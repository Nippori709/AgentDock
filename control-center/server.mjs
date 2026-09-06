import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyConfig, ensureAgentDockRunning, getState, restartAgentDock } from './backend/controller.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';
const PORT = Number(process.env.AGENTDOCK_CONTROL_PORT || 48731);
const BASE_URL = `http://${HOST}:${PORT}`;
const LOCAL_ORIGINS = new Set([BASE_URL, `http://localhost:${PORT}`]);
const LOCAL_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const RENDERER_DIR = path.join(__dirname, 'renderer');
const APP_WIDTH = 760;
const APP_HEIGHT = 680;
const SUPERVISOR_ENABLED = process.env.AGENTDOCK_CONTROL_DISABLE_SUPERVISOR !== '1';
const BROWSER_PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA || process.env.USERPROFILE || __dirname,
  'AgentDock-Control',
  'BrowserProfile2'
);
const sseClients = new Set();
let maintenanceBusy = false;
let supervisorBusy = false;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function assertLocalHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOCAL_HOSTS.has(host)) {
    throw requestError(403, '拒绝非本机 Control Center Host。');
  }
}

function assertControlMutationRequest(req) {
  const origin = String(req.headers.origin || '');
  if (!LOCAL_ORIGINS.has(origin)) {
    throw requestError(403, '拒绝非同源 Control Center 写请求。');
  }
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw requestError(415, 'Control Center 写请求必须使用 application/json。');
  }
  if (maintenanceBusy) {
    throw requestError(409, '已有配置维护操作正在执行，请稍后重试。');
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function broadcast(stage, message) {
  const line = `data: ${JSON.stringify({ stage, message })}\n\n`;
  for (const client of sseClients) {
    try { client.write(line); } catch { sseClients.delete(client); }
  }
}

async function readRequestJson(req, maxBytes = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw requestError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function windowsDrives() {
  if (process.platform !== 'win32') return [{ name: '/', path: '/' }];
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (fs.existsSync(drive)) drives.push({ name: drive.slice(0, 2), path: drive });
  }
  return drives;
}

function browseDirectories(requestedPath = '') {
  if (!requestedPath) {
    return { mode: 'drives', current: '', parent: null, directories: windowsDrives() };
  }
  const resolved = path.resolve(requestedPath);
  if (!fs.existsSync(resolved)) throw new Error(`目录不存在：${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`不是文件夹：${resolved}`);
  const current = fs.realpathSync(resolved);
  const parentPath = path.dirname(current);
  const parent = parentPath === current ? '' : parentPath;
  const directories = fs.readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, path: path.join(current, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }));
  return { mode: 'directory', current, parent, directories };
}

function browserCandidates() {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || '';
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
}

function openAppWindow() {
  const browser = browserCandidates().find((candidate) => fs.existsSync(candidate));
  if (browser) {
    fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    const child = spawn(browser, [
      `--app=${BASE_URL}/`,
      '--new-window',
      `--window-size=${APP_WIDTH},${APP_HEIGHT}`,
      '--window-position=120,80',
      `--user-data-dir=${BROWSER_PROFILE_DIR}`,
      '--no-first-run',
      '--disable-background-mode'
    ], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();
    return;
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd.exe', ['/c', 'start', '', BASE_URL], { detached: true, windowsHide: true, stdio: 'ignore' });
    child.unref();
    return;
  }
  throw new Error(`未找到可用于打开控制台的浏览器，请手动访问 ${BASE_URL}`);
}

function serveStatic(req, res) {
  const requestPath = new URL(req.url, BASE_URL).pathname;
  const relative = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
  const filePath = path.resolve(RENDERER_DIR, relative);
  if (!filePath.startsWith(path.resolve(RENDERER_DIR) + path.sep) && filePath !== path.join(path.resolve(RENDERER_DIR), 'index.html')) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    assertLocalHost(req);
    const url = new URL(req.url, BASE_URL);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, pid: process.pid, service: 'agentdock-control-center' });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, await getState());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/browse-directories') {
      sendJson(res, 200, browseDirectories(url.searchParams.get('path') || ''));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/apply') {
      assertControlMutationRequest(req);
      maintenanceBusy = true;
      try {
        const body = await readRequestJson(req);
        const result = await applyConfig(body, (stage, message) => broadcast(stage, message));
        sendJson(res, 200, result);
      } finally {
        maintenanceBusy = false;
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/restart-agentdock') {
      assertControlMutationRequest(req);
      maintenanceBusy = true;
      try {
        const result = await restartAgentDock((stage, message) => broadcast(stage, message));
        sendJson(res, 200, result);
      } finally {
        maintenanceBusy = false;
      }
      return;
    }
    if (req.method === 'GET') {
      serveStatic(req, res);
      return;
    }
    sendJson(res, 405, { error: 'method_not_allowed' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    broadcast('error', message);
    sendJson(res, statusCode, { error: message });
  }
});

async function superviseAgentDock() {
  if (maintenanceBusy || supervisorBusy) return;
  supervisorBusy = true;
  try {
    await ensureAgentDockRunning((stage, message) => broadcast(`supervisor-${stage}`, message));
  } catch (error) {
    broadcast('supervisor-error', error instanceof Error ? error.message : String(error));
  } finally {
    supervisorBusy = false;
  }
}

server.on('error', async (error) => {
  if (error?.code === 'EADDRINUSE') {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) {
        const payload = await response.json().catch(() => null);
        if (payload?.service === 'agentdock-control-center') {
          if (process.env.AGENTDOCK_CONTROL_NO_OPEN !== '1') openAppWindow();
          process.exit(0);
        }
      }
    } catch {}
  }
  console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  if (process.env.AGENTDOCK_CONTROL_NO_OPEN !== '1') openAppWindow();
  if (SUPERVISOR_ENABLED) {
    setTimeout(() => superviseAgentDock(), 700);
    const timer = setInterval(() => superviseAgentDock(), 15000);
    timer.unref();
  }
});
