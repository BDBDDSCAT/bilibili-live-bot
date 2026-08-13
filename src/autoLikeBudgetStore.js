"use strict";

const fs = require("node:fs");
const path = require("node:path");

function localDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const two = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function finiteInteger(value, fallback = null) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) ? number : null;
}

function validLocalDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function normalizeBudget(value) {
  if (!value || typeof value !== "object") return null;
  const roomId = finiteInteger(value.roomId, 0);
  const day = String(value.day || "").trim();
  const targetClicks = finiteInteger(value.targetClicks, 0);
  const rawSuccessfulClicks = finiteInteger(value.successfulClicks, 0);
  const updatedAt = finiteInteger(value.updatedAt, 0);
  if (
    !roomId ||
    roomId < 0 ||
    !validLocalDay(day) ||
    !targetClicks ||
    targetClicks < 0 ||
    rawSuccessfulClicks === null ||
    rawSuccessfulClicks < 0 ||
    updatedAt === null ||
    updatedAt < 0 ||
    (value.limitReached !== undefined && typeof value.limitReached !== "boolean")
  ) {
    return null;
  }
  const successfulClicks = Math.min(
    targetClicks,
    rawSuccessfulClicks
  );
  return {
    roomId,
    day,
    targetClicks,
    successfulClicks,
    limitReached: Boolean(value.limitReached) || successfulClicks >= targetClicks,
    updatedAt,
  };
}

function budgetKey(roomId, day) {
  return `${String(day || "").trim()}:${Math.max(0, Math.floor(Number(roomId) || 0))}`;
}

class AutoLikeBudgetStore {
  constructor({ stateDir = "state", filePath = "", now = () => new Date() } = {}) {
    this.filePath = path.resolve(
      filePath || path.join(stateDir, "snapshots", "auto-like-budget.json")
    );
    this.now = typeof now === "function" ? now : () => new Date();
  }

  currentDay(value = this.now()) {
    return localDayKey(value);
  }

  readBudgets() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }

    // 向后兼容旧版只保存一条预算的文件。
    const legacy = normalizeBudget(parsed);
    if (legacy) return { [budgetKey(legacy.roomId, legacy.day)]: legacy };

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("自动点赞预算文件损坏：根节点格式无效");
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, "budgets")) {
      throw new Error("自动点赞预算文件损坏：无法识别文件格式");
    }
    if (!parsed.budgets || typeof parsed.budgets !== "object" || Array.isArray(parsed.budgets)) {
      throw new Error("自动点赞预算文件损坏：budgets 格式无效");
    }
    const rows = parsed.budgets;
    const result = {};
    for (const [key, value] of Object.entries(rows)) {
      const budget = normalizeBudget(value);
      if (!budget) throw new Error(`自动点赞预算文件损坏：记录 ${key} 无效`);
      const canonicalKey = budgetKey(budget.roomId, budget.day);
      if (key !== canonicalKey) {
        throw new Error(`自动点赞预算文件损坏：记录 ${key} 与内容不一致`);
      }
      result[canonicalKey] = budget;
    }
    return result;
  }

  writeBudgets(budgets = {}) {
    const rows = Object.entries(budgets).map(([key, value]) => {
      const budget = normalizeBudget(value);
      if (!budget) throw new Error(`自动点赞预算内容无效：记录 ${key}`);
      return budget;
    });
    rows.sort((left, right) => right.updatedAt - left.updatedAt);
    rows.splice(200);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = {
      version: 1,
      budgets: Object.fromEntries(rows.map((row) => [budgetKey(row.roomId, row.day), row])),
    };
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      try {
        fs.rmSync(tempPath, { force: true });
      } catch {}
      throw error;
    }
  }

  load(roomId, value = this.now()) {
    const expectedRoomId = Math.max(0, Math.floor(Number(roomId) || 0));
    const day = this.currentDay(value);
    return this.readBudgets()[budgetKey(expectedRoomId, day)] || null;
  }

  save(value) {
    const budget = normalizeBudget({
      ...value,
      day: value?.day || this.currentDay(),
      updatedAt: value?.updatedAt || Date.now(),
    });
    if (!budget) throw new Error("自动点赞预算内容无效");
    const budgets = this.readBudgets();
    budgets[budgetKey(budget.roomId, budget.day)] = budget;
    this.writeBudgets(budgets);
    return budget;
  }

  clear(roomId = 0, value = this.now()) {
    const expectedRoomId = Math.max(0, Math.floor(Number(roomId) || 0));
    if (!expectedRoomId) {
      fs.rmSync(this.filePath, { force: true });
      return;
    }
    const budgets = this.readBudgets();
    delete budgets[budgetKey(expectedRoomId, this.currentDay(value))];
    if (Object.keys(budgets).length) this.writeBudgets(budgets);
    else fs.rmSync(this.filePath, { force: true });
  }
}

module.exports = {
  AutoLikeBudgetStore,
  budgetKey,
  localDayKey,
  normalizeBudget,
};
