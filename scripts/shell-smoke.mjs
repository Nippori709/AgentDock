import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { commandEnvironment, resolveShellCommand, runBash, terminateProcessTree } from '../dist/bashOps.js';
import { loadConfig } from '../dist/config.js';
import { PathGuard, WorkspaceManager } from '../dist/guard.js';

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(filePath, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

const windowsAuto = resolveShellCommand({ shellMode: 'auto' }, "Write-Output 'shell-ok'", 'win32');
if (windowsAuto.shell !== 'powershell' || windowsAuto.executable !== 'powershell.exe') {
  throw new Error(`Windows auto shell was not PowerShell: ${JSON.stringify(windowsAuto)}`);
}
const decodedPowerShell = Buffer.from(windowsAuto.args.at(-1), 'base64').toString('utf16le');
if (!decodedPowerShell.includes("Write-Output 'shell-ok'") || !decodedPowerShell.includes('OutputEncoding')) {
  throw new Error('PowerShell command was not UTF-8 encoded correctly');
}

const linuxAuto = resolveShellCommand({ shellMode: 'auto' }, 'pwd', 'linux', () => true);
if (linuxAuto.shell !== 'bash' || linuxAuto.executable !== '/bin/bash' || linuxAuto.args.join(' ') !== '-lc pwd') {
  throw new Error(`Linux auto shell was not /bin/bash: ${JSON.stringify(linuxAuto)}`);
}

const explicitBash = resolveShellCommand({ shellMode: 'bash', bashPath: 'C:\\Program Files\\Git\\bin\\bash.exe' }, 'pwd', 'win32');
if (explicitBash.executable !== 'C:\\Program Files\\Git\\bin\\bash.exe') {
  throw new Error(`explicit Git Bash path was ignored: ${JSON.stringify(explicitBash)}`);
}

const sourceEnvironment = {
  PATH: 'C:\\tools',
  PATHEXT: '.EXE;.CMD',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  USERPROFILE: 'C:\\Users\\tester',
  TEMP: 'C:\\Temp',
  HTTPS_PROXY: 'http://127.0.0.1:7890',
  NO_PROXY: 'localhost,127.0.0.1',
  LOCALWORKSPACEBRIDGE_PROXY_TEST_SECRET: 'do-not-copy'
};
const windowsEnvironment = commandEnvironment({ inheritEnv: false }, 'win32', sourceEnvironment);
for (const required of ['PATH', 'PATHEXT', 'SystemRoot', 'ComSpec', 'USERPROFILE', 'TEMP', 'HTTPS_PROXY', 'NO_PROXY']) {
  if (windowsEnvironment[required] !== sourceEnvironment[required]) {
    throw new Error(`Windows environment dropped ${required}: ${JSON.stringify(windowsEnvironment)}`);
  }
}
if (windowsEnvironment.LOCALWORKSPACEBRIDGE_PROXY_TEST_SECRET !== undefined || windowsEnvironment.SHELL !== undefined) {
  throw new Error(`Windows environment inherited an unsafe or Unix-only field: ${JSON.stringify(windowsEnvironment)}`);
}
if (windowsEnvironment.PYTHONIOENCODING !== 'utf-8') {
  throw new Error(`Windows environment did not force Python UTF-8 output: ${JSON.stringify(windowsEnvironment)}`);
}

const unixEnvironment = commandEnvironment({ inheritEnv: false }, 'linux', { PATH: '/usr/bin', HOME: '/home/tester', SHELL: '/bin/bash' });
if (unixEnvironment.HOME !== '/home/tester' || unixEnvironment.SHELL !== '/bin/bash' || unixEnvironment.SystemRoot !== undefined) {
  throw new Error(`Unix environment was not preserved: ${JSON.stringify(unixEnvironment)}`);
}

const actual = resolveShellCommand({ shellMode: 'auto' }, process.platform === 'win32' ? "Write-Output 'shell-actual-ok'" : "printf 'shell-actual-ok\\n'");
const executed = spawnSync(actual.executable, actual.args, {
  encoding: 'utf8',
  env: commandEnvironment({ inheritEnv: false })
});
if (executed.status !== 0 || !executed.stdout.includes('shell-actual-ok')) {
  throw new Error(`actual ${actual.shell} execution failed: ${executed.stderr || executed.stdout || executed.error}`);
}
if (process.platform === 'win32' && executed.stderr.trim()) {
  throw new Error(`PowerShell emitted unexpected stderr/CLIXML: ${executed.stderr}`);
}

if (process.platform === 'win32') {
  const python = resolveShellCommand({ shellMode: 'auto' }, 'python -c "print(\'\\u4e2d\\u6587\\u8f93\\u51fa\\u6b63\\u5e38\')"');
  const pythonResult = spawnSync(python.executable, python.args, {
    encoding: 'utf8',
    env: commandEnvironment({ inheritEnv: false })
  });
  if (pythonResult.status !== 0 || !pythonResult.stdout.includes('中文输出正常')) {
    throw new Error(`Python UTF-8 output failed: ${pythonResult.stderr || pythonResult.stdout || pythonResult.error}`);
  }
}

const timeoutRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-shell-timeout-'));
try {
  await fs.writeFile(path.join(timeoutRoot, 'sleepy.mjs'), 'setTimeout(() => {}, 5000);\n', 'utf8');
  const timeoutConfig = loadConfig(['--root', timeoutRoot, '--bash', 'full']);
  const timeoutGuard = new PathGuard(timeoutConfig);
  const timeoutWorkspace = new WorkspaceManager(timeoutConfig).defaultWorkspace();
  const timeoutResult = await runBash(timeoutConfig, timeoutGuard, timeoutWorkspace, 'node sleepy.mjs', { timeoutMs: 1_000 });
  if (timeoutResult.durationMs > 2_500 || !timeoutResult.stderr.includes('timed out after 1000 ms')) {
    throw new Error(`runBash did not stop on time: ${JSON.stringify(timeoutResult)}`);
  }
} finally {
  await fs.rm(timeoutRoot, { recursive: true, force: true });
}

const processTreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-shell-tree-'));
const pidFile = path.join(processTreeRoot, 'pids.json');
const grandchildScript = path.join(processTreeRoot, 'grandchild.mjs');
const childScript = path.join(processTreeRoot, 'child.mjs');
await fs.writeFile(grandchildScript, 'setInterval(() => {}, 1000);\n', 'utf8');
await fs.writeFile(childScript, [
  "import { spawn } from 'node:child_process';",
  "import fs from 'node:fs';",
  'const [pidFile, grandchildScript] = process.argv.slice(2);',
  'const grandchild = spawn(process.execPath, [grandchildScript], { stdio: \'ignore\' });',
  'fs.writeFileSync(pidFile, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));',
  'setInterval(() => {}, 1000);',
  ''
].join('\n'), 'utf8');
const tree = spawn(process.execPath, [childScript, pidFile, grandchildScript], {
  stdio: 'ignore',
  detached: process.platform !== 'win32',
  windowsHide: true
});
try {
  const pids = JSON.parse(await waitForFile(pidFile));
  const terminateStarted = Date.now();
  await terminateProcessTree(tree, 500);
  const terminateDuration = Date.now() - terminateStarted;
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (terminateDuration > 3_000 || processExists(pids.child) || processExists(pids.grandchild)) {
    throw new Error(`process tree termination failed: duration=${terminateDuration} pids=${JSON.stringify(pids)}`);
  }
} finally {
  if (tree.pid && processExists(tree.pid)) {
    await terminateProcessTree(tree, 100);
  }
  await fs.rm(processTreeRoot, { recursive: true, force: true });
}

console.log('shell smoke passed');
