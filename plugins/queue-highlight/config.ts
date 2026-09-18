/**
 * queue-highlight 配置
 *
 * 改完 `/reload` 生效（不用重启 pi）。
 * 运行时也能改：`/qh steering warning`、`/qh follow accent`、`/qh bold off`。
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

/** steering（Enter 排队）行的颜色。默认 `error`（红）。 */
export const STEERING_COLOR: ThemeColor = "error";

/** follow-up（Alt+Enter 排队）行的颜色。默认 `success`（绿）。 */
export const FOLLOW_UP_COLOR: ThemeColor = "success";

/** 是否加粗，让排队提示更抢眼。 */
export const BOLD = true;

/** 启动时是否启用。临时的 `/qh off` 只影响当前进程。 */
export const ENABLED = true;

/** 命中前缀（正常文本不动）。改成更宽松的正则可以在 pi 改文案后继续生效。 */
export const STEERING_PATTERN = /^Steering[:(]/;
export const FOLLOW_UP_PATTERN = /^Follow-?up[:(]/i;
