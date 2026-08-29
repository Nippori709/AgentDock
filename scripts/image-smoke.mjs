import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

class Client {
  constructor(root) {
    this.child = spawn(process.execPath, ['dist/stdio.js', '--root', root, '--allow-root', root, '--tool-mode', 'standard', '--bash', 'off', '--write-mode', 'off'], {
      cwd: path.resolve('.'),
      env: { ...process.env, LOCALWORKSPACEBRIDGE_ROOT: root, LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: root, LOCALWORKSPACEBRIDGE_TOOL_CARDS: '0' },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on('data', (chunk) => this.onData(String(chunk)));
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  }

  onData(chunk) {
    this.buffer += chunk;
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 30_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
    });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-image-smoke-'));
const client = new Client(root);
try {
  await fs.writeFile(path.join(root, 'pixel.png'), PNG);
  await fs.writeFile(path.join(root, 'large.png'), Buffer.concat([PNG, Buffer.alloc(400_000)]));
  await fs.writeFile(path.join(root, 'forged.jpg'), PNG);

  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'image-smoke', version: '1' } });
  client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const tools = await client.request('tools/list');
  const descriptor = tools.tools.find((tool) => tool.name === 'read_image');
  assert(descriptor?.annotations?.readOnlyHint === true, 'read_image is missing or not read-only');
  assert(tools.tools.some((tool) => tool.name === 'image_info'), 'image_info is missing');
  assert(tools.tools.some((tool) => tool.name === 'read_image_crop'), 'read_image_crop is missing');
  assert(tools.tools.some((tool) => tool.name === 'read_image_tile'), 'read_image_tile is missing');

  const original = await client.request('tools/call', { name: 'read_image', arguments: { path: 'pixel.png' } });
  assert(original.isError !== true && original.content?.[0]?.type === 'image', `original image failed: ${JSON.stringify(original)}`);
  assert(original.content[0].mimeType === 'image/png', 'small original did not preserve PNG');
  assert(Buffer.from(original.content[0].data, 'base64').equals(PNG), 'small original did not round-trip');
  assert(original.structuredContent?.preview === false, 'small original was unexpectedly previewed');
  assert(!JSON.stringify(original.structuredContent).includes(original.content[0].data), 'base64 was duplicated into structuredContent');

  const preview = await client.request('tools/call', { name: 'read_image', arguments: { path: 'large.png' } });
  assert(preview.isError !== true && preview.content?.[0]?.mimeType === 'image/jpeg', `automatic preview failed: ${JSON.stringify(preview)}`);
  assert(preview.structuredContent?.preview === true, 'large image was not automatically previewed');
  assert(preview.structuredContent?.original_bytes > preview.structuredContent?.bytes, 'preview did not reduce the large response');
  assert(preview.structuredContent?.max_dimension === 1600, 'automatic preview did not use the safe 1600px default');
  assert(Buffer.from(preview.content[0].data, 'base64').byteLength <= 3 * 1024 * 1024, 'preview exceeded output safety limit');

  const info = await client.request('tools/call', { name: 'image_info', arguments: { path: 'pixel.png' } });
  assert(info.isError !== true, `image_info failed: ${JSON.stringify(info)}`);
  assert(info.structuredContent?.width === 1 && info.structuredContent?.height === 1, 'image_info returned wrong dimensions');
  assert(info.structuredContent?.recommended_preview_dimension === 1600, 'image_info returned wrong safe preview dimension');
  assert(info.structuredContent?.recommended_tile_rows === 1 && info.structuredContent?.recommended_tile_columns === 1, 'image_info returned wrong tile grid');

  const crop = await client.request('tools/call', {
    name: 'read_image_crop',
    arguments: { path: 'pixel.png', x: 0, y: 0, width: 1, height: 1 }
  });
  assert(crop.isError !== true && crop.content?.[0]?.mimeType === 'image/jpeg', `read_image_crop failed: ${JSON.stringify(crop)}`);
  assert(crop.structuredContent?.crop?.width === 1 && crop.structuredContent?.crop?.height === 1, 'crop metadata is wrong');

  const tile = await client.request('tools/call', {
    name: 'read_image_tile',
    arguments: { path: 'pixel.png', row: 1, column: 1 }
  });
  assert(tile.isError !== true && tile.content?.[0]?.mimeType === 'image/jpeg', `read_image_tile failed: ${JSON.stringify(tile)}`);
  assert(tile.structuredContent?.tile?.rows === 1 && tile.structuredContent?.tile?.columns === 1, 'tile metadata is wrong');

  const forged = await client.request('tools/call', { name: 'read_image', arguments: { path: 'forged.jpg' } });
  assert(forged.isError === true, 'extension/magic mismatch was accepted');
  console.log('✓ image smoke test passed');
} finally {
  client.child.kill('SIGTERM');
  await fs.rm(root, { recursive: true, force: true });
}
