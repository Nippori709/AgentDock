import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

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

async function waitFor(url) {
  const deadline = Date.now() + 15000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = String(error);
    }
    await sleep(150);
  }
  throw new Error(`Control server did not become ready: ${last}`);
}

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-control-server-smoke-'));
const child = spawn(process.execPath, ['server.mjs'], {
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    AGENTDOCK_CONTROL_NO_OPEN: '1',
    AGENTDOCK_CONTROL_DISABLE_SUPERVISOR: '1',
    AGENTDOCK_CONTROL_PORT: String(port),
    AGENTDOCK_CONTROL_HOME: path.join(tempHome, 'control'),
    LOCALWORKSPACEBRIDGE_HOME: path.join(tempHome, 'bridge')
  },
  stdio: ['ignore', 'ignore', 'pipe']
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  await waitFor(`${baseUrl}/api/health`);
  const page = await (await fetch(`${baseUrl}/`)).text();
  if (!page.includes('AgentDock Control Center')) throw new Error('renderer index did not load');
  const stateResponse = await fetch(`${baseUrl}/api/state`);
  if (!stateResponse.ok) throw new Error(`state endpoint failed: HTTP ${stateResponse.status}`);
  const state = await stateResponse.json();
  const keys = Object.keys(state.config || {});
  const expected = ['defaultRoot', 'allowedRoots', 'bashMode', 'toolMode', 'writeMode'];
  if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error(`unexpected config keys: ${keys.join(', ')}`);
  console.log(`✓ AgentDock Control Center local server smoke passed on isolated port ${port}`);
} finally {
  child.kill('SIGTERM');
  await sleep(150);
  fs.rmSync(tempHome, { recursive: true, force: true });
}

if (child.exitCode && child.exitCode !== 0) throw new Error(`control server exited ${child.exitCode}: ${stderr}`);
