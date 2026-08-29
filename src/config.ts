import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ANALYSIS_LIMITS, type AnalysisLimits } from "./analysis/types.js";

export type BashMode = "off" | "safe" | "full";
export type BashTranscriptMode = "compact" | "full";
export type ShellMode = "auto" | "bash" | "powershell" | "pwsh" | "cmd";
export type CodexSessionsMode = "off" | "metadata" | "read";
export type WriteMode = "off" | "workspace";
export type ToolMode = "minimal" | "standard" | "full";

export interface LocalWorkspaceBridgeConfig {
  defaultRoot: string;
  allowedRoots: string[];
  host: string;
  port: number;
  widgetDomain: string;
  authToken?: string;
  publicUrl?: string;
  allowQueryToken: boolean;
  requireHttpToken: boolean;
  bashMode: BashMode;
  bashTranscript: BashTranscriptMode;
  shellMode: ShellMode;
  bashPath?: string;
  bashSessionId?: string;
  requireBashSession: boolean;
  codexSessions: CodexSessionsMode;
  codexDir: string;
  writeMode: WriteMode;
  toolMode: ToolMode;
  inheritEnv: boolean;
  maxReadBytes: number;
  maxWriteBytes: number;
  maxOutputBytes: number;
  maxSearchResults: number;
  maxHttpSessions: number;
  httpSessionTtlMs: number;
  blockedGlobs: string[];
  analysisIgnoreGlobs: string[];
  toolCards: boolean;
  connectionTest: boolean;
  lowMemory: boolean;
  analysisEnabled: boolean;
  analysisLimits: AnalysisLimits;
  analysisCacheEntries: number;
  analysisCacheTtlMs: number;
}

const DEFAULT_BLOCKED_GLOBS = [
  ".git",
  ".git/**",
  "**/.git/**",
  "node_modules",
  "node_modules/**",
  "**/node_modules/**",
  ".env",
  ".env/**",
  ".env.*",
  ".env.*/**",
  "**/.env",
  "**/.env/**",
  "**/.env.*",
  "**/.env.*/**",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.*",
  "**/id_ed25519",
  "**/id_ed25519.*",
  "**/.ssh/**",
  "dist",
  "dist/**",
  "**/dist/**",
  "build",
  "build/**",
  "**/build/**",
  ".next",
  ".next/**",
  "**/.next/**",
  "coverage",
  "coverage/**",
  "**/coverage/**",
  ".cache",
  ".cache/**",
  "**/.cache/**"
];

const DEFAULT_ANALYSIS_IGNORE_GLOBS = [
  "**/.venv/**", "**/venv/**", "**/__pycache__/**", "**/.pytest_cache/**",
  "**/.mypy_cache/**", "**/.ruff_cache/**", "**/*.egg-info/**", "**/.gradle/**",
  "**/target/**", "**/bin/Debug/**", "**/bin/Release/**", "**/obj/**", "**/.turbo/**", "**/_logs/**",
  "**/npm-cache/**", "=/npm-cache/**"
];

const LOW_MEMORY_ANALYSIS_LIMITS: AnalysisLimits = {
  maxInventoryFiles: 5_000,
  maxAnalyzedFiles: 800,
  maxScannedBytes: 16 * 1024 * 1024,
  maxSymbols: 20_000,
  maxRelationships: 40_000
};

function parseArgs(argv: string[]): Record<string, string | string[] | boolean> {
  const out: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;
    const withoutPrefix = raw.slice(2);
    const eqIndex = withoutPrefix.indexOf("=");
    let key: string;
    let value: string | boolean;
    if (eqIndex >= 0) {
      key = withoutPrefix.slice(0, eqIndex);
      value = withoutPrefix.slice(eqIndex + 1);
    } else {
      key = withoutPrefix;
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (key === "allow-root") {
      const prev = out[key];
      if (Array.isArray(prev)) prev.push(String(value));
      else if (prev) out[key] = [String(prev), String(value)];
      else out[key] = [String(value)];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function expandHome(input: string): string {
  if (!input || input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return input;
}

function splitList(value: string | undefined, delimiter: string = path.delimiter): string[] {
  if (!value) return [];
  return value
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean);
}

function splitRoots(value: string | undefined): string[] {
  return splitList(value, path.delimiter);
}

function toRealDir(input: string): string {
  const expanded = expandHome(input);
  const resolved = path.resolve(expanded);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Directory does not exist: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${resolved}`);
  }
  return fs.realpathSync(resolved);
}

function numberFrom(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function bashModeFrom(value: string | undefined): BashMode {
  if (value === "off" || value === "safe" || value === "full") return value;
  return "safe";
}

function bashTranscriptFrom(value: string | undefined): BashTranscriptMode {
  if (value === "compact" || value === "full") return value;
  return "compact";
}

function shellModeFrom(value: string | undefined): ShellMode {
  const normalized = value?.trim().toLowerCase() || "auto";
  if (["auto", "bash", "powershell", "pwsh", "cmd"].includes(normalized)) {
    return normalized as ShellMode;
  }
  throw new Error("LOCALWORKSPACEBRIDGE_SHELL must be one of: auto, bash, powershell, pwsh, cmd.");
}

function codexSessionsFrom(value: string | undefined): CodexSessionsMode {
  if (value === "metadata" || value === "read") return value;
  if (value === "1" || value === "true" || value === "yes" || value === "on") return "metadata";
  return "off";
}

function bashSessionIdFrom(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(trimmed)) {
    throw new Error("LOCALWORKSPACEBRIDGE_BASH_SESSION_ID must be 1-64 characters using letters, numbers, dot, underscore, or dash, and must start with a letter or number.");
  }
  return trimmed;
}

function writeModeFrom(value: string | undefined): WriteMode {
  if (value === "off" || value === "workspace") return value;
  return "workspace";
}

function toolModeFrom(value: string | undefined): ToolMode {
  if (value === "minimal" || value === "standard" || value === "full") return value;
  return "standard";
}

function widgetDomainFrom(value: string | undefined): string {
  const raw = value?.trim() || "https://example.invalid";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN must be a valid origin URL, got: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error("LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN must use https.");
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN must be an origin only, for example https://widgets.example.com.");
  }
  return parsed.origin;
}

function publicUrlFrom(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`LOCALWORKSPACEBRIDGE_PUBLIC_URL must be a valid HTTPS origin, got: ${raw}`);
  }
  if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("LOCALWORKSPACEBRIDGE_PUBLIC_URL must be an HTTPS origin without a path, query, or fragment.");
  }
  return parsed.origin;
}

function boolFrom(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function loadConfig(argv = process.argv.slice(2)): LocalWorkspaceBridgeConfig {
  const args = parseArgs(argv);
  const lowMemoryArg =
    args["low-memory"] === true
      ? "true"
      : typeof args["low-memory"] === "string"
        ? args["low-memory"]
        : undefined;
  const lowMemory = boolFrom(lowMemoryArg ?? process.env.LOCALWORKSPACEBRIDGE_LOW_MEMORY, false);
  const analysisDefaults = lowMemory ? LOW_MEMORY_ANALYSIS_LIMITS : DEFAULT_ANALYSIS_LIMITS;

  const rootFromArgs = typeof args.root === "string" ? args.root : undefined;
  const root = rootFromArgs ?? process.env.LOCALWORKSPACEBRIDGE_ROOT ?? process.cwd();
  const defaultRoot = toRealDir(root);

  const allowRootArgs = Array.isArray(args["allow-root"])
    ? args["allow-root"]
    : typeof args["allow-root"] === "string"
      ? [args["allow-root"]]
      : [];
  const envAllowedRoots = [
    ...splitRoots(process.env.LOCALWORKSPACEBRIDGE_ALLOWED_ROOTS)
  ];

  const allowHome = process.env.LOCALWORKSPACEBRIDGE_ALLOW_HOME === "1" || args["allow-home"] === true;
  const requestedAllowed = [defaultRoot, ...allowRootArgs, ...envAllowedRoots, ...(allowHome ? [os.homedir()] : [])];
  const allowedRoots = [...new Set(requestedAllowed.map(toRealDir))];

  const portArg = typeof args.port === "string" ? args.port : undefined;
  const hostArg = typeof args.host === "string" ? args.host : undefined;
  const bashArg = typeof args.bash === "string" ? args.bash : undefined;
  const bashTranscriptArg = typeof args["bash-transcript"] === "string" ? args["bash-transcript"] : undefined;
  const bashSessionArg = typeof args["bash-session"] === "string" ? args["bash-session"] : undefined;
  const codexSessionsArg = typeof args["codex-sessions"] === "string" ? args["codex-sessions"] : undefined;
  const codexDirArg = typeof args["codex-dir"] === "string" ? args["codex-dir"] : undefined;
  const requireBashSessionArg =
    args["require-bash-session"] === true
      ? "true"
      : typeof args["require-bash-session"] === "string"
        ? args["require-bash-session"]
        : undefined;
  const writeArg = typeof args.write === "string" ? args.write : undefined;
  const toolModeArg = typeof args["tool-mode"] === "string" ? args["tool-mode"] : undefined;
  const widgetDomainArg = typeof args["widget-domain"] === "string" ? args["widget-domain"] : undefined;
  const toolCardsArg =
    args["tool-cards"] === true
      ? "true"
      : typeof args["tool-cards"] === "string"
        ? args["tool-cards"]
        : undefined;
  const extraBlockedGlobs = splitList(process.env.LOCALWORKSPACEBRIDGE_BLOCKED_GLOBS, ",");
  const extraAnalysisIgnoreGlobs = splitList(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_IGNORE_GLOBS, ",");
  const host = hostArg ?? process.env.LOCALWORKSPACEBRIDGE_HOST ?? process.env.HOST ?? "127.0.0.1";
  const authToken = process.env.LOCALWORKSPACEBRIDGE_HTTP_TOKEN;
  const allowNoToken = boolFrom(process.env.LOCALWORKSPACEBRIDGE_ALLOW_NO_HTTP_TOKEN, false) && isLoopbackHost(host);
  const requireHttpToken =
    (!authToken && !allowNoToken) ||
    boolFrom(process.env.LOCALWORKSPACEBRIDGE_REQUIRE_HTTP_TOKEN, false) ||
    boolFrom(process.env.LOCALWORKSPACEBRIDGE_TUNNEL_MODE, false) ||
    (!isLoopbackHost(host) && !allowNoToken);
  const bashSessionId = bashSessionIdFrom(bashSessionArg ?? process.env.LOCALWORKSPACEBRIDGE_BASH_SESSION_ID);
  const requireBashSession = boolFrom(requireBashSessionArg ?? process.env.LOCALWORKSPACEBRIDGE_REQUIRE_BASH_SESSION, false);
  if (requireBashSession && !bashSessionId) {
    throw new Error("LOCALWORKSPACEBRIDGE_REQUIRE_BASH_SESSION requires LOCALWORKSPACEBRIDGE_BASH_SESSION_ID or --bash-session.");
  }

  return {
    defaultRoot,
    allowedRoots,
    host,
    port: numberFrom(portArg ?? process.env.LOCALWORKSPACEBRIDGE_PORT ?? process.env.PORT, 8787, 1, 65535),
    widgetDomain: widgetDomainFrom(widgetDomainArg ?? process.env.LOCALWORKSPACEBRIDGE_WIDGET_DOMAIN),
    authToken,
    publicUrl: publicUrlFrom(process.env.LOCALWORKSPACEBRIDGE_PUBLIC_URL),
    allowQueryToken: boolFrom(process.env.LOCALWORKSPACEBRIDGE_ALLOW_QUERY_TOKEN, false),
    requireHttpToken,
    bashMode: bashModeFrom(bashArg ?? process.env.LOCALWORKSPACEBRIDGE_BASH_MODE),
    bashTranscript: bashTranscriptFrom(bashTranscriptArg ?? process.env.LOCALWORKSPACEBRIDGE_BASH_TRANSCRIPT),
    shellMode: shellModeFrom(process.env.LOCALWORKSPACEBRIDGE_SHELL),
    bashPath: process.env.LOCALWORKSPACEBRIDGE_BASH_PATH?.trim() || undefined,
    bashSessionId,
    requireBashSession,
    codexSessions: codexSessionsFrom(codexSessionsArg ?? process.env.LOCALWORKSPACEBRIDGE_CODEX_SESSIONS),
    codexDir: expandHome(codexDirArg || process.env.LOCALWORKSPACEBRIDGE_CODEX_DIR || path.join(os.homedir(), ".codex")),
    writeMode: writeModeFrom(writeArg ?? process.env.LOCALWORKSPACEBRIDGE_WRITE_MODE),
    toolMode: toolModeFrom(toolModeArg ?? process.env.LOCALWORKSPACEBRIDGE_TOOL_MODE),
    inheritEnv: process.env.LOCALWORKSPACEBRIDGE_INHERIT_ENV === "1",
    maxReadBytes: numberFrom(process.env.LOCALWORKSPACEBRIDGE_MAX_READ_BYTES, 180_000, 4_000, 2_000_000),
    maxWriteBytes: numberFrom(process.env.LOCALWORKSPACEBRIDGE_MAX_WRITE_BYTES, 1_000_000, 1_000, 10_000_000),
    maxOutputBytes: numberFrom(process.env.LOCALWORKSPACEBRIDGE_MAX_OUTPUT_BYTES, 60_000, 4_000, 2_000_000),
    maxSearchResults: numberFrom(process.env.LOCALWORKSPACEBRIDGE_MAX_SEARCH_RESULTS, lowMemory ? 100 : 200, 5, 2_000),
    maxHttpSessions: numberFrom(process.env.LOCALWORKSPACEBRIDGE_MAX_HTTP_SESSIONS, lowMemory ? 16 : 64, 1, 512),
    httpSessionTtlMs: numberFrom(process.env.LOCALWORKSPACEBRIDGE_HTTP_SESSION_TTL_MS, lowMemory ? 10 * 60_000 : 30 * 60_000, 60_000, 24 * 60 * 60_000),
    blockedGlobs: [...DEFAULT_BLOCKED_GLOBS, ...extraBlockedGlobs],
    analysisIgnoreGlobs: [...DEFAULT_ANALYSIS_IGNORE_GLOBS, ...extraAnalysisIgnoreGlobs],
    toolCards: boolFrom(toolCardsArg ?? process.env.LOCALWORKSPACEBRIDGE_TOOL_CARDS, false),
    connectionTest: boolFrom(process.env.LOCALWORKSPACEBRIDGE_CONNECTION_TEST, false),
    lowMemory,
    analysisEnabled: boolFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS, true),
    analysisLimits: {
      maxInventoryFiles: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_INVENTORY_FILES, analysisDefaults.maxInventoryFiles, 100, 100_000),
      maxAnalyzedFiles: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_ANALYZED_FILES, analysisDefaults.maxAnalyzedFiles, 10, 50_000),
      maxScannedBytes: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_SCANNED_BYTES, analysisDefaults.maxScannedBytes, 1_000_000, 512 * 1024 * 1024),
      maxSymbols: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_SYMBOLS, analysisDefaults.maxSymbols, 100, 1_000_000),
      maxRelationships: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_MAX_RELATIONSHIPS, analysisDefaults.maxRelationships, 100, 2_000_000)
    },
    analysisCacheEntries: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_CACHE_ENTRIES, lowMemory ? 2 : 8, 1, 64),
    analysisCacheTtlMs: numberFrom(process.env.LOCALWORKSPACEBRIDGE_ANALYSIS_CACHE_TTL_MS, lowMemory ? 5 * 60_000 : 30 * 60_000, 60_000, 24 * 60 * 60_000)
  };
}
