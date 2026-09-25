'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const backup = require('./backup.js');

const STALE_MS = 60 * 1000;
const gistIdCache = {};

function descFor(roomHash) {
  return `envsync-signal-${roomHash.slice(0, 16)}`;
}

function tmpFile(contents) {
  const file = path.join(os.tmpdir(), `envsync-peers-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, contents);
  return file;
}

function findSignalGist(roomHash) {
  if (gistIdCache[roomHash]) return gistIdCache[roomHash];
  const desc = descFor(roomHash);
  try {
    const gists = JSON.parse(execFileSync('gh', ['api', '/gists?per_page=100']).toString());
    const match = gists.find(g => g.description === desc);
    if (!match) return null;
    gistIdCache[roomHash] = match.id;
    return match.id;
  } catch {
    return null;
  }
}

function readGistPeers(gistId) {
  try {
    const data = JSON.parse(execFileSync('gh', ['api', `/gists/${gistId}`]).toString());
    const content = data.files && data.files['peers.json'] && data.files['peers.json'].content;
    return content ? JSON.parse(content) : {};
  } catch {
    return {};
  }
}

function announcePresence(roomHash, announcement) {
  if (!backup.isGhAuthenticated()) return;
  const desc = descFor(roomHash);
  let file;
  try {
    let gistId = findSignalGist(roomHash);
    if (!gistId) {
      file = tmpFile(JSON.stringify({ [announcement.peerId]: announcement }));
      const out = execFileSync('gh', ['gist', 'create', '--filename', 'peers.json', '--desc', desc, '--public=false', file]).toString();
      const match = out.trim().match(/([a-f0-9]{20,})/);
      if (match) gistIdCache[roomHash] = match[1];
      return;
    }
    const peers = readGistPeers(gistId);
    peers[announcement.peerId] = announcement;
    file = tmpFile(JSON.stringify(peers));
    execFileSync('gh', ['gist', 'edit', gistId, '-f', 'peers.json', file]);
  } catch {
    // no internet, not authed, rate limited -- signaling is best-effort
  } finally {
    if (file) { try { fs.unlinkSync(file); } catch {} }
  }
}

function discoverPeers(roomHash) {
  if (!backup.isGhAuthenticated()) return [];
  try {
    const gistId = findSignalGist(roomHash);
    if (!gistId) return [];
    const peers = readGistPeers(gistId);
    const now = Date.now();
    return Object.values(peers).filter(p => now - p.ts < STALE_MS);
  } catch {
    return [];
  }
}

module.exports = { announcePresence, discoverPeers, findSignalGist };
