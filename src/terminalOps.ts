import { randomUUID } from "node:crypto";
import * as pty from "node-pty";
import type { LocalWorkspaceBridgeConfig, ShellMode } from "./config.js";
import { assertBashSession, commandEnvironment } from "./bashOps.js";
import { LocalWorkspaceBridgeError, PathGuard, WorkspaceManager, type Workspace } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

interface TerminalSession {
  id: string;
  workspace: Workspace;
  terminal: pty.IPty;
  cwd: string;
  shell: string;
  started: number;
  touched: number;
  baseCursor: number;
  nextCursor: number;
  buffer: string;
  pendingRaw: string;
  exited: boolean;
  exitCode: number | null;
}

const MAX_TERMINALS = 4;
const MAX_BUFFER_CHARS = 1_000_000;
const MAX_SEND_BYTES = 16_000;

function resolveInteractiveShell(config: LocalWorkspaceBridgeConfig): { executable: string; args: string[]; label: string } {
  const mode: ShellMode = config.shellMode;
  if (process.platform === "win32") {
    if (mode === "bash") return { executable: config.bashPath || "bash.exe", args: ["--noprofile", "--norc"], label: "bash" };
    if (mode === "pwsh") return { executable: "pwsh.exe", args: ["-NoLogo", "-NoProfile"], label: "pwsh" };
    if (mode === "cmd") return { executable: process.env.ComSpec || "cmd.exe", args: [], label: "cmd" };
    return {
      executable: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-NoExit", "-Command", "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); [Console]::InputEncoding=[System.Text.UTF8Encoding]::new()"],
      label: "powershell"
    };
  }
  if (mode === "pwsh") return { executable: "pwsh", args: ["-NoLogo", "-NoProfile"], label: "pwsh" };
  if (mode === "cmd") throw new LocalWorkspaceBridgeError("cmd shell is only available on Windows.");
  return { executable: config.bashPath || "/bin/bash", args: ["--noprofile", "--norc"], label: "bash" };
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();
  private disposed = false;

  constructor(private readonly config: LocalWorkspaceBridgeConfig) {}

  private authorize(workspace: Workspace, sessionId?: string): void {
    assertBashSession(this.config, sessionId);
    if (this.disposed) throw new LocalWorkspaceBridgeError("Terminal manager is shutting down.");
    if (this.config.connectionTest || this.config.bashMode !== "full" || this.config.toolMode === "minimal") {
      throw new LocalWorkspaceBridgeError("Persistent terminal requires bash=full and standard/full tool mode.");
    }
    new WorkspaceManager(this.config).openWorkspace(workspace.root);
    new PathGuard(this.config).resolve(workspace, ".");
  }

  private get(workspace: Workspace, id: string, sessionId?: string): TerminalSession {
    this.authorize(workspace, sessionId);
    const session = this.sessions.get(id);
    if (!session || session.workspace.root !== workspace.root) {
      throw new LocalWorkspaceBridgeError("Unknown terminal_id in this workspace. Use terminal_list; do not guess IDs.");
    }
    session.touched = Date.now();
    return session;
  }

  private appendSafe(session: TerminalSession, text: string): void {
    const safe = redactSensitiveText(text);
    session.buffer += safe;
    session.nextCursor += safe.length;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      const remove = session.buffer.length - MAX_BUFFER_CHARS;
      session.buffer = session.buffer.slice(remove);
      session.baseCursor += remove;
    }
    session.touched = Date.now();
  }

  private acceptPtyData(session: TerminalSession, raw: string): void {
    session.pendingRaw += raw;
    while (true) {
      const newline = session.pendingRaw.indexOf("\n");
      if (newline < 0) break;
      const complete = session.pendingRaw.slice(0, newline + 1);
      session.pendingRaw = session.pendingRaw.slice(newline + 1);
      this.appendSafe(session, complete);
    }
    if (session.pendingRaw.length > 65_536) {
      this.appendSafe(session, "[oversized terminal line omitted]\n");
      session.pendingRaw = "";
    }
    session.touched = Date.now();
  }

  open(workspace: Workspace, options: { cwd?: string; sessionId?: string; cols?: number; rows?: number } = {}) {
    this.authorize(workspace, options.sessionId);
    if (this.sessions.size >= MAX_TERMINALS) {
      throw new LocalWorkspaceBridgeError(`At most ${MAX_TERMINALS} persistent terminals may be open. Close one first.`);
    }
    const resolved = new PathGuard(this.config).resolve(workspace, options.cwd ?? ".");
    const cols = Math.max(40, Math.min(options.cols ?? 120, 300));
    const rows = Math.max(10, Math.min(options.rows ?? 40, 120));
    const shell = resolveInteractiveShell(this.config);
    const terminal = pty.spawn(shell.executable, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: resolved.absPath,
      env: commandEnvironment(this.config) as Record<string, string>
    });
    const now = Date.now();
    const session: TerminalSession = {
      id: randomUUID(),
      workspace,
      terminal,
      cwd: resolved.relPath || ".",
      shell: shell.label,
      started: now,
      touched: now,
      baseCursor: 0,
      nextCursor: 0,
      buffer: "",
      pendingRaw: "",
      exited: false,
      exitCode: null
    };
    terminal.onData((raw) => this.acceptPtyData(session, raw));
    terminal.onExit(({ exitCode }) => {
      if (session.pendingRaw) {
        this.appendSafe(session, session.pendingRaw);
        session.pendingRaw = "";
      }
      session.exited = true;
      session.exitCode = exitCode;
      session.touched = Date.now();
    });
    this.sessions.set(session.id, session);
    return {
      terminal_id: session.id,
      workspace_id: workspace.id,
      cwd: session.cwd,
      shell: session.shell,
      cols,
      rows,
      cursor: session.nextCursor,
      running: true
    };
  }

  read(workspace: Workspace, id: string, options: { sessionId?: string; cursor?: number; maxChars?: number } = {}) {
    const session = this.get(workspace, id, options.sessionId);
    const requested = options.cursor ?? session.baseCursor;
    const maxChars = Math.max(1000, Math.min(options.maxChars ?? 12_000, 24_000));
    if (!Number.isInteger(requested) || requested < 0 || requested > session.nextCursor) {
      throw new LocalWorkspaceBridgeError("Invalid terminal cursor.");
    }
    const effective = Math.max(requested, session.baseCursor);
    const localOffset = effective - session.baseCursor;
    const committed = session.buffer.slice(localOffset, localOffset + maxChars);
    const nextCursor = effective + committed.length;
    const hasMore = nextCursor < session.nextCursor;
    const partial = !hasMore && nextCursor >= session.nextCursor && session.pendingRaw
      ? redactSensitiveText(session.pendingRaw).slice(0, Math.max(0, maxChars - committed.length))
      : "";
    return {
      terminal_id: session.id,
      workspace_id: workspace.id,
      cwd: session.cwd,
      shell: session.shell,
      running: !session.exited,
      exit_code: session.exitCode,
      output: committed + partial,
      next_cursor: nextCursor,
      has_more: hasMore,
      output_lost: requested < session.baseCursor,
      partial_output: Boolean(partial)
    };
  }

  send(workspace: Workspace, id: string, text: string, sessionId?: string) {
    const session = this.get(workspace, id, sessionId);
    if (session.exited) throw new LocalWorkspaceBridgeError("Terminal has exited.");
    if (Buffer.byteLength(text, "utf8") > MAX_SEND_BYTES) {
      throw new LocalWorkspaceBridgeError(`terminal_send is limited to ${MAX_SEND_BYTES} bytes per call.`);
    }
    session.terminal.write(text);
    session.touched = Date.now();
    return { terminal_id: id, accepted_bytes: Buffer.byteLength(text, "utf8") };
  }

  signal(workspace: Workspace, id: string, signal: "interrupt" | "eof", sessionId?: string) {
    const session = this.get(workspace, id, sessionId);
    if (session.exited) return { terminal_id: id, signal, running: false };
    session.terminal.write(signal === "interrupt" ? "\x03" : process.platform === "win32" ? "\x1a" : "\x04");
    session.touched = Date.now();
    return { terminal_id: id, signal, running: true };
  }

  resize(workspace: Workspace, id: string, cols: number, rows: number, sessionId?: string) {
    const session = this.get(workspace, id, sessionId);
    if (session.exited) throw new LocalWorkspaceBridgeError("Terminal has exited.");
    const safeCols = Math.max(40, Math.min(cols, 300));
    const safeRows = Math.max(10, Math.min(rows, 120));
    session.terminal.resize(safeCols, safeRows);
    return { terminal_id: id, cols: safeCols, rows: safeRows };
  }

  list(workspace: Workspace, sessionId?: string) {
    this.authorize(workspace, sessionId);
    return [...this.sessions.values()]
      .filter((session) => session.workspace.root === workspace.root)
      .map((session) => ({
        terminal_id: session.id,
        cwd: session.cwd,
        shell: session.shell,
        running: !session.exited,
        exit_code: session.exitCode,
        cursor: session.nextCursor,
        touched_at: new Date(session.touched).toISOString()
      }));
  }

  close(workspace: Workspace, id: string, sessionId?: string) {
    const session = this.get(workspace, id, sessionId);
    if (!session.exited) {
      try { session.terminal.kill(); } catch {}
    }
    this.sessions.delete(id);
    return { terminal_id: id, closed: true };
  }

  async reconcile(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      try {
        this.authorize(session.workspace, this.config.bashSessionId);
      } catch {
        if (!session.exited) {
          try { session.terminal.kill(); } catch {}
        }
        this.sessions.delete(session.id);
      }
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const session of this.sessions.values()) {
      if (!session.exited) {
        try { session.terminal.kill(); } catch {}
      }
    }
    this.sessions.clear();
  }
}

const managers = new WeakMap<LocalWorkspaceBridgeConfig, TerminalManager>();

export function getTerminalManager(config: LocalWorkspaceBridgeConfig): TerminalManager {
  let manager = managers.get(config);
  if (!manager) {
    manager = new TerminalManager(config);
    managers.set(config, manager);
  }
  return manager;
}
