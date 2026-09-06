import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const baseUrl = 'http://127.0.0.1:48731';
const previewPath = path.join(projectRoot, 'preview.png');

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error('control server did not become ready');
}

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

const edge = findEdge();
if (!edge) throw new Error('Microsoft Edge not found for preview capture');

const server = spawn(process.execPath, ['server.mjs'], {
  cwd: projectRoot,
  windowsHide: true,
  env: { ...process.env, AGENTDOCK_CONTROL_NO_OPEN: '1' },
  stdio: 'ignore'
});

try {
  await waitForHealth();
  fs.rmSync(previewPath, { force: true });
  const result = spawnSync(edge, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=760,680',
    `--screenshot=${previewPath}`,
    `${baseUrl}/`
  ], { windowsHide: true, encoding: 'utf8', timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0 || !fs.existsSync(previewPath)) {
    throw new Error(`Edge screenshot failed: ${result.stderr || result.stdout || result.status}`);
  }
  console.log(`✓ Preview captured: ${previewPath}`);
} finally {
  server.kill('SIGTERM');
  await sleep(150);
}
