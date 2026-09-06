import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
export const AGENTDOCK_DIR = path.resolve(process.env.AGENTDOCK_DIR || path.join(PROJECT_ROOT, '..'));
export const AGENTDOCK_LAUNCHER = path.join(AGENTDOCK_DIR, 'scripts', 'local-workspace-bridge.mjs');
export const CONTROL_HOME = path.resolve(process.env.AGENTDOCK_CONTROL_HOME || path.join(os.homedir(), '.agentdock-control'));
export const USER_CONFIG_PATH = path.join(CONTROL_HOME, 'config.json');
export const LOG_PATH = path.join(CONTROL_HOME, 'agentdock.log');

export const CONFIG_KEYS = ['defaultRoot', 'allowedRoots', 'bashMode', 'toolMode', 'writeMode'];
const BASH_MODES = new Set(['off', 'safe', 'full']);
const TOOL_MODES = new Set(['minimal', 'standard', 'full']);
const WRITE_MODES = new Set(['off', 'workspace']);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bridgeHome() {
  const configured = process.env.LOCALWORKSPACEBRIDGE_HOME?.trim();
  if (!configured) return path.join(os.homedir(), '.local-workspace-bridge');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

function profileIdForRoot(root) {
  return crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function profilePathForRoot(root) {
  return path.join(bridgeHome(), 'profiles', `${profileIdForRoot(root)}.json`);
}

function runtimePathForRoot(root) {
  return path.join(bridgeHome(), 'runtime', `${profileIdForRoot(root)}.json`);
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, filePath);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tmp, filePath);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
}

function realDirectory(input, fieldName) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error(`${fieldName} 不能为空。`);
  }
  const resolved = path.resolve(input.trim());
  if (!fs.existsSync(resolved)) throw new Error(`${fieldName} 不存在：${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${fieldName} 不是文件夹：${resolved}`);
  return fs.realpathSync(resolved);
}

function dedupePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function samePath(a, b) {
  if (!a || !b) return false;
  const left = path.resolve(a);
  const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathSet(values) {
  return new Set(values.map((item) => {
    const resolved = path.resolve(item);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }));
}

function samePathSet(left, right) {
  const a = pathSet(left);
  const b = pathSet(right);
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

export function normalizeAndValidateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置格式无效。');
  const defaultRoot = realDirectory(raw.defaultRoot, '默认根目录');
  const inputAllowed = Array.isArray(raw.allowedRoots) ? raw.allowedRoots : [];
  const allowedRoots = dedupePaths(inputAllowed.filter((item) => String(item ?? '').trim()).map((item) => realDirectory(String(item), '允许访问目录')));
  const bashMode = String(raw.bashMode ?? 'safe');
  const toolMode = String(raw.toolMode ?? 'standard');
  const writeMode = String(raw.writeMode ?? 'workspace');
  if (!BASH_MODES.has(bashMode)) throw new Error(`Bash Mode 无效：${bashMode}`);
  if (!TOOL_MODES.has(toolMode)) throw new Error(`Tool Mode 无效：${toolMode}`);
  if (!WRITE_MODES.has(writeMode)) throw new Error(`Write Mode 无效：${writeMode}`);
  return { defaultRoot, allowedRoots, bashMode, toolMode, writeMode };
}

function discoverInitialConfig() {
  const live = listLiveRuntimes()[0];
  if (live?.root && fs.existsSync(live.root)) {
    let allowedRoots = [live.root];
    try {
      allowedRoots = allowedRootsFromRuntimeProcess(live);
    } catch {}
    return {
      defaultRoot: live.root,
      allowedRoots,
      bashMode: BASH_MODES.has(live.bash) ? live.bash : 'safe',
      toolMode: TOOL_MODES.has(live.toolMode) ? live.toolMode : 'standard',
      writeMode: WRITE_MODES.has(live.write) ? live.write : 'workspace'
    };
  }

  const profilesDir = path.join(bridgeHome(), 'profiles');
  if (fs.existsSync(profilesDir)) {
    const profiles = fs.readdirSync(profilesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => readJson(path.join(profilesDir, name), null))
      .filter((profile) => profile?.root && fs.existsSync(profile.root))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0));
    const profile = profiles[0];
    if (profile) {
      return {
        defaultRoot: profile.root,
        allowedRoots: [profile.root],
        bashMode: BASH_MODES.has(profile.bash) ? profile.bash : 'safe',
        toolMode: TOOL_MODES.has(profile.toolMode) ? profile.toolMode : 'standard',
        writeMode: WRITE_MODES.has(profile.write) ? profile.write : 'workspace'
      };
    }
  }

  return {
    defaultRoot: AGENTDOCK_DIR,
    allowedRoots: [AGENTDOCK_DIR],
    bashMode: 'safe',
    toolMode: 'standard',
    writeMode: 'workspace'
  };
}

export function loadConfig() {
  if (fs.existsSync(USER_CONFIG_PATH)) {
    return normalizeAndValidateConfig(readJson(USER_CONFIG_PATH, {}));
  }
  return normalizeAndValidateConfig(discoverInitialConfig());
}

export function saveConfig(config) {
  const normalized = normalizeAndValidateConfig(config);
  atomicWriteJson(USER_CONFIG_PATH, normalized);
  return normalized;
}

export function configsEqual(left, right) {
  const a = normalizeAndValidateConfig(left);
  const b = normalizeAndValidateConfig(right);
  return samePath(a.defaultRoot, b.defaultRoot)
    && samePathSet(a.allowedRoots, b.allowedRoots)
    && a.bashMode === b.bashMode
    && a.toolMode === b.toolMode
    && a.writeMode === b.writeMode;
}

export function buildLaunchArgs(config) {
  const normalized = normalizeAndValidateConfig(config);
  const args = [
    'start',
    '--root', normalized.defaultRoot,
    '--bash', normalized.bashMode,
    '--tool-mode', normalized.toolMode,
    '--write', normalized.writeMode,
    '--no-copy-url'
  ];
  for (const allowedRoot of normalized.allowedRoots) {
    args.push('--allow-root', allowedRoot);
  }
  return args;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === 'object' && error.code === 'EPERM');
  }
}

function readRuntimeForRoot(root) {
  const runtimePath = runtimePathForRoot(root);
  const runtime = readJson(runtimePath, null);
  if (!runtime || !Number.isInteger(runtime.pid) || !processAlive(runtime.pid)) return null;
  return { ...runtime, runtimePath };
}

function listLiveRuntimes() {
  const dir = path.join(bridgeHome(), 'runtime');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const runtimePath = path.join(dir, name);
      const runtime = readJson(runtimePath, null);
      if (!runtime || !Number.isInteger(runtime.pid) || !processAlive(runtime.pid)) return null;
      return { ...runtime, runtimePath };
    })
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt || b.startedAt || 0) - Date.parse(a.updatedAt || a.startedAt || 0));
}

function currentRuntime(config) {
  const exact = readRuntimeForRoot(config.defaultRoot);
  if (exact) return exact;
  const live = listLiveRuntimes();
  return live.length === 1 ? live[0] : null;
}

function readProfile(root) {
  return readJson(profilePathForRoot(root), null);
}

function writeProfile(root, profile) {
  const {
    version: _version,
    root: _root,
    updatedAt: _updatedAt,
    ...rest
  } = profile || {};
  atomicWriteJson(profilePathForRoot(root), {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    ...rest
  });
}

function ensureProfileForRoot(targetRoot, sourceRoot, config) {
  let targetProfile = readProfile(targetRoot);
  if (!targetProfile && sourceRoot && !samePath(targetRoot, sourceRoot)) {
    const sourceProfile = readProfile(sourceRoot);
    if (sourceProfile) {
      writeProfile(targetRoot, sourceProfile);
      targetProfile = readProfile(targetRoot);
    }
  }
  if (!targetProfile) {
    throw new Error(`根目录 ${targetRoot} 没有可复用的 AgentDock 连接配置。请先用原 AgentDock setup 为该目录建立一次连接配置。`);
  }
  writeProfile(targetRoot, {
    ...targetProfile,
    bash: config.bashMode,
    toolMode: config.toolMode,
    write: config.writeMode
  });
}

function restoreProfileModes(config) {
  const profile = readProfile(config.defaultRoot);
  if (!profile) return;
  writeProfile(config.defaultRoot, {
    ...profile,
    bash: config.bashMode,
    toolMode: config.toolMode,
    write: config.writeMode
  });
}

async function waitUntilDead(pid, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(150);
  }
  return !processAlive(pid);
}

export async function stopRuntime(runtime) {
  if (!runtime?.pid || !processAlive(runtime.pid)) return;
  const pid = runtime.pid;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T'], { windowsHide: true, encoding: 'utf8' });
    if (!(await waitUntilDead(pid, 2500))) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      await waitUntilDead(pid, 3500);
    }
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch {}
    if (!(await waitUntilDead(pid, 3500))) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
      await waitUntilDead(pid, 2500);
    }
  }
  if (processAlive(pid)) throw new Error(`无法停止旧 AgentDock 进程 PID ${pid}。`);
  if (runtime.runtimePath) fs.rmSync(runtime.runtimePath, { force: true });
}

function tailLog(maxBytes = 12000) {
  try {
    const stat = fs.statSync(LOG_PATH);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(LOG_PATH, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function spawnAgentDock(config) {
  fs.mkdirSync(CONTROL_HOME, { recursive: true });
  const args = buildLaunchArgs(config);
  const logFd = fs.openSync(LOG_PATH, 'a');
  let child;
  try {
    child = spawn(process.execPath, [AGENTDOCK_LAUNCHER, ...args], {
      cwd: AGENTDOCK_DIR,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: process.env
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.unref();
  return child.pid;
}

export async function ensureAgentDockRunning(onProgress = () => {}) {
  const config = loadConfig();
  let runtime = currentRuntime(config);
  if (runtime) {
    const profile = readProfile(runtime.root) || {};
    try {
      await healthCheck(runtime, profile.token || '');
      return { started: false, config, status: await liveStateFor(config), logPath: LOG_PATH };
    } catch {
      onProgress('recover', '检测到 AgentDock 进程存在但本地服务不可用，正在自动恢复');
      await stopRuntime(runtime);
      runtime = null;
    }
  }

  onProgress('start', 'AgentDock 未运行，正在按保存配置自动启动');
  ensureProfileForRoot(config.defaultRoot, config.defaultRoot, config);
  spawnAgentDock(config);
  const startedRuntime = await waitForRuntime(config.defaultRoot);
  const verified = await verifyRuntimeConfig(startedRuntime, config);
  const mismatches = compareLiveConfig(config, verified.liveConfig);
  if (mismatches.length) throw new Error(`自动启动后的配置核验失败：${mismatches.join('、')}`);
  onProgress('done', 'AgentDock 已自动恢复');
  return { started: true, config, status: await liveStateFor(config), logPath: LOG_PATH };
}

export async function restartAgentDock(onProgress = () => {}) {
  const config = loadConfig();
  const runtime = currentRuntime(config);
  if (runtime) {
    onProgress('stop', '正在停止当前 AgentDock');
    await stopRuntime(runtime);
  }
  onProgress('profile', '正在确认保存的 AgentDock 配置');
  ensureProfileForRoot(config.defaultRoot, config.defaultRoot, config);
  onProgress('start', '正在后台启动 AgentDock');
  spawnAgentDock(config);
  const startedRuntime = await waitForRuntime(config.defaultRoot);
  onProgress('verify', '正在验证新 AgentDock');
  const verified = await verifyRuntimeConfig(startedRuntime, config);
  const mismatches = compareLiveConfig(config, verified.liveConfig);
  if (mismatches.length) throw new Error(`重启后的配置核验失败：${mismatches.join('、')}`);
  onProgress('done', 'AgentDock 已在后台重新启动并通过验证');
  return { config, status: await liveStateFor(config), logPath: LOG_PATH, restarted: true };
}

async function waitForRuntime(root, timeoutMs = 60000) {
  const runtimePath = runtimePathForRoot(root);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runtime = readJson(runtimePath, null);
    if (runtime?.root && samePath(runtime.root, root) && Number.isInteger(runtime.pid) && processAlive(runtime.pid)) {
      return { ...runtime, runtimePath };
    }
    await sleep(300);
  }
  const tail = tailLog();
  throw new Error(`AgentDock 没有成功进入运行状态。${tail ? `\n\n最近日志：\n${tail}` : ''}`);
}

async function readHealthConfig(runtime, token) {
  if (!runtime?.localBase) throw new Error('运行状态中缺少 localBase。');
  const response = await fetch(`${runtime.localBase}/healthz`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {}
  });
  if (!response.ok) throw new Error(`AgentDock 健康检查失败：HTTP ${response.status}`);
  const payload = await response.json();
  return {
    defaultRoot: payload.defaultRoot,
    allowedRoots: payload.allowedRoots,
    bashMode: payload.bashMode,
    toolMode: payload.toolMode,
    writeMode: payload.writeMode
  };
}

async function healthCheck(runtime, token) {
  await readHealthConfig(runtime, token);
}

async function hotApplyRuntimeConfig(runtime, config) {
  if (!runtime?.localBase) throw new Error('运行状态中缺少 localBase。');
  const profile = readProfile(runtime.root) || readProfile(config.defaultRoot) || {};
  const token = profile.token || '';
  const response = await fetch(`${runtime.localBase}/admin/runtime-config`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(config)
  });
  if (response.status === 404 || response.status === 405) return { supported: false, payload: null };
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.error || JSON.stringify(payload);
    throw new Error(`AgentDock 热更新失败：HTTP ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  return { supported: true, payload };
}

function toolPayload(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = result?.content?.find?.((item) => item?.type === 'text')?.text;
  if (text) {
    try { return JSON.parse(text); } catch {}
  }
  return null;
}

function parseMcpHttpResponse(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const messages = String(text)
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
    return messages.find((message) => message.id === 1) || messages.at(-1) || null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readServerConfig(runtime) {
  const profile = readProfile(runtime.root) || {};
  const token = profile.token || '';
  await healthCheck(runtime, token);
  const response = await fetch(`${runtime.localBase}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'server_config',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'server_config',
        arguments: {},
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`server_config 请求失败：HTTP ${response.status} ${text.slice(0, 300)}`);
  const message = parseMcpHttpResponse(text, response.headers.get('content-type') || '');
  if (!message) throw new Error('无法解析 server_config HTTP 响应。');
  if (message.error) throw new Error(message.error.message || 'server_config 返回错误。');
  const result = message.result;
  if (result?.isError) throw new Error('server_config 返回错误。');
  const payload = toolPayload(result);
  if (!payload) throw new Error('无法解析 server_config。');
  return payload;
}

export function compareLiveConfig(expected, live) {
  const normalized = normalizeAndValidateConfig(expected);
  const expectedAllowed = dedupePaths([normalized.defaultRoot, ...normalized.allowedRoots]);
  const actualAllowed = Array.isArray(live?.allowedRoots) ? live.allowedRoots : [];
  const mismatches = [];
  if (!samePath(live?.defaultRoot, normalized.defaultRoot)) mismatches.push('默认根目录');
  if (!samePathSet(actualAllowed, expectedAllowed)) mismatches.push('Allowed Roots');
  if (live?.bashMode !== normalized.bashMode) mismatches.push('Bash Mode');
  if (live?.toolMode !== normalized.toolMode) mismatches.push('Tool Mode');
  if (live?.writeMode !== normalized.writeMode) mismatches.push('Write Mode');
  return mismatches;
}

function splitWindowsCommandLine(commandLine) {
  const input = String(commandLine || '');
  const args = [];
  let current = '';
  let inQuotes = false;
  let backslashes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === '\\') {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 0) {
        inQuotes = !inQuotes;
      } else {
        current += '"';
      }
      backslashes = 0;
      continue;
    }
    if (backslashes) {
      current += '\\'.repeat(backslashes);
      backslashes = 0;
    }
    if (!inQuotes && /\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (backslashes) current += '\\'.repeat(backslashes);
  if (current) args.push(current);
  return args;
}

function processCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行状态缺少有效 PID。');
  if (process.platform === 'win32') {
    const script = [
      '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '"',
      'if ($null -eq $p) { exit 3 }',
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()',
      'Write-Output $p.CommandLine'
    ].join('; ');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`无法读取 AgentDock 进程命令行（PID ${pid}）。`);
    return String(result.stdout || '').trim();
  }
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`无法读取 AgentDock 进程命令行（PID ${pid}）。`);
  return String(result.stdout || '').trim();
}

function allowedRootsFromRuntimeProcess(runtime) {
  const commandLine = processCommandLine(runtime.pid);
  const args = process.platform === 'win32'
    ? splitWindowsCommandLine(commandLine)
    : String(commandLine).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((part) => part.replace(/^["']|["']$/g, '')) || [];
  const allowedRoots = [runtime.root];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--allow-root' && args[i + 1]) {
      allowedRoots.push(args[i + 1]);
      i += 1;
      continue;
    }
    if (arg.startsWith('--allow-root=')) {
      allowedRoots.push(arg.slice('--allow-root='.length));
    }
  }
  return dedupePaths(allowedRoots.map((item) => path.resolve(item)));
}

function liveConfigFromRuntime(runtime) {
  return {
    defaultRoot: runtime.root,
    allowedRoots: allowedRootsFromRuntimeProcess(runtime),
    bashMode: runtime.bash,
    toolMode: runtime.toolMode,
    writeMode: runtime.write
  };
}

async function verifyRuntimeConfig(runtime, expected) {
  try {
    const liveConfig = await readServerConfig(runtime);
    return { liveConfig, verification: 'server_config', warning: null };
  } catch (error) {
    const profile = readProfile(runtime.root) || readProfile(expected.defaultRoot) || {};
    try {
      const liveConfig = await readHealthConfig(runtime, profile.token || '');
      const mismatches = compareLiveConfig(expected, liveConfig);
      if (!mismatches.length) {
        return {
          liveConfig,
          verification: 'healthz',
          warning: 'MCP server_config 未直接返回，已通过本机 healthz 完成实时配置核验。'
        };
      }
    } catch {}
    const liveConfig = liveConfigFromRuntime(runtime);
    const mismatches = compareLiveConfig(expected, liveConfig);
    if (mismatches.length) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}；本机运行态兜底核验仍发现差异：${mismatches.join('、')}`
      );
    }
    return {
      liveConfig,
      verification: 'runtime_process',
      warning: 'OAuth 模式下本机 MCP server_config 不可直接调用，已通过 runtime + 实际启动参数完成等价核验。'
    };
  }
}

async function liveStateFor(config) {
  const runtime = currentRuntime(config);
  if (!runtime) return { running: false, runtime: null, liveConfig: null, matchesSaved: false, error: null };
  try {
    const verified = await verifyRuntimeConfig(runtime, config);
    const liveConfig = verified.liveConfig;
    const mismatches = compareLiveConfig(config, liveConfig);
    return {
      running: true,
      runtime,
      liveConfig,
      matchesSaved: mismatches.length === 0,
      mismatches,
      verification: verified.verification,
      warning: verified.warning,
      error: null
    };
  } catch (error) {
    return {
      running: true,
      runtime,
      liveConfig: null,
      matchesSaved: false,
      mismatches: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function getState() {
  const config = loadConfig();
  return { config, status: await liveStateFor(config), logPath: LOG_PATH };
}

export async function applyConfig(rawConfig, onProgress = () => {}) {
  const next = normalizeAndValidateConfig(rawConfig);
  const previous = loadConfig();
  const previousRuntime = currentRuntime(previous);
  const sourceRoot = previousRuntime?.root || previous.defaultRoot;
  let stoppedOld = false;
  let startedNewRuntime = null;
  let hotApplied = false;

  onProgress('validate', '配置校验通过');
  try {
    if (configsEqual(next, previous) && previousRuntime) {
      const verified = await verifyRuntimeConfig(previousRuntime, next);
      const mismatches = compareLiveConfig(next, verified.liveConfig);
      if (!mismatches.length) {
        saveConfig(next);
        onProgress('done', '配置没有变化，无需重启 AgentDock');
        return {
          config: next,
          status: await liveStateFor(next),
          logPath: LOG_PATH,
          restarted: false
        };
      }
    }

    onProgress('profile', '正在继承并更新 AgentDock 连接配置');
    ensureProfileForRoot(next.defaultRoot, sourceRoot, next);

    if (previousRuntime) {
      onProgress('hot-reload', '正在热更新 AgentDock 核心配置，不重启 MCP 连接');
      const hotResult = await hotApplyRuntimeConfig(previousRuntime, next);
      if (hotResult.supported) {
        hotApplied = true;
        const liveConfig = {
          defaultRoot: hotResult.payload?.defaultRoot,
          allowedRoots: hotResult.payload?.allowedRoots,
          bashMode: hotResult.payload?.bashMode,
          toolMode: hotResult.payload?.toolMode,
          writeMode: hotResult.payload?.writeMode
        };
        const mismatches = compareLiveConfig(next, liveConfig);
        if (mismatches.length) throw new Error(`热更新后以下配置未按预期生效：${mismatches.join('、')}`);
        saveConfig(next);
        onProgress('done', '配置已热更新；MCP 连接与当前 ChatGPT 会话保持不变');
        return {
          config: next,
          status: await liveStateFor(next),
          logPath: LOG_PATH,
          restarted: false,
          hotReloaded: true
        };
      }
      onProgress('compat-restart', '当前 AgentDock 版本不支持热更新，将使用兼容重启流程');
    }

    const existingTargetRuntime = readRuntimeForRoot(next.defaultRoot);
    if (existingTargetRuntime && (!previousRuntime || existingTargetRuntime.pid !== previousRuntime.pid)) {
      onProgress('stop-target', '正在停止目标根目录的旧实例');
      await stopRuntime(existingTargetRuntime);
    }

    if (previousRuntime) {
      onProgress('stop', '正在停止当前 AgentDock');
      await stopRuntime(previousRuntime);
      stoppedOld = true;
    }

    onProgress('start', '正在按新配置启动 AgentDock');
    spawnAgentDock(next);
    startedNewRuntime = await waitForRuntime(next.defaultRoot);

    onProgress('verify', '正在读取 server_config 验证实际生效配置');
    const verified = await verifyRuntimeConfig(startedNewRuntime, next);
    const liveConfig = verified.liveConfig;
    const mismatches = compareLiveConfig(next, liveConfig);
    if (mismatches.length) throw new Error(`以下配置未按预期生效：${mismatches.join('、')}`);

    saveConfig(next);
    onProgress('done', '配置已生效并完成验证');
    return { config: next, status: await liveStateFor(next), logPath: LOG_PATH, restarted: true };
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);
    let rollbackMessage = '';
    try {
      if (hotApplied && previousRuntime) {
        restoreProfileModes(previous);
        const rollbackHot = await hotApplyRuntimeConfig(previousRuntime, previous);
        rollbackMessage = rollbackHot.supported ? '；已热回滚原配置' : '；热回滚接口不可用';
      }
      if (startedNewRuntime) await stopRuntime(startedNewRuntime);
      if (stoppedOld) {
        onProgress('rollback', '应用失败，正在自动恢复原配置');
        restoreProfileModes(previous);
        spawnAgentDock(previous);
        const restoredRuntime = await waitForRuntime(previous.defaultRoot);
        const restoredLive = (await verifyRuntimeConfig(restoredRuntime, previous)).liveConfig;
        const mismatches = compareLiveConfig(previous, restoredLive);
        rollbackMessage = mismatches.length ? '；原配置已重启，但自动验证存在差异' : '；已自动恢复原配置';
      }
    } catch (rollbackError) {
      rollbackMessage = `；自动恢复失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
    throw new Error(`${originalMessage}${rollbackMessage}`);
  }
}
