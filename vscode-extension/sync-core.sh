#!/bin/sh
# A packaged VS Code extension is installed in isolation -- it can't reach
# into the parent repo via `require('../lib')`. So this extension keeps its
# own copies of the core files instead. Re-run this after changing any of
# lib.js/cli.js/net.js/backup.js/notify.js at the repo root, then repackage.
set -e
cd "$(dirname "$0")"
cp ../lib.js ../cli.js ../net.js ../backup.js ../notify.js ../mesh.js ../signal.js .
echo "Synced core files into vscode-extension/. Re-run 'npx @vscode/vsce package' to repackage."
