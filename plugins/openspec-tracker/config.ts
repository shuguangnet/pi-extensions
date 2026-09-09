/**
 * OpenSpec 变更状态提醒配置
 *
 * 改完 `/reload` 或重启 pi 生效。
 */

/** OpenSpec 目录名（相对项目根）。 */
export const OPENSPEC_DIR = "openspec";

/** 变更目录名。 */
export const CHANGES_DIR = "changes";

/** 任务文件（全部勾选 = 已实现）。 */
export const TASKS_FILE = "tasks.md";

/** 在哪些 session_start 场景下提醒（startup/new/resume/fork/reload）。 */
export const REMIND_ON: string[] = ["startup", "new"];
