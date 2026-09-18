# queue-highlight

让 pi 的「排队中」提示一眼可见：**steering 红、follow-up 绿**，并加粗。

## 背景

pi 在输入框上方显示还没投递出去的消息，默认两行都是同一个暗灰色（主题的 `dim`，dark 主题下是 `#666`）：

```
Steering: 改一下这段逻辑        ← Enter 发送：等当前工具跑完就投递
Follow-up: 顺便补个测试          ← Alt+Enter 发送：等 agent 完全停下才投递
↳ alt+e to edit all queued messages
```

排队消息一多、或者 agent 正在跑长任务时，这两行很容易被看漏，而且光看暗灰分不清哪条是 steering、哪条是 follow-up。

## 效果

| 行 | 颜色 | 样式 |
|---|---|---|
| `Steering: …` | 红（`error`） | 加粗 |
| `Follow-up: …` | 绿（`success`） | 加粗 |
| 其它任何文本 | 不变 | 不变 |

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/queue-highlight" ~/.pi/agent/extensions/queue-highlight
```

`/reload` 生效（不用重启 pi）。

## 使用

| 命令 | 说明 |
|---|---|
| `/qh` | 查看状态：开关、颜色、加粗、累计命中行数 |
| `/qh test` | 自检：确认补丁在当前进程内真的生效 |
| `/qh on` / `/qh off` | 临时开关（只影响当前进程） |
| `/qh bold on` / `/qh bold off` | 加粗开关 |
| `/qh steering warning` | 改 steering 颜色（颜色名必须是当前主题里存在的 key） |
| `/qh follow accent` | 改 follow-up 颜色 |

**怎么确认真的生效：** 让 agent 跑一个稍长的任务，然后打一句话按 **Enter**（不按 Alt），输入框上方会出现红色的 `Steering: …` 行；再按 **Alt+Enter** 发一条，会出现绿色的 `Follow-up: …` 行。之后 `/qh` 能看到累计命中行数 > 0。

## 自定义（`config.ts`）

| 配置 | 默认 | 说明 |
|---|---|---|
| `STEERING_COLOR` | `error` | steering 行颜色（红） |
| `FOLLOW_UP_COLOR` | `success` | follow-up 行颜色（绿） |
| `BOLD` | `true` | 是否加粗 |
| `ENABLED` | `true` | 启动时是否启用 |
| `STEERING_PATTERN` / `FOLLOW_UP_PATTERN` | `/^Steering[:(]/`、`/^Follow-?up[:(]/i` | 命中前缀，pi 改文案后改这里即可 |

改完 `/reload` 即可生效，无需重启。

## 原理与已知边界

pi 目前没有「排队区渲染」的扩展点 —— 内置实现是硬编码的一行：

```js
this.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `Steering: ${message}`), 1, 0));
```

所以本插件用补丁方式挂 `Theme.prototype.fg`：只对这两个固定前缀换成目标颜色 + 加粗，**其它任何文本原样走原逻辑**，影响面被限制在最小范围。

已知边界：

- 补丁幂等：`/reload` 或切换会话都会重建扩展模块，但不会重复打补丁；配置存在 `globalThis`，所以改 `config.ts` 后 `/reload` 立即生效。
- 目标颜色在当前主题里不存在时会自动退回原来的颜色，不会让 TUI 崩掉。
- 加粗走 pi 自己的 chalk：在无颜色终端（`NO_COLOR`、非 TTY）下加粗会自动不生效，颜色仍然生效。
- 属于补丁式实现。pi 若改了队列渲染的文案或彻底移除了 `theme.fg("dim", …)` 这条路，需要更新 `config.ts` 里的两个正则，或等官方开放队列渲染扩展点。
- 想彻底卸载：删掉软链并重启 pi（补丁只存在于内存，不会改 pi 的安装文件）。
