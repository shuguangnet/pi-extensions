/**
 * 脏仓库守卫配置
 *
 * 控制哪些会话操作前要检查"当前 git 仓库是否有未提交改动"。
 * 改完 `/reload` 或重启 pi 生效。
 */

/** 切换 / 新建会话前检查（防止误清空丢工作）。 */
export const GUARD_SWITCH = true;

/** fork 会话前检查。 */
export const GUARD_FORK = true;

/** 压缩会话前检查（默认关：压缩只是摘要，不丢工作）。 */
export const GUARD_COMPACT = false;

/** 无交互界面（headless / CI）时，检测到脏仓库是否默认阻止。 */
export const BLOCK_HEADLESS = true;
