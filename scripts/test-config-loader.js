"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  DEFAULT_CONFIG,
  deepMerge,
  detectChromeExecutable,
  loadConfig,
  validateConfig,
} = require("../src/configLoader");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bilibot-config-"));
}

function assertSafeDefaults(config) {
  assert.strictEqual(config.dryRun, true);
  assert.strictEqual(config.send.enabled, false);
  assert.strictEqual(config.browserAutomation.enabled, false);
  assert.strictEqual(config.browserAutomation.autoLike.enabled, false);
  assert.strictEqual(config.browserAutomation.autoLike.onlyWhenLive, true);
  assert.strictEqual(config.modules.autoSend.enabled, false);
  assert.strictEqual(config.modules.autoLike.enabled, false);
  assert.strictEqual(config.modules.ai.enabled, false);
  assert.strictEqual(config.modules.rotation.enabled, false);
  assert.strictEqual(config.automation.enabled, false);
  assert.strictEqual(config.localAi.enabled, false);
  assert.strictEqual(config.localAi.proactive.enabled, false);
}

test("默认配置是安全的：不发送、不点赞、不接管浏览器", () => {
  assertSafeDefaults(DEFAULT_CONFIG);
  assert.strictEqual(DEFAULT_CONFIG.localAi.autoStart, true);
  assert.strictEqual(DEFAULT_CONFIG.localAi.startupTimeoutMs, 15000);
  assert.strictEqual(DEFAULT_CONFIG.localAi.proactive.onlyWhenLive, true);
  assert.strictEqual(DEFAULT_CONFIG.room, "");
});

test("Windows 会从标准安装目录发现 Chrome", () => {
  const root = makeTempRoot();
  try {
    const chrome = path.join(root, "Google", "Chrome", "Application", "chrome.exe");
    fs.mkdirSync(path.dirname(chrome), { recursive: true });
    fs.writeFileSync(chrome, "fixture");
    assert.strictEqual(
      detectChromeExecutable("", { env: { PROGRAMFILES: root }, platform: "win32" }),
      chrome
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows 只安装 Edge 时也能找到可托管浏览器", () => {
  const root = makeTempRoot();
  try {
    const edge = path.join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    fs.mkdirSync(path.dirname(edge), { recursive: true });
    fs.writeFileSync(edge, "fixture");
    assert.strictEqual(
      detectChromeExecutable("", { env: { PROGRAMFILES: root }, platform: "win32" }),
      edge
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("公开配置模板默认不启用普通固定话术", () => {
  const template = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "config.example.json"), "utf8")
  );
  assert.strictEqual(template.localAi.fallbackToRules, false);
  for (const name of ["greeting", "deduction_one", "six_reaction"]) {
    const rule = template.rules.find((item) => item.name === name);
    assert.ok(rule, `公开模板应保留可选规则 ${name}`);
    assert.strictEqual(rule.enabled, false, `公开模板不得默认开启 ${name}`);
  }
});

test("空配置文件不会隐式开启发送、点赞、AI 或主动聊天", () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, "config.json"), "{}");
    const config = loadConfig({ rootDir: root });
    assertSafeDefaults(config);
    assert.strictEqual(config.room, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("仅有 room 的旧配置不会继承危险功能开关", () => {
  const root = makeTempRoot();
  try {
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ room: "1985118453" }));
    const config = loadConfig({ rootDir: root });
    assertSafeDefaults(config);
    assert.strictEqual(config.room, "1985118453");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
