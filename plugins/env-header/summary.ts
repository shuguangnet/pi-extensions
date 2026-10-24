/**
 * env-header 会话概述：
 *   - collectStats / heuristicSummary：零成本本地摘要（始终可用）
 *   - llmSummary：调用模型生成一句话概述（节流、可关）
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Lang } from "./config";
import { singleLine, t } from "./text";

/** 只取我们关心的字段，避免绑定内部 entry 类型。 */
interface NarrowEntry {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    toolName?: string;
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

export interface SessionStats {
  /** 消息条目总数（含 user / assistant / toolResult）。 */
  messages: number;
  userTurns: number;
  assistantTurns: number;
  toolCalls: number;
  /** 被读写的文件路径（去重）。 */
  files: string[];
  firstPrompt: string;
  lastPrompt: string;
  startedAt?: number;
}

function toEntries(branch: unknown): NarrowEntry[] {
  return Array.isArray(branch) ? (branch as NarrowEntry[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function toolCallNames(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const block = part as ContentBlock;
    if (block.type === "toolCall" && typeof block.name === "string") names.push(block.name);
  }
  return names;
}

const FILE_ARG_KEYS = ["path", "filePath", "file", "paths", "files", "notebookPath"];

function filePathsFromArguments(args: unknown): string[] {
  if (!args || typeof args !== "object") return [];
  const record = args as Record<string, unknown>;
  const found: string[] = [];
  for (const key of FILE_ARG_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) found.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.trim().length > 0) found.push(item.trim());
      }
    }
  }
  return found;
}

export function collectStats(branch: unknown): SessionStats {
  const entries = toEntries(branch);
  const files = new Set<string>();
  const prompts: string[] = [];
  let messages = 0;
  let assistantTurns = 0;
  let toolCalls = 0;

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    messages += 1;
    const role = entry.message.role;

    if (role === "user") {
      const text = textOf(entry.message.content);
      if (text) prompts.push(singleLine(text));
      continue;
    }
    if (role === "assistant") {
      assistantTurns += 1;
      for (const part of Array.isArray(entry.message.content) ? (entry.message.content as ContentBlock[]) : []) {
        if (part?.type !== "toolCall") continue;
        toolCalls += 1;
        for (const path of filePathsFromArguments(part.arguments)) files.add(path);
      }
      continue;
    }
    if (role === "toolResult" && typeof entry.message.toolName === "string") {
      // toolResult 无 path，仅计数在 assistant 侧完成；这里保留分支以便将来扩展。
      continue;
    }
  }

  const firstTimestamp = entries.find((entry) => entry.type === "message" && entry.timestamp)?.timestamp;

  return {
    messages,
    userTurns: prompts.length,
    assistantTurns,
    toolCalls,
    files: [...files],
    firstPrompt: prompts[0] ?? "",
    lastPrompt: prompts.length > 1 ? (prompts[prompts.length - 1] ?? "") : "",
    startedAt: firstTimestamp ? Date.parse(firstTimestamp) : undefined,
  };
}

function clip(text: string, max: number): string {
  const flat = singleLine(text);
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(1, max - 1))}…`;
}

/** 零成本摘要：轮次 / 文件数 / 起于 & 最近在做什么。 */
export function heuristicSummary(stats: SessionStats, lang: Lang): string {
  if (stats.userTurns === 0 && stats.assistantTurns === 0) return t(lang, "summaryNone");

  const parts: string[] = [`${stats.userTurns} ${t(lang, "turns")}`];
  if (stats.files.length > 0) parts.push(`${stats.files.length} ${t(lang, "files")}`);
  if (stats.firstPrompt) parts.push(`${t(lang, "startsWith")}「${clip(stats.firstPrompt, 32)}」`);
  if (stats.lastPrompt && stats.lastPrompt !== stats.firstPrompt) {
    parts.push(`${t(lang, "recently")}「${clip(stats.lastPrompt, 32)}」`);
  }
  return parts.join(" · ");
}

/** 把会话压成给模型看的纯文本（含工具调用名），超长时保留头尾。 */
export function conversationDigest(branch: unknown, maxChars: number): string {
  const entries = toEntries(branch);
  const lines: string[] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const role = entry.message.role;

    if (role === "user" || role === "assistant") {
      const label = role === "user" ? "User" : "Assistant";
      const text = clip(textOf(entry.message.content), role === "user" ? 400 : 600);
      if (text) lines.push(`${label}: ${text}`);
      if (role === "assistant") {
        const tools = toolCallNames(entry.message.content);
        if (tools.length > 0) lines.push(`  (tools: ${[...new Set(tools)].join(", ")})`);
      }
    } else if (role === "compactionSummary") {
      const summary = textOf(entry.message.content);
      if (summary) lines.push(`[compacted summary] ${clip(summary, 600)}`);
    }
  }

  const text = lines.join("\n");
  if (text.length <= maxChars) return text;

  const headSize = Math.floor(maxChars * 0.35);
  const tailSize = maxChars - headSize - 20;
  return `${text.slice(0, headSize)}\n…(中间省略)…\n${text.slice(text.length - tailSize)}`;
}

export function buildSummaryPrompt(lang: Lang, digest: string, maxLength: number): string {
  if (lang === "en") {
    return [
      "Below is a record of a coding session.",
      `Summarize in ONE sentence (max ${maxLength} characters): what this session is working on, how far it got, and what is next.`,
      "Output only that sentence. No prefix, no quotes, no markdown, no line breaks.",
      "",
      "<session>",
      digest,
      "</session>",
    ].join("\n");
  }
  return [
    "下面是一段编码会话记录。",
    `请用一句中文概括（不超过 ${maxLength} 字）：这次会话在做什么、进展到哪一步、下一步要做什么。`,
    "只输出这句话本身，不要前缀、不要引号、不要 Markdown、不要换行。",
    "",
    "<会话记录>",
    digest,
    "</会话记录>",
  ].join("\n");
}

/** 清理模型输出：单行化、去掉前缀与引号、限长。 */
export function cleanupSummary(raw: string, maxLength: number): string {
  let text = singleLine(raw);
  text = text.replace(/^(概述|摘要|总结|会话概述|session summary|summary)\s*[:：\-—]\s*/i, "");
  text = text.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
  if (text.length > maxLength) text = `${text.slice(0, Math.max(1, maxLength - 1))}…`;
  return text;
}

type ModelLike = { provider?: string; id?: string };

function hasAuth(registry: ExtensionContext["modelRegistry"], model: unknown): boolean {
  try {
    return registry.hasConfiguredAuth(model as never);
  } catch {
    return false;
  }
}

/** 按 "provider/id" / "id" / null(当前模型) 解析概述用模型。 */
export function resolveSummaryModel(ctx: ExtensionContext, spec: string | null): ModelLike | undefined {
  const registry = ctx.modelRegistry;
  if (spec && spec.trim().length > 0) {
    const query = spec.trim();
    const slash = query.indexOf("/");
    if (slash > 0) {
      const provider = query.slice(0, slash);
      const id = query.slice(slash + 1);
      const exact = registry.find(provider, id);
      if (exact && hasAuth(registry, exact)) return exact as ModelLike;
      return undefined;
    }
    const available = registry.getAvailable() as ModelLike[];
    const byId = available.find((model) => model.id === query);
    if (byId) return byId;
    const fuzzy = available.find((model) => (model.id ?? "").toLowerCase().includes(query.toLowerCase()));
    return fuzzy;
  }

  const current = ctx.model;
  if (current && hasAuth(registry, current)) return current as ModelLike;
  return undefined;
}

interface CompleteLike {
  content?: ContentBlock[];
}

/**
 * 调模型生成概述。
 *
 * 这里刻意用一次 cast：`ModelRegistry.complete` 的第三参是按 provider API
 * 分派的联合类型（AnthropicOptions | OpenAICompletionsOptions | ...），
 * 插件侧只需要跨 provider 都存在的 `cacheRetention` / `signal`。
 * 超时与取消都通过 signal 注入。
 */
export async function llmSummary(
  ctx: ExtensionContext,
  model: ModelLike,
  prompt: string,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<string | undefined> {
  type CompleteFn = (
    model: unknown,
    context: unknown,
    options?: unknown,
  ) => Promise<CompleteLike>;

  const complete = ctx.modelRegistry.complete.bind(ctx.modelRegistry) as unknown as CompleteFn;

  const timeout = AbortSignal.timeout(Math.max(1000, options.timeoutMs));
  const signal = options.signal && typeof AbortSignal.any === "function"
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { cacheRetention: "none", signal },
  );

  const blocks = Array.isArray(response?.content) ? response.content : [];
  const text = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join(" ")
    .trim();

  return text.length > 0 ? text : undefined;
}
