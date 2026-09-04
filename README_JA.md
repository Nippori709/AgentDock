# AgentDock

**Languages:** [English](README.md) · [简体中文](README_ZH.md) · [日本語](README_JA.md)

AgentDock は、ChatGPT からローカルの開発ワークスペースへ、明示的な境界の中でアクセスできるようにするローカル MCP Gateway です。モデル側が計画・判断を担当し、AgentDock はリポジトリの根拠情報、ローカルファイルと画像、直接編集、コマンド検証、Git ベースの変更レビューを提供します。

> **Status:** early public release (`0.1.x`)。公開トンネル経由でローカルワークスペースを公開する前に、必ず [SECURITY.md](SECURITY.md) を確認してください。

## AgentDock を使う理由

ChatGPT はコードについて推論できますが、通常の Web セッションから PC 上の任意のプロジェクトファイルを直接確認・編集することはできません。AgentDock は MCP を通してそのギャップを埋めます。

```text
ChatGPT model
  ├─ inspect / search：リポジトリの根拠を取得
  ├─ read / image tools：テキストや画像を読む
  ├─ write / edit / apply_patch：ワークスペースを直接編集
  ├─ bash：制限付き検証コマンドを実行
  └─ show_changes：Git 変更をレビュー
        ↓
   local workspace
```

AgentDock は、モデルとは別の第 2 の Planner や実行レイヤーを追加しません。計画は MCP ツールを使っているモデル側に残します。

## 主な機能

- **Workspace isolation** — 許可した root のみを開き、path traversal、blocked file、symlink escape を防ぎます。
- **Repository analysis** — bounded inventory、言語/プロジェクト判定、symbols、relationships、impact hints、related tests、change-risk signals。
- **Text tools** — tree、search、paged read、exact edit、write、unified patch。
- **Image tools** — JPEG/PNG/WebP の metadata、preview、crop、tile 読み取り。
- **Verification** — Bash の `off / safe / full` と Git-aware `show_changes`。
- **HTTP + stdio** — ローカル MCP client は stdio、ChatGPT は HTTPS tunnel 経由の HTTP MCP を利用可能。
- **OAuth for public HTTP** — stable public URL がある場合、OAuth discovery / PKCE を利用できます。
- **Multiple workspaces** — 許可範囲内で複数 workspace を open / list / close / switch。
- **Optional local Codex history reads** — デフォルト無効。明示的に有効化した場合のみ読み取り。
- **Linux service support** — stable profile を `systemd --user` サービスとして実行可能。

## 必要環境

推奨する **Windows + ChatGPT + ngrok + OAuth** 構成では、次を用意してください。

- **Git**
- **Node.js 20+**
- **Python 3**
- **PyMuPDF**：`python -m pip install pymupdf`
- **ngrok**：ChatGPT から到達できる stable HTTPS URL 用
- Custom MCP App / Developer Mode を利用できる ChatGPT account/workspace

推奨ルートでは Namecheap などでドメインを購入する必要はありません。ngrok の free plan には account に割り当てられた development domain があります。独自ドメインを既に持っている場合だけ、Cloudflare named tunnel を代替ルートとして利用できます。

## ゼロからの導入：Windows + ngrok + OAuth

### Step 0 — 接続構成

```text
ChatGPT
  ↓ HTTPS + OAuth
ngrok development domain
  ↓
AgentDock HTTP/MCP server (default: 8787)
  ↓
explicitly allowed local workspace
```

混同しやすい値は 3 つあります。

| 項目 | 取得場所 | 使用場所 | 秘密情報? |
| --- | --- | --- | --- |
| ngrok authtoken | ngrok Dashboard | `ngrok config add-authtoken ...` | **Yes** |
| ngrok dev domain | ngrok Dashboard → Domains | AgentDock setup の hostname | No |
| AgentDock OAuth approval key | AgentDock 起動端末 | AgentDock consent page | **Yes** |

ngrok authtoken と AgentDock OAuth approval key は別物です。

### Step 1 — Clone

```powershell
git clone https://github.com/Nippori709/AgentDock.git
cd AgentDock
```

既に clone 済みなら：

```powershell
git pull
```

### Step 2 — Dependencies / build

```powershell
npm install
python -m pip install pymupdf
npm run build
npm run smoke
```

任意で global CLI として現在の checkout を登録できます。

```powershell
npm install -g .
```

これを行うと `local-workspace-bridge` コマンドを直接使えます。

### Step 3 — ngrok account から 2 つの値を取得

ngrok Dashboard で次を確認します。

1. **Authtoken**
2. **Domains** に表示される account-assigned development domain

ドメイン名は README の例をコピーせず、Dashboard に表示された実際の値を使ってください。account によっては次のような suffix が表示されます。

```text
example-name.ngrok-free.app
```

古い account では次のような hostname が残っている場合もあります。

```text
example-name.ngrok-free.dev
```

### Step 4 — ngrok を Windows にインストール

例：

```powershell
winget install ngrok -s msstore
ngrok version
```

次に ngrok authtoken をローカル設定へ保存します。

```powershell
ngrok config add-authtoken "YOUR_NGROK_AUTHTOKEN"
```

この token は Git/README/Issue/公開チャットに貼らないでください。

### Step 5 — AgentDock setup wizard

```powershell
node scripts/local-workspace-bridge.mjs setup
```

global CLI を登録した場合：

```powershell
local-workspace-bridge setup
```

推奨回答：

1. `Where is your project located?` → ChatGPT に操作させたい実際の project folder。
2. `Which local port ...?` → 通常は Enter で `8787`。
3. `Public access: ...?` → `ngrok`。
4. `Ngrok domain or URL, without /mcp` → Dashboard からコピーした hostname。`/mcp` は付けない。
5. `LocalWorkspaceBridge auth token for this workspace` → 通常は生成された default を Enter で採用。
6. `Save this setup ...?` → `yes`。
7. `Start LocalWorkspaceBridge now?` → `yes`。

workspace profile は `~/.local-workspace-bridge` に保存されるため、毎回同じ設定を入力する必要はありません。

### Step 6 — Startup output

成功時は次のような情報が表示されます。

```text
LocalWorkspaceBridge ready
Server URL  https://YOUR_NGROK_DOMAIN/mcp
Authentication: OAuth

OAuth approval key (enter once on the LocalWorkspaceBridge consent page):
  <private-key>
```

ChatGPT に入力するのは **Server URL** です。approval key は URL に追加せず、OAuth consent page でのみ使います。

### Step 7 — ChatGPT で custom MCP App を作成

ChatGPT UI は plan/rollout によって変わります。現在の OpenAI documentation では一般に **Settings → Apps → Create** が案内されていますが、一部の account/build では Developer Mode / Plugins の UI が表示されることがあります。

入力例：

```text
Name: AgentDock
Description: Local coding workspace bridge for ChatGPT
Connection: Server URL
Server URL: https://YOUR_NGROK_DOMAIN/mcp
Authentication: OAuth
```

`Scan Tools` がある場合は実行します。OAuth が開始されると AgentDock consent page に遷移します。

Current OpenAI help:

https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta

### Step 8 — OAuth approval

AgentDock consent page で：

1. 自分が ChatGPT から開始した request であることを確認。
2. terminal に表示された **AgentDock OAuth approval key** を入力。
3. Approve。

ここに ngrok authtoken を入力しないでください。

### Step 9 — Read-only test

```text
Use AgentDock to open the current workspace, inspect the repository, and summarize the architecture. Do not edit files.
```

まず `open_current_workspace` / `tree` / `search` / `read` を確認し、その後 write/edit/bash を試すのが安全です。

### Step 10 — Daily start

saved profile がある場合：

```powershell
node scripts/local-workspace-bridge.mjs start --root "D:\Projects\MyApp"
```

または global CLI：

```powershell
cd D:\Projects\MyApp
local-workspace-bridge start
```

同じ ngrok development domain を使う限り、ChatGPT 側の Server URL を毎回変更する必要はありません。

## Coding Agent に導入を任せる場合

Codex / Claude Code などは clone、dependency install、build、smoke、local process troubleshooting まで自動化できます。ただし次を推測させないでください。

1. ngrok login/account creation
2. ngrok authtoken
3. actual ngrok dev domain
4. ChatGPT account/workspace permissions
5. ChatGPT custom MCP App creation/authorization
6. AgentDock OAuth approval key の consent page 入力

例：

```text
Clone https://github.com/Nippori709/AgentDock and deploy it by following README_JA.md exactly.
Use the Windows + ngrok + OAuth path. Do all local terminal steps yourself.
Never invent a domain, token, approval key, or ChatGPT account permission.
When a browser/account action is required, tell me exactly what value you need and continue after I provide it.
Run build and smoke before declaring deployment complete.
```

## Tunnel の選択

- **ngrok**：推奨。account-assigned development domain を利用。
- **quick**：Cloudflare quick tunnel。簡単だが再起動で URL が変わることがある。
- **stable**：自分の domain + Cloudflare named tunnel。
- **tailscale**：Tailscale Funnel。
- **local**：public URL なし。

Namecheap は必須ではありません。既に Namecheap 等で独自ドメインを所有していて Cloudflare named tunnel を使いたい場合だけ関係します。

## OAuth を推奨する理由

推奨：

```text
https://YOUR_NGROK_DOMAIN/mcp
+ OAuth / PKCE
```

非推奨：

```text
https://YOUR_NGROK_DOMAIN/mcp?token=...
```

Query-string credential は漏えいしやすく、デフォルトで無効です。stable public URL では built-in OAuth を利用してください。

## Tool Mode

`LOCALWORKSPACEBRIDGE_TOOL_MODE` は ChatGPT に公開する MCP tool surface を制御します。

- `minimal` — workspace open、text/image read、write/edit/patch、bash、change review。
- `standard` — デフォルト。repository analysis、tree/search、skills、workspace management を追加。
- `full` — 高度な diagnostics、Git details、snapshot/inventory、optional Codex session tools を追加。

Write policy：

```text
LOCALWORKSPACEBRIDGE_WRITE_MODE=workspace
LOCALWORKSPACEBRIDGE_WRITE_MODE=off
```

Bash policy：

```text
LOCALWORKSPACEBRIDGE_BASH_MODE=safe
LOCALWORKSPACEBRIDGE_BASH_MODE=off
LOCALWORKSPACEBRIDGE_BASH_MODE=full
```

`full` は、信頼できる repository と command environment でのみ使用してください。

## Repository Analysis

`inspect_workspace` は manifest、source declarations、imports、tests、Git state から bounded repository map を構築します。structured `search` は symbol/reference/impact intent にも対応します。

この analysis layer はモデルに実際の根拠を渡すためのもので、モデルの代わりに implementation plan を決定・実行するものではありません。

## Image Access

大きな画像を最初から full resolution で model context に入れないため、次の progressive workflow を推奨します。

```text
image_info → read_image preview → 必要に応じて read_image_crop / read_image_tile
```

画像にも text file と同じ workspace/path security boundary が適用されます。

## PDF / DOCX Access

AgentDock は `read_pdf` で PDF のテキストを抽出し、`read_pdf_page` で指定ページを画像として確認できます。Word `.docx` は `read_docx` で段落や表の行を抽出できます。

PDF 機能には AgentDock を実行するマシン上の PyMuPDF が必要です。

```bash
python -m pip install pymupdf
```

DOCX は OOXML を直接解析するため、Microsoft Word や追加の Python パッケージは不要です。

## Security Model

主なデフォルト：

- root は明示的に許可する必要があります。
- `.env`、private key、credential store、dependency/build directory などは block されます。
- read output は secret-like content を redact し、write/edit は明らかな credential の書き込みを拒否します。
- public / non-loopback HTTP は、明示的な例外を除き authentication を要求します。
- query-string credential はデフォルト無効です。
- safe Bash は high-risk shell pattern と environment expansion を制限します。
- デフォルト log は source body、prompt、credential、full command output を記録しない設計です。

AgentDock は developer bridge であり、**OS sandbox ではありません**。詳細は [SECURITY.md](SECURITY.md) を参照してください。

## 検証

```bash
npm run build
npm run smoke
npm run benchmark:quick
```

Benchmark はローカルで再現可能な host-side behavior を対象とし、tool-schema size、共通 direct-agent workflow、security boundary、生成 repository 上の inventory/search timing を報告します。machine-specific result は自動 commit しません。

## Linux

Headless Linux / VPS の `systemd --user` セットアップは [LINUX_SERVER.md](LINUX_SERVER.md) を参照してください。

## Configuration

[config.example.env](config.example.env) を参照してください。machine-specific setting を commit するより、workspace ごとの saved profile を推奨します。

## Attribution

AgentDock は open-source **CodexPro** をベースにした derivative work です。CodexPro の original copyright notice と MIT License は [LICENSE](LICENSE) に保持されています。

現在の AgentDock は、single direct ChatGPT-to-workspace agent loop、repository/image evidence、authentication hardening、reproducible local evaluation に重点を置いています。upstream をゼロから再実装したプロジェクトとして扱うべきではありません。

## License

MIT. [LICENSE](LICENSE) を参照してください。
