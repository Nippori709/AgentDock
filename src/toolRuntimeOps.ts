import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { minimatch } from "minimatch";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import { isWithinAllowedRoots, LocalWorkspaceBridgeError } from "./guard.js";
import { redactSensitiveText, redactStructured } from "./redact.js";

const RETAINABLE_TOOLS = new Set([
  "inspect_workspace",
  "search",
  "grep",
  "lsp",
  "bash",
  "exec_poll",
  "terminal_read",
  "git_diff",
  "show_changes",
  "task_output",
  "Grep",
  "LSP",
  "Bash",
  "TaskOutput"
]);

const INLINE_RESULT_BUDGETS: Record<string, number> = {
  inspect_workspace: 48_000,
  search: 48_000,
  grep: 48_000,
  lsp: 48_000,
  bash: 56_000,
  exec_poll: 48_000,
  terminal_read: 36_000,
  git_diff: 56_000,
  show_changes: 56_000,
  task_output: 48_000,
  Grep: 48_000,
  LSP: 48_000,
  Bash: 56_000,
  TaskOutput: 48_000
};

const TOOL_ALIASES: Record<string, string[]> = {
  Bash: ["bash", "exec_start", "exec_input", "terminal_send"],
  Read: ["read", "read_many", "read_pdf", "read_pdf_page", "read_docx", "read_image", "read_image_crop", "read_image_tile", "image_info"],
  Write: ["write"],
  Edit: ["edit", "apply_patch"],
  Glob: ["glob"],
  Grep: ["grep", "search"],
  LSP: ["lsp"],
  Browser: ["browser_action", "browser_snapshot", "browser_screenshot"],
  Task: ["task_list", "task_output", "task_stop", "exec_start", "exec_poll", "exec_stop", "terminal_open", "terminal_read", "terminal_close"]
};

interface ParsedRule {
  raw: string;
  tool: string;
  pattern?: string;
}

function parseRule(rawRule: string): ParsedRule | undefined {
  const raw = rawRule.trim();
  if (!raw) return undefined;
  const match = /^([A-Za-z0-9_.-]+)(?:\((.*)\))?$/.exec(raw);
  if (!match) return undefined;
  return { raw, tool: match[1], pattern: match[2]?.trim() || undefined };
}

function canonicalToolCandidates(ruleTool: string): string[] {
  const alias = TOOL_ALIASES[ruleTool];
  if (alias) return [ruleTool, ...alias];
  const found = Object.entries(TOOL_ALIASES).find(([key]) => key.toLowerCase() === ruleTool.toLowerCase());
  if (found) return [found[0], ...found[1]];
  return [ruleTool];
}

function permissionSubject(name: string, args: Record<string, unknown>): string {
  const normalized = name.toLowerCase();
  if (normalized === "bash" || normalized === "exec_start") return String(args.command ?? "");
  if (name === "exec_input" || name === "terminal_send") return String(args.text ?? args.input ?? "");
  if (normalized === "lsp") return [args.operation, args.file_path ?? args.path, args.query].filter(Boolean).join(" ");
  if (normalized === "notebookedit") return String(args.notebook_path ?? "");
  if (["read", "write", "edit"].includes(normalized) && typeof args.file_path === "string") return args.file_path;
  if (name.startsWith("browser_")) return [args.action, args.url, args.selector].filter(Boolean).join(" ");
  if (typeof args.path === "string") return args.path;
  if (Array.isArray(args.paths)) return args.paths.map(String).join(";");
  if (name === "apply_patch") return "<patch>";
  return "";
}

function ruleMatches(rule: ParsedRule, name: string, args: Record<string, unknown>): boolean {
  const candidates = canonicalToolCandidates(rule.tool);
  if (!candidates.some((candidate) => candidate.toLowerCase() === name.toLowerCase())) return false;
  if (!rule.pattern || rule.pattern === "*") return true;
  const subject = permissionSubject(name, args);
  if (!subject) return false;
  return minimatch(subject, rule.pattern, {
    nocase: process.platform === "win32",
    dot: true,
    matchBase: true,
    nocomment: true,
    nonegate: true
  });
}

function isMutatingOrOpenWorld(options: Record<string, unknown>): boolean {
  const annotations = options.annotations as Record<string, unknown> | undefined;
  return annotations?.destructiveHint === true || annotations?.openWorldHint === true || annotations?.readOnlyHint === false;
}

export function enforceToolPermissionRules(
  config: LocalWorkspaceBridgeConfig,
  name: string,
  args: Record<string, unknown>,
  options: Record<string, unknown>
): void {
  const denyRules = config.permissionDenyRules.map(parseRule).filter((rule): rule is ParsedRule => Boolean(rule));
  const allowRules = config.permissionAllowRules.map(parseRule).filter((rule): rule is ParsedRule => Boolean(rule));

  const denied = denyRules.find((rule) => ruleMatches(rule, name, args));
  if (denied) {
    throw new LocalWorkspaceBridgeError(`Tool call denied by permission rule: ${denied.raw}`);
  }

  if (config.permissionPolicy !== "strict" || !isMutatingOrOpenWorld(options)) return;
  const allowed = allowRules.find((rule) => ruleMatches(rule, name, args));
  if (!allowed) {
    const subject = redactSensitiveText(permissionSubject(name, args)).slice(0, 240);
    throw new LocalWorkspaceBridgeError(
      `Strict permission policy blocked ${name}${subject ? `(${subject})` : ""}. Add an allow rule or switch permission policy to denylist.`
    );
  }
}

function resultRoot(config: LocalWorkspaceBridgeConfig, result: any): string | undefined {
  const structured = result?.structuredContent;
  const candidate = structured && typeof structured === "object" && !Array.isArray(structured)
    ? (structured as Record<string, unknown>).root
    : undefined;
  const requested = typeof candidate === "string" && candidate ? path.resolve(candidate) : path.resolve(config.defaultRoot);
  if (!fs.existsSync(requested)) return undefined;
  const root = fs.realpathSync(requested);
  const allowed = isWithinAllowedRoots(root, config.allowedRoots);
  if (!allowed) return undefined;
  return root;
}

function truncateText(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const head = Math.max(1, Math.floor(budget * 0.7));
  const tail = Math.max(1, budget - head);
  return `${value.slice(0, head)}\n...[tool result truncated; complete result retained when possible]...\n${value.slice(-tail)}`;
}

function compactValue(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || value === undefined) return value;
  if (typeof value === "string") return truncateText(value, 16_000);
  if (Array.isArray(value)) {
    const limit = 120;
    const items = value.slice(0, limit).map((item) => compactValue(item, depth + 1));
    if (value.length > limit) items.push(`...[array truncated: ${value.length - limit} more items]`);
    return items;
  }
  if (typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = compactValue(item, depth + 1);
  }
  return out;
}

function serializeForRetention(result: any): string {
  try {
    return JSON.stringify(redactStructured(result), null, 2);
  } catch {
    return redactSensitiveText(String(result));
  }
}

function attachRetentionMetadata(result: any, metadata: Record<string, unknown>): any {
  if (!result || typeof result !== "object") return result;
  const structured =
    result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
      ? result.structuredContent
      : {};
  result.structuredContent = { ...structured, ...metadata };
  return result;
}

export function applyToolResultRetention(
  config: LocalWorkspaceBridgeConfig,
  name: string,
  result: any
): any {
  if (!RETAINABLE_TOOLS.has(name) || !result || typeof result !== "object") return result;

  const serialized = serializeForRetention(result);
  const serializedBytes = Buffer.byteLength(serialized, "utf8");
  const inlineBudget = INLINE_RESULT_BUDGETS[name] ?? 48_000;
  if (serializedBytes <= inlineBudget) return result;

  let retainedPath: string | null = null;
  let retainedCapped = false;
  const root = resultRoot(config, result);
  if (config.toolResultRetention && config.writeMode === "workspace" && root) {
    try {
      const dir = path.join(root, ".ai-bridge", "tool-results");
      fs.mkdirSync(dir, { recursive: true });
      const safeName = name.replace(/[^A-Za-z0-9_.-]+/g, "-");
      const absolute = path.join(dir, `${Date.now()}-${safeName}-${randomUUID()}.json.txt`);
      let payload = serialized;
      const bytes = Buffer.byteLength(payload, "utf8");
      if (bytes > config.maxToolResultBytes) {
        const buffer = Buffer.from(payload, "utf8");
        payload = buffer.subarray(0, config.maxToolResultBytes).toString("utf8") +
          "\n...[retained tool result capped by maxToolResultBytes]\n";
        retainedCapped = true;
      }
      fs.writeFileSync(absolute, payload, { encoding: "utf8", mode: 0o600 });
      retainedPath = path.relative(root, absolute).split(path.sep).join("/");
    } catch {
      retainedPath = null;
    }
  }

  if (Array.isArray(result.content)) {
    result.content = result.content.map((item: any) => {
      if (!item || typeof item !== "object" || item.type !== "text" || typeof item.text !== "string") return item;
      return { ...item, text: truncateText(item.text, Math.max(8_000, Math.floor(inlineBudget * 0.55))) };
    });
  }
  if (result.structuredContent && typeof result.structuredContent === "object") {
    result.structuredContent = compactValue(result.structuredContent);
  }

  return attachRetentionMetadata(result, {
    retained_result_path: retainedPath,
    retained_result_bytes: serializedBytes,
    retained_result_capped: retainedCapped,
    inline_result_truncated: true
  });
}
