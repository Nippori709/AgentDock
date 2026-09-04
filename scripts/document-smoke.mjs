import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

function pythonExecutable() {
  return process.platform === 'win32' ? 'python' : 'python3';
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentdock-document-smoke-'));
const fixtureScript = String.raw`
import sys, zipfile
from pathlib import Path
root = Path(sys.argv[1])
import fitz
pdf = fitz.open()
page = pdf.new_page()
page.insert_text((72, 72), "Hello PDF page one")
page = pdf.new_page()
page.insert_text((72, 72), "Second PDF page")
pdf.save(root / "sample.pdf")
pdf.close()
xml = '''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Resume Title</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Cell B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>Final paragraph</w:t></w:r></w:p>
<w:sectPr/></w:body></w:document>'''
with zipfile.ZipFile(root / "sample.docx", "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("word/document.xml", xml)
`;
const fixture = spawnSync(pythonExecutable(), ['-c', fixtureScript, root], { encoding: 'utf8' });
if (fixture.status !== 0) {
  throw new Error(`unable to create document fixtures: ${fixture.stderr || fixture.stdout}`);
}

const client = new Client(root);
try {
  await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'document-smoke', version: '1' } });
  client.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const tools = await client.request('tools/list');
  for (const name of ['read_pdf', 'read_pdf_page', 'read_docx']) {
    const descriptor = tools.tools.find((tool) => tool.name === name);
    assert(descriptor?.annotations?.readOnlyHint === true, `${name} is missing or not read-only`);
  }

  const pdf = await client.request('tools/call', { name: 'read_pdf', arguments: { path: 'sample.pdf' } });
  assert(pdf.isError !== true, `read_pdf failed: ${JSON.stringify(pdf)}`);
  assert(pdf.structuredContent?.page_count === 2, 'read_pdf returned wrong page count');
  assert(pdf.structuredContent?.text?.includes('Hello PDF page one'), 'read_pdf missed page-one text');
  assert(pdf.structuredContent?.text?.includes('Second PDF page'), 'read_pdf missed page-two text');

  const pageTwo = await client.request('tools/call', { name: 'read_pdf', arguments: { path: 'sample.pdf', start_page: 2, end_page: 2 } });
  assert(pageTwo.isError !== true && pageTwo.structuredContent?.start_page === 2, 'read_pdf page range failed');
  assert(pageTwo.structuredContent?.text?.includes('Second PDF page'), 'read_pdf page range returned wrong text');

  const rendered = await client.request('tools/call', { name: 'read_pdf_page', arguments: { path: 'sample.pdf', page: 1, max_dimension: 900 } });
  assert(rendered.isError !== true && rendered.content?.[0]?.type === 'image', `read_pdf_page failed: ${JSON.stringify(rendered)}`);
  assert(rendered.content[0].mimeType === 'image/jpeg', 'read_pdf_page did not return JPEG');
  assert(rendered.structuredContent?.page === 1, 'read_pdf_page metadata is wrong');

  const docx = await client.request('tools/call', { name: 'read_docx', arguments: { path: 'sample.docx' } });
  assert(docx.isError !== true, `read_docx failed: ${JSON.stringify(docx)}`);
  assert(docx.structuredContent?.total_lines === 3, 'read_docx returned wrong logical line count');
  assert(docx.structuredContent?.text?.includes('Resume Title'), 'read_docx missed paragraph text');
  assert(docx.structuredContent?.text?.includes('Cell A | Cell B'), 'read_docx missed table row text');
  assert(docx.structuredContent?.text?.includes('Final paragraph'), 'read_docx missed final paragraph');

  console.log('✓ document smoke test passed');
} finally {
  client.child.kill('SIGTERM');
  await fs.rm(root, { recursive: true, force: true });
}
