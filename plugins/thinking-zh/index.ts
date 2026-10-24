/**
 * thinking-zh —— 强制 pi 的思考链用中文
 *
 * 做法是两层：
 *   1. `before_agent_start`：把"思考语言"规则**追加到系统提示末尾**（幂等，不会重复追加）。
 *   2. `context`：每轮请求前把一条简短提醒**追加到最后一条用户消息末尾**——系统提示里写了
 *      但模型仍跟着英文提问用英文思考时，靠这一层拉回来。`context` 拿到的是消息副本，
 *      改动不落盘、不进会话记录、不显示在对话里。
 *
 * 命令：
 *   /think-lang              查看状态
 *   /think-lang on | off     开关
 *   /think-lang reminder on | off   开关每轮提醒
 *
 * 语言 / 回答语言 / 额外规则见 config.ts。
 * 安装见本插件 README.md 与仓库根 README.md。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ANSWER_IN_THINKING_LANGUAGE,
  ENABLED,
  EXTRA_RULES,
  MARKER,
  PER_TURN_REMINDER,
  THINKING_LANGUAGE,
} from "./config";

interface ContentBlock {
  type?: string;
  text?: string;
}

interface NarrowMessage {
  role?: string;
  content?: string | ContentBlock[];
}

/** 追加到系统提示末尾的规则块。 */
function buildSystemBlock(): string {
  const answerRule = ANSWER_IN_THINKING_LANGUAGE
    ? `- 给用户的最终回答也**必须**用${THINKING_LANGUAGE}，不要用其他语言作答。`
    : "- 给用户的最终回答跟随用户消息的语言（用户说中文就中文，说英文就英文）。";

  const lines = [
    `${MARKER} 以下是本会话的语言要求，优先级高于用户消息本身的语言。`,
    "",
    "## 思考语言（强制）",
    "",
    `- 你的思考链——包括 thinking / reasoning 块，以及调用工具前写下的推理文字——**必须**用${THINKING_LANGUAGE}，`,
    "  无论用户用什么语言提问、无论仓库、代码、文档、报错信息是什么语言。",
    "- 思考过程中的代码、命令、文件路径、标识符、日志、引用原文保持原样，**不要翻译**。",
    answerRule,
    ...EXTRA_RULES,
  ];
  return lines.join("\n");
}

/**
 * 每轮追加到用户消息末尾的短提醒。
 *
 * 措辞只绑定 THINKING_LANGUAGE，不写死“英文”：思考跑偏的方向取决于**提问语言**
 * （英文问就英文思考、日文问就日文思考），而且 THINKING_LANGUAGE 本身是可配置的
 * （config.ts 可改成 English/日本語）——写死“不要用英文”在两个场景下都会失效或自相矛盾。
 * 这里改成“无论提问用什么语言”的口径，与系统提示里的表述保持一致。
 */
function buildReminder(): string {
  return `${MARKER} 提醒：思考链必须用${THINKING_LANGUAGE}，无论我这条消息用什么语言（代码/命令/路径保持原文，不要翻译）。`;
}

function containsMarker(content: string | ContentBlock[] | undefined): boolean {
  if (typeof content === "string") return content.includes(MARKER);
  if (Array.isArray(content)) {
    return content.some((block) => typeof block?.text === "string" && block.text.includes(MARKER));
  }
  return false;
}

function withReminder(content: string | ContentBlock[] | undefined, reminder: string): string | ContentBlock[] | undefined {
  if (typeof content === "string") return `${content}\n\n${reminder}`;
  if (Array.isArray(content)) return [...content, { type: "text", text: reminder }];
  return content;
}

export default function thinkingZhExtension(pi: ExtensionAPI) {
  let enabled = ENABLED;
  let perTurnReminder = PER_TURN_REMINDER;

  const systemBlock = buildSystemBlock();
  const reminderText = buildReminder();

  pi.on("before_agent_start", (event) => {
    if (!enabled) return;
    // 幂等：已有标记（例如上一轮注入过、或用户自己写了）就不重复追加
    if (event.systemPrompt.includes(MARKER)) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${systemBlock}` };
  });

  pi.on("context", (event) => {
    if (!enabled || !perTurnReminder) return;

    const messages = event.messages as unknown as NarrowMessage[];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (!message || message.role !== "user") continue;
      if (containsMarker(message.content)) return;
      message.content = withReminder(message.content, reminderText);
      return { messages: messages as never };
    }
    return;
  });

  pi.registerCommand("think-lang", {
    description: "思考链语言（默认强制中文）：status | on | off | reminder on | reminder off",
    handler: async (args, ctx) => {
      const [first = "status", second = ""] = args.trim().split(/\s+/).filter(Boolean);
      const notify = (message: string, type: "info" | "warning" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(message, type);
      };

      if (first === "on") {
        enabled = true;
        notify(`思考链语言：已开启（${THINKING_LANGUAGE}），下一轮请求生效`);
        return;
      }
      if (first === "off") {
        enabled = false;
        notify("思考链语言：已关闭（仅本次进程；想持久化改 config.ts 的 ENABLED）", "warning");
        return;
      }
      if (first === "reminder") {
        if (second === "on") {
          perTurnReminder = true;
          notify("每轮提醒：已开启");
        } else if (second === "off") {
          perTurnReminder = false;
          notify("每轮提醒：已关闭（只靠系统提示约束）", "warning");
        } else {
          notify(`每轮提醒：${perTurnReminder ? "on" : "off"}（用法：/think-lang reminder on|off）`, "warning");
        }
        return;
      }

      notify(
        [
          `思考链语言：${enabled ? `强制 ${THINKING_LANGUAGE}` : "未启用"}`,
          `每轮提醒：${perTurnReminder ? "on" : "off"}`,
          `最终回答：${ANSWER_IN_THINKING_LANGUAGE ? `也用${THINKING_LANGUAGE}` : "跟随用户语言"}`,
          `额外规则：${EXTRA_RULES.length > 0 ? `${EXTRA_RULES.length} 条` : "无"}`,
          "配置：plugins/thinking-zh/config.ts（改完 /reload）",
        ].join("\n"),
      );
    },
  });
}
