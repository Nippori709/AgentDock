import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expandHome, type LocalWorkspaceBridgeConfig } from "./config.js";
import { LocalWorkspaceBridgeError, PathGuard, isSubpath, type Workspace } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export type LspOperation =
  | "goToDefinition"
  | "findReferences"
  | "goToImplementation"
  | "hover"
  | "documentSymbol"
  | "workspaceSymbol"
  | "prepareCallHierarchy"
  | "incomingCalls"
  | "outgoingCalls"
  | "diagnostics";

export interface LspQuery {
  operation: LspOperation;
  path: string;
  line?: number;
  character?: number;
  query?: string;
  maxResults?: number;
}

export interface LspLocation {
  path: string;
  line: number;
  character: number;
  end_line: number;
  end_character: number;
}

export interface LspSymbol {
  name: string;
  kind?: number;
  detail?: string;
  container?: string;
  location?: LspLocation;
}

export interface LspCall {
  name: string;
  kind?: number;
  detail?: string;
  location?: LspLocation;
  from_ranges?: Array<{ line: number; character: number; end_line: number; end_character: number }>;
}

export interface LspDiagnostic {
  message: string;
  severity?: number;
  source?: string;
  code?: string | number;
  line: number;
  character: number;
  end_line: number;
  end_character: number;
}

export interface LspResult {
  operation: LspOperation;
  path: string;
  line?: number;
  character?: number;
  locations?: LspLocation[];
  hover?: string | null;
  symbols?: LspSymbol[];
  calls?: LspCall[];
  diagnostics?: LspDiagnostic[];
  truncated?: boolean;
  provider: string;
  server_reused: boolean;
  document_version?: number;
}

interface Provider {
  name: LspResult["provider"];
  languageId: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceFolder?: string;
  startupTimeout?: number;
  shutdownTimeout?: number;
  maxRestarts?: number;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

interface OpenDocument {
  uri: string;
  version: number;
  sha256: string;
}

interface ManagedServer {
  key: string;
  workspaceRoot: string;
  provider: Provider;
  client: LspProcess;
  openDocuments: Map<string, OpenDocument>;
  diagnostics: Map<string, LspDiagnostic[]>;
  startedAt: number;
}

const require = createRequire(import.meta.url);
const HEADER_SEPARATOR = "\r\n\r\n";
const MAX_HEADER_BYTES = 1 << 16;
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_LSP_FILE_BYTES = 10 * 1024 * 1024;

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function normalizedUriKey(uri: string): string {
  try {
    const absolute = path.resolve(fileURLToPath(uri));
    return process.platform === "win32" ? absolute.toLowerCase() : absolute;
  } catch {
    return process.platform === "win32" ? uri.toLowerCase() : uri;
  }
}

class MessageDecoder {
  private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.buffer.length) {
      const separator = this.buffer.indexOf(HEADER_SEPARATOR);
      if (separator < 0) {
        if (this.buffer.length > MAX_HEADER_BYTES) throw new Error("LSP header exceeds safety limit.");
        break;
      }
      if (separator > MAX_HEADER_BYTES) throw new Error("LSP header exceeds safety limit.");
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) throw new Error("LSP message is missing Content-Length.");
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        throw new Error("LSP message exceeds safety limit.");
      }
      const bodyStart = separator + Buffer.byteLength(HEADER_SEPARATOR);
      if (this.buffer.length < bodyStart + length) break;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      out.push(JSON.parse(body));
    }
    return out;
  }
}

function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body
  ]);
}

class LspProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly decoder = new MessageDecoder();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private nextId = 1;
  private stderr = "";
  private closed = false;

  constructor(
    private readonly cwd: string,
    private readonly provider: Provider,
    private readonly onClosed?: (unexpected: boolean) => void
  ) {
    this.child = spawn(provider.command, provider.args, {
      cwd,
      stdio: "pipe",
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", ...(provider.env ?? {}) }
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const raw of this.decoder.push(Buffer.from(chunk))) this.onMessage(raw);
      } catch (error) {
        this.failAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-16_000);
    });
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("close", () => {
      this.closed = true;
      this.failAll(new Error(this.stderr.trim() || "Language server exited before completing the request."));
      this.onClosed?.(!this.closing);
    });
  }

  private closing = false;

  get isClosed(): boolean {
    return this.closed;
  }

  onNotification(method: string, handler: (params: unknown) => void): () => void {
    const set = this.notificationHandlers.get(method) ?? new Set<(params: unknown) => void>();
    this.notificationHandlers.set(method, set);
    set.add(handler);
    return () => set.delete(handler);
  }

  private onMessage(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
    const message = raw as Record<string, unknown>;
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        this.handleServerRequest(message.id, message.method, message.params);
        return;
      }
      for (const handler of this.notificationHandlers.get(message.method) ?? []) {
        try { handler(message.params); } catch {}
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === "object") {
      const error = message.error as Record<string, unknown>;
      pending.reject(new Error(String(error.message ?? "Language server request failed.")));
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(id: unknown, method: string, params: unknown): void {
    let result: unknown = null;
    if (method === "workspace/configuration") {
      const items =
        params && typeof params === "object" && !Array.isArray(params) && Array.isArray((params as Record<string, unknown>).items)
          ? (params as { items: unknown[] }).items
          : [];
      result = items.map(() => ({}));
    } else if (method === "workspace/workspaceFolders") {
      result = [{ uri: pathToFileURL(this.cwd).href, name: path.basename(this.cwd) }];
    } else if (method === "workspace/applyEdit") {
      result = { applied: false, failureReason: "Server-initiated workspace edits are disabled." };
    }
    try {
      this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, result }));
    } catch {}
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  notify(method: string, params: unknown): void {
    if (this.closed) throw new Error("Language server is closed.");
    this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Language server is closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Language server request timed out after ${timeoutMs} ms.`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", id, method, params }));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    try {
      await this.request("shutdown", null, this.provider.shutdownTimeout ?? 3_000);
    } catch {}
    try { this.notify("exit", null); } catch {}
    await new Promise<void>((resolve) => {
      if (this.closed) {
        resolve();
        return;
      }
      let forceTimer: NodeJS.Timeout | undefined;
      let hardTimer: NodeJS.Timeout | undefined;
      const done = () => {
        if (forceTimer) clearTimeout(forceTimer);
        if (hardTimer) clearTimeout(hardTimer);
        resolve();
      };
      this.child.once("close", done);
      forceTimer = setTimeout(() => {
        try { this.child.kill(); } catch {}
      }, 500);
      forceTimer.unref();
      hardTimer = setTimeout(done, 2_000);
      hardTimer.unref();
    });
  }
}

type ClaudeLspConfig = {
  command?: unknown;
  args?: unknown;
  extensionToLanguage?: unknown;
  transport?: unknown;
  env?: unknown;
  initializationOptions?: unknown;
  settings?: unknown;
  workspaceFolder?: unknown;
  startupTimeout?: unknown;
  shutdownTimeout?: unknown;
  restartOnCrash?: unknown;
  maxRestarts?: unknown;
};

function positiveTimeout(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 120_000) : fallback;
}

function nonNegativeInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 100) : fallback;
}

function customProviderFor(config: LocalWorkspaceBridgeConfig, workspace: Workspace, filePath: string): Provider | undefined {
  if (!config.lspConfigPath) return undefined;
  const expanded = expandHome(config.lspConfigPath);
  const configPath = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(workspace.root, expanded);
  if (!fs.existsSync(configPath)) throw new LocalWorkspaceBridgeError(`Configured LSP file does not exist: ${configPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new LocalWorkspaceBridgeError(`Invalid Claude-compatible LSP JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new LocalWorkspaceBridgeError("Claude-compatible LSP config must be an object keyed by server name.");
  }
  const ext = path.extname(filePath).toLowerCase();
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entry = raw as ClaudeLspConfig;
    if (!entry.extensionToLanguage || typeof entry.extensionToLanguage !== "object" || Array.isArray(entry.extensionToLanguage)) continue;
    const language = Object.entries(entry.extensionToLanguage as Record<string, unknown>).find(([key]) => {
      const normalized = key.startsWith(".") ? key.toLowerCase() : `.${key.toLowerCase()}`;
      return normalized === ext;
    });
    if (!language || typeof language[1] !== "string") continue;
    if (typeof entry.command !== "string" || !entry.command.trim()) throw new LocalWorkspaceBridgeError(`LSP server ${name} is missing command.`);
    if (entry.transport !== undefined && entry.transport !== "stdio") {
      throw new LocalWorkspaceBridgeError(`LSP server ${name} uses transport=${String(entry.transport)}; this MCP adapter currently supports Claude-compatible stdio LSP servers only.`);
    }
    if (entry.restartOnCrash !== undefined) {
      throw new LocalWorkspaceBridgeError(`LSP server '${name}': restartOnCrash is not implemented by the Claude Code 2.1.150 runtime this compatibility layer targets. Remove this field from the configuration.`);
    }
    const configDir = path.dirname(configPath);
    const rawCommand = entry.command.trim();
    const command = rawCommand.startsWith(".") || rawCommand.includes("/") || rawCommand.includes("\\") ? path.resolve(configDir, rawCommand) : rawCommand;
    const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env)
      ? Object.fromEntries(Object.entries(entry.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : undefined;
    const rawFolder = typeof entry.workspaceFolder === "string" && entry.workspaceFolder.trim() ? expandHome(entry.workspaceFolder.trim()) : undefined;
    const workspaceFolder = rawFolder ? (path.isAbsolute(rawFolder) ? path.resolve(rawFolder) : path.resolve(workspace.root, rawFolder)) : undefined;
    return {
      name,
      languageId: language[1],
      command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env,
      initializationOptions: entry.initializationOptions,
      settings: entry.settings,
      workspaceFolder,
      startupTimeout: positiveTimeout(entry.startupTimeout, DEFAULT_TIMEOUT_MS),
      shutdownTimeout: positiveTimeout(entry.shutdownTimeout, 3_000),
      maxRestarts: nonNegativeInt(entry.maxRestarts, 3)
    };
  }
  return undefined;
}

function providerFor(config: LocalWorkspaceBridgeConfig, workspace: Workspace, filePath: string): Provider {
  const custom = customProviderFor(config, workspace, filePath);
  if (custom) return custom;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".py" || ext === ".pyi") {
    return {
      name: "pyright",
      languageId: "python",
      command: process.execPath,
      args: [require.resolve("pyright/langserver.index.js"), "--stdio"]
    };
  }
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    const languageId =
      ext === ".ts" ? "typescript" :
      ext === ".tsx" ? "typescriptreact" :
      ext === ".jsx" ? "javascriptreact" :
      "javascript";
    return {
      name: "typescript-language-server",
      languageId,
      command: process.execPath,
      args: [require.resolve("typescript-language-server/lib/cli.mjs"), "--stdio"]
    };
  }
  throw new LocalWorkspaceBridgeError("No LSP provider is configured for this file extension. Built-ins support Python and TypeScript/JavaScript; set LOCALWORKSPACEBRIDGE_LSP_CONFIG to a Claude-compatible .lsp.json for other languages.");
}

function providerKey(workspace: Workspace, provider: Provider): string {
  return `${workspace.root}\0${provider.name}`;
}

function requirePosition(query: LspQuery): { line: number; character: number } {
  if (!Number.isInteger(query.line) || (query.line ?? 0) < 1 || !Number.isInteger(query.character) || (query.character ?? 0) < 1) {
    throw new LocalWorkspaceBridgeError(`${query.operation} requires 1-based positive line and character values.`);
  }
  return { line: query.line!, character: query.character! };
}

function normalizeRange(rangeValue: unknown): { line: number; character: number; end_line: number; end_character: number } | undefined {
  if (!rangeValue || typeof rangeValue !== "object" || Array.isArray(rangeValue)) return undefined;
  const range = rangeValue as Record<string, unknown>;
  const start = range.start as Record<string, unknown> | undefined;
  const end = range.end as Record<string, unknown> | undefined;
  if (!start || !end || typeof start.line !== "number" || typeof start.character !== "number" || typeof end.line !== "number" || typeof end.character !== "number") {
    return undefined;
  }
  return {
    line: start.line + 1,
    character: start.character + 1,
    end_line: end.line + 1,
    end_character: end.character + 1
  };
}

function visibleLocation(
  uri: unknown,
  rangeValue: unknown,
  guard: PathGuard,
  workspace: Workspace
): LspLocation | undefined {
  if (typeof uri !== "string") return undefined;
  let absolute: string;
  try { absolute = fileURLToPath(uri); } catch { return undefined; }
  const canonical = path.resolve(absolute);
  if (!isSubpath(canonical, workspace.root)) return undefined;
  const rel = path.relative(workspace.root, canonical).split(path.sep).join("/") || ".";
  if (guard.isBlockedRelativePath(rel)) return undefined;
  const range = normalizeRange(rangeValue);
  return range ? { path: rel, ...range } : undefined;
}

function normalizeHover(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const contents = (value as Record<string, unknown>).contents;
  const render = (item: unknown): string => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object" || Array.isArray(item)) return "";
    const record = item as Record<string, unknown>;
    if (typeof record.value === "string" && typeof record.language === "string") {
      return `\`\`${record.language}\n${record.value}\n\`\``;
    }
    if (typeof record.value === "string") return record.value;
    return "";
  };
  const text = Array.isArray(contents) ? contents.map(render).filter(Boolean).join("\n\n") : render(contents);
  return text ? redactSensitiveText(text).slice(0, 12_000) : null;
}

function normalizeLocations(
  raw: unknown,
  guard: PathGuard,
  workspace: Workspace,
  maxResults: number
): { locations: LspLocation[]; truncated: boolean } {
  const items = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const locations: LspLocation[] = [];
  let visible = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const uri = record.uri ?? record.targetUri;
    const rangeValue = record.range ?? record.targetSelectionRange;
    const location = visibleLocation(uri, rangeValue, guard, workspace);
    if (!location) continue;
    visible += 1;
    if (locations.length < maxResults) locations.push(location);
  }
  return { locations, truncated: visible > locations.length };
}

function symbolLocation(record: Record<string, unknown>, guard: PathGuard, workspace: Workspace): LspLocation | undefined {
  const location = record.location;
  if (location && typeof location === "object" && !Array.isArray(location)) {
    const loc = location as Record<string, unknown>;
    return visibleLocation(loc.uri, loc.range, guard, workspace);
  }
  return undefined;
}

function normalizeSymbols(raw: unknown, guard: PathGuard, workspace: Workspace, currentUri: string, maxResults: number): { symbols: LspSymbol[]; truncated: boolean } {
  const out: LspSymbol[] = [];
  let total = 0;
  const visit = (item: unknown, container?: string): void => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const record = item as Record<string, unknown>;
    if (typeof record.name !== "string") return;
    const fallbackLocation = visibleLocation(currentUri, record.selectionRange ?? record.range, guard, workspace);
    const location = symbolLocation(record, guard, workspace) ?? fallbackLocation;
    if (record.location && !location) return;
    total += 1;
    if (out.length < maxResults) {
      out.push({
        name: redactSensitiveText(record.name).slice(0, 300),
        kind: typeof record.kind === "number" ? record.kind : undefined,
        detail: typeof record.detail === "string" ? redactSensitiveText(record.detail).slice(0, 500) : undefined,
        container: typeof record.containerName === "string" ? redactSensitiveText(record.containerName).slice(0, 300) : container,
        location
      });
    }
    if (Array.isArray(record.children)) {
      for (const child of record.children) visit(child, record.name);
    }
  };
  for (const item of Array.isArray(raw) ? raw : raw ? [raw] : []) visit(item);
  return { symbols: out, truncated: total > out.length };
}

function normalizeCallItems(raw: unknown, guard: PathGuard, workspace: Workspace, maxResults: number, direction: "plain" | "incoming" | "outgoing"): { calls: LspCall[]; truncated: boolean } {
  const items = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const calls: LspCall[] = [];
  let visible = 0;
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const wrapper = item as Record<string, unknown>;
    const callItem =
      direction === "incoming" ? wrapper.from :
      direction === "outgoing" ? wrapper.to :
      wrapper;
    if (!callItem || typeof callItem !== "object" || Array.isArray(callItem)) continue;
    const record = callItem as Record<string, unknown>;
    const location = visibleLocation(record.uri, record.selectionRange ?? record.range, guard, workspace);
    if (!location || typeof record.name !== "string") continue;
    visible += 1;
    if (calls.length >= maxResults) continue;
    const ranges = Array.isArray(wrapper.fromRanges)
      ? wrapper.fromRanges.map(normalizeRange).filter((value): value is NonNullable<typeof value> => Boolean(value)).slice(0, 20)
      : undefined;
    calls.push({
      name: redactSensitiveText(record.name).slice(0, 300),
      kind: typeof record.kind === "number" ? record.kind : undefined,
      detail: typeof record.detail === "string" ? redactSensitiveText(record.detail).slice(0, 500) : undefined,
      location,
      from_ranges: ranges
    });
  }
  return { calls, truncated: visible > calls.length };
}

function normalizeDiagnostics(raw: unknown): LspDiagnostic[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const params = raw as Record<string, unknown>;
  if (!Array.isArray(params.diagnostics)) return [];
  const out: LspDiagnostic[] = [];
  for (const item of params.diagnostics.slice(0, 500)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const range = normalizeRange(record.range);
    if (!range || typeof record.message !== "string") continue;
    out.push({
      message: redactSensitiveText(record.message).slice(0, 2_000),
      severity: typeof record.severity === "number" ? record.severity : undefined,
      source: typeof record.source === "string" ? redactSensitiveText(record.source).slice(0, 200) : undefined,
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
      ...range
    });
  }
  return out;
}

export class LspManager {
  private readonly servers = new Map<string, ManagedServer>();
  private readonly crashCounts = new Map<string, number>();
  private disposed = false;

  constructor(private readonly config: LocalWorkspaceBridgeConfig) {}

  private async startServer(workspace: Workspace, provider: Provider): Promise<ManagedServer> {
    if (this.disposed) throw new LocalWorkspaceBridgeError("LSP manager is shutting down.");
    const key = providerKey(workspace, provider);
    const existing = this.servers.get(key);
    if (existing && !existing.client.isClosed) return existing;
    const crashes = this.crashCounts.get(key) ?? 0;
    const maxRestarts = provider.maxRestarts ?? 3;
    if (crashes > maxRestarts) {
      throw new LocalWorkspaceBridgeError(`LSP server '${provider.name}' exceeded max crash recovery attempts (${maxRestarts}).`);
    }

    let managed!: ManagedServer;
    const serverRoot = provider.workspaceFolder ?? workspace.root;
    const client = new LspProcess(serverRoot, provider, (unexpected) => {
      if (this.servers.get(key) === managed) this.servers.delete(key);
      if (unexpected) this.crashCounts.set(key, (this.crashCounts.get(key) ?? 0) + 1);
    });
    managed = {
      key,
      workspaceRoot: workspace.root,
      provider,
      client,
      openDocuments: new Map(),
      diagnostics: new Map(),
      startedAt: Date.now()
    };
    this.servers.set(key, managed);

    const rootUri = pathToFileURL(serverRoot).href;
    try {
      await client.request("initialize", {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: path.basename(serverRoot) }],
        initializationOptions: provider.initializationOptions,
        capabilities: {
          general: { positionEncodings: ["utf-16"] },
          textDocument: {
            publishDiagnostics: { relatedInformation: true },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            callHierarchy: {}
          },
          workspace: { symbol: { resolveSupport: { properties: ["location.range"] } } }
        }
      }, provider.startupTimeout ?? DEFAULT_TIMEOUT_MS);
      client.notify("initialized", {});
      client.notify("workspace/didChangeConfiguration", { settings: provider.settings ?? {} });
      this.crashCounts.set(key, 0);
      client.onNotification("textDocument/publishDiagnostics", (params) => {
        if (!params || typeof params !== "object" || Array.isArray(params)) return;
        const uri = (params as Record<string, unknown>).uri;
        if (typeof uri !== "string") return;
        managed.diagnostics.set(normalizedUriKey(uri), normalizeDiagnostics(params));
      });
      return managed;
    } catch (error) {
      this.servers.delete(key);
      await client.close();
      throw error;
    }
  }

  private async openOrSync(workspace: Workspace, absolutePath: string, text?: string): Promise<{ server: ManagedServer; uri: string; version: number; reused: boolean }> {
    const provider = providerFor(this.config, workspace, absolutePath);
    const key = providerKey(workspace, provider);
    const reused = Boolean(this.servers.get(key) && !this.servers.get(key)!.client.isClosed);
    const server = await this.startServer(workspace, provider);
    const content = text ?? await fsp.readFile(absolutePath, "utf8");
    if (Buffer.byteLength(content, "utf8") > MAX_LSP_FILE_BYTES) {
      throw new LocalWorkspaceBridgeError("File exceeds the 10 MiB LSP safety limit.");
    }
    const uri = pathToFileURL(absolutePath).href;
    const digest = sha256(content);
    const current = server.openDocuments.get(uri);
    if (!current) {
      const version = 1;
      server.client.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: provider.languageId, version, text: content }
      });
      server.openDocuments.set(uri, { uri, version, sha256: digest });
      return { server, uri, version, reused };
    }
    if (current.sha256 !== digest) {
      const version = current.version + 1;
      server.client.notify("textDocument/didChange", {
        textDocument: { uri, version },
        contentChanges: [{ text: content }]
      });
      server.openDocuments.set(uri, { uri, version, sha256: digest });
      return { server, uri, version, reused };
    }
    return { server, uri, version: current.version, reused };
  }

  async syncFile(workspace: Workspace, absolutePath: string, text?: string, saved = true): Promise<void> {
    let synced: { server: ManagedServer; uri: string; version: number; reused: boolean };
    try {
      synced = await this.openOrSync(workspace, absolutePath, text);
    } catch (error) {
      if (error instanceof LocalWorkspaceBridgeError && /supports Python|10 MiB/.test(error.message)) return;
      throw error;
    }
    if (saved) {
      synced.server.client.notify("textDocument/didSave", { textDocument: { uri: synced.uri } });
    }
  }

  async query(guard: PathGuard, workspace: Workspace, query: LspQuery): Promise<LspResult> {
    const target = guard.resolve(workspace, query.path);
    const maxResults = Math.max(1, Math.min(query.maxResults ?? 50, 200));
    const { server, uri, version, reused } = await this.openOrSync(workspace, target.absPath);
    const base: Omit<LspResult, "operation"> = {
      path: target.relPath,
      line: query.line,
      character: query.character,
      provider: server.provider.name,
      server_reused: reused,
      document_version: version
    };

    try {
      if (query.operation === "diagnostics") {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return { operation: query.operation, ...base, diagnostics: server.diagnostics.get(normalizedUriKey(uri)) ?? [] };
      }

      if (query.operation === "workspaceSymbol") {
        const raw = await server.client.request("workspace/symbol", { query: query.query ?? "" });
        const normalized = normalizeSymbols(raw, guard, workspace, uri, maxResults);
        return { operation: query.operation, ...base, ...normalized };
      }

      if (query.operation === "documentSymbol") {
        const raw = await server.client.request("textDocument/documentSymbol", { textDocument: { uri } });
        const normalized = normalizeSymbols(raw, guard, workspace, uri, maxResults);
        return { operation: query.operation, ...base, ...normalized };
      }

      const position = requirePosition(query);
      const positionParams = {
        textDocument: { uri },
        position: { line: position.line - 1, character: position.character - 1 }
      };

      if (query.operation === "hover") {
        const raw = await server.client.request("textDocument/hover", positionParams);
        return { operation: query.operation, ...base, hover: normalizeHover(raw) };
      }

      if (query.operation === "prepareCallHierarchy" || query.operation === "incomingCalls" || query.operation === "outgoingCalls") {
        const prepared = await server.client.request("textDocument/prepareCallHierarchy", positionParams);
        if (query.operation === "prepareCallHierarchy") {
          const normalized = normalizeCallItems(prepared, guard, workspace, maxResults, "plain");
          return { operation: query.operation, ...base, ...normalized };
        }
        const items = Array.isArray(prepared) ? prepared : [];
        if (!items.length) return { operation: query.operation, ...base, calls: [] };
        const method = query.operation === "incomingCalls" ? "callHierarchy/incomingCalls" : "callHierarchy/outgoingCalls";
        const raw = await server.client.request(method, { item: items[0] });
        const normalized = normalizeCallItems(raw, guard, workspace, maxResults, query.operation === "incomingCalls" ? "incoming" : "outgoing");
        return { operation: query.operation, ...base, ...normalized };
      }

      const method =
        query.operation === "goToDefinition" ? "textDocument/definition" :
        query.operation === "findReferences" ? "textDocument/references" :
        "textDocument/implementation";
      const params: Record<string, unknown> = { ...positionParams };
      if (query.operation === "findReferences") params.context = { includeDeclaration: true };
      const raw = await server.client.request(method, params);
      const normalized = normalizeLocations(raw, guard, workspace, maxResults);
      return { operation: query.operation, ...base, ...normalized };
    } catch (error) {
      if (server.client.isClosed) {
        this.servers.delete(server.key);
      }
      const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
      throw new LocalWorkspaceBridgeError(`LSP request failed (${server.provider.name}): ${message}`);
    }
  }

  async reconcile(allowedRoots: string[]): Promise<void> {
    const allowed = allowedRoots.map((root) => path.resolve(root));
    for (const [key, server] of this.servers) {
      if (!allowed.some((root) => isSubpath(server.workspaceRoot, root))) {
        this.servers.delete(key);
        await server.client.close();
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const servers = [...this.servers.values()];
    this.servers.clear();
    this.crashCounts.clear();
    await Promise.allSettled(servers.map((server) => server.client.close()));
  }
}

const managers = new WeakMap<LocalWorkspaceBridgeConfig, LspManager>();

export function getLspManager(config: LocalWorkspaceBridgeConfig): LspManager {
  let manager = managers.get(config);
  if (!manager) {
    manager = new LspManager(config);
    managers.set(config, manager);
  }
  return manager;
}

export async function syncLspFile(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  text?: string
): Promise<void> {
  const target = guard.resolve(workspace, filePath);
  await getLspManager(config).syncFile(workspace, target.absPath, text, true);
}

export async function queryLsp(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  query: LspQuery
): Promise<LspResult> {
  return await getLspManager(config).query(guard, workspace, query);
}
