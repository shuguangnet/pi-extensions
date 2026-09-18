/**
 * statusline —— 纯渲染层
 *
 * 输入是已经从 pi 取好的数据 + 生效的选项，输出若干行字符串（不含换行符）。
 * 拆成纯函数是为了能脱离 TUI 直接跑测试（`node tools/render-check.mjs`）。
 */

import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import {
  BAR_EMPTY,
  BAR_FILLED,
  BAR_WIDTH,
  COLORS,
  DANGER_PERCENT,
  SEPARATOR,
  SHOW_AUTO_COMPACT,
  SHOW_BAR,
  SHOW_COST,
  SHOW_SESSION_NAME,
  SHOW_THINKING,
  SHOW_TOKENS,
  WARN_PERCENT,
} from "./config";

/** 运行时可覆盖的展示选项（默认值来自 config.ts）。 */
export interface StatuslineOptions {
  barWidth: number;
  showBar: boolean;
  showTokens: boolean;
  showCost: boolean;
  showSessionName: boolean;
  showThinking: boolean;
  showAutoCompact: boolean;
  separator: string;
  warnPercent: number;
  dangerPercent: number;
  colors: typeof COLORS;
}

export const DEFAULT_OPTIONS: StatuslineOptions = {
  barWidth: BAR_WIDTH,
  showBar: SHOW_BAR,
  showTokens: SHOW_TOKENS,
  showCost: SHOW_COST,
  showSessionName: SHOW_SESSION_NAME,
  showThinking: SHOW_THINKING,
  showAutoCompact: SHOW_AUTO_COMPACT,
  separator: SEPARATOR,
  warnPercent: WARN_PERCENT,
  dangerPercent: DANGER_PERCENT,
  colors: COLORS,
};

export interface StatuslineUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** 最近一次请求的缓存命中率（0-100），拿不到时为 undefined。 */
  cacheHitRate?: number;
}

export interface StatuslineData {
  cwd: string;
  home?: string;
  branch: string | null;
  sessionName?: string;
  modelId?: string;
  provider?: string;
  /** 可用模型数量大于 1 时才显示 provider 前缀。 */
  providerCount?: number;
  thinkingLevel?: string;
  /** 模型是否支持思考。 */
  reasoning?: boolean;
  usage: StatuslineUsage;
  context?: { percent: number | null; contextWindow: number };
  autoCompact?: boolean;
  /** 其它扩展通过 ctx.ui.setStatus() 设置的文本。 */
  statuses: string[];
}

/** 大数字缩写：390000 → 390k，1000000 → 1.0M。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

/** 把 home 前缀缩写成 ~；太长时只保留末尾两段。 */
export function shortenCwd(cwd: string, home?: string, maxLength = 34): string {
  let text = cwd;
  if (home && (cwd === home || cwd.startsWith(`${home}/`))) {
    text = `~${cwd.slice(home.length)}`;
  }
  if (text.length <= maxLength) return text;
  const parts = text.split("/").filter(Boolean);
  if (parts.length <= 2) return `…${text.slice(-(maxLength - 1))}`;
  return `…/${parts.slice(-2).join("/")}`;
}

/** 一段上下文占用使用的颜色（按阈值）。 */
function contextColor(options: StatuslineOptions, percent: number | null | undefined): ThemeColor {
  if (percent === null || percent === undefined) return options.colors.tokens;
  if (percent > options.dangerPercent) return options.colors.danger;
  if (percent > options.warnPercent) return options.colors.warn;
  return options.colors.ok;
}

/** 上下文段：进度条 + 百分比 + 窗口大小 + (auto)。 */
function renderContext(data: StatuslineData, theme: Theme, options: StatuslineOptions, withBar: boolean): string {
  const percent = data.context?.percent;
  const windowSize = data.context?.contextWindow ?? 0;
  const color = contextColor(options, percent);
  const percentText = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
  const windowText = windowSize ? `/${formatTokens(windowSize)}` : "";
  const auto = options.showAutoCompact && data.autoCompact ? theme.fg("dim", " (auto)") : "";

  let bar = "";
  if (withBar && options.showBar && percent !== null && percent !== undefined) {
    const ratio = Math.max(0, Math.min(1, percent / 100));
    const filled = Math.round(ratio * options.barWidth);
    bar = `${theme.fg(color, BAR_FILLED.repeat(filled))}${theme.fg("dim", BAR_EMPTY.repeat(options.barWidth - filled))} `;
  }
  return `${bar}${theme.fg(color, `${percentText}${windowText}`)}${auto}`;
}

/** token 明细段：full 含 W 与缓存命中率，short 只有 ↑↓R。 */
function renderTokens(data: StatuslineData, theme: Theme, options: StatuslineOptions, detail: "full" | "short" | "off"): string {
  if (!options.showTokens || detail === "off") return "";
  const { input, output, cacheRead, cacheWrite, cacheHitRate } = data.usage;
  const parts: string[] = [];
  if (input) parts.push(`↑${formatTokens(input)}`);
  if (output) parts.push(`↓${formatTokens(output)}`);
  if (cacheRead) parts.push(`R${formatTokens(cacheRead)}`);
  if (detail === "full" && cacheWrite) parts.push(`W${formatTokens(cacheWrite)}`);
  if (detail === "full" && (cacheRead > 0 || cacheWrite > 0) && cacheHitRate !== undefined) {
    parts.push(`CH${cacheHitRate.toFixed(1)}%`);
  }
  if (parts.length === 0) return "";
  return theme.fg(options.colors.tokens, parts.join(" "));
}

/** 模型段：`deepseek-v4.1-flash · high`。 */
function renderModel(data: StatuslineData, theme: Theme, options: StatuslineOptions): string {
  const name = data.modelId ?? "no-model";
  let text = name;
  if (options.showThinking && data.reasoning) {
    const level = data.thinkingLevel || "off";
    text = level === "off" ? `${name} · thinking off` : `${name} · ${level}`;
  }
  if ((data.providerCount ?? 0) > 1 && data.provider) {
    text = `(${data.provider}) ${text}`;
  }
  return theme.bold(theme.fg(options.colors.model, text));
}

/** 第一行：目录 · 分支 · 会话名。 */
function renderHeaderLine(data: StatuslineData, theme: Theme, options: StatuslineOptions, width: number): string {
  const cwd = shortenCwd(data.cwd, data.home);
  const segments: string[] = [theme.bold(theme.fg(options.colors.cwd, `📁 ${cwd}`))];
  if (data.branch) segments.push(theme.fg(options.colors.branch, `⎇ ${data.branch}`));
  let line = segments.join("  ");
  if (options.showSessionName && data.sessionName) {
    const withName = `${line}${theme.fg("muted", ` ${options.separator} `)}${theme.fg(options.colors.session, data.sessionName)}`;
    if (visibleWidth(withName) <= width) line = withName;
  }
  return truncateToWidth(line, width, theme.fg("dim", "…"));
}

/** 第二行：上下文 · token · 花费 · 模型。放不下时逐级降级。 */
function renderStatsLine(data: StatuslineData, theme: Theme, options: StatuslineOptions, width: number): string {
  const model = renderModel(data, theme, options);
  const cost = options.showCost && data.usage.cost > 0 ? theme.fg(options.colors.cost, `$${data.usage.cost.toFixed(3)}`) : "";
  const sep = theme.fg("muted", ` ${options.separator} `);
  const join = (parts: Array<string | false>) => parts.filter((part): part is string => Boolean(part)).join(sep);

  const candidates = [
    join([renderContext(data, theme, options, true), renderTokens(data, theme, options, "full"), cost, model]),
    join([renderContext(data, theme, options, true), renderTokens(data, theme, options, "short"), cost, model]),
    join([renderContext(data, theme, options, true), cost, model]),
    join([renderContext(data, theme, options, true), model]),
    join([renderContext(data, theme, options, false), model]),
    join([renderContext(data, theme, options, false)]),
  ];

  const fitted = candidates.find((line) => visibleWidth(line) <= width);
  return truncateToWidth(fitted ?? candidates[candidates.length - 1], width, theme.fg("dim", "…"));
}

/**
 * 渲染整个状态栏。
 *
 * @param data    已取好的会话数据
 * @param theme   当前主题
 * @param width   可用宽度（终端列数）
 * @param options 生效的展示选项
 */
export function renderStatusline(
  data: StatuslineData,
  theme: Theme,
  width: number,
  options: StatuslineOptions = DEFAULT_OPTIONS,
): string[] {
  const lines = [
    renderHeaderLine(data, theme, options, width),
    renderStatsLine(data, theme, options, width),
  ];
  if (data.statuses.length > 0) {
    const statusLine = data.statuses.map((text) => text.replace(/\s*\n\s*/g, " ")).join("  ");
    lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "…")));
  }
  return lines;
}
