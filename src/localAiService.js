"use strict";

const { spawn } = require("node:child_process");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function normalizeHost(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function safeModelName(value = "") {
  return String(value || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 160);
}

function finitePositive(value, fallback, minimum = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, number) : fallback;
}

function parseLoopbackEndpoint(value = "") {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return { ok: false, message: "Ollama 地址无效" };
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { ok: false, message: "Ollama 地址只能使用 http 或 https" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, message: "Ollama 地址不能包含账号或密码" };
  }
  if (!LOOPBACK_HOSTS.has(normalizeHost(parsed.hostname))) {
    return { ok: false, message: "自动恢复只支持本机 Ollama（localhost/127.0.0.1/::1）" };
  }
  return {
    ok: true,
    baseUrl: new URL(`${parsed.origin}/`),
  };
}

function modelNames(payload = {}) {
  return Array.isArray(payload.models)
    ? payload.models
        .flatMap((item) => [item?.name, item?.model])
        .map(safeModelName)
        .filter(Boolean)
    : [];
}

function hasConfiguredModel(names = [], configuredModel = "") {
  const wanted = safeModelName(configuredModel);
  if (!wanted) return false;
  if (names.includes(wanted)) return true;
  // Ollama 对未显式写 tag 的名称默认使用 latest。
  return !wanted.includes(":") && names.includes(`${wanted}:latest`);
}

class LocalAiService {
  constructor(options = {}, dependencies = {}) {
    this.options = { ...(options || {}) };
    this.fetchImpl = dependencies.fetch || dependencies.fetchImpl || globalThis.fetch;
    this.spawnImpl = dependencies.spawn || spawn;
    this.platform = dependencies.platform || process.platform;
    this.now = dependencies.now || Date.now;
    this.sleep =
      dependencies.sleep ||
      ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0))));
    this.pollIntervalMs = finitePositive(dependencies.pollIntervalMs, 500, 50);
    this.probeTimeoutMs = finitePositive(dependencies.probeTimeoutMs, 1500, 250);
    this.inFlight = null;
    this.generation = 0;
    this.state = {
      status: "idle",
      message: "尚未检查本地 AI",
      model: safeModelName(this.options.model),
      lastCheckedAt: 0,
    };
  }

  getState() {
    return { ...this.state };
  }

  reconfigure(options = {}) {
    this.generation += 1;
    this.inFlight = null;
    this.options = { ...(options || {}) };
    this.state = {
      status: this.options.enabled === true ? "idle" : "skipped",
      message: this.options.enabled === true ? "本地 AI 配置已更新，等待检查" : "本地 AI 未启用",
      model: safeModelName(this.options.model),
      lastCheckedAt: Number(this.now()) || Date.now(),
    };
    return this.getState();
  }

  setState(status, message, generation = this.generation) {
    if (generation !== this.generation) return this.getState();
    this.state = {
      status,
      message: String(message || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 300),
      model: safeModelName(this.options.model),
      lastCheckedAt: Number(this.now()) || Date.now(),
    };
    return this.getState();
  }

  ensureReady() {
    if (this.inFlight) return this.inFlight;
    const generation = this.generation;
    const pending = this.runEnsureReady(generation)
      .catch((error) =>
        this.setState("error", `本地 AI 检查失败：${error?.message || String(error)}`, generation)
      )
      .finally(() => {
        if (this.inFlight === pending) this.inFlight = null;
      });
    this.inFlight = pending;
    return pending;
  }

  async runEnsureReady(generation = this.generation) {
    const enabled = this.options.enabled === true;
    const provider = String(this.options.provider || "ollama").trim().toLowerCase();
    if (!enabled) return this.setState("skipped", "本地 AI 未启用", generation);
    if (provider !== "ollama") {
      return this.setState("skipped", "一键自动恢复仅支持本地 Ollama", generation);
    }
    const model = safeModelName(this.options.model);
    if (!model) return this.setState("error", "未配置 Ollama 模型", generation);
    const endpoint = parseLoopbackEndpoint(
      this.options.endpoint || this.options.baseUrl || "http://127.0.0.1:11434"
    );
    if (!endpoint.ok) return this.setState("skipped", endpoint.message, generation);
    if (typeof this.fetchImpl !== "function") {
      return this.setState("error", "当前环境没有可用的 fetch，无法检查 Ollama", generation);
    }

    this.setState("checking", `正在检查 Ollama 模型 ${model}`, generation);
    const firstProbe = await this.probe(endpoint.baseUrl, model);
    if (generation !== this.generation) return this.getState();
    if (firstProbe.ready) return this.setState("ready", `Ollama 与模型 ${model} 已就绪`, generation);
    if (firstProbe.reachable) return this.setState("error", firstProbe.message, generation);
    if (this.options.autoStart !== true) {
      return this.setState("error", "Ollama 不可达，自动启动已关闭", generation);
    }
    if (this.platform !== "darwin") {
      return this.setState("error", "Ollama 不可达；当前系统不支持自动打开 Ollama 应用", generation);
    }

    this.setState("checking", "Ollama 未运行，正在自动打开", generation);
    await this.launchOllama();
    if (generation !== this.generation) return this.getState();
    const timeoutMs = finitePositive(this.options.startupTimeoutMs, 15000, 1000);
    const deadline = Number(this.now()) + timeoutMs;
    let remainingPolls = Math.ceil(timeoutMs / this.pollIntervalMs) + 1;
    do {
      remainingPolls -= 1;
      const nextProbe = await this.probe(endpoint.baseUrl, model);
      if (generation !== this.generation) return this.getState();
      if (nextProbe.ready) {
        return this.setState("ready", `Ollama 已自动启动，模型 ${model} 已就绪`, generation);
      }
      // 服务已经上线但模型缺失/接口异常时立即结束，不 pull，也不继续假等。
      if (nextProbe.reachable) return this.setState("error", nextProbe.message, generation);
      const remainingMs = deadline - Number(this.now());
      if (remainingMs <= 0) break;
      await this.sleep(Math.min(this.pollIntervalMs, remainingMs));
    } while (remainingPolls > 0 && Number(this.now()) < deadline);
    return this.setState("error", `Ollama 打开后 ${timeoutMs}ms 内仍不可用`, generation);
  }

  async launchOllama() {
    let child;
    try {
      child = this.spawnImpl("open", ["-gj", "-a", "Ollama"], {
        stdio: "ignore",
        detached: true,
        shell: false,
      });
    } catch (error) {
      throw new Error(`无法打开 Ollama：${error.message || String(error)}`);
    }
    child?.on?.("error", () => {});
    child?.unref?.();
  }

  async probe(baseUrl, model) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.probeTimeoutMs);
    try {
      const response = await this.fetchImpl(new URL("api/tags", baseUrl).toString(), {
        method: "GET",
        signal: controller.signal,
        headers: { Accept: "application/json" },
      });
      if (!response?.ok) {
        return {
          ready: false,
          reachable: true,
          message: `Ollama 模型检查返回 HTTP ${Number(response?.status || 0) || "error"}`,
        };
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        return {
          ready: false,
          reachable: true,
          message: "Ollama /api/tags 返回的不是有效 JSON",
        };
      }
      const names = modelNames(payload);
      if (!hasConfiguredModel(names, model)) {
        return {
          ready: false,
          reachable: true,
          message: `Ollama 已运行，但未安装模型 ${model}（不会自动下载）`,
        };
      }
      return { ready: true, reachable: true, message: "" };
    } catch (error) {
      return {
        ready: false,
        reachable: false,
        message: timedOut
          ? `Ollama 探测超过 ${this.probeTimeoutMs}ms`
          : `Ollama 不可达：${error?.message || String(error)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = LocalAiService;
module.exports.LocalAiService = LocalAiService;
module.exports.parseLoopbackEndpoint = parseLoopbackEndpoint;
module.exports.hasConfiguredModel = hasConfiguredModel;
