import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { commandEnvironment } from '../dist/bashOps.js';

const proxyKeys = [
  'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy',
  'NO_PROXY', 'no_proxy', 'NODE_USE_ENV_PROXY'
];
const savedEnvironment = new Map([...proxyKeys, 'LOCALWORKSPACEBRIDGE_PROXY_TEST_SECRET'].map((key) => [key, process.env[key]]));

try {
  for (const key of proxyKeys) delete process.env[key];
  process.env.HTTPS_PROXY = 'http://127.0.0.1:17897';
  process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
  process.env.NODE_USE_ENV_PROXY = '1';
  process.env.LOCALWORKSPACEBRIDGE_PROXY_TEST_SECRET = 'must-not-be-inherited';

  const environment = commandEnvironment({ inheritEnv: false });
  if (environment.HTTPS_PROXY !== process.env.HTTPS_PROXY || environment.NO_PROXY !== process.env.NO_PROXY || environment.NODE_USE_ENV_PROXY !== '1') {
    throw new Error(`safe command environment did not inherit proxy settings: ${JSON.stringify(environment)}`);
  }
  if (environment.LOCALWORKSPACEBRIDGE_PROXY_TEST_SECRET !== undefined) {
    throw new Error('safe command environment inherited an unrelated secret');
  }
} finally {
  for (const [key, value] of savedEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const launcher = await fs.readFile(path.join(root, 'scripts', 'local-workspace-bridge.mjs'), 'utf8');
for (const expected of ['curlHealthRequest', "isLoopbackHost(target.hostname)", "'--proxy'", "'--header', '@-'"]) {
  if (!launcher.includes(expected)) throw new Error(`launcher proxy integration is missing: ${expected}`);
}

console.log('proxy smoke passed');
