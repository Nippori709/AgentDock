import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const tempProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-layout-browser-'));
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
const debugPort = await freePort();
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

async function waitTarget() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((item) => item.type === 'page' && item.url.startsWith(baseUrl));
        if (page?.webSocketDebuggerUrl) return page;
      }
    } catch {}
    await sleep(100);
  }
  throw new Error('Edge DevTools target did not become ready');
}

function cdpEvaluate(wsUrl, expression) {
  if (typeof WebSocket !== 'function') return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('CDP evaluation timed out'));
    }, 10000);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP WebSocket failed'));
    };
    ws.onopen = () => ws.send(JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true }
    }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result?.result?.value);
    };
  });
}

const edge = findEdge();
if (!edge) throw new Error('Microsoft Edge not found');

let browser = null;
try {
  await waitHttp();
  browser = spawn(edge, [
    '--headless=new',
    '--disable-gpu',
    `--remote-debugging-port=${debugPort}`,
    '--window-size=760,680',
    `--user-data-dir=${tempProfile}`,
    '--no-first-run',
    baseUrl
  ], { windowsHide: true, stdio: 'ignore' });

  const target = await waitTarget();
  await sleep(400);
  const metrics = await cdpEvaluate(target.webSocketDebuggerUrl, `({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight
  })`);

  if (!metrics) {
    console.log('↷ Layout dimensions skipped because this Node runtime has no global WebSocket; page launch still passed.');
  } else {
    console.log(JSON.stringify(metrics));
    if (metrics.scrollHeight > metrics.innerHeight) {
      throw new Error(`page needs vertical scrolling: scrollHeight=${metrics.scrollHeight}, innerHeight=${metrics.innerHeight}`);
    }
    if (metrics.scrollWidth > metrics.innerWidth) {
      throw new Error(`page needs horizontal scrolling: scrollWidth=${metrics.scrollWidth}, innerWidth=${metrics.innerWidth}`);
    }
    console.log('✓ 760x680 layout shows the complete main UI without page scrolling');
  }
} finally {
  try { browser?.kill('SIGTERM'); } catch {}
  try { control.kill('SIGTERM'); } catch {}
  await sleep(250);
  fs.rmSync(tempProfile, { recursive: true, force: true });
  fs.rmSync(tempHome, { recursive: true, force: true });
}
