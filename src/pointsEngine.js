"use strict";

const { formatBattery, firstString, displayName, guardNameFromLevel } = require("./interactionEngine");

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function dayKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

function startOfDay(input = Date.now()) {
  const date = input instanceof Date ? new Date(input) : new Date(input);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addDays(input, days = 0) {
  const date = startOfDay(input);
  date.setDate(date.getDate() + Number(days || 0));
  return date;
}

function signInDayFromRow(row = {}) {
  if (row.signInDay) return String(row.signInDay);
  const match = String(row.key || "").match(/:(\d{4}-\d{2}-\d{2})$/);
  if (match) return match[1];
  return row.at ? dayKey(row.at) : "";
}

function makeAction(reply, ruleName = "points", priority = 110) {
  return {
    type: "command_reply",
    ruleName,
    reply,
    emotion: "calm",
    priority,
  };
}

function cleanRedeemItemName(reasonText = "", fallback = "") {
  return String(reasonText || "")
    .replace(/^兑换\s*/, "")
    .trim() || fallback || "兑换商品";
}

function csvCell(value = "") {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

class PointsEngine {
  constructor(config = {}, eventStore = null) {
    this.config = {
      enabled: true,
      signInPoints: 10,
      giftPointsPerBattery: 1,
      guardPoints: {
        1: 20000,
        2: 2000,
        3: 300,
      },
      signInStreak: {
        enabled: true,
        bonusPerDay: 2,
        maxBonus: 20,
        milestones: {
          7: 20,
          30: 100,
        },
      },
      streakWindowDays: 40,
      shopItems: [
        { id: "song", name: "点歌一次", cost: 30, description: "主播方便时安排" },
        { id: "title", name: "弹幕称号", cost: 80, description: "主播人工确认后生效" },
        { id: "snapshot", name: "礼物长图点名", cost: 120, description: "生成礼物图时优先展示" },
      ],
      summaryCacheMs: 5000,
      ...config.points,
    };
    this.eventStore = eventStore;
    this.summaryCache = null;
    this.pointsIndex = null;
    if (this.isEnabled()) this.ensureIndex();
  }

  setEventStore(eventStore) {
    this.eventStore = eventStore;
    this.pointsIndex = null;
    this.summaryCache = null;
    if (this.isEnabled()) this.ensureIndex();
  }

  isEnabled() {
    return Boolean(this.config.enabled !== false && this.eventStore);
  }

  streakWindowDays() {
    const value = Number(this.config.streakWindowDays);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 40;
  }

  indexWindowDays() {
    return Math.max(45, this.streakWindowDays() + 1);
  }

  ensureIndex() {
    if (!this.eventStore) return null;
    const today = dayKey(Date.now());
    if (this.pointsIndex && this.pointsIndex.day === today) return this.pointsIndex;
    if (this.pointsIndex) {
      // 跨天只裁掉窗口外旧行，不再整月重读
      const cutoff = addDays(Date.now(), -this.indexWindowDays()).getTime();
      const rows = this.pointsIndex.rows.filter((row) => Number(row.at || 0) >= cutoff);
      const orders = this.pointsIndex.orders.filter((row) => Number(row.at || 0) >= cutoff);
      this.pointsIndex = {
        day: today,
        rows,
        orders,
        keys: new Set(rows.map((row) => row.key).filter(Boolean)),
      };
      return this.pointsIndex;
    }
    // 启动时把窗口内积分事件一次读入内存，此后增量维护，避免每次签到/礼物全月重读
    const rows = [];
    const orders = [];
    const keys = new Set();
    for (let offset = this.indexWindowDays() - 1; offset >= 0; offset -= 1) {
      const day = dayKey(addDays(Date.now(), -offset));
      for (const entry of this.eventStore.readEvents({ range: day, kinds: ["point", "point_order"] })) {
        const payload = entry.payload || entry;
        if (entry.isSimulated || payload.isSimulated) continue;
        if (entry.kind === "point") {
          rows.push(payload);
          if (payload.key) keys.add(payload.key);
        } else if (entry.kind === "point_order") {
          orders.push(payload);
        }
      }
    }
    this.pointsIndex = { day: today, rows, orders, keys };
    return this.pointsIndex;
  }

  indexRangeFilter(range = "month") {
    const value = String(range || "month").trim();
    const now = new Date();
    if (value === "month") {
      const since = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      return (row) => Number(row.at || 0) >= since;
    }
    if (value === "today") {
      const since = startOfDay(now).getTime();
      return (row) => Number(row.at || 0) >= since;
    }
    if (value === "yesterday") {
      const start = addDays(now, -1).getTime();
      const end = startOfDay(now).getTime();
      return (row) => Number(row.at || 0) >= start && Number(row.at || 0) < end;
    }
    if (value === "week") {
      const since = addDays(now, -6).getTime();
      return (row) => Number(row.at || 0) >= since;
    }
    return null;
  }

  userKey(event = {}) {
    return String(event.userId || normalizeText(event.displayUserName || event.userName));
  }

  userName(event = {}) {
    return displayName(event, firstString(event.displayUserName, event.userName, "观众"));
  }

  readTransactions(options = {}) {
    if (!this.eventStore) return [];
    const roomId = Number(options.roomId || 0);
    const userKey = options.userKey ? String(options.userKey) : "";
    const reason = options.reason || "";
    const range = options.range || "month";
    const index = this.ensureIndex();
    const rangeFilter = index ? this.indexRangeFilter(range) : null;
    const rows = rangeFilter
      ? index.rows.filter(rangeFilter)
      : this.eventStore
          .readEvents({ range, kinds: ["point"] })
          .filter((entry) => !entry.isSimulated)
          .map((entry) => entry.payload || entry)
          .filter((entry) => !entry.isSimulated);
    return rows
      .filter((entry) => !roomId || Number(entry.roomId || 0) === roomId)
      .filter((entry) => !userKey || String(entry.userKey || "") === userKey)
      .filter((entry) => !reason || entry.reason === reason);
  }

  hasTransaction(key, options = {}) {
    if (!key) return false;
    const index = this.ensureIndex();
    if (index) return index.keys.has(key);
    return this.readTransactions({ range: options.range || "month", roomId: options.roomId }).some(
      (entry) => entry.key === key
    );
  }

  appendTransaction(event = {}, patch = {}) {
    if (!this.isEnabled()) return null;
    // 积分事务一旦写入无法在读端剔除，模拟事件一律拒写
    if (event.isSimulated || patch.isSimulated) return null;
    const roomId = Number(patch.roomId || event.roomId || 0);
    const userKey = patch.userKey || this.userKey(event);
    if (!userKey) return null;
    const points = Number(patch.points || 0);
    if (!Number.isFinite(points) || points === 0) return null;
    const key = patch.key || `${patch.reason || "point"}:${roomId}:${userKey}:${Date.now()}`;
    if (this.hasTransaction(key, { roomId })) return null;
    const at = Number(patch.at || event.at || Date.now());
    const tx = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      key,
      at,
      roomId,
      userKey,
      userId: event.userId || 0,
      userName: this.userName(event),
      points,
      reason: patch.reason || "manual",
      reasonText: patch.reasonText || "",
      ref: patch.ref || "",
      ...(patch.signInDay ? { signInDay: patch.signInDay } : {}),
      ...(patch.streak ? { streak: Number(patch.streak || 0) } : {}),
      ...(patch.basePoints ? { basePoints: Number(patch.basePoints || 0) } : {}),
      ...(patch.bonusPoints ? { bonusPoints: Number(patch.bonusPoints || 0) } : {}),
    };
    this.eventStore.append("point", {
      roomId,
      userId: tx.userId,
      userName: tx.userName,
      payload: tx,
    });
    const index = this.ensureIndex();
    if (index) {
      index.rows.push(tx);
      if (tx.key) index.keys.add(tx.key);
    }
    this.summaryCache = null;
    return tx;
  }

  balance(event = {}, roomInfo = {}) {
    const roomId = Number(roomInfo.roomId || event.roomId || 0);
    const userKey = this.userKey(event);
    const rows = this.readTransactions({ range: "month", roomId, userKey });
    return rows.reduce((sum, row) => sum + Number(row.points || 0), 0);
  }

  signInRows(event = {}, roomInfo = {}) {
    const roomId = Number(roomInfo.roomId || event.roomId || 0);
    const userKey = this.userKey(event);
    if (!userKey) return [];
    // 连签按滚动窗口统计，跨月不清零
    const index = this.ensureIndex();
    if (!index) return [];
    const since = addDays(Date.now(), -this.streakWindowDays()).getTime();
    return index.rows.filter(
      (row) =>
        row.reason === "sign_in" &&
        Number(row.at || 0) >= since &&
        (!roomId || Number(row.roomId || 0) === roomId) &&
        String(row.userKey || "") === userKey
    );
  }

  signInStreakFromRows(rows = [], asOf = Date.now()) {
    const signedDays = new Set(rows.map(signInDayFromRow).filter(Boolean));
    let streak = 0;
    let cursor = startOfDay(asOf);
    while (signedDays.has(dayKey(cursor))) {
      streak += 1;
      cursor = addDays(cursor, -1);
    }
    return streak;
  }

  signInStreak(event = {}, roomInfo = {}, asOf = Date.now()) {
    return this.signInStreakFromRows(this.signInRows(event, roomInfo), asOf);
  }

  signInBonus(streak = 1) {
    const config = this.config.signInStreak || {};
    if (config.enabled === false) return 0;
    const value = Math.max(1, Number(streak || 1));
    const bonusPerDay = Math.max(0, Number(config.bonusPerDay ?? 2));
    const maxBonus = Math.max(0, Number(config.maxBonus ?? 20));
    const dailyBonus = Math.min(maxBonus, Math.max(0, value - 1) * bonusPerDay);
    const milestoneBonus = Number(config.milestones?.[value] || 0);
    return Math.floor(dailyBonus + milestoneBonus);
  }

  signIn(event = {}, roomInfo = {}) {
    if (!this.isEnabled()) return makeAction("积分系统当前关闭。", "points");
    if (event.isSimulated) return makeAction("模拟弹幕不计入积分。", "points");
    const roomId = Number(roomInfo.roomId || event.roomId || 0);
    const userKey = this.userKey(event);
    const now = Date.now();
    const today = dayKey(now);
    const key = `signin:${roomId}:${userKey}:${today}`;
    if (this.hasTransaction(key, { range: "today", roomId })) {
      const streak = this.signInStreak(event, roomInfo, now);
      return makeAction(
        `${this.userName(event)}今天已经签过到啦，连续${streak || 1}天，当前本月积分 ${this.balance(event, roomInfo)}。`,
        "points"
      );
    }
    const previousStreak = this.signInStreak(event, roomInfo, addDays(now, -1));
    const streak = previousStreak + 1;
    const basePoints = Number(this.config.signInPoints || 10);
    const bonusPoints = this.signInBonus(streak);
    const tx = this.appendTransaction(event, {
      key,
      roomId,
      at: now,
      points: basePoints + bonusPoints,
      reason: "sign_in",
      reasonText: streak > 1 ? `每日签到 连续${streak}天` : "每日签到",
      signInDay: today,
      streak,
      basePoints,
      bonusPoints,
    });
    if (!tx) return makeAction("签到没有登记成功，请稍后再试。", "points");
    const total = this.balance(event, roomInfo);
    const bonusText = bonusPoints > 0 ? `（连续${streak}天奖励+${bonusPoints}）` : `（连续${streak}天）`;
    return makeAction(`${tx.userName}签到成功，+${tx.points}积分${bonusText}，本月积分 ${total}。`, "points");
  }

  awardGift(event = {}, roomInfo = {}) {
    if (!this.isEnabled() || event.isSimulated || this.config.giftPointsPerBattery === false) return null;
    const roomId = Number(roomInfo.roomId || event.roomId || 0);
    const battery = Number(event.totalCoin || 0) / 100;
    const points = Math.floor(battery * Number(this.config.giftPointsPerBattery || 0));
    const ref = event.id || event.batchKey || event.dedupeKey || `${event.giftName}:${event.count}:${event.at || ""}`;
    return this.appendTransaction(event, {
      key: `gift:${roomId}:${this.userKey(event)}:${ref}`,
      roomId,
      points,
      reason: "gift",
      reasonText: `${event.giftName || "礼物"} ${formatBattery(event.totalCoin, event.coinType) || ""}`,
      ref,
    });
  }

  awardGuard(event = {}, roomInfo = {}) {
    if (!this.isEnabled() || event.isSimulated) return null;
    const roomId = Number(roomInfo.roomId || event.roomId || 0);
    const guardLevel = Number(event.guardLevel || 0);
    const points = Number(this.config.guardPoints?.[guardLevel] || 0) * Math.max(1, Number(event.count || 1));
    const ref = event.id || event.dedupeKey || `${guardLevel}:${event.count || 1}:${event.at || Date.now()}`;
    return this.appendTransaction(event, {
      key: `guard:${roomId}:${this.userKey(event)}:${ref}`,
      roomId,
      points,
      reason: "guard",
      reasonText: `${guardNameFromLevel(guardLevel) || event.guardName || "大航海"} ${event.count || 1}${event.unit || "月"}`,
      ref,
    });
  }

  createBalanceAction(event = {}, roomInfo = {}) {
    if (!this.isEnabled()) return makeAction("积分系统当前关闭。", "points");
    const streak = this.signInStreak(event, roomInfo);
    return makeAction(
      `${this.userName(event)}当前本月积分 ${this.balance(event, roomInfo)}${streak ? `，连续签到${streak}天` : ""}。`,
      "points"
    );
  }

  createLeaderboardAction(roomInfo = {}) {
    if (!this.isEnabled()) return makeAction("积分系统当前关闭。", "points");
    const roomId = Number(roomInfo.roomId || 0);
    const users = new Map();
    for (const row of this.readTransactions({ range: "month", roomId })) {
      const key = row.userKey || row.userId || row.userName;
      const item = users.get(key) || { userName: row.userName || "观众", points: 0 };
      item.points += Number(row.points || 0);
      users.set(key, item);
    }
    const top = [...users.values()]
      .sort((a, b) => b.points - a.points)
      .slice(0, 5);
    const text = top.length
      ? top.map((item, index) => `${index + 1}.${item.userName} ${item.points}`).join("；")
      : "暂无积分记录";
    return makeAction(`本月积分榜：${text}`, "points");
  }

  shopItems() {
    return toArray(this.config.shopItems)
      .map((item, index) => {
        if (typeof item === "string") {
          const [name, cost, description] = item.split("|").map((part) => String(part || "").trim());
          return {
            id: normalizeText(name) || `item${index + 1}`,
            name,
            cost: Number(cost || 0),
            description,
          };
        }
        return {
          id: String(item.id || normalizeText(item.name) || `item${index + 1}`),
          name: String(item.name || item.id || `商品${index + 1}`),
          cost: Number(item.cost || item.points || 0),
          description: String(item.description || item.desc || ""),
        };
      })
      .filter((item) => item.name && item.cost > 0);
  }

  createShopAction() {
    if (!this.isEnabled()) return makeAction("积分系统当前关闭。", "points_shop");
    const items = this.shopItems();
    const text = items.length
      ? items
          .slice(0, 6)
          .map((item) => `${item.name}${item.cost}分`)
          .join("；")
      : "暂未配置商品";
    return makeAction(`积分商城：${text}。发送“兑换 商品名”可登记兑换。`, "points_shop", 120);
  }

  createRedeemAction(text = "", event = {}, roomInfo = {}) {
    if (!this.isEnabled()) return makeAction("积分系统当前关闭。", "points_shop");
    if (event.isSimulated) return makeAction("模拟弹幕不计入积分。", "points_shop");
    const query = normalizeText(String(text || "").replace(/^兑换/, ""));
    if (!query) return this.createShopAction();
    const item = this.shopItems().find(
      (candidate) =>
        normalizeText(candidate.id) === query ||
        normalizeText(candidate.name) === query ||
        normalizeText(candidate.name).includes(query)
    );
    if (!item) return makeAction("没找到这个商品，发送“积分商城”看看可兑换列表。", "points_shop");
    const current = this.balance(event, roomInfo);
    if (current < item.cost) {
      return makeAction(
        `${this.userName(event)}积分不够，${item.name}需要${item.cost}分，当前${current}分。`,
        "points_shop"
      );
    }
    const tx = this.appendTransaction(event, {
      roomId: Number(roomInfo.roomId || event.roomId || 0),
      points: -item.cost,
      reason: "redeem",
      reasonText: `兑换 ${item.name}`,
      ref: item.id,
    });
    if (!tx) return makeAction("兑换没有登记成功，请稍后再试。", "points_shop");
    const total = this.balance(event, roomInfo);
    return makeAction(
      `${tx.userName}已登记兑换：${item.name}，扣${item.cost}分，剩余${total}分。主播稍后处理。`,
      "points_shop",
      130
    );
  }

  readRedemptionStatus(roomId = 0) {
    if (!this.eventStore) return new Map();
    const index = this.ensureIndex();
    const entries = index
      ? index.orders
      : this.eventStore.readEvents({ range: "month", kinds: ["point_order"] });
    return this.makeRedemptionStatusMap(entries, roomId);
  }

  makeRedemptionStatusMap(entries = [], roomId = 0) {
    const latest = new Map();
    for (const entry of entries) {
      const payload = entry.payload || entry;
      if (roomId && Number(payload.roomId || 0) !== Number(roomId)) continue;
      const orderId = String(payload.orderId || "");
      if (!orderId) continue;
      const previous = latest.get(orderId);
      if (!previous || Number(payload.at || entry.at || 0) >= Number(previous.at || 0)) {
        latest.set(orderId, {
          ...payload,
          at: Number(payload.at || entry.at || Date.now()),
        });
      }
    }
    return latest;
  }

  buildRedemptionSummary(rows = [], statusByOrder = new Map(), limit = 8) {
    const redemptions = rows
      .filter((row) => row.reason === "redeem")
      .map((row) => {
        const statusRow = statusByOrder.get(String(row.id || ""));
        const status = statusRow?.status || "pending";
        return {
          orderId: row.id,
          at: row.at,
          roomId: row.roomId,
          userId: row.userId,
          userName: row.userName || "观众",
          userKey: row.userKey || String(row.userId || normalizeText(row.userName || "")),
          itemId: row.ref || "",
          itemName: cleanRedeemItemName(row.reasonText, row.ref),
          cost: Math.abs(Number(row.points || 0)),
          status,
          handledAt: statusRow?.at || 0,
          handlerName: statusRow?.handlerName || "",
          note: statusRow?.note || "",
        };
      })
      .sort((left, right) => Number(right.at || 0) - Number(left.at || 0));
    return {
      total: redemptions.length,
      pendingCount: redemptions.filter((row) => row.status === "pending").length,
      pending: redemptions.filter((row) => row.status === "pending").slice(0, Number(limit || 8)),
      recent: redemptions.slice(0, Number(limit || 8)),
    };
  }

  listRedemptions(roomInfo = {}, options = {}) {
    if (!this.isEnabled()) return { pending: [], recent: [], total: 0, pendingCount: 0 };
    const roomId = Number(roomInfo.roomId || options.roomId || 0);
    const statusByOrder = this.readRedemptionStatus(roomId);
    const rows = this.readTransactions({ range: options.range || "month", roomId, reason: "redeem" });
    return this.buildRedemptionSummary(rows, statusByOrder, Number(options.limit || 8));
  }

  markRedemption(orderId = "", status = "done", roomInfo = {}, actor = {}) {
    if (!this.isEnabled()) return null;
    const id = String(orderId || "").trim();
    if (!id) return null;
    const normalizedStatus = status === "cancelled" ? "cancelled" : "done";
    const roomId = Number(roomInfo.roomId || actor.roomId || 0);
    // 直接按订单号在窗口内事务里检索，不再经过截断的最近列表
    const index = this.ensureIndex();
    if (!index) return null;
    const row = index.rows.find(
      (item) =>
        item.reason === "redeem" &&
        String(item.id || "") === id &&
        (!roomId || Number(item.roomId || 0) === roomId)
    );
    if (!row) return null;
    const statusByOrder = this.readRedemptionStatus(roomId);
    const order = this.buildRedemptionSummary([row], statusByOrder, 1).recent[0];
    if (!order) return null;
    const payload = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      orderId: id,
      at: Date.now(),
      roomId: Number(order.roomId || roomId || 0),
      userId: order.userId || 0,
      userName: order.userName || "",
      itemId: order.itemId || "",
      itemName: order.itemName || "",
      status: normalizedStatus,
      handlerName: actor.userName || "主播",
      note: firstString(actor.note, actor.remark, actor.reason),
    };
    this.eventStore.append("point_order", {
      roomId: payload.roomId,
      userId: payload.userId,
      userName: payload.userName,
      payload,
    });
    if (index) index.orders.push(payload);
    if (normalizedStatus === "cancelled" && order.status !== "cancelled") {
      this.appendTransaction(
        {
          userId: order.userId || 0,
          userName: order.userName || "",
          displayUserName: order.userName || "",
        },
        {
          key: `refund:${payload.roomId}:${id}`,
          roomId: payload.roomId,
          userKey: order.userKey || String(order.userId || normalizeText(order.userName || "")),
          points: Number(order.cost || 0),
          reason: "redeem_refund",
          reasonText: `取消兑换 ${order.itemName || "兑换商品"}`,
          ref: id,
        }
      );
    }
    this.summaryCache = null;
    return payload;
  }

  manualAdjust(input = {}, roomInfo = {}, actor = {}) {
    if (!this.isEnabled()) return null;
    if (input.isSimulated || input.simulated) return null;
    const points = Number(input.points || input.amount || 0);
    const userName = firstString(input.userName, input.displayUserName);
    const userId = Number(input.userId || input.uid || 0);
    if (!Number.isFinite(points) || points === 0 || (!userName && !userId)) return null;
    const roomId = Number(roomInfo.roomId || input.roomId || 0);
    const event = {
      roomId,
      userId,
      userName: userName || `UID${userId}`,
      displayUserName: userName || `UID${userId}`,
    };
    const tx = this.appendTransaction(event, {
      key: `manual:${roomId}:${this.userKey(event)}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      points,
      reason: "manual_adjust",
      reasonText: firstString(input.reason, input.reasonText, actor.userName ? `主播${actor.userName}手动调整` : "主播手动调整"),
      ref: actor.userName || "operator",
    });
    if (!tx) return null;
    return {
      ...tx,
      balance: this.balance(event, roomInfo),
    };
  }

  exportCsv(roomInfo = {}, options = {}) {
    const roomId = Number(roomInfo.roomId || options.roomId || 0);
    const rows = this.readTransactions({ range: options.range || "month", roomId }).sort(
      (left, right) => Number(left.at || 0) - Number(right.at || 0)
    );
    const header = [
      "time",
      "roomId",
      "userId",
      "userName",
      "userKey",
      "points",
      "reason",
      "reasonText",
      "ref",
      "balanceAfter",
    ];
    const balances = new Map();
    const lines = [header.join(",")];
    for (const row of rows) {
      const key = `${row.roomId || roomId}:${row.userKey || row.userId || row.userName}`;
      const balanceAfter = Number(balances.get(key) || 0) + Number(row.points || 0);
      balances.set(key, balanceAfter);
      lines.push(
        [
          new Date(Number(row.at || Date.now())).toISOString(),
          row.roomId || roomId || "",
          row.userId || "",
          row.userName || "",
          row.userKey || "",
          row.points || 0,
          row.reason || "",
          row.reasonText || "",
          row.ref || "",
          balanceAfter,
        ]
          .map(csvCell)
          .join(",")
      );
    }
    return `${lines.join("\n")}\n`;
  }

  getSummary(roomInfo = {}, options = {}) {
    const roomId = Number(roomInfo.roomId || 0);
    const now = Date.now();
    const cacheMs = Math.max(1000, Number(this.config.summaryCacheMs || 5000));
    if (
      !options.force &&
      this.summaryCache &&
      this.summaryCache.roomId === roomId &&
      now - Number(this.summaryCache.at || 0) < cacheMs
    ) {
      return this.summaryCache.value;
    }
    const index = this.ensureIndex();
    const monthFilter = this.indexRangeFilter("month");
    const rows = index
      ? index.rows
          .filter(monthFilter)
          .filter((entry) => !roomId || Number(entry.roomId || 0) === roomId)
      : [];
    const statusByOrder = index
      ? this.makeRedemptionStatusMap(index.orders.filter(monthFilter), roomId)
      : new Map();
    const users = new Map();
    const signInRows = rows.filter((row) => row.reason === "sign_in");
    for (const row of rows) {
      const key = row.userKey || row.userId || row.userName;
      const item = users.get(key) || { userName: row.userName || "观众", points: 0 };
      item.points += Number(row.points || 0);
      users.set(key, item);
    }
    const redemptions = this.buildRedemptionSummary(rows, statusByOrder, 8);
    const today = dayKey(now);
    const signInUserKeys = [...new Set(signInRows.map((row) => row.userKey || row.userId || row.userName).filter(Boolean))];
    const signInTodayCount = new Set(
      signInRows
        .filter((row) => signInDayFromRow(row) === today)
        .map((row) => row.userKey || row.userId || row.userName)
        .filter(Boolean)
    ).size;
    const summary = {
      enabled: this.isEnabled(),
      transactionCount: rows.length,
      totalPoints: rows.reduce((sum, row) => sum + Number(row.points || 0), 0),
      userCount: users.size,
      signIn: {
        todayCount: signInTodayCount,
        userCount: signInUserKeys.length,
        maxStreak: signInUserKeys.reduce((max, key) => {
          const userRows = signInRows.filter((row) => String(row.userKey || row.userId || row.userName) === String(key));
          return Math.max(max, this.signInStreakFromRows(userRows, now));
        }, 0),
        basePoints: Number(this.config.signInPoints || 10),
        bonusPerDay: Number(this.config.signInStreak?.bonusPerDay ?? 2),
        maxBonus: Number(this.config.signInStreak?.maxBonus ?? 20),
      },
      topUsers: [...users.values()]
        .sort((left, right) => right.points - left.points)
        .slice(0, 6),
      shopItems: this.shopItems().slice(0, 8),
      redemptions,
    };
    this.summaryCache = { roomId, at: now, value: summary };
    return summary;
  }
}

module.exports = {
  PointsEngine,
};
