# AgentDock

**Languages:** [English](README.md) · [简体中文](README_ZH.md) · [日本語](README_JA.md)

AgentDock 是一个运行在本机的 MCP Gateway，让 ChatGPT 在明确的工作区边界内读取仓库、分析代码、查看图片、修改文件、运行验证命令并审查 Git 改动。

核心设计只有一条执行链：**ChatGPT 负责理解、规划和决策；AgentDock 负责提供真实仓库证据与本机执行能力。**

> 当前为早期公开版本 `0.1.x`。通过公网隧道暴露本机工作区前，请先阅读 [SECURITY.md](SECURITY.md)。

## 为什么做 AgentDock

网页端 ChatGPT 本身具备较强的代码理解和规划能力，但默认无法直接访问你电脑上的任意项目文件。AgentDock 通过 MCP 补上“眼睛和手”：

```text
ChatGPT 大模型
  ├─ inspect / search：获取仓库证据
  ├─ read / image tools：读取文本和图片
  ├─ write / edit / apply_patch：直接修改工作区
  ├─ bash：运行受控验证命令
  └─ show_changes：审查最终 Git 改动
        ↓
     本机工作区
```

AgentDock 不额外实现第二套服务端规划/执行层，规划职责保持在正在调用 MCP 工具的大模型侧。

## 主要能力

- **工作区隔离**：只允许访问明确授权的 root，阻止路径逃逸、敏感文件和危险 symlink。
- **Repository Analysis**：本地生成有界的仓库 inventory、语言/项目类型、symbol、relationship、impact、related tests 和风险提示。
- **文本工具**：tree、search、分页 read、write、精确 edit、unified patch。
- **图片工具**：JPEG/PNG/WebP 的 metadata、preview、crop 和 tile 分级读取。
- **执行与验证**：Bash 支持 `off / safe / full` 三种模式，并通过 `show_changes` 汇总 Git 状态、diff 和影响分析。
- **stdio + HTTP**：本地 MCP Client 可使用 stdio；ChatGPT Web 可通过 HTTPS Tunnel 访问 HTTP MCP。
- **OAuth / PKCE**：稳定公网地址下可使用 OAuth 授权，不需要把凭据塞进 Server URL。
- **多工作区**：可以打开、列出、关闭和切换允许范围内的项目。
- **可选 Codex 历史读取**：默认关闭，仅在用户主动启用后读取本机 Codex session metadata / transcript。
- **Linux 服务化**：稳定 Tunnel profile 可安装为 `systemd --user` 服务。

## 环境要求

- Node.js 20+
- Git
- Python 3（图片处理）
- PyMuPDF：`pip install pymupdf`
- 可选：Cloudflare Tunnel / ngrok / Tailscale

## 本仓库直接运行

```bash
npm install
npm run build
node scripts/local-workspace-bridge.mjs setup
```

只在本机提供 MCP：

```bash
node scripts/local-workspace-bridge.mjs start --tunnel none
```

正常给 ChatGPT Web 使用时，在你想开放的项目目录中运行 setup/start。AgentDock 会把工作区级配置保存在 `~/.local-workspace-bridge`，并输出 MCP Server URL。

## ChatGPT 接入

1. 在目标项目中启动 AgentDock。
2. 长期使用建议选择稳定 HTTPS Tunnel。
3. 在 ChatGPT Developer Mode / Plugins 中添加 AgentDock 输出的 Server URL。
4. 如果启用 OAuth，按本机 approval 流程授权，不要把 token 写进 URL。

首次可以让 ChatGPT：

```text
Use AgentDock to open the current workspace, inspect the repository, and summarize the architecture. Do not edit files.
```

## ChatGPT + ngrok + OAuth 快速接入

如果你希望 ChatGPT 长期使用一个稳定公网地址，同时又不想把 Bearer Token 塞进 MCP URL，推荐使用 **固定 ngrok 域名 + OAuth/PKCE**。

### 1. 配置 ngrok

安装并登录 ngrok，然后只在本机写入 ngrok Auth Token：

```bash
ngrok config add-authtoken <your-ngrok-token>
```

在 ngrok 账号中创建或保留一个固定域名，例如 `your-name.ngrok-free.dev`。不要把 ngrok Auth Token 或本机 ngrok 配置提交到仓库。

### 2. 构建 AgentDock

```bash
npm install
npm run build
```

### 3. 使用固定 ngrok 域名启动

```bash
node scripts/local-workspace-bridge.mjs ngrok --hostname your-name.ngrok-free.dev
```

Launcher 会启动本机 MCP HTTP Server、连接这个固定 ngrok 域名，并为公网 URL 启用 OAuth/PKCE。终端会打印一个不带凭据的 MCP Server URL，同时还会打印本机 **OAuth approval key（授权确认密钥）**。这个 key 只应在 AgentDock 的授权确认页中输入，不要公开。

### 4. 在 ChatGPT 中添加

在 ChatGPT Developer Mode / Plugins 中：

1. 选择通过 **Server URL** 添加 MCP 连接。
2. 粘贴 AgentDock 打印的地址，例如 `https://your-name.ngrok-free.dev/mcp`。
3. Authentication 选择 **OAuth**。
4. 发起连接，ChatGPT 会进入 OAuth 授权流程。
5. 在 AgentDock consent page 中确认这是你刚刚发起的连接，输入终端打印的 OAuth approval key，然后批准。

批准后，ChatGPT 会完成 OAuth/PKCE，并使用得到的 Access Token 调用 MCP；你不需要把 Bearer Token 拼进 Server URL。

### 为什么推荐 OAuth，而不是把 token 放进 URL？

推荐：

```text
https://your-name.ngrok-free.dev/mcp
+ OAuth / PKCE
```

而不是：

```text
https://your-name.ngrok-free.dev/mcp?token=...
```

Query-string credential 默认就是关闭的，而且 URL 中的凭据更容易出现在浏览器历史、日志或其他记录面。既然固定公网 URL 已经支持内置 OAuth，就没有必要再把 token 放到 URL 里。

> OAuth approval key 和 ngrok Auth Token 不是同一个东西。ngrok Token 只保存在 ngrok 的本机配置中；OAuth approval key 由 AgentDock 用来确认你是否允许 ChatGPT 获得当前工作区访问权限。

## Tool Mode

`LOCALWORKSPACEBRIDGE_TOOL_MODE`：

- `minimal`：最紧凑的直接编码闭环，包含 workspace、文本/图片读取、写入/编辑/patch、bash、change review。
- `standard`：默认；额外包含 repository analysis、tree/search、skills 和 workspace management。
- `full`：额外暴露高级诊断、Git detail、snapshot/inventory，以及可选 Codex session 工具。

写权限单独控制：

```text
LOCALWORKSPACEBRIDGE_WRITE_MODE=workspace
LOCALWORKSPACEBRIDGE_WRITE_MODE=off
```

Bash 单独控制：

```text
LOCALWORKSPACEBRIDGE_BASH_MODE=safe
LOCALWORKSPACEBRIDGE_BASH_MODE=off
LOCALWORKSPACEBRIDGE_BASH_MODE=full
```

`full` 只应在可信仓库和可信命令环境中使用。

## Repository Analysis 的职责

`inspect_workspace` 根据本地 manifest、源码声明、imports、tests 和 Git state 构建有界仓库地图；structured `search` 还支持 symbol/reference/impact 类查询。

这些能力负责给 ChatGPT 提供**真实证据**，而不是替 ChatGPT 再做一次规则式任务规划。

## 图片读取

为了避免大图一次性占满模型上下文，推荐：

```text
image_info → read_image preview → 需要细节时 read_image_crop / read_image_tile
```

图片工具和文本工具使用同一套 workspace/path 安全边界。

## PDF 和 DOCX 读取

AgentDock 可以用 `read_pdf` 提取 PDF 文本，用 `read_pdf_page` 把指定 PDF 页面渲染成图片查看版式、扫描内容、图表或表格，也可以用 `read_docx` 提取 Word `.docx` 中的段落和表格行。

PDF 功能需要运行 AgentDock 的电脑安装 PyMuPDF：

```bash
python -m pip install pymupdf
```

DOCX 直接解析 OOXML，不需要安装 Microsoft Word，也不需要额外 Python 包。

## 安全边界

默认策略包括：

- 只访问显式允许的 roots；
- 阻止 `.env`、私钥、凭据目录、依赖/构建目录等敏感路径；
- read 输出会对疑似 secret 做脱敏，write/edit 会阻止明显凭据写入；
- 公网或非 loopback HTTP 默认要求认证；
- 默认不允许把凭据放进 query string；
- safe Bash 阻止高风险 shell pattern 与环境变量展开；
- 默认日志不记录源文件正文、prompt、credential 和完整命令输出。

AgentDock 是开发者桥接工具，**不是操作系统级 Sandbox**。完整说明见 [SECURITY.md](SECURITY.md)。

## 验证与评测

```bash
npm run build
npm run smoke
npm run benchmark:quick
```

公开 benchmark 只记录可以本地复现的 host-side 指标：Tool Schema、大致 workflow 可执行性、安全边界、生成仓库上的 inventory/search 性能。机器相关结果只输出到终端，不自动写进仓库。

## Linux

Headless Linux / VPS 的 `systemd --user` 运行方式见 [LINUX_SERVER.md](LINUX_SERVER.md)。

## 来源与许可证

AgentDock 是基于开源项目 **CodexPro** 的衍生开发，保留原项目的 MIT License 和版权声明，见 [LICENSE](LICENSE)。

本项目公开时应如实说明这一代码血缘；它不是“从零重新实现 CodexPro”。AgentDock 的当前方向主要集中在单一直接 Agent 执行链、仓库/图片证据、认证加固以及可复现本地评测。
