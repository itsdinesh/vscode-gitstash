#!/bin/bash

# Local build script for Git Stash VSCode Extension

set -e

echo "🔧 Installing dependencies..."
npm install

echo "🔍 Running linter..."
npm run lint

echo "🏗️  Building extension (production mode)..."
npm run build:prod

echo "📦 Packaging extension..."
npm run package

echo ""
echo "✅ Build completed successfully!"
echo "📦 VSIX package created in the current directory"
