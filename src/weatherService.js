"use strict";

const GEOCODING_ENDPOINT = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_ENDPOINT = "https://api.open-meteo.com/v1/forecast";

const LOCATION_ALIASES = new Map([
  ["东京", "Tokyo"],
  ["东京都", "Tokyo"],
  ["大阪", "Osaka"],
  ["京都", "Kyoto"],
  ["横滨", "Yokohama"],
  ["名古屋", "Nagoya"],
  ["札幌", "Sapporo"],
  ["福冈", "Fukuoka"],
  ["冲绳", "Naha"],
  ["北京", "Beijing"],
  ["上海", "Shanghai"],
]);

function stripLeadingBotMention(value = "") {
  return String(value || "")
    .trim()
    .replace(/^@[^\s:：,，]{1,24}[\s:：,，]+/u, "")
    .trim();
}

function stripRequestPrefix(value = "") {
  let text = String(value || "").trim();
  let previous = "";
  while (text && text !== previous) {
    previous = text;
    text = text
      .replace(/^(?:请问|麻烦|劳驾|想知道|能不能|可以|帮我|给我)/u, "")
      .replace(/^(?:查一下|查查|查|看一下|看看|看)/u, "")
      .trim();
  }
  return text;
}

function cleanLocation(value = "") {
  return stripRequestPrefix(value)
    .replace(/^(?:今天|现在|当前)/u, "")
    .replace(/(?:今天|现在|当前|的)$/u, "")
    .replace(/[：:,，。！!?？]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
}

const NON_WEATHER_DEGREE_PATTERN =
  /(近视|视力|眼镜|度数|显卡|水温|水烧|烧到|发烧|体温|血压|血糖|电池|机箱|散热|烤箱|油温|cpu)/iu;

function parseWeatherQuery(value = "") {
  const source = stripLeadingBotMention(value);
  if (!source) return null;
  const compact = source.replace(/\s+/g, "").replace(/[。！!?？,，]+$/g, "");
  if (!/(天气|气温|温度|多少度|几度)/u.test(compact)) return null;
  // 只靠“温度/几度”命中的问句先过排除词，避免把近视度数、显卡温度当成天气查询
  if (!/(天气|气温)/u.test(compact) && NON_WEATHER_DEGREE_PATTERN.test(compact)) return null;

  const queryPattern = /^(.*?)(?:今天|现在|当前)?(?:的)?(?:天气(?:预报)?(?:怎么样|如何|咋样)?|气温(?:是?多少|怎么样|如何)?|温度(?:是?多少|怎么样|如何)?|多少度|几度)(?:告诉我|说一下|说说|查一下)?$/u;
  const match = compact.match(queryPattern);
  if (!match) return null;

  const location = cleanLocation(match[1]);
  const futureRequested = /(明天|后天|大后天|未来|下周)/u.test(compact);
  return {
    intent: "current_weather",
    source,
    location: futureRequested ? "" : location,
    futureRequested,
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const CACHE_ENTRY_LIMIT = 200;

function pruneCache(cache, limit = CACHE_ENTRY_LIMIT) {
  while (cache.size > limit) {
    cache.delete(cache.keys().next().value);
  }
}

class WeatherService {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.fetchImpl = options.fetch || options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Math.max(1, finiteNumber(options.timeoutMs || 7000) ?? 7000);
    this.cacheTtlMs = Math.max(0, finiteNumber(options.cacheTtlMs ?? 600000) ?? 600000);
    this.language = String(options.language || "zh").trim() || "zh";
    this.geocodeCache = new Map();
    this.resultCache = new Map();
    this.pendingLookups = new Map();
    this.lastError = "";
    this.lastSuccessAt = 0;
  }

  getState() {
    return {
      enabled: this.enabled,
      available: this.lastSuccessAt > 0 && !this.lastError,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  async fetchJson(url) {
    if (typeof this.fetchImpl !== "function") throw new Error("当前环境没有可用的 fetch");
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response?.ok) throw new Error(`HTTP ${response?.status || "error"}`);
      return await response.json();
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        throw new Error(`实时天气请求超过 ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async lookupCurrent(location) {
    const requestedLocation = cleanLocation(location);
    if (!requestedLocation) throw new Error("缺少城市");
    // 同城市结果做 TTL 缓存并合并并发查询，避免弹幕刷屏打爆免费接口
    const cached = this.resultCache.get(requestedLocation);
    if (cached && this.cacheTtlMs > 0 && Date.now() - cached.at <= this.cacheTtlMs) {
      return { ...cached.data };
    }
    const pending = this.pendingLookups.get(requestedLocation);
    if (pending) return pending.then((data) => ({ ...data }));
    const lookup = (async () => {
      const data = await this.fetchCurrentWeather(requestedLocation);
      this.resultCache.set(requestedLocation, { at: Date.now(), data });
      pruneCache(this.resultCache);
      return data;
    })();
    this.pendingLookups.set(requestedLocation, lookup);
    try {
      return { ...(await lookup) };
    } finally {
      this.pendingLookups.delete(requestedLocation);
    }
  }

  async fetchCurrentWeather(requestedLocation) {
    const geocodingName = LOCATION_ALIASES.get(requestedLocation) || requestedLocation;
    let place = this.geocodeCache.get(geocodingName);
    if (!place) {
      const geocodingUrl = new URL(GEOCODING_ENDPOINT);
      geocodingUrl.searchParams.set("name", geocodingName);
      geocodingUrl.searchParams.set("count", "1");
      geocodingUrl.searchParams.set("language", this.language);
      geocodingUrl.searchParams.set("format", "json");
      const geocoding = await this.fetchJson(geocodingUrl.toString());
      place = Array.isArray(geocoding?.results) ? geocoding.results[0] : null;
    }
    const latitude = finiteNumber(place?.latitude);
    const longitude = finiteNumber(place?.longitude);
    if (!place || latitude === null || longitude === null) throw new Error("没有找到该城市");
    this.geocodeCache.set(geocodingName, place);
    pruneCache(this.geocodeCache);

    const forecastUrl = new URL(FORECAST_ENDPOINT);
    forecastUrl.searchParams.set("latitude", String(latitude));
    forecastUrl.searchParams.set("longitude", String(longitude));
    forecastUrl.searchParams.set(
      "current",
      "temperature_2m,apparent_temperature,weather_code"
    );
    forecastUrl.searchParams.set("timezone", "auto");
    const forecast = await this.fetchJson(forecastUrl.toString());
    const temperatureC = finiteNumber(forecast?.current?.temperature_2m);
    const apparentTemperatureC = finiteNumber(forecast?.current?.apparent_temperature);
    if (temperatureC === null) throw new Error("天气数据缺少气温");

    this.lastError = "";
    this.lastSuccessAt = Date.now();
    return {
      source: "Open-Meteo",
      requestedLocation,
      resolvedLocation: String(place.name || requestedLocation),
      admin1: String(place.admin1 || ""),
      country: String(place.country || ""),
      latitude,
      longitude,
      observedAt: String(forecast?.current?.time || ""),
      timezone: String(forecast?.timezone || ""),
      temperatureC,
      apparentTemperatureC,
      weatherCode: finiteNumber(forecast?.current?.weather_code),
    };
  }

  async getContext(message) {
    const query = parseWeatherQuery(message);
    if (!query) return null;
    if (query.futureRequested) {
      return {
        intent: "current_weather",
        available: false,
        reason: "future_forecast_not_loaded",
        instruction: "本次没有可靠的未来预报数据，请自然说明，不要编造温度。",
      };
    }
    if (!query.location) {
      return {
        intent: "current_weather",
        available: false,
        reason: "missing_location",
        instruction: "观众没说城市，请由你自然追问想查哪里，不要编造温度。",
      };
    }
    if (!this.enabled) {
      return {
        intent: "current_weather",
        available: false,
        requestedLocation: query.location,
        reason: "weather_service_disabled",
        instruction: "实时天气数据不可用，请自然说明，不要编造温度。",
      };
    }

    try {
      const current = await this.lookupCurrent(query.location);
      return {
        intent: "current_weather",
        available: true,
        ...current,
        instruction: "请由你用这些实时数据自然回答观众，不要更改数值。",
      };
    } catch (error) {
      this.lastError = error.message || String(error);
      return {
        intent: "current_weather",
        available: false,
        requestedLocation: query.location,
        reason: "weather_lookup_failed",
        instruction: "实时天气数据暂时不可用，请自然说明，不要编造温度。",
      };
    }
  }
}

module.exports = WeatherService;
module.exports.WeatherService = WeatherService;
module.exports.parseWeatherQuery = parseWeatherQuery;
module.exports.GEOCODING_ENDPOINT = GEOCODING_ENDPOINT;
module.exports.FORECAST_ENDPOINT = FORECAST_ENDPOINT;
