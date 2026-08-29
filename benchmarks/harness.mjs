import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

export const PROJECT_ROOT = process.cwd();
export const DEFAULT_TIMEOUT_MS = 120000;

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function stats(values) {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : 0;
  return {
    n: sorted.length,
    mean: round(mean),
    min: round(sorted[0] ?? 0),
    p50: round(percentile(sorted, 0.50)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    max: round(sorted.at(-1) ?? 0)
  };
}

export function ratio(numerator, denominator) {
  return denominator ? round(numerator / denominator, 4) : 0;
}

export function percent(value) {
  return `${round(value * 100, 1)}%`;
}

export function isToolError(result) {
  return result?.isError === true;
}

export function resultBytes(result) {
  return Buffer.byteLength(JSON.stringify(result ?? {}), 'utf8');
}

export async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

export function runLocal(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', windowsHide: true, ...options });
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  }
  return result;
}

export async function initGit(root) {
  runLocal('git', ['init'], root);
  runLocal('git', ['add', '.'], root);
  runLocal('git', ['-c', 'user.email=benchmark@example.com', '-c', 'user.name=LocalWorkspaceBridge Benchmark', 'commit', '-m', 'benchmark fixture'], root);
}

export class McpStdioClient {
  constructor(root, env = {}) {
    this.root = root;
    this.env = env;
    this.buffer = '';
    this.stderr = '';
    this.nextId = 1;
    this.pending = new Map();
    this.taskMetrics = null;
  }

  static async launch(root, env = {}) {
    const client = new McpStdioClient(root, env);
    client.home = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-bench-home-'));
    const started = performance.now();
    client.child = spawn(process.execPath, ['dist/stdio.js'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        LOCALWORKSPACEBRIDGE_HOME: client.home,
        LOCALWORKSPACEBRIDGE_ROOT: root,
        LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: root,
        LOCALWORKSPACEBRIDGE_TOOL_MODE: env.LOCALWORKSPACEBRIDGE_TOOL_MODE ?? 'standard',
        LOCALWORKSPACEBRIDGE_WRITE_MODE: env.LOCALWORKSPACEBRIDGE_WRITE_MODE ?? 'workspace',
        LOCALWORKSPACEBRIDGE_BASH_MODE: env.LOCALWORKSPACEBRIDGE_BASH_MODE ?? 'safe',
        LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0',
        LOCALWORKSPACEBRIDGE_CODEX_SESSIONS: 'off',
        LOCALWORKSPACEBRIDGE_MAX_SEARCH_RESULTS: env.LOCALWORKSPACEBRIDGE_MAX_SEARCH_RESULTS ?? '2000',
        LOCALWORKSPACEBRIDGE_MAX_OUTPUT_BYTES: env.LOCALWORKSPACEBRIDGE_MAX_OUTPUT_BYTES ?? '2000000',
        LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_INVENTORY_FILES: env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_INVENTORY_FILES ?? '20000',
        LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_ANALYZED_FILES: env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_ANALYZED_FILES ?? '5000',
        LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_SCANNED_BYTES: env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_SCANNED_BYTES ?? String(128 * 1024 * 1024),
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    client.child.stdout.on('data', (chunk) => client.onData(String(chunk)));
    client.child.stderr.on('data', (chunk) => { client.stderr += String(chunk); });
    client.child.on('exit', (code) => {
      for (const { reject, timer } of client.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`LocalWorkspaceBridge server exited with code ${code}\n${client.stderr}`));
      }
      client.pending.clear();
    });
    await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'local-workspace-bridge-benchmark', version: '1.0.0' }
    });
    client.notify('notifications/initialized');
    client.initializeMs = performance.now() - started;
    return client;
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (!msg.id || !this.pending.has(msg.id)) continue;
      const pending = this.pending.get(msg.id);
      clearTimeout(pending.timer);
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  request(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method} after ${timeoutMs} ms\n${this.stderr}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  beginTaskMetrics() {
    this.taskMetrics = {
      toolCalls: 0,
      resultBytes: 0,
      errorCalls: 0,
      byTool: {},
      readFiles: [],
      uniqueReadFiles: new Set(),
      startedAt: performance.now()
    };
  }

  endTaskMetrics() {
    if (!this.taskMetrics) return null;
    const value = {
      toolCalls: this.taskMetrics.toolCalls,
      resultBytes: this.taskMetrics.resultBytes,
      errorCalls: this.taskMetrics.errorCalls,
      byTool: this.taskMetrics.byTool,
      readFiles: this.taskMetrics.readFiles.length,
      uniqueReadFiles: this.taskMetrics.uniqueReadFiles.size,
      durationMs: round(performance.now() - this.taskMetrics.startedAt)
    };
    this.taskMetrics = null;
    return value;
  }

  async tool(name, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    if (this.taskMetrics) {
      const bytes = resultBytes(result);
      this.taskMetrics.toolCalls += 1;
      this.taskMetrics.resultBytes += bytes;
      if (isToolError(result)) this.taskMetrics.errorCalls += 1;
      const perTool = this.taskMetrics.byTool[name] ?? { calls: 0, resultBytes: 0, errors: 0 };
      perTool.calls += 1;
      perTool.resultBytes += bytes;
      if (isToolError(result)) perTool.errors += 1;
      this.taskMetrics.byTool[name] = perTool;
      if (name === 'read' && typeof args.path === 'string') {
        this.taskMetrics.readFiles.push(args.path);
        this.taskMetrics.uniqueReadFiles.add(args.path);
      }
    }
    return result;
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async openWorkspace() {
    const opened = await this.tool('open_current_workspace', { include_tree: false });
    if (isToolError(opened)) throw new Error(`open_current_workspace failed: ${JSON.stringify(opened)}`);
    return opened.structuredContent.workspace_id;
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1500))]);
  }
}

export async function withClient(root, env, fn) {
  const client = await McpStdioClient.launch(root, env);
  try { return await fn(client); } finally { await client.close(); }
}

export async function makeBaseFixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `local-workspace-bridge-bench-${prefix}-`));
  await fs.writeFile(path.join(root, 'README.md'), '# LocalWorkspaceBridge benchmark fixture\n', 'utf8');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: `local-workspace-bridge-bench-${prefix}`,
    private: true,
    scripts: {
      build: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"'
    }
  }, null, 2) + '\n', 'utf8');
  return root;
}

export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

export function markdownTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`)
  ].join('\n');
}
