import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  discoverNodeRuntimes,
  isLikelyTemporaryNodePath,
  resolveStableNodeRuntime,
  verifyRuntimeDependencies
} from './runtime-node.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const controlRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(controlRoot, '..');
const bridgeHome = path.resolve(
  process.env.LOCALWORKSPACEBRIDGE_HOME || path.join(os.homedir(), '.local-workspace-bridge')
);
const startupShortcutName = 'AgentDock Control Supervisor.lnk';

function result(name, status, detail, blocking = false) {
  return { name, status, detail, blocking };
}

function findNpm(nodePath) {
  const besideNode = process.platform === 'win32'
    ? path.join(path.dirname(nodePath), 'npm.cmd')
    : path.join(path.dirname(nodePath), 'npm');
  if (fs.existsSync(besideNode)) return besideNode;
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const check = spawnSync(command, ['npm'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (check.error || check.status !== 0) return null;
  return String(check.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function startupShortcutPath() {
  if (process.platform !== 'win32') return null;
  const script = "[Environment]::GetFolderPath('Startup')";
  const response = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (response.error || response.status !== 0) return null;
  const folder = String(response.stdout || '').trim();
  return folder ? path.join(folder, startupShortcutName) : null;
}

function readShortcut(shortcutPath) {
  if (!shortcutPath || !fs.existsSync(shortcutPath) || process.platform !== 'win32') return null;
  const script = [
    '$ws = New-Object -ComObject WScript.Shell',
    '$s = $ws.CreateShortcut($env:AD_SHORTCUT)',
    '[PSCustomObject]@{ target=$s.TargetPath; arguments=$s.Arguments; workingDirectory=$s.WorkingDirectory } | ConvertTo-Json -Compress'
  ].join('; ');
  const response = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, AD_SHORTCUT: shortcutPath },
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (response.error || response.status !== 0) return null;
  try {
    return JSON.parse(String(response.stdout || '').trim());
  } catch {
    return null;
  }
}

function latestSavedProfile() {
  const profilesDir = path.join(bridgeHome, 'profiles');
  if (!fs.existsSync(profilesDir)) return null;
  const profiles = fs.readdirSync(profilesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(profilesDir, name), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
  return profiles[0] || null;
}

async function httpReady(url, headers = {}) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

const checks = [];
if (process.platform !== 'win32') {
  checks.push(result('Platform', 'WARN', 'Desktop Control Center startup checks are intended for Windows 10/11.'));
}

const discovered = discoverNodeRuntimes();
let selectedNode = null;
try {
  const selection = resolveStableNodeRuntime({ candidates: discovered });
  selectedNode = selection.selected;
  checks.push(result(
    'Stable Node.js',
    'PASS',
    `${selectedNode.path} (v${selectedNode.version})`
  ));
} catch (error) {
  checks.push(result('Stable Node.js', 'FAIL', error instanceof Error ? error.message : String(error), true));
}

const currentTemporary = isLikelyTemporaryNodePath(process.execPath);
checks.push(result(
  'Current installer Node',
  currentTemporary ? 'WARN' : 'PASS',
  `${process.execPath}${currentTemporary ? ' (temporary/cache runtime; should not be used for sign-in startup)' : ''}`
));

if (selectedNode) {
  const npmPath = findNpm(selectedNode.path);
  checks.push(result(
    'npm',
    npmPath ? 'PASS' : 'WARN',
    npmPath || 'npm was not found next to the selected Node or on PATH. Runtime can start, but fresh installs/updates need npm.'
  ));
}

const distHttp = path.join(repoRoot, 'dist', 'http.js');
checks.push(result(
  'AgentDock build',
  fs.existsSync(distHttp) ? 'PASS' : 'FAIL',
  fs.existsSync(distHttp) ? distHttp : 'dist/http.js is missing. Run "npm run build".',
  !fs.existsSync(distHttp)
));

if (selectedNode) {
  try {
    verifyRuntimeDependencies(selectedNode.path, repoRoot);
    checks.push(result('Runtime dependencies', 'PASS', 'MCP SDK and zod resolve with the selected Node runtime.'));
  } catch (error) {
    checks.push(result('Runtime dependencies', 'FAIL', error instanceof Error ? error.message : String(error), true));
  }
}

const savedProfile = latestSavedProfile();
const profilePresent = Boolean(savedProfile);
checks.push(result(
  'Saved AgentDock profile',
  profilePresent ? 'PASS' : 'FAIL',
  profilePresent
    ? path.join(bridgeHome, 'profiles')
    : 'No saved workspace profile was found. Run "node scripts/local-workspace-bridge.mjs setup" once.',
  !profilePresent
));

const shortcutPath = startupShortcutPath();
const shortcut = readShortcut(shortcutPath);
if (!shortcut) {
  checks.push(result(
    'Windows sign-in shortcut',
    'FAIL',
    shortcutPath
      ? `Missing or unreadable: ${shortcutPath}. Run "npm run control-center:install".`
      : 'Unable to resolve the Windows Startup folder.',
    true
  ));
} else {
  const args = String(shortcut.arguments || '');
  const selectedMatches = selectedNode
    ? args.toLowerCase().includes(selectedNode.path.toLowerCase())
    : false;
  const temporaryShortcut = /\\(?:\.cache|appdata\\local\\temp|codex-runtimes|codex-primary-runtime)\\/i.test(args);
  const safe = selectedMatches && !temporaryShortcut;
  checks.push(result(
    'Windows sign-in shortcut',
    safe ? 'PASS' : 'FAIL',
    safe
      ? `${shortcutPath} -> ${selectedNode.path}`
      : `Startup shortcut is not bound to the selected stable Node runtime. Arguments: ${args}`,
    !safe
  ));
}

const controlReady = await httpReady('http://127.0.0.1:48731/api/health');
checks.push(result(
  'Control Center 48731',
  controlReady ? 'PASS' : 'WARN',
  controlReady ? 'Local Control Center is reachable.' : 'Not currently reachable. The sign-in supervisor may not be running yet.'
));

const agentDockReady = await httpReady(
  'http://127.0.0.1:8787/healthz',
  savedProfile?.token ? { Authorization: `Bearer ${savedProfile.token}` } : {}
);
checks.push(result(
  'AgentDock 8787',
  agentDockReady ? 'PASS' : 'WARN',
  agentDockReady ? 'Local AgentDock MCP server is reachable.' : 'Not currently reachable. Check the Control Center log after startup.'
));

const blocking = checks.filter((check) => check.blocking && check.status === 'FAIL');
const rebootReady = blocking.length === 0;

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rebootReady, checks, discoveredNodeRuntimes: discovered }, null, 2));
} else {
  console.log('AgentDock Control Center doctor');
  console.log('===============================');
  for (const check of checks) {
    const icon = check.status === 'PASS' ? '✓' : check.status === 'WARN' ? '!' : '✗';
    console.log(`${icon} [${check.status}] ${check.name}`);
    for (const line of String(check.detail || '').split(/\r?\n/)) {
      console.log(`    ${line}`);
    }
  }
  console.log('');
  if (rebootReady) {
    console.log('✓ AgentDock is ready for reboot-safe Windows startup.');
  } else {
    console.log('✗ AgentDock is not ready for reboot-safe Windows startup.');
    console.log('  Fix the FAIL items above, then rerun "npm run control-center:doctor".');
  }
}

if (!rebootReady) process.exitCode = 1;
