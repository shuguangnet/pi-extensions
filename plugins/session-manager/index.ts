/**
 * session-manager —— pi 会话管理
 *
 * 两个能力：
 *   1. 自动命名会话：用首条用户消息（或项目名）给会话起名，
 *      在会话选择器里显示更友好的名称。
 *   2. 上下文阈值提醒：上下文占用达到阈值时提醒 `/compact`，
 *      避免长会话上下文爆掉。
 *
 * 另提供 `/session-name [名称]` 命令手动查看 / 设置会话名。
 *
 * 安装 / 使用见本插件 README.md 与仓库根 README.md。
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import {
  AUTO_NAME,
  NAME_MAX_LENGTH,
  COMPACT_REMIND_PERCENT,
  COMPACT_REMIND_INTERVAL,
} from "./config";

/** 从一条消息里提取纯文本（兼容 string 或 content 数组）。 */
function messageText(message: { content?: unknown }): string {
  const content = message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") return text;
        }
        return "";
      })
      .join(" ")
      .trim();
  }
  return "";
}

/** 取会话里第一条用户消息文本。 */
function firstUserMessage(ctx: ExtensionContext): string {
  const entries = ctx.sessionManager.getEntries();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      const text = messageText(entry.message);
      if (text) return text;
    }
  }
  return "";
}

/** 截断到最大长度。 */
function truncate(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 从 cwd 取项目名（目录 basename）。 */
function projectName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cwd;
}

export default function (pi: ExtensionAPI) {
  // 记录上次提醒 /compact 的 turn 序号，用于节流
  let turnCount = 0;
  let lastRemindTurn = -Infinity;

  pi.on("turn_end", async (_event: TurnEndEvent, ctx: ExtensionContext) => {
    turnCount += 1;

    // ---- 1. 自动命名 ----
    if (AUTO_NAME && !pi.getSessionName()) {
      const first = firstUserMessage(ctx);
      const name = first
        ? truncate(first, NAME_MAX_LENGTH)
        : `${projectName(ctx.cwd)} 会话`;
      pi.setSessionName(name);
    }

    // ---- 2. 上下文阈值提醒 ----
    const usage = ctx.getContextUsage();
    const percent = usage?.percent;
    if (percent === null || percent === undefined) return;

    if (percent >= COMPACT_REMIND_PERCENT) {
      if (turnCount - lastRemindTurn < COMPACT_REMIND_INTERVAL) return;
      lastRemindTurn = turnCount;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `上下文已用 ${Math.round(percent)}%，建议 /compact 压缩`,
          "warning",
        );
      }
    }
  });

  // ---- 手动查看 / 设置会话名 ----
  pi.registerCommand("session-name", {
    description: "查看或设置会话名（用法：/session-name [名称]）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const name = args.trim();
      if (name) {
        pi.setSessionName(name);
        ctx.ui.notify(`会话已命名：${name}`, "info");
      } else {
        const current = pi.getSessionName();
        ctx.ui.notify(current ? `当前会话：${current}` : "尚未设置会话名", "info");
      }
    },
  });
}
