/**
 * env-header 文本工具：ANSI 感知的宽度计算 / 截断、文案、天气代码映射、时间格式化。
 */

import type { Lang } from "./config";

/* ------------------------------------------------------------------ *
 * ANSI 感知的宽度 / 截断
 * ------------------------------------------------------------------ */

/** 从 chars[i] 开始读一个 ANSI 序列，返回 [序列, 长度]。非 ANSI 时返回单字符。 */
function readAnsiSequence(chars: string[], i: number): [string, number] {
  const first = chars[i] ?? "";
  if (first !== "\u001b" && first !== "\u009b") return [first, 1];

  if (chars[i + 1] === "[") {
    let j = i + 2;
    while (j < chars.length && !/[@-~]/.test(chars[j] ?? "")) j += 1;
    const end = Math.min(j + 1, chars.length);
    return [chars.slice(i, end).join(""), end - i];
  }

  if (chars[i + 1] === "]") {
    let j = i + 2;
    while (j < chars.length) {
      if (chars[j] === "\u0007") {
        j += 1;
        break;
      }
      if (chars[j] === "\u001b" && chars[j + 1] === "\\") {
        j += 2;
        break;
      }
      j += 1;
    }
    return [chars.slice(i, j).join(""), j - i];
  }

  const end = Math.min(i + 2, chars.length);
  return [chars.slice(i, end).join(""), end - i];
}

/** 东亚全角 / 宽 emoji 区间（近似 wcwidth）。 */
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],
  [0x2600, 0x27bf],
  [0x2b00, 0x2bff],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1f2ff],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f7e0, 0x1f7eb],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
];

function isCombining(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

/** 单个码点的显示宽度。 */
export function codePointWidth(cp: number): number {
  if (cp === 0x200d) return 0; // ZWJ
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isCombining(cp)) return 0;
  for (const [start, end] of WIDE_RANGES) {
    if (cp >= start && cp <= end) return 2;
  }
  return 1;
}

/** 字符串可见宽度（忽略 ANSI 序列）。 */
export function visibleWidth(text: string): number {
  const chars = Array.from(text);
  let width = 0;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? "";
    if (char === "\u001b" || char === "\u009b") {
      const [, length] = readAnsiSequence(chars, i);
      i += length - 1;
      continue;
    }
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

/** 按可见宽度截断（保留 ANSI 序列，必要时补 reset）。 */
export function truncateVisible(text: string, maxWidth: number): string {
  const chars = Array.from(text);
  let out = "";
  let width = 0;
  let truncated = false;

  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i] ?? "";
    if (char === "\u001b" || char === "\u009b") {
      const [sequence, length] = readAnsiSequence(chars, i);
      out += sequence;
      i += length - 1;
      continue;
    }
    const charWidth = codePointWidth(char.codePointAt(0) ?? 0);
    if (width + charWidth > maxWidth) {
      truncated = true;
      break;
    }
    out += char;
    width += charWidth;
  }

  return truncated ? `${out}\u001b[0m` : out;
}

/** 单行化（折叠所有空白），用于把多行概述塞进一行。 */
export function singleLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/* ------------------------------------------------------------------ *
 * 文案
 * ------------------------------------------------------------------ */

type StringKey =
  | "locating"
  | "locationFailed"
  | "locationOff"
  | "weatherLoading"
  | "weatherFailed"
  | "weatherDisabled"
  | "weatherCached"
  | "summaryLabel"
  | "summaryPending"
  | "summaryNone"
  | "summaryError"
  | "turns"
  | "files"
  | "startsWith"
  | "recently";

const STRINGS: Record<Lang, Record<StringKey, string>> = {
  zh: {
    locating: "定位中…",
    locationFailed: "定位失败",
    locationOff: "未定位",
    weatherLoading: "天气获取中…",
    weatherFailed: "天气不可用",
    weatherDisabled: "天气已关闭",
    weatherCached: "缓存",
    summaryLabel: "概述",
    summaryPending: "正在生成概述…",
    summaryNone: "新会话",
    summaryError: "概述生成失败",
    turns: "轮",
    files: "文件",
    startsWith: "起于",
    recently: "最近",
  },
  en: {
    locating: "locating…",
    locationFailed: "no location",
    locationOff: "location off",
    weatherLoading: "loading weather…",
    weatherFailed: "weather unavailable",
    weatherDisabled: "weather off",
    weatherCached: "cached",
    summaryLabel: "session",
    summaryPending: "summarizing…",
    summaryNone: "new session",
    summaryError: "summary failed",
    turns: "turns",
    files: "files",
    startsWith: "started with",
    recently: "latest",
  },
};

export function t(lang: Lang, key: StringKey): string {
  return STRINGS[lang]?.[key] ?? STRINGS.zh[key];
}

/* ------------------------------------------------------------------ *
 * 天气代码（WMO）
 * ------------------------------------------------------------------ */

interface WeatherLabel {
  emoji: string;
  text: string;
}

const WMO_ZH: Record<number, string> = {
  0: "晴",
  1: "大致晴朗",
  2: "局部多云",
  3: "阴",
  45: "雾",
  48: "冻雾",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "大毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷阵雨",
  96: "雷暴伴冰雹",
  99: "强雷暴伴冰雹",
};

const WMO_EN: Record<number, string> = {
  0: "clear",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "depositing rime fog",
  51: "light drizzle",
  53: "drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "light snow showers",
  86: "snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "thunderstorm with heavy hail",
};

/** WMO code + 昼夜 → emoji 与文案。 */
export function weatherLabel(code: number, isDay: boolean, lang: Lang): WeatherLabel {
  const text = (lang === "en" ? WMO_EN[code] : WMO_ZH[code]) ?? (lang === "en" ? "unknown" : "未知");
  let emoji = "🌡";

  if (code === 0 || code === 1) emoji = isDay ? "☀️" : "🌙";
  else if (code === 2) emoji = isDay ? "⛅" : "☁️";
  else if (code === 3) emoji = "☁️";
  else if (code === 45 || code === 48) emoji = "🌫️";
  else if (code >= 51 && code <= 57) emoji = "🌦️";
  else if (code === 61 || code === 80) emoji = "🌦️";
  else if (code === 63 || code === 66 || code === 81) emoji = "🌧️";
  else if (code === 65 || code === 67 || code === 82) emoji = "🌧️";
  else if (code >= 71 && code <= 77) emoji = "🌨️";
  else if (code === 85 || code === 86) emoji = "🌨️";
  else if (code >= 95) emoji = "⛈️";

  return { emoji, text };
}

/* ------------------------------------------------------------------ *
 * 时间格式化
 * ------------------------------------------------------------------ */

interface ClockOptions {
  showSeconds: boolean;
  hour12: boolean;
  showWeekday: boolean;
}

function localeOf(lang: Lang): string {
  return lang === "en" ? "en-US" : "zh-CN";
}

function format(lang: Lang, options: Intl.DateTimeFormatOptions, date: Date, timeZone?: string): string {
  const formatter = new Intl.DateTimeFormat(localeOf(lang), timeZone ? { ...options, timeZone } : options);
  return formatter.format(date);
}

/** "10:45:03"。 */
export function formatTime(date: Date, options: ClockOptions, lang: Lang, timeZone?: string): string {
  return format(
    lang,
    {
      hour: "2-digit",
      minute: "2-digit",
      ...(options.showSeconds ? { second: "2-digit" } : {}),
      hour12: options.hour12,
    },
    date,
    timeZone,
  );
}

/** "2026-09-17"。 */
export function formatDate(date: Date, lang: Lang, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat(localeOf(lang), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(timeZone ? { timeZone } : {}),
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const separator = lang === "en" ? "-" : "-";
  return [get("year"), get("month"), get("day")].filter(Boolean).join(separator);
}

/** "星期四" / "Thursday"。 */
export function formatWeekday(date: Date, lang: Lang, timeZone?: string): string {
  return format(lang, { weekday: "long" }, date, timeZone);
}

/** 用 Intl.DisplayNames 本地化国家代码，"US" → "美国"。 */
export function countryName(code: string | undefined, lang: Lang): string | undefined {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return undefined;
  try {
    const names = new Intl.DisplayNames([localeOf(lang)], { type: "region" });
    return names.of(code.toUpperCase()) ?? undefined;
  } catch {
    return undefined;
  }
}
