import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const controlRoot = path.resolve(__dirname, '..');
const mode = String(process.argv[2] || 'ui').toLowerCase();
const noOpen = mode === 'supervisor';

const child = spawn(process.execPath, [path.join(controlRoot, 'server.mjs')], {
  cwd: controlRoot,
  detached: true,
  windowsHide: true,
  stdio: 'ignore',
  env: {
    ...process.env,
    AGENTDOCK_CONTROL_NO_OPEN: noOpen ? '1' : '0'
  }
});
child.unref();
