"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createLogger } = require("../src/logger");
const { runStateRetention } = require("../src/stateRetention");

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function dayKey(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 24 * 60 * 60 * 1000);
  const two = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

test("logger 按天落盘且能清理过期日志", async () => {
  const dir = makeTempDir("bilibot-log-");
  const staleName = `bot-${dayKey(-30)}.log`;
  fs.writeFileSync(path.join(dir, staleName), "old\n");
  const logger = createLogger({ dir, retentionDays: 14, mirrorConsole: false });
  logger.info("test", "第一条日志", { value: 1 });
  logger.warn("test", "第二条日志");
  await new Promise((resolve) => setTimeout(resolve, 50));
  logger.close();
  const todayFile = path.join(dir, `bot-${dayKey(0)}.log`);
  const content = fs.readFileSync(todayFile, "utf8");
  assert.ok(content.includes("第一条日志"));
  assert.ok(content.includes("[WARN]"));
  assert.ok(!fs.existsSync(path.join(dir, staleName)), "过期日志应被清理");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("logger 目录不可写时不抛异常", () => {
  const logger = createLogger({ dir: "/nonexistent-root-dir/logs", mirrorConsole: false });
  assert.doesNotThrow(() => logger.info("test", "should not throw"));
});

test("state 保留策略只删过期文件，当天文件不动，latest 挂件永远保留", () => {
  const stateDir = makeTempDir("bilibot-state-");
  for (const sub of ["raw", "events", "overlays"]) {
    fs.mkdirSync(path.join(stateDir, sub), { recursive: true });
  }
  const oldRaw = path.join(stateDir, "raw", `${dayKey(-90)}-123.raw.jsonl`);
  const freshRaw = path.join(stateDir, "raw", `${dayKey(0)}-123.raw.jsonl`);
  const oldEvents = path.join(stateDir, "events", `${dayKey(-400)}.jsonl`);
  const latestOverlay = path.join(stateDir, "overlays", "gift-scroll-latest.gif");
  fs.writeFileSync(oldRaw, "x\n");
  fs.writeFileSync(freshRaw, "x\n");
  fs.writeFileSync(oldEvents, "x\n");
  fs.writeFileSync(latestOverlay, "x");

  const summary = runStateRetention({
    stateDir,
    retention: { enabled: true, rawDays: 60, eventsDays: 180, overlaysKeep: 1 },
  });
  assert.ok(!fs.existsSync(oldRaw), "90 天前的 raw 应删除");
  assert.ok(fs.existsSync(freshRaw), "当天 raw 必须保留");
  assert.ok(!fs.existsSync(oldEvents), "400 天前的 events 应删除");
  assert.ok(fs.existsSync(latestOverlay), "latest 挂件必须保留");
  assert.strictEqual(summary.removed, 2);
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test("retention.enabled=false 时不动任何文件", () => {
  const stateDir = makeTempDir("bilibot-state-");
  fs.mkdirSync(path.join(stateDir, "raw"), { recursive: true });
  const oldRaw = path.join(stateDir, "raw", `${dayKey(-500)}-1.raw.jsonl`);
  fs.writeFileSync(oldRaw, "x\n");
  const summary = runStateRetention({ stateDir, retention: { enabled: false, rawDays: 1 } });
  assert.ok(fs.existsSync(oldRaw));
  assert.strictEqual(summary.removed, 0);
  fs.rmSync(stateDir, { recursive: true, force: true });
});
