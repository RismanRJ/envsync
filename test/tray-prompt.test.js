'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const { promptText } = require('../tray/prompt');

const originalPlatform = process.platform;
const originalExecFileSync = cp.execFileSync;

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p });
}

afterEach(() => {
  setPlatform(originalPlatform);
  cp.execFileSync = originalExecFileSync;
});

describe('promptText on win32', () => {
  beforeEach(() => setPlatform('win32'));

  it('builds correct PowerShell command', () => {
    let calledFile, calledArgs;
    cp.execFileSync = (file, args) => {
      calledFile = file;
      calledArgs = args;
      return Buffer.from('user input\n');
    };
    const result = promptText('Enter name:', 'default');
    assert.equal(calledFile, 'powershell');
    const script = calledArgs[calledArgs.length - 1];
    assert.match(script, /Enter name:/);
    assert.match(script, /default/);
    assert.equal(result, 'user input');
  });

  it('escapes single quotes', () => {
    let script;
    cp.execFileSync = (file, args) => {
      script = args[args.length - 1];
      return Buffer.from('ok');
    };
    promptText("it's", "it's");
    assert.match(script, /it''s/);
  });

  it('returns trimmed output', () => {
    cp.execFileSync = () => Buffer.from('  hello  \n');
    assert.equal(promptText('m'), 'hello');
  });

  it('returns null on empty output', () => {
    cp.execFileSync = () => Buffer.from('');
    assert.equal(promptText('m'), null);
  });

  it('returns null on error', () => {
    cp.execFileSync = () => { throw new Error('boom'); };
    assert.equal(promptText('m'), null);
  });
});

describe('promptText on linux', () => {
  beforeEach(() => setPlatform('linux'));

  it('tries zenity first', () => {
    let calledFile;
    cp.execFileSync = (file) => {
      calledFile = file;
      return Buffer.from('zenity result');
    };
    const result = promptText('m');
    assert.equal(calledFile, 'zenity');
    assert.equal(result, 'zenity result');
  });

  it('falls back to kdialog when zenity is missing', () => {
    const calledFiles = [];
    cp.execFileSync = (file) => {
      calledFiles.push(file);
      if (file === 'zenity') {
        const err = new Error('not found');
        err.code = 'ENOENT';
        throw err;
      }
      return Buffer.from('kdialog result');
    };
    const result = promptText('m');
    assert.deepEqual(calledFiles, ['zenity', 'kdialog']);
    assert.equal(result, 'kdialog result');
  });
});
