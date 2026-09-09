# pi-delegate

把外部 agent（如 Codex）委派的任务交给 pi agent headless（`pi -p`）执行。

这个目录提供**两种等价形式**，按客户端能力二选一：

| 形式 | 适用客户端 | 位置 |
|---|---|---|
| **Skill（推荐）** | Codex 等 shell 型 agent —— 直接跑 `pi -p`，天然支持后台/并行/重试 | `~/pi-extensions/skills/pi-delegate/SKILL.md`，软链到 `~/.codex/skills/pi-delegate` |
| **MCP server** | 不能跑 shell 的 MCP 客户端，或需要结构化工具 schema 的场景 | 本目录 `server.mjs` |

## MCP server 用法

零依赖，Node ≥ 22 直接运行：

```toml
# ~/.codex/config.toml（或其他 MCP 客户端配置）
[mcp_servers.pi-delegate]
command = "/Users/shuguang/.nvm/versions/node/v24.20.0/bin/node"
args = ["/Users/shuguang/pi-extensions/plugins/pi-delegate/server.mjs"]
startup_timeout_sec = 30

[mcp_servers.pi-delegate.env]
PI_BIN = "/Users/shuguang/.nvm/versions/node/v24.20.0/bin/pi"
PI_DELEGATE_MODEL = "9779/gpt-5.6-sol"   # pi 默认模型当前 404，建议显式指定
```

### 工具

- **`pi_dispatch`** —— 同步执行：阻塞直到完成（默认超时 10 分钟，`timeout_ms` 可调），返回最终回复
- **`pi_dispatch_start`** —— 异步启动，立即返回 `task_id`（适合长任务，规避客户端工具超时）
- **`pi_dispatch_poll`** —— 轮询异步任务：状态 + 输出尾部，`wait_seconds` 可阻塞等待（≤120s）

### 参数（start / dispatch 共用）

`prompt`（必填）、`cwd`、`model`、`provider`、`thinking`、`session_id`（多轮委派）、`name`、`append_system_prompt`、`no_extensions`、`trust_project`（默认 true → `--approve`）

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `PI_BIN` | `pi` | pi 可执行文件路径 |
| `PI_DELEGATE_MODEL` | （空） | 默认模型，如 `9779/gpt-5.6-sol` |
| `PI_DELEGATE_CWD` | server 启动目录 | 未传 cwd 时的执行目录 |
| `PI_DELEGATE_TIMEOUT_MS` | `600000` | 同步执行默认超时 |
| `PI_DELEGATE_MAX_OUTPUT_CHARS` | `100000` | 返回输出上限字符 |
| `PI_DELEGATE_MAX_CONCURRENT` | `8` | 并发 pi 进程上限 |

### 安全

pi 执行 bash / edit / write 无审批门禁，委派 = 赋予对目标目录的完整系统访问权限。只把信任的项目目录作为 `cwd`。客户端断开（stdin 关闭）时 server 会终止所有运行中的 pi 子进程。