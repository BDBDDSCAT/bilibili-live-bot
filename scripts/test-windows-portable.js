"use strict";

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  MAX_FAT32_FILE_BYTES,
  REQUIRED_PACKAGE_FILES,
  assertNoPathOverlap,
  build,
  copyMigrationState,
  portableConfigBackup,
  sanitizeConfig,
  validatePortableFilePlan,
  validateWindowsRuntime,
  verifyManifest,
  writeManifest,
} = require("./build-windows-portable");

const projectRoot = path.resolve(__dirname, "..");

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bilibot-windows-portable-"));
}

function writeFixture(root, relative, content = "fixture\n") {
  const file = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function writeFakeWindowsX64Node(file) {
  const body = Buffer.alloc(512);
  body.write("MZ", 0, "ascii");
  body.writeUInt32LE(0x80, 0x3c);
  body.write("PE\0\0", 0x80, "ascii");
  body.writeUInt16LE(0x8664, 0x84);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function initializeGitFixture(root) {
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Portable Test",
      "-c",
      "user.email=portable@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ],
    { cwd: root }
  );
}

function createBuildFixture(root) {
  const source = path.join(root, "source");
  const state = path.join(root, "mac-state");
  const runtime = path.join(root, "windows-node");
  const npmCache = path.join(root, "npm-cache");
  const config = path.join(root, "private-config.json");
  fs.mkdirSync(source, { recursive: true });
  for (const relative of REQUIRED_PACKAGE_FILES) {
    if (relative === "PACKAGE_INFO.json") continue;
    const realFile = path.join(projectRoot, ...relative.split("/"));
    const targetFile = path.join(source, ...relative.split("/"));
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.copyFileSync(realFile, targetFile);
  }
  writeFixture(source, "README.md", "portable fixture\n");
  initializeGitFixture(source);

  writeFixture(state, "events/2026-08-21.jsonl", '{"kind":"chat"}\n');
  writeFixture(state, "events/2026-08-21.jsonl.pre-compact-1", "stale\n");
  writeFixture(state, "raw/2026-08-21-123.raw.jsonl", '{"cmd":"DANMU_MSG"}\n');
  writeFixture(state, "snapshots/auto-like-budget.json", "{}\n");
  writeFixture(state, "snapshots/autoSendQueue.json", '{"pending":true}\n');
  writeFixture(state, "overlays/latest.png", "png");
  writeFixture(state, "secrets/bili-login.json", '{"cookie":"secret"}\n');

  writeFakeWindowsX64Node(path.join(runtime, "node.exe"));
  writeFixture(runtime, "npm.cmd", "@echo off\r\n");
  writeFixture(runtime, "node_modules/npm/bin/npm-cli.js", "// npm cli\n");
  writeFixture(npmCache, "content-v2/sha512/aa/cache-entry", "cached tarball\n");
  fs.writeFileSync(
    config,
    `${JSON.stringify(
      {
        room: "https://live.bilibili.com/12345",
        automation: { enabled: true },
        browserAutomation: { enabled: true, autoLike: { enabled: true } },
        modules: { autoLike: { enabled: true }, ai: { enabled: true }, spam: { enabled: true } },
        localAi: { enabled: true, apiKey: "hidden" },
        biliCookie: "SESSDATA=hidden",
      },
      null,
      2
    )}\n`
  );
  return { source, state, runtime, npmCache, config, target: path.join(root, "portable-output") };
}

function runWindowsVerifier(target) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(target, "windows", "verify-package.ps1"),
    ],
    { cwd: target, encoding: "utf8" }
  );
}

test("Windows 迁移配置保留无密偏好，但首次启动关闭所有出站功能", () => {
  const result = sanitizeConfig({
    room: "https://live.bilibili.com/12345",
    dryRun: false,
    send: { enabled: true },
    automation: { enabled: true },
    browserAutomation: {
      enabled: true,
      chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      autoLike: { enabled: true },
    },
    modules: {
      autoSend: { enabled: true },
      autoLike: { enabled: true },
      ai: { enabled: true },
      spam: { enabled: true },
      guardBoard: { enabled: true },
    },
    localAi: {
      enabled: true,
      model: "qwen3.5:4b",
      apiKey: "do-not-copy",
      clientSecret: "do-not-copy",
      csrfToken: "do-not-copy",
      endpoint: "https://user:pass@example.test/v1?access_token=hidden&model=qwen#token=hidden",
    },
    speakEndpoint: "https://example.test/speak?api_key=hidden&voice=one",
    customExecutable: "/Users/test/bin/helper",
    interactions: { welcome: { enabled: true } },
    rules: [{ name: "greeting", enabled: true }],
    timers: [{ name: "reminder", enabled: true }],
    cookie: "do-not-copy",
    biliCookie: "SESSDATA=do-not-copy",
    nested: { authorizationHeader: "Bearer do-not-copy", privateKeyPem: "do-not-copy" },
  });

  assert.strictEqual(result.room, "https://live.bilibili.com/12345");
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(result.send.enabled, false);
  assert.strictEqual(result.automation.enabled, false);
  assert.strictEqual(result.browserAutomation.enabled, false);
  assert.strictEqual(result.browserAutomation.chromeExecutable, "");
  assert.strictEqual(result.browserAutomation.profileDir, "state/browser-profile");
  assert.strictEqual(result.browserAutomation.autoLike.enabled, false);
  assert.strictEqual(result.modules.autoSend.enabled, false);
  assert.strictEqual(result.modules.autoLike.enabled, false);
  assert.strictEqual(result.modules.ai.enabled, false);
  assert.strictEqual(result.modules.spam.enabled, false);
  assert.strictEqual(result.modules.guardBoard.enabled, false);
  assert.strictEqual(result.localAi.enabled, false);
  assert.strictEqual(result.interactions.welcome.enabled, false);
  assert.strictEqual(result.rules[0].enabled, false);
  assert.deepStrictEqual(result.timers, []);
  assert.strictEqual(result.localAi.apiKey, "");
  assert.strictEqual(result.localAi.clientSecret, "");
  assert.strictEqual(result.localAi.csrfToken, "");
  assert.strictEqual(result.localAi.endpoint, "https://example.test/v1?model=qwen");
  assert.strictEqual(result.speakEndpoint, "https://example.test/speak?voice=one");
  assert.strictEqual(result.customExecutable, "");
  assert.strictEqual(result.cookie, "");
  assert.strictEqual(result.biliCookie, "");
  assert.strictEqual(result.nested.authorizationHeader, "");
  assert.strictEqual(result.nested.privateKeyPem, "");
});

test("Windows 迁移参考配置只清理密钥和 macOS 路径，不改变普通 URL 参数", () => {
  const result = portableConfigBackup({
    room: "https://live.bilibili.com/12345?live_from=71002",
    serviceUrl: "https://example.test/api?model=qwen&lang=zh",
    sessionCookieValue: "secret",
    outputDir: "/Users/test/private-output",
  });
  assert.strictEqual(result.room, "https://live.bilibili.com/12345?live_from=71002");
  assert.strictEqual(result.serviceUrl, "https://example.test/api?model=qwen&lang=zh");
  assert.strictEqual(result.sessionCookieValue, "");
  assert.strictEqual(result.outputDir, "");
});

test("Windows 私人历史只复制白名单数据，不复制 Cookie、Profile、日志或旧动作队列", () => {
  const root = tempRoot();
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  try {
    const files = {
      "events/2026-08-21.jsonl": "event\n",
      "events/2026-08-21.jsonl.pre-compact-1": "duplicate\n",
      "raw/2026-08-21-1.raw.jsonl": "raw\n",
      "snapshots/auto-like-budget.json": "{}\n",
      "snapshots/autoSendQueue.json": "{}\n",
      "overlays/latest.png": "png",
      "exports/history.png": "png",
      "secrets/bili-login.json": "secret",
      "browser-profile/Default/Cookies": "secret",
      "logs/bot.log": "log",
    };
    for (const [relative, content] of Object.entries(files)) {
      const file = path.join(source, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    copyMigrationState(source, target);
    assert.ok(fs.existsSync(path.join(target, "events/2026-08-21.jsonl")));
    assert.ok(fs.existsSync(path.join(target, "raw/2026-08-21-1.raw.jsonl")));
    assert.ok(fs.existsSync(path.join(target, "snapshots/auto-like-budget.json")));
    assert.ok(fs.existsSync(path.join(target, "overlays/latest.png")));
    assert.ok(fs.existsSync(path.join(target, "exports/history.png")));
    assert.ok(!fs.existsSync(path.join(target, "events/2026-08-21.jsonl.pre-compact-1")));
    assert.ok(!fs.existsSync(path.join(target, "snapshots/autoSendQueue.json")));
    assert.ok(!fs.existsSync(path.join(target, "secrets")));
    assert.ok(!fs.existsSync(path.join(target, "browser-profile")));
    assert.ok(!fs.existsSync(path.join(target, "logs")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows 包 SHA256 清单使用稳定 POSIX 相对路径且不包含清单自身", () => {
  const root = tempRoot();
  try {
    fs.mkdirSync(path.join(root, "中文 目录"), { recursive: true });
    fs.writeFileSync(path.join(root, "a.txt"), "a");
    fs.writeFileSync(path.join(root, "中文 目录", "b.txt"), "b");
    const result = writeManifest(root);
    assert.strictEqual(result.fileCount, 2);
    const lines = fs.readFileSync(result.manifestPath, "utf8").trim().split("\n");
    assert.strictEqual(lines.length, 2);
    assert.ok(lines.every((line) => /^[0-9a-f]{64}  .+$/.test(line)));
    assert.ok(lines.some((line) => line.endsWith("  中文 目录/b.txt")));
    assert.ok(lines.every((line) => !line.includes("MANIFEST.sha256")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows/FAT32 预检拒绝非法名、保留名、大小写冲突和超 4 GiB 文件", () => {
  assert.doesNotThrow(() =>
    validatePortableFilePlan([
      { relative: "中文 目录/normal.json", size: 12 },
      { relative: "runtime/node/node.exe", size: 1024 },
    ])
  );
  assert.throws(
    () => validatePortableFilePlan([{ relative: "state/CON.txt", size: 1 }]),
    /Windows 保留文件名/
  );
  assert.throws(
    () => validatePortableFilePlan([{ relative: "state/bad:name.json", size: 1 }]),
    /Windows\/FAT32 不支持/
  );
  assert.throws(
    () =>
      validatePortableFilePlan([
        { relative: "State/A.json", size: 1 },
        { relative: "state/a.json", size: 1 },
      ]),
    /大小写不敏感路径冲突/
  );
  assert.throws(
    () => validatePortableFilePlan([{ relative: "large.bin", size: MAX_FAT32_FILE_BYTES + 1 }]),
    /FAT32 单文件/
  );
});

test("输出目录不得与配置、状态、runtime 或 cache 源互相包含", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => assertNoPathOverlap(path.join(root, "state", "portable"), path.join(root, "state"), "状态来源"),
      /互相包含/
    );
    assert.throws(
      () => assertNoPathOverlap(root, path.join(root, "runtime"), "Windows Node 运行时"),
      /互相包含/
    );
    assert.doesNotThrow(() =>
      assertNoPathOverlap(path.join(root, "output"), path.join(root, "state"), "状态来源")
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows 便携 runtime 必须同时包含 x64 PE node.exe 和 npm.cmd", () => {
  const root = tempRoot();
  try {
    writeFakeWindowsX64Node(path.join(root, "node.exe"));
    assert.throws(() => validateWindowsRuntime(root), /缺少必需文件/);
    writeFixture(root, "npm.cmd", "@echo off\r\n");
    assert.doesNotThrow(() => validateWindowsRuntime(root));
    fs.writeFileSync(path.join(root, "node.exe"), Buffer.alloc(64));
    assert.throws(() => validateWindowsRuntime(root), /Windows PE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("端到端 Windows 迁移包可构建且拒绝空、截短、篡改和额外文件", () => {
  const root = tempRoot();
  try {
    const fixture = createBuildFixture(root);
    const result = build({
      root: fixture.source,
      target: fixture.target,
      configSource: fixture.config,
      stateSource: fixture.state,
      nodeRuntime: fixture.runtime,
      npmCache: fixture.npmCache,
    });
    const verified = verifyManifest(fixture.target);
    assert.strictEqual(verified.ok, true);
    assert.strictEqual(verified.checked, result.fileCount);
    assert.strictEqual(result.manifest.expectedEntries, result.fileCount);
    assert.strictEqual(result.sourceDirty, false);
    assert.ok(fs.existsSync(path.join(fixture.target, "runtime/node/node.exe")));
    assert.ok(fs.existsSync(path.join(fixture.target, "runtime/npm-cache/content-v2/sha512/aa/cache-entry")));
    assert.ok(fs.existsSync(path.join(fixture.target, "state/events/2026-08-21.jsonl")));
    assert.ok(!fs.existsSync(path.join(fixture.target, "state/snapshots/autoSendQueue.json")));
    assert.ok(!fs.existsSync(path.join(fixture.target, "state/secrets")));

    const safeConfig = JSON.parse(fs.readFileSync(path.join(fixture.target, "config.json"), "utf8"));
    const previous = JSON.parse(
      fs.readFileSync(path.join(fixture.target, "migration/previous-mac-settings.json"), "utf8")
    );
    assert.strictEqual(safeConfig.browserAutomation.enabled, false);
    assert.strictEqual(safeConfig.modules.spam.enabled, false);
    assert.strictEqual(safeConfig.biliCookie, "");
    assert.strictEqual(previous.biliCookie, "");
    assert.strictEqual(previous.localAi.apiKey, "");

    if (process.platform === "win32") {
      assert.match(runWindowsVerifier(fixture.target), /exact file set confirmed/i);
    }

    const manifestPath = path.join(fixture.target, "MANIFEST.sha256");
    const originalManifest = fs.readFileSync(manifestPath, "utf8");
    const lines = originalManifest.trimEnd().split("\n");
    fs.writeFileSync(manifestPath, `${lines.slice(0, -1).join("\n")}\n`);
    assert.throws(() => verifyManifest(fixture.target), /清单条目数不一致/);
    if (process.platform === "win32") assert.throws(() => runWindowsVerifier(fixture.target));

    fs.writeFileSync(manifestPath, "");
    assert.throws(() => verifyManifest(fixture.target), /清单条目数不一致/);
    fs.writeFileSync(manifestPath, originalManifest);

    const extraPath = writeFixture(fixture.target, "config.local.json", '{"automation":{"enabled":true}}\n');
    assert.throws(() => verifyManifest(fixture.target), /文件数与清单不一致|清单外文件/);
    if (process.platform === "win32") assert.throws(() => runWindowsVerifier(fixture.target));
    fs.rmSync(extraPath, { force: true });

    const packageJson = path.join(fixture.target, "package.json");
    const originalPackageJson = fs.readFileSync(packageJson);
    fs.appendFileSync(packageJson, "tampered\n");
    assert.throws(() => verifyManifest(fixture.target), /SHA256 不一致/);
    fs.writeFileSync(packageJson, originalPackageJson);
    assert.strictEqual(verifyManifest(fixture.target).ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Windows 启动链用 node 直接运行 npm CLI，PID 写入始终受 finally 清理", () => {
  const root = path.resolve(__dirname, "..");
  const common = fs.readFileSync(path.join(root, "windows", "common.ps1"), "utf8");
  const setup = fs.readFileSync(path.join(root, "windows", "setup.ps1"), "utf8");
  const start = fs.readFileSync(path.join(root, "windows", "start.ps1"), "utf8");

  assert.match(common, /node_modules\\npm\\bin\\npm-cli\.js/);
  assert.match(setup, /& \$node \$npmCli @npmArgs/);
  assert.doesNotMatch(setup, /& \$npm(?:\s|$)/m);

  const tryOffset = start.indexOf("try {");
  const pidWriteOffset = start.indexOf("Set-Content -LiteralPath $pidFile");
  const finallyOffset = start.indexOf("} finally {");
  assert.ok(tryOffset >= 0 && pidWriteOffset > tryOffset);
  assert.ok(finallyOffset > pidWriteOffset);
  assert.match(start, /\$null -ne \$server -and -not \$server\.HasExited/);
});
