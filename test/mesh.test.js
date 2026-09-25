'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const mesh = require('../mesh.js');

describe('mesh.js', () => {
  test('hasTailscale() returns false when tailscale is not in PATH', () => {
    const result = mesh.hasTailscale();
    assert.strictEqual(result, false, 'hasTailscale should return false when not installed');
  });

  test('hasZerotier() returns false when zerotier-cli is not in PATH', () => {
    const result = mesh.hasZerotier();
    assert.strictEqual(result, false, 'hasZerotier should return false when not installed');
  });

  test('getMeshPeers() returns empty array when no mesh VPN is installed', () => {
    const result = mesh.getMeshPeers();
    assert(Array.isArray(result), 'getMeshPeers should return an array');
    assert.strictEqual(result.length, 0, 'getMeshPeers should return empty array');
  });

  test('getMyMeshIps() returns empty array when no mesh VPN is installed', () => {
    const result = mesh.getMyMeshIps();
    assert(Array.isArray(result), 'getMyMeshIps should return an array');
    assert.strictEqual(result.length, 0, 'getMyMeshIps should return empty array');
  });
});
