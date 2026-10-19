// Local upgrade compatibility: keep existing CodexPro connections and profiles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
for (const [key, value] of Object.entries(process.env)) {
  if (key.startsWith('CODEXPRO_')) {
    const current = 'LOCALWORKSPACEBRIDGE_' + key.slice('CODEXPRO_'.length);
    if (process.env[current] === undefined) process.env[current] = value;
  }
}
if (!process.env.LOCALWORKSPACEBRIDGE_HOME) {
  let oldHome = '';
  if (process.platform === 'win32') {
    const result = require('node:child_process').spawnSync('powershell.exe', [
      '-NoProfile', '-Command',
      "$v=Get-ItemPropertyValue 'HKCU:\\Environment' -Name CODEXPRO_HOME -ErrorAction SilentlyContinue; if($v){[Console]::Out.Write($v)}"
    ], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    if (result.status === 0) oldHome = String(result.stdout || '').trim();
  }
  const defaultOldHome = path.join(os.homedir(), '.codexpro');
  if (oldHome) process.env.LOCALWORKSPACEBRIDGE_HOME = oldHome;
  else if (fs.existsSync(path.join(defaultOldHome, 'profiles'))) process.env.LOCALWORKSPACEBRIDGE_HOME = defaultOldHome;
}
