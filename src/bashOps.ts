import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { LocalWorkspaceBridgeConfig, ShellMode } from "./config.js";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError, PathGuard } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface BashResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  bashSessionId?: string;
  shell: Exclude<ShellMode, "auto">;
}

export interface ResolvedShellCommand {
  executable: string;
  args: string[];
  shell: Exclude<ShellMode, "auto">;
}

const SAFE_ALLOWED_PREFIXES = [
  "pwd",
  "ls",
  "find",
  "git status",
  "git diff",
  "git log",
  "git show",
  "git branch",
  "git rev-parse",
  "git ls-files",
  "npm test",
  "npm run test",
  "npm run typecheck",
  "npm run lint",
  "npm run build",
  "npm run check",
  "pnpm test",
  "pnpm run test",
  "pnpm run typecheck",
  "pnpm run lint",
  "pnpm run build",
  "pnpm run check",
  "yarn test",
  "yarn run test",
  "yarn run typecheck",
  "yarn run lint",
  "yarn run build",
  "yarn run check",
  "bun test",
  "bun run test",
  "bun run typecheck",
  "bun run lint",
  "bun run build",
  "pytest",
  "python -m pytest",
  "python3 -m pytest",
  "uv run pytest",
  "go test",
  "cargo test",
  "cargo check",
  "cargo clippy",
  "tsc",
  "npx tsc",
  "eslint",
  "npx eslint",
  "biome check",
  "npx biome check"
];

const SAFE_BLOCKED_PATTERNS = [
  /(^|\s)rm\s+/,
  /(^|\s)mv\s+/,
  /(^|\s)cp\s+/,
  /(^|\s)dd\s+/,
  /(^|\s)sudo\s+/,
  /(^|\s)chmod\s+/,
  /(^|\s)chown\s+/,
  /(^|\s)kill\s+/,
  /(^|\s)pkill\s+/,
  /(^|\s)curl\s+/,
  /(^|\s)wget\s+/,
  /(^|\s)ssh\s+/,
  /(^|\s)scp\s+/,
  /(^|\s)rsync\s+/,
  /(^|\s)docker\s+/,
  /(^|\s)podman\s+/,
  /(^|\s)git\s+push\b/,
  /(^|\s)git\s+reset\b/,
  /(^|\s)git\s+clean\b/,
  /(^|\s)git\s+checkout\b/,
  /(^|\s)git\s+switch\b/,
  /(^|\s)git\s+restore\b/,
  /(^|\s)(npm|pnpm|yarn)\s+publish\b/,
  /(^|\s)--no-index\b/,
  /(^|\s)--fix\b/,
  /(^|\s)(\/|~(?:\/|\s|$))/,
  /(^|\s)\.\.(?:\/|\s|$)/,
  /\$/,
  /(^|[\s:])(?:\.env(?:[./\s:]|$)|\.git(?:[\/\s:]|$)|node_modules(?:[\/\s:]|$)|\.ssh(?:[\/\s:]|$)|id_rsa(?:[.\s:]|$)|id_ed25519(?:[.\s:]|$)|[^\s:]*\.(?:pem|key)(?:[\s:]|$))/,
  /(^|\s)['"]?-exec(?:['"]|\s|$)/,
  /(^|\s)['"]?-execdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-delete(?:['"]|\s|$)/,
  /(^|\s)['"]?-ok(?:['"]|\s|$)/,
  /(^|\s)['"]?-okdir(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprint0?(?:['"]|\s|$)/,
  /(^|\s)['"]?-fprintf(?:['"]|\s|$)/,
  /(^|\s)['"]?-fls(?:['"]|\s|$)/,
  /(^|\s)['"]?--output(?:=|['"]|\s|$)/,
  /(^|\s)(sed|perl)\s+.*(^|\s)-i(\s|$)/,
  /(^|\s)(cat|grep|rg|head|tail|wc)\s+/,
  /[;&|<>`]/,
  /[\r\n]/
];

function compact(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function startsWithAllowedPrefix(command: string): boolean {
  const normalized = compact(command);
  return isAllowedPackageScript(normalized) || SAFE_ALLOWED_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

function isAllowedPackageScript(command: string): boolean {
  const packageScriptPattern =
    /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test|typecheck|lint|build|check)(?::[A-Za-z0-9._-]+)*(?:\s+--\s+[A-Za-z0-9._:= -]+)?$/;
  return packageScriptPattern.test(command);
}

function assertSafeCommand(config: LocalWorkspaceBridgeConfig, command: string): void {
  if (config.bashMode === "off") {
    throw new LocalWorkspaceBridgeError("bash tool is disabled. Start with LOCALWORKSPACEBRIDGE_BASH_MODE=safe or LOCALWORKSPACEBRIDGE_BASH_MODE=full to enable it.");
  }
  if (config.bashMode === "full") return;

  const raw = command.trim();
  const normalized = compact(command);
  for (const pattern of SAFE_BLOCKED_PATTERNS) {
    if (pattern.test(raw) || pattern.test(normalized)) {
      throw new LocalWorkspaceBridgeError(
        `Command is blocked in LOCALWORKSPACEBRIDGE_BASH_MODE=safe: ${normalized}\n` +
          "Use separate read/search/git tools, or restart with LOCALWORKSPACEBRIDGE_BASH_MODE=full only for trusted repos."
      );
    }
  }
  if (!startsWithAllowedPrefix(normalized)) {
    throw new LocalWorkspaceBridgeError(
      `Command is not in the safe bash allowlist: ${normalized}\n` +
        "Allowed examples: ls, find, git status, git diff, npm test, npm run typecheck, npm run build:clients, pytest, go test, cargo test. Use read/search tools for file contents. " +
        "Use LOCALWORKSPACEBRIDGE_BASH_MODE=full for trusted local automation."
    );
  }
}

function assertBashSession(config: LocalWorkspaceBridgeConfig, sessionId?: string): string | undefined {
  const requested = sessionId?.trim();
  if (!config.bashSessionId) {
    if (config.requireBashSession) {
      throw new LocalWorkspaceBridgeError("bash session guard is enabled but no server bash session id is configured.");
    }
    return undefined;
  }
  if (!requested) {
    if (config.requireBashSession) {
      throw new LocalWorkspaceBridgeError(`bash session id is required. Retry with session_id="${config.bashSessionId}".`);
    }
    return config.bashSessionId;
  }
  if (requested !== config.bashSessionId) {
    throw new LocalWorkspaceBridgeError(`bash session id mismatch. This LocalWorkspaceBridge server accepts session_id="${config.bashSessionId}".`);
  }
  return config.bashSessionId;
}

const PROXY_ENV_KEYS = [
  "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy",
  "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"
] as const;

function copyDefined(environment: NodeJS.ProcessEnv, source: NodeJS.ProcessEnv, keys: readonly string[]): void {
  for (const key of keys) {
    if (source[key] !== undefined) environment[key] = source[key];
  }
}

export function commandEnvironment(
  config: LocalWorkspaceBridgeConfig,
  platform: NodeJS.Platform = process.platform,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  if (config.inheritEnv) {
    return { ...source, NO_COLOR: "1", CI: source.CI ?? "1" };
  }

  let environment: NodeJS.ProcessEnv;
  if (platform === "win32") {
    environment = {
      PATH: source.PATH ?? "",
      PATHEXT: source.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
      SystemRoot: source.SystemRoot ?? "C:\\Windows",
      ComSpec: source.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
      USERPROFILE: source.USERPROFILE ?? "",
      HOMEDRIVE: source.HOMEDRIVE ?? "",
      HOMEPATH: source.HOMEPATH ?? "",
      TEMP: source.TEMP ?? "",
      TMP: source.TMP ?? "",
      APPDATA: source.APPDATA ?? "",
      LOCALAPPDATA: source.LOCALAPPDATA ?? "",
      PYTHONIOENCODING: source.PYTHONIOENCODING ?? "utf-8",
      TERM: "dumb",
      NO_COLOR: "1",
      CI: "1"
    };
  } else {
    environment = {
      PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: source.HOME ?? "",
      USER: source.USER ?? "",
      SHELL: source.SHELL ?? "/bin/bash",
      TMPDIR: source.TMPDIR ?? "/tmp",
      TERM: "dumb",
      NO_COLOR: "1",
      CI: "1"
    };
  }
  copyDefined(environment, source, PROXY_ENV_KEYS);
  return environment;
}

function powershellArgs(command: string): string[] {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "$utf8 = [System.Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding = $utf8",
    "[Console]::OutputEncoding = $utf8",
    "$OutputEncoding = $utf8",
    command
  ].join("; ");
  return ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")];
}

export function resolveShellCommand(
  config: Pick<LocalWorkspaceBridgeConfig, "shellMode" | "bashPath">,
  command: string,
  platform: NodeJS.Platform = process.platform,
  existsSync: (filePath: fs.PathLike) => boolean = fs.existsSync
): ResolvedShellCommand {
  const configured = config.shellMode ?? "auto";
  const selected: Exclude<ShellMode, "auto"> = configured === "auto"
    ? (platform === "win32" ? "powershell" : "bash")
    : configured;

  if (selected === "bash") {
    const executable = config.bashPath || (platform !== "win32" && existsSync("/bin/bash") ? "/bin/bash" : "bash");
    return { executable, args: ["-lc", command], shell: "bash" };
  }
  if (selected === "powershell") {
    return { executable: platform === "win32" ? "powershell.exe" : "powershell", args: powershellArgs(command), shell: "powershell" };
  }
  if (selected === "pwsh") {
    return { executable: platform === "win32" ? "pwsh.exe" : "pwsh", args: powershellArgs(command), shell: "pwsh" };
  }
  if (platform !== "win32") {
    throw new LocalWorkspaceBridgeError("LOCALWORKSPACEBRIDGE_SHELL=cmd is only supported on Windows.");
  }
  return { executable: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command], shell: "cmd" };
}

function trimOutput(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= maxBytes) return { value, truncated: false };
  const marker = `\n...[middle of output truncated; ${buffer.byteLength} bytes total]...\n`;
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  const headBytes = Math.ceil(contentBudget / 2);
  const tailBytes = Math.floor(contentBudget / 2);
  return {
    value: `${buffer.subarray(0, headBytes).toString("utf8")}${marker}${buffer.subarray(buffer.byteLength - tailBytes).toString("utf8")}`,
    truncated: true
  };
}

function trimCombinedOutput(stdout: string, stderr: string, maxBytes: number): { stdout: string; stderr: string; truncated: boolean } {
  const stdoutBytes = Buffer.byteLength(stdout, "utf8");
  const stderrBytes = Buffer.byteLength(stderr, "utf8");
  if (stdoutBytes + stderrBytes <= maxBytes) return { stdout, stderr, truncated: false };
  let stdoutBudget = stderrBytes ? Math.floor(maxBytes / 2) : maxBytes;
  let stderrBudget = stdoutBytes ? maxBytes - stdoutBudget : maxBytes;
  if (stdoutBytes < stdoutBudget) {
    stderrBudget += stdoutBudget - stdoutBytes;
    stdoutBudget = stdoutBytes;
  }
  if (stderrBytes < stderrBudget) {
    stdoutBudget += stderrBudget - stderrBytes;
    stderrBudget = stderrBytes;
  }
  const out = trimOutput(stdout, Math.max(0, stdoutBudget));
  const err = trimOutput(stderr, Math.max(0, stderrBudget));
  return { stdout: out.value, stderr: err.value, truncated: true };
}

function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (closed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once("close", onClose);
  });
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve) => {
    const args = ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
    const killer = spawn("taskkill.exe", args, { stdio: "ignore", windowsHide: true });
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}

export async function terminateProcessTree(
  child: ChildProcess,
  graceMs = 1_500,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return;

  if (platform === "win32") {
    await runTaskkill(pid, true);
    await waitForChildClose(child, graceMs);
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  if (await waitForChildClose(child, graceMs)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
  await waitForChildClose(child, graceMs);
}

export async function runBash(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  command: string,
  options: { cwd?: string; timeoutMs?: number; sessionId?: string } = {}
): Promise<BashResult> {
  if (!command?.trim()) throw new LocalWorkspaceBridgeError("command is required.");
  const bashSessionId = assertBashSession(config, options.sessionId);
  assertSafeCommand(config, command);
  const cwdResolved = guard.resolve(workspace, options.cwd ?? ".");
  const cwd = cwdResolved.absPath;
  const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 30_000, 180_000));
  const start = Date.now();
  const shell = resolveShellCommand(config, command);

  return new Promise((resolve, reject) => {
    const child = spawn(shell.executable, shell.args, {
      cwd,
      env: commandEnvironment(config),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let killedByOutputLimit = false;
    let terminationStarted = false;

    const terminate = (reason: "timeout" | "output") => {
      if (terminationStarted) return;
      terminationStarted = true;
      if (reason === "timeout") killedByTimeout = true;
      else killedByOutputLimit = true;
      void terminateProcessTree(child).catch(() => {
        try { child.kill("SIGKILL"); } catch {}
      });
    };

    const timer = setTimeout(() => {
      terminate("timeout");
    }, timeoutMs);
    timer.unref();

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > config.maxOutputBytes * 2) terminate("output");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (Buffer.byteLength(stdout, "utf8") + Buffer.byteLength(stderr, "utf8") > config.maxOutputBytes * 2) terminate("output");
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (killedByTimeout) {
        stderr += `\n[local-workspace-bridge] Command timed out after ${timeoutMs} ms.`;
      }
      if (killedByOutputLimit) {
        stderr += `\n[local-workspace-bridge] Command exceeded the output limit and its process tree was terminated.`;
      }
      const output = trimCombinedOutput(redactSensitiveText(stdout), redactSensitiveText(stderr), config.maxOutputBytes);
      resolve({
        command,
        cwd: path.relative(workspace.root, cwd) || ".",
        exitCode,
        signal,
        durationMs: Date.now() - start,
        stdout: output.stdout,
        stderr: output.stderr,
        truncated: output.truncated,
        shell: shell.shell,
        ...(bashSessionId ? { bashSessionId } : {})
      });
    });
  });
}
