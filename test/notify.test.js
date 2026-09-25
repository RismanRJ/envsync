'use strict';

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const notifyPath = require.resolve('../notify.js');

let originalPlatform;

function freshNotify() {
  delete require.cache[notifyPath];
  return require(notifyPath).notify;
}

beforeEach(() => {
  originalPlatform = process.platform;
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  mock.restoreAll();
  delete require.cache[notifyPath];
});

function setPlatform(value) {
  Object.defineProperty(process, 'platform', { value });
}

describe('notify() on win32', () => {
  test('dispatches to powershell with expected args', () => {
    setPlatform('win32');
    const execMock = mock.method(cp, 'execFileSync', () => {});
    const notify = freshNotify();
    notify('Test', 'Hello');
    assert.equal(execMock.mock.callCount(), 1);
    const [cmd, args] = execMock.mock.calls[0].arguments;
    assert.equal(cmd, 'powershell');
    assert.equal(args[0], '-NoProfile');
    assert.equal(args[1], '-Command');
    assert.equal(typeof args[2], 'string');
  });

  test('script contains title and message in CreateTextNode calls', () => {
    setPlatform('win32');
    const execMock = mock.method(cp, 'execFileSync', () => {});
    const notify = freshNotify();
    notify('My Title', 'My Message');
    const script = execMock.mock.calls[0].arguments[1][2];
    assert.match(script, /CreateTextNode\('My Title'\)/);
    assert.match(script, /CreateTextNode\('My Message'\)/);
  });

  test('escapes single quotes by doubling them', () => {
    setPlatform('win32');
    const execMock = mock.method(cp, 'execFileSync', () => {});
    const notify = freshNotify();
    notify('Title', "it's a test");
    const script = execMock.mock.calls[0].arguments[1][2];
    assert.match(script, /CreateTextNode\('it''s a test'\)/);
  });

  test('falls back to console on execFileSync failure', () => {
    setPlatform('win32');
    mock.method(cp, 'execFileSync', () => {
      throw new Error('powershell not found');
    });
    const notify = freshNotify();
    const logMock = mock.method(console, 'log', () => {});
    assert.doesNotThrow(() => notify('Title', 'Msg'));
    assert.equal(logMock.mock.callCount(), 1);
    assert.match(logMock.mock.calls[0].arguments[0], /\[notify\] Title: Msg/);
  });
});

describe('notify() on linux', () => {
  test('dispatches to notify-send', () => {
    setPlatform('linux');
    const execMock = mock.method(cp, 'execFileSync', () => {});
    const notify = freshNotify();
    notify('Title', 'Message');
    assert.equal(execMock.mock.callCount(), 1);
    const [cmd, args] = execMock.mock.calls[0].arguments;
    assert.equal(cmd, 'notify-send');
    assert.deepEqual(args, ['Title', 'Message']);
  });
});
