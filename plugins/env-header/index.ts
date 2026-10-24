/**
 * env-header —— pi 环境抬头
 *
 * 在输入框上方常驻两行：
 *   1. 时间 · 地点 · 天气（时间每秒刷新；地点走 IP 定位，可用 `/env where <城市>` 固定；天气走 Open-Meteo）
 *   2. 当前会话概述（本地启发式摘要始终可用，可选叠加模型生成的一句话概述）
 *
 * 命令：
 *   /env                 查看当前状态
 *   /env refresh         立刻刷新地点 + 天气
 *   /env summary         立刻用模型重新生成会话概述
 *   /env on | off        临时开关 widget
 *   /env where <城市>    把地点固定到某个城市（写入配置文件）
 *   /env auto            地点改回公网 IP 定位
 *   /env config          打印生效配置与配置文件路径
 *
 * 安装 / 自定义见本插件 README.md 与仓库根 README.md。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_CONFIG,
  cacheFilePath,
  configFilePath,
  readJsonFile,
  writeJsonFile,
  isPlainObject,
  loadConfig,
  type EnvHeaderConfig,
} from "./config";
import { fetchWeather, geocodeCity, resolvePlace, type Place, type Weather } from "./place";
import {
  buildSummaryPrompt,
  cleanupSummary,
  collectStats,
  conversationDigest,
  heuristicSummary,
  llmSummary,
  resolveSummaryModel,
  type SessionStats,
} from "./summary";
import {
  countryName,
  formatDate,
  formatTime,
  formatWeekday,
  singleLine,
  t,
  truncateVisible,
  visibleWidth,
  weatherLabel,
} from "./text";

const WIDGET_KEY = "env-header";
const CLOCK_INTERVAL_MS = 1000;
const TTL_INTERVAL_MS = 60_000;
const SUMMARY_TIMEOUT_MS = 45_000;
const MIN_SUMMARY_MESSAGES = 6;
/** 定位/天气失败后的重试间隔（避免离线时每分钟狂重试）。 */
const ERROR_RETRY_MS = 5 * 60_000;
/** RPC 模式的 widget 只支持字符串数组，没有真实宽度，这里给一个足够宽的预折叠宽度。 */
const RPC_FALLBACK_WIDTH = 140;

interface Timed<T> {
  value: T;
  fetchedAt: number;
}

interface CacheShape {
  place?: Timed<Place>;
  weather?: Timed<Weather>;
}

/** 一行 widget 的结构：分段 + 分隔符，窄终端时整段丢弃而不是拦腰截断。 */
interface WidgetLine {
  parts: string[];
  separator: string;
}

type Status = "idle" | "loading" | "ok" | "error";

type SummaryOutcome =
  | "generated"
  | "disabled"
  | "heuristic-only"
  | "too-short"
  | "unchanged"
  | "busy"
  | "no-model"
  | "failed";

interface State {
  config: EnvHeaderConfig;
  place?: Place;
  placeFetchedAt: number;
  placeStatus: Status;
  placeError?: string;
  placeRetryAt: number;
  weather?: Weather;
  weatherStatus: Status;
  weatherError?: string;
  weatherRetryAt: number;
  stats?: SessionStats;
  summary?: string;
  summaryStatus: Status;
  summaryError?: string;
}

function initialState(): State {
  return {
    config: DEFAULT_CONFIG,
    placeFetchedAt: 0,
    placeStatus: "idle",
    placeRetryAt: 0,
    weatherStatus: "idle",
    weatherRetryAt: 0,
    summaryStatus: "idle",
  };
}

function round1(value: number): string {
  if (!Number.isFinite(value)) return "-";
  return String(Math.round(value * 10) / 10);
}

export default function envHeaderExtension(pi: ExtensionAPI) {
  let activeCtx: ExtensionContext | null = null;
  let state: State = initialState();
  let clockTimer: ReturnType<typeof setInterval> | null = null;
  let ttlTimer: ReturnType<typeof setInterval> | null = null;
  let lastWidgetKey = "";
  let generation = 0;
  let summarizing = false;
  let summaryCancel: AbortController | null = null;
  let lastSummaryAt = 0;
  let lastSummaryMessages = 0;

  /* ---------------------------------------------------------------- *
   * 渲染
   * ---------------------------------------------------------------- */

  function clockTimeZone(): string | undefined {
    const tz = state.config.clock.timeZone;
    if (tz === "auto") return state.place?.timeZone ?? state.weather?.timeZone;
    return typeof tz === "string" && tz.length > 0 ? tz : undefined;
  }

  function safeFormat<T>(run: () => T, fallback: () => T): T {
    try {
      return run();
    } catch {
      return fallback();
    }
  }

  function renderClock(theme: ExtensionContext["ui"]["theme"]): string {
    const cfg = state.config;
    const now = new Date();
    const timeZone = clockTimeZone();
    const time = safeFormat(
      () => formatTime(now, cfg.clock, cfg.lang, timeZone),
      () => formatTime(now, cfg.clock, cfg.lang),
    );
    const date = safeFormat(
      () => formatDate(now, cfg.lang, timeZone),
      () => formatDate(now, cfg.lang),
    );
    const weekday = cfg.clock.showWeekday
      ? safeFormat(
          () => formatWeekday(now, cfg.lang, timeZone),
          () => formatWeekday(now, cfg.lang),
        )
      : "";
    const tail = [date, weekday].filter((part) => part.length > 0).join(" ");
    const head = `${theme.fg("accent", "🕒")} ${theme.bold(time)}`;
    return tail.length > 0 ? `${head} ${theme.fg("muted", tail)}` : head;
  }

  function placeLabel(place: Place): string {
    const country = countryName(place.countryCode, state.config.lang) ?? place.country;
    const region = place.region && place.region !== place.name ? place.region : undefined;
    const pieces = [place.name, region, country].filter((piece): piece is string => Boolean(piece));
    return [...new Set(pieces)].join(", ");
  }

  function renderPlace(theme: ExtensionContext["ui"]["theme"]): string {
    const lang = state.config.lang;
    const icon = theme.fg("accent", "📍");

    if (state.place) {
      return `${icon} ${theme.fg("text", placeLabel(state.place))}`;
    }
    if (state.placeStatus === "loading") {
      return `${icon} ${theme.fg("dim", t(lang, "locating"))}`;
    }
    if (state.placeStatus === "error") {
      return `${theme.fg("warning", "📍")} ${theme.fg("dim", t(lang, "locationFailed"))}`;
    }
    return `${icon} ${theme.fg("dim", t(lang, "locationOff"))}`;
  }

  function renderWeatherParts(theme: ExtensionContext["ui"]["theme"]): string[] {
    const cfg = state.config;
    const lang = cfg.lang;
    const weather = state.weather;

    if (!weather) {
      if (state.weatherStatus === "loading" || state.placeStatus === "loading") {
        return [`${theme.fg("accent", "🌐")} ${theme.fg("dim", t(lang, "weatherLoading"))}`];
      }
      return [`${theme.fg("warning", "⚠")} ${theme.fg("dim", t(lang, "weatherFailed"))}`];
    }

    const { emoji, text } = weatherLabel(weather.code, weather.isDay, lang);
    const extras: string[] = [];
    if (cfg.weather.showApparent) {
      extras.push(`${lang === "en" ? "feels" : "体感"} ${round1(weather.apparent)}${weather.tempUnit}`);
    }
    if (cfg.weather.showHumidity && weather.humidity >= 0) {
      extras.push(`${lang === "en" ? "humidity" : "湿度"} ${Math.round(weather.humidity)}%`);
    }
    if (cfg.weather.showWind && weather.windSpeed >= 0) {
      extras.push(`${lang === "en" ? "wind" : "风"} ${round1(weather.windSpeed)} ${weather.windUnit}`);
    }
    const ttl = Math.max(1, cfg.weather.cacheMinutes) * 60_000;
    if (Date.now() - weather.fetchedAt > ttl * 1.5) extras.push(t(lang, "weatherCached"));

    const parts = [
      `${emoji} ${theme.fg("text", text)} ${theme.bold(`${round1(weather.temperature)}${weather.tempUnit}`)}`,
    ];
    if (extras.length > 0) parts.push(theme.fg("dim", extras.join(", ")));
    return parts;
  }

  function renderSummary(theme: ExtensionContext["ui"]["theme"]): string {
    const cfg = state.config;
    const lang = cfg.lang;
    if (!cfg.summary.enabled) return "";

    const label = `${theme.fg("accent", "📋")} ${theme.fg("muted", t(lang, "summaryLabel"))}`;
    const text = state.summary ?? (state.stats ? heuristicSummary(state.stats, lang) : t(lang, "summaryNone"));

    let suffix = "";
    if (state.summaryStatus === "loading") {
      suffix = ` ${theme.fg("dim", "⟳")}`;
    } else if (state.summaryStatus === "error" && cfg.summary.useModel) {
      suffix = ` ${theme.fg("dim", `(${t(lang, "summaryError")})`)}`;
    }

    return `${label} ${theme.fg("text", text)}${suffix}`;
  }

  /** 一行 widget 的结构：分段 + 分隔符，窄终端时整段丢弃而不是拦腰截断。 */
  function fitLine(line: WidgetLine, width: number): string {
    const max = Math.max(12, width - 1);
    const [first = "", ...rest] = line.parts;
    let out = first;
    let dropped = false;

    for (const part of rest) {
      const candidate = `${out}${line.separator}${part}`;
      if (visibleWidth(candidate) <= max) out = candidate;
      else {
        dropped = true;
        break;
      }
    }

    if (visibleWidth(out) > max) return `${truncateVisible(out, Math.max(1, max - 1))}…`;
    if (!dropped) return out;
    const withEllipsis = `${out}…`;
    return visibleWidth(withEllipsis) <= max ? withEllipsis : `${truncateVisible(out, Math.max(1, max - 1))}…`;
  }

  function buildWidgetLines(theme: ExtensionContext["ui"]["theme"]): WidgetLine[] {
    const cfg = state.config;
    const env: string[] = [renderClock(theme)];
    if (cfg.location.mode !== "off") {
      env.push(renderPlace(theme));
      if (cfg.weather.enabled) env.push(...renderWeatherParts(theme));
    }

    const lines: WidgetLine[] = [{ parts: env, separator: theme.fg("dim", "  ·  ") }];
    const summary = renderSummary(theme);
    if (summary.length > 0) lines.push({ parts: [summary], separator: "" });
    return lines;
  }

  /**
   * 把当前状态推给 pi 的 widget（内容没变则跳过）。
   *
   * TUI 模式用 component factory，可以拿到真实终端宽度做分段折叠；
   * RPC 模式（pi web / IDE 集成）只支持字符串数组，factory 会被静默丢弃，
   * 所以退化成固定宽度预折叠的字符串。
   */
  function pushWidget(force = false): void {
    const ctx = activeCtx;
    if (!ctx || !ctx.hasUI) return;

    if (!state.config.enabled) {
      if (lastWidgetKey !== "") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        lastWidgetKey = "";
      }
      return;
    }

    const lines = buildWidgetLines(ctx.ui.theme);
    const key = `${ctx.mode}:${lines.map((line) => line.parts.join("|")).join("\n")}`;
    if (!force && key === lastWidgetKey) return;
    lastWidgetKey = key;

    if (ctx.mode === "tui") {
      ctx.ui.setWidget(WIDGET_KEY, () => ({
        render: (width: number) => lines.map((line) => ` ${fitLine(line, width)}`.trimEnd()),
        invalidate: () => {},
      }));
      return;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      lines.map((line) => ` ${fitLine(line, RPC_FALLBACK_WIDTH)}`.trimEnd()),
    );
  }

  function clearWidget(): void {
    const ctx = activeCtx;
    lastWidgetKey = "";
    if (!ctx || !ctx.hasUI) return;
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  }

  /* ---------------------------------------------------------------- *
   * 缓存
   * ---------------------------------------------------------------- */

  async function loadCache(): Promise<void> {
    const cache = await readJsonFile<CacheShape>(cacheFilePath());
    if (!cache) return;
    if (cache.place?.value) {
      state.place = { ...cache.place.value, source: "cache" };
      state.placeFetchedAt = cache.place.fetchedAt ?? 0;
      state.placeStatus = "ok";
    }
    if (cache.weather?.value) {
      state.weather = cache.weather.value;
      state.weatherStatus = "ok";
    }
  }

  async function saveCache(): Promise<void> {
    const payload: CacheShape = {};
    if (state.place) payload.place = { value: state.place, fetchedAt: state.placeFetchedAt };
    if (state.weather) payload.weather = { value: state.weather, fetchedAt: state.weather.fetchedAt };
    try {
      await writeJsonFile(cacheFilePath(), payload);
    } catch {
      // 缓存写不进去不影响主流程
    }
  }

  /* ---------------------------------------------------------------- *
   * 地点 / 天气刷新
   * ---------------------------------------------------------------- */

  async function refreshWeather(token: number): Promise<void> {
    const cfg = state.config;
    const place = state.place;
    if (!cfg.weather.enabled || !place) return;

    if (state.weatherStatus !== "ok") state.weatherStatus = "loading";
    pushWidget();

    try {
      const weather = await fetchWeather(place, cfg);
      if (token !== generation) return;
      state.weather = weather;
      state.weatherStatus = "ok";
      state.weatherError = undefined;
      state.weatherRetryAt = 0;
      await saveCache();
    } catch (error) {
      if (token !== generation) return;
      state.weatherStatus = state.weather ? "ok" : "error";
      state.weatherError = (error as Error).message;
      state.weatherRetryAt = Date.now() + ERROR_RETRY_MS;
    }
    pushWidget();
  }

  async function refreshAll(): Promise<void> {
    const cfg = state.config;
    const token = ++generation;

    if (cfg.location.mode === "off") {
      state.place = undefined;
      state.placeStatus = "ok";
      state.weather = undefined;
      state.weatherStatus = "idle";
      pushWidget();
      return;
    }

    state.placeStatus = "loading";
    state.placeError = undefined;
    state.placeRetryAt = 0;
    pushWidget();

    try {
      const place = await resolvePlace(cfg);
      if (token !== generation) return;
      if (!place) {
        state.place = undefined;
        state.placeStatus = "ok";
        pushWidget();
        return;
      }
      state.place = place;
      state.placeFetchedAt = Date.now();
      state.placeStatus = "ok";
      state.placeRetryAt = 0;
      await saveCache();
      pushWidget();
      await refreshWeather(token);
    } catch (error) {
      if (token !== generation) return;
      state.placeStatus = state.place ? "ok" : "error";
      state.placeError = (error as Error).message;
      state.placeRetryAt = Date.now() + ERROR_RETRY_MS;
      pushWidget();
    }
  }

  /** 按 TTL 判断要不要刷；启动和定时都走这里。 */
  async function refreshStale(): Promise<void> {
    const cfg = state.config;
    if (!cfg.enabled || cfg.location.mode === "off") return;

    const now = Date.now();
    const placeTtl = Math.max(5, cfg.location.cacheMinutes) * 60_000;
    const weatherTtl = Math.max(1, cfg.weather.cacheMinutes) * 60_000;

    const placeStale = !state.place || now - state.placeFetchedAt > placeTtl || state.placeStatus === "error";
    if (placeStale && now >= state.placeRetryAt) {
      await refreshAll();
      return;
    }

    const weatherStale = !state.weather || now - state.weather.fetchedAt > weatherTtl || state.weatherStatus === "error";
    if (cfg.weather.enabled && state.place && weatherStale && now >= state.weatherRetryAt) {
      await refreshWeather(++generation);
    }
  }

  /* ---------------------------------------------------------------- *
   * 会话概述
   * ---------------------------------------------------------------- */

  function updateStats(): void {
    const ctx = activeCtx;
    if (!ctx) return;
    state.stats = collectStats(ctx.sessionManager.getBranch());
  }

  async function maybeSummarize(force: boolean): Promise<SummaryOutcome> {
    const ctx = activeCtx;
    if (!ctx) return "failed";
    const cfg = state.config;

    updateStats();
    if (!cfg.summary.enabled) {
      pushWidget();
      return "disabled";
    }
    if (!cfg.summary.useModel) {
      pushWidget();
      return "heuristic-only";
    }
    if (summarizing) return "busy";

    const stats = state.stats;
    const messages = stats?.messages ?? 0;

    if (!force) {
      if (messages < MIN_SUMMARY_MESSAGES) {
        pushWidget();
        return "too-short";
      }
      if (messages - lastSummaryMessages < cfg.summary.minNewMessages) {
        pushWidget();
        return "unchanged";
      }
      if (Date.now() - lastSummaryAt < cfg.summary.minIntervalSeconds * 1000) {
        pushWidget();
        return "unchanged";
      }
    }

    const model = resolveSummaryModel(ctx, cfg.summary.model);
    if (!model) {
      // 没配模型就静默退回启发式摘要
      pushWidget();
      return "no-model";
    }

    summarizing = true;
    state.summaryStatus = "loading";
    summaryCancel = new AbortController();
    pushWidget();

    let outcome: SummaryOutcome = "failed";
    try {
      const branch = ctx.sessionManager.getBranch();
      const digest = conversationDigest(branch, cfg.summary.maxInputChars);
      const prompt = buildSummaryPrompt(cfg.lang, digest, cfg.summary.maxLength);
      const raw = await llmSummary(ctx, model, prompt, {
        timeoutMs: SUMMARY_TIMEOUT_MS,
        signal: summaryCancel.signal,
      });
      const text = raw ? cleanupSummary(raw, cfg.summary.maxLength) : undefined;
      if (text) {
        state.summary = text;
        state.summaryStatus = "ok";
        state.summaryError = undefined;
        outcome = "generated";
      } else {
        state.summaryStatus = state.summary ? "ok" : "error";
      }
    } catch (error) {
      state.summaryStatus = state.summary ? "ok" : "error";
      state.summaryError = (error as Error).message;
    } finally {
      summarizing = false;
      summaryCancel = null;
      lastSummaryAt = Date.now();
      lastSummaryMessages = messages;
      pushWidget();
    }

    return outcome;
  }

  /* ---------------------------------------------------------------- *
   * 定时器
   * ---------------------------------------------------------------- */

  function stopTimers(): void {
    if (clockTimer) clearInterval(clockTimer);
    if (ttlTimer) clearInterval(ttlTimer);
    clockTimer = null;
    ttlTimer = null;
  }

  function startTimers(): void {
    stopTimers();
    clockTimer = setInterval(() => pushWidget(), CLOCK_INTERVAL_MS);
    clockTimer.unref?.();
    ttlTimer = setInterval(() => {
      void refreshStale().catch(() => {});
    }, TTL_INTERVAL_MS);
    ttlTimer.unref?.();
  }

  /* ---------------------------------------------------------------- *
   * 配置落盘
   * ---------------------------------------------------------------- */

  async function patchLocationFile(patch: Record<string, unknown>): Promise<string> {
    const path = configFilePath();
    const existing = (await readJsonFile<Record<string, unknown>>(path)) ?? {};
    const location = isPlainObject(existing.location) ? existing.location : {};
    await writeJsonFile(path, { ...existing, location: { ...location, ...patch } });
    return path;
  }

  async function reloadConfig(): Promise<void> {
    const { config, error } = await loadConfig();
    state.config = config;
    if (error && activeCtx?.hasUI) activeCtx.ui.notify(error, "warning");
  }

  /* ---------------------------------------------------------------- *
   * 命令
   * ---------------------------------------------------------------- */

  function statusText(): string {
    const ctx = activeCtx;
    const cfg = state.config;
    const lang = cfg.lang;
    const place = state.place
      ? placeLabel(state.place)
      : state.placeStatus === "error"
        ? t(lang, "locationFailed")
        : t(lang, "locating");
    const weather = state.weather
      ? `${weatherLabel(state.weather.code, state.weather.isDay, lang).text} ${round1(state.weather.temperature)}${state.weather.tempUnit}`
      : state.weatherStatus === "error"
        ? t(lang, "weatherFailed")
        : t(lang, "weatherLoading");
    const summary = state.summary ?? (state.stats ? heuristicSummary(state.stats, lang) : t(lang, "summaryNone"));

    const lines = [
      `env-header: ${cfg.enabled ? "on" : "off"} · lang=${cfg.lang} · units=${cfg.weather.units}`,
      `📍 ${place}`,
      `🌐 ${weather}`,
      `📋 ${summary}`,
      state.placeError && !state.place ? `⚠ location: ${singleLine(state.placeError)}` : "",
      state.weatherError && !state.weather ? `⚠ weather: ${singleLine(state.weatherError)}` : "",
      state.summaryStatus === "error" && state.summaryError ? `⚠ summary: ${singleLine(state.summaryError)}` : "",
      ctx ? `cwd: ${ctx.cwd}` : "",
      `config: ${configFilePath()}`,
      `cache:  ${cacheFilePath()}`,
    ].filter((line) => line.length > 0);
    return lines.join("\n");
  }

  pi.registerCommand("env", {
    description: "环境抬头（时间/地点/天气/会话概述）：status | refresh | summary | on | off | where <城市> | auto | config",
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const notify = (message: string, type: "info" | "warning" | "error" = "info") => {
        if (ctx.hasUI) ctx.ui.notify(message, type);
      };

      switch (sub) {
        case "refresh": {
          notify("env-header: 刷新地点与天气…");
          await refreshAll();
          notify(statusText().split("\n").slice(1, 4).join("\n"));
          return;
        }
        case "summary": {
          notify("env-header: 生成会话概述…");
          const outcome = await maybeSummarize(true);
          if (outcome === "generated") {
            notify(`📋 ${state.summary}`);
            return;
          }
          if (outcome === "heuristic-only") {
            notify("summary.useModel = false，当前只用本地摘要；想用模型概述请打开它并 /reload", "warning");
            return;
          }
          if (outcome === "no-model") {
            notify(`没有可用于概述的模型（summary.model = ${state.config.summary.model ?? "null(当前会话模型)"}）`, "warning");
            return;
          }
          if (outcome === "busy") {
            notify("上一次概述还在生成中…", "warning");
            return;
          }
          notify(`概述生成失败：${state.summaryError ?? "未知错误"}`, "error");
          return;
        }
        case "on":
        case "off": {
          state.config = { ...state.config, enabled: sub === "on" };
          if (state.config.enabled) {
            startTimers();
            pushWidget(true);
            void refreshStale().catch(() => {});
          } else {
            clearWidget();
          }
          notify(`env-header: ${sub}（仅本次会话；想持久化改 ${configFilePath()} 里的 enabled）`);
          return;
        }
        case "where":
        case "auto": {
          if (sub === "auto") {
            const path = await patchLocationFile({ mode: "auto" });
            await reloadConfig();
            await refreshAll();
            notify(`📍 已改回 IP 定位，并写入 ${path}\n${statusText().split("\n")[1] ?? ""}`);
            return;
          }

          const query = rest.join(" ").trim();
          if (!query) {
            notify("用法：/env where 杭州", "warning");
            return;
          }
          notify(`env-header: 解析城市 ${query}…`);
          const place = await geocodeCity(query, state.config.lang, state.config.location.timeoutMs);
          if (!place) {
            notify(`找不到城市：${query}`, "error");
            return;
          }
          const path = await patchLocationFile({
            mode: "manual",
            manual: {
              name: query,
              label: place.name,
              latitude: place.latitude,
              longitude: place.longitude,
              region: place.region,
              country: place.country,
              countryCode: place.countryCode,
              timeZone: place.timeZone,
            },
          });
          await reloadConfig();
          await refreshAll();
          notify(`📍 已固定到 ${place.name}，并写入 ${path}`);
          return;
        }
        case "config": {
          notify(`${configFilePath()}\n\n${JSON.stringify(state.config, null, 2)}`);
          return;
        }
        default: {
          notify(statusText());
          return;
        }
      }
    },
  });

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;

    state = initialState();
    lastSummaryMessages = 0;
    lastSummaryAt = 0;
    summarizing = false;
    summaryCancel = null;
    generation += 1;

    await reloadConfig();
    if (!state.config.enabled) return;

    await loadCache();
    updateStats();
    pushWidget(true);

    startTimers();
    void refreshStale().catch(() => {});
  });

  pi.on("session_shutdown", () => {
    stopTimers();
    summaryCancel?.abort();
    summaryCancel = null;
    summarizing = false;
    generation += 1;
    clearWidget();
    activeCtx = null;
  });

  pi.on("turn_end", () => {
    if (!state.config.enabled) return;
    updateStats();
    pushWidget();
  });

  pi.on("agent_settled", async () => {
    if (!state.config.enabled) return;
    if (!state.config.summary.enabled || !state.config.summary.useModel) return;
    await maybeSummarize(false).catch(() => {});
  });
}
