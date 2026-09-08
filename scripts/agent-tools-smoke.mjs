import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../dist/config.js';
import { WorkspaceManager } from '../dist/guard.js';
import { ExecManager } from '../dist/execOps.js';
import { BrowserSessionManager } from '../dist/browserSessionOps.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local_workspace_bridge-agent-tools-'));
const config = loadConfig(['--root', root, '--bash', 'full']);
config.allowedRoots = [root]; config.bashSessionId = 'test-session'; config.requireBashSession = true;
config.connectionTest = false; config.writeMode = 'workspace'; config.toolMode = 'standard';
const workspace = new WorkspaceManager(config).defaultWorkspace();
const manager = new ExecManager(config);
const browser = new BrowserSessionManager(config);
const sessionId = 'test-session';
const options = (requestId, extra = {}) => ({ requestId, sessionId, waitMs: 0, ...extra });
const output = result => result.output.map(item => item.text).join('');
async function finished(id, cursor = 0) {
  const deadline = Date.now() + 15000;
  let result;
  do {
    result = await manager.poll(workspace, id, { sessionId, cursor, waitMs: 100 });
    if (!result.running) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  throw new Error('Process did not complete: ' + id);
}
let localServer, client, transport;
try {
  await fs.writeFile(path.join(root, 'echo.mjs'), `
    console.log('ready');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', text => { console.log('received:' + text.trim()); process.exitCode = 7; });
    process.stdin.on('end', () => process.exit(7));
  `);
  await fs.writeFile(path.join(root, 'sleep.mjs'), 'setInterval(() => {}, 1000);');
  await fs.writeFile(path.join(root, 'secret.mjs'), `
    process.stdout.write('sk-realSecret');
    setTimeout(() => process.stdout.write('Value123456789\\n中文完整\\n'), 250);
  `);
  await fs.writeFile(path.join(root, 'large.mjs'), `for(let i=0;i<20000;i++) console.log(String(i).padStart(5,'0') + 'x'.repeat(95));`);
  await assert.rejects(manager.start(workspace, 'node sleep.mjs', { requestId: 'bad-session' }), /session id/);
  await assert.rejects(manager.start(workspace, 'node sleep.mjs', options('bad-path', { cwd: '..' })), /escapes/);
  const first = await manager.start(workspace, 'node echo.mjs', options('echo'));
  assert(first.running);
  assert.equal((await manager.start(workspace, 'node echo.mjs', options('echo'))).process_id, first.process_id);
  await assert.rejects(manager.start(workspace, 'node sleep.mjs', options('echo')), /different command/);
  await manager.input(workspace, first.process_id, 'hello\n', true, sessionId);
  const echoed = await finished(first.process_id);
  assert.equal(echoed.exit_code, 7, JSON.stringify(echoed));
  assert.match(output(echoed), /received:hello/);
  assert.equal(output(await manager.poll(workspace, first.process_id, { sessionId, cursor: echoed.next_cursor })), '');
  const secret = await manager.start(workspace, 'node secret.mjs', options('secret'));
  const secretResult = await finished(secret.process_id);
  assert.match(output(secretResult), /REDACTED_SECRET/);
  assert.match(output(secretResult), /中文完整/);
  assert(!output(secretResult).includes('realSecret'));
  const large = await manager.start(workspace, 'node large.mjs', options('large'));
  let page = await finished(large.process_id);
  assert(page.output_lost && page.has_more);
  let pages = 1;
  while (page.has_more) { page = await manager.poll(workspace, large.process_id, { sessionId, cursor: page.next_cursor }); pages++; }
  assert(pages > 1); assert.match(output(page), /19999/);
  const sleepy = await manager.start(workspace, 'node sleep.mjs', options('stop'));
  await manager.stop(workspace, sleepy.process_id, sessionId);
  assert.equal((await finished(sleepy.process_id)).state, 'stopped');
  assert.equal((await manager.stop(workspace, sleepy.process_id, sessionId)).running, false);
  const timed = await manager.start(workspace, 'node sleep.mjs', options('timeout', { timeoutMs: 1000 }));
  assert.equal((await finished(timed.process_id)).state, 'timed_out');
  const revoke = await manager.start(workspace, 'node sleep.mjs', options('revoke'));
  config.allowedRoots = [path.join(root, 'narrow')];
  await manager.reconcile();
  config.allowedRoots = [root];
  assert.equal((await finished(revoke.process_id)).running, false);
  config.bashMode = 'safe';
  await assert.rejects(manager.start(workspace, 'node sleep.mjs', options('safe-denied')), /allowlist/);
  await assert.rejects(manager.input(workspace, first.process_id, 'x', false, sessionId), /full/);
  config.bashMode = 'full';
  const modeRevoke = await manager.start(workspace, 'node sleep.mjs', options('tool-mode-revoke'));
  config.toolMode = 'minimal';
  await manager.reconcile();
  await assert.rejects(manager.start(workspace, 'node sleep.mjs', options('minimal-denied')), /disabled/);
  config.toolMode = 'standard';
  assert.equal((await finished(modeRevoke.process_id)).running, false);
  console.log('PASS process lifecycle, stdin, exit codes, retries, pagination, redaction, timeout and policy revocation');

  localServer = http.createServer((req, res) => {
    if (req.url === '/missing') { res.writeHead(503); res.end('unavailable'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<html><head><title>Agent browser fixture</title></head><body>
      <label>Name <input aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Hello '+document.querySelector('input').value">Greet</button>
      <output>Waiting</output><a href="https://example.com/">External</a>
      <script>console.error('fixture-console-error'); fetch('/missing'); fetch('https://example.com/blocked').catch(()=>{});</script>
    </body></html>`);
  });
  await new Promise(resolve => localServer.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${localServer.address().port}/`;
  const opened = await browser.act(workspace, { action: 'open', url });
  assert.match(opened.snapshot, /Greet/);
  const browser_id = opened.browser_id;
  await browser.act(workspace, { action: 'fill', browser_id, role: 'textbox', name: 'Name', text: 'LocalWorkspaceBridge' });
  const clicked = await browser.act(workspace, { action: 'click', browser_id, role: 'button', name: 'Greet' });
  assert.match(clicked.snapshot, /Hello LocalWorkspaceBridge/);
  const snapshot = await browser.snapshot(workspace, browser_id);
  assert(snapshot.diagnostics.some(item => item.kind === 'console_error'));
  assert(snapshot.diagnostics.some(item => item.kind === 'http_error'));
  assert(snapshot.diagnostics.some(item => item.kind === 'blocked_request'));
  const shot = await browser.act(workspace, { action: 'screenshot', browser_id });
  const png = await fs.readFile(path.join(root, shot.path));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  await assert.rejects(browser.act(workspace, { action: 'navigate', browser_id, url: 'https://example.com/' }), /only accepts/);
  await browser.act(workspace, { action: 'close', browser_id });
  assert.equal((await browser.act(workspace, { action: 'list' })).sessions.length, 0);
  await browser.act(workspace, { action: 'open', url });
  config.toolMode = 'minimal';
  await browser.reconcile();
  await assert.rejects(browser.act(workspace, { action: 'open', url }), /standard\/full/);
  config.toolMode = 'standard';
  assert.equal((await browser.act(workspace, { action: 'list' })).sessions.length, 0);
  console.log('PASS installed browser, accessibility, fill/click, diagnostics, network restriction and PNG capture');

  const env = { ...process.env, LOCALWORKSPACEBRIDGE_HOME: path.join(root, 'home'), LOCALWORKSPACEBRIDGE_ROOT: root, LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: root,
    LOCALWORKSPACEBRIDGE_TOOL_MODE: 'standard', LOCALWORKSPACEBRIDGE_BASH_MODE: 'full', LOCALWORKSPACEBRIDGE_WRITE_MODE: 'workspace',
    LOCALWORKSPACEBRIDGE_REQUIRE_BASH_SESSION: '0', LOCALWORKSPACEBRIDGE_BASH_SESSION_ID: '', LOCALWORKSPACEBRIDGE_CONNECTION_TEST: '0', LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0' };
  transport = new StdioClientTransport({ command: process.execPath, args: ['dist/stdio.js', '--root', root, '--bash', 'full'], env });
  client = new Client({ name: 'agent-tools-smoke', version: '1.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  assert(!tools.some(tool => tool.name === 'task_plan'), 'legacy planner must not be in the default schema');
  for (const name of ['read_many', 'exec_start', 'exec_poll', 'exec_input', 'exec_stop', 'exec_list', 'browser_action', 'browser_snapshot']) assert(tools.some(tool => tool.name === name), name);
  assert.equal(tools.find(tool => tool.name === 'exec_poll').annotations.readOnlyHint, true);
  assert.equal(tools.find(tool => tool.name === 'browser_action').annotations.readOnlyHint, false);
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  await fs.writeFile(path.join(root, 'one.txt'), 'old\n');
  const read = await call('read_many', { files: [{ path: 'one.txt' }, { path: 'missing.txt' }] });
  assert.equal(read.structuredContent.files[0].ok, true);
  assert.equal(read.structuredContent.files[1].ok, false);
  const hash = read.structuredContent.files[0].sha256;
  await fs.writeFile(path.join(root, 'one.txt'), 'someone else\n');
  assert.equal((await call('write', { path: 'one.txt', content: 'bad\n', expected_sha256: hash })).isError, true);
  assert.equal((await call('edit', { path: 'one.txt', old_text: 'someone else', new_text: 'bad', expected_sha256: hash })).isError, true);
  assert.equal(await fs.readFile(path.join(root, 'one.txt'), 'utf8'), 'someone else\n');
  const current = await call('read', { path: 'one.txt' });
  const edited = await call('edit', { path: 'one.txt', old_text: 'someone else', new_text: 'updated', expected_sha256: current.structuredContent.sha256 });
  assert(!edited.isError, JSON.stringify(edited));
  const concurrent = await Promise.all(['writer-a', 'writer-b'].map(content => call('write', {
    path: 'one.txt', content, expected_sha256: edited.structuredContent.sha256
  })));
  assert.equal(concurrent.filter(result => !result.isError).length, 1, 'Only one concurrent writer may use a given file version');
  const started = await call('exec_start', { command: 'node sleep.mjs', request_id: 'mcp-run', wait_ms: 0 });
  assert(!started.isError, JSON.stringify(started));
  const stopped = await call('exec_stop', { process_id: started.structuredContent.process_id });
  assert.equal(stopped.structuredContent.running, false);
  const pageOpened = await call('browser_action', { action: 'open', url });
  assert(!pageOpened.isError, JSON.stringify(pageOpened));
  const image = await call('browser_action', { action: 'screenshot', browser_id: pageOpened.structuredContent.browser_id });
  assert(!image.isError, JSON.stringify(image));
  assert(image.content.some(block => block.type === 'image'), 'MCP must return native image content');
  await call('browser_action', { action: 'close', browser_id: pageOpened.structuredContent.browser_id });
  console.log('PASS MCP schema/policy, batch reads, stale-write rejection, execution and native browser image');
} finally {
  await client?.close();
  await transport?.close();
  await manager.dispose();
  await browser.dispose();
  if (localServer) await new Promise(resolve => localServer.close(resolve));
  const resolved = path.resolve(root);
  assert(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('local_workspace_bridge-agent-tools-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
