"use strict";

const ROOM_INIT_URL = "https://api.live.bilibili.com/room/v1/Room/room_init";
const MASTER_INFO_URL = "https://api.live.bilibili.com/live_user/v1/Master/info";
const GUARD_TOP_URL = "https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topListNew";
const ONLINE_GOLD_RANK_URL = "https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank";

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

function parseDisplayNumber(value) {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value).replace(/,/g, "").trim();
  const match = text.match(/(-?\d+(?:\.\d+)?)/);
  if (!match) return 0;
  let number = Number(match[1]);
  if (!Number.isFinite(number)) return 0;
  if (/万/.test(text)) number *= 10000;
  return number;
}

async function fetchJson(url, timeoutMs = 8000) {
  // 不设超时的话接口挂起会让 investigate 永远 pending，连带卡死上游的 inFlight 状态
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

function normalizeRankItem(item = {}, index = 0) {
  const uinfo = item.uinfo || item.user_info || {};
  const base = uinfo.base || {};
  const medal = uinfo.medal || item.medal_info || {};
  return {
    rank: firstNumber(item.rank, item.user_rank, index + 1),
    uid: firstNumber(item.uid, uinfo.uid),
    uname: firstString(item.uname, item.name, base.origin_info?.name, base.name),
    score: firstNumber(
      item.score,
      item.value,
      item.contribution,
      parseDisplayNumber(item.score_text),
      parseDisplayNumber(item.value_text),
      parseDisplayNumber(item.contribution_text)
    ),
    guardLevel: firstNumber(item.guard_level, uinfo.guard?.level, medal.guard_level),
  };
}

function normalizeGuardItem(item = {}, index = 0) {
  const uinfo = item.uinfo || item.user_info || {};
  const base = uinfo.base || {};
  const guard = uinfo.guard || {};
  const medal = uinfo.medal || item.medal_info || {};
  return {
    rank: firstNumber(item.rank, item.user_rank, index + 1),
    uid: firstNumber(item.uid, uinfo.uid),
    uname: firstString(item.uname, item.name, base.origin_info?.name, base.name),
    face: firstString(item.face, base.origin_info?.face, base.face),
    guardLevel: firstNumber(item.guard_level, guard.level, medal.guard_level),
    days: firstNumber(item.day, item.days, item.guard_days, guard.days),
  };
}

class PkInvestigator {
  constructor(options = {}) {
    this.cacheMs = Number(options.cacheMs || 30000);
    this.timeoutMs = Number(options.timeoutMs || 8000);
    this.maxCacheEntries = Number(options.maxCacheEntries || 64);
    this.cache = new Map();
  }

  pruneCache() {
    const now = Date.now();
    for (const [key, item] of this.cache) {
      if (now - Number(item.at || 0) >= this.cacheMs) this.cache.delete(key);
    }
    if (this.cache.size <= this.maxCacheEntries) return;
    const excess = this.cache.size - this.maxCacheEntries;
    let removed = 0;
    for (const key of this.cache.keys()) {
      if (removed >= excess) break;
      this.cache.delete(key);
      removed += 1;
    }
  }

  async investigate(roomId = 0) {
    const targetRoomId = Number(roomId || 0);
    if (!targetRoomId) return null;
    const cached = this.cache.get(targetRoomId);
    if (cached && Date.now() - cached.at < this.cacheMs) return cached.value;

    const room = await fetchJson(`${ROOM_INIT_URL}?id=${encodeURIComponent(targetRoomId)}`, this.timeoutMs);
    const ruid = firstNumber(room.uid, room.room_uid);
    if (!ruid) throw new Error("对手房间没有返回主播 UID");

    const [masterResult, guardResult, rankResult] = await Promise.allSettled([
      fetchJson(`${MASTER_INFO_URL}?uid=${encodeURIComponent(ruid)}`, this.timeoutMs),
      fetchJson(
        `${GUARD_TOP_URL}?${new URLSearchParams({
          roomid: String(targetRoomId),
          ruid: String(ruid),
          page: "1",
          page_size: "30",
        })}`,
        this.timeoutMs
      ),
      fetchJson(
        `${ONLINE_GOLD_RANK_URL}?${new URLSearchParams({
          ruid: String(ruid),
          roomId: String(targetRoomId),
          page: "1",
          pageSize: "50",
        })}`,
        this.timeoutMs
      ),
    ]);

    const master = masterResult.status === "fulfilled" ? masterResult.value : {};
    const guard = guardResult.status === "fulfilled" ? guardResult.value : {};
    const rank = rankResult.status === "fulfilled" ? rankResult.value : {};
    const info = master.info || {};
    const guardRows = [
      ...(Array.isArray(guard.top3) ? guard.top3 : []),
      ...(Array.isArray(guard.list) ? guard.list : []),
    ].map(normalizeGuardItem).filter((item) => item.uname || item.uid);
    const guardCounts = guardRows.reduce(
      (acc, row) => {
        const level = Number(row.guardLevel || 0);
        if (level >= 1 && level <= 3) acc[level] = (acc[level] || 0) + 1;
        return acc;
      },
      { 1: 0, 2: 0, 3: 0 }
    );
    const rankRows = (rank.online_rank_item || rank.onlineRankItem || rank.list || [])
      .map(normalizeRankItem)
      .filter((item) => item.uname || item.uid);
    const topScore = rankRows.slice(0, 50).reduce((sum, item) => sum + Number(item.score || 0), 0);
    const onlineGuardCount = rankRows.filter((item) => Number(item.guardLevel || 0) > 0).length;

    const value = {
      roomId: targetRoomId,
      uid: ruid,
      uname: firstString(info.uname, info.name, room.uname),
      face: firstString(info.face, room.face),
      fans: firstNumber(master.follower_num, master.followerNum, info.follower_num),
      guardCount: firstNumber(guard.info?.num, guardRows.length),
      guardCounts,
      guardTop: guardRows.slice(0, 6),
      onlineRankCount: firstNumber(rank.onlineNum, rank.online_num, rankRows.length),
      onlineGuardCount,
      topScore,
      topRank: rankRows.slice(0, 5),
      source: "http_investigation",
      partialFailures: [
        masterResult.status === "rejected" ? "主播信息" : "",
        guardResult.status === "rejected" ? "大航海榜" : "",
        rankResult.status === "rejected" ? "高能榜" : "",
      ].filter(Boolean),
      fetchedAt: Date.now(),
    };
    this.cache.set(targetRoomId, { at: Date.now(), value });
    this.pruneCache();
    return value;
  }
}

module.exports = {
  PkInvestigator,
};
