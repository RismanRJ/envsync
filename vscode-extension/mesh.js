'use strict';

const { execFileSync } = require('child_process');

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8' });
}

function hasTailscale() {
  try {
    run('tailscale', ['version']);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

function hasZerotier() {
  try {
    run('zerotier-cli', ['info']);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}

function getTailscaleStatus() {
  try {
    return JSON.parse(run('tailscale', ['status', '--json']));
  } catch (err) {
    return null;
  }
}

function getZerotierJson(args) {
  try {
    return JSON.parse(run('zerotier-cli', args));
  } catch (err) {
    return [];
  }
}

function getTailscalePeers() {
  const status = getTailscaleStatus();
  if (!status || !status.Peer) return [];
  const peers = [];
  for (const key of Object.keys(status.Peer)) {
    const peer = status.Peer[key];
    if (peer.Online && Array.isArray(peer.TailscaleIPs)) {
      for (const ip of peer.TailscaleIPs) peers.push({ ip, source: 'tailscale' });
    }
  }
  return peers;
}

function getTailscaleSelfIps() {
  const status = getTailscaleStatus();
  const ips = status && status.Self && status.Self.TailscaleIPs;
  return Array.isArray(ips) ? ips.map((ip) => ({ ip, source: 'tailscale' })) : [];
}

function getZerotierSelfIps() {
  const networks = getZerotierJson(['listnetworks', '-j']);
  const ips = [];
  for (const net of networks) {
    for (const addr of net.assignedAddresses || []) {
      ips.push({ ip: addr.split('/')[0], source: 'zerotier' });
    }
  }
  return ips;
}

function getZerotierPeers() {
  const peers = getZerotierJson(['listpeers', '-j']);
  const ips = [];
  for (const peer of peers) {
    for (const path of peer.paths || []) {
      if (path.active && path.address) {
        ips.push({ ip: path.address.split('/')[0], source: 'zerotier' });
      }
    }
  }
  return ips;
}

function getMeshPeers() {
  return [...getTailscalePeers(), ...getZerotierPeers()];
}

function getMyMeshIps() {
  return [...getTailscaleSelfIps(), ...getZerotierSelfIps()];
}

module.exports = { hasTailscale, hasZerotier, getMeshPeers, getMyMeshIps };
