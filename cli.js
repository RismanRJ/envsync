#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const qrcode = require('qrcode-terminal');
const lib = require('./lib');
const net = require('./net');
const backup = require('./backup');

function printInviteQr(name, filePath, key) {
  const inviteCommand = `envsync join ${name} <local-path-to-file> ${key}`;
  qrcode.generate(inviteCommand, { small: true }, (qr) => console.log(qr));
  console.log(`Or share this command directly: ${inviteCommand}`);
}

function promptDeleteOriginal(filePath) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(
    `Delete the original plaintext file at ${filePath}? It's now safely stored in the encrypted vault, so it doesn't need to sit in the repo. [y/N] `,
    (answer) => {
      rl.close();
      if (/^y(es)?$/i.test(answer.trim())) {
        fs.unlinkSync(filePath);
        console.log('Deleted. Values now live only in the encrypted vault -- use "envsync run"/"export" to inject them, "envsync set"/"unset" to edit.');
      } else {
        console.log('Kept the file (still gitignored, so it won\'t get committed by accident).');
      }
    },
  );
}

// promptDelete: false when called programmatically (VS Code extension, tray) --
// those have their own native confirmation dialogs instead of a stdin prompt.
function cmdCreate(name, filePath, { promptDelete = true } = {}) {
  if (!name) throw new Error('usage: envsync create <name> [file]  (omit file for a vault-only room -- no plaintext ever written to disk)');
  fs.mkdirSync(lib.roomDir(name), { recursive: true });
  if (fs.existsSync(lib.configFile(name))) throw new Error(`Room "${name}" already exists.`);
  const resolvedPath = filePath ? require('path').resolve(filePath) : null;
  const config = { name, filePath: resolvedPath, key: crypto.randomBytes(32).toString('hex'), peerId: lib.getDeviceIdentity().publicKey };
  lib.saveConfig(name, config);
  const initial = resolvedPath && fs.existsSync(resolvedPath) ? lib.parseEnv(fs.readFileSync(resolvedPath, 'utf8')) : {};
  lib.appendHistory(name, { ts: Date.now(), values: initial, diff: lib.diffValues({}, initial) });
  const merged = {};
  const ts = Date.now();
  for (const [k, v] of Object.entries(initial)) merged[k] = { value: v, ts, peer: config.peerId };
  lib.saveMerged(name, merged);
  if (resolvedPath) {
    lib.ensureGitignored(resolvedPath);
    console.log(`Room "${name}" created, tracking ${resolvedPath} (added to .gitignore)`);
  } else {
    console.log(`Room "${name}" created as vault-only -- no file on disk. Use "envsync set/unset" to edit, "envsync run -- <cmd>" to inject.`);
  }
  printInviteQr(name, resolvedPath, config.key);
  if (resolvedPath && promptDelete) promptDeleteOriginal(resolvedPath);
}

function cmdSet(name, key, value) {
  if (!key || value === undefined) throw new Error('usage: envsync set [name] <key> <value>');
  lib.setValue(name, key, value);
  console.log(`${key} set.`);
}

function cmdUnset(name, key) {
  if (!key) throw new Error('usage: envsync unset [name] <key>');
  lib.unsetValue(name, key);
  console.log(`${key} unset.`);
}

function cmdJoin(name, filePath, keyHex) {
  if (!name || !filePath || !keyHex) throw new Error('usage: envsync join <name> <file> <key>');
  fs.mkdirSync(lib.roomDir(name), { recursive: true });
  if (fs.existsSync(lib.configFile(name))) throw new Error(`Room "${name}" already exists locally.`);
  const config = { name, filePath: require('path').resolve(filePath), key: keyHex, peerId: lib.getDeviceIdentity().publicKey };
  lib.saveConfig(name, config);
  lib.saveMerged(name, {});
  lib.ensureGitignored(config.filePath);
  if (!fs.existsSync(config.filePath)) fs.writeFileSync(config.filePath, '');
  console.log(`Joined room "${name}", tracking ${config.filePath}. Run "envsync sync ${name}" to start syncing.`);
}

function cmdWatch(name) {
  const config = lib.loadConfig(name);
  console.log(`Watching ${config.filePath} for room "${name}" (ctrl-c to stop)`);
  let prev = lib.readHistory(name).slice(-1)[0]?.values || {};
  fs.watchFile(config.filePath, { interval: 1000 }, () => {
    if (!fs.existsSync(config.filePath)) return;
    const next = lib.parseEnv(fs.readFileSync(config.filePath, 'utf8'));
    const diff = lib.diffValues(prev, next);
    if (Object.keys(diff).length === 0) return;
    lib.appendHistory(name, { ts: Date.now(), values: next, diff });
    prev = next;
    console.log(`[${new Date().toISOString()}] change detected:`, diff);
  });
}

function cmdHistory(name) {
  for (const entry of lib.readHistory(name)) {
    console.log(`--- ${new Date(entry.ts).toISOString()}${entry.source ? ` (from ${lib.peerLabel(name, entry.source)})` : ''} ---`);
    if (entry.reveal) {
      console.log(`  (reveal: ${entry.reveal.join(', ')})`);
    } else if (Object.keys(entry.diff).length === 0) {
      console.log('  (initial snapshot)');
    } else {
      for (const [key, change] of Object.entries(entry.diff)) {
        console.log(`  ${key}: ${JSON.stringify(change)}`);
      }
    }
  }
}

function cmdSync(name) {
  net.startSync(name);
}

function cmdDaemon() {
  net.startAllRooms();
}

const PLIST_PATH = path.join(os.homedir(), 'Library/LaunchAgents/com.envsync.daemon.plist');
const DAEMON_LOG_PATH = path.join(os.homedir(), '.envsync/daemon.log');

function daemonPlist() {
  const cliPath = path.resolve(__dirname, 'cli.js');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.envsync.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${DAEMON_LOG_PATH}</string>
  <key>WorkingDirectory</key>
  <string>${path.dirname(cliPath)}</string>
</dict>
</plist>
`;
}

// ponytail: macOS-only (launchd) -- Linux/Windows auto-start (systemd/Task
// Scheduler) is out of scope, "envsync daemon" itself still runs anywhere.
function cmdDaemonInstall() {
  if (process.platform !== 'darwin') {
    console.log('launchd auto-start is macOS-only. Run "envsync daemon" directly, or wire it up with your OS\'s own equivalent (cron/systemd/Task Scheduler).');
    return;
  }
  fs.mkdirSync(path.dirname(DAEMON_LOG_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
  fs.writeFileSync(PLIST_PATH, daemonPlist());
  try {
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, PLIST_PATH]);
  } catch {
    execFileSync('launchctl', ['load', '-w', PLIST_PATH]);
  }
  console.log(`Installed and started com.envsync.daemon. Logs: ${DAEMON_LOG_PATH}`);
}

function cmdDaemonUninstall() {
  if (process.platform !== 'darwin') {
    console.log('launchd auto-start is macOS-only. Nothing to uninstall here.');
    return;
  }
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/com.envsync.daemon`]);
  } catch {
    try { execFileSync('launchctl', ['unload', PLIST_PATH]); } catch { /* not loaded */ }
  }
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  console.log('Uninstalled com.envsync.daemon.');
}

function cmdDaemonStatus() {
  if (process.platform !== 'darwin') {
    console.log('launchd auto-start is macOS-only. Run "envsync daemon" directly, or wire it up with your OS\'s own equivalent (cron/systemd/Task Scheduler).');
    return;
  }
  if (!fs.existsSync(PLIST_PATH)) { console.log('Not installed. Run "envsync daemon install".'); return; }
  const list = execFileSync('launchctl', ['list']).toString('utf8');
  const installed = list.includes('com.envsync.daemon');
  console.log(installed ? `Installed and running. Logs: ${DAEMON_LOG_PATH}` : `Installed but not running. Logs: ${DAEMON_LOG_PATH}`);
}

function cmdInit(name) {
  if (!name) throw new Error('usage: envsync init <name>  (run inside the project after create/join)');
  const config = lib.loadConfig(name);
  lib.writeProjectConfig(process.cwd(), { room: name, file: config.filePath });
  console.log(`Wrote .envsync.yml (room "${name}" -> ${config.filePath}). Other commands in this directory no longer need a name.`);
}

function cmdStatus() {
  const statuses = lib.listRoomStatuses();
  if (!statuses.length) { console.log('No rooms yet. Run: envsync create <name> <file>'); return; }
  for (const { name, filePath, pending, lastTs } of statuses) {
    const lastTsStr = lastTs ? new Date(lastTs).toISOString() : 'never';
    console.log(`${pending ? '\u{1F7E1}' : '\u{1F7E2}'} ${name}  ${filePath}  last change: ${lastTsStr}${pending ? '  (local edits not yet synced -- run "envsync sync ' + name + '")' : ''}`);
  }
}

function cmdInvite(name) {
  const config = lib.loadConfig(name);
  printInviteQr(name, config.filePath, config.key);
}

function cmdIdentity() {
  const identity = lib.getDeviceIdentity();
  console.log(`Alias: ${identity.label}`);
  console.log(`Public key (safe to share):\n${identity.publicKey}`);
}

function cmdAlias(newLabel) {
  if (!newLabel) { console.log(lib.getDeviceIdentity().label); return; }
  lib.setDeviceAlias(newLabel);
  console.log(`Alias set to "${newLabel}". Other peers will see this on your next sync.`);
}

function cmdInviteDevice(name, recipientPublicKey) {
  if (!recipientPublicKey) throw new Error('usage: envsync invite-device <name> <recipient-public-key>  (get theirs via "envsync identity" on their machine)');
  const config = lib.loadConfig(name);
  const envelope = lib.wrapRoomKey(config.key, recipientPublicKey);
  const encoded = Buffer.from(JSON.stringify(envelope)).toString('base64');
  console.log(`Room key encrypted for that device only -- safe to paste anywhere (Slack, cloud backup, etc), only their private key can open it:\n`);
  console.log(`envsync accept ${name} <local-path-to-file> ${encoded}`);
}

function cmdAccept(name, filePath, encodedEnvelope) {
  if (!name || !filePath || !encodedEnvelope) throw new Error('usage: envsync accept <name> <file> <envelope>');
  const envelope = JSON.parse(Buffer.from(encodedEnvelope, 'base64').toString('utf8'));
  const keyHex = lib.unwrapRoomKey(envelope);
  cmdJoin(name, filePath, keyHex);
}

function cmdBackupInit(githubRepoUrl) {
  if (!githubRepoUrl) throw new Error('usage: envsync backup-init <github-repo-url>  (point at an existing private repo you already created)');
  backup.connectRepo(githubRepoUrl);
  console.log(`Connected to ${githubRepoUrl}. Run "envsync backup [name]" or let "envsync sync" push automatically.`);
}

function cmdBackup(name) {
  const result = backup.pushBackup(name);
  console.log(result.ok ? `Pushed "${name}" to GitHub backup.` : `Backup push failed: ${result.reason}`);
}

function cmdConnectGithub(repoName) {
  if (!backup.isGhInstalled()) {
    throw new Error('GitHub CLI ("gh") not found. Install it first: https://cli.github.com');
  }
  if (!backup.isGhAuthenticated()) {
    console.log('Not signed in to GitHub -- opening browser sign-in (gh auth login)...');
    backup.loginInteractive();
  }
  const finalRepoName = repoName || backup.DEFAULT_REPO_NAME;
  console.log(`Creating (or reusing) private GitHub repo "${finalRepoName}"...`);
  const url = backup.createGithubRepo(finalRepoName);
  backup.connectRepo(url);
  const rooms = lib.listRoomStatuses();
  const results = rooms.map(({ name }) => ({ name, result: backup.pushBackup(name) }));
  console.log(`Connected to ${url}.`);
  for (const { name, result } of results) {
    console.log(result.ok ? `  pushed "${name}"` : `  "${name}" push failed: ${result.reason}`);
  }
}

function cmdInviteGithub(username) {
  if (!username) throw new Error('usage: envsync invite-github <github-username>  (grants them collaborator access to the shared private backup repo)');
  backup.addCollaborator(username);
  console.log(`Invited "${username}" as a collaborator on the shared backup repo.`);
  console.log(`They must accept the invite (github.com notifications or their email), then run:\n  envsync backup-init <the-repo-url>`);
}

function cmdRevokeGithub(username) {
  if (!username) throw new Error('usage: envsync revoke-github <github-username>  (removes them from the shared private backup repo)');
  backup.removeCollaborator(username);
  console.log(`Removed "${username}" from the shared backup repo.`);
}

function cmdRestore(name, githubRepoUrl) {
  if (githubRepoUrl) backup.connectRepo(githubRepoUrl);
  else if (!backup.isConnected()) throw new Error('usage: envsync restore <name> [github-repo-url]  (or run "envsync connect-github" / "backup-init" first)');
  const result = backup.pullBackup(name);
  if (result.ok) {
    // pullBackup only updates the encrypted vault (merged.json/history.jsonl).
    // Write the actual tracked file too, so a later "sync" doesn't see an
    // empty on-disk file and mistake the restore for an intentional wipe.
    const config = lib.loadConfig(name);
    fs.writeFileSync(config.filePath, lib.serializeEnv(lib.currentValues(name)));
  }
  console.log(result.ok ? 'Restored encrypted vault from GitHub backup.' : `Restore failed: ${result.reason}`);
}

function cmdReview(name, reveal) {
  const history = lib.readHistory(name);
  if (!history.length) { console.log('No history yet.'); return; }
  const last = history[history.length - 1];
  console.log(`Last change: ${new Date(last.ts).toISOString()}${last.source ? ` (from ${lib.peerLabel(name, last.source)})` : ''}`);
  for (const [key, change] of Object.entries(last.diff)) {
    if (change.type === 'removed') { console.log(`  ${key}: removed`); continue; }
    const value = change.type === 'changed' ? change.to : change.value;
    console.log(`  ${key}: ${reveal ? value : lib.mask(String(value))}`);
  }
  if (reveal) {
    lib.appendHistory(name, { ts: Date.now(), values: last.values, diff: {}, reveal: Object.keys(last.diff) });
    console.log('(reveal logged to history)');
  } else {
    console.log('(values masked -- pass --reveal to show them)');
  }
}

function cmdRotate(name) {
  const newKey = lib.rotateRoomKey(name);
  console.log(`Room "${name}" key rotated. New encryption key:`);
  console.log(newKey);
  console.log('\nShare this key with every device that should sync this room via: envsync invite-device or envsync join');
  console.log('Note: data already synced to devices before rotation is not retroactively protected.');
}

function cmdRun(name, commandArgs) {
  if (!commandArgs.length) throw new Error('usage: envsync run [name] -- <command> [args...]');
  const values = lib.currentValues(name);
  const child = require('child_process').spawn(commandArgs[0], commandArgs.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, ...values },
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

function cmdExport(name, format) {
  const values = lib.currentValues(name);
  for (const [k, v] of Object.entries(values)) {
    const quoted = `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`;
    console.log(format === 'env' ? `${k}=${v}` : `export ${k}=${quoted}`);
  }
}

function cmdPreview(name, reveal) {
  const values = lib.currentValues(name);
  const keys = Object.keys(values);
  if (!keys.length) { console.log('(no values tracked yet)'); return; }
  for (const key of keys) console.log(`${key}=${reveal ? values[key] : lib.mask(String(values[key]))}`);
  if (reveal) {
    lib.appendHistory(name, { ts: Date.now(), values, diff: {}, reveal: keys });
    console.log('(reveal logged to history)');
  } else {
    console.log('(values masked -- pass --reveal to show them)');
  }
}

function resolveName(argName) {
  if (argName) return argName;
  const projectConfig = lib.findProjectConfig(process.cwd());
  if (projectConfig?.room) return projectConfig.room;
  throw new Error('no room name given and no .envsync.yml found -- pass a name or run "envsync init <name>" first');
}

function main() {
  const [, , cmd, ...rawArgs] = process.argv;

  if (cmd === 'run') {
    const sepIdx = rawArgs.indexOf('--');
    if (sepIdx === -1) throw new Error('usage: envsync run [name] -- <command> [args...]');
    const name = resolveName(rawArgs.slice(0, sepIdx)[0]);
    cmdRun(name, rawArgs.slice(sepIdx + 1));
    return;
  }

  const reveal = rawArgs.includes('--reveal');
  const formatIdx = rawArgs.findIndex((a) => a.startsWith('--format='));
  const format = formatIdx !== -1 ? rawArgs[formatIdx].split('=')[1] : 'shell';
  const args = rawArgs.filter((a) => a !== '--reveal' && !a.startsWith('--format='));
  try {
    if (cmd === 'create') cmdCreate(args[0], args[1]);
    else if (cmd === 'join') cmdJoin(args[0], args[1], args[2]);
    else if (cmd === 'init') cmdInit(resolveName(args[0]));
    else if (cmd === 'watch') cmdWatch(resolveName(args[0]));
    else if (cmd === 'sync') cmdSync(resolveName(args[0]));
    else if (cmd === 'daemon') {
      if (args[0] === 'install') cmdDaemonInstall();
      else if (args[0] === 'uninstall') cmdDaemonUninstall();
      else if (args[0] === 'status') cmdDaemonStatus();
      else cmdDaemon();
    }
    else if (cmd === 'history') cmdHistory(resolveName(args[0]));
    else if (cmd === 'review') cmdReview(resolveName(args[0]), reveal);
    else if (cmd === 'preview') cmdPreview(resolveName(args[0]), reveal);
    else if (cmd === 'status') cmdStatus();
    else if (cmd === 'set') {
      // "set key value" (name from .envsync.yml) or "set name key value"
      const [a, b, c] = args;
      if (c !== undefined) cmdSet(a, b, c);
      else cmdSet(resolveName(undefined), a, b);
    }
    else if (cmd === 'unset') {
      // "unset key" (name from .envsync.yml) or "unset name key"
      const [a, b] = args;
      if (b !== undefined) cmdUnset(a, b);
      else cmdUnset(resolveName(undefined), a);
    }
    else if (cmd === 'invite') cmdInvite(resolveName(args[0]));
    else if (cmd === 'identity') cmdIdentity();
    else if (cmd === 'alias') cmdAlias(args[0]);
    else if (cmd === 'invite-device') cmdInviteDevice(args[0], args[1]);
    else if (cmd === 'accept') cmdAccept(args[0], args[1], args[2]);
    else if (cmd === 'rotate') cmdRotate(resolveName(args[0]));
    else if (cmd === 'backup-init') cmdBackupInit(args[0]);
    else if (cmd === 'connect-github') cmdConnectGithub(args[0]);
    else if (cmd === 'invite-github') cmdInviteGithub(args[0]);
    else if (cmd === 'revoke-github') cmdRevokeGithub(args[0]);
    else if (cmd === 'backup') cmdBackup(resolveName(args[0]));
    else if (cmd === 'restore') cmdRestore(resolveName(args[0]), args[1]);
    else if (cmd === 'export') cmdExport(resolveName(args[0]), format);
    else {
      console.log([
        'usage:',
        '  envsync create <name> [file]         create a room; omit file for a vault-only room (no plaintext file ever)',
        '  envsync join <name> <file> <key>    join an existing room with a shared key',
        '  envsync set [name] <key> <value>    set a value directly in the vault -- no file needed',
        '  envsync unset [name] <key>          remove a value directly from the vault',
        '  envsync init <name>                 write .envsync.yml in this dir (metadata only, no secrets)',
        '  envsync sync [name]                 watch + LAN P2P sync with other peers',
        '  envsync daemon                      headless: sync every locally known room in one process',
        '  envsync daemon install               (macOS) install + start a launchd agent that runs "envsync daemon" on login',
        '  envsync daemon uninstall             (macOS) stop and remove the launchd agent',
        '  envsync daemon status                (macOS) check whether the launchd agent is installed/running',
        '  envsync watch [name]                local-only: watch + encrypted history, no networking',
        '  envsync review [name] [--reveal]    show the last change, values masked by default',
        '  envsync preview [name] [--reveal]   show every current key, values masked by default',
        '  envsync status                      list all rooms and whether they have unsynced local edits',
        '  envsync invite [name]                reprint the QR code / join command for an existing room',
        '  envsync identity                     print this device\'s alias and public key (share the key so others can invite you)',
        '  envsync alias [new-name]             print or set this device\'s display name (what peers see in history/notifications)',
        '  envsync invite-device <name> <pubkey> wrap the room key for one device\'s public key -- safe to paste anywhere',
        '  envsync accept <name> <file> <env>    unwrap a device-targeted envelope from invite-device and join',
        '  envsync rotate [name]                generate a new encryption key for this room and append to history',
        '  envsync connect-github [repo-name]   sign in to GitHub once, create/reuse ONE shared private repo, push every room',
        '  envsync backup-init <repo-url>       point the shared backup at an existing private repo you already created',
        '  envsync invite-github <username>    grant a teammate collaborator access to the shared private backup repo',
        '  envsync revoke-github <username>     remove a collaborator from the shared private backup repo',
        '  envsync backup [name]                push one room into the shared GitHub backup',
        '  envsync restore [name] [repo-url]    pull a room from the shared GitHub backup (needs the room key locally already)',
        '  envsync run [name] -- <cmd> [args]  run a command with room values injected into its env (never written to disk)',
        '  envsync export [name] [--format=env] print `export KEY=VALUE` lines for shell/direnv eval, or plain KEY=VALUE with --format=env for --env-file',
        '  envsync history [name]              print decrypted change history',
        '(name is optional wherever a .envsync.yml exists in or above the cwd)',
      ].join('\n'));
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { cmdCreate };
