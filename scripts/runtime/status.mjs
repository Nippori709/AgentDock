import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeId = randomBytes(16).toString('hex');
const startedAt = new Date().toISOString();

function localWorkspaceBridgeHome() {
  const configured = process.env.LOCALWORKSPACEBRIDGE_HOME?.trim();
  if (!configured) return path.join(os.homedir(), '.local-workspace-bridge');
  if (configured === '~') return os.homedir();
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return path.join(os.homedir(), configured.slice(2));
  }
  return path.resolve(configured);
}

export function runtimeStatusPathForRoot(root) {
  const id = createHash('sha256').update(root).digest('hex').slice(0, 24);
  return path.join(localWorkspaceBridgeHome(), 'runtime', `${id}.json`);
}

export function saveRuntimeConnection(root, details, options = {}) {
  const filePath = runtimeStatusPathForRoot(root);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    pid: process.pid,
    runtimeId,
    startedAt,
    updatedAt: new Date().toISOString(),
    endpoint: details.endpoint,
    localBase: options.localBase ?? '',
    localStatusUrl: details.localStatusUrl ? details.localStatusUrl.replace(/local_workspace_bridge_token=[^&]+/, 'local_workspace_bridge_token=<redacted>') : '',
    tunnel: options.tunnel ?? '',
    mode: options.mode ?? '',
    bash: options.bash ?? '',
    bashTranscript: options.bashTranscript ?? '',
    codexSessions: options.codexSessions ?? '',
    bashSession: options.bashSession ?? '',
    requireBashSession: Boolean(options.requireBashSession),
    write: options.write ?? '',
    toolMode: options.toolMode ?? '',
    toolCards: Boolean(options.toolCards)
  };
  const tempPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (process.platform !== 'win32') throw error;
    fs.rmSync(filePath, { force: true });
    fs.renameSync(tempPath, filePath);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
  try { fs.chmodSync(filePath, 0o600); } catch {}
  return filePath;
}

export function clearRuntimeConnection(root) {
  try {
    const filePath = runtimeStatusPathForRoot(root);
    const saved = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (saved?.pid === process.pid && saved?.runtimeId === runtimeId) fs.rmSync(filePath, { force: true });
  } catch {}
}
