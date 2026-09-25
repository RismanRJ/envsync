'use strict';

// Status bar item showing sync state for the room tracked in this workspace
// (found via .envsync.yml) + review/reveal commands. Reuses ../lib.js
// directly instead of reimplementing diff/status/mask logic here.

const vscode = require('vscode');
const path = require('path');
const lib = require('./lib');
const { cmdCreate, cmdJoin } = require('./cli');

const REFRESH_MS = 5000;

// Which room (if any) already tracks this exact file -- distinct from
// "this workspace has a room" (findProjectConfig), since a workspace can
// contain .env files that aren't the one .envsync.yml points at.
function roomTrackingFile(filePath) {
  for (const status of lib.listRoomStatuses()) {
    if (status.filePath === filePath) return status.name;
  }
  return null;
}

function activate(context) {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'envsync.review';
  context.subscriptions.push(statusBarItem);

  const outputChannel = vscode.window.createOutputChannel('EnvSync');
  context.subscriptions.push(outputChannel);

  let currentRoom = null;

  function refresh() {
    const folders = vscode.workspace.workspaceFolders || [];
    let found = null;
    for (const folder of folders) {
      const projectConfig = lib.findProjectConfig(folder.uri.fsPath);
      if (projectConfig?.room) { found = projectConfig.room; break; }
    }
    currentRoom = found;
    if (!found) { statusBarItem.hide(); return; }

    const status = lib.listRoomStatuses().find((s) => s.name === found);
    if (!status) {
      statusBarItem.text = `$(circle-outline) envsync: ${found} (not found)`;
      statusBarItem.tooltip = `Room "${found}" is referenced by .envsync.yml but no longer exists locally.`;
      statusBarItem.show();
      return;
    }
    const icon = status.pending ? '$(warning)' : '$(check)';
    statusBarItem.text = `${icon} envsync: ${found}`;
    statusBarItem.tooltip = [
      status.filePath,
      `last change: ${status.lastTs ? new Date(status.lastTs).toISOString() : 'never'}`,
      status.pending ? '(local edits not yet synced -- run "envsync sync")' : '(in sync)',
    ].join('\n');
    statusBarItem.show();
  }

  refresh();
  const interval = setInterval(refresh, REFRESH_MS);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });

  function printDiff(reveal) {
    if (!currentRoom) {
      vscode.window.showInformationMessage('EnvSync: no room found in this workspace (no .envsync.yml).');
      return;
    }
    const history = lib.readHistory(currentRoom);
    if (!history.length) {
      vscode.window.showInformationMessage(`EnvSync: no history yet for "${currentRoom}".`);
      return;
    }
    const last = history[history.length - 1];
    outputChannel.clear();
    outputChannel.appendLine(`Last change: ${new Date(last.ts).toISOString()}${last.source ? ` (from ${last.source})` : ''}`);
    for (const [key, change] of Object.entries(last.diff)) {
      if (change.type === 'removed') { outputChannel.appendLine(`  ${key}: removed`); continue; }
      const value = change.type === 'changed' ? change.to : change.value;
      outputChannel.appendLine(`  ${key}: ${reveal ? value : lib.mask(String(value))}`);
    }
    if (reveal) {
      lib.appendHistory(currentRoom, { ts: Date.now(), values: last.values, diff: {}, reveal: Object.keys(last.diff) });
    }
    outputChannel.show();
  }

  function updateTrackedContext(editor) {
    const filePath = editor?.document?.uri?.fsPath;
    const isEnvsyncYml = path.basename(filePath) === '.envsync.yml';
    const isTracked = isEnvsyncYml || !!roomTrackingFile(filePath);
    vscode.commands.executeCommand('setContext', 'envsync.trackedActive', filePath ? isTracked : false);
  }
  updateTrackedContext(vscode.window.activeTextEditor);
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateTrackedContext));

  context.subscriptions.push(vscode.commands.registerCommand('envsync.vaultThisFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const filePath = editor.document.uri.fsPath;
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    if (!folder) {
      vscode.window.showErrorMessage('EnvSync: open this file inside a workspace folder first.');
      return;
    }
    const existingRoom = roomTrackingFile(filePath);
    if (existingRoom) {
      vscode.window.showInformationMessage(`Already vaulted as room "${existingRoom}".`);
      return;
    }
    const roomName = await vscode.window.showInputBox({
      prompt: 'Room name for this .env file',
      value: path.basename(folder.uri.fsPath),
    });
    if (!roomName) return;

    try {
      cmdCreate(roomName, filePath, { promptDelete: false });
      lib.writeProjectConfig(folder.uri.fsPath, { room: roomName, file: filePath });
      const config = lib.loadConfig(roomName);
      const choice = await vscode.window.showInformationMessage(
        `Vaulted as room "${roomName}" -- encrypted locally, nothing plaintext has left this machine.`,
        'Copy Room Key', 'Done',
      );
      if (choice === 'Copy Room Key') {
        await vscode.env.clipboard.writeText(config.key);
        vscode.window.showInformationMessage('Room key copied -- share it with teammates so they can "envsync join".');
      }
      const deleteChoice = await vscode.window.showWarningMessage(
        'Delete the original plaintext file? It\'s now safely stored in the encrypted vault -- no need for it to sit in the repo (e.g. for an AI assistant or anyone else to read).',
        'Delete File', 'Keep File',
      );
      if (deleteChoice === 'Delete File') {
        await vscode.workspace.fs.delete(vscode.Uri.file(filePath));
        vscode.window.showInformationMessage('Deleted. Use "EnvSync: Review" or the CLI\'s "run"/"export" to access values from here on.');
      }
    } catch (err) {
      vscode.window.showErrorMessage(`EnvSync: ${err.message}`);
      return;
    }
    currentRoom = roomName;
    refresh();
    updateTrackedContext(editor);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('envsync.review', () => printDiff(false)));
  context.subscriptions.push(vscode.commands.registerCommand('envsync.reveal', async () => {
    if (!currentRoom) return;
    const confirm = await vscode.window.showWarningMessage(
      `Reveal actual values for "${currentRoom}"? This is logged to encrypted history.`,
      'Reveal', 'Cancel',
    );
    if (confirm === 'Reveal') printDiff(true);
  }));

  context.subscriptions.push(vscode.commands.registerCommand('envsync.joinRoom', async () => {
    const roomName = await vscode.window.showInputBox({ prompt: 'Room name to join' });
    if (!roomName) return;
    const roomKey = await vscode.window.showInputBox({ prompt: 'Room key (from whoever ran "create" or "invite")' });
    if (!roomKey) return;
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Choose folder for this project',
    });
    if (!result || !result.length) return;
    const folderPath = result[0].fsPath;
    const filePath = path.join(folderPath, '.env');
    try {
      cmdJoin(roomName, roomKey, filePath, { promptDelete: false });
      lib.writeProjectConfig(folderPath, { room: roomName, file: filePath });
      vscode.window.showInformationMessage(`Joined room "${roomName}" -- .env synced to ${folderPath}`);
      currentRoom = roomName;
      refresh();
      updateTrackedContext(vscode.window.activeTextEditor);
    } catch (err) {
      vscode.window.showErrorMessage(`EnvSync: ${err.message}`);
    }
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
