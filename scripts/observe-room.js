#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BilibiliLiveClient } = require("../src/bilibiliClient");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function nowText() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function addCount(record, key, amount = 1) {
  const name = key || "unknown";
  record[name] = (record[name] || 0) + amount;
}

function remember(list, item, limit) {
  list.push(item);
  if (list.length > limit) list.shift();
}

function compactText(text, max = 120) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function detectAssistantLike(userName, text) {
  const name = String(userName || "");
  const value = String(text || "");
  if (/(小助理|助理|助手|机器人|管家|场控|bot)/i.test(name)) return true;
  if (/欢迎[『「]?.+[』」]?(来玩|进入直播间|来到直播间)/.test(value)) return true;
  if (/感谢.+(礼物|投喂|上船|醒目留言|SC|sc)/.test(value)) return true;
  return false;
}

function classifyChat(text) {
  const value = String(text || "").trim();
  const classes = [];
  if (/^(1|11|111|扣1|k1)$/i.test(value)) classes.push("扣1互动");
  if (/^(6|66|666|6666)$/.test(value)) classes.push("666");
  if (/(多少钱|价格|几米|多少米|贵吗)/.test(value)) classes.push("价格");
  if (/(链接|小黄车|怎么买|哪里拍|下单)/.test(value)) classes.push("购买");
  if (/(主播|姐姐|老婆|宝宝|鱼鱼|小鱼)/.test(value)) classes.push("称呼主播");
  if (/(pk|PK|对面|大哥|榜一|比分)/.test(value)) classes.push("PK");
  if (/(卡|延迟|没声音|声音|听不见|麦)/.test(value)) classes.push("技术反馈");
  if (/(来啦|来了|晚上好|你好|早|午好)/.test(value)) classes.push("打招呼");
  return classes;
}

function classifyCommand(command) {
  const name = String(command || "");
  if (name.startsWith("PK_") || /BATTLE|PK/.test(name)) return "pk";
  if (/VOICE|MIC|CONNECT|LINK|MULTI|CALL|INVITE|MATCH/.test(name)) return "connection";
  if (/GIFT|COMBO|GUARD|SUPER_CHAT|USER_TOAST/.test(name)) return "payment";
  if (/INTERACT|ENTRY|WELCOME/.test(name)) return "entry";
  if (/LIKE|WATCHED|ONLINE_RANK|POPULARITY/.test(name)) return "traffic";
  if (/LOT|RAFFLE|ANCHOR_LOT|ACTIVITY|RED_POCKET/.test(name)) return "activity";
  return "other";
}

function writeJsonLine(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function summarize(observation) {
  const top = (record, limit = 10) =>
    Object.entries(record)
      .sort((left, right) => right[1] - left[1])
      .slice(0, limit)
      .map(([name, count]) => ({ name, count }));

  return {
    room: observation.room,
    durationSec: Math.round((observation.finishedAt - observation.startedAt) / 1000),
    counts: observation.counts,
    commands: top(observation.commands, 30),
    chatClasses: top(observation.chatClasses, 20),
    assistantNames: top(observation.assistantNames, 20),
    giftNames: top(observation.giftNames, 20),
    pkCommands: top(observation.pkCommands, 20),
    commandGroups: top(observation.commandGroups, 20),
    samples: {
      chat: observation.samples.chat.slice(-30),
      assistant: observation.samples.assistant.slice(-30),
      gift: observation.samples.gift.slice(-20),
      pk: observation.samples.pk.slice(-20),
      unknown: observation.samples.unknown.slice(-30),
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const room = args.room;
  if (!room) {
    throw new Error("Usage: node scripts/observe-room.js --room <room-url-or-id> [--seconds 120]");
  }
  const seconds = Number(args.seconds || 120);
  const outDir = path.resolve(__dirname, "..", "state", "observations");
  fs.mkdirSync(outDir, { recursive: true });
  const sessionId =
    args.tag ||
    `observe-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const rawPath = path.join(outDir, `${sessionId}.raw.jsonl`);
  const specialPath = path.join(outDir, `${sessionId}.special.jsonl`);
  const rawStream = fs.createWriteStream(rawPath, { flags: "a" });
  const specialStream = fs.createWriteStream(specialPath, { flags: "a" });
  const quiet = Boolean(args.quiet);

  const client = new BilibiliLiveClient({ room });
  const observation = {
    startedAt: Date.now(),
    finishedAt: 0,
    roomInput: room,
    room: null,
    counts: {
      chat: 0,
      enter: 0,
      gift: 0,
      superChat: 0,
      guard: 0,
      like: 0,
      pk: 0,
      event: 0,
      warn: 0,
    },
    commands: {},
    chatClasses: {},
    assistantNames: {},
    giftNames: {},
    pkCommands: {},
    commandGroups: {},
    output: {
      rawPath,
      specialPath,
    },
    samples: {
      chat: [],
      assistant: [],
      gift: [],
      pk: [],
      unknown: [],
    },
  };

  client.on("room", (roomInfo) => {
    observation.room = roomInfo;
    console.log(`[${nowText()}] room ${roomInfo.roomId} ${roomInfo.liveStatusLabel} @${roomInfo.uname || ""} ${roomInfo.title || ""}`);
    console.log(`[${nowText()}] raw ${rawPath}`);
    console.log(`[${nowText()}] special ${specialPath}`);
  });

  client.on("authenticated", (body) => {
    console.log(`[${nowText()}] auth ${JSON.stringify(body)}`);
  });

  client.on("raw", ({ command, message }) => {
    addCount(observation.commands, command);
    const group = classifyCommand(command);
    addCount(observation.commandGroups, group);
    writeJsonLine(rawStream, {
      at: Date.now(),
      command,
      group,
      message,
    });
    if (group !== "other") {
      writeJsonLine(specialStream, {
        at: Date.now(),
        command,
        group,
        data: message.data,
        info: message.info,
      });
    }
    if (
      ![
        "DANMU_MSG",
        "INTERACT_WORD",
        "SEND_GIFT",
        "COMBO_SEND",
        "SUPER_CHAT_MESSAGE",
        "LIKE_INFO_V3_CLICK",
      ].includes(command) &&
      !command.startsWith("PK_")
    ) {
      remember(
        observation.samples.unknown,
        {
          at: Date.now(),
          command,
          dataKeys: Object.keys(message.data || {}),
        },
        80
      );
    }
  });

  client.on("chat", (event) => {
    observation.counts.chat += 1;
    for (const name of classifyChat(event.text)) addCount(observation.chatClasses, name);
    const sample = {
      at: Date.now(),
      userName: event.userName,
      text: compactText(event.text),
    };
    remember(observation.samples.chat, sample, 120);
    if (detectAssistantLike(event.userName, event.text)) {
      addCount(observation.assistantNames, event.userName);
      remember(observation.samples.assistant, sample, 120);
    }
    if (!quiet) console.log(`[${nowText()}] chat ${event.userName}: ${compactText(event.text, 80)}`);
  });

  client.on("interact", () => {
    observation.counts.enter += 1;
  });

  client.on("gift", (event) => {
    observation.counts.gift += 1;
    addCount(observation.giftNames, event.giftName, event.count || 1);
    remember(
      observation.samples.gift,
      {
        at: Date.now(),
        userName: event.userName,
        giftName: event.giftName,
        count: event.count,
        totalCoin: event.totalCoin,
      },
      80
    );
    if (!quiet) console.log(`[${nowText()}] gift ${event.userName} ${event.giftName} x${event.count}`);
  });

  client.on("superChat", (event) => {
    observation.counts.superChat += 1;
    if (!quiet) console.log(`[${nowText()}] sc ${event.userName}: ${compactText(event.text)}`);
  });

  client.on("guard", (event) => {
    observation.counts.guard += 1;
    if (!quiet) console.log(`[${nowText()}] guard ${event.userName} ${event.guardName || event.guardLevel}`);
  });

  client.on("like", () => {
    observation.counts.like += 1;
  });

  client.on("pk", (event) => {
    observation.counts.pk += 1;
    addCount(observation.pkCommands, event.command);
    remember(
      observation.samples.pk,
      {
        at: Date.now(),
        command: event.command,
        pkId: event.pkId,
        pkStatus: event.pkStatus,
        dataKeys: Object.keys(event.data || {}),
        raw: event.raw,
      },
      80
    );
    if (!quiet) console.log(`[${nowText()}] pk ${event.command}`);
  });

  client.on("event", (event) => {
    observation.counts.event += 1;
  });

  client.on("warn", ({ message }) => {
    observation.counts.warn += 1;
    console.log(`[${nowText()}] warn ${message}`);
  });

  // 收尾只允许走一次：正常到点结束与 Ctrl+C 中断共用同一条路径，
  // 保证 summary 落盘、两个 write stream flush 完成后再自然退出（不再 setTimeout 强杀进程）。
  let finished = false;
  let observeTimer = null;
  let cancelObserveWait = null;
  const finish = async (reason) => {
    if (finished) return;
    finished = true;
    // Ctrl+C 提前收尾时要把观察计时器一并取消，否则进程会等满整个观察时长才退出。
    clearTimeout(observeTimer);
    cancelObserveWait?.();
    // bilibiliClient.stop() 用 ws.close() 走优雅关闭，对端不应答时握手可挂 30 秒拖住进程；
    // 诊断脚本没必要等，close 之后直接 terminate 掐断底层 socket。
    const ws = client.ws;
    client.stop();
    try {
      ws?.terminate();
    } catch {
      // 已断开的 socket terminate 可能报错，忽略。
    }
    observation.finishedAt = Date.now();

    const summary = summarize(observation);
    const filename = `observe-${observation.room?.roomId || "room"}-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    const outputPath = path.join(outDir, filename);
    fs.writeFileSync(outputPath, JSON.stringify({ observation, summary }, null, 2));
    // end() 只是排队写入，必须等 finish 事件，否则大缓冲下最后的数据会被截断。
    await Promise.all(
      [rawStream, specialStream].map(
        (stream) =>
          new Promise((resolve) => {
            stream.once("finish", resolve);
            stream.once("error", resolve);
            stream.end();
          })
      )
    );

    console.log(`\n[${nowText()}] 结束（${reason}）`);
    console.log(`Saved ${outputPath}`);
    console.log(JSON.stringify(summary, null, 2));
  };

  process.once("SIGINT", () => {
    console.log(`\n[${nowText()}] 收到 Ctrl+C，落盘后退出…`);
    finish("SIGINT").catch((error) => {
      console.error(error.stack || error.message || String(error));
      process.exitCode = 1;
    });
  });

  await client.start();
  await new Promise((resolve) => {
    cancelObserveWait = resolve;
    observeTimer = setTimeout(resolve, seconds * 1000);
  });
  await finish(`观察 ${seconds}s 到点`);
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
});
