'use strict';

const { test, describe, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

let tempHome;
let lib;

// Must set HOME before requiring lib.js, since it computes ROOT from os.homedir() at module load time
before(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'envsync-test-'));
  process.env.HOME = tempHome;
  // Now require lib.js after HOME is set
  lib = require('../lib.js');
});

after(() => {
  // Clean up temp directory
  if (tempHome && fs.existsSync(tempHome)) {
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

// Isolated temp dir for each test to avoid state leakage
function freshTempHome() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'envsync-test-'));
  return temp;
}

describe('lib.js encryption and decryption', () => {
  test('encrypt/decrypt round-trip with correct key', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const obj = { DATABASE_URL: 'postgres://localhost', API_KEY: 'secret123' };

    const encrypted = lib.encrypt(key, obj);
    assert(encrypted.iv, 'encrypted should have iv');
    assert(encrypted.tag, 'encrypted should have tag');
    assert(encrypted.data, 'encrypted should have data');

    const decrypted = lib.decrypt(key, encrypted);
    assert.deepEqual(decrypted, obj, 'decrypted object should match original');
  });

  test('decrypt with wrong key throws', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const wrongKey = crypto.randomBytes(32).toString('hex');
    const obj = { TEST: 'value' };

    const encrypted = lib.encrypt(key, obj);
    assert.throws(() => lib.decrypt(wrongKey, encrypted), 'decrypting with wrong key should throw');
  });

  test('encrypt/decrypt preserves object types', () => {
    const key = crypto.randomBytes(32).toString('hex');
    const obj = {
      string: 'hello',
      number: 42,
      boolean: true,
      null: null,
      nested: { key: 'value' },
      array: [1, 2, 3],
    };

    const encrypted = lib.encrypt(key, obj);
    const decrypted = lib.decrypt(key, encrypted);
    assert.deepEqual(decrypted, obj, 'complex object should survive encryption/decryption');
  });
});

describe('lib.diffValues', () => {
  test('detects added keys', () => {
    const prev = {};
    const next = { KEY: 'value' };

    const diff = lib.diffValues(prev, next);
    assert.deepEqual(diff.KEY, { type: 'added', value: 'value' });
  });

  test('detects removed keys', () => {
    const prev = { KEY: 'value' };
    const next = {};

    const diff = lib.diffValues(prev, next);
    assert.deepEqual(diff.KEY, { type: 'removed' });
  });

  test('detects changed values', () => {
    const prev = { KEY: 'old' };
    const next = { KEY: 'new' };

    const diff = lib.diffValues(prev, next);
    assert.deepEqual(diff.KEY, { type: 'changed', from: 'old', to: 'new' });
  });

  test('detects multiple changes', () => {
    const prev = { A: 'a', B: 'b', C: 'c' };
    const next = { A: 'a1', B: 'b', D: 'd' };

    const diff = lib.diffValues(prev, next);
    assert.deepEqual(diff.A, { type: 'changed', from: 'a', to: 'a1' });
    assert(!('B' in diff), 'unchanged value should not be in diff');
    assert.deepEqual(diff.C, { type: 'removed' });
    assert.deepEqual(diff.D, { type: 'added', value: 'd' });
  });

  test('empty diff when objects are identical', () => {
    const prev = { KEY: 'value' };
    const next = { KEY: 'value' };

    const diff = lib.diffValues(prev, next);
    assert.deepEqual(diff, {});
  });
});

describe('lib.mask', () => {
  test('masks short strings to ••', () => {
    assert.equal(lib.mask(''), '••');
    assert.equal(lib.mask('a'), '••');
    assert.equal(lib.mask('ab'), '••');
  });

  test('masks longer strings with first char and dots', () => {
    const masked = lib.mask('secret123');
    assert(!masked.includes('secret'), 'mask should not include full plaintext');
    assert(!masked.includes('123'), 'mask should not include trailing plaintext');
    assert(masked.startsWith('s'), 'mask should start with first character');
    assert(masked.includes('•'), 'mask should contain bullet characters');
  });

  test('mask length is reasonable', () => {
    const masked = lib.mask('verylongpasswordvalue');
    assert(masked.length < 15, 'mask should be much shorter than plaintext');
  });

  test('different secrets with different first char produce different masks', () => {
    const mask1 = lib.mask('secret1');
    const mask2 = lib.mask('aaaaaa1');
    assert.notEqual(mask1, mask2, 'values with different first chars should produce different masks');
    assert(mask1.startsWith('s'), 'mask1 should start with s');
    assert(mask2.startsWith('a'), 'mask2 should start with a');
  });
});

describe('lib.mergedToValues', () => {
  test('extracts values from merged format', () => {
    const merged = {
      DATABASE_URL: { value: 'postgres://localhost', ts: 123, peer: 'peer1' },
      API_KEY: { value: 'key123', ts: 124, peer: 'peer2' },
    };

    const values = lib.mergedToValues(merged);
    assert.deepEqual(values, { DATABASE_URL: 'postgres://localhost', API_KEY: 'key123' });
  });

  test('returns empty object for empty merged state', () => {
    const values = lib.mergedToValues({});
    assert.deepEqual(values, {});
  });

  test('handles null and falsy values', () => {
    const merged = {
      NULL_VAL: { value: null, ts: 1, peer: 'p1' },
      ZERO: { value: '0', ts: 2, peer: 'p2' },
      EMPTY_STR: { value: '', ts: 3, peer: 'p3' },
    };

    const values = lib.mergedToValues(merged);
    assert.deepEqual(values, { NULL_VAL: null, ZERO: '0', EMPTY_STR: '' });
  });
});

describe('lib.ensureGitignored', () => {
  let testDir;

  beforeEach(() => {
    testDir = freshTempHome();
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('creates .gitignore with entry if it does not exist', () => {
    const filePath = path.join(testDir, '.env');
    lib.ensureGitignored(filePath);

    const gitignorePath = path.join(testDir, '.gitignore');
    assert(fs.existsSync(gitignorePath), '.gitignore should exist');

    const content = fs.readFileSync(gitignorePath, 'utf8');
    assert(content.includes('.env'), '.gitignore should contain .env');
  });

  test('appends to existing .gitignore without duplicating', () => {
    const gitignorePath = path.join(testDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'node_modules/\n');

    const filePath = path.join(testDir, '.env');
    lib.ensureGitignored(filePath);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    assert(content.includes('node_modules/'), 'existing content should be preserved');
    assert(content.includes('.env'), '.env should be added');
  });

  test('does not duplicate entry on second call', () => {
    const filePath = path.join(testDir, '.env');
    lib.ensureGitignored(filePath);
    lib.ensureGitignored(filePath);

    const gitignorePath = path.join(testDir, '.gitignore');
    const content = fs.readFileSync(gitignorePath, 'utf8');
    const matches = content.split('\n').filter((l) => l.trim() === '.env');
    assert.equal(matches.length, 1, '.env should appear exactly once in .gitignore');
  });

  test('handles .gitignore without trailing newline', () => {
    const gitignorePath = path.join(testDir, '.gitignore');
    fs.writeFileSync(gitignorePath, 'existing_entry');

    const filePath = path.join(testDir, '.env');
    lib.ensureGitignored(filePath);

    const content = fs.readFileSync(gitignorePath, 'utf8');
    const lines = content.split('\n').filter(Boolean);
    assert(lines.includes('existing_entry'), 'existing entry should be preserved');
    assert(lines.includes('.env'), '.env should be added on new line');
  });
});

describe('room lifecycle: config, merged, setValue, unsetValue', () => {
  let testDir;
  let tempHomeForRoom;

  beforeEach(() => {
    testDir = freshTempHome();
    tempHomeForRoom = testDir;
    process.env.HOME = tempHomeForRoom;
    // Need to re-require lib with new HOME for each test to pick up new ROOT
    delete require.cache[require.resolve('../lib.js')];
    lib = require('../lib.js');
  });

  afterEach(() => {
    if (tempHomeForRoom && fs.existsSync(tempHomeForRoom)) {
      fs.rmSync(tempHomeForRoom, { recursive: true, force: true });
    }
  });

  test('create and load config', () => {
    const name = 'test-room';
    const config = {
      name,
      filePath: '/tmp/.env.test',
      key: crypto.randomBytes(32).toString('hex'),
      peerId: 'test-peer-id',
    };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const loaded = lib.loadConfig(name);
    assert.deepEqual(loaded, config, 'loaded config should match saved config');
  });

  test('saveConfig chmod 0600', () => {
    const name = 'test-room';
    const config = { name, key: 'test-key' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const mode = fs.statSync(lib.configFile(name)).mode & 0o777;
    assert.equal(mode, 0o600, 'config file should have 0o600 permissions');
  });

  test('saveMerged encrypts and chmod 0600', () => {
    const name = 'test-room';
    const config = { name, key: crypto.randomBytes(32).toString('hex') };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const merged = {
      API_KEY: { value: 'secret', ts: Date.now(), peer: 'peer1' },
    };

    lib.saveMerged(name, merged);

    const mode = fs.statSync(lib.mergedFile(name)).mode & 0o777;
    assert.equal(mode, 0o600, 'merged file should have 0o600 permissions');

    const loaded = lib.loadMerged(name);
    assert.deepEqual(loaded, merged, 'loaded merged should match saved state after decryption');
  });

  test('loadMerged returns {} if file does not exist', () => {
    const name = 'nonexistent-room';
    const config = { name, key: 'test-key' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const merged = lib.loadMerged(name);
    assert.deepEqual(merged, {}, 'loadMerged should return empty object if file missing');
  });

  test('setValue adds to merged state', () => {
    const name = 'test-room';
    const config = { name, key: crypto.randomBytes(32).toString('hex'), peerId: 'my-peer' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);
    lib.saveMerged(name, {});

    lib.setValue(name, 'DATABASE_URL', 'postgres://localhost');

    const values = lib.currentValues(name);
    assert.equal(values.DATABASE_URL, 'postgres://localhost', 'setValue should persist value');
  });

  test('unsetValue removes from merged state', () => {
    const name = 'test-room';
    const config = { name, key: crypto.randomBytes(32).toString('hex'), peerId: 'my-peer' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const initial = {
      KEY1: { value: 'value1', ts: Date.now(), peer: 'peer1' },
      KEY2: { value: 'value2', ts: Date.now(), peer: 'peer2' },
    };
    lib.saveMerged(name, initial);

    lib.unsetValue(name, 'KEY1');

    const values = lib.currentValues(name);
    assert(!('KEY1' in values), 'KEY1 should be removed');
    assert.equal(values.KEY2, 'value2', 'KEY2 should remain');
  });

  test('currentValues returns merged values when they exist', () => {
    const name = 'test-room';
    const key = crypto.randomBytes(32).toString('hex');
    const config = { name, key, filePath: null };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const merged = {
      VAR1: { value: 'val1', ts: Date.now(), peer: 'peer1' },
      VAR2: { value: 'val2', ts: Date.now(), peer: 'peer2' },
    };
    lib.saveMerged(name, merged);

    const values = lib.currentValues(name);
    assert.deepEqual(values, { VAR1: 'val1', VAR2: 'val2' });
  });

  test('currentValues falls back to file if no merged state', () => {
    const envFile = path.join(tempHomeForRoom, '.env.test');
    fs.writeFileSync(envFile, 'FROM_FILE=file_value\n');

    const name = 'test-room';
    const config = { name, key: crypto.randomBytes(32).toString('hex'), filePath: envFile };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const values = lib.currentValues(name);
    assert.equal(values.FROM_FILE, 'file_value', 'currentValues should read from file when no merged state');
  });
});

describe('device identity and envelope encryption', () => {
  let tempHomeForIdentity;

  beforeEach(() => {
    tempHomeForIdentity = freshTempHome();
    process.env.HOME = tempHomeForIdentity;
    delete require.cache[require.resolve('../lib.js')];
    lib = require('../lib.js');
  });

  afterEach(() => {
    if (tempHomeForIdentity && fs.existsSync(tempHomeForIdentity)) {
      fs.rmSync(tempHomeForIdentity, { recursive: true, force: true });
    }
  });

  test('getDeviceIdentity creates keypair and returns identity', () => {
    const identity = lib.getDeviceIdentity();

    assert(identity.publicKey, 'identity should have publicKey');
    assert(identity.privateKey, 'identity should have privateKey');
    assert(identity.label, 'identity should have label');

    assert(typeof identity.publicKey === 'string', 'publicKey should be string');
    assert(typeof identity.privateKey === 'string', 'privateKey should be string');
    assert(typeof identity.label === 'string', 'label should be string');

    assert(identity.publicKey.length > 0, 'publicKey should not be empty');
    assert(identity.privateKey.length > 0, 'privateKey should not be empty');
  });

  test('getDeviceIdentity creates identity.json with 0o600 permissions', () => {
    lib.getDeviceIdentity();

    const identityFile = path.join(path.dirname(lib.ROOT), 'identity.json');
    assert(fs.existsSync(identityFile), 'identity.json should be created');

    const mode = fs.statSync(identityFile).mode & 0o777;
    assert.equal(mode, 0o600, 'identity.json should have 0o600 permissions');
  });

  test('getDeviceIdentity returns same identity on subsequent calls', () => {
    const identity1 = lib.getDeviceIdentity();
    const identity2 = lib.getDeviceIdentity();

    assert.equal(identity1.publicKey, identity2.publicKey, 'publicKey should be consistent');
    assert.equal(identity1.privateKey, identity2.privateKey, 'privateKey should be consistent');
  });

  test('wrapRoomKey/unwrapRoomKey round-trip with same device', () => {
    const roomKey = crypto.randomBytes(32).toString('hex');
    const identity = lib.getDeviceIdentity();

    const envelope = lib.wrapRoomKey(roomKey, identity.publicKey);
    assert(envelope.from, 'envelope should have from');
    assert(envelope.iv, 'envelope should have iv');
    assert(envelope.tag, 'envelope should have tag');
    assert(envelope.data, 'envelope should have data');

    const unwrapped = lib.unwrapRoomKey(envelope);
    assert.equal(unwrapped, roomKey, 'unwrapped key should match original');
  });

  test('unwrapRoomKey fails with envelope from wrong sender (tampering protection)', () => {
    // Device 1 wraps for Device 1
    const roomKey = crypto.randomBytes(32).toString('hex');
    const device1 = lib.getDeviceIdentity();
    const envelope = lib.wrapRoomKey(roomKey, device1.publicKey);

    // Create a third device with valid X25519 public key to simulate tampering with valid-but-wrong sender
    const tempHomeDevice3 = freshTempHome();
    process.env.HOME = tempHomeDevice3;
    delete require.cache[require.resolve('../lib.js')];
    const libDevice3 = require('../lib.js');
    const device3 = libDevice3.getDeviceIdentity();

    // Restore original HOME and lib for test continuation
    process.env.HOME = tempHomeForIdentity;
    delete require.cache[require.resolve('../lib.js')];
    lib = require('../lib.js');

    // Create envelope with Device 3's valid public key as sender (wrong but properly formatted)
    const tamperedEnvelope = { ...envelope, from: device3.publicKey };

    assert.throws(() => lib.unwrapRoomKey(tamperedEnvelope), 'unwrapping with wrong valid sender key should throw');

    // Clean up Device 3's temp home
    if (fs.existsSync(tempHomeDevice3)) fs.rmSync(tempHomeDevice3, { recursive: true, force: true });
  });

  test('wrapRoomKey/unwrapRoomKey with cross-device scenario', () => {
    // Device A wraps a key intended for Device B
    const tempHomeA = freshTempHome();
    process.env.HOME = tempHomeA;
    delete require.cache[require.resolve('../lib.js')];
    const libA = require('../lib.js');
    const deviceA = libA.getDeviceIdentity();

    // Device B
    const tempHomeB = freshTempHome();
    process.env.HOME = tempHomeB;
    delete require.cache[require.resolve('../lib.js')];
    const libB = require('../lib.js');
    const deviceB = libB.getDeviceIdentity();

    // Device A wraps a room key for Device B
    const roomKey = crypto.randomBytes(32).toString('hex');
    const envelope = libA.wrapRoomKey(roomKey, deviceB.publicKey);

    // Device B can unwrap it (because envelope.from is Device A's public key, and Device B knows how to verify)
    const unwrapped = libB.unwrapRoomKey(envelope);
    assert.equal(unwrapped, roomKey, 'Device B should unwrap key wrapped by Device A');

    // Clean up temp homes
    if (fs.existsSync(tempHomeA)) fs.rmSync(tempHomeA, { recursive: true, force: true });
    if (fs.existsSync(tempHomeB)) fs.rmSync(tempHomeB, { recursive: true, force: true });
  });
});

describe('lib.rotateRoomKey', () => {
  let testDir;
  let tempHomeForRotate;

  beforeEach(() => {
    testDir = freshTempHome();
    tempHomeForRotate = testDir;
    process.env.HOME = tempHomeForRotate;
    delete require.cache[require.resolve('../lib.js')];
    lib = require('../lib.js');
  });

  afterEach(() => {
    if (tempHomeForRotate && fs.existsSync(tempHomeForRotate)) {
      fs.rmSync(tempHomeForRotate, { recursive: true, force: true });
    }
  });

  test('rotateRoomKey generates new key and updates config', () => {
    const name = 'test-room';
    const oldKey = crypto.randomBytes(32).toString('hex');
    const config = { name, key: oldKey, peerId: 'test-peer' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const merged = {
      SECRET: { value: 'mysecret', ts: Date.now(), peer: 'peer1' },
    };
    lib.saveMerged(name, merged);

    const newKey = lib.rotateRoomKey(name);
    assert.notEqual(newKey, oldKey, 'new key should differ from old key');

    const updatedConfig = lib.loadConfig(name);
    assert.equal(updatedConfig.key, newKey, 'config should have new key');
  });

  test('rotateRoomKey preserves values after rotation', () => {
    const name = 'test-room';
    const oldKey = crypto.randomBytes(32).toString('hex');
    const config = { name, key: oldKey, peerId: 'test-peer' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const merged = {
      API_KEY: { value: 'key123', ts: Date.now(), peer: 'peer1' },
      DB_URL: { value: 'postgres://db', ts: Date.now(), peer: 'peer1' },
    };
    lib.saveMerged(name, merged);

    const oldValues = lib.currentValues(name);
    lib.rotateRoomKey(name);
    const newValues = lib.currentValues(name);

    assert.deepEqual(newValues, oldValues, 'values should be preserved after rotation');
    assert.equal(newValues.API_KEY, 'key123');
    assert.equal(newValues.DB_URL, 'postgres://db');
  });

  test('old key cannot decrypt merged.json after rotation', () => {
    const name = 'test-room';
    const oldKey = crypto.randomBytes(32).toString('hex');
    const config = { name, key: oldKey, peerId: 'test-peer' };

    fs.mkdirSync(lib.roomDir(name), { recursive: true });
    lib.saveConfig(name, config);

    const merged = {
      SECRET: { value: 'data', ts: Date.now(), peer: 'peer1' },
    };
    lib.saveMerged(name, merged);

    lib.rotateRoomKey(name);

    // Try to decrypt merged.json with old key
    const mergedContent = JSON.parse(fs.readFileSync(lib.mergedFile(name), 'utf8'));
    assert.throws(() => lib.decrypt(oldKey, mergedContent), 'old key should not decrypt rotated merged.json');
  });
});
