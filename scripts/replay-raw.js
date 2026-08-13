#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { BilibiliLiveClient } = require("../src/bilibiliClient");
const BOOLEAN_FLAGS = new Set(["json", "help"]);
const KNOWN_NON_CRITICAL_COMMANDS = new Set([
  "DANMU_AGGREGATION",
  "FLOW_REWARD_CARD",
  "POPULARITY_RANK_TAB_CHG",
  "ROOM_CHANGE",
]);

function parseArgs(argv) {
  const args = { files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      args.files.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      args[key] = true;
      continue;
    }
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

function addCount(map, key, amount = 1) {
  const name = String(key || "unknown");
  map.set(name, (map.get(name) || 0) + amount);
}

function top(map, limit = 20) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function readJsonl(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return [];
  // 行号必须按文件原始行计（含空行），否则报错定位会偏移。
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const rows = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      rows.push({ __parseError: error.message, __line: index + 1 });
    }
  }
  // 正在被在跑进程追加的文件可能读到半行 JSON：
  // tolerateTruncatedTail 只豁免"最后一条且解析失败"的行，中间的坏行仍然计错。
  if (options.tolerateTruncatedTail && rows.length && rows[rows.length - 1].__parseError) {
    rows.pop();
  }
  return rows;
}

function listDefaultRawFiles(rawDir, room = "") {
  if (!fs.existsSync(rawDir)) return [];
  return fs
    .readdirSync(rawDir)
    .filter((name) => name.endsWith(".raw.jsonl"))
    // 精确匹配 -<房号>.raw.jsonl 后缀，避免 --room 200 误命中 20002 等文件。
    .filter((name) => !room || name.endsWith(`-${room}.raw.jsonl`))
    .sort()
    .slice(-4)
    .map((name) => path.join(rawDir, name));
}

function classifyCommand(command = "") {
  const name = String(command || "");
  if (name === "DANMU_AGGREGATION") return "activity";
  if (name === "FLOW_REWARD_CARD") return "system";
  if (name === "POPULARITY_RANK_TAB_CHG") return "traffic";
  if (name === "ROOM_CHANGE") return "room";
  if (/DM_INTERACTION|LIVE_INTERACT_GAME|OPENPLATFORM_GAME|LIVE_OPEN_PLATFORM_GAME/.test(name)) return "activity";
  if (/RECALL_DANMU|BLOCK|SILENT|WARNING/.test(name)) return "moderation";
  if (name === "DANMU_MSG" || /_DM$|DANMU/.test(name)) return "chat";
  if (/INTERACT|ENTRY_EFFECT|WELCOME/.test(name)) return "enter";
  if (/SUPER_CHAT/.test(name)) return "superChat";
  if (/GUARD|USER_TOAST/.test(name)) return "guard";
  if (/GIFT|COMBO|RED_POCKET|NOTICE.*GIFT/.test(name)) return "gift";
  if (/PK_BATTLE|PK_INFO|PK_WIDGET|^PK_/.test(name)) return "pk";
  if (/UNIVERSAL_EVENT/.test(name)) return "universal";
  if (/VOICE_JOIN|VIDEO_CONNECTION|LIVE_ROOM_TOAST|CONNECT|MULTI_CONN/.test(name)) return "connection";
  if (/ONLINE_RANK|WATCHED|LIKE|POPULARITY/.test(name)) return "traffic";
  if (/LIVE|PREPARING|ROOM_REAL_TIME/.test(name)) return "room";
  if (/LOTTERY|RAFFLE|ANCHOR_LOT|ACTIVITY|RED_POCKET/.test(name)) return "activity";
  return "other";
}

function importantCommand(command = "") {
  // These are non-interactive business signals, but their high-level event parsers are still regression-gated.
  if (KNOWN_NON_CRITICAL_COMMANDS.has(String(command || ""))) return true;
  return /DANMU|INTERACT|ENTRY_EFFECT|WELCOME|GIFT|COMBO|GUARD|SUPER_CHAT|PK|VOICE_JOIN|VIDEO_CONNECTION|UNIVERSAL_EVENT|USER_TOAST|NOTICE_MSG|COMMON_NOTICE|ROOM_REAL_TIME|LIVE_ROOM_TOAST|LOTTERY|RAFFLE|ANCHOR_LOT|RED_POCKET/.test(
    String(command || "")
  );
}

function expectedHighEvents(command = "") {
  const name = String(command || "");
  if (KNOWN_NON_CRITICAL_COMMANDS.has(name)) return ["event"];
  if (/DM_INTERACTION|LIVE_INTERACT_GAME|OPENPLATFORM_GAME|LIVE_OPEN_PLATFORM_GAME/.test(name)) return ["event"];
  if (/RECALL_DANMU/.test(name)) return ["event"];
  if (name === "DANMU_MSG" || /_DM$|DANMU/.test(name)) return ["chat"];
  if (/INTERACT|ENTRY_EFFECT|WELCOME/.test(name)) return ["interact"];
  if (/SUPER_CHAT/.test(name)) return ["superChat"];
  if (/^(GUARD_BUY|USER_TOAST_MSG|USER_TOAST_MSG_V2|OPEN_LIVEROOM_GUARD|LIVE_OPEN_PLATFORM_GUARD)$/.test(name)) return ["guard"];
  if (/GUARD_HONOR/.test(name)) return ["event"];
  // POPULARITY_RED_POCKET_V2_NEW 现已在 bilibiliClient 里进 gift 流，回放门槛同步对齐。
  if (/^(SEND_GIFT|COMBO_SEND|GIFT_COMBO|POPULARITY_RED_POCKET_NEW|POPULARITY_RED_POCKET_V2_NEW|OPEN_LIVEROOM_SEND_GIFT|LIVE_OPEN_PLATFORM_SEND_GIFT)$/.test(name)) return ["gift"];
  if (/NOTICE_MSG|COMMON_NOTICE_DANMAKU/.test(name)) return ["notice"];
  if (/PK_BATTLE|PK_INFO|PK_WIDGET|^PK_|UNIVERSAL_EVENT/.test(name)) return ["pk"];
  if (/VOICE_JOIN|VIDEO_CONNECTION|LIVE_ROOM_TOAST|CONNECT|MULTI_CONN/.test(name)) return ["event"];
  if (/LOTTERY|RAFFLE|ANCHOR_LOT|RED_POCKET/.test(name)) return ["event"];
  if (/ONLINE_RANK_COUNT/.test(name)) return ["onlineStats"];
  if (/ONLINE_RANK/.test(name)) return ["onlineRank"];
  if (/WATCHED/.test(name)) return ["watchedStats"];
  if (/LIKE/.test(name)) return ["like"];
  if (/LIVE|PREPARING|ROOM_REAL_TIME|BLOCK|SILENT|WARNING/.test(name)) return ["event"];
  return ["event"];
}

function compactSample(entry, emitted = []) {
  const message = entry.message || {};
  const data = message.data || {};
  return {
    at: entry.at || 0,
    roomId: entry.roomId || data.room_id || data.roomid || 0,
    command: entry.command || message.cmd || "",
    emitted,
    userName:
      data.sender_uinfo?.base?.origin_info?.name ||
      data.sender_uinfo?.base?.name ||
      data.uname ||
      data.user_name ||
      "",
    giftName: data.giftName || data.gift_name || data.gift?.gift_name || "",
    text:
      message.info?.[1] ||
      data.msg ||
      data.message ||
      data.content ||
      data.msg_self ||
      data.msg_common ||
      "",
  };
}

function createReplayClient(roomId) {
  const client = new BilibiliLiveClient({
    room: String(roomId || 0),
    reconnect: false,
  });
  client.room = { roomId: Number(roomId || 0) };
  return client;
}

function replayFiles(files, options = {}) {
  const roomFilter = Number(options.room || 0);
  const stats = {
    files,
    roomFilter,
    totalLines: 0,
    parseErrors: 0,
    replayed: 0,
    commands: new Map(),
    groups: new Map(),
    emitted: new Map(),
    knownNonCritical: new Map(),
    uncoveredImportant: new Map(),
    samples: {
      gift: [],
      pk: [],
      connection: [],
      uncovered: [],
      parseErrors: [],
    },
  };

  let currentEmits = null;
  const eventNames = [
    "raw",
    "chat",
    "interact",
    "gift",
    "superChat",
    "guard",
    "like",
    "onlineStats",
    "watchedStats",
    "onlineRank",
    "pk",
    "notice",
    "event",
    "warn",
  ];
  const attachListeners = (client) => {
    for (const name of eventNames) {
      client.on(name, (payload = {}) => {
        addCount(stats.emitted, name);
        if (currentEmits) currentEmits.push(name);
        if (name === "gift" && stats.samples.gift.length < 30) stats.samples.gift.push(compactSample({ message: payload.raw || {}, command: payload.command }, [name]));
        if (name === "pk" && stats.samples.pk.length < 30) stats.samples.pk.push({ command: payload.command, mode: payload.data?.mode, status: payload.pkStatus });
        if (name === "event" && payload.eventKind === "connection" && stats.samples.connection.length < 30) {
          stats.samples.connection.push({ command: payload.command, text: payload.text || "", roomStatus: payload.roomStatus });
        }
      });
    }
    return client;
  };
  // 按房间各建一个回放客户端：打码昵称学习、连击/公告去重等跨包状态不允许跨房串扰。
  const clientsByRoom = new Map();
  const clientFor = (roomId) => {
    const key = Number(roomId || 0);
    if (!clientsByRoom.has(key)) {
      clientsByRoom.set(key, attachListeners(createReplayClient(key)));
    }
    return clientsByRoom.get(key);
  };

  for (const file of files) {
    for (const entry of readJsonl(file, { tolerateTruncatedTail: options.tolerateTruncatedTail })) {
      stats.totalLines += 1;
      if (entry.__parseError) {
        stats.parseErrors += 1;
        if (stats.samples.parseErrors.length < 10) stats.samples.parseErrors.push({ file, line: entry.__line, error: entry.__parseError });
        continue;
      }
      const command = entry.command || entry.message?.cmd || "";
      const entryRoom = Number(entry.roomId || entry.message?.data?.room_id || entry.message?.data?.roomid || 0);
      if (roomFilter && entryRoom && entryRoom !== roomFilter) continue;
      const client = clientFor(entryRoom || roomFilter || 0);
      addCount(stats.commands, command);
      addCount(stats.groups, classifyCommand(command));
      if (KNOWN_NON_CRITICAL_COMMANDS.has(command)) addCount(stats.knownNonCritical, command);

      currentEmits = [];
      try {
        client.handlePacket({
          operation: 5,
          body: Buffer.from(JSON.stringify(entry.message || {})),
        });
        stats.replayed += 1;
      } catch (error) {
        addCount(stats.emitted, "exception");
        currentEmits.push("exception");
      }
      const highEmits = currentEmits.filter((name) => name !== "raw");
      const expected = expectedHighEvents(command);
      const covered = expected.some((name) => highEmits.includes(name));
      if (importantCommand(command) && !covered) {
        addCount(stats.uncoveredImportant, command);
        if (stats.samples.uncovered.length < 40) {
          stats.samples.uncovered.push(compactSample(entry, currentEmits));
        }
      }
      currentEmits = null;
    }
  }

  return {
    files,
    roomFilter,
    totalLines: stats.totalLines,
    parseErrors: stats.parseErrors,
    replayed: stats.replayed,
    commands: top(stats.commands, 40),
    groups: top(stats.groups, 20),
    emitted: top(stats.emitted, 20),
    knownNonCritical: top(stats.knownNonCritical, 20),
    uncoveredImportant: top(stats.uncoveredImportant, 40),
    samples: stats.samples,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, "..");
  const rawDir = path.resolve(rootDir, "state", "raw");
  const files = (args.files.length ? args.files : listDefaultRawFiles(rawDir, args.room)).map((file) =>
    path.resolve(process.cwd(), file)
  );
  if (!files.length) {
    throw new Error("没有找到 raw jsonl。用法：node scripts/replay-raw.js [--room 1882952804] state/raw/xxx.raw.jsonl");
  }
  if (!args.files.length) {
    console.log(`未指定文件，默认只回放最近 ${files.length} 个 raw 文件（上限 4 个）。`);
  }
  const result = replayFiles(files, args);
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  console.log(`raw 回放完成：${result.replayed}/${result.totalLines} 行，文件 ${result.files.length} 个`);
  console.log("命令分组：", result.groups.map((item) => `${item.name}:${item.count}`).join("  "));
  console.log("高层事件：", result.emitted.map((item) => `${item.name}:${item.count}`).join("  "));
  console.log("已知非关键：", result.knownNonCritical.length ? result.knownNonCritical.map((item) => `${item.name}:${item.count}`).join("  ") : "无");
  console.log("重要缺口：", result.uncoveredImportant.length ? result.uncoveredImportant.map((item) => `${item.name}:${item.count}`).join("  ") : "无");
  console.log("Top commands：", result.commands.slice(0, 18).map((item) => `${item.name}:${item.count}`).join("  "));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  replayFiles,
  readJsonl,
};
