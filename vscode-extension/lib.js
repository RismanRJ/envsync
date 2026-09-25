'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(os.homedir(), '.envsync', 'rooms');

function roomDir(name) {
  return path.join(ROOT, name);
}

function configFile(name) {
  return path.join(roomDir(name), 'config.json');
}

function loadConfig(name) {
  const file = configFile(name);
  if (!fs.existsSync(file)) {
    throw new Error(`Room "${name}" not found. Run: envsync create <name> <file>`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveConfig(name, config) {
  const file = configFile(name);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  fs.chmodSync(file, 0o600);
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function serializeEnv(values) {
  return Object.entries(values)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n') + (Object.keys(values).length ? '\n' : '');
}

function diffValues(prev, next) {
  const diff = {};
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    if (!(key in prev)) diff[key] = { type: 'added', value: next[key] };
    else if (!(key in next)) diff[key] = { type: 'removed' };
    else if (prev[key] !== next[key]) diff[key] = { type: 'changed', from: prev[key], to: next[key] };
  }
  return diff;
}

// ponytail: room key sits in plaintext local config (single trust boundary =
// this device). Real risk once a peer's key material could be exfiltrated
// remotely -- move to OS keychain (keytar) then, not before.
function encrypt(keyHex, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return { iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), data: enc.toString('hex') };
}

function decrypt(keyHex, rec) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyHex, 'hex'), Buffer.from(rec.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(rec.tag, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(rec.data, 'hex')), decipher.final()]);
  return JSON.parse(dec.toString('utf8'));
}

function appendHistory(name, entry) {
  const config = loadConfig(name);
  const record = encrypt(config.key, entry);
  const file = path.join(roomDir(name), 'history.jsonl');
  fs.appendFileSync(file, JSON.stringify(record) + '\n');
  fs.chmodSync(file, 0o600);
}

function readHistory(name) {
  const config = loadConfig(name);
  const file = path.join(roomDir(name), 'history.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => decrypt(config.key, JSON.parse(line)));
}

// merged.json: { [key]: { value, ts, peer } } -- last-write-wins per key.
function mergedFile(name) {
  return path.join(roomDir(name), 'merged.json');
}

function loadMerged(name) {
  const file = mergedFile(name);
  if (!fs.existsSync(file)) return {};
  const config = loadConfig(name);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Pre-encryption merged.json files were plain {key: {value, ts, peer}}.
  // The encrypted envelope shape is always {iv, tag, data}; anything else
  // is old plaintext -- read it as-is, and it'll be re-saved encrypted on
  // the next write.
  if (!('iv' in parsed && 'tag' in parsed && 'data' in parsed)) return parsed;
  return decrypt(config.key, parsed);
}

function saveMerged(name, merged) {
  const config = loadConfig(name);
  const file = mergedFile(name);
  fs.writeFileSync(file, JSON.stringify(encrypt(config.key, merged)));
  fs.chmodSync(file, 0o600);
}

function mergedToValues(merged) {
  const values = {};
  for (const [k, entry] of Object.entries(merged)) values[k] = entry.value;
  return values;
}

// peers.json: { [peerId]: { label, firstSeen, lastSeen } } -- lets history
// and notifications show "Sarah's MacBook" instead of a raw public key.
function peersFile(name) {
  return path.join(roomDir(name), 'peers.json');
}

function loadPeers(name) {
  const file = peersFile(name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function savePeers(name, peers) {
  const file = peersFile(name);
  fs.writeFileSync(file, JSON.stringify(peers, null, 2));
  fs.chmodSync(file, 0o600);
}

function recordPeer(name, peerId, label) {
  const peers = loadPeers(name);
  const now = Date.now();
  peers[peerId] = { label, firstSeen: peers[peerId]?.firstSeen || now, lastSeen: now };
  savePeers(name, peers);
}

function peerLabel(name, peerId) {
  if (!peerId) return 'unknown';
  const peers = loadPeers(name);
  return peers[peerId]?.label || `${peerId.slice(0, 12)}...`;
}

// Public identifier for a room on the LAN -- never the key itself.
function roomHash(keyHex) {
  return crypto.createHmac('sha256', Buffer.from(keyHex, 'hex')).update('envsync-room-id').digest('hex');
}

// --- Per-device identity (X25519) + envelope encryption ---
// One keypair per device, shared across all rooms. The public half is safe
// to hand to anyone; the private half never leaves this machine. Used to
// wrap a room's symmetric key for one specific recipient device, so the
// raw room key never has to be typed/pasted/posted anywhere -- only the
// target device's private key can unwrap it.

function identityFile() {
  return path.join(path.dirname(ROOT), 'identity.json');
}

function getDeviceIdentity() {
  const file = identityFile();
  if (fs.existsSync(file)) {
    const identity = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!identity.label) {
      identity.label = os.hostname();
      fs.writeFileSync(file, JSON.stringify(identity, null, 2));
    }
    // Always re-assert 0600 here too, not just on write -- heals any file
    // created before this permission fix existed.
    fs.chmodSync(file, 0o600);
    return identity;
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  const identity = {
    publicKey: publicKey.toString('hex'),
    privateKey: privateKey.toString('hex'),
    label: os.hostname(),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(identity, null, 2));
  fs.chmodSync(file, 0o600);
  return identity;
}

function setDeviceAlias(label) {
  const identity = getDeviceIdentity();
  identity.label = label;
  const file = identityFile();
  fs.writeFileSync(file, JSON.stringify(identity, null, 2));
  fs.chmodSync(file, 0o600);
  return identity;
}

function sharedSecretKey(myPrivateKeyHex, theirPublicKeyHex) {
  const priv = crypto.createPrivateKey({ key: Buffer.from(myPrivateKeyHex, 'hex'), format: 'der', type: 'pkcs8' });
  const pub = crypto.createPublicKey({ key: Buffer.from(theirPublicKeyHex, 'hex'), format: 'der', type: 'spki' });
  return crypto.createHash('sha256').update(crypto.diffieHellman({ privateKey: priv, publicKey: pub })).digest();
}

function wrapRoomKey(roomKeyHex, recipientPublicKeyHex) {
  const me = getDeviceIdentity();
  const aesKey = sharedSecretKey(me.privateKey, recipientPublicKeyHex);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(roomKeyHex, 'hex')), cipher.final()]);
  return {
    from: me.publicKey,
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: enc.toString('hex'),
  };
}

function unwrapRoomKey(envelope) {
  const me = getDeviceIdentity();
  const aesKey = sharedSecretKey(me.privateKey, envelope.from);
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, Buffer.from(envelope.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'hex'));
  const dec = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'hex')), decipher.final()]);
  return dec.toString('hex');
}

// .envsync.yml: metadata only (room name + tracked file), never secrets.
// Hand-rolled two-key parser -- not general YAML, just enough for this fixed shape.
function findProjectConfig(startDir) {
  let dir = startDir;
  while (true) {
    const file = path.join(dir, '.envsync.yml');
    if (fs.existsSync(file)) {
      const out = {};
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^(\w+):\s*(.+)$/);
        if (m) out[m[1]] = m[2].trim();
      }
      return out;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function writeProjectConfig(dir, { room, file }) {
  fs.writeFileSync(path.join(dir, '.envsync.yml'), `room: ${room}\nfile: ${file}\n`);
}

function currentValues(name) {
  const merged = loadMerged(name);
  if (Object.keys(merged).length) return mergedToValues(merged);
  const config = loadConfig(name);
  return config.filePath && fs.existsSync(config.filePath) ? parseEnv(fs.readFileSync(config.filePath, 'utf8')) : {};
}

// Direct vault edits, for rooms with no on-disk file at all -- the only
// way to change a value in a vault-only room, since there's no file to
// watch. Also usable for file-mode rooms (a running `sync` daemon picks
// these up the same way it picks up a remote peer's change, see net.js).
function setValue(name, key, value) {
  const config = loadConfig(name);
  const merged = loadMerged(name);
  const prev = merged[key]?.value;
  merged[key] = { value, ts: Date.now(), peer: config.peerId || getDeviceIdentity().publicKey };
  saveMerged(name, merged);
  appendHistory(name, {
    ts: Date.now(),
    values: mergedToValues(merged),
    diff: { [key]: prev === undefined ? { type: 'added', value } : { type: 'changed', from: prev, to: value } },
    source: config.peerId || getDeviceIdentity().publicKey,
  });
}

function unsetValue(name, key) {
  const config = loadConfig(name);
  const merged = loadMerged(name);
  if (!(key in merged)) return;
  delete merged[key];
  saveMerged(name, merged);
  appendHistory(name, {
    ts: Date.now(),
    values: mergedToValues(merged),
    diff: { [key]: { type: 'removed' } },
    source: config.peerId || getDeviceIdentity().publicKey,
  });
}

// Keep a still-used on-disk tracked file out of git even if someone forgets
// -- cheap insurance against a plaintext .env ending up in a commit.
function ensureGitignored(filePath) {
  const dir = path.dirname(filePath);
  const gitignorePath = path.join(dir, '.gitignore');
  const basename = path.basename(filePath);
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (existing.split('\n').map((l) => l.trim()).includes(basename)) return;
  fs.writeFileSync(gitignorePath, existing && !existing.endsWith('\n') ? `${existing}\n${basename}\n` : `${existing}${basename}\n`);
}

function listRoomStatuses() {
  if (!fs.existsSync(ROOT)) return [];
  const statuses = [];
  for (const name of fs.readdirSync(ROOT)) {
    let config;
    try { config = loadConfig(name); } catch { continue; }
    const merged = loadMerged(name);
    const mergedValues = mergedToValues(merged);
    const onDisk = fs.existsSync(config.filePath) ? parseEnv(fs.readFileSync(config.filePath, 'utf8')) : {};
    const pending = Object.keys(diffValues(mergedValues, onDisk)).length > 0;
    const history = readHistory(name);
    const lastTs = history.length ? history[history.length - 1].ts : null;
    statuses.push({ name, filePath: config.filePath, pending, lastTs });
  }
  return statuses;
}

function rotateRoomKey(name) {
  const config = loadConfig(name);
  const merged = loadMerged(name);
  const newKey = crypto.randomBytes(32).toString('hex');
  config.key = newKey;
  saveConfig(name, config);
  saveMerged(name, merged);
  const mergedValues = mergedToValues(merged);
  appendHistory(name, { ts: Date.now(), values: mergedValues, diff: {}, rotated: true });
  return newKey;
}

function mask(value) {
  return value.length <= 2 ? '••' : `${value[0]}${'•'.repeat(Math.min(value.length - 1, 8))}`;
}

module.exports = {
  ROOT, roomDir, configFile, loadConfig, saveConfig,
  parseEnv, serializeEnv, diffValues,
  encrypt, decrypt, appendHistory, readHistory,
  loadMerged, saveMerged, mergedToValues, roomHash,
  findProjectConfig, writeProjectConfig, mask, listRoomStatuses, currentValues,
  setValue, unsetValue, ensureGitignored, mergedFile,
  getDeviceIdentity, setDeviceAlias, wrapRoomKey, unwrapRoomKey,
  loadPeers, savePeers, recordPeer, peerLabel, rotateRoomKey,
};
