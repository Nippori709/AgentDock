import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError } from "./guard.js";
import { commandEnvironment, resolveShellCommand } from "./bashOps.js";
import { redactSensitiveText } from "./redact.js";

export type LocalHookEvent =
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove";

type HookCommand = {
  type?: string;
  command?: string;
  timeout?: number;
};

type HookGroup = {
  matcher?: string;
  hooks?: HookCommand[];
};

type ClaudeSettings = {
  hooks?: Partial<Record<LocalHookEvent, HookGroup[]>>;
};

const TOOL_NAME_MAP: Record<string, string> = {
  read: "Read", write: "Write", edit: "Edit", glob: "Glob", grep: "Grep", search: "Grep",
  lsp: "LSP", bash: "Bash", exec_start: "Bash", task_output: "TaskOutput", task_stop: "TaskStop",
  load_skill: "Skill", read_many: "Read", apply_patch: "Edit"
};

export function canonicalClaudeToolName(name: string): string {
  return TOOL_NAME_MAP[name] ?? name;
}

function readSettings(file: string): ClaudeSettings {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as ClaudeSettings : {};
  } catch {
    return {};
  }
}

function loadHookGroups(workspace: Workspace, event: LocalHookEvent): HookGroup[] {
  const files = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(workspace.root, ".claude", "settings.json"),
    path.join(workspace.root, ".claude", "settings.local.json")
  ];
  const groups: HookGroup[] = [];
  for (const file of files) {
    const value = readSettings(file).hooks?.[event];
    if (Array.isArray(value)) groups.push(...value);
  }
  return groups;
}

function matcherMatches(matcher: string | undefined, toolName: string): boolean {
  if (!matcher?.trim()) return true;
  const pattern = matcher.trim();
  try {
    return new RegExp(`^(?:${pattern})$`, "i").test(toolName);
  } catch {
    return pattern.toLowerCase() === toolName.toLowerCase();
  }
}

async function runCommandHook(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  hook: HookCommand,
  payload: Record<string, unknown>
): Promise<{ command: string; exit_code: number | null; stdout: string; stderr: string }> {
  const command = hook.command?.trim();
  if (!command) throw new LocalWorkspaceBridgeError("Claude-compatible command hook is missing command.");
  const timeoutMs = Math.max(1_000, Math.min(Math.floor((hook.timeout ?? 60) * 1000), 120_000));
  const shell = resolveShellCommand(config, command);
  return await new Promise((resolve, reject) => {
    const child = spawn(shell.executable, shell.args, {
      cwd: workspace.root,
      env: commandEnvironment(config),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32"
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout = (stdout + String(chunk)).slice(-32_000); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + String(chunk)).slice(-32_000); });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({
        command,
        exit_code: code,
        stdout: redactSensitiveText(stdout.trim()),
        stderr: redactSensitiveText(stderr.trim())
      });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function runLocalHooks(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  event: LocalHookEvent,
  toolName: string,
  toolInput: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): Promise<Array<{ command: string; exit_code: number | null; stdout: string; stderr: string }>> {
  if (!config.hooksEnabled) return [];
  const canonical = canonicalClaudeToolName(toolName);
  const groups = loadHookGroups(workspace, event).filter((group) => matcherMatches(group.matcher, canonical));
  const payload = {
    hook_event_name: event,
    tool_name: canonical,
    tool_input: toolInput,
    cwd: workspace.root,
    ...extra
  };
  const results = [];
  for (const group of groups) {
    for (const hook of group.hooks ?? []) {
      if ((hook.type ?? "command") !== "command") continue;
      const result = await runCommandHook(config, workspace, hook, payload);
      results.push(result);
      if (event === "PreToolUse" && result.exit_code !== 0) {
        throw new LocalWorkspaceBridgeError(
          `PreToolUse hook blocked ${canonical}: ${result.stderr || result.stdout || `exit ${result.exit_code}`}`
        );
      }
    }
  }
  return results;
}
