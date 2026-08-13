"use strict";

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .trim();
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function pickReply(reply) {
  const replies = toArray(reply).filter(Boolean);
  if (replies.length === 0) return "";
  const index = Math.floor(Math.random() * replies.length);
  return replies[index];
}

function parseCronField(field, value) {
  const token = String(field || "*").trim();
  if (!token || token === "*") return true;
  return token.split(",").some((part) => {
    const item = part.trim();
    if (!item) return false;
    if (item.startsWith("*/")) {
      const step = Number(item.slice(2));
      return step > 0 && value % step === 0;
    }
    if (item.includes("-")) {
      const [start, end] = item.split("-").map(Number);
      return Number.isFinite(start) && Number.isFinite(end) && value >= start && value <= end;
    }
    return Number(item) === value;
  });
}

// 方言提示：与标准 cron 不同——日期与星期同时限定时按"且"处理，*/n 按 value%n==0 从 0 起算
function cronMatches(cron, date = new Date()) {
  const fields = String(cron || "").trim().split(/\s+/).filter(Boolean);
  if (fields.length !== 5 && fields.length !== 6) return false;
  const parts = fields.length === 5 ? ["0", ...fields] : fields;
  const dow = date.getDay();
  const values = [
    date.getSeconds(),
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    dow,
  ];
  return parts.every((field, index) => {
    if (index === 5) {
      return parseCronField(field, dow) || (dow === 0 && parseCronField(field, 7));
    }
    return parseCronField(field, values[index]);
  });
}

function compileRegex(rule) {
  if (!rule.regex) return null;
  const source = String(rule.regex);
  const flags = String(rule.regexFlags || "i").replace(/[gy]/g, "");
  try {
    return new RegExp(source, flags);
  } catch (error) {
    console.warn(`[规则引擎] 规则 ${rule.name || source} 正则无效，降级为关键词匹配：${error.message}`);
    return null;
  }
}

function timerIntervalSec(timer = {}) {
  if (timer.cron) return 0;
  const raw = timer.intervalSec;
  if (raw === undefined || raw === null || raw === "") return 180;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(5, value);
}

function interpolate(template, event, rule) {
  const userName =
    event.displayUserName && !/\*{2,}/.test(event.displayUserName)
      ? event.displayUserName
      : event.userName;
  return String(template || "")
    .replaceAll("{user}", userName || "这位朋友")
    .replaceAll("{text}", event.text || "")
    .replaceAll("{rule}", rule.name || "");
}

class RuleEngine {
  constructor(config = {}) {
    this.maxRepliesPerMessage = config.maxRepliesPerMessage || 1;
    this.blocklist = toArray(config.blocklist).map(normalizeText).filter(Boolean);
    this.ignoreUsers = new Set(toArray(config.ignoreUsers).map(normalizeText));
    this.ignoreNameIncludes = toArray(config.ignoreNameIncludes)
      .map(normalizeText)
      .filter(Boolean);
    this.rules = toArray(config.rules)
      .filter((rule) => rule && rule.enabled !== false)
      .map((rule) => ({
        ...rule,
        _regex: compileRegex(rule),
        _keywords: toArray(rule.keywords).map(normalizeText).filter(Boolean),
      }))
      .sort((left, right) => (right.priority || 0) - (left.priority || 0));
    this.configuredTimers = toArray(config.timers)
      .filter((timer) => timer)
      .map((timer, index) => ({
        ...timer,
        _name: timer.name || `timer_${index + 1}`,
      }));
    this.timers = this.configuredTimers.filter((timer) => timer.enabled !== false);
    this.ruleLastHit = new Map();
    this.userRuleLastHit = new Map();
    this.timerHandles = [];
    this.timerIndexes = new Map();
    this.timerLastFire = new Map();
    this.timerStats = new Map();
    this.lastSweepAt = 0;
    this.maxCooldownMs = this.rules.reduce(
      (max, rule) =>
        Math.max(
          max,
          Math.max(0, Number(rule.cooldownSec || 0)) * 1000,
          Math.max(0, Number(rule.userCooldownSec || 0)) * 1000
        ),
      0
    );
  }

  sweepHits(now = Date.now()) {
    if (now - this.lastSweepAt < 300000) return;
    this.lastSweepAt = now;
    const ttlMs = Math.max(this.maxCooldownMs, 60000);
    for (const [key, at] of this.ruleLastHit.entries()) {
      if (now - at > ttlMs) this.ruleLastHit.delete(key);
    }
    for (const [key, at] of this.userRuleLastHit.entries()) {
      if (now - at > ttlMs) this.userRuleLastHit.delete(key);
    }
  }

  isBlocked(text) {
    const normalized = normalizeText(text);
    return this.blocklist.some((term) => normalized.includes(term));
  }

  shouldIgnoreUser(userName) {
    const normalized = normalizeText(userName);
    return (
      this.ignoreUsers.has(normalized) ||
      this.ignoreNameIncludes.some((term) => normalized.includes(term))
    );
  }

  handleChat(event) {
    if (!event?.text || this.isBlocked(event.text) || this.shouldIgnoreUser(event.userName)) {
      return [];
    }

    const actions = [];
    const normalized = normalizeText(event.text);
    const raw = String(event.text || "");
    const now = Date.now();
    this.sweepHits(now);

    for (const rule of this.rules) {
      if (!this.matches(rule, normalized, raw)) {
        continue;
      }

      if (this.isCoolingDown(rule, event, now)) {
        continue;
      }

      const reply = interpolate(pickReply(rule.reply), event, rule).trim();
      if (!reply && !rule.action) {
        continue;
      }

      this.markHit(rule, event, now);
      actions.push({
        type: rule.action || "reply",
        ruleName: rule.name || "unnamed_rule",
        reply,
        emotion: rule.emotion || "calm",
        priority: rule.priority || 0,
        metadata: rule.metadata || {},
      });

      if (actions.length >= this.maxRepliesPerMessage) {
        break;
      }
    }

    return actions;
  }

  matches(rule, normalized, raw) {
    if (rule._regex && rule._regex.test(raw)) {
      return true;
    }

    if (!rule._keywords?.length) {
      return false;
    }

    const mode = rule.matchMode || "any";
    if (mode === "all") {
      return rule._keywords.every((keyword) => normalized.includes(keyword));
    }
    if (mode === "exact") {
      return rule._keywords.some((keyword) => normalized === keyword);
    }

    return rule._keywords.some((keyword) => normalized.includes(keyword));
  }

  isCoolingDown(rule, event, now) {
    const ruleName = rule.name || "";
    const cooldownMs = Math.max(0, Number(rule.cooldownSec || 0)) * 1000;
    const userCooldownMs = Math.max(0, Number(rule.userCooldownSec || 0)) * 1000;

    if (cooldownMs > 0) {
      const last = this.ruleLastHit.get(ruleName) || 0;
      if (now - last < cooldownMs) {
        return true;
      }
    }

    if (userCooldownMs > 0) {
      const userKey = `${ruleName}:${event.userId || event.userName || "unknown"}`;
      const last = this.userRuleLastHit.get(userKey) || 0;
      if (now - last < userCooldownMs) {
        return true;
      }
    }

    return false;
  }

  markHit(rule, event, now) {
    const ruleName = rule.name || "";
    this.ruleLastHit.set(ruleName, now);
    const userKey = `${ruleName}:${event.userId || event.userName || "unknown"}`;
    this.userRuleLastHit.set(userKey, now);
  }

  startTimers(onAction) {
    this.stopTimers();

    const cronTimers = [];
    for (const timer of this.timers) {
      const timerName = timer._name || timer.name || "timer";
      const intervalSec = timerIntervalSec(timer);
      if (!timer.cron && intervalSec <= 0) {
        console.warn(`[规则引擎] 定时器 ${timerName} 的 intervalSec 配置无效，本次不启动`);
        continue;
      }
      const intervalMs = timer.cron ? 0 : intervalSec * 1000;
      const existingStats = this.timerStats.get(timerName) || {};
      this.timerStats.set(timerName, {
        ...existingStats,
        name: timerName,
        startedAt: Date.now(),
        nextFireAt: intervalMs ? Date.now() + intervalMs : 0,
      });
      const emitAction = () => {
        const reply = this.pickTimerReply(timer, timerName).trim();
        if (!reply) return;
        const stats = this.timerStats.get(timerName) || {};
        this.timerStats.set(timerName, {
          ...stats,
          name: timerName,
          fireCount: Number(stats.fireCount || 0) + 1,
          lastFireAt: Date.now(),
          lastReply: reply,
          nextFireAt: intervalMs ? Date.now() + intervalMs : 0,
        });
        onAction({
          type: "timer",
          ruleName: timerName,
          reply,
          emotion: timer.emotion || "calm",
          priority: timer.priority || 0,
        });
      };

      if (timer.fireOnStart) {
        emitAction();
      }

      if (timer.cron) {
        cronTimers.push({ timer, timerName, emitAction });
      } else {
        const handle = setInterval(emitAction, intervalMs);
        handle.unref?.();
        this.timerHandles.push(handle);
      }
    }

    if (cronTimers.length) {
      const handle = setInterval(() => {
        const now = new Date();
        const fireKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}-${now.getSeconds()}`;
        for (const item of cronTimers) {
          if (!cronMatches(item.timer.cron, now)) continue;
          if (this.timerLastFire.get(item.timerName) === fireKey) continue;
          this.timerLastFire.set(item.timerName, fireKey);
          item.emitAction();
        }
      }, 1000);
      handle.unref?.();
      this.timerHandles.push(handle);
    }
  }

  pickTimerReply(timer = {}, timerName = "") {
    const replies = toArray(timer.reply).filter(Boolean);
    if (!replies.length) return "";
    const mode = timer.mode || timer.order || (timer.random === false ? "sequence" : "random");
    if (mode === "sequence" || mode === "sequential" || mode === "顺序") {
      const index = this.timerIndexes.get(timerName) || 0;
      this.timerIndexes.set(timerName, (index + 1) % replies.length);
      return replies[index % replies.length];
    }
    return pickReply(replies);
  }

  stopTimers() {
    for (const handle of this.timerHandles) {
      clearInterval(handle);
    }
    this.timerHandles = [];
    this.timerLastFire.clear();
    for (const [name, stats] of this.timerStats.entries()) {
      if (stats?.nextFireAt) {
        this.timerStats.set(name, { ...stats, nextFireAt: 0 });
      }
    }
  }

  getTimerState() {
    const timers = this.configuredTimers.map((timer) => {
      const name = timer._name;
      const stats = this.timerStats.get(name) || {};
      const replies = toArray(timer.reply).filter(Boolean);
      return {
        name,
        enabled: timer.enabled !== false,
        intervalSec: timerIntervalSec(timer),
        cron: timer.cron || "",
        replyCount: replies.length,
        mode: timer.mode || timer.order || (timer.random === false ? "sequence" : "random"),
        fireOnStart: timer.fireOnStart === true,
        priority: timer.priority || 0,
        running: timer.enabled !== false && this.timerHandles.length > 0,
        startedAt: stats.startedAt || 0,
        lastFireAt: stats.lastFireAt || 0,
        lastReply: stats.lastReply || "",
        nextFireAt: stats.nextFireAt || 0,
        fireCount: Number(stats.fireCount || 0),
      };
    });
    return {
      total: timers.length,
      active: timers.filter((timer) => timer.enabled).length,
      running: this.timerHandles.length > 0,
      timers,
    };
  }
}

module.exports = {
  RuleEngine,
  normalizeText,
};
