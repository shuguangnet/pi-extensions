# thinking-zh

强制 pi 的**思考链**（thinking / reasoning 块 + 调工具前的推理文字）用中文输出，**不管用户用什么语言提问**。

真实效果（用英文提问，`pi --mode json -p` 抓到的 thinking 原文）：

```
问: Explain in exactly one sentence why the sky is blue. Then stop.

思考: 用户要求用一句话解释天空为什么是蓝色，然后停止。语言要求：思考用中文。
      最终回答跟随用户消息语言，用户消息是中文夹英文？"Explain in exactly one sentence
      why the sky is blue. Then stop." 是英文。…回答应该用英文吧。

回答: (英文 —— 因为默认 ANSWER_IN_THINKING_LANGUAGE = false，回答跟随用户)
```

## 为什么是两层

只写系统提示经常不管用：模型会跟着**提问语言**思考。所以这里做了两层：

1. **系统提示**（`before_agent_start`）：把一段"思考语言"规则追加到系统提示末尾（幂等，带 `[pi-thinking-language]` 标记，不会重复追加）。
2. **每轮提醒**（`context`）：每次请求发给模型前，在**最后一条用户消息末尾**追加一句短提醒，把"跟着提问语言思考"的惯性拉回来。

第 2 层只改**发给模型的副本**——`context` 事件拿到的是消息深拷贝，所以：
- 不落盘（会话 JSONL 里搜不到 `[pi-thinking-language]`）
- 不显示在对话里
- 不改动会话记录/树

## 命令

| 命令 | 作用 |
|---|---|
| `/think-lang` | 查看状态（语言 / 每轮提醒 / 回答语言 / 配置位置） |
| `/think-lang on` \| `off` | 开关（本次进程，下一轮请求生效） |
| `/think-lang reminder on` \| `off` | 只开关每轮提醒，保留系统提示约束 |

## 配置

直接改 [`config.ts`](./config.ts)（改完 `/reload`）：

| 常量 | 默认 | 说明 |
|---|---|---|
| `ENABLED` | `true` | 总开关 |
| `THINKING_LANGUAGE` | `"简体中文"` | 思考链语言，可改成 `"English"` / `"日本語"` 等 |
| `ANSWER_IN_THINKING_LANGUAGE` | `false` | `false` = 最终回答跟随用户语言，只强制思考链；`true` = 回答也用该语言 |
| `PER_TURN_REMINDER` | `true` | 是否做第 2 层（每轮提醒） |
| `EXTRA_RULES` | `[]` | 追加到规则块里的额外要求，例如 `"- 思考不要复述我的问题，直接分析。"` |

## 边界

- 能约束的是模型**写出来的**思考内容。某些 provider 的隐藏 CoT（内部推理）无法改写，但 pi 显示、可读的那部分 thinking 会跟随。
- 思考里的**代码、命令、文件路径、标识符、日志、引用原文保持原样**，不翻译（否则会降低推理质量）。
- 不产生任何网络请求，纯提示词注入。
- 与 `~/.pi/agent/APPEND_SYSTEM.md` 的区别：那只是静态追加文本，没有"每轮提醒"和运行时开关；两者可以共存（有 `[pi-thinking-language]` 幂等标记，不会重复注入）。

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/thinking-zh" ~/.pi/agent/extensions/thinking-zh
```

在 pi 里 `/reload`，或重启 pi。之后 `/think-lang` 看状态。

> 只对交互式会话生效；`pi config` 之类的管理命令不跑 agent，自然也无所谓。

## 验证方式

1. mock 掉 `ExtensionAPI`：验证系统提示追加/幂等、`context` 对 string 与 content 数组（含图片）两种消息的追加、无 user 消息时不动作、`/think-lang off` / `reminder off` 的即时生效。
2. 真跑 `pi --mode json -p`：英文提问 → thinking 为中文（见上面例子）；带工具的一轮（read `/etc/hosts`）确认工具循环不受影响。
3. 真跑带 `--session-dir` 的会话，grep 会话 JSONL：`[pi-thinking-language]` 不存在 → 确认提醒不落盘。
