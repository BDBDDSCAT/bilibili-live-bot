#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { replayFiles, readJsonl } = require("./replay-raw");

const ROOT = path.resolve(__dirname, "..");
// 默认审计仓库 state/；audit({ stateDir }) 可指向任意目录（fixtures、外置 history.dir 等）。
const DEFAULT_STATE_DIR = path.join(ROOT, "state");

const GROUPS = [
  {
    key: "chat",
    label: "弹幕",
    commands: ["DANMU_MSG", "OPEN_LIVEROOM_DM", "LIVE_OPEN_PLATFORM_DM"],
    kinds: ["chat"],
  },
  {
    key: "enter",
    label: "进房/关注",
    commands: [
      "INTERACT_WORD",
      "INTERACT_WORD_V2",
      "DM_INTERACTION",
      "ENTRY_EFFECT",
      "ENTRY_EFFECT_MUST_RECEIVE",
      "OPEN_PLATFORM_LIVE_ROOM_ENTER",
      "OPEN_LIVEROOM_LIVE_ROOM_ENTER",
      "LIVE_OPEN_PLATFORM_ENTER_ROOM",
    ],
    kinds: ["enter", "follow"],
  },
  {
    key: "gift",
    label: "礼物/盲盒/全站公告",
    commands: [
      "SEND_GIFT",
      "OPEN_LIVEROOM_SEND_GIFT",
      "LIVE_OPEN_PLATFORM_SEND_GIFT",
      "COMBO_SEND",
      "GIFT_COMBO",
      "POPULARITY_RED_POCKET_NEW",
      "POPULARITY_RED_POCKET_V2_NEW",
      "NOTICE_MSG",
    ],
    kinds: ["gift"],
  },
  {
    key: "guard",
    label: "大航海",
    commands: [
      "GUARD_BUY",
      "USER_TOAST_MSG",
      "USER_TOAST_MSG_V2",
      "OPEN_LIVEROOM_GUARD",
      "LIVE_OPEN_PLATFORM_GUARD",
      "GUARD_HONOR_THOUSAND",
    ],
    kinds: ["guard"],
  },
  {
    key: "superChat",
    label: "醒目留言",
    commands: [
      "SUPER_CHAT_MESSAGE",
      "SUPER_CHAT_MESSAGE_JPN",
      "SUPER_CHAT_MESSAGE_DELETE",
      "OPEN_LIVEROOM_SUPER_CHAT",
      "LIVE_OPEN_PLATFORM_SUPER_CHAT",
    ],
    kinds: ["superChat"],
  },
  {
    key: "pk",
    label: "PK/连线",
    commands: [
      "PK_BATTLE_",
      "PK_BATTLE",
      "PK_INFO",
      "PK_WIDGET",
      "LIVE_PK_",
      "UNIVERSAL_EVENT_GIFT",
      "LIVE_ROOM_TOAST_MESSAGE",
      "VOICE_JOIN_",
    ],
    kinds: ["pk"],
  },
];

const KNOWN_COMMAND_PREFIXES = new Set(
  GROUPS.flatMap((group) => group.commands).concat([
    "NOTICE_MSG",
    "ONLINE_RANK_COUNT",
    "ONLINE_RANK_V3",
    "ONLINE_RANK_V2",
    "WATCHED_CHANGE",
    "ROOM_REAL_TIME_MESSAGE_UPDATE",
    "STOP_LIVE_ROOM_LIST",
    "LIKE_INFO_V3_UPDATE",
    "LIKE_INFO_V3_CLICK",
    "PK_INFO",
    "PK_WIDGET",
    "POPULAR_RANK_CHANGED",
    "RANK_CHANGED",
    "RANK_CHANGED_V2",
    "TRADING_SCORE",
    "LIVE_ROOM_TOAST_MESSAGE",
    "VOICE_JOIN_ROOM_COUNT_INFO",
    "VOICE_JOIN_LIST",
    "GUARD_HONOR_THOUSAND",
    "ANCHOR_LOT",
    "RED_POCKET",
    "LOTTERY",
    "RAFFLE",
    "ACTIVITY_BANNER",
    "POPULARITY_RED_POCKET",
    "COMMON_NOTICE_DANMAKU",
    "CUSTOM_NOTICE_CARD",
    "GIFT_PANEL_PLAN",
    "LOG_IN_NOTICE",
    "LIVE",
    "LIVE_INTERACT_GAME_STATE_CHANGE",
    "LIVE_OPEN_PLATFORM_GAME",
    "LIVE_PANEL_CHANGE_CONTENT",
    "MESSAGEBOX_USER_MEDAL_CHANGE",
    "OPENPLATFORM_GAME_BUTTON_STATUS_CHANGE",
    "PREPARING",
    "ROOM_SKIN_MSG",
    "SYS_MSG",
    "WEALTH_NOTIFY",
    "WIDGET_BANNER",
    "WIDGET_GIFT_STAR_PROCESS",
    "WIDGET_GIFT_STAR_PROCESS_V2",
    "PLAYTOGETHER",
    "RANK_REM",
    "RECALL_DANMU_MSG",
    "WARNING",
    "DANMU_AGGREGATION",
    "FLOW_REWARD_CARD",
    "POPULARITY_RANK_TAB_CHG",
    "ROOM_CHANGE",
  ])
);

function parseArgs(argv) {
  const args = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
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

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(predicate)
    .map((name) => path.join(dir, name))
    .sort();
}

function matchesRoom(value, room) {
  if (!room) return true;
  return String(value || "") === String(room);
}

function rawFilesFor({ day = "", room = "" }, stateDir = DEFAULT_STATE_DIR) {
  return listFiles(path.join(stateDir, "raw"), (name) => {
    if (!name.endsWith(".raw.jsonl")) return false;
    if (day && !name.startsWith(day)) return false;
    if (room && !name.includes(`-${room}.raw.jsonl`)) return false;
    return true;
  });
}

function eventFilesFor({ day = "" }, stateDir = DEFAULT_STATE_DIR) {
  return listFiles(path.join(stateDir, "events"), (name) => {
    if (!name.endsWith(".jsonl")) return false;
    if (name.includes(".pre-compact")) return false;
    return day ? name === `${day}.jsonl` : true;
  });
}

function localDayKey(date = new Date()) {
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

// 当天的文件可能正在被在跑进程追加，读到的最后一行常常是半行 JSON；
// 只对"文件名日期 == 今天"的文件豁免尾行解析失败，历史文件的坏行仍然计错。
function readJsonlTolerantToday(filePath) {
  const isToday = path.basename(filePath).startsWith(localDayKey());
  return readJsonl(filePath, { tolerateTruncatedTail: isToday });
}

function increment(map, key, count = 1) {
  const value = key || "UNKNOWN";
  map.set(value, (map.get(value) || 0) + count);
}

function sortedCounts(map, limit = 40) {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

function rawCommand(row = {}) {
  return row.command || row.message?.cmd || row.cmd || "";
}

function noticeIsGift(message = {}) {
  const text = [message.msg_self, message.msg_common, message.name].filter(Boolean).join(" ");
  return Number(message.msg_type || 0) === 2 || /投喂|送出|礼物|盲盒/.test(text);
}

function rawMatchesGroup(row = {}, group) {
  const command = rawCommand(row);
  if (!command) return false;
  if (group.key === "gift" && command === "NOTICE_MSG") {
    return noticeIsGift(row.message || row);
  }
  return group.commands.some((prefix) => command === prefix || command.startsWith(prefix));
}

function eventMatchesGroup(row = {}, group) {
  const kind = row.kind || "";
  const payload = row.payload || {};
  if (group.kinds.includes(kind)) return true;
  if (group.key === "gift" && kind === "notice") return payload.noticeKind === "gift";
  if (group.key === "pk" && kind === "event") {
    return /^(PK_|PK_BATTLE|LIVE_PK|VOICE_JOIN|VIDEO_CONNECTION|LIVE_ROOM_TOAST_MESSAGE)/.test(
      String(payload.command || "")
    );
  }
  if (group.key === "guard" && kind === "event") {
    return payload.eventKind === "guard_honor" || payload.command === "GUARD_HONOR_THOUSAND";
  }
  return false;
}

function countRealGroupEvents(eventRows = [], group) {
  return eventRows.filter((row) => {
    const payload = row.payload || {};
    return !isSimulatedEvent(row, payload) && eventMatchesGroup(row, group);
  }).length;
}

function commandMatches(command = "", prefixes = []) {
  return prefixes.some((prefix) => command === prefix || command.startsWith(prefix));
}

function replayUncoveredCountForGroup(replay = {}, group = {}) {
  const uncovered = Array.isArray(replay.uncoveredImportant) ? replay.uncoveredImportant : [];
  return uncovered
    .filter((item) => commandMatches(item.name, group.commands))
    .reduce((sum, item) => sum + Number(item.count || 0), 0);
}

function rawCountFor(rawRows = [], prefixes = [], predicate = null) {
  return uniqueRawRows(rawRows, prefixes, predicate).length;
}

function uniqueBusinessCount(rows = [], keyFn) {
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    seen.add(key);
  }
  return seen.size;
}

function giftBusinessRawKey(row = {}) {
  const command = rawCommand(row);
  if (
    !commandMatches(command, [
      "SEND_GIFT",
      "OPEN_LIVEROOM_SEND_GIFT",
      "LIVE_OPEN_PLATFORM_SEND_GIFT",
      "COMBO_SEND",
      "GIFT_COMBO",
    ])
  ) {
    return "";
  }
  const message = row.message || row.raw || row;
  const data = message.data || {};
  const uid = data.uid || data.open_id || data.sender_uinfo?.uid || "";
  const giftId = data.gift_id || data.giftId || data.combo_send?.gift_id || "";
  const batch = data.batch_combo_id || data.batch_combo_send?.batch_combo_id || data.combo_id || data.combo_send?.combo_id || "";
  if (batch) return `batch:${uid}:${giftId}:${batch}`;
  const uniqueId = data.tid || data.rnd || data.id || message.msg_id || row.id || "";
  if (uniqueId) return `id:${command}:${uid}:${giftId}:${uniqueId}`;
  return `raw:${command}:${uid}:${giftId}:${JSON.stringify(data).slice(0, 220)}`;
}

function giftBusinessEventKey(row = {}) {
  if (!isDirectGiftEvent(row)) return "";
  return giftEventIdentityKey(row);
}

function giftEventIdentityKey(row = {}) {
  const payload = row.payload || {};
  if (row.kind !== "gift") return "";
  const id = payload.id || payload.dedupeKey || payload.batchKey || payload.raw?.msg_id || "";
  if (id) return `id:${id}`;
  return `event:${payload.command || "gift"}:${payload.userId || payload.uid || payload.userName || ""}:${payload.giftId || ""}:${payload.giftName || ""}:${payload.count || ""}:${payload.at || row.at || ""}`;
}

function giftEventSourceCommand(row = {}, payload = row.payload || {}) {
  return String(payload.sourceCommand || payload.command || payload.raw?.cmd || payload.raw?.command || row.command || "");
}

function isDirectGiftEvent(row = {}, payload = row.payload || {}) {
  if (row.kind !== "gift") return false;
  const command = giftEventSourceCommand(row, payload);
  return commandMatches(command, ["SEND_GIFT", "COMBO_SEND", "GIFT_COMBO", "OPEN_LIVEROOM_SEND_GIFT", "LIVE_OPEN_PLATFORM_SEND_GIFT"]);
}

function fallbackGiftTextEventKey(row = {}) {
  const payload = row.payload || {};
  if (row.kind !== "gift") return "";
  const command = giftEventSourceCommand(row, payload);
  const source = String(payload.source || "");
  if (
    !commandMatches(command, ["ASSISTANT_GIFT_TEXT", "DANMU_GIFT_FALLBACK"]) &&
    !/assistant_text|danmu_gift_fallback/i.test(source)
  ) {
    return "";
  }
  return giftEventIdentityKey(row);
}

function guardBusinessRawKey(row = {}) {
  const command = rawCommand(row);
  if (!commandMatches(command, ["GUARD_BUY", "USER_TOAST_MSG", "USER_TOAST_MSG_V2", "OPEN_LIVEROOM_GUARD", "LIVE_OPEN_PLATFORM_GUARD"])) {
    return "";
  }
  const message = row.message || row.raw || row;
  const data = message.data || {};
  const guardInfo = data.guard_info || {};
  const payInfo = data.pay_info || {};
  const sender = data.sender_uinfo || data.sender_info || {};
  const flowId = data.payflow_id || payInfo.payflow_id || data.order_id || data.id || "";
  if (flowId) return `pay:${flowId}`;
  const uid = data.uid || data.open_id || data.user_info?.uid || sender.uid || "";
  const level = data.guard_level || data.guardLevel || guardInfo.guard_level || "";
  const count = data.num || data.guard_num || payInfo.num || 1;
  const start = data.start_time || guardInfo.start_time || data.timestamp || message.send_time || message.timestamp || "";
  return `guard:${uid}:${level}:${count}:${start}`;
}

function guardBusinessEventKey(row = {}) {
  const payload = row.payload || {};
  if (row.kind !== "guard") return "";
  const data = payload.raw?.data || {};
  const flowId = data.payflow_id || data.pay_info?.payflow_id || data.order_id || data.id || "";
  if (flowId) return `pay:${flowId}`;
  const id = payload.id || payload.dedupeKey || payload.raw?.msg_id || "";
  if (id) return `id:${id}`;
  return `guard:${payload.userId || payload.uid || payload.userName || ""}:${payload.guardLevel || ""}:${payload.count || 1}:${data.start_time || data.guard_info?.start_time || payload.at || row.at || ""}`;
}

function giftBusinessRawCountFor(rawRows = []) {
  return uniqueBusinessCount(rawRows, giftBusinessRawKey);
}

function giftBusinessEventCountFor(eventRows = []) {
  return uniqueBusinessCount(
    eventRows.filter((row) => !isSimulatedEvent(row, row.payload || {})),
    giftBusinessEventKey
  );
}

function fallbackGiftTextEventCountFor(eventRows = []) {
  return uniqueBusinessCount(
    eventRows.filter((row) => !isSimulatedEvent(row, row.payload || {})),
    fallbackGiftTextEventKey
  );
}

function guardBusinessRawCountFor(rawRows = []) {
  return uniqueBusinessCount(rawRows, guardBusinessRawKey);
}

function guardBusinessEventCountFor(eventRows = []) {
  return uniqueBusinessCount(
    eventRows.filter((row) => !isSimulatedEvent(row, row.payload || {})),
    guardBusinessEventKey
  );
}

function rawStableKey(row = {}) {
  const command = rawCommand(row);
  const message = row.message || row.raw || row;
  const data = message.data || {};
  if (command === "UNIVERSAL_EVENT_GIFT") {
    const info = data.info || {};
    return [
      command,
      data.room_id,
      info.biz_session_id,
      info.interact_channel_id,
      info.business_label,
      info.interact_template?.template_id,
      info.interact_template?.layout_id,
      info.version,
      info.members_version,
    ]
      .filter((part) => part !== undefined && part !== null && part !== "")
      .join(":");
  }
  if (/GIFT|COMBO|RED_POCKET/.test(command)) {
    return [
      command,
      data.batch_combo_id,
      data.batch_combo_send?.batch_combo_id,
      data.combo_id,
      data.combo_send?.combo_id,
      data.rnd,
      data.uid,
      data.open_id,
      data.gift_id || data.giftId,
      data.gift_name || data.giftName,
      data.num || data.gift_num || data.count,
      data.timestamp || data.send_time || message.timestamp,
    ]
      .filter((part) => part !== undefined && part !== null && part !== "")
      .join(":");
  }
  if (command === "NOTICE_MSG" || command === "COMMON_NOTICE_DANMAKU") {
    return [
      command,
      message.msg_type,
      message.msg_common,
      message.msg_self,
      message.name,
      message.timestamp,
      data.timestamp,
      data.id,
    ]
      .filter((part) => part !== undefined && part !== null && part !== "")
      .join(":");
  }
  if (command === "DANMU_MSG") {
    const info = message.info || [];
    return [
      command,
      info?.[0]?.[12],
      info?.[0]?.[13],
      info?.[2]?.[0],
      info?.[1],
      message.timestamp,
    ]
      .filter((part) => part !== undefined && part !== null && part !== "")
      .join(":");
  }
  return `${command}:${JSON.stringify(message)}`;
}

function uniqueRawRows(rawRows = [], prefixes = [], predicate = null) {
  const seen = new Set();
  return rawRows.filter((row) => {
    const command = rawCommand(row);
    if (!commandMatches(command, prefixes)) return false;
    if (predicate && !predicate(row)) return false;
    const key = rawStableKey(row);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventCountFor(eventRows = [], predicate) {
  return eventRows.filter((row) => predicate(row, row.payload || {})).length;
}

function isSimulatedEvent(row = {}, payload = row.payload || {}) {
  // 用近似词边界匹配模拟来源：'self_test'/'simulation' 命中，'latest' 这类真实值不误伤。
  return (
    row.isSimulated === true ||
    payload.isSimulated === true ||
    /(^|[^a-z])(simulate|simulated|simulation|test)/i.test(String(row.source || payload.source || payload.ingestSource || ""))
  );
}

function realEventCountFor(eventRows = [], predicate) {
  return eventCountFor(eventRows, (row, payload) => !isSimulatedEvent(row, payload) && predicate(row, payload));
}

function eventPayloadCommand(row = {}) {
  const payload = row.payload || {};
  return String(payload.command || payload.cmd || payload.rawCommand || row.command || "");
}

function replayEmittedCount(replay = {}, name = "") {
  return Number((replay.emitted || []).find((item) => item.name === name)?.count || 0);
}

function multiPkIndicators(message = {}, payload = {}) {
  const data = message.data || payload.data || {};
  const info = data.info || payload.info || {};
  const template = info.interact_template || data.interact_template || {};
  const pkBasic = data.pk_basic || payload.pkBasic || {};
  const members = info.members || data.members || payload.multiMembers || payload.members || payload.rooms || [];
  const templateId = String(
    message.template_id ||
      payload.templateId ||
      payload.template_id ||
      data.template_id ||
      template.template_id ||
      pkBasic.template_id ||
      ""
  );
  const businessLabel = String(info.business_label || payload.businessLabel || payload.business_label || data.business_label || "");
  const mode = String(payload.mode || payload.connectionMode || data.mode || "");
  const battleType = Number(data.battle_type || pkBasic.type || pkBasic.battle_type || payload.battleType || 0);
  const matchType = Number(data.match_type || pkBasic.sub_type || payload.matchType || 0);
  const multiPkType = Number(pkBasic.muti_pk_type || pkBasic.multi_pk_type || data.muti_pk_type || data.multi_pk_type || 0);
  return {
    members,
    text: [templateId, businessLabel, mode].filter(Boolean).join(" "),
    battleType,
    matchType,
    multiPkType,
  };
}

function hasMultiPkIndicators(indicators = {}) {
  return (
    /multi|conn|grid|连线/i.test(indicators.text || "") ||
    indicators.battleType === 6 ||
    indicators.matchType === 5 ||
    indicators.multiPkType > 0
  );
}

function rawIsMultiPkConnection(row = {}) {
  const command = rawCommand(row);
  const message = row.message || row.raw || row;
  if (commandMatches(command, ["PK_MULTI_CONN", "VOICE_JOIN_", "VIDEO_CONNECTION", "LIVE_ROOM_TOAST_MESSAGE"])) {
    return true;
  }
  const indicators = multiPkIndicators(message, {});
  if (hasMultiPkIndicators(indicators)) return true;
  if (command === "UNIVERSAL_EVENT_GIFT" && Array.isArray(indicators.members) && indicators.members.length > 1) {
    return true;
  }
  return false;
}

function eventIsMultiPkConnection(row = {}, payload = row.payload || {}) {
  const command = eventPayloadCommand(row);
  if (commandMatches(command, ["PK_MULTI_CONN", "VOICE_JOIN_", "VIDEO_CONNECTION", "LIVE_ROOM_TOAST_MESSAGE"])) {
    return true;
  }
  const indicators = multiPkIndicators({}, payload);
  return (
    hasMultiPkIndicators(indicators) ||
    (Array.isArray(indicators.members) && indicators.members.length > 1) ||
    payload.mode === "multi" ||
    payload.connectionMode === "multi"
  );
}

function gateState(rawCount, eventCount, options = {}) {
  const requireRaw = options.requireRaw !== false;
  const replayCount = Number(options.replayCount || 0);
  if (rawCount > 0) {
    if (eventCount >= rawCount) return "covered";
    if (replayCount >= rawCount) return "covered_by_replay";
    return "missing";
  }
  if (eventCount > 0 && !requireRaw) return "covered";
  if (eventCount > 0 && rawCount === 0) return "eventOnly";
  return "idle";
}

function sampleGates(rawRows = [], eventRows = [], replay = {}) {
  const giftRaw = giftBusinessRawCountFor(rawRows);
  const noticeGiftRaw = rawCountFor(rawRows, ["NOTICE_MSG"], (row) => noticeIsGift(row.message || row));
  const giftEvents = giftBusinessEventCountFor(eventRows);
  const fallbackGiftTextEvents = fallbackGiftTextEventCountFor(eventRows);
  const noticeGiftEvents = realEventCountFor(
    eventRows,
    (row, payload) => row.kind === "notice" && payload.noticeKind === "gift"
  );

  const superChatPrefixes = [
    "SUPER_CHAT_MESSAGE",
    "SUPER_CHAT_MESSAGE_JPN",
    "SUPER_CHAT_MESSAGE_DELETE",
    "OPEN_LIVEROOM_SUPER_CHAT",
    "LIVE_OPEN_PLATFORM_SUPER_CHAT",
  ];
  const superChatRaw = rawCountFor(rawRows, superChatPrefixes);
  const superChatEvents = realEventCountFor(eventRows, (row) => row.kind === "superChat");

  const guardPrefixes = [
    "GUARD_BUY",
    "USER_TOAST_MSG",
    "USER_TOAST_MSG_V2",
    "OPEN_LIVEROOM_GUARD",
    "LIVE_OPEN_PLATFORM_GUARD",
  ];
  const guardRaw = guardBusinessRawCountFor(rawRows);
  const guardEvents = guardBusinessEventCountFor(eventRows);
  const guardHonorRaw = rawCountFor(rawRows, ["GUARD_HONOR_THOUSAND"]);
  const guardHonorEvents = realEventCountFor(
    eventRows,
    (row, payload) => row.kind === "event" && (payload.eventKind === "guard_honor" || payload.command === "GUARD_HONOR_THOUSAND")
  );

  const lotteryPrefixes = [
    "ANCHOR_LOT",
    "POPULARITY_RED_POCKET",
    "RAFFLE",
    "LOTTERY",
    "ACTIVITY_BANNER",
  ];
  const lotteryRaw = rawCountFor(rawRows, lotteryPrefixes);
  const lotteryEvents = realEventCountFor(eventRows, (row, payload) => {
    const text = [eventPayloadCommand(row), payload.activityType, payload.activityKind, payload.name]
      .filter(Boolean)
      .join(" ");
    return /ANCHOR_LOT|POPULARITY_RED_POCKET|RED_POCKET|LOTTERY|RAFFLE|抽奖|红包|天选/i.test(text);
  });

  const multiPkPrefixes = [
    "PK_MULTI_CONN",
    "PK_BATTLE_",
    "PK_INFO",
    "UNIVERSAL_EVENT_GIFT",
    "VOICE_JOIN_LIST",
    "VOICE_JOIN_ROOM_COUNT_INFO",
    "VOICE_JOIN_STATUS",
    "VIDEO_CONNECTION",
    "LIVE_ROOM_TOAST_MESSAGE",
  ];
  const multiPkRaw = rawCountFor(rawRows, multiPkPrefixes, rawIsMultiPkConnection);
  const multiPkEvents = realEventCountFor(eventRows, eventIsMultiPkConnection);
  const multiPkReplay = replayEmittedCount(replay, "pk");

  const visibleBridgeEvents = realEventCountFor(eventRows, (row, payload) => {
    const text = [row.source, payload.source, payload.ingestSource, payload.bridgeVersion, payload.captureSource]
      .filter(Boolean)
      .join(" ");
    return /visible|bridge|dom|网页|补抓/i.test(text);
  });

  const gates = [
    {
      key: "paidGift",
      label: "直播间付费礼物",
      rawCount: giftRaw,
      eventCount: giftEvents,
      replayCount: replayEmittedCount(replay, "gift"),
      state: gateState(giftRaw, giftEvents, { replayCount: replayEmittedCount(replay, "gift") }),
      detail: `送礼批次 ${giftRaw}，已入库 ${giftEvents}；不含全站公告`,
      action: giftRaw ? "核对礼物流和长图" : "继续监听有人送礼的时段",
    },
    ...(fallbackGiftTextEvents
      ? [
          {
            key: "fallbackGiftText",
            label: "文字补记礼物",
            rawCount: 0,
            eventCount: fallbackGiftTextEvents,
            state: gateState(0, fallbackGiftTextEvents),
            detail: `弹幕/小助理文字补记 ${fallbackGiftTextEvents} 条，已入库 ${fallbackGiftTextEvents}；不是 B站直接送礼包，不能当作已对上的送礼包`,
            action: "需要网页核对或直播间可见礼物核对后再确认",
          },
        ]
      : []),
    {
      key: "globalGiftNotice",
      label: "全站礼物公告",
      rawCount: noticeGiftRaw,
      eventCount: noticeGiftEvents,
      replayCount: replayEmittedCount(replay, "notice"),
      state: gateState(noticeGiftRaw, noticeGiftEvents, { replayCount: replayEmittedCount(replay, "notice") }),
      detail: `全站公告 ${noticeGiftRaw}，已入库 ${noticeGiftEvents}；只提示，不计入本房礼物统计`,
      action: noticeGiftRaw ? "只核对公告展示，不计入本房礼物流水" : "等待全站公告样本",
    },
    {
      key: "superChat",
      label: "醒目留言 SC",
      rawCount: superChatRaw,
      eventCount: superChatEvents,
      replayCount: replayEmittedCount(replay, "superChat"),
      state: gateState(superChatRaw, superChatEvents, { replayCount: replayEmittedCount(replay, "superChat") }),
      detail: `收到样本 ${superChatRaw}，已入库 ${superChatEvents}`,
      action: superChatRaw ? "检查 SC 解析和截图触发" : "等待真实 SC 样本",
    },
    {
      key: "guardBuy",
      label: "大航海购买/续费",
      rawCount: guardRaw,
      eventCount: guardEvents,
      replayCount: replayEmittedCount(replay, "guard"),
      state: gateState(guardRaw, guardEvents, { replayCount: replayEmittedCount(replay, "guard") }),
      detail: `购买/续费上船流水 ${guardRaw}，已入库 ${guardEvents}`,
      action: guardRaw ? "检查掉舰榜和积分入账" : "等待舰长/提督/总督购买或续费样本",
    },
    {
      key: "guardHonor",
      label: "大航海荣誉榜变化",
      rawCount: guardHonorRaw,
      eventCount: guardHonorEvents,
      state: gateState(guardHonorRaw, guardHonorEvents),
      detail: `荣誉榜变化 ${guardHonorRaw}，已入库 ${guardHonorEvents}；这是荣誉榜/千舰变化，不等于购买续费`,
      action: guardHonorRaw ? "只作为大航海榜变化参考，不计入掉舰购买流水" : "等待荣誉榜变化样本",
    },
    {
      key: "lotteryRedPocket",
      label: "天选/红包活动",
      rawCount: lotteryRaw,
      eventCount: lotteryEvents,
      state: gateState(lotteryRaw, lotteryEvents),
      detail: `收到样本 ${lotteryRaw}，已入库 ${lotteryEvents}`,
      action: lotteryRaw ? "检查暂停欢迎/感谢逻辑" : "等待天选/红包真实样本",
    },
    {
      key: "multiPkLine",
      label: "多人 PK/连线",
      rawCount: multiPkRaw,
      eventCount: multiPkEvents,
      replayCount: multiPkReplay,
      state: gateState(multiPkRaw, multiPkEvents, { replayCount: multiPkReplay }),
      detail: `收到样本 ${multiPkRaw}，已入库 ${multiPkEvents}${
        multiPkReplay > multiPkEvents ? `，历史样本可补回 ${multiPkReplay}` : ""
      }`,
      action: multiPkRaw ? "检查多人对手房间侦查" : "等待多人 PK 或连线样本",
    },
    {
      key: "visibleBridge",
      label: "网页核对",
      rawCount: 0,
      eventCount: visibleBridgeEvents,
      state: visibleBridgeEvents > 0 ? "covered" : "idle",
      detail: `网页核对入库 ${visibleBridgeEvents}`,
      action: visibleBridgeEvents ? "核对已入库内容" : "在 B站直播页启用网页核对脚本",
    },
  ];
  return gates;
}

function gateIsCovered(gate = {}) {
  return gate.state === "covered" || gate.state === "covered_by_replay";
}

function auditGroupDisplayLabel(group = {}, gates = []) {
  if (group.key === "gift") {
    const paidGift = gates.find((item) => item.key === "paidGift") || {};
    const globalNotice = gates.find((item) => item.key === "globalGiftNotice") || {};
    const fallback = gates.find((item) => item.key === "fallbackGiftText") || {};
    const parts = [];
    if (gateIsCovered(paidGift)) parts.push("直播间送礼包");
    if (gateIsCovered(globalNotice)) parts.push("全站礼物公告");
    if (!parts.length) return group.label || "礼物事件";
    return fallback.state === "eventOnly" ? `${parts.join("、")}（不含文字补记）` : parts.join("、");
  }
  if (group.key === "guard") {
    const guardBuy = gates.find((item) => item.key === "guardBuy") || {};
    const guardHonor = gates.find((item) => item.key === "guardHonor") || {};
    const buyCovered = gateIsCovered(guardBuy);
    const honorCovered = gateIsCovered(guardHonor);
    if (buyCovered && honorCovered) return "大航海购买/续费、荣誉榜变化";
    if (buyCovered) return "大航海购买/续费";
    if (honorCovered) return "大航海荣誉榜变化（不含购买/续费）";
    return "大航海已出现事件";
  }
  return group.label || group.key || "";
}

function auditOperatorSummary(report = {}) {
  const groups = Array.isArray(report.groups) ? report.groups : [];
  const gates = Array.isArray(report.sampleGates) ? report.sampleGates : [];
  const parserReplay = report.parserReplay || {};
  const unknown = Array.isArray(report.unknownCommands) ? report.unknownCommands : [];
  const context = report.context || {};
  const hasRoomLiveStatus = context.roomLiveStatus !== null && context.roomLiveStatus !== undefined && context.roomLiveStatus !== "";
  const roomOffline = Boolean(context.roomOffline || (hasRoomLiveStatus && Number(context.roomLiveStatus) === 0));
  const missing = [
    ...groups.filter((item) => item.state === "missing").map((item) => item.displayLabel || item.label || item.key),
    ...gates.filter((item) => item.state === "missing").map((item) => item.label || item.key),
  ].filter(Boolean);
  const parserUncovered = Array.isArray(parserReplay.uncoveredImportant)
    ? parserReplay.uncoveredImportant.map((item) => item.name || item.command).filter(Boolean)
    : [];
  const blockers = [];
  const nextSteps = [];
  const fallbackGift = gates.find((item) => item.key === "fallbackGiftText") || {};
  const visibleBridge = gates.find((item) => item.key === "visibleBridge") || {};
  const superChat = gates.find((item) => item.key === "superChat") || {};
  const guardBuy = gates.find((item) => item.key === "guardBuy") || {};
  const replayRecovered = [
    ...groups.filter((item) => item.state === "covered_by_replay").map((item) => item.displayLabel || item.label || item.key),
    ...gates.filter((item) => item.state === "covered_by_replay").map((item) => item.label || item.key),
  ].filter(Boolean);

  if (missing.length) blockers.push(`真实缺口：${missing.slice(0, 4).join("、")}`);
  if (parserUncovered.length) blockers.push(`解析器未覆盖：${parserUncovered.slice(0, 4).join("、")}`);
  if (unknown.length) blockers.push(`新命令待分类：${unknown.slice(0, 4).map((item) => item.name).join("、")}`);
  if (fallbackGift.state === "eventOnly") blockers.push("文字补记礼物：不是 B站直接送礼包，需要网页核对");
  if (visibleBridge.state === "idle") blockers.push("网页核对：未接入，完整昵称、头像和网页礼物泡泡不能判满分");
  if (superChat.state === "idle") blockers.push("醒目留言 SC：这段监听还没出现真实样本");
  if (guardBuy.state === "idle") blockers.push("大航海购买/续费：这段监听还没出现上船/续费流水");

  if (fallbackGift.state === "eventOnly" || visibleBridge.state === "idle") {
    nextSteps.push(
      roomOffline
        ? "当前房间未开播，保持安全监听即可；开播后再运行网页核对脚本，核对完整昵称、头像和网页可见礼物泡泡"
        : "点“复制网页核对脚本”，核对完整昵称、头像和网页可见礼物泡泡"
    );
  }
  const waitingSamples = [];
  if (superChat.state === "idle") waitingSamples.push("醒目留言 SC");
  if (guardBuy.state === "idle") waitingSamples.push("上船购买/续费");
  if (waitingSamples.length) {
    nextSteps.push(`继续安全监听；等 ${waitingSamples.join("、")} 真实出现后再判定这些模块`);
  }
  if (replayRecovered.length) {
    nextSteps.push(`旧记录可通过历史样本复查恢复：${replayRecovered.slice(0, 3).join("、")}`);
  }
  if (missing.length || parserUncovered.length || unknown.length) {
    nextSteps.unshift("先排查真实缺口或新命令，再开放自动托管");
  }

  const level = missing.length || parserUncovered.length || unknown.length ? "danger" : blockers.length ? "warn" : "ok";
  const title =
    level === "danger"
      ? "发现真实缺口，先别说抓全"
      : level === "warn"
        ? "已出现样本对账通过，但还不能判满分"
        : "当前可验证样本对账通过";
  return {
    level,
    title,
    blockers: blockers.slice(0, 8),
    nextSteps: nextSteps.slice(0, 6),
    replayRecovered: replayRecovered.slice(0, 6),
    canClaimPerfect: level === "ok",
  };
}

function loadSnapshot(name, stateDir = DEFAULT_STATE_DIR) {
  const filePath = path.join(stateDir, "snapshots", `${name}.json`);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function giftCatalogNameCandidates(name = "") {
  const raw = String(name || "").trim();
  if (!raw) return [];
  const values = [raw];
  for (const part of raw.split(/[，,、+＋/|]/)) {
    const text = String(part || "").trim();
    if (!text) continue;
    values.push(text);
    const withoutCount = text
      .replace(/\s*[xX][0-9０-９一二三四五六七八九十百千万]+$/u, "")
      .replace(/\s*[xX][lL]$/u, "")
      .trim();
    if (withoutCount && withoutCount !== text) values.push(withoutCount);
  }
  return [...new Set(values.filter(Boolean))];
}

function catalogGiftFor(gift = {}, catalog = {}) {
  const items = Array.isArray(catalog.items) ? catalog.items : [];
  const byId = new Map(items.map((item) => [Number(item.id || item.giftId || 0), item]));
  const giftId = Number(gift.giftId || gift.gift_id || 0);
  if (giftId && byId.has(giftId)) return byId.get(giftId);
  for (const name of giftCatalogNameCandidates(gift.giftName || gift.name)) {
    const found = items.find((item) => String(item.name || item.giftName || "") === name);
    if (found) return found;
  }
  return null;
}

function faceIndexFromEvents(events = []) {
  const byUserId = new Map();
  const byName = new Map();
  for (const row of events) {
    const payload = row.payload || row;
    const face = payload.face || payload.faceUrl || "";
    if (!face) continue;
    const userId = Number(payload.userId || payload.uid || 0);
    const name = String(payload.userName || payload.displayUserName || "").trim();
    if (userId) byUserId.set(userId, face);
    if (name) byName.set(name, face);
  }
  return { byUserId, byName };
}

function giftQuality(events = [], catalog = {}) {
  const gifts = events
    .filter((row) => row.kind === "gift")
    .map((row) => row.payload || {});
  const total = gifts.length;
  if (!total) return { total: 0, missingIcon: 0, recoverableIcon: 0, missingFace: 0, recoverableFace: 0, maskedName: 0, missingValue: 0 };
  const faces = faceIndexFromEvents(events);
  const missingIcon = gifts.filter((gift) => !gift.giftIcon && !catalogGiftFor(gift, catalog)?.icon).length;
  const recoverableIcon = gifts.filter((gift) => !gift.giftIcon && catalogGiftFor(gift, catalog)?.icon).length;
  const missingFace = gifts.filter((gift) => {
    if (gift.face) return false;
    const userId = Number(gift.userId || gift.uid || 0);
    const name = String(gift.userName || gift.displayUserName || "").trim();
    return !(userId && faces.byUserId.has(userId)) && !(name && faces.byName.has(name));
  }).length;
  const recoverableFace = gifts.filter((gift) => {
    if (gift.face) return false;
    const userId = Number(gift.userId || gift.uid || 0);
    const name = String(gift.userName || gift.displayUserName || "").trim();
    return (userId && faces.byUserId.has(userId)) || (name && faces.byName.has(name));
  }).length;
  const maskedName = gifts.filter((gift) => /\*{2,}/.test(String(gift.userName || gift.displayUserName || ""))).length;
  const missingValue = gifts.filter((gift) => !Number(gift.totalCoin || gift.price || 0)).length;
  return { total, missingIcon, recoverableIcon, missingFace, recoverableFace, maskedName, missingValue };
}

function snapshotRows(snapshot = {}) {
  if (Array.isArray(snapshot.rows)) return snapshot.rows;
  if (Array.isArray(snapshot.items)) return snapshot.items;
  if (Array.isArray(snapshot.list)) return snapshot.list;
  return [];
}

function guardBoardSummary(guardBoard = {}, guardCatalog = {}) {
  const boardRows = snapshotRows(guardBoard);
  const catalogRows = snapshotRows(guardCatalog);
  const boardTotal = Number(guardBoard.total || boardRows.length || 0);
  const catalogTotal = Number(guardCatalog.total || catalogRows.length || 0);
  const effectiveRows = boardRows.length ? boardRows : catalogRows;
  const effectiveTotal = boardTotal || catalogTotal || effectiveRows.length;

  return {
    catalogTotal,
    boardTotal: effectiveTotal,
    boardSource: boardRows.length || boardTotal ? "guardBoard" : catalogRows.length || catalogTotal ? "guardCatalog" : "none",
  };
}

function commandIsKnown(command = "") {
  if (!command) return true;
  return [...KNOWN_COMMAND_PREFIXES].some((prefix) => command === prefix || command.startsWith(prefix));
}

function audit(options = {}) {
  const stateDir =
    typeof options.stateDir === "string" && options.stateDir ? path.resolve(options.stateDir) : DEFAULT_STATE_DIR;
  const rawFiles = rawFilesFor(options, stateDir);
  const eventFiles = eventFilesFor(options, stateDir);
  const rawRows = rawFiles.flatMap(readJsonlTolerantToday).filter((row) => !row.__parseError && matchesRoom(row.roomId, options.room));
  const eventRows = eventFiles.flatMap(readJsonlTolerantToday).filter((row) => !row.__parseError && matchesRoom(row.roomId, options.room));
  const realEventRows = eventRows.filter((row) => !isSimulatedEvent(row, row.payload || {}));
  const replay = rawFiles.length
    ? replayFiles(rawFiles, { room: options.room || "", tolerateTruncatedTail: true })
    : {
        replayed: 0,
        totalLines: 0,
        parseErrors: 0,
        emitted: [],
        uncoveredImportant: [],
      };

  const commandCounts = new Map();
  const kindCounts = new Map();
  for (const row of rawRows) increment(commandCounts, rawCommand(row));
  for (const row of realEventRows) increment(kindCounts, row.kind || "UNKNOWN");

  const groups = GROUPS.map((group) => {
    const matchedRaw = rawRows.filter((row) => rawMatchesGroup(row, group));
    const rawPackets = matchedRaw.length;
    const expected = uniqueRawRows(rawRows, group.commands, (row) => rawMatchesGroup(row, group)).length;
    const captured = countRealGroupEvents(eventRows, group);
    const persistedState = expected === 0 ? "idle" : captured >= expected ? "covered" : "missing";
    const parserUncovered = replayUncoveredCountForGroup(replay, group);
    const parserState = expected === 0 ? "idle" : parserUncovered > 0 ? "missing" : "covered";
    const state =
      persistedState === "covered"
        ? "covered"
        : parserState === "covered"
          ? "covered_by_replay"
          : persistedState;
    return {
      key: group.key,
      label: group.label,
      rawPackets,
      expectedRaw: expected,
      capturedEvents: captured,
      persistedState,
      parserState,
      parserUncovered,
      state,
    };
  });

  // 未知命令检测必须遍历完整 commandCounts（先过滤再截断展示条数）：
  // 低频的新命令恰恰是最需要被发现的，不允许被 top-80 展示截断静默吞掉。
  const unknownCounts = new Map([...commandCounts].filter(([name]) => !commandIsKnown(name)));
  const unknownCommands = sortedCounts(unknownCounts, 80);
  const giftCatalog = loadSnapshot("giftCatalog", stateDir).giftCatalog || {};
  const guardCatalog = loadSnapshot("guardCatalog", stateDir).guardCatalog || {};
  const guardBoard = loadSnapshot("guardBoard", stateDir).guardBoard || {};
  const giftHistorySummary = loadSnapshot("giftHistorySummary", stateDir).giftHistorySummary || {};
  const guards = guardBoardSummary(guardBoard, guardCatalog);
  const gates = sampleGates(rawRows, eventRows, replay);
  const displayGroups = groups.map((group) => ({
    ...group,
    displayLabel: auditGroupDisplayLabel(group, gates),
  }));

  const roomLiveStatus = Number(options.roomLiveStatus);
  const hasRoomLiveStatus =
    options.roomLiveStatus !== null &&
    options.roomLiveStatus !== undefined &&
    options.roomLiveStatus !== "" &&
    Number.isFinite(roomLiveStatus);

  const report = {
    generatedAt: new Date().toISOString(),
	    filters: {
	      day: options.day || "",
	      room: options.room || "",
	      stateDir: path.relative(ROOT, stateDir) || ".",
	    },
    context: {
      roomLiveStatus: hasRoomLiveStatus ? roomLiveStatus : null,
      roomOffline: hasRoomLiveStatus ? roomLiveStatus === 0 : Boolean(options.roomOffline),
    },
    files: {
      raw: rawFiles.map((file) => path.relative(ROOT, file)),
      events: eventFiles.map((file) => path.relative(ROOT, file)),
    },
    totals: {
      rawRows: rawRows.length,
      eventRows: eventRows.length,
      realEventRows: realEventRows.length,
      rawCommands: commandCounts.size,
      eventKinds: kindCounts.size,
    },
    groups: displayGroups,
    parserReplay: {
      totalLines: replay.totalLines || 0,
      replayed: replay.replayed || 0,
      parseErrors: replay.parseErrors || 0,
      emitted: replay.emitted || [],
      knownNonCritical: replay.knownNonCritical || [],
      uncoveredImportant: replay.uncoveredImportant || [],
    },
    sampleGates: gates,
    rawCommands: sortedCounts(commandCounts, 30),
    eventKinds: sortedCounts(kindCounts, 30),
    unknownCommands,
    gifts: {
      quality: giftQuality(realEventRows, giftCatalog),
      catalogTotal: Number(giftCatalog.total || giftCatalog.items?.length || 0),
      roomGiftCount: Number(giftCatalog.roomGiftCount || 0),
      todayCount: Number(giftHistorySummary.totalGiftCount || 0),
      todayValueText: giftHistorySummary.totalValueText || "",
    },
    guards,
  };
  report.operatorSummary = auditOperatorSummary(report);
  return report;
}

function printText(report) {
  const lines = [];
  const title = [
    "B站直播助理功能审计",
    report.filters.room ? `房间 ${report.filters.room}` : "",
    report.filters.day ? `日期 ${report.filters.day}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  lines.push(title);
  lines.push(
    `收到记录 ${report.totals.rawRows} 行 / 已入库 ${report.totals.eventRows} 行 / 真实入库 ${
      report.totals.realEventRows ?? report.totals.eventRows
    } 行`
  );
  const operatorSummary = report.operatorSummary || auditOperatorSummary(report);
  lines.push(`结论：${operatorSummary.title}`);
  if (operatorSummary.blockers?.length) lines.push(`还差：${operatorSummary.blockers.join("；")}`);
  if (operatorSummary.nextSteps?.length) lines.push(`下一步：${operatorSummary.nextSteps.join("；")}`);
  lines.push("");
  lines.push("覆盖：");
  for (const group of report.groups) {
    const replayNote =
      group.state === "covered_by_replay"
        ? "；旧入库记录不全，历史样本复查已补回"
        : group.parserUncovered
          ? `；仍有 ${group.parserUncovered} 条未覆盖`
          : "";
    const label = group.displayLabel || group.label || group.key || "";
    lines.push(
      `- ${label}: 收到 ${group.rawPackets || 0} 条 / 去重样本 ${group.expectedRaw} 条 -> 入库 ${
        group.capturedEvents
      } 条（${textAuditStateText(group.state, group.key)}）${replayNote}`
    );
  }
  if (report.parserReplay) {
    const knownNonCriticalCount = report.parserReplay.knownNonCritical?.length || 0;
    lines.push(
      `历史样本复查：${report.parserReplay.replayed || 0}/${report.parserReplay.totalLines || 0} 行，重要缺口 ${
        report.parserReplay.uncoveredImportant?.length || 0
      } 类，已知非关键 ${knownNonCriticalCount} 类`
    );
  }
  if (report.sampleGates?.length) {
    lines.push("");
    lines.push("真实样本门槛：");
    for (const gate of report.sampleGates) {
      const replayNote = gate.state === "covered_by_replay" ? "；旧入库记录不全，历史样本复查已补回" : "";
      lines.push(
        `- ${gate.label}: 收到 ${gate.rawCount || 0} 条 -> 入库 ${gate.eventCount || 0} 条（${textAuditStateText(
          gate.state,
          gate.key
        )}）${replayNote}；${
          gate.action || gate.detail || ""
        }`
      );
    }
  }
  lines.push("");
  lines.push(
    `礼物素材：事件 ${report.gifts.quality.total}，缺图标 ${report.gifts.quality.missingIcon}（可补${
      report.gifts.quality.recoverableIcon || 0
    }），缺头像 ${report.gifts.quality.missingFace}（可补${report.gifts.quality.recoverableFace || 0}），打码 ${
      report.gifts.quality.maskedName
    }，缺价值 ${report.gifts.quality.missingValue}`
  );
  lines.push(`礼物图鉴：${report.gifts.catalogTotal} 个，当前房间 ${report.gifts.roomGiftCount} 个`);
  lines.push(`大航海：图鉴 ${report.guards.catalogTotal}，榜单 ${report.guards.boardTotal}（${report.guards.boardSource}）`);
  if (report.unknownCommands.length) {
    lines.push("");
    lines.push("需要关注的新/未分类命令：");
    for (const item of report.unknownCommands.slice(0, 12)) {
      lines.push(`- ${item.name}: ${item.count}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function textAuditStateText(state = "", key = "") {
  if (key === "fallbackGiftText" && state === "eventOnly") return "需网页核对";
  if (state === "covered") return "已对上";
  if (state === "covered_by_replay") return "可从历史样本补回";
  if (state === "missing") return "需要修";
  if (state === "eventOnly") return "来源需核对";
  return "未出现";
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const report = audit({
    day: args.day || args.date || "",
    room: args.room || args.roomId || "",
    stateDir: args["state-dir"] || args.stateDir || "",
  });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : printText(report));
}

module.exports = {
  audit,
  printText,
  _internals: {
    GROUPS,
    auditOperatorSummary,
    auditGroupDisplayLabel,
    countRealGroupEvents,
    eventMatchesGroup,
    isSimulatedEvent,
  },
};
