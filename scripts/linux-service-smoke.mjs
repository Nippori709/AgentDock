import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(args, env, expectedStatus = 0) {
  const result = spawnSync(process.execPath, ['scripts/local-workspace-bridge.mjs', ...args], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (result.status !== expectedStatus) {
    throw new Error(`local-workspace-bridge ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  return `${result.stdout}\n${result.stderr}`;
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-linux-service-'));
const home = path.join(temp, 'local-workspace-bridge-home');
const root = path.join(temp, 'server project');
await fs.mkdir(root, { recursive: true });

const env = {
  ...process.env,
  LOCALWORKSPACEBRIDGE_HOME: home,
  NO_COLOR: '1'
};

try {
  run([
    'settings', 'set',
    '--root', root,
    '--tunnel', 'ngrok',
    '--hostname', 'linux-example.ngrok-free.dev',
    '--token', 'linux-service-test-token-1234567890',
    '--bash', 'safe'
  ], env);

  const unit = run(['service', 'install', '--root', root, '--dry-run'], env);
  for (const expected of [
    '[Unit]',
    '[Service]',
    '[Install]',
    'Restart=on-failure',
    '--no-copy-url',
    'WantedBy=default.target'
  ]) {
    if (!unit.includes(expected)) throw new Error(`generated systemd unit is missing ${expected}\n${unit}`);
  }
  if (unit.includes('linux-service-test-token-1234567890')) {
    throw new Error('generated systemd unit leaked the saved LocalWorkspaceBridge token');
  }
  if (unit.includes('WorkingDirectory=')) {
    throw new Error(`generated systemd unit should not set WorkingDirectory; older systemd releases can treat quoted paths as invalid\n${unit}`);
  }
  if (!unit.includes('server project')) {
    throw new Error(`generated systemd unit did not preserve a workspace path containing spaces\n${unit}`);
  }

  const lowMemoryUnit = run(['service', 'install', '--root', root, '--low-memory', '--dry-run'], env);
  for (const expected of [
    'LOCALWORKSPACEBRIDGE_LOW_MEMORY=1',
    'MemoryAccounting=true',
    'MemoryHigh=650M',
    'MemoryMax=850M'
  ]) {
    if (!lowMemoryUnit.includes(expected)) throw new Error(`low-memory systemd unit is missing ${expected}\n${lowMemoryUnit}`);
  }

  run([
    'settings', 'set',
    '--root', root,
    '--tunnel', 'ngrok',
    '--hostname', 'linux-example.ngrok-free.dev',
    '--low-memory'
  ], env);
  const savedLowMemoryUnit = run(['service', 'install', '--root', root, '--dry-run'], env);
  if (!savedLowMemoryUnit.includes('LOCALWORKSPACEBRIDGE_LOW_MEMORY=1')) {
    throw new Error(`saved low-memory profile was not inherited by systemd service\n${savedLowMemoryUnit}`);
  }

  const quickRoot = path.join(temp, 'quick');
  await fs.mkdir(quickRoot, { recursive: true });
  run(['settings', 'set', '--root', quickRoot, '--tunnel', 'cloudflare'], env);
  const unstable = spawnSync(process.execPath, ['scripts/local-workspace-bridge.mjs', 'service', 'install', '--root', quickRoot, '--dry-run'], {
    cwd: path.resolve('.'),
    env,
    encoding: 'utf8'
  });
  if (unstable.status === 0 || !`${unstable.stdout}\n${unstable.stderr}`.includes('stable saved tunnel')) {
    throw new Error(`quick-tunnel profile was not rejected for Linux service mode\n${unstable.stdout}\n${unstable.stderr}`);
  }

  console.log('linux service smoke passed');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
