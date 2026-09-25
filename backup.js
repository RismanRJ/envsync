'use strict';

// Backup/restore ALL rooms' encrypted vaults (merged.json + history.jsonl --
// both already AES-256-GCM encrypted, never plaintext) to ONE shared private
// GitHub repo, one subfolder per room. Connect once; every room's `sync`
// pushes into its own subfolder of the same repo. Plain `git`/`gh` shelled
// out to -- no GitHub API client library, no server of our own to run.
// This is a backup channel, not the sync transport: LAN P2P (net.js) stays
// the primary, always-on path; this is what recovers a room if no LAN peer
// is ever reachable, or a device is lost.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const lib = require('./lib');

function sharedDir() {
  return path.join(path.dirname(lib.ROOT), 'backup');
}

function backupConfigFile() {
  return path.join(path.dirname(lib.ROOT), 'backup-config.json');
}

function loadBackupConfig() {
  const file = backupConfigFile();
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

function saveBackupConfig(config) {
  const file = backupConfigFile();
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  fs.chmodSync(file, 0o600);
}

function isConnected() {
  return loadBackupConfig() !== null;
}

function git(args) {
  return execFileSync('git', args, { cwd: sharedDir(), stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

// One-time setup: point the shared backup repo at a GitHub URL.
function connectRepo(repoUrl) {
  const dir = sharedDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    git(['init']);
    git(['checkout', '-b', 'main']);
  }
  const remotes = git(['remote']).split('\n').filter(Boolean);
  if (remotes.includes('origin')) git(['remote', 'set-url', 'origin', repoUrl]);
  else git(['remote', 'add', 'origin', repoUrl]);
  saveBackupConfig({ repoUrl });
}

function stageRoom(name) {
  const dir = path.join(sharedDir(), name);
  fs.mkdirSync(dir, { recursive: true });
  const roomFile = path.join(lib.roomDir(name), 'merged.json');
  const historyFile = path.join(lib.roomDir(name), 'history.jsonl');
  if (fs.existsSync(roomFile)) fs.copyFileSync(roomFile, path.join(dir, 'merged.json'));
  if (fs.existsSync(historyFile)) fs.copyFileSync(historyFile, path.join(dir, 'history.jsonl'));
}

// Best-effort push: called opportunistically (after a merge, or on a timer)
// while `sync` is running. Silently does nothing if not connected yet or
// there's no internet -- this is what "keeps in sync with the cloud
// whenever connected" means in practice: retry next time, don't block.
function pushBackup(name) {
  if (!isConnected()) return { ok: false, reason: 'not connected -- run "envsync connect-github"' };
  stageRoom(name);
  try {
    git(['add', name]);
    if (git(['status', '--porcelain']).trim()) {
      git(['commit', '-m', `envsync backup: ${name} ${new Date().toISOString()}`]);
    }
    try {
      git(['push', '-u', 'origin', 'main']);
    } catch {
      // another room/device pushed in between -- rebase once and retry
      git(['pull', '--rebase', 'origin', 'main']);
      git(['push', '-u', 'origin', 'main']);
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: (err.stderr || err.message).toString().trim().split('\n').pop() };
  }
}

// Phase 5: read-only fetch for the async relay in net.js -- pulls the
// shared repo and decrypts the room's remote merged state WITHOUT
// touching local room files. The caller merges this through the same
// last-write-wins logic used for LAN peers (applyMergedUpdate), so a
// stale or divergent remote can never blindly clobber local state.
function fetchRemoteMerged(name) {
  if (!isConnected()) return { ok: false, reason: 'not connected' };
  try {
    git(['pull', '--rebase', 'origin', 'main']);
  } catch (err) {
    return { ok: false, reason: (err.stderr || err.message).toString().trim().split('\n').pop() };
  }
  const file = path.join(sharedDir(), name, 'merged.json');
  if (!fs.existsSync(file)) return { ok: true, merged: {} };
  try {
    const config = lib.loadConfig(name);
    const encrypted = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, merged: lib.decrypt(config.key, encrypted) };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

function pullBackup(name) {
  if (!isConnected()) return { ok: false, reason: 'not connected -- run "envsync connect-github"' };
  try {
    git(['pull', '--rebase', 'origin', 'main']);
  } catch (err) {
    return { ok: false, reason: (err.stderr || err.message).toString().trim().split('\n').pop() };
  }
  const dir = path.join(sharedDir(), name);
  const roomFile = path.join(lib.roomDir(name), 'merged.json');
  const historyFile = path.join(lib.roomDir(name), 'history.jsonl');
  if (fs.existsSync(path.join(dir, 'merged.json'))) fs.copyFileSync(path.join(dir, 'merged.json'), roomFile);
  if (fs.existsSync(path.join(dir, 'history.jsonl'))) fs.copyFileSync(path.join(dir, 'history.jsonl'), historyFile);
  return { ok: true };
}

// --- GitHub connection, via the `gh` CLI (browser OAuth is `gh`'s job,
// not ours -- no reason to reimplement it when the CLI already does it
// well and is likely already installed on a dev machine). ---

function isGhInstalled() {
  try { execFileSync('gh', ['--version']); return true; } catch { return false; }
}

function isGhAuthenticated() {
  try { execFileSync('gh', ['auth', 'status']); return true; } catch { return false; }
}

function githubLogin() {
  return execFileSync('gh', ['api', 'user', '--jq', '.login']).toString().trim();
}

// Blocks until the user finishes the browser flow -- fine for a CLI
// (it has a controlling terminal). The tray can't block this way; see
// tray/main.js for how it opens a real Terminal window instead.
function loginInteractive() {
  execFileSync('gh', ['auth', 'login', '--web', '--git-protocol', 'https'], { stdio: 'inherit' });
}

// Parses "https://github.com/<owner>/<repo>.git" -- the only shape
// connectRepo/createGithubRepo ever produce or accept.
function parseRepoUrl(url) {
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Not a recognizable GitHub URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

// The repo is kept private, so a new peer's own GitHub account needs
// collaborator access before their `sync` can push/pull the shared
// backup -- only the repo's owner/admin can grant that. GitHub sends the
// invitee a real invite they still have to accept themselves; this just
// starts that process via `gh api` instead of the web UI.
function addCollaborator(username) {
  const config = loadBackupConfig();
  if (!config) throw new Error('not connected -- run "envsync connect-github" first');
  const { owner, repo } = parseRepoUrl(config.repoUrl);
  execFileSync('gh', ['api', `repos/${owner}/${repo}/collaborators/${username}`, '-X', 'PUT']);
}

function removeCollaborator(username) {
  const config = loadBackupConfig();
  if (!config) throw new Error('not connected -- run "envsync connect-github" first');
  const { owner, repo } = parseRepoUrl(config.repoUrl);

  try {
    execFileSync('gh', ['api', `repos/${owner}/${repo}/collaborators/${username}`, '-X', 'DELETE']);
  } catch {
    // Not an accepted collaborator; check for pending invitation instead
  }

  try {
    const invitationsJson = execFileSync('gh', ['api', `repos/${owner}/${repo}/invitations`]).toString();
    const invitations = JSON.parse(invitationsJson);
    const invitation = invitations.find(inv => inv.invitee.login.toLowerCase() === username.toLowerCase());
    if (invitation) {
      execFileSync('gh', ['api', `repos/${owner}/${repo}/invitations/${invitation.id}`, '-X', 'DELETE']);
    }
  } catch {
    // Silently ignore if invitations endpoint fails or no invitation found
  }
}

function createGithubRepo(repoName) {
  try {
    execFileSync('gh', ['repo', 'create', repoName, '--private']);
  } catch (err) {
    const message = (err.stderr || err.message).toString();
    if (!/already exists/i.test(message)) throw err;
  }
  return `https://github.com/${githubLogin()}/${repoName}.git`;
}

const DEFAULT_REPO_NAME = 'envsync-vault';

module.exports = {
  sharedDir, loadBackupConfig, isConnected, connectRepo, pushBackup, pullBackup, fetchRemoteMerged,
  isGhInstalled, isGhAuthenticated, githubLogin, loginInteractive, createGithubRepo, addCollaborator, removeCollaborator, DEFAULT_REPO_NAME,
};
