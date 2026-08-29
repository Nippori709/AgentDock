#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { clearRuntimeConnection, saveRuntimeConnection } from './runtime/status.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function usage() {
  console.log(`LocalWorkspaceBridge launcher

Usage:
  npm install -g .
  local-workspace-bridge setup
  local-workspace-bridge start
  local-workspace-bridge start --root /path/to/repo
  local-workspace-bridge settings
  local-workspace-bridge doctor
  local-workspace-bridge inspect --root /path/to/repo [--json]
  local-workspace-bridge review --root /path/to/repo [--staged] [--path src/file.ts] [--json]
  local-workspace-bridge service install --root /path/to/repo
  local-workspace-bridge service status --root /path/to/repo
  local-workspace-bridge service restart --root /path/to/repo
  local-workspace-bridge service uninstall --root /path/to/repo
  local-workspace-bridge connection-test --root /path/to/repo
  local-workspace-bridge ngrok --hostname your-domain.ngrok-free.dev
  local-workspace-bridge tailscale --hostname your-device.your-tailnet.ts.net

Core options:
  --root <dir>              Workspace root. Default: current directory.
  --allow-root <dir>        Additional allowed root. Can be repeated.
  --allow-home              Allow opening workspaces under your home directory.
  --host <host>             Local bind host. Default: 127.0.0.1.
  --port <port>             Local port. Default: 8787.
  --bash <off|safe|full>    Bash mode. Default: safe.
  --no-bash                 Shortcut for --bash off.
  --write <off|workspace>   Direct workspace writes or read-only mode. Default: workspace.
  --tool-mode <minimal|standard|full>  Tool surface exposed to ChatGPT. Default: standard.
  --codex-sessions <off|metadata|read> Optional read-only local Codex session history.
  --tunnel <none|cloudflare|cloudflare-named|ngrok|tailscale>
  --hostname <host>         Stable public hostname for stable tunnel modes.
  --token <token>           Bearer token for HTTP MCP. Auto-generated for tunnels.
  --low-memory              Tune repository analysis for small Linux/VPS hosts.
  --version, -v             Print the version.
  --help                    Show this message.

LocalWorkspaceBridge keeps planning in the ChatGPT model and exposes bounded repository evidence, file/image access, direct edits, bash verification, and change review.
`);
}

const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m'
};

function paint(style, text) {
  if (!colorEnabled) return text;
  return `${ansi[style] ?? ''}${text}${ansi.reset}`;
}

function termWidth(max = 78) {
  return Math.max(56, Math.min(max, process.stdout.columns || max));
}

function divider(label = '') {
  const width = termWidth();
  if (!label) return paint('dim', '-'.repeat(width));
  const text = ` ${label} `;
  return paint('dim', `${text}${'-'.repeat(Math.max(0, width - text.length))}`);
}

function printBox(title, lines) {
  const width = termWidth();
  const inner = width - 4;
  console.log(divider(title));
  for (const line of lines) {
    const chunks = wrapLine(line, inner);
    for (const chunk of chunks) console.log(`| ${chunk.padEnd(inner)} |`);
  }
  console.log(divider());
}

function wrapLine(text, width) {
  if (text.length <= width) return [text];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function labelValue(label, value) {
  return `${label.padEnd(12)} ${value}`;
}

function statusLine(status, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('cyan', '..');
  console.log(`${marker} ${detail}`);
}

function profileSummary(profile) {
  if (!profile?.tunnel) return '';
  if (profile.tunnel === 'ngrok' && profile.hostname) return `Saved ngrok URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare-named' && profile.hostname) return `Saved Cloudflare URL: ${profile.hostname}`;
  if (profile.tunnel === 'tailscale' && profile.hostname) return `Saved Tailscale Funnel URL: ${profile.hostname}`;
  if (profile.tunnel === 'cloudflare') return 'Saved Cloudflare quick-tunnel setup';
  if (profile.tunnel === 'none') return 'Saved local-only setup';
  return '';
}

function profileOneLine(profile, index = 0) {
  const prefix = index ? `${index}. ` : '';
  const tunnel = profile.tunnel ?? 'cloudflare';
  const host = profile.hostname ? ` -> ${profile.hostname}` : '';
  const port = profile.port ? ` :${profile.port}` : '';
  return `${prefix}${profile.root}  ${tunnel}${host}${port}`;
}

function printSavedProfileHint(profile) {
  const summary = profileSummary(profile);
  if (!summary) return;
  printBox('Saved setup found', [
    summary,
    'From this folder, future launches only need: local-workspace-bridge start',
    'Use local-workspace-bridge setup when you want to change the port, mode, tool mode, tunnel, hostname, or token.'
  ]);
}

function parseArgs(argv) {
  const out = { allowRoots: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const option = raw.slice(2);
    const eq = option.indexOf('=');
    const key = eq >= 0 ? option.slice(0, eq) : option;
    const inlineValue = eq >= 0 ? option.slice(eq + 1) : undefined;
    if (key === 'help') out.help = true;
    else if (key === 'allow-home') out.allowHome = true;
    else if (key === 'no-auth') out.noAuth = true;
    else if (key === 'no-bash') out.bash = 'off';
    else if (key === 'compact-bash-transcript') out.bashTranscript = 'compact';
    else if (key === 'full-bash-transcript') out.bashTranscript = 'full';
    else if (key === 'codex-sessions-read') out.codexSessions = 'read';
    else if (key === 'require-bash-session') out.requireBashSession = true;
    else if (key === 'copy-url') out.copyUrl = true;
    else if (key === 'no-copy-url') out.noCopyUrl = true;
    else if (key === 'dry-run') out.dryRun = true;
    else if (key === 'no-start') out.noStart = true;
    else if (key === 'json') out.json = true;
    else if (key === 'staged') out.staged = true;
    else if (key === 'open-chatgpt') out.openChatgpt = true;
    else if (key === 'no-profile') out.noProfile = true;
    else if (key === 'save-config') out.saveConfig = true;
    else if (key === 'no-save-config') out.noSaveConfig = true;
    else if (key === 'yes' || key === 'force') out.yes = true;
    else if (key === 'stable') out.tunnel = 'cloudflare-named';
    else if (key === 'install-cloudflared') out.installCloudflared = true;
    else if (key === 'no-install-cloudflared') out.noInstallCloudflared = true;
    else if (key === 'log-requests') out.logRequests = true;
    else if (key === 'print-env') out.printEnv = true;
    else if (key === 'low-memory') out.lowMemory = true;
    else {
      const next = argv[i + 1];
      const value = inlineValue ?? next;
      if (value === undefined || (inlineValue === undefined && value.startsWith('--'))) throw new Error(`Missing value for --${key}`);
      if (inlineValue === undefined) i += 1;
      if (key === 'allow-root') out.allowRoots.push(value);
      else out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
  }
  return out;
}

function expandHome(input) {
  if (!input || input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function analysisChangedPaths(status) {
  if (!status || status === '(no output)') return [];
  const paths = [];
  for (const rawLine of String(status).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || /^(fatal:|error:|git unavailable)/i.test(line)) continue;
    let filePath = '';
    if (line.startsWith('?? ')) filePath = line.slice(3).trim();
    else if (line.includes('\t')) filePath = line.split('\t').pop()?.trim() ?? '';
    else if (/^.{2}\s/.test(line)) filePath = line.slice(3).trim();
    if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop() ?? filePath;
    if (filePath.startsWith('"') && filePath.endsWith('"')) {
      try { filePath = JSON.parse(filePath); } catch { filePath = filePath.slice(1, -1); }
    }
    if (filePath && !paths.includes(filePath)) paths.push(filePath);
  }
  return paths;
}

function assertGitStatusAvailable(status) {
  const value = String(status || '').trim();
  if (/^(fatal:|error:|git unavailable or failed:|git exited with status|usage: git )/i.test(value) || /not a git repository/i.test(value)) {
    throw new Error(`Unable to read Git changes: ${value}`);
  }
}

function printWorkspaceInspection(result, json) {
  const payload = {
    schema_version: result.schemaVersion,
    workspace_id: result.workspaceId,
    root: result.root,
    languages: result.languages,
    project_types: result.projectTypes,
    entrypoints: result.entrypoints,
    important_files: result.importantFiles,
    areas: result.areas,
    files: result.files,
    symbols: result.symbols,
    relationships: result.relationships,
    coverage: result.coverage,
    warnings: result.warnings,
    cache: result.cache
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log([
    'LocalWorkspaceBridge Repository Analysis',
    '',
    `Workspace: ${result.root}`,
    `Projects: ${result.projectTypes.join(', ') || 'unknown'}`,
    `Languages: ${result.languages.join(', ') || 'unknown'}`,
    `Entrypoints: ${result.entrypoints.join(', ') || 'none detected'}`,
    `Important areas: ${result.areas.slice(0, 8).map((area) => `${area.path} (${area.files})`).join(', ') || 'none'}`,
    `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files, ${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships${result.coverage.truncated ? ' (partial)' : ''}`,
    ...(result.warnings.length ? ['', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`)] : [])
  ].join('\n'));
}

function printChangeReview(result, json) {
  const payload = {
    schema_version: result.schemaVersion,
    changed_files: result.changedPaths,
    affected_areas: result.affectedAreas,
    dependent_files: result.dependentFiles,
    related_tests: result.relatedTests,
    risk_signals: result.riskSignals,
    recommended_commands: result.recommendedCommands,
    coverage: result.coverage,
    warnings: result.warnings,
    cache: result.cache
  };
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  console.log([
    'LocalWorkspaceBridge Change Review',
    '',
    `Changed files: ${result.changedPaths.join(', ') || 'none'}`,
    `Affected areas: ${result.affectedAreas.join(', ') || 'none'}`,
    `Risk: ${result.riskSignals.map((risk) => risk.label).join(', ') || 'none detected'}`,
    `Related tests: ${result.relatedTests.map((file) => file.path).join(', ') || 'none detected'}`,
    `Recommended verification: ${result.recommendedCommands.map((item) => item.command).join(', ') || 'none detected'}`,
    `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files${result.coverage.truncated ? ' (partial)' : ''}`,
    ...(result.warnings.length ? ['', 'Warnings:', ...result.warnings.map((warning) => `- ${warning}`)] : [])
  ].join('\n'));
}

async function runAnalysisCli(command, argv) {
  const args = parseArgs(argv);
  const root = realDir(args.root ?? process.cwd());
  const [{ loadConfig }, { PathGuard, WorkspaceManager }, analysis, git] = await Promise.all([
    import(pathToFileURL(path.join(projectRoot, 'dist', 'config.js')).href),
    import(pathToFileURL(path.join(projectRoot, 'dist', 'guard.js')).href),
    import(pathToFileURL(path.join(projectRoot, 'dist', 'analysis', 'index.js')).href),
    import(pathToFileURL(path.join(projectRoot, 'dist', 'gitOps.js')).href)
  ]);
  const config = loadConfig(['--root', root, '--bash', 'off', '--write', 'off']);
  const guard = new PathGuard(config);
  const workspace = new WorkspaceManager(config).defaultWorkspace();
  if (args.path) guard.resolve(workspace, args.path);
  if (command === 'inspect') {
    printWorkspaceInspection(await analysis.inspectWorkspace(config, guard, workspace), Boolean(args.json));
    return;
  }
  const status = git.gitDiffStatus(config, guard, workspace, args.path, Boolean(args.staged));
  assertGitStatusAvailable(status);
  const changedPaths = analysisChangedPaths(status);
  const review = await analysis.reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
  printChangeReview(review, Boolean(args.json));
}

function realDir(input) {
  const resolved = path.resolve(expandHome(input));
  if (!fs.existsSync(resolved)) throw new Error(`Directory does not exist: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${resolved}`);
  return fs.realpathSync(resolved);
}

function resolveCodexDir(root, input) {
  if (!input) return '';
  const expanded = expandHome(input);
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function resolveConfigPath(root, input) {
  if (!input) return '';
  const expanded = expandHome(String(input));
  return path.isAbsolute(expanded) || path.win32.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
}

function effectiveWriteMode(mode, requested) {
  const value = requested || 'workspace';
  if (!['off', 'workspace'].includes(value)) {
    throw new Error('--write must be off or workspace');
  }
  return value;
}

function writeOption(args, profile, mode) {
  return effectiveWriteMode(mode, optionValue(args, profile, 'write', ['LOCALWORKSPACEBRIDGE_WRITE_MODE'], 'workspace'));
}

function validateChoice(flag, value, allowed) {
  if (allowed.includes(value)) return value;
  throw new Error(`--${flag} must be ${allowed.slice(0, -1).join(', ')}, or ${allowed.at(-1)}`);
}

function optionalChoice(flag, value, allowed) {
  if (!value) return '';
  return validateChoice(flag, value, allowed);
}

function optionalWriteOption(args, profile, mode) {
  const requested = optionValue(args, profile, 'write', ['LOCALWORKSPACEBRIDGE_WRITE_MODE'], '');
  return requested ? effectiveWriteMode(mode, requested) : '';
}

function commandExists(command) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'command', process.platform === 'win32' ? [command] : ['-v', command], {
    shell: process.platform !== 'win32',
    stdio: 'ignore'
  });
  return result.status === 0;
}

function commandPaths(command) {
  if (process.platform === 'win32') {
    const result = spawnSync('where', [command], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (result.status !== 0) return [];
    return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }
  const result = spawnSync('command', ['-v', command], { encoding: 'utf8', shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status !== 0) return [];
  return String(result.stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isPathLike(command) {
  return command.includes('/') || command.includes('\\') || command.startsWith('.');
}

function resolveExecutablePath(command) {
  const expanded = expandHome(command);
  return path.resolve(expanded);
}

function isWindowsBatchFile(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

function isWindowsCommandCandidate(command) {
  return process.platform === 'win32' && /\.(cmd|bat|exe)$/i.test(command);
}

function resolveCodexCommand() {
  const explicit = String(process.env.LOCALWORKSPACEBRIDGE_CODEX_BIN ?? '').trim();
  if (explicit) {
    if (isPathLike(explicit)) return resolveExecutablePath(explicit);
    const candidates = commandPaths(explicit);
    if (process.platform !== 'win32') return candidates[0] || explicit;
    return candidates.find(isWindowsCommandCandidate) || explicit;
  }
  if (process.platform !== 'win32') return 'codex';
  return commandPaths('codex').find(isWindowsCommandCandidate) || 'codex';
}

function executableFileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  if (isPathLike(command)) return executableFileExists(resolveExecutablePath(command));
  return commandExists(command);
}

function commandAvailableFromRoot(command, root) {
  if (!isPathLike(command)) return commandExists(command);
  const expanded = expandHome(command);
  const resolved = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(root, expanded);
  return executableFileExists(resolved);
}

function executableCommand(command, args = []) {
  if (process.platform === 'win32' && /\.(?:mjs|cjs|js)$/i.test(command)) {
    return { command: process.execPath, args: [command, ...args] };
  }
  if (isWindowsBatchFile(command)) {
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] };
  }
  return { command, args };
}

function localWorkspaceBridgeHome() {
  const customHome = process.env.LOCALWORKSPACEBRIDGE_HOME;
  return customHome ? path.resolve(expandHome(customHome)) : path.join(os.homedir(), '.local-workspace-bridge');
}

function profileDir() {
  return path.join(localWorkspaceBridgeHome(), 'profiles');
}

function profileIdForRoot(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 24);
}

function profilePathForRoot(root) {
  return path.join(profileDir(), `${profileIdForRoot(root)}.json`);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
}

function loadWorkspaceProfile(root) {
  const profilePath = profilePathForRoot(root);
  if (!fs.existsSync(profilePath)) return {};
  const profile = readJsonFile(profilePath);
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return {};
  if (profile.root && profile.root !== root) return {};
  return { ...profile, profilePath };
}

function listWorkspaceProfiles() {
  const dir = profileDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const profilePath = path.join(dir, name);
      const profile = readJsonFile(profilePath);
      if (!profile || typeof profile !== 'object' || Array.isArray(profile) || !profile.root) return null;
      return { ...profile, profilePath };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
}

function deleteWorkspaceProfile(root) {
  const filePath = profilePathForRoot(root);
  if (!fs.existsSync(filePath)) return false;
  fs.rmSync(filePath, { force: true });
  return true;
}

function saveWorkspaceProfile(root, profile) {
  const dir = profileDir();
  const filePath = profilePathForRoot(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const payload = {
    version: 1,
    root,
    updatedAt: new Date().toISOString(),
    ...profile
  };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {}
  return filePath;
}

function sanitizedProfile(profile) {
  if (!profile || !Object.keys(profile).length) return {};
  const { token, cloudflareToken, ...rest } = profile;
  return {
    ...rest,
    ...(token ? { token: '<saved>' } : {}),
    ...(cloudflareToken ? { cloudflareToken: '<saved>' } : {})
  };
}

function reusableProfilePayload(profile, overrides = {}) {
  const {
    version,
    root,
    updatedAt,
    profilePath,
    ...rest
  } = profile || {};
  return {
    ...rest,
    ...overrides
  };
}

function optionValue(args, profile, field, envNames = [], fallback = undefined) {
  if (args[field] !== undefined) return args[field];
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return process.env[envName];
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return profile[field];
  return fallback;
}

function boolFromValue(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).toLowerCase());
}

function optionBool(args, profile, field, envNames = [], fallback = false) {
  if (args[field] !== undefined) return boolFromValue(args[field], fallback);
  for (const envName of envNames) {
    if (process.env[envName] !== undefined && process.env[envName] !== '') return boolFromValue(process.env[envName], fallback);
  }
  if (profile?.[field] !== undefined && profile[field] !== '') return boolFromValue(profile[field], fallback);
  return fallback;
}

function hasToolCardsInput(args, profile = {}) {
  return args.toolCards !== undefined || profile.toolCards !== undefined || (process.env.LOCALWORKSPACEBRIDGE_TOOL_CARDS !== undefined && process.env.LOCALWORKSPACEBRIDGE_TOOL_CARDS !== '');
}

function toolCardsProfileEntry(args, profile = {}) {
  const hasInput = hasToolCardsInput(args, profile);
  return hasInput ? { toolCards: optionBool(args, profile, 'toolCards', ['LOCALWORKSPACEBRIDGE_TOOL_CARDS'], false) } : {};
}

function toolCardsCliArgs(args, profile = {}) {
  if (!hasToolCardsInput(args, profile)) return [];
  return ['--tool-cards', optionBool(args, profile, 'toolCards', ['LOCALWORKSPACEBRIDGE_TOOL_CARDS'], false) ? 'on' : 'off'];
}

function validateBashSession(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error('--bash-session must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.');
  }
  return trimmed;
}

function bashSessionOptions(args, profile = {}) {
  const bashSession = validateBashSession(optionValue(args, profile, 'bashSession', ['LOCALWORKSPACEBRIDGE_BASH_SESSION_ID'], ''));
  const requireBashSession = optionBool(args, profile, 'requireBashSession', ['LOCALWORKSPACEBRIDGE_REQUIRE_BASH_SESSION'], false);
  if (requireBashSession && !bashSession) {
    throw new Error('--require-bash-session requires --bash-session <id>.');
  }
  return { bashSession, requireBashSession };
}

function bashTranscriptOption(args, profile = {}) {
  const value = optionValue(args, profile, 'bashTranscript', ['LOCALWORKSPACEBRIDGE_BASH_TRANSCRIPT'], 'compact');
  if (value === 'compact' || value === 'full') return value;
  throw new Error('--bash-transcript must be compact or full.');
}

function codexSessionsOption(args, profile = {}) {
  const value = optionValue(args, profile, 'codexSessions', ['LOCALWORKSPACEBRIDGE_CODEX_SESSIONS'], 'off');
  if (value === 'off' || value === 'metadata' || value === 'read') return value;
  throw new Error('--codex-sessions must be off, metadata, or read.');
}

function stableToken(existing = '') {
  return existing || randomBytes(24).toString('hex');
}

function cloudflaredBinName() {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

function localCloudflaredPath() {
  return path.join(localWorkspaceBridgeHome(), 'bin', cloudflaredBinName());
}

function cloudflaredReleaseAsset() {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'darwin') {
    if (arch === 'arm64') return { file: 'cloudflared-darwin-arm64.tgz', archive: true };
    if (arch === 'x64') return { file: 'cloudflared-darwin-amd64.tgz', archive: true };
  }

  if (platform === 'linux') {
    if (arch === 'arm64') return { file: 'cloudflared-linux-arm64', archive: false };
    if (arch === 'arm') return { file: 'cloudflared-linux-arm', archive: false };
    if (arch === 'x64') return { file: 'cloudflared-linux-amd64', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-linux-386', archive: false };
  }

  if (platform === 'win32') {
    if (arch === 'x64') return { file: 'cloudflared-windows-amd64.exe', archive: false };
    if (arch === 'ia32') return { file: 'cloudflared-windows-386.exe', archive: false };
  }

  throw new Error(`Automatic cloudflared install is not supported on ${platform}/${arch}. Install cloudflared manually or pass --cloudflared <path>.`);
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return fullPath;
    if (entry.isDirectory()) {
      const found = findFileByName(fullPath, fileName);
      if (found) return found;
    }
  }
  return '';
}

async function downloadFile(url, destination) {
  const proxyUrl = outboundProxyFromEnv(process.env);
  if (proxyUrl) {
    await runCurl([
      '--silent',
      '--show-error',
      '--fail',
      '--location',
      '--connect-timeout',
      '15',
      '--max-time',
      '300',
      '--proxy',
      proxyUrl,
      '--user-agent',
      'local-workspace-bridge-launcher',
      '--output',
      destination,
      url
    ], { timeoutMs: 305000 });
    return;
  }

  const response = await fetch(url, {
    headers: { 'user-agent': 'local-workspace-bridge-launcher' },
    signal: AbortSignal.timeout(300000)
  });
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destination, buffer, { mode: 0o755 });
}

function verifyCloudflared(binaryPath) {
  const executable = executableCommand(binaryPath, ['--version']);
  const result = spawnSync(executable.command, executable.args, {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`Downloaded cloudflared, but ${binaryPath} --version failed.`);
  }
}

async function installCloudflaredLocal() {
  const asset = cloudflaredReleaseAsset();
  const installPath = localCloudflaredPath();
  const binDir = path.dirname(installPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-workspace-bridge-cloudflared-'));
  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset.file}`;

  fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });
  console.error(`[local-workspace-bridge] Installing cloudflared locally: ${installPath}`);
  console.error(`[local-workspace-bridge] Downloading official Cloudflare release: ${asset.file}`);

  try {
    if (asset.archive) {
      const archivePath = path.join(tmpRoot, asset.file);
      const extractDir = path.join(tmpRoot, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await downloadFile(url, archivePath);
      const tar = spawnSync('tar', ['-xzf', archivePath, '-C', extractDir], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false
      });
      if (tar.status !== 0) {
        throw new Error(`Failed to extract ${asset.file}: ${tar.stderr || tar.stdout || `exit ${tar.status}`}`);
      }
      const extracted = findFileByName(extractDir, 'cloudflared');
      if (!extracted) throw new Error(`Could not find cloudflared inside ${asset.file}`);
      fs.copyFileSync(extracted, installPath);
    } else {
      const tmpBinary = path.join(tmpRoot, cloudflaredBinName());
      await downloadFile(url, tmpBinary);
      fs.copyFileSync(tmpBinary, installPath);
    }

    if (process.platform !== 'win32') fs.chmodSync(installPath, 0o755);
    verifyCloudflared(installPath);
    console.error('[local-workspace-bridge] cloudflared installed successfully.');
    return installPath;
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

async function resolveCloudflared(args) {
  const explicit = args.cloudflared ?? process.env.CLOUDFLARED_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyCloudflared(resolved);
      return resolved;
    }
    throw new Error(`cloudflared was not found at ${explicit}. Remove --cloudflared, install it, or pass a valid path.`);
  }

  if (!args.installCloudflared && commandExists('cloudflared')) {
    try {
      verifyCloudflared('cloudflared');
      return 'cloudflared';
    } catch (error) {
      console.error(`[local-workspace-bridge] cloudflared in PATH failed --version; trying local install. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const localPath = localCloudflaredPath();
  if (!args.installCloudflared && executableFileExists(localPath)) {
    try {
      verifyCloudflared(localPath);
      return localPath;
    } catch (error) {
      if (args.noInstallCloudflared) return localPath;
      console.error(`[local-workspace-bridge] Existing ${localPath} failed --version; reinstalling. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (args.noInstallCloudflared) return '';
  return installCloudflaredLocal();
}

function verifyNgrok(binaryPath) {
  const executable = executableCommand(binaryPath, ['version']);
  const result = spawnSync(executable.command, executable.args, {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`ngrok was found, but ${binaryPath} version failed. Run ngrok version to inspect it.`);
  }
}

function resolveNgrok(args) {
  const explicit = args.ngrok ?? process.env.NGROK_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyNgrok(resolved);
      return resolved;
    }
    throw new Error(`ngrok was not found at ${explicit}. Install ngrok, add it to PATH, or pass --ngrok <path>.`);
  }

  if (commandExists('ngrok')) {
    verifyNgrok('ngrok');
    return 'ngrok';
  }

  throw new Error('ngrok was not found on PATH. Install it with Homebrew, winget, apt, or from https://ngrok.com/download, then run ngrok config add-authtoken <token>.');
}

function verifyTailscale(binaryPath) {
  const executable = executableCommand(binaryPath, ['version']);
  const result = spawnSync(executable.command, executable.args, {
    stdio: 'ignore',
    shell: false,
    timeout: 15000
  });
  if (result.status !== 0) {
    throw new Error(`tailscale was found, but ${binaryPath} version failed. Run tailscale version to inspect it.`);
  }
}

function resolveTailscale(args) {
  const explicit = args.tailscale ?? process.env.TAILSCALE_BIN ?? '';
  if (explicit) {
    const resolved = isPathLike(explicit) ? resolveExecutablePath(explicit) : explicit;
    if (commandAvailable(resolved)) {
      verifyTailscale(resolved);
      return resolved;
    }
    throw new Error(`tailscale was not found at ${explicit}. Install Tailscale, add it to PATH, or pass --tailscale <path>.`);
  }

  if (commandExists('tailscale')) {
    verifyTailscale('tailscale');
    return 'tailscale';
  }

  throw new Error('tailscale was not found on PATH. Install Tailscale and enable Funnel, then run local-workspace-bridge tailscale --hostname your-device.your-tailnet.ts.net.');
}

function ngrokConfigPath(root, args, profile = {}) {
  const configPath = optionValue(args, profile, 'ngrokConfig', ['NGROK_CONFIG', 'LOCALWORKSPACEBRIDGE_NGROK_CONFIG'], '');
  return resolveConfigPath(root, configPath);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(url, token, timeoutMs = 15000) {
  const started = Date.now();
  let lastError = '';
  while (Date.now() - started < timeoutMs) {
    try {
      const remainingMs = timeoutMs - (Date.now() - started);
      const attemptTimeoutMs = Math.max(1, Math.min(5000, remainingMs));
      const target = new URL(url);
      const proxyUrl = isLoopbackHost(target.hostname) ? '' : outboundProxyFromEnv(process.env);
      if (proxyUrl) {
        const response = await curlHealthRequest(url, token, proxyUrl, attemptTimeoutMs);
        if (response.ok) return JSON.parse(response.body);
        lastError = `${response.status} ${response.body}`;
      } else {
        const res = await fetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          signal: AbortSignal.timeout(attemptTimeoutMs)
        });
        if (res.ok) return await res.json();
        lastError = `${res.status} ${await res.text()}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}. Last error: ${lastError}`);
}

function portInUseHelp(host, port) {
  return [
    `Local port ${port} is already in use on ${host}.`,
    '',
    'If you want two repositories running at the same time, each one needs its own local port.',
    '',
    'Example:',
    '  repo A: local-workspace-bridge setup  -> port 8787 -> hostname A',
    '  repo B: local-workspace-bridge setup  -> port 8788 -> hostname B',
    '',
    'For quick tunnels you can also start the second repo with:',
    '  local-workspace-bridge start --port 8788',
    '',
    'Stable public hostnames also cannot be shared by two running repositories at once.'
  ].join('\n');
}

function normalizePort(port) {
  const numericPort = Number(port);
  if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  return String(numericPort);
}

async function assertPortAvailable(host, port) {
  const numericPort = Number(normalizePort(port));
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE') {
        reject(new Error(portInUseHelp(host, port)));
        return;
      }
      reject(error);
    });
    server.once('listening', () => {
      server.close(() => resolve());
    });
    server.listen(numericPort, host);
  });
}

const spawnedChildren = new Set();

function spawnLogged(name, command, args, options = {}) {
  const { verbose = false, ...spawnOptions } = options;
  const executable = executableCommand(command, args);
  const child = spawn(executable.command, executable.args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] });
  const logLines = [];
  const record = (stream, chunk) => {
    const text = redactForLog(String(chunk));
    logLines.push(...text.split(/\r?\n/).filter(Boolean).map((line) => `[${name}] ${line}`));
    while (logLines.length > 120) logLines.shift();
    if (verbose) stream.write(`[${name}] ${text}`);
  };
  child.localWorkspaceBridgeLogTail = () => logLines.join('\n');
  spawnedChildren.add(child);
  child.stdout.on('data', (chunk) => record(process.stdout, chunk));
  child.stderr.on('data', (chunk) => record(process.stderr, chunk));
  child.on('exit', (code, signal) => {
    spawnedChildren.delete(child);
    if (verbose) console.error(`[${name}] exited code=${code} signal=${signal}`);
  });
  return child;
}

function waitForCloudflareUrl(child, timeoutMs = 45000) {
  const re = /https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/g;
  let buffer = '';
  const isQuickTunnelUrl = (value) => {
    try {
      return new URL(value).hostname !== 'api.trycloudflare.com';
    } catch {
      return false;
    }
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for cloudflared public URL.')), timeoutMs);
    timer.unref();
    const onData = (chunk) => {
      const text = String(chunk);
      buffer += text;
      const match = buffer.match(re);
      const tunnelUrl = match?.find(isQuickTunnelUrl);
      if (tunnelUrl) {
        clearTimeout(timer);
        resolve(tunnelUrl);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited before a URL was found, code=${code}`));
    });
  });
}

function waitForTunnelStartup(child, label, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
    };
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const outputTail = () => {
      const tail = typeof child.localWorkspaceBridgeLogTail === 'function' ? child.localWorkspaceBridgeLogTail() : '';
      return tail ? `\n\nRecent ${label} output:\n${tail}` : '';
    };
    const onExit = (code, signal) => {
      settle(reject, new Error(`${label} exited before startup completed, code=${code} signal=${signal}${outputTail()}`));
    };
    const onError = (error) => {
      settle(reject, new Error(`${label} failed before startup completed: ${error instanceof Error ? error.message : String(error)}${outputTail()}`));
    };
    timer = setTimeout(() => settle(resolve), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

function outboundProxyFromEnv(env = process.env) {
  return env.HTTPS_PROXY || env.https_proxy || env.ALL_PROXY || env.all_proxy || env.HTTP_PROXY || env.http_proxy || '';
}

function directNgrokEnvironment(env = process.env) {
  const direct = { ...env };
  for (const key of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    delete direct[key];
  }
  return direct;
}

function curlExecutable(args) {
  return executableCommand(process.env.LOCALWORKSPACEBRIDGE_CURL?.trim() || 'curl', args);
}

function runCurl(args, options = {}) {
  const { input = '', timeoutMs = 30000 } = options;
  const executable = curlExecutable(args);
  return new Promise((resolve, reject) => {
    const child = spawn(executable.command, executable.args, {
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-1024 * 1024);
    child.stdout.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`curl timed out after ${timeoutMs}ms.`));
      } else if (code !== 0) {
        reject(new Error(redactForLog(`curl failed, code=${code} signal=${signal}: ${stderr || stdout}`)));
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (input) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

async function curlHealthRequest(url, token, proxyUrl, timeoutMs) {
  const args = [
    '--silent',
    '--show-error',
    '--max-time',
    String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    '--proxy',
    proxyUrl,
    '--output',
    '-',
    '--write-out',
    '\n%{http_code}'
  ];
  const input = token ? `Authorization: Bearer ${token}\n` : '';
  if (input) args.push('--header', '@-');
  args.push(url);
  const result = await runCurl(args, { input, timeoutMs: timeoutMs + 1000 });
  const splitAt = result.stdout.lastIndexOf('\n');
  if (splitAt < 0) throw new Error('curl health response did not include an HTTP status.');
  const body = result.stdout.slice(0, splitAt);
  const status = Number(result.stdout.slice(splitAt + 1).trim());
  if (!Number.isInteger(status)) throw new Error('curl health response included an invalid HTTP status.');
  return { ok: status >= 200 && status < 300, status, body };
}

function requestQuickTunnelViaCurl(proxyUrl) {
  const args = ['--silent', '--show-error', '--fail', '--max-time', '30'];
  if (proxyUrl) args.push('--proxy', proxyUrl);
  args.push('-X', 'POST', 'https://api.trycloudflare.com/tunnel');
  const executable = curlExecutable(args);
  const result = spawnSync(executable.command, executable.args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  if (result.status !== 0) {
    throw new Error(redactForLog(`Failed to request Cloudflare quick tunnel via curl: ${result.stderr || result.stdout || `exit ${result.status}`}`));
  }

  let body;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    throw new Error('Cloudflare quick tunnel API returned invalid JSON.');
  }

  const tunnel = body?.result;
  if (!body?.success || !tunnel?.id || !tunnel?.hostname || !tunnel?.account_tag || !tunnel?.secret) {
    const errors = Array.isArray(body?.errors) && body.errors.length ? ` ${JSON.stringify(body.errors)}` : '';
    throw new Error(redactForLog(`Cloudflare quick tunnel API did not return usable tunnel credentials.${errors}`));
  }

  return {
    id: String(tunnel.id),
    hostname: normalizePublicHostname(tunnel.hostname),
    accountTag: String(tunnel.account_tag),
    secret: String(tunnel.secret)
  };
}

function writeQuickTunnelCredentials(tunnel) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'local-workspace-bridge-cloudflare-quick-'));
  const credentialsPath = path.join(tmpRoot, 'credentials.json');
  fs.writeFileSync(credentialsPath, JSON.stringify({
    AccountTag: tunnel.accountTag,
    TunnelSecret: tunnel.secret,
    TunnelID: tunnel.id
  }, null, 2), { mode: 0o600 });
  return { tmpRoot, credentialsPath };
}

function killProcess(child) {
  if (!child || child.killed) return;
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (!child.killed) {
      try { child.kill('SIGKILL'); } catch {}
    }
  }, 1500).unref();
}

function cleanupChildren() {
  for (const child of spawnedChildren) killProcess(child);
}

function normalizePublicHostname(value) {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  if (url.protocol !== 'https:') throw new Error('hostname must use https when a scheme is provided.');
  if (url.search || url.hash) throw new Error('hostname must not include query strings or fragments.');
  if (url.pathname !== '/' && url.pathname !== '/mcp') throw new Error('hostname must be a host, URL root, or /mcp URL.');
  return url.host;
}

function publicBaseFromHostname(hostname) {
  return `https://${normalizePublicHostname(hostname)}`;
}

function tailscaleFunnelHttpsPort(publicBase) {
  const port = new URL(publicBase).port || '443';
  if (!['443', '8443', '10000'].includes(port)) {
    throw new Error('Tailscale Funnel HTTPS port must be 443, 8443, or 10000.');
  }
  return port;
}

function readTokenFile(filePath) {
  const resolved = path.resolve(expandHome(filePath));
  return fs.readFileSync(resolved, 'utf8').trim();
}

function normalizeMode(args) {
  const mode = args.mode ?? process.env.LOCALWORKSPACEBRIDGE_MODE ?? 'agent';
  if (mode !== 'agent') {
    throw new Error('--mode only supports agent');
  }
  return mode;
}

function copyToClipboard(text) {
  const attempts = [];
  if (process.platform === 'darwin') attempts.push(['pbcopy', []]);
  else if (process.platform === 'win32') attempts.push(['cmd', ['/c', 'clip']]);
  else {
    attempts.push(['wl-copy', []]);
    attempts.push(['xclip', ['-selection', 'clipboard']]);
    attempts.push(['xsel', ['--clipboard', '--input']]);
  }

  for (const [command, args] of attempts) {
    const exists = command === 'cmd' || commandExists(command);
    if (!exists) continue;
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
      shell: false
    });
    if (result.status === 0) return { ok: true, command };
  }
  return { ok: false, command: '' };
}

function openUrl(url) {
  const command =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  const [bin, args] = command;
  if (bin !== 'cmd' && !commandExists(bin)) return false;
  const result = spawnSync(bin, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function waitForProcessExit(child) {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function waitForPublicHealth(publicBase, token, tunnelChild, tunnelLabel = 'tunnel') {
  const health = waitForHealth(`${publicBase}/healthz`, token, 60000);
  const exit = waitForProcessExit(tunnelChild).then(({ code, signal }) => {
    throw new Error(`${tunnelLabel} exited before ${publicBase}/healthz was reachable, code=${code} signal=${signal}`);
  });
  return Promise.race([health, exit]);
}

function isSubpath(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function shellCommandPreview(parts) {
  return parts.map((part) => {
    const text = String(part);
    if (/^[A-Za-z0-9_./:@=+-]+$/.test(text)) return text;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }).join(' ');
}

function redactForLog(value) {
  return String(value)
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_SECRET]')
    .replace(/\b(?:sk-ant-[A-Za-z0-9_-]{10,}|gh[opsru]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1[REDACTED_SECRET]')
    .replace(/(["']?Authorization["']?\s*:\s*["']?Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED_SECRET]')
    .replace(/([?&](?:local_workspace_bridge_token|token|access_token|auth_token|api[_-]?key)=)[^&\s"'`<>]{8,}/gi, '$1[REDACTED_SECRET]')
    .replace(/(["']?[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}["']?\s*:\s*)(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi, '$1[REDACTED_SECRET]')
    .replace(/\b[A-Za-z0-9_]{0,64}(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)[A-Za-z0-9_]{0,64}\s*=\s*(?:"[^"\r\n]{12,512}"|'[^'\r\n]{12,512}'|`[^`\r\n]{12,512}`|[A-Za-z0-9_./+=-]{20,512})/gi, (match) => {
      const index = match.indexOf('=');
      return index < 0 ? '[REDACTED_SECRET]' : `${match.slice(0, index).trimEnd()}= [REDACTED_SECRET]`;
    });
}

function redactEnvObject(env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    out[key] = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PRIVATE[_-]?KEY)/i.test(key)
      ? '<redacted>'
      : redactForLog(String(value));
  }
  return out;
}

function trimBytes(value, maxBytes) {
  const redacted = redactForLog(value);
  const buffer = Buffer.from(redacted, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: redacted, truncated: false };
  return {
    text: `${buffer.subarray(0, maxBytes).toString('utf8')}\n...[output truncated to ${maxBytes} bytes]`,
    truncated: true
  };
}

function createConnectorDetails(endpoint, token, localBase = '', oauth = false) {
  const serverUrl = endpoint;
  return {
    endpoint,
    token,
    oauth,
    serverUrl,
    localStatusUrl: localBase && !token ? `${localBase}/` : '',
    chatgptSettingsUrl: 'https://chatgpt.com/#settings/Connectors'
  };
}

function printCreateAppFields(details) {
  console.log('Create App fields:');
  console.log('');
  console.log('  Name: LocalWorkspaceBridge');
  console.log('  Description: Local coding workspace bridge for ChatGPT.');
  console.log('  Connection: Server URL');
  console.log(`  Server URL: ${details.serverUrl}`);
  console.log(`  Authentication: ${details.oauth ? 'OAuth' : details.token ? 'Bearer token / Custom header' : 'No Authentication / None'}`);
  console.log('');
  if (details.oauth) {
    console.log('OAuth approval key (enter once on the LocalWorkspaceBridge consent page):');
    console.log('');
    console.log(`  ${details.token}`);
  } else if (details.token) {
    console.log('Required request header:');
    console.log('');
    console.log(`  Authorization: Bearer ${details.token}`);
  } else {
    console.log('Authorization: disabled');
  }
}

function printConnectorBlock(endpoint, token, options = {}) {
  const details = createConnectorDetails(endpoint, token, options.localBase ?? '', Boolean(options.oauth));
  const { serverUrl } = details;
  const publicHttps = serverUrl.startsWith('https://');
  const shouldCopy = options.copyUrl === true || (options.copyUrl !== false && publicHttps);
  const copied = shouldCopy ? copyToClipboard(serverUrl) : { ok: false, command: '' };
  const opened = options.openChatgpt ? openUrl(details.chatgptSettingsUrl) : false;

  const mode = options.mode ?? 'agent';
  const modeTitle = 'Agent';
  console.log('');
  console.log(paint('bold', 'LocalWorkspaceBridge ready'));
  if (options.root) console.log(`  Workspace  ${options.root}`);
  console.log(`  Mode       ${modeTitle}  tools=${options.toolMode ?? 'standard'}  write=${options.write ?? 'workspace'}  bash=${options.bash ?? 'safe'}`);
  console.log(`  Transcript bash=${options.bashTranscript ?? 'compact'}`);
  if (options.codexSessions && options.codexSessions !== 'off') console.log(`  Codex      sessions=${options.codexSessions}`);
  if (options.bashSession) console.log(`  Bash       session=${options.bashSession}${options.requireBashSession ? ' required' : ''}`);
  console.log(`  Connector  ${publicHttps ? 'public HTTPS' : 'local HTTP'}`);
  if (copied.ok) {
    console.log(`  URL        copied with ${copied.command}`);
    console.log(`  Server URL ${serverUrl}`);
  } else if (shouldCopy) {
    console.log('  URL        copy failed; copy manually:');
    console.log(serverUrl);
  } else if (options.copyUrl === false && publicHttps) {
    console.log('  URL        not copied; press c to copy or u to show');
  } else if (!publicHttps) {
    console.log('  URL        local HTTP only');
    console.log(serverUrl);
  }
  if (options.openChatgpt) {
    statusLine(opened ? 'ok' : 'warn', opened ? 'Opened ChatGPT connector settings' : 'Could not open ChatGPT automatically');
  }
  console.log('');
  if (options.connectionTest) {
    console.log(paint('bold', 'Connection test'));
    console.log('  1. In ChatGPT, open Settings -> Plugins and create a development plugin.');
    console.log(`  2. Paste the Server URL above and choose Authentication: ${details.oauth ? 'OAuth' : 'Bearer'}.`);
    console.log('  3. Watch this terminal for: [LocalWorkspaceBridge] POST /mcp received');
    console.log('');
    console.log('  No POST /mcp     ChatGPT or the tunnel did not reach LocalWorkspaceBridge.');
    console.log(`  POST /mcp -> 401 ${details.oauth ? 'Complete the OAuth consent flow and enter the local approval key.' : 'The Authorization: Bearer header is missing or invalid.'}`);
    console.log('  POST /mcp -> 2xx The MCP connection reached LocalWorkspaceBridge successfully.');
    console.log('');
  }
  console.log(`Next: press Enter to open ChatGPT, paste the copied Server URL, choose Authentication: ${details.oauth ? 'OAuth' : token ? 'Bearer' : 'None'}.`);
  console.log(`Keys: Enter open | c copy | p ${details.oauth ? 'OAuth key' : 'fields'} | o status | h help | q quit`);
  return { ...details, copied, opened, mode, toolMode: options.toolMode ?? 'standard' };
}

function printControlHelp() {
  console.log('');
  console.log('Controls');
  console.log('  Enter  open ChatGPT connector settings in your browser');
  console.log('  c      copy Server URL again');
  console.log('  u      print Server URL only');
  console.log('  o      open local setup/status page');
  console.log('  p      print Create App fields');
  console.log('  m      print mode help');
  console.log('  h      show controls');
  console.log('  q      stop LocalWorkspaceBridge');
  console.log('');
}

function printModeHelp() {
  console.log('');
  console.log('Modes');
  console.log('  local-workspace-bridge start                 agent mode: read/write/edit/apply_patch/search/bash');
  console.log('  local-workspace-bridge start --no-bash       agent mode without ChatGPT-triggered shell commands');
  console.log('  local-workspace-bridge start --bash-session main --require-bash-session');
  console.log('  local-workspace-bridge start                 direct ChatGPT-to-workspace agent mode');
  console.log('  local-workspace-bridge start --tool-mode minimal   expose only the tight coding loop');
  console.log('  local-workspace-bridge start --tool-mode full      expose every advanced compatibility tool');
  console.log('');
}

function printStableUrlHelp() {
  console.log('');
  console.log('Stable URL setup');
  console.log('');
  console.log('Quick tunnels change every restart. ChatGPT apps should use a stable URL.');
  console.log('');
  console.log('One-time Cloudflare setup with your domain:');
  console.log('  local-workspace-bridge install-cloudflared');
  console.log('  ~/.local-workspace-bridge/bin/cloudflared tunnel login');
  console.log('  ~/.local-workspace-bridge/bin/cloudflared tunnel create local-workspace-bridge');
  console.log('  ~/.local-workspace-bridge/bin/cloudflared tunnel route dns local-workspace-bridge local-workspace-bridge.example.com');
  console.log('');
  console.log('Daily start:');
  console.log('  local-workspace-bridge stable --hostname local-workspace-bridge.example.com --tunnel-name local-workspace-bridge --token [REDACTED_SECRET]');
  console.log('');
  console.log('Ngrok alternative with a reserved domain:');
  console.log('  ngrok config add-authtoken <your-ngrok-token>');
  console.log('  local-workspace-bridge ngrok --hostname your-domain.ngrok-free.dev --token [REDACTED_SECRET]');
  console.log('');
  console.log('Tailscale Funnel alternative:');
  console.log('  tailscale funnel 8787');
  console.log('  local-workspace-bridge tailscale --hostname your-device.your-tailnet.ts.net --token [REDACTED_SECRET]');
  console.log('');
}

function compareMajorVersion(version, minimumMajor) {
  const major = Number(String(version).split('.')[0]);
  return Number.isFinite(major) && major >= minimumMajor;
}

function browserOpenCommand() {
  if (process.platform === 'darwin') return commandExists('open') ? 'open' : '';
  if (process.platform === 'win32') return 'cmd start';
  return commandExists('xdg-open') ? 'xdg-open' : '';
}

function clipboardCommand() {
  if (process.platform === 'darwin') return commandExists('pbcopy') ? 'pbcopy' : '';
  if (process.platform === 'win32') return 'clip';
  for (const command of ['wl-copy', 'xclip', 'xsel']) {
    if (commandExists(command)) return command;
  }
  return '';
}

function localOrPathCommand(command, localPath) {
  if (command && commandAvailable(command)) return command;
  if (localPath && executableFileExists(localPath)) return localPath;
  return '';
}

function doctorLine(status, label, detail = '') {
  const marker = status === 'ok' ? paint('green', 'OK') : status === 'warn' ? paint('yellow', 'WARN') : paint('red', 'FAIL');
  console.log(`${marker} ${label.padEnd(18)} ${detail}`);
}

async function runDoctor(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.LOCALWORKSPACEBRIDGE_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  const effectiveArgs = { ...profile, ...args };
  const tunnel = optionValue(args, profile, 'tunnel', ['LOCALWORKSPACEBRIDGE_TUNNEL'], 'cloudflare');
  const host = optionValue(args, profile, 'host', ['LOCALWORKSPACEBRIDGE_HOST'], '127.0.0.1');
  const port = String(optionValue(args, profile, 'port', ['LOCALWORKSPACEBRIDGE_PORT'], '8787'));
  const mode = optionValue(args, profile, 'mode', ['LOCALWORKSPACEBRIDGE_MODE'], 'agent');
  const bash = optionValue(args, profile, 'bash', ['LOCALWORKSPACEBRIDGE_BASH_MODE'], 'safe');
  const rawWrite = optionValue(args, profile, 'write', ['LOCALWORKSPACEBRIDGE_WRITE_MODE'], 'workspace');
  let write = String(rawWrite);
  let writeError = '';
  try {
    write = effectiveWriteMode(mode, rawWrite);
  } catch (error) {
    writeError = error instanceof Error ? error.message : String(error);
  }
  const toolMode = optionValue(args, profile, 'toolMode', ['LOCALWORKSPACEBRIDGE_TOOL_MODE'], 'standard');
  const stableHostname = args.hostname
    ?? args.url
    ?? process.env.LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME
    ?? process.env.LOCALWORKSPACEBRIDGE_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  const serverPath = path.join(projectRoot, 'dist', 'server.js');
  const cloudflaredPath = localOrPathCommand(
    effectiveArgs.cloudflared ?? process.env.CLOUDFLARED_BIN ?? 'cloudflared',
    localCloudflaredPath()
  );
  const ngrokPath = localOrPathCommand(effectiveArgs.ngrok ?? process.env.NGROK_BIN ?? 'ngrok', '');
  const tailscalePath = localOrPathCommand(effectiveArgs.tailscale ?? process.env.TAILSCALE_BIN ?? 'tailscale', '');
  const clipboard = clipboardCommand();
  const browser = browserOpenCommand();
  const checks = [];

  function record(status, label, detail) {
    checks.push(status);
    doctorLine(status, label, detail);
  }

  console.log('');
  printBox('LocalWorkspaceBridge doctor', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    labelValue('Tunnel', tunnel),
    ...(stableHostname ? [labelValue('Hostname', stableHostname)] : []),
    ...(profile.profilePath ? [labelValue('Profile', profile.profilePath)] : [])
  ]);

  record(compareMajorVersion(process.versions.node, 20) ? 'ok' : 'fail', 'Node', `v${process.versions.node} (requires >=20)`);
  record(fs.existsSync(httpPath) && fs.existsSync(serverPath) ? 'ok' : 'fail', 'Build artifacts', fs.existsSync(httpPath) ? 'dist ready' : 'missing dist/http.js; run npm install && npm run build');
  record(fs.existsSync(path.join(projectRoot, 'package.json')) ? 'ok' : 'fail', 'Package root', projectRoot);
  const npmCacheValue = String(process.env.npm_config_cache ?? '').trim();
  const resolvedNpmCache = npmCacheValue && !npmCacheValue.startsWith('=') ? path.resolve(npmCacheValue) : '';
  const suspiciousCacheDir = fs.existsSync(path.join(root, '=', 'npm-cache')) || fs.existsSync(path.join(root, 'npm-cache'));
  const npmCacheInsideWorkspace = Boolean(resolvedNpmCache && isSubpath(resolvedNpmCache, root));
  record(
    npmCacheValue.startsWith('=') || suspiciousCacheDir || npmCacheInsideWorkspace ? 'fail' : 'ok',
    'npm cache',
    npmCacheValue.startsWith('=')
      ? `invalid npm_config_cache begins with '=': ${npmCacheValue}`
      : suspiciousCacheDir
        ? 'suspicious npm cache directory exists inside the workspace'
        : npmCacheInsideWorkspace
          ? `npm cache resolves inside the workspace: ${resolvedNpmCache}`
          : npmCacheValue || 'default external cache'
  );
  record(profile.profilePath ? 'ok' : 'warn', 'Saved profile', profile.profilePath ? profileSummary(profile) || profile.profilePath : 'none for this workspace');
  record(mode === 'agent' ? 'ok' : 'fail', 'Mode', mode === 'agent' ? mode : '--mode only supports agent');
  record(['off', 'safe', 'full'].includes(bash) ? 'ok' : 'fail', 'Bash mode', ['off', 'safe', 'full'].includes(bash) ? bash : '--bash must be off, safe, or full');
  record(!writeError && ['off', 'workspace'].includes(write) ? 'ok' : 'fail', 'Write mode', writeError || write);
  record(['minimal', 'standard', 'full'].includes(toolMode) ? 'ok' : 'fail', 'Tool mode', ['minimal', 'standard', 'full'].includes(toolMode) ? toolMode : '--tool-mode must be minimal, standard, or full');
  record(clipboard ? 'ok' : 'warn', 'Clipboard', clipboard || 'not found; URL will be printed for manual copy');
  record(browser ? 'ok' : 'warn', 'Browser open', browser || 'not found; open ChatGPT manually');

  try {
    await assertPortAvailable(host, port);
    record('ok', 'Local port', `${host}:${port} available`);
  } catch (error) {
    record('fail', 'Local port', error instanceof Error ? error.message.split('\n')[0] : String(error));
  }

  if (tunnel === 'none') {
    record('ok', 'Tunnel', 'local-only mode');
  } else if (tunnel === 'cloudflare') {
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; local-workspace-bridge start can auto-install unless --no-install-cloudflared is used');
  } else if (tunnel === 'cloudflare-named') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Cloudflare stable mode');
    record(cloudflaredPath ? 'ok' : 'warn', 'cloudflared', cloudflaredPath || 'missing now; run local-workspace-bridge install-cloudflared or pass --cloudflared');
    record(
      optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'LOCALWORKSPACEBRIDGE_TUNNEL_NAME'], '') ||
        optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN_FILE'], '') ||
        optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'LOCALWORKSPACEBRIDGE_CLOUDFLARE_CONFIG'], '') ||
        optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN'], '')
        ? 'ok'
        : 'fail',
      'Cloudflare setup',
      'needs tunnel name, config, token file, or tunnel token'
    );
  } else if (tunnel === 'ngrok') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for ngrok mode');
    record(ngrokPath ? 'ok' : 'fail', 'ngrok', ngrokPath || 'not found on PATH; install ngrok and run ngrok config add-authtoken <token>');
  } else if (tunnel === 'tailscale') {
    record(stableHostname ? 'ok' : 'fail', 'Hostname', stableHostname || 'required for Tailscale Funnel mode');
    record(tailscalePath ? 'ok' : 'fail', 'tailscale', tailscalePath || 'not found on PATH; install Tailscale and enable Funnel');
  } else {
    record('fail', 'Tunnel', `unknown tunnel mode: ${tunnel}`);
  }

  const failures = checks.filter((status) => status === 'fail').length;
  const warnings = checks.filter((status) => status === 'warn').length;
  console.log('');
  if (failures) {
    statusLine('warn', `${failures} blocker${failures === 1 ? '' : 's'} and ${warnings} warning${warnings === 1 ? '' : 's'} found.`);
    process.exitCode = 1;
    return;
  }
  statusLine('ok', warnings ? `Ready with ${warnings} warning${warnings === 1 ? '' : 's'}.` : 'Ready.');
}

function normalizeSetupChoice(value, allowed, fallback) {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  const match = allowed.find((item) => item === normalized || item.startsWith(normalized));
  return match ?? fallback;
}

async function ask(rl, question, fallback = '') {
  const suffix = fallback ? ` ${paint('dim', `[${fallback}]`)}` : '';
  const hint = fallback ? `${paint('dim', '> Enter to proceed with default')}\n` : '';
  const answer = await rl.question(`${paint('cyan', '?')} ${question}${suffix}\n${hint}> `);
  return answer.trim() || fallback;
}

function tunnelChoiceFromProfile(profile, fallback = 'cloudflare') {
  if (profile?.tunnel === 'ngrok') return 'ngrok';
  if (profile?.tunnel === 'cloudflare-named') return 'stable';
  if (profile?.tunnel === 'tailscale') return 'tailscale';
  if (profile?.tunnel === 'none') return 'local';
  if (profile?.tunnel === 'cloudflare') return 'cloudflare';
  return fallback;
}

function tunnelModeFromChoice(choice) {
  if (choice === 'quick' || choice === 'cloudflare') return 'cloudflare';
  if (choice === 'stable') return 'cloudflare-named';
  if (choice === 'tailscale') return 'tailscale';
  if (choice === 'local') return 'none';
  return choice;
}

function hasExplicitTunnelInput(args) {
  return Boolean(
    args.tunnel ||
    args.noProfile ||
    process.env.LOCALWORKSPACEBRIDGE_TUNNEL
  );
}

async function collectTunnelPreference(rl, defaults, profile, options = {}) {
  const defaultTunnel = options.defaultTunnel ?? tunnelChoiceFromProfile(profile, 'cloudflare');
  const tunnelAnswer = await ask(rl, 'Tunnel: cloudflare, ngrok, tailscale, stable, or local?', defaultTunnel);
  const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['cloudflare', 'quick', 'ngrok', 'tailscale', 'stable', 'local'], defaultTunnel);
  const tunnel = tunnelModeFromChoice(tunnelChoice);
  let hostname = '';
  let tunnelName = '';
  let ngrokConfig = '';
  let cloudflareConfig = '';
  let cloudflareTokenFile = '';

  if (tunnel === 'ngrok') {
    hostname = await ask(
      rl,
      'Ngrok domain or URL, without /mcp',
      optionValue(defaults, profile, 'hostname', ['LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME', 'LOCALWORKSPACEBRIDGE_HOSTNAME', 'NGROK_DOMAIN'], '')
    );
    if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
    hostname = normalizePublicHostname(hostname);
    ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'LOCALWORKSPACEBRIDGE_NGROK_CONFIG'], '');
  } else if (tunnel === 'cloudflare-named') {
    hostname = await ask(
      rl,
      'Stable Cloudflare hostname, without /mcp',
      optionValue(defaults, profile, 'hostname', ['LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME', 'LOCALWORKSPACEBRIDGE_HOSTNAME'], '')
    );
    if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example local-workspace-bridge.yourdomain.com.');
    hostname = normalizePublicHostname(hostname);
    tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['LOCALWORKSPACEBRIDGE_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'local-workspace-bridge'));
    cloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['LOCALWORKSPACEBRIDGE_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
    cloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
  } else if (tunnel === 'tailscale') {
    hostname = await ask(
      rl,
      'Tailscale Funnel hostname, without /mcp',
      optionValue(defaults, profile, 'hostname', ['LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME', 'LOCALWORKSPACEBRIDGE_HOSTNAME', 'TAILSCALE_FUNNEL_HOSTNAME'], '')
    );
    if (!hostname) throw new Error('Tailscale setup needs your Funnel hostname, for example machine.tailnet.ts.net.');
    hostname = normalizePublicHostname(hostname);
  }

  return {
    tunnel,
    hostname,
    tunnelName,
    ngrokConfig,
    cloudflareConfig,
    cloudflareTokenFile
  };
}

function applyTunnelPreferenceToArgs(args, preference) {
  args.tunnel = preference.tunnel;
  if (preference.hostname) args.hostname = preference.hostname;
  if (preference.tunnelName) args.tunnelName = preference.tunnelName;
  if (preference.ngrokConfig) args.ngrokConfig = preference.ngrokConfig;
  if (preference.cloudflareConfig) args.cloudflareConfig = preference.cloudflareConfig;
  if (preference.cloudflareTokenFile) args.cloudflareTokenFile = preference.cloudflareTokenFile;
}

function profileFromPreference(root, args, profile, preference) {
  const mode = optionValue(args, profile, 'mode', ['LOCALWORKSPACEBRIDGE_MODE'], 'agent');
  const port = String(optionValue(args, profile, 'port', ['LOCALWORKSPACEBRIDGE_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['LOCALWORKSPACEBRIDGE_BASH_MODE'], '');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['LOCALWORKSPACEBRIDGE_CODEX_DIR'], '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = optionalWriteOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', ['LOCALWORKSPACEBRIDGE_TOOL_MODE'], '');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN'], '');
  const lowMemory = optionBool(args, profile, 'lowMemory', ['LOCALWORKSPACEBRIDGE_LOW_MEMORY'], false);
  const existingToken = optionValue(args, profile, 'token', ['LOCALWORKSPACEBRIDGE_HTTP_TOKEN'], '');
  const token = preference.tunnel === 'none' ? existingToken : stableToken(existingToken);
  return {
    port,
    mode,
    tunnel: preference.tunnel,
    ...(preference.hostname ? { hostname: preference.hostname } : {}),
    ...(preference.tunnelName ? { tunnelName: preference.tunnelName } : {}),
    ...(preference.ngrokConfig ? { ngrokConfig: preference.ngrokConfig } : {}),
    ...(preference.cloudflareConfig ? { cloudflareConfig: preference.cloudflareConfig } : {}),
    ...(preference.cloudflareTokenFile ? { cloudflareTokenFile: preference.cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(bash ? { bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(write ? { write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...(lowMemory ? { lowMemory: true } : {}),
    ...toolCardsProfileEntry(args, profile),
    ...(args.noInstallCloudflared ? { noInstallCloudflared: true } : {}),
    root
  };
}

async function maybeConfigureFirstRun(root, args, profile) {
  if (profile.profilePath || !process.stdin.isTTY || !process.stdout.isTTY || process.env.CI || hasExplicitTunnelInput(args)) {
    return profile;
  }

  const reusableProfiles = listWorkspaceProfiles().filter((item) => item.root !== root);
  if (reusableProfiles.length) {
    const shown = reusableProfiles.slice(0, 9);
    printBox('Saved setups', [
      'No saved settings exist for this workspace, but LocalWorkspaceBridge found saved setups from other workspaces.',
      ...shown.map((item, index) => profileOneLine(item, index + 1)),
      'Use a number to reuse one here, or type new to choose a fresh tunnel.'
    ]);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await ask(rl, 'Use saved setup number, or new?', shown.length === 1 ? '1' : 'new');
      const normalized = answer.trim().toLowerCase();
      const selectedIndex = Number(normalized);
      if (Number.isInteger(selectedIndex) && selectedIndex >= 1 && selectedIndex <= shown.length) {
        const selected = shown[selectedIndex - 1];
        const payload = reusableProfilePayload(selected, {
          port: String(optionValue(args, selected, 'port', ['LOCALWORKSPACEBRIDGE_PORT'], selected.port ?? '8787')),
          mode: optionValue(args, selected, 'mode', ['LOCALWORKSPACEBRIDGE_MODE'], selected.mode ?? 'agent')
        });
        const savedPath = saveWorkspaceProfile(root, payload);
        statusLine('ok', `Saved workspace settings from ${selected.root}: ${savedPath}`);
        return loadWorkspaceProfile(root);
      }
    } finally {
      rl.close();
    }
  }

  printBox('First run setup', [
    'No saved tunnel preference exists for this workspace.',
    'Choose once now. LocalWorkspaceBridge will reuse this choice on future local-workspace-bridge start runs until you change or delete it with local-workspace-bridge settings.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const preference = await collectTunnelPreference(rl, args, profile, { defaultTunnel: 'cloudflare' });
    applyTunnelPreferenceToArgs(args, preference);
    const saveAnswer = await ask(rl, 'Save this as the default for this workspace?', 'yes');
    if (!['n', 'no'].includes(saveAnswer.trim().toLowerCase())) {
      const savedPath = saveWorkspaceProfile(root, profileFromPreference(root, args, profile, preference));
      statusLine('ok', `Saved workspace settings: ${savedPath}`);
      return loadWorkspaceProfile(root);
    }
    return profileFromPreference(root, args, profile, preference);
  } finally {
    rl.close();
  }
}

function commandPreview(args) {
  return shellCommandPreview(['local-workspace-bridge', ...args]);
}

async function runSetupWizard(argv) {
  if (!process.stdin.isTTY) {
    throw new Error('local-workspace-bridge setup needs an interactive terminal. Use local-workspace-bridge start --root /path/to/repo for non-interactive scripts.');
  }
  const defaults = parseArgs(argv);
  const defaultRoot = path.resolve(expandHome(defaults.root ?? process.env.LOCALWORKSPACEBRIDGE_ROOT ?? process.cwd()));

  printBox('LocalWorkspaceBridge setup', [
    'This wizard prepares a ChatGPT connector for the folder you choose.',
    'Press Enter to accept defaults. Stable tunnel choices are saved per workspace under ~/.local-workspace-bridge.'
  ]);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const rootInput = await ask(rl, 'Where is your project located?', defaultRoot);
    const root = realDir(rootInput);
    const profile = defaults.noProfile ? {} : loadWorkspaceProfile(root);
    if (profile.profilePath) {
      statusLine('ok', `Loaded saved profile: ${profile.profilePath}`);
      printSavedProfileHint(profile);
    }

    const savedTunnel = optionValue(defaults, profile, 'tunnel', ['LOCALWORKSPACEBRIDGE_TUNNEL'], 'cloudflare');
  const defaultTunnel = savedTunnel === 'cloudflare-named'
      ? 'stable'
      : savedTunnel === 'ngrok'
        ? 'ngrok'
        : savedTunnel === 'tailscale'
          ? 'tailscale'
          : savedTunnel === 'none'
            ? 'local'
            : 'quick';
    const defaultPort = String(optionValue(defaults, profile, 'port', ['LOCALWORKSPACEBRIDGE_PORT'], '8787'));
    const mode = 'agent';

    const port = normalizePort(await ask(rl, 'Which local port should LocalWorkspaceBridge use?', defaultPort));

    printBox('Public URL', [
      'ChatGPT needs an HTTPS URL it can reach.',
      'quick  = LocalWorkspaceBridge creates a Cloudflare quick tunnel for demos and local work.',
      'stable = use your own domain with a Cloudflare named tunnel so the ChatGPT app URL does not change.',
      'ngrok  = use your ngrok free dev domain, for example https://name.ngrok-free.dev.',
      'tailscale = use Tailscale Funnel, for example https://device.tailnet.ts.net.',
      'local  = no tunnel, only useful for local MCP clients that can reach 127.0.0.1.'
    ]);

    const tunnelAnswer = await ask(rl, 'Public access: quick, stable, ngrok, tailscale, or local?', defaultTunnel);
    const tunnelChoice = normalizeSetupChoice(tunnelAnswer, ['quick', 'stable', 'ngrok', 'tailscale', 'local'], defaultTunnel);
    const args = ['start', '--root', root, '--port', port, '--mode', mode];
    const bash = optionValue(defaults, profile, 'bash', ['LOCALWORKSPACEBRIDGE_BASH_MODE'], '');
    const bashTranscript = bashTranscriptOption(defaults, profile);
    const codexSessions = codexSessionsOption(defaults, profile);
    const codexDir = optionValue(defaults, profile, 'codexDir', ['LOCALWORKSPACEBRIDGE_CODEX_DIR'], '');
    const write = optionalWriteOption(defaults, profile, mode);
    const toolMode = optionalChoice('tool-mode', optionValue(defaults, profile, 'toolMode', ['LOCALWORKSPACEBRIDGE_TOOL_MODE'], ''), ['minimal', 'standard', 'full']);
    const widgetDomain = optionValue(defaults, profile, 'widgetDomain', ['LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN'], '');
    const toolCardsEntry = toolCardsProfileEntry(defaults, profile);
    const lowMemory = optionBool(defaults, profile, 'lowMemory', ['LOCALWORKSPACEBRIDGE_LOW_MEMORY'], false);
    if (bash) args.push('--bash', bash);
    if (bashTranscript !== 'compact') args.push('--bash-transcript', bashTranscript);
    if (codexSessions !== 'off') args.push('--codex-sessions', codexSessions);
    if (codexDir) args.push('--codex-dir', codexDir);
    const { bashSession, requireBashSession } = bashSessionOptions(defaults, profile);
    if (bashSession) args.push('--bash-session', bashSession);
    if (requireBashSession) args.push('--require-bash-session');
    if (write) args.push('--write', write);
    if (toolMode) args.push('--tool-mode', toolMode);
    if (widgetDomain) args.push('--widget-domain', widgetDomain);
    if (lowMemory) args.push('--low-memory');
    args.push(...toolCardsCliArgs(defaults, profile));
    if (defaults.noInstallCloudflared) args.push('--no-install-cloudflared');
    if (defaults.openChatgpt) args.push('--open-chatgpt');
    if (defaults.noCopyUrl) args.push('--no-copy-url');

    let profileTunnel = 'cloudflare';
    let profileHostname = '';
    let profileTunnelName = '';
    let profileNgrokConfig = '';
    let profileCloudflareConfig = '';
    let profileCloudflareTokenFile = '';
    let profileToken = optionValue(defaults, profile, 'token', ['LOCALWORKSPACEBRIDGE_HTTP_TOKEN'], '');

    if (tunnelChoice === 'local') {
      profileTunnel = 'none';
      args.push('--tunnel', 'none');
    } else if (tunnelChoice === 'stable') {
      profileTunnel = 'cloudflare-named';
      let hostname = await ask(
        rl,
        'Stable Cloudflare hostname, without /mcp',
        optionValue(defaults, profile, 'hostname', ['LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME', 'LOCALWORKSPACEBRIDGE_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Stable public URL setup needs a real hostname, for example local-workspace-bridge.yourdomain.com.');
      hostname = normalizePublicHostname(hostname);
      profileHostname = hostname;
      const tunnelName = await ask(rl, 'Cloudflare tunnel name', optionValue(defaults, profile, 'tunnelName', ['LOCALWORKSPACEBRIDGE_TUNNEL_NAME', 'CLOUDFLARE_TUNNEL_NAME'], 'local-workspace-bridge'));
      profileTunnelName = tunnelName;
      args.push('--tunnel', 'cloudflare-named', '--hostname', hostname, '--tunnel-name', tunnelName);
      profileCloudflareConfig = optionValue(defaults, profile, 'cloudflareConfig', ['LOCALWORKSPACEBRIDGE_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], '');
      profileCloudflareTokenFile = optionValue(defaults, profile, 'cloudflareTokenFile', ['LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], '');
      if (profileCloudflareConfig) args.push('--cloudflare-config', profileCloudflareConfig);
      if (profileCloudflareTokenFile) args.push('--cloudflare-token-file', profileCloudflareTokenFile);
    } else if (tunnelChoice === 'ngrok') {
      profileTunnel = 'ngrok';
      let hostname = await ask(
        rl,
        'Ngrok domain or URL, without /mcp',
        optionValue(defaults, profile, 'hostname', ['LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME', 'LOCALWORKSPACEBRIDGE_HOSTNAME', 'NGROK_DOMAIN'], '')
      );
      if (!hostname) throw new Error('Ngrok setup needs your reserved domain, for example name.ngrok-free.dev.');
      hostname = normalizePublicHostname(hostname);
      profileHostname = hostname;
      args.push('--tunnel', 'ngrok', '--hostname', hostname);
      const ngrokConfig = optionValue(defaults, profile, 'ngrokConfig', ['NGROK_CONFIG', 'LOCALWORKSPACEBRIDGE_NGROK_CONFIG'], '');
      if (ngrokConfig) {
        profileNgrokConfig = ngrokConfig;
        args.push('--ngrok-config', ngrokConfig);
      }
    } else if (tunnelChoice === 'tailscale') {
      profileTunnel = 'tailscale';
      let hostname = await ask(
        rl,
        'Tailscale Funnel hostname, without /mcp',
        optionValue(defaults, profile, 'hostname', ['LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME', 'LOCALWORKSPACEBRIDGE_HOSTNAME', 'TAILSCALE_FUNNEL_HOSTNAME'], '')
      );
      if (!hostname) throw new Error('Tailscale setup needs your Funnel hostname, for example machine.tailnet.ts.net.');
      hostname = normalizePublicHostname(hostname);
      profileHostname = hostname;
      args.push('--tunnel', 'tailscale', '--hostname', hostname);
    } else {
      profileTunnel = 'cloudflare';
      args.push('--tunnel', 'cloudflare');
    }

    if (profileTunnel !== 'none') {
      profileToken = await ask(rl, 'LocalWorkspaceBridge auth token for this workspace', stableToken(profileToken));
      if (profileToken) args.push('--token', profileToken);
    }

    const saveDefault = defaults.noSaveConfig ? 'no' : 'yes';
    const saveAnswer = await ask(rl, 'Save this setup for future runs from this workspace?', saveDefault);
    const shouldSave = !['n', 'no'].includes(saveAnswer.trim().toLowerCase());
    if (shouldSave) {
      const savedPath = saveWorkspaceProfile(root, {
        port,
        mode,
        tunnel: profileTunnel,
        ...(profileHostname ? { hostname: profileHostname } : {}),
        ...(profileTunnelName ? { tunnelName: profileTunnelName } : {}),
        ...(profileNgrokConfig ? { ngrokConfig: profileNgrokConfig } : {}),
        ...(profileCloudflareConfig ? { cloudflareConfig: profileCloudflareConfig } : {}),
        ...(profileCloudflareTokenFile ? { cloudflareTokenFile: profileCloudflareTokenFile } : {}),
        ...(profileToken ? { token: profileToken } : {}),
        ...(bash ? { bash } : {}),
        ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
        ...(codexSessions !== 'off' ? { codexSessions } : {}),
        ...(codexDir ? { codexDir } : {}),
        ...(bashSession ? { bashSession } : {}),
        ...(requireBashSession ? { requireBashSession: true } : {}),
        ...(write ? { write } : {}),
        ...(toolMode ? { toolMode } : {}),
        ...(widgetDomain ? { widgetDomain } : {}),
        ...(lowMemory ? { lowMemory: true } : {}),
        ...toolCardsEntry,
        ...(defaults.noInstallCloudflared ? { noInstallCloudflared: true } : {})
      });
      statusLine('ok', `Saved workspace profile: ${savedPath}`);
    }

    const startAnswer = await ask(rl, 'Start LocalWorkspaceBridge now?', 'yes');
    const shouldStart = !['n', 'no'].includes(startAnswer.trim().toLowerCase());
    console.log('');
    console.log(paint('bold', 'Command'));
    console.log(`  ${commandPreview(args)}`);
    console.log('');
    if (!shouldStart) {
      console.log('Setup complete. Run the command above when you are ready.');
      return null;
    }
    return args;
  } finally {
    rl.close();
  }
}

function printProfile(root, profile) {
  if (!profile.profilePath) {
    printBox('LocalWorkspaceBridge settings', [
      labelValue('Workspace', root),
      'No saved settings for this workspace.',
      'Run local-workspace-bridge settings set or local-workspace-bridge setup to save a tunnel preference.'
    ]);
    return;
  }
  const safe = sanitizedProfile(profile);
  printBox('LocalWorkspaceBridge settings', [
    labelValue('Workspace', root),
    labelValue('Profile', profile.profilePath),
    labelValue('Tunnel', safe.tunnel ?? 'cloudflare'),
    ...(safe.hostname ? [labelValue('Hostname', safe.hostname)] : []),
    ...(safe.tunnelName ? [labelValue('Tunnel name', safe.tunnelName)] : []),
    ...(safe.ngrokConfig ? [labelValue('Ngrok config', safe.ngrokConfig)] : []),
    ...(safe.cloudflareConfig ? [labelValue('Cloudflare cfg', safe.cloudflareConfig)] : []),
    ...(safe.cloudflareTokenFile ? [labelValue('CF token file', safe.cloudflareTokenFile)] : []),
    ...(safe.port ? [labelValue('Port', safe.port)] : []),
    ...(safe.mode ? [labelValue('Mode', safe.mode)] : []),
    ...(safe.bash ? [labelValue('Bash', safe.bash)] : []),
    ...(safe.write ? [labelValue('Write', safe.write)] : []),
    ...(safe.toolMode ? [labelValue('Tool mode', safe.toolMode)] : []),
    ...(safe.lowMemory ? [labelValue('Memory', 'low-memory')] : []),
    ...(safe.toolCards !== undefined ? [labelValue('Tool cards', safe.toolCards ? 'on' : 'off')] : []),
    labelValue('Bash transcript', safe.bashTranscript ?? 'compact'),
    labelValue('Codex sessions', safe.codexSessions ?? 'off'),
    ...(safe.codexDir ? [labelValue('Codex dir', safe.codexDir)] : []),
    ...(safe.bashSession ? [labelValue('Bash session', `${safe.bashSession}${safe.requireBashSession ? ' required' : ''}`)] : []),
    ...(safe.widgetDomain ? [labelValue('Widget origin', safe.widgetDomain)] : []),
    ...(safe.noInstallCloudflared ? [labelValue('cloudflared', 'manual install only')] : []),
    ...(safe.token ? [labelValue('Token', safe.token)] : []),
    ...(safe.cloudflareToken ? [labelValue('Cloudflare token', safe.cloudflareToken)] : [])
  ]);
}

function printProfileList(profiles = listWorkspaceProfiles()) {
  if (!profiles.length) {
    printBox('LocalWorkspaceBridge saved setups', [
      'No saved workspace settings found.',
      'Run local-workspace-bridge setup or local-workspace-bridge settings set to create one.'
    ]);
    return;
  }
  printBox('LocalWorkspaceBridge saved setups', profiles.slice(0, 50).map((profile, index) => profileOneLine(profile, index + 1)));
}

function saveSettingsFromArgs(root, args, profile) {
  if (args.cloudflareToken !== undefined) {
    throw new Error('local-workspace-bridge settings set does not save raw --cloudflare-token. Save it to a local file and use --cloudflare-token-file <path>; start still accepts --cloudflare-token for a single launch.');
  }
  const tunnel = optionValue(args, profile, 'tunnel', ['LOCALWORKSPACEBRIDGE_TUNNEL'], profile.tunnel ?? 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'tailscale'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, ngrok, or tailscale');
  }
  const needsHostname = tunnel === 'ngrok' || tunnel === 'cloudflare-named' || tunnel === 'tailscale';
  const rawHostname = needsHostname ? (args.hostname ?? args.url ?? profile.hostname ?? '') : '';
  const hostname = needsHostname ? normalizePublicHostname(rawHostname) : String(rawHostname ?? '').trim();
  if (needsHostname && !hostname) {
    throw new Error('--hostname is required for ngrok, cloudflare-named, and tailscale settings.');
  }
  const mode = optionValue(args, profile, 'mode', ['LOCALWORKSPACEBRIDGE_MODE'], profile.mode ?? 'agent');
  if (mode !== 'agent') {
    throw new Error('--mode only supports agent');
  }
  const toolMode = optionalChoice('tool-mode', optionValue(args, profile, 'toolMode', ['LOCALWORKSPACEBRIDGE_TOOL_MODE'], profile.toolMode ?? ''), ['minimal', 'standard', 'full']);
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN'], profile.widgetDomain ?? '');
  const lowMemory = optionBool(args, profile, 'lowMemory', ['LOCALWORKSPACEBRIDGE_LOW_MEMORY'], false);
  const port = normalizePort(optionValue(args, profile, 'port', ['LOCALWORKSPACEBRIDGE_PORT'], profile.port ?? '8787'));
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = optionValue(args, profile, 'codexDir', ['LOCALWORKSPACEBRIDGE_CODEX_DIR'], profile.codexDir ?? '');
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = writeOption(args, profile, mode);
  const bash = optionalChoice('bash', optionValue(args, profile, 'bash', ['LOCALWORKSPACEBRIDGE_BASH_MODE'], profile.bash ?? ''), ['off', 'safe', 'full']);
  const tunnelName = tunnel === 'cloudflare-named' ? (args.tunnelName ?? profile.tunnelName ?? '') : '';
  const ngrokConfig = tunnel === 'ngrok'
    ? resolveConfigPath(root, optionValue(args, profile, 'ngrokConfig', ['NGROK_CONFIG', 'LOCALWORKSPACEBRIDGE_NGROK_CONFIG'], ''))
    : '';
  const cloudflareConfig = tunnel === 'cloudflare-named'
    ? resolveConfigPath(root, optionValue(args, profile, 'cloudflareConfig', ['LOCALWORKSPACEBRIDGE_CLOUDFLARE_CONFIG', 'CLOUDFLARE_TUNNEL_CONFIG'], ''))
    : '';
  const cloudflareTokenFile = tunnel === 'cloudflare-named'
    ? resolveConfigPath(root, optionValue(args, profile, 'cloudflareTokenFile', ['LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN_FILE', 'CLOUDFLARE_TUNNEL_TOKEN_FILE'], ''))
    : '';
  const token = tunnel === 'none'
    ? optionValue(args, profile, 'token', ['LOCALWORKSPACEBRIDGE_HTTP_TOKEN'], profile.token ?? '')
    : stableToken(optionValue(args, profile, 'token', ['LOCALWORKSPACEBRIDGE_HTTP_TOKEN'], profile.token ?? ''));
  const savedPath = saveWorkspaceProfile(root, {
    port,
    mode,
    tunnel,
    ...(hostname ? { hostname } : {}),
    ...(tunnelName ? { tunnelName } : {}),
    ...(ngrokConfig ? { ngrokConfig } : {}),
    ...(cloudflareConfig ? { cloudflareConfig } : {}),
    ...(cloudflareTokenFile ? { cloudflareTokenFile } : {}),
    ...(token ? { token } : {}),
    ...(bash ? { bash } : {}),
    ...(bashTranscript !== 'compact' ? { bashTranscript } : {}),
    ...(codexSessions !== 'off' ? { codexSessions } : {}),
    ...(codexDir ? { codexDir } : {}),
    ...(bashSession ? { bashSession } : {}),
    ...(requireBashSession ? { requireBashSession: true } : {}),
    ...(mode !== 'agent' || args.write !== undefined || profile.write ? { write } : {}),
    ...(toolMode ? { toolMode } : {}),
    ...(widgetDomain ? { widgetDomain } : {}),
    ...(lowMemory ? { lowMemory: true } : {}),
    ...toolCardsProfileEntry(args, profile),
    ...(args.noInstallCloudflared ?? profile.noInstallCloudflared ? { noInstallCloudflared: true } : {})
  });
  statusLine('ok', `Saved workspace settings: ${savedPath}`);
  printProfile(root, loadWorkspaceProfile(root));
}

async function chooseReusableProfile(rl, currentRoot, profiles = listWorkspaceProfiles()) {
  const reusable = profiles.filter((item) => item.root !== currentRoot);
  if (!reusable.length) return null;
  printProfileList(reusable);
  const answer = await ask(rl, 'Use saved setup number?', reusable.length === 1 ? '1' : '');
  const selectedIndex = Number(answer.trim());
  if (!Number.isInteger(selectedIndex) || selectedIndex < 1 || selectedIndex > reusable.length) {
    throw new Error('Invalid saved setup number.');
  }
  return reusable[selectedIndex - 1];
}

async function runSettings(argv) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
  const args = parseArgs(action ? argv.slice(1) : argv);
  if (args.help) {
    usage();
    return;
  }
  const root = realDir(args.root ?? process.env.LOCALWORKSPACEBRIDGE_ROOT ?? process.cwd());
  const profile = args.noProfile ? {} : loadWorkspaceProfile(root);

  if (action === 'list' || action === 'ls') {
    printProfileList();
    return;
  }

  if (action === 'show' || (!action && !process.stdin.isTTY)) {
    printProfile(root, profile);
    return;
  }

  if (action === 'delete' || action === 'reset' || action === 'remove') {
    if (!profile.profilePath) {
      statusLine('warn', 'No saved settings exist for this workspace.');
      return;
    }
    if (!args.yes && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
        if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
          statusLine('warn', 'Settings delete cancelled.');
          return;
        }
      } finally {
        rl.close();
      }
    } else if (!args.yes) {
      throw new Error('Use local-workspace-bridge settings delete --yes in non-interactive shells.');
    }
    deleteWorkspaceProfile(root);
    statusLine('ok', 'Deleted saved settings for this workspace.');
    return;
  }

  if (action === 'set') {
    saveSettingsFromArgs(root, args, profile);
    return;
  }

  if (action === 'use' || action === 'copy') {
    const fromRoot = args.fromRoot ? realDir(args.fromRoot) : '';
    let source = fromRoot ? loadWorkspaceProfile(fromRoot) : null;
    if (fromRoot && !source.profilePath) {
      throw new Error(`No saved settings found for --from-root ${fromRoot}`);
    }
    if (!source) {
      if (!process.stdin.isTTY) throw new Error('Use --from-root in non-interactive shells.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        source = await chooseReusableProfile(rl, root);
      } finally {
        rl.close();
      }
    }
    if (!source) {
      statusLine('warn', 'No reusable saved settings found.');
      return;
    }
    const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
    statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
    return;
  }

  if (action && !['change', 'edit'].includes(action)) {
    throw new Error(`Unknown settings action: ${action}`);
  }

  if (!process.stdin.isTTY) {
    printProfile(root, profile);
    return;
  }

  printProfile(root, profile);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const selected = await ask(rl, 'Action: set, use, delete, show, list, or exit?', profile.profilePath ? 'show' : 'set');
    const normalized = normalizeSetupChoice(selected, ['set', 'use', 'delete', 'show', 'list', 'exit'], profile.profilePath ? 'show' : 'set');
    if (normalized === 'exit') return;
    if (normalized === 'list') {
      printProfileList();
      return;
    }
    if (normalized === 'show') {
      printProfile(root, profile);
      return;
    }
    if (normalized === 'use') {
      const source = await chooseReusableProfile(rl, root);
      if (!source) {
        statusLine('warn', 'No reusable saved settings found.');
        return;
      }
      const savedPath = saveWorkspaceProfile(root, reusableProfilePayload(source));
      statusLine('ok', `Saved workspace settings from ${source.root}: ${savedPath}`);
      printProfile(root, loadWorkspaceProfile(root));
      return;
    }
    if (normalized === 'delete') {
      if (!profile.profilePath) {
        statusLine('warn', 'No saved settings exist for this workspace.');
        return;
      }
      const answer = await ask(rl, `Delete saved settings for ${root}?`, 'no');
      if (!['y', 'yes'].includes(answer.trim().toLowerCase())) {
        statusLine('warn', 'Settings delete cancelled.');
        return;
      }
      deleteWorkspaceProfile(root);
      statusLine('ok', 'Deleted saved settings for this workspace.');
      return;
    }

    const preference = await collectTunnelPreference(rl, args, profile);
    const payload = profileFromPreference(root, args, profile, preference);
    const savedPath = saveWorkspaceProfile(root, payload);
    statusLine('ok', `Saved workspace settings: ${savedPath}`);
    printProfile(root, loadWorkspaceProfile(root));
  } finally {
    rl.close();
  }
}

function normalizeServiceName(value, root) {
  const explicit = String(value ?? '').trim().replace(/\.service$/i, '');
  if (explicit) {
    if (!/^[A-Za-z0-9_.@-]+$/.test(explicit)) {
      throw new Error('--name may only contain letters, numbers, dot, underscore, @, or dash.');
    }
    return explicit;
  }
  const base = path.basename(root).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'workspace';
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8);
  return `local-workspace-bridge-${base}-${digest}`;
}

function systemdQuote(value) {
  return `"${String(value).replace(/%/g, '%%').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function renderLinuxUserService(root, serviceName, options = {}) {
  const launcherPath = fileURLToPath(import.meta.url);
  const inheritedPath = process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  const lowMemory = Boolean(options.lowMemory);
  return [
    '[Unit]',
    `Description=LocalWorkspaceBridge (${path.basename(root)})`,
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `Environment=${systemdQuote(`PATH=${inheritedPath}`)}`,
    ...(lowMemory ? [
      `Environment=${systemdQuote('LOCALWORKSPACEBRIDGE_LOW_MEMORY=1')}`,
      'MemoryAccounting=true',
      'MemoryHigh=650M',
      'MemoryMax=850M'
    ] : []),
    `ExecStart=${systemdQuote(process.execPath)} ${systemdQuote(launcherPath)} start --root ${systemdQuote(root)} --no-copy-url`,
    'Restart=on-failure',
    'RestartSec=5',
    'TimeoutStopSec=20',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  ].join('\n');
}

function runSystemctlUser(args) {
  const result = spawnSync('systemctl', ['--user', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw new Error(`systemctl --user ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`systemctl --user ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

async function runLinuxService(argv) {
  const action = argv[0] && !argv[0].startsWith('--') ? argv[0].toLowerCase() : 'install';
  const args = parseArgs(action === argv[0] ? argv.slice(1) : argv);
  if (args.help) {
    printBox('Linux user service', [
      'Install after local-workspace-bridge setup has saved a stable ngrok, Cloudflare named, or Tailscale profile.',
      'local-workspace-bridge service install --root /path/to/repo',
      'local-workspace-bridge service status --root /path/to/repo',
      'local-workspace-bridge service restart --root /path/to/repo',
      'local-workspace-bridge service stop --root /path/to/repo',
      'local-workspace-bridge service uninstall --root /path/to/repo',
      'Use --dry-run to print the generated unit without writing or calling systemctl.',
      'Use --name <unit-name> to override the deterministic per-workspace service name.',
      'Use --low-memory on 1 GB-class VPS hosts to add bounded analysis defaults and systemd memory protection.'
    ]);
    return;
  }
  if (process.platform !== 'linux' && !args.dryRun) {
    throw new Error('local-workspace-bridge service is for Linux systemd user services. Use --dry-run on other platforms to inspect the generated unit.');
  }

  const root = realDir(args.root ?? process.env.LOCALWORKSPACEBRIDGE_ROOT ?? process.cwd());
  const serviceName = normalizeServiceName(args.name, root);
  const unitName = `${serviceName}.service`;
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const unitPath = path.join(unitDir, unitName);

  if (action === 'install' || action === 'print') {
    const profile = args.noProfile ? {} : loadWorkspaceProfile(root);
    if (!profile.profilePath) {
      throw new Error(`No saved LocalWorkspaceBridge profile exists for ${root}. Run local-workspace-bridge setup there first, choose a stable tunnel, then retry.`);
    }
    if (!['ngrok', 'cloudflare-named', 'tailscale'].includes(profile.tunnel)) {
      throw new Error(`Linux service install needs a stable saved tunnel. Current profile uses ${profile.tunnel ?? 'cloudflare'}. Run local-workspace-bridge settings set --tunnel ngrok --hostname <name.ngrok-free.dev> first.`);
    }
    const lowMemory = optionBool(args, profile, 'lowMemory', ['LOCALWORKSPACEBRIDGE_LOW_MEMORY'], false);
    const unit = renderLinuxUserService(root, serviceName, { lowMemory });
    if (args.dryRun || action === 'print') {
      process.stdout.write(unit);
      return;
    }
    fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(unitPath, unit, { encoding: 'utf8', mode: 0o600 });
    runSystemctlUser(['daemon-reload']);
    if (!args.noStart) runSystemctlUser(['enable', '--now', unitName]);
    printBox('Linux service ready', [
      labelValue('Workspace', root),
      labelValue('Service', unitName),
      labelValue('Unit', unitPath),
      args.noStart ? 'Installed but not started. Run: systemctl --user enable --now ' + unitName : 'Enabled and started with systemd --user.',
      `Status: systemctl --user status ${unitName}`,
      `Logs: journalctl --user -u ${unitName} -f`,
      'For boot-time startup without an SSH login, enable linger once: sudo loginctl enable-linger "$USER".'
    ]);
    return;
  }

  if (!['status', 'restart', 'stop', 'start', 'uninstall', 'remove'].includes(action)) {
    throw new Error(`Unknown service action: ${action}. Use install, status, start, stop, restart, or uninstall.`);
  }

  if (action === 'status') {
    const result = spawnSync('systemctl', ['--user', 'status', unitName, '--no-pager'], { encoding: 'utf8' });
    process.stdout.write(String(result.stdout || ''));
    process.stderr.write(String(result.stderr || ''));
    if (result.status !== 0) process.exitCode = result.status ?? 1;
    return;
  }
  if (action === 'restart' || action === 'stop' || action === 'start') {
    runSystemctlUser([action, unitName]);
    statusLine('ok', `${action} ${unitName}`);
    return;
  }

  runSystemctlUser(['disable', '--now', unitName]);
  fs.rmSync(unitPath, { force: true });
  runSystemctlUser(['daemon-reload']);
  statusLine('ok', `Removed Linux user service ${unitName}`);
}

function writeControlPrompt() {
  process.stdout.write('local-workspace-bridge> ');
}

function runControlPanel(details, cleanup = cleanupChildren) {
  if (!process.stdin.isTTY) return new Promise(() => {});

  writeControlPrompt();

  process.stdin.setEncoding('utf8');
  if (typeof process.stdin.setRawMode === 'function') process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise(() => {
    process.stdin.on('data', (key) => {
      if (key === '\u0003') {
        console.log('\nStopping LocalWorkspaceBridge...');
        cleanup();
        process.exit(130);
      }
      const normalized = key.toLowerCase();
      if (key === '\r' || key === '\n') {
        const opened = openUrl(details.chatgptSettingsUrl);
        console.log(opened ? '\nOpened ChatGPT connector settings. The Server URL is already copied; paste it into Server URL.' : '\nCould not open ChatGPT automatically.');
        writeControlPrompt();
      } else if (normalized === 'c') {
        const copied = copyToClipboard(details.serverUrl);
        console.log(copied.ok ? `\nServer URL copied with ${copied.command}.` : '\nCould not copy automatically.');
        writeControlPrompt();
      } else if (normalized === 'u') {
        console.log(`\n${details.serverUrl}`);
        writeControlPrompt();
      } else if (normalized === 'o') {
        if (!details.localStatusUrl) {
          console.log('\nNo local status page URL is available for this run.');
        } else {
          const opened = openUrl(details.localStatusUrl);
          console.log(opened ? '\nOpened local LocalWorkspaceBridge setup/status page.' : `\nCould not open automatically. Open this URL:\n${details.localStatusUrl}`);
        }
        writeControlPrompt();
      } else if (normalized === 'p') {
        console.log('');
        printCreateAppFields(details);
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'm') {
        printModeHelp();
        console.log('');
        writeControlPrompt();
      } else if (normalized === 'h' || normalized === '?') {
        printControlHelp();
        writeControlPrompt();
      } else if (normalized === 'q') {
        console.log('\nStopping LocalWorkspaceBridge...');
        cleanup();
        process.exit(0);
      }
    });
  });
}

async function main() {
  let argv = process.argv.slice(2);
  let connectionTest = false;
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(packageVersion());
    return;
  }
  let subcommand = argv[0];
  if (subcommand === 'inspect' || subcommand === 'review') {
    await runAnalysisCli(subcommand, argv.slice(1));
    return;
  }
  if (subcommand === 'stable-help') {
    printStableUrlHelp();
    return;
  }
  if (subcommand === 'setup' || subcommand === 'onboard') {
    if (argv.includes('--help') || argv[1] === 'help') {
      usage();
      return;
    }
    const setupArgs = await runSetupWizard(argv.slice(1));
    if (!setupArgs) return;
    argv = setupArgs;
    subcommand = argv[0];
  }
  if (subcommand === 'settings' || subcommand === 'config') {
    await runSettings(argv.slice(1));
    return;
  }
  if (subcommand === 'service' || subcommand === 'systemd') {
    await runLinuxService(argv.slice(1));
    return;
  }
  if (subcommand === 'install-cloudflared') {
    const installArgs = parseArgs(argv.slice(1));
    if (installArgs.help) {
      usage();
      return;
    }
    const installedCloudflared = await installCloudflaredLocal();
    console.log(`cloudflared ready: ${installedCloudflared}`);
    return;
  }
  if (subcommand === 'doctor') {
    await runDoctor(argv.slice(1));
    return;
  }
  if (argv[0] === 'stable') {
    argv.shift();
    argv.unshift('--tunnel', 'cloudflare-named');
  }
  if (argv[0] === 'ngrok') {
    argv.shift();
    argv.unshift('--tunnel', 'ngrok');
  }
  if (argv[0] === 'tailscale') {
    argv.shift();
    argv.unshift('--tunnel', 'tailscale');
  }
  if (argv[0] === 'connection-test') {
    connectionTest = true;
    argv.shift();
  }
  if (argv[0] === 'start' || argv[0] === 'connect') argv.shift();
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    console.log(packageVersion());
    return;
  }
  if (argv[0] === 'help') argv[0] = '--help';
  const args = parseArgs(argv);
  if (connectionTest) {
    args.mode = 'agent';
    args.toolMode = 'standard';
    args.write = 'off';
    args.bash = 'off';
    args.toolCards = 'off';
    args.logRequests = true;
  }
  if (args.help) {
    usage();
    return;
  }

  const root = realDir(args.root ?? process.env.LOCALWORKSPACEBRIDGE_ROOT ?? process.cwd());
  let profile = args.noProfile ? {} : loadWorkspaceProfile(root);
  profile = await maybeConfigureFirstRun(root, args, profile);
  const effectiveArgs = { ...profile, ...args };
  if (profile.profilePath && !args.noProfile) {
    statusLine('ok', `Using saved profile: ${profile.profilePath}`);
    const summary = profileSummary(profile);
    if (summary) statusLine('ok', `${summary}. Future launches from this folder only need: local-workspace-bridge start`);
  }

  const tunnel = optionValue(args, profile, 'tunnel', ['LOCALWORKSPACEBRIDGE_TUNNEL'], 'cloudflare');
  if (!['none', 'cloudflare', 'cloudflare-named', 'ngrok', 'tailscale'].includes(tunnel)) {
    throw new Error('--tunnel must be none, cloudflare, cloudflare-named, ngrok, or tailscale');
  }
  const stableHostname = args.hostname
    ?? args.url
    ?? process.env.LOCALWORKSPACEBRIDGE_PUBLIC_HOSTNAME
    ?? process.env.LOCALWORKSPACEBRIDGE_HOSTNAME
    ?? process.env.NGROK_DOMAIN
    ?? profile.hostname
    ?? '';
  if (tunnel === 'cloudflare-named' && !stableHostname) {
    printStableUrlHelp();
    throw new Error('--hostname is required with stable URL mode.');
  }
  if (tunnel === 'ngrok' && !stableHostname) {
    throw new Error('--hostname is required with ngrok tunnel mode. Example: local-workspace-bridge ngrok --hostname your-domain.ngrok-free.dev');
  }
  if (tunnel === 'tailscale' && !stableHostname) {
    throw new Error('--hostname is required with Tailscale Funnel mode. Example: local-workspace-bridge tailscale --hostname your-device.your-tailnet.ts.net');
  }
  const mode = optionValue(args, profile, 'mode', ['LOCALWORKSPACEBRIDGE_MODE'], 'agent');
  if (mode !== 'agent') {
    throw new Error('--mode only supports agent');
  }

  const allowRoots = [root, ...(args.allowRoots ?? [])].map(realDir);
  const host = optionValue(args, profile, 'host', ['LOCALWORKSPACEBRIDGE_HOST'], '127.0.0.1');
  if (args.noAuth && (tunnel !== 'none' || !isLoopbackHost(host))) {
    throw new Error('--no-auth is only allowed with --tunnel none on a loopback host.');
  }
  const port = String(optionValue(args, profile, 'port', ['LOCALWORKSPACEBRIDGE_PORT'], '8787'));
  const bash = optionValue(args, profile, 'bash', ['LOCALWORKSPACEBRIDGE_BASH_MODE'], 'safe');
  const bashTranscript = bashTranscriptOption(args, profile);
  const codexSessions = codexSessionsOption(args, profile);
  const codexDir = resolveCodexDir(root, optionValue(args, profile, 'codexDir', ['LOCALWORKSPACEBRIDGE_CODEX_DIR'], ''));
  const { bashSession, requireBashSession } = bashSessionOptions(args, profile);
  const write = writeOption(args, profile, mode);
  const toolMode = optionValue(args, profile, 'toolMode', ['LOCALWORKSPACEBRIDGE_TOOL_MODE'], 'standard');
  const widgetDomain = optionValue(args, profile, 'widgetDomain', ['LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN'], 'https://example.invalid');
  const toolCards = optionBool(args, profile, 'toolCards', ['LOCALWORKSPACEBRIDGE_TOOL_CARDS'], false);
  const lowMemory = optionBool(args, profile, 'lowMemory', ['LOCALWORKSPACEBRIDGE_LOW_MEMORY'], false);
  validateChoice('bash', bash, ['off', 'safe', 'full']);
  validateChoice('write', write, ['off', 'workspace']);
  validateChoice('tool-mode', toolMode, ['minimal', 'standard', 'full']);

  let token = args.noAuth ? '' : optionValue(args, profile, 'token', ['LOCALWORKSPACEBRIDGE_HTTP_TOKEN'], '');
  if (!token && !args.noAuth) token = stableToken();

  const serverEnv = {
    ...process.env,
    LOCALWORKSPACEBRIDGE_ROOT: root,
    LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS: allowRoots.join(path.delimiter),
    LOCALWORKSPACEBRIDGE_HOST: host,
    LOCALWORKSPACEBRIDGE_PORT: port,
    LOCALWORKSPACEBRIDGE_BASH_MODE: bash,
    LOCALWORKSPACEBRIDGE_BASH_TRANSCRIPT: bashTranscript,
    LOCALWORKSPACEBRIDGE_BASH_SESSION_ID: bashSession,
    LOCALWORKSPACEBRIDGE_REQUIRE_BASH_SESSION: requireBashSession ? '1' : '0',
    LOCALWORKSPACEBRIDGE_CODEX_SESSIONS: codexSessions,
    LOCALWORKSPACEBRIDGE_WRITE_MODE: write,
    LOCALWORKSPACEBRIDGE_TOOL_MODE: toolMode,
    LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN: widgetDomain,
    LOCALWORKSPACEBRIDGE_TOOL_CARDS: toolCards ? '1' : '0',
    LOCALWORKSPACEBRIDGE_CONNECTION_TEST: connectionTest ? '1' : '0',
    LOCALWORKSPACEBRIDGE_LOW_MEMORY: lowMemory ? '1' : '0',
    LOCALWORKSPACEBRIDGE_MODE: mode,
    LOCALWORKSPACEBRIDGE_TUNNEL_MODE: tunnel === 'none' ? '0' : '1',
    LOCALWORKSPACEBRIDGE_ALLOW_NO_HTTP_TOKEN: args.noAuth ? '1' : '0'
  };
  if (stableHostname && tunnel !== 'cloudflare') serverEnv.LOCALWORKSPACEBRIDGE_PUBLIC_URL = publicBaseFromHostname(stableHostname);
  if (codexDir) serverEnv.LOCALWORKSPACEBRIDGE_CODEX_DIR = codexDir;
  if (args.logRequests || process.env.LOCALWORKSPACEBRIDGE_LOG_REQUESTS === '1') serverEnv.LOCALWORKSPACEBRIDGE_LOG_REQUESTS = '1';
  if (args.allowHome) serverEnv.LOCALWORKSPACEBRIDGE_ALLOW_HOME = '1';
  if (token) serverEnv.LOCALWORKSPACEBRIDGE_HTTP_TOKEN = token;
  else delete serverEnv.LOCALWORKSPACEBRIDGE_HTTP_TOKEN;
  if (lowMemory && !/(?:^|\s)--max-old-space-size(?:=|\s)/.test(serverEnv.NODE_OPTIONS ?? '')) {
    serverEnv.NODE_OPTIONS = `${serverEnv.NODE_OPTIONS ?? ''} --max-old-space-size=320`.trim();
  }

  if (args.printEnv) {
    console.log(JSON.stringify(redactEnvObject(serverEnv), null, 2));
  }

  const httpPath = path.join(projectRoot, 'dist', 'http.js');
  if (!fs.existsSync(httpPath)) {
    throw new Error(`Missing ${httpPath}. Run npm install && npm run build first.`);
  }

  await assertPortAvailable(host, port);

  printBox('LocalWorkspaceBridge start', [
    labelValue('Workspace', root),
    labelValue('Mode', `${mode}  tools=${toolMode}  write=${write}  bash=${bash}`),
    ...(lowMemory ? [labelValue('Memory profile', 'low-memory (1 GB-class VPS)')] : []),
    labelValue('Bash transcript', bashTranscript),
    labelValue('Codex sessions', codexSessions),
    ...(bashSession ? [labelValue('Bash session', `${bashSession}${requireBashSession ? ' required' : ''}`)] : []),
    ...(bash === 'full' ? [labelValue('SECURITY', `HIGH RISK: full shell can access the OS and network${requireBashSession ? '' : '; no Bash Session Guard'}`)] : []),
    labelValue('Local URL', `http://${host}:${port}/mcp`),
    labelValue(
      'Tunnel',
      tunnel === 'cloudflare'
        ? 'Cloudflare quick tunnel'
        : tunnel === 'cloudflare-named'
          ? `Cloudflare named tunnel for ${stableHostname}`
          : tunnel === 'ngrok'
            ? `ngrok endpoint for ${stableHostname}`
            : tunnel === 'tailscale'
              ? `Tailscale Funnel endpoint for ${stableHostname}`
              : 'none'
    )
  ]);

  const verboseLogs = Boolean(args.logRequests || process.env.LOCALWORKSPACEBRIDGE_LOG_REQUESTS === '1');
  statusLine('wait', 'Starting local MCP server');
  const server = spawnLogged('local-workspace-bridge', process.execPath, [httpPath], { cwd: projectRoot, env: serverEnv, verbose: verboseLogs });
  let cloudflared;
  let cleanupTunnelCredentials = () => {};
  const cleanup = () => {
    cleanupTunnelCredentials();
    cleanupChildren();
    clearRuntimeConnection(root);
  };
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const localBase = `http://${host}:${port}`;
  await waitForHealth(`${localBase}/healthz`, token);
  statusLine('ok', `Local MCP ready at ${localBase}/mcp`);
  const runtimeOptions = {
    localBase,
    tunnel,
    mode,
    toolMode,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    toolCards,
    connectionTest
  };

  if (tunnel === 'none') {
    if (effectiveArgs.installCloudflared) {
      const installedCloudflared = await resolveCloudflared(effectiveArgs);
      if (installedCloudflared) console.log(`cloudflared ready: ${installedCloudflared}`);
    }
    const details = printConnectorBlock(`${localBase}/mcp`, token, {
      localBase,
      copyUrl: args.copyUrl ? true : args.noCopyUrl ? false : undefined,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details, cleanup);
    return;
  }

  if (tunnel === 'ngrok') {
    const ngrokPath = resolveNgrok(effectiveArgs);
    const publicBase = publicBaseFromHostname(stableHostname);
    const ngrokArgs = ['http', localBase, '--url', publicBase];
    const configPath = ngrokConfigPath(root, args, profile);
    if (configPath) ngrokArgs.push('--config', configPath);
    statusLine('wait', `Opening ngrok endpoint for ${publicBase}`);
    cloudflared = spawnLogged('ngrok', ngrokPath, ngrokArgs, { cwd: root, env: directNgrokEnvironment(process.env), verbose: verboseLogs });
    try {
      await waitForPublicHealth(publicBase, token, cloudflared, 'ngrok');
    } catch (error) {
      const tail = typeof cloudflared.localWorkspaceBridgeLogTail === 'function' ? cloudflared.localWorkspaceBridgeLogTail() : '';
      const hint = [
        '',
        'Ngrok stable domains need one-time setup before this can succeed:',
        '',
        '  ngrok config add-authtoken <your-ngrok-token>',
        '  find your free ngrok dev domain in the ngrok dashboard',
        '  local-workspace-bridge ngrok --hostname your-domain.ngrok-free.dev --token [REDACTED_SECRET]',
        '',
        'If the domain is already in use, stop the other ngrok process or choose another reserved domain.'
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent ngrok output:\n${tail}` : ''}${hint}`);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      oauth: true,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details, cleanup);
    return;
  }

  if (tunnel === 'tailscale') {
    const tailscalePath = resolveTailscale(effectiveArgs);
    const publicBase = publicBaseFromHostname(stableHostname);
    const httpsPort = tailscaleFunnelHttpsPort(publicBase);
    const tailscaleArgs = ['funnel'];
    if (httpsPort !== '443') tailscaleArgs.push(`--https=${httpsPort}`);
    tailscaleArgs.push(localBase);
    statusLine('wait', `Opening Tailscale Funnel for ${publicBase}`);
    cloudflared = spawnLogged('tailscale', tailscalePath, tailscaleArgs, { cwd: root, env: process.env, verbose: verboseLogs });
    try {
      await waitForPublicHealth(publicBase, token, cloudflared, 'Tailscale Funnel');
    } catch (error) {
      const tail = typeof cloudflared.localWorkspaceBridgeLogTail === 'function' ? cloudflared.localWorkspaceBridgeLogTail() : '';
      const hint = [
        '',
        'Tailscale Funnel needs one-time setup before this can succeed:',
        '',
        '  install and log in to Tailscale',
        '  enable MagicDNS, HTTPS certificates, and Funnel for this tailnet',
        '  local-workspace-bridge tailscale --hostname your-device.your-tailnet.ts.net --token [REDACTED_SECRET]',
        '',
        'Funnel exposes this connector publicly. Keep the LocalWorkspaceBridge token enabled.'
      ].join('\n');
      throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent tailscale output:\n${tail}` : ''}${hint}`);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      oauth: true,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details, cleanup);
    return;
  }

  const cloudflaredPath = await resolveCloudflared(effectiveArgs);
  if (!cloudflaredPath) {
    console.error('\ncloudflared was not found. The local MCP server is still running.');
    console.error('Install Cloudflare Tunnel, rerun without --no-install-cloudflared, or run with --tunnel none for local clients.');
    console.error('Downloads: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/');
    const details = printConnectorBlock(`${localBase}/mcp`, token, {
      localBase,
      copyUrl: args.copyUrl ? true : false,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details, cleanup);
    return;
  }

  if (tunnel === 'cloudflare') {
    statusLine('wait', 'Opening Cloudflare quick tunnel');
    const proxyUrl = outboundProxyFromEnv(process.env);
    let publicBase = '';
    if (proxyUrl) {
      const quickTunnel = requestQuickTunnelViaCurl(proxyUrl);
      const { tmpRoot, credentialsPath } = writeQuickTunnelCredentials(quickTunnel);
      const removeCredentials = () => fs.rmSync(tmpRoot, { recursive: true, force: true });
      cleanupTunnelCredentials = removeCredentials;
      try {
        cloudflared = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase, '--credentials-file', credentialsPath, 'run', quickTunnel.id], { cwd: root, env: process.env, verbose: verboseLogs });
      } catch (error) {
        removeCredentials();
        throw error;
      }
      cloudflared.once('exit', removeCredentials);
      cloudflared.once('error', removeCredentials);
      await waitForTunnelStartup(cloudflared, 'cloudflared');
      publicBase = `https://${quickTunnel.hostname}`;
    } else {
      cloudflared = spawnLogged('cloudflared', cloudflaredPath, ['tunnel', '--url', localBase], { cwd: root, env: process.env, verbose: verboseLogs });
      publicBase = await waitForCloudflareUrl(cloudflared);
    }
    const details = printConnectorBlock(`${publicBase}/mcp`, token, {
      localBase,
      copyUrl: args.noCopyUrl ? false : true,
      openChatgpt: Boolean(args.openChatgpt),
      mode,
      toolMode,
      root,
      write,
      bash,
      bashTranscript,
      codexSessions,
      bashSession,
      requireBashSession,
      connectionTest
    });
    saveRuntimeConnection(root, details, runtimeOptions);
    await runControlPanel(details, cleanup);
    return;
  }

  const publicBase = publicBaseFromHostname(stableHostname);
  const tunnelName = optionValue(args, profile, 'tunnelName', ['CLOUDFLARE_TUNNEL_NAME', 'LOCALWORKSPACEBRIDGE_TUNNEL_NAME'], '');
  const cloudflareConfig = resolveConfigPath(root, optionValue(args, profile, 'cloudflareConfig', ['CLOUDFLARE_TUNNEL_CONFIG', 'LOCALWORKSPACEBRIDGE_CLOUDFLARE_CONFIG'], ''));
  const cloudflareTokenFile = resolveConfigPath(root, optionValue(args, profile, 'cloudflareTokenFile', ['CLOUDFLARE_TUNNEL_TOKEN_FILE', 'LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN_FILE'], ''));
  const cloudflareToken = optionValue(args, profile, 'cloudflareToken', ['CLOUDFLARE_TUNNEL_TOKEN', 'LOCALWORKSPACEBRIDGE_CLOUDFLARE_TUNNEL_TOKEN'], '');

  const cloudflaredArgs = ['tunnel'];
  if (cloudflareConfig) {
    cloudflaredArgs.push('--config', cloudflareConfig, 'run');
    if (tunnelName) cloudflaredArgs.push(tunnelName);
  } else {
    cloudflaredArgs.push('run', '--url', localBase);
    if (cloudflareTokenFile) {
      cloudflaredArgs.push('--token-file', cloudflareTokenFile);
    } else if (cloudflareToken) {
      // Passed to cloudflared through the child environment below.
    } else {
      if (!tunnelName) {
        throw new Error('--tunnel-name, --cloudflare-token, --cloudflare-token-file, or --cloudflare-config is required with --tunnel cloudflare-named.');
      }
      cloudflaredArgs.push(tunnelName);
    }
  }

  statusLine('wait', `Starting Cloudflare named tunnel for ${publicBase}`);
  const cloudflaredEnv = cloudflareToken && !cloudflareTokenFile
    ? { ...process.env, TUNNEL_TOKEN: cloudflareToken }
    : process.env;
  cloudflared = spawnLogged('cloudflared', cloudflaredPath, cloudflaredArgs, { cwd: root, env: cloudflaredEnv, verbose: verboseLogs });
  try {
    await waitForPublicHealth(publicBase, token, cloudflared);
  } catch (error) {
    const tail = typeof cloudflared.localWorkspaceBridgeLogTail === 'function' ? cloudflared.localWorkspaceBridgeLogTail() : '';
    const hint = [
      '',
      'Named Cloudflare tunnels need one-time setup before this can succeed:',
      '',
      '  cloudflared tunnel login',
      '  cloudflared tunnel create <tunnel-name>',
      '  cloudflared tunnel route dns <tunnel-name> <hostname>',
      '',
      'Or create a remotely managed tunnel in the Cloudflare dashboard and pass:',
      '',
      '  --cloudflare-token-file ~/.local-workspace-bridge/cloudflare-tunnel-token',
      '',
      'Quick tunnels do not support a permanent hostname. Use --tunnel cloudflare only for demos.'
    ].join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}${tail ? `\n\nRecent cloudflared output:\n${tail}` : ''}${hint}`);
  }
  const details = printConnectorBlock(`${publicBase}/mcp`, token, {
    localBase,
    oauth: true,
    copyUrl: args.noCopyUrl ? false : true,
    openChatgpt: Boolean(args.openChatgpt),
    mode,
    toolMode,
    root,
    write,
    bash,
    bashTranscript,
    codexSessions,
    bashSession,
    requireBashSession,
    connectionTest
  });
  saveRuntimeConnection(root, details, runtimeOptions);
  await runControlPanel(details, cleanup);
}

main().catch((error) => {
  cleanupChildren();
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Error: ${message}`);
  if (process.env.LOCALWORKSPACEBRIDGE_DEBUG === '1' && error instanceof Error && error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
});
