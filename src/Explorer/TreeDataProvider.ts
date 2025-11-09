'use strict'

import {
    EventEmitter,
    TreeDataProvider,
    TreeItem,
    TreeView,
    Uri,
    commands,
    window,
} from 'vscode'
import Config from '../Config'
import GitBridge from '../GitBridge'
import StashLabels from '../StashLabels'
import StashNode from '../StashNode/StashNode'
import NodeType from '../StashNode/NodeType'
import StashNodeRepository from '../StashNode/StashNodeRepository'
import TreeItemFactory from './TreeItemFactory'
import UriGenerator from '../uriGenerator'

export default class implements TreeDataProvider<StashNode> {
    private readonly onDidChangeTreeDataEmitter = new EventEmitter<void>()
    readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event

    private config: Config
    private stashNodeRepository: StashNodeRepository
    private treeItemFactory: TreeItemFactory
    private gitBridge: GitBridge
    private rawStashes = {}
    private loadTimeout: NodeJS.Timer
    private showExplorer: boolean
    private searchText: string = ''
    private treeView: TreeView<StashNode> | null = null

    constructor(
        config: Config,
        stashNodeRepository: StashNodeRepository,
        gitBridge: GitBridge,
        uriGenerator: UriGenerator,
        stashLabels: StashLabels
    ) {
        this.config = config
        this.stashNodeRepository = stashNodeRepository
        this.gitBridge = gitBridge
        this.treeItemFactory = new TreeItemFactory(config, uriGenerator, stashLabels)
    }

    /**
     * Creates a tree view.
     */
    public createTreeView(): TreeView<StashNode> {
        this.treeView = window.createTreeView('gitstash.explorer', {
            treeDataProvider: this,
            showCollapseAll: true,
            canSelectMany: false,
        })

        this.updateTreeViewDescription()

        return this.treeView
    }

    /**
     * Updates the tree view description to show search status.
     */
    private updateTreeViewDescription(): void {
        if (this.treeView) {
            if (this.searchText) {
                this.treeView.description = `🔍 "${this.searchText}"`
            } else {
                this.treeView.description = undefined
            }
        }
    }

    /**
     * Toggles the explorer tree.
     */
    public toggle = (): void => {
        this.showExplorer = this.showExplorer === undefined
            ? this.config.get('explorer.enabled')
            : !this.showExplorer

        void commands.executeCommand(
            'setContext',
            'gitstash.explorer.enabled',
            this.showExplorer,
        )
    }

    /**
     * Reloads the explorer tree.
     */
    public refresh = (): void => {
        this.reload('force')
    }

    /**
     * Shows a search input box and filters stashes with live updates.
     * Press Enter to keep the filter, or Escape to cancel.
     */
    public search = (): void => {
        const inputBox = window.createInputBox()
        inputBox.placeholder = 'Search stashes by description, branch, or index'
        inputBox.prompt = 'Type to filter (live) -'
        inputBox.value = this.searchText
        inputBox.ignoreFocusOut = false

        let accepted = false

        // Update search on every keystroke
        inputBox.onDidChangeValue((value) => {
            this.searchText = value
            void commands.executeCommand('setContext', 'gitstash.explorer.hasSearch', value.length > 0)
            this.updateTreeViewDescription()
            this.onDidChangeTreeDataEmitter.fire()
        })

        // Keep filter when Enter is pressed
        inputBox.onDidAccept(() => {
            accepted = true
            inputBox.hide()
        })

        // Handle hide/cancel
        inputBox.onDidHide(() => {
            // If not accepted (Escape or click away), clear the search
            if (!accepted) {
                this.searchText = ''
                void commands.executeCommand('setContext', 'gitstash.explorer.hasSearch', false)
                this.updateTreeViewDescription()
                this.onDidChangeTreeDataEmitter.fire()
            }
            inputBox.dispose()
        })

        inputBox.show()
    }

    /**
     * Clears the search filter.
     */
    public clearSearch = (): void => {
        this.searchText = ''
        void commands.executeCommand('setContext', 'gitstash.explorer.hasSearch', false)
        this.updateTreeViewDescription()
        this.onDidChangeTreeDataEmitter.fire()
    }

    /**
     * Gets the tree children, which may be repositories, stashes or files.
     *
     * @param node the parent node for the requested children
     */
    public getChildren(node?: StashNode): Thenable<StashNode[]> | StashNode[] {
        // If we have a search active and this is a repository node, don't use cache
        if (node && node.children && !(this.searchText && node.type === NodeType.Repository)) {
            const filteredChildren = this.filterChildren(node, node.children)
            return this.prepareChildren(node, filteredChildren)
        }

        const children = !node
            ? this.stashNodeRepository.getRepositories(this.config.get('explorer.eagerLoadStashes'))
            : this.stashNodeRepository.getChildren(node)

        return children.then((children: StashNode[]) => {
            node && node.setChildren(children)
            const filteredChildren = this.filterChildren(node, children)
            return this.prepareChildren(node, filteredChildren)
        })
    }

    /**
     * Filters children based on search text.
     *
     * @param parent   the parent node
     * @param children the children to filter
     */
    private filterChildren(parent: StashNode | null, children: StashNode[]): StashNode[] {
        // Only filter if we have search text and parent is a repository
        if (!this.searchText || !parent || parent.type !== NodeType.Repository) {
            return children
        }

        const searchLower = this.searchText.toLowerCase()
        return children.filter((child: StashNode) => {
            // Only filter stash nodes
            if (child.type !== NodeType.Stash) {
                return true
            }

            // Search in stash name (includes branch and description)
            if (child.name && child.name.toLowerCase().includes(searchLower)) {
                return true
            }

            // Search in index
            if (child.index !== undefined && child.index.toString().includes(searchLower)) {
                return true
            }

            return false
        })
    }

    /**
     * Prepares the children to be displayed, adding default items according user settings.
     *
     * @param parent   the children's parent node
     * @param children the parent's children
     */
    private prepareChildren(parent: StashNode | null, children: StashNode[]): StashNode[] {
        const itemDisplayMode = this.config.get('explorer.itemDisplayMode')

        if (!parent) {
            if (itemDisplayMode === 'hide-empty' && this.config.get('explorer.eagerLoadStashes')) {
                children = children.filter((repositoryNode: StashNode) => repositoryNode.childrenCount)
            }
        }

        if (children.length) {
            return children
        }

        if (itemDisplayMode === 'indicate-empty') {
            if (!parent) {
                return [this.stashNodeRepository.getMessageNode('No repositories found.')]
            }
            if (parent.type === 'r') {
                return [this.stashNodeRepository.getMessageNode('No stashes found.')]
            }
        }

        return []
    }

    /**
     * Generates a tree item for the specified node.
     *
     * @param node the node to be used as base
     */
    public getTreeItem(node: StashNode): TreeItem {
        return this.treeItemFactory.getTreeItem(node)
    }

    /**
     * Reloads the git stash tree view.
     *
     * @param type        the event type: settings, force, create, update, delete
     * @param projectPath the URI of the project with content changes
     */
    public reload(type: string, projectPath?: Uri): void {
        if (this.loadTimeout) {
            clearTimeout(this.loadTimeout)
        }

        this.loadTimeout = setTimeout((type: string, pathUri?: Uri) => {
            if (['settings', 'force'].indexOf(type) !== -1) {
                this.onDidChangeTreeDataEmitter.fire()
            }
            else {
                const path = pathUri.fsPath

                void this.gitBridge.getRawStashesList(path).then((rawStash: null | string) => {
                    const cachedRawStash = this.rawStashes[path] as null | string

                    if (!cachedRawStash || cachedRawStash !== rawStash) {
                        this.rawStashes[path] = rawStash
                        this.onDidChangeTreeDataEmitter.fire()
                    }
                })
            }
        }, type === 'force' ? 250 : 750, type, projectPath)
    }
}
