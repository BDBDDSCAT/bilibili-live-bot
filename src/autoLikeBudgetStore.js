"use strict";

const fs = require("node:fs");
const path = require("node:path");

function localDayKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  const two = (part) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function normalizeBudget(value) {
  if (!value || typeof value !== "object") return null;
  const roomId = Math.max(0, Math.floor(Number(value.roomId) || 0));
  const day = String(value.day || "").trim();
  const targetClicks = Math.floor(Number(value.targetClicks) || 0);
  const successfulClicks = Math.min(
    targetClicks,
    Math.max(0, Math.floor(Number(value.successfulClicks) || 0))
  );
  if (!roomId || !/^\d{4}-\d{2}-\d{2}$/.test(day) || targetClicks <= 0) return null;
  return {
    roomId,
    day,
    targetClicks,
    successfulClicks,
    limitReached: Boolean(value.limitReached) || successfulClicks >= targetClicks,
    updatedAt: Math.max(0, Math.floor(Number(value.updatedAt) || 0)),
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

    const rows = parsed?.budgets && typeof parsed.budgets === "object" ? parsed.budgets : {};
    const result = {};
    for (const value of Object.values(rows)) {
      const budget = normalizeBudget(value);
      if (budget) result[budgetKey(budget.roomId, budget.day)] = budget;
    }
    return result;
  }

  writeBudgets(budgets = {}) {
    const rows = Object.values(budgets)
      .map(normalizeBudget)
      .filter(Boolean)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 200);
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
