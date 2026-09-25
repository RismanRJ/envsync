'use strict';

// Phase 2: LAN P2P sync. No new deps -- `dgram` multicast stands in for
// mDNS discovery, raw `net` sockets + a room-key HMAC handshake stand in
// for the Noise/libp2p transport. Good enough for one office LAN; swap for
// libp2p if you ever need real NAT traversal or a relay path (Phase 5).

const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const fs = require('fs');
const lib = require('./lib');
const { notify } = require('./notify');
const backup = require('./backup');
const mesh = require('./mesh');
const signal = require('./signal');

const MCAST_ADDR = '239.255.42.99';
const MCAST_PORT = 41234;
const ANNOUNCE_INTERVAL_MS = 3000;
const SIGNAL_INTERVAL_MS = 10000;

function getLocalIp() {
  const ifaces = require('os').networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function startSync(name) {
  const config = lib.loadConfig(name);
  if (!config.peerId) {
    config.peerId = lib.getDeviceIdentity().publicKey;
    lib.saveConfig(name, config);
  }
  const key = config.key;
  const roomHash = lib.roomHash(key);
  lib.recordPeer(name, config.peerId, lib.getDeviceIdentity().label);

  let merged = lib.loadMerged(name);
  // Reconcile against whatever is on disk right now instead of overwriting
  // it: any edits made while sync wasn't running are local changes, not
  // stale data to discard. Vault-only rooms (config.filePath === null) have
  // no file at all -- skip this entirely, or an absent file would read as
  // "the user deleted everything" and wipe the vault.
  let localValues = lib.mergedToValues(merged);
  if (config.filePath) {
    const onDisk = fs.existsSync(config.filePath) ? lib.parseEnv(fs.readFileSync(config.filePath, 'utf8')) : {};
    const startupDiff = lib.diffValues(lib.mergedToValues(merged), onDisk);
    if (Object.keys(startupDiff).length > 0) {
      const ts = Date.now();
      for (const [k, change] of Object.entries(startupDiff)) {
        if (change.type === 'removed') delete merged[k];
        else merged[k] = { value: onDisk[k], ts, peer: config.peerId };
      }
      lib.saveMerged(name, merged);
      lib.appendHistory(name, { ts, values: onDisk, diff: startupDiff, source: config.peerId });
      log('picked up local changes made while sync was stopped:', startupDiff);
    }
    localValues = onDisk;
  }

  const sockets = new Map(); // peerId -> socket
  const connecting = new Set(); // "host:port" currently being dialed

  function sendEncrypted(socket, payload) {
    socket.write(JSON.stringify(lib.encrypt(key, payload)) + '\n');
  }

  function broadcastState() {
    for (const socket of sockets.values()) sendEncrypted(socket, { type: 'state', merged });
  }

  // Best-effort GitHub backup push: debounced so a burst of merges (e.g. a
  // fresh peer's initial full-state exchange) triggers one push, not many.
  // If there's no repo configured yet, or no internet right now, it just
  // fails silently and the periodic retry below picks it up once connected.
  let backupPushTimer = null;
  function scheduleBackupPush() {
    if (!backup.isConnected()) return;
    clearTimeout(backupPushTimer);
    backupPushTimer = setTimeout(() => {
      const result = backup.pushBackup(name);
      if (!result.ok) log(`backup push skipped (${result.reason})`);
    }, 3000);
  }
  setInterval(scheduleBackupPush, 60000);

  // Phase 5: async off-LAN relay. Reuses the GitHub backup as a transport,
  // not just a backup -- periodically pull the shared repo and merge it
  // through the exact same last-write-wins logic used for LAN peers
  // (applyMergedUpdate), so it can never blindly overwrite local state.
  // This is what lets two peers who are never on the same LAN converge --
  // slower than LAN (bounded by RELAY_PULL_MS), but with no server to run.
  const RELAY_PEER_ID = 'github-relay';
  const RELAY_PULL_MS = 45000;
  lib.recordPeer(name, RELAY_PEER_ID, 'GitHub backup');
  function relayPull() {
    if (!backup.isConnected()) return;
    const result = backup.fetchRemoteMerged(name);
    if (!result.ok) { log(`relay pull skipped (${result.reason})`); return; }
    applyMergedUpdate(result.merged, RELAY_PEER_ID);
  }
  setInterval(relayPull, RELAY_PULL_MS);
  relayPull();

  function applyMergedUpdate(remoteMerged, sourcePeer) {
    let changed = false;
    const diff = {};
    for (const [k, remoteEntry] of Object.entries(remoteMerged)) {
      const localEntry = merged[k];
      const remoteWins = !localEntry
        || remoteEntry.ts > localEntry.ts
        || (remoteEntry.ts === localEntry.ts && remoteEntry.peer > localEntry.peer);
      if (remoteWins && (!localEntry || localEntry.value !== remoteEntry.value)) {
        merged[k] = remoteEntry;
        diff[k] = { type: localEntry ? 'changed' : 'added', from: localEntry?.value, to: remoteEntry.value, peer: remoteEntry.peer };
        changed = true;
      }
    }
    if (!changed) return;
    lib.saveMerged(name, merged);
    localValues = lib.mergedToValues(merged);
    if (config.filePath) fs.writeFileSync(config.filePath, lib.serializeEnv(localValues));
    lib.appendHistory(name, { ts: Date.now(), values: localValues, diff, source: sourcePeer });
    const sourceLabel = lib.peerLabel(name, sourcePeer);
    log(`merged update from ${sourceLabel}:`, diff);
    if (sourcePeer !== config.peerId) {
      notify(`envsync: ${name}`, `${sourceLabel} changed ${Object.keys(diff).join(', ')} -- run "envsync review ${name}"`);
    }
    broadcastState();
    scheduleBackupPush();
  }

  // --- TCP: mutual auth (prove room-key knowledge both ways) then encrypted state exchange ---
  function attachSocket(socket, isServer) {
    let authed = false;
    let remotePeerId = null;
    let buf = '';
    const myNonce = crypto.randomBytes(16).toString('hex');

    function proof(nonce) {
      return crypto.createHmac('sha256', Buffer.from(key, 'hex')).update(nonce).digest('hex');
    }

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (!authed) {
          if (msg.type === 'challenge') {
            socket.write(JSON.stringify({ type: 'response', proof: proof(msg.nonce), nonce: myNonce, peerId: config.peerId, label: lib.getDeviceIdentity().label }) + '\n');
          } else if (msg.type === 'response') {
            if (msg.proof !== proof(myNonce)) { socket.destroy(); return; }
            remotePeerId = msg.peerId;
            sockets.set(remotePeerId, socket);
            lib.recordPeer(name, msg.peerId, msg.label);
            if (isServer) socket.write(JSON.stringify({ type: 'ack', proof: proof(msg.nonce), peerId: config.peerId, label: lib.getDeviceIdentity().label }) + '\n');
            authed = true;
            // Always send full state once authed, regardless of side --
            // a brand-new joiner's empty state would otherwise never
            // trigger the other side to send its data back.
            sendEncrypted(socket, { type: 'state', merged });
          } else if (msg.type === 'ack') {
            if (msg.proof !== proof(myNonce)) { socket.destroy(); return; }
            remotePeerId = msg.peerId;
            sockets.set(remotePeerId, socket);
            lib.recordPeer(name, msg.peerId, msg.label);
            authed = true;
            sendEncrypted(socket, { type: 'state', merged });
          }
          continue;
        }
        const payload = lib.decrypt(key, msg);
        if (payload.type === 'state') applyMergedUpdate(payload.merged, remotePeerId);
      }
    });
    socket.on('close', () => {
      for (const [pid, s] of sockets) if (s === socket) sockets.delete(pid);
    });
    socket.on('error', () => socket.destroy());
    if (isServer) socket.write(JSON.stringify({ type: 'challenge', nonce: myNonce }) + '\n');
  }

  function dialPeer(host, port) {
    const addrKey = `${host}:${port}`;
    if (connecting.has(addrKey)) return;
    connecting.add(addrKey);
    const socket = net.createConnection({ host, port }, () => {
      log(`connected to peer at ${addrKey}`);
      attachSocket(socket, false);
    });
    socket.on('error', () => connecting.delete(addrKey));
    socket.on('close', () => connecting.delete(addrKey));
  }

  const server = net.createServer((socket) => attachSocket(socket, true));
  server.listen(0, () => {
    log(`TCP listening on port ${server.address().port}`);

    setInterval(() => {
      try {
        signal.announcePresence(roomHash, {
          peerId: config.peerId,
          label: lib.getDeviceIdentity().label,
          ip: getLocalIp(),
          port: server.address().port,
          meshIps: mesh.getMyMeshIps().map((m) => m.ip),
          ts: Date.now(),
        });
        const peers = signal.discoverPeers(roomHash);
        for (const peer of peers) {
          if (peer.peerId === config.peerId) continue;
          if (sockets.has(peer.peerId)) continue;
          if (config.peerId > peer.peerId) continue;
          if (peer.meshIps && peer.meshIps.length) {
            for (const meshIp of peer.meshIps) dialPeer(meshIp, peer.port);
          }
          dialPeer(peer.ip, peer.port);
        }
      } catch (err) {
        log('gist signaling failed:', err.message);
      }
    }, SIGNAL_INTERVAL_MS);
  });

  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (msg, rinfo) => {
    let announce;
    try { announce = JSON.parse(msg.toString('utf8')); } catch { return; }
    if (announce.roomHash !== roomHash || announce.peerId === config.peerId) return;
    if (sockets.has(announce.peerId)) return;
    // avoid both sides dialing each other: lower peerId initiates.
    if (config.peerId > announce.peerId) return;
    const addrKey = `${rinfo.address}:${announce.port}`;
    if (connecting.has(addrKey)) return;
    connecting.add(addrKey);
    const socket = net.createConnection({ host: rinfo.address, port: announce.port }, () => {
      log(`connected to peer at ${addrKey}`);
      attachSocket(socket, false);
    });
    socket.on('error', () => connecting.delete(addrKey));
    socket.on('close', () => connecting.delete(addrKey));
  });
  udp.bind(MCAST_PORT, () => {
    udp.addMembership(MCAST_ADDR);
    setInterval(() => {
      const payload = Buffer.from(JSON.stringify({ roomHash, peerId: config.peerId, port: server.address().port }));
      udp.send(payload, MCAST_PORT, MCAST_ADDR);
    }, ANNOUNCE_INTERVAL_MS);
  });

  // local file watch -> update merged, write history, broadcast
  // (vault-only rooms have no file, so there's nothing to watch here --
  // editing happens via `envsync set`/`unset` instead, picked up below)
  if (config.filePath) {
    fs.watchFile(config.filePath, { interval: 1000 }, () => {
      if (!fs.existsSync(config.filePath)) return;
      const next = lib.parseEnv(fs.readFileSync(config.filePath, 'utf8'));
      const diff = lib.diffValues(localValues, next);
      if (Object.keys(diff).length === 0) return;
      const ts = Date.now();
      for (const [k, change] of Object.entries(diff)) {
        if (change.type === 'removed') delete merged[k];
        else merged[k] = { value: next[k], ts, peer: config.peerId };
      }
      lib.saveMerged(name, merged);
      localValues = next;
      lib.appendHistory(name, { ts, values: next, diff, source: config.peerId });
      log('local change:', diff);
      broadcastState();
      scheduleBackupPush();
    });
  }

  // `envsync set`/`unset` run from another terminal write straight to the
  // vault (lib.setValue/unsetValue), bypassing this process's in-memory
  // state entirely. Watch the vault file itself so a running `sync` still
  // notices, merges, and broadcasts those edits -- this is the only edit
  // path for vault-only rooms, and works for file-mode rooms too.
  fs.watchFile(lib.mergedFile(name), { interval: 1000 }, () => {
    let fresh;
    try { fresh = lib.loadMerged(name); } catch { return; }
    const diff = {};
    let changed = false;
    for (const [k, entry] of Object.entries(fresh)) {
      if (!merged[k] || merged[k].value !== entry.value) {
        diff[k] = { type: merged[k] ? 'changed' : 'added', from: merged[k]?.value, to: entry.value };
        changed = true;
      }
    }
    for (const k of Object.keys(merged)) {
      if (!(k in fresh)) { diff[k] = { type: 'removed' }; changed = true; }
    }
    if (!changed) return;
    merged = fresh;
    localValues = lib.mergedToValues(merged);
    if (config.filePath) fs.writeFileSync(config.filePath, lib.serializeEnv(localValues));
    log('vault edited directly (set/unset):', diff);
    broadcastState();
    scheduleBackupPush();
  });

  log(`syncing room "${name}" (peer ${config.peerId}, room ${roomHash.slice(0, 8)}...)`);
}

function startAllRooms() {
  const rooms = lib.listRoomStatuses();
  if (!rooms.length) {
    log('no rooms found -- daemon staying alive with nothing to sync yet');
    setInterval(() => {}, 60000);
    return;
  }
  for (const { name } of rooms) {
    try {
      startSync(name);
      log(`daemon: started sync for room "${name}"`);
    } catch (err) {
      log(`daemon: skipping room "${name}" (${err.message})`);
    }
  }
}

module.exports = { startSync, startAllRooms };
