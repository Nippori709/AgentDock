import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStableNodeRuntime, verifyRuntimeDependencies } from './runtime-node.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const controlRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(controlRoot, '..');
const runnerVbs = path.join(__dirname, 'run-hidden.vbs');
const desktopScript = path.join(__dirname, 'desktop.mjs');
const launcher = path.join(repoRoot, 'scripts', 'local-workspace-bridge.mjs');
const distHttp = path.join(repoRoot, 'dist', 'http.js');
const noStartup = process.argv.includes('--no-startup');

if (process.platform !== 'win32') {
  throw new Error('AgentDock Control Center desktop installer currently supports Windows 10/11 only.');
}
if (!fs.existsSync(launcher)) throw new Error(`AgentDock launcher not found: ${launcher}`);
if (!fs.existsSync(distHttp)) {
  throw new Error('AgentDock is not built yet. Run "npm install" and "npm run build" from the repository root first.');
}
if (!fs.existsSync(runnerVbs) || !fs.existsSync(desktopScript)) {
  throw new Error('Control Center launcher files are incomplete.');
}

const runtimeSelection = resolveStableNodeRuntime();
const nodePath = runtimeSelection.selected.path;
verifyRuntimeDependencies(nodePath, repoRoot);
const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
if (!fs.existsSync(wscript)) throw new Error(`wscript.exe not found: ${wscript}`);

const script = [
  "$ErrorActionPreference='Stop'",
  "$ws=New-Object -ComObject WScript.Shell",
  "$desktop=[Environment]::GetFolderPath('Desktop')",
  "$startup=[Environment]::GetFolderPath('Startup')",
  "$desktopPath=Join-Path $desktop 'AgentDock Control Center.lnk'",
  "$s=$ws.CreateShortcut($desktopPath)",
  "$s.TargetPath=$env:AD_WSCRIPT",
  `$s.Arguments='"'+$env:AD_RUNNER+'" "'+$env:AD_NODE+'" "'+$env:AD_DESKTOP+'" "ui"'`,
  "$s.WorkingDirectory=$env:AD_CONTROL_ROOT",
  "$s.Description='AgentDock Control Center'",
  "$s.Save()",
  "if ($env:AD_NO_STARTUP -ne '1') {",
  "  $startupPath=Join-Path $startup 'AgentDock Control Supervisor.lnk'",
  "  $t=$ws.CreateShortcut($startupPath)",
  "  $t.TargetPath=$env:AD_WSCRIPT",
  `  $t.Arguments='"'+$env:AD_RUNNER+'" "'+$env:AD_NODE+'" "'+$env:AD_DESKTOP+'" "supervisor"'`,
  "  $t.WorkingDirectory=$env:AD_CONTROL_ROOT",
  "  $t.Description='AgentDock background supervisor'",
  "  $t.Save()",
  "}",
  "Write-Output $desktopPath"
].join('; ');

const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  encoding: 'utf8',
  windowsHide: true,
  env: {
    ...process.env,
    AD_WSCRIPT: wscript,
    AD_RUNNER: runnerVbs,
    AD_NODE: nodePath,
    AD_DESKTOP: desktopScript,
    AD_CONTROL_ROOT: controlRoot,
    AD_NO_STARTUP: noStartup ? '1' : '0'
  }
});
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'Failed to create shortcuts').trim());

if (!noStartup) {
  const supervisor = spawn(wscript, [runnerVbs, nodePath, desktopScript, 'supervisor'], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  supervisor.unref();
}

const profilesDir = path.join(process.env.LOCALWORKSPACEBRIDGE_HOME || path.join(os.homedir(), '.local-workspace-bridge'), 'profiles');
const hasProfile = fs.existsSync(profilesDir) && fs.readdirSync(profilesDir).some((name) => name.endsWith('.json'));

console.log('✓ AgentDock Control Center installed.');
console.log(`  Desktop shortcut: ${String(result.stdout || '').trim()}`);
console.log(`  Node runtime: ${nodePath} (v${runtimeSelection.selected.version})`);
if (path.resolve(process.execPath).toLowerCase() !== path.resolve(nodePath).toLowerCase()) {
  console.log(`  Installer Node: ${process.execPath}`);
  console.log('  Note: selected a different stable Node runtime for reboot-safe startup.');
}
if (!noStartup) console.log('  Background supervisor: enabled at Windows sign-in');
if (!hasProfile) {
  console.log('');
  console.log('Note: no saved AgentDock workspace profile was found.');
  console.log('Run "node scripts/local-workspace-bridge.mjs setup" once before using the Control Center to start AgentDock.');
}
