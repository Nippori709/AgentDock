import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  throw new Error('AgentDock Control Center desktop uninstaller currently supports Windows only.');
}

const script = [
  "$desktop=Join-Path ([Environment]::GetFolderPath('Desktop')) 'AgentDock Control Center.lnk'",
  "$startup=Join-Path ([Environment]::GetFolderPath('Startup')) 'AgentDock Control Supervisor.lnk'",
  "Remove-Item $desktop -Force -ErrorAction SilentlyContinue",
  "Remove-Item $startup -Force -ErrorAction SilentlyContinue"
].join('; ');
spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  windowsHide: true,
  stdio: 'ignore'
});

try {
  const response = await fetch('http://127.0.0.1:48731/api/health');
  if (response.ok) {
    const info = await response.json();
    if (Number.isInteger(info.pid) && info.pid > 0) {
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
    }
  }
} catch {}

if (process.argv.includes('--purge')) {
  fs.rmSync(path.join(os.homedir(), '.agentdock-control'), { recursive: true, force: true });
}

console.log('✓ AgentDock Control Center shortcuts removed.');
console.log('  AgentDock itself was not stopped.');
if (!process.argv.includes('--purge')) {
  console.log('  User Control Center settings were preserved. Use --purge to remove them.');
}
