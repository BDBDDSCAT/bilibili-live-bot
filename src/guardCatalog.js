"use strict";

const { formatBattery } = require("./interactionEngine");

const GUARD_TOP_LIST_URL =
  "https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topListNew";

const GUARD_LEVELS = {
  1: {
    guardLevel: 1,
    guardName: "总督",
    defaultPrice: 19998000,
    color: "#d47aff",
    icon: "",
  },
  2: {
    guardLevel: 2,
    guardName: "提督",
    defaultPrice: 1998000,
    color: "#8f68ff",
    icon: "",
  },
  3: {
    guardLevel: 3,
    guardName: "舰长",
    defaultPrice: 198000,
    color: "#58a1f8",
    icon: "https://i0.hdslb.com/bfs/live/48360c8f3b7de8031e86ff1ef4a2dfc0ec2a61c2.png",
  },
};

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function cleanImageUrl(url) {
  return String(url || "").trim().replace(/^J(?=https?:\/\/)/, "");
}

function findImageUrlDeep(value, seen = new Set()) {
  if (!value) return "";
  if (typeof value === "string") {
    const image = value.match(/https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif|avif)/i);
    return cleanImageUrl(image?.[0] || "");
  }
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  for (const key of ["url", "src", "value", "frame_img", "face_frame", "frame_url", "image"]) {
    const image = findImageUrlDeep(value[key], seen);
    if (image) return image;
  }
  for (const item of Object.values(value)) {
    const image = findImageUrlDeep(item, seen);
    if (image) return image;
  }
  return "";
}

function normalizeAvatarFrame(frame = {}) {
  const url = findImageUrlDeep(frame);
  if (!url) return null;
  return {
    id: firstNumber(frame.id, frame.frame_id),
    url,
    name: firstString(frame.name, frame.frame_name, frame.title, frame.desc),
    raw: frame,
  };
}

function guardLevelInfo(level = 0) {
  const value = Number(level || 0);
  return GUARD_LEVELS[value] || {
    guardLevel: value,
    guardName: "大航海",
    defaultPrice: 0,
    color: "#58a1f8",
    icon: "",
  };
}

function parseDaysLeft(text = "") {
  const value = String(text || "").trim();
  if (!value) return null;
  if (/已过期|已掉|过期/.test(value)) return -1;
  const match = value.match(/(\d{1,4})\s*天/);
  if (match) return Number(match[1]);
  return null;
}

function normalizeGuardRow(item = {}) {
  const uinfo = item.uinfo || {};
  const base = uinfo.base || {};
  const medal = uinfo.medal || item.medal_info || {};
  const guard = uinfo.guard || {};
  const avatarFrame = normalizeAvatarFrame(uinfo.uhead_frame || item.uhead_frame || item.face_frame);
  const guardLevel = firstNumber(item.guard_level, guard.level, medal.guard_level);
  const info = guardLevelInfo(guardLevel);
  const userName = firstString(item.username, item.name, base.origin_info?.name, base.name);
  const face = firstString(item.face, base.origin_info?.face, base.face);
  const expiredText = firstString(item.expired_str, guard.expired_str);
  const daysLeft = parseDaysLeft(expiredText);
  return {
    userId: firstNumber(item.uid, uinfo.uid),
    userName,
    face,
    rank: firstNumber(item.rank, item.user_rank),
    guardLevel,
    guardName: info.guardName,
    guardIcon: firstString(medal.guard_icon, info.icon),
    medalName: firstString(item.medal_name, item.medal_info?.medal_name, medal.name),
    medalLevel: firstNumber(item.level, item.medal_info?.medal_level, medal.level),
    avatarFrame,
    avatarFrameUrl: avatarFrame?.url || "",
    avatarFrameName: avatarFrame?.name || "",
    accompany: firstNumber(item.accompany),
    score: firstNumber(item.score),
    expiredText,
    daysLeft,
    expired: daysLeft !== null && daysLeft < 0,
    defaultPrice: info.defaultPrice,
    valueText: formatBattery(info.defaultPrice, "gold") || "",
  };
}

async function fetchJson(url, timeoutMs = 8000) {
  // 不设超时的话接口挂起会让 refresh 永远 pending
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      Referer: "https://live.bilibili.com/",
    },
    signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 8000)),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0) throw new Error(payload.message || `code ${payload.code}`);
  return payload.data || {};
}

function toRows(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

class GuardCatalog {
  constructor(options = {}) {
    this.eventStore = options.eventStore || null;
    this.roomId = 0;
    this.ruid = 0;
    this.fetchedAt = 0;
    this.info = {};
    this.rows = [];
    this.byLevel = GUARD_LEVELS;
    this.buyGuardIcon = "";
    this.failedPages = 0;
    this.loadPersisted();
  }

  loadPersisted() {
    if (!this.eventStore?.readSnapshot) return false;
    const payload = this.eventStore.readSnapshot("guardCatalog");
    const snapshot = payload.guardCatalog || {};
    const rows = Array.isArray(snapshot.rows)
      ? snapshot.rows.filter((row) => row && (row.userName || row.userId))
      : [];
    if (!rows.length && !Number(snapshot.roomId || 0)) return false;
    this.roomId = Number(snapshot.roomId || 0);
    this.ruid = Number(snapshot.ruid || 0);
    this.fetchedAt = Number(snapshot.fetchedAt || payload.at || 0);
    this.info = snapshot.info && typeof snapshot.info === "object" ? snapshot.info : {};
    this.buyGuardIcon = firstString(snapshot.buyGuardIcon, this.info.buy_guard_icon_src);
    this.rows = rows;
    return true;
  }

  async refresh({ roomId = 0, ruid = 0 } = {}) {
    const targetRoomId = Number(roomId || 0);
    const targetRuid = Number(ruid || 0);
    if (!targetRoomId || !targetRuid) return this.getSnapshot();

    const firstUrl = this.buildUrl(targetRoomId, targetRuid, 1);
    const firstPage = await fetchJson(firstUrl);
    const pageCount = Math.min(50, Math.max(1, Number(firstPage.info?.page || 1)));
    const pages = [firstPage];
    let failedPages = 0;
    if (pageCount > 1) {
      // 分批 3 并发拉取，避免几十页一起打过去触发风控
      const pageNumbers = Array.from({ length: pageCount - 1 }, (_, index) => index + 2);
      for (let start = 0; start < pageNumbers.length; start += 3) {
        const batch = await Promise.allSettled(
          pageNumbers
            .slice(start, start + 3)
            .map((page) => fetchJson(this.buildUrl(targetRoomId, targetRuid, page)))
        );
        for (const result of batch) {
          if (result.status === "fulfilled") pages.push(result.value);
          else failedPages += 1;
        }
      }
    }

    const rows = [];
    for (const page of pages) {
      rows.push(...toRows(page.top3).map(normalizeGuardRow));
      rows.push(...toRows(page.list).map(normalizeGuardRow));
    }
    const byUser = new Map();
    for (const row of rows.filter((item) => item.userName || item.userId)) {
      const key = String(row.userId || row.userName);
      const previous = byUser.get(key);
      if (!previous || Number(row.rank || 999999) < Number(previous.rank || 999999)) {
        byUser.set(key, row);
      }
    }

    this.roomId = targetRoomId;
    this.ruid = targetRuid;
    this.fetchedAt = Date.now();
    this.info = firstPage.info || {};
    this.buyGuardIcon = firstString(this.info.buy_guard_icon_src);
    this.failedPages = failedPages;
    this.rows = [...byUser.values()].sort(
      (left, right) => Number(left.rank || 999999) - Number(right.rank || 999999)
    );
    this.persist();
    return this.getSnapshot();
  }

  buildUrl(roomId, ruid, page) {
    const params = new URLSearchParams({
      roomid: String(roomId),
      ruid: String(ruid),
      page: String(page),
      page_size: "30",
    });
    return `${GUARD_TOP_LIST_URL}?${params.toString()}`;
  }

  enrichGuard(event = {}) {
    const guardLevel = Number(event.guardLevel || 0);
    const info = guardLevelInfo(guardLevel);
    const count = Math.max(1, Number(event.count || 1));
    const totalCoin = firstNumber(event.totalCoin, event.price, info.defaultPrice * count);
    return {
      ...event,
      guardLevel,
      guardName: event.guardName || info.guardName,
      guardIcon: event.guardIcon || info.icon || this.buyGuardIcon,
      price: firstNumber(event.price, info.defaultPrice),
      totalCoin,
      valueText: formatBattery(totalCoin, "gold") || "",
      catalogGuard: info,
    };
  }

  getBoard() {
    const rows = this.rows.map((row) => ({
      ...row,
      expired: Boolean(row.expired),
      daysLeft: row.daysLeft === undefined ? null : row.daysLeft,
    }));
    return {
      total: rows.length,
      expiring: rows.filter((item) => item.daysLeft !== null && item.daysLeft >= 0 && item.daysLeft <= 7),
      expired: rows.filter((item) => item.expired),
      rows,
      recent: [],
      source: "guardCatalog",
    };
  }

  getSnapshot() {
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (const row of this.rows) {
      if (counts[row.guardLevel] !== undefined) counts[row.guardLevel] += 1;
    }
    return {
      roomId: this.roomId,
      ruid: this.ruid,
      fetchedAt: this.fetchedAt,
      total: this.rows.length || Number(this.info.num || 0),
      counts,
      info: this.info,
      buyGuardIcon: this.buyGuardIcon,
      failedPages: this.failedPages,
      levels: Object.values(GUARD_LEVELS).map((item) => ({
        ...item,
        valueText: formatBattery(item.defaultPrice, "gold"),
      })),
      rows: this.rows,
    };
  }

  getSummary() {
    const snapshot = this.getSnapshot();
    return {
      roomId: snapshot.roomId,
      ruid: snapshot.ruid,
      fetchedAt: snapshot.fetchedAt,
      total: snapshot.total,
      counts: snapshot.counts,
    };
  }

  persist() {
    if (!this.eventStore) return;
    this.eventStore.writeSnapshot("guardCatalog", {
      guardCatalog: this.getSnapshot(),
    });
  }

  findUser(query = {}) {
    const uid = Number(query.userId || query.uid || 0);
    const face = cleanImageUrl(query.face || "");
    const name = firstString(query.userName, query.name, query.uname);
    const prefix = name.includes("***") ? name.split("***")[0] : "";
    const rows = this.rows || [];

    return (
      (uid ? rows.find((row) => Number(row.userId || 0) === uid) : null) ||
      (face ? rows.find((row) => cleanImageUrl(row.face) === face) : null) ||
      (name && !prefix ? rows.find((row) => row.userName === name) : null) ||
      (prefix
        ? rows.find((row) => String(row.userName || "").startsWith(prefix))
        : null) ||
      null
    );
  }
}

module.exports = {
  GuardCatalog,
  guardLevelInfo,
};
