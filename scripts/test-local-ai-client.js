"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const LocalAiClient = require("../src/localAiClient");
const { BotRuntime } = require("../src/botRuntime");
const liveConfig = require("../config.example.json");

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload;
    },
  };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("等待测试条件超时");
}

test("直播 Qwen 使用 8192 上下文和低温度", () => {
  assert.equal(liveConfig.localAi.numCtx, 8192);
  assert.equal(liveConfig.localAi.temperature, 0.4);
});

test("Ollama /api/chat uses the Chinese live prompt and cleans the reply", async () => {
  let request = null;
  const requests = [];
  const client = new LocalAiClient({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434/some/path",
    model: "qwen-test",
    maxChars: 6,
    fetch: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      requests.push(request);
      return jsonResponse({
        message: {
          content:
            requests.length === 1
              ? "<think>先分析</think>\n回复：欢迎来到直播间！"
              : "欢迎来玩",
        },
      });
    },
  });

  const reply = await client.generateReply({
    userName: "小明",
    message: "今天播什么？",
    context: "轻松聊天",
    fallback: "先聊会儿吧",
  });

  assert.equal(reply, "欢迎来玩");
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, "http://127.0.0.1:11434/api/chat");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].body.model, "qwen-test");
  assert.equal(requests[0].body.stream, false);
  assert.equal(requests[0].body.think, false);
  assert.equal(requests[0].body.options.num_predict, 80);
  assert.equal(requests[0].body.options.num_ctx, 4096);
  assert.equal(requests[0].body.keep_alive, "30m");
  assert.match(requests[0].body.messages[0].content, /娱乐主播/);
  assert.match(requests[0].body.messages[1].content, /观众昵称：小明/);
  assert.match(requests[0].body.messages[1].content, /观众弹幕：今天播什么/);
  assert.match(requests[1].body.messages[1].content, /不超过 6 个字符/);
  assert.deepEqual(client.getState(), {
    enabled: true,
    provider: "ollama",
    model: "qwen-test",
    numCtx: 4096,
    available: true,
    lastError: "",
    lastSuccessAt: client.getState().lastSuccessAt,
  });
  assert.ok(client.getState().lastSuccessAt > 0);
});

test("OpenAI-compatible /v1/chat/completions supports a local bearer token", async () => {
  let request = null;
  const client = new LocalAiClient({
    provider: "openai",
    endpoint: "http://localhost:1234",
    model: "local-chat",
    apiKey: "local-token",
    fetch: async (url, init) => {
      request = { url, init, body: JSON.parse(init.body) };
      return jsonResponse({
        choices: [{ message: { content: "可以呀，今天一起开心玩！" } }],
      });
    },
  });

  const reply = await client.reply("可以加入吗？", { fallback: "欢迎来玩" });

  assert.equal(reply, "可以呀，今天一起开心玩！");
  assert.equal(request.url, "http://localhost:1234/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer local-token");
  assert.equal(request.body.model, "local-chat");
  assert.equal(request.body.stream, false);
  assert.equal(client.getState().provider, "openai-compatible");
  assert.equal(client.getState().available, true);
});

test("Ollama 和 OpenAI 都按 chat roles 传入同观众历史，当前问题只出现一次", async () => {
  for (const provider of ["ollama", "openai-compatible"]) {
    let requestBody = null;
    const client = new LocalAiClient({
      provider,
      endpoint: provider === "ollama" ? "http://127.0.0.1:11434" : "http://localhost:1234",
      model: "qwen-memory",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return provider === "ollama"
          ? jsonResponse({ message: { content: "你刚才说的是紫色。" } })
          : jsonResponse({ choices: [{ message: { content: "你刚才说的是紫色。" } }] });
      },
    });
    const current = "我刚才说最喜欢什么颜色？";
    await client.generateReply({
      userName: "小明",
      message: current,
      context: {
        instruction: "历史只用于指代。",
        realtimeWeather: { available: false, reason: "not_requested" },
        conversationMemory: {
          policy: "从旧到新",
          sameViewerTurns: [
            { viewer: "我最喜欢的颜色是紫色", assistant: "记住了，是紫色。" },
          ],
          recentRoomChats: [{ user: "旁观者", text: "房间里在聊颜色" }],
        },
      },
      retryGuidance: "上一个候选与最近回复重复，请换一种明显不同的说法。",
      requireModel: true,
      maxChars: 40,
    });

    assert.deepEqual(requestBody.messages.map((item) => item.role), [
      "system",
      "user",
      "assistant",
      "user",
    ]);
    assert.equal(requestBody.messages[1].content, "我最喜欢的颜色是紫色");
    assert.equal(requestBody.messages[2].content, "记住了，是紫色。");
    const finalUserMessage = requestBody.messages.at(-1).content;
    assert.match(finalUserMessage, /房间里在聊颜色/);
    assert.equal(finalUserMessage.includes("sameViewerTurns"), false);
    assert.equal(finalUserMessage.includes("我最喜欢的颜色是紫色"), false);
    assert.match(finalUserMessage, /【重写要求】/);
    assert.match(finalUserMessage, /换一种明显不同的说法/);
    const currentOccurrences = requestBody.messages.reduce(
      (count, item) => count + item.content.split(current).length - 1,
      0
    );
    assert.equal(currentOccurrences, 1);
    assert.ok(
      requestBody.messages
        .slice(1)
        .reduce((count, item) => count + Array.from(item.content).length, 0) <= 2400
    );
  }
});

test("baseUrl takes priority over the endpoint alias", async () => {
  let requestedUrl = "";
  const client = new LocalAiClient({
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    endpoint: "http://127.0.0.1:9999",
    fetch: async (url) => {
      requestedUrl = url;
      return jsonResponse({ message: { content: "欢迎来玩" } });
    },
  });

  assert.equal(
    await client.generateReply({ message: "你好", fallback: "你好呀" }),
    "欢迎来玩"
  );
  assert.equal(requestedUrl, "http://127.0.0.1:11434/api/chat");
});

test("remote hosts are rejected without calling fetch and use the fallback", async () => {
  let fetchCount = 0;
  const client = new LocalAiClient({
    provider: "ollama",
    baseUrl: "https://example.com",
    maxChars: 4,
    fetch: async () => {
      fetchCount += 1;
      return jsonResponse({ message: { content: "不应被使用" } });
    },
  });

  const reply = await client.generateReply({ message: "你好", fallback: "备用回复很长" });

  assert.equal(reply, "备用回复");
  assert.equal(fetchCount, 0);
  assert.equal(client.getState().available, false);
  assert.match(client.getState().lastError, /只允许 localhost/);
});

test("timeouts abort the fake request and return the fallback", async () => {
  const client = new LocalAiClient({
    provider: "ollama",
    timeoutMs: 15,
    fetch: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      }),
  });

  const reply = await client.generateReply({ message: "测试超时", fallback: "稍后再试" });

  assert.equal(reply, "稍后再试");
  assert.equal(client.getState().available, false);
  assert.match(client.getState().lastError, /超过 15ms/);
});

test("requireModel fails instead of returning a fixed fallback", async () => {
  const client = new LocalAiClient({
    provider: "ollama",
    fetch: async () => jsonResponse({ error: "qwen unavailable" }, 503),
  });
  await assert.rejects(
    client.generateReply({
      message: "东京多少度",
      fallback: "这句固定话术不能发",
      requireModel: true,
    }),
    /qwen unavailable/
  );
  assert.equal(client.getState().available, false);
});

test("HTTP errors, empty prompts, and disabled mode all fail closed to fallback", async () => {
  const failing = new LocalAiClient({
    provider: "openai-compatible",
    fetch: async () => jsonResponse({ error: { message: "model unavailable" } }, 503),
  });
  assert.equal(
    await failing.generateReply({ message: "你好", fallback: "你好呀" }),
    "你好呀"
  );
  assert.equal(failing.getState().lastError, "model unavailable");

  assert.equal(
    await failing.generateReply({ message: "", fallback: "我先看看" }),
    "我先看看"
  );
  assert.equal(failing.getState().lastError, "观众弹幕为空");

  const disabled = new LocalAiClient({ enabled: false, maxChars: 3 });
  assert.equal(
    await disabled.generateReply({ message: "你好", fallback: "默认回复" }),
    "默认回"
  );
  assert.deepEqual(disabled.getState(), {
    enabled: false,
    provider: "ollama",
    model: "qwen2.5:3b",
    numCtx: 4096,
    available: false,
    lastError: "",
    lastSuccessAt: 0,
  });
});

test("BotRuntime replaces #hey fallback with the local model reply", async () => {
  const calls = [];
  const localAiClient = {
    getState: () => ({ enabled: true, available: true, provider: "fake", model: "tiny" }),
    async generateReply(input) {
      calls.push(input);
      return "本地模型回复";
    },
  };
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    localAiClient,
    config: {
      history: { enabled: false },
      localAi: { enabled: true, maxChars: 36 },
      modules: { ai: { enabled: true }, autoSend: { enabled: false } },
      automation: { enabled: true },
    },
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, title: "测试直播间", liveStatus: 1 };
  const actionPromise = new Promise((resolve) => runtime.once("action", resolve));
  runtime.handleActions(
    [{ type: "command_reply", ruleName: "ai", reply: "内置回复", priority: 90 }],
    { userName: "小明", text: "#hey 今天播什么" }
  );
  const action = await actionPromise;
  assert.equal(action.reply, "本地模型回复");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].message, "今天播什么");
  assert.equal(runtime.getSnapshot().localAi.model, "tiny");
  runtime.stop("测试结束");
});

test("BotRuntime stop discards an in-flight local model reply", async () => {
  let resolveReply;
  const localAiClient = {
    getState: () => ({ enabled: true, available: true }),
    generateReply: () => new Promise((resolve) => { resolveReply = resolve; }),
  };
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    localAiClient,
    config: {
      history: { enabled: false },
      modules: { ai: { enabled: true }, autoSend: { enabled: false } },
      automation: { enabled: true },
    },
  });
  runtime.running = true;
  let actionCount = 0;
  runtime.on("action", () => { actionCount += 1; });
  runtime.handleActions(
    [{ type: "command_reply", ruleName: "ai", reply: "内置回复" }],
    { userName: "小明", text: "#hey 你好" }
  );
  await new Promise((resolve) => setImmediate(resolve));
  runtime.stop("立即停止");
  resolveReply("这条不应该发出");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(actionCount, 0);
});

test("LocalAiClient shortens a long reply and preserves the mention prefix", async () => {
  const prompts = [];
  const client = new LocalAiClient({
    provider: "ollama",
    maxChars: 20,
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      prompts.push(body.messages[1].content);
      return jsonResponse({ message: { content: "@小明 今晚一起看直播呀" } });
    },
  });
  const reply = await client.shortenReply({
    text: "@小明 这是一条特别特别长的娱乐直播间回复，需要模型重新说短一点再发送出去",
    maxChars: 20,
    preservePrefix: "@小明",
  });
  assert.ok(reply.startsWith("@小明 "));
  assert.ok(Array.from(reply).length <= 20);
  assert.match(prompts[0], /必须原样保留开头/);
});

test("BotRuntime replies to a bot mention by mentioning the viewer exactly once", async () => {
  const modelCalls = [];
  const localAiClient = {
    getState: () => ({ enabled: true, available: true, provider: "fake", model: "tiny" }),
    async generateReply(input) {
      modelCalls.push(input);
      return "今晚一起陪主播玩～";
    },
  };
  const config = {
    history: { enabled: false },
    roles: { botNames: ["测试机器人"] },
    localAi: { enabled: true, maxChars: 40 },
    modules: { ai: { enabled: true }, autoSend: { enabled: false } },
    automation: { enabled: true },
    rules: [],
  };
  const runtime = new BotRuntime({ room: "20002", dryRun: true, localAiClient, config });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, title: "娱乐直播间", liveStatus: 1 };
  runtime.ensureVisibleEngines();
  const actionPromise = new Promise((resolve) => runtime.once("action", resolve));
  runtime.handleIncomingChat({ userName: "小明", displayUserName: "小明", text: "@测试机器人 今晚播什么" });
  const action = await actionPromise;
  assert.equal(action.reply, "@小明 今晚一起陪主播玩～");
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].message, "今晚播什么");
  const viewerReplyPromise = new Promise((resolve) => runtime.once("action", resolve));
  runtime.handleIncomingChat({ userName: "小红", text: "今天天气不错" });
  const viewerReply = await viewerReplyPromise;
  assert.ok(viewerReply.reply.startsWith("@小红 "));
  assert.equal(modelCalls.length, 2);
  let ownReplyCount = 0;
  runtime.on("action", () => { ownReplyCount += 1; });
  runtime.rememberSentText("我是机器人自己的弹幕");
  runtime.handleIncomingChat({ userName: "测试机器人", text: "我是机器人自己的弹幕" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ownReplyCount, 0);
  runtime.stop("测试结束");
});

test("BotRuntime sends a model-shortened long action once", async () => {
  const shortenCalls = [];
  const sent = [];
  const localAiClient = {
    getState: () => ({ enabled: true, available: true }),
    async shortenReply(input) {
      shortenCalls.push(input);
      return "多人PK我方加油，稳住这一把～";
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
    biliMaxChars: 40,
    config: { history: { enabled: false }, modules: { autoSend: { enabled: true } }, automation: { enabled: true } },
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1 };
  const result = await runtime.sendActionToBili({
    type: "pk_multi_report",
    ruleName: "pk_multi_report",
    reply: "多人PK：我方第7，33分；榜首对面主播1760分，前排还有很多很多人的详细战报。",
  });
  assert.equal(result.ok, true);
  assert.equal(shortenCalls.length, 1);
  assert.deepEqual(sent, ["多人PK我方加油，稳住这一把～"]);
});

test("本地 AI 内容在压缩后仍会做最终公屏禁词检查", async () => {
  const sent = [];
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: false,
    sendToBili: true,
    browserAuto: true,
    browserController: {
      getState: () => ({ ready: true }),
      async send(text) {
        sent.push(text);
        return { ok: true, sentText: text };
      },
    },
    localAiClient: {
      getState: () => ({ enabled: true, available: true }),
      async shortenReply() {
        return "截图里能看到露点";
      },
    },
    biliMaxChars: 12,
    config: {
      history: { enabled: false },
      localAi: { enabled: true },
      modules: { ai: { enabled: true }, autoSend: { enabled: true } },
      automation: { enabled: true },
    },
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1 };

  const result = await runtime.sendActionToBili({
    type: "reply",
    ruleName: "ai",
    reply: "这是一条需要先使用本地模型压缩的超长候选回复",
    metadata: { localAi: true },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /公屏禁词“露点”/);
  assert.equal(sent.length, 0);
});

function makeMemoryRuntime(options = {}) {
  const modelCalls = [];
  const sent = [];
  const replies = options.replies || ["第一个回答", "第二个回答", "第三个回答"];
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: options.dryRun === true,
    sendToBili: options.dryRun !== true,
    browserAuto: options.dryRun !== true,
    browserController: {
      getState: () => ({ ready: true }),
      async send(text) {
        sent.push(text);
        return { ok: true, sentText: text };
      },
    },
    localAiClient: {
      getState: () => ({ enabled: true, available: true, model: "qwen-memory-test" }),
      async generateReply(input) {
        modelCalls.push(input);
        return replies[Math.min(modelCalls.length - 1, replies.length - 1)];
      },
    },
    weatherService: {
      getState: () => ({ enabled: true }),
      async getContext() {
        return null;
      },
    },
    config: {
      history: { enabled: false },
      localAi: {
        enabled: true,
        allViewerChats: true,
        viewerReplyCooldownMs: 0,
        maxChars: 40,
      },
      modules: { ai: { enabled: true }, autoSend: { enabled: true }, rotation: { enabled: false } },
      automation: {
        enabled: true,
        humanTiming: {
          enabled: true,
          actionDelayMinMs: 0,
          actionDelayMaxMs: 0,
          sendGapMinSec: 0,
          sendGapMaxSec: 0,
        },
      },
      rules: [],
      roles: { botNames: ["测试机器人"] },
    },
  });
  runtime.running = true;
  runtime.connected = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1, title: "不得进入上下文的标题" };
  runtime.ensureVisibleEngines();
  return { runtime, modelCalls, sent };
}

test("截图场景连续两次命中公屏禁词时，第三个安全候选才发送", async () => {
  const { runtime, modelCalls } = makeMemoryRuntime({
    dryRun: true,
    replies: ["截图里能看到内裤", "这一帧有露点", "这张图不方便判断，聊点别的吧"],
  });
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.handleIncomingChat({
    roomId: 20002,
    userId: 701,
    userName: "截图用户",
    text: "帮我看看这张截图",
  });
  await waitFor(() => modelCalls.length === 3 && actions.length === 1);

  assert.match(modelCalls[1].retryGuidance, /内裤/);
  assert.match(modelCalls[2].retryGuidance, /露点/);
  assert.match(actions[0].reply, /这张图不方便判断/);
  assert.doesNotMatch(actions[0].reply, /内裤|露点/);
  runtime.stop("测试结束");
});

test("敏感首答会带原因重试，不会发固定兜底", async () => {
  const { runtime, modelCalls } = makeMemoryRuntime({
    dryRun: true,
    replies: ["这个镜头像是走光了", "这个话题我们换个轻松方向聊吧"],
  });
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.handleIncomingChat({
    roomId: 20002,
    userId: 702,
    userName: "小红",
    text: "这个画面怎么样",
  });
  await waitFor(() => modelCalls.length === 2 && actions.length === 1);

  assert.match(modelCalls[1].retryGuidance, /公屏禁词“走光”/);
  assert.equal(actions[0].reply.includes("走光"), false);
  runtime.stop("测试结束");
});

test("观众要求换一个时，重复上次真实回复会重生成", async () => {
  const repeated = "程序员最怕的不是bug，是需求又改了";
  const { runtime, modelCalls } = makeMemoryRuntime({
    dryRun: true,
    replies: [repeated, "为什么键盘不睡觉？因为它一直有空格"],
  });
  const previous = {
    roomId: 20002,
    userId: 703,
    userName: "小明",
    text: "讲个笑话",
  };
  runtime.rememberLocalAiChat(previous);
  runtime.rememberLocalAiDirectReply(previous, previous.text, repeated);
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.handleIncomingChat({ ...previous, text: "换一个" });
  await waitFor(() => modelCalls.length === 2 && actions.length === 1);

  assert.match(modelCalls[1].retryGuidance, /完全重复/);
  assert.match(modelCalls[1].retryGuidance, /更换主题/);
  assert.match(actions[0].reply, /键盘不睡觉/);
  assert.equal(actions[0].reply.includes("需求又改了"), false);
  runtime.stop("测试结束");
});

test("“我想换一个城市”不会被误判成要求重讲上一答", async () => {
  const { runtime, modelCalls } = makeMemoryRuntime({
    dryRun: true,
    replies: ["推荐你去大阪看看樱花", "这个不应该被用到"],
  });
  const previous = {
    roomId: 20002,
    userId: 705,
    userName: "旅行用户",
    text: "推荐个城市",
  };
  runtime.rememberLocalAiChat(previous);
  runtime.rememberLocalAiDirectReply(previous, previous.text, "推荐你去东京看看樱花");
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.handleIncomingChat({ ...previous, text: "我想换一个城市" });
  await waitFor(() => actions.length === 1);

  assert.equal(modelCalls.length, 1);
  assert.match(actions[0].reply, /大阪/);
  runtime.stop("测试结束");
});

test("三个候选连续失败时不会产生任何发送动作", async () => {
  const { runtime, modelCalls } = makeMemoryRuntime({
    dryRun: true,
    replies: ["内裤", "露点", "走光"],
  });
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.handleIncomingChat({
    roomId: 20002,
    userId: 704,
    userName: "连续失败用户",
    text: "随便聊两句",
  });
  await waitFor(() => modelCalls.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(actions.length, 0);
  assert.equal(runtime.recentSuccessfulAiOutputs.length, 0);
  runtime.stop("测试结束");
});

test("主动话术避免连续嗨场套话，且只在真实发送成功后记录", async () => {
  const { runtime, modelCalls } = makeMemoryRuntime({
    replies: ["别安静，一起嗨起来！", "来猜猜主播下一句会说啥？"],
  });
  runtime.config.localAi.proactive = {
    enabled: true,
    silenceMinSec: 0,
    prompts: ["主动抛一个观众容易接话的小问题"],
  };
  runtime.moduleStatus.rotation.enabled = true;
  runtime.rememberSuccessfulAiOutput(
    { ruleName: "ai", metadata: { proactiveAi: true, localAi: true } },
    "别安静，一起嗨起来！"
  );
  const previousLastAt = runtime.proactiveAiLastAt;
  let releaseSend = null;
  let attemptedText = "";
  runtime.browserController.send = async (text) => {
    attemptedText = text;
    return new Promise((resolve) => {
      releaseSend = () => resolve({ ok: true, sentText: text });
    });
  };

  const queued = await runtime.runProactiveAi(runtime.proactiveAiGeneration);
  await waitFor(() => typeof releaseSend === "function");
  assert.equal(queued, true);
  assert.equal(modelCalls.length, 2);
  assert.match(modelCalls[1].retryGuidance, /套话|重复/);
  assert.equal(runtime.proactiveAiLastAt, previousLastAt);
  assert.equal(runtime.proactiveAiLastReply, "别安静，一起嗨起来！");

  releaseSend();
  await waitFor(() => runtime.proactiveAiLastReply === attemptedText);
  assert.equal(attemptedText, "来猜猜主播下一句会说啥？");
  assert.equal(runtime.recentSuccessfulAiOutputs[0].text, attemptedText);
  runtime.stop("测试结束");
});

test("同一观众的上一轮真实问答可承接，当前弹幕不重复进历史", async () => {
  const { runtime, modelCalls, sent } = makeMemoryRuntime({ replies: ["蓝色", "因为看着很放松"] });
  runtime.handleIncomingChat({ roomId: 20002, userId: 101, userName: "小明", text: "我喜欢蓝色" });
  await waitFor(() => sent.length === 1 && runtime.getLocalAiMemorySnapshot().turnCount === 1);
  runtime.handleIncomingChat({ roomId: 20002, userId: 101, userName: "小明", text: "那为什么" });
  await waitFor(() => sent.length === 2 && runtime.getLocalAiMemorySnapshot().turnCount === 2);

  const history = modelCalls[1].context.conversationMemory;
  assert.deepEqual(history.sameViewerTurns, [{ viewer: "我喜欢蓝色", assistant: "蓝色" }]);
  assert.equal(history.recentRoomChats.some((item) => item.text === "我喜欢蓝色"), false);
  assert.equal(JSON.stringify(modelCalls[1].context).includes("那为什么"), false);
  assert.equal(JSON.stringify(modelCalls[1].context).includes("不得进入上下文的标题"), false);
  runtime.stop("测试结束");
});

test("不同观众的 personal 记忆隔离，且按房间隔离", async () => {
  const { runtime, modelCalls, sent } = makeMemoryRuntime({ replies: ["A的答案", "B的答案"] });
  runtime.handleIncomingChat({ roomId: 20002, userId: 201, userName: "A", text: "A的秘密" });
  await waitFor(() => sent.length === 1);
  runtime.handleIncomingChat({ roomId: 20002, userId: 202, userName: "B", text: "你记得我吗" });
  await waitFor(() => sent.length === 2);

  assert.deepEqual(modelCalls[1].context.conversationMemory?.sameViewerTurns || [], []);
  const otherRoomSnapshot = runtime.captureLocalAiContextSnapshot({
    roomId: 999,
    userId: 201,
    userName: "A",
    text: "换房间",
  });
  assert.deepEqual(otherRoomSnapshot.sameViewerTurns, []);
  assert.deepEqual(otherRoomSnapshot.recentRoomChats, []);
  runtime.stop("测试结束");
});

test("昵称与 UID 切换可迁移记忆，同名不同 UID 不串，冷却按观众隔离", () => {
  const { runtime } = makeMemoryRuntime({ dryRun: true });
  const nameOnly = { roomId: 20002, userName: "同名测试", text: "先用昵称说话" };
  runtime.rememberLocalAiChat(nameOnly);
  runtime.rememberLocalAiDirectReply(nameOnly, nameOnly.text, "昵称轮的回答");

  const uidOne = { roomId: 20002, userId: 501, userName: "同名测试", text: "UID1" };
  const uidOneMemory = runtime.captureLocalAiContextSnapshot(uidOne);
  assert.equal(uidOneMemory.sameViewerTurns[0].assistantText, "昵称轮的回答");
  runtime.rememberLocalAiChat(uidOne);
  runtime.rememberLocalAiDirectReply(uidOne, "UID1", "UID1的回答");

  const uidTwo = { roomId: 20002, userId: 502, userName: "同名测试", text: "UID2" };
  runtime.localAiViewerKey(uidTwo);
  assert.deepEqual(runtime.captureLocalAiContextSnapshot(uidTwo).sameViewerTurns, []);
  assert.deepEqual(runtime.captureLocalAiContextSnapshot(nameOnly).sameViewerTurns, []);
  assert.equal(runtime.captureLocalAiContextSnapshot(uidOne).sameViewerTurns.length, 2);

  runtime.config.localAi.viewerReplyCooldownMs = 1500;
  assert.ok(runtime.createViewerAiAction({ roomId: 20002, userId: 601, userName: "A", text: "A1" }));
  assert.ok(runtime.createViewerAiAction({ roomId: 20002, userId: 602, userName: "B", text: "B1" }));
  assert.equal(
    runtime.createViewerAiAction({ roomId: 20002, userId: 601, userName: "A", text: "A2" }),
    null
  );
  runtime.stop("测试结束");
});

test("自身回显、小助理、主动话术和模拟弹幕不污染记忆", () => {
  const { runtime } = makeMemoryRuntime({ dryRun: true });
  runtime.rememberLocalAiChat({ roomId: 20002, userId: 1, userName: "真观众", text: "真实弹幕" });
  runtime.rememberSentText("机器人自身回显");
  runtime.rememberLocalAiChat({ roomId: 20002, userName: "路人", text: "机器人自身回显" });
  runtime.rememberLocalAiChat({ roomId: 20002, userName: "测试机器人", text: "配置机器人昵称" });
  runtime.rememberLocalAiChat({ roomId: 20002, userName: "直播间小助理", text: "助理播报" });
  runtime.rememberLocalAiChat({ roomId: 20002, userName: "直播间", text: "主动笑话", proactiveAi: true });
  runtime.rememberLocalAiChat({ roomId: 20002, userName: "测试用户", text: "模拟弹幕", isSimulated: true });
  runtime.rememberLocalAiChat({ roomId: 20002, userName: "郎***", text: "真实打码观众" });

  const snapshot = runtime.getLocalAiMemorySnapshot();
  assert.equal(snapshot.roomChatCount, 2);
  assert.equal(snapshot.turnCount, 0);
  const publicSnapshot = JSON.stringify(runtime.getSnapshot().localAiMemory);
  assert.equal(publicSnapshot.includes("真实弹幕"), false);
  assert.equal(publicSnapshot.includes("真实打码观众"), false);
  runtime.stop("测试结束");
});

test("30分钟 TTL、每人8轮、房间20条和1800字上下文预算均生效", () => {
  const { runtime } = makeMemoryRuntime({ dryRun: true });
  const now = Date.now();
  for (let index = 0; index < 25; index += 1) {
    runtime.rememberLocalAiChat(
      { roomId: 20002, userId: index + 1, userName: `用户${index}`, text: `房间弹幕${index}` },
      now + index
    );
  }
  const sameViewer = { roomId: 20002, userId: 999, userName: "连续用户", text: "" };
  for (let index = 0; index < 10; index += 1) {
    sameViewer.text = `问题${index}${"长".repeat(160)}`;
    runtime.rememberLocalAiChat(sameViewer, now + 100 + index);
    runtime.rememberLocalAiDirectReply(
      sameViewer,
      sameViewer.text,
      `回答${index}${"长".repeat(160)}`,
      now + 100 + index
    );
  }

  const bounded = runtime.getLocalAiMemorySnapshot(now + 200);
  assert.equal(bounded.roomChatCount, 20);
  assert.equal(bounded.turnCount, 8);
  const memory = runtime.captureLocalAiContextSnapshot({
    roomId: 20002,
    userId: 999,
    userName: "连续用户",
    text: "当前问题",
  }, now + 200);
  assert.equal(memory.sameViewerTurns.length, 8);
  assert.match(memory.sameViewerTurns[0].userText, /^问题2/);
  const context = runtime.buildLocalAiPromptContext(memory, null);
  assert.ok(Array.from(JSON.stringify(context)).length <= 1800);

  const expired = runtime.getLocalAiMemorySnapshot(now + 30 * 60 * 1000 + 1000);
  assert.equal(expired.roomChatCount, 0);
  assert.equal(expired.turnCount, 0);
  assert.equal(expired.viewerCount, 0);
  runtime.stop("测试结束");
});
