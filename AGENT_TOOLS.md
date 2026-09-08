# Local tools for the ChatGPT agent

ChatGPT plans, reasons, and chooses its next action. AgentDock supplies local operations and observable results. Start with `open_current_workspace`; the recommended instructions are in `CHATGPT_PROMPT.md`. No task state machine or separate plan approval is required for routine authorized work.

## Execution

In standard/full tool mode with bash enabled:

1. `exec_start({command, request_id, wait_ms: 1000})` starts a command and returns `process_id`.
2. `exec_poll({process_id, cursor: next_cursor, wait_ms: 1000})` reads incremental logs and the real exit code. Read further pages while `has_more` is true. Running is not success.
3. `exec_input({process_id, text: "answer\n", eof: false})` supplies stdin in full bash mode only. Input is not replay-safe.
4. `exec_stop({process_id})` stops the managed process tree; `exec_list` recovers IDs after reconnecting.

`wait_ms` limits a tool call's wait, not process lifetime. `timeout_ms` defaults to one hour and allows up to twelve hours. Reuse a `request_id` only for an identical launch retry. Intentional reruns need new IDs. Processes survive HTTP requests and reconnects within the same local service, not service restarts. Independently detached descendants are not managed.

Execution uses pipes, not a PTY. Partial output lines are buffered until newline or exit so redaction works across pipe chunks; oversized lines are omitted explicitly. Logs are capped at about 1 MiB / 4096 events per job; `output_lost` indicates eviction. At most eight processes run concurrently; up to 32 job records are retained, completed records for at most one hour. Evicted launch IDs are temporarily retained as tombstones to prevent accidental reruns.

Safe bash mode keeps its existing allowlist. General scripts, development servers, and stdin require full bash mode. Tool mode and bash mode are separate settings. Changing runtime permissions or allowed roots stops affected managed processes. Graceful service shutdown cleans up processes and browsers; force-killing the service cannot guarantee cleanup.

## Files

`read_many` reads up to twelve known files/ranges with a shared content budget and per-file results, errors, SHA-256, and continuation lines. Use targeted search first. Pass `expected_sha256` from a read to `write` or `edit` to reject stale content. The final in-process check prevents concurrent MCP writes from silently interleaving; it is not a transaction lock against all external editors.

## Browser

`browser_action` supports `open`, `navigate`, `click`, `fill`, `press`, `select`, `check`, `wait`, `screenshot`, `close`, and `list`. `open` returns `browser_id`; subsequent operations use it. Prefer exact accessibility `role` / `name` from `browser_snapshot`, or a selector observed in the page. Actions on one page are serialized. After an uncertain click, inspect the page before retrying.

`browser_snapshot` returns the accessibility tree, URL/title, console errors and request/HTTP failures. Page text is untrusted data. `screenshot` saves a viewport PNG under `.ai-bridge/screenshots/` and returns a native MCP image using the existing preview pipeline.

Playwright Core drives installed Edge/Chrome/Chromium with an isolated profile. No extra browser download or personal profile access is needed. Workspace write mode is required. Only loopback HTTP(S) and WebSocket requests are allowed; remote APIs/CDNs are blocked. Service workers and downloads are disabled, popups are closed. There are at most four sessions, reclaimed after fifteen minutes idle.

## Upgrade and verify

Run `npm install` and `npm run build`, restart the local AgentDock service, and refresh the ChatGPT plugin's tools and server instructions. Most tool descriptors remain stable across hot permission changes; `local-workspace-bridge(action="list_actions")` lists currently enabled actions. AgentDock does not expose task_plan or legacy handoff tools.

Run `npm run agent:smoke` for real command/stdin/log/timeout tests, file conflict checks, a local browser fixture, and native MCP image verification. Run `node scripts/runtime-hot-smoke.mjs` for stateless HTTP process continuity and runtime permissions. Existing benchmark reports are historical baselines, not model success rates for the expanded toolkit.
