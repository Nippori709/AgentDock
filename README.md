# AgentDock

**Languages:** [English](README.md) · [简体中文](README_ZH.md) · [日本語](README_JA.md)

AgentDock is a local MCP gateway that gives ChatGPT bounded access to a developer workspace. The model remains the planner; AgentDock supplies repository evidence, local files and images, direct edits, command verification, and Git-aware review.

> **Status:** early public release (`0.1.x`). Review the security model before exposing a local workspace through a public tunnel.

## Why AgentDock

ChatGPT can reason about code, but a web session normally cannot inspect or modify arbitrary files on your computer. AgentDock bridges that gap through MCP while keeping workspace boundaries explicit.

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

AgentDock does not add a second server-side planning or execution layer. Planning stays with the model that is already driving the MCP tools.

## Features

- **Workspace isolation** — open one or more explicitly allowed roots; path traversal, blocked files, and symlink escapes are guarded.
- **Repository analysis** — bounded inventory, language/project detection, symbols, relationships, impact hints, related tests, and change-risk signals.
- **Text tools** — tree, search, paged reads, exact edits, writes, and unified patches.
- **Image tools** — image metadata, safe preview, rectangular crop, and tiled high-detail reads for JPEG/PNG/WebP files.
- **Verification** — safe/full/off command modes plus Git-aware `show_changes` review.
- **HTTP + stdio transports** — local MCP clients can use stdio; ChatGPT can connect through an HTTPS tunnel.
- **OAuth for public HTTP mode** — OAuth discovery/PKCE is available when AgentDock has a stable public URL.
- **Multiple workspaces** — open, list, close, and switch the default workspace inside an allowed root set.
- **Optional local Codex history reads** — disabled by default and only enabled explicitly.
- **Linux service support** — saved stable profiles can run as a per-workspace `systemd --user` service.

## Requirements

For the recommended Windows + ChatGPT + ngrok setup, install:

- **Git** — used to clone AgentDock and inspect workspace changes.
- **Node.js 20+** — `node -v` should report 20 or newer.
- **Python 3** — used by the image/PDF helper workers.
- **PyMuPDF** — required for PDF text/page rendering and image processing: `python -m pip install pymupdf`.
- **ngrok** — recommended for a stable public HTTPS address that ChatGPT can reach.
- A ChatGPT account/workspace that exposes **Developer Mode / custom MCP app** creation. Availability and UI labels vary by plan and rollout; see the current OpenAI help page linked below.

You do **not** need to buy a domain from Namecheap for the recommended path. A free ngrok account currently includes one account-assigned development domain. If you already own a custom domain, the Cloudflare named-tunnel route is an optional alternative.

## Zero-to-working deployment: Windows + ngrok + OAuth

This section is intentionally verbose. It is written so that a person—or a coding agent such as Codex/Claude Code—can follow the deployment from a clean machine without guessing missing steps.

### Step 0 — Know what will happen

The final connection looks like this:

```text
ChatGPT
  ↓ HTTPS + OAuth
your ngrok development domain
  ↓
AgentDock HTTP/MCP server on your computer (default port 8787)
  ↓
one explicitly allowed local workspace
```

There are **three different credentials/identifiers** that are easy to confuse:

| Item | Where it comes from | Where it is used | Keep private? |
| --- | --- | --- | --- |
| ngrok authtoken | ngrok Dashboard | `ngrok config add-authtoken ...` on your computer | **Yes** |
| ngrok dev domain | ngrok Dashboard → Domains | AgentDock `--hostname` / setup wizard | No, it is a public hostname |
| AgentDock OAuth approval key | AgentDock setup/start output | AgentDock consent page opened during ChatGPT OAuth | **Yes** |

The **ngrok authtoken and AgentDock approval key are not the same thing**.

### Step 1 — Clone AgentDock

Open PowerShell, Windows Terminal, or another normal terminal:

```powershell
git clone https://github.com/Nippori709/AgentDock.git
cd AgentDock
```

If the repository already exists locally, update it instead:

```powershell
git pull
```

### Step 2 — Install Node/Python dependencies and build

From the AgentDock repository:

```powershell
npm install
python -m pip install pymupdf
npm run build
```

The build must finish without TypeScript errors. You can run the full local smoke suite as an optional sanity check:

```powershell
npm run smoke
```

For easier daily use, you may also install this local checkout as a global CLI:

```powershell
npm install -g .
```

That exposes the command `local-workspace-bridge`. If you skip this optional step, use `node scripts/local-workspace-bridge.mjs ...` in the commands below.

### Step 3 — Create a free ngrok account and get your two ngrok values

1. Create/sign in to an ngrok account.
2. Open the ngrok Dashboard.
3. Find your **authtoken**. This is a long secret string used only to authenticate the ngrok agent running on your computer.
4. Open **Domains** and copy the development domain assigned to your account.

Do not invent the domain or blindly copy the suffix from this README. ngrok has changed domain suffixes over time. Depending on the account, you may see something such as:

```text
example-name.ngrok-free.app
```

or an older assigned domain such as:

```text
example-name.ngrok-free.dev
```

**Copy exactly what the ngrok Dashboard shows for your account.** Free plans generally provide an assigned development domain; choosing a custom name or bringing your own custom domain may require a paid ngrok plan.

> Namecheap is not part of this recommended free path. Namecheap only becomes relevant if you separately buy/own a custom domain and choose an advanced custom-domain deployment.

### Step 4 — Install and authenticate ngrok on Windows

ngrok currently recommends the Microsoft Store/WinGet path on Windows. One option is:

```powershell
winget install ngrok -s msstore
```

You can also install it from ngrok's official download page. After installation, verify:

```powershell
ngrok version
```

Then add the **ngrok authtoken** from Step 3:

```powershell
ngrok config add-authtoken "YOUR_NGROK_AUTHTOKEN"
```

Do not paste this token into README files, source code, screenshots, issues, or ChatGPT prompts.

### Step 5 — Run the AgentDock setup wizard

The easiest and least error-prone path is the interactive wizard:

```powershell
node scripts/local-workspace-bridge.mjs setup
```

If you installed the global CLI in Step 2, this is equivalent to:

```powershell
local-workspace-bridge setup
```

The wizard asks several questions. For the normal ChatGPT + ngrok setup, use the following answers.

#### 5.1 `Where is your project located?`

Enter the folder that you actually want ChatGPT to inspect/edit, for example:

```text
D:\Projects\MyApp
```

If you are intentionally exposing AgentDock itself, the AgentDock repository path is fine. Otherwise, do **not** accidentally expose the AgentDock source folder when you meant to expose another project.

#### 5.2 `Which local port should LocalWorkspaceBridge use?`

Press Enter to keep the default unless port `8787` is already occupied.

Typical answer:

```text
8787
```

#### 5.3 `Public access: quick, stable, ngrok, tailscale, or local?`

For this guide, enter:

```text
ngrok
```

The choices mean:

- `quick` — temporary Cloudflare quick tunnel; easiest demo, but URL changes after restart.
- `ngrok` — recommended here; reuse your account's stable ngrok development domain.
- `stable` — Cloudflare named tunnel using a domain you control.
- `tailscale` — Tailscale Funnel.
- `local` — no public tunnel; ChatGPT on the web cannot normally reach `127.0.0.1` directly.

#### 5.4 `Ngrok domain or URL, without /mcp`

Paste the exact development domain copied from the ngrok Dashboard, for example:

```text
example-name.ngrok-free.app
```

Do **not** append `/mcp`; AgentDock adds the MCP route itself.

#### 5.5 `LocalWorkspaceBridge auth token for this workspace`

The wizard provides a generated random default. For a normal setup, **press Enter to accept it**.

This saved secret is used by AgentDock's public HTTP authentication. When OAuth is active, the launcher prints it as the local **OAuth approval key** that you enter on the AgentDock consent page.

Do not publish this value.

#### 5.6 `Save this setup for future runs from this workspace?`

Answer:

```text
yes
```

AgentDock saves the per-workspace profile under:

```text
~/.local-workspace-bridge
```

That is why later launches can reuse the same workspace, tunnel type, hostname, port, and local auth secret without asking everything again.

#### 5.7 `Start LocalWorkspaceBridge now?`

Answer:

```text
yes
```

### Step 6 — Read the startup output carefully

A successful public OAuth launch prints a block containing values similar to:

```text
LocalWorkspaceBridge ready
Workspace   D:\Projects\MyApp
Server URL  https://YOUR_ASSIGNED_NGROK_DOMAIN/mcp
Authentication: OAuth

OAuth approval key (enter once on the LocalWorkspaceBridge consent page):

  <private-generated-key>
```

Two values matter now:

1. **Server URL** — copy the full HTTPS URL ending in `/mcp` into ChatGPT.
2. **OAuth approval key** — keep the terminal open or copy the key somewhere private temporarily. You will enter it on AgentDock's own consent page during OAuth.

Do **not** append `?token=...` to the Server URL. Query-string credentials are disabled by default and are easier to leak through browser history/logs.

### Step 7 — Create the custom MCP app in ChatGPT

ChatGPT's UI is changing over time and can differ by plan/workspace. Current OpenAI documentation generally describes the path as **Settings → Apps → Create** (or the equivalent workspace Apps page). Some accounts/builds may still expose a **Developer Mode / Plugins → +** flow.

Use whichever custom-MCP creation UI your account exposes, then enter:

```text
Name: AgentDock
Description: Local coding workspace bridge for ChatGPT
Connection: Server URL
Server URL: https://YOUR_ASSIGNED_NGROK_DOMAIN/mcp
Authentication: OAuth
```

If the UI has **Scan Tools**, start the scan. Because the server uses OAuth, ChatGPT should open/redirect to AgentDock's authorization page.

Current OpenAI help for Developer Mode/custom MCP apps:

https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta

> Plan availability changes over time. If your ChatGPT account does not offer custom MCP app creation or blocks write/modify tools, check the current OpenAI plan/workspace requirements before debugging AgentDock itself.

### Step 8 — Approve the OAuth request

On the AgentDock consent page:

1. Confirm that **you** initiated this connection from ChatGPT.
2. Check the requested client/redirect information.
3. Paste the **AgentDock OAuth approval key** printed in your local terminal.
4. Approve the request.

Do not paste your ngrok authtoken here. The consent page wants the **AgentDock approval key**, not the ngrok credential.

After approval, ChatGPT completes OAuth/PKCE and receives an access token. The MCP Server URL itself stays credential-free.

### Step 9 — Verify the connection in ChatGPT

Start with a read-only request:

```text
Use AgentDock to open the current workspace, inspect the repository, and summarize the architecture. Do not edit files.
```

Then verify a harmless tool such as `tree`, `search`, or `read`. Only after the read path works should you try write/edit/bash operations.

### Step 10 — Daily startup after the first setup

If the profile was saved, you do **not** need to repeat the ngrok account setup or ChatGPT app creation each day.

From the AgentDock checkout:

```powershell
node scripts/local-workspace-bridge.mjs start --root "D:\Projects\MyApp"
```

Or, if you installed the global CLI:

```powershell
cd D:\Projects\MyApp
local-workspace-bridge start
```

The saved ngrok hostname remains the same, so the ChatGPT Server URL can remain unchanged.

## Non-interactive ngrok launch

Once ngrok is installed/authenticated and you know the assigned domain, you can skip the wizard and launch explicitly:

```powershell
node scripts/local-workspace-bridge.mjs ngrok --root "D:\Projects\MyApp" --hostname YOUR_ASSIGNED_NGROK_DOMAIN
```

For reproducible automation, prefer a saved workspace profile after the first interactive setup rather than putting private auth values directly on command lines.

## What a coding agent can and cannot automate

If you ask Codex, Claude Code, or another local coding agent to deploy AgentDock from this README, it can usually automate:

- cloning/pulling the repository;
- checking Node.js, Python, Git, and ngrok availability;
- running `npm install`, PyMuPDF installation, build, and smoke tests;
- starting the AgentDock setup wizard or constructing the equivalent launch command;
- diagnosing local port/process/build problems.

It normally **cannot safely invent or bypass** the account-interaction steps. Expect to perform or provide these yourself:

1. Sign in/create the ngrok account.
2. Copy the account's ngrok authtoken.
3. Copy the exact assigned ngrok development domain.
4. Enable the relevant Developer Mode/custom-app feature in ChatGPT if your plan/workspace requires it.
5. Create/authorize the ChatGPT MCP app.
6. Enter the locally printed AgentDock OAuth approval key on the consent page.

A good prompt for a coding agent is:

```text
Clone https://github.com/Nippori709/AgentDock and deploy it by following README.md exactly.
Use the recommended Windows + ngrok + OAuth path.
Do not invent a domain, token, approval key, or ChatGPT account setting.
Perform all local terminal steps yourself. When an ngrok/ChatGPT account action is required,
tell me exactly what page/value you need, then continue from the value I provide.
Run the documented build and smoke checks before declaring the deployment complete.
```

## Tunnel choices

### Recommended: ngrok assigned development domain

Use this when you want the simplest persistent URL. The free plan currently includes an account-assigned development domain. Your actual hostname may use a suffix different from examples in older AgentDock releases, so always copy it from the ngrok Dashboard.

### Temporary demo: Cloudflare quick tunnel

For a quick test with no stable URL requirement:

```powershell
node scripts/local-workspace-bridge.mjs start
```

The quick-tunnel URL can change after restart. If ChatGPT was configured with that URL, you must update the app/connector when the URL changes.

### Advanced: your own domain + Cloudflare named tunnel

If you already own a domain (for example one purchased from Namecheap), you can use a Cloudflare named tunnel. The domain must be configured appropriately in Cloudflare DNS. This is an advanced alternative; **buying a Namecheap domain is not required for AgentDock**.

### Local-only

For MCP clients running on the same computer:

```powershell
node scripts/local-workspace-bridge.mjs start --tunnel none
```

This does not provide a public HTTPS URL for ChatGPT web.

## OAuth vs credentials in the URL

Prefer:

```text
https://YOUR_ASSIGNED_NGROK_DOMAIN/mcp
+ OAuth / PKCE
```

instead of:

```text
https://YOUR_ASSIGNED_NGROK_DOMAIN/mcp?token=...
```

Query-string credentials are disabled by default, can leak through browser/history/log surfaces, and are unnecessary when the stable public URL uses AgentDock's OAuth flow.

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

Large images should not be pushed into model context at full resolution by default. AgentDock exposes a progressive path:

```text
image_info → read_image preview → read_image_crop / read_image_tile when detail is needed
```

Image paths are subject to the same workspace guards as text files.

## PDF and DOCX access

AgentDock can read PDF text with `read_pdf`, render a PDF page for visual inspection with `read_pdf_page`, and extract paragraphs/table rows from Word `.docx` files with `read_docx`.

PDF support uses PyMuPDF on the machine running AgentDock:

```bash
python -m pip install pymupdf
```

DOCX extraction reads OOXML directly and does not require Microsoft Word or an extra Python package.

## Security model

Important defaults:

- roots must be explicitly allowed;
- `.env`, private keys, credential stores, dependency/build directories, and other blocked paths are denied;
- secret-looking content is redacted on reads and blocked on writes;
- public/non-loopback HTTP use requires authentication unless explicitly overridden;
- query-string credentials are disabled by default;
- safe Bash blocks high-risk shell patterns and environment expansion;
- logs are designed not to contain source contents, prompts, credentials, or full command output by default.

AgentDock is a developer bridge, **not an OS sandbox**. See [SECURITY.md](SECURITY.md).

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

AgentDock is a derivative work based on the open-source **CodexPro** project. The original CodexPro copyright notice and MIT license are preserved in [LICENSE](LICENSE).

This derivative focuses on a single direct ChatGPT-to-workspace agent loop, repository/image evidence, authentication hardening, and reproducible local evaluation. It should not be represented as a from-scratch implementation of the upstream project.

## License

MIT. See [LICENSE](LICENSE).
