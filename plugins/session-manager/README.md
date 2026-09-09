# session-manager

pi 会话管理：自动命名会话 + 上下文占用阈值提醒 `/compact`。

## 能力

### 1. 自动命名会话

每个新会话在第一次 `turn_end` 时，用**首条用户消息**（截断到 40 字）给会话起名，在会话选择器里显示更友好的名称；没有用户消息时用项目名兜底。已有名称（手动设置或历史会话）不会被覆盖。

### 2. 上下文阈值提醒

每次 `turn_end` 检查上下文占用（`ctx.getContextUsage().percent`），达到阈值（默认 70%）时提醒 `/compact`。为避免刷屏，提醒后至少隔 5 次 turn 再提醒。

### 3. `/session-name` 命令

- `/session-name` —— 查看当前会话名
- `/session-name 修复登录401` —— 手动设置会话名

## 安装

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$HOME/pi-extensions/plugins/session-manager" ~/.pi/agent/extensions/session-manager
```

改完 `/reload` 或重启 pi 生效。

## 自定义

编辑 `config.ts`：

- `AUTO_NAME` —— 是否自动命名
- `NAME_MAX_LENGTH` —— 名称最大长度
- `COMPACT_REMIND_PERCENT` —— 上下文占用提醒阈值（%）
- `COMPACT_REMIND_INTERVAL` —— 提醒节流间隔（turn 数）
