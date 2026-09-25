#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('Electron not found. Try reinstalling: npm install -g p2p-envsync-tray');
  process.exit(1);
}

let mainPath;
try {
  const envsyncRoot = path.dirname(require.resolve('p2p-envsync/package.json'));
  mainPath = path.join(envsyncRoot, 'tray', 'main.js');
} catch {
  console.error('p2p-envsync not found. Install it first: npm install -g p2p-envsync');
  process.exit(1);
}

const child = spawn(electronPath, [mainPath], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
