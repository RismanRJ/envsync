'use strict';

// Phase 3 tray app: a menu-bar icon showing room status, with per-room
// Sync/Review/Reveal actions, plus Create/Join Room. No renderer/window
// needed -- Tray + native Menu + dialog + osascript prompts cover it.

const { app, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const lib = require('../lib');
const backup = require('../backup');
const icons = require('./icons');
const { cmdCreate } = require('../cli');
const { promptText } = require('./prompt');

const CLI_PATH = path.join(__dirname, '..', 'cli.js');
const REFRESH_MS = 5000;

// macOS menu bar icons render at ~18x18 points; the source PNGs are 32x32
// so they get supersampled-then-downscaled here for a crisp result.
const TRAY_ICON_SIZE = { width: 18, height: 18 };
const ICONS = {
  green: nativeImage.createFromDataURL(icons.green).resize(TRAY_ICON_SIZE),
  yellow: nativeImage.createFromDataURL(icons.yellow).resize(TRAY_ICON_SIZE),
  gray: nativeImage.createFromDataURL(icons.gray).resize(TRAY_ICON_SIZE),
};

const running = new Map(); // room name -> child process

function toggleSync(name) {
  if (running.has(name)) {
    running.get(name).kill();
    running.delete(name);
    return;
  }
  const child = spawn(process.execPath, [CLI_PATH, 'sync', name], { stdio: 'ignore' });
  child.on('exit', () => running.delete(name));
  running.set(name, child);
}

function runCli(args) {
  try {
    return { ok: true, output: execFileSync(process.execPath, [CLI_PATH, ...args]).toString() };
  } catch (err) {
    return { ok: false, output: (err.stderr || err.stdout || err.message).toString() };
  }
}

function createRoomFlow(refresh) {
  const name = promptText('Room name:');
  if (!name) return;
  const filePath = promptText('Full path to the .env file to track (leave blank for a vault-only room -- no file on disk, ever):');
  // promptText returns null on Cancel, '' on an intentionally empty answer --
  // only treat Cancel as an abort; '' means "vault-only, no file".
  if (filePath === null) return;

  // In-process, not shelled out (unlike other tray actions) -- cmdCreate can
  // prompt interactively over stdin when run as a CLI, which would hang
  // Electron's main process indefinitely if spawned via execFileSync here.
  try {
    cmdCreate(name, filePath || undefined, { promptDelete: false });
    if (filePath) {
      const deleteChoice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: ['Keep File', 'Delete File'],
        defaultId: 0,
        message: 'Delete the original plaintext file? It\'s now safely stored in the encrypted vault -- no need for it to sit in the repo.',
      });
      if (deleteChoice === 1) {
        require('fs').unlinkSync(filePath);
        dialog.showMessageBox({ message: 'Deleted. Values now live only in the encrypted vault.' });
      }
    } else {
      dialog.showMessageBox({ title: 'Room created', message: `"${name}" created as vault-only -- no file on disk.` });
    }
  } catch (err) {
    dialog.showMessageBox({ title: 'Failed to create room', message: err.message });
  }
  refresh();
}

function joinRoomFlow(refresh) {
  const name = promptText('Room name to join:');
  if (!name) return;
  const folders = dialog.showOpenDialogSync({
    title: 'Choose the folder for this project\'s .env file',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!folders || folders.length === 0) return;
  const chosenFolder = folders[0];
  const filePath = path.join(chosenFolder, '.env');
  const key = promptText('Room key (from whoever ran "create" or "invite"):');
  if (!key) return;
  const result = runCli(['join', name, filePath, key]);
  dialog.showMessageBox({
    title: result.ok ? 'Joined room' : 'Failed to join room',
    message: result.output,
  });
  if (result.ok) {
    lib.writeProjectConfig(chosenFolder, { room: name, file: filePath });
  }
  refresh();
}

function showDiff(name, reveal) {
  const history = lib.readHistory(name);
  if (!history.length) {
    dialog.showMessageBox({ title: name, message: 'No history yet.' });
    return;
  }
  const last = history[history.length - 1];
  const lines = Object.entries(last.diff).map(([key, change]) => {
    if (change.type === 'removed') return `${key}: removed`;
    const value = change.type === 'changed' ? change.to : change.value;
    return `${key}: ${reveal ? value : lib.mask(String(value))}`;
  });
  if (reveal) {
    lib.appendHistory(name, { ts: Date.now(), values: last.values, diff: {}, reveal: Object.keys(last.diff) });
  }
  dialog.showMessageBox({
    title: `${name} -- last change ${new Date(last.ts).toISOString()}`,
    message: lines.join('\n') || '(no changes)',
  });
}

function showPreview(name, reveal) {
  const values = lib.currentValues(name);
  const keys = Object.keys(values);
  const lines = keys.map((key) => `${key}=${reveal ? values[key] : lib.mask(String(values[key]))}`);
  if (reveal) {
    lib.appendHistory(name, { ts: Date.now(), values, diff: {}, reveal: keys });
  }
  dialog.showMessageBox({
    title: `${name} -- current values${reveal ? ' (revealed)' : ' (masked)'}`,
    message: lines.join('\n') || '(no values tracked yet)',
    buttons: reveal ? ['Close'] : ['Close', 'Unmask'],
  }).then((res) => {
    if (!reveal && res.response === 1) showPreview(name, true);
  });
}

// Electron's main process has no controlling terminal, so `gh auth login`
// can't run inline here the way it can from the CLI -- open a real Terminal
// window for it instead (same osascript trick as promptText/notify), then
// let the user re-click once they've finished signing in.
// One shared repo for every room -- connect once, all rooms push into it.
function connectGithubFlow(refresh) {
  if (!backup.isGhInstalled()) {
    dialog.showMessageBox({ message: 'GitHub CLI ("gh") not found. Install it first: https://cli.github.com' });
    return;
  }
  if (!backup.isGhAuthenticated()) {
    if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', 'tell application "Terminal" to do script "gh auth login --web"']);
      dialog.showMessageBox({
        title: 'Sign in to GitHub',
        message: 'A Terminal window opened to complete GitHub sign-in.\nOnce finished, click "Connect GitHub Backup..." again.',
      });
    } else {
      dialog.showMessageBox({ message: 'Not signed in to GitHub. Run "gh auth login" in a terminal, then try again.' });
    }
    return;
  }
  const repoName = promptText('Private GitHub repo name for the shared backup:', backup.DEFAULT_REPO_NAME);
  if (!repoName) return;
  try {
    const url = backup.createGithubRepo(repoName);
    backup.connectRepo(url);
    const results = lib.listRoomStatuses().map(({ name }) => ({ name, result: backup.pushBackup(name) }));
    const lines = results.map(({ name, result }) => `${name}: ${result.ok ? 'pushed' : result.reason}`);
    dialog.showMessageBox({ title: `Connected to ${url}`, message: lines.join('\n') || '(no rooms yet)' });
  } catch (err) {
    dialog.showMessageBox({ title: 'Failed to connect GitHub backup', message: err.message });
  }
  refresh();
}

function inviteGithubCollaboratorFlow() {
  if (!backup.isConnected()) {
    dialog.showMessageBox({ message: 'Connect GitHub Backup first, then invite teammates as collaborators.' });
    return;
  }
  const username = promptText('GitHub username to invite as a collaborator on the shared backup repo:');
  if (!username) return;
  try {
    backup.addCollaborator(username);
    dialog.showMessageBox({
      title: 'Invited',
      message: `Invited "${username}". They must accept the GitHub invite, then run:\nenvsync backup-init ${backup.loadBackupConfig().repoUrl}`,
    });
  } catch (err) {
    dialog.showMessageBox({ title: 'Failed to invite collaborator', message: err.message });
  }
}

function pushRoomToGithub(name) {
  if (!backup.isConnected()) {
    dialog.showMessageBox({ message: 'Not connected to GitHub yet -- use "Connect GitHub Backup..." first.' });
    return;
  }
  const result = backup.pushBackup(name);
  dialog.showMessageBox({
    title: result.ok ? 'Pushed' : 'Push failed',
    message: result.ok ? `"${name}" pushed to the shared GitHub backup.` : result.reason,
  });
}

function buildMenu(tray) {
  const statuses = lib.listRoomStatuses();
  const anyPending = statuses.some((s) => s.pending);
  tray.setImage(statuses.length === 0 ? ICONS.gray : anyPending ? ICONS.yellow : ICONS.green);
  tray.setToolTip(statuses.length ? `${statuses.length} room(s) tracked` : 'No rooms yet');

  const refresh = () => buildMenu(tray);
  const connected = backup.isConnected();
  const githubLabel = connected
    ? `GitHub Backup: connected (${backup.loadBackupConfig().repoUrl})`
    : 'GitHub Backup: not connected';
  const myAlias = lib.getDeviceIdentity().label;
  const template = [
    { label: `This device: ${myAlias}`, enabled: false },
    {
      label: 'Edit Device Alias...',
      click: () => {
        const newAlias = promptText('Display name other peers will see:', myAlias);
        if (newAlias) { lib.setDeviceAlias(newAlias); refresh(); }
      },
    },
    { type: 'separator' },
    { label: 'Create Room...', click: () => createRoomFlow(refresh) },
    { label: 'Join Room...', click: () => joinRoomFlow(refresh) },
    { type: 'separator' },
    { label: githubLabel, enabled: false },
    { label: connected ? 'Reconnect GitHub Backup...' : 'Connect GitHub Backup...', click: () => connectGithubFlow(refresh) },
    { label: 'Invite GitHub Collaborator...', enabled: connected, click: () => inviteGithubCollaboratorFlow() },
    { type: 'separator' },
  ];

  if (statuses.length) {
    for (const { name, filePath, pending } of statuses) {
      template.push({
        label: `${pending ? '\u{1F7E1}' : '\u{1F7E2}'} ${name}`,
        submenu: [
          { label: filePath, enabled: false },
          { type: 'separator' },
          { label: running.has(name) ? 'Stop syncing' : 'Sync now', click: () => toggleSync(name) },
          { label: 'Push to GitHub now', click: () => pushRoomToGithub(name) },
          { label: 'Preview env (masked)', click: () => showPreview(name, false) },
          { label: 'Review last change (masked)', click: () => showDiff(name, false) },
          {
            label: 'Reveal last change...',
            click: () => {
              dialog.showMessageBox({
                type: 'question',
                buttons: ['Cancel', 'Reveal'],
                defaultId: 0,
                message: `Reveal actual values for "${name}"? This is logged to history.`,
              }).then((res) => { if (res.response === 1) showDiff(name, true); });
            },
          },
        ],
      });
    }
  } else {
    template.push({ label: 'No rooms yet', enabled: false });
  }

  template.push({ type: 'separator' });
  template.push({ label: 'Quit', click: () => { for (const child of running.values()) child.kill(); app.quit(); } });

  tray.setContextMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.hide();
  const tray = new Tray(ICONS.gray);
  buildMenu(tray);
  setInterval(() => buildMenu(tray), REFRESH_MS);
});

app.on('window-all-closed', (e) => e.preventDefault());
