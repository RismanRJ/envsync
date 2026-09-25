'use strict';

const cp = require('child_process');

function promptText(message, defaultAnswer = '') {
  const escape = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  if (process.platform === 'darwin') {
    try {
      const out = cp.execFileSync('osascript', ['-e',
        `display dialog "${escape(message)}" default answer "${escape(defaultAnswer)}" with title "EnvSync"`,
      ]).toString();
      const match = out.match(/text returned:(.*)$/s);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  if (process.platform === 'win32') {
    const escapePowerShell = (s) => s.replace(/'/g, "''");
    const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::InputBox('${escapePowerShell(message)}', 'EnvSync', '${escapePowerShell(defaultAnswer)}')`;
    try {
      const out = cp.execFileSync('powershell', ['-NoProfile', '-Command', script]).toString().trim();
      return out || null;
    } catch {
      return null;
    }
  }

  if (process.platform === 'linux') {
    try {
      return cp.execFileSync('zenity', ['--entry', '--title=EnvSync', `--text=${message}`, `--entry-text=${defaultAnswer}`]).toString().trim();
    } catch (err) {
      if (err.code === 'ENOENT') {
        try {
          return cp.execFileSync('kdialog', ['--inputbox', message, defaultAnswer]).toString().trim();
        } catch (fallbackErr) {
          if (fallbackErr.code === 'ENOENT') {
            console.error('Install zenity or kdialog to use this feature on Linux, or use the CLI instead.');
            return null;
          }
          return null;
        }
      }
      return null;
    }
  }

  return null;
}

module.exports = { promptText };
