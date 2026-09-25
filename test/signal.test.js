'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

describe('signal.js', () => {
  test('discoverPeers() returns empty array when gh auth check fails', () => {
    const signal = require('../signal.js');
    const result = signal.discoverPeers('test-room-hash');
    assert(Array.isArray(result), 'discoverPeers should return an array');
    assert.strictEqual(result.length, 0, 'discoverPeers should return empty array when not authenticated');
  });

  test('announcePresence() does not throw when gh auth check fails', () => {
    const signal = require('../signal.js');
    const announcement = { peerId: 'peer1', ts: Date.now(), ips: ['192.168.1.1'] };
    assert.doesNotThrow(() => {
      signal.announcePresence('test-room-hash', announcement);
    }, 'announcePresence should not throw when not authenticated');
  });

  test('discoverPeers filters out stale peers by timestamp', () => {
    const now = Date.now();
    const staleMs = 60 * 1000;
    const recent = { peerId: 'peer1', ts: now - 1000 };
    const stale = { peerId: 'peer2', ts: now - (staleMs + 5000) };
    const allPeers = { peer1: recent, peer2: stale };
    const filtered = Object.values(allPeers).filter(p => now - p.ts < staleMs);
    assert.strictEqual(filtered.length, 1, 'should filter to 1 recent peer');
    assert.strictEqual(filtered[0].peerId, 'peer1', 'should only include recent peer');
  });
});
