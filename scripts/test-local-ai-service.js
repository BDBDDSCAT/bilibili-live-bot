"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_CONFIG, deepMerge } = require("../src/configLoader");
const LocalAiClient = require("../src/localAiClient");
const LocalAiService = require("../src/localAiService");
const { createWebApp } = require("../src/webServer");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

function enabledConfig(overrides = {}) {
  return {
    enabled: true,
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen3.5:4b",
    autoStart: true,
    startupTimeoutMs: 15000,
    ...overrides,
  };
}

test("Ollama 已在线且模型存在时直接 ready", async () => {
  const calls = [];
  const service = new LocalAiService(enabledConfig(), {
    fetch: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse({ models: [{ name: "qwen3.5:4b" }] });
    },
    spawn: () => {
      throw new Error("不应启动 Ollama");
    },
    now: () => 1000,
  });

  const state = await service.ensureReady();

  assert.strictEqual(state.status, "ready");
  assert.strictEqual(state.model, "qwen3.5:4b");
  assert.strictEqual(state.lastCheckedAt, 1000);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, "http://127.0.0.1:11434/api/tags");
  assert.strictEqual(calls[0].options.method, "GET");
});

test("Ollama 不可达时 macOS 无 shell 启动并轮询到 ready", async () => {
  let fetchCount = 0;
  const spawnCalls = [];
  const child = { on: () => child, unref: () => {} };
  const service = new LocalAiService(enabledConfig(), {
    fetch: async () => {
      fetchCount += 1;
      if (fetchCount === 1) throw new Error("ECONNREFUSED");
      return jsonResponse({ models: [{ model: "qwen3.5:4b" }] });
    },
    spawn: (...args) => {
      spawnCalls.push(args);
      return child;
    },
    platform: "darwin",
    now: () => 2000,
    sleep: async () => {},
  });

  const state = await service.ensureReady();

  assert.strictEqual(state.status, "ready");
  assert.match(state.message, /自动启动/);
  assert.strictEqual(fetchCount, 2);
  assert.strictEqual(spawnCalls.length, 1);
  assert.deepStrictEqual(spawnCalls[0][0], "open");
  assert.deepStrictEqual(spawnCalls[0][1], ["-gj", "-a", "Ollama"]);
  assert.deepStrictEqual(spawnCalls[0][2], {
    stdio: "ignore",
    detached: true,
    shell: false,
  });
});

test("Ollama 在线但配置模型缺失时清晰报错且不启动、不 pull", async () => {
  let spawnCount = 0;
  const service = new LocalAiService(enabledConfig(), {
    fetch: async () => jsonResponse({ models: [{ name: "qwen3:4b" }] }),
    spawn: () => {
      spawnCount += 1;
    },
  });

  const state = await service.ensureReady();

  assert.strictEqual(state.status, "error");
  assert.match(state.message, /未安装模型 qwen3\.5:4b/);
  assert.match(state.message, /不会自动下载/);
  assert.strictEqual(spawnCount, 0);
});

test("远程 endpoint 被 skipped，不探测也不启动", async () => {
  let touched = false;
  const service = new LocalAiService(
    enabledConfig({ endpoint: "https://ai.example.com:11434/secret?token=hidden" }),
    {
      fetch: async () => {
        touched = true;
      },
      spawn: () => {
        touched = true;
      },
    }
  );

  const state = await service.ensureReady();

  assert.strictEqual(state.status, "skipped");
  assert.match(state.message, /只支持本机 Ollama/);
  assert.strictEqual(touched, false);
  assert.deepStrictEqual(Object.keys(state).sort(), [
    "lastCheckedAt",
    "message",
    "model",
    "status",
  ]);
  assert.doesNotMatch(JSON.stringify(state), /hidden|example\.com/);
});

test("本地 AI 禁用时 skipped，不探测也不启动", async () => {
  let touched = false;
  const service = new LocalAiService(enabledConfig({ enabled: false }), {
    fetch: async () => {
      touched = true;
    },
    spawn: () => {
      touched = true;
    },
  });

  const state = await service.ensureReady();

  assert.strictEqual(state.status, "skipped");
  assert.match(state.message, /未启用/);
  assert.strictEqual(touched, false);
});

test("非 Ollama provider 不进入自动恢复", async () => {
  let touched = false;
  const service = new LocalAiService(enabledConfig({ provider: "openai-compatible" }), {
    fetch: async () => {
      touched = true;
    },
    spawn: () => {
      touched = true;
    },
  });

  const state = await service.ensureReady();

  assert.strictEqual(state.status, "skipped");
  assert.match(state.message, /仅支持本地 Ollama/);
  assert.strictEqual(touched, false);
});

test("LocalAiClient 的公开 available 跟随服务模型探测", () => {
  const client = new LocalAiClient(enabledConfig());
  client.applyServiceProbe({
    status: "ready",
    message: "已就绪",
    model: "qwen3.5:4b",
    lastCheckedAt: 123,
  });
  assert.strictEqual(client.getState().available, true);
  assert.strictEqual(client.getState().lastError, "");

  client.applyServiceProbe({
    status: "error",
    message: "Ollama 已退出",
    model: "qwen3.5:4b",
    lastCheckedAt: 456,
  });
  assert.strictEqual(client.getState().available, false);
  assert.strictEqual(client.getState().lastError, "Ollama 已退出");
});

test("托管启动先检查 AI，AI 失败不挡 B 站，且可用独立接口重试", async () => {
  class FakeBrowserController extends EventEmitter {
    constructor() {
      super();
      this.started = 0;
      this.state = { ready: false, status: "waiting_login", roomId: 0 };
    }

    getState() {
      return { ...this.state };
    }

    async start({ room }) {
      this.started += 1;
      this.state.roomUrl = room;
      this.state.roomId = Number(String(room).match(/(\d+)$/)?.[1] || 0);
      return this.getState();
    }

    async emergencyStop() {}
    async stop() {}
  }

  const browserController = new FakeBrowserController();
  let ensureCount = 0;
  let serviceState = {
    status: "idle",
    message: "尚未检查",
    model: "qwen3.5:4b",
    lastCheckedAt: 0,
  };
  const localAiService = {
    getState: () => ({ ...serviceState }),
    ensureReady: async () => {
      ensureCount += 1;
      serviceState =
        ensureCount === 1
          ? {
              status: "error",
              message: "Ollama 暂时不可达",
              model: "qwen3.5:4b",
              lastCheckedAt: 10,
            }
          : {
              status: "ready",
              message: "Ollama 与模型已就绪",
              model: "qwen3.5:4b",
              lastCheckedAt: 20,
            };
      return { ...serviceState };
    },
  };
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bilibot-ai-service-web-"));
  const config = deepMerge(DEFAULT_CONFIG, {
    room: "https://live.bilibili.com/20002",
    localAi: enabledConfig(),
    history: { dir: "state" },
  });
  const app = createWebApp({ rootDir, config, browserController, localAiService });
  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const invalidResponse = await fetch(`${baseUrl}/api/browser-control/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "not-a-room" }),
    });
    assert.strictEqual(invalidResponse.status, 400);
    assert.strictEqual(ensureCount, 0);
    assert.strictEqual(browserController.started, 0);

    const browserResponse = await fetch(`${baseUrl}/api/browser-control/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ room: "20002" }),
    });
    const browserPayload = await browserResponse.json();
    assert.strictEqual(browserResponse.status, 200);
    assert.strictEqual(browserPayload.ok, true);
    assert.strictEqual(browserController.started, 1);
    assert.strictEqual(ensureCount, 1);
    assert.strictEqual(browserPayload.snapshot.localAiService.status, "error");
    assert.deepStrictEqual(Object.keys(browserPayload.snapshot.localAiService).sort(), [
      "lastCheckedAt",
      "message",
      "model",
      "status",
    ]);

    const retryResponse = await fetch(`${baseUrl}/api/local-ai/start`, { method: "POST" });
    const retryPayload = await retryResponse.json();
    assert.strictEqual(retryResponse.status, 200);
    assert.strictEqual(retryPayload.ok, true);
    assert.strictEqual(ensureCount, 2);
    assert.strictEqual(retryPayload.localAiService.status, "ready");
    assert.strictEqual(retryPayload.snapshot.localAiService.status, "ready");
  } finally {
    await app.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
