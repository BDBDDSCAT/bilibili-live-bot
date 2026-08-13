#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { BilibiliLiveClient } = require("./bilibiliClient");
const { loadConfig: loadMergedConfig } = require("./configLoader");
const { InteractionEngine } = require("./interactionEngine");
const { PkTracker } = require("./pkTracker");
const { RuleEngine } = require("./ruleEngine");

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;

    const key = arg.slice(2);
    const next = argv[index + 1];

    if (
      next === undefined ||
      next.startsWith("--") ||
      ["dry-run", "enable-post", "show-events", "help"].includes(key)
    ) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

function showHelp() {
  console.log(`
Bilibili Live Bot

Usage:
  node src/index.js
  node src/index.js --room <直播间号或链接>

Options:
  --config <path>       JSON config path（默认自动读取 config.json）
  --room <id-or-url>    Override room in config
  --speak-endpoint <url>  POST matched script replies to a local speech endpoint
  --enable-post         Enable POST to speak endpoint. Without this, console only
  --dry-run             Force console only
  --show-events         Print non-chat live events too
  --exit-after <sec>    Exit after N seconds, useful for smoke tests
  --help                Show this help
`);
}

function nowTime() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function logLine(label, message) {
  console.log(`[${nowTime()}] ${label} ${message}`);
}

async function postSpeak(endpoint, action, event) {
  const response = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text: action.reply,
      emotion: action.emotion || "calm",
      scene: "10_main_chat",
      metadata: {
        source: "bilibili-live-bot",
        type: action.type,
        ruleName: action.ruleName,
        userName: event?.userName,
        userId: event?.userId,
        text: event?.text,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`POST ${endpoint} failed: HTTP ${response.status}`);
  }

  return response.json().catch(() => ({}));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    showHelp();
    return;
  }

  const rootDir = path.resolve(__dirname, "..");
  const config = loadMergedConfig({ configPath: args.config || "", rootDir });

  const room = args.room || config.room;
  if (!room) {
    throw new Error("请在配置里设置 room，或通过 --room 传入直播间 URL/id");
  }

  const showEvents = Boolean(args["show-events"] || config.showAllEvents);
  const speakEndpoint = args["speak-endpoint"] || config.speakEndpoint || "";
  let dryRun = config.dryRun !== false;
  if (args["enable-post"]) {
    dryRun = false;
  }
  if (args["dry-run"] || !speakEndpoint) {
    dryRun = true;
  }

  const engine = new RuleEngine(config);
  const interactions = new InteractionEngine(config);
  const pkTracker = new PkTracker(config.pk || {});
  const client = new BilibiliLiveClient({ room });

  async function handleAction(action, event) {
    if (!action?.reply) return;

    if (action.type === "gift_report") {
      logLine("礼物报告", action.reply);
    } else if (action.type?.startsWith("pk_")) {
      logLine("PK情报", action.reply);
    } else {
      const prefix =
        action.type === "timer" ? "定时话术" : `命中 ${action.ruleName}`;
      logLine("建议回复", `${prefix}: ${action.reply}`);
    }

    if (!dryRun && speakEndpoint) {
      try {
        await postSpeak(speakEndpoint, action, event);
        logLine("已推送", `local speak endpoint: ${speakEndpoint}`);
      } catch (error) {
        logLine("推送失败", error.message);
      }
    }
  }

  async function handleRuleAction(action, event) {
    if (action.type === "gift_report") {
      await handleAction(interactions.createGiftReportAction(), event);
      return;
    }

    if (action.type === "pk_report") {
      await handleAction(pkTracker.createReportAction(), event);
      return;
    }

    await handleAction(action, event);
  }

  async function handleActions(actions, event) {
    for (const action of actions) {
      await handleAction(action, event);
    }
  }

  async function handleRuleActions(actions, event) {
    for (const action of actions) {
      await handleRuleAction(action, event);
    }
  }

  client.on("room", (roomInfo) => {
    logLine(
      "房间",
      `${roomInfo.roomId} ${roomInfo.liveStatusLabel} ${roomInfo.uname ? `@${roomInfo.uname}` : ""} ${
        roomInfo.title ? `「${roomInfo.title}」` : ""
      }`
    );
    pkTracker.setOwnRoomId(roomInfo.roomId);
    if (roomInfo.danmuWarning) {
      logLine("提示", `弹幕配置接口失败，已使用默认服务器: ${roomInfo.danmuWarning}`);
    }
  });

  client.on("connecting", ({ endpoint }) => {
    logLine("连接", endpoint);
  });

  client.on("connected", () => {
    logLine("连接", "WebSocket 已打开，正在鉴权");
  });

  client.on("authenticated", (body) => {
    logLine("连接", `鉴权完成 ${JSON.stringify(body)}`);
    engine.startTimers((action) => handleAction(action, null));
  });

  client.on("popularity", ({ popularity }) => {
    if (showEvents && popularity !== undefined) {
      logLine("人气", String(popularity));
    }
  });

  client.on("chat", (event) => {
    logLine("弹幕", `${event.displayUserName || event.userName}: ${event.text}`);
    const actions = engine.handleChat(event);
    handleRuleActions(actions, event);
  });

  client.on("interact", (event) => {
    // interact 事件同时承载进房/关注/分享，按 interactKind 分派，与 botRuntime 口径一致。
    const kind = event.interactKind || "enter";
    if (showEvents) {
      logLine(
        kind === "follow" ? "关注" : kind === "share" ? "分享" : "进房",
        event.displayUserName || event.userName
      );
    }
    if (kind === "follow") {
      handleActions(interactions.handleFollow(event), event);
    } else if (kind === "share") {
      handleActions(interactions.handleShare(event), event);
    } else {
      handleActions(interactions.handleEnter(event), event);
    }
  });

  client.on("gift", (event) => {
    logLine("礼物", `${event.userName} ${event.giftName} x${event.count}`);
    handleActions(interactions.handleGift(event), event);
  });

  client.on("superChat", (event) => {
    logLine("醒目留言", `${event.userName}: ${event.text} (${event.price})`);
    handleActions(interactions.handleSuperChat(event), event);
  });

  client.on("guard", (event) => {
    logLine("大航海", event.message || `${event.userName} ${event.guardName || event.guardLevel}`);
    handleActions(interactions.handleGuard(event), event);
  });

  client.on("like", (event) => {
    if (showEvents) {
      logLine("点赞", `${event.userName} x${event.likeCount}`);
    }
    handleActions(interactions.handleLike(event), event);
  });

  client.on("pk", (event) => {
    if (showEvents || config.pk?.showRawEvents) {
      logLine("PK事件", event.command);
      if (config.pk?.showRawEvents) {
        console.log(JSON.stringify(event.raw));
      }
    }
    handleActions(pkTracker.handle(event), event);
  });

  client.on("event", (event) => {
    if (showEvents) {
      logLine("事件", event.command);
    }
  });

  client.on("warn", ({ message, error }) => {
    logLine("警告", `${message}${error?.message ? `: ${error.message}` : ""}`);
  });

  client.on("closed", ({ code, reason }) => {
    logLine("断开", `${code}${reason ? ` ${reason}` : ""}`);
    engine.stopTimers();
  });

  client.on("reconnecting", ({ delayMs }) => {
    logLine("重连", `${Math.round(delayMs / 1000)} 秒后重试`);
  });

  process.on("SIGINT", () => {
    logLine("退出", "收到 Ctrl+C");
    engine.stopTimers();
    client.stop();
    process.exit(0);
  });

  const exitAfter = Number(args["exit-after"] || 0);
  if (exitAfter > 0) {
    setTimeout(() => {
      logLine("退出", `smoke test ${exitAfter} 秒结束`);
      engine.stopTimers();
      client.stop();
      process.exit(0);
    }, exitAfter * 1000);
  }

  logLine("配置", `${config.__path}`);
  logLine(
    "模式",
    dryRun
      ? "dry-run，只打印建议回复，不推送到任何发送端"
      : `会推送到本地 speech endpoint: ${speakEndpoint}`
  );
  await client.start();
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
