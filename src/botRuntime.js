"use strict";

const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { BilibiliLiveClient, extractRoomId, parseOnlineRankV2, parseOnlineRankV3 } = require("./bilibiliClient");
const { checkBiliCookie, extractCookie, sendLiveDanmu } = require("./bilibiliSender");
const { InteractionEngine, formatBattery, giftDataQuality, compactGiftFeedItem } = require("./interactionEngine");
const { PkTracker } = require("./pkTracker");
const { RuleEngine, normalizeText } = require("./ruleEngine");
const { CommandEngine } = require("./commandEngine");
const { EventStore, dayKey, summarizeGifts } = require("./eventStore");
const { GiftCatalog } = require("./giftCatalog");
const { GuardCatalog } = require("./guardCatalog");
const { PointsEngine } = require("./pointsEngine");
const { ScreenshotService, readableScreenshotError } = require("./screenshotService");
const { PkInvestigator } = require("./pkInvestigator");
const LocalAiClient = require("./localAiClient");
const WeatherService = require("./weatherService");

const BILI_GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter("zh-CN", { granularity: "grapheme" })
    : null;

// 模拟/自检专用的假房间号：没有真实房间信息时兜底展示用，不指向任何生产房间
const SIMULATED_FALLBACK_ROOM_ID = 5561470;

async function postSpeak(endpoint, action, event) {
  const response = await fetch(endpoint, {
    method: "POST",
    // 语音端挂起会拖死整个 action 流程，10 秒拿不到响应就中断
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

function cloneConfig(config) {
  return JSON.parse(JSON.stringify(config || {}));
}

function createId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function incrementMap(map, key, amount = 1) {
  const name = String(key || "UNKNOWN");
  map.set(name, Number(map.get(name) || 0) + amount);
}

function coverageRow(key, label, expected, captured, aliases = [], options = {}) {
  const safeExpected = Math.max(0, Number(expected || 0));
  const safeCaptured = Math.max(0, Number(captured || 0));
  const gap = Math.max(0, safeExpected - safeCaptured);
  return {
    key,
    label,
    expected: safeExpected,
    captured: safeCaptured,
    gap,
    aliases,
    filtered: Math.max(0, Number(options.filtered || 0)),
    state: safeExpected === 0 ? "idle" : gap === 0 ? "ok" : safeCaptured > 0 ? "warn" : "bad",
  };
}

function extractVisibleRoomId(input = {}) {
  const candidates = [
    input.roomId,
    input.room_id,
    input.room,
    input.url,
    input.href,
    input.pageUrl,
    input.location,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const roomId = Number(extractRoomId(candidate));
      if (roomId) return roomId;
    } catch {
      // Try the next candidate.
    }
  }
  return 0;
}

function mergeGuardBoards(overlayBoard = {}, baseBoard = {}, options = {}) {
  const overlayRows = Array.isArray(overlayBoard.rows) ? overlayBoard.rows : [];
  const baseRows = Array.isArray(baseBoard.rows) ? baseBoard.rows : [];
  if (!overlayRows.length) return baseBoard || overlayBoard || null;
  const byUser = new Map();
  const aliases = new Map();
  const rowKeys = (row = {}) =>
    [
      row.userId ? `uid:${row.userId}` : "",
      row.uid ? `uid:${row.uid}` : "",
      row.userName ? `name:${String(row.userName).trim().toLowerCase()}` : "",
    ].filter(Boolean);
  const upsert = (row = {}, preferOverlay = false) => {
    const keys = rowKeys(row);
    if (!keys.length) return;
    let key = keys.map((item) => aliases.get(item) || item).find((item) => byUser.has(item));
    if (!key) key = keys[0];
    const previous = byUser.get(key) || {};
    byUser.set(key, preferOverlay ? { ...previous, ...row } : { ...row, ...previous });
    for (const alias of keys) aliases.set(alias, key);
  };
  for (const row of baseRows) {
    upsert(row, false);
  }
  for (const row of overlayRows) {
    upsert(row, true);
  }
  const source = options.source || overlayBoard.source || "mergedGuardBoard";
  const rows = [...byUser.values()].sort(
    (left, right) => Number(left.daysLeft ?? 999999) - Number(right.daysLeft ?? 999999)
  );
  return {
    total: rows.length,
    expiring: rows.filter((item) => item.daysLeft !== null && item.daysLeft !== undefined && item.daysLeft <= 7 && item.daysLeft >= 0),
    expired: rows.filter((item) => item.expired),
    rows,
    recent: overlayBoard.recent || baseBoard.recent || [],
    source,
    manualTotal: source === "manualGuardBoard" ? overlayRows.length : Number(overlayBoard.manualTotal || 0),
    overlayTotal: overlayRows.length,
    baseTotal: baseRows.length,
    baseSource: baseBoard.source || "",
    updatedAt: overlayBoard.updatedAt || overlayBoard.at || baseBoard.updatedAt || 0,
  };
}

function createScreenshotStats() {
  return {
    attempted: 0,
    saved: 0,
    skipped: 0,
    failed: 0,
    lastAt: 0,
    lastKind: "",
    lastFiles: [],
    lastError: "",
  };
}

function parseExtra(raw = {}) {
  const extra = raw.info?.[0]?.[15]?.extra;
  if (!extra) return {};
  try {
    return JSON.parse(extra);
  } catch {
    return {};
  }
}

function shortHash(value = "") {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(36);
}

function rawMessageKey(command, message = {}) {
  const extra = parseExtra(message);
  if (command === "COMBO_SEND") {
    const data = message.data || {};
    return [
      data.batch_combo_id || data.batch_combo_send?.batch_combo_id || "",
      data.combo_id || data.combo_send?.combo_id || "",
      data.combo_num || "",
      data.total_num || "",
      data.batch_combo_num || "",
      data.combo_total_coin || "",
      data.gift_id || data.giftId || "",
      data.uid || data.sender_uinfo?.uid || "",
      data.timestamp || message.timestamp || "",
    ].join(":");
  }
  if (command === "UNIVERSAL_EVENT_GIFT" || command === "UNIVERSAL_EVENT_GIFT_V2") {
    const data = message.data || {};
    const info = data.info || data;
    const extra = info.biz_extra_data || data.biz_extra_data || {};
    const multi = info.multi_conn_info || data.multi_conn_info || {};
    return [
      command,
      info.trace_id || data.trace_id || "",
      info.biz_session_id || data.biz_session_id || "",
      info.interact_channel_id || data.interact_channel_id || "",
      info.version || data.version || "",
      info.members_version || data.members_version || "",
      info.system_time_unix || data.system_time_unix || "",
      info.invoking_time || data.invoking_time || "",
      JSON.stringify(multi.scores || extra.multi_conn?.scores || []).slice(0, 220),
    ].join(":");
  }
  if (command === "NOTICE_MSG" || command === "COMMON_NOTICE_DANMAKU") {
    const important = {
      id: message.id,
      name: message.name,
      roomid: message.roomid,
      real_roomid: message.real_roomid,
      notice_type: message.notice_type,
      business_id: message.business_id,
      marquee_id: message.marquee_id,
      link_url: message.link_url,
      msg_common: message.msg_common,
      msg_self: message.msg_self,
      content_segments: message.content_segments,
      data: message.data,
      send_time: message.send_time || message.timestamp,
    };
    return `${command}:${shortHash(JSON.stringify(important))}`;
  }
  return (
    message.msg_id ||
    extra.id_str ||
    message.trace_id ||
    message.data?.trace_id ||
    message.data?.batch_combo_id ||
    message.data?.tid ||
    message.data?.combo_id ||
    (command === "DANMU_MSG"
      ? `${command}:${message.info?.[0]?.[4] || ""}:${message.info?.[1] || ""}:${
          message.info?.[2]?.[1] || ""
        }`
      : `${command}:${message.send_time || message.timestamp || ""}:${JSON.stringify(
          message.data || {}
        ).slice(0, 160)}`)
  );
}

function eventMessageKey(type, event = {}) {
  const command = event.command || type;
  return `${type}:${command}:${rawMessageKey(command, event.raw || {})}`;
}

const CROSS_SOURCE_CHAT_DEDUPE_MS = 8000;
const CROSS_SOURCE_CHAT_DEDUPE_LIMIT = 160;
// 长期运行的进程里这些 Map 只会越写越大，统一给容量/时效上限
const VISUAL_HINT_CACHE_LIMIT = 5000;
const LOCAL_AI_NAME_ALIAS_LIMIT = 1000;
const WELCOME_IDLE_LAST_AT_TTL_MS = 24 * 60 * 60 * 1000;
const PERSISTED_GIFT_ID_LIMIT = 4000;
const LOCAL_AI_MEMORY_TTL_MS = 30 * 60 * 1000;
const LOCAL_AI_VIEWER_TURN_LIMIT = 8;
const LOCAL_AI_ROOM_CHAT_LIMIT = 20;
const LOCAL_AI_VIEWER_LIMIT = 200;
const LOCAL_AI_MEMORY_TEXT_LIMIT = 120;
const LOCAL_AI_ROOM_TEXT_LIMIT = 96;
const LOCAL_AI_CONTEXT_CHAR_BUDGET = LocalAiClient.CONTEXT_CHAR_BUDGET || 1800;
const LOCAL_AI_OUTPUT_MAX_ATTEMPTS = 3;
const DEFAULT_LOCAL_AI_OUTPUT_BLOCKED_TERMS = [
  "内裤",
  "露点",
  "走光",
  "裸聊",
  "裸照",
  "成人视频",
  "性器官",
];
const CHAT_IDENTITY_PLACEHOLDERS = new Set([
  "网页可见用户",
  "匿名用户",
  "新来的朋友",
]);

function chatDedupeNames(event = {}) {
  return [
    event.displayUserName,
    event.userName,
    ...(Array.isArray(event.nameCandidates) ? event.nameCandidates : []),
  ]
    .map((name) => cleanDisplayName(name).toLocaleLowerCase())
    .filter((name, index, names) =>
      Boolean(name) &&
      !CHAT_IDENTITY_PLACEHOLDERS.has(name) &&
      names.indexOf(name) === index
    );
}

function maskedChatNameMatches(maskedName = "", fullName = "") {
  const masked = cleanDisplayName(maskedName).toLocaleLowerCase();
  const full = cleanDisplayName(fullName).toLocaleLowerCase();
  if (!masked || !full || !/\*+/.test(masked) || !masked.replace(/\*+/g, "")) return false;
  const pattern = masked
    .split(/\*+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".+");
  return new RegExp(`^${pattern}$`, "u").test(full);
}

function chatDedupeNamesMatch(leftNames = [], rightNames = []) {
  return leftNames.some((leftName) =>
    rightNames.some(
      (rightName) =>
        leftName === rightName ||
        maskedChatNameMatches(leftName, rightName) ||
        maskedChatNameMatches(rightName, leftName)
    )
  );
}

function chatDedupeIdentityMatches(left = {}, right = {}) {
  const leftUserId = Number(left.userId || left.uid || 0);
  const rightUserId = Number(right.userId || right.uid || 0);
  if (leftUserId && rightUserId) return leftUserId === rightUserId;
  return chatDedupeNamesMatch(
    left.names || chatDedupeNames(left),
    right.names || chatDedupeNames(right)
  );
}

function isAssistantLikeName(name) {
  return /(小助理|助理|助手|机器人|管家|bot)/i.test(String(name || ""));
}

function compactLocalAiText(value = "", limit = LOCAL_AI_MEMORY_TEXT_LIMIT) {
  return Array.from(
    String(value || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  )
    .slice(0, Math.max(1, Number(limit) || LOCAL_AI_MEMORY_TEXT_LIMIT))
    .join("");
}

function compactRealtimeWeatherContext(value = null) {
  if (!value || typeof value !== "object") return null;
  const output = {};
  const textKeys = [
    "intent",
    "source",
    "requestedLocation",
    "resolvedLocation",
    "admin1",
    "country",
    "observedAt",
    "timezone",
    "reason",
    "instruction",
  ];
  for (const key of textKeys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      output[key] = compactLocalAiText(value[key], key === "instruction" ? 160 : 80);
    }
  }
  const numberKeys = ["temperatureC", "apparentTemperatureC", "weatherCode"];
  for (const key of numberKeys) {
    const number = Number(value[key]);
    if (Number.isFinite(number)) output[key] = number;
  }
  if (value.available !== undefined) output.available = value.available === true;
  return Object.keys(output).length ? output : null;
}

function normalizeLocalAiOutput(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^@[^\s]+\s*/u, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function localAiOutputSimilarity(left = "", right = "") {
  const first = normalizeLocalAiOutput(left);
  const second = normalizeLocalAiOutput(right);
  if (!first || !second) return 0;
  if (first === second) return 1;
  const shorter = Math.min(Array.from(first).length, Array.from(second).length);
  if (shorter >= 6 && (first.includes(second) || second.includes(first))) return 0.95;
  const grams = (value) => {
    const chars = Array.from(value);
    if (chars.length < 2) return new Set(chars);
    return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
  };
  const leftGrams = grams(first);
  const rightGrams = grams(second);
  let overlap = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) overlap += 1;
  return (2 * overlap) / Math.max(1, leftGrams.size + rightGrams.size);
}

function localAiClicheCategory(value = "") {
  const text = normalizeLocalAiOutput(value);
  if (/(?:别|不要)安静|一起嗨|嗨起来|燥起来|热闹起来|弹幕(?:走起|刷起)/u.test(text)) {
    return "generic_hype";
  }
  return "";
}

function asksForAnotherReply(value = "") {
  const text = String(value || "")
    .normalize("NFKC")
    .replace(/^@[^\s]+\s*/u, "")
    .replace(/[!！?？。.]+$/u, "")
    .trim();
  const request = /(?:换一个|换个|重新讲|重新说|再来一个|再来个|再讲一个|再说一个)/u;
  const shortRequest = /^(?:请|能不能|可以)?\s*(?:换一个|换个|重新讲|重新说|再来一个|再来个|再讲一个|再说一个)(?:吧|呗|呢|呀|啊)?$/u;
  const replyTopic = /(?:笑话|段子|故事|梗|回答|回复|说法|版本|这个|上一个|刚才|敏感词|不合适|违规)/u;
  return shortRequest.test(text) || (request.test(text) && replyTopic.test(text));
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function localIsMaskedName(name) {
  return /\*{2,}/.test(String(name || ""));
}

function cleanDisplayName(value) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]+/g, "")
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .trim();
}

function userNameKey(name) {
  return cleanDisplayName(name).toLocaleLowerCase();
}

function cleanImageUrl(url) {
  return String(url || "").trim().replace(/^J(?=https?:\/\/)/, "");
}

function isUsefulFace(face) {
  const value = cleanImageUrl(face);
  return Boolean(value && /\/bfs\/face\//i.test(value) && !/\/bfs\/face\/member\/noface\.jpg/i.test(value));
}

const DEFAULT_GUARD_AVATAR_FRAMES = {
  1: "https://i0.hdslb.com/bfs/live/3b46129e796df42ec7356fcba77c8a79d47db682.png",
  2: "https://i0.hdslb.com/bfs/live/3b46129e796df42ec7356fcba77c8a79d47db682.png",
  3: "https://i0.hdslb.com/bfs/live/80f732943cc3367029df65e267960d56736a82ee.png",
};

function defaultAvatarFrameForGuard(level = 0) {
  return DEFAULT_GUARD_AVATAR_FRAMES[Number(level || 0)] || "";
}

function guardLevelFromText(...values) {
  const text = values
    .flat()
    .filter(Boolean)
    .map((value) =>
      typeof value === "object"
        ? `${value.name || ""} ${value.frameName || ""} ${value.title || ""}`
        : String(value || "")
    )
    .join(" ");
  if (/总督/.test(text)) return 1;
  if (/提督/.test(text)) return 2;
  if (/舰长|船长/.test(text)) return 3;
  return 0;
}

function guardNameFromLevelLocal(level = 0) {
  const value = Number(level || 0);
  if (value === 1) return "总督";
  if (value === 2) return "提督";
  if (value === 3) return "舰长";
  return "";
}

function resolveGuardLevel(input = {}, previous = {}) {
  const textLevel = guardLevelFromText(
    input.guardName,
    input.avatarFrameName,
    input.frameName,
    input.avatarFrame,
    previous.guardName,
    previous.avatarFrameName,
    previous.frameName,
    previous.avatarFrame
  );
  if (textLevel) return textLevel;
  const numeric = Number(input.guardLevel || 0) || Number(previous.guardLevel || 0);
  return [1, 2, 3].includes(numeric) ? numeric : 0;
}

function preferFullName(candidate, fallback = "") {
  const next = cleanDisplayName(candidate);
  const previous = cleanDisplayName(fallback);
  const score = (name = "") => {
    const value = cleanDisplayName(name);
    if (!value) return 0;
    if (value === "匿名用户" || value === "新来的朋友") return 1;
    if (localIsMaskedName(value)) return 5 + Array.from(value.replace(/\*/g, "")).length;
    return 100 + Array.from(value).length;
  };
  if (!previous) return next;
  if (!next) return previous;
  return score(next) > score(previous) ? next : previous;
}

function shownEventName(event = {}) {
  const display = cleanDisplayName(event.displayUserName || "");
  if (display && display !== "新来的朋友" && !localIsMaskedName(display)) return display;
  return cleanDisplayName(event.userName) || display || "匿名用户";
}

function attachSourceClient(event, client) {
  Object.defineProperty(event, "_sourceClient", {
    value: client,
    enumerable: false,
    configurable: true,
  });
  return event;
}

function parseAssistantGiftSummary(text) {
  const value = String(text || "").replace(/\s+/g, "").trim();
  const match =
    value.match(/^(.+?)x((?:l|I|１|1)?\d*|\d+)共(\d+(?:\.\d+)?)电池$/i) ||
    value.match(/^(.+?)×(\d+)共(\d+(?:\.\d+)?)电池$/i);
  if (!match) return null;
  const countToken = String(match[2] || "1")
    .replace(/^[lI１]$/, "1")
    .replace(/^[lI１]/, "1")
    .replace(/[oO]/g, "0");

  return {
    giftName: match[1],
    count: Number(countToken || 1),
    totalCoin: Math.round(Number(match[3] || 0) * 100),
  };
}

function parseAssistantGiftThanks(text) {
  const match = String(text || "").match(/^感谢(.+?)的礼物[~～!！。]*$/);
  return match?.[1]?.trim() || "";
}

function cleanGiftToken(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:礼物|道具|获得|爆出|开出|抽中|赠送|投喂)\s*/, "")
    .replace(/^(?:好运|幸运|欧气|血赚|大赚|小赚|小亏|大亏|亏了|赚了)\s+/, "")
    .replace(/\s*[x×X＊*]\s*\d+.*$/, "")
    .replace(/[，,。].*$/, "")
    .trim();
}

function createModuleStatus(config = {}) {
  const modules = config.modules || {};
  const names = [
    "autoSend",
    "autoLike",
    "welcome",
    "giftThanks",
    "pk",
    "rotation",
    "ai",
    "spam",
    "guardBoard",
    "history",
  ];
  return Object.fromEntries(
    names.map((name) => [
      name,
      {
        ...(modules[name] || {}),
        enabled: modules[name]?.enabled !== false,
      },
    ])
  );
}

function createVisualAuditState() {
  return {
    lastAt: 0,
    lastUrl: "",
    lastTitle: "",
    lastBridgeVersion: "",
    lastBatchId: "",
    heartbeatCount: 0,
    observedChat: 0,
    observedGift: 0,
    observedPk: 0,
    acceptedChat: 0,
    acceptedGift: 0,
    acceptedPk: 0,
    duplicateCount: 0,
    truncatedCount: 0,
    lastSampleCount: 0,
    lastOnlineText: "",
    lastTextHash: "",
    lastDeliveryStatus: "",
    lastDeliveryNote: "",
    lastDeliveryAt: 0,
    lastDeliverySent: 0,
    lastDeliveryAccepted: 0,
    lastDeliveryObserved: 0,
    lastDeliveryKind: "",
    recent: [],
    lastScreenshotAt: 0,
    lastScreenshotNote: "",
  };
}

function resolveStateDir(config = {}) {
  const rootDir = config.__path ? path.dirname(config.__path) : process.cwd();
  return path.resolve(rootDir, config.history?.dir || "state");
}

function shouldPersistKind(config = {}, kind = "") {
  const history = config.history || {};
  if (history.enabled === false) return false;
  const persistKinds = history.persistKinds;
  if (!Array.isArray(persistKinds) || persistKinds.length === 0) return true;
  return persistKinds.includes(kind);
}

function compactEvent(event = {}) {
  const copy = { ...event };
  delete copy.raw;
  delete copy._sourceClient;
  return copy;
}

function compactLogEntry(entry = {}) {
  const copy = { ...entry };
  if (copy.event && typeof copy.event === "object") {
    copy.event = compactEvent(copy.event);
  }
  if (copy.action && typeof copy.action === "object" && copy.action.raw) {
    copy.action = compactEvent(copy.action);
  }
  delete copy.raw;
  return copy;
}

function compactEventList(list = [], limit = 30) {
  return Array.isArray(list) ? list.slice(0, limit).map((item) => compactEvent(item)) : [];
}

function parseGiftTextFallback(text = "") {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  const visibleGiftMatch = value.match(/^(.{1,40}?)\s+投喂\s+(.+)$/);
  if (visibleGiftMatch && !value.startsWith("投喂 ")) {
    const nested = parseGiftTextFallback(`投喂 ${visibleGiftMatch[2].trim()}`);
    return nested
      ? {
          ...nested,
          userName: visibleGiftMatch[1].trim(),
        }
      : null;
  }
  const blindMatch = value.match(/投喂\s*(.+?)\s*(?:爆出|开出|获得)\s*(.+?)\s*[x×X＊*]\s*(\d+)/);
  if (blindMatch) {
    return {
      sourceGiftName: cleanGiftToken(blindMatch[1]),
      giftName: cleanGiftToken(blindMatch[2]),
      count: Number(blindMatch[3] || 1),
      blind: true,
    };
  }
  const resultMatch = value.match(/^(.+?)\s*[x×X＊*]\s*(\d+)\s*(?:小亏|血赚|赚|亏)\s*\d+(?:\.\d+)?\s*电池/);
  if (resultMatch) {
    return {
      giftName: cleanGiftToken(resultMatch[1]),
      count: Number(resultMatch[2] || 1),
      blind: true,
    };
  }
  const normalGiftMatch = value.match(/^投喂\s*(.+?)\s*(?:[x×X＊*]\s*(\d+))?$/);
  if (normalGiftMatch) {
    return {
      giftName: cleanGiftToken(normalGiftMatch[1]),
      count: Number(normalGiftMatch[2] || 1),
      blind: false,
    };
  }
  return null;
}

function parseVisibleLine(input = {}) {
  const rawLine = String(input.line || input.text || input.message || "")
    .replace(/\r/g, "\n")
    .trim();
  const compact = rawLine.replace(/\s+/g, " ").trim();
  const explicitUser = String(input.userName || input.uname || "").trim();
  const explicitText = String(input.chatText || input.content || "").trim();
  const explicitFields = {
    kind: input.kind || "",
    giftId: input.giftId || input.gift_id || 0,
    giftName: input.giftName || input.gift_name || "",
    giftIcon: input.giftIcon || input.giftIconUrl || "",
    giftIconUrl: input.giftIconUrl || input.giftIcon || "",
    sourceGiftId: input.sourceGiftId || input.source_gift_id || 0,
    sourceGiftName: input.sourceGiftName || input.source_gift_name || "",
    sourceGiftIcon: input.sourceGiftIcon || input.sourceGiftIconUrl || "",
    count: Number(input.count || input.num || 0) || 0,
    price: Number(input.price || 0) || 0,
    totalCoin: Number(input.totalCoin || input.total_coin || 0) || 0,
    coinType: input.coinType || input.coin_type || "",
    pk: input.pk || null,
  };
  if (explicitUser && explicitText) {
    return {
      userName: explicitUser,
      text: explicitText.replace(/\s+/g, " ").trim(),
      line: compact,
      ...explicitFields,
    };
  }

  const colonMatch =
    rawLine.match(/(?:^|\n)([^\n:：]{1,40}?)[\s　]*[:：][\s　]*([\s\S]+)$/) ||
    compact.match(/^(.{1,40}?)[\s　]*[:：][\s　]*(.+)$/);
  if (colonMatch) {
    return {
      userName: String(colonMatch[1] || "").trim(),
      text: String(colonMatch[2] || "").replace(/\s+/g, " ").trim(),
      line: compact,
      ...explicitFields,
    };
  }

  const giftMatch = compact.match(/^(.{1,40}?)\s+投喂\s+(.+)$/);
  if (giftMatch) {
    return {
      userName: String(giftMatch[1] || "").trim(),
      text: `投喂 ${String(giftMatch[2] || "").trim()}`,
      line: compact,
      ...explicitFields,
      kind: explicitFields.kind || "gift",
    };
  }

  return {
    userName: explicitUser || "网页可见用户",
    text: compact,
    line: compact,
    ...explicitFields,
  };
}

function normalizeVisibleText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseVisibleBlocks(input = {}) {
  if (Array.isArray(input.events)) {
    return input.events.flatMap((event) => parseVisibleBlocks(event));
  }

  const explicit = parseVisibleLine(input);
  const hasExplicitFields = Boolean(
    (input.userName || input.uname) && (input.chatText || input.content)
  );
  if (hasExplicitFields) return [explicit];

  const rawText = String(input.line || input.text || input.message || "").replace(/\r/g, "\n");
  const lines = rawText
    .split("\n")
    .map(normalizeVisibleText)
    .filter(Boolean);
  const events = [];

  for (let index = 0; index < lines.length; index += 1) {
    const medalName = lines[index] || "";
    const medalLevelText = lines[index + 1] || "";
    const userLine = lines[index + 2] || "";
    const messageLine = lines[index + 3] || "";
    const levelMatch = medalLevelText.match(/^\d{1,3}$/);
    const splitUserOnly = userLine.match(/^(.{1,48}?)[\s　]*[:：]\s*$/);
    const splitUserWithText = userLine.match(/^(.{1,48}?)[\s　]*[:：][\s　]*(.+)$/);

    if (levelMatch && splitUserOnly && messageLine) {
      events.push({
        userName: splitUserOnly[1].trim(),
        text: messageLine,
        medalName,
        medalLevel: Number(medalLevelText),
        line: [medalName, medalLevelText, userLine, messageLine].join("\n"),
        parsedFromBlock: true,
      });
      index += 3;
      continue;
    }

    if (levelMatch && splitUserWithText) {
      events.push({
        userName: splitUserWithText[1].trim(),
        text: splitUserWithText[2].trim(),
        medalName,
        medalLevel: Number(medalLevelText),
        line: [medalName, medalLevelText, userLine].join("\n"),
        parsedFromBlock: true,
      });
      index += 2;
    }
  }

  return events.length ? events : [explicit];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function simpleTemplate(template = "", values = {}) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function splitBiliGraphemes(value = "") {
  const text = String(value || "");
  if (!BILI_GRAPHEME_SEGMENTER) return Array.from(text);
  return [...BILI_GRAPHEME_SEGMENTER.segment(text)].map((item) => item.segment);
}

function takeBiliGraphemesWithin(segments = [], maxCodePoints = 0) {
  const output = [];
  let used = 0;
  for (const segment of segments) {
    const size = Array.from(segment).length;
    if (used + size > maxCodePoints) break;
    output.push(segment);
    used += size;
  }
  return output;
}

function compressBiliText(value, maxChars = 40) {
  const source = String(value || "");
  const limit = Math.max(1, Math.floor(Number(maxChars) || 40));
  if (!source.trim()) return "";
  if (Array.from(source).length <= limit) return source;

  const compact = source.replace(/\s+/g, " ").trim();
  if (Array.from(compact).length <= limit) return compact;
  if (limit === 1) return "…";

  const visible = takeBiliGraphemesWithin(splitBiliGraphemes(compact), limit);
  let completeSentenceEnd = -1;
  for (let index = 0; index < visible.length; index += 1) {
    if (/[。！？!?；;]/.test(visible[index])) completeSentenceEnd = index;
  }
  if (completeSentenceEnd >= 1) {
    return visible.slice(0, completeSentenceEnd + 1).join("");
  }

  const prefix = takeBiliGraphemesWithin(splitBiliGraphemes(compact), limit - 1).join("");
  return `${prefix}…`;
}

function actionModuleName(action = {}) {
  const type = String(action.type || "");
  const ruleName = String(action.ruleName || "");
  if (type === "timer") return "rotation";
  if (type === "spam" || ruleName === "spam") return "spam";
  if (ruleName === "welcome" || ruleName === "follow" || ruleName === "share" || ruleName === "live_status") {
    return "welcome";
  }
  if (ruleName === "gift" || type === "gift_report" || ruleName === "gift_history") {
    return "giftThanks";
  }
  if (type.startsWith("pk_") || ruleName.startsWith("pk")) return "pk";
  if (ruleName === "ai") return "ai";
  if (ruleName === "guard_board") return "guardBoard";
  return "";
}

class BotRuntime extends EventEmitter {
  constructor(options = {}) {
    super();
    this.baseConfig = cloneConfig(options.config || {});
    this.config = cloneConfig(options.config || {});
    this.room = options.room || this.config.room;
    this.speakEndpoint = options.speakEndpoint || this.config.speakEndpoint || "";
    this.biliCookie = options.biliCookie || "";
    this.browserController = options.browserController || null;
    this.browserAuto = Boolean(options.browserAuto);
    this.sendLiveDanmu = options.sendLiveDanmu || sendLiveDanmu;
    this.localAiClient =
      options.localAiClient ||
      new LocalAiClient({
        enabled: false,
        ...(this.config.localAi || {}),
        ...(options.localAiFetch ? { fetch: options.localAiFetch } : {}),
      });
    this.weatherService =
      options.weatherService ||
      new WeatherService({
        ...(this.config.weather || {}),
        ...(options.weatherFetch ? { fetch: options.weatherFetch } : {}),
      });
    this.localAiGeneration = 0;
    this.localAiViewerMemory = new Map();
    this.localAiRoomChats = [];
    this.localAiMemorySequence = 0;
    this.localAiContextSnapshots = new WeakMap();
    this.pendingLocalAiTurns = new Map();
    this.localAiNameAliases = new Map();
    this.lastViewerAiAtByKey = new Map();
    this.lastUnkeyedViewerAiAt = 0;
    this.lastViewerChatAt = 0;
    this.proactiveAiTimer = null;
    this.proactiveAiGeneration = 0;
    this.proactiveAiInFlight = false;
    this.proactiveAiNextAt = 0;
    this.proactiveAiLastAt = 0;
    this.proactiveAiLastReply = "";
    this.proactiveAiLastPromptIndex = -1;
    this.recentSuccessfulAiOutputs = [];
    this.biliUid = 0;
    this.biliAccountName = "";
    this.biliAccountFace = "";
    this.identityMasked = false;
    this.loggedPrivacyNotice = false;
    this.sendToBili = Boolean(options.sendToBili);
    this.biliMaxChars = Number(options.biliMaxChars || this.config.send?.maxChars || 40);
    this.biliSendCooldownMs =
      Number(
        options.biliSendCooldownSec ||
          this.config.rateLimit?.globalSendCooldownSec ||
          this.config.send?.cooldownSec ||
          8
      ) * 1000;
    this.recentSentTexts = [];
    this.showEvents = Boolean(options.showEvents ?? this.config.showAllEvents);
    this.dryRun = options.dryRun ?? this.config.dryRun !== false;
    this.enablePost = Boolean(options.enablePost);

    this.client = null;
    this.clients = [];
    this.clientLineStates = new Map();
    this.rules = null;
    this.interactions = null;
    this.pkTracker = null;
    this.pkInvestigator = new PkInvestigator(this.config.pk?.investigator || {});
    this.commandEngine = null;
    this.eventStore = new EventStore({
      rootDir: resolveStateDir(this.config),
    });
    this.pointsEngine = new PointsEngine(this.config, this.eventStore);
    this.giftCatalog = new GiftCatalog({ eventStore: this.eventStore });
    this.giftCatalogRefreshPromise = null;
    this.guardCatalog = new GuardCatalog({ eventStore: this.eventStore });
    this.guardCatalogRefreshPromise = null;
    this.screenshotService = new ScreenshotService(this.config, this.eventStore);
    this.screenshotStats = createScreenshotStats();
    this.moduleStatus = createModuleStatus(this.config);
    this.clearLocalAiMemory();
    this.running = false;
    this.connected = false;
    this.startedAt = 0;
    this.stoppedAt = 0;
    this.roomInfo = null;
    this.endpoint = "";
    this.popularity = 0;
    this.onlineCount = 0;
    this.onlineText = "";
    this.watchedCount = 0;
    this.watchedText = "";
    this.roomRealtime = null;
    this.connectionState = null;
    this.rankStats = [];
    this.widgetStats = [];
    this.activityStats = [];
    this.moderationEvents = [];
    this.lastLiveStatus = null;
    this.lastConnectionLogKey = "";
    this.lastPopularityLogAt = 0;
    this.lastPopularityLoggedValue = null;
    this.lastOnlineLoggedValue = null;
    this.counts = {
      raw: 0,
      chat: 0,
      enter: 0,
      follow: 0,
      share: 0,
      gift: 0,
      superChat: 0,
      guard: 0,
      like: 0,
      pk: 0,
      notice: 0,
      connection: 0,
      event: 0,
      action: 0,
      warn: 0,
    };
    this.lastAction = null;
    this.lastLog = null;
    this.lastPkLogKey = "";
    this.pkInvestigationInFlight = false;
    this.pkInvestigationInFlightRooms = new Set();
    this.lastPkInvestigationByRoom = new Map();
    this.lastBiliSendAt = 0;
    this.nextBiliSendAt = 0;
    this.currentBiliSendGapMs = this.biliSendCooldownMs;
    this.randomFn = typeof options.randomFn === "function" ? options.randomFn : Math.random;
    this.pendingEnterTimers = new Set();
    this.pendingWelcomeIdleReminders = new Map();
    this.welcomeIdleReminderLastAt = new Map();
    this.pendingGiftThanks = new Map();
    this.pendingNoticeGifts = new Map();
    this.lastAssistantGiftUser = null;
    this.recentGiftPackets = [];
    this.seenRawEvents = new Map();
    this.seenHighEvents = new Map();
    this.recentCrossSourceChats = [];
    this.lastRawSnapshotAt = 0;
    this.lastRawAt = 0;
    this.lastRawCommand = "";
    this.lastPkLogKey = "";
    this.rawAuditCount = 0;
    this.lastRawAuditError = 0;
    this.commandStats = new Map();
    this.filteredRawStats = new Map();
    this.recentCommands = [];
    this.onlineRankRows = [];
    this.userVisualHintsByName = new Map();
    this.userVisualHintsByUid = new Map();
    this.userVisualHintsByFace = new Map();
    this.visualAudit = createVisualAuditState();
    this.lastVisualAuditPersistAt = 0;
    this.lastVisualAuditSnapshotAt = 0;
    this.lastVisibleRoomMismatchLogAt = 0;
    this.giftEventStats = {
      sendGift: 0,
      comboSend: 0,
      fallback: 0,
      visibleBridge: 0,
      assistantText: 0,
      noticeGift: 0,
      superChat: 0,
      guard: 0,
      historyRestored: 0,
      historyRestoredTotalCoin: 0,
      lastGiftAt: 0,
      lastGiftCommand: "",
    };
    this.autoSendQueue = [];
    this.autoSendInFlight = false;
    this.autoSendGeneration = 0;
    for (const batch of this.pendingGiftThanks.values()) clearTimeout(batch.timer);
    this.pendingGiftThanks.clear();
    for (const pending of this.pendingNoticeGifts.values()) clearTimeout(pending.timer);
    this.pendingNoticeGifts.clear();
    this.specialModes = {
      lotteryUntil: 0,
      lotteryReason: "",
      live: true,
    };
    this.persistedGiftIds = new Set();
    this.persistedGuardIds = new Set();
    this.lastHistorySummary = null;
    this.lastHistorySummaryAt = 0;
    this.lastGuardBoard = null;
    this.lastGuardBoardAt = 0;
    this.lastGiftStatsSnapshot = null;
    this.lastGiftStatsSnapshotAt = 0;
    this.lastSnapshotPersistAt = 0;
    this.seededGiftStatsRoomId = 0;
    this.seededRawHintRoomId = 0;
    this.seededEventHintRoomId = 0;
    this.recentGiftPackets = [];
  }

  async prepareBiliLogin() {
    this.biliUid = 0;
    this.biliAccountName = "";
    this.biliAccountFace = "";
    if (this.browserAuto && this.browserController) {
      const browserState = this.getBrowserControlState();
      const account = browserState.account || browserState.user || {};
      this.biliUid = Number(account.mid || account.uid || browserState.mid || browserState.uid || 0);
      this.biliAccountName =
        account.uname || account.name || browserState.uname || browserState.accountName || "";
      this.biliAccountFace = account.face || browserState.face || "";
    }
    const cookie = extractCookie(this.biliCookie || "");
    this.biliCookie = cookie;
    if (!cookie) return;

    try {
      const result = await checkBiliCookie(cookie);
      if (!result.ok) {
        this.log("登录态", "Cookie 不是已登录状态，弹幕昵称可能继续打码", {
          level: "warn",
        });
        return;
      }
      this.biliUid = Number(result.mid || 0);
      this.biliAccountName = result.uname || "";
      this.biliAccountFace = result.face || "";
      this.log(
        "登录态",
        `已应用 ${result.uname || result.mid} 的登录态，用于发送和账号权限；弹幕监听继续使用稳定游客通道`
      );
    } catch (error) {
      this.log("登录态", `检查 Cookie 失败：${error.message}`, { level: "warn" });
    }
  }

  applyBiliLogin(cookie, account = {}, reason = "登录态已更新") {
    const normalized = extractCookie(cookie || "");
    if (normalized) this.biliCookie = normalized;
    const uid = Number(account.mid || account.uid || account.account?.mid || account.account?.uid || 0);
    const name = account.uname || account.name || account.account?.uname || account.account?.name || "";
    const face = account.face || account.account?.face || "";
    if (uid) this.biliUid = uid;
    if (name) this.biliAccountName = name;
    if (face) this.biliAccountFace = face;
    this.log(
      "登录态",
      `${reason}，已热应用到发送/权限；弹幕监听不重启，仍走稳定游客通道`
    );
    this.emitSnapshot();
  }

  async start() {
    if (this.running) return this.getSnapshot();
    if (!this.room) {
      throw new Error("请先填写直播间 URL 或房间号");
    }

    this.config = cloneConfig(this.baseConfig);
    this.config.room = this.room;
    this.config.speakEndpoint = this.speakEndpoint;
    this.config.send = {
      ...(this.config.send || {}),
      maxChars: this.biliMaxChars,
      cooldownSec: this.biliSendCooldownMs / 1000,
    };
    this.config.showAllEvents = this.showEvents;
    this.config.dryRun = this.dryRun;

    this.rules = new RuleEngine(this.config);
    this.interactions = new InteractionEngine(this.config);
    this.pkTracker = new PkTracker(this.config.pk || {});
    this.pkInvestigator = new PkInvestigator(this.config.pk?.investigator || {});
    this.commandEngine = new CommandEngine(this.config);
    this.eventStore = new EventStore({
      rootDir: resolveStateDir(this.config),
    });
    this.pointsEngine = new PointsEngine(this.config, this.eventStore);
    // eventStore 重建后图鉴要跟着换绑，避免旧实例继续读写已废弃的存储
    this.giftCatalog = new GiftCatalog({ eventStore: this.eventStore });
    this.giftCatalogRefreshPromise = null;
    this.guardCatalog = new GuardCatalog({ eventStore: this.eventStore });
    this.guardCatalogRefreshPromise = null;
    this.screenshotService = new ScreenshotService(this.config, this.eventStore);
    this.screenshotStats = createScreenshotStats();
    this.moduleStatus = createModuleStatus(this.config);
    this.clearLocalAiMemory();
    this.seededGiftStatsRoomId = 0;
    this.autoSendGeneration += 1;
    this.autoSendQueue = [];
    this.autoSendInFlight = false;
    this.nextBiliSendAt = 0;
    this.currentBiliSendGapMs = this.biliSendCooldownMs;
    this.specialModes = {
      lotteryUntil: 0,
      lotteryReason: "",
      live: true,
    };
    this.persistedGiftIds.clear();
    this.persistedGuardIds.clear();
    this.lastHistorySummary = null;
    this.lastHistorySummaryAt = 0;
    this.lastGuardBoard = null;
    this.lastGuardBoardAt = 0;
    this.lastGiftStatsSnapshot = null;
    this.lastGiftStatsSnapshotAt = 0;
    this.lastSnapshotPersistAt = 0;
    // 快速 stop→start 时残留的去重 key 会误吞重启初期的同 key 事件
    this.seenRawEvents = new Map();
    this.seenHighEvents = new Map();
    this.lastRawAt = 0;
    this.lastRawCommand = "";
    this.rawAuditCount = 0;
    this.lastRawAuditError = 0;
    this.commandStats = new Map();
    this.filteredRawStats = new Map();
    this.recentCommands = [];
    for (const pending of this.pendingWelcomeIdleReminders.values()) {
      for (const timer of pending.timers || []) clearTimeout(timer);
    }
    this.pendingWelcomeIdleReminders.clear();
    this.welcomeIdleReminderLastAt = new Map();
    this.giftEventStats = {
      sendGift: 0,
      comboSend: 0,
      fallback: 0,
      visibleBridge: 0,
      assistantText: 0,
      noticeGift: 0,
      superChat: 0,
      guard: 0,
      historyRestored: 0,
      historyRestoredTotalCoin: 0,
      lastGiftAt: 0,
      lastGiftCommand: "",
    };
    this.identityMasked = false;
    this.loggedPrivacyNotice = false;
    this.onlineRankRows = [];
    this.userVisualHintsByName = new Map();
    this.userVisualHintsByUid = new Map();
    this.userVisualHintsByFace = new Map();
    this.visualAudit = createVisualAuditState();
    this.recentCrossSourceChats = [];
    this.lastVisualAuditPersistAt = 0;
    this.lastVisualAuditSnapshotAt = 0;
    this.lastVisibleRoomMismatchLogAt = 0;
    this.seededRawHintRoomId = 0;
    this.seededEventHintRoomId = 0;
    await this.prepareBiliLogin();
    const fanoutHosts = Math.min(4, Math.max(1, Number(this.config.connection?.fanoutHosts || 3)));
    this.clients = Array.from(
      { length: fanoutHosts },
      (_, index) =>
        new BilibiliLiveClient({
          room: this.room,
          hostIndex: index,
          // Some Bilibili comet nodes close account-bound WebSocket auth with 1006.
          // Keep the danmaku listener on the stable guest channel; login cookies are
          // still used for account checks, sending danmu, and HTTP-only lookups.
          uid: 0,
          cookie: "",
        })
    );
    this.client = this.clients[0];
    this.running = true;
    this.connected = false;
    this.clientLineStates = new Map();
    this.startedAt = Date.now();
    this.stoppedAt = 0;
    this.roomInfo = null;
    this.endpoint = "";
    this.popularity = 0;
    this.onlineCount = 0;
    this.onlineText = "";
    this.watchedCount = 0;
    this.watchedText = "";
    this.roomRealtime = null;
    this.connectionState = null;
    this.rankStats = [];
    this.widgetStats = [];
    this.activityStats = [];
    this.moderationEvents = [];
    this.lastLiveStatus = null;
    this.lastConnectionLogKey = "";
    this.pkInvestigationInFlight = false;
    this.pkInvestigationInFlightRooms = new Set();
    this.lastPkInvestigationByRoom = new Map();
    this.lastPopularityLogAt = 0;
    this.lastPopularityLoggedValue = null;
    this.lastOnlineLoggedValue = null;
    for (const key of Object.keys(this.counts)) this.counts[key] = 0;

    this.attachClient(this.client, { primary: true, index: 0 });
    this.clients.slice(1).forEach((client, index) => {
      this.attachClient(client, { primary: false, index: index + 1 });
    });
    this.log("配置", this.config.__path || "config.example.json");
    this.log(
      "模式",
      `建议回复：开启；本地语音接口：${
        !this.dryRun && this.speakEndpoint ? "开启" : "关闭"
      }；B站发送：${this.sendToBili ? "开启" : "关闭"}`
    );
    this.log("监听线路", `${fanoutHosts} 条弹幕节点并行监听，自动去重`);

    try {
      await this.client.start();
      for (const backup of this.clients.slice(1)) {
        backup.start().catch((error) => {
          this.log("备线失败", error.message, { level: "warn" });
        });
      }
    } catch (error) {
      this.running = false;
      this.connected = false;
      this.log("错误", error.message, { level: "error" });
      throw error;
    }

    this.emitSnapshot();
    return this.getSnapshot();
  }

  stop(reason = "手动停止") {
    this.cancelAutoSendQueue(reason);
    this.stopProactiveAiScheduler();
    this.clearLocalAiMemory();
    if (!this.running && !this.client) {
      this.emitSnapshot();
      return;
    }
    this.running = false;
    this.connected = false;
    this.clientLineStates.clear();
    this.stoppedAt = Date.now();
    if (this.rules) this.rules.stopTimers();
    for (const timer of this.pendingEnterTimers) clearTimeout(timer);
    this.pendingEnterTimers.clear();
    for (const pending of this.pendingWelcomeIdleReminders.values()) {
      for (const timer of pending.timers || []) clearTimeout(timer);
    }
    this.pendingWelcomeIdleReminders.clear();
    // 停止时点附近还在延迟确认的公告礼物直接落账，避免既不入账也无日志地丢失
    const pendingNoticeGifts = [...this.pendingNoticeGifts.values()];
    this.pendingNoticeGifts.clear();
    for (const pending of pendingNoticeGifts) {
      clearTimeout(pending.timer);
      try {
        this.processGiftEvent(pending.event);
      } catch (error) {
        this.log("公告礼物结算失败", error.message, { level: "warn" });
      }
    }
    for (const batch of this.pendingGiftThanks.values()) clearTimeout(batch.timer);
    this.pendingGiftThanks.clear();
    for (const client of this.clients) client.stop();
    this.log("停止", reason);
    this.emitSnapshot();
  }

  getBrowserControlState() {
    if (!this.browserController?.getState) return null;
    try {
      return this.browserController.getState() || null;
    } catch (error) {
      return {
        ready: false,
        error: error.message || String(error),
      };
    }
  }

  isBrowserControlReady() {
    if (!this.browserAuto || !this.browserController) return false;
    return this.getBrowserControlState()?.ready === true;
  }

  humanTimingConfig() {
    const timing = this.config.automation?.humanTiming || {};
    const numberOr = (value, fallback = 0) => {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, number) : Math.max(0, Number(fallback) || 0);
    };
    const actionFirst = numberOr(timing.actionDelayMinMs, 0);
    const actionSecond = numberOr(timing.actionDelayMaxMs, actionFirst);
    const fallbackGapSec = Math.max(0, this.biliSendCooldownMs / 1000);
    const gapFirst = numberOr(timing.sendGapMinSec, fallbackGapSec) * 1000;
    const gapSecond = numberOr(timing.sendGapMaxSec, gapFirst / 1000) * 1000;
    return {
      enabled: timing.enabled === true,
      actionDelayMinMs: Math.min(actionFirst, actionSecond),
      actionDelayMaxMs: Math.max(actionFirst, actionSecond),
      sendGapMinMs: Math.min(gapFirst, gapSecond),
      sendGapMaxMs: Math.max(gapFirst, gapSecond),
    };
  }

  randomBetween(minValue, maxValue) {
    const firstValue = Number(minValue);
    const secondValue = Number(maxValue);
    const first = Number.isFinite(firstValue) ? Math.max(0, firstValue) : 0;
    const second = Number.isFinite(secondValue) ? Math.max(0, secondValue) : first;
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    const sampled = Number(this.randomFn?.());
    const random = Number.isFinite(sampled) ? Math.min(0.999999999, Math.max(0, sampled)) : 0.5;
    return Math.round(min + (max - min) * random);
  }

  randomActionDelayMs() {
    const timing = this.humanTimingConfig();
    if (!timing.enabled) return 0;
    return this.randomBetween(timing.actionDelayMinMs, timing.actionDelayMaxMs);
  }

  randomSendGapMs() {
    const timing = this.humanTimingConfig();
    if (!timing.enabled) return this.biliSendCooldownMs;
    return this.randomBetween(timing.sendGapMinMs, timing.sendGapMaxMs);
  }

  proactiveAiConfig() {
    const section = this.config.localAi?.proactive || {};
    const initialMinSec = Math.max(1, Number(section.initialMinSec ?? 12));
    const initialMaxSec = Math.max(initialMinSec, Number(section.initialMaxSec ?? 24));
    const intervalMinSec = Math.max(5, Number(section.intervalMinSec ?? 24));
    const intervalMaxSec = Math.max(intervalMinSec, Number(section.intervalMaxSec ?? 55));
    const silenceMinSec = Math.max(0, Number(section.silenceMinSec ?? 12));
    const prompts = arrayValue(section.prompts)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    return {
      enabled: section.enabled === true,
      onlyWhenLive: section.onlyWhenLive !== false,
      initialMinSec,
      initialMaxSec,
      intervalMinSec,
      intervalMaxSec,
      silenceMinSec,
      prompts: prompts.length
        ? prompts
        : [
            "直播间暂时安静，请主动讲一个不超过30字的轻松短笑话，适合娱乐直播公屏。",
            "直播间暂时安静，请主动说一句不超过30字的B站式轻松玩梗，不要攻击任何人。",
            "直播间暂时安静，请用不超过30字俏皮地抖个机灵，别假装看见具体画面。",
            "直播间暂时安静，请主动抛一个观众容易接话的有趣小问题，不超过30字。",
            "直播间暂时安静，请用不超过30字给主播和观众一句俏皮加油。",
          ],
    };
  }

  proactiveAiLiveEligible(settings = this.proactiveAiConfig()) {
    return settings.onlyWhenLive === false || Number(this.roomInfo?.liveStatus ?? -1) === 1;
  }

  activeOutboundLiveEligible(action = {}) {
    const proactiveAi = action.metadata?.proactiveAi === true;
    const activeTimer = String(action.type || "") === "timer";
    if (!proactiveAi && !activeTimer && action.ruleName !== "startup_message") return true;
    if (proactiveAi && this.proactiveAiConfig().onlyWhenLive === false) return true;
    return Number(this.roomInfo?.liveStatus ?? -1) === 1;
  }

  stopProactiveAiScheduler() {
    this.proactiveAiGeneration += 1;
    if (this.proactiveAiTimer) clearTimeout(this.proactiveAiTimer);
    this.proactiveAiTimer = null;
    this.proactiveAiNextAt = 0;
    this.proactiveAiInFlight = false;
  }

  startProactiveAiScheduler() {
    this.stopProactiveAiScheduler();
    const settings = this.proactiveAiConfig();
    // 主动话术挂在“主动发言”(rotation)开关下，与 runProactiveAi/setModule 保持同一判定
    if (
      !settings.enabled ||
      !this.running ||
      this.dryRun !== false ||
      !this.sendToBili ||
      !this.isModuleEnabled("ai") ||
      !this.isModuleEnabled("rotation") ||
      !this.proactiveAiLiveEligible(settings)
    ) {
      return;
    }
    if (!this.lastViewerChatAt) this.lastViewerChatAt = Date.now();
    const generation = this.proactiveAiGeneration;
    this.scheduleProactiveAi(generation, true);
  }

  scheduleProactiveAi(generation = this.proactiveAiGeneration, initial = false) {
    if (generation !== this.proactiveAiGeneration || !this.running) return;
    const settings = this.proactiveAiConfig();
    if (
      !settings.enabled ||
      this.dryRun !== false ||
      !this.sendToBili ||
      !this.isModuleEnabled("ai") ||
      !this.isModuleEnabled("rotation") ||
      !this.proactiveAiLiveEligible(settings)
    ) {
      return;
    }
    if (this.proactiveAiTimer) clearTimeout(this.proactiveAiTimer);
    const minSec = initial ? settings.initialMinSec : settings.intervalMinSec;
    const maxSec = initial ? settings.initialMaxSec : settings.intervalMaxSec;
    const delayMs = this.randomBetween(minSec * 1000, maxSec * 1000);
    this.proactiveAiNextAt = Date.now() + delayMs;
    this.proactiveAiTimer = setTimeout(async () => {
      this.proactiveAiTimer = null;
      this.proactiveAiNextAt = 0;
      try {
        await this.runProactiveAi(generation);
      } catch (error) {
        this.log("主动互动", error.message || String(error), { level: "warn" });
      } finally {
        if (generation === this.proactiveAiGeneration && this.running) {
          this.scheduleProactiveAi(generation, false);
        }
      }
    }, delayMs);
    this.proactiveAiTimer.unref?.();
  }

  nextProactiveAiPrompt(settings = this.proactiveAiConfig()) {
    const prompts = settings.prompts || [];
    if (!prompts.length) return "";
    if (prompts.length === 1) return prompts[0];
    const offset = this.randomBetween(1, prompts.length - 1);
    const index = (Math.max(-1, this.proactiveAiLastPromptIndex) + offset) % prompts.length;
    this.proactiveAiLastPromptIndex = index;
    return prompts[index];
  }

  async runProactiveAi(generation = this.proactiveAiGeneration) {
    const settings = this.proactiveAiConfig();
    if (
      generation !== this.proactiveAiGeneration ||
      !settings.enabled ||
      !this.running ||
      !this.isModuleEnabled("ai") ||
      !this.isModuleEnabled("rotation") ||
      !this.proactiveAiLiveEligible(settings) ||
      this.proactiveAiInFlight
    ) {
      return false;
    }
    if (Date.now() - Number(this.lastViewerChatAt || 0) < settings.silenceMinSec * 1000) {
      return false;
    }
    const prompt = this.nextProactiveAiPrompt(settings);
    if (!prompt) return false;
    this.proactiveAiInFlight = true;
    let gateTimeoutTimer = null;
    try {
      const maxChars = Math.min(
        Number(this.config.localAi?.maxChars || 36),
        this.biliMaxChars
      );
      // 本地模型请求可能永不 settle，30 秒保险丝保证 finally 一定执行、调度链不断
      const gated = await Promise.race([
        this.generateLocalAiReplyWithGate(
          {
            userName: "直播间",
            message: prompt,
            context: {
              instruction: "这是机器人主动活跃气氛，直接给出公屏内容，不要提及指令。",
            },
            fallback: "",
            requireModel: true,
            maxChars,
          },
          {
            proactive: true,
            recentReplies: this.recentSuccessfulAiOutputs
              .filter((item) => item.proactive === true)
              .map((item) => item.text),
            maxChars,
          }
        ),
        new Promise((resolve) => {
          gateTimeoutTimer = setTimeout(
            () => resolve({ ok: false, reply: "", attempts: 0, reason: "本地模型 30 秒未响应，已超时放弃" }),
            30000
          );
          gateTimeoutTimer.unref?.();
        }),
      ]);
      if (generation !== this.proactiveAiGeneration || !this.running) return false;
      if (!gated.ok) {
        this.log(
          "AI输出门禁",
          `主动话术连续 ${gated.attempts} 个候选未通过，已放弃发送：${gated.reason}`,
          { level: "warn" }
        );
        return false;
      }
      const queueItem = await this.handleAction(
        {
          type: "timer",
          ruleName: "ai",
          reply: gated.reply,
          emotion: "cheerful",
          priority: 35,
          metadata: { proactiveAi: true, localAi: true },
        },
        { userName: "直播间", text: prompt, proactiveAi: true }
      );
      return Boolean(queueItem);
    } catch (error) {
      this.log("主动互动", `Qwen 生成失败：${error.message || String(error)}`, { level: "warn" });
      return false;
    } finally {
      if (gateTimeoutTimer) clearTimeout(gateTimeoutTimer);
      if (generation === this.proactiveAiGeneration) this.proactiveAiInFlight = false;
    }
  }

  cancelAutoSendQueue(reason = "已停止") {
    this.autoSendGeneration += 1;
    this.localAiGeneration += 1;
    this.pendingLocalAiTurns.clear();
    this.autoSendQueue = [];
    this.autoSendInFlight = false;
    this.nextBiliSendAt = 0;
    this.persistSnapshots(true);
    return reason;
  }

  mergeVisualHint(previous = {}, input = {}) {
    const userName = preferFullName(input.userName || input.displayUserName, previous.userName);
    const face = isUsefulFace(input.face)
      ? cleanImageUrl(input.face)
      : isUsefulFace(previous.face)
        ? cleanImageUrl(previous.face)
        : "";
    const guardLevel = resolveGuardLevel(input, previous);
    const guardName =
      firstString(
        input.guardName,
        input.avatarFrameName && guardLevelFromText(input.avatarFrameName)
          ? input.avatarFrameName
          : "",
        previous.guardName,
        previous.avatarFrameName && guardLevelFromText(previous.avatarFrameName)
          ? previous.avatarFrameName
          : "",
        guardNameFromLevelLocal(guardLevel)
      ) || "";
    const avatarFrameUrl =
      input.avatarFrameUrl ||
      input.avatarFrame?.url ||
      previous.avatarFrameUrl ||
      defaultAvatarFrameForGuard(guardLevel);
    const avatarFrame = input.avatarFrame || previous.avatarFrame || (avatarFrameUrl ? { url: avatarFrameUrl } : null);
    return {
      userId: Number(input.userId || input.uid || previous.userId || previous.uid || 0),
      uid: Number(input.userId || input.uid || previous.userId || previous.uid || 0),
      userName,
      displayUserName: userName || input.displayUserName || previous.displayUserName || "",
      face,
      faceSource: input.faceSource || previous.faceSource || "",
      guardLevel,
      guardName,
      guardIcon: input.guardIcon || previous.guardIcon || "",
      medalName: input.medalName || previous.medalName || "",
      medalLevel: Number(input.medalLevel || previous.medalLevel || 0),
      medalColors: input.medalColors || previous.medalColors || null,
      avatarFrame,
      avatarFrameUrl,
      avatarFrameName:
        input.avatarFrameName || input.avatarFrame?.name || previous.avatarFrameName || "",
      avatarFrameSource:
        input.avatarFrameSource ||
        input.avatarFrame?.source ||
        previous.avatarFrameSource ||
        (avatarFrameUrl ? "guard_default" : ""),
      wealthLevel: Number(input.wealthLevel || previous.wealthLevel || 0),
      hintSource: input.hintSource || previous.hintSource || "",
      hintAt: Date.now(),
    };
  }

  onlineRankVisualRow(row = {}, source = "online_rank") {
    const hint = this.rememberUserVisualHint(
      {
        ...row,
        userId: row.userId || row.uid || 0,
      },
      source
    );
    if (!hint) return null;
    return {
      uid: row.uid || hint.userId || 0,
      userId: hint.userId || row.userId || row.uid || 0,
      userName: hint.userName || row.userName || "",
      displayUserName: hint.displayUserName || row.displayUserName || row.userName || "",
      face: hint.face || row.face || "",
      faceSource: hint.faceSource || row.faceSource || "",
      guardLevel: hint.guardLevel || Number(row.guardLevel || 0),
      guardName: hint.guardName || row.guardName || "",
      guardIcon: hint.guardIcon || row.guardIcon || "",
      medalName: hint.medalName || row.medalName || "",
      medalLevel: Number(hint.medalLevel || row.medalLevel || 0),
      medalColors: hint.medalColors || row.medalColors || null,
      avatarFrame: hint.avatarFrame || row.avatarFrame || null,
      avatarFrameUrl: hint.avatarFrameUrl || row.avatarFrameUrl || "",
      avatarFrameName: hint.avatarFrameName || row.avatarFrameName || "",
      avatarFrameSource: hint.avatarFrameSource || row.avatarFrameSource || "",
      wealthLevel: Number(hint.wealthLevel || row.wealthLevel || 0),
      rank: row.rank,
      score: row.score,
      accompany: row.accompany,
      expiredText: row.expiredText,
      daysLeft: row.daysLeft === undefined ? null : row.daysLeft,
      expired: Boolean(row.expired),
      defaultPrice: row.defaultPrice,
      hintSource: source,
      hintAt: hint.hintAt,
    };
  }

  rememberUserVisualHint(input = {}, source = "") {
    if (!input) return null;
    const rawName = firstString(input.userName, input.displayUserName, input.uname, input.name);
    const userName = preferFullName(rawName, "");
    const userId = Number(input.userId || input.uid || 0);
    const face = cleanImageUrl(input.face || "");
    const key = userNameKey(userName || rawName);
    const existing =
      (userId ? this.userVisualHintsByUid.get(String(userId)) : null) ||
      (face ? this.userVisualHintsByFace.get(face) : null) ||
      (key ? this.userVisualHintsByName.get(key) : null) ||
      {};
    const merged = this.mergeVisualHint(existing, {
      ...input,
      userId,
      userName: userName || rawName,
      face,
      hintSource: source,
    });

    if (merged.userId) this.setVisualHintWithCap(this.userVisualHintsByUid, String(merged.userId), merged);
    if (isUsefulFace(merged.face)) this.setVisualHintWithCap(this.userVisualHintsByFace, merged.face, merged);
    if (merged.userName && !localIsMaskedName(merged.userName)) {
      this.setVisualHintWithCap(this.userVisualHintsByName, userNameKey(merged.userName), merged);
    }
    return merged;
  }

  setVisualHintWithCap(map, key, value) {
    // 先删再写让活跃用户回到队尾；Map 按插入序迭代，超限时从最旧的键开始淘汰
    if (map.has(key)) map.delete(key);
    map.set(key, value);
    while (map.size > VISUAL_HINT_CACHE_LIMIT) {
      map.delete(map.keys().next().value);
    }
  }

  findUserVisualHint(event = {}) {
    const userId = Number(event.userId || event.uid || 0);
    const face = cleanImageUrl(event.face || "");
    const name = firstString(event.userName, event.displayUserName, event.uname, event.name);
    const byUid = userId ? this.userVisualHintsByUid.get(String(userId)) : null;
    if (byUid) return byUid;
    const byFace = isUsefulFace(face) ? this.userVisualHintsByFace.get(face) : null;
    if (byFace) return byFace;
    const byName = name ? this.userVisualHintsByName.get(userNameKey(name)) : null;
    if (byName) return byName;

    if (localIsMaskedName(name)) {
      const prefix = String(name || "").split("***")[0].trim();
      if (prefix) {
        const candidates = [...this.userVisualHintsByName.values()]
          .filter((item) => String(item.userName || "").startsWith(prefix))
          .sort((left, right) => Number(right.hintAt || 0) - Number(left.hintAt || 0));
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1 && face) {
          return candidates.find((item) => cleanImageUrl(item.face) === face) || null;
        }
      }
    }

    const guardRow = this.guardCatalog?.findUser?.({
      userId,
      userName: name,
      face,
    });
    return guardRow ? this.rememberUserVisualHint(guardRow, "guard_catalog") : null;
  }

  enrichUserVisual(event = {}) {
    const hint = this.findUserVisualHint(event);
    if (!hint) return event;
    const fullName = preferFullName(hint.userName, event.userName);
    const next = {
      ...event,
      userName: fullName || event.userName,
      displayUserName:
        fullName && !localIsMaskedName(fullName)
          ? fullName
          : event.displayUserName || event.userName,
      isMaskedName: fullName ? localIsMaskedName(fullName) : event.isMaskedName,
      identityResolved:
        Boolean(fullName && !localIsMaskedName(fullName) && localIsMaskedName(event.userName)) ||
        event.identityResolved,
      face: isUsefulFace(event.face) ? cleanImageUrl(event.face) : hint.face || event.face || "",
      faceSource: event.faceSource || hint.faceSource || hint.hintSource || "",
      guardLevel: Number(event.guardLevel || 0) || Number(hint.guardLevel || 0),
      guardName: event.guardName || hint.guardName || "",
      guardIcon: event.guardIcon || hint.guardIcon || "",
      medalName: event.medalName || hint.medalName || "",
      medalLevel: Number(event.medalLevel || 0) || Number(hint.medalLevel || 0),
      medalColors: event.medalColors || hint.medalColors || null,
      avatarFrame: event.avatarFrame || hint.avatarFrame || null,
      avatarFrameUrl:
        event.avatarFrameUrl ||
        hint.avatarFrameUrl ||
        hint.avatarFrame?.url ||
        defaultAvatarFrameForGuard(Number(event.guardLevel || hint.guardLevel || 0)),
      avatarFrameName:
        event.avatarFrameName || hint.avatarFrameName || hint.avatarFrame?.name || "",
      avatarFrameSource:
        event.avatarFrameSource ||
        hint.avatarFrameSource ||
        hint.avatarFrame?.source ||
        (defaultAvatarFrameForGuard(Number(event.guardLevel || hint.guardLevel || 0))
          ? "guard_default"
          : ""),
      wealthLevel: Number(event.wealthLevel || 0) || Number(hint.wealthLevel || 0),
    };
    this.rememberUserVisualHint(next, event.source || event.command || "event");
    return next;
  }

  findVisibleChatMatch(event = {}) {
    if (!this.eventStore || !event.text) return null;
    const text = String(event.text || "").trim();
    const targetRoomId = Number(this.roomInfo?.roomId || event.roomId || 0);
    const medalLevel = Number(event.medalLevel || 0);
    const medalName = String(event.medalName || "").trim();
    try {
      const rows = this.eventStore
        .readEvents({ range: "today", kinds: ["chat"] })
        .filter((entry) => !targetRoomId || Number(entry.roomId || 0) === targetRoomId)
        .map((entry) => entry.payload || entry)
        .filter((row) => String(row.text || "").trim() === text)
        .reverse();
      if (!rows.length) return null;
      const score = (row = {}) => {
        let value = 0;
        if (localIsMaskedName(row.userName || row.displayUserName)) value += 8;
        if (isUsefulFace(row.face)) value += 6;
        if (medalLevel && Number(row.medalLevel || 0) === medalLevel) value += 3;
        if (medalName && String(row.medalName || "") === medalName) value += 2;
        if (Number(row.guardLevel || 0)) value += 1;
        return value;
      };
      return rows.sort((left, right) => score(right) - score(left))[0] || null;
    } catch (error) {
      this.log("可见校正失败", error.message, { level: "warn" });
      return null;
    }
  }

  applyVisibleIdentityHint(event = {}) {
    const candidateNames = [
      event.userName,
      event.displayUserName,
      ...(Array.isArray(event.nameCandidates) ? event.nameCandidates : []),
    ];
    const fullName = candidateNames.reduce((best, name) => preferFullName(name, best), "");
    if (!fullName || localIsMaskedName(fullName)) return event;

    const matched = this.findVisibleChatMatch(event);
    const face = isUsefulFace(event.face) ? event.face : matched?.face || "";
    const hint = this.rememberUserVisualHint(
      {
        ...(matched || {}),
        ...event,
        userName: fullName,
        displayUserName: fullName,
        face,
        medalName: event.medalName || matched?.medalName || "",
        medalLevel: Number(event.medalLevel || 0) || Number(matched?.medalLevel || 0),
        guardLevel: Number(event.guardLevel || 0) || Number(matched?.guardLevel || 0),
        guardName: event.guardName || matched?.guardName || "",
        guardIcon: event.guardIcon || matched?.guardIcon || "",
        avatarFrame: event.avatarFrame || matched?.avatarFrame || null,
        avatarFrameUrl: event.avatarFrameUrl || matched?.avatarFrameUrl || "",
        wealthLevel: Number(event.wealthLevel || 0) || Number(matched?.wealthLevel || 0),
      },
      matched ? "visible_bridge_match" : "visible_bridge"
    );
    const next = this.enrichUserVisual({
      ...event,
      face,
      userName: fullName,
      displayUserName: fullName,
      isMaskedName: false,
      identityResolved: true,
    });
    if (
      matched &&
      localIsMaskedName(matched.userName || matched.displayUserName) &&
      hint?.userName &&
      !localIsMaskedName(hint.userName)
    ) {
      this.log("昵称校正", `${matched.userName || matched.displayUserName} -> ${hint.userName}`, {
        kind: "identity",
      });
    }
    return next;
  }

  backfillGiftFeedVisuals() {
    const changed =
      this.interactions?.updateGiftFeedVisuals?.((row) => this.enrichUserVisual(row)) || 0;
    if (changed) {
      this.persistSnapshots(true);
      this.emitSnapshot();
    }
    return changed;
  }

  seedVisualHintsFromRawHistory(roomId = this.roomInfo?.roomId) {
    if (!this.eventStore || !roomId) return 0;
    const targetRoomId = Number(roomId || 0);
    if (!targetRoomId || this.seededRawHintRoomId === targetRoomId) return 0;
    const filePath = this.eventStore.rawPath(targetRoomId);
    if (!fs.existsSync(filePath)) return 0;
    let count = 0;
    let rows = [];
    try {
      const lines = fs.readFileSync(filePath, "utf8").trim().split(/\r?\n/).filter(Boolean);
      for (const line of lines.slice(-2500)) {
        const entry = JSON.parse(line);
        let parsedRows = [];
        if (entry.command === "ONLINE_RANK_V3" || entry.command === "ONLINE_RANK_V2") {
          parsedRows =
            entry.command === "ONLINE_RANK_V3"
              ? parseOnlineRankV3(entry.message?.data || {})
              : parseOnlineRankV2(entry.message?.data || {});
        } else if (/UNIVERSAL_EVENT_GIFT/.test(entry.command || "")) {
          const members = entry.message?.data?.info?.members || entry.message?.data?.members || [];
          parsedRows = members.map((member) => ({
            userId: member.uid || 0,
            userName: member.uname || member.display_name || "",
            face: member.face || "",
          }));
        } else if (entry.command === "COMBO_SEND" || entry.command === "SEND_GIFT") {
          const data = entry.message?.data || {};
          parsedRows = [
            {
              userId: data.sender_uinfo?.uid || data.uid || 0,
              userName:
                data.sender_uinfo?.base?.origin_info?.name ||
                data.sender_uinfo?.base?.name ||
                data.uname ||
                "",
              face: data.sender_uinfo?.base?.origin_info?.face || data.sender_uinfo?.base?.face || "",
            },
            {
              userId: data.receiver_uinfo?.uid || data.receive_user_info?.uid || data.ruid || 0,
              userName:
                data.receiver_uinfo?.base?.origin_info?.name ||
                data.receiver_uinfo?.base?.name ||
                data.receive_user_info?.uname ||
                data.r_uname ||
                "",
              face:
                data.receiver_uinfo?.base?.origin_info?.face ||
                data.receiver_uinfo?.base?.face ||
                "",
            },
          ];
        }
        if (!parsedRows.length) continue;
        rows = parsedRows
          .map((row) => this.onlineRankVisualRow(row, "raw_identity_history"))
          .filter(Boolean);
        count += rows.length;
      }
      if (rows.length) this.onlineRankRows = rows.slice(0, 20);
      if (count) {
        this.backfillGiftFeedVisuals();
        this.log("身份线索", `已从今日在线榜原始记录补齐 ${count} 条昵称/头像/头像框线索`);
      }
      this.seededRawHintRoomId = targetRoomId;
    } catch (error) {
      this.log("身份线索失败", error.message, { level: "warn" });
      this.seededRawHintRoomId = targetRoomId;
    }
    return count;
  }

  seedVisualHintsFromEventHistory(roomId = this.roomInfo?.roomId) {
    if (!this.eventStore || !roomId) return 0;
    const targetRoomId = Number(roomId || 0);
    if (!targetRoomId || this.seededEventHintRoomId === targetRoomId) return 0;
    let count = 0;
    try {
      const rows = this.eventStore
        .readRecentEvents({
          range: "today",
          kinds: ["chat", "enter", "gift", "guard"],
          maxLines: 4000,
          maxBytes: 3 * 1024 * 1024,
        })
        .filter((entry) => Number(entry.roomId || 0) === targetRoomId)
        .map((entry) => entry.payload || entry)
        .slice(-2500);
      for (const row of rows) {
        const remembered = this.rememberUserVisualHint(row, "event_history");
        if (remembered && (remembered.userName || remembered.face)) count += 1;
      }
      if (count) {
        this.backfillGiftFeedVisuals();
        this.log("身份线索", `已从今日事件历史补齐 ${count} 条昵称/头像线索`);
      }
      this.seededEventHintRoomId = targetRoomId;
    } catch (error) {
      this.log("身份线索失败", error.message, { level: "warn" });
      this.seededEventHintRoomId = targetRoomId;
    }
    return count;
  }

  attachClient(client, options = {}) {
    const primary = options.primary !== false;
    const lineLabel = primary ? "主线" : `备线${options.index || ""}`;

    client.on("room", (roomInfo) => {
      if (primary || !this.roomInfo) {
        this.roomInfo = roomInfo;
        this.pkTracker.setOwnRoomId(roomInfo.roomId);
        this.specialModes.live = Number(roomInfo.liveStatus || 0) !== 0;
      }
      if (primary) {
        this.rememberUserVisualHint(
          {
            userId: roomInfo.uid,
            userName: roomInfo.uname,
            displayUserName: roomInfo.uname,
            face: roomInfo.face || "",
            avatarFrameUrl: roomInfo.avatarFrameUrl || "",
            avatarFrameName: roomInfo.avatarFrameName || "",
          },
          "room_anchor"
        );
        this.log(
          "房间",
          `${roomInfo.roomId} ${roomInfo.liveStatusLabel} ${roomInfo.uname ? `@${roomInfo.uname}` : ""} ${
            roomInfo.title ? `「${roomInfo.title}」` : ""
          }`
        );
        this.seedGiftStatsFromHistory(roomInfo.roomId);
        this.seedVisualHintsFromRawHistory(roomInfo.roomId);
        this.seedVisualHintsFromEventHistory(roomInfo.roomId);
        this.refreshGiftCatalog(roomInfo.roomId);
        this.refreshGuardCatalog(roomInfo);
      }
      if (roomInfo.danmuWarning) {
        this.log("提示", `弹幕配置接口失败，已使用默认服务器: ${roomInfo.danmuWarning}`, {
          level: "warn",
        });
      }
      this.emitSnapshot();
    });

    client.on("connecting", ({ endpoint }) => {
      if (primary) this.endpoint = endpoint;
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        endpoint,
        connected: false,
        authenticated: false,
        reconnecting: false,
        connectingAt: Date.now(),
      });
      this.log(primary ? "连接" : "备线连接", `${lineLabel} ${endpoint}`);
      this.emitSnapshot();
    });

    client.on("connected", ({ endpoint } = {}) => {
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        endpoint: endpoint || this.clientLineStates.get(lineLabel)?.endpoint || "",
        connected: true,
        reconnecting: false,
        connectedAt: Date.now(),
      });
      this.log(primary ? "连接" : "备线连接", `${lineLabel} WebSocket 已打开，正在鉴权`);
      this.emitSnapshot();
    });

    client.on("authenticated", (body) => {
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        connected: true,
        authenticated: true,
        reconnecting: false,
        authenticatedAt: Date.now(),
      });
      this.log(primary ? "连接" : "备线连接", `${lineLabel} 鉴权完成 ${JSON.stringify(body)}`);
      if (primary) {
        this.rules.startTimers((action) => this.handleAction(action, null));
        this.startProactiveAiScheduler();
      }
      this.emitSnapshot();
    });

    client.on("popularity", ({ popularity }) => {
      if (!primary) return;
      this.popularity = Number(popularity || 0);
      this.emitSnapshot();
    });

    client.on("onlineStats", (event) => {
      if (!this.shouldProcessHighEvent("online", event)) return;
      const nextOnlineCount = Number(event.onlineCount || 0);
      const nextOnlineText = event.onlineText || (nextOnlineCount ? String(nextOnlineCount) : "");
      const rankRows = this.onlineRankRows?.length || 0;
      // 高能榜刷新瞬间会把在线数抖回 1，这里刻意过滤裸 "1"，代价是单人观看时在线数停在旧值
      const meaningfulRankCount =
        nextOnlineCount > 1 ||
        (nextOnlineText && nextOnlineText !== "1") ||
        (rankRows > 1 && nextOnlineCount >= rankRows);
      if (meaningfulRankCount) {
        this.onlineCount = nextOnlineCount;
        this.onlineText = nextOnlineText;
      }
      this.recordEvent("online", event);
      if (this.showEvents && meaningfulRankCount && this.lastOnlineLoggedValue !== this.onlineCount) {
        this.lastOnlineLoggedValue = this.onlineCount;
        this.log("在线榜", this.onlineText || String(this.onlineCount), {
          kind: "online",
          event,
        });
      }
      this.emitSnapshot();
    });

    client.on("watchedStats", (event) => {
      if (!this.shouldProcessHighEvent("watched", event)) return;
      this.watchedCount = Number(event.watchedCount || 0);
      this.watchedText = event.watchedText || "";
      this.recordEvent("watched", event);
      this.emitSnapshot();
    });

    client.on("onlineRank", (event) => {
      const rows = (event.rows || []).map((row) =>
        this.onlineRankVisualRow(row, "online_rank")
      ).filter(Boolean);
      this.recordEvent("onlineRank", {
        command: event.command,
        rowCount: rows.length,
        rows: rows.slice(0, 20),
      });
      if (primary) {
        this.onlineRankRows = rows.slice(0, 20);
        if (!this.onlineText && rows.length) {
          this.onlineCount = Math.max(this.onlineCount || 0, rows.length);
          this.onlineText = `${this.onlineCount}+`;
        }
        this.backfillGiftFeedVisuals();
        this.emitSnapshot();
      }
    });

    client.on("raw", ({ command, message }) => {
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        connected: true,
        reconnecting: false,
        lastRawAt: Date.now(),
        lastRawCommand: command || "",
      });
      if (!this.shouldProcessRaw(command, message)) return;
      this.counts.raw += 1;
      this.trackRawCommand(command);
      this.auditRaw(command, message);
      if (command === "LOG_IN_NOTICE") {
        this.identityMasked = true;
        if (!this.loggedPrivacyNotice) {
          this.loggedPrivacyNotice = true;
          this.log(
            "登录提示",
            "B站弹幕流可能返回打码昵称；发送账号可扫码登录，完整昵称优先用网页核对",
            { level: "warn" }
          );
        }
      }
      this.updateSpecialMode(command, { raw: message });
      const now = Date.now();
      if (now - this.lastRawSnapshotAt > 1000) {
        this.lastRawSnapshotAt = now;
        this.emitSnapshot();
      }
    });

    client.on("chat", (event) => {
      if (!this.shouldProcessHighEvent("chat", event)) return;
      if (!this.shouldProcessCrossSourceChat(event, "websocket")) {
        this.emitSnapshot();
        return;
      }
      this.handleIncomingChat(event, client);
      this.emitSnapshot();
    });

    client.on("interact", (event) => {
      if (!this.shouldProcessHighEvent("interact", event)) return;
      attachSourceClient(event, client);
      this.rememberUserVisualHint(event, "interact_raw");
      Object.assign(event, this.enrichUserVisual(event));
      const msgType = Number(event.msgType || 0);
      const interactKind = event.interactKind || (msgType === 2 || msgType === 5 ? "follow" : msgType === 3 ? "share" : "enter");
      event.interactKind = interactKind;
      if (interactKind === "follow") {
        this.counts.follow += 1;
        this.recordEvent("follow", event);
        if (this.showEvents) {
          this.log("关注", shownEventName(event), {
            kind: "enter",
            event,
          });
        }
        if (this.isModuleEnabled("welcome")) {
          this.handleActions(this.interactions.handleFollow(event), event);
        }
      } else if (interactKind === "share") {
        this.counts.share += 1;
        this.recordEvent("share", event);
        if (this.showEvents) {
          this.log("分享", shownEventName(event), {
            kind: "enter",
            event,
          });
        }
        if (this.isModuleEnabled("welcome")) {
          this.handleActions(this.interactions.handleShare(event), event);
        }
      } else {
        this.shareMaskedEntry(event);
        this.counts.enter += 1;
        this.recordEvent("enter", event);
        if (this.showEvents) {
          this.log(interactKind === "entry_effect" ? "进场特效" : "进房", shownEventName(event), {
            kind: "enter",
            event,
          });
        }
        if (this.isModuleEnabled("welcome")) {
          this.handleEnterEvent(event);
        }
      }
      this.emitSnapshot();
    });

    client.on("gift", (event) => {
      if (!this.shouldProcessHighEvent("gift", event)) return;
      this.rememberUserVisualHint(event, "gift_raw");
      const giftEvent = this.giftCatalog.enrichGift(this.enrichUserVisual(event));
      this.rememberUserVisualHint(giftEvent, "gift_packet");
      if (giftEvent.source === "notice_gift") {
        this.deferNoticeGift(giftEvent);
        return;
      }
      this.cancelPendingNoticeGift(giftEvent);
      this.processGiftEvent(giftEvent);
    });

    client.on("superChat", (event) => {
      if (!this.shouldProcessHighEvent("superChat", event)) return;
      this.markGiftEvent(event.command || "SUPER_CHAT_MESSAGE");
      this.counts.superChat += 1;
      this.recordEvent("superChat", event);
      this.captureScreenIfNeeded("superChat", event);
      if (event.isDelete) {
        this.log("醒目留言", `删除 ${event.deletedIds?.length || 0} 条`, { kind: "superChat" });
        this.emitSnapshot();
        return;
      }
      this.log("醒目留言", `${event.userName}: ${event.text} (${event.price})`);
      this.handleActions(this.interactions.handleSuperChat(event), event);
      this.emitSnapshot();
    });

    client.on("guard", (event) => {
      if (!this.shouldProcessHighEvent("guard", event)) return;
      this.rememberUserVisualHint(event, "guard_raw");
      const guardEvent = this.guardCatalog.enrichGuard(this.enrichUserVisual(event));
      this.rememberUserVisualHint(guardEvent, "guard");
      this.markGiftEvent(guardEvent.command || "GUARD_BUY");
      this.counts.guard += 1;
      this.log(
        "大航海",
        guardEvent.message ||
          `${guardEvent.userName} ${guardEvent.guardName || guardEvent.guardLevel} ${guardEvent.valueText || ""}`
      );
      const actions = this.interactions.handleGuard(guardEvent);
      this.recordGuardIfNeeded(guardEvent);
      this.captureScreenIfNeeded("guard", guardEvent);
      this.pointsEngine?.awardGuard(guardEvent, this.roomInfo || {});
      this.handleActions(this.isModuleEnabled("guardBoard") ? actions : [], guardEvent);
      this.emitSnapshot();
    });

    client.on("like", (event) => {
      if (!this.shouldProcessHighEvent("like", event)) return;
      this.rememberUserVisualHint(event, "like_raw");
      Object.assign(event, this.enrichUserVisual(event));
      this.counts.like += 1;
      this.recordEvent("like", event);
      if (this.showEvents) this.log("点赞", `${event.userName} x${event.likeCount}`);
      this.handleActions(this.interactions.handleLike(event), event);
      this.emitSnapshot();
    });

    client.on("pk", (event) => {
      if (!this.shouldProcessHighEvent("pk", event)) return;
      if (event.command === "PK_MULTI_CONN") {
        for (const member of event.data?.members || []) {
          this.rememberUserVisualHint(
            {
              userId: member.uid || 0,
              userName: member.uname || member.display_name || "",
              face: member.face || "",
            },
            "pk_multi_member"
          );
        }
      }
      this.counts.pk += 1;
      this.recordEvent("pk", event);
      if (this.showEvents || this.config.pk?.showRawEvents) {
        this.log("PK事件", event.command, {
          kind: "pk",
          raw: this.config.pk?.showRawEvents ? event.raw : undefined,
        });
      }
      const actions = this.isModuleEnabled("pk") ? this.pkTracker.handle(event) : [];
      this.refreshPkInvestigationIfNeeded();
      this.logPkEventIfChanged(event);
      this.handleActions(actions, event);
      this.emitSnapshot();
    });

    client.on("notice", (event) => {
      if (!this.shouldProcessHighEvent("notice", event)) return;
      const noticeRoomId = Number(event.roomId || event.notice?.roomId || 0);
      const ownRoomId = Number(this.roomInfo?.roomId || 0);
      const isLocalNotice = !noticeRoomId || !ownRoomId || noticeRoomId === ownRoomId;
      const isLocalGiftNotice = event.noticeKind === "gift" && isLocalNotice;
      this.counts.notice += 1;
      this.recordEvent("notice", event);
      if (isLocalGiftNotice) this.markGiftEvent(`${event.command || "NOTICE"}_GIFT`);
      if (this.showEvents || isLocalGiftNotice) {
        this.log(isLocalGiftNotice ? "公告礼物" : "公告", event.text || event.command || "", {
          kind: isLocalGiftNotice ? "gift" : "notice",
          event,
        });
      }
      this.emitSnapshot();
    });

    client.on("event", (event) => {
      if (!this.shouldProcessHighEvent("event", event)) return;
      this.counts.event += 1;
      this.handleGenericEvent(event);
      this.updateSpecialMode(event.command, event);
      this.recordEvent("event", event);
      if (this.showEvents) this.log("事件", event.command);
      this.emitSnapshot();
    });

    client.on("warn", ({ message, error }) => {
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        lastWarnAt: Date.now(),
        lastWarn: `${message || ""}${error?.message ? `: ${error.message}` : ""}`,
      });
      this.counts.warn += 1;
      this.log("警告", `${message}${error?.message ? `: ${error.message}` : ""}`, {
        level: "warn",
      });
    });

    client.on("closed", ({ code, reason }) => {
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        connected: false,
        authenticated: false,
        reconnecting: false,
        closedAt: Date.now(),
        closeCode: code,
        closeReason: reason || "",
      });
      if (primary) {
        this.log("断开", `${code}${reason ? ` ${reason}` : ""}`);
        if (this.rules && !this.connected) this.rules.stopTimers();
      } else if (this.showEvents) {
        this.log("备线断开", `${lineLabel} ${code}${reason ? ` ${reason}` : ""}`);
      }
      this.emitSnapshot();
    });

    client.on("reconnecting", ({ delayMs }) => {
      this.setClientLineState(lineLabel, {
        primary,
        label: lineLabel,
        connected: false,
        authenticated: false,
        reconnecting: true,
        reconnectingAt: Date.now(),
        nextRetryAt: Date.now() + Number(delayMs || 0),
      });
      this.log("重连", `${Math.round(delayMs / 1000)} 秒后重试`);
      this.emitSnapshot();
    });
  }

  setClientLineState(lineLabel, patch = {}) {
    const key = lineLabel || "线路";
    const previous = this.clientLineStates.get(key) || {};
    const next = {
      ...previous,
      ...patch,
      label: patch.label || previous.label || key,
      updatedAt: Date.now(),
    };
    this.clientLineStates.set(key, next);
    this.updateConnectedState();
    return next;
  }

  updateConnectedState(now = Date.now()) {
    if (!this.running) {
      this.connected = false;
      return false;
    }
    const rawFreshMs = Number(this.config.connection?.lineRawFreshMs || 45000);
    const anyLive = [...this.clientLineStates.values()].some((line) => {
      if (line.connected || line.authenticated) return true;
      return Boolean(line.lastRawAt && now - Number(line.lastRawAt) <= rawFreshMs);
    });
    this.connected = anyLive;
    return anyLive;
  }

  getConnectionLines() {
    return [...this.clientLineStates.values()]
      .map((line) => ({
        label: line.label || "",
        primary: Boolean(line.primary),
        endpoint: line.endpoint || "",
        connected: Boolean(line.connected),
        authenticated: Boolean(line.authenticated),
        reconnecting: Boolean(line.reconnecting),
        lastRawAt: line.lastRawAt || 0,
        lastRawCommand: line.lastRawCommand || "",
        lastWarnAt: line.lastWarnAt || 0,
        lastWarn: line.lastWarn || "",
        closeCode: line.closeCode || 0,
        closeReason: line.closeReason || "",
        updatedAt: line.updatedAt || 0,
      }))
      .sort((left, right) => Number(right.primary) - Number(left.primary) || left.label.localeCompare(right.label));
  }

  isModuleEnabled(name) {
    if (!name) return true;
    return this.moduleStatus?.[name]?.enabled !== false;
  }

  createGiftReportAction(options = {}) {
    const range = options.range || "today";
    const label = options.label || (range === "today" ? "今日" : "本次");
    const roomId = options.roomId || this.roomInfo?.roomId;
    let stats = null;
    try {
      if (this.eventStore && roomId) {
        stats = summarizeGifts(this.queryTrustedGiftRows({ range, roomId }));
        if (stats) {
          stats = {
            ...stats,
            source: stats.source || "history",
            day: stats.day || (range === "today" ? dayKey() : range),
          };
        }
      }
    } catch {
      stats = null;
    }
    if (!stats && range === "today") stats = this.getGiftStatsSnapshot();
    if (!stats && this.interactions?.createGiftReportAction) {
      return this.interactions.createGiftReportAction(options);
    }
    stats = stats || { topUsers: [], topGifts: [], totalValueText: "0电池", totalGiftCount: 0 };
    const userText =
      stats.topUsers?.length > 0
        ? stats.topUsers
            .slice(0, 5)
            .map((item, index) => `${index + 1}.${item.userName} ${item.valueText || formatBattery(item.totalCoin) || "0电池"}`)
            .join("；")
        : "暂无付费礼物";
    const giftText =
      stats.topGifts?.length > 0
        ? stats.topGifts.slice(0, 5).map((item) => `${item.giftName}x${item.count}`).join("，")
        : "暂无礼物";
    return {
      type: "gift_report",
      ruleName: "gift_report",
      reply: `${label}礼物：共${stats.totalValueText || formatBattery(stats.totalCoin) || "0电池"}，${stats.totalGiftCount || 0}件。贡献榜 ${userText}。礼物 ${giftText}。`,
      emotion: "calm",
      priority: 100,
      metadata: {
        range,
        label,
        source: stats.source || "history",
        day: stats.day || "",
      },
    };
  }

  createTrustedHistoryView() {
    const store = this.eventStore;
    if (!store) return store;
    if (this.trustedHistoryView?.__store === store) return this.trustedHistoryView;
    // 观众命令查礼物历史也必须走受信口径，否则打字伪造的补记会出现在「我的今日礼物」里
    const view = {
      __store: store,
      queryGifts: (options = {}) => summarizeGifts(this.queryTrustedGiftRows(options)),
    };
    for (const key of ["queryChatCounts", "queryChatSummary", "queryGuards", "queryManualGuards", "queryGiftRows", "readEvents"]) {
      if (typeof store[key] === "function") view[key] = store[key].bind(store);
    }
    this.trustedHistoryView = view;
    return view;
  }

  createCommandContext() {
    const interactions = this.interactions ? Object.create(this.interactions) : {};
    interactions.createGiftReportAction = (options) => this.createGiftReportAction(options);
    return {
      roomInfo: this.roomInfo,
      history: this.createTrustedHistoryView(),
      interactions,
      pkTracker: this.pkTracker,
      guardBoard: this.getGuardBoard(),
      points: this.pointsEngine,
      moduleStatus: this.moduleStatus,
    };
  }

  refreshGiftCatalog(roomId) {
    if (!roomId || this.giftCatalogRefreshPromise) return this.giftCatalogRefreshPromise;
    this.giftCatalogRefreshPromise = this.giftCatalog
      .refresh(roomId)
      .then((catalog) => {
        if (!this.running) return catalog;
        this.log(
          "礼物图鉴",
          `已缓存 ${catalog.total} 个礼物，当前房间面板 ${catalog.roomGiftCount} 个`
        );
        this.emitSnapshot();
        return catalog;
      })
      .catch((error) => {
        this.log("礼物图鉴失败", error.message, { level: "warn" });
        return null;
      })
      .finally(() => {
        this.giftCatalogRefreshPromise = null;
      });
    return this.giftCatalogRefreshPromise;
  }

  refreshGuardCatalog(roomInfo = {}) {
    if (!roomInfo.roomId || !roomInfo.uid || this.guardCatalogRefreshPromise) {
      return this.guardCatalogRefreshPromise;
    }
    this.guardCatalogRefreshPromise = this.guardCatalog
      .refresh({ roomId: roomInfo.roomId, ruid: roomInfo.uid })
      .then((catalog) => {
        if (!this.running) return catalog;
        const counts = catalog.counts || {};
        for (const row of catalog.rows || []) {
          this.rememberUserVisualHint(row, "guard_catalog");
        }
        this.backfillGiftFeedVisuals();
        this.log(
          "大航海图鉴",
          `已缓存 ${catalog.total} 位大航海：总督${counts[1] || 0} 提督${counts[2] || 0} 舰长${counts[3] || 0}`
        );
        this.emitSnapshot();
        return catalog;
      })
      .catch((error) => {
        this.log("大航海图鉴失败", error.message, { level: "warn" });
        return null;
      })
      .finally(() => {
        this.guardCatalogRefreshPromise = null;
      });
    return this.guardCatalogRefreshPromise;
  }

  noticeGiftMatchKey(event = {}) {
    const user = normalizeText(event.displayUserName || event.userName || "");
    const gift = Number(event.giftId || 0) || normalizeText(event.giftName || "");
    const count = Number(event.count || 1);
    if (!user || !gift) return "";
    return `${user}:${gift}:${count}`;
  }

  deferNoticeGift(event = {}) {
    const key = this.noticeGiftMatchKey(event);
    const delayMs = Math.max(0, Number(this.config.history?.noticeGiftDelayMs ?? 8000));
    if (!key || !delayMs) {
      this.processGiftEvent(event);
      return;
    }
    const previous = this.pendingNoticeGifts.get(key);
    if (previous?.timer) clearTimeout(previous.timer);
    const timer = setTimeout(() => {
      this.pendingNoticeGifts.delete(key);
      if (!this.running) return;
      this.processGiftEvent(event);
    }, delayMs);
    this.pendingNoticeGifts.set(key, {
      at: Date.now(),
      event,
      timer,
    });
    this.markGiftEvent(event.command || "NOTICE_MSG_GIFT");
    if (this.showEvents) {
      this.log(
        "公告礼物待确认",
        `${event.displayUserName || event.userName} ${event.giftName} x${event.count}`,
        { kind: "gift", event }
      );
    }
    this.emitSnapshot();
  }

  cancelPendingNoticeGift(event = {}) {
    const key = this.noticeGiftMatchKey(event);
    if (!key) return false;
    const pending = this.pendingNoticeGifts.get(key);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingNoticeGifts.delete(key);
    if (this.showEvents) {
      this.log(
        "公告礼物合并",
        `${event.displayUserName || event.userName} ${event.giftName} 已由真实礼物包入账`,
        { kind: "gift", event }
      );
    }
    return true;
  }

  processGiftEvent(giftEvent = {}) {
    this.markGiftEvent(giftEvent.command || "SEND_GIFT");
    this.counts.gift += 1;
    this.log("礼物", `${giftEvent.displayUserName || giftEvent.userName} ${giftEvent.giftName} x${giftEvent.count}`, {
      kind: "gift",
      event: giftEvent,
    });
    const actions = this.interactions.handleGift(giftEvent);
    this.recordGiftIfNeeded(giftEvent);
    this.captureScreenIfNeeded("gift", giftEvent);
    this.pointsEngine?.awardGift(giftEvent, this.roomInfo || {});
    this.rememberRecentGiftPacket(giftEvent);
    this.handleGiftThanksActions(this.isModuleEnabled("giftThanks") ? actions : [], giftEvent);
    this.emitSnapshot();
  }

  refreshPkInvestigationIfNeeded() {
    if (!this.pkInvestigator || !this.pkTracker || !this.isModuleEnabled("pk")) return;
    if (this.config.pk?.investigator?.enabled === false) return;
    const snapshot = this.pkTracker.getSnapshot();
    const ownRoomId = Number(snapshot.ownRoomId || this.roomInfo?.roomId || 0);
    const maxRooms = Math.max(1, Number(this.config.pk?.investigator?.maxRooms || 4));
    const rooms = [
      Number(snapshot.opponent?.roomId || 0),
      ...(snapshot.multiMembers || [])
        .map((member) => Number(member.roomId || 0))
        .filter((roomId) => roomId && (!ownRoomId || roomId !== ownRoomId)),
    ]
      .filter(Boolean)
      .filter((roomId, index, list) => list.indexOf(roomId) === index)
      .slice(0, maxRooms);
    if (!rooms.length) return;
    const now = Date.now();
    for (const roomId of rooms) {
      const lastAt = Number(this.lastPkInvestigationByRoom?.get(roomId) || 0);
      if (this.pkInvestigationInFlightRooms?.has(roomId)) continue;
      if (now - lastAt < 30000) continue;
      this.runPkInvestigation(roomId, Number(snapshot.opponent?.roomId || 0) === roomId);
    }
  }

  retryPkInvestigation(roomId = 0) {
    if (!this.pkTracker || !this.pkInvestigator) {
      return { ok: false, error: "PK 模块还没有启动" };
    }
    if (!this.isModuleEnabled("pk")) {
      return { ok: false, error: "PK 侦查模块已关闭" };
    }
    const snapshot = this.pkTracker.getSnapshot();
    const ownRoomId = Number(snapshot.ownRoomId || this.roomInfo?.roomId || 0);
    const targetRoomId =
      Number(roomId || 0) ||
      Number(snapshot.opponent?.roomId || 0) ||
      Number(
        (snapshot.multiMembers || []).find((member) => {
          const memberRoomId = Number(member.roomId || 0);
          return memberRoomId && (!ownRoomId || memberRoomId !== ownRoomId);
        })?.roomId || 0
      );
    if (!targetRoomId) {
      return { ok: false, error: "还没有对手房间，等 PK/连线事件出现后再重试" };
    }
    if (this.pkInvestigationInFlightRooms?.has(targetRoomId)) {
      return { ok: true, roomId: targetRoomId, inFlight: true, message: "侦查已经在进行中" };
    }
    this.lastPkInvestigationByRoom?.delete(targetRoomId);
    const isPrimaryOpponent = Number(snapshot.opponent?.roomId || 0) === targetRoomId;
    this.log("PK侦查", `正在重新侦查房间 ${targetRoomId}`, { kind: "pk" });
    this.runPkInvestigation(targetRoomId, isPrimaryOpponent);
    return { ok: true, roomId: targetRoomId, inFlight: true, message: "已开始重新侦查" };
  }

  runPkInvestigation(roomId = 0, isPrimaryOpponent = false) {
    const targetRoomId = Number(roomId || 0);
    if (!targetRoomId || !this.pkInvestigator || !this.pkTracker) return;
    this.pkInvestigationInFlight = true;
    if (!this.pkInvestigationInFlightRooms) this.pkInvestigationInFlightRooms = new Set();
    if (!this.lastPkInvestigationByRoom) this.lastPkInvestigationByRoom = new Map();
    this.pkInvestigationInFlightRooms.add(targetRoomId);
    this.lastPkInvestigationByRoom.set(targetRoomId, Date.now());
    this.pkInvestigator
      .investigate(targetRoomId)
      .then((info) => {
        if (!this.running) return;
        if (!info) return;
        this.pkTracker.mergeMemberInvestigation?.(targetRoomId, info);
        if (isPrimaryOpponent) this.pkTracker.mergeOpponentInvestigation?.(info);
        this.pkTracker.setInvestigationError?.("");
        for (const row of info.topRank || []) {
          this.rememberUserVisualHint(
            {
              userId: row.uid,
              userName: row.uname,
              guardLevel: row.guardLevel,
            },
            "pk_opponent_rank"
          );
        }
        this.log(
          "PK侦查",
          `${isPrimaryOpponent ? "对手" : "多人对手"} ${info.uname || targetRoomId}：${info.guardCount || 0}船，${info.fans || 0}粉，高能榜${info.onlineRankCount || 0}人，船员在线${info.onlineGuardCount || 0}人，前排贡献${info.topScore || 0}${info.partialFailures?.length ? `；部分接口失败：${info.partialFailures.join("、")}` : ""}`,
          { kind: "pk" }
        );
        this.persistSnapshots(true);
        this.emitSnapshot();
      })
      .catch((error) => {
        this.pkTracker.setInvestigationError?.(`${targetRoomId}: ${error.message}`);
        this.log("PK侦查失败", error.message, { level: "warn" });
      })
      .finally(() => {
        this.pkInvestigationInFlightRooms.delete(targetRoomId);
        this.pkInvestigationInFlight = this.pkInvestigationInFlightRooms.size > 0;
      });
  }

  formatPkEventLog(event = {}) {
    if (!this.pkTracker) return "";
    const snapshot = this.pkTracker.getSnapshot();
    const command = event.command || "";
    if (command === "PK_NOTICE") {
      const text = snapshot.lastNotice?.text || event.text || event.data?.text || "";
      return text ? `PK提醒：${text}` : "PK提醒";
    }
    if (command === "PK_MULTI_CONN") {
      const members = snapshot.multiMembers || [];
      if (!members.length) return snapshot.report || "";
      const ownRoomId = Number(snapshot.ownRoomId || this.roomInfo?.roomId || 0);
      const own = members.find((item) => ownRoomId && Number(item.roomId) === ownRoomId);
      const target =
        members.find((item) => own && Number(item.roomId) !== Number(own.roomId)) ||
        members.find((item) => item.rank === 1) ||
        members[0];
      const rows = members
        .slice()
        .sort((left, right) => (left.rank || 9999) - (right.rank || 9999))
        .map(
          (item) =>
            `${item.rank || "-"} ${item.uname || item.roomId || "未知"} ${item.votes}${
              snapshot.voteName || "分"
            }`
        )
        .join("，");
      const ownText = own ? `我方 ${own.votes}${snapshot.voteName || "分"}` : "我方未知";
      const targetText = target
        ? `对面 ${target.uname || target.roomId} ${target.votes}${snapshot.voteName || "分"}`
        : "对面未知";
      return `连线/多人PK：${ownText}，${targetText}；${rows}`;
    }
    return snapshot.report || command;
  }

  logPkEventIfChanged(event = {}) {
    const message = this.formatPkEventLog(event);
    if (!message) return;
    const key = `${event.command || ""}:${message}`;
    if (key === this.lastPkLogKey) return;
    this.lastPkLogKey = key;
    this.log(event.command === "PK_MULTI_CONN" ? "连线情报" : "PK情报", message, {
      kind: "pk",
      event,
    });
  }

  handleGenericEvent(event = {}) {
    const kind = event.eventKind || "";
    if (kind === "live_status") {
      const liveStatus = Number(event.liveStatus || 0);
      const previousLiveStatus = this.lastLiveStatus;
      this.specialModes.live = liveStatus !== 0;
      this.roomInfo = {
        ...(this.roomInfo || {}),
        roomId: event.roomId || this.roomInfo?.roomId || 0,
        liveStatus,
        liveStatusLabel: event.liveStatusLabel || (liveStatus ? "直播中" : "未开播"),
      };
      if (this.lastLiveStatus !== liveStatus) {
        this.lastLiveStatus = liveStatus;
        this.log(liveStatus ? "开播" : "下播", event.text || this.roomInfo.liveStatusLabel, {
          kind: "event",
          event,
        });
        if (this.running) {
          if (this.proactiveAiLiveEligible()) this.startProactiveAiScheduler();
          else this.stopProactiveAiScheduler();
        }
        const liveConfig = this.config.interactions?.live || {};
        const entryMsg = firstString(liveConfig.entryMsg, this.config.EntryMsg, this.config.entryMsg);
        const goodbyeInfo = firstString(liveConfig.goodbyeInfo, this.config.GoodbyeInfo, this.config.goodbyeInfo);
        if (liveStatus && entryMsg) {
          this.handleAction(
            {
              type: "reply",
              ruleName: "live_status",
              reply: entryMsg,
              emotion: "calm",
              priority: 70,
            },
            event
          );
        } else if (previousLiveStatus === 1 && !liveStatus && goodbyeInfo) {
          this.handleAction(
            {
              type: "reply",
              ruleName: "live_status",
              reply: goodbyeInfo,
              emotion: "calm",
              priority: 70,
            },
            event
          );
        }
      }
      return;
    }

    if (kind === "room_realtime") {
      this.roomRealtime = {
        ...event,
        at: Date.now(),
      };
      if (this.roomInfo) {
        this.roomInfo = {
          ...this.roomInfo,
          fans: Number(event.fans || this.roomInfo.fans || 0),
          fansClub: Number(event.fansClub || this.roomInfo.fansClub || 0),
        };
      }
      return;
    }

    if (kind === "room_metadata") {
      this.roomInfo = {
        ...(this.roomInfo || {}),
        title: event.title || this.roomInfo?.title || "",
        areaId: event.areaId ?? this.roomInfo?.areaId ?? 0,
        parentAreaId: event.parentAreaId ?? this.roomInfo?.parentAreaId ?? 0,
        areaName: event.areaName || this.roomInfo?.areaName || "",
        parentAreaName: event.parentAreaName || this.roomInfo?.parentAreaName || "",
      };
      const item = {
        ...event,
        at: Date.now(),
      };
      this.activityStats.unshift(item);
      if (this.activityStats.length > 30) this.activityStats.length = 30;
      if (this.showEvents) {
        this.log("房间信息", event.text || event.command || "直播间信息变化", {
          kind: "event",
          event,
        });
      }
      return;
    }

    if (kind === "system_notice" || kind === "room_skin" || kind === "wealth" || kind === "medal_change") {
      if (kind === "medal_change") {
        this.rememberUserVisualHint(event, "medal_change");
      }
      const item = {
        ...event,
        at: Date.now(),
      };
      this.activityStats.unshift(item);
      if (this.activityStats.length > 30) this.activityStats.length = 30;
      if (this.showEvents) {
        const label =
          kind === "medal_change"
            ? "粉丝牌"
            : kind === "wealth"
              ? "财富等级"
              : kind === "room_skin"
                ? "直播间皮肤"
                : "系统提示";
        this.log(label, event.text || event.command || label, {
          kind: "event",
          event,
        });
      }
      return;
    }

    if (kind === "rank") {
      const item = {
        ...event,
        at: Date.now(),
      };
      this.rankStats.unshift(item);
      if (this.rankStats.length > 30) this.rankStats.length = 30;
      if (this.showEvents) {
        this.log("榜单", event.text || event.command || "榜单变化", {
          kind: "event",
          event,
        });
      }
      return;
    }

    if (kind === "widget") {
      const item = {
        ...event,
        at: Date.now(),
      };
      this.widgetStats.unshift(item);
      if (this.widgetStats.length > 30) this.widgetStats.length = 30;
      if (this.showEvents) {
        this.log("挂件/面板", event.text || event.command || "面板变化", {
          kind: "event",
          event,
        });
      }
      return;
    }

    if (kind === "activity") {
      const item = {
        ...event,
        at: Date.now(),
      };
      this.activityStats.unshift(item);
      if (this.activityStats.length > 30) this.activityStats.length = 30;
      if (this.showEvents || event.activityType === "share") {
        this.log(
          event.activityType === "share" ? "分享" : "活动",
          event.text || event.command || "活动变化",
          {
            kind: "event",
            event,
          }
        );
      }
      return;
    }

    if (kind === "connection") {
      for (const member of event.members || []) {
        this.rememberUserVisualHint(
          {
            userId: member.userId || member.uid || 0,
            userName: member.userName || member.uname || "",
            face: member.face || "",
          },
          "connection_member"
        );
      }
      this.connectionState = {
        ...event,
        at: Date.now(),
      };
      this.counts.connection += 1;
      const message = event.text || event.command || "连线状态变化";
      const key = `${event.command || ""}:${message}:${event.roomStatus || ""}:${event.rootStatus || ""}`;
      if (
        (this.showEvents || /连线|视频|语音|PK|pk|VOICE_JOIN|VIDEO_CONNECTION/i.test(`${message} ${event.command || ""}`)) &&
        key !== this.lastConnectionLogKey
      ) {
        this.lastConnectionLogKey = key;
        this.log("连线", message, {
          kind: "pk",
          event,
        });
      }
      return;
    }

    if (kind === "room_moderation") {
      this.moderationEvents.unshift({
        ...event,
        at: Date.now(),
      });
      if (this.moderationEvents.length > 20) this.moderationEvents.length = 20;
      if (this.showEvents) {
        this.log("房管", event.text || event.command || "", {
          kind: "event",
          event,
        });
      }
      const moderation = this.config.interactions?.moderation || {};
      const showBlockMsg =
        moderation.showBlockMsg === true ||
        this.config.ShowBlockMsg === true ||
        this.config.showBlockMsg === true;
      if (showBlockMsg && event.userName) {
        const template = firstString(
          moderation.blockTemplate,
          "{user} 被禁言了，大家注意直播间秩序。"
        );
        const reply = template.replaceAll("{user}", event.userName).replaceAll("{message}", event.text || "");
        this.handleAction(
          {
            type: "reply",
            ruleName: "moderation",
            reply,
            emotion: "serious",
            priority: 70,
          },
          event
        );
      }
      return;
    }

    if (kind === "guard_honor") {
      this.markGiftEvent(event.command || "GUARD_HONOR_THOUSAND");
      if (this.roomInfo?.roomId && this.roomInfo?.uid) {
        this.refreshGuardCatalog(this.roomInfo);
      }
      if (this.showEvents) {
        this.log("大航海", event.text || event.command || "大航海荣誉事件", {
          kind: "guard",
          event,
        });
      }
    }
  }

  handleGiftTextFallback(chatEvent = {}) {
    if (isAssistantLikeName(chatEvent.userName) || isAssistantLikeName(chatEvent.displayUserName)) return;
    const sourceEvent = this.enrichUserVisual(chatEvent);
    const parsed = parseGiftTextFallback(chatEvent.text);
    if (!parsed) return;

    const resultGift = this.giftCatalog.findGift({ giftName: parsed.giftName });
    const sourceGift = this.giftCatalog.findGift({ giftName: parsed.sourceGiftName });
    const count = Number(parsed.count || 1);
    const totalCoin = Number(sourceGift?.price || resultGift?.price || 0) * count;
    const source = chatEvent.source === "visible_bridge" ? "visible_gift_bridge" : "danmu_gift_fallback";
    const userName = parsed.userName || sourceEvent.userName;
    const giftEvent = this.enrichUserVisual(this.giftCatalog.enrichGift({
      command: source === "visible_gift_bridge" ? "VISIBLE_GIFT_BRIDGE" : "DANMU_GIFT_FALLBACK",
      userName,
      displayUserName: sourceEvent.displayUserName || userName,
      userId: sourceEvent.userId || 0,
      face: sourceEvent.face || "",
      medalName: sourceEvent.medalName || "",
      medalLevel: sourceEvent.medalLevel || 0,
      medalColors: sourceEvent.medalColors || null,
      guardLevel: sourceEvent.guardLevel || 0,
      guardName: sourceEvent.guardName || "",
      guardIcon: sourceEvent.guardIcon || "",
      avatarFrame: sourceEvent.avatarFrame || null,
      avatarFrameUrl: sourceEvent.avatarFrameUrl || "",
      avatarFrameName: sourceEvent.avatarFrameName || "",
      avatarFrameSource: sourceEvent.avatarFrameSource || "",
      wealthLevel: sourceEvent.wealthLevel || 0,
      action: parsed.blind
        ? parsed.sourceGiftName
          ? `投喂 ${parsed.sourceGiftName} 爆出`
          : "爆出"
        : "投喂",
      giftId: resultGift?.id || 0,
      giftName: parsed.giftName,
      giftIcon: resultGift?.icon || "",
      sourceGiftId: sourceGift?.id || 0,
      sourceGiftName: parsed.sourceGiftName || "",
      sourceGiftPrice: sourceGift?.price || 0,
      blindGift: parsed.blind
        ? {
            originalGiftId: sourceGift?.id || 0,
            originalGiftName: parsed.sourceGiftName || "",
            originalGiftPrice: sourceGift?.price || 0,
            action: "爆出",
            resultPrice: resultGift?.price || 0,
          }
        : null,
      count,
      price: resultGift?.price || sourceGift?.price || 0,
      totalCoin,
      coinType: resultGift?.coinType || sourceGift?.coinType || "gold",
      source,
      isSimulated: Boolean(sourceEvent.isSimulated),
      dedupeKey:
        chatEvent.raw?.msg_id || chatEvent.id
          ? `${source}:${chatEvent.raw?.msg_id || chatEvent.id}`
          : `${source}:${chatEvent.userId || userName}:${parsed.sourceGiftName || ""}:${parsed.giftName}:${count}:${Date.now()}`,
    }));
    this.rememberUserVisualHint(giftEvent, source);

    // 不论来自 WS 弹幕还是网页公屏（DOM 桥），纯文本解析出的"礼物"任何观众都能打字伪造：
    // 一律只留档为待网页核对的补记，不进统计/积分，也不触发感谢。
    // 只有带结构化礼物字段的可见礼物泡泡（走 handleVisibleStructuredGift）才允许全额入账。
    giftEvent.needsVisualCheck = true;
    this.markGiftEvent(giftEvent.command);
    this.counts.gift += 1;
    this.log(
      "礼物兜底",
      `${giftEvent.displayUserName || giftEvent.userName} ${giftEvent.sourceGiftName ? `${giftEvent.sourceGiftName}->` : ""}${giftEvent.giftName} x${giftEvent.count}（待网页核对，不计入统计）`,
      { kind: "gift", event: giftEvent }
    );
    this.recordUnverifiedGiftEvent(giftEvent);
    this.emitSnapshot();
    return giftEvent;
  }

  handleVisibleStructuredGift(event = {}, parsed = {}, input = {}) {
    const fallbackGift = parseGiftTextFallback(event.text);
    const kind = String(input.kind || parsed.kind || "").toLowerCase();
    const giftName = firstString(input.giftName, parsed.giftName, fallbackGift?.giftName);
    const sourceGiftName = firstString(input.sourceGiftName, parsed.sourceGiftName, fallbackGift?.sourceGiftName);
    const isGiftLike = kind === "gift" || Boolean(giftName) || Boolean(fallbackGift);
    if (!isGiftLike || !giftName) return null;
    // 结构化证据 = 桥端解析礼物泡泡时给出的显式字段；只有这种才可信。
    // 仅凭 parseGiftTextFallback 从聊天文本推断出来的"礼物"，观众打字就能伪造，必须走补记降级。
    const hasStructuredEvidence =
      kind === "gift" ||
      Boolean(firstString(input.giftName, parsed.giftName)) ||
      Number(input.giftId || parsed.giftId || 0) > 0;
    if (!hasStructuredEvidence) {
      return this.handleGiftTextFallback({
        ...event,
        source: "visible_bridge",
      });
    }

    const resultGift = this.giftCatalog.findGift({
      giftId: input.giftId || parsed.giftId,
      giftName,
    });
    const sourceGift = this.giftCatalog.findGift({
      giftId: input.sourceGiftId || parsed.sourceGiftId,
      giftName: sourceGiftName,
    });
    const count = Math.max(1, Number(input.count || parsed.count || fallbackGift?.count || 1));
    const blind = Boolean(sourceGiftName || fallbackGift?.blind);
    const price = Number(
      input.price ||
        parsed.price ||
        (blind ? sourceGift?.price : resultGift?.price) ||
        resultGift?.price ||
        sourceGift?.price ||
        0
    );
    const totalCoin = Number(input.totalCoin || parsed.totalCoin || 0) || price * count;
    const source = "visible_gift_bridge";
    const at = Number(input.at || event.at || 0) || Date.now();
    const dedupeKey =
      input.id ||
      input.nodeKey ||
      (input.batchId ? `${input.batchId}:${input.batchIndex || 0}` : "") ||
      `${source}:${event.userId || event.userName}:${sourceGiftName}:${giftName}:${count}:${at}`;
    const giftIcon = firstString(input.giftIcon, input.giftIconUrl, parsed.giftIcon, parsed.giftIconUrl, resultGift?.icon);
    const action = blind
      ? sourceGiftName
        ? `投喂 ${sourceGiftName} ${fallbackGift?.blindGift?.action || "爆出"}`
        : "爆出"
      : "投喂";

    const giftEvent = this.enrichUserVisual(
      this.giftCatalog.enrichGift({
        ...event,
        command: "VISIBLE_GIFT_BRIDGE",
        text: event.text,
        action,
        giftId: Number(input.giftId || parsed.giftId || resultGift?.id || 0),
        giftName,
        giftIcon,
        sourceGiftId: Number(input.sourceGiftId || parsed.sourceGiftId || sourceGift?.id || 0),
        sourceGiftName,
        sourceGiftPrice: Number(sourceGift?.price || 0),
        blindGift: blind
          ? {
              originalGiftId: Number(input.sourceGiftId || parsed.sourceGiftId || sourceGift?.id || 0),
              originalGiftName: sourceGiftName,
              originalGiftPrice: Number(sourceGift?.price || 0),
              action: "爆出",
              resultPrice: Number(resultGift?.price || price || 0),
            }
          : null,
        count,
        price,
        totalCoin,
        coinType: input.coinType || parsed.coinType || resultGift?.coinType || sourceGift?.coinType || "gold",
        source,
        at,
        dedupeKey,
        raw: {
          cmd: "VISIBLE_GIFT_BRIDGE",
          msg_id: dedupeKey,
          data: {
            line: parsed.line || input.line || "",
            bridge_version: input.bridgeVersion || "",
            batch_id: input.batchId || "",
            batch_index: input.batchIndex,
            image_urls: input.imageUrls || [],
          },
        },
      })
    );

    this.rememberUserVisualHint(giftEvent, source);
    this.markGiftEvent(giftEvent.command);
    this.counts.gift += 1;
    if (this.visualAudit) this.visualAudit.acceptedGift += 1;
    this.log(
      "可见礼物",
      `${giftEvent.displayUserName || giftEvent.userName} ${giftEvent.sourceGiftName ? `${giftEvent.sourceGiftName}->` : ""}${giftEvent.giftName} x${giftEvent.count}`,
      { kind: "gift", event: giftEvent }
    );
    const actions = this.interactions.handleGift(giftEvent);
    this.recordGiftIfNeeded(giftEvent);
    this.captureScreenIfNeeded("gift", giftEvent);
    this.pointsEngine?.awardGift(giftEvent, this.roomInfo || {});
    this.rememberRecentGiftPacket(giftEvent);
    this.handleGiftThanksActions(!giftEvent.isSimulated && this.isModuleEnabled("giftThanks") ? actions : [], giftEvent);
    this.emitSnapshot();
    return giftEvent;
  }

  ensureVisibleEngines() {
    if (!this.rules || !this.interactions || !this.commandEngine) {
      this.rules = new RuleEngine(this.config);
      this.interactions = new InteractionEngine(this.config);
      this.commandEngine = new CommandEngine(this.config);
      this.pkTracker = new PkTracker({
        ...(this.config.pk || {}),
        ownRoomId: this.roomInfo?.roomId || 0,
      });
    }
  }

  currentVisibleRoomId() {
    const roomInfoId = Number(this.roomInfo?.roomId || this.roomInfo?.room_id || 0);
    if (roomInfoId) return roomInfoId;
    try {
      return Number(extractRoomId(this.room || this.config?.room || ""));
    } catch {
      return 0;
    }
  }

  visibleRoomGuard(input = {}) {
    if (input.isSimulated || input.simulated || input.source === "simulation") {
      return { ok: true };
    }
    const expectedRoomId = this.currentVisibleRoomId();
    const incomingRoomId = extractVisibleRoomId(input);
    if (!expectedRoomId) {
      return { ok: false, expectedRoomId, incomingRoomId, missingExpectedRoom: true };
    }
    if (expectedRoomId && incomingRoomId && expectedRoomId !== incomingRoomId) {
      return { ok: false, expectedRoomId, incomingRoomId };
    }
    return { ok: true, expectedRoomId, incomingRoomId };
  }

  visibleRoomMismatchResult(input = {}, guard = {}) {
    const expectedRoomId = Number(guard.expectedRoomId || 0);
    const incomingRoomId = Number(guard.incomingRoomId || 0);
    const missingExpectedRoom = Boolean(guard.missingExpectedRoom);
    const message = missingExpectedRoom
      ? `网页核对来自房间 ${incomingRoomId || "未知"}，但本地还没有确认监听房间，已拒收以避免错房间数据污染`
      : `网页核对来自房间 ${incomingRoomId}，当前监听房间 ${expectedRoomId}，已拒收以避免错房间数据污染`;
    const now = Date.now();
    if (now - Number(this.lastVisibleRoomMismatchLogAt || 0) > 15000) {
      this.lastVisibleRoomMismatchLogAt = now;
      this.log("网页核对房间不符", message, { level: "warn" });
    }
    const normalizedKind = String(input.kind || "").toLowerCase();
    const kind =
      input.audit === true || normalizedKind === "audit"
        ? "audit"
        : Array.isArray(input.events) || normalizedKind === "batch"
          ? "batch"
          : "visible";
    return {
      ok: true,
      skipped: true,
      kind,
      active: false,
      reason: missingExpectedRoom ? "未绑定监听房间，网页核对未入库" : "网页房间不匹配，未入库",
      message,
      expectedRoomId,
      incomingRoomId,
      missingExpectedRoom,
      summary: this.getVisualAuditSummary(),
    };
  }

  ingestVisible(input = {}) {
    this.ensureVisibleEngines();
    if (input.audit === true || String(input.kind || "").toLowerCase() === "audit") {
      return this.ingestVisibleAudit(input);
    }
    const roomGuard = this.visibleRoomGuard(input);
    if (!roomGuard.ok) return this.visibleRoomMismatchResult(input, roomGuard);

    if (Array.isArray(input.events)) {
      const dropped = Math.max(0, input.events.length - 80);
      if (dropped > 0) {
        // 超限截断不再静默：留日志并计入网页核对缺口，解释 observed/accepted 差值
        if (this.visualAudit) {
          this.visualAudit.truncatedCount = Number(this.visualAudit.truncatedCount || 0) + dropped;
        }
        this.log(
          "网页核对截断",
          `单批 ${input.events.length} 条超过 80 条上限，已丢弃末尾 ${dropped} 条`,
          { level: "warn" }
        );
      }
      const results = input.events.slice(0, 80).map((event, index) =>
        this.ingestVisible({
          ...event,
          bridgeVersion: event.bridgeVersion || input.bridgeVersion || "",
          url: event.url || input.url || "",
          title: event.title || input.title || "",
          roomId: event.roomId || event.room_id || input.roomId || input.room_id || 0,
          batchId: event.batchId || input.batchId || "",
          batchIndex: event.batchIndex ?? index,
          batchTotal: event.batchTotal || input.batchTotal || input.events.length,
          isSimulated: event.isSimulated !== undefined ? event.isSimulated : input.isSimulated,
        })
      );
      const accepted = results.filter((result) => result.ok && !result.skipped);
      return {
        ok: accepted.length > 0 || results.some((result) => result.ok),
        kind: "batch",
        count: accepted.length,
        total: results.length,
        results: results.map((result) => ({
          ok: result.ok,
          skipped: result.skipped,
          kind: result.kind,
          reason: result.reason,
          event: result.event
            ? {
                userName: result.event.userName,
                text: result.event.text,
                giftName: result.event.giftName,
                count: result.event.count,
              }
            : null,
        })),
      };
    }

    const parsedEvents = parseVisibleBlocks(input).filter((item) => item?.text);
    if (parsedEvents.length > 1) {
      const results = parsedEvents.map((parsed, index) =>
        this.ingestVisibleParsed(parsed, {
          ...input,
          id: input.id ? `${input.id}:${index}` : "",
          batchIndex: index,
          roomId: input.roomId || input.room_id || 0,
          isSimulated: input.isSimulated,
        })
      );
      const accepted = results.filter((result) => result.ok && !result.skipped);
      return {
        ok: accepted.length > 0 || results.some((result) => result.ok),
        kind: "batch",
        count: accepted.length,
        total: results.length,
        results: results.map((result) => ({
          ok: result.ok,
          skipped: result.skipped,
          kind: result.kind,
          reason: result.reason,
          event: result.event
            ? {
                userName: result.event.userName,
                text: result.event.text,
                giftName: result.event.giftName,
                count: result.event.count,
              }
            : null,
        })),
      };
    }

    return this.ingestVisibleParsed(parsedEvents[0] || parseVisibleLine(input), input);
  }

  ingestVisibleAudit(input = {}) {
    const now = Number(input.at || Date.now()) || Date.now();
    if (input.isSimulated || input.simulated || input.source === "simulation") {
      return {
        ok: true,
        kind: "audit",
        skipped: true,
        simulated: true,
        active: false,
        reason: "模拟网页心跳未入库",
        message: "本地接收接口可用；模拟心跳不会标记网页核对在线",
        summary: this.getVisualAuditSummary(),
      };
    }
    const roomGuard = this.visibleRoomGuard(input);
    if (!roomGuard.ok) return this.visibleRoomMismatchResult(input, roomGuard);
    const counts = input.counts || {};
    const delivery = input.delivery || input.bridgeStats || {};
    const recentEvents = Array.isArray(input.recentEvents) ? input.recentEvents.slice(0, 12) : [];
    const recent = recentEvents
      .map((item) => ({
        kind: item.kind || "",
        userName: item.userName || item.displayUserName || "",
        text: item.chatText || item.text || item.line || "",
        giftName: item.giftName || "",
        count: Number(item.count || 0) || 0,
        at: Number(item.at || now) || now,
      }))
      .filter((item) => item.text || item.giftName || item.userName);

    this.visualAudit = {
      ...(this.visualAudit || createVisualAuditState()),
      lastAt: now,
      lastUrl: input.url || this.visualAudit?.lastUrl || "",
      lastTitle: input.title || this.visualAudit?.lastTitle || "",
      lastBridgeVersion: input.bridgeVersion || this.visualAudit?.lastBridgeVersion || "",
      lastBatchId: input.batchId || this.visualAudit?.lastBatchId || "",
      heartbeatCount: (this.visualAudit?.heartbeatCount || 0) + 1,
      observedChat: Math.max(Number(counts.chat || 0), this.visualAudit?.observedChat || 0),
      observedGift: Math.max(Number(counts.gift || 0), this.visualAudit?.observedGift || 0),
      observedPk: Math.max(Number(counts.pk || 0), this.visualAudit?.observedPk || 0),
      acceptedChat: this.visualAudit?.acceptedChat || 0,
      acceptedGift: this.visualAudit?.acceptedGift || 0,
      acceptedPk: this.visualAudit?.acceptedPk || 0,
      duplicateCount: this.visualAudit?.duplicateCount || 0,
      lastSampleCount: Number(input.sampleCount || recent.length || 0),
      lastOnlineText: input.onlineText || this.visualAudit?.lastOnlineText || "",
      lastTextHash: input.textHash || this.visualAudit?.lastTextHash || "",
      lastDeliveryStatus: delivery.status || this.visualAudit?.lastDeliveryStatus || "",
      lastDeliveryNote: delivery.note || this.visualAudit?.lastDeliveryNote || "",
      lastDeliveryAt: Number(delivery.at || this.visualAudit?.lastDeliveryAt || 0),
      lastDeliverySent: Number(delivery.sent ?? this.visualAudit?.lastDeliverySent ?? 0) || 0,
      lastDeliveryAccepted: Number(delivery.accepted ?? this.visualAudit?.lastDeliveryAccepted ?? 0) || 0,
      lastDeliveryObserved: Number(delivery.observed ?? this.visualAudit?.lastDeliveryObserved ?? 0) || 0,
      lastDeliveryKind: delivery.kind || delivery.lastKind || this.visualAudit?.lastDeliveryKind || "",
      recent: recent.length ? recent : this.visualAudit?.recent || [],
      lastScreenshotAt: this.visualAudit?.lastScreenshotAt || 0,
      lastScreenshotNote: this.visualAudit?.lastScreenshotNote || "",
    };

    if (now - Number(this.lastVisualAuditPersistAt || 0) >= 60000) {
      try {
        this.eventStore?.append("audit", {
          roomId: this.roomInfo?.roomId || 0,
          payload: {
            command: "VISIBLE_AUDIT_HEARTBEAT",
            ...this.visualAudit,
          },
        });
        this.lastVisualAuditPersistAt = now;
      } catch (error) {
        this.log("网页核对写入失败", error.message, { level: "warn" });
      }
    }
    if (now - Number(this.lastVisualAuditSnapshotAt || 0) >= 1500) {
      this.lastVisualAuditSnapshotAt = now;
      this.emitSnapshot();
    }
    return {
      ok: true,
      kind: "audit",
      active: true,
      summary: this.getVisualAuditSummary(),
    };
  }

  ingestVisibleParsed(parsed = {}, input = {}) {
    this.ensureVisibleEngines();
    if (!parsed.text) {
      return { ok: false, reason: "没有可解析的可见弹幕文本" };
    }
    const userName = parsed.userName || "网页可见用户";
    const rawVisibleText = String(parsed.text || "").replace(/\s+/g, " ").trim();
    const escapedUserName = String(userName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const visiblePrefixMatch = rawVisibleText.match(
      new RegExp(`${escapedUserName}\\s*[：:]\\s*([\\s\\S]+)$`)
    );
    const visibleText = String(visiblePrefixMatch?.[1] || rawVisibleText).trim();
    const eventId =
      input.id ||
      `${userName}:${visibleText}:${parsed.medalLevel || input.medalLevel || ""}:${Math.floor(
        Number(input.at || Date.now()) / 2000
      )}`;
    const event = {
      command: "VISIBLE_CHAT_BRIDGE",
      text: visibleText,
      userName,
      displayUserName: userName,
      isMaskedName: false,
      identityResolved: true,
      isSimulated: Boolean(input.isSimulated),
      userId: input.userId || input.uid || 0,
      medalName: input.medalName || parsed.medalName || "",
      medalLevel: Number(input.medalLevel || parsed.medalLevel || 0),
      medalColors: input.medalColors || null,
      guardLevel: Number(input.guardLevel || 0),
      guardName: input.guardName || "",
      guardIcon: input.guardIcon || "",
      avatarFrame: input.avatarFrame || null,
      avatarFrameUrl: input.avatarFrameUrl || input.avatarFrame?.url || "",
      avatarFrameName: input.avatarFrameName || input.avatarFrame?.name || "",
      wealthLevel: Number(input.wealthLevel || 0),
      face: input.face || "",
      nameCandidates: Array.isArray(input.nameCandidates) ? input.nameCandidates : [],
      source: "visible_bridge",
      roomId: Number(input.roomId || input.room_id || 0) || 0,
      raw: {
        cmd: "VISIBLE_CHAT_BRIDGE",
        msg_id: eventId,
        data: {
          trace_id: eventId,
          line: parsed.line,
          url: input.url || "",
          room_id: Number(input.roomId || input.room_id || 0) || 0,
          batch_index: input.batchIndex,
        },
      },
    };
    Object.assign(event, this.applyVisibleIdentityHint(event));

    if (event.isSimulated) {
      const visibleKind = String(input.kind || parsed.kind || "").toLowerCase();
      const fallbackGift = parseGiftTextFallback(event.text);
      const giftName = firstString(input.giftName, parsed.giftName, fallbackGift?.giftName);
      const count = Math.max(1, Number(input.count || parsed.count || fallbackGift?.count || 1));
      const kind =
        visibleKind === "pk" && (input.pk || parsed.pk)
          ? "pk"
          : visibleKind === "gift" || giftName || fallbackGift
            ? "gift"
            : "chat";
      return {
        ok: true,
        skipped: true,
        simulated: true,
        kind,
        reason: "模拟可见事件未入库",
        event: compactEvent({
          ...event,
          command: kind === "gift" ? "VISIBLE_GIFT_BRIDGE" : kind === "pk" ? "VISIBLE_PK_BRIDGE" : event.command,
          giftName: kind === "gift" ? giftName : "",
          count: kind === "gift" ? count : 0,
        }),
      };
    }

    if (!this.shouldProcessHighEvent("visible", event)) {
      if (this.visualAudit) this.visualAudit.duplicateCount += 1;
      return { ok: true, skipped: true, reason: "重复可见事件" };
    }

    if (String(input.kind || parsed.kind || "").toLowerCase() === "pk" && (input.pk || parsed.pk)) {
      const pkEvent = {
        ...event,
        command: "VISIBLE_PK_BRIDGE",
        eventKind: "visible_pk",
        pk: input.pk || parsed.pk,
      };
      this.counts.pk += 1;
      if (this.visualAudit) this.visualAudit.acceptedPk += 1;
      this.recordEvent("pk", pkEvent);
      this.log("网页PK", pkEvent.text, { kind: "pk", event: pkEvent });
      this.emitSnapshot();
      return { ok: true, kind: "pk", event: compactEvent(pkEvent) };
    }

    const visibleGiftEvent = this.handleVisibleStructuredGift(event, parsed, input);
    if (visibleGiftEvent) {
      return { ok: true, kind: "gift", event: compactEvent(visibleGiftEvent) };
    }

    const giftEvent = this.handleGiftTextFallback(event);
    if (giftEvent) {
      return { ok: true, kind: "gift", event: compactEvent(giftEvent) };
    }

    if (!this.shouldProcessCrossSourceChat(event, "visible_bridge")) {
      return { ok: true, skipped: true, reason: "跨来源重复弹幕" };
    }

    const chatResult = this.handleIncomingChat(event);
    // 机器人自身弹幕被跳过时不算“已接收”，避免网页核对口径虚高
    if (this.visualAudit && !chatResult?.skippedAutomation) {
      this.visualAudit.acceptedChat += 1;
    }
    this.emitSnapshot();
    return {
      ok: true,
      kind: "chat",
      skippedAutomation: Boolean(chatResult?.skippedAutomation),
      reason: chatResult?.reason || "",
      event: compactEvent(event),
    };
  }

  setModule(name, enabled, options = {}) {
    if (!name) return this.moduleStatus;
    const nextEnabled = Boolean(enabled);
    this.moduleStatus[name] = {
      ...(this.moduleStatus[name] || {}),
      enabled: nextEnabled,
    };
    this.config.modules = {
      ...(this.config.modules || {}),
      [name]: {
        ...(this.config.modules?.[name] || {}),
        enabled: nextEnabled,
      },
    };
    if (name === "ai" || name === "rotation") {
      if (this.running && this.isModuleEnabled("ai") && this.isModuleEnabled("rotation")) {
        this.startProactiveAiScheduler();
      } else {
        this.stopProactiveAiScheduler();
      }
    }
    if (!options.silent) {
      this.log("模块", `${name} 已${nextEnabled ? "开启" : "关闭"}`);
    }
    this.persistSnapshots(true);
    this.emitSnapshot();
    return this.moduleStatus;
  }

  applyModuleUpdates(updates = []) {
    for (const update of updates || []) {
      this.setModule(update.name, update.enabled, { silent: true });
      this.log("模块命令", `${update.label || update.name} 已${update.enabled ? "开启" : "关闭"}`);
    }
  }

  handleIncomingChat(event = {}, client = null) {
    if (client) attachSourceClient(event, client);
    this.rememberUserVisualHint(event, "chat_raw");
    Object.assign(event, this.enrichUserVisual(event));
    const ownBotEvent = this.isOwnBotEvent(event);
    if (ownBotEvent) {
      event.isOwnBot = true;
      event.source = event.source || "bili_own_chat";
    }
    this.counts.chat += 1;
    this.recordEvent("chat", event);
    this.log("弹幕", `${shownEventName(event)}: ${event.text}`, {
      kind: "chat",
      event,
    });
    if (ownBotEvent) {
      return {
        ok: true,
        recorded: true,
        skippedAutomation: true,
        reason: "own_bot_chat",
      };
    }
    this.rememberLocalAiChat(event);
    this.lastViewerChatAt = Date.now();
    this.cancelWelcomeIdleReminders(event);
    this.shareIdentityHintsFromChat(event.text);
    this.handleInboundModerationHint(event);
    this.handleAssistantGiftText(event);
    this.handleGiftTextFallback(event);
    if (!isAssistantLikeName(event.userName) && !isAssistantLikeName(event.displayUserName)) {
      const commandResult = this.commandEngine.handleChat(event, this.createCommandContext());
      this.applyModuleUpdates(commandResult.moduleUpdates);
      if (commandResult.handled) {
        this.handleActions(this.attachMentionMetadata(commandResult.actions, event), event);
      } else {
        const mentionAction = this.createMentionAiAction(event);
        if (mentionAction) this.handleActions([mentionAction], event);
        else if (this.config.localAi?.allViewerChats === true && this.isModuleEnabled("ai")) {
          const viewerAction = this.createViewerAiAction(event);
          if (viewerAction) this.handleActions([viewerAction], event);
        } else {
          const ruleActions = this.rules.handleChat(event);
          if (ruleActions.length) this.handleRuleActions(ruleActions, event);
          else {
            const viewerAction = this.createViewerAiAction(event);
            if (viewerAction) this.handleActions([viewerAction], event);
          }
        }
      }
    }
    return {
      ok: true,
      recorded: true,
      skippedAutomation: false,
    };
  }

  recordEvent(kind, event = {}) {
    if (!shouldPersistKind(this.config, kind) || !this.eventStore) return null;
    try {
      const entry = this.eventStore.append(kind, {
        roomId: this.roomInfo?.roomId || event.roomId || 0,
        payload: compactEvent(event),
      });
      if (kind === "pk") this.persistSnapshots();
      // 历史摘要走定时缓存，普通事件不再逐条打穿缓存去全量重读文件
      return entry;
    } catch (error) {
      this.log("历史写入失败", error.message, { level: "warn" });
      return null;
    }
  }

  trackRawCommand(command = "") {
    const name = String(command || "UNKNOWN");
    incrementMap(this.commandStats, name);
    const count = this.commandStats.get(name) || 0;
    this.lastRawAt = Date.now();
    this.lastRawCommand = name;
    this.recentCommands.unshift({
      at: this.lastRawAt,
      command: name,
      count,
    });
    if (this.recentCommands.length > 40) this.recentCommands.length = 40;
  }

  trackFilteredRawCommand(command = "") {
    incrementMap(this.filteredRawStats, command || "UNKNOWN");
  }

  auditRaw(command = "", message = {}) {
    if (this.config.history?.enabled === false || this.config.history?.rawAudit?.enabled === false) {
      return;
    }
    try {
      this.eventStore.appendRaw({
        roomId: this.roomInfo?.roomId || message?.data?.room_id || 0,
        command,
        message,
      });
      this.rawAuditCount += 1;
    } catch (error) {
      if (!this.lastRawAuditError || Date.now() - this.lastRawAuditError > 30000) {
        this.lastRawAuditError = Date.now();
        this.log("原始记录失败", error.message, { level: "warn" });
      }
    }
  }

  markGiftEvent(command = "") {
    const name = String(command || "");
    if (name === "COMBO_SEND" || name === "GIFT_COMBO") this.giftEventStats.comboSend += 1;
    else if (name === "DANMU_GIFT_FALLBACK") this.giftEventStats.fallback += 1;
    else if (name === "VISIBLE_GIFT_BRIDGE") this.giftEventStats.visibleBridge += 1;
    else if (name === "ASSISTANT_GIFT_TEXT") this.giftEventStats.assistantText += 1;
    else if (/NOTICE.*GIFT/.test(name)) this.giftEventStats.noticeGift += 1;
    else if (/SUPER_CHAT/.test(name)) this.giftEventStats.superChat += 1;
    else if (/GUARD|TOAST/.test(name)) this.giftEventStats.guard += 1;
    else if (/RED_POCKET/.test(name)) this.giftEventStats.fallback += 1;
    else if (/GIFT/.test(name)) this.giftEventStats.sendGift += 1;
    this.giftEventStats.lastGiftAt = Date.now();
    this.giftEventStats.lastGiftCommand = name;
  }

  recordGiftIfNeeded(sourceEvent = {}) {
    const row = this.interactions?.lastGiftRecord;
    if (!row || this.config.history?.enabled === false || !this.eventStore) return;
    if (row.isSimulated || sourceEvent.isSimulated || row.source === "simulation") return;
    // 连击会以同一 id 递增 count/totalCoin，把状态并入去重键：状态没变化的重复触发不再重复落盘
    const rowKey = `${row.id || row.dedupeKey || row.batchKey || ""}:${Number(row.count || 1)}:${Number(row.totalCoin || 0)}`;
    if (this.persistedGiftIds.has(rowKey)) return;
    this.persistedGiftIds.add(rowKey);
    while (this.persistedGiftIds.size > PERSISTED_GIFT_ID_LIMIT) {
      this.persistedGiftIds.delete(this.persistedGiftIds.values().next().value);
    }
    try {
      this.eventStore.append("gift", {
        roomId: this.roomInfo?.roomId || sourceEvent.roomId || 0,
        payload: {
          ...row,
          sourceCommand: sourceEvent.command || row.source || "",
        },
      });
      this.lastHistorySummaryAt = 0;
      this.lastGiftStatsSnapshotAt = 0;
      this.persistSnapshots();
    } catch (error) {
      this.log("礼物历史失败", error.message, { level: "warn" });
    }
  }

  recordUnverifiedGiftEvent(giftEvent = {}) {
    // 补记只留档供人工核对与 audit 门槛统计，绝不进入礼物统计口径
    if (this.config.history?.enabled === false || !this.eventStore) return;
    if (giftEvent.isSimulated || giftEvent.source === "simulation") return;
    const rowId = String(
      giftEvent.dedupeKey ||
        giftEvent.raw?.msg_id ||
        `${giftEvent.source || "unverified"}:${giftEvent.userId || giftEvent.userName || ""}:${giftEvent.giftName || ""}:${giftEvent.count || 1}:${Date.now()}`
    );
    if (this.persistedGiftIds.has(rowId)) return;
    this.persistedGiftIds.add(rowId);
    while (this.persistedGiftIds.size > PERSISTED_GIFT_ID_LIMIT) {
      this.persistedGiftIds.delete(this.persistedGiftIds.values().next().value);
    }
    try {
      this.eventStore.append("gift", {
        roomId: this.roomInfo?.roomId || giftEvent.roomId || 0,
        payload: {
          ...compactEvent(giftEvent),
          id: rowId,
          needsVisualCheck: true,
          sourceCommand: giftEvent.command || giftEvent.source || "",
        },
      });
    } catch (error) {
      this.log("礼物历史失败", error.message, { level: "warn" });
    }
  }

  isUnverifiedGiftRow(row = {}) {
    return row.needsVisualCheck === true || String(row.source || "") === "danmu_gift_fallback";
  }

  queryTrustedGiftRows(options = {}) {
    if (!this.eventStore || typeof this.eventStore.queryGiftRows !== "function") return [];
    // needsVisualCheck 补记与弹幕兜底记录只留档供人工核对，不进统计口径
    return this.eventStore.queryGiftRows(options).filter((row) => !this.isUnverifiedGiftRow(row));
  }

  seedGiftStatsFromHistory(roomId = this.roomInfo?.roomId) {
    if (this.config.history?.enabled === false || !this.eventStore || !this.interactions) return;
    const targetRoomId = Number(roomId || 0);
    if (!targetRoomId || this.seededGiftStatsRoomId === targetRoomId) return;
    const restoreOnStart =
      this.config.history?.restoreGiftStatsOnStart === true ||
      this.config.history?.giftStatsRestoreMode === "today";
    if (!restoreOnStart) {
      this.seededGiftStatsRoomId = targetRoomId;
      return;
    }
    try {
      const queryRows = typeof this.eventStore.queryGiftRows === "function"
        ? this.eventStore.queryGiftRows({ range: "today", roomId: targetRoomId })
        : this.eventStore.queryGifts({ range: "today", roomId: targetRoomId }).giftFeed || [];
      const gifts = queryRows
        .filter(
          (gift) =>
            // 弹幕兜底与 needsVisualCheck 补记可被观众伪造，不允许跨重启恢复进统计
            [
              "gift_packet",
              "visible_gift_bridge",
              "assistant_text",
              "red_pocket",
              "notice_gift",
              "manual_verified",
            ].includes(gift.source) &&
            !gift.isSimulated &&
            !this.isUnverifiedGiftRow(gift)
        )
        .sort((left, right) => Number(left.at || 0) - Number(right.at || 0));
      for (const gift of gifts) {
        this.rememberUserVisualHint(gift, "history_gift");
        const enrichedGift = this.enrichGiftHistoryRow({
          ...gift,
          dedupeKey: gift.batchKey || gift.dedupeKey || gift.id || "",
          source: gift.source || "gift_packet",
        });
        this.interactions.handleGift(enrichedGift);
        this.rememberRecentGiftPacket(enrichedGift);
      }
      if (gifts.length) {
        const restoredGiftCount = gifts.reduce(
          (total, gift) => total + Math.max(1, Number(gift.count || 1)),
          0
        );
        const restoredGiftCoin = gifts.reduce((total, gift) => total + Number(gift.totalCoin || 0), 0);
        this.giftEventStats.historyRestored += restoredGiftCount;
        this.giftEventStats.historyRestoredTotalCoin += restoredGiftCoin;
        this.giftEventStats.lastGiftAt = Math.max(
          Number(this.giftEventStats.lastGiftAt || 0),
          Number(gifts[gifts.length - 1]?.at || Date.now())
        );
        this.giftEventStats.lastGiftCommand = "HISTORY_RESTORE";
        this.log(
          "历史恢复",
          `已恢复今日真实礼物 ${restoredGiftCount} 件/${gifts.length} 条记录到截图统计`
        );
      }
      this.seededGiftStatsRoomId = targetRoomId;
    } catch (error) {
      this.log("历史恢复失败", error.message, { level: "warn" });
    }
  }

  recordGuardIfNeeded(sourceEvent = {}) {
    const row = this.interactions?.lastGuardRecord;
    // 新舰长事件不管是否落盘（自检/模拟/history 关闭时不落盘），板子缓存都必须失效，
    // 否则 5 秒缓存窗口内的快照拿不到内存里刚记的这一条。
    if (row) this.lastGuardBoardAt = 0;
    if (!row || this.persistedGuardIds.has(row.id) || this.config.history?.enabled === false || !this.eventStore) {
      return;
    }
    if (row.isSimulated || sourceEvent.isSimulated || row.source === "simulation") return;
    this.persistedGuardIds.add(row.id);
    try {
      this.eventStore.append("guard", {
        roomId: this.roomInfo?.roomId || sourceEvent.roomId || 0,
        payload: {
          ...row,
          sourceCommand: sourceEvent.command || "",
        },
      });
      this.lastGuardBoardAt = 0;
      this.persistSnapshots();
    } catch (error) {
      this.log("舰长历史失败", error.message, { level: "warn" });
    }
  }

  captureScreenIfNeeded(kind = "", event = {}) {
    if (!this.screenshotService?.enabled) return;
    this.screenshotStats.attempted += 1;
    this.screenshotService
      .capture(kind, compactEvent(event))
      .then((result) => {
        if (!this.running) return;
        if (result.skipped) {
          this.screenshotStats.skipped += 1;
          this.screenshotStats.lastError = result.reason || "";
          this.emitSnapshot();
          return;
        }
        if (!result.ok) {
          this.screenshotStats.failed += 1;
          this.screenshotStats.lastError = result.reason || result.error || "截图失败";
          this.log("画面留档失败", this.screenshotStats.lastError, { level: "warn" });
          this.emitSnapshot();
          return;
        }
        this.screenshotStats.saved += result.files?.length || 0;
        this.screenshotStats.lastAt = result.at || Date.now();
        this.screenshotStats.lastKind = kind;
        this.screenshotStats.lastFiles = (result.files || []).map((file) => file.filePath);
        this.screenshotStats.lastError = "";
        this.log(
          "画面留档",
          `${kind} 已保存 ${result.files?.length || 0} 张截图`,
          { kind: "system" }
        );
        this.emitSnapshot();
      })
      .catch((error) => {
        this.screenshotStats.failed += 1;
        this.screenshotStats.lastError = error.message || String(error);
        this.log("画面留档失败", this.screenshotStats.lastError, { level: "warn" });
        this.emitSnapshot();
      });
  }

  async captureScreenForTest(kind = "manual") {
    if (!this.screenshotService) {
      this.screenshotService = new ScreenshotService(this.config, this.eventStore);
    }
    this.screenshotStats.attempted += 1;
    let result;
    try {
      result = await this.screenshotService.capture(kind, {
        command: "MANUAL_SCREENSHOT_TEST",
      });
    } catch (error) {
      result = {
        ok: false,
        skipped: false,
        reason: readableScreenshotError(error),
      };
    }
    if (result.ok) {
      this.screenshotStats.saved += result.files?.length || 0;
      this.screenshotStats.lastAt = result.at || Date.now();
      this.screenshotStats.lastKind = kind;
      this.screenshotStats.lastFiles = (result.files || []).map((file) => file.filePath);
      this.screenshotStats.lastError = "";
      this.log("画面留档", `${kind} 测试截图已保存 ${result.files?.length || 0} 张`);
    } else if (result.skipped) {
      this.screenshotStats.skipped += 1;
      this.screenshotStats.lastError = result.reason || "";
    } else {
      this.screenshotStats.failed += 1;
      this.screenshotStats.lastError = result.reason || result.error || "截图失败";
      this.log("画面留档失败", this.screenshotStats.lastError, { level: "warn" });
    }
    this.emitSnapshot();
    return result;
  }

  rememberRecentGiftPacket(event = {}) {
    const row = this.interactions?.lastGiftRecord;
    if (!row || row.source !== "gift_packet" || row.isSimulated) return;
    const item = {
      at: Date.now(),
      giftName: row.giftName,
      count: Number(row.count || event.count || 1),
      totalCoin: Number(row.totalCoin || event.totalCoin || 0),
      userId: row.userId,
      userName: row.userName,
      displayUserName: row.displayUserName || row.userName,
      face: row.face,
      guardLevel: row.guardLevel,
      guardName: row.guardName,
      guardIcon: row.guardIcon,
      medalName: row.medalName,
      medalLevel: row.medalLevel,
      medalColors: row.medalColors,
      avatarFrame: row.avatarFrame,
      avatarFrameUrl: row.avatarFrameUrl,
      avatarFrameName: row.avatarFrameName,
      wealthLevel: row.wealthLevel,
      giftIcon: row.giftIcon,
      row,
    };
    this.recentGiftPackets.unshift(item);
    const now = Date.now();
    this.recentGiftPackets = this.recentGiftPackets
      .filter((gift) => now - gift.at < 45000)
      .slice(0, 40);
  }

  findRecentGiftPacket(summary = {}) {
    const now = Date.now();
    const giftName = String(summary.giftName || "");
    const count = Number(summary.count || 0);
    const totalCoin = Number(summary.totalCoin || 0);
    const candidates = this.recentGiftPackets.filter((gift) => {
      if (now - gift.at > 45000) return false;
      if (giftName && gift.giftName !== giftName) return false;
      const countMatches =
        !count ||
        Number(gift.count || 0) === count ||
        Math.abs(Number(gift.count || 0) - count) <= 1;
      const coinMatches =
        !totalCoin ||
        Number(gift.totalCoin || 0) === totalCoin ||
        Math.abs(Number(gift.totalCoin || 0) - totalCoin) <= 100;
      return countMatches || coinMatches;
    });
    return (
      candidates.find((gift) => Number(gift.count || 0) === count) ||
      candidates.find((gift) => Number(gift.totalCoin || 0) === totalCoin) ||
      candidates[0] ||
      null
    );
  }

  updateSpecialMode(command, event = {}) {
    const name = String(command || event.command || "");
    const now = Date.now();
    // 普通活动横幅(ACTIVITY_BANNER)不代表抽奖，不应触发 90 秒暂停
    if (
      /LOTTERY|ANCHOR_LOT|RED_POCKET|POPULARITY_RED_POCKET|RAFFLE/.test(
        name
      )
    ) {
      const wasInactive = Number(this.specialModes.lotteryUntil || 0) < now;
      const isEnding = /END|FINISH|AWARD|WINNER|CLOSE|STOP/.test(name) || event.activityStatus === "end";
      this.specialModes.lotteryUntil = now + (isEnding ? 15000 : 90000);
      this.specialModes.lotteryReason =
        event.activityType === "red_pocket" || /RED_POCKET|POPULARITY_RED_POCKET/.test(name)
          ? "红包"
          : "天选/抽奖";
      if (wasInactive) {
        this.log(
          "特殊状态",
          isEnding
            ? "检测到天选/红包结束类事件，短暂暂停欢迎和礼物感谢自动发送"
            : "检测到天选/红包类事件，90秒内暂停欢迎和礼物感谢自动发送"
        );
      }
    }
  }

  isPausedBySpecialMode(action = {}) {
    if (action.ruleName === "live_status") return "";
    const moduleName = actionModuleName(action);
    const now = Date.now();
    if (
      now < Number(this.specialModes.lotteryUntil || 0) &&
      ((moduleName === "welcome" && this.config.automation?.pauseWelcomeDuringLottery !== false) ||
        (moduleName === "giftThanks" && this.config.automation?.pauseGiftDuringLottery !== false))
    ) {
      return `${this.specialModes.lotteryReason || "天选/红包"}期间暂停`;
    }

    if (
      this.roomInfo &&
      Number(this.roomInfo.liveStatus || 0) === 0 &&
      (moduleName === "welcome" || moduleName === "giftThanks")
    ) {
      return "直播间未开播，暂停欢迎/感谢";
    }

    return "";
  }

  shouldAutoSend(action = {}) {
    const automation = this.config.automation || {};
    if (!this.running) return { ok: false, reason: "监听已停止" };
    if (automation.enabled === false) return { ok: false, reason: "自动托管总开关关闭" };
    if (!this.isModuleEnabled("autoSend")) return { ok: false, reason: "自动发送模块关闭" };
    if (this.dryRun) return { ok: false, reason: "dry-run 模式禁止真实发送" };
    if (!this.sendToBili) return { ok: false, reason: "B站发送未开启" };
    if (this.browserAuto) {
      if (!this.isBrowserControlReady()) {
        return { ok: false, reason: "浏览器尚未登录或未准备就绪" };
      }
    } else if (!this.biliCookie) {
      return { ok: false, reason: "缺少B站登录Cookie" };
    }
    if (!this.roomInfo?.roomId) return { ok: false, reason: "还没有房间号" };
    if (!this.activeOutboundLiveEligible(action)) {
      return { ok: false, reason: "直播间未开播，主动发言等待开播" };
    }

    const allowedTypes = new Set(
      automation.autoSendTypes || [
        "reply",
        "command_reply",
        "gift_report",
        "pk_report",
        "pk_multi_report",
        "pk_info",
        "timer",
        "spam",
      ]
    );
    const pkAllowed =
      String(action.type || "").startsWith("pk_") &&
      (allowedTypes.has("pk_report") || allowedTypes.has("pk_info"));
    if (!allowedTypes.has(action.type) && !pkAllowed) {
      return { ok: false, reason: `类型 ${action.type || "unknown"} 未允许自动发送` };
    }

    const moduleName = actionModuleName(action);
    if (moduleName && !this.isModuleEnabled(moduleName)) {
      return { ok: false, reason: `${moduleName} 模块关闭` };
    }

    const paused = this.isPausedBySpecialMode(action);
    if (paused) return { ok: false, reason: paused };
    const finalText = compressBiliText(action?.reply, this.biliMaxChars);
    if (!finalText) {
      return { ok: false, reason: "发送内容为空" };
    }
    const finalAction = { ...action, reply: finalText };
    const blocked = this.moderateOutbound(finalAction);
    if (blocked) return { ok: false, reason: blocked };
    return { ok: true, reason: "" };
  }

  moderateOutbound(action = {}) {
    const reply = String(action.reply || "").trim();
    if (!reply) return "";
    if (this.rules?.isBlocked?.(reply)) return "出站内容命中黑名单";
    const normalized = normalizeText(reply);
    const terms = Array.isArray(this.rules?.blocklist)
      ? this.rules.blocklist
      : Array.isArray(this.config.blocklist)
        ? this.config.blocklist.map(normalizeText).filter(Boolean)
        : [];
    if (terms.some((term) => term && normalized.includes(term))) {
      return "出站内容命中黑名单";
    }
    if (this.isLocalAiOutboundAction(action)) {
      const blockedTerm = this.findLocalAiBlockedTerm(reply);
      if (blockedTerm) return `AI出站内容命中公屏禁词“${blockedTerm}”`;
    }
    return "";
  }

  handleInboundModerationHint(event = {}) {
    const text = String(event.text || "");
    if (!text.trim()) return;
    const moderation = this.config.interactions?.moderation || {};
    if (moderation.keywordAlert === false) return;
    const terms = [
      ...(Array.isArray(moderation.keywords) ? moderation.keywords : []),
      ...(Array.isArray(this.config.blocklist) ? this.config.blocklist : []),
    ]
      .map(normalizeText)
      .filter(Boolean);
    if (!terms.length) return;
    const normalized = normalizeText(text);
    const hit = terms.find((term) => term && normalized.includes(term));
    if (!hit) return;
    const name = shownEventName(event);
    const item = {
      command: "LOCAL_KEYWORD_ALERT",
      eventKind: "moderation_keyword",
      userName: event.displayUserName || event.userName || "",
      userId: event.userId || 0,
      text,
      hit,
      at: Date.now(),
    };
    this.moderationEvents.unshift(item);
    if (this.moderationEvents.length > 20) this.moderationEvents.length = 20;
    const template = firstString(
      moderation.keywordAlertTemplate,
      "{user} 的弹幕命中巡场词，建议房管确认。"
    );
    const message = template
      .replaceAll("{user}", name || "这位观众")
      .replaceAll("{message}", text)
      .replaceAll("{keyword}", hit);
    this.log("巡场提醒", message, {
      level: "warn",
      kind: "event",
      event: item,
    });
  }

  rememberSentText(text = "") {
    const value = normalizeText(text);
    if (!value) return;
    const now = Date.now();
    this.recentSentTexts.unshift({ text: value, at: now });
    this.recentSentTexts = this.recentSentTexts
      .filter((item) => now - Number(item.at || 0) < 30000)
      .slice(0, 30);
  }

  isLocalAiOutboundAction(action = {}) {
    return Boolean(
      action.ruleName === "ai" ||
        action.metadata?.localAi === true ||
        action.metadata?.proactiveAi === true
    );
  }

  rememberSuccessfulAiOutput(action = {}, sentText = "", now = Date.now()) {
    if (!this.isLocalAiOutboundAction(action)) return false;
    const text = compactLocalAiText(sentText, this.biliMaxChars || 40);
    if (!text) return false;
    const proactive = action.metadata?.proactiveAi === true;
    this.recentSuccessfulAiOutputs.unshift({ text, proactive, at: Number(now) });
    this.recentSuccessfulAiOutputs = this.recentSuccessfulAiOutputs
      .filter((item) => Number(now) - Number(item.at || 0) <= LOCAL_AI_MEMORY_TTL_MS)
      .slice(0, 20);
    if (proactive) {
      this.proactiveAiLastAt = Number(now);
      this.proactiveAiLastReply = text;
    }
    return true;
  }

  isOwnBotEvent(event = {}) {
    const userId = Number(event.userId || event.uid || 0);
    if (this.biliUid && userId && Number(this.biliUid) === userId) return true;
    const name = normalizeText(event.userName || event.displayUserName || "");
    if (this.biliAccountName && name && name === normalizeText(this.biliAccountName)) return true;
    const configuredBotNames = arrayValue(this.config.roles?.botNames)
      .map((item) => normalizeText(item))
      .filter(Boolean);
    if (name && configuredBotNames.includes(name)) return true;
    const text = normalizeText(event.text || "");
    if (text) {
      // 网页桥回显可能带前缀，允许 endsWith；WS 通道观众复读机器人的话不能被误吞，只认完全相等
      const fromVisibleBridge =
        String(event.source || "").startsWith("visible") ||
        String(event.command || "") === "VISIBLE_CHAT_BRIDGE";
      const now = Date.now();
      const echoed = this.recentSentTexts.some((item) => {
        if (now - Number(item.at || 0) >= 30000) return false;
        if (item.text === text) return true;
        return (
          fromVisibleBridge &&
          Array.from(item.text).length >= 6 &&
          text.endsWith(item.text)
        );
      });
      if (echoed) return true;
    }
    return false;
  }

  queueAction(action = {}, event = {}) {
    const decision = this.shouldAutoSend(action);
    const queuedAt = Date.now();
    const randomDelayMs = decision.ok ? this.randomActionDelayMs(action) : 0;
    const item = {
      id: action.id || createId(),
      at: queuedAt,
      notBeforeAt: queuedAt + randomDelayMs,
      randomDelayMs,
      type: action.type || "reply",
      ruleName: action.ruleName || "",
      reply: action.reply || "",
      priority: Number(action.priority || 0),
      status: decision.ok ? "pending" : "blocked",
      reason: decision.reason,
      sourceUser: event?.displayUserName || event?.userName || "",
      sourceText: event?.text || "",
      action,
    };
    this.autoSendQueue.unshift(item);
    const limit = Number(this.config.automation?.queueLimit || 80);
    if (this.autoSendQueue.length > limit) {
      const removed = this.autoSendQueue.splice(limit);
      for (const dropped of removed) this.discardPendingLocalAiTurn(dropped.id);
    }
    this.persistSnapshots();
    if (decision.ok) this.drainAutoSendQueue();
    return item;
  }

  updateQueueItem(id, patch = {}) {
    if (!id) return;
    const item = this.autoSendQueue.find((entry) => entry.id === id);
    if (!item) return;
    Object.assign(item, patch);
    // cooldown/pending/sending 这类中间态只发轻量队列事件；终态才写快照与全量 snapshot
    const status = String(patch.status || "");
    if (status === "sent" || status === "failed" || status === "blocked" || status === "cancelled") {
      this.persistSnapshots();
      this.emitSnapshot();
    } else {
      this.emit("queue", this.getQueueSnapshot());
    }
  }

  nextPendingQueueItem() {
    return this.autoSendQueue
      .filter((item) => item.status === "pending")
      .sort((left, right) => right.priority - left.priority || left.at - right.at)[0];
  }

  async drainAutoSendQueue() {
    if (this.autoSendInFlight) return;
    const generation = this.autoSendGeneration;
    this.autoSendInFlight = true;
    try {
      let item = this.nextPendingQueueItem();
      while (item) {
        if (generation !== this.autoSendGeneration || !this.running) return;
        const freshDecision = this.shouldAutoSend(item.action);
        if (!freshDecision.ok) {
          this.discardPendingLocalAiTurn(item.id);
          this.updateQueueItem(item.id, {
            status: "blocked",
            reason: freshDecision.reason,
            handledAt: Date.now(),
          });
          item = this.nextPendingQueueItem();
          continue;
        }

        let waitMs = Math.max(
          0,
          Number(item.notBeforeAt || 0) - Date.now(),
          Number(this.nextBiliSendAt || 0) - Date.now()
        );
        while (waitMs > 0) {
          this.updateQueueItem(item.id, {
            status: "cooldown",
            reason: `随机等待 ${Math.ceil(waitMs / 1000)} 秒`,
          });
          await delay(waitMs);
          if (generation !== this.autoSendGeneration || !this.running) return;
          // 睡眠期间手动发送可能把冷却推后，醒来后重算并继续等到冷却真正结束
          waitMs = Math.max(
            0,
            Number(item.notBeforeAt || 0) - Date.now(),
            Number(this.nextBiliSendAt || 0) - Date.now()
          );
        }
        if (item.status === "cooldown") {
          this.updateQueueItem(item.id, { status: "pending", reason: "" });
        }

        const finalDecision = this.shouldAutoSend(item.action);
        if (!finalDecision.ok) {
          this.discardPendingLocalAiTurn(item.id);
          this.updateQueueItem(item.id, {
            status: "blocked",
            reason: finalDecision.reason,
            handledAt: Date.now(),
          });
          item = this.nextPendingQueueItem();
          continue;
        }

        this.updateQueueItem(item.id, { status: "sending", reason: "发送中" });
        const result = await this.sendActionToBili(item.action, { ignoreCooldown: true });
        if (generation !== this.autoSendGeneration || !this.running) return;
        this.updateQueueItem(item.id, {
          status: result.ok ? "sent" : "failed",
          reason: result.ok ? "已发送" : result.error || "发送失败",
          handledAt: Date.now(),
          sentText: result.sentText || "",
        });
        if (result.ok) {
          const sentText = result.sentText || item.action.reply;
          this.commitPendingLocalAiTurn(item.id, sentText);
          this.rememberSuccessfulAiOutput(item.action, sentText);
        } else {
          this.discardPendingLocalAiTurn(item.id);
        }
        item = this.nextPendingQueueItem();
      }
    } finally {
      if (generation === this.autoSendGeneration) {
        this.autoSendInFlight = false;
        this.emitSnapshot();
      }
    }
  }

  persistSnapshots(force = false) {
    if (this.config.history?.enabled === false || !this.eventStore) return;
    const now = Date.now();
    if (!force && now - this.lastSnapshotPersistAt < 5000) return;
    this.lastSnapshotPersistAt = now;
    try {
      this.eventStore.writeSnapshot("giftHistorySummary", {
        giftHistorySummary: this.getHistorySummary(true),
      });
      this.eventStore.writeSnapshot("pkInvestigation", {
        pkInvestigation: this.pkTracker?.getSnapshot() || null,
      });
      this.eventStore.writeSnapshot("guardBoard", {
        guardBoard: this.getGuardBoard(),
      });
      this.eventStore.writeSnapshot("autoSendQueue", {
        autoSendQueue: this.getQueueSnapshot(),
      });
      this.eventStore.writeSnapshot("moduleStatus", {
        moduleStatus: this.moduleStatus,
      });
    } catch (error) {
      this.log("快照写入失败", error.message, { level: "warn" });
    }
  }

  handleRuleActions(actions, event) {
    for (const action of actions) {
      if (action.type === "gift_report") {
        this.handleAction(this.createGiftReportAction(action.metadata || action), event);
      } else if (action.type === "pk_report") {
        this.handleAction(this.pkTracker.createReportAction(), event);
      } else {
        this.handleAction(action, event);
      }
    }
  }

  pruneSeenMaps(now = Date.now()) {
    // 两个表按插入序时间递增，从头删到第一个未过期项即可停，避免每条 raw 全表遍历
    for (const [key, at] of this.seenRawEvents) {
      if (now - at <= 120000) break;
      this.seenRawEvents.delete(key);
    }
    for (const [key, at] of this.seenHighEvents) {
      if (now - at <= 120000) break;
      this.seenHighEvents.delete(key);
    }
  }

  shouldProcessRaw(command, message) {
    const now = Date.now();
    this.pruneSeenMaps(now);
    const key = `${command}:${rawMessageKey(command, message)}`;
    if (this.seenRawEvents.has(key)) return false;
    this.seenRawEvents.set(key, now);
    return true;
  }

  shouldProcessHighEvent(type, event) {
    const now = Date.now();
    this.pruneSeenMaps(now);
    const key = eventMessageKey(type, event);
    if (this.seenHighEvents.has(key)) return false;
    this.seenHighEvents.set(key, now);
    return true;
  }

  shouldProcessCrossSourceChat(event = {}, source = "") {
    const text = normalizeText(event.text || "");
    if (!text) return true;
    const sourceKey = String(source || "").trim().toLowerCase();
    if (!sourceKey) return true;
    const now = Date.now();
    this.recentCrossSourceChats = (this.recentCrossSourceChats || []).filter(
      (item) => now - Number(item.at || 0) <= CROSS_SOURCE_CHAT_DEDUPE_MS
    );
    const identity = {
      userId: Number(event.userId || event.uid || 0),
      names: chatDedupeNames(event),
    };
    // 双方 uid 都为 0 且昵称都被占位名过滤空时，身份无从比对，退化为按文本+时间窗判重
    const selfAnonymous = !identity.userId && !identity.names.length;
    const duplicate = this.recentCrossSourceChats.some((item) => {
      if (item.source === sourceKey || item.text !== text) return false;
      const itemAnonymous = !Number(item.userId || 0) && !(item.names || []).length;
      if (itemAnonymous && selfAnonymous) return true;
      return chatDedupeIdentityMatches(item, identity);
    });
    if (duplicate) {
      if (this.visualAudit) this.visualAudit.duplicateCount += 1;
      return false;
    }
    this.recentCrossSourceChats.unshift({
      source: sourceKey,
      text,
      userId: identity.userId,
      names: identity.names,
      at: now,
    });
    if (this.recentCrossSourceChats.length > CROSS_SOURCE_CHAT_DEDUPE_LIMIT) {
      this.recentCrossSourceChats.length = CROSS_SOURCE_CHAT_DEDUPE_LIMIT;
    }
    return true;
  }

  shareIdentityHintsFromChat(text) {
    if (!text) return;
    for (const client of this.clients) {
      if (typeof client.learnIdentityFromWelcomeText === "function") {
        client.learnIdentityFromWelcomeText(text);
      }
    }
  }

  shareMaskedEntry(event) {
    if (!event?.isMaskedName || !event.face) return;
    for (const client of this.clients) {
      if (client === event._sourceClient) continue;
      if (typeof client.rememberMaskedEntry === "function") {
        client.rememberMaskedEntry({
          userName: event.userName,
          face: event.face,
          roomId: event.roomId,
        });
      }
    }
  }

  resolveIdentityAcrossClients(event) {
    const params = {
      uid: event.userId,
      face: event.face,
      userName: event.userName,
    };
    const orderedClients = [
      event._sourceClient,
      this.client,
      ...this.clients,
    ].filter(Boolean);
    let fallback = null;

    for (const client of orderedClients) {
      if (typeof client.resolveIdentity !== "function") continue;
      const resolved = client.resolveIdentity(params);
      if (!fallback) fallback = resolved;
      if (resolved && !resolved.isMaskedName) {
        return resolved;
      }
    }

    return fallback || {};
  }

  clearLocalAiMemory() {
    this.localAiViewerMemory = new Map();
    this.localAiRoomChats = [];
    this.localAiMemorySequence = 0;
    this.localAiContextSnapshots = new WeakMap();
    this.pendingLocalAiTurns = new Map();
    this.localAiNameAliases = new Map();
    this.lastViewerAiAtByKey = new Map();
    this.lastUnkeyedViewerAiAt = 0;
    this.recentSuccessfulAiOutputs = [];
    this.proactiveAiLastAt = 0;
    this.proactiveAiLastReply = "";
  }

  localAiRoomId(event = {}) {
    return Number(
      event.roomId ||
        event.room_id ||
        this.roomInfo?.roomId ||
        this.roomInfo?.room_id ||
        0
    );
  }

  reliableLocalAiViewerName(event = {}) {
    const name = shownEventName(event);
    const normalizedName = normalizeText(name);
    if (
      !normalizedName ||
      localIsMaskedName(name) ||
      isAssistantLikeName(name) ||
      ["网页可见用户", "匿名用户", "新来的朋友"].includes(name)
    ) {
      return "";
    }
    return normalizedName;
  }

  migrateLocalAiViewerBucket(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return;
    const source = this.localAiViewerMemory.get(fromKey);
    if (source) {
      const target = this.localAiViewerMemory.get(toKey) || { lastAt: 0, turns: [] };
      const seen = new Set();
      const turns = [...arrayValue(target.turns), ...arrayValue(source.turns)]
        .sort((left, right) => Number(left.at || 0) - Number(right.at || 0))
        .filter((turn) => {
          const key = String(turn.id || `${turn.chatId}:${turn.userText}:${turn.assistantText}`);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(-LOCAL_AI_VIEWER_TURN_LIMIT);
      this.localAiViewerMemory.set(toKey, {
        turns,
        lastAt: Number(turns[turns.length - 1]?.at || target.lastAt || source.lastAt || 0),
      });
      this.localAiViewerMemory.delete(fromKey);
    }
    if (this.lastViewerAiAtByKey.has(fromKey)) {
      this.lastViewerAiAtByKey.set(
        toKey,
        Math.max(
          Number(this.lastViewerAiAtByKey.get(toKey) || 0),
          Number(this.lastViewerAiAtByKey.get(fromKey) || 0)
        )
      );
      this.lastViewerAiAtByKey.delete(fromKey);
    }
  }

  canonicalLocalAiViewerKey(viewerKey = "") {
    if (!viewerKey || !viewerKey.includes(":name:")) return viewerKey;
    const alias = this.localAiNameAliases.get(viewerKey);
    if (alias?.ambiguous) return "";
    return alias?.uidKey || viewerKey;
  }

  localAiViewerKey(event = {}) {
    const roomId = this.localAiRoomId(event);
    const userId = Number(event.userId || event.uid || 0);
    const normalizedName = this.reliableLocalAiViewerName(event);
    const nameKey = normalizedName ? `room:${roomId}:name:${normalizedName}` : "";
    if (userId > 0) {
      const uidKey = `room:${roomId}:uid:${userId}`;
      if (nameKey) {
        const alias = this.localAiNameAliases.get(nameKey);
        if (!alias) {
          this.localAiNameAliases.set(nameKey, { uidKey, ambiguous: false });
          this.migrateLocalAiViewerBucket(nameKey, uidKey);
        } else if (!alias.ambiguous && alias.uidKey !== uidKey) {
          this.localAiNameAliases.set(nameKey, { uidKey: "", ambiguous: true });
        } else if (!alias.ambiguous && alias.uidKey === uidKey) {
          this.migrateLocalAiViewerBucket(nameKey, uidKey);
        }
      }
      return uidKey;
    }
    if (!nameKey) return "";
    const alias = this.localAiNameAliases.get(nameKey);
    if (alias?.ambiguous) return "";
    return alias?.uidKey || nameKey;
  }

  isEligibleLocalAiViewerChat(event = {}) {
    if (
      !event ||
      event.isOwnBot ||
      event.proactiveAi ||
      event.isSimulated ||
      event.simulated ||
      event.source === "simulation"
    ) {
      return false;
    }
    if (isAssistantLikeName(event.userName) || isAssistantLikeName(event.displayUserName)) {
      return false;
    }
    if (this.isOwnBotEvent(event)) return false;
    return Boolean(compactLocalAiText(event.text));
  }

  pruneLocalAiMemory(now = Date.now()) {
    const cutoff = Number(now) - LOCAL_AI_MEMORY_TTL_MS;
    for (const [viewerKey, at] of this.lastViewerAiAtByKey.entries()) {
      if (Number(at || 0) < cutoff) this.lastViewerAiAtByKey.delete(viewerKey);
    }
    for (const [viewerKey, entry] of this.localAiViewerMemory.entries()) {
      const turns = arrayValue(entry?.turns).filter((turn) => Number(turn.at || 0) >= cutoff);
      if (!turns.length) this.localAiViewerMemory.delete(viewerKey);
      else {
        this.localAiViewerMemory.set(viewerKey, {
          lastAt: Number(turns[turns.length - 1]?.at || entry.lastAt || 0),
          turns: turns.slice(-LOCAL_AI_VIEWER_TURN_LIMIT),
        });
      }
    }
    if (this.localAiViewerMemory.size > LOCAL_AI_VIEWER_LIMIT) {
      const oldest = [...this.localAiViewerMemory.entries()].sort(
        (left, right) => Number(left[1]?.lastAt || 0) - Number(right[1]?.lastAt || 0)
      );
      while (oldest.length > LOCAL_AI_VIEWER_LIMIT) {
        this.localAiViewerMemory.delete(oldest.shift()[0]);
      }
    }
    // 昵称别名表没有时间戳，按插入序保留最近写入的一段
    while (this.localAiNameAliases.size > LOCAL_AI_NAME_ALIAS_LIMIT) {
      this.localAiNameAliases.delete(this.localAiNameAliases.keys().next().value);
    }
    const recentRoomChats = arrayValue(this.localAiRoomChats).filter(
      (item) => Number(item.at || 0) >= cutoff
    );
    const keptByRoom = new Map();
    this.localAiRoomChats = recentRoomChats
      .slice()
      .reverse()
      .filter((item) => {
        const roomId = Number(item.roomId || 0);
        const count = Number(keptByRoom.get(roomId) || 0);
        if (count >= LOCAL_AI_ROOM_CHAT_LIMIT) return false;
        keptByRoom.set(roomId, count + 1);
        return true;
      })
      .reverse();
  }

  rememberLocalAiChat(event = {}, now = Date.now()) {
    if (!this.isEligibleLocalAiViewerChat(event)) return null;
    this.pruneLocalAiMemory(now);
    const record = {
      id: `chat-${++this.localAiMemorySequence}`,
      at: Number(now),
      roomId: this.localAiRoomId(event),
      viewerKey: this.localAiViewerKey(event),
      userName: compactLocalAiText(shownEventName(event), 32),
      text: compactLocalAiText(event.text, LOCAL_AI_ROOM_TEXT_LIMIT),
    };
    this.localAiRoomChats.push(record);
    this.pruneLocalAiMemory(now);
    try {
      Object.defineProperty(event, "_localAiMemoryChatId", {
        value: record.id,
        enumerable: false,
        configurable: true,
      });
    } catch {
      // A frozen test event can still participate without an exclusion id.
    }
    return record;
  }

  appendLocalAiViewerTurn(viewerKey, turn = {}) {
    if (!viewerKey || !turn.userText || !turn.assistantText) return false;
    const entry = this.localAiViewerMemory.get(viewerKey) || { lastAt: 0, turns: [] };
    const nextTurn = {
      id: turn.id || `turn-${++this.localAiMemorySequence}`,
      chatId: String(turn.chatId || ""),
      at: Number(turn.at || Date.now()),
      userText: compactLocalAiText(turn.userText),
      assistantText: compactLocalAiText(turn.assistantText),
    };
    entry.turns = [...arrayValue(entry.turns), nextTurn].slice(-LOCAL_AI_VIEWER_TURN_LIMIT);
    entry.lastAt = nextTurn.at;
    this.localAiViewerMemory.set(viewerKey, entry);
    this.pruneLocalAiMemory(nextTurn.at);
    return true;
  }

  rememberLocalAiDirectReply(event = {}, userText = "", assistantText = "", now = Date.now()) {
    if (!this.isEligibleLocalAiViewerChat(event)) return false;
    return this.appendLocalAiViewerTurn(this.localAiViewerKey(event), {
      chatId: event._localAiMemoryChatId || "",
      at: now,
      userText,
      assistantText,
    });
  }

  captureLocalAiContextSnapshot(event = {}, now = Date.now()) {
    this.pruneLocalAiMemory(now);
    const roomId = this.localAiRoomId(event);
    const viewerKey = this.localAiViewerKey(event);
    const currentChatId = String(event._localAiMemoryChatId || "");
    const sameViewerTurns = arrayValue(this.localAiViewerMemory.get(viewerKey)?.turns).map(
      (turn) => ({ ...turn })
    );
    const personalChatIds = new Set(
      sameViewerTurns.map((turn) => String(turn.chatId || "")).filter(Boolean)
    );
    const recentRoomChats = this.localAiRoomChats
      .filter(
        (chat) =>
          Number(chat.roomId || 0) === roomId &&
          chat.id !== currentChatId &&
          !personalChatIds.has(String(chat.id || ""))
      )
      .map((chat) => ({ ...chat }));
    return {
      capturedAt: Number(now),
      sameViewerTurns,
      recentRoomChats,
    };
  }

  buildLocalAiPromptContext(memorySnapshot = {}, realtimeWeather = null) {
    const context = {
      instruction:
        "只直接回应当前观众这句话。历史仅可用于理解‘这个/那个/继续’等指代，不得覆盖当前问题；不要复读昵称。",
    };
    const weather = compactRealtimeWeatherContext(realtimeWeather);
    if (weather) context.realtimeWeather = weather;
    const conversationMemory = {
      policy: "时间顺序从旧到新；只在当前弹幕有指代或明确承接时使用。",
      sameViewerTurns: [],
      recentRoomChats: [],
    };
    context.conversationMemory = conversationMemory;
    const fits = () => Array.from(JSON.stringify(context)).length <= LOCAL_AI_CONTEXT_CHAR_BUDGET;

    const sameViewerTurns = arrayValue(memorySnapshot.sameViewerTurns);
    for (let index = sameViewerTurns.length - 1; index >= 0; index -= 1) {
      const turn = sameViewerTurns[index] || {};
      conversationMemory.sameViewerTurns.unshift({
        viewer: compactLocalAiText(turn.userText),
        assistant: compactLocalAiText(turn.assistantText),
      });
      if (!fits()) conversationMemory.sameViewerTurns.shift();
    }

    const recentRoomChats = arrayValue(memorySnapshot.recentRoomChats);
    for (let index = recentRoomChats.length - 1; index >= 0; index -= 1) {
      const chat = recentRoomChats[index] || {};
      conversationMemory.recentRoomChats.unshift({
        user: compactLocalAiText(chat.userName, 32),
        text: compactLocalAiText(chat.text, LOCAL_AI_ROOM_TEXT_LIMIT),
      });
      if (!fits()) conversationMemory.recentRoomChats.shift();
    }
    if (!conversationMemory.sameViewerTurns.length && !conversationMemory.recentRoomChats.length) {
      delete context.conversationMemory;
    }
    return context;
  }

  stagePendingLocalAiTurn(actionId, event = {}, userText = "", assistantText = "", generation = 0) {
    if (!actionId || !this.isEligibleLocalAiViewerChat(event)) return false;
    const viewerKey = this.localAiViewerKey(event);
    if (!viewerKey) return false;
    this.pendingLocalAiTurns.set(actionId, {
      viewerKey,
      chatId: String(event._localAiMemoryChatId || ""),
      userText: compactLocalAiText(userText),
      assistantText: compactLocalAiText(assistantText),
      mentionPrefix: compactLocalAiText(`@${shownEventName(event)}`, 40),
      generation: Number(generation),
    });
    return true;
  }

  discardPendingLocalAiTurn(actionId) {
    if (actionId) this.pendingLocalAiTurns.delete(actionId);
  }

  commitPendingLocalAiTurn(actionId, sentText = "", now = Date.now()) {
    const pending = this.pendingLocalAiTurns.get(actionId);
    this.pendingLocalAiTurns.delete(actionId);
    if (!pending || pending.generation !== this.localAiGeneration || !this.running) return false;
    const finalText = compactLocalAiText(sentText);
    const prefix = String(pending.mentionPrefix || "");
    const assistantText = finalText.startsWith(prefix)
      ? finalText.slice(prefix.length).trim()
      : finalText || pending.assistantText;
    return this.appendLocalAiViewerTurn(this.canonicalLocalAiViewerKey(pending.viewerKey), {
      chatId: pending.chatId,
      at: now,
      userText: pending.userText,
      assistantText: assistantText || pending.assistantText,
    });
  }

  getLocalAiMemorySnapshot(now = Date.now()) {
    this.pruneLocalAiMemory(now);
    const turns = [...this.localAiViewerMemory.values()].flatMap((entry) => arrayValue(entry.turns));
    const timestamps = [
      ...turns.map((turn) => Number(turn.at || 0)),
      ...this.localAiRoomChats.map((chat) => Number(chat.at || 0)),
    ].filter((at) => at > 0);
    return {
      windowMinutes: LOCAL_AI_MEMORY_TTL_MS / 60000,
      perViewerTurnLimit: LOCAL_AI_VIEWER_TURN_LIMIT,
      roomChatLimit: LOCAL_AI_ROOM_CHAT_LIMIT,
      contextBudgetChars: LOCAL_AI_CONTEXT_CHAR_BUDGET,
      viewerCount: this.localAiViewerMemory.size,
      turnCount: turns.length,
      roomChatCount: this.localAiRoomChats.length,
      oldestAt: timestamps.length ? Math.min(...timestamps) : 0,
      newestAt: timestamps.length ? Math.max(...timestamps) : 0,
    };
  }

  localAiOutputGateSettings() {
    const section = this.config.localAi?.outputGate || {};
    const numberOption = (value, fallback) => {
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    };
    const blockedTerms = [
      ...DEFAULT_LOCAL_AI_OUTPUT_BLOCKED_TERMS,
      ...arrayValue(section.blockedTerms || section.blocklist),
      ...arrayValue(this.config.blocklist),
    ]
      .map((item) => compactLocalAiText(item, 40))
      .filter((item) => item && normalizeLocalAiOutput(item))
      .filter((item, index, items) => items.indexOf(item) === index);
    return {
      blockedTerms,
      maxRegenerations: Math.min(
        2,
        Math.max(0, Math.floor(numberOption(section.maxRegenerations, 2)))
      ),
      viewerSimilarity: Math.min(
        1,
        Math.max(0.5, numberOption(section.viewerSimilarity, 0.78))
      ),
      alternativeSimilarity: Math.min(
        1,
        Math.max(0.45, numberOption(section.alternativeSimilarity, 0.62))
      ),
      proactiveSimilarity: Math.min(
        1,
        Math.max(0.45, numberOption(section.proactiveSimilarity, 0.68))
      ),
    };
  }

  findLocalAiBlockedTerm(reply = "") {
    const normalized = normalizeLocalAiOutput(reply);
    if (!normalized) return "";
    return (
      this.localAiOutputGateSettings().blockedTerms.find((term) =>
        normalized.includes(normalizeLocalAiOutput(term))
      ) || ""
    );
  }

  evaluateLocalAiOutput(reply = "", options = {}) {
    const text = compactLocalAiText(reply, 500);
    if (!text) return { ok: false, code: "empty", reason: "候选回复为空" };
    const maxChars = Math.max(1, Number(options.maxChars || this.biliMaxChars || 40));
    if (Array.from(text).length > maxChars) {
      return {
        ok: false,
        code: "too_long",
        reason: `候选回复超过 ${maxChars} 字`,
      };
    }
    const settings = this.localAiOutputGateSettings();
    const blockedTerm = this.findLocalAiBlockedTerm(text);
    if (blockedTerm) {
      return {
        ok: false,
        code: "blocked_term",
        reason: `候选回复包含娱乐公屏禁词“${blockedTerm}”`,
      };
    }

    const recentReplies = arrayValue(options.recentReplies).filter(Boolean);
    const threshold = options.proactive
      ? settings.proactiveSimilarity
      : options.alternativeRequested
        ? settings.alternativeSimilarity
        : settings.viewerSimilarity;
    const candidateCategory = localAiClicheCategory(text);
    for (const previous of recentReplies) {
      const similarity = localAiOutputSimilarity(text, previous);
      if (similarity >= threshold) {
        return {
          ok: false,
          code: similarity === 1 ? "exact_repeat" : "similar_repeat",
          reason:
            similarity === 1
              ? "候选回复与最近回复完全重复"
              : `候选回复与最近回复高度相似（${similarity.toFixed(2)}）`,
        };
      }
      if (
        options.proactive &&
        candidateCategory &&
        candidateCategory === localAiClicheCategory(previous)
      ) {
        return {
          ok: false,
          code: "cliche_repeat",
          reason: "候选回复连续使用了‘别安静/一起嗨’类套话",
        };
      }
    }
    return { ok: true, code: "ok", reason: "" };
  }

  localAiRetryGuidance(gate = {}, rejectedReplies = [], options = {}) {
    const rejected = arrayValue(rejectedReplies)
      .slice(-3)
      .map((item) => `“${compactLocalAiText(item, 60)}”`)
      .join("、");
    return [
      `上一个候选未通过发送门禁，原因：${gate.reason || "不适合公屏"}。`,
      rejected ? `不得复用这些候选：${rejected}。` : "",
      options.alternativeRequested
        ? "观众明确要求换一个：必须更换主题、角色和包袱，不能只改前缀或续写上一条；新回复必须独立完整。"
        : "",
      gate.code === "blocked_term"
        ? "彻底避开被拦截词及同类低俗表达，改用健康的娱乐直播内容。"
        : "",
      options.proactive
        ? "不要再说‘安静、一起嗨、直播间老师’等元套话，直接给出笑话、问题或梗本身。"
        : "",
      "请重新直接回答当前弹幕，只输出安全且明显不同的新回复。",
    ]
      .filter(Boolean)
      .join("");
  }

  async generateLocalAiReplyWithGate(input = {}, options = {}) {
    const settings = this.localAiOutputGateSettings();
    const attempts = Math.min(
      LOCAL_AI_OUTPUT_MAX_ATTEMPTS,
      1 + settings.maxRegenerations
    );
    const rejectedReplies = [];
    let lastGate = null;
    const initialGuidance = [
      options.alternativeRequested
        ? "观众明确要求换一个：必须更换主题、角色和包袱，不能只改前缀或续写上一条；回复必须独立完整。"
        : "",
      options.proactive
        ? "直接给出内容本身，不要说‘安静、一起嗨、直播间老师’等元套话。"
        : "",
    ]
      .filter(Boolean)
      .join("");
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let attemptContext = input.context;
      if (
        lastGate &&
        attemptContext &&
        typeof attemptContext === "object" &&
        !Array.isArray(attemptContext) &&
        attemptContext.conversationMemory &&
        typeof attemptContext.conversationMemory === "object"
      ) {
        const memory = attemptContext.conversationMemory;
        const blockedHistory = [
          ...arrayValue(options.recentReplies),
          ...rejectedReplies,
        ].filter(Boolean);
        const sameViewerTurns = arrayValue(memory.sameViewerTurns).filter((turn) => {
          const assistant = String(turn?.assistant ?? turn?.assistantText ?? "").trim();
          if (!assistant) return false;
          if (this.findLocalAiBlockedTerm(assistant)) return false;
          return !blockedHistory.some(
            (previous) =>
              localAiOutputSimilarity(assistant, previous) >=
              (options.alternativeRequested ? 0.45 : 0.78)
          );
        });
        attemptContext = {
          ...attemptContext,
          conversationMemory: {
            ...memory,
            sameViewerTurns,
          },
        };
      }
      const reply = await this.localAiClient.generateReply({
        ...input,
        context: attemptContext,
        ...(lastGate
          ? {
              retryGuidance: this.localAiRetryGuidance(
                lastGate,
                rejectedReplies,
                options
              ),
            }
          : initialGuidance
            ? { retryGuidance: initialGuidance }
            : {}),
      });
      const gate = this.evaluateLocalAiOutput(reply, {
        ...options,
        recentReplies: [...arrayValue(options.recentReplies), ...rejectedReplies],
      });
      if (gate.ok) return { ok: true, reply: String(reply).trim(), attempts: attempt + 1 };
      rejectedReplies.push(String(reply || "").trim());
      lastGate = gate;
      this.log(
        "AI输出门禁",
        `${options.proactive ? "主动话术" : "观众回复"}第 ${attempt + 1} 个候选已拦截：${gate.reason}`,
        { level: "warn" }
      );
    }
    return {
      ok: false,
      reply: "",
      attempts,
      reason: lastGate?.reason || "候选回复未通过发送门禁",
    };
  }

  botMentionInfo(event = {}) {
    const text = String(event.text || "").trim();
    if (!text || !this.isModuleEnabled("ai")) return null;
    const botNames = arrayValue(this.config.roles?.botNames)
      .map((name) => String(name || "").trim())
      .filter(Boolean);
    const matchedBotName = botNames.find((name) => text.includes(`@${name}`));
    if (!matchedBotName) return null;
    let question = text;
    for (const name of botNames) question = question.replaceAll(`@${name}`, " ");
    question = question.replace(/^[\s:：,，]+/, "").replace(/\s+/g, " ").trim();
    const sourceUser = shownEventName(event) || "观众";
    return {
      matchedBotName,
      question: question || "和我打个招呼吧",
      sourceUser,
      prefix: `@${sourceUser}`,
    };
  }

  createMentionAiAction(event = {}) {
    const mention = this.botMentionInfo(event);
    if (!mention) return null;
    return {
      type: "command_reply",
      ruleName: "ai",
      reply: `${mention.prefix} 收到@，你说，我在听～`,
      emotion: "cheerful",
      priority: 180,
      metadata: {
        replyMentionUser: true,
        mentionPrefix: mention.prefix,
        mentionQuestion: mention.question,
      },
    };
  }

  createViewerAiAction(event = {}) {
    const text = String(event.text || "").replace(/\s+/g, " ").trim();
    if (!text || !this.isModuleEnabled("ai")) return null;
    const now = Date.now();
    const viewerKey = this.localAiViewerKey(event);
    const configuredCooldownMs = Math.max(
      0,
      Number(this.config.localAi?.viewerReplyCooldownMs ?? 1500)
    );
    const cooldownMs = viewerKey
      ? configuredCooldownMs
      : Math.max(
          0,
          Number(
            this.config.localAi?.unkeyedViewerReplyCooldownMs ??
              Math.min(500, configuredCooldownMs)
          )
        );
    const lastAt = viewerKey
      ? Number(this.lastViewerAiAtByKey.get(viewerKey) || 0)
      : Number(this.lastUnkeyedViewerAiAt || 0);
    if (cooldownMs && now - lastAt < cooldownMs) return null;
    if (viewerKey) this.lastViewerAiAtByKey.set(viewerKey, now);
    else this.lastUnkeyedViewerAiAt = now;
    const sourceUser = shownEventName(event) || "观众";
    const prefix = `@${sourceUser}`;
    return {
      type: "command_reply",
      ruleName: "ai",
      reply: `${prefix} 收到，陪主播聊起来～`,
      emotion: "cheerful",
      priority: 80,
      metadata: {
        viewerAutoReply: true,
        replyMentionUser: true,
        mentionPrefix: prefix,
        mentionQuestion: text,
      },
    };
  }

  attachMentionMetadata(actions = [], event = {}) {
    const mention = this.botMentionInfo(event);
    if (!mention) return actions;
    return (actions || []).map((action) =>
      action?.ruleName === "ai"
        ? {
            ...action,
            metadata: {
              ...(action.metadata || {}),
              replyMentionUser: true,
              mentionPrefix: mention.prefix,
              mentionQuestion: mention.question,
            },
          }
        : action
    );
  }

  shouldUseLocalAi(action = {}) {
    return Boolean(
      this.running &&
        action.ruleName === "ai" &&
        this.isModuleEnabled("ai") &&
        this.localAiClient?.getState?.().enabled
    );
  }

  async handleLocalAiAction(action, event = {}) {
    const generation = this.localAiGeneration;
    const memorySnapshot =
      this.localAiContextSnapshots.get(action) || this.captureLocalAiContextSnapshot(event);
    this.localAiContextSnapshots.delete(action);
    const sourceText = String(event.text || "").trim();
    const mentionPrefix = String(action.metadata?.mentionPrefix || "").trim();
    const question =
      String(action.metadata?.mentionQuestion || "").trim() ||
      sourceText.replace(/^#?(?:hey|ai)[\s:：]*/i, "").trim() ||
      sourceText;
    const prefixSize = mentionPrefix ? Array.from(`${mentionPrefix} `).length : 0;
    const replyBudget = Math.max(8, this.biliMaxChars - prefixSize);
    let realtimeWeather = null;
    try {
      realtimeWeather = await this.weatherService?.getContext?.(question);
    } catch (error) {
      realtimeWeather = {
        intent: "current_weather",
        available: false,
        reason: "weather_context_failed",
        instruction: "实时天气数据暂时不可用，请自然说明，不要编造温度。",
      };
      this.log("实时天气", error.message || String(error), { level: "warn" });
    }
    if (generation !== this.localAiGeneration || !this.running) return;
    let reply = "";
    try {
      const maxChars = Math.min(
        Number(this.config.localAi?.maxChars || this.biliMaxChars || 40),
        replyBudget
      );
      const gated = await this.generateLocalAiReplyWithGate(
        {
          userName: shownEventName(event) || "观众",
          message: question,
          context: this.buildLocalAiPromptContext(memorySnapshot, realtimeWeather),
          fallback: "",
          requireModel: true,
          maxChars,
        },
        {
          recentReplies: arrayValue(memorySnapshot.sameViewerTurns)
            .map((turn) => turn?.assistantText || turn?.assistant)
            .filter(Boolean),
          alternativeRequested: asksForAnotherReply(question),
          proactive: false,
          maxChars,
        }
      );
      if (!gated.ok) {
        this.log(
          "AI输出门禁",
          `连续 ${gated.attempts} 个候选未通过，已放弃发送：${gated.reason}`,
          { level: "warn" }
        );
        return;
      }
      reply = gated.reply;
    } catch (error) {
      this.log("本地AI", `Qwen 回复失败：${error.message || String(error)}；未发送固定话术`, {
        level: "warn",
      });
      return;
    }
    if (generation !== this.localAiGeneration || !this.running) return;
    const modelReply = String(reply || "").trim();
    const outboundReply = mentionPrefix ? `${mentionPrefix} ${modelReply}`.trim() : modelReply;
    const actionId = createId();
    this.stagePendingLocalAiTurn(actionId, event, question, modelReply, generation);
    const queueItem = await this.handleAction(
      {
        ...action,
        id: actionId,
        reply: outboundReply,
        metadata: {
          ...(action.metadata || {}),
          localAi: this.localAiClient.getState?.().available === true,
          realtimeWeather: realtimeWeather?.available === true,
        },
      },
      event
    );
    if (!queueItem || queueItem.status === "blocked" || queueItem.status === "failed") {
      this.discardPendingLocalAiTurn(actionId);
    }
  }

  handleLocalAiQueryAction(action = {}, event = {}) {
    // commandEngine 的 #hey 会给出 local_ai_query 动作，这里转接到观众弹幕同款 AI 管线
    const question =
      String(action.text || "").replace(/\s+/g, " ").trim() ||
      String(event?.text || "").replace(/\s+/g, " ").trim();
    const sourceUser =
      cleanDisplayName(action.user || "") || shownEventName(event || {}) || "观众";
    const prefix = `@${sourceUser}`;
    const aiAction = {
      type: "command_reply",
      ruleName: "ai",
      reply: `${prefix} 收到，我想想～`,
      emotion: "cheerful",
      priority: Number(action.priority || 120),
      metadata: {
        commandAiQuery: true,
        replyMentionUser: true,
        mentionPrefix: prefix,
        mentionQuestion: question || "和我打个招呼吧",
      },
    };
    if (this.shouldUseLocalAi(aiAction)) {
      this.localAiContextSnapshots.set(aiAction, this.captureLocalAiContextSnapshot(event || {}));
      this.handleLocalAiAction(aiAction, event || {}).catch((error) => {
        this.log("本地AI", error.message || String(error), { level: "warn" });
      });
      return;
    }
    this.handleAction(
      {
        type: "command_reply",
        ruleName: "command",
        reply: `${prefix} AI 互动当前未开启`,
        emotion: "calm",
        priority: Number(action.priority || 120),
      },
      event
    );
  }

  handleActions(actions, event) {
    for (const action of actions) {
      if (action?.type === "local_ai_query") {
        this.handleLocalAiQueryAction(action, event);
        continue;
      }
      if (this.shouldUseLocalAi(action)) {
        this.localAiContextSnapshots.set(action, this.captureLocalAiContextSnapshot(event));
        this.handleLocalAiAction(action, event).catch((error) => {
          this.log("本地AI", error.message || String(error), { level: "warn" });
        });
      } else {
        this.handleAction(action, event);
      }
    }
  }

  handleGiftThanksActions(actions = [], event = {}) {
    const giftActions = (actions || []).filter((action) => action?.reply);
    if (!giftActions.length) return;
    const section = this.config.interactions?.gift || {};
    const aggregateWindowMs = Math.max(
      0,
      Number(section.aggregateWindowMs || section.thanksDelayMs || giftActions[0]?.metadata?.aggregateWindowMs || 0)
    );
    if (!aggregateWindowMs) {
      this.handleActions(giftActions, event);
      return;
    }

    const userKey = String(event.userId || event.displayUserName || event.userName || "unknown");
    const now = Date.now();
    const batch = this.pendingGiftThanks.get(userKey) || {
      userKey,
      userName: shownEventName(event),
      firstAt: now,
      lastAt: now,
      totalCoin: 0,
      coinType: event.coinType || "gold",
      gifts: new Map(),
      blind: [],
      sourceEvent: event,
      baseAction: giftActions[0],
      timer: null,
    };

    batch.userName = shownEventName(event) || batch.userName;
    batch.lastAt = now;
    batch.sourceEvent = event;
    batch.baseAction = giftActions[0];
    const giftName = event.giftName || giftActions[0]?.metadata?.giftName || "礼物";
    const count = Math.max(
      1,
      Number(giftActions[0]?.metadata?.deltaCount || event.deltaCount || event.count || giftActions[0]?.metadata?.count || 1)
    );
    const totalCoin =
      event.coinType === "silver"
        ? 0
        : Number(giftActions[0]?.metadata?.deltaCoin ?? event.deltaCoin ?? event.totalCoin ?? giftActions[0]?.metadata?.totalCoin ?? 0);
    batch.totalCoin += totalCoin;
    const gift = batch.gifts.get(giftName) || { giftName, count: 0, totalCoin: 0 };
    gift.count += count;
    gift.totalCoin += totalCoin;
    batch.gifts.set(giftName, gift);
    if (event.sourceGiftName || event.blindGift) {
      batch.blind.push({
        sourceGiftName: event.sourceGiftName || event.blindGift?.originalGiftName || "盲盒",
        giftName,
        count,
      });
    }

    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      this.pendingGiftThanks.delete(userKey);
      if (!this.running || !this.isModuleEnabled("giftThanks")) return;
      const finalAction = this.createAggregatedGiftThanksAction(batch);
      this.handleAction(finalAction, batch.sourceEvent);
    }, aggregateWindowMs);
    this.pendingGiftThanks.set(userKey, batch);
  }

  createAggregatedGiftThanksAction(batch = {}) {
    const section = this.config.interactions?.gift || {};
    const gifts = [...(batch.gifts || new Map()).values()]
      .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
      .slice(0, 4)
      .map((item) => `${item.giftName}x${item.count}`)
      .join("、");
    const valueText = formatBattery(batch.totalCoin, batch.coinType || "gold") || "";
    const bigThanksMinCoin = Number(section.bigThanksMinCoin ?? 50000);
    const bigTail = bigThanksMinCoin > 0 && Number(batch.totalCoin || 0) >= bigThanksMinCoin ? "，老板大气" : "";
    const blindText = batch.blind?.length
      ? `，盲盒${batch.blind
          .slice(0, 2)
          .map((item) => `${item.sourceGiftName}->${item.giftName}x${item.count}`)
          .join("、")}`
      : "";
    return {
      ...(batch.baseAction || {}),
      type: batch.baseAction?.type || "reply",
      ruleName: "gift",
      reply: `感谢${batch.userName || "这位朋友"}的礼物：${gifts || "礼物"}${valueText ? `，共${valueText}` : ""}${blindText}${bigTail}`,
      emotion: batch.baseAction?.emotion || "happy",
      priority: batch.baseAction?.priority || 80,
      metadata: {
        ...(batch.baseAction?.metadata || {}),
        aggregated: true,
        totalCoin: batch.totalCoin,
      },
    };
  }

  handleAssistantGiftText(event) {
    if (!isAssistantLikeName(event.userName) && !isAssistantLikeName(event.displayUserName)) {
      return;
    }

    const thankedUser = parseAssistantGiftThanks(event.text);
    if (thankedUser) {
      this.lastAssistantGiftUser = {
        userName: thankedUser,
        at: Date.now(),
      };
      return;
    }

    const summary = parseAssistantGiftSummary(event.text);
    if (!summary) return;

    const recentUser =
      this.lastAssistantGiftUser && Date.now() - this.lastAssistantGiftUser.at < 15000
        ? this.lastAssistantGiftUser.userName
        : "小助理播报";

    // 昵称像助理只决定“是否尝试解析”；能否入账要看发送者 uid 是否在官方助理白名单里
    const assistantUids = arrayValue(this.config.roles?.assistantUids)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value > 0);
    const senderUid = Number(event.userId || event.uid || 0);
    if (!senderUid || !assistantUids.includes(senderUid)) {
      const giftEvent = this.enrichUserVisual(this.giftCatalog.enrichGift({
        command: "ASSISTANT_GIFT_TEXT",
        userName: recentUser,
        displayUserName: recentUser,
        userId: 0,
        giftName: summary.giftName,
        count: summary.count,
        totalCoin: summary.totalCoin,
        coinType: "gold",
        source: "assistant_text",
        isSimulated: Boolean(event.isSimulated),
        dedupeKey: `assistant:${recentUser}:${summary.giftName}:${summary.count}:${summary.totalCoin}:${Math.floor(Date.now() / 30000)}`,
      }));
      giftEvent.needsVisualCheck = true;
      this.markGiftEvent("ASSISTANT_GIFT_TEXT");
      this.counts.gift += 1;
      this.log(
        "礼物播报",
        `${giftEvent.userName} ${giftEvent.giftName} x${giftEvent.count}（播报者不在助理白名单，待网页核对，不计入统计）`,
        { kind: "gift", event: giftEvent }
      );
      this.recordUnverifiedGiftEvent(giftEvent);
      this.emitSnapshot();
      return;
    }

    const matchedGift = this.findRecentGiftPacket(summary);
    if (matchedGift) {
      if (matchedGift.row) {
        matchedGift.row.aliasName = recentUser;
        matchedGift.row.aliasNames = [
          ...new Set([...(matchedGift.row.aliasNames || []), recentUser].filter(Boolean)),
        ];
      }
      this.log(
        "礼物播报合并",
        `${recentUser} -> ${matchedGift.userName} ${summary.giftName} x${summary.count}`,
        {
          kind: "gift",
          event: {
            ...matchedGift,
            aliasName: recentUser,
          },
        }
      );
      this.emitSnapshot();
      return;
    }

    const giftEvent = this.enrichUserVisual(this.giftCatalog.enrichGift({
      command: "ASSISTANT_GIFT_TEXT",
      userName: recentUser,
      displayUserName: recentUser,
      userId: 0,
      giftName: summary.giftName,
      count: summary.count,
      totalCoin: summary.totalCoin,
      coinType: "gold",
      source: "assistant_text",
      dedupeKey: `assistant:${recentUser}:${summary.giftName}:${summary.count}:${summary.totalCoin}:${Math.floor(Date.now() / 30000)}`,
    }));
    this.markGiftEvent("ASSISTANT_GIFT_TEXT");
    this.counts.gift += 1;
    this.log("礼物播报", `${giftEvent.userName} ${giftEvent.giftName} x${giftEvent.count}`, {
      kind: "gift",
      event: giftEvent,
    });
    const actions = this.interactions.handleGift(giftEvent);
    this.recordGiftIfNeeded(giftEvent);
    this.captureScreenIfNeeded("gift", giftEvent);
    this.pointsEngine?.awardGift(giftEvent, this.roomInfo || {});
    this.handleGiftThanksActions(this.isModuleEnabled("giftThanks") ? actions : [], giftEvent);
  }

  welcomeIdleUserKey(event = {}) {
    return String(event.userId || event.face || event.displayUserName || event.userName || "").trim();
  }

  cancelWelcomeIdleReminders(event = {}) {
    const key = this.welcomeIdleUserKey(event);
    if (!key) return;
    const pending = this.pendingWelcomeIdleReminders.get(key);
    if (!pending) return;
    for (const timer of pending.timers || []) clearTimeout(timer);
    this.pendingWelcomeIdleReminders.delete(key);
    if (pending.userName) {
      this.log("沉默提醒取消", `${pending.userName} 已发言`, { kind: "enter" });
    }
  }

  shouldScheduleWelcomeIdleReminder(event = {}, reminder = {}, welcome = {}) {
    if (reminder.enabled === false) return false;
    if (event.isMaskedName && welcome.requireFullName) return false;
    if (this.interactions?.shouldIgnoreUser?.(event.userName)) return false;
    const requireFan = reminder.requireFan !== false;
    if (!requireFan) return true;
    const guardLevel = Number(event.guardLevel || 0);
    const medalLevel = Number(event.medalLevel || 0);
    const wealthLevel = Number(event.wealthLevel || 0);
    const minWealth = Number(reminder.minWealthLevel || welcome.idleReminderMinWealthLevel || 20);
    return Boolean(guardLevel > 0 || medalLevel > 0 || event.medalName || wealthLevel >= minWealth);
  }

  scheduleWelcomeIdleReminders(event = {}) {
    const welcome = this.config.interactions?.welcome || {};
    const reminders = arrayValue(welcome.idleReminders || welcome.silentReminders).filter(Boolean);
    if (!reminders.length || !this.running || !this.isModuleEnabled("welcome")) return;
    const enabledReminders = reminders.filter((reminder) =>
      this.shouldScheduleWelcomeIdleReminder(event, reminder, welcome)
    );
    if (!enabledReminders.length) return;

    const userKey = this.welcomeIdleUserKey(event);
    if (!userKey) return;
    const previous = this.pendingWelcomeIdleReminders.get(userKey);
    if (previous) {
      for (const timer of previous.timers || []) clearTimeout(timer);
    }

    const enteredAt = Date.now();
    const userName = shownEventName(event);
    const pending = {
      userKey,
      userName,
      enteredAt,
      timers: [],
    };
    this.pendingWelcomeIdleReminders.set(userKey, pending);

    enabledReminders.forEach((reminder, index) => {
      const delayMs = Math.max(
        1,
        Number(reminder.delayMs || 0) ||
          Number(reminder.delaySec || reminder.seconds || 0) * 1000 ||
          Number(reminder.delayMin || reminder.minutes || 5) * 60 * 1000
      );
      const stageKey = `${userKey}:${index}`;
      const cooldownMs = Math.max(0, Number(reminder.userCooldownSec || welcome.idleReminderUserCooldownSec || 1800)) * 1000;
      const lastAt = Number(this.welcomeIdleReminderLastAt.get(stageKey) || 0);
      if (cooldownMs > 0 && enteredAt - lastAt < cooldownMs) return;

      const timer = setTimeout(() => {
        const current = this.pendingWelcomeIdleReminders.get(userKey);
        if (!current || current.enteredAt !== enteredAt) return;
        current.timers = (current.timers || []).filter((item) => item !== timer);
        if (!current.timers.length) this.pendingWelcomeIdleReminders.delete(userKey);
        if (!this.running || !this.isModuleEnabled("welcome")) return;
        // 删后再写保持插入序即时间序，顺带从头清掉早已过期的 stageKey
        const reminderNow = Date.now();
        for (const [key, at] of this.welcomeIdleReminderLastAt) {
          if (reminderNow - Number(at || 0) <= WELCOME_IDLE_LAST_AT_TTL_MS) break;
          this.welcomeIdleReminderLastAt.delete(key);
        }
        this.welcomeIdleReminderLastAt.delete(stageKey);
        this.welcomeIdleReminderLastAt.set(stageKey, reminderNow);
        const reply = simpleTemplate(reminder.reply || reminder.template || "{user}还在的话扣个1，让主播看到你。", {
          user: userName || "这位朋友",
          medalName: event.medalName || "",
          medalLevel: event.medalLevel || "",
          guardName: event.guardName || "",
          wealthLevel: event.wealthLevel || "",
        }).trim();
        if (!reply) return;
        this.handleAction(
          {
            type: "reply",
            ruleName: "welcome",
            reply,
            emotion: reminder.emotion || "calm",
            priority: Number(reminder.priority || 55),
            metadata: {
              idleReminder: true,
              delayMs,
            },
          },
          event
        );
      }, delayMs);
      pending.timers.push(timer);
    });

    if (!pending.timers.length) {
      this.pendingWelcomeIdleReminders.delete(userKey);
    }
  }

  handleEnterEvent(event) {
    const welcome = this.config.interactions?.welcome || {};
    const delayMs = Number(welcome.maskedResolveDelayMs ?? 3500);

    if (event.isMaskedName && !event.identityResolved && delayMs > 0) {
      if (this.showEvents) {
        this.log("进房待解析", `${event.userName}，等待完整昵称`, {
          kind: "enter",
          event,
        });
      }

      const timer = setTimeout(() => {
        this.pendingEnterTimers.delete(timer);
        if (!this.running || !this.isModuleEnabled("welcome")) return;

        const resolved = this.resolveIdentityAcrossClients(event);
        const nextEvent = {
          ...event,
          ...resolved,
        };

        if (nextEvent.isMaskedName && welcome.requireFullName) {
          if (this.showEvents) {
            this.log("进房跳过", `${event.userName} 未拿到完整昵称`, {
              kind: "enter",
              event: nextEvent,
            });
          }
          this.emitSnapshot();
          return;
        }

        const welcomeActions = this.interactions.handleEnter(nextEvent);
        this.handleActions(welcomeActions, nextEvent);
        if (welcomeActions.length || welcome.idleRemindersRequireWelcome === false) {
          this.scheduleWelcomeIdleReminders(nextEvent);
        }
        this.emitSnapshot();
      }, delayMs);

      this.pendingEnterTimers.add(timer);
      return;
    }

    const welcomeActions = this.interactions.handleEnter(event);
    this.handleActions(welcomeActions, event);
    if (welcomeActions.length || welcome.idleRemindersRequireWelcome === false) {
      this.scheduleWelcomeIdleReminders(event);
    }
  }

  async handleAction(action, event) {
    if (!action?.reply) return null;
    this.counts.action += 1;
    this.lastAction = {
      id: createId(),
      at: Date.now(),
      ...action,
    };
    this.emit("action", this.lastAction);
    const queueItem = this.queueAction(this.lastAction, event);

    if (action.type === "gift_report") {
      this.log("礼物报告", action.reply, { kind: "action", action: this.lastAction });
    } else if (action.type?.startsWith("pk_")) {
      this.log("PK情报", action.reply, { kind: "action", action: this.lastAction });
    } else {
      const prefix = action.type === "timer" ? "定时话术" : `命中 ${action.ruleName}`;
      this.log("建议回复", `${prefix}: ${action.reply}`, {
        kind: "action",
        action: this.lastAction,
      });
    }

    if (!this.dryRun && this.enablePost && this.speakEndpoint) {
      try {
        await postSpeak(this.speakEndpoint, action, event);
        this.log("已推送", `local speak endpoint: ${this.speakEndpoint}`);
      } catch (error) {
        this.log("推送失败", error.message, { level: "warn" });
      }
    }

    if (queueItem.status === "blocked" && this.sendToBili) {
      this.log("发送待确认", queueItem.reason, { level: "warn" });
    }
    this.emitSnapshot();
    return queueItem;
  }

  async prepareBiliOutboundText(action = {}) {
    const source = String(action.reply || "").replace(/\s+/g, " ").trim();
    if (!source) return "";
    if (Array.from(source).length <= this.biliMaxChars) return source;

    const mentionPrefix = String(
      action.metadata?.mentionPrefix || source.match(/^@[^\s]{1,30}/u)?.[0] || ""
    ).trim();
    if (this.localAiClient?.shortenReply && this.localAiClient?.getState?.().enabled) {
      try {
        const shortened = await this.localAiClient.shortenReply({
          text: source,
          maxChars: this.biliMaxChars,
          preservePrefix: mentionPrefix,
        });
        const value = String(shortened || "").replace(/\s+/g, " ").trim();
        if (value && Array.from(value).length <= this.biliMaxChars) return value;
      } catch (error) {
        this.log("弹幕压缩", "本地模型未能压缩，已使用本地短句兜底", { level: "warn" });
      }
    }
    return compressBiliText(source, this.biliMaxChars);
  }

  async sendActionToBili(action, options = {}) {
    if (this.dryRun && !options.allowDryRunSend) {
      this.log("B站发送失败", "当前是 dry-run 模式，先关闭 dry-run 再真实发送", {
        level: "warn",
      });
      return {
        ok: false,
        error: "dry-run 模式禁止真实发送",
      };
    }
    if (!this.sendToBili && !options.allowDryRunSend) {
      this.log("B站发送失败", "B站发送开关未开启", {
        level: "warn",
      });
      return {
        ok: false,
        error: "B站发送开关未开启",
      };
    }
    if (!this.activeOutboundLiveEligible(action)) {
      return {
        ok: false,
        error: "直播间未开播，主动发言等待开播",
      };
    }
    const finalText = await this.prepareBiliOutboundText(action);
    if (!finalText) {
      this.log("B站发送失败", "发送内容为空", { level: "warn" });
      return {
        ok: false,
        error: "发送内容为空",
      };
    }
    if (!this.running && !options.allowDryRunSend) {
      return {
        ok: false,
        error: "监听已停止",
      };
    }
    const finalAction = { ...action, reply: finalText };
    const blocked = this.moderateOutbound(finalAction);
    if (blocked) {
      this.log("B站发送失败", blocked, { level: "warn" });
      return {
        ok: false,
        error: blocked,
      };
    }
    const now = Date.now();
    const waitMs = Math.max(0, Number(this.nextBiliSendAt || 0) - now);
    if (!options.ignoreCooldown && waitMs > 0) {
      this.log("发送跳过", `B站发送冷却中，还需 ${Math.ceil(waitMs / 1000)} 秒`, {
        level: "warn",
      });
      return {
        ok: false,
        skipped: true,
      };
    }
    if (this.browserAuto && !this.isBrowserControlReady()) {
      this.log("B站发送失败", "浏览器尚未登录或未准备就绪", { level: "warn" });
      return {
        ok: false,
        error: "浏览器尚未登录或未准备就绪",
      };
    }
    if (!this.browserAuto && !this.biliCookie) {
      this.log("B站发送失败", "缺少 B站 Cookie", { level: "warn" });
      return {
        ok: false,
        error: "缺少 B站 Cookie",
      };
    }
    if (!this.roomInfo?.roomId) {
      this.log("B站发送失败", "还没有拿到房间号", { level: "warn" });
      return {
        ok: false,
        error: "还没有拿到房间号",
      };
    }
    if (!this.activeOutboundLiveEligible(action)) {
      return {
        ok: false,
        error: "直播间未开播，主动发言等待开播",
      };
    }

    try {
      const transportResult = this.browserAuto
        ? await this.browserController.send(finalText, {
            roomId: this.roomInfo?.roomId,
            maxChars: this.biliMaxChars,
            shouldContinue: () => this.activeOutboundLiveEligible(action),
          })
        : await this.sendLiveDanmu({
            cookie: this.biliCookie,
            roomId: this.roomInfo?.roomId,
            message: finalText,
            maxChars: this.biliMaxChars,
          });
      if (!transportResult || transportResult.ok === false) {
        throw new Error(transportResult?.error || transportResult?.message || "浏览器发送失败");
      }
      const result = { ...transportResult, sentText: finalText };
      this.lastBiliSendAt = Date.now();
      this.currentBiliSendGapMs = this.randomSendGapMs();
      this.nextBiliSendAt = this.lastBiliSendAt + this.currentBiliSendGapMs;
      this.rememberSentText(finalText);
      // Cookie 通道发出的弹幕也要登记进浏览器回声过滤，否则 DOM 轮询会把它回流成观众弹幕。
      if (!this.browserAuto) {
        try {
          this.browserController?.noteOutboundText?.(finalText, {
            at: this.lastBiliSendAt,
            uid: Number(this.biliUid || 0),
          });
        } catch {
          // 回声登记失败不影响发送结果。
        }
      }
      this.log("已发B站", finalText, {
        kind: "action",
      });
      return result;
    } catch (error) {
      this.log("B站发送失败", error.message, {
        level: "warn",
      });
      return {
        ok: false,
        error: error.message,
      };
    }
  }

  async sendTextToBili(text) {
    const action = {
      type: "manual_send",
      ruleName: "manual_send",
      reply: text,
      emotion: "calm",
      priority: 100,
    };
    const result = await this.sendActionToBili(action);
    this.emitSnapshot();
    return result;
  }

  log(label, message, extra = {}) {
    let event = extra.event;
    let nextMessage = message;
    if (event && typeof event === "object") {
      event = this.enrichUserVisual(event);
      if ((extra.kind === "chat" || label === "弹幕" || label === "网页弹幕") && event.text) {
        nextMessage = `${shownEventName(event)}: ${event.text}`;
      } else if ((extra.kind === "gift" || label === "礼物") && event.giftName) {
        nextMessage = `${event.displayUserName || event.userName || "匿名用户"} ${event.giftName} x${
          event.count || 1
        }`;
      }
    }
    const entry = {
      id: createId(),
      at: Date.now(),
      level: extra.level || "info",
      label,
      message: nextMessage,
      kind: extra.kind || "log",
      event: event ? compactEvent(event) : event,
      action: extra.action,
    };
    this.lastLog = entry;
    this.emit("log", entry);
  }

  emitSnapshot() {
    this.emit("snapshot", this.getSnapshot());
  }

  getQueueSnapshot() {
    return this.autoSendQueue.slice(0, 40).map((item) => ({
      id: item.id,
      at: item.at,
      handledAt: item.handledAt,
      notBeforeAt: item.notBeforeAt,
      randomDelayMs: item.randomDelayMs,
      type: item.type,
      ruleName: item.ruleName,
      reply: item.reply,
      priority: item.priority,
      status: item.status,
      reason: item.reason,
      sourceUser: item.sourceUser,
      sourceText: item.sourceText,
      sentText: item.sentText,
    }));
  }

  enrichGiftHistoryRow(row = {}) {
    const withVisual = this.enrichUserVisual(row);
    return this.giftCatalog?.enrichGift ? this.giftCatalog.enrichGift(withVisual) : withVisual;
  }

  enrichGiftHistoryStats(stats = null) {
    if (!stats) return stats;
    const giftFeed = Array.isArray(stats.giftFeed)
      ? stats.giftFeed.map((row, index) => compactGiftFeedItem(this.enrichGiftHistoryRow(row), index))
      : [];
    return {
      ...stats,
      giftFeed,
      quality: giftFeed.length ? giftDataQuality(giftFeed) : stats.quality,
    };
  }

  getHistorySummary(force = false) {
    const now = Date.now();
    if (!force && this.lastHistorySummary && now - this.lastHistorySummaryAt < 5000) {
      return this.lastHistorySummary;
    }
    try {
      if (!force && (this.eventStore?.eventFileSize?.() || 0) > 12 * 1024 * 1024) {
        this.lastHistorySummary = this.interactions?.getStats?.() || this.lastHistorySummary || null;
        this.lastHistorySummaryAt = now;
        return this.lastHistorySummary;
      }
      this.lastHistorySummary = this.enrichGiftHistoryStats(
        this.eventStore
          ? summarizeGifts(this.queryTrustedGiftRows({ range: "today", roomId: this.roomInfo?.roomId }))
          : null
      );
      this.lastHistorySummaryAt = now;
    } catch (error) {
      this.lastHistorySummary = null;
    }
    return this.lastHistorySummary;
  }

  queryGiftHistory(query = {}) {
    // 统计口径只吃受信行；待网页核对的补记单独放 unverifiedFeed 供人工核对，不进 totalCoin/排行。
    const options = {
      ...query,
      roomId: query.roomId || this.roomInfo?.roomId,
    };
    if (!this.eventStore || typeof this.eventStore.queryGiftRows !== "function") {
      return this.enrichGiftHistoryStats(this.eventStore?.queryGifts(options) || null);
    }
    const allRows = this.eventStore.queryGiftRows(options);
    const summary = summarizeGifts(allRows.filter((row) => !this.isUnverifiedGiftRow(row)));
    summary.unverifiedFeed = allRows
      .filter((row) => this.isUnverifiedGiftRow(row))
      .slice(-50);
    return this.enrichGiftHistoryStats(summary);
  }

  getGuardBoard() {
    // queryGuards 会读整月历史文件，高频调用要靠短时缓存挡住
    const now = Date.now();
    if (this.lastGuardBoardAt && now - this.lastGuardBoardAt < 5000) {
      return this.lastGuardBoard;
    }
    const memoryBoard = this.interactions?.getGuardBoard?.();
    const roomId = this.roomInfo?.roomId;
    const manualBoard = this.eventStore?.queryManualGuards?.({ roomId }) || null;
    const catalogBoard = this.guardCatalog?.getBoard?.() || null;
    let result;
    try {
      let historyBoard = null;
      if ((this.eventStore?.eventFileSize?.() || 0) > 12 * 1024 * 1024) {
        historyBoard = null;
      } else {
        historyBoard = this.eventStore?.queryGuards({ range: "month", roomId }) || null;
      }
      let board = catalogBoard || historyBoard || memoryBoard || null;
      if (historyBoard?.rows?.length) {
        board = mergeGuardBoards(historyBoard, board || {}, { source: "guardBoard" });
      }
      if (memoryBoard?.rows?.length || memoryBoard?.recent?.length) {
        board = mergeGuardBoards(memoryBoard, board || {}, { source: "guardBoard" });
      }
      if (manualBoard?.rows?.length) {
        board = mergeGuardBoards(manualBoard, board || {}, { source: "manualGuardBoard" });
      }
      result = board;
    } catch {
      result = memoryBoard || catalogBoard || null;
    }
    this.lastGuardBoard = result;
    this.lastGuardBoardAt = now;
    return result;
  }

  testCommand(text, userName = "") {
    if (!this.commandEngine) this.commandEngine = new CommandEngine(this.config);
    if (!this.interactions) this.interactions = new InteractionEngine(this.config);
    if (!this.pkTracker) {
      this.pkTracker = new PkTracker({
        ...(this.config.pk || {}),
        ownRoomId: this.roomInfo?.roomId || SIMULATED_FALLBACK_ROOM_ID,
      });
    }
    const roomAnchor = this.roomInfo?.uname || "主播";
    const actorName = userName || roomAnchor || "网页测试员";
    const result = this.commandEngine.handleChat(
      {
        text,
        userName: actorName,
        displayUserName: actorName,
        userId: 0,
      },
      {
        ...this.createCommandContext(),
        roomInfo: {
          ...(this.roomInfo || {}),
          uname: roomAnchor,
        },
      }
    );
    return {
      handled: result.handled,
      moduleUpdates: result.moduleUpdates,
      replies: result.actions.map((action) => action.reply).filter(Boolean),
      actions: result.actions,
    };
  }

  getVisualAuditSummary() {
    const audit = this.visualAudit || createVisualAuditState();
    const now = Date.now();
    const active = Boolean(audit.lastAt && now - Number(audit.lastAt) <= 15000);
    return {
      ...audit,
      active,
      lagMs: audit.lastAt ? now - Number(audit.lastAt) : 0,
      acceptedTotal:
        Number(audit.acceptedChat || 0) +
        Number(audit.acceptedGift || 0) +
        Number(audit.acceptedPk || 0),
      observedTotal:
        Number(audit.observedChat || 0) +
        Number(audit.observedGift || 0) +
        Number(audit.observedPk || 0),
    };
  }

  getCommandCoverage() {
    const get = (command) => Number(this.commandStats?.get(command) || 0);
    const getFiltered = (command) => Number(this.filteredRawStats?.get(command) || 0);
    const getPrefix = (prefix) =>
      [...(this.commandStats || new Map()).entries()].reduce(
        (sum, [command, count]) => sum + (String(command).startsWith(prefix) ? Number(count || 0) : 0),
        0
      );
    const giftRawCommands = [
      "SEND_GIFT",
      "OPEN_LIVEROOM_SEND_GIFT",
      "LIVE_OPEN_PLATFORM_SEND_GIFT",
      "COMBO_SEND",
      "GIFT_COMBO",
      "POPULARITY_RED_POCKET_NEW",
    ];
    const guardRawCommands = [
      "GUARD_BUY",
      "USER_TOAST_MSG",
      "USER_TOAST_MSG_V2",
      "OPEN_LIVEROOM_GUARD",
      "LIVE_OPEN_PLATFORM_GUARD",
      "GUARD_HONOR_THOUSAND",
    ];
    const superChatRawCommands = [
      "SUPER_CHAT_MESSAGE",
      "SUPER_CHAT_MESSAGE_JPN",
      "SUPER_CHAT_MESSAGE_DELETE",
      "OPEN_LIVEROOM_SUPER_CHAT",
      "LIVE_OPEN_PLATFORM_SUPER_CHAT",
    ];
    const chatRawCommands = ["DANMU_MSG", "OPEN_LIVEROOM_DM", "LIVE_OPEN_PLATFORM_DM"];
    const enterRawCommands = [
      "INTERACT_WORD",
      "INTERACT_WORD_V2",
      "OPEN_PLATFORM_LIVE_ROOM_ENTER",
      "OPEN_LIVEROOM_LIVE_ROOM_ENTER",
      "LIVE_OPEN_PLATFORM_ENTER_ROOM",
      "ENTRY_EFFECT",
      "ENTRY_EFFECT_MUST_RECEIVE",
    ];
    const pkRaw = getPrefix("PK_") + get("UNIVERSAL_EVENT_GIFT") + get("UNIVERSAL_EVENT_GIFT_V2");
    const sum = (commands) => commands.reduce((total, command) => total + get(command), 0);
    const sumFiltered = (commands) => commands.reduce((total, command) => total + getFiltered(command), 0);
    const effectiveSum = (commands) => Math.max(0, sum(commands) - sumFiltered(commands));
    const giftCaptured =
      Number(this.giftEventStats?.sendGift || 0) +
      Number(this.giftEventStats?.comboSend || 0) +
      Number(this.giftEventStats?.fallback || 0) +
      Number(this.giftEventStats?.visibleBridge || 0);
    const rows = [
      coverageRow("gift", "礼物包", sum(giftRawCommands), giftCaptured, giftRawCommands),
      coverageRow("guard", "大航海", sum(guardRawCommands), Number(this.giftEventStats?.guard || 0), guardRawCommands),
      coverageRow("superChat", "醒目留言", sum(superChatRawCommands), Number(this.giftEventStats?.superChat || 0), superChatRawCommands),
      coverageRow("pk", "PK/连线", pkRaw, Number(this.counts?.pk || 0), ["PK_*", "UNIVERSAL_EVENT_GIFT"]),
      coverageRow("chat", "弹幕", effectiveSum(chatRawCommands), Number(this.counts?.chat || 0), chatRawCommands, {
        filtered: sumFiltered(chatRawCommands),
      }),
      coverageRow(
        "enter",
        "进房/关注",
        sum(enterRawCommands),
        Number(this.counts?.enter || 0) + Number(this.counts?.follow || 0) + Number(this.counts?.share || 0),
        enterRawCommands
      ),
    ];
    const gaps = rows.filter((row) => row.gap > 0);
    return {
      groups: rows,
      totalExpected: rows.reduce((total, row) => total + row.expected, 0),
      totalCaptured: rows.reduce((total, row) => total + Math.min(row.expected, row.captured), 0),
      totalGap: rows.reduce((total, row) => total + row.gap, 0),
      hasGap: gaps.length > 0,
      worst: gaps.sort((left, right) => right.gap - left.gap || right.expected - left.expected)[0] || null,
    };
  }

  getCaptureHealth() {
    const commandCounts = [...(this.commandStats || new Map()).entries()]
      .map(([command, count]) => ({ command, count }))
      .sort((left, right) => right.count - left.count || left.command.localeCompare(right.command));
    return {
      lastRawAt: this.lastRawAt,
      lastRawCommand: this.lastRawCommand,
      rawAuditCount: this.rawAuditCount,
      rawAuditEnabled: this.config.history?.rawAudit?.enabled !== false,
      commandCounts: commandCounts.slice(0, 18),
      recentCommands: this.recentCommands || [],
      giftEvents: { ...this.giftEventStats },
      roomRealtime: this.roomRealtime ? compactEvent(this.roomRealtime) : null,
      connectionState: this.connectionState ? compactEvent(this.connectionState) : null,
      connectionLines: this.getConnectionLines(),
      screenshots: {
        ...(this.screenshotService?.getStatus?.() || {}),
        stats: { ...(this.screenshotStats || {}) },
      },
      visualHints: {
        names: this.userVisualHintsByName?.size || 0,
        faces: this.userVisualHintsByFace?.size || 0,
        onlineRank: this.onlineRankRows?.length || 0,
      },
      visualAudit: this.getVisualAuditSummary(),
      coverage: this.getCommandCoverage(),
    };
  }

  getGiftStatsSnapshot() {
    const liveStats = this.interactions?.getStats?.() || null;
    const useTodayHistory =
      (this.config.history?.restoreGiftStatsOnStart === true ||
        this.config.history?.giftStatsRestoreMode === "today") &&
      this.eventStore &&
      this.roomInfo?.roomId;
    if (!useTodayHistory) {
      return liveStats ? { ...liveStats, scope: "session", source: "session" } : null;
    }

    const now = Date.now();
    if (this.lastGiftStatsSnapshot && now - Number(this.lastGiftStatsSnapshotAt || 0) < 3000) {
      return this.lastGiftStatsSnapshot;
    }

    try {
      const today = dayKey(now);
      const historyStats = summarizeGifts(
        this.queryTrustedGiftRows({
          range: "today",
          roomId: this.roomInfo?.roomId,
        })
      );
      const enrichedHistoryStats = this.enrichGiftHistoryStats(historyStats);
      const restoredGiftCount = Number(this.giftEventStats?.historyRestored || 0);
      const restoredGiftCoin = Number(this.giftEventStats?.historyRestoredTotalCoin || 0);
      const liveTodayGiftCount = Math.max(0, Number(historyStats.totalGiftCount || 0) - restoredGiftCount);
      const liveTodayGiftCoin = Math.max(0, Number(historyStats.totalCoin || 0) - restoredGiftCoin);
      this.lastGiftStatsSnapshot = {
        ...enrichedHistoryStats,
        superChatTotal: liveStats?.superChatTotal || historyStats.superChatTotal || 0,
        scope: "today",
        source: "history_today",
        day: today,
        liveSessionTotalGiftCount: liveTodayGiftCount,
        liveSessionTotalCoin: liveTodayGiftCoin,
      };
      this.lastGiftStatsSnapshotAt = now;
      return this.lastGiftStatsSnapshot;
    } catch {
      return liveStats ? { ...liveStats, scope: "session_fallback", source: "session_fallback" } : null;
    }
  }

  getSnapshot() {
    this.updateConnectedState();
    const pkSnapshot = this.pkTracker?.getSnapshot() || null;
    if (pkSnapshot) {
      pkSnapshot.investigationInFlight = Boolean(this.pkInvestigationInFlight);
      pkSnapshot.investigationRooms = [...(this.pkInvestigationInFlightRooms || [])];
    }
    return {
      running: this.running,
      connected: this.connected,
      dryRun: this.dryRun,
      showEvents: this.showEvents,
      roomInput: this.room,
      speakEndpoint: this.speakEndpoint,
      enablePost: this.enablePost,
      fanoutHosts: this.clients?.length || Number(this.config.connection?.fanoutHosts || 1),
      sendToBili: this.sendToBili,
      browserControl: this.getBrowserControlState(),
      sendTransport: this.browserAuto ? "browser" : this.sendToBili ? "cookie" : "disabled",
      browserAuto: this.browserAuto,
      localAi: this.localAiClient?.getState?.() || null,
      localAiMemory: this.getLocalAiMemorySnapshot(),
      weather: this.weatherService?.getState?.() || null,
      proactiveAi: {
        enabled: this.proactiveAiConfig().enabled,
        onlyWhenLive: this.proactiveAiConfig().onlyWhenLive,
        waitingForLive:
          this.proactiveAiConfig().enabled &&
          this.proactiveAiConfig().onlyWhenLive &&
          Number(this.roomInfo?.liveStatus ?? -1) !== 1,
        active: Boolean(this.proactiveAiTimer || this.proactiveAiInFlight),
        inFlight: this.proactiveAiInFlight,
        nextAt: this.proactiveAiNextAt,
        lastAt: this.proactiveAiLastAt,
        lastReply: this.proactiveAiLastReply,
      },
      humanTiming: {
        ...this.humanTimingConfig(),
        currentSendGapMs: this.currentBiliSendGapMs,
        nextSendAt: this.nextBiliSendAt,
      },
      hasBiliCookie: Boolean(this.biliCookie),
      biliUid: this.biliUid,
      biliAccountName: this.biliAccountName,
      identityMasked: this.identityMasked,
      biliMaxChars: this.biliMaxChars,
      biliSendCooldownSec: this.biliSendCooldownMs / 1000,
      sendTiming: {
        ...this.humanTimingConfig(),
        currentGapMs: this.currentBiliSendGapMs,
        nextSendAt: this.nextBiliSendAt,
      },
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      endpoint: this.endpoint,
      popularity: this.popularity,
      onlineCount: this.onlineCount,
      onlineText: this.onlineText,
      watchedCount: this.watchedCount,
      watchedText: this.watchedText,
      roomRealtime: this.roomRealtime ? compactEvent(this.roomRealtime) : null,
      connectionState: this.connectionState ? compactEvent(this.connectionState) : null,
      rankStats: compactEventList(this.rankStats),
      widgetStats: compactEventList(this.widgetStats),
      activityStats: compactEventList(this.activityStats),
      moderationEvents: compactEventList(this.moderationEvents, 20),
      room: this.roomInfo,
      counts: { ...this.counts },
      giftStats: this.getGiftStatsSnapshot(),
      giftStatsScope:
        this.config.history?.restoreGiftStatsOnStart === true ||
        this.config.history?.giftStatsRestoreMode === "today"
          ? "today"
          : "session",
      pk: pkSnapshot,
      guardBoard: this.getGuardBoard(),
      moduleStatus: this.moduleStatus,
      autoSendQueue: this.getQueueSnapshot(),
      historySummary: this.getHistorySummary(),
      giftCatalog: this.giftCatalog?.getSummary?.() || null,
      guardCatalog: this.guardCatalog?.getSummary?.() || null,
      points: this.pointsEngine?.getSummary?.(this.roomInfo || {}) || null,
      commandState: this.commandEngine?.getState?.() || null,
      commandCatalog: this.commandEngine?.getCatalog?.(this.moduleStatus) || [],
      timerState: this.rules?.getTimerState?.() || null,
      onlineRank: this.onlineRankRows || [],
      captureHealth: this.getCaptureHealth(),
      specialModes: { ...this.specialModes },
      lastAction: this.lastAction,
      lastLog: this.lastLog ? compactLogEntry(this.lastLog) : null,
    };
  }

  simulate(kind) {
    if (!this.rules || !this.interactions || !this.pkTracker) {
      this.rules = new RuleEngine(this.config);
      this.interactions = new InteractionEngine(this.config);
      this.pkTracker = new PkTracker({
        ...(this.config.pk || {}),
        ownRoomId: this.roomInfo?.roomId || SIMULATED_FALLBACK_ROOM_ID,
      });
      this.commandEngine = new CommandEngine(this.config);
    }

    if (kind === "blind_gift") {
      this.handleGiftTextFallback({
        text: "投喂 幸运盲盒 爆出 好运柚叶 x1",
        userName: "陌生ゅ",
        displayUserName: "陌生ゅ",
        userId: 37,
        face: "https://i0.hdslb.com/bfs/face/member/noface.jpg",
        isSimulated: true,
      });
    } else if (kind === "gift") {
      const event = {
        userName: "测试赠礼者",
        displayUserName: "测试赠礼者",
        userId: 2,
        face: "https://i0.hdslb.com/bfs/face/e77cad65b85375a9e62f74817c25beb4874f629a.jpg",
        action: "投喂",
        giftName: "撒花",
        giftIcon: "https://i0.hdslb.com/bfs/live/1967620f5f22f66a579abc870f7ff418b175a285.webp",
        count: 5,
        totalCoin: 500,
        coinType: "gold",
        medalName: "主播牌",
        medalLevel: 20,
        guardLevel: 2,
        source: "simulation",
        isSimulated: true,
      };
      this.counts.gift += 1;
      this.log("礼物", `${event.userName} ${event.giftName} x${event.count}`, {
        kind: "gift",
        event,
      });
      const actions = this.interactions.handleGift(event);
      this.recordGiftIfNeeded(event);
      this.handleActions(this.isModuleEnabled("giftThanks") ? actions : [], event);
    } else if (kind === "superChat") {
      const frame = defaultAvatarFrameForGuard(3);
      const event = {
        command: "SUPER_CHAT_MESSAGE",
        userName: "醒目留言用户",
        displayUserName: "醒目留言用户",
        userId: 30,
        face: "https://i0.hdslb.com/bfs/face/member/noface.jpg",
        text: "主播加油，SC 模拟测试",
        message: "主播加油，SC 模拟测试",
        price: 30,
        medalName: "测试牌",
        medalLevel: 32,
        guardLevel: 3,
        guardName: "舰长",
        avatarFrame: frame,
        avatarFrameUrl: frame?.url || "",
        avatarFrameName: "舰长",
        source: "simulation",
        isSimulated: true,
      };
      this.markGiftEvent(event.command);
      this.counts.superChat += 1;
      this.recordEvent("superChat", event);
      this.captureScreenIfNeeded("superChat", event);
      this.log("醒目留言", `${event.userName}: ${event.text} (${event.price})`, {
        kind: "superChat",
        event,
      });
      this.handleActions(this.interactions.handleSuperChat(event), event);
    } else if (kind === "guard") {
      const frame = defaultAvatarFrameForGuard(2);
      const event = {
        command: "GUARD_BUY",
        userName: "白纸折七次",
        displayUserName: "白纸折七次",
        userId: 41,
        face: "https://i0.hdslb.com/bfs/face/member/noface.jpg",
        action: "开通",
        guardLevel: 2,
        guardName: "提督",
        count: 1,
        unit: "月",
        price: 199800,
        totalCoin: 199800,
        coinType: "gold",
        valueText: formatBattery(199800, "gold") || "19.98万电池",
        medalName: "修铃铛",
        medalLevel: 41,
        avatarFrame: frame,
        avatarFrameUrl: frame?.url || "",
        avatarFrameName: "提督",
        source: "simulation",
        isSimulated: true,
      };
      this.rememberUserVisualHint(event, "guard_simulation");
      const guardEvent = this.guardCatalog.enrichGuard(this.enrichUserVisual(event));
      this.rememberUserVisualHint(guardEvent, "guard_simulation");
      this.markGiftEvent(guardEvent.command || "GUARD_BUY");
      this.counts.guard += 1;
      this.log(
        "大航海",
        guardEvent.message ||
          `${guardEvent.userName} ${guardEvent.guardName || guardEvent.guardLevel} ${guardEvent.valueText || ""}`,
        { kind: "guard", event: guardEvent }
      );
      const actions = this.interactions.handleGuard(guardEvent);
      this.recordGuardIfNeeded(guardEvent);
      this.captureScreenIfNeeded("guard", guardEvent);
      this.handleActions(this.isModuleEnabled("guardBoard") ? actions : [], guardEvent);
    } else if (kind === "live") {
      const event = {
        command: "LIVE",
        eventKind: "live_status",
        liveStatus: 1,
        liveStatusLabel: "直播中",
        roomId: this.roomInfo?.roomId || SIMULATED_FALLBACK_ROOM_ID,
        text: "开播",
        isSimulated: true,
      };
      this.counts.event += 1;
      this.handleGenericEvent(event);
      this.recordEvent("event", event);
    } else if (kind === "offline") {
      this.lastLiveStatus = 1;
      const event = {
        command: "PREPARING",
        eventKind: "live_status",
        liveStatus: 0,
        liveStatusLabel: "未开播",
        roomId: this.roomInfo?.roomId || SIMULATED_FALLBACK_ROOM_ID,
        text: "下播/准备中",
        isSimulated: true,
      };
      this.counts.event += 1;
      this.handleGenericEvent(event);
      this.recordEvent("event", event);
    } else if (kind === "lottery") {
      const event = {
        command: "POPULARITY_RED_POCKET_NEW",
        eventKind: "activity",
        activityKind: "red_pocket",
        text: "红包/天选测试",
        isSimulated: true,
      };
      this.counts.event += 1;
      this.updateSpecialMode(event.command, event);
      this.recordEvent("event", event);
      this.log("特殊状态", "已模拟天选/红包：欢迎和礼物感谢会临时暂停", {
        kind: "event",
        event,
      });
    } else if (kind === "pk") {
      const pre = {
        command: "PK_BATTLE_PRE_NEW",
        raw: {
          pk_id: 1,
          pk_status: 101,
          data: {
            uname: "人间蜜药",
            uid: 12450452,
            room_id: 22262300,
            pk_votes_name: "PK值",
          },
        },
      };
      const process = {
        command: "PK_BATTLE_PROCESS_NEW",
        raw: {
          pk_id: 1,
          pk_status: 201,
          data: {
            init_info: {
              room_id: this.roomInfo?.roomId || SIMULATED_FALLBACK_ROOM_ID,
              votes: 120,
              best_uname: "我方榜一",
            },
            match_info: {
              room_id: 22262300,
              votes: 80,
              best_uname: "对面榜一",
              assist_info: [{ rank: 1, uname: "对面大哥", pk_votes: 60 }],
            },
          },
        },
      };
      this.counts.pk += 2;
      this.recordEvent("pk", pre);
      this.recordEvent("pk", process);
      this.handleActions(this.isModuleEnabled("pk") ? this.pkTracker.handle(pre) : [], pre);
      this.handleActions(
        this.isModuleEnabled("pk") ? this.pkTracker.handle(process) : [],
        process
      );
    } else if (kind === "multi") {
      const event = {
        command: "PK_MULTI_CONN",
        data: {
          sessionStatus: 1,
          voteName: "分",
          members: [
            {
              room_id: this.roomInfo?.roomId || this.pkTracker.ownRoomId || 1870883256,
              uid: 1001,
              uname: "本房主播",
              votes: 160,
            },
            {
              room_id: 1990577428,
              uid: 1002,
              uname: "高圆圆吖-",
              votes: 15,
            },
            {
              room_id: 1981538101,
              uid: 1003,
              uname: "一米八的呆呆喵",
              votes: 52,
            },
            {
              room_id: 1728486926,
              uid: 1004,
              uname: "发呆小羊__",
              votes: 73,
            },
          ],
        },
        raw: {},
        forceReport: true,
      };
      this.counts.pk += 1;
      this.log("PK事件", "PK_MULTI_CONN", { kind: "pk", event });
      this.recordEvent("pk", event);
      this.handleActions(this.isModuleEnabled("pk") ? this.pkTracker.handle(event) : [], event);
    } else if (kind === "chat") {
      const event = {
        userName: "bili_9492694743",
        userId: 3,
        text: "这个多少钱",
        isSimulated: true,
        source: "simulation",
      };
      this.counts.chat += 1;
      this.log("弹幕", `${event.userName}: ${event.text}`, { kind: "chat", event });
      this.rememberLocalAiChat(event);
      this.recordEvent("chat", event);
      this.handleInboundModerationHint(event);
      const commandResult = this.commandEngine?.handleChat(event, this.createCommandContext()) || {
        handled: false,
        actions: [],
        moduleUpdates: [],
      };
      this.applyModuleUpdates(commandResult.moduleUpdates);
      this.handleActions(commandResult.actions, event);
      if (!commandResult.handled) this.handleRuleActions(this.rules.handleChat(event), event);
    } else {
      const event = { userName: "依旧秋实", userId: 1 };
      this.counts.enter += 1;
      this.log("进房", event.userName);
      this.recordEvent("enter", event);
      this.handleActions(
        this.isModuleEnabled("welcome") ? this.interactions.handleEnter(event) : [],
        event
      );
    }

    this.emitSnapshot();
    return this.getSnapshot();
  }

  triggerReport(kind) {
    if (!this.rules || !this.interactions || !this.pkTracker) {
      this.rules = new RuleEngine(this.config);
      this.interactions = new InteractionEngine(this.config);
      this.pkTracker = new PkTracker({
        ...(this.config.pk || {}),
        ownRoomId: this.roomInfo?.roomId || SIMULATED_FALLBACK_ROOM_ID,
      });
      this.commandEngine = new CommandEngine(this.config);
    }

    if (kind === "pk") {
      this.handleAction(this.pkTracker.createReportAction(), null);
    } else {
      this.handleAction(this.createGiftReportAction({ range: "today", label: "今日" }), null);
    }

    this.emitSnapshot();
    return this.getSnapshot();
  }
}

module.exports = {
  BotRuntime,
  compressBiliText,
  postSpeak,
};
