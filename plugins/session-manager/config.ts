/**
 * 会话管理配置
 *
 * 改完 `/reload` 或重启 pi 生效。
 */

/** 是否自动命名会话（用首条用户消息 / 项目名）。 */
export const AUTO_NAME = true;

/** 自动命名时名称最大长度（超出截断）。 */
export const NAME_MAX_LENGTH = 40;

/** 上下文占用达到该百分比时提醒 /compact。 */
export const COMPACT_REMIND_PERCENT = 70;

/** 提醒后至少隔多少次 turn 再提醒，避免刷屏。 */
export const COMPACT_REMIND_INTERVAL = 5;
