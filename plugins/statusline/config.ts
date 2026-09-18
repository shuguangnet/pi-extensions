/**
 * statusline 配置
 *
 * 改完 `/reload` 生效（不用重启 pi）。运行时也能用 `/sl ...` 临时切换。
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** 启动时是否接管底部状态栏。 */
export const ENABLED = true;

/** 进度条格数（Claude Code 风格的分段进度条）。 */
export const BAR_WIDTH = 10;

/** 是否显示上下文进度条（关掉则只显示 `28.4%/1.0M`）。 */
export const SHOW_BAR = true;

/** 是否显示 token 明细（↑输入 ↓输出 R缓存读 W缓存写 CH命中率）。 */
export const SHOW_TOKENS = true;

/** 是否显示累计花费。 */
export const SHOW_COST = true;

/** 是否显示会话名（第一行末尾）。 */
export const SHOW_SESSION_NAME = true;

/** 是否显示思考等级（跟在模型名后面）。 */
export const SHOW_THINKING = true;

/** 是否显示自动压缩标记 `(auto)`（读全局 settings 的 compaction.enabled）。 */
export const SHOW_AUTO_COMPACT = true;

/** 分段分隔符。 */
export const SEPARATOR = "│";

/** 上下文占用达到该百分比后转黄色。 */
export const WARN_PERCENT = 70;

/** 上下文占用达到该百分比后转红色。 */
export const DANGER_PERCENT = 90;

/** 进度条填充 / 空槽字符。 */
export const BAR_FILLED = "█";
export const BAR_EMPTY = "░";

/** 各段的颜色。 */
export const COLORS: Record<"cwd" | "branch" | "model" | "cost" | "tokens" | "session" | "ok" | "warn" | "danger", ThemeColor> = {
  cwd: "accent",
  branch: "success",
  model: "accent",
  cost: "warning",
  tokens: "dim",
  session: "muted",
  ok: "success",
  warn: "warning",
  danger: "error",
};
