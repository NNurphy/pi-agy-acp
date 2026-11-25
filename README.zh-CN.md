# pi-agy-acp（中文）

把 **Google Antigravity CLI**（`agy acp`）接成 [Pi](https://pi.dev) 的模型供应商。

Antigravity 是 Google 的 agent 开发平台，它的 CLI 提供
[ACP（Agent Client Protocol）](https://antigravity.google/docs/cli/acp) 服务。
本扩展把该服务注册为 Pi 的 provider，于是你 Antigravity 账号可用的模型
（Gemini、Claude 等）会像普通 provider 一样出现在 Pi 的模型列表里。

```
Pi  ──▶  pi-agy-acp  ──ACP（stdio 上的 JSON-RPC）──▶  agy acp  ──▶  Google
```

**这不是反代**：没有中间人、不拦截不重签，请求由官方 `agy` 二进制自己发出，
Pi 只做前端。

---

## 前置条件

| 项 | 版本 |
|---|---|
| Pi | ≥ 1.5 |
| Node.js | ≥ 22.19 |
| Antigravity CLI（`agy`） | 已安装并已登录 |

先装好 CLI 并登录：

```bash
# macOS / Linux
curl -fsSL https://antigravity.google/cli/install.sh | bash

# Windows（PowerShell）
irm https://antigravity.google/cli/install.ps1 | iex

agy --version     # 确认安装
agy models        # 确认登录；会列出该账号可用模型
```

`agy models` 必须能列出模型。若提示登录，先运行一次 `agy` 完成浏览器授权。

---

## 安装

**方式 A —— 放进 Pi 的扩展目录**

```bash
git clone https://github.com/NNurphy/pi-agy-acp.git ~/.pi/agent/extensions/pi-agy-acp
```

**方式 B —— 放在任意位置，从设置里引用**

```jsonc
// ~/.pi/agent/settings.json
{
  "extensions": ["/绝对路径/pi-agy-acp"]
}
```

重启 Pi（或 `/reload`），然后 `pi --list-models | grep agy-acp` 验证。

> 代码变更需要新的引擎进程：在 [pi-shell](https://github.com/NNurphy/pi-shell) 这类网页壳里，
> 开一个新列或重启应用。

---

## 配置

全部可选，不设任何变量也能工作。

| 变量 | 默认 | 作用 |
|---|---|---|
| `PI_AGY_COMMAND` | 自动探测 | `agy` 可执行文件路径。自动探测顺序：平台常规安装位置 → `PATH` 上的 `agy`。 |
| `PI_AGY_PROXY` | 未设 | 给 agy 子进程用的代理（如 `http://127.0.0.1:7890`）。仅在未设置 `HTTPS_PROXY`/`HTTP_PROXY` 时生效。 |
| `PI_AGY_SKIP_PERMISSIONS` | `0` | `1` = 自动批准所有工具调用（`--dangerously-skip-permissions`）。只在受信目录使用。 |
| `PI_AGY_MODE` | agy 默认 | 执行模式：`default` / `accept-edits` / `auto` / `plan`。 |
| `PI_AGY_HOME` | 未设 | agy 的独立 HOME，使全局 agy 规则/技能不生效。 |
| `PI_AGY_SAFETY_TIMEOUT` | `3600` | 一轮超过这么多秒没有任何结果就放弃。这是防挂起的保险，**不是**故障判定。 |
| `PI_AGY_WATCH_LOG` | `1` | 尾随 agy 日志以识别上游错误。`0` 关闭。 |
| `PI_AGY_LOG_DIR` | `~/.gemini/antigravity-cli/log` | agy 写 `acp-server-*.log` 的目录。 |
| `PI_AGY_STATE_DIR` | `<pi agent dir>/state` | `/agy-mode` 记住按目录设置的位置。 |

### 命令

| 命令 | 说明 |
|---|---|
| `/agy-acp-status` | 查看 agy 是否可用、模型数量、活跃会话 |
| `/agy-mode` | 查看当前目录的执行模式 |
| `/agy-mode plan` | 只读规划：只出计划，不改文件、不执行命令 |
| `/agy-mode accept-edits` | 自动改文件，命令仍询问 |
| `/agy-mode auto` | 编辑与沙箱内命令自动执行 |
| `/agy-mode reset` | 清除该目录的设置 |

模式按**工作目录**记忆，重启后仍然有效。

---

## 故障提示

`agy` 只把上游错误写进自己的日志、**不回 ACP 响应**，所以"只等协议"的客户端会一直挂着。
本扩展会在本轮内尾随该日志，把 agy 的错误文本映射到 Google 官方错误码
（[错误码表](https://ai.google.dev/gemini-api/docs/api-errors)）：

| 类别 | 典型原文 | 含义 |
|---|---|---|
| `capacity` | `No capacity available for model X` | 模型无容量（503），不是你的配额 |
| `rate_limit` | `RESOURCE_EXHAUSTED`、`429` | 请求过密 |
| `quota` | `reached the quota limit … resume at …` | 订阅窗口用尽 |
| `payment` | `payment_required` | 余额/账单 |
| `auth` | `Authentication required`、`invalid_grant` | 登录失效 |
| `permission` | `permission_denied` | 账号/项目受限 |
| `model_not_found` | `model_not_found` | 模型不可用 |
| `context` | `prompt is too long` | 上下文超限 |
| `deadline` | `deadline_exceeded`、`504` | 上游超时 |
| `blocked` | `safety`、`recitation` | 内容策略 |
| `malformed_output` | `malformed_tool_call` | 工具调用格式错误 |
| `internal` | `api_error`、`500` | 服务端错误 |
| `aborted` | `cancelled`、`499` | 已取消 |
| `invalid_request` | `invalid_request`、`400` | 参数错误 |
| `network` | `transport error`、`TLS handshake`、`EOF` | 连接问题 |
| `local` | `keyring`、`advisory lock` | 本机环境 |

每类都带"是否可重试"和建议动作。若某轮**已产出正文**后才失败，正文会保留并附上原因，
可以直接回「继续」，不必整轮重跑。详见 [`docs/ERROR-CODES.md`](docs/ERROR-CODES.md)。

---

## 限制

- Pi 的工具**不参与** agy 的回合：agy 用自己的 agent loop 和自己的工具，Pi 只渲染结果。
  想用 Pi 原生工具跑 Gemini，请使用 Gemini API。
- 历史是**文本交接**：agy 无法通过 ACP 导入 Pi 的结构化历史；新会话或分支时，早期对话
  会以 transcript 文本重放一次。
- `agy acp` 虽有官方文档但仍年轻，本扩展为实验性质，不绑定具体 agy 版本。
- 与 Google 无关联。你对 Antigravity 的使用受 Google 条款约束。

## 开发

```bash
npm test          # 错误分类器单测（node:test，无需依赖）
pi -e ./src/index.ts --list-models | grep agy-acp
```

结构：`src/config.ts`（所有环境输入）、`src/acp-client.ts`（ACP 传输）、
`src/session.ts`（Pi 会话 ↔ agy 会话）、`src/stream.ts`（回合 → Pi 流事件）、
`src/upstream-errors.ts`（错误表）。见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。与 Google 无关联、未获其背书。