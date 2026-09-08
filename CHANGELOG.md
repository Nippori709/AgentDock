# Changelog

## 0.2.0 — 2026-09-09

Integration baseline: AgentDock main `edc8b1194ddd36ec83fe398b34c8444638ce32de` (`fix: harden PyMuPDF workers and restore media CI`).

### Added

- Nine MCP tools: `exec_start`, `exec_poll`, `exec_input`, `exec_stop`, `exec_list`, `read_many`, `browser_action`, `browser_snapshot`, and `browser_screenshot`.
- Managed long-running commands with incremental redacted logs, cursor pagination, real exit codes, stdin in full mode, cancellation, timeouts, and bounded retained results. Launch retries reuse a request ID; stateless HTTP calls and reconnects share the same service runtime.
- Isolated installed-browser sessions for local frontend testing: accessibility snapshots, fill/click/key/select/check/wait actions, console and network diagnostics, and native MCP screenshot previews.
- Bounded reads of up to twelve files, per-file errors, continuation information, and SHA-256 hashes. Optional `expected_sha256` on write/edit rejects stale changes; final checks serialize concurrent writes within the service.
- ChatGPT workflow instructions in `CHATGPT_PROMPT.md` and tool behavior/limits in `AGENT_TOOLS.md`. Planning remains with ChatGPT; no task_plan or legacy handoff layer is added.

### Fixed and changed

- PowerShell commands preserve native nonzero exit codes without suppressing successful formatted output.
- Runtime policy changes reconcile managed processes and browser sessions. Graceful service shutdown and stdio disconnect clean up managed resources.
- Self-test compares enabled tools with the current policy instead of treating stable HTTP descriptors for disabled tools as a registration error. `server_config` exposes `enabledTools`.
- Stdio advertises only the enabled tool set; HTTP keeps stable descriptors for permission hot updates, with every call checked against current policy.
- Fixed the previous runtime-hot smoke test's dependency on a machine-specific `MoE_LT_0` directory and fixed port. It now creates an isolated temporary workspace and verifies HTTP process continuity and launch deduplication.
- A portable smoke runner reports each of eleven suites and propagates failures reliably. Added real execution, browser, file-conflict, and MCP image regression checks.
- Updated vulnerable transitive dependencies and package metadata. Package allowlists include required Control Center runtime files and exclude development tests/artifacts.

### Retained from the baseline

- Stable Node discovery and dependency checks for Control Center startup, runtime doctor, five-setting hot updates, and existing tests.
- Canonical PyMuPDF imports, legacy fallback validation, clean JSON worker output, and Python media setup in CI.
- Existing repository analysis, Git review, image/PDF/DOCX reading, HTTP/stdio transports, OAuth, workspace boundaries, and optional Codex history access.

### Boundaries

- Commands use pipes, not a PTY. Partial log lines wait for newline or process exit. Sessions survive HTTP reconnects, not service restarts; independently detached descendants are outside managed cleanup.
- Browsers use separate profiles and permit loopback application HTTP(S)/WebSocket requests. Remote APIs/CDNs are blocked. This is a local development tool, not personal-browser or whole-desktop control.
- File version checks do not provide an operating-system transaction against every external editor. These tools extend the connected model's local capabilities; they do not change its model or guarantee parity with Codex.

## 0.2.0 中文变更摘要

相比上一个 main（`edc8b11`），新增持续执行与进程管理、本地浏览器操作与原生截图、批量文件读取、防止旧内容覆盖的版本校验，以及对应的 ChatGPT 使用指令和自动化测试。保留最新版的控制中心启动修复、权限热更新和 PyMuPDF 修复；修复原版测试依赖私人目录的问题，并更新依赖与打包清单。规划继续由 ChatGPT 完成，不引入 task_plan。
