/**
 * workspace-switcher 配置
 *
 * 改完 `/reload` 或重启 pi 生效。所有项都可以用环境变量覆盖，见下方注释。
 */

/**
 * 后台任务使用的 pi 可执行文件。
 * 默认 `pi`（走 PATH）；也可用环境变量 PI_WS_PI_BINARY 覆盖。
 */
export const PI_BINARY = process.env.PI_WS_PI_BINARY || "pi";

/** 后台任务并发上限（超过后拒绝新任务）。环境变量 PI_WS_MAX_JOBS。 */
export const MAX_JOBS = Number(process.env.PI_WS_MAX_JOBS || 4);

/** pi 退出（/quit、Ctrl+D）时终止后台任务（在 index.ts 的 session_shutdown 里执行）。 */

/** 后台任务是否继承当前会话的模型（推荐开启，保持体验一致）。 */
export const INHERIT_MODEL = true;

/**
 * 后台任务遇到需要交互的弹窗（例如项目信任确认）时，是否自动同意。
 * 默认 false：一律取消，pi 走默认策略（通常不加载该项目本地扩展），不阻塞后台任务。
 * 只影响后台子进程，不会影响主会话。
 */
export const AUTO_APPROVE_DIALOGS = process.env.PI_WS_AUTO_APPROVE === "1";

/** 传给后台 pi 的额外参数。例如 ["--thinking", "high"]。 */
export const EXTRA_PI_ARGS: string[] = [];

/** 目录列表最多展示多少项（按最近活动排序）。 */
export const MAX_DIRS = 25;

/** 单个目录下最多展示多少条会话。 */
export const MAX_SESSIONS_PER_DIR = 25;

/** 目录/会话列表缓存时长（毫秒），避免每次打开面板都全量扫描。 */
export const LIST_CACHE_MS = 20_000;

/** 后台任务保留的输出预览字符数。 */
export const PREVIEW_CHARS = 2000;
