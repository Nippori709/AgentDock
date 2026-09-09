import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-layout-control-'));

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

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

function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

const serverPort = await freePort();
const baseUrl = `http://127.0.0.1:${serverPort}/`;

const control = spawn(process.execPath, ['server.mjs'], {
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    AGENTDOCK_CONTROL_NO_OPEN: '1',
    AGENTDOCK_CONTROL_DISABLE_SUPERVISOR: '1',
    AGENTDOCK_CONTROL_PORT: String(serverPort),
    AGENTDOCK_CONTROL_HOME: path.join(tempHome, 'control'),
    LOCALWORKSPACEBRIDGE_HOME: path.join(tempHome, 'bridge')
  },
  stdio: 'ignore'
});

async function waitHttp() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${baseUrl}api/health`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('isolated Control Center did not start');
}

const edge = findEdge();
if (!edge) throw new Error('Microsoft Edge not found');
let browser;
try {
  await waitHttp();
  browser = await chromium.launch({ executablePath: edge, headless: true, timeout: 60000 });
  const page = await browser.newPage({ viewport: { width: 736, height: 588 } });
  await page.goto(baseUrl, { waitUntil: 'load', timeout: 60000 });
  await page.waitForFunction(() => {
    const button = document.querySelector('#restartBtn');
    return button && !button.disabled;
  });
  const restartChecks = await page.evaluate(async () => {
    for (let i = 0; !document.querySelector('#restartBtn') && i < 100; i++) await new Promise(r => setTimeout(r, 50));
    const button = document.querySelector('#restartBtn');
    if (!button) throw new Error('restart button did not load');
    const root = document.querySelector('#rootInput');
    const apply = document.querySelector('#applyBtn');
    for (let i = 0; button.disabled && i < 100; i++) await new Promise(r => setTimeout(r, 50));
    const originalFetch = window.fetch;
    let calls = 0, release;
    window.fetch = async (url, options) => {
      if (url !== '/api/restart-agentdock') return originalFetch(url, options);
      calls++;
      return await new Promise(resolve => { release = resolve; });
    };
    window.confirm = () => false;
    button.click();
    if (calls !== 0) throw new Error('cancel sent a restart request');
    root.value = 'unapplied-draft';
    window.confirm = () => true;
    button.click();
    if (calls !== 1 || !button.disabled || !apply.disabled || !root.disabled) throw new Error('restart controls not locked');
    button.click();
    if (calls !== 1) throw new Error('duplicate restart');
    release(new Response(JSON.stringify({ status: { running: true, matchesSaved: true } }), { status: 200 }));
    for (let i = 0; button.disabled && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    if (button.disabled || root.value !== 'unapplied-draft' || !document.querySelector('#resultBanner').classList.contains('success')) throw new Error('restart success or draft preservation failed');
    button.click();
    release(new Response(JSON.stringify({ error: 'test restart failure' }), { status: 500 }));
    for (let i = 0; button.disabled && i < 100; i++) await new Promise(r => setTimeout(r, 20));
    if (button.disabled || root.value !== 'unapplied-draft' || !document.querySelector('#resultBanner').textContent.includes('test restart failure')) throw new Error('restart error recovery failed');
    return { passed: true };
  });

  if (!restartChecks.passed) throw new Error('restart UI checks failed');
  console.log('✓ Restart UI cancellation, locking, success, failure and draft preservation passed');
  const metrics = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight
  }));
  console.log(JSON.stringify(metrics));
  if (metrics.scrollHeight > metrics.innerHeight || metrics.scrollWidth > metrics.innerWidth) {
    throw new Error('main UI requires page scrolling');
  }
  console.log('✓ 760x680 layout shows the complete main UI without page scrolling');
} finally {
  try { await browser?.close(); } finally {
    control.kill('SIGTERM');
    await sleep(1000);
    fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
