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

下面按最常见的 **Windows + ChatGPT + ngrok + OAuth** 路线写。建议先准备：

- **Git**：用于拉取 AgentDock，以及后续查看 Git 改动。
- **Node.js 20+**：`node -v` 应显示 20 或更高版本。
- **Python 3**：图片/PDF 辅助处理需要。
- **PyMuPDF**：PDF 文本提取、PDF 页面渲染等需要，安装命令：`python -m pip install pymupdf`。
- **ngrok**：推荐用于给本机 AgentDock 提供一个 ChatGPT 能访问的稳定 HTTPS 地址。
- 一个能够创建 **Developer Mode / 自定义 MCP App** 的 ChatGPT 账号或工作区。OpenAI 的入口名称和套餐要求会变化，README 后面给了官方文档链接。

> 推荐路线**不需要去 Namecheap 买域名**。ngrok 免费账号目前会给一个账号级的开发域名。只有你本来就有自定义域名，并且想走 Cloudflare named tunnel 时，Namecheap 这类域名注册商才可能参与进来。

## 从零部署：Windows + ngrok + OAuth（推荐）

这一节故意写得很细，目标是让一个第一次接触 AgentDock 的人，或者让 Codex / Claude Code 之类的本地 Agent，只看 README 就知道每一步该做什么、什么时候必须让用户接手。

### 第 0 步：先搞懂最终链路

最终连接关系是：

```text
ChatGPT
  ↓ HTTPS + OAuth
你的 ngrok 开发域名
  ↓
你电脑上的 AgentDock HTTP/MCP Server（默认 8787 端口）
  ↓
你显式允许的本地项目目录
```

整个过程中最容易混淆的是下面三个东西：

| 名称 | 从哪里拿 | 用在哪里 | 是否保密 |
| --- | --- | --- | --- |
| ngrok Authtoken | ngrok Dashboard | 在本机执行 `ngrok config add-authtoken ...` | **要保密** |
| ngrok Dev Domain | ngrok Dashboard → Domains | AgentDock setup 里的 hostname | 不用保密，它本来就是公网地址 |
| AgentDock OAuth approval key | AgentDock 启动后的终端输出 | ChatGPT OAuth 跳转出来的 AgentDock 授权页 | **要保密** |

**ngrok Authtoken 和 AgentDock OAuth approval key 不是同一个东西。**

### 第 1 步：把 AgentDock 拉到本机

打开 PowerShell、Windows Terminal 或普通终端：

```powershell
git clone https://github.com/Nippori709/AgentDock.git
cd AgentDock
```

如果已经 clone 过：

```powershell
git pull
```

### 第 2 步：安装依赖并构建

在 AgentDock 仓库目录执行：

```powershell
npm install
python -m pip install pymupdf
npm run build
```

`npm run build` 应该正常结束，不能有 TypeScript 编译错误。

建议第一次部署顺便跑完整 smoke：

```powershell
npm run smoke
```

如果想让以后在任意目录都能直接输入命令，可以可选地把当前 checkout 安装成全局 CLI：

```powershell
npm install -g .
```

安装后可以直接使用：

```text
local-workspace-bridge
```

如果不做这一步也完全没问题，后面一直使用：

```text
node scripts/local-workspace-bridge.mjs ...
```

即可。

### 第 3 步：注册 ngrok，并拿到两个值

进入 ngrok 官网并注册/登录账号，然后在 Dashboard 找到：

1. **Authtoken**
2. **Domains** 页面中分配给你账号的开发域名

这里不要自己猜域名，也不要照抄 README 中某个固定后缀。ngrok 的开发域名后缀历史上发生过变化。

新账号可能看到类似：

```text
example-name.ngrok-free.app
```

老账号也可能仍然是类似：

```text
example-name.ngrok-free.dev
```

**以你自己 ngrok Dashboard 中显示的实际域名为准，原样复制。**

目前 ngrok 免费档通常包含一个系统分配的开发域名，但免费档不能保证让你自己随便指定域名名字；如果要自定义 ngrok 域名或自带域名，可能需要付费套餐。

> 所以你如果记得“以前去 Namecheap 申请免费域名”，这里大概率是把两条路线记串了。AgentDock 推荐的免费路线是 **ngrok 自带开发域名**；Namecheap 只属于“自己另外买域名”的高级可选路线。

### 第 4 步：Windows 安装并登录 ngrok

ngrok 当前官方在 Windows 上推荐 Microsoft Store / WinGet。可以执行：

```powershell
winget install ngrok -s msstore
```

也可以直接从 ngrok 官网下载安装。

安装后先验证：

```powershell
ngrok version
```

然后把第 3 步拿到的 **ngrok Authtoken** 写入本机 ngrok 配置：

```powershell
ngrok config add-authtoken "你的_NGROK_AUTHTOKEN"
```

这个 Token 只应该留在本机 ngrok 配置中，不要：

- 写进 README；
- commit 到 Git；
- 截图发出去；
- 发到 Issue；
- 贴进公开聊天。

### 第 5 步：运行 AgentDock setup 向导

推荐直接使用交互式向导：

```powershell
node scripts/local-workspace-bridge.mjs setup
```

如果第 2 步做过 `npm install -g .`，也可以：

```powershell
local-workspace-bridge setup
```

下面把向导的每一个关键问题都解释一遍。

#### 5.1 `Where is your project located?`

这里填的是：**你想让 ChatGPT 控制哪个项目目录**。

例如：

```text
D:\Projects\MyApp
```

这不是在问 AgentDock 自己安装在哪里。

如果你的目的就是让 ChatGPT 操作 AgentDock 源码，那么填 AgentDock 仓库当然可以；但如果你是要操作别的项目，不要误把 AgentDock 自己的目录暴露出去。

#### 5.2 `Which local port should LocalWorkspaceBridge use?`

默认是：

```text
8787
```

一般直接按 Enter 接受默认值即可。

只有本机 8787 已经被其他程序占用时才需要换端口。

#### 5.3 `Public access: quick, stable, ngrok, tailscale, or local?`

这份教程选择：

```text
ngrok
```

各选项含义：

- `quick`：Cloudflare quick tunnel，最省事，但每次重启 URL 可能变化，适合临时测试。
- `ngrok`：**本教程推荐**，使用你 ngrok 账号分配的固定开发域名。
- `stable`：Cloudflare named tunnel，需要你自己的域名。
- `tailscale`：Tailscale Funnel。
- `local`：只监听本机，不提供 ChatGPT Web 能直接访问的公网 HTTPS URL。

#### 5.4 `Ngrok domain or URL, without /mcp`

把第 3 步从 ngrok Dashboard 复制的域名粘贴进来，例如：

```text
example-name.ngrok-free.app
```

注意：

- 可以填 hostname；
- **不要手动加 `/mcp`**；
- AgentDock 最终会自己输出完整的 `https://.../mcp` Server URL。

#### 5.5 `LocalWorkspaceBridge auth token for this workspace`

这里向导会自动生成一个随机默认值。

正常情况下：**直接按 Enter 接受默认值**。

这个值会保存为当前工作区的 AgentDock 本机认证密钥。使用公网 OAuth 时，启动器会把它打印为：

```text
OAuth approval key
```

也就是说，它后面要填到 **AgentDock 自己的 OAuth consent page** 中。

不要公开这个值。

#### 5.6 `Save this setup for future runs from this workspace?`

输入：

```text
yes
```

AgentDock 会把这个工作区的配置保存在：

```text
~/.local-workspace-bridge
```

里面会记录这个工作区对应的：

- 本地端口；
- Tunnel 类型；
- ngrok hostname；
- 本机 AgentDock auth secret；
- 其他 workspace-specific 设置。

所以第一次 setup 完成之后，以后不需要每天重新填一遍。

#### 5.7 `Start LocalWorkspaceBridge now?`

输入：

```text
yes
```

### 第 6 步：看懂启动成功后的终端输出

正常启动后，终端会打印类似：

```text
LocalWorkspaceBridge ready
Workspace   D:\Projects\MyApp
Server URL  https://你的_ngrok_域名/mcp
Authentication: OAuth

OAuth approval key (enter once on the LocalWorkspaceBridge consent page):

  <一串本机私密 key>
```

此时最重要的是两个值：

#### A. Server URL

类似：

```text
https://你的_ngrok_域名/mcp
```

这个完整地址要复制到 ChatGPT 的自定义 MCP App / Connector 配置里。

#### B. OAuth approval key

这串 key **不要填到 ChatGPT 的 Server URL 里**。

先让 AgentDock 终端保持运行。等 ChatGPT 发起 OAuth 后，会打开 AgentDock 自己的授权确认页面，到那个页面再填。

### 第 7 步：在 ChatGPT 创建 AgentDock MCP App

ChatGPT 的产品 UI 会更新，不同套餐/工作区看到的入口也可能不完全一样。

OpenAI 当前官方文档通常描述为：

```text
Settings → Apps → Create
```

有些账号/版本仍然可能显示成类似：

```text
Developer Mode → Plugins → +
```

不要死记 README 中某一个按钮名称；目标是找到“创建自定义 MCP App / Connector”的入口。

推荐填写：

```text
Name: AgentDock
Description: Local coding workspace bridge for ChatGPT
Connection: Server URL
Server URL: https://你的_ngrok_域名/mcp
Authentication: OAuth
```

如果界面有 **Scan Tools / 扫描工具**，点击它。

因为 AgentDock 使用 OAuth，ChatGPT 会进入授权流程，并跳转到 AgentDock 的 consent page。

OpenAI 当前 Developer Mode / MCP 官方说明：

https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta

> 如果你的账号完全没有自定义 MCP App 入口，或者能读但写操作被产品侧限制，先核对 OpenAI 当前套餐/工作区权限，不要第一时间认定是 AgentDock 部署失败。

### 第 8 步：在 AgentDock consent page 输入 approval key

ChatGPT OAuth 跳转到 AgentDock 授权页之后：

1. 确认这次连接确实是你刚刚在 ChatGPT 主动发起的；
2. 看一下页面显示的 Client / Redirect 信息有没有异常；
3. 把第 6 步终端打印的 **OAuth approval key** 粘贴进去；
4. 点击批准。

这里千万不要填 ngrok Authtoken。

再次强调：

```text
ngrok Authtoken
    → 只用于 ngrok CLI 登录

AgentDock OAuth approval key
    → 只用于 AgentDock consent page 授权
```

批准后，ChatGPT 会完成 OAuth/PKCE，拿到 Access Token，然后开始扫描/调用 MCP 工具。

### 第 9 步：第一次连接先做只读测试

建议第一次不要直接让它改文件。

先发：

```text
Use AgentDock to open the current workspace, inspect the repository, and summarize the architecture. Do not edit files.
```

或者中文：

```text
使用 AgentDock 打开当前工作区，读取目录和主要源码，总结项目架构。先不要修改任何文件。
```

确认下面这类工具能正常工作：

- `open_current_workspace`
- `tree`
- `search`
- `read`

只读链路正常之后，再测试 `write` / `edit` / `apply_patch` / `bash`。

### 第 10 步：以后每天怎么启动

如果第一次 setup 时选择保存配置，那么 ngrok 域名和工作区 profile 都已经保存。

以后**不需要**重新：

- 注册 ngrok；
- 输入 ngrok Authtoken；
- 创建新的 ChatGPT App；
- 换 Server URL。

从 AgentDock 仓库启动：

```powershell
node scripts/local-workspace-bridge.mjs start --root "D:\Projects\MyApp"
```

如果安装了全局 CLI：

```powershell
cd D:\Projects\MyApp
local-workspace-bridge start
```

只要仍然使用同一个 ngrok 开发域名，ChatGPT 中配置的 Server URL 可以一直不变。

## 已经知道域名时：跳过向导直接启动

如果 ngrok 已经安装、Authtoken 已经写入本机，而且你已经知道自己的开发域名，可以直接：

```powershell
node scripts/local-workspace-bridge.mjs ngrok --root "D:\Projects\MyApp" --hostname 你的_ngrok_域名
```

但首次部署仍建议走一次 setup 并保存 profile，这样后续自动化更稳定，也避免把敏感 token 塞在命令行里。

## 如果让 Codex / Claude Code 全程帮你部署

本地 Coding Agent 通常可以自动完成：

- clone / pull AgentDock；
- 检查 Git、Node.js、Python、ngrok 是否安装；
- `npm install`；
- 安装 PyMuPDF；
- `npm run build`；
- `npm run smoke`；
- 启动 setup；
- 根据 README 选择本机配置；
- 排查端口占用、构建失败、进程启动失败等问题。

但下面这些步骤**不要让 Agent 自己猜**：

1. 登录/注册 ngrok；
2. 获取你的 ngrok Authtoken；
3. 获取你的实际 ngrok Dev Domain；
4. 在 ChatGPT 中启用 Developer Mode / 自定义 App 能力；
5. 创建/授权 AgentDock MCP App；
6. 在 AgentDock consent page 输入终端打印的 OAuth approval key。

可以直接把这段 Prompt 给本地 Codex：

```text
请从零部署 https://github.com/Nippori709/AgentDock 。
严格按照 README_ZH.md 的“Windows + ngrok + OAuth”推荐路线执行。
你负责所有可以在本机终端完成的步骤，包括 clone、依赖安装、build、smoke、启动和本机故障排查。
不要自行编造 ngrok 域名、Authtoken、AgentDock approval key，也不要猜 ChatGPT 账号权限。
当必须由我登录 ngrok 或 ChatGPT 网页操作时，明确告诉我：打开哪个页面、复制哪个值、把什么值给你，然后继续执行。
在 build 和 smoke 全部通过，并且 ChatGPT 成功扫描 AgentDock 工具之前，不要宣布部署完成。
```

## 公网 Tunnel 怎么选

### 推荐：ngrok 账号分配的开发域名

适合大多数用户：简单，而且 URL 可以长期保持不变。

免费账号当前通常会分配一个开发域名。**具体后缀以你 ngrok Dashboard 为准**，不要机械照抄旧版 README 的 `.dev` 示例。

### 临时测试：Cloudflare quick tunnel

只想快速试一下：

```powershell
node scripts/local-workspace-bridge.mjs start
```

缺点是 quick tunnel URL 重启后可能变化。URL 一变，ChatGPT 里的 Server URL 也需要跟着更新。

### 高级：自己的域名 + Cloudflare named tunnel

如果你已经有自己的域名，例如在 Namecheap 买过一个域名，可以把域名正确配置到 Cloudflare DNS，再走 Cloudflare named tunnel。

这条路线更适合：

- 已经有自己的域名；
- 想使用自定义子域名；
- 想自己管理 DNS/Tunnel。

**它不是 AgentDock 的必需步骤，也不是推荐新手为了部署 AgentDock 专门去买域名。**

### 只给本机 MCP Client：local

```powershell
node scripts/local-workspace-bridge.mjs start --tunnel none
```

这种模式不会生成 ChatGPT Web 能访问的公网 HTTPS 地址。

## 为什么推荐 OAuth，而不是把 token 放进 URL？

推荐：

```text
https://你的_ngrok_域名/mcp
+ OAuth / PKCE
```

而不是：

```text
https://你的_ngrok_域名/mcp?token=...
```

Query-string credential 默认关闭，而且 URL 中的凭据更容易出现在浏览器历史、日志等位置。既然稳定公网 URL 已经支持 AgentDock 内置 OAuth，就没必要再把 token 塞进 URL。

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
