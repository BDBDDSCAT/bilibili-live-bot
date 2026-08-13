"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { formatBattery, giftDataQuality, compactGiftFeedItem } = require("./interactionEngine");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function endOfDay(input = Date.now()) {
  const date = new Date(input);
  date.setHours(23, 59, 59, 999);
  return date;
}

function startOfDay(input = Date.now()) {
  const date = new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function datesBetween(start, end) {
  const days = [];
  let cursor = startOfDay(start);
  const last = startOfDay(end);
  while (cursor <= last) {
    days.push(dayKey(cursor));
    cursor = addDays(cursor, 1);
  }
  return days;
}

function dateOffset(days = 0, input = Date.now()) {
  return dayKey(addDays(startOfDay(input), days));
}

function parseRange(range = "today") {
  const now = new Date();
  const today = startOfDay(now);
  const value = String(range || "today").trim();
  if (value === "yesterday") {
    const date = addDays(today, -1);
    return datesBetween(date, date);
  }
  if (value === "week") {
    return datesBetween(addDays(today, -6), today);
  }
  if (value === "month") {
    return datesBetween(new Date(now.getFullYear(), now.getMonth(), 1), today);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return [value];
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    const first = new Date(year, month - 1, 1);
    const last = new Date(year, month, 0);
    return datesBetween(first, last > today ? today : last);
  }
  return [dayKey(today)];
}

function lineMatchesKinds(line = "", kinds = null) {
  if (!kinds || kinds.size === 0) return true;
  for (const kind of kinds) {
    if (line.includes(`"kind":"${kind}"`)) return true;
  }
  return false;
}

function readJsonl(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return [];
  const kinds = options.kinds instanceof Set ? options.kinds : null;
  const onParseError = typeof options.onParseError === "function" ? options.onParseError : null;
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((line) => lineMatchesKinds(line, kinds))
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        if (onParseError) onParseError(filePath);
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonlTail(filePath, options = {}) {
  if (!fs.existsSync(filePath)) return [];
  const maxLines = Math.max(1, Number(options.maxLines || 5000));
  const maxBytes = Math.max(1024, Number(options.maxBytes || 4 * 1024 * 1024));
  const kinds = options.kinds instanceof Set ? options.kinds : null;
  const onParseError = typeof options.onParseError === "function" ? options.onParseError : null;
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, "r");
  try {
    const size = stat.size - start;
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const firstBreak = text.indexOf("\n");
      text = firstBreak >= 0 ? text.slice(firstBreak + 1) : "";
    }
    return text
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => lineMatchesKinds(line, kinds))
      .slice(-maxLines)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          if (onParseError) onParseError(filePath);
          return null;
        }
      })
      .filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function includesText(value, keyword) {
  if (!keyword) return true;
  return String(value || "").toLowerCase().includes(String(keyword).toLowerCase());
}

const CHAT_STOP_WORDS = new Set([
  "这个",
  "那个",
  "就是",
  "不是",
  "什么",
  "没有",
  "怎么",
  "可以",
  "已经",
  "还是",
  "感觉",
  "一下",
  "一个",
  "大家",
  "哈哈",
  "啊啊",
  "真的",
  "然后",
  "但是",
  "因为",
  "所以",
]);

function cleanChatText(value = "") {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\[[^\]]{1,20}\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chatTextFromEvent(chat = {}) {
  return cleanChatText(chat.text || chat.message || chat.content || chat.chatText || "");
}

function chatUserName(chat = {}) {
  return String(chat.displayUserName || chat.userName || chat.uname || "匿名用户").trim() || "匿名用户";
}

function isMaskedName(value = "") {
  return /[*＊]{2,}/.test(String(value || ""));
}

function isSimulatedEventPayload(payload = {}) {
  return Boolean(payload.isSimulated || payload.simulated || payload.source === "simulation");
}

function tokenizeChatText(text = "") {
  const value = cleanChatText(text);
  const chunks = value.match(/[\p{Script=Han}A-Za-z0-9_]{2,12}/gu) || [];
  return chunks
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length >= 2 && chunk.length <= 12)
    .filter((chunk) => !CHAT_STOP_WORDS.has(chunk))
    .filter((chunk) => !/^\d+$/.test(chunk));
}

function guardNameFromLevel(level = 0) {
  const value = Number(level || 0);
  if (value === 1) return "总督";
  if (value === 2) return "提督";
  if (value === 3) return "舰长";
  return "";
}

function guardLevelFromText(value = "") {
  const text = String(value || "");
  if (/总督/.test(text)) return 1;
  if (/提督/.test(text)) return 2;
  if (/舰长|船长|舰/.test(text)) return 3;
  const number = Number(text);
  return [1, 2, 3].includes(number) ? number : 0;
}

function safeParseJson(value, fallback = {}) {
  if (!value || typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rawChatText(entry = {}) {
  const message = entry.message || entry.raw || entry;
  const info = Array.isArray(message.info) ? message.info : [];
  const data = message.data || {};
  return String(info[1] || data.msg || data.message || data.content || "").trim();
}

function rawChatAt(entry = {}) {
  const message = entry.message || entry.raw || entry;
  const info = Array.isArray(message.info) ? message.info : [];
  const meta = Array.isArray(info[0]) ? info[0] : [];
  return Number(entry.at || meta[4] || dataAt(message) || Date.now());
}

function dataAt(message = {}) {
  const data = message.data || {};
  return Number(data.timestamp || data.ts || data.time || 0);
}

function rawChatUser(entry = {}) {
  const message = entry.message || entry.raw || entry;
  const info = Array.isArray(message.info) ? message.info : [];
  const user = Array.isArray(info[2]) ? info[2] : [];
  const meta = Array.isArray(info[0]) ? info[0] : [];
  const rich = meta[15] || {};
  const richUser = rich.user || {};
  const richBase = richUser.base || {};
  const data = message.data || {};
  return {
    userId: Number(user[0] || richUser.uid || data.uid || data.user_id || 0),
    userName: String(
      richBase.origin_info?.name ||
        richBase.risk_ctrl_info?.name ||
        richBase.name ||
        user[1] ||
        data.uname ||
        data.user_name ||
        "匿名用户"
    ).trim(),
    face:
      richBase.origin_info?.face ||
      richBase.risk_ctrl_info?.face ||
      richBase.face ||
      data.face ||
      "",
    extra: safeParseJson(rich.extra || ""),
  };
}

function parseRawChatRow(entry = {}) {
  const command = entry.command || entry.message?.cmd || entry.cmd || "";
  if (!["DANMU_MSG", "OPEN_LIVEROOM_DM", "LIVE_OPEN_PLATFORM_DM"].includes(command)) return null;
  const text = rawChatText(entry);
  if (!text) return null;
  const at = rawChatAt(entry);
  const user = rawChatUser(entry);
  const userName = user.userName || "匿名用户";
  return {
    at,
    roomId: Number(entry.roomId || entry.message?.data?.room_id || entry.message?.data?.roomid || 0),
    command,
    text,
    userName,
    displayUserName: userName,
    userId: user.userId || 0,
    face: user.face || "",
    isMaskedName: isMaskedName(userName),
    identityLimited: isMaskedName(userName),
    rawRecovered: true,
    source: "raw_replay_chat",
    rawId: user.extra?.id_str || entry.message?.msg_id || entry.id || "",
  };
}

function chatEventRowsFromEntries(entries = []) {
  return entries
    .filter((entry) => entry.kind === "chat")
    .map((entry) => ({
      ...(entry.payload || entry),
      at: Number(entry.payload?.at || entry.at || 0),
      day: entry.day || dayKey(entry.at),
      roomId: Number(entry.roomId || entry.payload?.roomId || 0),
      rawRecovered: false,
    }))
    .filter((chat) => !isSimulatedEventPayload(chat))
    .filter((chat) => chatTextFromEvent(chat));
}

function parseManualGuardLine(line = "", options = {}) {
  const value = String(line || "").trim();
  if (!value || value.startsWith("#")) return null;
  const now = Number(options.now || Date.now());
  const dateMatch = value.match(/(\d{4}-\d{2}-\d{2})/);
  const daysMatch = value.match(/(-?\d{1,4})\s*天/);
  const csv = value
    .split(/[,，\t]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const tokens = csv.length >= 2 ? csv : value.split(/\s+/).map((item) => item.trim()).filter(Boolean);
  const guardIndex = tokens.findIndex((token) => guardLevelFromText(token));
  const guardLevel = guardLevelFromText(tokens[guardIndex] || "") || guardLevelFromText(value) || 3;
  const guardName = guardNameFromLevel(guardLevel) || "大航海";
  const userName = (guardIndex > 0 ? tokens.slice(0, guardIndex).join(" ") : tokens[0] || "")
    .replace(/[:：]+$/, "")
    .trim();
  if (!userName) return null;
  const numericToken = tokens
    .slice(Math.max(guardIndex + 1, 1))
    .find((token) => /^-?\d{1,4}$/.test(token));
  const daysLeft = daysMatch ? Number(daysMatch[1]) : numericToken !== undefined ? Number(numericToken) : null;
  let expiresAt = 0;
  if (dateMatch) {
    expiresAt = endOfDay(dateMatch[1]).getTime();
  } else if (Number.isFinite(daysLeft)) {
    expiresAt = now + Number(daysLeft) * 86400000;
  }
  return {
    at: now,
    roomId: Number(options.roomId || 0),
    userName,
    guardLevel,
    guardName,
    daysLeft: Number.isFinite(daysLeft) ? Number(daysLeft) : expiresAt ? Math.ceil((expiresAt - now) / 86400000) : null,
    expiresAt,
    source: "manual_guard_import",
    rawLine: value,
  };
}

function summarizeGuardRows(rows = [], now = Date.now()) {
  const normalized = rows
    .map((item) => ({
      ...item,
      expired: Number(item.expiresAt || 0) > 0 && Number(item.expiresAt) < now,
      daysLeft:
        item.daysLeft === null || item.daysLeft === undefined
          ? item.expiresAt
            ? Math.ceil((Number(item.expiresAt) - now) / 86400000)
            : null
          : Number(item.daysLeft),
    }))
    .sort((left, right) => Number(left.expiresAt || Infinity) - Number(right.expiresAt || Infinity));
  return {
    total: normalized.length,
    expiring: normalized.filter((item) => item.daysLeft !== null && item.daysLeft <= 7 && item.daysLeft >= 0),
    expired: normalized.filter((item) => item.expired),
    rows: normalized,
  };
}

function giftMatchesKeyword(gift = {}, keyword = "") {
  if (!keyword) return true;
  return [
    gift.giftName,
    gift.sourceGiftName,
    gift.blindGift?.originalGiftName,
    gift.action,
  ].some((value) => includesText(value, keyword));
}

function isBlindGift(gift = {}) {
  return Boolean(gift.sourceGiftName || gift.blindGift?.originalGiftName || gift.blindGift);
}

function normalizeDedupeText(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function isNoticeGift(gift = {}) {
  return gift.source === "notice_gift" || /NOTICE.*GIFT/.test(String(gift.sourceCommand || gift.command || ""));
}

function noticeGiftDedupeKey(gift = {}) {
  const user = normalizeDedupeText(gift.userName || gift.displayUserName || "");
  const name = normalizeDedupeText(gift.giftName || "");
  const giftId = Number(gift.giftId || 0);
  const count = Number(gift.count || 1);
  if (!user || (!giftId && !name)) return "";
  return `${user}:${giftId || name}:${count}`;
}

function removeDuplicateNoticeGifts(gifts = [], windowMs = 30 * 60 * 1000) {
  const realByKey = new Map();
  for (const gift of gifts) {
    if (isNoticeGift(gift)) continue;
    const key = noticeGiftDedupeKey(gift);
    if (!key) continue;
    const list = realByKey.get(key) || [];
    list.push(gift);
    realByKey.set(key, list);
  }

  const seenNotice = new Map();
  return gifts.filter((gift) => {
    if (!isNoticeGift(gift)) return true;
    const key = noticeGiftDedupeKey(gift);
    if (!key) return true;
    const at = Number(gift.at || 0);
    const realMatch = (realByKey.get(key) || []).some((item) => {
      const realAt = Number(item.at || 0);
      return !at || !realAt || Math.abs(realAt - at) <= windowMs;
    });
    if (realMatch) return false;

    const previousAt = seenNotice.get(key) || 0;
    if (previousAt && at && Math.abs(at - previousAt) <= windowMs) return false;
    seenNotice.set(key, at || Date.now());
    return true;
  });
}

class EventStore {
  constructor(options = {}) {
    this.rootDir = options.rootDir || path.resolve(process.cwd(), "state");
    this.eventDir = path.join(this.rootDir, "events");
    this.rawDir = path.join(this.rootDir, "raw");
    this.snapshotDir = path.join(this.rootDir, "snapshots");
    ensureDir(this.eventDir);
    ensureDir(this.rawDir);
    ensureDir(this.snapshotDir);
    this.parseFailures = { count: 0, lastAt: 0, lastFile: "" };
    this.lastParseWarnAt = 0;
  }

  recordParseFailure(filePath) {
    this.parseFailures.count += 1;
    this.parseFailures.lastAt = Date.now();
    this.parseFailures.lastFile = String(filePath || "");
    if (Date.now() - this.lastParseWarnAt >= 60000) {
      this.lastParseWarnAt = Date.now();
      console.warn(
        `[事件存储] 发现无法解析的事件行（累计 ${this.parseFailures.count} 行），最近文件：${this.parseFailures.lastFile}`
      );
    }
  }

  getParseFailureStats() {
    return { ...this.parseFailures };
  }

  eventPath(day = dayKey()) {
    return path.join(this.eventDir, `${day}.jsonl`);
  }

  eventFileSize(day = dayKey()) {
    const filePath = this.eventPath(day);
    return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  }

  rawPath(roomId = 0, day = dayKey()) {
    const room = Number(roomId || 0) || "unknown";
    return path.join(this.rawDir, `${day}-${room}.raw.jsonl`);
  }

  buildEventEntry(kind, payload = {}) {
    const at = Number(payload.at || Date.now());
    // payload 里同名的 at/day/month/kind 不允许覆盖框架字段，避免重放事件落错文件或换 kind
    const { at: _at, day: _day, month: _month, kind: _kind, ...fields } = payload;
    const entry = {
      at,
      day: dayKey(at),
      month: monthKey(at),
      kind,
      ...fields,
    };
    // 模拟事件在存储层强制打标，读端过滤才有兜底
    const nested = entry.payload && typeof entry.payload === "object" ? entry.payload : null;
    if (isSimulatedEventPayload(entry) || (nested && isSimulatedEventPayload(nested))) {
      entry.isSimulated = true;
      if (nested && !nested.isSimulated) {
        entry.payload = { ...nested, isSimulated: true };
      }
    }
    return entry;
  }

  appendMany(kind, payloads = []) {
    const entries = payloads.map((payload) => this.buildEventEntry(kind, payload));
    const linesByPath = new Map();
    for (const entry of entries) {
      const filePath = this.eventPath(entry.day);
      const lines = linesByPath.get(filePath) || [];
      lines.push(JSON.stringify(entry));
      linesByPath.set(filePath, lines);
    }
    for (const [filePath, lines] of linesByPath) {
      fs.appendFileSync(filePath, `${lines.join("\n")}\n`);
    }
    return entries;
  }

  append(kind, payload = {}) {
    return this.appendMany(kind, [payload])[0];
  }

  appendRaw(payload = {}) {
    const at = Number(payload.at || Date.now());
    const entry = {
      at,
      day: dayKey(at),
      roomId: payload.roomId || 0,
      command: payload.command || "",
      message: payload.message || null,
    };
    fs.appendFileSync(this.rawPath(entry.roomId, entry.day), `${JSON.stringify(entry)}\n`);
    return entry;
  }

  writeSnapshot(name, payload = {}) {
    ensureDir(this.snapshotDir);
    const filePath = path.join(this.snapshotDir, `${name}.json`);
    // 先写临时文件再原子替换，强杀/断电不会留下截断的快照
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify({ at: Date.now(), ...payload }, null, 2));
      fs.renameSync(tmpPath, filePath);
    } catch (error) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      throw error;
    }
    return filePath;
  }

  readSnapshot(name) {
    const filePath = path.join(this.snapshotDir, `${name}.json`);
    if (!fs.existsSync(filePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      // 坏快照留档而不是静默吞掉，避免后续写入以空数据重建
      try {
        fs.copyFileSync(filePath, `${filePath}.corrupt`);
      } catch {}
      console.warn(`[事件存储] 快照 ${name}.json 解析失败，已备份为 .corrupt：${error.message || error}`);
      return {};
    }
  }

  importManualGuards(input = {}) {
    const now = Number(input.now || Date.now());
    const roomId = Number(input.roomId || 0);
    const parsedRows = [
      ...(Array.isArray(input.rows) ? input.rows : []),
      ...String(input.text || "")
        .split(/\r?\n/)
        .map((line) => parseManualGuardLine(line, { now, roomId }))
        .filter(Boolean),
    ].map((row) => {
      const guardLevel = Number(row.guardLevel || guardLevelFromText(row.guardName) || 3);
      return {
        ...row,
        at: Number(row.at || now),
        roomId: Number(row.roomId || roomId),
        guardLevel,
        guardName: row.guardName || guardNameFromLevel(guardLevel) || "大航海",
        source: row.source || "manual_guard_import",
      };
    });
    const snapshot = this.readSnapshot("manualGuardBoard");
    const existing = Array.isArray(snapshot.rows) ? snapshot.rows : [];
    const byUser = new Map();
    const upsert = (row) => {
      const room = Number(row.roomId || 0);
      const idKey = row.userId ? `${room}:${row.userId}` : "";
      const nameKey = row.userName ? `${room}:${row.userName}` : "";
      if (!idKey && !nameKey) return;
      if (idKey) {
        // 带 userId 的行吸收此前仅按昵称登记的同名旧行，避免榜上重复
        if (nameKey) byUser.delete(nameKey);
        byUser.set(idKey, row);
        return;
      }
      for (const [key, item] of byUser) {
        if (
          Number(item.roomId || 0) === room &&
          item.userId &&
          String(item.userName || "") === String(row.userName || "")
        ) {
          byUser.set(key, { ...row, userId: item.userId });
          return;
        }
      }
      byUser.set(nameKey, row);
    };
    for (const row of existing) upsert(row);
    for (const row of parsedRows) upsert(row);
    const rows = [...byUser.values()].sort((left, right) =>
      String(left.userName || "").localeCompare(String(right.userName || ""), "zh-Hans-CN")
    );
    this.writeSnapshot("manualGuardBoard", {
      updatedAt: now,
      rows,
    });
    return {
      ok: true,
      imported: parsedRows.length,
      total: rows.length,
      rows: parsedRows,
    };
  }

  queryManualGuards(options = {}) {
    const roomId = Number(options.roomId || 0);
    const snapshot = this.readSnapshot("manualGuardBoard");
    const rows = (Array.isArray(snapshot.rows) ? snapshot.rows : [])
      .filter((item) => !roomId || Number(item.roomId || 0) === roomId)
      .filter((item) => includesText(item.userName, options.userName || ""));
    return {
      ...summarizeGuardRows(rows),
      source: "manualGuardBoard",
      updatedAt: snapshot.updatedAt || snapshot.at || 0,
    };
  }

  readEvents(options = {}) {
    const days = parseRange(options.range || "today");
    const kinds = Array.isArray(options.kinds) ? new Set(options.kinds) : null;
    const onParseError = (filePath) => this.recordParseFailure(filePath);
    return days
      .flatMap((day) => readJsonl(this.eventPath(day), { kinds, onParseError }))
      .filter((entry) => !kinds || kinds.has(entry.kind));
  }

  readRecentEvents(options = {}) {
    const days = parseRange(options.range || "today");
    const kinds = Array.isArray(options.kinds) ? new Set(options.kinds) : null;
    const onParseError = (filePath) => this.recordParseFailure(filePath);
    return days
      .flatMap((day) =>
        readJsonlTail(this.eventPath(day), {
          maxLines: options.maxLines || 5000,
          maxBytes: options.maxBytes || 4 * 1024 * 1024,
          kinds,
          onParseError,
        })
      )
      .filter((entry) => !kinds || kinds.has(entry.kind));
  }

  rawFilesForDay(day = dayKey(), roomId = 0) {
    if (roomId) {
      const filePath = this.rawPath(roomId, day);
      return fs.existsSync(filePath) ? [filePath] : [];
    }
    if (!fs.existsSync(this.rawDir)) return [];
    return fs
      .readdirSync(this.rawDir)
      .filter((name) => name.startsWith(`${day}-`) && name.endsWith(".raw.jsonl"))
      .map((name) => path.join(this.rawDir, name))
      .sort();
  }

  readRawChatRows(days = [], roomId = 0) {
    const onParseError = (filePath) => this.recordParseFailure(filePath);
    return days
      .flatMap((day) => this.rawFilesForDay(day, roomId).flatMap((filePath) => readJsonl(filePath, { onParseError })))
      .map(parseRawChatRow)
      .filter(Boolean)
      .filter((row) => !roomId || Number(row.roomId || 0) === Number(roomId || 0));
  }

  queryChatRowsWithRawRecovery(options = {}) {
    const roomId = Number(options.roomId || 0);
    const daysBack = Math.max(1, Math.min(31, Number(options.daysBack || 3)));
    const days = Array.from({ length: daysBack }, (_, index) => dateOffset(-index));
    const onParseError = (filePath) => this.recordParseFailure(filePath);
    const eventRows = chatEventRowsFromEntries(
      days.flatMap((day) => readJsonl(this.eventPath(day), { kinds: new Set(["chat"]), onParseError }))
    ).filter((row) => !roomId || Number(row.roomId || 0) === roomId);
    const rawRows = this.readRawChatRows(days, roomId);
    // 按文本建索引再匹配，避免 raw×event 双层遍历
    const eventsByText = new Map();
    for (const event of eventRows) {
      const text = chatTextFromEvent(event);
      if (!text) continue;
      const list = eventsByText.get(text) || [];
      list.push(event);
      eventsByText.set(text, list);
    }
    const recoveredRows = [];
    for (const raw of rawRows) {
      const rawText = cleanChatText(raw.text);
      const candidates = rawText ? eventsByText.get(rawText) || [] : [];
      const rawAt = Number(raw.at || 0);
      const matched = candidates.some((event) => {
        const eventAt = Number(event.at || 0);
        if (!rawAt || !eventAt) return true;
        return Math.abs(rawAt - eventAt) <= 10000;
      });
      if (!matched) {
        recoveredRows.push(raw);
      }
    }
    return {
      days,
      rows: [...eventRows, ...recoveredRows].sort((left, right) => Number(left.at || 0) - Number(right.at || 0)),
      eventCount: eventRows.length,
      rawCount: rawRows.length,
      rawRecovered: recoveredRows.length,
      identityLimited: recoveredRows.some((row) => row.identityLimited || row.isMaskedName),
    };
  }

  queryGiftRows(options = {}) {
    const keyword = options.giftName || "";
    const userName = options.userName || "";
    const roomId = Number(options.roomId || 0);
    const blindOnly = Boolean(options.blindOnly);
    const latestById = new Map();
    const looseRows = [];
    for (const gift of this.readEvents({ range: options.range, kinds: ["gift"] })
      .filter((entry) => !roomId || Number(entry.roomId || 0) === roomId)
      .map((entry) => entry.payload || entry)
      .filter((gift) => !isSimulatedEventPayload(gift))
      .filter((gift) => giftMatchesKeyword(gift, keyword))
      .filter((gift) => !blindOnly || isBlindGift(gift))
      .filter((gift) => includesText(gift.userName || gift.displayUserName, userName))) {
      if (gift.id && !isNoticeGift(gift)) {
        latestById.set(gift.id, gift);
      } else {
        looseRows.push(gift);
      }
    }
    const gifts = removeDuplicateNoticeGifts([...latestById.values(), ...looseRows]).sort(
      (left, right) => Number(left.at || 0) - Number(right.at || 0)
    );
    return gifts;
  }

  queryGifts(options = {}) {
    return summarizeGifts(this.queryGiftRows(options));
  }

  queryGuards(options = {}) {
    const now = Date.now();
    const roomId = Number(options.roomId || 0);
    const guards = this.readEvents({ range: options.range || "month", kinds: ["guard"] })
      .filter((entry) => !roomId || Number(entry.roomId || 0) === roomId)
      .map((entry) => entry.payload || entry)
      .filter((item) => !isSimulatedEventPayload(item))
      .filter((item) => includesText(item.userName, options.userName || ""));
    const latestByUser = new Map();
    for (const guard of guards) {
      const key = String(guard.userId || guard.userName || "");
      const prev = latestByUser.get(key);
      if (!prev || Number(guard.expiresAt || 0) > Number(prev.expiresAt || 0)) {
        latestByUser.set(key, guard);
      }
    }
    for (const guard of this.queryManualGuards({ roomId, userName: options.userName || "" }).rows || []) {
      const key = String(guard.userId || guard.userName || "");
      if (!key) continue;
      latestByUser.set(key, guard);
    }
    const rows = [...latestByUser.values()]
      .map((item) => ({
        ...item,
        expired: Number(item.expiresAt || 0) > 0 && Number(item.expiresAt) < now,
        daysLeft: item.expiresAt
          ? Math.ceil((Number(item.expiresAt) - now) / 86400000)
          : null,
      }))
      .sort((left, right) => Number(left.expiresAt || 0) - Number(right.expiresAt || 0));
    return {
      total: rows.length,
      expiring: rows.filter((item) => item.daysLeft !== null && item.daysLeft <= 7 && item.daysLeft >= 0),
      expired: rows.filter((item) => item.expired),
      rows,
    };
  }

  queryChatCounts(options = {}) {
    const roomId = Number(options.roomId || 0);
    const userId = Number(options.userId || 0);
    const userName = String(options.userName || "").trim();
    const daysBack = Math.max(1, Math.min(31, Number(options.daysBack || 3)));
    const recovered = this.queryChatRowsWithRawRecovery({ roomId, daysBack });
    const days = recovered.days;
    const rows = days.map((day) => ({
      day,
      count: 0,
    }));
    const rowByDay = new Map(rows.map((row) => [row.day, row]));
    let rawRecovered = 0;
    let identityLimited = false;
    for (const chat of recovered.rows) {
      const sameUser =
        (userId && Number(chat.userId || 0) === userId) ||
        (userName && includesText(chat.userName || chat.displayUserName, userName));
      if (!sameUser) continue;
      if (chat.rawRecovered) rawRecovered += 1;
      if (chat.identityLimited || chat.isMaskedName) identityLimited = true;
      const row = rowByDay.get(chat.day || dayKey(chat.at));
      if (row) row.count += 1;
    }
    return {
      mode: "user",
      userName,
      userId,
      rows,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      source: rawRecovered ? "events+raw_replay" : "events",
      eventCount: recovered.eventCount,
      rawCount: recovered.rawCount,
      rawRecovered,
      identityLimited,
      note: rawRecovered
        ? `已从原始弹幕补回 ${rawRecovered} 条；补回部分昵称可能仍是星号，完整身份需网页核对。`
        : "",
    };
  }

  queryChatSummary(options = {}) {
    const roomId = Number(options.roomId || 0);
    const daysBack = Math.max(1, Math.min(31, Number(options.daysBack || 3)));
    const recovered = this.queryChatRowsWithRawRecovery({ roomId, daysBack });
    const days = recovered.days;
    const rows = days.map((day) => ({
      day,
      count: 0,
    }));
    const rowByDay = new Map(rows.map((row) => [row.day, row]));
    const users = new Map();
    const words = new Map();
    const messages = new Map();
    let total = 0;
    let rawRecovered = 0;

    for (const chat of recovered.rows) {
      const text = chatTextFromEvent(chat);
      if (!text) continue;
      if (chat.rawRecovered) rawRecovered += 1;
      const row = rowByDay.get(chat.day || dayKey(chat.at));
      if (row) row.count += 1;
      total += 1;

      const userKey = String(chat.userId || chatUserName(chat));
      const user = users.get(userKey) || {
        userId: Number(chat.userId || 0),
        userName: chatUserName(chat),
        count: 0,
      };
      user.count += 1;
      users.set(userKey, user);

      for (const token of tokenizeChatText(text)) {
        words.set(token, (words.get(token) || 0) + 1);
      }

      const messageKey = text.replace(/\s+/g, "");
      if (messageKey.length >= 2 && messageKey.length <= 120) {
        const message = messages.get(messageKey) || { text, count: 0 };
        message.count += 1;
        messages.set(messageKey, message);
      }
    }

    return {
      mode: "summary",
      daysBack,
      rows,
      total,
      source: rawRecovered ? "events+raw_replay" : "events",
      eventCount: recovered.eventCount,
      rawCount: recovered.rawCount,
      rawRecovered,
      identityLimited: recovered.identityLimited,
      note: rawRecovered
        ? `已从原始弹幕补回 ${rawRecovered} 条；补回部分昵称可能仍是星号，完整身份需网页核对。`
        : "",
      activeUserCount: users.size,
      topUsers: [...users.values()]
        .sort((left, right) => right.count - left.count || String(left.userName).localeCompare(String(right.userName), "zh-Hans-CN"))
        .slice(0, 10)
        .map((item, index) => ({ rank: index + 1, ...item })),
      topWords: [...words.entries()]
        .map(([word, count]) => ({ word, count }))
        .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word, "zh-Hans-CN"))
        .slice(0, 12),
      topMessages: [...messages.values()]
        .filter((item) => item.count > 1)
        .sort((left, right) => right.count - left.count || left.text.localeCompare(right.text, "zh-Hans-CN"))
        .slice(0, 8),
    };
  }
}

function summarizeGifts(gifts = []) {
  const users = new Map();
  const names = new Map();
  const sourceNames = new Map();
  const resultNames = new Map();
  let totalCoin = 0;
  let totalGiftCount = 0;
  const blindBoxes = {
    count: 0,
    sourceCoin: 0,
    resultCoin: 0,
  };

  for (const gift of gifts) {
    const coin = gift.coinType === "silver" ? 0 : Number(gift.totalCoin || 0);
    const count = Number(gift.count || 1);
    totalCoin += coin;
    totalGiftCount += count;
    const userKey = String(gift.userId || gift.userName || "unknown");
    const user = users.get(userKey) || {
      userName: gift.userName || gift.displayUserName || "匿名用户",
      totalCoin: 0,
      count: 0,
    };
    user.totalCoin += coin;
    user.count += count;
    users.set(userKey, user);

    const giftName = gift.giftName || "礼物";
    const item = names.get(giftName) || {
      giftName,
      count: 0,
      totalCoin: 0,
    };
    item.count += count;
    item.totalCoin += coin;
    names.set(giftName, item);

    if (isBlindGift(gift)) {
      const sourceGiftName = gift.sourceGiftName || gift.blindGift?.originalGiftName || "盲盒";
      const sourcePrice = Number(gift.sourceGiftPrice || gift.blindGift?.originalGiftPrice || 0);
      const resultPrice = Number(gift.resultGiftPrice || gift.blindGift?.resultPrice || gift.price || 0);
      const sourceCoin = sourcePrice ? sourcePrice * count : coin;
      const resultCoin = resultPrice ? resultPrice * count : coin;
      blindBoxes.count += count;
      blindBoxes.sourceCoin += sourceCoin;
      blindBoxes.resultCoin += resultCoin;

      const sourceItem = sourceNames.get(sourceGiftName) || {
        giftName: sourceGiftName,
        count: 0,
        totalCoin: 0,
      };
      sourceItem.count += count;
      sourceItem.totalCoin += sourceCoin;
      sourceNames.set(sourceGiftName, sourceItem);

      const resultItem = resultNames.get(giftName) || {
        giftName,
        count: 0,
        totalCoin: 0,
      };
      resultItem.count += count;
      resultItem.totalCoin += resultCoin;
      resultNames.set(giftName, resultItem);
    }
  }

  const topUsers = [...users.values()]
    .sort((left, right) => right.totalCoin - left.totalCoin)
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
      valueText: formatBattery(item.totalCoin) || "0电池",
    }));
  const topGifts = [...names.values()]
    .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
      valueText: formatBattery(item.totalCoin) || "0电池",
    }));
  const topBlindSources = [...sourceNames.values()]
    .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
      valueText: formatBattery(item.totalCoin) || "0电池",
    }));
  const topBlindResults = [...resultNames.values()]
    .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
    .slice(0, 10)
    .map((item, index) => ({
      rank: index + 1,
      ...item,
      valueText: formatBattery(item.totalCoin) || "0电池",
    }));
  const blindDeltaCoin = blindBoxes.resultCoin - blindBoxes.sourceCoin;

  return {
    totalCoin,
    totalValueText: formatBattery(totalCoin) || "0电池",
    totalGiftCount,
    topUsers,
    topGifts,
    blindBoxes: {
      ...blindBoxes,
      sourceValueText: formatBattery(blindBoxes.sourceCoin) || "0电池",
      resultValueText: formatBattery(blindBoxes.resultCoin) || "0电池",
      deltaCoin: blindDeltaCoin,
      deltaValueText: `${blindDeltaCoin >= 0 ? "+" : "-"}${formatBattery(Math.abs(blindDeltaCoin)) || "0电池"}`,
      topSources: topBlindSources,
      topResults: topBlindResults,
    },
    quality: giftDataQuality(gifts),
    giftFeed: gifts.slice(-40).reverse().map(compactGiftFeedItem),
  };
}

module.exports = {
  EventStore,
  summarizeGifts,
  dayKey,
  monthKey,
  parseRange,
};
