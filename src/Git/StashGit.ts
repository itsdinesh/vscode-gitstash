'use strict'

import Git from './Git'

export interface Stash {
    index: number;
    date: string;
    hash: string;
    description: string;
}

export interface RenameStash {
    new: string;
    old: string;
}

export interface StashedFiles {
    indexAdded: string[];
    modified: string[];
    renamed: RenameStash[];
    untracked: string[];
    deleted: string[];
}

export const enum FileStage {
    Parent = 'p',
    Change = 'c',
}

export default class StashGit extends Git {
    /**
     * Gets the raw git stash command data.
     *
     * @param cwd the current working directory
     */
    public async getRawStash(cwd: string): Promise<null | string> {
        const params = [
            'stash',
            'list',
        ]

        return (await this.exec(params, cwd)).trim() || null
    }

    /**
     * Gets the stashes list.
     *
     * @param cwd the current working directory
     */
    public async getStashes(cwd: string): Promise<Stash[]> {
        const params = [
            'stash',
            'list',
            '--format="%ci|%H|%gs"',
        ]

        const stashList = (await this.exec(params, cwd)).trim()

        const list: Stash[] = !stashList.length ? [] : stashList
            .split(/\r?\n/g)
            .map((stash, index) => {
                const parts = stash.substring(1, stash.length - 1).split('|')
                return {
                    index,
                    date: parts[0],
                    hash: parts[1],
                    description: parts[2],
                }
            })

        return list
    }

    /**
     * Gets the stash files.
     *
     * @param cwd   the current working directory
     * @param index the int with the stash index
     */
    public async getStashedFiles(cwd: string, index: number): Promise<StashedFiles> {
        const files: StashedFiles = {
            untracked: await this.getStashUntracked(cwd, index),
            indexAdded: [],
            modified: [],
            deleted: [],
            renamed: [] as RenameStash[],
        }

        const params = [
            'stash',
            'show',
            '--name-status',
            `stash@{${index}}`,
        ]

        try {
            const stashData = (await this.exec(params, cwd)).trim()

            if (stashData.length > 0) {
                const stashedFiles = stashData.split(/\r?\n/g)
                stashedFiles.forEach((line: string) => {
                    const status = line.substring(0, 1)
                    const file = line.substring(1).trim()

                    if (status === 'A') {
                        files.indexAdded.push(file)
                    }
                    else if (status === 'D') {
                        files.deleted.push(file)
                    }
                    else if (status === 'M') {
                        files.modified.push(file)
                    }
                    else if (status === 'R') {
                        const fileNames = /^\d+\s+([^\t]+)\t(.+)$/.exec(file)
                        files.renamed.push({
                            new: fileNames[2],
                            old: fileNames[1],
                        })
                    }
                })
            }
        }
        catch (e) {
            console.log('StashGit.getStashedFiles')
            console.log(e)
        }

        return files
    }

    /**
     * Gets the stash untracked files.
     *
     * @param cwd   the current working directory
     * @param index the int with the stash index
     */
    private async getStashUntracked(cwd: string, index: number): Promise<string[]> {
        const params = [
            'ls-tree',
            '-r',
            '--name-only',
            `stash@{${index}}^3`,
        ]

        const list: string[] = []

        try {
            const stashData = (await this.exec(params, cwd)).trim()

            if (stashData.length > 0) {
                const stashedFiles = stashData.split(/\r?\n/g)
                stashedFiles.forEach((file: string) => {
                    list.push(file)
                })
            }
        }
        catch (e) { /* we may get an error if there aren't untracked files */ }

        return list
    }

    /**
     * Gets the file contents from the stash commit.
     *
     * This gets the changed contents for:
     *  - index-added
     *  - modified
     *  - renamed
     *
     * @param cwd   the current working directory
     * @param index the int with the index of the parent stash
     * @param file  the string with the stashed file name
     */
    public async getStashContents(cwd: string, index: number, file: string): Promise<string> {
        const params = [
            'show',
            `stash@{${index}}:${file}`,
        ]

        return this.exec(params, cwd)
    }

    /**
     * Gets the file contents from the parent stash commit.
     *
     * This gets the original contents for:
     *  - deleted
     *  - modified
     *  - renamed
     *
     * @param cwd   the current working directory
     * @param index the int with the index of the parent stash
     * @param file  the string with the stashed file name
     */
    public async getParentContents(cwd: string, index: number, file: string): Promise<string> {
        const params = [
            'show',
            `stash@{${index}}^1:${file}`,
        ]

        return this.exec(params, cwd)
    }

    /**
     * Gets the file contents from the third (untracked) stash commit.
     *
     * @param cwd   the current working directory
     * @param index the int with the index of the parent stash
     * @param file  the string with the stashed file name
     */
    public async getThirdParentContents(cwd: string, index: number, file: string): Promise<string> {
        const params = [
            'show',
            `stash@{${index}}^3:${file}`,
        ]

        return this.exec(params, cwd)
    }

    /**
     * Renames a stash.
     *
     * @param cwd        the current working directory
     * @param index      the int with the stash index
     * @param newMessage the string with the new stash message
     */
    public async renameStash(cwd: string, index: number, newMessage: string): Promise<void> {
        const stashes = await this.getStashes(cwd)
        if (index >= stashes.length) {
            throw new Error(`Stash index ${index} not found.`)
        }

        const targetStash = stashes[index]

        // 1. Determine the full message for the new commit
        let fullMessage = newMessage
        const prefixMatch = targetStash.description.match(/^(WIP on |On )(.+?): /)
        if (prefixMatch && !newMessage.match(/^(WIP on |On )(.+?): /)) {
            fullMessage = `${prefixMatch[0]}${newMessage}`
        }

        // 2. Create a new commit object for the renamed stash
        // This ensures the hash is different, so 'stash store' will always push
        const parents = (await this.exec(['rev-list', '--parents', '-n', '1', targetStash.hash], cwd))
            .trim().split(' ').slice(1)

        const commitArgs = ['commit-tree', `${targetStash.hash}^{tree}`]
        for (const parent of parents) {
            commitArgs.push('-p', parent)
        }
        commitArgs.push('-m', fullMessage)

        const newHash = (await this.exec(commitArgs, cwd)).trim()

        // 3. Rebuild the stack from index down to 0
        for (let i = index; i >= 0; i--) {
            const stash = stashes[i]
            const hash = (i === index) ? newHash : stash.hash
            const message = (i === index) ? fullMessage : stash.description

            await this.exec(['stash', 'store', '-m', message, hash], cwd)
        }

        // 4. Drop the old entries which are now shifted down the stack
        const dropIndex = index + 1
        for (let i = index; i >= 0; i--) {
            await this.exec(['stash', 'drop', '--quiet', `stash@{${dropIndex + i}}`], cwd)
        }
    }
}
