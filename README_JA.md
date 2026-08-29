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

- Node.js 20+
- Git
- Python 3（画像処理用）
- PyMuPDF：`pip install pymupdf`
- 任意：Cloudflare Tunnel / ngrok / Tailscale

## インストールと起動

このリポジトリから：

```bash
npm install
npm run build
node scripts/local-workspace-bridge.mjs setup
```

ローカル専用 MCP endpoint：

```bash
node scripts/local-workspace-bridge.mjs start --tunnel none
```

通常の ChatGPT workflow では、公開したいプロジェクトで setup wizard を実行します。workspace ごとの設定は `~/.local-workspace-bridge` に保存され、MCP Server URL が表示されます。

## ChatGPT 接続

1. 対象プロジェクトで AgentDock を起動します。
2. 継続利用する場合は stable HTTPS tunnel を使います。
3. ChatGPT Developer Mode / Plugins で、表示された Server URL を追加します。
4. OAuth が有効な場合は、URL に credential を埋め込まず、ローカル consent flow を完了します。

最初の確認用プロンプト例：

```text
Use AgentDock to open the current workspace, inspect the repository, and summarize the architecture. Do not edit files.
```

## ChatGPT + ngrok + OAuth クイックスタート

固定の公開 URL を使いつつ、Bearer Token を MCP URL に入れたくない場合は、**固定 ngrok ドメイン + OAuth/PKCE** を推奨します。

### 1. ngrok を準備する

ngrok をインストールしてログインし、ngrok Auth Token をローカル設定に追加します。

```bash
ngrok config add-authtoken <your-ngrok-token>
```

ngrok アカウントで固定ドメインを作成または予約します。例：`your-name.ngrok-free.dev`。ngrok Auth Token やローカル設定ファイルはリポジトリに commit しないでください。

### 2. AgentDock をビルドする

```bash
npm install
npm run build
```

### 3. 固定 ngrok hostname で起動する

```bash
node scripts/local-workspace-bridge.mjs ngrok --hostname your-name.ngrok-free.dev
```

Launcher はローカル MCP HTTP Server を起動し、予約済み ngrok hostname を接続し、その public URL に対して OAuth/PKCE を有効にします。端末には credential を含まない MCP Server URL と、ローカルの **OAuth approval key** が表示されます。

OAuth approval key は AgentDock の consent page で接続を承認するときだけ入力してください。公開しないでください。

### 4. ChatGPT に追加する

ChatGPT Developer Mode / Plugins で：

1. **Server URL** を使って MCP 接続を追加します。
2. AgentDock が表示した URL を貼り付けます。例：`https://your-name.ngrok-free.dev/mcp`。
3. Authentication は **OAuth** を選びます。
4. 接続を開始すると ChatGPT が OAuth authorization flow に入ります。
5. AgentDock の consent page で、自分が開始した接続であることを確認し、端末に表示された OAuth approval key を入力して承認します。

承認後、ChatGPT は OAuth/PKCE を完了し、取得した Access Token で MCP request を行います。Server URL に Bearer Token を追加する必要はありません。

### URL token より OAuth を推奨する理由

推奨：

```text
https://your-name.ngrok-free.dev/mcp
+ OAuth / PKCE
```

非推奨：

```text
https://your-name.ngrok-free.dev/mcp?token=...
```

Query-string credential はデフォルトで無効です。また URL に credential を入れると、browser history や log などに残る可能性があります。stable public URL では built-in OAuth を利用できるため、URL token は不要です。

> OAuth approval key と ngrok Auth Token は別物です。ngrok Token は ngrok のローカル設定に保存されます。OAuth approval key は、AgentDock が ChatGPT に workspace access を許可するか確認するためのキーです。

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
