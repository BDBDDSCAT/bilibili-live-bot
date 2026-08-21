#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const MAX_FAT32_FILE_BYTES = 0xffffffff;
const REQUIRED_PACKAGE_FILES = [
  "PACKAGE_INFO.json",
  "package.json",
  "WINDOWS-1-SETUP.cmd",
  "WINDOWS-2-START.cmd",
  "WINDOWS-3-INSTALL-AI.cmd",
  "WINDOWS-4-VERIFY.cmd",
  "WINDOWS-START-HERE.txt",
  "docs/WINDOWS.md",
  "scripts/build-windows-portable.js",
  "scripts/test-windows-portable.js",
  "windows/common.ps1",
  "windows/setup-ai.ps1",
  "windows/setup.ps1",
  "windows/start.ps1",
  "windows/verify-package.ps1",
];
const REQUIRED_TRACKED_WINDOWS_FILES = REQUIRED_PACKAGE_FILES.filter(
  (file) => file !== "PACKAGE_INFO.json"
);
const ALLOWED_SNAPSHOT_FILES = new Set([
  "auto-like-budget.json",
  "giftCatalog.json",
  "guardCatalog.json",
  "manualGiftCorrections.json",
  "manualGuardBoard.json",
]);

function normalizedSecretKey(key = "") {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key = "") {
  const normalized = normalizedSecretKey(key);
  return Boolean(
    normalized &&
      (normalized.includes("cookie") ||
        normalized.includes("token") ||
        normalized.includes("secret") ||
        normalized.includes("password") ||
        normalized.includes("passwd") ||
        normalized.includes("passcode") ||
        normalized.includes("authorization") ||
        normalized.includes("apikey") ||
        normalized.includes("privatekey") ||
        normalized === "csrf" ||
        normalized === "sessdata" ||
        normalized === "bilijct" ||
        normalized === "dedeuserid")
  );
}

function scrubUrlCredentials(value = "") {
  const source = String(value || "");
  let parsed;
  try {
    parsed = new URL(source);
  } catch {
    return source;
  }
  if (!/^(?:https?|wss?):$/.test(parsed.protocol)) return source;
  let changed = false;
  if (parsed.username || parsed.password) {
    parsed.username = "";
    parsed.password = "";
    changed = true;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      parsed.searchParams.delete(key);
      changed = true;
    }
  }
  if (parsed.hash && /(?:cookie|token|secret|password|authorization|api.?key)/i.test(parsed.hash)) {
    parsed.hash = "";
    changed = true;
  }
  return changed ? parsed.toString() : source;
}

function isMacPathSetting(key = "", value = "") {
  const normalized = normalizedSecretKey(key);
  if (!/(?:path|dir|directory|executable)$/.test(normalized)) return false;
  return /^\/(?:Applications|Library|System|Users|Volumes|opt|private|tmp|usr|var)(?:\/|$)/.test(
    String(value || "")
  );
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) result[key] = true;
    else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function portableConfigBackup(config = {}) {
  const next = JSON.parse(JSON.stringify(config || {}));
  const scrubSecrets = (value) => {
    if (Array.isArray(value)) {
      value.forEach(scrubSecrets);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        value[key] = "";
      } else if (typeof child === "string" && isMacPathSetting(key, child)) {
        value[key] = "";
      } else if (typeof child === "string") {
        value[key] = scrubUrlCredentials(child);
      } else {
        scrubSecrets(child);
      }
    }
  };
  scrubSecrets(next);
  next.browserAutomation = {
    ...(next.browserAutomation || {}),
    chromeExecutable: "",
    profileDir: "state/browser-profile",
  };
  next.screenshots = { ...(next.screenshots || {}), enabled: false };
  delete next.__path;
  delete next.__source;
  return next;
}

function sanitizeConfig(config = {}) {
  const next = portableConfigBackup(config);
  next.dryRun = true;
  next.send = { ...(next.send || {}), enabled: false };
  next.automation = { ...(next.automation || {}), enabled: false };
  next.browserAutomation = {
    ...(next.browserAutomation || {}),
    enabled: false,
    autoLike: { ...(next.browserAutomation?.autoLike || {}), enabled: false },
  };
  next.modules = {
    ...(next.modules || {}),
    autoSend: { ...(next.modules?.autoSend || {}), enabled: false },
    autoLike: { ...(next.modules?.autoLike || {}), enabled: false },
    welcome: { ...(next.modules?.welcome || {}), enabled: false },
    giftThanks: { ...(next.modules?.giftThanks || {}), enabled: false },
    pk: { ...(next.modules?.pk || {}), enabled: false },
    rotation: { ...(next.modules?.rotation || {}), enabled: false },
    ai: { ...(next.modules?.ai || {}), enabled: false },
    spam: { ...(next.modules?.spam || {}), enabled: false },
    guardBoard: { ...(next.modules?.guardBoard || {}), enabled: false },
  };
  next.localAi = {
    ...(next.localAi || {}),
    enabled: false,
    proactive: { ...(next.localAi?.proactive || {}), enabled: false },
  };
  if (Array.isArray(next.rules)) {
    next.rules = next.rules.map((rule) => ({ ...(rule || {}), enabled: false }));
  }
  next.timers = [];
  if (next.interactions && typeof next.interactions === "object") {
    for (const value of Object.values(next.interactions)) {
      if (value && typeof value === "object" && !Array.isArray(value) && "enabled" in value) {
        value.enabled = false;
      }
    }
  }
  return next;
}

function toPosixPath(value = "") {
  return String(value).split(path.sep).join("/");
}

function validatePortableRelativePath(relative = "") {
  const value = toPosixPath(relative);
  if (!value || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error(`Windows 便携包路径必须是相对路径：${relative}`);
  }
  const segments = value.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") {
      throw new Error(`Windows 便携包路径不合法：${relative}`);
    }
    if (/[<>:"\\|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment)) {
      throw new Error(`Windows/FAT32 不支持文件名：${relative}`);
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) {
      throw new Error(`Windows 保留文件名不可用：${relative}`);
    }
    if (segment.length > 255) {
      throw new Error(`Windows/FAT32 文件名超过 255 个 UTF-16 字符：${relative}`);
    }
  }
  return value;
}

function filePlanEntry(source, relative) {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error(`便携包不接受符号链接：${source}`);
  if (!stat.isFile()) throw new Error(`便携包来源不是普通文件：${source}`);
  return {
    source,
    relative: validatePortableRelativePath(relative),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ino: stat.ino,
  };
}

function collectTreeFiles(source, relativeRoot = "", accept = () => true) {
  if (!fs.existsSync(source)) return [];
  const rootStat = fs.lstatSync(source);
  if (rootStat.isSymbolicLink()) throw new Error(`便携包不接受符号链接：${source}`);
  if (!rootStat.isDirectory()) throw new Error(`便携包来源不是目录：${source}`);
  const result = [];
  const walk = (current, currentRelative) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = currentRelative ? `${currentRelative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`便携包不接受符号链接：${absolute}`);
      }
      if (!accept(absolute, entry, relative)) continue;
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) result.push(filePlanEntry(absolute, relative));
      else throw new Error(`便携包不接受特殊文件：${absolute}`);
    }
  };
  const normalizedRoot = relativeRoot ? validatePortableRelativePath(relativeRoot) : "";
  walk(source, normalizedRoot);
  return result;
}

function migrationStatePlan(sourceState, prefix = "") {
  const plan = [];
  const add = (directory, accept = () => true) => {
    const relativeRoot = [prefix, directory].filter(Boolean).join("/");
    plan.push(
      ...collectTreeFiles(path.join(sourceState, directory), relativeRoot, (file, entry) =>
        entry.isDirectory() || accept(file, entry)
      )
    );
  };
  add("events", (file, entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
  add("raw", (file, entry) => entry.isFile() && entry.name.endsWith(".raw.jsonl"));
  add("snapshots", (file, entry) => entry.isFile() && ALLOWED_SNAPSHOT_FILES.has(entry.name));
  for (const directory of ["exports", "overlays", "observations"]) add(directory);
  return plan;
}

function validatePortableFilePlan(plan = []) {
  const seen = new Map();
  for (const entry of plan) {
    const relative = validatePortableRelativePath(entry.relative);
    const collisionKey = relative.normalize("NFC").toLowerCase();
    const previous = seen.get(collisionKey);
    if (previous) {
      throw new Error(`Windows 大小写不敏感路径冲突：${previous} / ${relative}`);
    }
    seen.set(collisionKey, relative);
    const size = Number(entry.size ?? (entry.source ? fs.lstatSync(entry.source).size : 0));
    if (!Number.isFinite(size) || size < 0) throw new Error(`无法确认文件大小：${relative}`);
    if (size > MAX_FAT32_FILE_BYTES) {
      throw new Error(`FAT32 单文件不能超过 4 GiB - 1 字节：${relative}`);
    }
  }
  return plan;
}

function copyFile(source, destination, expected = null) {
  const before = fs.lstatSync(source);
  if (before.isSymbolicLink()) throw new Error(`便携包不接受符号链接：${source}`);
  if (!before.isFile()) throw new Error(`便携包来源不是普通文件：${source}`);
  if (
    expected &&
    (before.size !== expected.size || before.mtimeMs !== expected.mtimeMs || before.ino !== expected.ino)
  ) {
    throw new Error(`来源文件在打包前发生变化，请停止旧机器服务后重试：${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  const after = fs.lstatSync(source);
  const copied = fs.lstatSync(destination);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino ||
    copied.size !== before.size
  ) {
    throw new Error(`来源文件在复制期间发生变化，请停止旧机器服务后重试：${source}`);
  }
}

function copyPlan(plan, target) {
  for (const entry of plan) {
    copyFile(entry.source, path.join(target, ...entry.relative.split("/")), entry);
  }
  return plan.length;
}

function copyMigrationState(sourceState, targetState) {
  const plan = migrationStatePlan(path.resolve(sourceState));
  validatePortableFilePlan(plan);
  return copyPlan(plan, path.resolve(targetState));
}

function trackedFiles(root = projectRoot) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function listFiles(root) {
  const result = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) result.push(path.relative(root, absolute).split(path.sep).join("/"));
      else if (entry.isSymbolicLink()) throw new Error(`便携包不接受符号链接：${absolute}`);
      else throw new Error(`便携包不接受特殊文件：${absolute}`);
    }
  }
  walk(root);
  return result.sort((left, right) => left.localeCompare(right, "en"));
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeManifest(root, options = {}) {
  const manifestPath = path.join(root, "MANIFEST.sha256");
  const files = listFiles(root).filter((file) => file !== "MANIFEST.sha256");
  validatePortableFilePlan(files.map((relative) => ({ relative, size: fs.lstatSync(path.join(root, ...relative.split("/"))).size })));
  if (options.expectedCount !== undefined && files.length !== Number(options.expectedCount)) {
    throw new Error(`清单条目数不一致：预期 ${options.expectedCount}，实际 ${files.length}`);
  }
  const lines = files
    .map((file) => `${sha256(path.join(root, ...file.split("/")))}  ${file}`);
  fs.writeFileSync(manifestPath, `${lines.join("\n")}\n`, "utf8");
  return { manifestPath, fileCount: lines.length };
}

function verifyManifest(root) {
  const packageRoot = path.resolve(root);
  const infoPath = path.join(packageRoot, "PACKAGE_INFO.json");
  const manifestPath = path.join(packageRoot, "MANIFEST.sha256");
  if (!fs.existsSync(infoPath) || !fs.existsSync(manifestPath)) {
    throw new Error("便携包缺少 PACKAGE_INFO.json 或 MANIFEST.sha256");
  }
  const info = JSON.parse(fs.readFileSync(infoPath, "utf8"));
  const expectedCount = Number(info.manifest?.expectedEntries);
  if (info.manifest?.algorithm !== "sha256" || !Number.isInteger(expectedCount) || expectedCount <= 0) {
    throw new Error("PACKAGE_INFO.json 缺少有效的清单协议信息");
  }
  const rawLines = fs.readFileSync(manifestPath, "utf8").split(/\r?\n/);
  if (rawLines.at(-1) === "") rawLines.pop();
  if (rawLines.length !== expectedCount) {
    throw new Error(`清单条目数不一致：预期 ${expectedCount}，实际 ${rawLines.length}`);
  }
  const listed = new Map();
  for (const line of rawLines) {
    const match = line.match(/^([0-9a-fA-F]{64})  (.+)$/);
    if (!match) throw new Error(`清单行不合法：${line}`);
    const relative = validatePortableRelativePath(match[2]);
    if (relative === "MANIFEST.sha256") throw new Error("清单不得包含自身");
    const key = relative.normalize("NFC").toLowerCase();
    if (listed.has(key)) throw new Error(`清单路径重复：${relative}`);
    listed.set(key, { relative, expected: match[1].toLowerCase() });
  }
  for (const required of REQUIRED_PACKAGE_FILES) {
    if (!listed.has(required.toLowerCase())) throw new Error(`清单缺少必需文件：${required}`);
  }
  const actualFiles = listFiles(packageRoot).filter((file) => file !== "MANIFEST.sha256");
  if (actualFiles.length !== listed.size) {
    throw new Error(`便携包文件数与清单不一致：清单 ${listed.size}，实际 ${actualFiles.length}`);
  }
  for (const relative of actualFiles) {
    const key = relative.normalize("NFC").toLowerCase();
    if (!listed.has(key)) throw new Error(`发现清单外文件：${relative}`);
  }
  for (const { relative, expected } of listed.values()) {
    const file = path.join(packageRoot, ...relative.split("/"));
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) throw new Error(`清单文件缺失：${relative}`);
    const actual = sha256(file);
    if (actual !== expected) throw new Error(`SHA256 不一致：${relative}`);
  }
  return { ok: true, checked: listed.size, expected: expectedCount };
}

function pathIsWithin(candidate, parent) {
  const childPath = path.resolve(candidate);
  const parentPath = path.resolve(parent);
  return childPath === parentPath || childPath.startsWith(`${parentPath}${path.sep}`);
}

function assertNoPathOverlap(target, source, label = "来源") {
  if (!source) return;
  if (pathIsWithin(target, source) || pathIsWithin(source, target)) {
    throw new Error(`输出目录不得与${label}互相包含：${target} / ${source}`);
  }
}

function resolveSource(value, label, kind) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label} 必须提供路径参数`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) throw new Error(`${label}不存在：${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label}不得是符号链接：${resolved}`);
  if (kind === "file" && !stat.isFile()) throw new Error(`${label}必须是文件：${resolved}`);
  if (kind === "directory" && !stat.isDirectory()) throw new Error(`${label}必须是目录：${resolved}`);
  return resolved;
}

function validateWindowsRuntime(runtimeDir) {
  const nodeExe = path.join(runtimeDir, "node.exe");
  const npmCmd = path.join(runtimeDir, "npm.cmd");
  for (const file of [nodeExe, npmCmd]) {
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) {
      throw new Error(`Windows 运行时缺少必需文件：${file}`);
    }
  }
  const header = Buffer.alloc(64);
  const descriptor = fs.openSync(nodeExe, "r");
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length || header.toString("ascii", 0, 2) !== "MZ") {
      throw new Error("runtime/node.exe 不是 Windows PE 可执行文件");
    }
    const peOffset = header.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    if (fs.readSync(descriptor, peHeader, 0, peHeader.length, peOffset) !== peHeader.length) {
      throw new Error("runtime/node.exe 的 PE 头不完整");
    }
    if (peHeader.toString("ascii", 0, 4) !== "PE\0\0" || peHeader.readUInt16LE(4) !== 0x8664) {
      throw new Error("runtime/node.exe 必须是 Windows x64 PE 可执行文件");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { nodeExe, npmCmd };
}

function build(options = {}) {
  const root = path.resolve(options.root || projectRoot);
  if (typeof options.target !== "string" || !options.target.trim()) {
    throw new Error("必须提供 --target <输出目录>");
  }
  const target = path.resolve(options.target);
  const configSource = resolveSource(options.configSource, "配置来源", "file");
  const stateSource = resolveSource(options.stateSource, "状态来源", "directory");
  const nodeRuntime = resolveSource(options.nodeRuntime, "Windows Node 运行时", "directory");
  const npmCache = resolveSource(options.npmCache, "npm 离线缓存", "directory");
  assertNoPathOverlap(target, root, "项目源码");
  assertNoPathOverlap(target, configSource, "配置来源");
  assertNoPathOverlap(target, stateSource, "状态来源");
  assertNoPathOverlap(target, nodeRuntime, "Windows Node 运行时");
  assertNoPathOverlap(target, npmCache, "npm 离线缓存");
  if (fs.existsSync(target)) throw new Error(`目标已存在，不会覆盖：${target}`);

  const tracked = trackedFiles(root);
  for (const required of REQUIRED_TRACKED_WINDOWS_FILES) {
    if (!tracked.includes(required)) {
      throw new Error(`Windows 便携包必需文件尚未被 Git 跟踪：${required}`);
    }
  }
  const projectPlan = tracked.map((relative) => filePlanEntry(path.join(root, relative), relative));
  const statePlan = stateSource ? migrationStatePlan(stateSource, "state") : [];
  const runtimePlan = nodeRuntime ? collectTreeFiles(nodeRuntime, "runtime/node") : [];
  const cachePlan = npmCache ? collectTreeFiles(npmCache, "runtime/npm-cache") : [];
  if (nodeRuntime) validateWindowsRuntime(nodeRuntime);

  let config = null;
  let safeConfigText = "";
  let previousSettingsText = "";
  const migrationReadme =
    "Reference only: previous-mac-settings.json preserves prior feature preferences after secrets and macOS paths were removed. Do not rename it to config.json. Enable features from the Windows web console after logging in.\n";
  if (configSource) {
    config = JSON.parse(fs.readFileSync(configSource, "utf8"));
    safeConfigText = `${JSON.stringify(sanitizeConfig(config), null, 2)}\n`;
    previousSettingsText = `${JSON.stringify(portableConfigBackup(config), null, 2)}\n`;
  }
  const generatedPlan = [
    { relative: "PACKAGE_INFO.json", size: 0 },
    { relative: "MANIFEST.sha256", size: 0 },
    ...(configSource
      ? [
          { relative: "config.json", size: Buffer.byteLength(safeConfigText) },
          { relative: "migration/previous-mac-settings.json", size: Buffer.byteLength(previousSettingsText) },
          { relative: "migration/README.txt", size: Buffer.byteLength(migrationReadme) },
        ]
      : []),
  ];
  validatePortableFilePlan([
    ...projectPlan,
    ...statePlan,
    ...runtimePlan,
    ...cachePlan,
    ...generatedPlan,
  ]);

  fs.mkdirSync(target, { recursive: true });
  copyPlan(projectPlan, target);
  copyPlan(statePlan, target);
  copyPlan(runtimePlan, target);
  copyPlan(cachePlan, target);
  if (configSource) {
    fs.writeFileSync(path.join(target, "config.json"), safeConfigText, "utf8");
    fs.mkdirSync(path.join(target, "migration"), { recursive: true });
    fs.writeFileSync(path.join(target, "migration", "previous-mac-settings.json"), previousSettingsText, "utf8");
    fs.writeFileSync(path.join(target, "migration", "README.txt"), migrationReadme, "utf8");
  }

  const historyFiles = statePlan.length;

  let commit = "unknown";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    // 非 Git 源码包仍可构建，但会明确记录 unknown。
  }
  let sourceDirty = true;
  try {
    sourceDirty = Boolean(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: root,
        encoding: "utf8",
      }).trim()
    );
  } catch {}
  const expectedManifestEntries = listFiles(target).filter((file) => file !== "MANIFEST.sha256").length + 1;
  const info = {
    packageType: options.stateSource ? "private-windows-migration" : "windows-portable",
    createdAt: new Date().toISOString(),
    sourceCommit: commit,
    sourceDirty,
    architecture: "windows-x64",
    historyFiles,
    manifest: {
      algorithm: "sha256",
      expectedEntries: expectedManifestEntries,
      exactFileSet: true,
    },
    firstRunSafety: {
      browserAutomationEnabled: false,
      automationEnabled: false,
      dryRun: true,
      outboundFeaturesEnabled: false,
      requiresFreshBilibiliLogin: true,
    },
    excluded: [
      ".git",
      "macOS node_modules",
      "state/browser-profile",
      "state/secrets",
      "state/logs",
      "state/private-archive",
      "state/debug-images",
      "stale action/runtime snapshots",
      "Ollama models",
    ],
  };
  fs.writeFileSync(path.join(target, "PACKAGE_INFO.json"), `${JSON.stringify(info, null, 2)}\n`);
  const manifest = writeManifest(target, { expectedCount: expectedManifestEntries });
  verifyManifest(target);
  return { target, ...manifest, ...info };
}

if (require.main === module) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = build({
      target: args.target,
      configSource: args["config-source"],
      stateSource: args["state-source"],
      nodeRuntime: args["node-runtime"],
      npmCache: args["npm-cache"],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_SNAPSHOT_FILES,
  MAX_FAT32_FILE_BYTES,
  REQUIRED_PACKAGE_FILES,
  assertNoPathOverlap,
  build,
  copyMigrationState,
  isSensitiveKey,
  listFiles,
  portableConfigBackup,
  sanitizeConfig,
  scrubUrlCredentials,
  validatePortableFilePlan,
  validatePortableRelativePath,
  validateWindowsRuntime,
  verifyManifest,
  writeManifest,
};
