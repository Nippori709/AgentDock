import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { AGENTDOCK_DIR, compareLiveConfig, readServerConfig } from '../backend/controller.mjs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(url) {
  const deadline = Date.now() + 15000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await sleep(150);
  }
  throw new Error(`health check timed out: ${lastError}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-control-smoke-root-'));
const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-control-smoke-allowed-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-control-smoke-home-'));
const oldHome = process.env.LOCALWORKSPACEBRIDGE_HOME;
const port = await freePort();
const httpEntry = path.join(AGENTDOCK_DIR, 'dist', 'http.js');

process.env.LOCALWORKSPACEBRIDGE_HOME = home;
const child = spawn(process.execPath, [httpEntry], {
  cwd: AGENTDOCK_DIR,
  windowsHide: true,
  env: {
    ...process.env,
    LOCALWORKSPACEBRIDGE_HOME: home,
    LOCALWORKSPACEBRIDGE_ROOT: root,
    LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: [root, allowed].join(path.delimiter),
    LOCALWORKSPACEBRIDGE_HOST: '127.0.0.1',
    LOCALWORKSPACEBRIDGE_PORT: String(port),
    LOCALWORKSPACEBRIDGE_ALLOW_NO_HTTP_TOKEN: '1',
    LOCALWORKSPACEBRIDGE_BASH_MODE: 'safe',
    LOCALWORKSPACEBRIDGE_TOOL_MODE: 'full',
    LOCALWORKSPACEBRIDGE_WRITE_MODE: 'off',
    LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0'
  },
  stdio: ['ignore', 'ignore', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  const localBase = `http://127.0.0.1:${port}`;
  await waitForHealth(`${localBase}/healthz`);
  const live = await readServerConfig({ root: fs.realpathSync(root), localBase });
  const expected = {
    defaultRoot: root,
    allowedRoots: [allowed],
    bashMode: 'safe',
    toolMode: 'full',
    writeMode: 'off'
  };
  const mismatches = compareLiveConfig(expected, live);
  if (mismatches.length) throw new Error(`server_config mismatch: ${mismatches.join(', ')}`);
  console.log('✓ AgentDock Control Center MCP verification smoke passed');
} finally {
  child.kill('SIGTERM');
  await sleep(200);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(allowed, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.LOCALWORKSPACEBRIDGE_HOME;
  else process.env.LOCALWORKSPACEBRIDGE_HOME = oldHome;
}

if (child.exitCode && child.exitCode !== 0) {
  throw new Error(`temporary AgentDock exited ${child.exitCode}: ${stderr}`);
}
