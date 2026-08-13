"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const WeatherService = require("../src/weatherService");
const { parseWeatherQuery } = require("../src/weatherService");
const { BotRuntime } = require("../src/botRuntime");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待测试条件超时");
}

test("识别常见的中文实时天气问法，不把普通天气感叹当查询", () => {
  assert.equal(parseWeatherQuery("东京多少度").location, "东京");
  assert.equal(parseWeatherQuery("帮我查一下东京天气怎么样？").location, "东京");
  assert.equal(parseWeatherQuery("@测试机器人 北京现在几度").location, "北京");
  assert.equal(parseWeatherQuery("天气预报").location, "");
  assert.equal(parseWeatherQuery("天气预报告诉我").location, "");
  assert.equal(parseWeatherQuery("东京天气告诉我").location, "东京");
  assert.equal(parseWeatherQuery("北京明天天气").futureRequested, true);
  assert.equal(parseWeatherQuery("今天天气不错"), null);
});

test("Open-Meteo 两段请求生成可交给 Qwen 的实时事实", async () => {
  const urls = [];
  const service = new WeatherService({
    fetch: async (url) => {
      urls.push(new URL(url));
      if (urls.length === 1) {
        return jsonResponse({
          results: [
            {
              name: "Tokyo",
              admin1: "Tokyo",
              country: "Japan",
              latitude: 35.6895,
              longitude: 139.6917,
            },
          ],
        });
      }
      return jsonResponse({
        timezone: "Asia/Tokyo",
        current: {
          time: "2026-07-12T04:00",
          temperature_2m: 27.4,
          apparent_temperature: 29.1,
          weather_code: 3,
        },
      });
    },
  });

  const context = await service.getContext("东京多少度");
  assert.equal(urls.length, 2);
  assert.equal(urls[0].hostname, "geocoding-api.open-meteo.com");
  assert.equal(urls[0].searchParams.get("name"), "Tokyo");
  assert.equal(urls[0].searchParams.has("apikey"), false);
  assert.equal(urls[1].hostname, "api.open-meteo.com");
  assert.match(urls[1].searchParams.get("current"), /temperature_2m/);
  assert.equal(context.available, true);
  assert.equal(context.source, "Open-Meteo");
  assert.equal(context.requestedLocation, "东京");
  assert.equal(context.temperatureC, 27.4);
  assert.equal(context.apparentTemperatureC, 29.1);
});

test("缺城市或接口失败只产生 Qwen context，不产生固定弹幕", async () => {
  let fetchCount = 0;
  const service = new WeatherService({
    fetch: async () => {
      fetchCount += 1;
      throw new Error("offline");
    },
  });
  const missing = await service.getContext("天气预报");
  assert.equal(fetchCount, 0);
  assert.equal(missing.reason, "missing_location");
  assert.match(missing.instruction, /不要编造温度/);

  const failed = await service.getContext("东京天气");
  assert.equal(fetchCount, 1);
  assert.equal(failed.reason, "weather_lookup_failed");
  assert.match(failed.instruction, /不要编造温度/);
});

test("天气数据进 Qwen，最终 @ 回复由 Qwen 生成并走自动发送队列", async () => {
  const modelCalls = [];
  const sent = [];
  const localAiClient = {
    getState: () => ({ enabled: true, available: true, provider: "fake", model: "qwen-test" }),
    async generateReply(input) {
      modelCalls.push(input);
      return `QWEN实时答案${input.context.realtimeWeather.temperatureC}℃`;
    },
  };
  const weatherService = {
    getState: () => ({ enabled: true, available: true }),
    async getContext() {
      return {
        intent: "current_weather",
        available: true,
        source: "Open-Meteo",
        requestedLocation: "东京",
        temperatureC: 27.4,
        apparentTemperatureC: 29.1,
      };
    },
  };
  const browserController = {
    getState: () => ({ ready: true }),
    async send(text) {
      sent.push(text);
      return { ok: true, sentText: text };
    },
  };
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: false,
    sendToBili: true,
    browserAuto: true,
    browserController,
    localAiClient,
    weatherService,
    biliMaxChars: 40,
    config: {
      history: { enabled: false },
      localAi: { enabled: true, maxChars: 40 },
      modules: { ai: { enabled: true }, autoSend: { enabled: true } },
      automation: { enabled: true, humanTiming: { enabled: false } },
      rules: [],
    },
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, title: "测试直播间", liveStatus: 1 };
  runtime.ensureVisibleEngines();
  runtime.handleIncomingChat({ userName: "小明", displayUserName: "小明", text: "东京多少度" });
  await waitFor(() => sent.length === 1);

  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].requireModel, true);
  assert.equal(modelCalls[0].fallback, "");
  assert.equal(modelCalls[0].context.realtimeWeather.temperatureC, 27.4);
  assert.deepEqual(sent, ["@小明 QWEN实时答案27.4℃"]);
  assert.equal(runtime.getQueueSnapshot()[0].status, "sent");
  assert.ok(Array.from(sent[0]).length <= 40);
  runtime.stop("测试结束");
});

test("天气请求未完成时停止机器人，不会追发过期回复", async () => {
  let resolveWeather;
  let modelCalls = 0;
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    localAiClient: {
      getState: () => ({ enabled: true, available: true }),
      async generateReply() {
        modelCalls += 1;
        return "不应该出现";
      },
    },
    weatherService: {
      getState: () => ({ enabled: true }),
      getContext: () => new Promise((resolve) => { resolveWeather = resolve; }),
    },
    config: {
      history: { enabled: false },
      localAi: { enabled: true },
      modules: { ai: { enabled: true }, autoSend: { enabled: true } },
      automation: { enabled: true },
      rules: [],
    },
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1 };
  runtime.ensureVisibleEngines();
  let actionCount = 0;
  runtime.on("action", () => { actionCount += 1; });
  runtime.handleIncomingChat({ userName: "小明", text: "东京天气" });
  await waitFor(() => typeof resolveWeather === "function");
  runtime.stop("紧急停止");
  resolveWeather({ available: true, temperatureC: 27.4 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(modelCalls, 0);
  assert.equal(actionCount, 0);
});
