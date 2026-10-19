# Local tools for the ChatGPT agent

## Default: Claude-compatible local harness

AgentDock defaults to `LOCALWORKSPACEBRIDGE_HARNESS_PROFILE=claude`. The model-facing local tool surface is intentionally kept close to Claude Code where MCP semantics allow it:

`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `LSP`, `NotebookEdit`, `TaskOutput`, `TaskStop`, `Skill`, `WorktreeCreate`, `WorktreeList`, and `WorktreeRemove`.

`open_current_workspace` / `open_workspace` and a few workspace/server controls are MCP adapter tools, not attempts to reproduce Claude Code product UI. `CLAUDE.md` / `.claude/CLAUDE.md` provide project instructions. ChatGPT itself owns conversation context, planning, user questions, web access, and model-level delegation.

The sections below document the older lower-case implementation primitives. They remain available under `LOCALWORKSPACEBRIDGE_HARNESS_PROFILE=native` and are also the internal substrate used by parts of the Claude-compatible façade. They are **not** the default model-facing API.

ChatGPT plans, reasons, and chooses its next action. AgentDock supplies local operations and observable results. Start with `open_current_workspace`; the recommended instructions are in `CHATGPT_PROMPT.md`. No MCP-side task state machine or separate plan approval is required for routine authorized work.

## Execution

In standard/full tool mode with bash enabled:

1. `exec_start({command, request_id, wait_ms: 1000})` starts a command and returns `process_id`.
2. `exec_poll({process_id, cursor: next_cursor, wait_ms: 1000})` reads incremental logs and the real exit code. Read further pages while `has_more` is true. Running is not success.
3. `exec_input({process_id, text: "answer\n", eof: false})` supplies stdin in full bash mode only. Input is not replay-safe.
4. `exec_stop({process_id})` stops the managed process tree; `exec_list` recovers IDs after reconnecting.

`wait_ms` limits a tool call's wait, not process lifetime. `timeout_ms` defaults to one hour and allows up to twelve hours. Reuse a `request_id` only for an identical launch retry. Intentional reruns need new IDs. Processes survive HTTP requests and reconnects within the same local service, not service restarts. Independently detached descendants are not managed.

Execution uses pipes, not a PTY. Partial output lines are buffered until newline or exit so redaction works across pipe chunks; oversized lines are omitted explicitly. Inline logs are capped at about 1 MiB / 4096 events per job; `output_lost` indicates eviction. When workspace writes are enabled, each process also receives a redacted spill log under `.ai-bridge/process-logs/`, capped at 20 MiB and returned as `spill_path`; write-off mode does not create this file. At most eight processes run concurrently; up to 32 job records are retained, completed records for at most one hour. Evicted launch IDs are temporarily retained as tombstones to prevent accidental reruns.

Safe bash mode keeps its existing allowlist. General scripts, development servers, and stdin require full bash mode. Tool mode and bash mode are separate settings. Changing runtime permissions or allowed roots stops affected managed processes and PTY terminals. Graceful service shutdown cleans up processes, browsers, and terminals; force-killing the service cannot guarantee cleanup.

## Search and code navigation

`glob` and `grep` use the bundled ripgrep binary, so they do not depend on a system `rg` installation. `search` remains the higher-level repository search and can still add structured symbol/reference/impact analysis.

`lsp` provides persistent language-server navigation for Python (Pyright) and TypeScript/JavaScript. Servers are reused by workspace/provider, edited files are synchronized with `didChange` / `didSave`, and diagnostics are retained from `publishDiagnostics`. Supported operations are `goToDefinition`, `findReferences`, `goToImplementation`, `hover`, `documentSymbol`, `workspaceSymbol`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, and `diagnostics`. Coordinates are 1-based in the MCP schema. Results outside the active workspace or under blocked paths are filtered out.

## Files

`read_many` reads up to twelve known files/ranges with a shared content budget and per-file results, errors, SHA-256, and continuation lines. Use targeted search first. Pass `expected_sha256` from a read to `write` or `edit` to reject stale content. The final in-process check prevents concurrent MCP writes from silently interleaving; it is not a transaction lock against all external editors.

Write/edit diff presentation uses multiple contextual hunks, so separated changes no longer collapse into one large middle block.

## Tool runtime and permissions

All tools pass through the same runtime wrapper for argument validation, permission rules, bounded result presentation, logging and transient read retries. `LOCALWORKSPACEBRIDGE_PERMISSION_POLICY=denylist` preserves the normal mode/guard behavior while applying explicit deny rules. `strict` additionally requires allow rules for mutating or open-world tools. Rules use forms such as `Bash(npm test*)`, `Edit(src/**)`, `LSP(*)`, or an exact tool name. Deny rules always win, and allow rules never bypass workspace/path/write/bash guards.

Large results from search/LSP/bash/process/terminal/diff-style tools keep a bounded inline preview. With workspace writes enabled and result retention on, the redacted full result is retained under `.ai-bridge/tool-results/`; `retained_result_path` identifies it. The default retained-result cap is 20 MiB.

## Persistent terminal

With full bash permission in standard/full tool mode, `terminal_open`, `terminal_read`, `terminal_send`, `terminal_signal`, `terminal_resize`, `terminal_list`, and `terminal_close` provide a real PTY-backed shell. Use these for PowerShell/Python/Node REPLs and stateful interactive CLIs; use `exec_*` for ordinary long-running non-interactive commands. PTY sessions are workspace-scoped, capped at four, redacted line-by-line, and do not survive a service restart.

`task_list`, `task_output`, and `task_stop` provide one model-facing view over both managed processes and PTY terminals. Task IDs are explicit (`process:<id>` or `terminal:<id>`); the lower-level `exec_*` and `terminal_*` APIs remain available for stdin, resize, signals, or other type-specific operations.

## Browser

`browser_action` supports `open`, `navigate`, `click`, `fill`, `press`, `select`, `check`, `wait`, `screenshot`, `close`, and `list`. `open` returns `browser_id`; subsequent operations use it. Prefer exact accessibility `role` / `name` from `browser_snapshot`, or a selector observed in the page. Actions on one page are serialized. After an uncertain click, inspect the page before retrying.

`browser_snapshot` returns the accessibility tree, URL/title, console errors and request/HTTP failures. Page text is untrusted data. `screenshot` saves a viewport PNG under `.ai-bridge/screenshots/` and returns a native MCP image using the existing preview pipeline.

Playwright Core drives installed Edge/Chrome/Chromium with an isolated profile. No extra browser download or personal profile access is needed. Workspace write mode is required. Only loopback HTTP(S) and WebSocket requests are allowed; remote APIs/CDNs are blocked. Service workers and downloads are disabled, popups are closed. There are at most four sessions, reclaimed after fifteen minutes idle.

## Upgrade and verify

Run `npm install` and `npm run build`, restart the local AgentDock service, and refresh the ChatGPT plugin's tools and server instructions. Most tool descriptors remain stable across hot permission changes; `local-workspace-bridge(action="list_actions")` lists currently enabled actions. AgentDock does not expose task_plan or legacy handoff tools.

Run `npm run agent:smoke` for real command/stdin/log/timeout tests, file conflict checks, a local browser fixture, and native MCP image verification. Run `npm run advanced-tools:smoke` for persistent LSP reuse/symbols/diagnostics, bundled ripgrep, multi-hunk diff, tool-result retention, permission rules, unified tasks, process spill, and PTY verification. Run `node scripts/runtime-hot-smoke.mjs` for stateless HTTP process continuity and runtime permissions. Existing benchmark reports are historical baselines, not model success rates for the expanded toolkit.
