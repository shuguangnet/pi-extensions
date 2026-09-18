/**
 * statusline —— Claude Code 风格的底部状态栏
 *
 * 把 pi 默认那两行「全灰、信息挤在一起」的 footer 换成 Claude Code 那种分段式状态栏：
 *
 *     📁 ~/gym-iam-runtime  ⎇ feature/develop  │ 参考其他权限，为组装单…
 *     ▓▓▓░░░░░░░ 28.4%/1.0M (auto)  │ ↑390k ↓144k R28M W1k CH94.0%  │ $0.42  │ deepseek-v4.1-flash · high
 *     🛰 1 跑中
 *
 * 与内置 footer 相比：
 *   - 目录 / 分支 / 模型不再是同一档暗灰，关键信息有颜色
 *   - 上下文占用用分段进度条 + 阈值变色（70% 黄、90% 红）
 *   - 分段之间有分隔符，token 明细 / 花费 / 模型一眼能分开
 *   - 终端变窄时按重要性逐级降级，而不是粗暴截断
 *   - 其它扩展 `ctx.ui.setStatus()` 的内容照旧展示在第三行
 *
 * 命令：
 *   /sl                     查看状态栏配置
 *   /sl on | off            接管 / 交还给 pi 原生 footer
 *   /sl bar|tokens|cost|name|thinking|auto on|off   分段开关
 *
 * 安装 / 自定义见本插件 README.md 与仓库根 README.md。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
} from "@earendil-works/pi-coding-agent";

import { ENABLED } from "./config";
import {
  DEFAULT_OPTIONS,
  renderStatusline,
  type StatuslineData,
  type StatuslineOptions,
  type StatuslineUsage,
} from "./render";

const STATE_KEY = Symbol.for("pi-statusline/state");
/** 自动压缩配置的缓存时长（settings.json 不需要每次渲染都读）。 */
const SETTINGS_CACHE_MS = 60_000;

interface StatuslineState {
  enabled: boolean;
  options: StatuslineOptions;
}

/**
 * 运行态放 globalThis：`/reload` 与切换会话都会重建扩展模块，
 * 但用户通过 `/sl` 调过的开关应该继续有效。
 */
function state(): StatuslineState {
  const store = globalThis as unknown as Record<symbol, StatuslineState | undefined>;
  let current = store[STATE_KEY];
  if (!current) {
    current = { enabled: ENABLED, options: { ...DEFAULT_OPTIONS, colors: { ...DEFAULT_OPTIONS.colors } } };
    store[STATE_KEY] = current;
  }
  return current;
}

/** 汇总整个会话的 token / 花费，并记录最近一次请求的缓存命中率。 */
function aggregateUsage(ctx: ExtensionContext): StatuslineUsage {
  const totals: StatuslineUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as AssistantMessage;
      const usage = message.usage;
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.cost += usage.cost?.total ?? 0;
      const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
      if (promptTokens > 0) totals.cacheHitRate = (usage.cacheRead / promptTokens) * 100;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      const usage = entry.message.usage;
      totals.cost += usage.cost?.total ?? 0;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      totals.cost += entry.usage.cost?.total ?? 0;
    }
  }
  return totals;
}

let cachedAutoCompact: { at: number; value: boolean } | undefined;

/** 自动压缩是否开启（读全局 settings 的 compaction.enabled，默认开）。 */
function readAutoCompact(): boolean {
  const now = Date.now();
  if (cachedAutoCompact && now - cachedAutoCompact.at < SETTINGS_CACHE_MS) {
    return cachedAutoCompact.value;
  }
  let value = true;
  try {
    const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
    const parsed = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as {
      compaction?: { enabled?: unknown };
    };
    if (typeof parsed?.compaction?.enabled === "boolean") value = parsed.compaction.enabled;
  } catch {
    // 读不到就按默认值处理，不影响渲染
  }
  cachedAutoCompact = { at: now, value };
  return value;
}

/** 从当前上下文取出渲染需要的全部数据。 */
function collectData(ctx: ExtensionContext, footerData: ReadonlyFooterDataProvider): StatuslineData {
  const contextUsage = ctx.getContextUsage();
  const model = ctx.model as { id?: string; provider?: string; reasoning?: boolean } | undefined;
  return {
    cwd: ctx.sessionManager.getCwd(),
    home: process.env.HOME || process.env.USERPROFILE,
    branch: footerData.getGitBranch(),
    sessionName: ctx.sessionManager.getSessionName(),
    modelId: model?.id,
    provider: model?.provider,
    providerCount: footerData.getAvailableProviderCount(),
    thinkingLevel: ctx.thinkingLevel,
    reasoning: model?.reasoning,
    usage: aggregateUsage(ctx),
    context: contextUsage
      ? { percent: contextUsage.percent, contextWindow: contextUsage.contextWindow }
      : undefined,
    autoCompact: readAutoCompact(),
    statuses: [...footerData.getExtensionStatuses().values()],
  };
}

/** 接管 footer：每次重新调用都会用传入的 ctx 重建组件（切会话后必须重来一次）。 */
function installFooter(ctx: ExtensionContext): void {
  ctx.ui.setFooter((tui, theme: Theme, footerData) => {
    const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    return {
      dispose: unsubscribe,
      invalidate() {},
      render(width: number): string[] {
        try {
          return renderStatusline(collectData(ctx, footerData), theme, width, state().options);
        } catch {
          // 会话替换的瞬间可能拿到失效的 ctx，宁可少画一行也不要打断渲染
          return [];
        }
      },
    };
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (state().enabled) installFooter(ctx);
  });

  pi.registerCommand("sl", {
    description: "Claude Code 风格状态栏：/sl [on|off|bar|tokens|cost|name|thinking|auto on|off]",
    handler: async (args, ctx) => {
      const current = state();
      const [action, value] = args.trim().split(/\s+/, 2);
      const verb = (action ?? "").toLowerCase();
      const next = (value ?? "").toLowerCase();

      const toggles: Record<string, keyof StatuslineOptions> = {
        bar: "showBar",
        tokens: "showTokens",
        cost: "showCost",
        name: "showSessionName",
        thinking: "showThinking",
        auto: "showAutoCompact",
      };

      if (!verb) {
        const o = current.options;
        ctx.ui.notify(
          [
            `状态栏：${current.enabled ? "已接管（Claude 风格）" : "已交还 pi 原生 footer"}`,
            `进度条 ${o.showBar ? "开" : "关"}｜token 明细 ${o.showTokens ? "开" : "关"}｜花费 ${o.showCost ? "开" : "关"}`,
            `会话名 ${o.showSessionName ? "开" : "关"}｜思考等级 ${o.showThinking ? "开" : "关"}｜(auto) ${o.showAutoCompact ? "开" : "关"}`,
            "用法：/sl on|off，或 /sl bar|tokens|cost|name|thinking|auto on|off",
          ].join("\n"),
          "info",
        );
        return;
      }

      if (verb === "on") {
        current.enabled = true;
        installFooter(ctx);
        ctx.ui.notify("已接管底部状态栏（Claude 风格）", "info");
        return;
      }

      if (verb === "off") {
        current.enabled = false;
        ctx.ui.setFooter(undefined);
        ctx.ui.notify("已交还 pi 原生 footer，再次 /sl on 可切回", "info");
        return;
      }

      const key = toggles[verb];
      if (key) {
        if (next !== "on" && next !== "off") {
          ctx.ui.notify(`用法：/sl ${verb} on|off`, "warning");
          return;
        }
        const enabled = next === "on";
        (current.options[key] as boolean) = enabled;
        installFooter(ctx);
        ctx.ui.notify(`${verb} 已${enabled ? "开启" : "关闭"}`, "info");
        return;
      }

      ctx.ui.notify("用法：/sl [on|off|bar|tokens|cost|name|thinking|auto on|off]", "warning");
    },
  });
}
