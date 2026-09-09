import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import { PathGuard, WorkspaceManager, LocalWorkspaceBridgeError, type Workspace } from "./guard.js";
import { assertBashSession, assertSafeCommand, commandEnvironment, resolveShellCommand, terminateProcessTree } from "./bashOps.js";
import { redactSensitiveText } from "./redact.js";
import { getBrowserSessionManager } from "./browserSessionOps.js";

type State = "running" | "exited" | "failed" | "stopping" | "stopped" | "timed_out";
interface Output { cursor: number; stream: "stdout" | "stderr"; text: string }
interface Job {
  id: string; requestId: string; signature: string; workspace: Workspace;
  command: string; cwd: string; shell: string; mode: string; child: ChildProcessWithoutNullStreams;
  started: number; ended?: number; state: State; exitCode: number | null; signal: string | null;
  events: Output[]; next: number; bytes: number; timer: NodeJS.Timeout;
  done: Promise<void>; finish: () => void; stopping?: Promise<void>;
  inputBusy?: boolean;
}
const MAX_JOBS = 32;
const MAX_RUNNING = 8;
const MAX_LOG_BYTES = 1024 * 1024;
const RETENTION_MS = 60 * 60 * 1000;

/** One service runtime, shared across HTTP requests, never across config identities. */
export class ExecManager {
  private jobs = new Map<string, Job>();
  private retired = new Map<string, number>();
  private disposed = false;
  constructor(private config: LocalWorkspaceBridgeConfig) {}

  private prune() {
    const now = Date.now();
    for (const [key, retiredAt] of this.retired) if (now - retiredAt > RETENTION_MS) this.retired.delete(key);
    for (const [id, job] of this.jobs) {
      if (job.ended && now - job.ended > RETENTION_MS) {
        this.retired.set(JSON.stringify([job.workspace.root, job.requestId]), now);
        this.jobs.delete(id);
      }
    }
  }

  private authorize(workspace: Workspace, sessionId?: string) {
    assertBashSession(this.config, sessionId);
    if (this.config.connectionTest || this.config.bashMode === "off" || this.config.toolMode === "minimal") throw new LocalWorkspaceBridgeError("Execution is disabled by current runtime policy.");
    new WorkspaceManager(this.config).openWorkspace(workspace.root);
    new PathGuard(this.config).resolve(workspace, ".");
  }

  private get(workspace: Workspace, id: string, sessionId?: string): Job {
    this.authorize(workspace, sessionId);
    this.prune();
    const job = this.jobs.get(id);
    if (!job || job.workspace.root !== workspace.root) throw new LocalWorkspaceBridgeError("Unknown process_id in this workspace. Use exec_list; do not guess IDs.");
    return job;
  }

  private append(job: Job, stream: Output["stream"], text: string) {
    // Redact complete lines before pagination so tokens split across pipe chunks cannot leak.
    const safe = redactSensitiveText(text);
    for (let offset = 0; offset < safe.length; offset += 4000) {
      const event = { cursor: job.next++, stream, text: safe.slice(offset, offset + 4000) };
      job.events.push(event);
      job.bytes += Buffer.byteLength(event.text);
    }
    while ((job.bytes > MAX_LOG_BYTES || job.events.length > 4096) && job.events.length) job.bytes -= Buffer.byteLength(job.events.shift()!.text);
  }

  private capture(job: Job, stream: "stdout" | "stderr") {
    let pending = "";
    let dropping = false;
    job.child[stream].setEncoding("utf8");
    job.child[stream].on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (!dropping && line.length <= 65536) this.append(job, stream, line + "\n");
        else this.append(job, stream, "[oversized output line omitted]\n");
        dropping = false;
      }
      if (pending.length > 65536) { pending = ""; dropping = true; }
    });
    job.child[stream].on("end", () => {
      if (dropping) this.append(job, stream, "[oversized output line omitted]\n");
      else if (pending) this.append(job, stream, pending);
      pending = "";
    });
  }

  async start(workspace: Workspace, command: string, options: {
    requestId: string; cwd?: string; sessionId?: string; timeoutMs?: number; waitMs?: number;
  }) {
    this.authorize(workspace, options.sessionId);
    this.prune();
    if (this.disposed) throw new LocalWorkspaceBridgeError("Execution manager is shutting down.");
    if (!command.trim() || command.length > 32000) throw new LocalWorkspaceBridgeError("command must contain 1–32000 characters.");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(options.requestId)) throw new LocalWorkspaceBridgeError("request_id must contain 1–128 letters, digits, dots, underscores or hyphens.");
    assertSafeCommand(this.config, command);
    const cwd = new PathGuard(this.config).resolve(workspace, options.cwd ?? ".");
    const timeoutMs = options.timeoutMs ?? 3600000;
    if (options.waitMs !== undefined && (!Number.isInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 10000)) throw new LocalWorkspaceBridgeError("wait_ms must be 0–10000.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 43200000) throw new LocalWorkspaceBridgeError("timeout_ms must be 1000–43200000.");
    const shell = resolveShellCommand(this.config, command);
    const signature = JSON.stringify([command, cwd.absPath, timeoutMs, shell]);
    for (const job of this.jobs.values()) {
      if (job.requestId === options.requestId && job.workspace.root === workspace.root) {
        if (job.signature !== signature) throw new LocalWorkspaceBridgeError("request_id already belongs to a different command. Use a new ID for new work.");
        return this.poll(workspace, job.id, { sessionId: options.sessionId, waitMs: options.waitMs });
      }
    }
    for (const [key, retiredAt] of this.retired) if (Date.now() - retiredAt > RETENTION_MS) this.retired.delete(key);
    const requestKey = JSON.stringify([workspace.root, options.requestId]);
    if (this.retired.has(requestKey)) throw new LocalWorkspaceBridgeError("This launch's result was evicted; it will not be restarted. Choose a new request_id only for a deliberate new launch.");
    const retire = (job: Job) => {
      this.retired.set(JSON.stringify([job.workspace.root, job.requestId]), Date.now());
      this.jobs.delete(job.id);
    };
    if (this.retired.size > 4096) throw new LocalWorkspaceBridgeError("Launch retry history is full; wait for its one-hour retention to expire.");
    for (const job of this.jobs.values()) if (job.ended && Date.now() - job.ended > RETENTION_MS) retire(job);
    if ([...this.jobs.values()].filter(job => !job.ended).length >= MAX_RUNNING) throw new LocalWorkspaceBridgeError("At most 8 processes may run. Stop an existing process first.");
    if (this.jobs.size >= MAX_JOBS) {
      const completed = [...this.jobs.values()].find(job => job.ended);
      if (completed) retire(completed);
    }
    const child = spawn(shell.executable, shell.args, {
      cwd: cwd.absPath, env: commandEnvironment(this.config), stdio: "pipe",
      detached: process.platform !== "win32", windowsHide: true
    });
    let finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const job: Job = {
      id: randomUUID(), requestId: options.requestId, signature, workspace, command: redactSensitiveText(command),
      cwd: cwd.relPath || ".", shell: shell.shell, mode: this.config.bashMode, child,
      started: Date.now(), state: "running", exitCode: null, signal: null,
      events: [], next: 0, bytes: 0, done, finish,
      timer: setTimeout(() => { void this.stopJob(job, "timed_out"); }, timeoutMs)
    };
    job.timer.unref();
    this.jobs.set(job.id, job);
    this.capture(job, "stdout");
    this.capture(job, "stderr");
    child.stdin.on("error", () => {}); // EPIPE is reported by the write callback, never crashes the server.
    child.once("error", error => {
      this.append(job, "stderr", error.message + "\n");
      job.state = "failed";
    });
    child.once("close", (code, signal) => {
      clearTimeout(job.timer);
      job.exitCode = code;
      job.signal = signal;
      job.ended = Date.now();
      if (job.state === "running") job.state = "exited";
      else if (job.state === "stopping") job.state = "stopped";
      job.finish();
    });
    return this.poll(workspace, job.id, { sessionId: options.sessionId, waitMs: options.waitMs ?? 1000 });
  }

  async poll(workspace: Workspace, id: string, options: { sessionId?: string; cursor?: number; waitMs?: number; maxChars?: number } = {}) {
    const job = this.get(workspace, id, options.sessionId);
    const cursor = options.cursor ?? 0;
    const waitMs = options.waitMs ?? 0;
    const maxChars = options.maxChars ?? 12000;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > job.next) throw new LocalWorkspaceBridgeError("Invalid output cursor.");
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw new LocalWorkspaceBridgeError("wait_ms must be 0–10000.");
    if (!Number.isInteger(maxChars) || maxChars < 4000 || maxChars > 24000) throw new LocalWorkspaceBridgeError("max_chars must be 4000–24000.");
    if (!job.ended && waitMs && cursor === job.next) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([job.done, new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]);
      clearTimeout(timer);
    }
    // Recheck permissions after waiting: the control center can change them mid-call.
    this.authorize(workspace, options.sessionId);
    const first = job.events[0]?.cursor ?? job.next;
    const output: Output[] = [];
    let chars = 0;
    for (const event of job.events) {
      if (event.cursor < cursor) continue;
      if (chars + event.text.length > maxChars) break;
      output.push(event); chars += event.text.length;
    }
    const nextCursor = output.length ? output.at(-1)!.cursor + 1 : Math.max(cursor, first);
    return { process_id: job.id, request_id: job.requestId, workspace_id: workspace.id,
      state: job.state, running: !job.ended, command: job.command, cwd: job.cwd, shell: job.shell,
      exit_code: job.exitCode, signal: job.signal, duration_ms: (job.ended ?? Date.now()) - job.started,
      output, next_cursor: nextCursor, has_more: nextCursor < job.next, output_lost: cursor < first,
      output_note: "Logs are redacted and emitted at newline or process exit; partial lines are buffered. Pipes, not a PTY."
    };
  }

  list(workspace: Workspace, sessionId?: string) {
    this.authorize(workspace, sessionId);
    this.prune();
    return [...this.jobs.values()].filter(job => job.workspace.root === workspace.root).map(job => ({
      process_id: job.id, request_id: job.requestId, command: job.command, cwd: job.cwd,
      state: job.state, running: !job.ended, exit_code: job.exitCode, next_cursor: job.next
    }));
  }

  async input(workspace: Workspace, id: string, text: string, eof: boolean, sessionId?: string) {
    const job = this.get(workspace, id, sessionId);
    if (this.config.bashMode !== "full" || job.mode !== "full") throw new LocalWorkspaceBridgeError("stdin requires a process started in full bash mode and full mode still enabled.");
    if (job.ended || job.state !== "running" || job.child.stdin.destroyed || job.child.stdin.writableEnded) throw new LocalWorkspaceBridgeError("Process stdin is closed.");
    if (job.inputBusy) throw new LocalWorkspaceBridgeError("A previous stdin write is still pending. Do not repeat input; inspect or stop the process.");
    if (Buffer.byteLength(text) > 16000) throw new LocalWorkspaceBridgeError("stdin is limited to 16000 bytes per call.");
    if (text) await new Promise<void>((resolve, reject) => {
      job.inputBusy = true;
      const timer = setTimeout(() => reject(new LocalWorkspaceBridgeError("stdin write is still pending after 5 seconds and may be delivered later. Do not retry blindly; inspect or stop the process.")), 5000);
      job.child.stdin.write(text, error => {
        clearTimeout(timer); job.inputBusy = false;
        if (error) reject(error); else resolve();
      });
    });
    if (eof) job.child.stdin.end();
    return { process_id: id, accepted_bytes: Buffer.byteLength(text), eof };
  }

  private async stopJob(job: Job, reason: "stopped" | "timed_out") {
    if (job.ended) return;
    if (job.stopping) return job.stopping;
    job.state = reason === "timed_out" ? reason : "stopping";
    job.stopping = terminateProcessTree(job.child).catch(error => {
      this.append(job, "stderr", `Process termination failed: ${String(error)}\n`);
    });
    await job.stopping;
  }

  async stop(workspace: Workspace, id: string, sessionId?: string) {
    const job = this.get(workspace, id, sessionId);
    await this.stopJob(job, "stopped");
    return this.poll(workspace, id, { sessionId });
  }

  async reconcile() {
    await Promise.all([...this.jobs.values()].map(async job => {
      try {
        this.authorize(job.workspace, this.config.bashSessionId);
        if (job.mode !== this.config.bashMode) throw new Error("Execution mode changed");
      } catch { await this.stopJob(job, "stopped"); }
    }));
  }

  async dispose() {
    this.disposed = true;
    await Promise.all([...this.jobs.values()].map(job => this.stopJob(job, "stopped")));
  }
}

const managers = new WeakMap<LocalWorkspaceBridgeConfig, ExecManager>();
export function getExecManager(config: LocalWorkspaceBridgeConfig) {
  let manager = managers.get(config);
  if (!manager) { manager = new ExecManager(config); managers.set(config, manager); }
  return manager;
}

/** Called only by executable entrypoints, not library imports or short-lived HTTP MCP instances. */
export function installExecShutdown(config: LocalWorkspaceBridgeConfig) {
  let stopping = false;
  const shutdown = (code: number) => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(code), 5000);
    deadline.unref();
    void Promise.allSettled([getExecManager(config).dispose(), getBrowserSessionManager(config).dispose()]).finally(() => process.exit(code));
  };
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
}
