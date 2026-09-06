import { spawn } from 'node:child_process';
import path from 'node:path';

const projectRoot = process.cwd();
const node = process.execPath;
const port = 48987;
const token = 'test';
const base = `http://127.0.0.1:${port}`;
const root = path.resolve('..');
const narrowRoot = path.join(root, 'MoE_LT_0');

const child = spawn(node, ['dist/http.js'], {
  cwd: projectRoot,
  env: {
    ...process.env,
    LOCALWORKSPACEBRIDGE_ROOT: root,
    LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: root,
    LOCALWORKSPACEBRIDGE_PORT: String(port),
    LOCALWORKSPACEBRIDGE_HTTP_TOKEN: token,
    LOCALWORKSPACEBRIDGE_BASH_MODE: 'off',
    LOCALWORKSPACEBRIDGE_TOOL_MODE: 'minimal',
    LOCALWORKSPACEBRIDGE_WRITE_MODE: 'off',
    LOCALWORKSPACEBRIDGE_TUNNEL_MODE: '0',
    LOCALWORKSPACEBRIDGE_PUBLIC_URL: ''
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});

let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

function parseMcp(text, contentType) {
  if (contentType.includes('text/event-stream')) {
    const messages = String(text).split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    return messages.find((item) => item.id === 1) || messages.at(-1);
  }
  return JSON.parse(text);
}

async function waitHealth() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`${base}/healthz`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`isolated AgentDock did not start. stderr: ${stderr.slice(-2000)}`);
}

async function mcp(method, params = {}) {
  const name = method === 'tools/call' ? params.name : '';
  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Mcp-Method': method,
      ...(name ? { 'Mcp-Name': name } : {})
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientCapabilities': {}
        }
      }
    })
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} HTTP ${r.status}: ${text.slice(0, 500)}`);
  return parseMcp(text, r.headers.get('content-type') || '');
}

async function hot(config) {
  const r = await fetch(`${base}/admin/runtime-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(config)
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`runtime hot reload failed: HTTP ${r.status} ${JSON.stringify(body)}`);
  return body;
}

function toolNames(message) {
  return (message?.result?.tools || []).map((tool) => tool.name).sort();
}

function callIsError(message) {
  return Boolean(message?.result?.isError);
}

try {
  await waitHealth();
  const pid = child.pid;

  const beforeList = toolNames(await mcp('tools/list'));
  for (const required of ['bash', 'write', 'tree', 'server_config']) {
    if (!beforeList.includes(required)) throw new Error(`stable schema missing ${required} in minimal/off mode`);
  }

  const bashDenied = await mcp('tools/call', { name: 'bash', arguments: { command: 'pwd' } });
  if (!callIsError(bashDenied)) throw new Error('bash was not denied while bashMode=off');

  const treeDenied = await mcp('tools/call', { name: 'tree', arguments: {} });
  if (!callIsError(treeDenied)) throw new Error('tree was not denied while toolMode=minimal');

  const widened = await hot({
    defaultRoot: root,
    allowedRoots: [root],
    bashMode: 'full',
    toolMode: 'full',
    writeMode: 'workspace'
  });
  if (!widened.hotReloaded || widened.restarted !== false) throw new Error('hot reload did not report no-restart');

  const afterList = toolNames(await mcp('tools/list'));
  if (JSON.stringify(beforeList) !== JSON.stringify(afterList)) throw new Error('tool schema changed across runtime policy update');

  const bashAllowed = await mcp('tools/call', { name: 'bash', arguments: { command: 'pwd' } });
  if (callIsError(bashAllowed)) throw new Error('bash stayed denied after hot reload to full');

  const treeAllowed = await mcp('tools/call', { name: 'tree', arguments: { max_depth: 1, max_files: 20 } });
  if (callIsError(treeAllowed)) throw new Error('tree stayed denied after hot reload to full');

  await hot({
    defaultRoot: narrowRoot,
    allowedRoots: [narrowRoot],
    bashMode: 'full',
    toolMode: 'full',
    writeMode: 'workspace'
  });

  const health = await (await fetch(`${base}/healthz`, { headers: { Authorization: `Bearer ${token}` } })).json();
  if (path.resolve(health.defaultRoot).toLowerCase() !== path.resolve(narrowRoot).toLowerCase()) {
    throw new Error('defaultRoot did not hot reload');
  }
  const current = await mcp('tools/call', { name: 'open_current_workspace', arguments: {} });
  const currentRoot = current?.result?.structuredContent?.root;
  if (!currentRoot || path.resolve(currentRoot).toLowerCase() !== path.resolve(narrowRoot).toLowerCase()) {
    throw new Error(`open_current_workspace did not switch to hot root: ${currentRoot}`);
  }

  if (child.pid !== pid || child.exitCode !== null) throw new Error('HTTP/MCP process changed or exited during hot reload');
  console.log(`✓ runtime hot reload kept the same AgentDock process PID ${pid}`);
  console.log('✓ stable tool schema preserved across minimal/off -> full/workspace');
  console.log('✓ runtime permissions changed without MCP restart');
  console.log('✓ defaultRoot/allowedRoots changed without MCP restart');
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (child.exitCode === null) child.kill('SIGKILL');
}
