---
name: pi-delegate
description: 把完整任务委派给 pi 编码代理 headless 执行并取回结果。当用户要求"交给 pi 做""让 pi 执行""分配给 pi agent"，或需要把独立的编码子任务并行派发时使用。
---

# pi-delegate

把一个任务交给 pi agent（`pi -p` headless 模式）执行并取回最终结果。pi 拥有 read / bash / edit / write 工具，会在目标目录内自主多步执行。

## 铁律

1. **pi 看不到当前对话。** prompt 必须自带全部上下文：目标、涉及文件的绝对路径、约束、验收标准。写 prompt 时假设接收方是一个刚入职、只看这条消息的工程师。
2. **pi 执行 bash 无审批门禁。** 只把信任的项目目录作为执行目录；不要在 prompt 中夹带与本任务无关的敏感信息。
3. **必须显式指定 `--model`。** pi 默认配置的模型当前不可用（404），不指定会直接报错。可用模型用 `pi --list-models [关键词]` 查询。常用：
   - `9779/gpt-5.6-sol`（快，已验证）
   - `opencode-go/kimi-k2.7-code`（长上下文，适合大任务）
   - `deepseek/deepseek-v4-pro`

## 基本用法

```bash
cd <项目目录> && pi -p --approve --model <模型> "<任务描述>"
```

默认**保留会话**：会写入项目会话记录，pi 会话选择器可见、可回溯 / 续聊（装了 session-manager 扩展时会自动命名）。

| 参数 | 说明 |
|---|---|
| `-p` | headless：执行完输出最终回复并退出 |
| `--approve` | 信任项目本地配置（AGENTS.md / .pi/） |
| `--model` | 模型，必填（见上） |
| `--no-session` | 可选，不留会话（默认会保存会话） |
| `--no-extensions` | 可选，跳过 pi 扩展加载，更快更干净 |

退出码 0 = 成功；非 0 时错误信息在 stderr。stdout 很长时先重定向到文件再用 `tail -c 4000` 查看，避免刷屏。

## 长任务（预计超过几分钟）

后台运行 + 轮询，避免长时间阻塞：

```bash
cd <项目目录>
nohup pi -p --approve --model <模型> "<任务描述>" \
  > /tmp/pi-task-<标识>.out 2> /tmp/pi-task-<标识>.err &
echo $!   # 记下 PID
```

之后间隔查看：`kill -0 <PID> 2>/dev/null && echo running || echo done`，
`tail -c 2000 /tmp/pi-task-<标识>.out` 看进度；结束后读完整输出文件。
不要在原目录留 .out 文件污染仓库。

## 多轮委派（需要来回交互的任务）

用命名会话实现跨调用续聊（会话按项目目录隔离）：

```bash
SID="pi-deleg-$(date +%s)"
pi -p --session-id "$SID" --approve --model <模型> "第一轮：……"
pi -p --session-id "$SID" --approve --model <模型> "第二轮：基于刚才的改动……"
```

不指定 `--session-id` 时每次调用各自生成新会话；同一 SID 的调用共享上下文（跨调用续聊）。

## 并行派发

相互独立的子任务可同时启动多个 pi 进程（每个必须：独立 prompt、独立输出文件）。并行任务间如需隔离会话，各自指定不同的 `--session-id`。注意：同一目录并行改代码可能冲突，并行任务应分属不同目录或互不重叠的文件集。

## 何时不要委派

- 任务需要与用户多轮澄清 —— 先在本对话问清楚再委派
- 单文件小改动 —— 直接自己做更快
- 任务依赖本对话中的大量上下文且难以转述 —— 缩小范围后委派

## 相关

仓库 `~/pi-extensions/plugins/pi-delegate/` 内含等价能力的 MCP server（`server.mjs`，供不能跑 shell 的 MCP 客户端使用），日常用本 skill 即可。