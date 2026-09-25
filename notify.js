'use strict';

// Native OS notifications -- no GUI framework, no new deps. Each platform's
// own bundled tool does the work: osascript (mac), notify-send (Linux,
// ships with most desktop distros), PowerShell toast (Windows 10+).

const { execFileSync } = require('child_process');

function escapeAppleScript(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function notifyDarwin(title, message) {
  execFileSync('osascript', ['-e', `display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`]);
}

function notifyLinux(title, message) {
  execFileSync('notify-send', [title, message]);
}

// ponytail: shells out to powershell for a toast; untested on real Windows,
// fix on first report if the XML namespace/API surface has drifted.
function notifyWindows(title, message) {
  const escape = (s) => s.replace(/'/g, "''");
  const script = `
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
    $texts = $template.GetElementsByTagName('text')
    $texts.Item(0).AppendChild($template.CreateTextNode('${escape(title)}')) > $null
    $texts.Item(1).AppendChild($template.CreateTextNode('${escape(message)}')) > $null
    $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('envsync').Show($toast)
  `;
  execFileSync('powershell', ['-NoProfile', '-Command', script]);
}

function notify(title, message) {
  try {
    if (process.platform === 'darwin') return notifyDarwin(title, message);
    if (process.platform === 'linux') return notifyLinux(title, message);
    if (process.platform === 'win32') return notifyWindows(title, message);
  } catch {
    // fall through to console
  }
  console.log(`[notify] ${title}: ${message}`);
}

module.exports = { notify };
