import type { LocalWorkspaceBridgeConfig } from "./config.js";
import { getExecManager } from "./execOps.js";
import { LocalWorkspaceBridgeError, type Workspace } from "./guard.js";
import { getTerminalManager } from "./terminalOps.js";

type TaskKind = "process" | "terminal";

function parseTaskId(taskId: string): { kind: TaskKind; id: string } {
  const match = /^(process|terminal):(.+)$/.exec(taskId);
  if (!match) {
    throw new LocalWorkspaceBridgeError("task_id must be an exact ID returned by task_list/task_output, such as process:<id> or terminal:<id>.");
  }
  return { kind: match[1] as TaskKind, id: match[2] };
}

export function listTasks(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  sessionId?: string
) {
  const processes = getExecManager(config).list(workspace, sessionId).map((item) => ({
    task_id: `process:${item.process_id}`,
    kind: "process" as const,
    running: item.running,
    state: item.state,
    label: item.command,
    cwd: item.cwd,
    cursor: item.next_cursor,
    exit_code: item.exit_code,
    spill_path: item.spill_path
  }));
  const terminals = config.bashMode === "full" && config.toolMode !== "minimal"
    ? getTerminalManager(config).list(workspace, sessionId).map((item) => ({
    task_id: `terminal:${item.terminal_id}`,
    kind: "terminal" as const,
    running: item.running,
    state: item.running ? "running" : "exited",
    label: item.shell,
    cwd: item.cwd,
    cursor: item.cursor,
    exit_code: item.exit_code,
    spill_path: null
    }))
    : [];
  return [...processes, ...terminals];
}

export async function readTaskOutput(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  taskId: string,
  options: { sessionId?: string; cursor?: number; waitMs?: number; maxChars?: number } = {}
) {
  const task = parseTaskId(taskId);
  if (task.kind === "process") {
    const result = await getExecManager(config).poll(workspace, task.id, {
      sessionId: options.sessionId,
      cursor: options.cursor,
      waitMs: options.waitMs,
      maxChars: options.maxChars
    });
    return {
      task_id: taskId,
      kind: task.kind,
      cursor_kind: "event",
      ...result
    };
  }

  let result = getTerminalManager(config).read(workspace, task.id, {
    sessionId: options.sessionId,
    cursor: options.cursor,
    maxChars: options.maxChars
  });
  const waitMs = options.waitMs ?? 0;
  if (waitMs > 0 && !result.output && result.running) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 10_000)));
    result = getTerminalManager(config).read(workspace, task.id, {
      sessionId: options.sessionId,
      cursor: options.cursor,
      maxChars: options.maxChars
    });
  }
  return {
    task_id: taskId,
    kind: task.kind,
    cursor_kind: "character",
    ...result
  };
}

export async function stopTask(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  taskId: string,
  sessionId?: string
) {
  const task = parseTaskId(taskId);
  if (task.kind === "process") {
    const result = await getExecManager(config).stop(workspace, task.id, sessionId);
    return { task_id: taskId, kind: task.kind, ...result };
  }
  const result = getTerminalManager(config).close(workspace, task.id, sessionId);
  return { task_id: taskId, kind: task.kind, ...result };
}
