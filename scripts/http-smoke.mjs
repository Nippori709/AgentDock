import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

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

async function waitForHealth(url, token) {
  const deadline = Date.now() + 15000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      last = `${response.status} ${await response.text()}`;
      if (response.ok) return;
    } catch (error) {
      last = String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`HTTP server did not become healthy: ${last}`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-http-smoke-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-http-home-'));
await fs.writeFile(path.join(root, 'README.md'), '# HTTP smoke\n', 'utf8');
const port = await freePort();
const token = 'smoke';
const child = spawn(process.execPath, ['dist/http.js', '--root', root, '--host', '127.0.0.1', '--port', String(port)], {
  cwd: path.resolve('.'),
  env: {
    ...process.env,
    LOCALWORKSPACEBRIDGE_HOME: home,
    LOCALWORKSPACEBRIDGE_ROOT: root,
    LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: root,
    LOCALWORKSPACEBRIDGE_HTTP_TOKEN: token,
    LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += String(chunk); });

try {
  const health = `http://127.0.0.1:${port}/healthz`;
  await waitForHealth(health, token);
  const authorized = await fetch(health, { headers: { Authorization: `Bearer ${token}` } });
  if (!authorized.ok) throw new Error(`authorized health check failed: ${authorized.status}`);
  const body = await authorized.json();
  if (!body.ok && body.status !== 'ok') throw new Error(`unexpected health payload: ${JSON.stringify(body)}`);

  const unauthorized = await fetch(health);
  if (unauthorized.status !== 401) throw new Error(`unauthenticated health check should be 401, got ${unauthorized.status}`);
  console.log('✓ LocalWorkspaceBridge HTTP smoke test passed');
} finally {
  child.kill('SIGTERM');
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
}

if (child.exitCode && child.exitCode !== 0) throw new Error(`HTTP server exited ${child.exitCode}: ${stderr}`);
