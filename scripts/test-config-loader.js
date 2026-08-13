"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { DEFAULT_CONFIG, deepMerge, loadConfig, validateConfig } = require("../src/configLoader");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bilibot-config-"));
}

test("默认配置是安全的：不发送、不点赞、不接管浏览器", () => {
  assert.strictEqual(DEFAULT_CONFIG.dryRun, true);
  assert.strictEqual(DEFAULT_CONFIG.send.enabled, false);
  assert.strictEqual(DEFAULT_CONFIG.browserAutomation.enabled, false);
  assert.strictEqual(DEFAULT_CONFIG.browserAutomation.autoLike.enabled, false);
  assert.strictEqual(DEFAULT_CONFIG.browserAutomation.autoLike.onlyWhenLive, true);
  assert.strictEqual(DEFAULT_CONFIG.modules.autoSend.enabled, false);
  assert.strictEqual(DEFAULT_CONFIG.localAi.autoStart, true);
  assert.strictEqual(DEFAULT_CONFIG.localAi.startupTimeoutMs, 15000);
  assert.strictEqual(DEFAULT_CONFIG.localAi.proactive.onlyWhenLive, true);
  assert.strictEqual(DEFAULT_CONFIG.room, "");
});

test("deepMerge 深合并对象、整体替换数组", () => {
  const merged = deepMerge(
    { a: { b: 1, c: 2 }, list: [1, 2, 3] },
    { a: { c: 9 }, list: [4] }
  );
  assert.deepStrictEqual(merged, { a: { b: 1, c: 9 }, list: [4] });
});

test("开播门禁配置只接受布尔值", () => {
  const invalid = validateConfig({
    browserAutomation: { autoLike: { onlyWhenLive: "yes" } },
    localAi: { proactive: { onlyWhenLive: 1 } },
  });
  assert.ok(invalid.errors.includes("browserAutomation.autoLike.onlyWhenLive 必须是布尔值"));
  assert.ok(invalid.errors.includes("localAi.proactive.onlyWhenLive 必须是布尔值"));
  assert.deepStrictEqual(
    validateConfig({
      browserAutomation: { autoLike: { onlyWhenLive: false } },
      localAi: { proactive: { onlyWhenLive: false } },
    }).errors,
    []
  );
});

test("loadConfig 优先读 config.json 并与默认值合并", () => {
  const root = makeTempRoot();
  fs.writeFileSync(
    path.join(root, "config.json"),
    JSON.stringify({ room: "https://live.bilibili.com/123", send: { enabled: true } })
  );
  const config = loadConfig({ rootDir: root });
  assert.strictEqual(config.room, "https://live.bilibili.com/123");
  assert.strictEqual(config.send.enabled, true);
  assert.strictEqual(config.send.maxChars, 40);
  assert.strictEqual(config.__source, "config.json");
  assert.ok(Array.isArray(config.rules));
  fs.rmSync(root, { recursive: true, force: true });
});

test("没有任何配置文件时报出带 npm run setup 指引的错误", () => {
  const root = makeTempRoot();
  assert.throws(() => loadConfig({ rootDir: root }), /npm run setup/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("配置 JSON 语法坏掉时报可读错误而不是裸异常", () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, "config.json"), "{ 坏掉的json");
  assert.throws(() => loadConfig({ rootDir: root }), /解析失败/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("数值越界时校验报中文错误", () => {
  const { errors } = validateConfig(
    deepMerge(DEFAULT_CONFIG, { connection: { fanoutHosts: 99 }, send: { maxChars: 0 } })
  );
  assert.ok(errors.some((item) => item.includes("fanoutHosts")));
  assert.ok(errors.some((item) => item.includes("maxChars")));
});

test("example 兜底模式会被标记，方便启动时提示迁移", () => {
  const root = makeTempRoot();
  fs.writeFileSync(path.join(root, "config.example.json"), JSON.stringify({ room: "" }));
  const config = loadConfig({ rootDir: root, logger: { warn: () => {} } });
  assert.strictEqual(config.__source, "example-fallback");
  fs.rmSync(root, { recursive: true, force: true });
});
