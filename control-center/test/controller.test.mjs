import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildLaunchArgs, compareLiveConfig, normalizeAndValidateConfig, CONFIG_KEYS } from '../backend/controller.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdock-control-test-'));
  const allowed = path.join(root, 'allowed');
  fs.mkdirSync(allowed);
  return { root, allowed };
}

test('normalizes exactly the five supported settings', () => {
  const { root, allowed } = fixture();
  try {
    const config = normalizeAndValidateConfig({
      defaultRoot: root,
      allowedRoots: [allowed, allowed],
      bashMode: 'full',
      toolMode: 'full',
      writeMode: 'workspace',
      ignoredExtra: 'must-not-survive'
    });
    assert.deepEqual(Object.keys(config), CONFIG_KEYS);
    assert.equal(config.allowedRoots.length, 1);
    assert.equal(config.bashMode, 'full');
    assert.equal(config.toolMode, 'full');
    assert.equal(config.writeMode, 'workspace');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launch arguments contain only the requested core overrides plus allowed roots', () => {
  const { root, allowed } = fixture();
  try {
    const args = buildLaunchArgs({
      defaultRoot: root,
      allowedRoots: [allowed],
      bashMode: 'safe',
      toolMode: 'standard',
      writeMode: 'off'
    });
    assert.deepEqual(args.slice(0, 11), [
      'start', '--root', fs.realpathSync(root), '--bash', 'safe', '--tool-mode', 'standard', '--write', 'off', '--no-copy-url', '--allow-root'
    ]);
    assert.equal(args.at(-1), fs.realpathSync(allowed));
    assert.equal(args.includes('--port'), false);
    assert.equal(args.includes('--tunnel'), false);
    assert.equal(args.includes('--hostname'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('live comparison verifies all five settings', () => {
  const { root, allowed } = fixture();
  try {
    const expected = {
      defaultRoot: root,
      allowedRoots: [allowed],
      bashMode: 'full',
      toolMode: 'full',
      writeMode: 'workspace'
    };
    const normalized = normalizeAndValidateConfig(expected);
    const live = {
      defaultRoot: normalized.defaultRoot,
      allowedRoots: [normalized.defaultRoot, normalized.allowedRoots[0]],
      bashMode: 'full',
      toolMode: 'full',
      writeMode: 'workspace'
    };
    assert.deepEqual(compareLiveConfig(expected, live), []);
    assert.deepEqual(compareLiveConfig(expected, { ...live, bashMode: 'safe' }), ['Bash Mode']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
