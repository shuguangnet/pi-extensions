# statusline

Claude Code 风格的底部状态栏，替换 pi 默认那两行「全灰、信息挤在一起」的 footer。

## 前后对比

pi 原生 footer（全部 `dim` 暗灰，目录/分支/模型一个待遇）：

```
~/gym-iam-runtime (feature/develop) • 参考其他权限，为组装单…
↑390k ↓144k R28M 28.4%/1.0M (auto)
```

本插件（分段、着色、带上下文进度条，Claude Code 风格）：

```
📁 ~/gym-iam-runtime  ⎇ feature/develop │ 参考其他权限，为组装单…
███░░░░░░░ 28.4%/1.0M (auto) │ ↑390k ↓144k R28.0M W1.2M CH94.2% │ $0.423 │ deepseek-v4.1-flash · high
🛰 1 跑中
```

- 第一行：目录（强调色加粗）· git 分支（绿）· 会话名（muted，放不下自动省略）
- 第二行：上下文进度条（**<70% 绿 / 70~90% 黄 / >90% 红**）+ 百分比 + 窗口 · token 明细 · 花费 · 模型 + 思考等级
- 第三行：其它扩展 `ctx.ui.setStatus()` 的内容照旧展示（例如 workspace-switcher 的 🛰、queue-highlight 的 qh:off）
- 终端变窄时按重要性逐级降级（先丢 CH/W → token 段 → 花费 → 进度条 → 模型），不是粗暴截断

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/statusline" ~/.pi/agent/extensions/statusline
```

`/reload` 生效（不用重启 pi）。

## 使用

| 命令 | 说明 |
|---|---|
| `/sl` | 查看当前状态与各段开关 |
| `/sl on` / `/sl off` | 接管 / 交还 pi 原生 footer |
| `/sl bar on\|off` | 上下文进度条 |
| `/sl tokens on\|off` | ↑↓RWCH token 明细 |
| `/sl cost on\|off` | 累计花费 |
| `/sl name on\|off` | 第一行的会话名 |
| `/sl thinking on\|off` | 模型名后的思考等级 |
| `/sl auto on\|off` | `(auto)` 自动压缩标记 |

`/sl` 调的开关在当前进程内有效（切换会话、`/reload` 都保持）；想改默认值就改 `config.ts`。

## 自定义（`config.ts`）

| 配置 | 默认 | 说明 |
|---|---|---|
| `ENABLED` | `true` | 启动时是否接管 |
| `BAR_WIDTH` | `10` | 进度条格数 |
| `SHOW_*` | 基本全开 | 各分段默认显隐 |
| `SEPARATOR` | `│` | 分段分隔符 |
| `WARN_PERCENT` / `DANGER_PERCENT` | 70 / 90 | 上下文占用变色阈值 |
| `COLORS` | 见文件 | 各段颜色（主题语义色名） |

## 渲染自检（脱离 TUI）

```bash
node plugins/statusline/tools/render-check.mjs
```

用真实主题跑不同终端宽度的排版、降级路径和阈值变色，不依赖交互式会话。

## 原理与已知边界

- 通过官方的 `ctx.ui.setFooter((tui, theme, footerData) => ({ render(width) }))` 接管 footer，属于公开扩展点，不打补丁。
- git 分支和扩展 statuses 来自 `footerData`（`getGitBranch()` / `getExtensionStatuses()`）；token / 上下文 / 模型来自 `ctx`。
- `(auto)` 标记读全局 settings 的 `compaction.enabled`（60 秒缓存；项目级覆盖不感知，以全局为准）。
- 每次会话启动（含切换会话、`/reload`）都会用最新 ctx 重建 footer 组件，避免 stale ctx；渲染期取数据失败时静默返回空行，不阻断 TUI。
- pi-tui 的 `visibleWidth` / `truncateToWidth` 负责 ANSI 与宽字符（中文会话名、emoji）的宽度计算。
- 已知取舍：模型名左对齐（Claude Code 风格），不做原生 footer 的右对齐填充；`(provider)` 前缀仅在可用模型来自多个 provider 时显示，与原生行为一致。
