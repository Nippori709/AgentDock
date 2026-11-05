import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStableNodeRuntime, verifyRuntimeDependencies } from './runtime-node.mjs';

export const LAUNCH_AGENT_LABEL = 'com.agentdock.control-center';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const controlRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(controlRoot, '..');
const serverScript = path.join(controlRoot, 'server.mjs');

function assertMac() {
  if (process.platform !== 'darwin') throw new Error('This operation requires macOS.');
  if (typeof process.getuid !== 'function' || process.getuid() === 0) {
    throw new Error('Install AgentDock as your normal macOS user, without sudo.');
  }
}

export function launchAgentPath(home = os.homedir()) {
  return path.posix.join(home, 'Library', 'LaunchAgents', LAUNCH_AGENT_LABEL + '.plist');
}

export function launchAgentTarget(uid = process.getuid()) {
  return 'gui/' + uid + '/' + LAUNCH_AGENT_LABEL;
}

function launchAgentDomain(uid = process.getuid()) {
  return 'gui/' + uid;
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function launchAgentEnvironmentPath(nodePath, sourcePath = process.env.PATH || '') {
  return [...new Set([
    path.posix.dirname(nodePath),
    ...String(sourcePath).split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin'
  ].filter(Boolean))].join(':');
}

// launchd does not inherit the user's interactive shell environment. Keep the
// service's Node path absolute and give child tools an explicit, stable PATH.
// Never embed workspace auth tokens or tunnel credentials in the plist.
export function buildLaunchAgentPlist({ nodePath, home = os.homedir(), workingDirectory = controlRoot, sourcePath = process.env.PATH || '' }) {
  const logDir = path.posix.join(home, '.agentdock-control', 'logs');
  const fields = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key><string>' + xml(LAUNCH_AGENT_LABEL) + '</string>',
    '  <key>ProgramArguments</key><array>',
    '    <string>' + xml(nodePath) + '</string>',
    '    <string>' + xml(path.posix.join(workingDirectory, 'control-center', 'server.mjs')) + '</string>',
    '  </array>',
    '  <key>WorkingDirectory</key><string>' + xml(path.posix.join(workingDirectory, 'control-center')) + '</string>',
    '  <key>EnvironmentVariables</key><dict>',
    '    <key>HOME</key><string>' + xml(home) + '</string>',
    '    <key>PATH</key><string>' + xml(launchAgentEnvironmentPath(nodePath, sourcePath)) + '</string>',
    '    <key>AGENTDOCK_CONTROL_NO_OPEN</key><string>1</string>',
    '  </dict>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key><true/>',
    '  <key>ThrottleInterval</key><integer>15</integer>',
    '  <key>StandardOutPath</key><string>' + xml(path.posix.join(logDir, 'control-center.out.log')) + '</string>',
    '  <key>StandardErrorPath</key><string>' + xml(path.posix.join(logDir, 'control-center.err.log')) + '</string>',
    '</dict>',
    '</plist>'
  ];
  return fields.join('\n') + '\n';
}

function launchctl(args) {
  return spawnSync('/bin/launchctl', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000
  });
}

export function macLaunchAgentStatus(home = os.homedir(), uid = process.getuid()) {
  const plist = launchAgentPath(home);
  const installed = fs.existsSync(plist);
  if (process.platform !== 'darwin') return { installed, loaded: false, plist, detail: 'Not running on macOS' };
  const status = launchctl(['print', launchAgentTarget(uid)]);
  return {
    installed,
    loaded: !status.error && status.status === 0,
    plist,
    detail: String(status.stderr || status.error || '').trim()
  };
}

export async function installMacControlCenter({ noStartup = false } = {}) {
  assertMac();
  if (!fs.existsSync(serverScript) || !fs.existsSync(path.join(repoRoot, 'dist', 'http.js'))) {
    throw new Error('AgentDock build is missing. Run npm run build first.');
  }
  const { selected } = resolveStableNodeRuntime();
  verifyRuntimeDependencies(selected.path, repoRoot);
  if (noStartup) {
    console.log('✓ macOS Control Center dependencies verified (startup installation skipped).');
    return;
  }

  const home = os.homedir();
  const plist = launchAgentPath(home);
  const logDir = path.posix.join(home, '.agentdock-control', 'logs');
  const previous = fs.existsSync(plist) ? fs.readFileSync(plist, 'utf8') : null;
  const newPlist = buildLaunchAgentPlist({ nodePath: selected.path, home, workingDirectory: repoRoot });
  fs.mkdirSync(path.dirname(plist), { recursive: true, mode: 0o755 });
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });

  // A previous service may already be loaded. Remove it before replacing the
  // plist, then restore the old service on bootstrap failure.
  launchctl(['bootout', launchAgentDomain(), plist]);
  const temp = plist + '.' + process.pid + '.tmp';
  try {
    fs.writeFileSync(temp, newPlist, { mode: 0o644 });
    fs.renameSync(temp, plist);
    const enabled = launchctl(['enable', launchAgentTarget()]);
    if (enabled.error) throw enabled.error;
    const started = launchctl(['bootstrap', launchAgentDomain(), plist]);
    if (started.error || started.status !== 0) {
      throw new Error('launchctl bootstrap failed: ' + String(started.stderr || started.error || started.stdout || 'unknown error').trim());
    }
  } catch (error) {
    fs.rmSync(temp, { force: true });
    if (previous === null) {
      fs.rmSync(plist, { force: true });
    } else {
      fs.writeFileSync(plist, previous, { mode: 0o644 });
      launchctl(['bootstrap', launchAgentDomain(), plist]);
    }
    throw error;
  }

  console.log('✓ AgentDock Control Center LaunchAgent installed and started.');
  console.log('  Service: ' + launchAgentTarget());
  console.log('  Startup file: ' + plist);
  console.log('  Node: ' + selected.path + ' (v' + selected.version + ')');
  console.log('  Control Center: http://127.0.0.1:48731');
  console.log('  To open the UI: npm run control-center:start');
  console.log('  To verify: npm run control-center:doctor');
  if (!fs.existsSync(path.join(home, '.local-workspace-bridge', 'profiles'))) {
    console.log('  First use: node scripts/local-workspace-bridge.mjs setup');
  }
}

export async function uninstallMacControlCenter({ purge = false } = {}) {
  assertMac();
  const plist = launchAgentPath();
  // Only unload our own per-user service. Never touch system LaunchDaemons.
  launchctl(['bootout', launchAgentDomain(), plist]);
  fs.rmSync(plist, { force: true });
  if (purge) {
    fs.rmSync(path.join(os.homedir(), '.agentdock-control'), { recursive: true, force: true });
  }
  console.log('✓ AgentDock macOS Control Center LaunchAgent removed.');
  console.log('  AgentDock workspace profiles and tunnel credentials were not removed.');
  if (!purge) console.log('  Control Center settings preserved; pass --purge to remove them.');
}
