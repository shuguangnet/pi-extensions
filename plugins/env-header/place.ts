/**
 * env-header 数据源：IP / 手动定位 + Open-Meteo 天气。
 *
 * 只用免鉴权的公开接口，全部走 fetch，失败即抛错由调用方兜底：
 *   - IP 定位：ipwho.is → ipinfo.io → ip-api.com
 *   - 城市名 → 经纬度：Open-Meteo Geocoding
 *   - 天气：Open-Meteo Forecast
 */

import type { EnvHeaderConfig, Lang } from "./config";

export interface Place {
  /** 城市名。 */
  name: string;
  /** 省 / 州。 */
  region?: string;
  /** 国家名（英文原文，展示时可用 countryName() 本地化）。 */
  country?: string;
  /** ISO 3166-1 alpha-2。 */
  countryCode?: string;
  latitude: number;
  longitude: number;
  timeZone?: string;
  /** 数据来源：ip = 公网 IP，manual = 配置，cache = 磁盘缓存。 */
  source: "ip" | "manual" | "cache";
}

export interface Weather {
  /** WMO weather code。 */
  code: number;
  /** 是否白天。 */
  isDay: boolean;
  temperature: number;
  apparent: number;
  humidity: number;
  windSpeed: number;
  tempUnit: string;
  windUnit: string;
  timeZone?: string;
  fetchedAt: number;
}

const USER_AGENT = "pi-env-header/1.0 (+https://github.com/shuguangnet/pi-extensions)";

async function fetchJson<T>(url: string, timeoutMs: number): Promise<T> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(Math.max(1000, timeoutMs)),
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function toNumber(value: unknown): number | undefined {
  const num = typeof value === "string" ? Number.parseFloat(value) : value;
  return typeof num === "number" && Number.isFinite(num) ? num : undefined;
}

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 时区字段可能是字符串（ipinfo/ip-api），也可能是对象（ipwho.is 的 { id }）。 */
function toTimeZone(value: unknown): string | undefined {
  const direct = toText(value);
  if (direct) return direct;
  if (value && typeof value === "object") {
    return toText((value as { id?: unknown }).id);
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * IP 定位
 * ------------------------------------------------------------------ */

async function locateByIp(timeoutMs: number): Promise<Place | undefined> {
  const failures: string[] = [];

  // 1. ipwho.is（HTTPS，免 token）
  try {
    const data = await fetchJson<Record<string, unknown>>("https://ipwho.is/", timeoutMs);
    if (data.success !== false) {
      const latitude = toNumber(data.latitude);
      const longitude = toNumber(data.longitude);
      const name = toText(data.city) ?? toText(data.region);
      if (latitude !== undefined && longitude !== undefined && name) {
        return {
          name,
          region: toText(data.region),
          country: toText(data.country),
          countryCode: toText(data.country_code),
          latitude,
          longitude,
          timeZone: toTimeZone(data.timezone),
          source: "ip",
        };
      }
    }
    failures.push("ipwho.is: 字段缺失");
  } catch (error) {
    failures.push(`ipwho.is: ${(error as Error).message}`);
  }

  // 2. ipinfo.io（HTTPS）
  try {
    const data = await fetchJson<Record<string, unknown>>("https://ipinfo.io/json", timeoutMs);
    const [lat, lon] = (toText(data.loc) ?? "").split(",");
    const latitude = toNumber(lat);
    const longitude = toNumber(lon);
    const name = toText(data.city) ?? toText(data.region);
    if (latitude !== undefined && longitude !== undefined && name) {
      return {
        name,
        region: toText(data.region),
        country: toText(data.country),
        countryCode: toText(data.country),
        latitude,
        longitude,
        timeZone: toTimeZone(data.timezone),
        source: "ip",
      };
    }
    failures.push("ipinfo.io: 字段缺失");
  } catch (error) {
    failures.push(`ipinfo.io: ${(error as Error).message}`);
  }

  // 3. ip-api.com（免费版只支持 HTTP）
  try {
    const data = await fetchJson<Record<string, unknown>>("http://ip-api.com/json/", timeoutMs);
    if (data.status === "success") {
      const latitude = toNumber(data.lat);
      const longitude = toNumber(data.lon);
      const name = toText(data.city) ?? toText(data.regionName);
      if (latitude !== undefined && longitude !== undefined && name) {
        return {
          name,
          region: toText(data.regionName),
          country: toText(data.country),
          countryCode: toText(data.countryCode),
          latitude,
          longitude,
          timeZone: toTimeZone(data.timezone),
          source: "ip",
        };
      }
    }
    failures.push("ip-api.com: 字段缺失");
  } catch (error) {
    failures.push(`ip-api.com: ${(error as Error).message}`);
  }

  throw new Error(failures.join(" / "));
}

/* ------------------------------------------------------------------ *
 * 城市名 → 地点
 * ------------------------------------------------------------------ */

export async function geocodeCity(query: string, lang: Lang, timeoutMs: number): Promise<Place | undefined> {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", lang === "en" ? "en" : "zh");
  url.searchParams.set("format", "json");

  const data = await fetchJson<{ results?: Array<Record<string, unknown>> }>(url.toString(), timeoutMs);
  const hit = data.results?.[0];
  if (!hit) return undefined;

  const latitude = toNumber(hit.latitude);
  const longitude = toNumber(hit.longitude);
  const name = toText(hit.name);
  if (latitude === undefined || longitude === undefined || !name) return undefined;

  return {
    name,
    region: toText(hit.admin1),
    country: toText(hit.country),
    countryCode: toText(hit.country_code),
    latitude,
    longitude,
    timeZone: toTimeZone(hit.timezone),
    source: "manual",
  };
}

/** 按配置解析地点：manual 优先，其次 IP 定位。 */
export async function resolvePlace(config: EnvHeaderConfig): Promise<Place | undefined> {
  const { mode, manual, timeoutMs } = config.location;
  if (mode === "off") return undefined;

  const manualLat = manual.latitude;
  const manualLon = manual.longitude;

  if (mode === "manual") {
    if (typeof manualLat === "number" && typeof manualLon === "number") {
      return {
        name: manual.label ?? manual.name ?? `${manualLat.toFixed(2)}, ${manualLon.toFixed(2)}`,
        region: manual.region,
        country: manual.country,
        countryCode: manual.countryCode,
        latitude: manualLat,
        longitude: manualLon,
        timeZone: manual.timeZone,
        source: "manual",
      };
    }
    if (manual.name) {
      const place = await geocodeCity(manual.name, config.lang, timeoutMs);
      if (!place) throw new Error(`无法解析城市：${manual.name}`);
      return {
        ...place,
        name: manual.label ?? place.name,
        timeZone: manual.timeZone ?? place.timeZone,
      };
    }
    throw new Error("location.mode = manual，但 manual 里既没有 name 也没有经纬度");
  }

  return locateByIp(timeoutMs);
}

/* ------------------------------------------------------------------ *
 * 天气
 * ------------------------------------------------------------------ */

export async function fetchWeather(place: Place, config: EnvHeaderConfig): Promise<Weather> {
  const imperial = config.weather.units === "imperial";
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", String(place.latitude));
  url.searchParams.set("longitude", String(place.longitude));
  url.searchParams.set(
    "current",
    ["temperature_2m", "apparent_temperature", "relative_humidity_2m", "is_day", "weather_code", "wind_speed_10m"].join(
      ",",
    ),
  );
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("temperature_unit", imperial ? "fahrenheit" : "celsius");
  url.searchParams.set("wind_speed_unit", imperial ? "mph" : "kmh");

  const data = await fetchJson<{
    timezone?: string;
    current?: Record<string, unknown>;
  }>(url.toString(), config.weather.timeoutMs);

  const current = data.current;
  if (!current) throw new Error("天气响应缺少 current 字段");

  const temperature = toNumber(current.temperature_2m);
  if (temperature === undefined) throw new Error("天气响应缺少温度");

  return {
    code: toNumber(current.weather_code) ?? -1,
    isDay: toNumber(current.is_day) !== 0,
    temperature,
    apparent: toNumber(current.apparent_temperature) ?? temperature,
    humidity: toNumber(current.relative_humidity_2m) ?? -1,
    windSpeed: toNumber(current.wind_speed_10m) ?? -1,
    tempUnit: imperial ? "°F" : "°C",
    windUnit: imperial ? "mph" : "km/h",
    timeZone: toText(data.timezone),
    fetchedAt: Date.now(),
  };
}
