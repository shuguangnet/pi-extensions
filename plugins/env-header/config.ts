/**
 * env-header 配置
 *
 * 这里是**默认值**，改完 `/reload` 或重启 pi 生效。
 * 想临时/长期覆盖某项而不动代码，可以在
 *   $PI_CODING_AGENT_DIR/env-header.json   （默认 ~/.pi/agent/env-header.json）
 * 里写**同名子集**，会被深合并覆盖（见 README）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Lang = "zh" | "en";
export type LocationMode = "auto" | "manual" | "off";
export type Units = "metric" | "imperial";

/** 手动指定的地点（mode = "manual" 时生效）。 */
export interface ManualLocation {
  /** 城市名，会走 open-meteo geocoding 解析成经纬度。填了它就不用填经纬度。 */
  name?: string;
  /** 显示名覆盖，例如 "杭州"。不填则用 geocoding 返回的城市名。 */
  label?: string;
  latitude?: number;
  longitude?: number;
  /** 省 / 州（`/env where` 会自动写入，仅用于展示）。 */
  region?: string;
  /** 国家名（`/env where` 会自动写入，仅用于展示）。 */
  country?: string;
  /** ISO 3166-1 alpha-2（`/env where` 会自动写入，用于本地化国家名）。 */
  countryCode?: string;
  /** IANA 时区，例如 "Asia/Shanghai"。不填则用 geocoding/weather 返回的。 */
  timeZone?: string;
}

export interface EnvHeaderConfig {
  /** 总开关，false 时完全不显示 widget。 */
  enabled: boolean;
  /** 文案语言。 */
  lang: Lang;
  clock: {
    /** 显示秒（每秒刷新一次）。 */
    showSeconds: boolean;
    /** 12 小时制。 */
    hour12: boolean;
    /** 显示星期。 */
    showWeekday: boolean;
    /**
     * 时钟时区：
     *   null    = 跟随系统本地时区
     *   "auto"  = 跟随定位到的城市时区
     *   其他    = IANA 时区名，例如 "Asia/Shanghai"
     */
    timeZone: string | null | "auto";
  };
  location: {
    /** auto = 用公网 IP 定位；manual = 用下面的 manual 块；off = 不显示地点（也不查天气）。 */
    mode: LocationMode;
    manual: ManualLocation;
    /** IP 定位结果缓存时长（分钟）。 */
    cacheMinutes: number;
    /** 定位/地理编码请求超时（毫秒）。 */
    timeoutMs: number;
  };
  weather: {
    enabled: boolean;
    units: Units;
    /** 天气缓存时长（分钟），过期后自动刷新，请求失败时继续用缓存。 */
    cacheMinutes: number;
    /** 天气请求超时（毫秒）。 */
    timeoutMs: number;
    /** 额外信息。 */
    showApparent: boolean;
    showHumidity: boolean;
    showWind: boolean;
  };
  summary: {
    /** 是否在 widget 第二行显示会话概述。 */
    enabled: boolean;
    /** false = 只用本地启发式摘要（零成本）；true = 额外用模型生成一句概述。 */
    useModel: boolean;
    /** "provider/id" 或 "id"；null = 用当前会话模型。 */
    model: string | null;
    /** 至少新增多少条消息才重新生成概述。 */
    minNewMessages: number;
    /** 两次模型概述之间的最小间隔（秒）。 */
    minIntervalSeconds: number;
    /** 发给模型的会话文本上限（字符）。 */
    maxInputChars: number;
    /** 概述最大长度（字符）。 */
    maxLength: number;
  };
}

export const DEFAULT_CONFIG: EnvHeaderConfig = {
  enabled: true,
  lang: "zh",
  clock: {
    showSeconds: true,
    hour12: false,
    showWeekday: true,
    timeZone: null,
  },
  location: {
    mode: "auto",
    manual: {},
    cacheMinutes: 720,
    timeoutMs: 6000,
  },
  weather: {
    enabled: true,
    units: "metric",
    cacheMinutes: 10,
    timeoutMs: 6000,
    showApparent: true,
    showHumidity: true,
    showWind: false,
  },
  summary: {
    enabled: true,
    useModel: true,
    model: null,
    minNewMessages: 8,
    minIntervalSeconds: 120,
    maxInputChars: 6000,
    maxLength: 80,
  },
};

/** pi 的全局配置目录（可用 PI_CODING_AGENT_DIR 覆盖）。 */
export function agentConfigDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR?.trim();
  return override && override.length > 0 ? override : join(homedir(), ".pi", "agent");
}

/** 用户覆盖配置路径。 */
export function configFilePath(): string {
  return join(agentConfigDir(), "env-header.json");
}

/** 定位/天气磁盘缓存路径。 */
export function cacheFilePath(): string {
  return join(agentConfigDir(), "env-header-cache.json");
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export async function writeJsonFile(path: string, data: unknown): Promise<void> {
  await mkdir(agentConfigDir(), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 把覆盖对象深合并到默认值上（数组/标量直接替换）。 */
export function mergeConfig(base: EnvHeaderConfig, override: unknown): EnvHeaderConfig {
  return deepMerge(base, override) as EnvHeaderConfig;
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  if (!isPlainObject(base)) return override;
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key]) ? deepMerge(result[key], value) : value;
  }
  return result;
}

/** 读取 config.ts 默认值 + env-header.json 覆盖。 */
export async function loadConfig(): Promise<{ config: EnvHeaderConfig; path: string; error?: string }> {
  const path = configFilePath();
  const override = await readJsonFile<unknown>(path);
  if (override === undefined) {
    return { config: DEFAULT_CONFIG, path };
  }
  try {
    return { config: mergeConfig(DEFAULT_CONFIG, override), path };
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      path,
      error: `${path} 解析失败，已回退默认配置：${(error as Error).message}`,
    };
  }
}
