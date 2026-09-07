import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function normalizePath(value) {
  return path.resolve(String(value || '')).replaceAll('/', '\\').toLowerCase();
}

function isInside(candidate, parent) {
  const child = normalizePath(candidate);
  const root = normalizePath(parent).replace(/[\\]+$/, '');
  return child === root || child.startsWith(`${root}\\`);
}

export function isLikelyTemporaryNodePath(nodePath) {
  const normalized = normalizePath(nodePath);
  if (!normalized) return true;
  const tempRoot = os.tmpdir();
  if (tempRoot && isInside(nodePath, tempRoot)) return true;
  return normalized.includes('\\codex-runtimes\\')
    || normalized.includes('\\codex-primary-runtime\\')
    || normalized.includes('\\.cache\\')
    || normalized.includes('\\appdata\\local\\temp\\');
}

export function parseNodeMajor(version) {
  const match = String(version || '').trim().match(/^v?(\d+)/);
  return match ? Number(match[1]) : NaN;
}

function dedupePaths(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (!value) continue;
    const resolved = path.resolve(String(value).trim());
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(resolved);
  }
  return result;
}

function whereNodeCandidates() {
  if (process.platform !== 'win32') return [];
  const result = spawnSync('where.exe', ['node'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function commonWindowsNodeCandidates() {
  if (process.platform !== 'win32') return [];
  return [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs', 'node.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs', 'node.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe')
  ].filter(Boolean);
}

export function inspectNodeCandidate(nodePath) {
  const resolved = path.resolve(nodePath);
  if (!fs.existsSync(resolved)) {
    return { path: resolved, valid: false, version: null, major: NaN, temporary: isLikelyTemporaryNodePath(resolved), reason: 'not found' };
  }
  const result = spawnSync(resolved, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    return {
      path: resolved,
      valid: false,
      version: null,
      major: NaN,
      temporary: isLikelyTemporaryNodePath(resolved),
      reason: String(result.stderr || result.error || 'failed to execute').trim()
    };
  }
  const version = String(result.stdout || '').trim();
  const major = parseNodeMajor(version);
  return {
    path: resolved,
    valid: Number.isFinite(major) && major >= 20,
    version,
    major,
    temporary: isLikelyTemporaryNodePath(resolved),
    reason: Number.isFinite(major) && major >= 20 ? null : `Node.js 20+ required; found ${version || 'unknown'}`
  };
}

export function chooseStableNodeCandidate(candidates, preferredPath = null) {
  const preferred = preferredPath ? normalizePath(preferredPath) : null;
  const valid = candidates.filter((candidate) => candidate?.valid);
  const stable = valid.filter((candidate) => !candidate.temporary);
  if (!stable.length) return null;
  return stable
    .slice()
    .sort((a, b) => {
      const aPreferred = preferred && normalizePath(a.path) === preferred ? 1 : 0;
      const bPreferred = preferred && normalizePath(b.path) === preferred ? 1 : 0;
      if (aPreferred !== bPreferred) return bPreferred - aPreferred;
      const aProgramFiles = normalizePath(a.path).includes('\\program files\\nodejs\\') ? 1 : 0;
      const bProgramFiles = normalizePath(b.path).includes('\\program files\\nodejs\\') ? 1 : 0;
      if (aProgramFiles !== bProgramFiles) return bProgramFiles - aProgramFiles;
      return String(a.path).localeCompare(String(b.path));
    })[0];
}

export function discoverNodeRuntimes({ explicitPath = process.env.AGENTDOCK_CONTROL_NODE, currentPath = process.execPath } = {}) {
  const paths = dedupePaths([
    explicitPath,
    currentPath,
    ...whereNodeCandidates(),
    ...commonWindowsNodeCandidates()
  ]);
  return paths.map(inspectNodeCandidate);
}

export function resolveStableNodeRuntime(options = {}) {
  const explicitPath = options.explicitPath ?? process.env.AGENTDOCK_CONTROL_NODE;
  const currentPath = options.currentPath ?? process.execPath;
  const candidates = options.candidates || discoverNodeRuntimes({ explicitPath, currentPath });
  if (explicitPath) {
    const explicit = candidates.find((candidate) => normalizePath(candidate.path) === normalizePath(explicitPath));
    if (!explicit?.valid) {
      throw new Error(`AGENTDOCK_CONTROL_NODE is not a usable Node.js 20+ runtime: ${explicitPath}`);
    }
    if (explicit.temporary) {
      throw new Error(`AGENTDOCK_CONTROL_NODE points to a temporary/cache runtime that is unsafe for Windows sign-in startup: ${explicit.path}`);
    }
    return { selected: explicit, candidates, currentPath };
  }

  const selected = chooseStableNodeCandidate(candidates, currentPath);
  if (selected) return { selected, candidates, currentPath };

  const current = candidates.find((candidate) => normalizePath(candidate.path) === normalizePath(currentPath));
  const detail = current
    ? `Current Node: ${current.path} (${current.version || current.reason || 'unknown'})`
    : `Current Node: ${currentPath}`;
  throw new Error(
    [
      'No reboot-safe Node.js 20+ runtime was found for AgentDock Control Center.',
      detail,
      'Temporary/cache runtimes (for example Codex .cache/codex-runtimes) are not written into Windows startup shortcuts.',
      'Install Node.js LTS system-wide, reopen the terminal, run "npm ci", then rerun "npm run control-center:install".',
      'You may also set AGENTDOCK_CONTROL_NODE to a stable Node.js executable.'
    ].join('\n')
  );
}

export function verifyRuntimeDependencies(nodePath, repoRoot) {
  const script = [
    "await import('@modelcontextprotocol/sdk/types.js')",
    "await import('zod')",
    "console.log('ok')"
  ].join('; ');
  const result = spawnSync(nodePath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error || '').trim();
    throw new Error(
      [
        'AgentDock runtime dependencies are incomplete for the selected Node.js runtime.',
        detail || 'Runtime dependency check failed.',
        'Run "npm ci" from the AgentDock repository root, then rerun "npm run control-center:install".'
      ].join('\n')
    );
  }
  return true;
}
