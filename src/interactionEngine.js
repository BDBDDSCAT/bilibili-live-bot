"use strict";

const { normalizeText } = require("./ruleEngine");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function pick(value) {
  const list = toArray(value).filter(Boolean);
  if (list.length === 0) return "";
  return list[Math.floor(Math.random() * list.length)];
}

function formatNumber(value) {
  const number = Number(value || 0);
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatBattery(totalCoin, coinType = "gold") {
  const coin = Number(totalCoin || 0);
  if (!coin) return "";
  if (coinType === "silver") return `${coin}银瓜子`;

  const battery = coin / 100;
  return `${formatNumber(battery)}电池`;
}

function interpolate(template, values) {
  return String(template || "").replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

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

function eventTimeMs(event = {}) {
  const at = Number(event.at || 0);
  if (Number.isFinite(at) && at > 0) return at < 1000000000000 ? at * 1000 : at;
  const timestamp = Number(event.timestamp || event.raw?.data?.timestamp || event.raw?.timestamp || 0);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    return timestamp < 1000000000000 ? timestamp * 1000 : timestamp;
  }
  return Date.now();
}

function displayName(event, fallback = "新来的朋友") {
  const name = firstString(event.displayUserName, event.userName, event.uname)
    .replace(/[\x00-\x1f\x7f]+/g, "")
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .trim();
  if (!name || /\*{2,}/.test(name) || event.isMaskedName) return fallback;
  return name;
}

function stableGiftRecordId(event = {}, batchKey = "") {
  return firstString(
    event.id,
    batchKey,
    event.dedupeKey,
    event.raw?.msg_id,
    event.raw?.data?.tid,
    event.raw?.data?.rnd
  );
}

function stableSuperChatId(event = {}) {
  return (
    firstString(event.messageId, event.id, event.dedupeKey) ||
    String(event.raw?.data?.id ?? "")
  );
}

function localDayKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function guardExpiryEstimate(now, count, unit = "月") {
  const date = new Date(now);
  const unitText = String(unit || "月");
  if (/年/.test(unitText)) date.setMonth(date.getMonth() + count * 12);
  else if (/周/.test(unitText)) date.setDate(date.getDate() + count * 7);
  else if (/天|日/.test(unitText)) date.setDate(date.getDate() + count);
  else date.setMonth(date.getMonth() + count);
  return date.getTime();
}

function stableGuardRecordId(event = {}) {
  return firstString(
    event.id,
    event.dedupeKey,
    event.raw?.msg_id,
    event.raw?.data?.tid,
    event.raw?.data?.id,
    event.raw?.data?.order_id,
    [
      event.command || "GUARD_BUY",
      event.roomId || "",
      event.userId || event.uid || event.userName || "",
      event.guardLevel || "",
      event.count || 1,
      event.raw?.timestamp || event.timestamp || event.at || "",
    ].join(":")
  );
}

function guardNameFromLevel(level) {
  const value = Number(level || 0);
  if (value === 1) return "总督";
  if (value === 2) return "提督";
  if (value === 3) return "舰长";
  return "";
}

function hasUsefulFace(face = "") {
  return Boolean(String(face || "").trim() && !/\/bfs\/face\/member\/noface\.jpg/i.test(String(face || "")));
}

function giftDataQuality(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  const quality = {
    checkedRows: list.length,
    missingIcon: 0,
    zeroValue: 0,
    missingFace: 0,
    missingAvatarFrame: 0,
    affectedRows: 0,
    ok: true,
    summary: list.length ? "素材完整" : "暂无礼物流水",
  };

  for (const row of list) {
    const missingIcon = !row.giftIcon;
    const zeroValue = Number(row.totalCoin || 0) <= 0 && row.coinType !== "silver";
    const missingFace = !hasUsefulFace(row.face);
    const missingAvatarFrame =
      Number(row.guardLevel || 0) > 0 && !(row.avatarFrameUrl || row.avatarFrame?.url);
    if (missingIcon) quality.missingIcon += 1;
    if (zeroValue) quality.zeroValue += 1;
    if (missingFace) quality.missingFace += 1;
    if (missingAvatarFrame) quality.missingAvatarFrame += 1;
    if (missingIcon || zeroValue || missingFace || missingAvatarFrame) {
      quality.affectedRows += 1;
    }
  }

  quality.ok = quality.affectedRows === 0;
  if (!quality.ok) {
    quality.summary = `异常${quality.affectedRows}条：缺图${quality.missingIcon}，0价值${quality.zeroValue}，缺头像${quality.missingFace}，缺框${quality.missingAvatarFrame}`;
  }
  return quality;
}

function compactAvatarFrame(frame = null) {
  if (!frame || typeof frame !== "object") return null;
  const url = firstString(frame.url, frame.src, frame.value);
  if (!url) return null;
  return {
    id: firstNumber(frame.id, frame.frame_id),
    url,
    name: firstString(frame.name, frame.frame_name, frame.title, frame.desc),
    source: firstString(frame.source),
  };
}

function compactBlindGift(blindGift = null, item = {}) {
  if (!blindGift || typeof blindGift !== "object") return null;
  return {
    originalGiftId: firstNumber(
      blindGift.originalGiftId,
      blindGift.original_gift_id,
      item.sourceGiftId
    ),
    originalGiftName: firstString(
      blindGift.originalGiftName,
      blindGift.original_gift_name,
      item.sourceGiftName
    ),
    originalGiftPrice: Number(
      blindGift.originalGiftPrice ||
        blindGift.original_gift_price ||
        item.sourceGiftPrice ||
        0
    ),
    action: firstString(blindGift.action, blindGift.gift_action, item.action),
    resultPrice: Number(
      blindGift.resultPrice ||
        blindGift.gift_tip_price ||
        blindGift.result_price ||
        item.resultGiftPrice ||
        item.price ||
        0
    ),
    configId: firstNumber(blindGift.configId, blindGift.config_id, blindGift.blind_gift_config_id),
    from: blindGift.from ?? null,
  };
}

function compactGiftFeedItem(item = {}, index = 0) {
  const avatarFrame = compactAvatarFrame(item.avatarFrame) ||
    (item.avatarFrameUrl
      ? {
          id: 0,
          url: item.avatarFrameUrl,
          name: firstString(item.avatarFrameName),
          source: firstString(item.avatarFrameSource),
        }
      : null);
  return {
    id: firstString(item.id, item.dedupeKey, item.batchKey),
    rank: index + 1,
    at: Number(item.at || 0),
    userId: Number(item.userId || item.uid || 0),
    uid: Number(item.uid || item.userId || 0),
    userName: firstString(item.userName, item.displayUserName) || "匿名用户",
    displayUserName: firstString(item.displayUserName, item.userName) || "匿名用户",
    face: firstString(item.face),
    faceSource: firstString(item.faceSource),
    action: firstString(item.action) || "投喂",
    giftId: Number(item.giftId || 0),
    giftName: firstString(item.giftName) || "礼物",
    giftIcon: firstString(item.giftIcon, item.giftIconUrl),
    sourceGiftId: Number(item.sourceGiftId || item.blindGift?.originalGiftId || 0),
    sourceGiftName: firstString(item.sourceGiftName, item.blindGift?.originalGiftName),
    sourceGiftPrice: Number(item.sourceGiftPrice || item.blindGift?.originalGiftPrice || 0),
    resultGiftPrice: Number(item.resultGiftPrice || item.blindGift?.resultPrice || item.price || 0),
    inputTotalCoin: Number(item.inputTotalCoin || 0),
    outputTotalCoin: Number(item.outputTotalCoin || 0),
    profitCoin: Number(item.profitCoin || 0),
    blindGift: compactBlindGift(item.blindGift, item),
    count: Number(item.count || 1),
    totalCoin: Number(item.totalCoin || 0),
    valueText: item.valueText || formatBattery(item.totalCoin, item.coinType) || "0电池",
    coinType: firstString(item.coinType) || "gold",
    medalName: firstString(item.medalName),
    medalLevel: Number(item.medalLevel || 0),
    medalColors: item.medalColors || null,
    guardLevel: Number(item.guardLevel || 0),
    guardName: firstString(item.guardName),
    guardIcon: firstString(item.guardIcon),
    avatarFrame,
    avatarFrameUrl: firstString(item.avatarFrameUrl, avatarFrame?.url),
    avatarFrameName: firstString(item.avatarFrameName, avatarFrame?.name),
    avatarFrameSource: firstString(item.avatarFrameSource, avatarFrame?.source),
    wealthLevel: Number(item.wealthLevel || 0),
    source: firstString(item.source),
    sourceCommand: firstString(item.sourceCommand, item.command),
    isSimulated: Boolean(item.isSimulated),
    batchKey: firstString(item.batchKey),
  };
}

function mapLookup(mapLike, ...keys) {
  if (!mapLike || typeof mapLike !== "object" || Array.isArray(mapLike)) return "";
  for (const key of keys) {
    const value = mapLike[String(key || "")];
    if (value) return value;
  }
  return "";
}

function timeToMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2})(?::(\d{1,2}))?$/);
  if (!match) return null;
  return Math.max(0, Math.min(23, Number(match[1]))) * 60 + Math.max(0, Math.min(59, Number(match[2] || 0)));
}

function isCurrentTimeInBucket(bucket = {}, date = new Date()) {
  const start = timeToMinutes(bucket.start);
  const end = timeToMinutes(bucket.end);
  if (start === null || end === null) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  if (start <= end) return now >= start && now <= end;
  return now >= start || now <= end;
}

class InteractionEngine {
  constructor(config = {}) {
    this.config = config.interactions || {};
    if (config.modules?.giftThanks && this.config.gift) {
      this.config.gift = {
        ...this.config.gift,
        minCoin: this.config.gift.minCoin ?? config.modules.giftThanks.minCoin,
        minBattery: this.config.gift.minBattery ?? config.modules.giftThanks.minBattery,
      };
    }
    this.botNames = new Set(
      toArray(this.config.ignoreUsers || config.ignoreUsers).map(normalizeText)
    );
    this.ignoreNameIncludes = toArray(
      this.config.ignoreNameIncludes || config.ignoreNameIncludes || []
    )
      .map(normalizeText)
      .filter(Boolean);
    this.lastEmit = new Map();
    this.seenUsers = new Map();
    this.giftUsers = new Map();
    this.giftNames = new Map();
    this.giftBatches = new Map();
    this.giftFingerprints = new Map();
    this.giftFeed = [];
    this.giftFeedByBatch = new Map();
    this.lastGiftRecord = null;
    this.blindBoxStats = {
      count: 0,
      sourceCoin: 0,
      resultCoin: 0,
      sourceNames: new Map(),
      resultNames: new Map(),
    };
    this.guardUsers = new Map();
    this.guardFeed = [];
    this.lastGuardRecord = null;
    this.superChatSeenIds = new Map();
    this.superChatFingerprints = new Map();
    this.guardSeenIds = new Map();
    this.guardFingerprints = new Map();
    this.totalCoin = 0;
    this.totalGiftCount = 0;
    this.superChatTotal = 0;
    this.statsDay = localDayKey();
    this.lastSweepAt = 0;
    this.stateTtlMs = Math.max(1, Number(this.config.stateTtlHours || 24)) * 3600000;
    this.seenTtlMs = Math.max(1, Number(this.config.welcome?.seenTtlHours || 24)) * 3600000;
  }

  sweepState(now = Date.now()) {
    if (now - this.lastSweepAt < 60000) return;
    this.lastSweepAt = now;
    for (const [key, at] of this.lastEmit.entries()) {
      if (now - at > this.stateTtlMs) this.lastEmit.delete(key);
    }
    for (const [key, at] of this.seenUsers.entries()) {
      if (now - at > this.seenTtlMs) this.seenUsers.delete(key);
    }
    for (const [key, at] of this.superChatSeenIds.entries()) {
      if (now - at > 3600000) this.superChatSeenIds.delete(key);
    }
    for (const [key, at] of this.superChatFingerprints.entries()) {
      if (now - at > 600000) this.superChatFingerprints.delete(key);
    }
    for (const [key, at] of this.guardSeenIds.entries()) {
      if (now - at > 3600000) this.guardSeenIds.delete(key);
    }
    for (const [key, at] of this.guardFingerprints.entries()) {
      if (now - at > 60000) this.guardFingerprints.delete(key);
    }
    for (const [key, item] of this.guardUsers.entries()) {
      const expiresAt = Number(item?.expiresAt || 0);
      if (expiresAt > 0 && now - expiresAt > 60 * 86400000) this.guardUsers.delete(key);
    }
  }

  rolloverDailyStats(now = Date.now()) {
    const day = localDayKey(now);
    if (day === this.statsDay) return;
    this.statsDay = day;
    this.giftUsers = new Map();
    this.giftNames = new Map();
    this.blindBoxStats = {
      count: 0,
      sourceCoin: 0,
      resultCoin: 0,
      sourceNames: new Map(),
      resultNames: new Map(),
    };
    this.totalCoin = 0;
    this.totalGiftCount = 0;
    this.superChatTotal = 0;
  }

  shouldIgnoreUser(userName) {
    const name = normalizeText(userName);
    return (
      this.botNames.has(name) ||
      this.ignoreNameIncludes.some((keyword) => name.includes(keyword))
    );
  }

  canEmit(key, cooldownSec) {
    const now = Date.now();
    if (!this.checkCooldown(key, cooldownSec, now)) {
      return false;
    }
    this.markEmit(key, now);
    return true;
  }

  checkCooldown(key, cooldownSec, now = Date.now()) {
    const cooldownMs = Math.max(0, Number(cooldownSec || 0)) * 1000;
    if (cooldownMs <= 0) return true;
    const last = this.lastEmit.get(key) || 0;
    return now - last >= cooldownMs;
  }

  markEmit(key, now = Date.now()) {
    this.lastEmit.set(key, now);
  }

  makeAction(kind, event, options = {}) {
    const section = this.config[kind] || {};
    const template = options.template || pick(section.templates);
    const values = {
      user: displayName(event, this.config.maskedUserFallback || "新来的朋友"),
      text: event.text || "",
      giftName: event.giftName || "",
      sourceGiftName: event.sourceGiftName || event.blindGift?.originalGiftName || "",
      count: event.count || 1,
      value: event.valueText || "",
      battery: event.batteryText || event.valueText || "",
      price: event.price || "",
      guardName: event.guardName || "",
      wealthLevel: event.wealthLevel || "",
      likeCount: event.likeCount || "",
      message: event.message || event.text || "",
      roomId: event.roomId || "",
      opponent: event.opponentName || "",
    };
    const reply = interpolate(template, values).trim();
    if (!reply) return null;

    return {
      type: options.type || "reply",
      ruleName: options.ruleName || kind,
      reply,
      emotion: section.emotion || options.emotion || "calm",
      priority: section.priority || options.priority || 0,
    };
  }

  handleEnter(event) {
    const section = this.config.welcome || {};
    if (section.enabled === false || this.shouldIgnoreUser(event.userName)) {
      return [];
    }
    if (section.requireFullName && event.isMaskedName) {
      return [];
    }

    const normalizedName = normalizeText(displayName(event, event.userName || ""));
    const guardLevel = Number(event.guardLevel || 0);
    const blacklist = toArray(section.blacklist || section.exactBlacklist).map(normalizeText);
    const blacklistWide = toArray(section.blacklistIncludes || section.wideBlacklist).map(normalizeText);
    const guardIgnoresBlacklist = section.guardIgnoresBlacklist !== false && guardLevel > 0;
    if (
      !guardIgnoresBlacklist &&
      (blacklist.includes(normalizedName) || blacklistWide.some((keyword) => normalizedName.includes(keyword)))
    ) {
      return [];
    }

    const userKey = String(event.userId || event.userName || "");
    if (section.firstVisitOnly && this.seenUsers.has(userKey)) {
      return [];
    }

    const now = Date.now();
    this.sweepState(now);
    if (!this.checkCooldown(`welcome:${userKey}`, section.userCooldownSec || 300, now)) {
      return [];
    }
    if (!this.checkCooldown("welcome:global", section.cooldownSec || 3, now)) {
      return [];
    }

    const guardName = event.guardName || guardNameFromLevel(guardLevel);
    const template =
      mapLookup(section.specificTemplates, event.userId, event.displayUserName, event.userName) ||
      (guardName && mapLookup(section.guardTemplates, guardName, guardLevel)) ||
      (section.highWealth?.enabled &&
      Number(event.wealthLevel || 0) >= Number(section.highWealth.minLevel || 20)
        ? pick(section.highWealth.templates)
        : "") ||
      pick(
        toArray(section.timeBuckets)
          .filter((bucket) => bucket?.enabled !== false && isCurrentTimeInBucket(bucket))
          .flatMap((bucket) => toArray(bucket.templates || bucket.danmu))
      );
    const action = this.makeAction("welcome", event, { template });
    if (!action) return [];
    this.seenUsers.set(userKey, now);
    this.markEmit(`welcome:${userKey}`, now);
    this.markEmit("welcome:global", now);
    return [action];
  }

  handleFollow(event) {
    const section = this.config.follow || {};
    if (section.enabled === false || this.shouldIgnoreUser(event.userName)) {
      return [];
    }
    const userKey = String(event.userId || event.userName || "");
    const now = Date.now();
    this.sweepState(now);
    if (!this.checkCooldown(`follow:${userKey}`, section.userCooldownSec || 600, now)) {
      return [];
    }
    if (!this.checkCooldown("follow:global", section.cooldownSec || 10, now)) {
      return [];
    }
    const action = this.makeAction("follow", event, {
      ruleName: "follow",
      priority: section.priority || 80,
    });
    if (!action) return [];
    this.markEmit(`follow:${userKey}`, now);
    this.markEmit("follow:global", now);
    return [action];
  }

  handleShare(event) {
    const section = this.config.share || {};
    if (section.enabled === false || this.shouldIgnoreUser(event.userName)) {
      return [];
    }
    const userKey = String(event.userId || event.userName || "");
    const now = Date.now();
    this.sweepState(now);
    if (!this.checkCooldown(`share:${userKey}`, section.userCooldownSec || 600, now)) {
      return [];
    }
    if (!this.checkCooldown("share:global", section.cooldownSec || 10, now)) {
      return [];
    }
    const action = this.makeAction("share", event, {
      ruleName: "share",
      priority: section.priority || 75,
    });
    if (!action) return [];
    this.markEmit(`share:${userKey}`, now);
    this.markEmit("share:global", now);
    return [action];
  }

  handleGift(event) {
    this.lastGiftRecord = null;
    if (this.shouldIgnoreUser(event.userName)) {
      return [];
    }

    const totalCoin = firstNumber(
      event.totalCoin,
      Number(event.price || 0) * Number(event.count || 1)
    );
    const coinType = event.coinType || "gold";
    const giftName = event.giftName || "礼物";
    const count = Number(event.count || 1);
    const shownUserName = displayName(event, event.userName || "匿名用户");
    const now = eventTimeMs(event);
    const section = this.config.gift || {};
    this.pruneGiftDedupe(now);
    this.sweepState();
    this.rolloverDailyStats();

    const fingerprint = [
      normalizeText(event.roomId || ""),
      normalizeText(shownUserName),
      normalizeText(giftName),
      count,
      totalCoin,
      coinType,
    ].join(":");

    let deltaCount = count;
    let deltaCoin = coinType === "silver" ? 0 : totalCoin;
    const batchKey = event.dedupeKey || "";
    let previous = null;
    if (batchKey) {
      previous = this.giftBatches.get(batchKey);
      if (previous) {
        deltaCount = Math.max(0, count - previous.count);
        deltaCoin = Math.max(0, (coinType === "silver" ? 0 : totalCoin) - previous.totalCoin);
        if (deltaCount <= 0 && deltaCoin <= 0) {
          return [];
        }
      }
      this.giftBatches.set(batchKey, {
        count: Math.max(previous?.count || 0, count),
        totalCoin: Math.max(previous?.totalCoin || 0, coinType === "silver" ? 0 : totalCoin),
        at: now,
      });
    } else {
      const lastFingerprintAt = this.giftFingerprints.get(fingerprint) || 0;
      const fingerprintWindowMs = Math.max(100, Number(section.dedupeFingerprintWindowMs || 300));
      if (lastFingerprintAt && now - lastFingerprintAt < fingerprintWindowMs) {
        return [];
      }
      this.giftFingerprints.set(fingerprint, now);
    }

    this.totalCoin += deltaCoin;
    this.totalGiftCount += deltaCount;

    const masked = Boolean(event.isMaskedName) || /\*{2,}/.test(String(event.userName || ""));
    const userKey = event.userId
      ? String(event.userId)
      : masked
        ? "__anon__"
        : String(shownUserName || event.userName || "unknown");
    const bucketName =
      userKey === "__anon__" ? "匿名用户" : shownUserName || event.userName || "匿名用户";
    const userStats = this.giftUsers.get(userKey) || {
      userName: bucketName,
      totalCoin: 0,
      count: 0,
    };
    userStats.userName = bucketName || userStats.userName;
    userStats.totalCoin += deltaCoin;
    userStats.count += deltaCount;
    this.giftUsers.set(userKey, userStats);

    const giftStats = this.giftNames.get(giftName) || {
      giftName,
      count: 0,
      totalCoin: 0,
    };
    giftStats.count += deltaCount;
    giftStats.totalCoin += deltaCoin;
    this.giftNames.set(giftName, giftStats);
    this.recordBlindBoxStats(event, {
      giftName,
      deltaCount,
      deltaCoin,
      price: Number(event.price || 0),
      totalCoin,
      coinType,
    });
    this.recordGiftFeed({
      ...event,
      userName: shownUserName,
      displayUserName: shownUserName,
      giftName,
      count,
      totalCoin,
      coinType,
      valueText: formatBattery(totalCoin, coinType) || "0电池",
      deltaCount,
      deltaCoin,
      batchKey,
      isUpdate: Boolean(previous),
    });

    if (section.enabled === false) {
      return [];
    }
    const minBattery = Number(section.minBattery || 0);
    const minCoin = Number(section.minCoin || 0);
    if (
      coinType !== "silver" &&
      ((minBattery > 0 && totalCoin < minBattery * 100) || (minCoin > 0 && totalCoin < minCoin))
    ) {
      return [];
    }
    const aggregateWindowMs = Number(section.aggregateWindowMs || section.thanksDelayMs || 0);
    const nowMs = Date.now();
    if (!aggregateWindowMs) {
      if (!this.checkCooldown(`gift:${userKey}:${giftName}`, section.userCooldownSec || 8, nowMs)) {
        return [];
      }
      if (!this.checkCooldown("gift:global", section.cooldownSec || 3, nowMs)) {
        return [];
      }
    }

    const valueText = formatBattery(totalCoin, coinType);
    const blindTemplate =
      event.sourceGiftName || event.blindGift ? pick(section.blindTemplates) : "";
    const action = this.makeAction("gift", {
      ...event,
      count,
      displayUserName: shownUserName,
      giftName,
      valueText,
      batteryText: valueText,
    }, { template: blindTemplate });
    if (action) {
      if (!aggregateWindowMs) {
        this.markEmit(`gift:${userKey}:${giftName}`, nowMs);
        this.markEmit("gift:global", nowMs);
      }
      action.metadata = {
        ...(action.metadata || {}),
        aggregateWindowMs,
        totalCoin,
        deltaCoin,
        deltaCount,
        coinType,
        count,
        giftName,
        valueText,
      };
    }
    return action ? [action] : [];
  }

  pruneGiftDedupe(now = Date.now()) {
    for (const [key, item] of this.giftBatches.entries()) {
      if (now - item.at > 120000) this.giftBatches.delete(key);
    }
    for (const [key, at] of this.giftFingerprints.entries()) {
      if (now - at > 30000) this.giftFingerprints.delete(key);
    }
  }

  recordBlindBoxStats(event = {}, values = {}) {
    if (!(event.sourceGiftName || event.blindGift)) return;
    const count = Number(values.deltaCount || 0);
    if (count <= 0) return;
    const sourceGiftName = event.sourceGiftName || event.blindGift?.originalGiftName || "盲盒";
    const resultGiftName = values.giftName || event.giftName || "礼物";
    const sourcePrice = Number(event.sourceGiftPrice || event.blindGift?.originalGiftPrice || 0);
    const resultPrice = Number(event.resultGiftPrice || event.blindGift?.resultPrice || values.price || 0);
    const sourceCoin = sourcePrice ? sourcePrice * count : Number(values.deltaCoin || 0);
    const resultCoin = resultPrice ? resultPrice * count : Number(values.deltaCoin || 0);

    this.blindBoxStats.count += count;
    this.blindBoxStats.sourceCoin += sourceCoin;
    this.blindBoxStats.resultCoin += resultCoin;

    const sourceItem = this.blindBoxStats.sourceNames.get(sourceGiftName) || {
      giftName: sourceGiftName,
      count: 0,
      totalCoin: 0,
    };
    sourceItem.count += count;
    sourceItem.totalCoin += sourceCoin;
    this.blindBoxStats.sourceNames.set(sourceGiftName, sourceItem);

    const resultItem = this.blindBoxStats.resultNames.get(resultGiftName) || {
      giftName: resultGiftName,
      count: 0,
      totalCoin: 0,
    };
    resultItem.count += count;
    resultItem.totalCoin += resultCoin;
    this.blindBoxStats.resultNames.set(resultGiftName, resultItem);
  }

  recordGiftFeed(event) {
    const batchKey = event.batchKey || event.dedupeKey || "";
    const existing =
      batchKey && this.giftFeedByBatch.has(batchKey)
        ? this.giftFeedByBatch.get(batchKey)
        : null;
    const guardLevel = Number(event.guardLevel || 0);
    const rawAction = event.action || "投喂";
    const giftAction =
      event.sourceGiftName && !String(rawAction).includes(event.sourceGiftName)
        ? `${rawAction} ${event.sourceGiftName} ${event.blindGift?.action || "爆出"}`
        : rawAction;
    const sourceGiftPrice = Number(event.sourceGiftPrice || event.blindGift?.originalGiftPrice || 0);
    const resultGiftPrice = Number(event.resultGiftPrice || event.blindGift?.resultPrice || event.price || 0);
    const inputTotalCoin = sourceGiftPrice ? sourceGiftPrice * Number(event.count || 1) : 0;
    const outputTotalCoin = resultGiftPrice ? resultGiftPrice * Number(event.count || 1) : 0;
    const row = {
      id:
        existing?.id ||
        stableGiftRecordId(event, batchKey) ||
        `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: Number(event.at || 0) || Date.now(),
      userId: event.userId || 0,
      userName: displayName(event, event.userName || "匿名用户"),
      face: event.face || "",
      faceSource: event.faceSource || "",
      faceCandidates: event.faceCandidates || [],
      action: giftAction,
      giftId: event.giftId || 0,
      giftName: event.giftName || "礼物",
      giftIcon: event.giftIcon || "",
      sourceGiftId: event.sourceGiftId || event.blindGift?.originalGiftId || 0,
      sourceGiftName: event.sourceGiftName || event.blindGift?.originalGiftName || "",
      sourceGiftPrice,
      resultGiftPrice,
      inputTotalCoin,
      outputTotalCoin,
      profitCoin: outputTotalCoin - inputTotalCoin,
      blindGift: event.blindGift || null,
      count: Number(event.count || 1),
      totalCoin: Number(event.totalCoin || 0),
      valueText: event.valueText || formatBattery(event.totalCoin, event.coinType) || "0电池",
      coinType: event.coinType || "gold",
      medalName: event.medalName || "",
      medalLevel: Number(event.medalLevel || 0),
      medalColors: event.medalColors || null,
      guardLevel,
      guardName: event.guardName || guardNameFromLevel(guardLevel),
      guardIcon: event.guardIcon || "",
      avatarFrame: event.avatarFrame || null,
      avatarFrameUrl: event.avatarFrameUrl || event.avatarFrame?.url || "",
      avatarFrameName: event.avatarFrameName || event.avatarFrame?.name || "",
      wealthLevel: Number(event.wealthLevel || 0),
      source: event.source || "gift_packet",
      isSimulated: Boolean(event.isSimulated),
      batchKey,
    };

    if (existing) {
      Object.assign(existing, row, {
        id: existing.id,
        at: row.at,
        count: Math.max(existing.count || 0, row.count || 0),
        totalCoin: Math.max(existing.totalCoin || 0, row.totalCoin || 0),
        valueText: row.valueText,
      });
      this.lastGiftRecord = existing;
      return existing;
    }

    this.giftFeed.unshift(row);
    this.lastGiftRecord = row;
    if (batchKey) this.giftFeedByBatch.set(batchKey, row);
    if (this.giftFeed.length > 80) {
      const removed = this.giftFeed.splice(80);
      for (const item of removed) {
        if (item.batchKey) this.giftFeedByBatch.delete(item.batchKey);
      }
    }
    return row;
  }

  updateGiftFeedVisuals(resolveVisual) {
    if (typeof resolveVisual !== "function") return 0;
    let changed = 0;
    for (const row of this.giftFeed) {
      const next = resolveVisual(row) || {};
      const patch = {};
      for (const key of [
        "userName",
        "displayUserName",
        "face",
        "faceSource",
        "guardLevel",
        "guardName",
        "guardIcon",
        "medalName",
        "medalLevel",
        "medalColors",
        "avatarFrame",
        "avatarFrameUrl",
        "avatarFrameName",
        "avatarFrameSource",
        "wealthLevel",
      ]) {
        if (
          next[key] !== undefined &&
          next[key] !== null &&
          next[key] !== "" &&
          JSON.stringify(row[key] ?? "") !== JSON.stringify(next[key])
        ) {
          patch[key] = next[key];
        }
      }
      if (Object.keys(patch).length) {
        Object.assign(row, patch);
        changed += 1;
      }
    }
    return changed;
  }

  handleSuperChat(event) {
    const section = this.config.superChat || {};
    if (section.enabled === false || this.shouldIgnoreUser(event.userName)) {
      return [];
    }

    const now = Date.now();
    this.sweepState(now);
    this.rolloverDailyStats(now);
    if (!event.isSimulated) {
      const scId = stableSuperChatId(event);
      if (scId) {
        if (this.superChatSeenIds.has(scId)) return [];
        this.superChatSeenIds.set(scId, now);
      } else {
        const fingerprint = [
          "sc",
          event.userId || normalizeText(event.userName || ""),
          Number(event.price || 0),
          Number(event.startTime || 0) || normalizeText(event.text || "").slice(0, 20),
        ].join(":");
        const lastAt = this.superChatFingerprints.get(fingerprint) || 0;
        if (lastAt && now - lastAt < 600000) return [];
        this.superChatFingerprints.set(fingerprint, now);
      }
    }

    this.superChatTotal += Number(event.price || 0);
    const action = this.makeAction("superChat", {
      ...event,
      price: event.price ? `${event.price}元` : "",
    });
    return action ? [action] : [];
  }

  handleGuard(event) {
    const section = this.config.guard || {};
    const row = this.recordGuard(event);
    if (!row) {
      return [];
    }
    if (section.enabled === false || this.shouldIgnoreUser(event.userName)) {
      return [];
    }

    const action = this.makeAction("guard", event);
    return action ? [action] : [];
  }

  recordGuard(event = {}) {
    const now = Date.now();
    this.sweepState(now);
    const guardLevel = Number(event.guardLevel || 0);
    const count = Math.max(1, Number(event.count || 1));
    if (!event.isSimulated) {
      const recordId = stableGuardRecordId(event);
      const fingerprint = [
        "guard",
        normalizeText(event.roomId || ""),
        event.userId || event.uid || normalizeText(event.userName || ""),
        guardLevel,
        count,
      ].join(":");
      if (recordId && this.guardSeenIds.has(recordId)) return null;
      const lastAt = this.guardFingerprints.get(fingerprint) || 0;
      if (lastAt && now - lastAt < 30000) return null;
      if (recordId) this.guardSeenIds.set(recordId, now);
      this.guardFingerprints.set(fingerprint, now);
    }
    const expiresAt =
      Number(event.expiresAt || 0) || guardExpiryEstimate(now, count, event.unit);
    const guardName = event.guardName || guardNameFromLevel(guardLevel) || "大航海";
    const row = {
      id:
        stableGuardRecordId(event) ||
        `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: now,
      userId: event.userId || 0,
      userName: displayName(event, event.userName || "匿名用户"),
      face: event.face || "",
      guardLevel,
      guardName,
      guardIcon: event.guardIcon || "",
      count,
      unit: event.unit || "月",
      price: Number(event.price || 0),
      totalCoin: Number(event.totalCoin || event.price || 0),
      valueText: event.valueText || formatBattery(event.totalCoin || event.price, "gold") || "",
      medalName: event.medalName || "",
      medalLevel: Number(event.medalLevel || 0),
      medalColors: event.medalColors || null,
      avatarFrame: event.avatarFrame || null,
      avatarFrameUrl: event.avatarFrameUrl || event.avatarFrame?.url || "",
      avatarFrameName: event.avatarFrameName || event.avatarFrame?.name || "",
      isSimulated: Boolean(event.isSimulated),
      expiresAt,
      expiresAtText: new Date(expiresAt).toLocaleString("zh-CN", {
        hour12: false,
        timeZone: "Asia/Shanghai",
      }),
    };
    const key = String(row.userId || row.userName);
    const previous = this.guardUsers.get(key);
    if (!previous || Number(row.expiresAt || 0) >= Number(previous.expiresAt || 0)) {
      this.guardUsers.set(key, row);
    }
    this.guardFeed.unshift(row);
    if (this.guardFeed.length > 80) this.guardFeed.length = 80;
    this.lastGuardRecord = row;
    return row;
  }

  handleLike(event) {
    const section = this.config.like || {};
    if (section.enabled === false || this.shouldIgnoreUser(event.userName)) {
      return [];
    }

    const likeCount = Number(event.likeCount || 1);
    if (likeCount < Number(section.minCount || 1)) {
      return [];
    }
    const now = Date.now();
    if (!this.checkCooldown("like:global", section.cooldownSec || 30, now)) {
      return [];
    }

    const action = this.makeAction("like", {
      ...event,
      likeCount,
    });
    if (!action) return [];
    this.markEmit("like:global", now);
    return [action];
  }

  createGiftReportAction(options = {}) {
    this.rolloverDailyStats();
    const range = options.range || "today";
    const label = options.label || "今日";
    const topUsers = [...this.giftUsers.values()]
      .sort((left, right) => right.totalCoin - left.totalCoin)
      .slice(0, 5);
    const topGifts = [...this.giftNames.values()]
      .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
      .slice(0, 5);

    const userText =
      topUsers.length > 0
        ? topUsers
            .map(
              (item, index) =>
                `${index + 1}.${item.userName} ${formatBattery(item.totalCoin)}`
            )
            .join("；")
        : "暂无付费礼物";
    const giftText =
      topGifts.length > 0
        ? topGifts.map((item) => `${item.giftName}x${item.count}`).join("，")
        : "暂无礼物";

    const heading =
      range === "today" ? `${label}礼物` : `${label}历史暂不可查，改报今日礼物`;
    return {
      type: "gift_report",
      ruleName: "gift_report",
      reply: `${heading}：共${formatBattery(this.totalCoin) || "0电池"}，${this.totalGiftCount}件。贡献榜 ${userText}。礼物 ${giftText}。`,
      emotion: "calm",
      priority: 100,
      metadata: {
        range: "today",
        label,
        source: "memory",
        day: this.statsDay,
      },
    };
  }

  getStats() {
    this.rolloverDailyStats();
    const topUsers = [...this.giftUsers.values()]
      .sort((left, right) => right.totalCoin - left.totalCoin)
      .slice(0, 8)
      .map((item, index) => ({
        rank: index + 1,
        userName: item.userName,
        totalCoin: item.totalCoin,
        valueText: formatBattery(item.totalCoin) || "0电池",
        count: item.count,
      }));
    const topGifts = [...this.giftNames.values()]
      .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
      .slice(0, 8)
      .map((item, index) => ({
        rank: index + 1,
        giftName: item.giftName,
        count: item.count,
        totalCoin: item.totalCoin,
        valueText: formatBattery(item.totalCoin) || "0电池",
      }));
    const blindTopSources = [...this.blindBoxStats.sourceNames.values()]
      .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
      .slice(0, 8)
      .map((item, index) => ({
        rank: index + 1,
        ...item,
        valueText: formatBattery(item.totalCoin) || "0电池",
      }));
    const blindTopResults = [...this.blindBoxStats.resultNames.values()]
      .sort((left, right) => right.totalCoin - left.totalCoin || right.count - left.count)
      .slice(0, 8)
      .map((item, index) => ({
        rank: index + 1,
        ...item,
        valueText: formatBattery(item.totalCoin) || "0电池",
      }));
    const blindDeltaCoin = this.blindBoxStats.resultCoin - this.blindBoxStats.sourceCoin;
    const giftFeed = this.giftFeed.slice(0, 40).map(compactGiftFeedItem);

    return {
      totalCoin: this.totalCoin,
      totalValueText: formatBattery(this.totalCoin) || "0电池",
      totalGiftCount: this.totalGiftCount,
      superChatTotal: this.superChatTotal,
      topUsers,
      topGifts,
      blindBoxes: {
        count: this.blindBoxStats.count,
        sourceCoin: this.blindBoxStats.sourceCoin,
        resultCoin: this.blindBoxStats.resultCoin,
        sourceValueText: formatBattery(this.blindBoxStats.sourceCoin) || "0电池",
        resultValueText: formatBattery(this.blindBoxStats.resultCoin) || "0电池",
        deltaCoin: blindDeltaCoin,
        deltaValueText: `${blindDeltaCoin >= 0 ? "+" : "-"}${formatBattery(Math.abs(blindDeltaCoin)) || "0电池"}`,
        topSources: blindTopSources,
        topResults: blindTopResults,
      },
      quality: giftDataQuality(giftFeed),
      giftFeed,
    };
  }

  getGuardBoard() {
    const now = Date.now();
    const rows = [...this.guardUsers.values()]
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
      recent: this.guardFeed.slice(0, 20),
    };
  }
}

module.exports = {
  InteractionEngine,
  formatBattery,
  giftDataQuality,
  compactGiftFeedItem,
  firstString,
  firstNumber,
  displayName,
  guardNameFromLevel,
};
