"use strict";

const DEFAULT_SYSTEM_PROMPT = [
  "你是 B站娱乐主播的中文直播间小助手，不是带货客服。",
  "最高优先级：只针对观众当前这条弹幕直接回答，问什么答什么；信息不足就简短追问。",
  "历史对话只能用于理解‘这个’、‘那个’、‘继续’等指代，绝不能覆盖或转移当前弹幕。",
  "不要复读昵称、不要转移话题、不要擅自玩梗，也不要把闲聊当成问题答案。",
  "除非观众自己先提，否则禁止使用家人们谁懂啊、电子宠物、打工人、老板、加鸡腿等尴尬套话。",
  "温度、天气等实时数值只能来自【实时数据（必须使用）】里明确给出的 realtimeWeather；任何情况下没有这份数据都绝不给出具体温度数值，不要编造。",
  "不编造主播行程、隐私、关系或活动结果，不输出攻击性、低俗或敏感内容。",
  "只输出可直接发到公屏的一句简短回复，不加引号、解释或思考过程。",
].join("");

const SHORTEN_SYSTEM_PROMPT = [
  "你是直播回复的压缩助手，只负责把一句待发送的回复改得更短。",
  "不回答问题、不新增信息、不改变原意，只输出压缩后的一句话，不加引号或解释。",
].join("");

const CONTEXT_CHAR_BUDGET = 1800;

const CONTEXT_ALLOWED_KEYS = new Set(["instruction", "realtimeWeather", "conversationMemory"]);

const DEFAULT_LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function finiteOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeProvider(value = "ollama") {
  const provider = String(value || "ollama").trim().toLowerCase();
  if (provider === "ollama") return "ollama";
  if (["openai", "openai-compatible", "openai_compatible"].includes(provider)) {
    return "openai-compatible";
  }
  throw new Error(`不支持的本地 AI 服务：${provider || "empty"}`);
}

function defaultBaseUrl(provider) {
  return provider === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:1234";
}

function defaultModel(provider) {
  return provider === "ollama" ? "qwen2.5:3b" : "local-model";
}

function normalizeHostname(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "");
}

function validateBaseUrl(value, allowedHosts = []) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("本地 AI 地址无效");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("本地 AI 地址只能使用 http 或 https");
  }
  if (url.username || url.password) {
    throw new Error("本地 AI 地址不能包含账号或密码");
  }
  const allowed = new Set([
    ...DEFAULT_LOCAL_HOSTS,
    ...[].concat(allowedHosts || []).map(normalizeHostname).filter(Boolean),
  ]);
  const hostname = normalizeHostname(url.hostname);
  if (!allowed.has(hostname)) {
    throw new Error(`本地 AI 默认只允许 localhost、127.0.0.1 或 ::1，已拒绝 ${hostname}`);
  }
  return url;
}

function endpointUrl(baseUrl, provider) {
  const path = provider === "ollama" ? "/api/chat" : "/v1/chat/completions";
  return new URL(path, `${baseUrl.origin}/`).toString();
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item : item?.text || item?.content || ""))
      .filter(Boolean)
      .join(" ");
  }
  return "";
}

function cleanReply(value, maxChars = 40) {
  let text = contentText(value)
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*(?:assistant|reply|助手|回复)\s*[:：]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“‘`]+|["'”’`]+$/g, "")
    .trim();
  const limit = Math.max(1, finiteOption(maxChars || 40, 40));
  const chars = Array.from(text);
  if (chars.length > limit) text = chars.slice(0, limit).join("");
  return text;
}

function truncateReply(value, maxChars = 40, preservePrefix = "") {
  const limit = Math.max(1, finiteOption(maxChars || 40, 40));
  const prefix = String(preservePrefix || "").replace(/\s+/g, " ").trim();
  let text = cleanReply(value, 2000);
  if (prefix) {
    text = text.startsWith(prefix) ? text : `${prefix} ${text}`.trim();
  }
  const chars = Array.from(text);
  if (chars.length <= limit) return text;
  if (!prefix) return `${chars.slice(0, Math.max(1, limit - 1)).join("")}…`;
  const prefixChars = Array.from(prefix);
  if (prefixChars.length + 1 >= limit) {
    // 前缀放不下时放弃保留前缀，避免把 @昵称 拦腰截断发到公屏
    const body = text.slice(prefix.length).replace(/^\s+/, "");
    const bodyChars = Array.from(body);
    if (!bodyChars.length) return chars.slice(0, Math.max(1, limit - 1)).join("") + "…";
    return bodyChars.length <= limit
      ? body
      : `${bodyChars.slice(0, Math.max(1, limit - 1)).join("")}…`;
  }
  // 保留前缀与正文之间的原始分隔，不额外插入空格
  const rest = Array.from(text.slice(prefix.length));
  const restBudget = Math.max(1, limit - prefixChars.length - 1);
  return `${prefix}${rest.slice(0, restBudget).join("")}…`;
}

function codePointLength(value = "") {
  return Array.from(String(value || "")).length;
}

function shrinkJsonContext(value, budget) {
  let clone;
  try {
    clone = JSON.parse(JSON.stringify(value));
  } catch {
    return "";
  }
  if (clone === undefined || clone === null) return "";
  if (typeof clone !== "object") {
    return Array.from(String(clone).replace(/\s+/g, " ").trim()).slice(0, budget).join("");
  }
  const render = () => JSON.stringify(clone).replace(/\s+/g, " ").trim();
  const fits = () => codePointLength(render()) <= budget;
  if (fits()) return render();
  if (Array.isArray(clone)) {
    while (clone.length && !fits()) clone.shift();
    return clone.length && fits() ? render() : "";
  }
  // 超预算时按整段丢弃（先丢最旧历史，再丢整个键），避免提示词里出现被拦腰切断的 JSON
  const memory = clone.conversationMemory;
  if (memory && typeof memory === "object" && !Array.isArray(memory)) {
    for (const key of ["recentRoomChats", "sameViewerTurns"]) {
      const list = memory[key];
      if (!Array.isArray(list)) continue;
      while (list.length && !fits()) list.shift();
      if (!list.length) delete memory[key];
    }
    if (!Object.keys(memory).length) delete clone.conversationMemory;
    if (fits()) return render();
  }
  const keys = Object.keys(clone);
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    if (fits()) break;
    if (keys[index] === "instruction") continue;
    delete clone[keys[index]];
  }
  return fits() ? render() : "";
}

function contextText(value, maxChars = CONTEXT_CHAR_BUDGET) {
  if (value === undefined || value === null || value === "") return "";
  const budget = Math.max(0, Number(maxChars) || 0);
  if (typeof value === "object") return shrinkJsonContext(value, budget);
  return Array.from(String(value).replace(/\s+/g, " ").trim()).slice(0, budget).join("");
}

function prepareConversationContext(input = {}) {
  const sourceContext = input.context;
  if (!sourceContext || typeof sourceContext !== "object" || Array.isArray(sourceContext)) {
    return { context: sourceContext, sameViewerTurns: [], realtimeWeather: null };
  }
  const sourceMemory = sourceContext.conversationMemory;
  const sameViewerTurns = Array.isArray(sourceMemory?.sameViewerTurns)
    ? sourceMemory.sameViewerTurns
    : [];
  // 只放行已知键，防止调用方把房间标题等杂项塞进背景通道
  const nextContext = {};
  for (const key of Object.keys(sourceContext)) {
    if (CONTEXT_ALLOWED_KEYS.has(key)) nextContext[key] = sourceContext[key];
  }
  const realtimeWeather =
    nextContext.realtimeWeather === undefined ? null : nextContext.realtimeWeather;
  delete nextContext.realtimeWeather;
  if (sourceMemory && typeof sourceMemory === "object" && !Array.isArray(sourceMemory)) {
    const nextMemory = { ...sourceMemory };
    delete nextMemory.sameViewerTurns;
    if (Object.keys(nextMemory).length) nextContext.conversationMemory = nextMemory;
    else delete nextContext.conversationMemory;
  }
  return { context: nextContext, sameViewerTurns, realtimeWeather };
}

function buildRequestMessages(input = {}, systemPrompt = DEFAULT_SYSTEM_PROMPT) {
  const prepared = prepareConversationContext(input);
  const totalBudget = Math.max(
    0,
    finiteOption(input.contextBudget || CONTEXT_CHAR_BUDGET, CONTEXT_CHAR_BUDGET)
  );
  const retryGuidance = contextText(input.retryGuidance, 500);
  const auxiliaryBudget = Math.max(0, totalBudget - codePointLength(retryGuidance));
  const realtimeWeather = contextText(prepared.realtimeWeather, Math.min(auxiliaryBudget, 600));
  const backgroundBudget = Math.max(0, auxiliaryBudget - codePointLength(realtimeWeather));
  const rawBackground = contextText(prepared.context, backgroundBudget);
  const reservedBackground = Math.min(codePointLength(rawBackground), 600);
  const historyBudget = Math.max(0, backgroundBudget - reservedBackground);
  const selectedTurns = [];
  let historyChars = 0;
  for (let index = prepared.sameViewerTurns.length - 1; index >= 0; index -= 1) {
    const turn = prepared.sameViewerTurns[index] || {};
    const user = contextText(turn.viewer ?? turn.user ?? turn.userText, 400);
    const assistant = contextText(turn.assistant ?? turn.assistantText, 400);
    if (!user || !assistant) continue;
    const size = codePointLength(user) + codePointLength(assistant);
    if (historyChars + size > historyBudget) break;
    selectedTurns.unshift({ user, assistant });
    historyChars += size;
  }
  const background = contextText(
    prepared.context,
    Math.max(0, backgroundBudget - historyChars)
  );
  const historyMessages = selectedTurns.flatMap((turn) => [
    { role: "user", content: turn.user },
    { role: "assistant", content: turn.assistant },
  ]);
  return [
    { role: "system", content: systemPrompt },
    ...historyMessages,
    {
      role: "user",
      content: buildUserMessage({
        ...input,
        context: background,
        realtimeWeather,
        retryGuidance,
      }),
    },
  ];
}

function buildUserMessage(input = {}) {
  const userName = String(input.userName || input.user || "观众").replace(/\s+/g, " ").trim().slice(0, 40);
  const message = Array.from(String(input.message || input.text || "").replace(/\s+/g, " ").trim())
    .slice(0, 400)
    .join("");
  const context = contextText(input.context);
  const realtimeWeather = contextText(input.realtimeWeather, 600);
  const retryGuidance = contextText(input.retryGuidance, 500);
  return [
    `【最高优先级】观众弹幕：${message}`,
    `观众昵称：${userName || "观众"}`,
    realtimeWeather ? `【实时数据（必须使用）】${realtimeWeather}` : "",
    context ? `【仅用于指代的实时事实/历史】${context}` : "",
    retryGuidance ? `【重写要求】${retryGuidance}` : "",
    "请只回答上面的当前弹幕，给出一句可直接发送的中文回复。",
  ]
    .filter(Boolean)
    .join("\n");
}

function responseError(payload, status) {
  return (
    payload?.error?.message ||
    payload?.error ||
    payload?.message ||
    payload?.msg ||
    `HTTP ${status || "error"}`
  );
}

class LocalAiClient {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.fetchImpl = options.fetch || options.fetchImpl || globalThis.fetch;
    this.timeoutMs = Math.max(1, finiteOption(options.timeoutMs || 20000, 20000));
    this.maxChars = Math.max(1, finiteOption(options.maxChars || 40, 40));
    this.contextBudget = Math.max(
      0,
      finiteOption(options.contextBudget || CONTEXT_CHAR_BUDGET, CONTEXT_CHAR_BUDGET)
    );
    this.systemPrompt = String(options.systemPrompt || DEFAULT_SYSTEM_PROMPT).trim();
    this.apiKey = String(options.apiKey || "").trim();
    this.temperature = finiteOption(options.temperature, 0.7);
    this.think = options.think === true;
    this.numPredict = Math.max(8, finiteOption(options.numPredict || 80, 80));
    this.numCtx = Math.max(512, finiteOption(options.numCtx || options.num_ctx || 4096, 4096));
    this.keepAlive = String(options.keepAlive || "30m");
    this.endpointError = "";

    try {
      this.provider = normalizeProvider(options.provider || "ollama");
      this.model = String(options.model || defaultModel(this.provider)).trim();
      this.baseUrl = validateBaseUrl(
        options.baseUrl || options.endpoint || defaultBaseUrl(this.provider),
        options.allowedHosts || []
      );
    } catch (error) {
      this.provider = ["openai", "openai-compatible", "openai_compatible"].includes(
        String(options.provider || "").toLowerCase()
      )
        ? "openai-compatible"
        : "ollama";
      this.model = String(options.model || defaultModel(this.provider)).trim();
      this.baseUrl = null;
      this.endpointError = error.message || String(error);
    }

    this.available = false;
    this.lastError = this.endpointError;
    this.lastSuccessAt = 0;
    this.lastProbeAt = 0;
  }

  getState() {
    return {
      enabled: this.enabled,
      provider: this.provider,
      model: this.model,
      numCtx: this.numCtx,
      available: this.available,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
    };
  }

  // 服务级 /api/tags 探测比生成请求更轻；托管启动时用它同步公开可用状态。
  // 这里只接受已脱敏的服务状态，不保存 endpoint、header 或凭据。
  applyServiceProbe(serviceState = {}) {
    const status = String(serviceState.status || "");
    const checkedAt = Number(serviceState.lastCheckedAt || 0);
    if (checkedAt) this.lastProbeAt = checkedAt;
    if (!this.enabled) {
      this.available = false;
      return this.getState();
    }
    if (status === "ready") {
      const probedModel = String(serviceState.model || "").trim();
      if (probedModel && probedModel !== this.model) {
        this.available = false;
        this.lastError = `本地 AI 探测模型 ${probedModel} 与当前模型 ${this.model} 不一致`;
      } else {
        this.available = true;
        this.lastError = "";
      }
    } else if (status === "error") {
      this.available = false;
      this.lastError = String(serviceState.message || "本地 AI 服务不可用");
    } else if (status === "skipped") {
      this.available = false;
      // 非 Ollama provider 或远程 provider 不由本机服务管理器接管；
      // skipped 不能被误写成推理故障，真正请求仍按各 provider 自己的结果更新状态。
      this.lastError = "";
    }
    return this.getState();
  }

  async generateReply(input = {}) {
    if (typeof input === "string") input = { message: input };
    const maxChars = Math.max(1, finiteOption(input.maxChars || this.maxChars, this.maxChars));
    const fallback = cleanReply(input.fallback || "", maxChars);
    const requireModel = input.requireModel === true;
    const unavailable = (message) => {
      this.available = false;
      if (message) this.lastError = message;
      if (requireModel) throw new Error(message || "本地 AI 不可用");
      return fallback;
    };

    if (!this.enabled) {
      this.available = false;
      if (requireModel) return unavailable("本地 AI 已关闭");
      return fallback;
    }
    if (this.endpointError || !this.baseUrl) {
      return unavailable(this.endpointError || "本地 AI 地址不可用");
    }
    if (typeof this.fetchImpl !== "function") {
      return unavailable("当前环境没有可用的 fetch");
    }
    if (!String(input.message || input.text || "").trim()) {
      return unavailable("观众弹幕为空");
    }

    try {
      const reply = await this.request(
        buildRequestMessages({ contextBudget: this.contextBudget, ...input }, this.systemPrompt)
      );
      let cleaned = cleanReply(reply, 2000);
      if (!cleaned) throw new Error("本地 AI 返回了空内容");
      if (Array.from(cleaned).length > maxChars) {
        cleaned = await this.shortenReply({ text: cleaned, maxChars });
      }
      this.available = true;
      this.lastError = "";
      this.lastSuccessAt = Date.now();
      return cleaned;
    } catch (error) {
      this.available = false;
      this.lastError = error.message || String(error);
      if (requireModel) throw error;
      return fallback;
    }
  }

  reply(message, options = {}) {
    return this.generateReply(
      message && typeof message === "object" ? message : { ...options, message }
    );
  }

  async shortenReply(input = {}) {
    if (typeof input === "string") input = { text: input };
    const maxChars = Math.max(1, finiteOption(input.maxChars || this.maxChars, this.maxChars));
    const preservePrefix = String(input.preservePrefix || "").replace(/\s+/g, " ").trim();
    const source = cleanReply(input.text || input.message || "", 2000);
    const fallback = truncateReply(input.fallback || source, maxChars, preservePrefix);
    if (!source) return fallback;
    if (!this.enabled || this.endpointError || !this.baseUrl || typeof this.fetchImpl !== "function") {
      return fallback;
    }
    const instruction = [
      `请把下面这句待发送的回复压缩到不超过 ${maxChars} 个字符。`,
      "保留核心信息，语气自然，不要解释，只输出压缩后的结果。",
      preservePrefix ? `必须原样保留开头的“${preservePrefix}”。` : "",
      `原文：${source}`,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      let shortened = cleanReply(
        await this.request([
          { role: "system", content: SHORTEN_SYSTEM_PROMPT },
          { role: "user", content: instruction },
        ]),
        2000
      );
      if (!shortened) return fallback;
      if (preservePrefix && !shortened.startsWith(preservePrefix)) {
        shortened = `${preservePrefix} ${shortened}`;
      }
      this.available = true;
      this.lastError = "";
      this.lastSuccessAt = Date.now();
      return Array.from(shortened).length <= maxChars
        ? shortened
        : truncateReply(shortened, maxChars, preservePrefix);
    } catch (error) {
      this.available = false;
      this.lastError = error.message || String(error);
      return fallback;
    }
  }

  async request(userMessage) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    const messages = Array.isArray(userMessage)
      ? userMessage
      : [
          { role: "system", content: this.systemPrompt },
          { role: "user", content: userMessage },
        ];
    const body =
      this.provider === "ollama"
        ? {
            model: this.model,
            stream: false,
            think: this.think,
            keep_alive: this.keepAlive,
            options: {
              temperature: this.temperature,
              num_predict: this.numPredict,
              num_ctx: this.numCtx,
            },
            messages,
          }
        : {
            model: this.model,
            stream: false,
            temperature: this.temperature,
            max_tokens: this.numPredict,
            messages,
          };
    const headers = { "Content-Type": "application/json" };
    if (this.provider === "openai-compatible" && this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    try {
      const response = await this.fetchImpl(endpointUrl(this.baseUrl, this.provider), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let payload = null;
      let invalidJson = false;
      try {
        payload = await response.json();
      } catch {
        invalidJson = true;
      }
      if (!response.ok) throw new Error(String(responseError(payload, response.status)));
      if (invalidJson) throw new Error(`本地 AI 返回的不是 JSON（HTTP ${response.status}）`);
      return this.provider === "ollama"
        ? contentText(payload?.message?.content || payload?.response)
        : contentText(payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text);
    } catch (error) {
      if (timedOut || controller.signal.aborted) {
        throw new Error(`本地 AI 请求超过 ${this.timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = LocalAiClient;
module.exports.LocalAiClient = LocalAiClient;
module.exports.DEFAULT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT;
module.exports.SHORTEN_SYSTEM_PROMPT = SHORTEN_SYSTEM_PROMPT;
module.exports.CONTEXT_CHAR_BUDGET = CONTEXT_CHAR_BUDGET;
module.exports.cleanReply = cleanReply;
module.exports.truncateReply = truncateReply;
module.exports.validateBaseUrl = validateBaseUrl;
module.exports.buildRequestMessages = buildRequestMessages;
module.exports.prepareConversationContext = prepareConversationContext;
