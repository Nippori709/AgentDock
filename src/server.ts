import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import { WorkspaceManager, PathGuard, LocalWorkspaceBridgeError, type Workspace } from "./guard.js";
import { repoTree, readTextFile, writeTextFile, editTextFile, makeUnifiedDiff } from "./fsOps.js";
import {
  DEFAULT_IMAGE_PREVIEW_DIMENSION,
  DEFAULT_TILE_OVERLAP,
  EXPERIMENTAL_IMAGE_MAX_DIMENSION,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_OUTPUT_BYTES,
  SAFE_IMAGE_MAX_DIMENSION,
  getImageInfo,
  readImageCrop,
  readImageFile,
  readImageTile
} from "./imageOps.js";
import { searchWorkspace } from "./searchOps.js";
import { runBash } from "./bashOps.js";
import { gitDiff, gitDiffNumstat, gitDiffStatus, gitLog, gitStatus } from "./gitOps.js";
import { workspaceSummary } from "./workspaceOps.js";
import { localWorkspaceBridgeInventory, loadSkill } from "./capabilitiesOps.js";
import { listCodexSessions, readCodexSession } from "./codexSessions.js";
import { TOOL_CARD_MIME_TYPE, TOOL_CARD_URI, toolCardWidgetHtml } from "./toolCardWidget.js";
import { hasSecretValue, redactSensitiveText, redactStructured } from "./redact.js";
import { inspectWorkspace, invalidateWorkspaceAnalysis, reviewWorkspaceChanges, type AnalysisMode } from "./analysis/index.js";

const STRUCTURED_STRING_MAX_CHARS = 60_000;
const READ_RESPONSE_MAX_BYTES = 60_000;
const INSPECT_RESPONSE_MAX_BYTES = 36_000;
const INSPECT_HARD_TRANSPORT_BUDGET_BYTES = 48_000;
const require = createRequire(import.meta.url);
const packagePath = require.resolve("../package.json");
const packageInfo = require(packagePath) as { name: string; version: string };
const packageRoot = path.dirname(packagePath);

function runtimeDiagnostics(): Record<string, unknown> {
  const commit = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
  let buildTime = "unknown";
  try { buildTime = new Date(require("node:fs").statSync(new URL(import.meta.url)).mtimeMs).toISOString(); } catch {}
  return {
    version: packageInfo.version,
    git_commit: commit.status === 0 ? commit.stdout.trim() : "unknown",
    build_time: buildTime,
    package_path: packagePath,
    entrypoint: process.argv[1] ? path.resolve(process.argv[1]) : "unknown",
    protocol_schema_version: 1
  };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(`${error.name}: ${error.message}`);
  return redactSensitiveText(String(error));
}

function compactStructuredContent<T>(value: T, depth = 0): T {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (value.length <= STRUCTURED_STRING_MAX_CHARS) return value as T;
    return `${value.slice(0, STRUCTURED_STRING_MAX_CHARS)}\n...[structured field truncated to ${STRUCTURED_STRING_MAX_CHARS} chars]` as T;
  }
  if (Array.isArray(value)) return value.map((item) => compactStructuredContent(item, depth + 1)) as T;
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = compactStructuredContent(item, depth + 1);
  }
  return out as T;
}

function textResult(text: string, structuredContent: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): any {
  return {
    content: [{ type: "text", text: redactSensitiveText(text) }],
    structuredContent: redactStructured(structuredContent),
    _meta: meta
  };
}

function countTextLines(value: string | undefined): number {
  if (!value) return 0;
  return value.split(/\r?\n/).filter((line) => line.length > 0).length;
}

function bashTextResult(config: LocalWorkspaceBridgeConfig, result: Awaited<ReturnType<typeof runBash>>): string {
  if (config.bashTranscript === "full") {
    return `# Bash\n\n\`\`\`bash\n$ ${result.command}\n\`\`\`\n\nCWD: ${result.cwd}\nExit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}\nDuration: ${result.durationMs} ms\n\n## stdout\n\n\`\`\`text\n${result.stdout || ""}\n\`\`\`\n\n## stderr\n\n\`\`\`text\n${result.stderr || ""}\n\`\`\``;
  }

  const stdoutLines = countTextLines(result.stdout);
  const stderrLines = countTextLines(result.stderr);
  return [
    "# Bash",
    "",
    `\`${result.command}\``,
    "",
    `CWD: ${result.cwd}`,
    `Exit: ${result.exitCode}${result.signal ? ` (${result.signal})` : ""}`,
    `Duration: ${result.durationMs} ms`,
    `Output: stdout ${stdoutLines} line${stdoutLines === 1 ? "" : "s"}, stderr ${stderrLines} line${stderrLines === 1 ? "" : "s"}.`,
    "",
    "Raw stdout/stderr are in the structured LocalWorkspaceBridge card. Start with `--bash-transcript full` to print raw output in chat."
  ].join("\n");
}

function errorResult(error: unknown): any {
  return {
    isError: true,
    content: [{ type: "text", text: errorText(error) }],
    structuredContent: { error: errorText(error) }
  };
}

function validateToolArgs(name: string, options: Record<string, unknown>, args: unknown): any {
  const inputSchema = options.inputSchema;
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema)) return args ?? {};
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, value] of Object.entries(inputSchema)) {
    if (value && typeof (value as { safeParse?: unknown }).safeParse === "function") {
      shape[key] = value as z.ZodTypeAny;
    }
  }
  if (!Object.keys(shape).length) return {};
  const parsed = z.object(shape).safeParse(args ?? {});
  if (parsed.success) return parsed.data;
  const details = parsed.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "arguments"}: ${issue.message}`)
    .join("; ");
  throw new LocalWorkspaceBridgeError(`Invalid arguments for ${name}: ${details}`);
}

function tagToolResult(result: any, name: string, options: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured = result.structuredContent;
  const base =
    structured && typeof structured === "object" && !Array.isArray(structured)
      ? structured
      : {};
  const tagged = {
    local_workspace_bridge_tool: name,
    local_workspace_bridge_title: options.title ?? name,
    ...base
  };
  const meta = (options._meta as Record<string, unknown> | undefined) ?? {};
  result.structuredContent = meta.ui || meta["openai/outputTemplate"] ? compactStructuredContent(tagged) : tagged;
  return result;
}

function toolCardMeta(): Record<string, unknown> {
  return {
    ui: { resourceUri: TOOL_CARD_URI },
    "openai/outputTemplate": TOOL_CARD_URI
  };
}

const TOOL_CARD_RENDER_TOOL_NAMES = new Set<string>([
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "show_changes",
  "git_status",
  "bash"
]);

const OPTIONAL_TOOL_CARD_META = [
  "ui",
  "openai/outputTemplate",
  "openai/toolInvocation/invoking",
  "openai/toolInvocation/invoked"
] as const;

function usesToolCard(config: LocalWorkspaceBridgeConfig, name: string): boolean {
  return config.toolCards && TOOL_CARD_RENDER_TOOL_NAMES.has(name);
}

function descriptorOptionsForConfig(config: LocalWorkspaceBridgeConfig, name: string, options: Record<string, unknown>): Record<string, unknown> {
  if (usesToolCard(config, name)) return options;
  const meta = { ...((options._meta as Record<string, unknown> | undefined) ?? {}) };
  for (const key of OPTIONAL_TOOL_CARD_META) delete meta[key];
  return { ...options, _meta: meta };
}

function toolCallLoggingEnabled(): boolean {
  return process.env.LOCALWORKSPACEBRIDGE_LOG_TOOL_CALLS === "1" || process.env.LOCALWORKSPACEBRIDGE_LOG_REQUESTS === "1";
}

const IDEMPOTENT_RETRY_TOOLS = new Set(["inspect_workspace", "search", "read", "read_image", "tree"]);

function shortHash(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function flattenedErrors(error: unknown): Array<{ type: string; message: string }> {
  const output: Array<{ type: string; message: string }> = [];
  const visit = (item: unknown): void => {
    if (item && typeof item === "object" && Array.isArray((item as { errors?: unknown }).errors)) {
      for (const nested of (item as { errors: unknown[] }).errors) visit(nested);
      return;
    }
    output.push({
      type: item instanceof Error ? item.name : typeof item,
      message: redactSensitiveText(item instanceof Error ? item.message : String(item)).slice(0, 500)
    });
  };
  visit(error);
  return output.slice(0, 12);
}

function isTransientReadError(error: unknown): boolean {
  const messages = flattenedErrors(error).map((item) => `${item.type}: ${item.message}`).join("\n");
  return /(?:ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR|socket|connection|TaskGroup|ExceptionGroup)/i.test(messages);
}

function logToolCall(name: string, status: "ok" | "error", started: number, details: Record<string, unknown> = {}): void {
  if (!toolCallLoggingEnabled()) return;
  console.error(`[LocalWorkspaceBridgeTool] ${name} ${status} ${Date.now() - started}ms ${JSON.stringify(redactStructured(details))}`);
}

function registerToolCardResource(server: McpServer, config: LocalWorkspaceBridgeConfig): void {
  if (config.connectionTest) return;
  const s = server as any;
  if (typeof s.registerResource !== "function") {
    throw new Error("Unsupported MCP SDK: LocalWorkspaceBridge widgets require registerResource.");
  }

  const registerUri = (uri: string, name: string): void => {
    s.registerResource(
      name,
      uri,
      {
        title: "LocalWorkspaceBridge Tool Card",
        description: "Compact visual renderer for workspace orientation, source changes, and verification results.",
        mimeType: TOOL_CARD_MIME_TYPE
      },
      async () => ({
        contents: [
          {
            uri,
            mimeType: TOOL_CARD_MIME_TYPE,
            text: toolCardWidgetHtml,
            _meta: {
              ui: {
                prefersBorder: true,
                domain: config.widgetDomain,
                csp: {
                  connectDomains: [],
                  resourceDomains: []
                }
              },
              "openai/widgetDescription": "Renders workspace orientation, diagnostics, file diffs, change reviews, and terminal checks as compact developer cards with bounded previews.",
              "openai/widgetPrefersBorder": true,
              "openai/widgetDomain": config.widgetDomain,
              "openai/widgetCSP": {
                connect_domains: [],
                resource_domains: []
              }
            }
          }
        ]
      })
    );
  };

  registerUri(TOOL_CARD_URI, "local-workspace-bridge-tool-card");
}

type CodexToolHandler = (args: any) => Promise<any> | any;

const SUPERTOOL_NAME = "local-workspace-bridge";
const SUPERTOOL_ACTION_ALIASES: Record<string, string> = {
  actions: "list_actions",
  config: "server_config",
  self_test: "local_workspace_bridge_self_test",
  inventory: "local_workspace_bridge_inventory",
  open: "open_current_workspace",
  snapshot: "workspace_snapshot",
  changes: "show_changes"
};

const registeredToolHandlersByServer = new WeakMap<object, Map<string, CodexToolHandler>>();

function rememberRegisteredToolHandler(server: McpServer, name: string, handler: CodexToolHandler): void {
  const key = server as object;
  const handlers = registeredToolHandlersByServer.get(key) ?? new Map<string, CodexToolHandler>();
  if (!registeredToolHandlersByServer.has(key)) registeredToolHandlersByServer.set(key, handlers);
  handlers.set(name, handler);
}

function registeredToolHandler(server: McpServer, name: string): CodexToolHandler | undefined {
  return registeredToolHandlersByServer.get(server as object)?.get(name);
}

function normalizeSupertoolAction(value: unknown): string {
  const raw = String(value ?? "list_actions").trim();
  const normalized = raw.toLowerCase().replace(/[\s-]+/g, "_");
  return SUPERTOOL_ACTION_ALIASES[normalized] ?? normalized;
}


function assertWriteToolAllowed(config: LocalWorkspaceBridgeConfig, relPath: string): void {
  if (config.writeMode === "workspace") return;
  throw new LocalWorkspaceBridgeError(`write/edit/apply_patch tools are disabled because write mode is off. Refused path: ${relPath}`);
}

function registerToolCompat(
  config: LocalWorkspaceBridgeConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: (args: any) => Promise<any> | any
): void {
  const wrapped = async (args: any, context?: any) => {
    const started = Date.now();
    const diagnostics = {
      request_id: context?.requestId ?? context?.mcpReq?.id ?? null,
      tool_name: name,
      cursor_hash: shortHash(args?.cursor) ?? null
    };
    try {
      const result = tagToolResult(await handler(args ?? {}), name, options);
      logToolCall(name, result?.isError ? "error" : "ok", started, {
        ...diagnostics,
        response_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
        retry_count: 0
      });
      return result;
    } catch (error) {
      const retryAllowed = IDEMPOTENT_RETRY_TOOLS.has(name) || (name === "show_changes" && args?.include_diff === false);
      if (retryAllowed && isTransientReadError(error)) {
        try {
          const result = tagToolResult(await handler(args ?? {}), name, options);
          logToolCall(name, result?.isError ? "error" : "ok", started, {
            ...diagnostics,
            response_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
            retry_count: 1,
            first_error: flattenedErrors(error)
          });
          return result;
        } catch (retryError) {
          error = new AggregateError([error, retryError], `Transient ${name} call failed after one retry`);
        }
      }
      const result = tagToolResult(errorResult(error), name, options);
      logToolCall(name, "error", started, {
        ...diagnostics,
        response_bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
        retry_count: retryAllowed ? 1 : 0,
        exception_group_size: flattenedErrors(error).length,
        sub_exceptions: flattenedErrors(error)
      });
      return result;
    }
  };

  const securitySchemes = config.publicUrl && config.authToken
    ? [{ type: "oauth2", scopes: ["mcp:tools"] }]
    : [{ type: "noauth" }];
  const rawInputSchema = options.inputSchema;
  const inputSchema = rawInputSchema && typeof rawInputSchema === "object" && !Array.isArray(rawInputSchema) &&
    typeof (rawInputSchema as { safeParse?: unknown }).safeParse !== "function"
      ? z.object(rawInputSchema as Record<string, z.ZodTypeAny>)
      : rawInputSchema;
  const fullOptions: Record<string, unknown> = {
    ...options,
    inputSchema,
    securitySchemes,
    _meta: {
      ...(options._meta as Record<string, unknown> | undefined),
      securitySchemes
    }
  };

  const s = server as any;
  if (typeof s.registerTool === "function") {
    s.registerTool(name, fullOptions, wrapped);
    return;
  }

  if (typeof s.tool === "function") {
    s.tool(name, (fullOptions.description as string | undefined) ?? name, fullOptions.inputSchema ?? {}, wrapped);
    return;
  }

  throw new Error("Unsupported MCP SDK: McpServer has neither registerTool nor tool.");
}

const MINIMAL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "local_workspace_bridge_self_test",
  "open_current_workspace",
  "open_workspace",
  "read",
  "read_image",
  "image_info",
  "read_image_crop",
  "read_image_tile",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "show_changes"
] as const;

const STANDARD_TOOL_NAMES = [
  ...MINIMAL_TOOL_NAMES,
  "inspect_workspace",
  "tree",
  "search",
  "load_skill",
  "list_workspaces",
  "close_workspace",
  "set_default_workspace"
] as const;

const FULL_TOOL_NAMES = [
  SUPERTOOL_NAME,
  "server_config",
  "local_workspace_bridge_self_test",
  "local_workspace_bridge_inventory",
  "load_skill",
  "list_workspaces",
  "close_workspace",
  "set_default_workspace",
  "open_current_workspace",
  "open_workspace",
  "workspace_snapshot",
  "inspect_workspace",
  "tree",
  "search",
  "read",
  "read_image",
  "image_info",
  "read_image_crop",
  "read_image_tile",
  "write",
  "edit",
  "apply_patch",
  "bash",
  "git_status",
  "git_diff",
  "show_changes",
  
] as const;

const CONNECTION_TEST_HIDDEN_TOOLS = new Set<string>([
  SUPERTOOL_NAME,
  "local_workspace_bridge_self_test",
  "write",
  "edit",
  "apply_patch",
  "bash"
]);

function codexSessionToolNames(config: LocalWorkspaceBridgeConfig): string[] {
  if (config.codexSessions === "off") return [];
  return config.codexSessions === "read"
    ? ["codex_sessions", "read_codex_session"]
    : ["codex_sessions"];
}

function toolNamesForMode(config: LocalWorkspaceBridgeConfig): string[] {
  const names: string[] =
    config.toolMode === "full"
      ? [...FULL_TOOL_NAMES]
      : config.toolMode === "minimal"
        ? [...MINIMAL_TOOL_NAMES]
        : [...STANDARD_TOOL_NAMES];
  if (config.bashMode === "off") {
    const bashIndex = names.indexOf("bash");
    if (bashIndex !== -1) names.splice(bashIndex, 1);
  }
  if (config.writeMode !== "workspace") {
    for (const writeTool of ["write", "edit", "apply_patch"]) {
      const toolIndex = names.indexOf(writeTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  if (!config.analysisEnabled) {
    for (const analysisTool of ["inspect_workspace"]) {
      const analysisIndex = names.indexOf(analysisTool);
      if (analysisIndex !== -1) names.splice(analysisIndex, 1);
    }
  }
  if (config.connectionTest) {
    for (const hiddenTool of CONNECTION_TEST_HIDDEN_TOOLS) {
      const toolIndex = names.indexOf(hiddenTool);
      if (toolIndex !== -1) names.splice(toolIndex, 1);
    }
  }
  for (const name of codexSessionToolNames(config)) {
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const MINIMAL_TOOLS = new Set<string>(MINIMAL_TOOL_NAMES);
const STANDARD_TOOLS = new Set<string>(STANDARD_TOOL_NAMES);
const registeredToolNamesByServer = new WeakMap<object, string[]>();

function rememberRegisteredTool(server: McpServer, name: string): void {
  const key = server as object;
  const names = registeredToolNamesByServer.get(key) ?? [];
  if (!registeredToolNamesByServer.has(key)) registeredToolNamesByServer.set(key, names);
  if (!names.includes(name)) names.push(name);
}

function registeredToolNames(server: McpServer): string[] {
  return [...(registeredToolNamesByServer.get(server as object) ?? [])];
}

function shouldRegisterTool(config: LocalWorkspaceBridgeConfig, name: string): boolean {
  if (config.connectionTest && CONNECTION_TEST_HIDDEN_TOOLS.has(name)) return false;
  if (name === "bash" && config.bashMode === "off") return false;
  if ((name === "write" || name === "edit" || name === "apply_patch") && config.writeMode !== "workspace") return false;
  if (name === "codex_sessions") return config.codexSessions !== "off";
  if (name === "read_codex_session") return config.codexSessions === "read";
  if (name === "inspect_workspace" && !config.analysisEnabled) return false;
  if (config.toolMode === "full") return true;
  if (config.toolMode === "minimal") return MINIMAL_TOOLS.has(name);
  return STANDARD_TOOLS.has(name);
}

function registerCodexTool(
  config: LocalWorkspaceBridgeConfig,
  server: McpServer,
  name: string,
  options: Record<string, unknown>,
  handler: CodexToolHandler
): void {
  if (!shouldRegisterTool(config, name)) return;
  const validatedHandler: CodexToolHandler = (args) => handler(validateToolArgs(name, options, args));
  registerToolCompat(config, server, name, descriptorOptionsForConfig(config, name, options), validatedHandler);
  rememberRegisteredTool(server, name);
  rememberRegisteredToolHandler(server, name, validatedHandler);
}

function serverInstructions(config: LocalWorkspaceBridgeConfig): string {
  const editInstruction =
    config.connectionTest
      ? "4. Connection test mode is read-only. Write and patch tools are unavailable."
      : config.writeMode === "workspace"
      ? "4. Edit source files with write/edit/apply_patch. After edits, call show_changes once for git status, diff stats, and review diff."
      : "4. Write/edit/apply_patch tools are disabled. Do not attempt direct file writes.";
  const bashInstruction =
    config.bashMode === "off"
      ? "5. Bash is disabled and the bash tool is unavailable. Do not attempt shell commands."
      : "5. Use bash only for meaningful verification commands such as npm test, npm run build, lint, typecheck, or an existing project script.";

  return [
    "LocalWorkspaceBridge connects ChatGPT to one local development workspace.",
    "",
    "Preferred workflow:",
    "1. Start with open_current_workspace. Use open_workspace only when the user gives a different root or asks to switch folders.",
    "2. Follow any AGENTS.md-style instructions returned by the workspace open call before editing files.",
    "3. Inspect text with tree, search, and read. For .jpg, .jpeg, .png, or .webp files, use read_image so the visual model receives native image content; never use text read or bash as a substitute for image reading.",
    editInstruction,
    bashInstruction,
    "6. Keep tool calls minimal. Prefer one targeted search plus show_changes instead of repeated broad inspection calls.",
    config.codexSessions !== "off"
      ? `7. Codex session history access is enabled in ${config.codexSessions} mode. Use it only when the user asks for local Codex session history.`
      : "",
    config.requireBashSession && config.bashSessionId
      ? `8. Bash session guard is enabled. Every bash call must include session_id="${config.bashSessionId}".`
      : config.bashSessionId
        ? `8. Bash session label for this server is "${config.bashSessionId}".`
        : "",
    "",
    `Current modes: tool=${config.toolMode}, bash=${config.bashMode}, write=${config.writeMode}.`
  ].filter(Boolean).join("\n");
}

function limitInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function parseBool(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === undefined || value === null) return fallback;
  return ["1", "true", "yes", "y"].includes(String(value).toLowerCase());
}

function diffBlock(diff: string): string {
  return `\n\n\`\`\`diff\n${diff}\n\`\`\``;
}

function diffStats(diff: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions, changed: Boolean(diff.trim()) };
}

const reviewCheckpoints = new Map<string, string>();

function reviewCheckpointKey(workspace: Workspace, options: { path?: string; staged: boolean }): string {
  return `${workspace.id}\0${options.path ?? ""}\0${options.staged ? "staged" : "unstaged"}`;
}

function reviewFingerprint(status: string, diff: string): string {
  return createHash("sha256").update(status).update("\0").update(diff).digest("hex");
}

async function untrackedReviewFingerprint(config: LocalWorkspaceBridgeConfig, guard: PathGuard, workspace: Workspace, changedFiles: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const line of changedFiles) {
    const match = line.match(/^\?\?\s+(.+)$/);
    if (!match) continue;
    const relPath = match[1];
    hash.update(relPath).update("\0");
    try {
      const resolved = guard.resolve(workspace, relPath);
      const stat = await fsp.stat(resolved.absPath);
      hash.update(String(stat.size)).update("\0").update(String(Math.floor(stat.mtimeMs))).update("\0");
      if (stat.isFile() && stat.size <= config.maxReadBytes) {
        hash.update(await fsp.readFile(resolved.absPath));
      }
    } catch (error) {
      hash.update(errorText(error));
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function normalizeGitOutput(output: string): string {
  return output.trim() === "(no output)" ? "" : output;
}

function decodeGitQuotedPath(pathText: string): string {
  const input = pathText.startsWith('"') && pathText.endsWith('"') ? pathText.slice(1, -1) : pathText;
  let decoded = "";
  let escapedBytes: number[] = [];
  const flushEscapedBytes = () => {
    if (!escapedBytes.length) return;
    decoded += Buffer.from(escapedBytes).toString("utf8");
    escapedBytes = [];
  };
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    if (char !== "\\") {
      flushEscapedBytes();
      decoded += char;
      continue;
    }
    i += 1;
    const escaped = input[i];
    if (escaped === undefined) throw new LocalWorkspaceBridgeError(`Invalid quoted Git path: ${pathText}`);
    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (let j = 0; j < 2 && i + 1 < input.length && /[0-7]/.test(input[i + 1]); j += 1) {
        i += 1;
        octal += input[i];
      }
      escapedBytes.push(Number.parseInt(octal, 8));
    } else {
      flushEscapedBytes();
      decoded += ({ a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" } as Record<string, string>)[escaped] ?? escaped;
    }
  }
  flushEscapedBytes();
  return decoded;
}

function numstatStats(numstat: string): { additions: number; deletions: number; changed: boolean } {
  let additions = 0;
  let deletions = 0;
  let changed = false;
  for (const line of numstat.split(/\r?\n/)) {
    const match = line.match(/^(\d+|-)\s+(\d+|-)\s+/);
    if (!match) continue;
    changed = true;
    if (match[1] !== "-") additions += Number(match[1]);
    if (match[2] !== "-") deletions += Number(match[2]);
  }
  return { additions, deletions, changed };
}

type InspectPageType = "files" | "symbols" | "relationships";
interface InspectCursor {
  phase?: InspectPageType;
  fileIndex: number;
  symbolIndex: number;
  relationshipIndex: number;
}

function inspectCursor(value: unknown): InspectCursor {
  if (typeof value !== "string" || !value.trim()) return { fileIndex: 0, symbolIndex: 0, relationshipIndex: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const offset = (key: string) => Number.isInteger(parsed?.[key]) && parsed[key] >= 0 ? parsed[key] : 0;
    const phase = ["files", "symbols", "relationships"].includes(parsed?.phase) ? parsed.phase as InspectPageType : undefined;
    return {
      ...(phase ? { phase } : {}),
      fileIndex: Number.isInteger(parsed?.fileIndex) ? offset("fileIndex") : offset("files"),
      symbolIndex: Number.isInteger(parsed?.symbolIndex) ? offset("symbolIndex") : offset("symbols"),
      relationshipIndex: Number.isInteger(parsed?.relationshipIndex) ? offset("relationshipIndex") : offset("relationships")
    };
  } catch {
    throw new LocalWorkspaceBridgeError("Invalid inspect_workspace cursor.");
  }
}

function encodeInspectCursor(cursor: InspectCursor): string {
  return Buffer.from(JSON.stringify({ version: 2, ...cursor }), "utf8").toString("base64url");
}

async function untrackedReviewDiff(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  changedFiles: string[],
  includeDiff = true
): Promise<{ diff: string; files: Array<Record<string, unknown>>; warnings: string[] }> {
  const sections: string[] = [];
  const files: Array<Record<string, unknown>> = [];
  const warnings: string[] = [];
  const limit = Math.min(config.maxOutputBytes, 60_000);
  let used = 0;
  for (const line of changedFiles) {
    const match = line.match(/^\?\?\s+(.+)$/);
    if (!match) continue;
    const relPath = decodeGitQuotedPath(match[1]);
    try {
      const resolved = guard.resolve(workspace, relPath);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) {
        files.push({ path: relPath, kind: "non_file", bytes: stat.size });
        continue;
      }
      try {
        await guard.assertTextFile(resolved.absPath, Math.min(config.maxReadBytes, limit));
        const text = await fsp.readFile(resolved.absPath, "utf8");
        const normalized = text.replace(/\r\n/g, "\n");
        const lines = normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n") : normalized.split("\n");
        if (!includeDiff) {
          files.push({ path: relPath, kind: "text", bytes: stat.size, additions: lines.length, diff_included: false });
          continue;
        }
        const body = [
          "--- /dev/null",
          `+++ b/${relPath}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((content) => `+${content}`)
        ].join("\n");
        const bytes = Buffer.byteLength(body, "utf8");
        if (used + bytes > limit) {
          warnings.push(`Untracked diff output was limited before ${relPath}. Read that file directly for complete review.`);
          files.push({ path: relPath, kind: "text", bytes: stat.size, diff_included: false });
          continue;
        }
        sections.push(redactSensitiveText(body));
        used += bytes;
        files.push({ path: relPath, kind: "text", bytes: stat.size, additions: lines.length, diff_included: true });
      } catch (error) {
        const handle = await fsp.open(resolved.absPath, "r");
        const hash = createHash("sha256");
        const hashLimit = Math.min(stat.size, 16 * 1024 * 1024);
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        try {
          while (offset < hashLimit) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, hashLimit - offset), offset);
            if (!bytesRead) break;
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
          }
        } finally {
          await handle.close();
        }
        files.push({
          path: relPath,
          kind: "binary_or_large",
          bytes: stat.size,
          sha256: hash.digest("hex"),
          hash_scope: offset === stat.size ? "full" : `first_${offset}_bytes`,
          reason: errorText(error)
        });
        warnings.push(`No virtual text diff for ${relPath}; binary/large-file metadata is available.`);
      }
    } catch (error) {
      warnings.push(`Unable to inspect untracked path ${relPath}: ${errorText(error)}`);
    }
  }
  return { diff: sections.join("\n"), files, warnings };
}

function stripPatchPathComponents(filePath: string, stripComponents: number): string {
  if (path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) return filePath;
  let stripped = filePath;
  for (let i = 0; i < stripComponents; i += 1) {
    const slash = stripped.indexOf("/");
    if (slash < 0) return stripped;
    stripped = stripped.slice(slash + 1);
  }
  return stripped;
}

function normalizePatchPath(rawPath: string, stripComponents = 1): string | undefined {
  const raw = rawPath.trim().split("\t")[0]?.trim();
  if (!raw || raw === "/dev/null") return undefined;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? decodeGitQuotedPath(raw.slice(1, -1)) : raw;
  return stripPatchPathComponents(unquoted, stripComponents);
}

function patchHasSymlinkMode(patch: string): boolean {
  return patch.split(/\r?\n/).some((line) => /^(?:new|old|deleted) file mode 120000\s*$/.test(line) || /^new mode 120000\s*$/.test(line) || /^old mode 120000\s*$/.test(line));
}

function patchTouchedPaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const normalized = normalizePatchPath(line.slice(4));
      if (normalized) paths.add(normalized);
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
      const normalized = normalizePatchPath(line.replace(/^(?:rename|copy) (?:from|to) /, ""), 0);
      if (normalized) paths.add(normalized);
    }
  }
  return [...paths];
}

interface CodexPatchOperation { kind: "Update" | "Add" | "Delete"; path: string; lines: string[] }

function parseCodexPatch(patch: string): CodexPatchOperation[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") throw new LocalWorkspaceBridgeError("Invalid Codex Patch: expected '*** Begin Patch' on line 1.");
  const operations: CodexPatchOperation[] = [];
  let index = 1;
  while (index < lines.length) {
    if (lines[index].trim() === "*** End Patch") return operations;
    const header = lines[index].match(/^\*\*\* (Update|Add|Delete) File:\s*(.+)$/);
    if (!header) throw new LocalWorkspaceBridgeError(`Invalid Codex Patch at line ${index + 1}: expected a file operation header.`);
    const operation: CodexPatchOperation = { kind: header[1] as CodexPatchOperation["kind"], path: header[2].trim(), lines: [] };
    index += 1;
    while (index < lines.length && !/^\*\*\* (?:Update|Add|Delete) File:/.test(lines[index]) && lines[index].trim() !== "*** End Patch") {
      operation.lines.push(lines[index]);
      index += 1;
    }
    operations.push(operation);
  }
  throw new LocalWorkspaceBridgeError("Invalid Codex Patch: missing '*** End Patch'.");
}

function findLineSequence(haystack: string[], needle: string[], start: number): number {
  if (!needle.length) return start;
  outer: for (let index = start; index <= haystack.length - needle.length; index += 1) {
    for (let offset = 0; offset < needle.length; offset += 1) if (haystack[index + offset] !== needle[offset]) continue outer;
    return index;
  }
  return -1;
}

function applyCodexUpdate(original: string, patchLines: string[], filePath: string): string {
  let current = original.replace(/\r\n/g, "\n").split("\n");
  const trailingNewline = original.endsWith("\n");
  if (trailingNewline) current.pop();
  const hunks: string[][] = [];
  let hunk: string[] = [];
  for (const line of patchLines) {
    if (line.startsWith("@@")) {
      if (hunk.length) hunks.push(hunk);
      hunk = [];
    } else if (line === "*** End of File") {
      continue;
    } else {
      hunk.push(line);
    }
  }
  if (hunk.length) hunks.push(hunk);
  if (!hunks.length) throw new LocalWorkspaceBridgeError(`Invalid Codex Patch for ${filePath}: no hunks were supplied.`);
  let cursor = 0;
  for (const [hunkIndex, lines] of hunks.entries()) {
    for (const line of lines) if (!line || ![" ", "+", "-"].includes(line[0])) {
      throw new LocalWorkspaceBridgeError(`Invalid Codex Patch for ${filePath}, hunk ${hunkIndex + 1}: every content line must start with space, +, or -.`);
    }
    const before = lines.filter((line) => !line.startsWith("+")).map((line) => line.slice(1));
    const after = lines.filter((line) => !line.startsWith("-")).map((line) => line.slice(1));
    const found = findLineSequence(current, before, cursor);
    if (found < 0) throw new LocalWorkspaceBridgeError(`Codex Patch context did not match ${filePath} at hunk ${hunkIndex + 1}. Use edit for a small exact replacement.`);
    current.splice(found, before.length, ...after);
    cursor = found + after.length;
  }
  return `${current.join("\n")}${trailingNewline ? "\n" : ""}`;
}

function applyCodexWorkspacePatch(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): { paths: string[]; stdout: string; stderr: string; diff: string; additions: number; deletions: number; changed: boolean } {
  const operations = parseCodexPatch(patch);
  if (!operations.length) throw new LocalWorkspaceBridgeError("Codex Patch must contain at least one file operation.");
  const prepared: Array<{ operation: CodexPatchOperation; absPath: string; before?: string; after?: string }> = [];
  for (const operation of operations) {
    const resolved = guard.resolve(workspace, operation.path, { forWrite: true });
    assertWriteToolAllowed(config, resolved.relPath);
    const exists = fs.existsSync(resolved.absPath);
    const before = exists ? fs.readFileSync(resolved.absPath, "utf8") : undefined;
    if (operation.kind === "Add") {
      if (exists) throw new LocalWorkspaceBridgeError(`Codex Patch cannot add an existing file: ${operation.path}`);
      const invalidLine = operation.lines.findIndex((line) => line && !line.startsWith("+"));
      if (invalidLine >= 0) throw new LocalWorkspaceBridgeError(`Invalid Add File content for ${operation.path} at patch line ${invalidLine + 1}: expected + prefix.`);
      prepared.push({ operation, absPath: resolved.absPath, after: `${operation.lines.map((line) => line.startsWith("+") ? line.slice(1) : "").join("\n")}\n` });
    } else if (operation.kind === "Delete") {
      if (!exists) throw new LocalWorkspaceBridgeError(`Codex Patch cannot delete a missing file: ${operation.path}`);
      prepared.push({ operation, absPath: resolved.absPath, before });
    } else {
      if (before === undefined) throw new LocalWorkspaceBridgeError(`Codex Patch cannot update a missing file: ${operation.path}`);
      prepared.push({ operation, absPath: resolved.absPath, before, after: applyCodexUpdate(before, operation.lines, operation.path) });
    }
  }
  const applied: typeof prepared = [];
  try {
    for (const item of prepared) {
      if (item.operation.kind === "Delete") fs.rmSync(item.absPath);
      else {
        fs.mkdirSync(path.dirname(item.absPath), { recursive: true });
        fs.writeFileSync(item.absPath, item.after ?? "", "utf8");
      }
      applied.push(item);
    }
  } catch (error) {
    for (const item of applied.reverse()) {
      try {
        if (item.before === undefined) fs.rmSync(item.absPath, { force: true });
        else fs.writeFileSync(item.absPath, item.before, "utf8");
      } catch {}
    }
    throw error;
  }
  const diffs = prepared.map((item) => makeUnifiedDiff(item.before ?? "", item.after ?? "", item.operation.path).diff).join("\n");
  const stats = diffStats(diffs);
  return { paths: operations.map((item) => item.path), stdout: "", stderr: "", diff: diffs, ...stats };
}

function applyWorkspacePatch(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  patch: string
): { paths: string[]; stdout: string; stderr: string; diff: string; additions: number; deletions: number; changed: boolean } {
  if (!patch.trim()) throw new LocalWorkspaceBridgeError("patch is required.");
  if (Buffer.byteLength(patch, "utf8") > config.maxWriteBytes) {
    throw new LocalWorkspaceBridgeError(`Patch is too large. Limit: ${config.maxWriteBytes} bytes.`);
  }
  if (hasSecretValue(patch)) {
    throw new LocalWorkspaceBridgeError("Secret-looking content is blocked from apply_patch. Use placeholders such as [REDACTED_SECRET].");
  }
  if (patchHasSymlinkMode(patch)) {
    throw new LocalWorkspaceBridgeError("Symlink patches are blocked from apply_patch.");
  }

  if (patch.trimStart().startsWith("*** Begin Patch")) {
    return applyCodexWorkspacePatch(config, guard, workspace, patch.trim());
  }

  const paths = patchTouchedPaths(patch);
  if (!paths.length) throw new LocalWorkspaceBridgeError("Patch must include at least one unified-diff file path. For Codex format, wrap operations in *** Begin Patch / *** End Patch; for a small replacement, use edit.");
  for (const touchedPath of paths) {
    guard.resolve(workspace, touchedPath, { forWrite: true });
    assertWriteToolAllowed(config, touchedPath);
  }

  const check = spawnSync("git", ["apply", "--check", "--whitespace=nowarn"], {
    cwd: workspace.root,
    input: patch,
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (check.error || check.status !== 0) {
    throw new LocalWorkspaceBridgeError(redactSensitiveText(check.stderr?.trim() || check.stdout?.trim() || check.error?.message || "git apply --check failed"));
  }

  const applied = spawnSync("git", ["apply", "--whitespace=nowarn"], {
    cwd: workspace.root,
    input: patch,
    encoding: "utf8",
    maxBuffer: config.maxOutputBytes,
    env: { ...process.env, NO_COLOR: "1" }
  });
  if (applied.error || applied.status !== 0) {
    throw new LocalWorkspaceBridgeError(redactSensitiveText(applied.stderr?.trim() || applied.stdout?.trim() || applied.error?.message || "git apply failed"));
  }

  const diff = redactSensitiveText(patch.trimEnd());
  const stats = diffStats(diff);
  return {
    paths,
    stdout: redactSensitiveText(applied.stdout?.trim() || ""),
    stderr: redactSensitiveText(applied.stderr?.trim() || ""),
    diff,
    additions: stats.additions,
    deletions: stats.deletions,
    changed: true
  };
}

function looksLikeGitError(output: string): boolean {
  const trimmed = output.trim();
  const lower = trimmed.toLowerCase();
  return (
    trimmed.startsWith("fatal:") ||
    trimmed.startsWith("error:") ||
    trimmed.startsWith("git unavailable or failed:") ||
    trimmed.startsWith("git exited with status") ||
    trimmed.startsWith("usage: git ") ||
    lower.includes("not a git repository")
  );
}

function previewText(value: string, maxLines = 40, maxChars = 12_000): string {
  const lines = value.replace(/\r\n/g, "\n").split("\n").slice(0, maxLines).join("\n");
  return lines.length > maxChars ? `${lines.slice(0, maxChars)}\n...[preview truncated]` : lines;
}

function changedStatusLines(status: string): string[] {
  return status
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "(no output)" && !line.startsWith("##"));
}

function changedPathsFromStatus(lines: string[]): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    let raw: string;
    if (line.startsWith("?? ")) raw = line.slice(3).trim();
    else if (line.includes("\t")) raw = line.split("\t").pop()?.trim() ?? "";
    else if (/^.{2}\s/.test(line)) raw = line.slice(3).trim();
    else continue;
    if (raw.includes(" -> ")) raw = raw.split(" -> ").pop() ?? raw;
    const decoded = decodeGitQuotedPath(raw);
    if (decoded && !paths.includes(decoded)) paths.push(decoded);
  }
  return paths;
}

function cleanOneLine(value: unknown, fallback: string, maxLength = 120): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, maxLength);
}

const READ_ONLY_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };
const SESSION_READ_ANNOTATIONS = { readOnlyHint: true, openWorldHint: false, destructiveHint: false, idempotentHint: false };
const LOCAL_WRITE_ANNOTATIONS = { readOnlyHint: false, openWorldHint: false, destructiveHint: true, idempotentHint: false };
const BASH_ANNOTATIONS = { readOnlyHint: false, openWorldHint: true, destructiveHint: true, idempotentHint: false };

const workspaceManagers = new Map<string, WorkspaceManager>();

function workspaceManagerKey(config: LocalWorkspaceBridgeConfig): string {
  return JSON.stringify({
    defaultRoot: config.defaultRoot,
    allowedRoots: [...config.allowedRoots].sort()
  });
}

function getSharedWorkspaceManager(config: LocalWorkspaceBridgeConfig): WorkspaceManager {
  const key = workspaceManagerKey(config);
  const existing = workspaceManagers.get(key);
  if (existing) return existing;
  const manager = new WorkspaceManager(config);
  workspaceManagers.set(key, manager);
  return manager;
}

export function createLocalWorkspaceBridgeServer(config: LocalWorkspaceBridgeConfig): McpServer {
  const workspaces = getSharedWorkspaceManager(config);
  const guard = new PathGuard(config);
  const server = new McpServer({ name: "LocalWorkspaceBridge", version: packageInfo.version }, { instructions: serverInstructions(config) });
  registeredToolNamesByServer.set(server as object, []);
  registerToolCardResource(server, config);

  registerCodexTool(
    config,
    server,
    SUPERTOOL_NAME,
    {
      title: "LocalWorkspaceBridge Supertool",
      description:
        "Stable wrapper for advanced ChatGPT connector setups. Pass action plus args to call an already-registered LocalWorkspaceBridge tool without changing the visible schema; it cannot call tools disabled by the current mode.",
      inputSchema: {
        action: z.string().optional().describe("Action or registered tool name. Use list_actions to see what this server mode allows."),
        args: z.record(z.string(), z.any()).optional().describe("Arguments for the selected action. Same shape as the wrapped LocalWorkspaceBridge tool.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running LocalWorkspaceBridge supertool action...",
        "openai/toolInvocation/invoked": "LocalWorkspaceBridge supertool action complete"
      }
    },
    async (args) => {
      const action = normalizeSupertoolAction(args.action);
      const names = registeredToolNames(server).filter((name) => name !== SUPERTOOL_NAME);
      if (action === "list_actions" || action === "help") {
        const text = [
          "# LocalWorkspaceBridge Supertool",
          "",
          "Use `local-workspace-bridge` only when a stable wrapper is useful for ChatGPT connector caching or custom workflows. The explicit tools remain the preferred default because they give clearer descriptions and validation.",
          "",
          "## Available actions",
          "",
          names.length ? names.map((name) => `- ${name}`).join("\n") : "- none",
          "",
          "## Usage",
          "",
          "```json",
          JSON.stringify({ action: "search", args: { workspace_id: "ws_...", query: "needle", path: "src" } }, null, 2),
          "```"
        ].join("\n");
        return textResult(text, {
          actions: names,
          action_count: names.length,
          aliases: SUPERTOOL_ACTION_ALIASES,
          tool_mode: config.toolMode,
          bash_mode: config.bashMode,
          write_mode: config.writeMode
        });
      }

      if (action === SUPERTOOL_NAME) {
        throw new LocalWorkspaceBridgeError("local-workspace-bridge cannot call itself. Use action=list_actions to inspect available wrapped actions.");
      }

      const handler = registeredToolHandler(server, action);
      if (!handler) {
        throw new LocalWorkspaceBridgeError(
          `LocalWorkspaceBridge action is not available in the current mode: ${action}. ` +
            "Call local-workspace-bridge with action=list_actions, or restart LocalWorkspaceBridge with a broader tool mode if that action should be exposed."
        );
      }

      const childArgs =
        args.args && typeof args.args === "object" && !Array.isArray(args.args)
          ? args.args
          : {};
      let result: any;
      try {
        result = await handler(childArgs);
      } catch (error) {
        result = errorResult(error);
      }
      if (result && typeof result === "object") {
        const structured = result.structuredContent;
        result.structuredContent = {
          local_workspace_bridge_tool: action,
          local_workspace_bridge_title: action,
          local_workspace_bridge_super_action: action,
          wrapped_tool: action,
          ...(structured && typeof structured === "object" && !Array.isArray(structured) ? structured : {})
        };
      }
      return result;
    }
  );

  registerCodexTool(
    config,
    server,
    "server_config",
    {
      title: "Server Config",
      description: "Show LocalWorkspaceBridge server configuration, safety modes, limits, and blocked paths. Does not reveal auth tokens.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading LocalWorkspaceBridge server config...",
        "openai/toolInvocation/invoked": "LocalWorkspaceBridge server config ready"
      }
    },
    async () => {
      const runtime = runtimeDiagnostics();
      const securityWarnings = [
        ...(config.bashMode === "full" ? ["HIGH RISK: bashMode=full can bypass workspace file guards and access the network."] : []),
        ...(config.bashMode === "full" && !config.requireBashSession ? ["Full bash is enabled without Bash Session Guard."] : []),
        ...(config.allowedRoots.some((root) => path.parse(root).root === root) ? ["One or more allowed roots are entire filesystem/drive roots."] : [])
      ];
      const safeConfig = {
        ...runtime,
        defaultRoot: config.defaultRoot,
        allowedRoots: config.allowedRoots,
        host: config.host,
        port: config.port,
        widgetDomain: config.widgetDomain,
        authEnabled: Boolean(config.authToken),
        allowQueryToken: config.allowQueryToken,
        publicUrl: config.publicUrl ?? null,
        oauthEnabled: Boolean(config.publicUrl && config.authToken),
        bashMode: config.bashMode,
        bashTranscript: config.bashTranscript,
        shellMode: config.shellMode,
        bashPathConfigured: Boolean(config.bashPath),
        bashSessionId: config.bashSessionId ?? null,
        requireBashSession: config.requireBashSession,
        codexSessions: config.codexSessions,
        codexDir: config.codexDir,
        writeMode: config.writeMode,
        toolMode: config.toolMode,
        toolCards: config.toolCards,
        connectionTest: config.connectionTest,
        analysisEnabled: config.analysisEnabled,
        analysisLimits: config.analysisLimits,
        inheritEnv: config.inheritEnv,
        maxReadBytes: config.maxReadBytes,
        maxImageBytes: MAX_IMAGE_BYTES,
        maxImageOutputBytes: MAX_IMAGE_OUTPUT_BYTES,
        defaultImagePreviewDimension: DEFAULT_IMAGE_PREVIEW_DIMENSION,
        maxWriteBytes: config.maxWriteBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSearchResults: config.maxSearchResults,
        blockedGlobs: config.blockedGlobs,
        analysisIgnoreGlobs: config.analysisIgnoreGlobs,
        registeredTools: registeredToolNames(server),
        registeredToolCount: registeredToolNames(server).length,
        securityWarnings
      };
      return textResult(`# LocalWorkspaceBridge Server Config\n\n${JSON.stringify(safeConfig, null, 2)}`, safeConfig);
    }
  );

  registerCodexTool(
    config,
    server,
    "local_workspace_bridge_self_test",
    {
      title: "LocalWorkspaceBridge Self Test",
      description:
        "Run a controlled local diagnostic for workspace access, tool registration, skills, git, and the configured bash policy without modifying workspace files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        bash_probe: z.boolean().optional().describe("Check bash policy with safe local commands only. Default: true."),
        include_global_skills: z.boolean().optional().describe("Include user/plugin skill discovery in the inventory check. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Maximum skills to inspect during the inventory check. Default: 40.")
      },
      annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: false },
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running LocalWorkspaceBridge self-test...",
        "openai/toolInvocation/invoked": "LocalWorkspaceBridge self-test complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const started = Date.now();
      const checks: Array<{ name: string; status: "pass" | "warn" | "fail"; detail: string }> = [];
      const check = (name: string, status: "pass" | "warn" | "fail", detail: string) => {
        checks.push({ name, status, detail: cleanOneLine(detail, detail, 260) });
      };

      check("workspace", "pass", workspace.root);
      const runtime = runtimeDiagnostics();
      const cliVersion = spawnSync(process.execPath, [path.join(packageRoot, "scripts", "local-workspace-bridge.mjs"), "--version"], { cwd: packageRoot, encoding: "utf8", windowsHide: true });
      check(
        "runtime version",
        cliVersion.status === 0 && cliVersion.stdout.trim() === packageInfo.version ? "pass" : "fail",
        `package=${packageInfo.version}; cli=${cliVersion.status === 0 ? cliVersion.stdout.trim() : "unavailable"}; entrypoint=${runtime.entrypoint}`
      );
      check("tool mode", config.toolMode === "full" ? "pass" : "warn", `${config.toolMode}; expected tools: ${toolNamesForMode(config).length}`);
      check("write mode", config.writeMode === "off" ? "warn" : "pass", config.writeMode);
      check("bash mode", config.bashMode === "full" ? "warn" : "pass", config.bashMode);
      check("http auth", "pass", config.authToken ? "token configured" : config.requireHttpToken ? "token required when serving HTTP" : "token auth explicitly disabled");

      const expectedTools = toolNamesForMode(config).sort();
      const actualTools = registeredToolNames(server).sort();
      const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
      const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
      check(
        "registered tool set",
        missingTools.length || extraTools.length ? "fail" : "pass",
        missingTools.length || extraTools.length
          ? `missing: ${missingTools.join(", ") || "none"}; extra: ${extraTools.join(", ") || "none"}`
          : `${actualTools.length} tools registered for ${config.toolMode} mode`
      );

      try {
        const inventory = await localWorkspaceBridgeInventory(config, workspace, {
          includeGlobalSkills: parseBool(args.include_global_skills, true),
          includeMcpServers: true,
          maxSkills: limitInt(args.max_skills, 40, 1, 120)
        });
        check("inventory", "pass", `${inventory.skills.length} skills inspected, ${inventory.mcpServers.length} MCP server names visible`);
      } catch (error) {
        check("inventory", "fail", errorText(error));
      }

      try {
        const statusText = gitStatus(config, workspace);
        const gitFailed = looksLikeGitError(statusText);
        const changed = gitFailed ? 0 : changedStatusLines(statusText).length;
        check("git status", gitFailed ? "warn" : "pass", gitFailed ? statusText : `${changed} changed entries`);
      } catch (error) {
        check("git status", "fail", errorText(error));
      }

      if (parseBool(args.bash_probe, true)) {
        try {
          if (config.bashMode === "off") {
            check("bash policy", "warn", "bash disabled");
          } else {
            const bashProbeOptions = { timeoutMs: 10_000, sessionId: config.bashSessionId };
            const pwd = await runBash(config, guard, workspace, "pwd", bashProbeOptions);
            if (config.bashMode === "safe") {
              try {
                await runBash(config, guard, workspace, "ls $HOME", bashProbeOptions);
                check("bash policy", "fail", "safe bash allowed environment expansion unexpectedly");
              } catch {
                check("bash policy", pwd.exitCode === 0 ? "pass" : "warn", "safe bash allowed pwd and blocked environment expansion");
              }
            } else {
              check("bash policy", pwd.exitCode === 0 ? "warn" : "fail", "full bash is enabled; use only for trusted local repos");
            }
          }
        } catch (error) {
          check("bash policy", "fail", errorText(error));
        }
      } else {
        check("bash policy", "warn", "skipped by request");
      }

      check("terms boundary", "pass", "local workspace bridge only; does not provide models, proxy model access, bypass quotas, or execute local agents through MCP");
      const failed = checks.filter((item) => item.status === "fail").length;
      const warned = checks.filter((item) => item.status === "warn").length;
      const passed = checks.filter((item) => item.status === "pass").length;
      const status = failed ? "fail" : warned ? "warn" : "pass";
      const body = [
        "# LocalWorkspaceBridge Self Test",
        "",
        `Status: ${status}`,
        `Workspace: ${workspace.root}`,
        `Mode: tools=${config.toolMode}, write=${config.writeMode}, bash=${config.bashMode}`,
        `Expected tools: ${expectedTools.length}`,
        `Registered tools: ${actualTools.length}`,
        `Duration: ${Date.now() - started} ms`,
        "",
        "## Checks",
        "",
        ...checks.map((item) => `- ${item.status.toUpperCase()} ${item.name}: ${item.detail}`)
      ].join("\n");
      return textResult(body, {
        workspace_id: workspace.id, root: workspace.root, status, passed, warned, failed,
        duration_ms: Date.now() - started, expected_tools: expectedTools, registered_tools: actualTools,
        bash_mode: config.bashMode, write_mode: config.writeMode, tool_mode: config.toolMode, checks
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "local_workspace_bridge_inventory",
    {
      title: "LocalWorkspaceBridge Inventory",
      description:
        "List LocalWorkspaceBridge modes plus discovered skill names and configured MCP server names. Use this early when planning needs local agent capabilities.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        include_global_skills: z.boolean().optional().describe("Include user and plugin skill folders. Default: true."),
        include_mcp_servers: z.boolean().optional().describe("Include configured MCP server names from safe config files. Default: true."),
        max_skills: z.number().int().min(1).max(120).optional().describe("Skills per page. Default: 20."),
        skill_cursor: z.number().int().min(0).max(499).optional().describe("Continuation cursor from next_skill_cursor. Default: 0."),
        compact: z.boolean().optional().describe("Return capability status only, omitting descriptions and paths. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading LocalWorkspaceBridge inventory...",
        "openai/toolInvocation/invoked": "LocalWorkspaceBridge inventory ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const inventory = await localWorkspaceBridgeInventory(config, workspace, {
        includeGlobalSkills: parseBool(args.include_global_skills, true),
        includeMcpServers: parseBool(args.include_mcp_servers, true),
        maxSkills: limitInt(args.max_skills, 20, 1, 120),
        skillCursor: limitInt(args.skill_cursor, 0, 0, 499),
        compact: parseBool(args.compact, true)
      });
      return textResult(inventory.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode,
        skills: inventory.skills,
        skill_count: inventory.skills.length,
        skill_total_at_least: inventory.skillTotalAtLeast,
        next_skill_cursor: inventory.nextSkillCursor,
        compact: parseBool(args.compact, true),
        mcp_servers: inventory.mcpServers,
        mcp_server_count: inventory.mcpServers.length,
        widget_uri: TOOL_CARD_URI
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "load_skill",
    {
      title: "Load Skill",
      description:
        "Load the bounded SKILL.md body for a discovered workspace, user, or plugin skill by name. Does not accept arbitrary paths; use after open_current_workspace/open_workspace shows skill_inventory.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        name: z.string().describe("Exact skill name from skill_inventory or local_workspace_bridge_inventory."),
        source: z.enum(["workspace", "user", "plugin", "other"]).optional().describe("Optional source when multiple skills share a name."),
        path: z.string().optional().describe("Exact sanitized path from skill_inventory when name/source are still ambiguous."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills. Default: auto when source/path is not workspace."),
        max_skills: z.number().int().min(1).max(500).optional().describe("Maximum skills to scan while resolving the requested skill. Default: 500."),
        max_bytes: z.number().int().min(1000).max(100000).optional().describe("Maximum bytes to return from SKILL.md. Default: 40000.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Loading skill instructions...",
        "openai/toolInvocation/invoked": "Skill instructions loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const requestedPath = typeof args.path === "string" ? args.path : undefined;
      const includeGlobalDefault =
        args.source === undefined ||
        (args.source !== undefined && args.source !== "workspace") ||
        Boolean(requestedPath && !requestedPath.startsWith("$WORKSPACE/"));
      const loaded = await loadSkill(workspace, {
        name: String(args.name ?? ""),
        source: args.source,
        path: requestedPath,
        includeGlobal: parseBool(args.include_global_skills, includeGlobalDefault),
        maxSkills: limitInt(args.max_skills, 500, 1, 500),
        maxBytes: limitInt(args.max_bytes, 40_000, 1_000, 100_000)
      });
      const truncated = loaded.truncated ? "\n\n[truncated: increase max_bytes if more context is required]" : "";
      const text = `# Load Skill\n\nName: ${loaded.skill.name}\nSource: ${loaded.skill.source}\nPath: ${loaded.skill.path}\nBytes: ${loaded.bytes}/${loaded.totalBytes}\n\n\`\`\`markdown\n${loaded.text}${truncated}\n\`\`\``;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        skill: loaded.skill,
        bytes: loaded.bytes,
        total_bytes: loaded.totalBytes,
        truncated: loaded.truncated,
        text: loaded.text
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "list_workspaces",
    {
      title: "List Workspaces",
      description: "List currently opened LocalWorkspaceBridge workspaces for this server/config.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing LocalWorkspaceBridge workspaces...",
        "openai/toolInvocation/invoked": "LocalWorkspaceBridge workspaces listed"
      }
    },
    async () => {
      const current = workspaces.listWorkspaces();
      const activeWorkspace = workspaces.activeWorkspaceIdValue();
      const defaultWorkspace = workspaces.defaultWorkspaceIdValue();
      const text = current.length
        ? current.map((workspace) => `- ${workspace.id} — ${workspace.root} (opened ${workspace.openedAt})`).join("\n")
        : "No workspaces opened on this LocalWorkspaceBridge server/config yet. Call open_workspace first.";
      return textResult(text, { workspaces: current, count: current.length, active_workspace: activeWorkspace, default_workspace: defaultWorkspace });
    }
  );

  registerCodexTool(
    config,
    server,
    "close_workspace",
    {
      title: "Close Workspace",
      description: "Forget one opened workspace from this server session. This does not delete files.",
      inputSchema: { workspace_id: z.string().describe("Workspace id to close.") },
      annotations: SESSION_READ_ANNOTATIONS
    },
    async (args) => {
      const closed = workspaces.closeWorkspace(args.workspace_id);
      return textResult(`# Workspace Closed\n\n${closed.root}`, {
        closed_workspace: closed.id,
        root: closed.root,
        active_workspace: workspaces.activeWorkspaceIdValue() ?? null,
        default_workspace: workspaces.defaultWorkspaceIdValue() ?? null
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "set_default_workspace",
    {
      title: "Set Default Workspace",
      description: "Set an already-opened workspace as the default and active workspace for omitted workspace_id calls.",
      inputSchema: { workspace_id: z.string().describe("Workspace id from open_workspace/list_workspaces.") },
      annotations: SESSION_READ_ANNOTATIONS
    },
    async (args) => {
      const selected = workspaces.setDefaultWorkspace(args.workspace_id);
      return textResult(`# Default Workspace\n\n${selected.root}`, {
        workspace_id: selected.id,
        root: selected.root,
        active_workspace: selected.id,
        default_workspace: selected.id
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_current_workspace",
    {
      title: "Open Current Workspace",
      description:
        "Use this once at the start to open the configured default workspace without accepting a path. Do not call open_workspace after this unless switching roots.",
      inputSchema: {
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: false for speed."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth when include_tree=true. Default: 2."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening current LocalWorkspaceBridge workspace...",
        "openai/toolInvocation/invoked": "Current LocalWorkspaceBridge workspace opened"
      }
    },
    async (args) => {
      const workspace = workspaces.defaultWorkspace();
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: parseBool(args.include_tree, false),
        maxDepth: limitInt(args.max_depth, 2, 1, 8),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "open_workspace",
    {
      title: "Open Workspace",
      description:
        "Open a local project directory as a LocalWorkspaceBridge workspace. Returns a workspace_id plus git status, AGENTS.md, and a compact file tree.",
      inputSchema: {
        root: z.string().optional().describe("Project directory to open. Omit to use LOCALWORKSPACEBRIDGE_ROOT/current working directory. Supports ~/ paths."),
        path: z.string().optional().describe("Alias for root. Useful for clients that naturally send path instead of root."),
        include_tree: z.boolean().optional().describe("Include a compact file tree. Default: true."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover skills by name/description. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan installed user/plugin skills when include_skills=true. Default: false.")
      },
      annotations: SESSION_READ_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Opening LocalWorkspaceBridge workspace...",
        "openai/toolInvocation/invoked": "LocalWorkspaceBridge workspace opened"
      }
    },
    async (args) => {
      if (args.root && args.path && args.root !== args.path) {
        throw new LocalWorkspaceBridgeError("open_workspace accepts either root or path. If both are provided, they must match.");
      }
      const workspace = workspaces.openWorkspace(args.root ?? args.path);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: args.include_tree !== false,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      return textResult(summary.text, {
        workspace_id: summary.workspaceId,
        root: summary.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "workspace_snapshot",
    {
      title: "Workspace Snapshot",
      description: "Return git status, recent commits, skills, and a compact tree for an opened workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        max_depth: z.number().int().min(1).max(8).optional().describe("Tree depth. Default: 3."),
        max_files: z.number().int().min(1).max(3000).optional().describe("Alias for maximum tree entries. Default: 500."),
        include_skills: z.boolean().optional().describe("Discover repo-local skills. Default: false for speed."),
        include_global_skills: z.boolean().optional().describe("Also scan home-level skill folders when include_skills=true. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Collecting workspace snapshot...",
        "openai/toolInvocation/invoked": "Workspace snapshot ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const summary = await workspaceSummary(config, guard, workspace, {
        includeTree: true,
        maxDepth: limitInt(args.max_depth, 3, 1, 8),
        maxEntries: limitInt(args.max_files, 500, 1, 3000),
        includeSkills: parseBool(args.include_skills, false),
        includeGlobalSkills: parseBool(args.include_global_skills, false)
      });
      return textResult(summary.text, {
        workspace_id: workspace.id,
        root: workspace.root,
        agents_loaded: summary.agentsLoaded,
        agents_path: summary.agentsPath,
        skills: summary.skills,
        skill_inventory: summary.skillInventory,
        skill_counts: summary.skillCounts,
        tree: summary.tree,
        git_status: summary.gitStatus,
        bash_mode: config.bashMode,
        write_mode: config.writeMode,
        tool_mode: config.toolMode
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "inspect_workspace",
    {
      title: "Inspect Workspace",
      description: "Build a bounded repository map with languages, project types, entrypoints, areas, symbols, relationships, and coverage warnings.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional workspace-relative area to emphasize. Default: entire workspace."),
        mode: z.enum(["inventory", "inventory_only", "symbols", "relationships", "full"]).optional().describe("Analysis depth. inventory/inventory_only skips symbol extraction; symbols skips dependency graph construction. Default: full, or inventory when symbols and relationships are disabled."),
        cursor: z.string().optional().describe("Opaque continuation token from a previous limited response."),
        max_files: z.number().int().min(1).max(100000).optional().describe("Maximum returned file records. Default: 300."),
        include_symbols: z.boolean().optional().describe("Include symbols in structured output. Default: true."),
        include_relationships: z.boolean().optional().describe("Include relationships in structured output. Default: true."),
        max_symbols: z.number().int().min(1).max(100000).optional().describe("Maximum returned symbols. Analysis remains bounded by server config."),
        max_relationships: z.number().int().min(1).max(250000).optional().describe("Maximum returned relationships. Analysis remains bounded by server config.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Inspecting workspace analysis...",
        "openai/toolInvocation/invoked": "Workspace analysis ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      if (args.path) guard.resolve(workspace, args.path);
      const requestedMode = args.mode ?? (args.include_symbols === false && args.include_relationships !== true ? "inventory" : "full");
      const mode: AnalysisMode = requestedMode === "inventory" ? "inventory_only" : requestedMode;
      const result = await inspectWorkspace(config, guard, workspace, { mode });
      const prefix = typeof args.path === "string" && args.path.trim()
        ? guard.resolve(workspace, args.path).relPath.replace(/^\.\/?$/, "")
        : "";
      const inScope = (filePath: string) => !prefix || filePath === prefix || filePath.startsWith(`${prefix}/`);
      const areaInScope = (areaPath: string) => !prefix || (areaPath !== "." && (inScope(areaPath) || prefix.startsWith(`${areaPath}/`)));
      const cardWorkspaceAnalysis = usesToolCard(config, "inspect_workspace");
      const fileLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_files, 300, 1, config.analysisLimits.maxInventoryFiles);
      const symbolLimit = cardWorkspaceAnalysis ? 80 : limitInt(args.max_symbols, 500, 1, config.analysisLimits.maxSymbols);
      const relationshipLimit = cardWorkspaceAnalysis ? 120 : limitInt(args.max_relationships, 800, 1, config.analysisLimits.maxRelationships);
      const scopedFiles = result.files.filter((file) => inScope(file.path));
      const scopedSymbols = result.symbols.filter((symbol) => inScope(symbol.path));
      const scopedRelationships = result.relationships.filter((relationship) => inScope(relationship.from) || inScope(relationship.to));
      const cursor = inspectCursor(args.cursor);
      const enabledPageTypes: InspectPageType[] = [
        "files",
        ...(args.include_symbols === false ? [] : ["symbols" as const]),
        ...(args.include_relationships === false ? [] : ["relationships" as const])
      ];
      const totalFor = (type: InspectPageType) => type === "files" ? scopedFiles.length : type === "symbols" ? scopedSymbols.length : scopedRelationships.length;
      const cursorOffset = (type: InspectPageType) => type === "files" ? cursor.fileIndex : type === "symbols" ? cursor.symbolIndex : cursor.relationshipIndex;
      const cursorHasRemaining = (type: InspectPageType) => cursorOffset(type) < totalFor(type);
      const pageType = cursor.phase && enabledPageTypes.includes(cursor.phase) && cursorHasRemaining(cursor.phase)
        ? cursor.phase
        : enabledPageTypes.find(cursorHasRemaining) ?? enabledPageTypes[0] ?? "files";
      let files = pageType === "files" ? scopedFiles.slice(cursor.fileIndex, cursor.fileIndex + fileLimit) : [];
      let symbols = pageType === "symbols" ? scopedSymbols.slice(cursor.symbolIndex, cursor.symbolIndex + symbolLimit) : [];
      let relationships = pageType === "relationships" ? scopedRelationships.slice(cursor.relationshipIndex, cursor.relationshipIndex + relationshipLimit) : [];
      const responseMetadata = {
        schema_version: 1,
        analysis_mode: requestedMode === "inventory_only" ? "inventory" : requestedMode,
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? ".",
        languages: result.languages,
        project_types: result.projectTypes,
        entrypoints: result.entrypoints.filter(inScope).slice(0, 200),
        important_files: result.importantFiles.filter(inScope).slice(0, 200),
        areas: result.areas.filter((area) => areaInScope(area.path)).slice(0, 300),
        coverage: result.coverage,
        cache: result.cache
      };
      let metadataLimited = result.entrypoints.filter(inScope).length > responseMetadata.entrypoints.length ||
        result.importantFiles.filter(inScope).length > responseMetadata.important_files.length ||
        result.areas.filter((area) => areaInScope(area.path)).length > responseMetadata.areas.length;
      const hasRemovableOutput = () => files.length || symbols.length || relationships.length || responseMetadata.areas.length || responseMetadata.important_files.length || responseMetadata.entrypoints.length;
      const removeLastOutputItem = () => {
        if (relationships.length) relationships.pop();
        else if (symbols.length) symbols.pop();
        else if (files.length) files.pop();
        else if (responseMetadata.areas.length) { responseMetadata.areas.pop(); metadataLimited = true; }
        else if (responseMetadata.important_files.length) { responseMetadata.important_files.pop(); metadataLimited = true; }
        else if (responseMetadata.entrypoints.length) { responseMetadata.entrypoints.pop(); metadataLimited = true; }
      };
      const estimatedBytes = () => Buffer.byteLength(JSON.stringify({ ...responseMetadata, files, symbols, relationships }), "utf8") + 5_000;
      while (estimatedBytes() > INSPECT_RESPONSE_MAX_BYTES && hasRemovableOutput()) {
        removeLastOutputItem();
      }
      const nextOffsets: InspectCursor = {
        fileIndex: cursor.fileIndex + files.length,
        symbolIndex: cursor.symbolIndex + symbols.length,
        relationshipIndex: cursor.relationshipIndex + relationships.length
      };
      const offsetFrom = (offsets: InspectCursor, type: InspectPageType) => type === "files" ? offsets.fileIndex : type === "symbols" ? offsets.symbolIndex : offsets.relationshipIndex;
      const hasRemainingFrom = (offsets: InspectCursor, type: InspectPageType) => offsetFrom(offsets, type) < totalFor(type);
      const nextPageType = (offsets: InspectCursor): InspectPageType | undefined => {
        const currentIndex = Math.max(0, enabledPageTypes.indexOf(pageType));
        for (let step = 1; step <= enabledPageTypes.length; step += 1) {
          const candidate = enabledPageTypes[(currentIndex + step) % enabledPageTypes.length];
          if (hasRemainingFrom(offsets, candidate)) return candidate;
        }
        return undefined;
      };
      let nextType = nextPageType(nextOffsets);
      let hasMore = Boolean(nextType);
      let outputLimited = hasMore || metadataLimited;
      const outputWarnings = [
        ...result.warnings,
        ...(outputLimited ? ["Structured output is paginated within a shared response byte budget. Continue with next_cursor or narrow path/max_* arguments."] : [])
      ];
      let text = [
        "# Workspace Analysis",
        "",
        `Workspace: ${workspace.root}`,
        `Projects: ${result.projectTypes.join(", ") || "unknown"}`,
        `Languages: ${result.languages.join(", ") || "unknown"}`,
        `Entrypoints: ${result.entrypoints.filter(inScope).join(", ") || "none detected"}`,
        `Coverage: ${result.coverage.analyzedFiles}/${result.coverage.inventoryFiles} files analyzed, ${result.coverage.symbolCount} symbols, ${result.coverage.relationshipCount} relationships${result.coverage.truncated ? " (partial)" : ""}`,
        `Page: ${pageType} from offset ${cursorOffset(pageType)}`,
        `Returned: ${files.length} files, ${symbols.length} symbols, ${relationships.length} relationships`,
        ...(outputWarnings.length ? ["", "## Warnings", "", ...outputWarnings.map((warning) => `- ${warning}`)] : [])
      ].join("\n");
      const structured: Record<string, any> = {
        ...responseMetadata,
        files,
        symbols,
        relationships,
        warnings: outputWarnings,
        output_limited: outputLimited,
        returned: { files: files.length, symbols: symbols.length, relationships: relationships.length },
        total: { files: scopedFiles.length, symbols: scopedSymbols.length, relationships: scopedRelationships.length },
        page: {
          type: pageType,
          offset: cursorOffset(pageType),
          returned: pageType === "files" ? files.length : pageType === "symbols" ? symbols.length : relationships.length,
          remaining: Math.max(0, totalFor(pageType) - offsetFrom(nextOffsets, pageType)),
          ...(nextType ? { next_type: nextType } : {})
        },
        response_budget_bytes: INSPECT_RESPONSE_MAX_BYTES,
        hard_transport_budget_bytes: INSPECT_HARD_TRANSPORT_BUDGET_BYTES,
        estimated_response_bytes: estimatedBytes(),
        ...(hasMore && nextType ? { next_cursor: encodeInspectCursor({ ...nextOffsets, phase: nextType }) } : {})
      };
      const syncFinalResponse = (): number => {
        const finalOffsets: InspectCursor = {
          fileIndex: cursor.fileIndex + files.length,
          symbolIndex: cursor.symbolIndex + symbols.length,
          relationshipIndex: cursor.relationshipIndex + relationships.length
        };
        nextType = nextPageType(finalOffsets);
        hasMore = Boolean(nextType);
        outputLimited = hasMore || metadataLimited;
        if (hasMore && !outputWarnings.some((warning) => warning.includes("paginated"))) {
          outputWarnings.push("Structured output is paginated within a shared response byte budget. Continue with next_cursor or narrow path/max_* arguments.");
        }
        structured.returned = { files: files.length, symbols: symbols.length, relationships: relationships.length };
        structured.page = {
          type: pageType,
          offset: cursorOffset(pageType),
          returned: pageType === "files" ? files.length : pageType === "symbols" ? symbols.length : relationships.length,
          remaining: Math.max(0, totalFor(pageType) - offsetFrom(finalOffsets, pageType)),
          ...(nextType ? { next_type: nextType } : {})
        };
        structured.output_limited = outputLimited;
        if (hasMore && nextType) structured.next_cursor = encodeInspectCursor({ ...finalOffsets, phase: nextType });
        else delete structured.next_cursor;
        text = text.replace(/Returned: \d+ files, \d+ symbols, \d+ relationships/, `Returned: ${files.length} files, ${symbols.length} symbols, ${relationships.length} relationships`);
        structured.estimated_response_bytes = 0;
        let bytes = Buffer.byteLength(JSON.stringify(textResult(text, structured)), "utf8");
        structured.estimated_response_bytes = bytes;
        return Buffer.byteLength(JSON.stringify(textResult(text, structured)), "utf8");
      };
      let serializedBytes = syncFinalResponse();
      while (serializedBytes > INSPECT_RESPONSE_MAX_BYTES && hasRemovableOutput()) {
        removeLastOutputItem();
        serializedBytes = syncFinalResponse();
      }
      if (serializedBytes > INSPECT_HARD_TRANSPORT_BUDGET_BYTES) {
        throw new LocalWorkspaceBridgeError(`Workspace analysis metadata exceeds the ${INSPECT_HARD_TRANSPORT_BUDGET_BYTES}-byte transport boundary. Narrow path or disable symbols/relationships.`);
      }
      structured.estimated_response_bytes = serializedBytes;
      return textResult(text, structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "tree",
    {
      title: "File Tree",
      description: "List files and directories inside the workspace, excluding blocked paths.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Directory relative to workspace root. Default: ."),
        max_depth: z.number().int().min(1).max(12).optional().describe("Maximum depth. Default: 4."),
        include_hidden: z.boolean().optional().describe("Include dotfiles/dotfolders that are not blocked. Default: false."),
        max_entries: z.number().int().min(1).max(3000).optional().describe("Maximum entries. Default: 800.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Listing workspace files...",
        "openai/toolInvocation/invoked": "Workspace files listed"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await repoTree(config, guard, workspace, {
        path: args.path ?? ".",
        maxDepth: limitInt(args.max_depth, 4, 1, 12),
        includeHidden: parseBool(args.include_hidden, false),
        maxEntries: limitInt(args.max_entries, 800, 1, 3000)
      });
      return textResult(result.text, { workspace_id: workspace.id, root: workspace.root, ...result });
    }
  );

  registerCodexTool(
    config,
    server,
    "search",
    {
      title: "Search Files",
      description: "Use this for targeted verification or code lookup. Prefer one specific final search instead of repeated broad verification searches.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        query: z.string().describe("Text or regex to search for."),
        regex: z.boolean().optional().describe("Treat query as a regular expression. Requires ripgrep. Default: false."),
        path: z.string().optional().describe("Directory or file relative to workspace root. Default: ."),
        glob: z.string().optional().describe("Optional glob, for example src/**/*.ts."),
        include_hidden: z.boolean().optional().describe("Include hidden files that are not blocked. Default: false."),
        max_results: z.number().int().min(1).max(2000).optional().describe("Maximum results. Default from config."),
        intent: z.enum(["auto", "text", "symbol", "references", "impact"]).optional().describe("Optional structured search intent. Omit for legacy lexical behavior."),
        symbol: z.string().optional().describe("Optional symbol query. Uses repository analysis and overrides query text."),
        include_tests: z.boolean().optional().describe("Include related tests in structured results. Default: false.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Searching workspace...",
        "openai/toolInvocation/invoked": "Workspace search complete"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await searchWorkspace(config, guard, workspace, {
        query: args.query,
        regex: parseBool(args.regex, false),
        root: args.path ?? ".",
        glob: args.glob,
        includeHidden: parseBool(args.include_hidden, false),
        maxResults: limitInt(args.max_results, config.maxSearchResults, 1, config.maxSearchResults),
        intent: args.intent,
        symbol: args.symbol,
        includeTests: args.include_tests === undefined ? undefined : parseBool(args.include_tests, false)
      });
      const structured: Record<string, unknown> = {
        workspace_id: workspace.id,
        root: workspace.root,
        matches: result.matches,
        truncated: result.truncated,
        used: result.used
      };
      if (result.analysis) structured.analysis = result.analysis;
      return textResult(result.text, structured);
    }
  );

  registerCodexTool(
    config,
    server,
    "read",
    {
      title: "Read File",
      description: "Read a specific text file with line numbers. Avoid rereading files after write/edit/apply_patch unless exact final content is needed.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        start_line: z.number().int().min(1).optional().describe("First line to read. Default: 1."),
        end_line: z.number().int().min(1).optional().describe("Last line to read. Default: end of file."),
        max_bytes: z.number().int().min(1000).max(2000000).optional().describe("Maximum bytes returned in this page. Capped by the server and MCP response limits.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading file...",
        "openai/toolInvocation/invoked": "File read"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await readTextFile(config, guard, workspace, args.path, {
        startLine: args.start_line,
        endLine: args.end_line,
        maxBytes: Math.min(limitInt(args.max_bytes, READ_RESPONSE_MAX_BYTES, 1_000, config.maxReadBytes), READ_RESPONSE_MAX_BYTES)
      });
      const { text: fileText, ...metadata } = result;
      const summary = `# Read File\n\nPath: ${result.path}\nLines: ${result.startLine}-${result.endLine} of ${result.totalLines}\nReturned: ${result.bytesReturned}/${result.bytes} bytes${result.truncated ? " (partial)" : ""}${result.nextStartLine ? `\nNext start line: ${result.nextStartLine}` : ""}\nSHA-256: ${result.sha256}`;
      const standardText = [summary, "", "## File Content", "", fileText].join("\n");
      return textResult(standardText, { workspace_id: workspace.id, root: workspace.root, ...metadata, text: fileText });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_image",
    {
      title: "Read Image",
      description:
        "Read a workspace-local JPEG, PNG, or WebP as native MCP image content. Safe default previews use a 1600 px longest side; values above 1600 up to 4096 are experimental in ChatGPT. For pixel-level detail, prefer image_info plus read_image_crop/read_image_tile.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("Image path relative to workspace root. Supported: .jpg, .jpeg, .png, .webp. Maximum input: 25 MiB."),
        max_dimension: z.number().int().min(128).max(EXPERIMENTAL_IMAGE_MAX_DIMENSION).optional().describe("Preview longest-side dimension. Default: 1600. Values above 1600 are experimental and may be unstable in ChatGPT's MCP image path."),
        return_original: z.boolean().optional().describe("Return original bytes when they fit within the 3 MiB output safety limit. Default: false. This bypasses safe pixel-dimension previewing and is experimental for large-dimension images.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Loading local image...",
        "openai/toolInvocation/invoked": "Local image loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const image = await readImageFile(guard, workspace, args.path, {
        maxDimension: args.max_dimension,
        returnOriginal: args.return_original === true
      });
      return image.result;
    }
  );

  registerCodexTool(
    config,
    server,
    "image_info",
    {
      title: "Image Info",
      description:
        "Inspect a workspace-local image without returning its pixels. Reports original dimensions/bytes and a recommended 1600 px-safe tile grid for high-detail follow-up reads.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("Image path relative to workspace root. Supported: .jpg, .jpeg, .png, .webp. Maximum input: 25 MiB."),
        tile_overlap: z.number().min(0).max(0.2).optional().describe("Fractional overlap used when recommending tiles. Default: 0.08 (8%).")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Inspecting image...",
        "openai/toolInvocation/invoked": "Image inspected"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const info = await getImageInfo(guard, workspace, args.path, { tileOverlap: args.tile_overlap });
      const overlapPercent = Math.round(info.recommendedTileOverlap * 1000) / 10;
      const summary = `# Image Info\n\nPath: ${info.path}\nOriginal: ${info.width}x${info.height}\nBytes: ${info.bytes}\nSafe full preview: ${info.recommendedPreviewDimension}px longest side\nRecommended detail grid: ${info.recommendedTileRows} rows x ${info.recommendedTileColumns} columns\nTile overlap: ${overlapPercent}%`;
      return textResult(summary, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: info.path,
        mime_type: info.mimeType,
        bytes: info.bytes,
        width: info.width,
        height: info.height,
        longest_dimension: info.longestDimension,
        recommended_preview_dimension: info.recommendedPreviewDimension,
        recommended_tile_rows: info.recommendedTileRows,
        recommended_tile_columns: info.recommendedTileColumns,
        recommended_tile_overlap: info.recommendedTileOverlap
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "read_image_crop",
    {
      title: "Read Image Crop",
      description:
        "Read a rectangular crop directly from the original image, rendered at a safe maximum longest side of 1600 px. Coordinates are original-image pixels from the top-left corner.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("Image path relative to workspace root."),
        x: z.number().min(0).describe("Crop left coordinate in original-image pixels."),
        y: z.number().min(0).describe("Crop top coordinate in original-image pixels."),
        width: z.number().positive().describe("Crop width in original-image pixels."),
        height: z.number().positive().describe("Crop height in original-image pixels."),
        max_dimension: z.number().int().min(128).max(SAFE_IMAGE_MAX_DIMENSION).optional().describe("Crop output longest-side dimension. Default/max: 1600 pixels.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Loading image crop...",
        "openai/toolInvocation/invoked": "Image crop loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const image = await readImageCrop(guard, workspace, args.path, {
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height
      }, { maxDimension: args.max_dimension });
      return image.result;
    }
  );

  registerCodexTool(
    config,
    server,
    "read_image_tile",
    {
      title: "Read Image Tile",
      description:
        "Read one tile from an automatically recommended high-detail grid. Tiles come directly from original pixels, default to 8% overlap, and are kept within the safe 1600 px longest-side path.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("Image path relative to workspace root."),
        row: z.number().int().min(1).describe("1-based tile row from image_info's recommended grid."),
        column: z.number().int().min(1).describe("1-based tile column from image_info's recommended grid."),
        overlap: z.number().min(0).max(0.2).optional().describe("Fractional tile overlap. Default: 0.08 (8%). Use the same value as image_info if overridden."),
        max_dimension: z.number().int().min(128).max(SAFE_IMAGE_MAX_DIMENSION).optional().describe("Tile output longest-side dimension. Default/max: 1600 pixels.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        "openai/toolInvocation/invoking": "Loading image tile...",
        "openai/toolInvocation/invoked": "Image tile loaded"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const image = await readImageTile(guard, workspace, args.path, args.row, args.column, {
        overlap: args.overlap ?? DEFAULT_TILE_OVERLAP,
        maxDimension: args.max_dimension
      });
      return image.result;
    }
  );

  registerCodexTool(
    config,
    server,
    "write",
    {
      title: "Write File",
      description: "Create or overwrite a meaningful text file inside the workspace. Returns a unified diff; do not create empty placeholder files.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        content: z.string().describe("Complete file contents to write."),
        create_dirs: z.boolean().optional().describe("Create parent directories if missing. Default: true."),
        overwrite: z.boolean().optional().describe("Allow overwriting existing files. Default: true.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Writing file...",
        "openai/toolInvocation/invoked": "File written"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await writeTextFile(config, guard, workspace, args.path, String(args.content ?? ""), {
        createDirs: args.create_dirs !== false,
        overwrite: args.overwrite !== false
      });
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = `# Write File\n\nPath: ${result.path}\nExisted before: ${result.existed}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        existed: result.existed,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "edit",
    {
      title: "Edit File",
      description: "Apply a targeted exact text replacement inside a workspace text file. Returns a unified diff.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().describe("File path relative to workspace root."),
        old_text: z.string().describe("Exact text to replace. Must match once unless replace_all=true."),
        new_text: z.string().describe("Replacement text."),
        replace_all: z.boolean().optional().describe("Replace all occurrences. Default: false."),
        expected_replacements: z.number().int().min(1).optional().describe("Fail if actual replacement count differs.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Editing file...",
        "openai/toolInvocation/invoked": "File edited"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const resolved = guard.resolve(workspace, args.path, { forWrite: true });
      assertWriteToolAllowed(config, resolved.relPath);
      const result = await editTextFile(config, guard, workspace, args.path, String(args.old_text ?? ""), String(args.new_text ?? ""), {
        replaceAll: parseBool(args.replace_all, false),
        expectedReplacements: args.expected_replacements
      });
      if (result.diff.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = `# Edit File\n\nPath: ${result.path}\nReplacements: ${result.replacements}\nBytes: ${result.bytes}\nSHA-256: ${result.sha256}\nDiff stats: +${result.diff.additions} -${result.diff.deletions}${diffBlock(result.diff.diff)}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: result.path,
        replacements: result.replacements,
        bytes: result.bytes,
        sha256: result.sha256,
        additions: result.diff.additions,
        deletions: result.diff.deletions,
        diff: result.diff.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Apply one unified diff patch inside the workspace. Paths are validated before applying. Prefer edit for tiny replacements and apply_patch for multi-file diffs.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        patch: z.string().describe("Unified diff patch to apply. File paths must stay inside the workspace and avoid blocked paths.")
      },
      annotations: LOCAL_WRITE_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Applying patch...",
        "openai/toolInvocation/invoked": "Patch applied"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = applyWorkspacePatch(config, guard, workspace, String(args.patch ?? ""));
      if (result.changed) invalidateWorkspaceAnalysis(workspace.id);
      const text = [
        "# Apply Patch",
        "",
        `Paths: ${result.paths.join(", ")}`,
        `Diff stats: +${result.additions} -${result.deletions}`,
        result.stderr ? `stderr: ${result.stderr}` : "",
        result.diff ? diffBlock(result.diff) : "No diff output."
      ].filter(Boolean).join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        paths: result.paths,
        stdout: result.stdout,
        stderr: result.stderr,
        additions: result.additions,
        deletions: result.deletions,
        changed: result.changed,
        diff: result.diff
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "bash",
    {
      title: "Bash",
      description:
        "Run one allowlisted verification command in the workspace, such as tests, build, lint, typecheck, or a project script. Do not use for git status/diff or file inspection; use show_changes, tree, search, and read instead. Do not chain commands with &&, pipes, redirects, or shell file readers.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        command: z.string().describe("Command to run."),
        session_id: z.string().optional().describe(config.requireBashSession && config.bashSessionId ? `Required bash session id for this server: ${config.bashSessionId}.` : "Optional bash session id. If configured on the server, a provided value must match it."),
        cwd: z.string().optional().describe("Working directory relative to workspace root. Default: ."),
        timeout_ms: z.number().int().min(1000).max(180000).optional().describe("Timeout in milliseconds. Default: 30000.")
      },
      annotations: BASH_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Running bash command...",
        "openai/toolInvocation/invoked": "Bash command finished"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const result = await runBash(config, guard, workspace, String(args.command ?? ""), {
        cwd: args.cwd,
        timeoutMs: args.timeout_ms,
        sessionId: args.session_id
      });
      const text = bashTextResult(config, result);
      return textResult(text, { workspace_id: workspace.id, root: workspace.root, ...result, bash_session_id: result.bashSessionId ?? null });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_status",
    {
      title: "Git Status",
      description: "Show git branch and changed files for the workspace.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git status...",
        "openai/toolInvocation/invoked": "Git status ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const status = gitStatus(config, workspace, guard, scopedPath);
      const statusError = looksLikeGitError(status) ? status : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      return textResult(status, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace status",
        status,
        status_error: statusError || undefined,
        changed_files: changedFiles,
        changed: !statusError && changedFiles.length > 0
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "git_diff",
    {
      title: "Git Diff",
      description: "Show current unstaged or staged git diff, optionally scoped to a file.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the raw unified diff in the response. Default: true. Set false for stats-only checks.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Reading git diff...",
        "openai/toolInvocation/invoked": "Git diff ready"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const rawDiff = normalizeGitOutput(gitDiff(config, guard, workspace, args.path, parseBool(args.staged, false)));
      const diffError = rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const stats = diffError ? { additions: 0, deletions: 0, changed: false } : diffStats(rawDiff);
      const includeDiff = parseBool(args.include_diff, true);
      const text = diffError
        ? diffError
        : includeDiff
        ? rawDiff
        : [
            "# Git Diff",
            "",
            `Workspace: ${workspace.root}`,
            `Path: ${args.path ?? "workspace diff"}`,
            `Staged: ${parseBool(args.staged, false)}`,
            `Diff stats: +${stats.additions} -${stats.deletions}`,
            "",
            "Raw diff omitted by include_diff=false."
          ].join("\n");
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace diff",
        staged: parseBool(args.staged, false),
        include_diff: includeDiff,
        diff_error: diffError || undefined,
        additions: stats.additions,
        deletions: stats.deletions,
        changed: !diffError && stats.changed,
        diff: diffError || includeDiff ? rawDiff : ""
      });
    }
  );

  registerCodexTool(
    config,
    server,
    "show_changes",
    {
      title: "Show Changes",
      description: "Summarize the current workspace changes in one review-oriented result with git status, diff stats, and optional diff. Use this instead of bash git status, bash git diff, git_status, or git_diff when reviewing work.",
      inputSchema: {
        workspace_id: z.string().optional().describe("Workspace id from open_workspace. Omit to use default workspace."),
        path: z.string().optional().describe("Optional file path relative to workspace root."),
        staged: z.boolean().optional().describe("Show staged diff. Default: false."),
        include_diff: z.boolean().optional().describe("Include the unified diff. Default: true."),
        since: z.enum(["last_shown", "workspace"]).optional().describe("Use last_shown to suppress unchanged repeated reviews. Default: last_shown."),
        mark_reviewed: z.boolean().optional().describe("Update the last-shown review checkpoint after this call. Default: true.")
      },
      annotations: READ_ONLY_ANNOTATIONS,
      _meta: {
        ...toolCardMeta(),
        "openai/toolInvocation/invoking": "Summarizing workspace changes...",
        "openai/toolInvocation/invoked": "Workspace changes summarized"
      }
    },
    async (args) => {
      const workspace = workspaces.getWorkspace(args.workspace_id);
      const scopedPath = typeof args.path === "string" ? args.path : undefined;
      const staged = parseBool(args.staged, false);
      const normalizedScopedPath = scopedPath?.trim() ? guard.resolve(workspace, scopedPath).relPath : undefined;
      const status = normalizeGitOutput(gitDiffStatus(config, guard, workspace, normalizedScopedPath, staged));
      const includeDiff = parseBool(args.include_diff, true);
      const rawDiff = includeDiff ? normalizeGitOutput(gitDiff(config, guard, workspace, normalizedScopedPath, staged)) : "";
      const rawNumstat = normalizeGitOutput(gitDiffNumstat(config, guard, workspace, normalizedScopedPath, staged));
      const statusError = looksLikeGitError(status) ? status : "";
      const diffError = includeDiff && rawDiff && looksLikeGitError(rawDiff) ? rawDiff : "";
      const numstatError = rawNumstat && looksLikeGitError(rawNumstat) ? rawNumstat : "";
      const changedFiles = statusError ? [] : changedStatusLines(status);
      const untrackedReview = statusError || staged
        ? { diff: "", files: [] as Array<Record<string, unknown>>, warnings: [] as string[] }
        : await untrackedReviewDiff(config, guard, workspace, changedFiles, includeDiff);
      const diff = diffError ? "" : [rawDiff, untrackedReview.diff].filter(Boolean).join("\n");
      const trackedStats = includeDiff && !diffError ? diffStats(rawDiff) : numstatError ? { additions: 0, deletions: 0, changed: false } : numstatStats(rawNumstat);
      const untrackedStats = untrackedReview.files.reduce<{ additions: number; deletions: number }>((totals, file) => {
        totals.additions += typeof file.additions === "number" ? file.additions : 0;
        return totals;
      }, { additions: 0, deletions: 0 });
      const stats = {
        additions: trackedStats.additions + untrackedStats.additions,
        deletions: trackedStats.deletions,
        changed: trackedStats.changed || untrackedReview.files.length > 0
      };
      const untrackedFingerprint = statusError ? "" : await untrackedReviewFingerprint(config, guard, workspace, changedFiles);
      const since = args.since === "workspace" ? "workspace" : "last_shown";
      const markReviewed = parseBool(args.mark_reviewed, true);
      const checkpointKey = reviewCheckpointKey(workspace, { path: normalizedScopedPath, staged });
      const fingerprint = reviewFingerprint(status, `${diff}\0${untrackedFingerprint}`);
      const checkpointHit = includeDiff && since === "last_shown" && reviewCheckpoints.get(checkpointKey) === fingerprint;
      const checkpointWritten = markReviewed && includeDiff;
      if (checkpointWritten) reviewCheckpoints.set(checkpointKey, fingerprint);
      const responseDiff = checkpointHit ? "" : includeDiff ? diff : "";
      const responseStats = checkpointHit ? { additions: 0, deletions: 0, changed: false } : stats;
      const changedPaths = statusError ? [] : changedPathsFromStatus(changedFiles);
      let analysis: Record<string, unknown> | undefined;
      if (config.analysisEnabled && changedPaths.length && !checkpointHit) {
        try {
          const impact = await reviewWorkspaceChanges(config, guard, workspace, { changedPaths });
          analysis = {
            schema_version: impact.schemaVersion,
            changed_paths: impact.changedPaths,
            affected_areas: impact.affectedAreas,
            dependent_files: impact.dependentFiles,
            related_tests: impact.relatedTests,
            risk_signals: impact.riskSignals,
            recommended_commands: impact.recommendedCommands,
            coverage: impact.coverage,
            warnings: impact.warnings,
            cache: impact.cache
          };
        } catch (error) {
          analysis = {
            schema_version: 1,
            changed_paths: changedPaths,
            affected_areas: [],
            dependent_files: [],
            related_tests: [],
            risk_signals: [],
            recommended_commands: [],
            warnings: [`Change analysis unavailable: ${errorText(error)}`]
          };
        }
      }
      const changedText = statusError
        ? `- Git status unavailable: ${statusError}`
        : checkpointHit
          ? "- No changes since last shown review."
          : changedFiles.length
          ? changedFiles.map((line) => `- ${line}`).join("\n")
          : "- No changed files.";
      const diffText = checkpointHit
        ? "\n\nNo new diff since last shown review."
        : includeDiff
        ? diffError
          ? `\n\nGit diff unavailable: ${diffError}`
          : diff
          ? diffBlock(diff)
            : "\n\nNo diff output."
        : "\n\nDiff omitted by request.";
      const analysisText = analysis
        ? `\n\n## Analysis\n\nAffected areas: ${(analysis.affected_areas as string[]).join(", ") || "none"}\nRisks: ${((analysis.risk_signals as Array<{ label?: string }>) ?? []).map((risk) => risk.label).filter(Boolean).join(", ") || "none"}\nRelated tests: ${((analysis.related_tests as Array<{ path?: string }>) ?? []).map((file) => file.path).filter(Boolean).join(", ") || "none"}`
        : "";
      const text = `# Show Changes\n\nWorkspace: ${workspace.root}\n\n## Changed\n\n${changedText}\n\n## Diff stats\n\n+${responseStats.additions} -${responseStats.deletions}${diffText}${analysisText}`;
      return textResult(text, {
        workspace_id: workspace.id,
        root: workspace.root,
        path: args.path ?? "workspace changes",
        status,
        status_error: statusError || undefined,
        diff_error: diffError || undefined,
        stat_error: numstatError || undefined,
        changed_files: checkpointHit ? [] : changedFiles,
        staged,
        include_diff: includeDiff,
        additions: responseStats.additions,
        deletions: responseStats.deletions,
        changed: !statusError && (checkpointHit ? false : changedFiles.length > 0 || responseStats.changed),
        diff: responseDiff,
        untracked_files: checkpointHit ? [] : untrackedReview.files,
        review_warnings: checkpointHit ? [] : untrackedReview.warnings,
        review_since: since,
        review_marked: checkpointWritten,
        review_checkpoint_hit: checkpointHit,
        ...(analysis ? { analysis } : {})
      });
    }
  );

  if (config.codexSessions !== "off") {
    registerCodexTool(
      config,
      server,
      "codex_sessions",
      {
        title: "Codex Sessions",
        description:
          "Opt-in, read-only local Codex session history browser. Lists metadata from the user's configured Codex session JSONL files without reading full transcripts.",
        inputSchema: {
          max_sessions: z.number().int().min(1).max(200).optional().describe("Maximum sessions to return. Default: 30."),
          query: z.string().optional().describe("Optional case-insensitive search over session id, title, cwd, and source path.")
        },
        annotations: READ_ONLY_ANNOTATIONS,
        _meta: {
          ...toolCardMeta(),
          "openai/toolInvocation/invoking": "Listing local Codex sessions...",
          "openai/toolInvocation/invoked": "Codex sessions ready"
        }
      },
      async (args) => {
        const result = await listCodexSessions(config, {
          maxSessions: args.max_sessions,
          query: args.query
        });
        const rows = result.sessions.length
          ? result.sessions.map((session) => `- ${session.session_id}  ${session.title || "(untitled)"}${session.project_dir ? `  cwd=${session.project_dir}` : ""}`).join("\n")
          : "- No Codex sessions found.";
        const text = `# Codex Sessions\n\nCodex dir: ${result.codex_dir}\nMode: ${config.codexSessions}\nTotal matched: ${result.total_found}\n\n${rows}`;
        return textResult(text, {
          codex_dir: result.codex_dir,
          roots: result.roots,
          sessions: result.sessions,
          total_found: result.total_found,
          codex_sessions_mode: config.codexSessions
        });
      }
    );

    if (config.codexSessions === "read") {
      registerCodexTool(
        config,
        server,
        "read_codex_session",
        {
          title: "Read Codex Session",
          description:
            "Opt-in, read-only local Codex transcript reader. Requires --codex-sessions read and returns a bounded transcript from a local Codex session JSONL file.",
          inputSchema: {
            session_id: z.string().optional().describe("Codex session id from codex_sessions."),
            source_path: z.string().optional().describe("Source path from codex_sessions. Must be inside the configured Codex session roots."),
            max_messages: z.number().int().min(1).max(400).optional().describe("Maximum transcript messages. Default: 80."),
            max_total_bytes: z.number().int().min(4000).max(400000).optional().describe("Maximum transcript content bytes. Default: 80000.")
          },
          annotations: READ_ONLY_ANNOTATIONS,
          _meta: {
            ...toolCardMeta(),
            "openai/toolInvocation/invoking": "Reading local Codex session...",
            "openai/toolInvocation/invoked": "Codex session read"
          }
        },
        async (args) => {
          const result = await readCodexSession(config, {
            sessionId: args.session_id,
            sourcePath: args.source_path,
            maxMessages: args.max_messages,
            maxTotalBytes: args.max_total_bytes
          });
          return textResult(result.text, {
            session: result.session,
            messages: result.messages,
            message_count: result.messages.length,
            truncated: result.truncated,
            codex_sessions_mode: config.codexSessions
          });
        }
      );
    }
  }

  return server;
}
