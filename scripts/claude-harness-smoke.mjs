import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdock-claude-harness-'));
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdock-claude-home-'));
const worktreePath = root + '-wt';
let client;
let transport;

const textOf = result => (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');

try {
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# Project memory\nUse the local harness directly.\n');
  await fs.writeFile(path.join(root, 'src', 'math.ts'), 'export function add(a: number, b: number) { return a + b; }\nexport const answer = add(20, 22);\n');
  await fs.writeFile(path.join(root, 'demo.txt'), 'alpha\nbeta\n');
  await fs.writeFile(path.join(root, 'demo.ipynb'), JSON.stringify({
    cells: [{ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['print("hello")\n'] }],
    metadata: {}, nbformat: 4, nbformat_minor: 5
  }, null, 1));
  await fs.writeFile(path.join(root, 'sample.foo'), 'custom-symbol\n');
  await fs.writeFile(path.join(root, 'fake-lsp.mjs'), `
let buffer = Buffer.alloc(0);
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write('Content-Length: ' + body.length + '\\r\\n\\r\\n');
  process.stdout.write(body);
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const marker = buffer.indexOf('\\r\\n\\r\\n');
    if (marker < 0) return;
    const header = buffer.subarray(0, marker).toString();
    const match = /Content-Length:\\s*(\\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const end = marker + 4 + length;
    if (buffer.length < end) return;
    const message = JSON.parse(buffer.subarray(marker + 4, end).toString());
    buffer = buffer.subarray(end);
    if (message.method === 'initialize') send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { documentSymbolProvider: true } } });
    else if (message.method === 'textDocument/documentSymbol') send({ jsonrpc: '2.0', id: message.id, result: [{ name: 'customSymbol', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } }, selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } } }] });
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null });
    else if (message.id !== undefined) send({ jsonrpc: '2.0', id: message.id, result: null });
    if (message.method === 'exit') process.exit(0);
  }
});
`);
  await fs.writeFile(path.join(root, '.lsp.json'), JSON.stringify({
    fixture: {
      command: process.execPath,
      args: ['fake-lsp.mjs'],
      extensionToLanguage: { '.foo': 'plaintext' },
      transport: 'stdio',
      initializationOptions: { smoke: true },
      settings: { fixture: { enabled: true } },
      startupTimeout: 5000,
      shutdownTimeout: 2000,
      maxRestarts: 3
    }
  }, null, 2));

  for (const args of [['init'], ['add', '.']]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  let result = spawnSync('git', ['-c', 'user.email=smoke@example.invalid', '-c', 'user.name=Claude Harness Smoke', 'commit', '-m', 'fixture'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: {
      PreToolUse: [{
        matcher: 'Read',
        hooks: [{ type: 'command', command: 'node -e "require(\'fs\').appendFileSync(\'hook.log\',\'pre\\\\n\')"' }]
      }]
    }
  }, null, 2));

  const env = {
    ...process.env,
    LOCALWORKSPACEBRIDGE_HOME: home,
    LOCALWORKSPACEBRIDGE_ROOT: root,
    LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: os.tmpdir(),
    LOCALWORKSPACEBRIDGE_HARNESS_PROFILE: 'claude',
    LOCALWORKSPACEBRIDGE_HOOKS: '1',
    LOCALWORKSPACEBRIDGE_LSP_CONFIG: '.lsp.json',
    LOCALWORKSPACEBRIDGE_ANALYSIS: '0',
    LOCALWORKSPACEBRIDGE_TOOL_MODE: 'full',
    LOCALWORKSPACEBRIDGE_BASH_MODE: 'full',
    LOCALWORKSPACEBRIDGE_WRITE_MODE: 'workspace',
    LOCALWORKSPACEBRIDGE_CONNECTION_TEST: '0',
    LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0'
  };

  transport = new StdioClientTransport({ command: process.execPath, args: ['dist/stdio.js', '--root', root, '--bash', 'full'], env });
  client = new Client({ name: 'claude-harness-smoke', version: '1.0.0' });
  await client.connect(transport);
  const listed = (await client.listTools()).tools;
  const names = listed.map(tool => tool.name);
  const expected = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'LSP', 'NotebookEdit', 'TaskOutput', 'TaskStop', 'Skill', 'WorktreeCreate', 'WorktreeList', 'WorktreeRemove'];
  for (const name of expected) assert(names.includes(name), 'missing Claude-compatible tool ' + name);
  for (const oldName of ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'exec_start', 'read_many', 'inspect_workspace', 'search']) {
    assert(!names.includes(oldName), 'native duplicate leaked into Claude profile: ' + oldName);
  }

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const opened = await call('open_current_workspace', {});
  assert.match(textOf(opened), /CLAUDE\.md/);
  assert.match(textOf(opened), /Use the local harness directly/);

  const read = await call('Read', { file_path: 'demo.txt' });
  assert.match(textOf(read), /alpha/);
  assert.match(await fs.readFile(path.join(root, 'hook.log'), 'utf8'), /pre/);

  const glob = await call('Glob', { pattern: 'src/**/*.ts' });
  assert.match(textOf(glob), /src\/math\.ts/);

  const grep = await call('Grep', { pattern: 'add\\(', path: 'src', output_mode: 'content' });
  assert.match(textOf(grep), /math\.ts/);

  const write = await call('Write', { file_path: 'created.txt', content: 'one\n' });
  assert.equal(write.isError, undefined);
  const edit = await call('Edit', { file_path: 'created.txt', old_string: 'one', new_string: 'two' });
  assert.equal(edit.isError, undefined);
  assert.equal(await fs.readFile(path.join(root, 'created.txt'), 'utf8'), 'two\n');

  const notebookRead = await call('Read', { file_path: 'demo.ipynb' });
  assert.match(textOf(notebookRead), /print\("hello"\)/);
  const notebookEdit = await call('NotebookEdit', { notebook_path: 'demo.ipynb', cell_index: 0, new_source: 'print("updated")\n' });
  assert.equal(notebookEdit.isError, undefined);
  assert.match(await fs.readFile(path.join(root, 'demo.ipynb'), 'utf8'), /updated/);

  const lsp = await call('LSP', { operation: 'documentSymbol', file_path: 'src/math.ts' });
  assert.equal(lsp.isError, undefined);
  assert.match(textOf(lsp), /add|answer/);
  const customLsp = await call('LSP', { operation: 'documentSymbol', file_path: 'sample.foo' });
  assert.equal(customLsp.isError, undefined, JSON.stringify(customLsp));
  assert.match(textOf(customLsp), /customSymbol/);

  const bash = await call('Bash', { command: 'node -e "console.log(6*7)"' });
  assert.match(textOf(bash), /42/);

  const background = await call('Bash', { command: 'node -e "setTimeout(()=>console.log(\'done\'),250)"', run_in_background: true });
  const taskId = background.structuredContent.task_id;
  assert.match(taskId, /^process:/);
  let task;
  for (let i = 0; i < 20; i++) {
    task = await call('TaskOutput', { task_id: taskId, block: true, timeout: 1000 });
    if (task.structuredContent.running === false) break;
  }
  assert.match(textOf(task), /done/);

  const created = await call('WorktreeCreate', { name: 'smoke', path: worktreePath, detach: true });
  assert.equal(created.isError, undefined);
  assert.equal(await fs.stat(worktreePath).then(s => s.isDirectory()), true);
  const list = await call('WorktreeList', {});
  assert.match(textOf(list), /-wt/);
  const removed = await call('WorktreeRemove', { path: worktreePath, force: true });
  assert.equal(removed.isError, undefined, JSON.stringify(removed));

  const config = await call('server_config', {});
  assert.equal(config.structuredContent.harnessProfile, 'claude');
  assert.equal(config.structuredContent.hooksEnabled, true);

  console.log('✓ Claude-compatible local harness smoke test passed');
} finally {
  try { await client?.close(); } catch {}
  try { await fs.rm(worktreePath, { recursive: true, force: true }); } catch {}
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.rm(home, { recursive: true, force: true }).catch(() => {});
}
