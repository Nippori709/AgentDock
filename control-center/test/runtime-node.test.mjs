import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chooseStableNodeCandidate,
  isLikelyTemporaryNodePath,
  parseNodeMajor,
  resolveStableNodeRuntime
} from '../scripts/runtime-node.mjs';

test('detects temporary/cache Node runtimes', () => {
  assert.equal(isLikelyTemporaryNodePath('C:\\Users\\alice\\.cache\\codex-runtimes\\runtime\\node.exe'), true);
  assert.equal(isLikelyTemporaryNodePath('C:\\Users\\alice\\AppData\\Local\\Temp\\node.exe'), true);
  assert.equal(isLikelyTemporaryNodePath('C:\\Program Files\\nodejs\\node.exe'), false);
});

test('parses supported Node major versions', () => {
  assert.equal(parseNodeMajor('v20.18.0'), 20);
  assert.equal(parseNodeMajor('24.1.0'), 24);
  assert.equal(Number.isNaN(parseNodeMajor('unknown')), true);
});

test('prefers a stable Node runtime over a temporary current runtime', () => {
  const temporary = {
    path: 'C:\\Users\\alice\\.cache\\codex-runtimes\\node.exe',
    valid: true,
    version: '24.0.0',
    major: 24,
    temporary: true
  };
  const stable = {
    path: 'C:\\Program Files\\nodejs\\node.exe',
    valid: true,
    version: '22.0.0',
    major: 22,
    temporary: false
  };
  assert.equal(chooseStableNodeCandidate([temporary, stable], temporary.path), stable);
  assert.equal(resolveStableNodeRuntime({
    currentPath: temporary.path,
    candidates: [temporary, stable]
  }).selected, stable);
});

test('refuses startup installation when only temporary runtimes are available', () => {
  const temporary = {
    path: 'C:\\Users\\alice\\.cache\\codex-runtimes\\node.exe',
    valid: true,
    version: '24.0.0',
    major: 24,
    temporary: true
  };
  assert.throws(
    () => resolveStableNodeRuntime({
      currentPath: temporary.path,
      candidates: [temporary]
    }),
    /No reboot-safe Node\.js 20\+ runtime/
  );
});

test('explicit AGENTDOCK_CONTROL_NODE must also be stable', () => {
  const temporary = {
    path: 'C:\\Users\\alice\\.cache\\codex-runtimes\\node.exe',
    valid: true,
    version: '24.0.0',
    major: 24,
    temporary: true
  };
  assert.throws(
    () => resolveStableNodeRuntime({
      explicitPath: temporary.path,
      currentPath: temporary.path,
      candidates: [temporary]
    }),
    /temporary\/cache runtime/
  );
});
