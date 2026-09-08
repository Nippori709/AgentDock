import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const tests = [
  'analysis-smoke', 'analysis-cli-smoke', 'shell-smoke', 'linux-service-smoke',
  'image-smoke', 'document-smoke', 'browser-smoke', 'agent-tools-smoke',
  'smoke', 'runtime-hot-smoke', 'http-smoke'
];

for (const test of tests) {
  console.log(`[smoke] ${test}`);
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [`scripts/${test}.mjs`], {
      cwd: root, env: process.env, stdio: 'inherit', windowsHide: true
    });
    child.once('error', error => resolve({ code: 1, error: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (result.code !== 0) {
    console.error(`[smoke] ${test} failed: ${JSON.stringify(result)}`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) console.log(`[smoke] All ${tests.length} suites passed.`);
