"use strict";

const fs = require("node:fs");
const path = require("node:path");

const GIFT_CONFIG_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/giftConfig";
const ROOM_GIFT_URL =
  "https://api.live.bilibili.com/xlive/web-room/v1/giftPanel/roomGiftList";

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

function normalizeGift(item = {}) {
  const id = firstNumber(item.id, item.gift_id, item.giftId);
  if (!id) return null;
  return {
    id,
    giftId: id,
    name: firstString(item.name, item.gift_name, item.giftName),
    price: firstNumber(item.price, item.r_price),
    coinType: firstString(item.coin_type, item.coinType, "gold"),
    icon: firstString(item.webp, item.img_dynamic, item.img_basic, item.gif, item.icon),
    imgBasic: firstString(item.img_basic),
    webp: firstString(item.webp),
    gif: firstString(item.gif),
    type: Number(item.type || 0),
    bagGift: Number(item.bag_gift || 0),
    effect: Number(item.effect || 0),
    desc: firstString(item.desc, item.rights),
    roomAvailable: Boolean(item.roomAvailable || item.room_available),
  };
}

function addNameCandidate(map, gift) {
  if (!gift?.name) return;
  const key = gift.name;
  const list = map.get(key) || [];
  list.push(gift);
  map.set(key, list);
}

function giftNameCandidates(name = "") {
  const raw = firstString(name);
  if (!raw) return [];
  const candidates = [raw];
  for (const part of raw.split(/[，,、+＋/|]/)) {
    const text = firstString(part);
    if (!text) continue;
    candidates.push(text);
    const withoutCount = text
      .replace(/\s*[xX][0-9０-９一二三四五六七八九十百千万]+$/u, "")
      .replace(/\s*[xX][lL]$/u, "")
      .trim();
    if (withoutCount && withoutCount !== text) candidates.push(withoutCount);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function pickGiftCandidate(candidates = [], query = {}) {
  if (!candidates.length) return null;
  const price = firstNumber(query.price, query.giftPrice);
  const coinType = firstString(query.coinType, query.coin_type);
  const score = (gift) => {
    let value = 0;
    if (gift.roomAvailable) value += 12;
    if (coinType && gift.coinType === coinType) value += 4;
    if (price && Number(gift.price || 0) === price) value += 10;
    if (price && Number(gift.price || 0) && Math.abs(Number(gift.price) - price) <= 1) value += 6;
    if (gift.webp || gift.icon) value += 1;
    return value;
  };
  return candidates.slice().sort((left, right) => score(right) - score(left) || Number(right.id || 0) - Number(left.id || 0))[0] || null;
}

function collectRoomGiftIds(data = {}) {
  const root = data.gift_data || data;
  const roomGiftList = root.room_gift_list || data.room_gift_list || {};
  const lists = [
    roomGiftList.gold_list,
    roomGiftList.silver_list,
    roomGiftList.blind_box_list,
    roomGiftList.special_list,
  ].filter(Array.isArray);
  const ids = new Set();
  for (const list of lists) {
    for (const item of list) {
      const id = firstNumber(item.gift_id, item.id, item.giftId);
      if (id) ids.add(id);
    }
  }
  return ids;
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

class GiftCatalog {
  constructor(options = {}) {
    this.eventStore = options.eventStore || null;
    this.byId = new Map();
    this.byName = new Map();
    this.roomGiftIds = new Set();
    this.roomId = 0;
    this.fetchedAt = 0;
    this.persistedLoadAttempted = false;
    this.loadPersisted();
  }

  loadPersisted() {
    this.persistedLoadAttempted = true;
    if (!this.eventStore?.snapshotDir) return false;
    const filePath = path.join(this.eventStore.snapshotDir, "giftCatalog.json");
    if (!fs.existsSync(filePath)) return false;
    try {
      const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const snapshot = payload.giftCatalog || {};
      const gifts = Array.isArray(snapshot.items) ? snapshot.items : [];
      if (!gifts.length) return false;
      const nextById = new Map();
      const nextByName = new Map();
      for (const gift of gifts.map(normalizeGift).filter(Boolean)) {
        nextById.set(gift.id, gift);
        addNameCandidate(nextByName, gift);
      }
      this.byId = nextById;
      this.byName = nextByName;
      this.roomId = Number(snapshot.roomId || 0);
      this.fetchedAt = Number(snapshot.fetchedAt || payload.at || 0);
      this.roomGiftIds = new Set(
        gifts.filter((gift) => gift.roomAvailable).map((gift) => Number(gift.id || gift.giftId || 0)).filter(Boolean)
      );
      for (const giftId of this.roomGiftIds) {
        const gift = this.byId.get(giftId);
        if (gift) gift.roomAvailable = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  async refresh(roomId = 0) {
    const id = Number(roomId || 0);
    const configUrl = `${GIFT_CONFIG_URL}?room_id=${encodeURIComponent(id)}&platform=pc`;
    const roomUrl = `${ROOM_GIFT_URL}?room_id=${encodeURIComponent(id)}&platform=pc`;
    const [configResult, roomResult] = await Promise.allSettled([
      fetchJson(configUrl),
      fetchJson(roomUrl),
    ]);

    if (configResult.status !== "fulfilled") {
      throw configResult.reason;
    }

    const gifts = Array.isArray(configResult.value.list) ? configResult.value.list : [];
    const nextById = new Map();
    const nextByName = new Map();
    for (const gift of gifts.map(normalizeGift).filter(Boolean)) {
      nextById.set(gift.id, gift);
      addNameCandidate(nextByName, gift);
    }

    const roomGiftIds =
      roomResult.status === "fulfilled" ? collectRoomGiftIds(roomResult.value) : new Set();
    for (const giftId of roomGiftIds) {
      const gift = nextById.get(giftId);
      if (gift) gift.roomAvailable = true;
    }

    this.byId = nextById;
    this.byName = nextByName;
    this.roomGiftIds = roomGiftIds;
    this.roomId = id;
    this.fetchedAt = Date.now();
    this.persist();
    return this.getSnapshot();
  }

  enrichGift(event = {}) {
    const id = Number(event.giftId || event.gift_id || 0);
    const gift =
      this.byId.get(id) ||
      pickGiftCandidate(this.byName.get(event.giftName || "") || [], event);
    if (!gift) return event;
    const count = Number(event.count || 1);
    const coinType = event.coinType || gift.coinType || "gold";
    const price = Number(event.price || gift.price || 0);
    const totalCoin = firstNumber(event.totalCoin, price * count);
    return {
      ...event,
      giftId: event.giftId || gift.id,
      giftName: event.giftName || gift.name,
      giftIcon: event.giftIcon || gift.icon,
      price,
      totalCoin,
      coinType,
      catalogGift: gift,
    };
  }

  findGift(query = {}) {
    // 只在还没尝试过时补读一次快照，避免目录为空时每个礼物事件都白做磁盘探测
    if (!this.byId.size && !this.byName.size && !this.persistedLoadAttempted) this.loadPersisted();
    const id = Number(query.giftId || query.id || 0);
    if (id && this.byId.has(id)) return this.byId.get(id);
    const name = query.giftName || query.name || "";
    for (const candidate of giftNameCandidates(name)) {
      const gift = pickGiftCandidate(this.byName.get(candidate) || [], query);
      if (gift) return gift;
    }
    return null;
  }

  getSnapshot() {
    const items = [...this.byId.values()];
    return {
      roomId: this.roomId,
      fetchedAt: this.fetchedAt,
      total: items.length,
      roomGiftCount: this.roomGiftIds.size,
      items,
    };
  }

  getSummary() {
    return {
      roomId: this.roomId,
      fetchedAt: this.fetchedAt,
      total: this.byId.size,
      roomGiftCount: this.roomGiftIds.size,
    };
  }

  persist() {
    if (!this.eventStore) return;
    this.eventStore.writeSnapshot("giftCatalog", {
      giftCatalog: this.getSnapshot(),
    });
  }
}

module.exports = {
  GiftCatalog,
};
