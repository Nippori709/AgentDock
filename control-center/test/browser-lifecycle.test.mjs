import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDedicatedBrowserCleanupScript,
  clearDedicatedBrowserTransientCaches,
  stopDedicatedBrowserProcesses
} from '../browser-lifecycle.mjs';

test('browser cleanup targets only Edge/Chrome processes using the dedicated profile', () => {
  const script = buildDedicatedBrowserCleanupScript("C:\\Users\\alice\\AppData\\Local\\AgentDock-Control\\BrowserProfile2");
  assert.match(script, /msedge\.exe/);
  assert.match(script, /chrome\.exe/);
  assert.match(script, /CommandLine\.Contains\(\$profile\)/);
  assert.doesNotMatch(script, /Stop-Process -Name/);
});

test('browser cleanup invokes hidden PowerShell only on Windows', () => {
  const calls = [];
  const result = stopDedicatedBrowserProcesses('C:\\profile', {
    platform: 'win32',
    execFileSyncImpl(command, args, options) {
      calls.push({ command, args, options });
    }
  });

  assert.deepEqual(result, { attempted: true, ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'powershell.exe');
  assert.equal(calls[0].options.windowsHide, true);

  const nonWindowsCalls = [];
  assert.deepEqual(stopDedicatedBrowserProcesses('/tmp/profile', {
    platform: 'linux',
    execFileSyncImpl(...args) { nonWindowsCalls.push(args); }
  }), { attempted: false, ok: true });
  assert.equal(nonWindowsCalls.length, 0);
});

test('browser cache cleanup is bounded to transient directories under the dedicated profile', () => {
  const removed = [];
  clearDedicatedBrowserTransientCaches('C:/profile', {
    fsImpl: {
      rmSync(target, options) {
        removed.push({ target, options });
      }
    }
  });

  assert.deepEqual(removed.map((entry) => entry.target), [
    'C:/profile/GPUCache',
    'C:/profile/GrShaderCache',
    'C:/profile/ShaderCache',
    'C:/profile/DawnCache',
    'C:/profile/Default/GPUCache'
  ]);
  assert.ok(removed.every((entry) => entry.options.recursive && entry.options.force));
});
