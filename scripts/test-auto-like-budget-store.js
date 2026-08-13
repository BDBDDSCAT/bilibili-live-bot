"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AutoLikeBudgetStore } = require("../src/autoLikeBudgetStore");

test("auto-like budget survives restart for the same room and local day", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-like-budget-"));
  const now = () => new Date(2026, 7, 9, 12, 0, 0);
  try {
    const first = new AutoLikeBudgetStore({ stateDir, now });
    first.save({
      roomId: 20002,
      day: first.currentDay(),
      targetClicks: 15000,
      successfulClicks: 1234,
      limitReached: false,
    });

    const restarted = new AutoLikeBudgetStore({ stateDir, now });
    assert.deepEqual(restarted.load(20002), {
      roomId: 20002,
      day: "2026-08-09",
      targetClicks: 15000,
      successfulClicks: 1234,
      limitReached: false,
      updatedAt: restarted.load(20002).updatedAt,
    });
    assert.equal(restarted.load(1), null);
    assert.equal(
      new AutoLikeBudgetStore({
        stateDir,
        now: () => new Date(2026, 7, 10, 0, 0, 1),
      }).load(20002),
      null
    );
    assert.equal(
      fs.readdirSync(path.join(stateDir, "snapshots")).some((name) => name.includes(".tmp-")),
      false
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("limit is normalized and explicit clear removes the persisted budget", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-like-budget-"));
  const now = () => new Date(2026, 7, 9, 12, 0, 0);
  try {
    const store = new AutoLikeBudgetStore({ stateDir, now });
    store.save({
      roomId: 42,
      day: store.currentDay(),
      targetClicks: 10000,
      successfulClicks: 20000,
      limitReached: false,
    });
    assert.equal(store.load(42).successfulClicks, 10000);
    assert.equal(store.load(42).limitReached, true);
    store.clear();
    assert.equal(store.load(42), null);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test("budgets are isolated by room so switching away and back cannot reset the daily cap", () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-like-budget-"));
  const now = () => new Date(2026, 7, 9, 12, 0, 0);
  try {
    const store = new AutoLikeBudgetStore({ stateDir, now });
    store.save({ roomId: 10001, targetClicks: 12000, successfulClicks: 11999 });
    store.save({ roomId: 20002, targetClicks: 18000, successfulClicks: 3456 });

    assert.equal(store.load(10001).successfulClicks, 11999);
    assert.equal(store.load(10001).targetClicks, 12000);
    assert.equal(store.load(20002).successfulClicks, 3456);
    assert.equal(store.load(20002).targetClicks, 18000);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
