/**
 * thinking-zh 配置
 *
 * 改完 `/reload` 或重启 pi 生效。
 */

/** 总开关。 */
export const ENABLED = true;

/** 思考链（thinking / reasoning）要用的语言。 */
export const THINKING_LANGUAGE = "简体中文";

/**
 * 最终回答用什么语言：
 *   false（默认）= 跟随用户消息的语言，只强制"思考链"用上面的语言
 *   true         = 回答也用 THINKING_LANGUAGE
 */
export const ANSWER_IN_THINKING_LANGUAGE = false;

/**
 * 是否在每轮请求前，把一条提醒追加到最后一条用户消息末尾。
 *
 * 只影响发给模型的内容（`context` 事件拿到的是副本，**不落盘、不显示**），
 * 用来解决"系统提示里写了但模型还是跟着英文提问用英文思考"的问题。
 */
export const PER_TURN_REMINDER = true;

/** 追加到系统提示里的额外规则（每条一行）。 */
export const EXTRA_RULES: string[] = [];

/** 幂等标记：系统提示 / 用户消息里已经带了这个标记就不再重复注入。 */
export const MARKER = "[pi-thinking-language]";
