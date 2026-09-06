import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function profileIdForRoot(root) {
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-control-apply-smoke-'));
const rootPath = path.join(temp, 'root');
const allowedPath = path.join(temp, 'allowed');
fs.mkdirSync(rootPath, { recursive: true });
fs.mkdirSync(allowedPath, { recursive: true });
const root = fs.realpathSync(rootPath);
const allowed = fs.realpathSync(allowedPath);
const bridgeHome = path.join(temp, 'bridge-home');
const controlHome = path.join(temp, 'control-home');
const port = await freePort();
const token = 'smoke';

process.env.LOCALWORKSPACEBRIDGE_HOME = bridgeHome;
process.env.AGENTDOCK_CONTROL_HOME = controlHome;

fs.mkdirSync(path.join(bridgeHome, 'profiles'), { recursive: true });
fs.mkdirSync(controlHome, { recursive: true });

const profilePath = path.join(bridgeHome, 'profiles', `${profileIdForRoot(root)}.json`);
fs.writeFileSync(profilePath, JSON.stringify({
  version: 1,
  root,
  port: String(port),
  mode: 'agent',
  tunnel: 'none',
  token,
  bash: 'safe',
  write: 'workspace',
  toolMode: 'standard'
}, null, 2) + '\n');

fs.writeFileSync(path.join(controlHome, 'config.json'), JSON.stringify({
  defaultRoot: root,
  allowedRoots: [allowed],
  bashMode: 'safe',
  toolMode: 'standard',
  writeMode: 'workspace'
}, null, 2) + '\n');

const { applyConfig, getState, stopRuntime } = await import('../backend/controller.mjs');
let runtime = null;

try {
  const before = await getState();
  if (before.status.running) throw new Error('isolated smoke unexpectedly found a running AgentDock');

  const progress = [];
  const result = await applyConfig({
    defaultRoot: root,
    allowedRoots: [allowed],
    bashMode: 'off',
    toolMode: 'full',
    writeMode: 'off'
  }, (stage) => progress.push(stage));

  runtime = result.status.runtime;
  if (!result.status.running) throw new Error('AgentDock did not start');
  if (!result.status.matchesSaved) throw new Error(`applied config did not verify: ${JSON.stringify(result.status)}`);
  if (result.status.liveConfig.bashMode !== 'off') throw new Error('bash mode was not applied');
  if (result.status.liveConfig.toolMode !== 'full') throw new Error('tool mode was not applied');
  if (result.status.liveConfig.writeMode !== 'off') throw new Error('write mode was not applied');
  for (const required of ['validate', 'profile', 'start', 'verify', 'done']) {
    if (!progress.includes(required)) throw new Error(`missing progress stage: ${required}`);
  }

  const saved = JSON.parse(fs.readFileSync(path.join(controlHome, 'config.json'), 'utf8'));
  if (saved.bashMode !== 'off' || saved.toolMode !== 'full' || saved.writeMode !== 'off') {
    throw new Error('saved config does not match applied config');
  }

  const pidBeforeHotReload = runtime.pid;
  const hotProgress = [];
  const hotResult = await applyConfig({
    defaultRoot: root,
    allowedRoots: [allowed],
    bashMode: 'full',
    toolMode: 'minimal',
    writeMode: 'workspace'
  }, (stage) => hotProgress.push(stage));
  runtime = hotResult.status.runtime;
  if (hotResult.hotReloaded !== true || hotResult.restarted !== false) {
    throw new Error(`expected runtime hot reload without restart: ${JSON.stringify(hotResult)}`);
  }
  if (runtime.pid !== pidBeforeHotReload) throw new Error('AgentDock launcher PID changed during hot reload');
  if (!hotProgress.includes('hot-reload')) throw new Error('hot-reload progress stage was not observed');
  if (hotProgress.includes('stop') || hotProgress.includes('start')) throw new Error('hot reload unexpectedly used restart stages');
  if (hotResult.status.liveConfig.bashMode !== 'full') throw new Error('hot bash mode was not applied');
  if (hotResult.status.liveConfig.toolMode !== 'minimal') throw new Error('hot tool mode was not applied');
  if (hotResult.status.liveConfig.writeMode !== 'workspace') throw new Error('hot write mode was not applied');

  console.log('✓ AgentDock Control Center initial start/restart/verify smoke passed');
  console.log(`✓ Control Center hot apply kept AgentDock launcher PID ${pidBeforeHotReload}`);
} finally {
  if (runtime) {
    try { await stopRuntime(runtime); } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 300));
  fs.rmSync(temp, { recursive: true, force: true });
}
