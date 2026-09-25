#!/usr/bin/env node
'use strict';

const { spawn } = require('child_process');
const path = require('path');

let electronPath;
try {
  electronPath = require('electron');
} catch {
  console.error('Electron not found. Install the tray package: npm install -g p2p-envsync-tray');
  process.exit(1);
}

const appPath = path.join(__dirname, 'main.js');
const child = spawn(electronPath, [appPath], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
