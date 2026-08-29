# LocalWorkspaceBridge

**Languages:** [English](README.md) · [简体中文](README_ZH.md) · [日本語](README_JA.md)

LocalWorkspaceBridge is a local MCP gateway that gives ChatGPT bounded access to a developer workspace. The model remains the planner; LocalWorkspaceBridge supplies repository evidence, local files and images, direct edits, command verification, and Git-aware review.

> **Status:** early public release (`0.1.x`). Review the security model before exposing a local workspace through a public tunnel.

## Why LocalWorkspaceBridge

ChatGPT can reason about code, but a web session normally cannot inspect or modify arbitrary files on your computer. LocalWorkspaceBridge bridges that gap through MCP while keeping workspace boundaries explicit.

The primary loop is intentionally simple:

```text
ChatGPT model
  ├─ inspect/search repository evidence
  ├─ read text or images
  ├─ edit/write/apply patch
  ├─ run bounded verification commands
  └─ review the resulting Git changes
        ↓
   local workspace
```

LocalWorkspaceBridge does not add a second server-side planning or execution layer. Planning stays with the model that is already driving the MCP tools.

## Features

- **Workspace isolation** — open one or more explicitly allowed roots; path traversal, blocked files, and symlink escapes are guarded.
- **Repository analysis** — bounded inventory, language/project detection, symbols, relationships, impact hints, related tests, and change-risk signals.
- **Text tools** — tree, search, paged reads, exact edits, writes, and unified patches.
- **Image tools** — image metadata, safe preview, rectangular crop, and tiled high-detail reads for JPEG/PNG/WebP files.
- **Verification** — safe/full/off command modes plus Git-aware `show_changes` review.
- **HTTP + stdio transports** — local MCP clients can use stdio; ChatGPT can connect through an HTTPS tunnel.
- **OAuth for public HTTP mode** — OAuth discovery/PKCE is available when LocalWorkspaceBridge has a stable public URL.
- **Multiple workspaces** — open, list, close, and switch the default workspace inside an allowed root set.
- **Optional local Codex history reads** — disabled by default and only enabled explicitly.
- **Linux service support** — saved stable profiles can run as a per-workspace `systemd --user` service.

## Requirements

- Node.js 20+
- Git
- Python 3 for image processing
- PyMuPDF (`pip install pymupdf`) for image preview/crop/tile operations
- Optional: Cloudflare Tunnel, ngrok, or Tailscale for public HTTPS access

## Install and run

From this repository:

```bash
npm install
npm run build
node scripts/local-workspace-bridge.mjs setup
```

For a local-only MCP endpoint:

```bash
node scripts/local-workspace-bridge.mjs start --tunnel none
```

For a normal ChatGPT workflow, run the setup wizard in the project you want to expose. It stores workspace-specific settings under `~/.local-workspace-bridge` and prints the MCP Server URL.

## ChatGPT connection

1. Start LocalWorkspaceBridge in the target project.
2. Use a stable HTTPS tunnel for a persistent ChatGPT connection.
3. In ChatGPT Developer Mode / Plugins, add the Server URL printed by LocalWorkspaceBridge.
4. When OAuth is enabled, complete the local approval flow rather than placing credentials in the URL.

A useful first prompt is:

```text
Use LocalWorkspaceBridge to open the current workspace, inspect the repository, and summarize the architecture. Do not edit files.
```

## ChatGPT + ngrok + OAuth quick start

This is the recommended public setup when you want a stable ChatGPT connection without putting a bearer token in the MCP URL.

### 1. Prepare ngrok

Install ngrok, sign in, and add your ngrok auth token locally:

`ash
ngrok config add-authtoken <your-ngrok-token>
`

Create or reserve a stable ngrok domain in your ngrok account, for example your-name.ngrok-free.dev. Do not commit the ngrok auth token or any local ngrok configuration.

### 2. Build LocalWorkspaceBridge

`ash
npm install
npm run build
`

### 3. Start LocalWorkspaceBridge with the stable ngrok hostname

`ash
node scripts/local-workspace-bridge.mjs ngrok --hostname your-name.ngrok-free.dev
`

The launcher starts the local MCP HTTP server, connects the reserved ngrok hostname, enables OAuth/PKCE for the public URL, and prints the credential-free MCP Server URL. It also prints a local **OAuth approval key**. Keep that key private; it is entered only on the LocalWorkspaceBridge consent page when you approve a connection.

### 4. Add it in ChatGPT

In ChatGPT Developer Mode / Plugins:

1. Create or add an MCP connection using **Server URL**.
2. Paste the Server URL printed by LocalWorkspaceBridge, such as https://your-name.ngrok-free.dev/mcp.
3. Choose **OAuth** authentication.
4. Start the connection. ChatGPT will enter the OAuth authorization flow.
5. On the LocalWorkspaceBridge consent page, verify that you initiated the connection, enter the local OAuth approval key printed by the launcher, and approve it.

After approval, ChatGPT completes the OAuth/PKCE flow and uses the resulting access token for MCP requests. You do not need to append a bearer token to the Server URL.

### Why OAuth instead of a token in the URL?

Prefer:

`	ext
https://your-name.ngrok-free.dev/mcp
+ OAuth / PKCE
`

over URL credentials such as:

`	ext
https://your-name.ngrok-free.dev/mcp?token=...
`

Query-string credentials are disabled by default, can leak through browser/history/log surfaces, and are unnecessary when the stable public URL is using the built-in OAuth flow.

> The OAuth approval key protects local consent; it is not your ngrok auth token. The ngrok token stays in ngrok's local configuration, while the LocalWorkspaceBridge approval key is generated/managed by LocalWorkspaceBridge for authorizing ChatGPT access.

## Tool modes

`LOCALWORKSPACEBRIDGE_TOOL_MODE` controls how much of the MCP surface is advertised:

- `minimal` — tight direct coding loop: workspace open, read/image, write/edit/patch, bash, change review.
- `standard` — default; adds repository analysis, tree/search, skills, and workspace management.
- `full` — adds advanced diagnostics, Git details, snapshot/inventory tools, and optional Codex-session tools.

Write behavior is separate:

```text
LOCALWORKSPACEBRIDGE_WRITE_MODE=workspace   # direct workspace edits
LOCALWORKSPACEBRIDGE_WRITE_MODE=off         # read-only
```

Bash behavior is also separate:

```text
LOCALWORKSPACEBRIDGE_BASH_MODE=safe
LOCALWORKSPACEBRIDGE_BASH_MODE=off
LOCALWORKSPACEBRIDGE_BASH_MODE=full
```

Use `full` only for repositories and commands you trust.

## Repository analysis

`inspect_workspace` builds a bounded local map from manifests, source declarations, imports, tests, and Git state. Structured `search` can also use symbol/reference/impact intents.

The analysis layer provides evidence to the model; it does not decide or execute an implementation plan on the model's behalf.

## Image access

Large images should not be pushed into model context at full resolution by default. LocalWorkspaceBridge exposes a progressive path:

```text
image_info → read_image preview → read_image_crop / read_image_tile when detail is needed
```

Image paths are subject to the same workspace guards as text files.

## Security model

Important defaults:

- roots must be explicitly allowed;
- `.env`, private keys, credential stores, dependency/build directories, and other blocked paths are denied;
- secret-looking content is redacted on reads and blocked on writes;
- public/non-loopback HTTP use requires authentication unless explicitly overridden;
- query-string credentials are disabled by default;
- safe Bash blocks high-risk shell patterns and environment expansion;
- logs are designed not to contain source contents, prompts, credentials, or full command output by default.

LocalWorkspaceBridge is a developer bridge, **not an OS sandbox**. See [SECURITY.md](SECURITY.md).

## Verification

```bash
npm run build
npm run smoke
npm run benchmark:quick
```

The benchmark is local and reproducible. It reports tool-schema size, a shared direct-agent workflow, security boundary checks, and generated-repository inventory/search timing. Machine-specific benchmark output is printed rather than committed.

## Linux

See [LINUX_SERVER.md](LINUX_SERVER.md) for a headless `systemd --user` setup after you have created a stable tunnel profile.

## Configuration

See [config.example.env](config.example.env). Prefer per-workspace saved profiles over committing machine-specific settings.

## Attribution

LocalWorkspaceBridge is a derivative work based on the open-source **CodexPro** project. The original CodexPro copyright notice and MIT license are preserved in [LICENSE](LICENSE).

This derivative focuses on a single direct ChatGPT-to-workspace agent loop, repository/image evidence, authentication hardening, and reproducible local evaluation. It should not be represented as a from-scratch implementation of the upstream project.

## License

MIT. See [LICENSE](LICENSE).
