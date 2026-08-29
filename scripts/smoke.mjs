import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function encode(message) {
  return `${JSON.stringify(message)}\n`;
}

class McpStdioClient {
  constructor(command, args, options) {
    this.child = spawn(command, args, options);
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    this.child.on('exit', (code) => {
      for (const { reject } of this.pending.values()) reject(new Error(`server exited ${code}`));
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  request(method, params) {
    const id = this.nextId++;
    this.child.stdin.write(encode({ jsonrpc: '2.0', id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(encode({ jsonrpc: '2.0', method, params }));
  }

  close() {
    this.child.kill('SIGTERM');
  }
}

function assertCommand(args, expected) {
  const result = spawnSync(process.execPath, args, { cwd: path.resolve('.'), encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout.includes(expected)) {
    throw new Error(`${args.join(' ')} failed or omitted ${expected}: ${result.stderr || result.stdout}`);
  }
}

const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
assertCommand(['dist/stdio.js', '--version'], pkg.version);
assertCommand(['dist/stdio.js', '--help'], 'LocalWorkspaceBridge MCP stdio server');
assertCommand(['dist/http.js', '--version'], pkg.version);
assertCommand(['dist/http.js', '--help'], 'LocalWorkspaceBridge MCP HTTP server');

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-smoke-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-smoke-home-'));
await fs.writeFile(path.join(tmp, 'demo.txt'), 'alpha\nbeta\n', 'utf8');
await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }, null, 2), 'utf8');
await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
await fs.writeFile(path.join(tmp, 'src', 'auth.ts'), 'export const authenticate = (value) => Boolean(value);\n', 'utf8');
for (const args of [['init'], ['add', '.']]) {
  const result = spawnSync('git', args, { cwd: tmp, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
}
const commit = spawnSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=LocalWorkspaceBridge Smoke', 'commit', '-m', 'fixture'], { cwd: tmp, encoding: 'utf8' });
if (commit.status !== 0) throw new Error(`fixture commit failed: ${commit.stderr || commit.stdout}`);

const env = {
  ...process.env,
  LOCALWORKSPACEBRIDGE_HOME: home,
  LOCALWORKSPACEBRIDGE_ROOT: tmp,
  LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: tmp,
  LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0',
  LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN: 'https://example.invalid'
};
const client = new McpStdioClient('node', ['dist/stdio.js', '--root', tmp, '--allow-root', tmp, '--bash', 'safe', '--tool-mode', 'full'], {
  cwd: path.resolve('.'),
  env
});

await client.request('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'local-workspace-bridge-smoke', version: '0.1.0' }
});
client.notify('notifications/initialized');

const tools = await client.request('tools/list', {});
const names = tools.tools.map((tool) => tool.name);
const expected = [
  'local-workspace-bridge', 'server_config', 'local_workspace_bridge_self_test', 'local_workspace_bridge_inventory',
  'open_current_workspace', 'open_workspace', 'workspace_snapshot', 'inspect_workspace',
  'tree', 'search', 'read', 'read_image', 'image_info', 'read_image_crop', 'read_image_tile',
  'write', 'edit', 'apply_patch', 'bash', 'git_status', 'git_diff', 'show_changes'
];
for (const name of expected) if (!names.includes(name)) throw new Error(`missing tool: ${name}`);

const opened = await client.request('tools/call', { name: 'open_current_workspace', arguments: { include_tree: false } });
if (opened.isError || !opened.structuredContent?.workspace_id) throw new Error(`open_current_workspace failed: ${JSON.stringify(opened)}`);
const workspaceId = opened.structuredContent.workspace_id;

const read = await client.request('tools/call', { name: 'read', arguments: { workspace_id: workspaceId, path: 'demo.txt' } });
if (read.isError || !String(read.content?.[0]?.text ?? '').includes('alpha')) throw new Error('read failed');

const search = await client.request('tools/call', { name: 'search', arguments: { workspace_id: workspaceId, query: 'authenticate', path: 'src' } });
if (search.isError || !JSON.stringify(search).includes('auth.ts')) throw new Error('search failed');

const inspect = await client.request('tools/call', { name: 'inspect_workspace', arguments: { workspace_id: workspaceId, mode: 'inventory' } });
if (inspect.isError || !inspect.structuredContent?.coverage) throw new Error('inspect_workspace failed');

const edited = await client.request('tools/call', { name: 'edit', arguments: { workspace_id: workspaceId, path: 'demo.txt', old_text: 'beta', new_text: 'gamma', expected_replacements: 1 } });
if (edited.isError) throw new Error(`edit failed: ${JSON.stringify(edited)}`);

const reviewed = await client.request('tools/call', { name: 'show_changes', arguments: { workspace_id: workspaceId, include_diff: true, since: 'workspace', mark_reviewed: false } });
if (reviewed.isError || !JSON.stringify(reviewed).includes('demo.txt')) throw new Error('show_changes failed');

const selfTest = await client.request('tools/call', { name: 'local_workspace_bridge_self_test', arguments: { workspace_id: workspaceId, bash_probe: false, include_global_skills: false } });
if (selfTest.isError || selfTest.structuredContent?.status === 'fail') throw new Error(`self test failed: ${JSON.stringify(selfTest)}`);

const blocked = await client.request('tools/call', {
  name: 'write',
  arguments: { workspace_id: workspaceId, path: 'secret.txt', content: 'OPENAI_API_KEY=sk-' + 'x'.repeat(40) }
});
if (!blocked.isError) throw new Error('secret-looking write was not blocked');

client.close();
await fs.rm(tmp, { recursive: true, force: true });
await fs.rm(home, { recursive: true, force: true });
console.log('✓ LocalWorkspaceBridge core smoke test passed');
