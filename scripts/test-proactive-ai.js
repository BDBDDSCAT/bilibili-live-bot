"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { BotRuntime } = require("../src/botRuntime");

function makeRuntime(overrides = {}) {
  const modelCalls = [];
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    randomFn: () => 0,
    localAiClient: {
      getState: () => ({ enabled: true, available: true, model: "qwen-test" }),
      async generateReply(input) {
        modelCalls.push(input);
        return input.userName === "直播间" ? "主播一开口，弹幕都自动上班了！" : "这题我来接，包有节目效果！";
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
        maxChars: 36,
        proactive: {
          enabled: true,
          initialMinSec: 30,
          initialMaxSec: 60,
          intervalMinSec: 60,
          intervalMaxSec: 120,
          silenceMinSec: 0,
        },
      },
      modules: {
        ai: { enabled: true },
        rotation: { enabled: true },
        autoSend: { enabled: true },
      },
      automation: { enabled: true },
      rules: [
        {
          name: "greeting",
          enabled: true,
          keywords: ["你好"],
          reply: "旧固定问候不应发送",
        },
      ],
      ...overrides,
    },
  });
  runtime.running = true;
  runtime.connected = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1, title: "娱乐直播测试" };
  runtime.ensureVisibleEngines();
  return { runtime, modelCalls };
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

test("普通观众弹幕优先交给 Qwen，不发送旧关键词固定话术", async () => {
  const { runtime, modelCalls } = makeRuntime();
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.handleIncomingChat({ userName: "小明", displayUserName: "小明", text: "你好呀" });
  await waitFor(() => actions.length === 1);

  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].message, "你好呀");
  assert.equal(modelCalls[0].requireModel, true);
  assert.equal(actions[0].ruleName, "ai");
  assert.equal(actions[0].reply, "@小明 这题我来接，包有节目效果！");
  assert.equal(actions[0].reply.includes("旧固定问候"), false);
  runtime.stop("测试结束");
});

test("网页公屏会去掉粉丝牌前缀，只把观众正文交给 Qwen", async () => {
  const { runtime, modelCalls } = makeRuntime();
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  runtime.ingestVisibleParsed(
    { userName: "测试观众", text: "测试牌 48 测试观众 : ？" },
    { id: "visible-prefix-test", roomId: 20002 }
  );
  await waitFor(() => actions.length === 1);

  assert.equal(modelCalls[0].message, "？");
  assert.equal(actions[0].reply.startsWith("@测试观众 "), true);
  runtime.stop("测试结束");
});

test("配置中的机器人昵称永远只记录，不触发 Qwen 自问自答", async () => {
  const { runtime, modelCalls } = makeRuntime({
    roles: { botNames: ["测试机器人"] },
  });
  const actions = [];
  runtime.on("action", (action) => actions.push(action));

  const result = runtime.handleIncomingChat({
    userName: "测试机器人",
    displayUserName: "测试机器人",
    text: "机器人自己的回显",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(result.skippedAutomation, true);
  assert.equal(result.reason, "own_bot_chat");
  assert.equal(modelCalls.length, 0);
  assert.equal(actions.length, 0);
  runtime.stop("测试结束");
});

test("无人发言时 Qwen 生成笑话玩梗类主动弹幕", async () => {
  const { runtime, modelCalls } = makeRuntime();
  const actions = [];
  runtime.on("action", (action) => actions.push(action));
  runtime.proactiveAiGeneration = 7;
  runtime.lastViewerChatAt = 0;

  const generated = await runtime.runProactiveAi(7);

  assert.equal(generated, true);
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].userName, "直播间");
  assert.match(modelCalls[0].message, /笑话|玩梗|抖个机灵|有趣小问题|俏皮加油/);
  assert.equal(modelCalls[0].requireModel, true);
  assert.equal(actions[0].type, "timer");
  assert.equal(actions[0].ruleName, "ai");
  assert.equal(actions[0].metadata.proactiveAi, true);
  assert.equal(actions[0].reply, "主播一开口，弹幕都自动上班了！");
  runtime.stop("测试结束");
});

test("主动 Qwen 使用随机区间并在停止后取消", () => {
  const { runtime } = makeRuntime();
  runtime.dryRun = false;
  runtime.sendToBili = true;
  runtime.startProactiveAiScheduler();
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.proactiveAi.enabled, true);
  assert.equal(snapshot.proactiveAi.active, true);
  assert.ok(snapshot.proactiveAi.nextAt >= Date.now() + 29000);

  runtime.stop("急停测试");
  const stopped = runtime.getSnapshot();
  assert.equal(stopped.proactiveAi.active, false);
  assert.equal(stopped.proactiveAi.nextAt, 0);
});

test("默认只在开播后启动主动 Qwen，下播立即暂停", async () => {
  const { runtime, modelCalls } = makeRuntime();
  runtime.dryRun = false;
  runtime.sendToBili = true;
  runtime.biliCookie = "bili_jct=test";
  runtime.roomInfo.liveStatus = 0;
  runtime.startProactiveAiScheduler();

  let snapshot = runtime.getSnapshot();
  assert.equal(snapshot.proactiveAi.onlyWhenLive, true);
  assert.equal(snapshot.proactiveAi.waitingForLive, true);
  assert.equal(snapshot.proactiveAi.active, false);
  assert.equal(await runtime.runProactiveAi(runtime.proactiveAiGeneration), false);
  assert.equal(modelCalls.length, 0);
  const proactiveAction = {
    type: "timer",
    ruleName: "ai",
    reply: "不该在下播后发出",
    metadata: { proactiveAi: true, localAi: true },
  };
  assert.equal(runtime.shouldAutoSend(proactiveAction).ok, false);
  assert.match(runtime.shouldAutoSend(proactiveAction).reason, /未开播/);
  assert.match((await runtime.sendActionToBili(proactiveAction)).error, /未开播/);
  assert.equal(
    runtime.shouldAutoSend({ type: "timer", ruleName: "startup_message", reply: "离线上线提示" }).ok,
    false
  );

  runtime.handleGenericEvent({
    eventKind: "live_status",
    command: "LIVE",
    liveStatus: 1,
    roomId: 20002,
    text: "开播",
  });
  snapshot = runtime.getSnapshot();
  assert.equal(snapshot.proactiveAi.waitingForLive, false);
  assert.equal(snapshot.proactiveAi.active, true);

  runtime.handleGenericEvent({
    eventKind: "live_status",
    command: "PREPARING",
    liveStatus: 0,
    roomId: 20002,
    text: "下播",
  });
  snapshot = runtime.getSnapshot();
  assert.equal(snapshot.proactiveAi.waitingForLive, true);
  assert.equal(snapshot.proactiveAi.active, false);
  assert.equal(snapshot.proactiveAi.nextAt, 0);
  runtime.stop("开播门禁测试结束");
});

test("主动弹幕准备文本期间下播，最终运输层不得发送", async () => {
  const { runtime } = makeRuntime();
  runtime.dryRun = false;
  runtime.sendToBili = true;
  runtime.biliCookie = "bili_jct=test";
  runtime.roomInfo.liveStatus = 1;
  let prepareStarted = false;
  let releasePrepare;
  runtime.prepareBiliOutboundText = async () => {
    prepareStarted = true;
    return new Promise((resolve) => {
      releasePrepare = resolve;
    });
  };
  const sends = [];
  runtime.sendLiveDanmu = async (payload) => {
    sends.push(payload);
    return { ok: true };
  };
  const pending = runtime.sendActionToBili({
    type: "timer",
    ruleName: "ai",
    reply: "准备中的主动弹幕",
    metadata: { proactiveAi: true, localAi: true },
  });
  await waitFor(() => prepareStarted);
  runtime.roomInfo.liveStatus = 0;
  releasePrepare("准备中的主动弹幕");
  const result = await pending;

  assert.equal(result.ok, false);
  assert.match(result.error, /未开播/);
  assert.equal(sends.length, 0);
  runtime.stop("最终发送门禁测试结束");
});

test("安全监听态不会提前启动主动 Qwen", () => {
  const { runtime } = makeRuntime();
  runtime.startProactiveAiScheduler();
  const snapshot = runtime.getSnapshot();
  assert.equal(snapshot.dryRun, true);
  assert.equal(snapshot.proactiveAi.enabled, true);
  assert.equal(snapshot.proactiveAi.active, false);
  assert.equal(snapshot.proactiveAi.nextAt, 0);
  runtime.stop("安全监听测试结束");
});
