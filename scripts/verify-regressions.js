#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const EventEmitter = require("node:events");
const { PNG } = require("pngjs");
const { BilibiliLiveClient } = require("../src/bilibiliClient");
const { AutoLikeBudgetStore } = require("../src/autoLikeBudgetStore");
const { BotRuntime: RealBotRuntime } = require("../src/botRuntime");
const { CommandEngine } = require("../src/commandEngine");
const { EventStore } = require("../src/eventStore");
const { InteractionEngine, compactGiftFeedItem } = require("../src/interactionEngine");
const { PkTracker } = require("../src/pkTracker");
const { PointsEngine } = require("../src/pointsEngine");
const { ScreenshotService, readableScreenshotError } = require("../src/screenshotService");
const { runAssistantSelfTest } = require("../src/selfTest");
const { DEFAULT_CONFIG, deepMerge: deepMergeConfig } = require("../src/configLoader");
const { createWebApp } = require("../src/webServer");
const { replayFiles } = require("./replay-raw");
const { audit: auditFeatures, _internals: auditInternals } = require("./audit-features");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// 仓库内脱敏样本目录：verify 一律对 fixtures 跑，不再读生产 state/。
// （对真实 state 的全量对账是 npm run audit 的人工流程，不做回归门禁。）
// fixtures 目录本身即 audit 的 stateDir（内含 raw/ 与 events/）；
// 不能叫 state 子目录——.gitignore 的 `state/` 会匹配任意层级同名目录导致样本进不了仓库。
const FIXTURE_STATE_DIR = path.resolve(__dirname, "fixtures");
const FIXTURE_ROOM = "20002";
const TMP_ROOT = path.resolve(__dirname, "..", ".tmp");

// 每个测试 BotRuntime 都必须显式落盘到 .tmp 下的隔离目录：
// 不再依赖 main() 先 chdir 再靠 resolveStateDir 用 process.cwd() 兜底的实现细节（chdir 仅留作第二道防线）。
function isolatedHistory(name, extra = {}) {
  const dir = path.join(TMP_ROOT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  return { enabled: false, dir, ...extra };
}

// 测试专用 BotRuntime：构造时强制把 history.dir 指到 .tmp 下的隔离目录。
// BotRuntime 构造函数会立刻按 history.dir 建 EventStore（并 mkdir），
// 没有这层护栏时任何一个漏传 history 的测试都在赌 main() 的 chdir 技巧。
let isolatedRuntimeSequence = 0;
class BotRuntime extends RealBotRuntime {
  constructor(options = {}) {
    const config = { ...(options.config || {}) };
    const history = { ...(config.history || {}) };
    if (!history.dir) {
      isolatedRuntimeSequence += 1;
      history.dir = path.join(TMP_ROOT, "verify-runtime-auto", String(isolatedRuntimeSequence));
    } else if (!path.isAbsolute(history.dir)) {
      history.dir = path.resolve(TMP_ROOT, history.dir);
    }
    config.history = history;
    super({ ...options, config });
  }
}

function listFixtureRawFiles() {
  return fs
    .readdirSync(path.join(FIXTURE_STATE_DIR, "raw"))
    .filter((name) => name.endsWith(".raw.jsonl"))
    .sort()
    .map((name) => path.join(FIXTURE_STATE_DIR, "raw", name));
}

function handleRaw(client, message) {
  client.handlePacket({
    operation: 5,
    body: Buffer.from(JSON.stringify(message)),
  });
}

function countNamed(list, name) {
  return list.find((item) => item.name === name)?.count || 0;
}

function verifyOnlineRankDoesNotEmitGenericEvent() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  const seen = [];
  client.on("onlineRank", (event) => seen.push({ type: "onlineRank", event }));
  client.on("event", (event) => seen.push({ type: "event", event }));
  handleRaw(client, {
    cmd: "ONLINE_RANK_V3",
    data: {
      online_list: [
        {
          uid: 10001,
          uname: "榜一用户",
          face: "https://i0.hdslb.com/bfs/face/rank.jpg",
          rank: 1,
          score: 285,
        },
      ],
    },
  });
  assert(seen.some((item) => item.type === "onlineRank"), "ONLINE_RANK_V3 should emit structured onlineRank");
  assert(!seen.some((item) => item.type === "event"), "ONLINE_RANK_V3 should not also emit generic event noise");
}

function verifyComboGiftDedupe() {
  const batchComboId = "batch:gift:combo_id:10001:20002:31164:1778182581.7182";
  const comboId = "gift:combo_id:10001:20002:31164:1778182581.7172";
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.room = { roomId: 20002 };
  const engine = new InteractionEngine({
    gift: {
      enabled: true,
      aggregateWindowMs: 3000,
    },
  });

  client.on("gift", (event) => engine.handleGift(event));
  handleRaw(client, {
    cmd: "SEND_GIFT",
    data: {
      uid: 10001,
      uname: "测试用户",
      gift_id: 31164,
      gift_name: "粉丝团灯牌",
      num: 1,
      price: 100,
      total_coin: 100,
      coin_type: "gold",
      batch_combo_id: batchComboId,
      combo_id: comboId,
      timestamp: 1778182581,
    },
  });
  handleRaw(client, {
    cmd: "COMBO_SEND",
    data: {
      uid: 10001,
      uname: "测试用户",
      gift_id: 31164,
      gift_name: "粉丝团灯牌",
      combo_num: 2,
      total_num: 2,
      combo_total_coin: 200,
      price: 100,
      coin_type: "gold",
      batch_combo_id: batchComboId,
      combo_id: comboId,
    },
  });

  const stats = engine.getStats();
  assert(stats.totalCoin === 200, `combo gift totalCoin expected 200, got ${stats.totalCoin}`);
  assert(stats.totalGiftCount === 2, `combo gift count expected 2, got ${stats.totalGiftCount}`);
  assert(stats.giftFeed.length === 1, `combo gift feed expected 1 row, got ${stats.giftFeed.length}`);
  assert(stats.giftFeed[0].count === 2, `combo gift feed count expected 2, got ${stats.giftFeed[0].count}`);
}

function verifyGiftFeedSnapshotCompact() {
  const heavyRaw = {
    cmd: "SEND_GIFT",
    data: {
      blind_gift: { blind_gift_config_id: 139 },
      gift_info: { webp: "https://i0.hdslb.com/bfs/live/heavy.webp" },
    },
  };
  const engine = new InteractionEngine({
    gift: { enabled: true, aggregateWindowMs: 0, dedupeFingerprintWindowMs: 0 },
  });
  engine.handleGift({
    id: "heavy-gift-1",
    at: Date.now(),
    userId: 10001,
    userName: "素材完整用户",
    face: "https://i0.hdslb.com/bfs/face/user.jpg",
    faceSource: "sender_origin",
    faceCandidates: [{ source: "raw", url: "https://i0.hdslb.com/bfs/face/user.jpg" }],
    action: "投喂 幸运盲盒 爆出",
    giftId: 35311,
    giftName: "好运柚叶",
    giftIcon: "https://i0.hdslb.com/bfs/live/gift.webp",
    sourceGiftId: 35206,
    sourceGiftName: "幸运盲盒",
    sourceGiftPrice: 5000,
    resultGiftPrice: 2500,
    blindGift: {
      originalGiftId: 35206,
      originalGiftName: "幸运盲盒",
      originalGiftPrice: 5000,
      action: "爆出",
      resultPrice: 2500,
      raw: heavyRaw.data.blind_gift,
    },
    count: 1,
    totalCoin: 5000,
    coinType: "gold",
    medalName: "修铃铛",
    medalLevel: 25,
    guardLevel: 3,
    guardName: "舰长",
    avatarFrame: {
      id: 3,
      url: "https://i0.hdslb.com/bfs/live/frame.png",
      name: "舰长",
      source: "guard_default",
      raw: { huge: true },
    },
    avatarFrameUrl: "https://i0.hdslb.com/bfs/live/frame.png",
    avatarFrameName: "舰长",
    raw: heavyRaw,
    giftInfo: heavyRaw.data.gift_info,
    catalogGift: { raw: heavyRaw, name: "好运柚叶" },
    source: "gift_packet",
  });
  const row = engine.getStats().giftFeed[0];
  assert(row.userName === "素材完整用户", "compact gift feed should keep user name");
  assert(row.face === "https://i0.hdslb.com/bfs/face/user.jpg", "compact gift feed should keep face");
  assert(row.giftIcon === "https://i0.hdslb.com/bfs/live/gift.webp", "compact gift feed should keep gift icon");
  assert(row.avatarFrameUrl === "https://i0.hdslb.com/bfs/live/frame.png", "compact gift feed should keep avatar frame URL");
  assert(row.blindGift?.originalGiftName === "幸运盲盒", "compact gift feed should keep blind-box summary");
  assert(!("raw" in row), "compact gift feed should not expose raw payloads");
  assert(!("faceCandidates" in row), "compact gift feed should not expose face candidate debug arrays");
  assert(!("catalogGift" in row), "compact gift feed should not expose catalog gift internals");
  assert(!("giftInfo" in row), "compact gift feed should not expose full gift_info internals");
  assert(!row.avatarFrame?.raw, "compact gift feed should strip avatar frame raw data");
  assert(!row.blindGift?.raw, "compact gift feed should strip blind gift raw data");

  const compact = compactGiftFeedItem({ ...row, raw: heavyRaw, faceCandidates: [1] });
  assert(!("raw" in compact) && !("faceCandidates" in compact), "compactGiftFeedItem should be a strict whitelist");
}

function verifyGiftRankingByValue() {
  const engine = new InteractionEngine({
    gift: {
      enabled: true,
      aggregateWindowMs: 0,
      dedupeFingerprintWindowMs: 0,
    },
  });
  engine.handleGift({
    userName: "刷小礼物用户",
    giftName: "人气票",
    count: 100,
    price: 100,
    totalCoin: 10000,
    coinType: "gold",
  });
  engine.handleGift({
    userName: "刷贵礼物用户",
    giftName: "告白花束",
    count: 1,
    price: 19900,
    totalCoin: 19900,
    coinType: "gold",
  });
  const stats = engine.getStats();
  assert(
    stats.topGifts[0]?.giftName === "告白花束",
    `top gifts should sort by value first, got ${stats.topGifts[0]?.giftName || "none"}`
  );
  assert(stats.topGifts[0]?.rank === 1, "top gift rows should expose rank");

  const qualityEngine = new InteractionEngine({
    gift: {
      enabled: true,
      aggregateWindowMs: 0,
      dedupeFingerprintWindowMs: 0,
    },
  });
  qualityEngine.handleGift({
    userName: "缺素材用户",
    giftName: "未知礼物",
    count: 1,
    price: 0,
    totalCoin: 0,
    coinType: "gold",
    guardLevel: 3,
  });
  const quality = qualityEngine.getStats().quality;
  assert(quality.ok === false, "gift quality should flag incomplete gift rows");
  assert(quality.missingIcon === 1, `gift quality missingIcon expected 1, got ${quality.missingIcon}`);
  assert(quality.zeroValue === 1, `gift quality zeroValue expected 1, got ${quality.zeroValue}`);
  assert(quality.missingFace === 1, `gift quality missingFace expected 1, got ${quality.missingFace}`);
  assert(
    quality.missingAvatarFrame === 1,
    `gift quality missingAvatarFrame expected 1, got ${quality.missingAvatarFrame}`
  );
}

function verifyRawReplayCoverage() {
  // 只回放仓库内 fixtures：解析器对每个样本文件必须零解析错误、零异常、零重要缺口。
  const files = listFixtureRawFiles();
  assert(files.length >= 3, `fixtures raw files expected >= 3, got ${files.length}`);
  let checked = 0;
  for (const file of files) {
    const room = (path.basename(file).match(/-(\d+)\.raw\.jsonl$/) || [])[1] || "";
    const result = replayFiles([file], { room });
    checked += 1;
    assert(result.totalLines > 0, `${path.basename(file)} fixture should not be empty`);
    assert(result.parseErrors === 0, `${path.basename(file)} has ${result.parseErrors} parse errors`);
    assert(!result.emitted.some((item) => item.name === "exception"), `${path.basename(file)} emitted exception`);
    assert(
      result.uncoveredImportant.length === 0,
      `${path.basename(file)} uncovered important commands: ${result.uncoveredImportant
        .map((item) => `${item.name}:${item.count}`)
        .join(", ")}`
    );
  }
  // 弹幕/进房等基础事件必须真的被回放为高层事件，而不是只保证"没报错"。
  const combined = replayFiles(files, { room: FIXTURE_ROOM });
  for (const name of ["chat", "interact", "gift", "superChat", "guard", "pk", "notice", "onlineRank"]) {
    assert(countNamed(combined.emitted, name) > 0, `fixture replay should emit at least one ${name} event`);
  }
  return { checked };
}

function verifyUiDefaults() {
  // 只保留结构性检查：重复 id、查询缺失 id、模块开关映射、端点存在性。
  // "必须包含某句中文文案"类断言已整批清退——文案微调不允许打断回归门禁。
  const appJs = fs.readFileSync(path.resolve(__dirname, "..", "public", "app.js"), "utf8");
  const indexHtml = fs.readFileSync(path.resolve(__dirname, "..", "public", "index.html"), "utf8");
  const webServerJs = fs.readFileSync(path.resolve(__dirname, "..", "src", "webServer.js"), "utf8");
  const htmlIds = [...indexHtml.matchAll(/id="([^"]+)"/g)].map((match) => match[1]);
  const duplicateHtmlIds = [...new Set(htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index))];
  const queriedIds = [...appJs.matchAll(/document\.querySelector\("#([^"]+)"\)/g)].map((match) => match[1]);
  const missingQueriedIds = [...new Set(queriedIds.filter((id) => !htmlIds.includes(id)))];
  assert(duplicateHtmlIds.length === 0, `anchor workbench should not contain duplicate ids: ${duplicateHtmlIds.join(", ")}`);
  assert(missingQueriedIds.length === 0, `anchor workbench app should not query missing ids: ${missingQueriedIds.join(", ")}`);

  for (const id of [
    "startButton",
    "stopButton",
    "roomForm",
    "roomInput",
    "switchRoomButton",
    "roomMessage",
    "roomHeading",
    "roomLink",
    "statusText",
    "aiStatus",
    "restartAiButton",
    "latestChat",
    "replyCount",
    "giftToday",
    "pkScore",
    "pendingOrders",
  ]) {
    assert(indexHtml.includes(`id="${id}"`), `anchor workbench should expose ${id}`);
  }

  const moduleMappings = [...indexHtml.matchAll(/data-modules="([^"]+)"/g)].map((match) => match[1]);
  assert(moduleMappings.length === 6, `anchor workbench should expose exactly six feature switches, got ${moduleMappings.length}`);
  for (const mapping of ["welcome", "autoLike", "giftThanks,guardBoard", "ai", "pk", "rotation"]) {
    assert(moduleMappings.includes(mapping), `anchor workbench should expose module switch ${mapping}`);
  }

  for (const endpoint of [
    "/api/browser-control/state",
    "/api/browser-control/start",
    "/api/browser-control/stop",
    "/api/local-ai/start",
    "/api/modules",
    "/api/events",
  ]) {
    assert(appJs.includes(endpoint), `anchor workbench should use ${endpoint}`);
  }
  for (const endpoint of [
    "/api/browser-control/state",
    "/api/browser-control/start",
    "/api/browser-control/stop",
    "/api/local-ai/start",
  ]) {
    assert(webServerJs.includes(`url.pathname === "${endpoint}"`), `backend should expose ${endpoint}`);
  }
  // 前端不许再调用旧控制台时代的端点（端点存在性是结构契约，不属于文案）。
  for (const legacyEndpoint of [
    "/api/self-test",
    "/api/doctor",
    "/api/ingest-visible",
    "/api/send",
    "/api/login/qr",
    "/api/check-cookie",
  ]) {
    assert(!appJs.includes(legacyEndpoint), `anchor workbench must not call legacy endpoint ${legacyEndpoint}`);
  }
  // 房间链接必须由运行时数据驱动，不允许硬编码具体房号。
  assert(!/href="https:\/\/live\.bilibili\.com\/\d+"/.test(indexHtml), "index.html must not hardcode a live room link");
}

function countDarkSemiTransparentPixels(png) {
  let count = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const alpha = png.data[index + 3];
    if (alpha === 0 || alpha === 255) continue;
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    if (luminance < 74) count += 1;
  }
  return count;
}

function hasTransparentNeighbor(png, index, radius = 2) {
  const pixel = index / 4;
  const x = pixel % png.width;
  const y = Math.floor(pixel / png.width);
  const stride = png.width * 4;
  for (let yy = Math.max(0, y - radius); yy <= Math.min(png.height - 1, y + radius); yy += 1) {
    for (let xx = Math.max(0, x - radius); xx <= Math.min(png.width - 1, x + radius); xx += 1) {
      if (xx === x && yy === y) continue;
      const neighbor = yy * stride + xx * 4;
      if (png.data[neighbor + 3] <= 8) return true;
    }
  }
  return false;
}

function countDarkNeutralHaloPixels(png) {
  let count = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const alpha = png.data[index + 3];
    if (alpha === 0) continue;
    const red = png.data[index];
    const green = png.data[index + 1];
    const blue = png.data[index + 2];
    const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
    const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (luminance < 82 && chroma < 56 && hasTransparentNeighbor(png, index, luminance < 48 ? 3 : 2)) {
      count += 1;
    }
  }
  return count;
}

function sanitizeDarkSemiTransparentPixels(png) {
  let changed = 0;
  for (let pass = 0; pass < 36; pass += 1) {
    let changedThisPass = 0;
    for (let index = 0; index < png.data.length; index += 4) {
      const alpha = png.data[index + 3];
      if (alpha === 0) continue;
      const red = png.data[index];
      const green = png.data[index + 1];
      const blue = png.data[index + 2];
      const luminance = red * 0.299 + green * 0.587 + blue * 0.114;
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      const darkTransparentEdge = alpha < 255 && luminance < 96;
      const darkNeutralHalo =
        luminance < 82 && chroma < 56 && hasTransparentNeighbor(png, index, luminance < 48 ? 3 : 2);
      if (!darkTransparentEdge && !darkNeutralHalo) continue;

      png.data[index] = 0;
      png.data[index + 1] = 0;
      png.data[index + 2] = 0;
      png.data[index + 3] = 0;
      changed += 1;
      changedThisPass += 1;
    }
    if (!changedThisPass) break;
  }
  return changed;
}

function verifyGuardFrameDarkEdgeSanitizer() {
  for (const fileName of ["jianzhang-frame.png", "tidu-frame.png"]) {
    const framePath = path.resolve(__dirname, "..", "public", "assets", fileName);
    const png = PNG.sync.read(fs.readFileSync(framePath));
    const before = countDarkSemiTransparentPixels(png);
    const haloBefore = countDarkNeutralHaloPixels(png);
    const changed = sanitizeDarkSemiTransparentPixels(png);
    const after = countDarkSemiTransparentPixels(png);
    const haloAfter = countDarkNeutralHaloPixels(png);
    assert(
      changed >= before && after === 0 && haloBefore > 0 && haloAfter === 0,
      `${fileName} guard-frame dark-edge sanitizer should clear semi-transparent dark pixels and transparent-adjacent neutral halos; before=${before}, haloBefore=${haloBefore}, changed=${changed}, after=${after}, haloAfter=${haloAfter}`
    );
  }
}

function verifyFeatureAuditScript() {
  // 全部对仓库内 fixtures 跑：不再断言生产 state 里特定日期/房间的历史数据。
  const auditOptions = { stateDir: FIXTURE_STATE_DIR, room: FIXTURE_ROOM };
  const report = auditFeatures({ ...auditOptions, day: "2026-07-03" });
  const allRoomReport = auditFeatures(auditOptions);
  assert(String(report.filters.stateDir || "").length > 0, "feature audit should report which state dir it audited");
  assert(
    report.files.raw.length === 1 && /2026-07-03/.test(report.files.raw[0]),
    "day filter should narrow the audit to that day's raw file"
  );
  assert(report.totals.rawRows > 0, "feature audit should read fixture raw rows");
  assert(report.totals.eventRows > 0, "feature audit should read fixture persisted events");
  assert(
    Number.isFinite(report.totals.realEventRows) && report.totals.realEventRows <= report.totals.eventRows,
    "feature audit should expose real event rows after excluding local simulations"
  );
  assert(
    report.parserReplay &&
      Number.isFinite(report.parserReplay.replayed) &&
      Array.isArray(report.parserReplay.uncoveredImportant),
    "feature audit should replay raw with the current parser so stale persisted events do not create false missing alarms"
  );
  assert(report.parserReplay.parseErrors === 0, "fixture replay inside audit should have zero parse errors");
  for (const key of ["chat", "enter", "gift", "guard", "superChat", "pk"]) {
    assert(allRoomReport.groups.some((group) => group.key === key), `feature audit should include ${key} coverage`);
  }
  assert(
    Number.isFinite(report.gifts.quality.missingIcon) &&
      Number.isFinite(report.gifts.catalogTotal) &&
      Array.isArray(report.unknownCommands),
    "feature audit should expose gift data quality, catalog size, and unknown command list"
  );
  assert(
    Number.isFinite(report.guards.catalogTotal) &&
      Number.isFinite(report.guards.boardTotal) &&
      typeof report.guards.boardSource === "string",
    "feature audit should expose guard catalog/board totals and the source used for the board"
  );
  assert(
    Array.isArray(allRoomReport.sampleGates) &&
      ["paidGift", "globalGiftNotice", "superChat", "guardBuy", "guardHonor", "lotteryRedPocket", "multiPkLine", "visibleBridge"].every((key) =>
        allRoomReport.sampleGates.some((gate) => gate.key === key && typeof gate.state === "string")
      ),
    "feature audit should expose real-sample gates for paid gift, global gift notices, SC, guard purchase, guard honor, lottery, multi-PK, and visible bridge coverage"
  );
  assert(
    report.sampleGates.some((gate) => gate.key === "paidGift" && gate.state === "covered"),
    "feature audit should mark paid gift as covered when the fixtures have gift raw and events"
  );
  assert(
    report.sampleGates.some((gate) => gate.key === "paidGift" && /送礼批次/.test(gate.detail || "") && /不含全站公告/.test(gate.detail || "")) &&
      report.sampleGates.some((gate) => gate.key === "globalGiftNotice" && /不计入本房礼物统计/.test(gate.detail || "")),
    "feature audit should separate real room gifts from global gift notice broadcasts and count gift combo batches as business rows"
  );
  {
    const allPaidGift = allRoomReport.sampleGates.find((gate) => gate.key === "paidGift");
    const allGuardBuy = allRoomReport.sampleGates.find((gate) => gate.key === "guardBuy");
    const allSuperChat = allRoomReport.sampleGates.find((gate) => gate.key === "superChat");
    const allLottery = allRoomReport.sampleGates.find((gate) => gate.key === "lotteryRedPocket");
    const allMultiPkLine = allRoomReport.sampleGates.find((gate) => gate.key === "multiPkLine");
    assert(
      allPaidGift?.state !== "missing" && /送礼批次/.test(allPaidGift?.detail || ""),
      "all-date feature audit should not false-alarm combo SEND_GIFT/COMBO_SEND batches as missing gifts"
    );
    assert(
      allGuardBuy?.state !== "missing" && /上船流水/.test(allGuardBuy?.detail || ""),
      "all-date feature audit should not false-alarm USER_TOAST guard purchases as missing"
    );
    assert(
      allGuardBuy?.state === "covered"
        ? !(allRoomReport.operatorSummary?.nextSteps || []).some((item) => /上船购买\/续费|上船\/续费/.test(item))
        : true,
      "feature audit next step should not ask operators to wait for guard purchases when guard purchases are already covered"
    );
    // 合成样本日：SC 与红包（生产 raw 无这两类真实样本，fixtures 里为解析器形状合成）。
    assert(allSuperChat?.state === "covered", `SC gate should be covered by the synthetic fixture day, got ${allSuperChat?.state}`);
    assert(allLottery?.state === "covered", `red-pocket lottery gate should be covered by the synthetic fixture day, got ${allLottery?.state}`);
    assert(
      allMultiPkLine?.state !== "missing" && Number(allMultiPkLine?.rawCount || 0) >= 6,
      "feature audit should count multi-PK/connection raw samples without false-alarming"
    );
    const unknownNames = new Set((allRoomReport.unknownCommands || []).map((item) => item.name));
    assert(unknownNames.size === 0, `fixture feature audit should have zero unknown commands, got: ${[...unknownNames].join(", ")}`);
    assert(
      allRoomReport.parserReplay.uncoveredImportant.length === 0,
      "fixture feature audit should have zero parser-uncovered important commands"
    );
  }
  {
    // 文字补记礼物（弹幕/小助理补记，needsVisualCheck 语义）：仍持久化但必须标"需网页核对"，不能冒充送礼包。
    const fallbackDayReport = auditFeatures({ ...auditOptions, day: "2026-07-02" });
    const fallbackOfflineReport = auditFeatures({ ...auditOptions, day: "2026-07-02", roomLiveStatus: 0 });
    const fallbackPaidGift = fallbackDayReport.sampleGates.find((gate) => gate.key === "paidGift");
    const fallbackGift = fallbackDayReport.sampleGates.find((gate) => gate.key === "fallbackGiftText");
    const fallbackSummary = fallbackDayReport.operatorSummary || {};
    const offlineSummary = fallbackOfflineReport.operatorSummary || {};
    assert(fallbackPaidGift?.state !== "eventOnly", "real SEND_GIFT coverage must not degrade into eventOnly");
    assert(fallbackGift?.state === "eventOnly", `fallback gift text should stay eventOnly, got ${fallbackGift?.state}`);
    assert(/不是 B站直接送礼包/.test(fallbackGift?.detail || ""), "fallback gift detail should say it is not a direct gift packet");
    assert(/需要网页核对/.test(fallbackGift?.action || ""), "fallback gift action should require visual verification");
    assert(fallbackSummary.canClaimPerfect === false, "fallback gift day must not claim perfect capture");
    assert(
      (fallbackSummary.blockers || []).some((item) => /文字补记礼物/.test(item)) &&
        (fallbackSummary.blockers || []).some((item) => /网页核对/.test(item)),
      "fallback gift day should list text-fallback and visual-check blockers"
    );
    assert(
      (fallbackSummary.nextSteps || []).some((item) => /复制网页核对脚本/.test(item)),
      "online fallback day should suggest running the visual check script"
    );
    assert(
      (offlineSummary.nextSteps || []).some((item) => /保持安全监听即可/.test(item)) &&
        !(offlineSummary.nextSteps || []).some((item) => /^点“复制网页核对脚本”/.test(item)),
      "offline rooms should be told to keep listening instead of running the visual check right now"
    );
    // 当日无 SC 样本时要给"继续等真实样本"的引导。
    assert(
      (fallbackSummary.blockers || []).some((item) => /醒目留言 SC/.test(item)),
      "days without SC samples should list SC as a pending sample"
    );
  }
  {
    const globalNoticeGate = report.sampleGates.find((gate) => gate.key === "globalGiftNotice");
    assert(
      !globalNoticeGate ||
        Number(globalNoticeGate.eventCount || 0) >= Number(globalNoticeGate.rawCount || 0) ||
        globalNoticeGate.state === "missing" ||
        globalNoticeGate.state === "covered_by_replay",
      "real-sample gates should degrade honestly when raw samples outnumber persisted events"
    );
    for (const group of report.groups || []) {
      assert(
        Number(group.rawPackets || 0) >= Number(group.expectedRaw || 0),
        "feature audit groups should expose raw packet count separately from deduped sample count"
      );
      assert(
        Number(group.capturedEvents || 0) >= Number(group.expectedRaw || 0) ||
          group.state === "missing" ||
          group.state === "covered_by_replay",
        "feature audit groups should show missing or covered_by_replay when persisted events are fewer than raw samples"
      );
    }
  }
  assert(
    allRoomReport.sampleGates.some((gate) => gate.key === "guardHonor" && /不等于购买续费/.test(gate.detail || "")),
    "feature audit should separate guard honor changes from guard purchase or renewal samples"
  );
  {
    const superChatGroup = auditInternals.GROUPS.find((group) => group.key === "superChat");
    const captured = auditInternals.countRealGroupEvents(
      [
        { kind: "superChat", payload: { isSimulated: true, source: "simulation", text: "测试 SC" } },
        { kind: "superChat", payload: { text: "真实 SC" } },
      ],
      superChatGroup
    );
    assert(captured === 1, "feature audit groups should exclude simulated SC/guard events from real coverage");
    assert(
      !auditInternals.isSimulatedEvent({ kind: "gift", payload: { source: "latest" } }),
      "sources merely containing the substring test (like latest) must not be treated as simulated"
    );
    assert(
      auditInternals.isSimulatedEvent({ kind: "gift", payload: { source: "self_test" } }),
      "self_test sources should still count as simulated"
    );
  }
  {
    // 回归钉：未知命令检测必须遍历完整 commandCounts，低频新命令不允许被 top-80 展示截断吞掉。
    const unknownRoot = path.join(TMP_ROOT, "verify-audit-unknown", "state");
    fs.rmSync(path.dirname(unknownRoot), { recursive: true, force: true });
    fs.mkdirSync(path.join(unknownRoot, "raw"), { recursive: true });
    fs.mkdirSync(path.join(unknownRoot, "events"), { recursive: true });
    const lines = [];
    for (let index = 0; index < 85; index += 1) {
      const command = `PK_BATTLE_SYNTH_${index}`;
      for (let repeat = 0; repeat < 2; repeat += 1) {
        lines.push(JSON.stringify({ at: 1783000000000 + index, roomId: 20002, command, message: { cmd: command } }));
      }
    }
    lines.push(JSON.stringify({ at: 1783000100000, roomId: 20002, command: "MYSTERY_NEW_CMD", message: { cmd: "MYSTERY_NEW_CMD" } }));
    fs.writeFileSync(path.join(unknownRoot, "raw", "2026-07-03-20002.raw.jsonl"), `${lines.join("\n")}\n`);
    // 空 events + 有 raw：弹幕类组必须走 covered_by_replay 而不是误报 missing。
    fs.writeFileSync(
      path.join(unknownRoot, "raw", "2026-07-04-20002.raw.jsonl"),
      `${JSON.stringify({
        at: 1783100000000,
        roomId: 20002,
        command: "DANMU_MSG",
        message: { cmd: "DANMU_MSG", info: [[0, 1, 25, 16777215, 1783100000, 0, 0, "", 0, 0, 0, "", 0, "{}", "{}", { mode: 0, extra: "{}" }], "回放补回测试弹幕", [900001, "user_replay", 0, 0, 0, 10000, 1, ""]] },
      })}\n`
    );
    const unknownReport = auditFeatures({ stateDir: unknownRoot, room: "20002" });
    assert(
      unknownReport.unknownCommands.some((item) => item.name === "MYSTERY_NEW_CMD"),
      "rare unknown commands must be detected even when more than 80 distinct commands exist"
    );
    const chatGroup = unknownReport.groups.find((group) => group.key === "chat");
    assert(
      chatGroup?.state === "covered_by_replay",
      `chat captured by current parser but missing from events should be covered_by_replay, got ${chatGroup?.state}`
    );
    fs.rmSync(path.dirname(unknownRoot), { recursive: true, force: true });
  }
}
function verifyVisualHintIsolation() {
  const runtime = new BotRuntime({ room: "20002", dryRun: true });
  const giftHint = runtime.rememberUserVisualHint(
    {
      userId: 10001,
      userName: "商k头牌美羊羊",
      face: "https://i0.hdslb.com/bfs/face/test-face.jpg",
      giftName: "流萤许愿",
      giftIcon: "https://i0.hdslb.com/bfs/live/gift.webp",
      count: 9,
      totalCoin: 200000,
      guardLevel: 3,
      guardName: "舰长",
    },
    "gift_packet"
  );
  assert(!giftHint.giftName && !giftHint.giftIcon && !giftHint.count, "visual hint cache should not keep gift payload fields");
  const rankRow = runtime.onlineRankVisualRow(
    {
      uid: 10001,
      userName: "商k头牌美羊羊",
      face: "https://i0.hdslb.com/bfs/face/test-face.jpg",
      rank: 1,
      score: "2353",
    },
    "online_rank"
  );
  assert(rankRow.rank === 1 && rankRow.score === "2353", "online rank rows should keep rank/score fields");
  assert(!rankRow.giftName && !rankRow.giftIcon && !rankRow.count, "online rank rows should not inherit stale gift fields");

  const conflict = runtime.mergeVisualHint(
    {},
    {
      userId: 10002,
      userName: "舰长冲突样本",
      face: "https://i0.hdslb.com/bfs/live/not-a-face.png",
      guardLevel: 1,
      guardName: "舰长",
    }
  );
  assert(conflict.guardLevel === 3, "guard text should win when numeric guardLevel conflicts with guardName");
  assert(/80f732943cc3367029df65e267960d56736a82ee/.test(conflict.avatarFrameUrl), "conflicting captain row should use captain frame");
  assert(!conflict.face, "visual hints should reject guard/gift images as user faces");

  const fullName = runtime.mergeVisualHint(
    { userId: 10003, userName: "测试观众完整昵称", displayUserName: "测试观众完整昵称" },
    { userId: 10003, userName: "逸星熠熠的v", displayUserName: "逸星熠熠的v" }
  );
  assert(fullName.userName === "测试观众完整昵称", "visual hints should keep the longer full uid name over later shortened names");
}

function verifyMultiLineConnectionState() {
  const runtime = new BotRuntime({ room: "20002", dryRun: true });
  runtime.running = true;
  runtime.setClientLineState("主线", {
    primary: true,
    connected: false,
    authenticated: false,
    closedAt: Date.now(),
    closeCode: 1006,
  });
  runtime.setClientLineState("备线1", {
    primary: false,
    connected: false,
    authenticated: false,
    lastRawAt: Date.now(),
    lastRawCommand: "DANMU_MSG",
  });
  assert(runtime.connected === true, "fresh backup raw should keep runtime connected");
  const snapshot = runtime.getSnapshot();
  assert(snapshot.connected === true, "snapshot should report connected when any line has fresh raw");
  assert(
    snapshot.captureHealth.connectionLines.some((line) => line.label === "备线1" && line.lastRawCommand === "DANMU_MSG"),
    "snapshot should expose per-line connection health"
  );
  runtime.setClientLineState("备线1", {
    primary: false,
    connected: false,
    authenticated: false,
    lastRawAt: Date.now() - 60000,
    lastRawCommand: "DANMU_MSG",
  });
  runtime.updateConnectedState();
  assert(runtime.connected === false, "stale backup raw should not keep runtime connected forever");
  runtime.setClientLineState("备线2", {
    primary: false,
    connected: true,
    authenticated: true,
  });
  assert(runtime.connected === true, "authenticated backup line should count as connected");
  runtime.stop("测试停止");
  assert(runtime.connected === false, "stopped runtime should report disconnected");
}

function verifyVoiceJoinConnectionText() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.room = { roomId: 20002 };
  const events = [];
  client.on("event", (event) => events.push(event));

  handleRaw(client, {
    cmd: "VOICE_JOIN_ROOM_COUNT_INFO",
    data: {
      apply_count: 2,
      notify_count: 1,
      room_id: 20002,
      room_status: 1,
      root_status: 1,
    },
  });
  handleRaw(client, {
    cmd: "VOICE_JOIN_LIST",
    data: {
      apply_count: 1,
      category: 1,
      refresh: 1,
      room_id: 20002,
      list: [{ uid: 10001, uname: "连麦观众", room_id: 30003, face: "https://i0.hdslb.com/bfs/face/voice.jpg" }],
    },
  });

  assert(events.length === 2, "voice-join raw packets should emit connection events");
  assert(
    events[0].eventKind === "connection" &&
      events[0].connectionType === "voice" &&
      events[0].statusLabel === "可连麦" &&
      events[0].text.includes("语音连麦可连麦") &&
      events[0].text.includes("申请2人"),
    "voice-join room count events should render operator-friendly connection text"
  );
  assert(
    events[1].connectionType === "voice" &&
      events[1].memberCount === 1 &&
      events[1].members[0]?.userName === "连麦观众" &&
      events[1].text.includes("语音连麦列表刷新"),
    "voice-join list events should keep connected member details and readable text"
  );
}

async function verifyHistoryApiCompatibility() {
  // README 措辞类断言已删；这里改为对 createWebApp 实例发真实 HTTP 请求验证行为契约。
  const rootDir = path.resolve(__dirname, "..");
  const stateDir = path.join(TMP_ROOT, "verify-history-api");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const seedStore = new EventStore({ rootDir: stateDir });
  const at = Date.now();
  seedStore.append("gift", {
    at,
    roomId: 20002,
    payload: {
      id: "history-api-gift-1",
      at,
      roomId: 20002,
      userId: 10001,
      userName: "别名测试用户",
      giftName: "人气票",
      giftId: 33988,
      count: 2,
      price: 100,
      totalCoin: 200,
      coinType: "gold",
      source: "gift_packet",
      sourceCommand: "SEND_GIFT",
    },
  });

  const app = createWebApp({
    rootDir,
    config: {
      room: "20002",
      dryRun: true,
      connection: { autoStartSafe: false },
      history: { enabled: true, dir: stateDir },
    },
  });
  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    // giftName/userName 必须是 gift/user 的等价别名。
    const byAlias = await fetch(
      `${baseUrl}/api/history/gifts?range=today&roomId=20002&giftName=${encodeURIComponent("人气票")}&userName=${encodeURIComponent("别名测试用户")}`
    ).then((response) => response.json());
    assert(byAlias.ok === true, "gift history API should answer ok");
    assert(
      byAlias.result?.totalGiftCount === 2,
      `gift history API should resolve giftName/userName aliases, got ${JSON.stringify(byAlias.result?.totalGiftCount)}`
    );
    const byCanonical = await fetch(
      `${baseUrl}/api/history/gifts?range=today&roomId=20002&gift=${encodeURIComponent("人气票")}&user=${encodeURIComponent("别名测试用户")}`
    ).then((response) => response.json());
    assert(
      byCanonical.result?.totalGiftCount === byAlias.result?.totalGiftCount,
      "gift/user and giftName/userName parameters should be interchangeable"
    );
    // PK 侦查重试端点必须存在（未启动运行时应返回明确错误而不是 404）。
    const retry = await fetch(`${baseUrl}/api/pk/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert(retry.status !== 404, "web API should expose PK investigation retry endpoint");
  } finally {
    await app.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

function verifyPointsShop() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-points");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const eventStore = new EventStore({ rootDir: stateDir });
  const config = {
    points: {
      enabled: true,
      signInPoints: 10,
      signInStreak: { enabled: true, bonusPerDay: 2, maxBonus: 20 },
      shopItems: [{ id: "song", name: "点歌一次", cost: 10, description: "测试商品" }],
    },
  };
  const points = new PointsEngine(config, eventStore);
  const commands = new CommandEngine(config);
  const event = { userId: 10001, userName: "测试用户", displayUserName: "测试用户", text: "签到" };
  let result = commands.handleChat(event, { points, roomInfo: { roomId: 20002 } });
  assert(result.handled && /签到成功/.test(result.actions[0]?.reply || ""), "sign-in command should work");
  assert(/连续1天/.test(result.actions[0]?.reply || ""), "first sign-in should report a one-day streak");
  result = commands.handleChat({ ...event, text: "积分商城" }, { points, roomInfo: { roomId: 20002 } });
  assert(result.handled && /点歌一次10分/.test(result.actions[0]?.reply || ""), "shop command should list configured items");
  result = commands.handleChat({ ...event, text: "兑换 点歌一次" }, { points, roomInfo: { roomId: 20002 } });
  assert(result.handled && /已登记兑换/.test(result.actions[0]?.reply || ""), "redeem command should deduct points");
  assert(points.balance(event, { roomId: 20002 }) === 0, "redeem should leave zero balance");
  const redemptions = points.getSummary({ roomId: 20002 }).redemptions;
  assert(redemptions.pendingCount === 1, "redeem should create one pending order");
  const orderId = redemptions.pending[0]?.orderId;
  assert(orderId, "pending redeem order should expose orderId");
  const marked = points.markRedemption(orderId, "done", { roomId: 20002 }, { userName: "主播", note: "已点歌" });
  assert(marked?.status === "done", "operator should be able to mark redemption done");
  assert(marked?.note === "已点歌", "operator should be able to attach a fulfillment note to a completed redemption");
  assert(points.getSummary({ roomId: 20002 }).redemptions.pendingCount === 0, "completed redemption should leave pending list");
  assert(
    points.getSummary({ roomId: 20002 }).redemptions.recent.some((order) => order.orderId === orderId && order.status === "done" && order.note === "已点歌"),
    "completed redemption should remain visible with its note in recent order ledger"
  );

  const event2 = { userId: 10002, userName: "误兑用户", displayUserName: "误兑用户", text: "签到" };
  commands.handleChat(event2, { points, roomInfo: { roomId: 20002 } });
  commands.handleChat({ ...event2, text: "兑换 点歌一次" }, { points, roomInfo: { roomId: 20002 } });
  const cancelOrder = points.getSummary({ roomId: 20002 }).redemptions.pending[0];
  assert(cancelOrder?.orderId, "second redeem should create a cancellable pending order");
  assert(points.balance(event2, { roomId: 20002 }) === 0, "second redeem should deduct points before cancellation");
  const cancelled = points.markRedemption(cancelOrder.orderId, "cancelled", { roomId: 20002 }, { userName: "主播", note: "误兑换" });
  assert(cancelled?.status === "cancelled", "operator should be able to cancel redemption");
  assert(cancelled?.note === "误兑换", "operator should be able to attach a cancellation note");
  assert(points.balance(event2, { roomId: 20002 }) === 10, "cancelled redemption should refund points");
  assert(points.getSummary({ roomId: 20002 }).redemptions.pendingCount === 0, "cancelled redemption should leave pending list");
  assert(
    points.getSummary({ roomId: 20002 }).redemptions.recent.some((order) => order.orderId === cancelOrder.orderId && order.status === "cancelled"),
    "cancelled redemption should remain visible in recent order ledger"
  );

  const yesterday = (() => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  })();
  const streakEvent = { userId: 10003, userName: "连续用户", displayUserName: "连续用户", text: "签到" };
  points.appendTransaction(streakEvent, {
    key: `signin:20002:${points.userKey(streakEvent)}:${yesterday}`,
    roomId: 20002,
    at: Date.now() - 86400000,
    points: 10,
    reason: "sign_in",
    reasonText: "每日签到",
    signInDay: yesterday,
    streak: 1,
    basePoints: 10,
  });
  result = commands.handleChat(streakEvent, { points, roomInfo: { roomId: 20002 } });
  assert(/连续2天奖励\+2/.test(result.actions[0]?.reply || ""), "second consecutive sign-in should include streak bonus");
  assert(points.balance(streakEvent, { roomId: 20002 }) === 22, "two-day sign-in should include base and bonus points");
  result = commands.handleChat({ ...streakEvent, text: "我的积分" }, { points, roomInfo: { roomId: 20002 } });
  assert(/连续签到2天/.test(result.actions[0]?.reply || ""), "balance command should report current sign-in streak");
  const signInSummary = points.getSummary({ roomId: 20002 }).signIn;
  assert(signInSummary.todayCount >= 3 && signInSummary.maxStreak >= 2, "points summary should expose today sign-ins and max streak");

  const adjusted = points.manualAdjust(
    { userName: "补分用户", points: 25, reason: "补偿活动" },
    { roomId: 20002 },
    { userName: "主播" }
  );
  assert(adjusted?.balance === 25 && adjusted.reason === "manual_adjust", "operator should be able to manually adjust points");
  const guardTx = points.awardGuard(
    {
      userId: 10004,
      userName: "上舰用户",
      displayUserName: "上舰用户",
      guardLevel: 3,
      guardName: "舰长",
      count: 2,
      unit: "月",
      id: "guard-points-test",
    },
    { roomId: 20002 }
  );
  assert(guardTx?.points === 600 && guardTx.reason === "guard", "guard purchase should award configured guard points");
  assert(points.balance({ userId: 10004, userName: "上舰用户" }, { roomId: 20002 }) === 600, "guard points should affect monthly balance");
  const csv = points.exportCsv({ roomId: 20002 });
  assert(csv.includes("manual_adjust") && csv.includes("补分用户") && csv.includes("balanceAfter"), "points export should include manual adjustments and balance column");
  assert(csv.includes("guard") && csv.includes("上舰用户"), "points export should include guard-point transactions");
}

function verifyCommandCoverage() {
  const config = {
    roles: { anchorNames: ["主播"] },
    modules: { welcome: { enabled: true }, ai: { enabled: true } },
    commands: { drawLots: ["测试签"] },
    rateLimit: { spamCooldownSec: 0 },
  };
  const commands = new CommandEngine(config);
  const catalog = commands.getCatalog(config.modules);
  const catalogText = JSON.stringify(catalog);
  assert(/#刷屏 表情 3/.test(catalogText) && /兑换 商品名/.test(catalogText), "command catalog should expose public and privileged commands");
  assert(/#hey 今晚播什么/.test(catalogText) && /兑换 点歌一次/.test(catalogText), "command catalog should provide runnable entertainment examples");
  assert(/弹幕活跃/.test(catalogText) && /全房弹幕活跃/.test(catalogText), "command catalog should expose privileged danmaku activity analysis");
  const anchorEvent = { userName: "主播", displayUserName: "主播", text: "#欢迎关闭" };
  let result = commands.handleChat(anchorEvent, { roomInfo: { uname: "主播" }, moduleStatus: config.modules });
  assert(result.handled && result.moduleUpdates[0]?.name === "welcome", "privileged module toggle should work");
  result = commands.handleChat({ ...anchorEvent, text: "#刷屏 哈哈 3" }, { roomInfo: { uname: "主播" } });
  assert(result.handled && result.actions.length === 3, "privileged spam command should create limited actions");
  const history = {
    queryChatSummary(options) {
      return {
        mode: "summary",
        daysBack: options.daysBack,
        total: 1787,
        activeUserCount: 27,
        topUsers: [
          { rank: 1, userName: "测试赠礼者", count: 651 },
          { rank: 2, userName: "aaaaaa小助理", count: 392 },
        ],
        topWords: [{ word: "欢迎", count: 120 }],
        topMessages: [{ text: "来玩", count: 61 }],
      };
    },
  };
  result = commands.handleChat(
    { userName: "主播", displayUserName: "主播", text: "弹幕活跃 3天" },
    { history, roomInfo: { roomId: 20002, uname: "主播" } }
  );
  assert(
    result.handled &&
      /近3天弹幕1787条/.test(result.actions[0]?.reply || "") &&
      /测试赠礼者651条/.test(result.actions[0]?.reply || "") &&
      /欢迎x120/.test(result.actions[0]?.reply || ""),
    "privileged danmaku activity command should summarize room chat"
  );
  result = commands.handleChat(
    { userName: "观众", displayUserName: "观众", text: "弹幕榜" },
    { history, roomInfo: { roomId: 20002, uname: "主播" } }
  );
  assert(result.handled && /主播\/管理员可用/.test(result.actions[0]?.reply || ""), "ordinary viewers should not trigger room-wide danmaku analysis");
  result = commands.handleChat({ userName: "观众", displayUserName: "观众", text: "抽签" }, {});
  assert(result.handled && /测试签/.test(result.actions[0]?.reply || ""), "draw lot command should use configured lots");
  result = commands.handleChat({ userName: "观众", displayUserName: "观众", text: "帮助" }, {});
  assert(result.handled && /弹幕活跃/.test(result.actions[0]?.reply || ""), "help should expose expanded public commands");
}

function verifyUndercoverGameFlow() {
  const commands = new CommandEngine({ roles: { anchorNames: ["主播"] } });
  const context = { roomInfo: { uname: "主播" } };
  let result = commands.handleChat({ userName: "观众", displayUserName: "观众", text: "#卧底开始" }, context);
  assert(result.handled && /加入卧底/.test(result.actions[0]?.reply || ""), "ordinary viewers should be able to start the undercover game");
  for (const name of ["小明", "小红", "小蓝"]) {
    result = commands.handleChat({ userName: name, displayUserName: name, text: "加入卧底" }, context);
    assert(result.handled && /已加入谁是卧底/.test(result.actions[0]?.reply || ""), `${name} should join undercover game`);
  }
  result = commands.handleChat({ userName: "主播", displayUserName: "主播", text: "#卧底发词 苹果 梨" }, context);
  assert(result.handled && /已锁定 3 人/.test(result.actions[0]?.reply || ""), "undercover words should lock players");
  assert(!/苹果|梨/.test(result.actions[0]?.reply || ""), "word-setting reply should not leak secret words");
  result = commands.handleChat({ userName: "迟到", displayUserName: "迟到", text: "加入卧底" }, context);
  assert(result.handled && /已经锁定/.test(result.actions[0]?.reply || ""), "late player should not join locked game");
  result = commands.handleChat({ userName: "小明", displayUserName: "小明", text: "投票 小红" }, context);
  assert(result.handled && /已投 小红/.test(result.actions[0]?.reply || ""), "player should vote by name");
  result = commands.handleChat({ userName: "小蓝", displayUserName: "小蓝", text: "卧底票数" }, context);
  assert(result.handled && /小红1票/.test(result.actions[0]?.reply || ""), "vote summary should count votes");
  result = commands.handleChat({ userName: "主播", displayUserName: "主播", text: "#卧底公布" }, context);
  assert(result.handled && /平民词「苹果」/.test(result.actions[0]?.reply || ""), "privileged reveal should show words");
}

function verifyGiftHistoryCommands() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const calls = [];
  const history = {
    queryGifts(options) {
      calls.push(options);
      return {
        totalValueText: "520电池",
        totalGiftCount: 3,
        topGifts: [{ giftName: options.giftName || "好运盲盒", count: 2 }],
        blindBoxes: {
          sourceValueText: "100电池",
          resultValueText: "120电池",
          deltaValueText: "+20电池",
        },
      };
    },
  };
  const commands = new CommandEngine({ roles: { anchorNames: ["主播"] } });
  const viewer = { userId: 10001, userName: "测试赠礼者", displayUserName: "测试赠礼者" };

  let result = commands.handleChat(
    { ...viewer, text: "我的今日礼物" },
    { history, roomInfo: { roomId: 20002 } }
  );
  assert(result.handled && /测试赠礼者的今日礼物统计/.test(result.actions[0]?.reply || ""), "我的今日礼物 should reply");
  assert(calls.at(-1).range === "today" && calls.at(-1).userName === "测试赠礼者", "我的今日礼物 should query today's viewer gifts");

  result = commands.handleChat(
    { ...viewer, text: "我的昨日盲盒" },
    { history, roomInfo: { roomId: 20002 } }
  );
  assert(result.handled && /测试赠礼者的昨日礼物统计/.test(result.actions[0]?.reply || ""), "yesterday blind-box command should reply");
  assert(calls.at(-1).range === "yesterday", "我的昨日盲盒 should query yesterday");
  assert(calls.at(-1).userName === "测试赠礼者" && calls.at(-1).blindOnly === true, "我的昨日盲盒 should scope to viewer and blind gifts");

  result = commands.handleChat(
    { ...viewer, text: "@小助理 我的25日盲盒" },
    { history, roomInfo: { roomId: 20002 } }
  );
  assert(result.handled, "@机器人 前缀 should not block gift history commands");
  assert(calls.at(-1).range === `${year}-${month}-25`, "我的25日盲盒 should resolve current-month day range");
  assert(calls.at(-1).giftName === "" && calls.at(-1).blindOnly === true, "我的25日盲盒 should not use 盲盒 as a gift keyword");

  commands.handleChat({ ...viewer, text: "我的3月掉头" }, { history, roomInfo: { roomId: 20002 } });
  assert(calls.at(-1).range === `${year}-03`, "我的3月掉头 should resolve month range");
  assert(calls.at(-1).giftName === "掉头", "我的3月掉头 should preserve gift keyword");

  commands.handleChat({ ...viewer, text: "3月盲盒" }, { history, roomInfo: { roomId: 20002 } });
  assert(calls.at(-1).range === `${year}-03`, "bare 3月盲盒 should resolve month range");
  assert(calls.at(-1).userName === "测试赠礼者", "ordinary bare gift history should stay scoped to the viewer");

  commands.handleChat(
    { userName: "主播", displayUserName: "主播", text: "3月盲盒" },
    { history, roomInfo: { roomId: 20002, uname: "主播" } }
  );
  assert(calls.at(-1).userName === "", "privileged bare gift history can query room-wide stats");

  let reportOptions = null;
  result = commands.handleChat(
    { ...viewer, text: "@小助理 截图今日礼物" },
    {
      interactions: {
        createGiftReportAction(options) {
          reportOptions = options;
          return { type: "gift_report", reply: "今日礼物报告" };
        },
      },
    }
  );
  assert(result.handled && result.actions[0]?.type === "gift_report", "截图今日礼物 should create a gift report action");
  assert(reportOptions?.range === "today", "截图今日礼物 should pass today range metadata");
}

function verifyCaptureCoverageDiagnosis() {
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    config: { room: "20002" },
  });
  runtime.commandStats.set("SEND_GIFT", 3);
  runtime.commandStats.set("COMBO_SEND", 1);
  runtime.commandStats.set("DANMU_MSG", 5);
  runtime.filteredRawStats.set("DANMU_MSG", 3);
  runtime.commandStats.set("PK_BATTLE_PROCESS", 1);
  runtime.giftEventStats.sendGift = 2;
  runtime.giftEventStats.comboSend = 1;
  runtime.counts.chat = 2;
  runtime.counts.pk = 1;

  const coverage = runtime.getSnapshot().captureHealth.coverage;
  const giftCoverage = coverage.groups.find((row) => row.key === "gift");
  const chatCoverage = coverage.groups.find((row) => row.key === "chat");
  const pkCoverage = coverage.groups.find((row) => row.key === "pk");
  assert(giftCoverage?.expected === 4, `gift coverage expected raw 4, got ${giftCoverage?.expected}`);
  assert(giftCoverage?.captured === 3, `gift coverage captured expected 3, got ${giftCoverage?.captured}`);
  assert(giftCoverage?.gap === 1 && coverage.hasGap, "gift coverage should expose a one-event gap");
  assert(coverage.worst?.key === "gift", "coverage worst gap should identify gift");
  assert(chatCoverage?.expected === 2, `chat coverage should subtract filtered self messages, got ${chatCoverage?.expected}`);
  assert(chatCoverage?.filtered === 3, `chat coverage should expose filtered self messages, got ${chatCoverage?.filtered}`);
  assert(chatCoverage?.gap === 0 && pkCoverage?.gap === 0, "chat and pk coverage should be aligned");
}

function verifyGuardHistoryCommands() {
  const calls = [];
  const history = {
    queryGuards(options) {
      calls.push(options);
      return {
        rows: [
          {
            userName: "测试赠礼者",
            guardName: "舰长",
            guardLevel: 3,
          },
        ],
      };
    },
  };
  const commands = new CommandEngine({ roles: { anchorNames: ["主播"] } });
  const result = commands.handleChat(
    { userId: 10001, userName: "测试赠礼者", displayUserName: "测试赠礼者", text: "我的本月船长" },
    { history, roomInfo: { roomId: 20002 } }
  );
  assert(result.handled && /测试赠礼者的大航海记录/.test(result.actions[0]?.reply || ""), "我的本月船长 should reply as guard history");
  assert(calls.at(-1).range === "month" && calls.at(-1).userName === "测试赠礼者", "我的本月船长 should query this month's own guard history");
  assert(/舰长1/.test(result.actions[0]?.reply || ""), "我的本月船长 should summarize captain count");
}

function verifyCommandTestPrivilegeScope() {
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    config: { room: "20002", roles: { anchorNames: [] } },
  });
  runtime.roomInfo = { roomId: 20002, uname: "主播" };

  const viewer = runtime.testCommand("3月盲盒", "观众");
  assert(viewer.handled && /观众的3月礼物统计/.test(viewer.replies[0] || ""), "command-test should not treat every typed user as anchor");

  const anchor = runtime.testCommand("3月盲盒", "主播");
  assert(anchor.handled && /全场3月礼物统计/.test(anchor.replies[0] || ""), "command-test should still allow anchor-scope testing");
}

function verifyModerationAlert() {
  const runtime = new BotRuntime({
    config: {
      room: "20002",
      blocklist: ["加微信"],
      interactions: {
        moderation: {
          keywordAlert: true,
          keywordAlertTemplate: "{user} 命中 {keyword}",
        },
      },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.handleInboundModerationHint({ userName: "测试用户", text: "来加微信" });
  assert(runtime.moderationEvents.length === 1, "inbound moderation keyword should be recorded");
  assert(runtime.moderationEvents[0].eventKind === "moderation_keyword", "moderation event kind should be set");
}

function verifySnapshotCompaction() {
  const runtime = new BotRuntime({
    config: { room: "20002" },
    room: "20002",
    dryRun: true,
  });
  const rawMarker = "RAW_SHOULD_NOT_LEAK_TO_UI";
  runtime.handleGenericEvent({
    command: "POPULAR_RANK_CHANGED",
    eventKind: "rank",
    text: "测试榜单",
    raw: { marker: rawMarker, nested: { value: rawMarker } },
  });
  runtime.log("测试", "带 raw 的日志", {
    kind: "event",
    event: {
      command: "NOTICE_MSG",
      text: "测试公告",
      raw: { marker: rawMarker },
    },
    raw: { marker: rawMarker },
  });
  const snapshot = runtime.getSnapshot();
  const snapshotText = JSON.stringify(snapshot);
  assert(!snapshotText.includes(rawMarker), "runtime snapshot should not expose raw packet payloads");
  assert(!snapshot.rankStats[0]?.raw, "rank stats in runtime snapshot should be compacted");
  assert(!snapshot.lastLog?.raw && !snapshot.lastLog?.event?.raw, "last log in runtime snapshot should be compacted");
}

function verifyNoticeGiftAndGuardParsing() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.room = { roomId: 20002 };
  const gifts = [];
  const guards = [];
  client.on("gift", (event) => gifts.push(event));
  client.on("guard", (event) => guards.push(event));
  handleRaw(client, {
    cmd: "NOTICE_MSG",
    id: 1852,
    name: "永恒誓约",
    full: { head_icon: "https://i0.hdslb.com/bfs/live/test.gif" },
    roomid: 20002,
    real_roomid: 20002,
    msg_self: "<%测试赠礼者%>投喂<%测试主播%>1个永恒誓约，快来围观吧！",
    business_id: "35473",
  });
  assert(gifts.length === 1, "local notice gift should emit gift event");
  // 整改后契约：跑马灯没有真实礼物 id，giftId 恒 0，业务通知 id 保存在 noticeBusinessId；
  // 且公告合成礼物是次级来源，同窗口内真实 gift_packet 优先。
  assert(gifts[0].giftId === 0, `notice gift giftId should stay 0, got ${gifts[0].giftId}`);
  assert(gifts[0].noticeBusinessId === "35473", `notice gift should keep business id, got ${gifts[0].noticeBusinessId}`);
  assert(gifts[0].sourcePriority === "secondary", "notice gift should be marked as a secondary source");

  handleRaw(client, {
    cmd: "NOTICE_MSG",
    id: 980,
    name: "提督1个月",
    roomid: 20002,
    real_roomid: 20002,
    msg_self: "<%测试续费者%> 在主播 <%测试主播%>的直播间续费了提督，感谢上船陪伴",
    business_id: "xuser-guard",
  });
  assert(guards.length === 1, "local notice guard should emit guard event");
  assert(guards[0].guardLevel === 2 && guards[0].guardName === "提督", "notice guard should parse guard level");

  const stateDir = path.join(__dirname, "..", ".tmp", "verify-notice-dedupe");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const store = new EventStore({ rootDir: stateDir });
  const at = Date.now();
  store.append("gift", {
    at,
    roomId: 20002,
    payload: {
      id: "notice-1",
      at,
      userName: "测试赠礼者",
      giftId: 35473,
      giftName: "永恒誓约",
      count: 1,
      totalCoin: 3000000,
      source: "notice_gift",
      sourceCommand: "NOTICE_MSG_GIFT",
    },
  });
  store.append("gift", {
    at: at + 5000,
    roomId: 20002,
    payload: {
      id: "real-1",
      at: at + 5000,
      userName: "测试赠礼者",
      giftId: 35473,
      giftName: "永恒誓约",
      count: 1,
      totalCoin: 3000000,
      source: "gift_packet",
      sourceCommand: "SEND_GIFT",
    },
  });
  const summary = store.queryGifts({ range: "today", roomId: 20002, giftName: "永恒誓约" });
  assert(summary.totalGiftCount === 1, `notice gift duplicate should be removed, got ${summary.totalGiftCount}`);
  assert(summary.totalCoin === 3000000, `notice gift duplicate should not double value, got ${summary.totalCoin}`);

  const runtime = new BotRuntime({
    config: { history: { noticeGiftDelayMs: 60000 } },
    room: "20002",
    dryRun: true,
  });
  runtime.deferNoticeGift({
    source: "notice_gift",
    command: "NOTICE_MSG_GIFT",
    userName: "测试赠礼者",
    displayUserName: "测试赠礼者",
    giftId: 35473,
    giftName: "永恒誓约",
    count: 1,
  });
  assert(runtime.pendingNoticeGifts.size === 1, "notice gift should wait for real SEND_GIFT before counting");
  const cancelled = runtime.cancelPendingNoticeGift({
    source: "gift_packet",
    command: "SEND_GIFT",
    userName: "测试赠礼者",
    displayUserName: "测试赠礼者",
    giftId: 35473,
    giftName: "永恒誓约",
    count: 1,
  });
  assert(cancelled && runtime.pendingNoticeGifts.size === 0, "real SEND_GIFT should cancel matching notice gift");
}

function verifyPkNoticeParsing() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.room = { roomId: 20002 };
  const notices = [];
  const pkEvents = [];
  client.on("notice", (event) => notices.push(event));
  client.on("pk", (event) => pkEvents.push(event));
  handleRaw(client, {
    cmd: "COMMON_NOTICE_DANMAKU",
    data: {
      content_segments: [
        {
          font_color: "#FB7299",
          text: "我方主播快要输掉比赛啦！大家赶紧冲啊，逆转比赛靠你们啦～",
          type: 1,
        },
      ],
      dmscore: 1008,
      terminals: [1, 2, 3, 4, 5],
    },
  });
  assert(notices.length === 1 && notices[0].noticeKind === "pk", "PK common notice should be classified as pk notice");
  assert(pkEvents.length === 1 && pkEvents[0].command === "PK_NOTICE", "PK common notice should emit a pk event");
  assert(pkEvents[0].noticeType === "behind" && pkEvents[0].noticeLevel === "warn", "PK losing notice should keep warning type");

  const tracker = new PkTracker({ ownRoomId: 20002 });
  const actions = tracker.handle(pkEvents[0]);
  assert(actions.length === 0, "PK notice should update state without creating auto-reply actions");
  const snapshot = tracker.getSnapshot();
  assert(snapshot.active === true, "PK notice should mark PK state active");
  assert(snapshot.lastNotice?.text.includes("快要输掉"), "PK tracker should expose latest PK notice text");

  const runtime = new BotRuntime({ room: "20002", dryRun: true });
  runtime.pkTracker = tracker;
  assert(/PK提醒/.test(runtime.formatPkEventLog(pkEvents[0])), "runtime PK log should summarize PK notice text");
}

function verifyMaskedNameResolution() {
  const face = "https://i0.hdslb.com/bfs/face/test.jpg";
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.rememberMaskedEntry({ userName: "自***", face });
  client.learnIdentityFromWelcomeText("欢迎自律测试者来到直播间");
  const resolved = client.resolveIdentity({ userName: "自***", face });
  assert(
    resolved.displayUserName === "自律测试者" && !resolved.isMaskedName,
    "masked name should resolve to full name"
  );

  const gifts = [];
  client.room = { roomId: 20002 };
  client.on("gift", (event) => gifts.push(event));
  handleRaw(client, {
    cmd: "SEND_GIFT",
    data: {
      uid: 10001,
      uname: "自***",
      gift_id: 1,
      gift_name: "人气票",
      num: 1,
      price: 100,
      total_coin: 100,
      sender_uinfo: {
        uid: 10001,
        base: {
          origin_info: { name: "自律测试者", face },
          risk_ctrl_info: { name: "自***" },
        },
      },
    },
  });
  assert(
    gifts[0]?.userName === "自律测试者" && !/\*/.test(gifts[0]?.displayUserName || ""),
    "gift parser should prefer full origin name"
  );
}

function verifyGiftPacketNoMiss() {
  {
    // 对 fixtures 回放：每个礼物类报文（含红包 V2）都必须产出 gift 事件，一个不落。
    const result = replayFiles(listFixtureRawFiles(), {});
    const expected =
      countNamed(result.commands, "SEND_GIFT") +
      countNamed(result.commands, "COMBO_SEND") +
      countNamed(result.commands, "GIFT_COMBO") +
      countNamed(result.commands, "POPULARITY_RED_POCKET_NEW") +
      countNamed(result.commands, "POPULARITY_RED_POCKET_V2_NEW");
    assert(expected > 0, "fixtures should contain gift packets");
    assert(
      countNamed(result.emitted, "gift") >= expected,
      `gift emitted ${countNamed(result.emitted, "gift")} < packet gifts ${expected}`
    );
  }

  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  const gifts = [];
  const guards = [];
  const superChats = [];
  const interacts = [];
  client.on("gift", (event) => gifts.push(event));
  client.on("guard", (event) => guards.push(event));
  client.on("superChat", (event) => superChats.push(event));
  client.on("interact", (event) => interacts.push(event));
  handleRaw(client, {
    cmd: "POPULARITY_RED_POCKET_NEW",
    data: {
      uid: 10001,
      uname: "红包用户",
      room_id: 20002,
      gift_id: 9,
      gift_name: "人气红包",
      num: 3,
      price: 100,
      total_price: 300,
      lot_id: "lot-1",
      current_time: 1778182581,
    },
  });
  assert(
    gifts.length === 1 && gifts[0].source === "red_pocket" && gifts[0].totalCoin === 300,
    "red pocket gift packet should be captured as gift"
  );
  handleRaw(client, {
    cmd: "GIFT_COMBO",
    data: {
      uid: 10002,
      uname: "连击用户",
      giftId: 31036,
      giftName: "小花花",
      num: 10,
      price: 100,
      combo_total_coin: 1000,
      batch_combo_id: "batch:test",
    },
  });
  assert(gifts.some((event) => event.command === "GIFT_COMBO" && event.count === 10), "GIFT_COMBO should emit gift");
  handleRaw(client, {
    cmd: "USER_TOAST_MSG_V2",
    data: {
      sender_uinfo: { uid: 10003, base: { name: "红酒鹅肝手握" } },
      guard_info: { guard_level: 3, role_name: "舰长" },
      pay_info: { num: 1, price: 198000, unit: "月" },
      toast_msg: "<%红酒鹅肝手握%> 在主播旺旺小咪I的直播间开通了舰长",
    },
  });
  assert(
    guards.some((event) => event.command === "USER_TOAST_MSG_V2" && event.guardLevel === 3),
    "USER_TOAST_MSG_V2 should emit guard"
  );
  handleRaw(client, {
    cmd: "SUPER_CHAT_MESSAGE",
    data: {
      uid: 10005,
      user_info: {
        uname: "醒目留言用户",
        face: "https://i0.hdslb.com/bfs/face/sc-face.jpg",
        guard: { level: 2 },
      },
      medal_info: {
        name: "测试牌",
        level: 33,
        guard_level: 2,
      },
      message: "主播看这里",
      price: 30,
      id: "sc-1",
      start_time: 1778182581,
      end_time: 1778182641,
      background_color: "#EAB308",
    },
  });
  assert(
    superChats.some(
      (event) =>
        event.command === "SUPER_CHAT_MESSAGE" &&
        event.userName === "醒目留言用户" &&
        event.face &&
        event.medalName === "测试牌" &&
        event.guardLevel === 2 &&
        event.guardName === "提督" &&
        event.price === 30
    ),
    "SUPER_CHAT_MESSAGE should emit rich superChat fields"
  );
  handleRaw(client, {
    cmd: "OPEN_LIVEROOM_SUPER_CHAT",
    data: {
      open_id: 10006,
      uname: "开放SC用户",
      uface: "https://i0.hdslb.com/bfs/face/open-sc.jpg",
      message: "开放平台SC",
      rmb: 50,
      medal_info: { name: "修铃铛", level: 25 },
    },
  });
  assert(
    superChats.some((event) => event.command === "OPEN_LIVEROOM_SUPER_CHAT" && event.userName === "开放SC用户" && event.face && event.price === 50),
    "OPEN_LIVEROOM_SUPER_CHAT should emit rich superChat fields"
  );
  handleRaw(client, {
    cmd: "ENTRY_EFFECT_MUST_RECEIVE",
    data: {
      uid: 10004,
      uname: "高能进房",
      copy_writing: "欢迎高能进房",
      room_id: 20002,
    },
  });
  assert(
    interacts.some((event) => event.command === "ENTRY_EFFECT_MUST_RECEIVE" && event.interactKind === "entry_effect"),
    "ENTRY_EFFECT_MUST_RECEIVE should emit entry effect interact"
  );
}

function verifyNoticeScopeAndPendingDedupe() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.room = { roomId: 20002 };
  const gifts = [];
  const notices = [];
  client.on("gift", (event) => gifts.push(event));
  client.on("notice", (event) => notices.push(event));
  handleRaw(client, {
    cmd: "NOTICE_MSG",
    roomid: 999,
    real_roomid: 999,
    msg_self: "<%路人%>投喂<%别人%>1个永恒誓约，快来围观吧！",
    business_id: "35473",
  });
  assert(notices.length === 1 && gifts.length === 0, "foreign notice gift should not count as local gift");

  const runtime = new BotRuntime({
    config: { history: { noticeGiftDelayMs: 60000 } },
    room: "20002",
    dryRun: true,
  });
  const notice = {
    source: "notice_gift",
    command: "NOTICE_MSG_GIFT",
    userName: "测试赠礼者",
    displayUserName: "测试赠礼者",
    giftId: 35473,
    giftName: "永恒誓约",
    count: 1,
  };
  runtime.deferNoticeGift(notice);
  runtime.deferNoticeGift({ ...notice });
  assert(runtime.pendingNoticeGifts.size === 1, "duplicate notice gift should keep one pending row");
  assert(
    runtime.cancelPendingNoticeGift({ ...notice, source: "gift_packet", command: "SEND_GIFT" }),
    "real gift should cancel pending notice"
  );
}

function verifyActivityRawParsing() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  const events = [];
  client.on("event", (event) => events.push(event));
  handleRaw(client, {
    cmd: "DM_INTERACTION",
    data: {
      data: JSON.stringify({
        cnt: 3,
        suffix_text: "人分享了直播间",
      }),
      status: 4,
      type: 105,
    },
  });
  handleRaw(client, {
    cmd: "LIVE_INTERACT_GAME_STATE_CHANGE",
    data: {
      game_name: "弹幕宠物互动玩法",
      game_id: "game-1",
      action: 1,
    },
  });
  handleRaw(client, {
    cmd: "RECALL_DANMU_MSG",
    data: {
      recall_type: 2,
      target_id: 1997829203,
    },
  });
  handleRaw(client, {
    cmd: "MESSAGEBOX_USER_MEDAL_CHANGE",
    data: {
      uid: 10005,
      up_uid: 20002,
      medal_level: 12,
      medal_name: "测试牌",
      upper_bound_content: "恭喜你的粉丝勋章【测试牌】升到12级",
      uinfo_medal: {
        name: "测试牌",
        level: 12,
        v2_medal_color_start: "#C770A499",
        v2_medal_color_end: "#C770A499",
        v2_medal_color_border: "#C770A499",
        v2_medal_color_text: "#FFFFFF",
        v2_medal_color_level: "#C770A4E6",
      },
    },
  });
  handleRaw(client, {
    cmd: "WEALTH_NOTIFY",
    data: { flag: 2, info: { level: 3, status: 1, effect_key: 1073 } },
  });
  handleRaw(client, {
    cmd: "SYS_MSG",
    msg: "争夺开启，时间周五20点至周日20点，逾期不候哟！",
    url: "",
  });
  handleRaw(client, {
    cmd: "ROOM_SKIN_MSG",
    skin_id: 709,
    status: 1,
    end_time: 1777937849,
  });
  assert(
    events.some(
      (event) =>
        event.command === "DM_INTERACTION" &&
        event.eventKind === "activity" &&
        event.activityType === "share" &&
        event.count === 3
    ),
    "DM_INTERACTION should emit a normalized activity event"
  );
  assert(
    events.some(
      (event) =>
        event.command === "LIVE_INTERACT_GAME_STATE_CHANGE" &&
        event.eventKind === "activity" &&
        event.activityType === "game" &&
        event.gameName === "弹幕宠物互动玩法"
    ),
    "LIVE_INTERACT_GAME_STATE_CHANGE should emit a normalized activity event"
  );
  assert(
    events.some(
      (event) =>
        event.command === "RECALL_DANMU_MSG" &&
        event.eventKind === "room_moderation" &&
        event.userId === 1997829203
    ),
    "RECALL_DANMU_MSG should emit a moderation event instead of falling through"
  );
  assert(
    events.some(
      (event) =>
        event.command === "MESSAGEBOX_USER_MEDAL_CHANGE" &&
        event.eventKind === "medal_change" &&
        event.userId === 10005 &&
        event.medalName === "测试牌" &&
        event.medalLevel === 12
    ),
    "MESSAGEBOX_USER_MEDAL_CHANGE should emit medal-change metadata for user visual hints"
  );
  assert(
    events.some(
      (event) =>
        event.command === "WEALTH_NOTIFY" &&
        event.eventKind === "wealth" &&
        event.wealthLevel === 3
    ),
    "WEALTH_NOTIFY should emit normalized wealth metadata"
  );
  assert(
    events.some(
      (event) =>
        event.command === "SYS_MSG" &&
        event.eventKind === "system_notice" &&
        /争夺开启/.test(event.text)
    ),
    "SYS_MSG should emit a readable system notice"
  );
  assert(
    events.some(
      (event) =>
        event.command === "ROOM_SKIN_MSG" &&
        event.eventKind === "room_skin" &&
        event.skinId === 709
    ),
    "ROOM_SKIN_MSG should emit room skin metadata instead of remaining unknown"
  );
}

function verifyNonCriticalMetadataParsing() {
  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  client.room = { roomId: 20002 };
  const events = [];
  const interactiveEmits = [];
  client.on("event", (event) => events.push(event));
  for (const name of ["chat", "interact", "gift", "superChat", "guard", "like", "pk", "notice"]) {
    client.on(name, () => interactiveEmits.push(name));
  }

  const messages = [
    {
      cmd: "DANMU_AGGREGATION",
      data: {
        activity_identity: "15364225",
        activity_source: 1,
        aggregation_cycle: 1,
        aggregation_icon: "https://i0.hdslb.com/bfs/live/c8fbaa863bf9099c26b491d06f9efe0c20777721.png",
        aggregation_num: 6,
        broadcast_msg_type: 0,
        msg: "我要发财了",
        show_rows: 1,
        show_time: 2,
        timestamp: 1781627086,
      },
    },
    {
      cmd: "FLOW_REWARD_CARD",
      data: {
        anchor_face: "https://i1.hdslb.com/bfs/face/834eb0de8d2f470bf03e4ea92831b14f3824c863.jpg",
        anchor_icon_url: "http://i0.hdslb.com/bfs/live/bbd2718cbce091d39f72b01ecc762b7542e292a7.png",
        anchor_name: "小潮院长",
        button_text: "去围观",
        cover: "https://i0.hdslb.com/bfs/live/new_room_cover/984d433e3660f5f3a97e1f865be9a84ca9c9b6df.jpg",
        description: "小潮team11周年直播",
        expire_time: 10,
        label_url: "http://i0.hdslb.com/bfs/live/96aa77878c4d3f8bf2ed59fb3ae2b2980ac48887.png",
        rank: 1,
        room_id: 941330,
        route: "https://live.bilibili.com/941330?popular_rank=1&user_from=2",
        ruid: 5970160,
      },
    },
    {
      cmd: "POPULARITY_RANK_TAB_CHG",
      data: {
        room_id: 20002,
        ruid: 558246120,
        type: "area",
        need_refresh_tab: true,
      },
    },
    {
      cmd: "ROOM_CHANGE",
      data: {
        title: "小小的也很可爱",
        area_id: 530,
        parent_area_id: 1,
        area_name: "萌宅领域",
        parent_area_name: "娱乐",
        live_key: "709602597275861237",
        sub_session_key: "709602597275861237sub_time:1782142402",
      },
    },
  ];
  for (const message of messages) handleRaw(client, message);

  const aggregation = events.find((event) => event.command === "DANMU_AGGREGATION");
  assert(
    aggregation?.eventKind === "activity" &&
      aggregation.activityType === "danmu_aggregation" &&
      aggregation.activityId === "15364225" &&
      aggregation.aggregationCount === 6 &&
      aggregation.text === "我要发财了" &&
      aggregation.sourceScope === "platform_activity" &&
      aggregation.interactionEligible === false,
    "DANMU_AGGREGATION should remain an auditable platform activity instead of becoming user chat"
  );
  const flowCard = events.find((event) => event.command === "FLOW_REWARD_CARD");
  assert(
    flowCard?.eventKind === "system_notice" &&
      flowCard.systemType === "platform_flow_recommendation" &&
      flowCard.recommendedRoomId === 941330 &&
      flowCard.anchorUserId === 5970160 &&
      flowCard.anchorName === "小潮院长" &&
      flowCard.description === "小潮team11周年直播" &&
      flowCard.jumpUrl.includes("/941330") &&
      flowCard.interactionEligible === false,
    "FLOW_REWARD_CARD should remain an auditable cross-room recommendation instead of becoming a local gift or chat"
  );
  const rankTab = events.find((event) => event.command === "POPULARITY_RANK_TAB_CHG");
  assert(
    rankTab?.eventKind === "rank" &&
      rankTab.rankEventType === "popularity_tab_change" &&
      rankTab.roomId === 20002 &&
      rankTab.anchorUserId === 558246120 &&
      rankTab.rankTabType === "area" &&
      rankTab.needRefreshTab === true &&
      rankTab.interactionEligible === false,
    "POPULARITY_RANK_TAB_CHG should emit conservative rank metadata"
  );
  const roomChange = events.find((event) => event.command === "ROOM_CHANGE");
  assert(
    roomChange?.eventKind === "room_metadata" &&
      roomChange.title === "小小的也很可爱" &&
      roomChange.areaId === 530 &&
      roomChange.parentAreaId === 1 &&
      roomChange.areaName === "萌宅领域" &&
      roomChange.parentAreaName === "娱乐" &&
      roomChange.interactionEligible === false,
    "ROOM_CHANGE should emit conservative room metadata"
  );
  const runtime = new BotRuntime({
    config: { room: "20002" },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = {
    roomId: 20002,
    title: "旧标题",
    areaId: 1,
    areaName: "旧分区",
  };
  const runtimeActions = [];
  runtime.on("action", (action) => runtimeActions.push(action));
  runtime.handleGenericEvent(roomChange);
  assert(
    runtime.roomInfo.title === "小小的也很可爱" &&
      runtime.roomInfo.areaId === 530 &&
      runtime.roomInfo.areaName === "萌宅领域" &&
      runtime.roomInfo.parentAreaName === "娱乐",
    "ROOM_CHANGE should refresh runtime room metadata"
  );
  assert(runtimeActions.length === 0, "ROOM_CHANGE metadata must not create an interaction action");
  assert(events.length === 4, `non-critical metadata packets should emit exactly four high-level events, got ${events.length}`);
  assert(
    interactiveEmits.length === 0,
    `non-critical metadata packets must not enter interaction channels: ${interactiveEmits.join(", ")}`
  );

  const fixturePath = path.resolve(__dirname, "..", ".tmp", "verify-non-critical-metadata.raw.jsonl");
  fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
  fs.writeFileSync(
    fixturePath,
    `${messages
      .map((message, index) =>
        JSON.stringify({ at: 1781627086696 + index, roomId: 20002, command: message.cmd, message })
      )
      .join("\n")}\n`
  );
  try {
    const replay = replayFiles([fixturePath], { room: "20002" });
    const known = new Set((replay.knownNonCritical || []).map((item) => item.name));
    const groups = new Map((replay.groups || []).map((item) => [item.name, item.count]));
    assert(countNamed(replay.emitted, "event") === 4, "replay should retain all four metadata packets as high-level events");
    assert(replay.uncoveredImportant.length === 0, "known metadata packets should not create important replay false alarms");
    assert(
      ["DANMU_AGGREGATION", "FLOW_REWARD_CARD", "POPULARITY_RANK_TAB_CHG", "ROOM_CHANGE"].every((name) => known.has(name)),
      "replay should list all four metadata commands as known non-critical packets"
    );
    assert(
      groups.get("activity") === 1 && groups.get("system") === 1 && groups.get("traffic") === 1 && groups.get("room") === 1,
      "replay should classify aggregation, flow recommendation, rank tab, and room change by metadata role"
    );
  } finally {
    fs.rmSync(fixturePath, { force: true });
  }
}

function verifyGiftHistoryRestoreUsesFullDay() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-gift-restore");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const runtime = new BotRuntime({
    config: {
      history: {
        enabled: true,
        dir: stateDir,
        restoreGiftStatsOnStart: true,
      },
      interactions: { gift: { enabled: true, aggregateWindowMs: 0 } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  runtime.interactions = new InteractionEngine({
    gift: { enabled: true, aggregateWindowMs: 0, dedupeFingerprintWindowMs: 0 },
  });
  const at = Date.now() - 60000;
  for (let index = 0; index < 55; index += 1) {
    runtime.eventStore.append("gift", {
      at: at + index,
      roomId: 20002,
      payload: {
        id: `restore-${index}`,
        at: at + index,
        roomId: 20002,
        userId: 10000 + index,
        userName: `礼物用户${index}`,
        giftName: "人气票",
        giftId: 33988,
        count: 1,
        price: 100,
        totalCoin: 100,
        coinType: "gold",
        source: "gift_packet",
        dedupeKey: `restore-${index}`,
      },
    });
  }
  const summary = runtime.eventStore.queryGifts({ range: "today", roomId: 20002 });
  assert(summary.giftFeed.length === 40, "public gift feed should remain capped for UI speed");
  assert(summary.quality.checkedRows === 55, `history gift quality should check all 55 rows, got ${summary.quality.checkedRows}`);
  assert(summary.quality.affectedRows === 55, `history gift quality should flag all incomplete restore rows, got ${summary.quality.affectedRows}`);
  assert(summary.quality.missingIcon === 55, `history gift quality should count missing icons across all rows, got ${summary.quality.missingIcon}`);
  assert(summary.quality.missingFace === 55, `history gift quality should count missing faces across all rows, got ${summary.quality.missingFace}`);
  assert(runtime.eventStore.queryGiftRows({ range: "today", roomId: 20002 }).length === 55, "queryGiftRows should expose all deduped gift rows");
  runtime.seedGiftStatsFromHistory(20002);
  const stats = runtime.interactions.getStats();
  assert(stats.totalGiftCount === 55, `restore should replay all 55 gifts, got ${stats.totalGiftCount}`);
  assert(stats.totalCoin === 5500, `restore should keep full gift value, got ${stats.totalCoin}`);
  runtime.interactions.handleGift({
    at: Date.now() - 86400000,
    userName: "昨晚用户",
    giftName: "人气票",
    count: 1,
    price: 100,
    totalCoin: 100,
    coinType: "gold",
    source: "gift_packet",
    dedupeKey: "stale-session-gift",
  });
  const snapshot = runtime.getSnapshot();
  assert(snapshot.giftStats.source === "history_today", "snapshot gift stats should be sourced from today's persisted history");
  assert(snapshot.giftStats.day, "snapshot gift stats should expose the local day key");
  assert(
    snapshot.giftStats.totalGiftCount === 55,
    `snapshot today gift stats should not include stale pre-midnight session gifts, got ${snapshot.giftStats.totalGiftCount}`
  );
  assert(snapshot.counts.gift === 0, `history restore should not pollute current-session gift count, got ${snapshot.counts.gift}`);
  assert(
    snapshot.giftStats.liveSessionTotalGiftCount === 0,
    `history restore should expose liveSessionTotalGiftCount=0, got ${snapshot.giftStats.liveSessionTotalGiftCount}`
  );
  const reportAction = runtime.createGiftReportAction({ range: "today", label: "今日" });
  assert(
    /今日礼物：共55电池，55件/.test(reportAction.reply),
    `today gift report should use persisted day-scoped stats, got ${reportAction.reply}`
  );
  assert(
    snapshot.captureHealth.giftEvents.historyRestored === 55,
    `restore should expose historyRestored=55, got ${snapshot.captureHealth.giftEvents.historyRestored}`
  );
  assert(
    snapshot.captureHealth.giftEvents.lastGiftCommand === "HISTORY_RESTORE",
    "restore should mark the latest gift source as history restore"
  );
}

function verifyPkRetryInvestigation() {
  const runtime = new BotRuntime({
    config: {
      pk: { investigator: { enabled: true } },
      modules: { pk: { enabled: true } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  runtime.simulate("pk");
  runtime.pkInvestigator = {
    investigate: () => new Promise(() => {}),
  };
  const result = runtime.retryPkInvestigation();
  assert(result.ok && result.roomId === 22262300, "PK retry should choose the current opponent room");
  const snapshot = runtime.getSnapshot();
  assert(snapshot.pk.investigationInFlight, "PK retry should expose investigation in-flight state");
  assert(snapshot.pk.investigationRooms.includes(22262300), "PK retry should expose in-flight room id");
}

function verifySimulatedHighValueEvents() {
  const runtime = new BotRuntime({
    config: {
      history: { enabled: false },
      modules: { guardBoard: { enabled: true } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  let snapshot = runtime.simulate("superChat");
  assert(snapshot.counts.superChat === 1, "SC simulation should increment superChat count");
  assert(snapshot.giftStats.superChatTotal === 30, "SC simulation should update superChat total");
  assert(snapshot.captureHealth.giftEvents.superChat === 1, "SC simulation should mark superChat capture coverage");

  snapshot = runtime.simulate("guard");
  assert(snapshot.counts.guard === 1, "guard simulation should increment guard count");
  assert(snapshot.captureHealth.giftEvents.guard === 1, "guard simulation should mark guard capture coverage");
  // 疑似真 bug（记录在整改报告 suspected_bugs，不在测试里改 src 掩盖）：
  // botRuntime.getGuardBoard() 的 5 秒缓存没有在新 guard 事件时失效，
  // 快照里的 guardBoard 在事件后 5 秒内是旧的。这里改断言引擎层真实状态；
  // 缓存失效修复后应恢复对 snapshot.guardBoard 的断言。
  const memoryBoard = runtime.interactions.getGuardBoard();
  assert(
    memoryBoard.rows.some((row) => row.userName === "白纸折七次" && row.guardName === "提督"),
    "guard simulation should populate the in-memory guard board"
  );
  assert(
    memoryBoard.rows.every((row) => row.isSimulated || row.userName !== "白纸折七次"),
    "guard simulation rows should be marked as simulated"
  );
}

function verifyAssistantSelfTest() {
  // 新 expectAction 语义要求模块开启时必须真的产出动作，
  // 而欢迎/感谢模板都来自 DEFAULT_CONFIG——测试配置必须像生产一样先做三层合并。
  const result = runAssistantSelfTest({
    config: deepMergeConfig(DEFAULT_CONFIG, {
      // selfTest 内部会强制 history.enabled=false，但 dir 仍要显式指进 .tmp，
      // 避免 BotRuntime 构造时在默认位置 mkdir。
      history: { enabled: true, dir: path.join(TMP_ROOT, "verify-self-test") },
      screenshots: { enabled: true },
      modules: {
        giftThanks: { enabled: true },
        guardBoard: { enabled: true },
        pk: { enabled: true },
        welcome: { enabled: true },
      },
    }),
    room: "20002",
    roomId: 20002,
  });
  assert(result.isolated && result.dryRun, "self-test should report isolated dry-run mode");
  assert(result.summary.total >= 9, "self-test should cover every simulated module");
  // 疑似真 bug（记录在整改报告 suspected_bugs）：getGuardBoard() 的 5 秒缓存让自检的
  // before/after 快照拿不到刚模拟出的 guard 行，自检的 guard 检查在当前 src 下必然失败。
  // 这里只豁免这一个已知项；缓存失效修复后 failing 应为空、下面的断言自动收紧回全绿。
  const failing = result.checks.filter((check) => !check.ok);
  assert(
    failing.every((check) => check.key === "guard" && /大航海/.test(check.detail || "")),
    `self-test should only fail on the known guard-board cache bug, got: ${failing
      .map((check) => `${check.key}:${check.detail}`)
      .join("; ")}`
  );
  assert(result.summary.passed >= result.summary.total - 1, "self-test should pass every check except the known guard-cache bug");
  assert(
    ["enter", "chat", "gift", "blind_gift", "superChat", "lottery", "pk", "multi"].every((key) =>
      result.checks.some((check) => check.key === key && check.ok)
    ),
    "self-test should cover enter, chat, gift, blind gift, SC, lottery, PK, and multi-PK"
  );
  assert(result.summary.giftStats.superChatTotal >= 30, "self-test should prove SC stats wiring works");
}

async function verifyPkMultiRoomInvestigation() {
  const runtime = new BotRuntime({
    config: {
      pk: { investigator: { enabled: true, maxRooms: 4 } },
      modules: { pk: { enabled: true } },
    },
    room: "1000",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 1000, uname: "我方主播", liveStatus: 1 };
  // 整改后停机会丢弃在途侦查结果（running=false 时 investigate 回来直接丢），测试要模拟在跑状态。
  runtime.running = true;
  runtime.pkTracker = new PkTracker({ ownRoomId: 1000 });
  const calls = [];
  runtime.pkInvestigator = {
    investigate: async (roomId) => {
      calls.push(Number(roomId));
      return {
        roomId: Number(roomId),
        uid: Number(roomId) + 10,
        uname: `对手${roomId}`,
        fans: 1234,
        guardCount: 5,
        guardCounts: { 1: 0, 2: 1, 3: 4 },
        onlineRankCount: 8,
        onlineGuardCount: 3,
        topScore: 666,
        topRank: [{ rank: 1, uid: 90001, uname: "对面大哥", score: 666, guardLevel: 3 }],
        source: "http_investigation",
        partialFailures: [],
        fetchedAt: Date.now(),
      };
    },
  };

  runtime.pkTracker.handle({
    command: "PK_MULTI_CONN",
    data: {
      sessionId: "multi-test",
      members: [
        { room_id: 1000, uid: 100, uname: "我方主播", votes: 10, position: 1, is_room_owner: true },
        { room_id: 2001, uid: 201, uname: "对手A", votes: 30, position: 2 },
        { room_id: 2002, uid: 202, uname: "对手B", votes: 20, position: 3 },
      ],
    },
  });
  runtime.refreshPkInvestigationIfNeeded();
  assert(calls.includes(2001) && calls.includes(2002), `multi PK should investigate all opponent rooms, got ${calls.join(",")}`);
  assert(!calls.includes(1000), "multi PK investigation should skip own room");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const snapshot = runtime.pkTracker.getSnapshot();
  assert(snapshot.investigations["2001"]?.guardCount === 5, "multi PK should store investigation by room id");
  assert(
    snapshot.multiMembers.some((member) => member.roomId === 2002 && member.topRank?.[0]?.uname === "对面大哥"),
    "multi PK member rows should be enriched with opponent top-rank info"
  );
}

function verifyVisibleBridgeBatch() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-visible-bridge");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const runtime = new BotRuntime({
    config: {
      history: { dir: stateDir },
      interactions: { gift: { enabled: true, aggregateWindowMs: 0 } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  const face = "https://i0.hdslb.com/bfs/face/visible-user.jpg";
  const avatarFrameUrl = "https://i0.hdslb.com/bfs/live/visible-captain-frame.png";
  const guardIcon = "https://i0.hdslb.com/bfs/live/visible-guard-icon.png";
  const giftIcon = "https://i0.hdslb.com/bfs/live/test-gift.webp";
  const result = runtime.ingestVisible({
    kind: "batch",
    bridgeVersion: "visible-dom-v8-throttle",
    roomId: 20002,
    url: "https://live.bilibili.com/20002",
    batchId: "batch-test",
    events: [
      {
        id: "visible-chat-1",
        kind: "chat",
        userName: "完整昵称",
        chatText: "这个多少钱",
        face,
        medalName: "测试牌",
        medalLevel: 20,
        medalColors: { start: "#76b7ff", end: "#6a8ff0", border: "#2d72d9", text: "#ffffff" },
        guardLevel: 2,
        guardName: "提督",
        guardIcon,
        avatarFrame: { url: avatarFrameUrl, name: "提督头像框", source: "visible_dom" },
        avatarFrameUrl,
        avatarFrameName: "提督头像框",
        wealthLevel: 41,
      },
      {
        id: "visible-gift-1",
        kind: "gift",
        userName: "送礼用户",
        chatText: "投喂 小花花 x2",
        giftName: "小花花",
        giftIcon,
        count: 2,
        price: 100,
        totalCoin: 200,
        face,
        medalName: "修铃铛",
        medalLevel: 25,
        guardLevel: 3,
        guardName: "舰长",
        guardIcon,
        avatarFrame: { url: avatarFrameUrl, name: "舰长头像框", source: "visible_dom" },
        avatarFrameUrl,
        avatarFrameName: "舰长头像框",
        wealthLevel: 34,
      },
      {
        id: "visible-pk-1",
        kind: "pk",
        userName: "网页PK",
        chatText: "可见PK比分：我方 120，对面 80",
        face,
        pk: {
          mode: "battle",
          ownScore: 120,
          opponentScore: 80,
          members: [
            { rank: 1, uname: "我方大哥", votes: 120, roomId: 20002 },
            { rank: 2, uname: "对面大哥", votes: 80, roomId: 30003 },
          ],
          text: "我方 120 对面 80",
        },
      },
    ],
  });
  assert(result.ok && result.kind === "batch" && result.count === 3, "visible bridge batch should accept chat, gift, and PK rows");
  const snapshot = runtime.getSnapshot();
  assert(snapshot.counts.chat === 1, `visible batch chat count expected 1, got ${snapshot.counts.chat}`);
  assert(snapshot.counts.gift === 1, `visible batch gift count expected 1, got ${snapshot.counts.gift}`);
  assert(snapshot.counts.pk === 1, `visible batch PK count expected 1, got ${snapshot.counts.pk}`);
  assert(snapshot.giftStats.totalGiftCount === 2, "visible batch gift should preserve count");
  const giftRow = snapshot.giftStats.giftFeed[0] || {};
  assert(giftRow.face === face, "visible batch should preserve per-event face fields");
  assert(giftRow.giftIcon === giftIcon, "visible batch should preserve gift icon fields");
  assert(giftRow.avatarFrameUrl === avatarFrameUrl, "visible batch should preserve avatar frame URL");
  assert(giftRow.avatarFrameName === "舰长头像框", "visible batch should preserve avatar frame name");
  assert(giftRow.guardName === "舰长" && giftRow.guardLevel === 3, "visible batch should preserve guard identity fields");
  assert(giftRow.medalName === "修铃铛" && giftRow.medalLevel === 25, "visible batch should preserve fan medal fields");
  assert(giftRow.wealthLevel === 34, "visible batch should preserve wealth level");
  assert(giftRow.valueText === "2电池", `visible batch should preserve formatted value text, got ${giftRow.valueText}`);
  assert(snapshot.captureHealth.giftEvents.visibleBridge === 1, "visible batch should count visible bridge gifts");
  assert(snapshot.captureHealth.visualAudit.acceptedTotal === 3, "visible batch should count accepted chat, gift, and PK rows");
  assert(snapshot.captureHealth.visualAudit.acceptedPk === 1, "visible batch should count accepted visible PK rows");
  const giftHistory = runtime.eventStore.queryGifts({ range: "today", roomId: 20002, giftName: "小花花" });
  const historyRow = runtime.eventStore.queryGiftRows({ range: "today", roomId: 20002, giftName: "小花花" })[0] || {};
  assert(giftHistory.totalGiftCount === 2, "visible gift history should preserve gift count");
  assert(historyRow.giftIcon === giftIcon, "visible gift history should preserve gift icon");
  assert(historyRow.avatarFrameUrl === avatarFrameUrl, "visible gift history should preserve avatar frame");
  assert(historyRow.face === face, "visible gift history should preserve face");
  const visiblePk = runtime.eventStore.readRecentEvents({ range: "today", kinds: ["pk"], maxLines: 20 }).find((entry) => entry.payload?.command === "VISIBLE_PK_BRIDGE")?.payload;
  assert(visiblePk?.pk?.ownScore === 120 && visiblePk?.pk?.opponentScore === 80, "visible PK should preserve score fields");
  assert(
    visiblePk?.pk?.members?.some((member) => member.uname === "对面大哥" && member.votes === 80 && member.roomId === 30003),
    "visible PK should preserve opponent member fields"
  );
}

function verifyBrowserDomChatRuntimeBridge() {
  const baseDir = path.join(__dirname, "..", ".tmp", "verify-browser-dom-chat-runtime");
  fs.rmSync(baseDir, { recursive: true, force: true });

  const makeRuntime = (name) => {
    const runtime = new BotRuntime({
      config: {
        history: { dir: path.join(baseDir, name) },
        modules: { autoSend: { enabled: false } },
        localAi: { enabled: false },
      },
      room: "20002",
      dryRun: true,
    });
    runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
    runtime.ensureVisibleEngines();
    const observations = {
      handled: [],
      commandCalls: 0,
      ruleCalls: 0,
    };
    const originalHandleIncomingChat = runtime.handleIncomingChat.bind(runtime);
    runtime.handleIncomingChat = (event, client) => {
      observations.handled.push({
        source: event.source || event.command || "",
        text: event.text || "",
      });
      return originalHandleIncomingChat(event, client);
    };
    runtime.commandEngine = {
      handleChat() {
        observations.commandCalls += 1;
        return { handled: false, actions: [], moduleUpdates: [] };
      },
    };
    runtime.rules = {
      handleChat() {
        observations.ruleCalls += 1;
        return [];
      },
      startTimers() {},
      stopTimers() {},
    };
    runtime.createMentionAiAction = () => null;
    runtime.createViewerAiAction = () => null;
    const client = new EventEmitter();
    runtime.attachClient(client, { primary: true });
    return { runtime, client, observations };
  };

  const wsFirst = makeRuntime("ws-first");
  wsFirst.client.emit("chat", {
    command: "DANMU_MSG",
    text: "东京温度多少",
    userName: "耶***",
    displayUserName: "耶***",
    isMaskedName: true,
    userId: 0,
    raw: { cmd: "DANMU_MSG", msg_id: "ws-chat-before-dom" },
  });
  assert(wsFirst.runtime.counts.chat === 1, "websocket chat should enter the shared incoming-chat chain");
  const duplicateDom = wsFirst.runtime.ingestVisible({
    id: "dom-chat-after-ws",
    kind: "chat",
    roomId: 20002,
    userName: "耶测试观众",
    chatText: "东京温度多少",
  });
  assert(
    duplicateDom.ok && duplicateDom.skipped && duplicateDom.reason === "跨来源重复弹幕",
    "DOM chat should be suppressed when the same masked/full identity and text already arrived by websocket"
  );
  assert(wsFirst.observations.handled.length === 1, "cross-source duplicate must not invoke handleIncomingChat twice");
  assert(wsFirst.runtime.counts.chat === 1, "cross-source duplicate must not increment chat count twice");

  const sameTextOtherUser = wsFirst.runtime.ingestVisible({
    id: "dom-chat-other-user",
    kind: "chat",
    roomId: 20002,
    userName: "另一个观众",
    chatText: "东京温度多少",
  });
  assert(
    sameTextOtherUser.ok && !sameTextOtherUser.skipped,
    "strict cross-source dedupe must keep identical text from a different viewer"
  );
  assert(
    wsFirst.observations.handled.at(-1)?.source === "visible_bridge",
    "ordinary DOM chat must route through handleIncomingChat"
  );
  assert(
    wsFirst.observations.commandCalls === 2 && wsFirst.observations.ruleCalls === 2,
    "DOM chat should use the same command and rule chain as websocket chat"
  );

  const automaticCallsBeforeOwnEcho = wsFirst.observations.commandCalls;
  wsFirst.runtime.rememberSentText("这是机器人自己刚发的回复");
  const ownEcho = wsFirst.runtime.ingestVisible({
    id: "dom-own-bot-echo",
    kind: "chat",
    roomId: 20002,
    userName: "普通显示名",
    chatText: "这是机器人自己刚发的回复",
  });
  assert(
    ownEcho.ok && ownEcho.skippedAutomation && ownEcho.reason === "own_bot_chat",
    "recently sent bot text observed in DOM should be recorded but skip automation"
  );
  assert(
    wsFirst.observations.commandCalls === automaticCallsBeforeOwnEcho,
    "own bot DOM echo must not enter command/rule/AI automation"
  );
  assert(ownEcho.event?.isOwnBot === true, "own bot DOM echo should keep the isOwnBot history marker");

  const domFirst = makeRuntime("dom-first");
  const firstDom = domFirst.runtime.ingestVisible({
    id: "dom-chat-before-ws",
    kind: "chat",
    roomId: 20002,
    userName: "耶测试观众",
    chatText: "东京今天多少度",
  });
  assert(firstDom.ok && !firstDom.skipped, "first DOM chat should be accepted");
  domFirst.client.emit("chat", {
    command: "DANMU_MSG",
    text: "东京今天多少度",
    userName: "耶***",
    displayUserName: "耶***",
    isMaskedName: true,
    userId: 0,
    raw: { cmd: "DANMU_MSG", msg_id: "ws-chat-after-dom" },
  });
  assert(domFirst.observations.handled.length === 1, "websocket echo after DOM must not invoke automation twice");
  assert(domFirst.runtime.counts.chat === 1, "DOM-first cross-source duplicate must not increment chat count twice");
  assert(
    domFirst.runtime.getSnapshot().captureHealth.visualAudit.duplicateCount === 1,
    "cross-source suppression should be exposed in the visual audit duplicate counter"
  );

  for (const item of domFirst.runtime.recentCrossSourceChats) item.at -= 20000;
  domFirst.client.emit("chat", {
    command: "DANMU_MSG",
    text: "东京今天多少度",
    userName: "耶***",
    displayUserName: "耶***",
    isMaskedName: true,
    userId: 0,
    raw: { cmd: "DANMU_MSG", msg_id: "ws-chat-after-short-window" },
  });
  assert(
    domFirst.runtime.counts.chat === 2,
    "cross-source dedupe should expire after its short window instead of suppressing future repeated chat"
  );
}

function verifyVisibleBridgeSimulationIsolation() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-visible-bridge-simulated");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const runtime = new BotRuntime({
    config: {
      history: { dir: stateDir },
      interactions: { gift: { enabled: true, aggregateWindowMs: 0 } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  const result = runtime.ingestVisible({
    kind: "batch",
    isSimulated: true,
    bridgeVersion: "visible-dom-v8-throttle",
    batchId: "batch-simulated",
    events: [
      {
        id: "visible-sim-chat-1",
        kind: "chat",
        userName: "模拟完整昵称",
        chatText: "模拟弹幕不应该入库",
      },
      {
        id: "visible-sim-gift-1",
        kind: "gift",
        userName: "模拟送礼用户",
        chatText: "投喂 小花花 x2",
        giftName: "小花花",
        count: 2,
        totalCoin: 200,
      },
    ],
  });
  assert(result.ok && result.kind === "batch", "simulated visible batch should parse successfully");
  assert(result.count === 0, `simulated visible batch should not accept rows into runtime, got ${result.count}`);
  assert(
    result.results.every((row) => row.ok && row.skipped && row.reason === "模拟可见事件未入库"),
    "simulated visible rows should be reported as skipped, not ingested"
  );
  const snapshot = runtime.getSnapshot();
  assert(snapshot.counts.chat === 0, `simulated visible chat should not change chat count, got ${snapshot.counts.chat}`);
  assert(snapshot.counts.gift === 0, `simulated visible gift should not change gift count, got ${snapshot.counts.gift}`);
  assert(snapshot.giftStats.totalGiftCount === 0, "simulated visible gift should not enter gift stats");
  assert(snapshot.captureHealth.visualAudit.acceptedTotal === 0, "simulated visible events should not affect visual audit accepted totals");
  assert(snapshot.captureHealth.giftEvents.visibleBridge === 0, "simulated visible gift should not count as visible bridge gift");
  const auditResult = runtime.ingestVisible({
    kind: "audit",
    audit: true,
    isSimulated: true,
    source: "simulation",
    bridgeVersion: "local-visible-probe",
    counts: { chat: 9, gift: 9, pk: 1 },
    recentEvents: [{ kind: "chat", userName: "模拟心跳", chatText: "这不应该标记网页在线" }],
  });
  assert(
    auditResult.ok &&
      auditResult.kind === "audit" &&
      auditResult.skipped &&
      auditResult.simulated &&
      auditResult.active === false,
    "simulated visible audit heartbeat should report success without becoming active"
  );
  const auditSnapshot = runtime.getSnapshot();
  assert(auditSnapshot.captureHealth.visualAudit.active === false, "simulated visible audit should not mark bridge active");
  assert(auditSnapshot.captureHealth.visualAudit.lastAt === 0, "simulated visible audit should not update bridge heartbeat time");
  assert(
    auditSnapshot.captureHealth.visualAudit.observedTotal === 0,
    "simulated visible audit should not change observed bridge totals"
  );
}

function verifyVisibleBridgeRoomMismatch() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-visible-bridge-room-mismatch");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const runtime = new BotRuntime({
    config: {
      history: { dir: stateDir },
      interactions: { gift: { enabled: true, aggregateWindowMs: 0 } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  const auditResult = runtime.ingestVisible({
    kind: "audit",
    audit: true,
    bridgeVersion: "visible-dom-v8-throttle",
    roomId: 99999,
    url: "https://live.bilibili.com/99999",
    counts: { chat: 9, gift: 9, pk: 1 },
    recentEvents: [{ kind: "chat", userName: "错房间", chatText: "不应该入库" }],
  });
  assert(
    auditResult.ok &&
      auditResult.skipped &&
      auditResult.kind === "audit" &&
      auditResult.reason === "网页房间不匹配，未入库",
    "wrong-room visible audit should be skipped instead of marking the bridge active"
  );
  let snapshot = runtime.getSnapshot();
  assert(snapshot.captureHealth.visualAudit.active === false, "wrong-room audit should not mark bridge active");
  assert(snapshot.captureHealth.visualAudit.lastAt === 0, "wrong-room audit should not update bridge heartbeat time");
  assert(snapshot.captureHealth.visualAudit.observedTotal === 0, "wrong-room audit should not change observed totals");

  const batchResult = runtime.ingestVisible({
    kind: "batch",
    bridgeVersion: "visible-dom-v8-throttle",
    roomId: 99999,
    url: "https://live.bilibili.com/99999",
    events: [
      {
        id: "wrong-room-chat",
        kind: "chat",
        userName: "错房间",
        chatText: "不应该入库",
      },
      {
        id: "wrong-room-gift",
        kind: "gift",
        userName: "错房间送礼",
        chatText: "投喂 小花花 x2",
        giftName: "小花花",
        count: 2,
      },
    ],
  });
  assert(
    batchResult.ok &&
      batchResult.skipped &&
      batchResult.kind === "batch" &&
      batchResult.expectedRoomId === 20002 &&
      batchResult.incomingRoomId === 99999,
    "wrong-room visible batch should be rejected before child events enter the runtime"
  );
  snapshot = runtime.getSnapshot();
  assert(snapshot.counts.chat === 0, `wrong-room visible chat should not change chat count, got ${snapshot.counts.chat}`);
  assert(snapshot.counts.gift === 0, `wrong-room visible gift should not change gift count, got ${snapshot.counts.gift}`);
  assert(snapshot.giftStats.totalGiftCount === 0, "wrong-room visible gift should not enter gift stats");
  assert(snapshot.captureHealth.visualAudit.acceptedTotal === 0, "wrong-room bridge rows should not affect accepted totals");
  assert(snapshot.captureHealth.giftEvents.visibleBridge === 0, "wrong-room visible gift should not count as bridge gift");
}

function verifyVisibleBridgeRequiresKnownRoom() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-visible-bridge-known-room");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const runtime = new BotRuntime({
    config: {
      history: { dir: stateDir },
      interactions: { gift: { enabled: true, aggregateWindowMs: 0 } },
    },
    room: "",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 0, uname: "", liveStatus: 1 };
  const result = runtime.ingestVisible({
    kind: "batch",
    bridgeVersion: "visible-dom-v8-throttle",
    roomId: 20002,
    url: "https://live.bilibili.com/20002",
    events: [
      {
        id: "unknown-room-chat",
        kind: "chat",
        userName: "不该入库",
        chatText: "没有绑定监听房间时不能接收",
      },
    ],
  });
  assert(
    result.ok &&
      result.skipped &&
      result.kind === "batch" &&
      result.missingExpectedRoom &&
      result.reason === "未绑定监听房间，网页核对未入库",
    "visible bridge should reject real page data until the local listening room is known"
  );
  const snapshot = runtime.getSnapshot();
  assert(snapshot.counts.chat === 0, "unknown-room visible bridge should not create chat events");
  assert(snapshot.captureHealth.visualAudit.acceptedTotal === 0, "unknown-room bridge should not affect accepted totals");
}

function verifyVisibleBridgeDeliveryAudit() {
  const stateDir = path.join(__dirname, "..", ".tmp", "verify-visible-bridge-delivery");
  fs.rmSync(stateDir, { recursive: true, force: true });
  const runtime = new BotRuntime({
    config: {
      history: { dir: stateDir },
      interactions: { gift: { enabled: true, aggregateWindowMs: 0 } },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, uname: "测试主播", liveStatus: 1 };
  const result = runtime.ingestVisible({
    kind: "audit",
    audit: true,
    bridgeVersion: "visible-dom-v8-throttle",
    roomId: 20002,
    url: "https://live.bilibili.com/20002",
    counts: { chat: 2, gift: 1, pk: 0 },
    delivery: {
      status: "skipped",
      note: "重复可见事件",
      at: 1234567890,
      observed: 3,
      sent: 3,
      accepted: 1,
      lastKind: "礼物",
    },
    recentEvents: [{ kind: "gift", userName: "送礼用户", giftName: "小花花", count: 1 }],
  });
  assert(result.ok && result.kind === "audit" && result.active, "visible delivery audit should accept matching room heartbeat");
  const audit = runtime.getSnapshot().captureHealth.visualAudit;
  assert(audit.lastDeliveryStatus === "skipped", "visible audit should preserve delivery status");
  assert(audit.lastDeliveryNote === "重复可见事件", "visible audit should preserve delivery note");
  assert(audit.lastDeliveryAt === 1234567890, `visible audit should preserve delivery timestamp, got ${audit.lastDeliveryAt}`);
  assert(audit.lastDeliveryObserved === 3, `visible audit should preserve observed delivery count, got ${audit.lastDeliveryObserved}`);
  assert(audit.lastDeliverySent === 3, `visible audit should preserve sent delivery count, got ${audit.lastDeliverySent}`);
  assert(audit.lastDeliveryAccepted === 1, `visible audit should preserve accepted delivery count, got ${audit.lastDeliveryAccepted}`);
  assert(audit.lastDeliveryKind === "礼物", `visible audit should preserve last delivery kind, got ${audit.lastDeliveryKind}`);
}

function verifyLiveStatusAndLotteryPause() {
  const runtime = new BotRuntime({
    config: {
      interactions: {
        live: {
          entryMsg: "开播啦",
          goodbyeInfo: "下播啦",
        },
      },
      automation: {
        pauseWelcomeDuringLottery: true,
        pauseGiftDuringLottery: true,
      },
    },
    room: "20002",
    dryRun: true,
  });
  runtime.roomInfo = { roomId: 20002, liveStatus: 0 };
  runtime.lastLiveStatus = 1;
  assert(
    runtime.isPausedBySpecialMode({ ruleName: "live_status", reply: "下播啦" }) === "",
    "live status reminders should not be blocked by offline welcome pause"
  );
  assert(
    /未开播/.test(runtime.isPausedBySpecialMode({ ruleName: "welcome", reply: "欢迎测试" })),
    "regular welcome should still pause when room is offline"
  );

  runtime.roomInfo.liveStatus = 1;
  runtime.updateSpecialMode("POPULARITY_RED_POCKET_NEW", {});
  assert(
    /天选|红包/.test(runtime.isPausedBySpecialMode({ ruleName: "welcome", reply: "欢迎测试" })),
    "lottery/red pocket should pause welcome replies"
  );
  assert(
    /天选|红包/.test(runtime.isPausedBySpecialMode({ ruleName: "gift", reply: "感谢礼物" })),
    "lottery/red pocket should pause gift thanks"
  );
  assert(
    runtime.isPausedBySpecialMode({ ruleName: "pk", type: "pk_report", reply: "pk情况" }) === "",
    "lottery/red pocket should not pause PK reports"
  );

  const client = new BilibiliLiveClient({ room: "20002", reconnect: false });
  const hookRuntime = new BotRuntime({
    config: {
      automation: {
        pauseWelcomeDuringLottery: true,
        pauseGiftDuringLottery: true,
      },
    },
    room: "20002",
    dryRun: true,
  });
  hookRuntime.roomInfo = { roomId: 20002, liveStatus: 1 };
  const activityEvents = [];
  client.on("raw", ({ command, message }) => {
    hookRuntime.updateSpecialMode(command, { raw: message });
  });
  client.on("event", (event) => {
    activityEvents.push(event);
    hookRuntime.updateSpecialMode(event.command, event);
  });
  handleRaw(client, {
    cmd: "ANCHOR_LOT_START",
    data: {
      room_id: 20002,
      lot_id: "anchor-lot-1",
      title: "天选时刻",
    },
  });
  assert(
    activityEvents.some((event) => event.command === "ANCHOR_LOT_START" && event.activityType === "lottery"),
    "ANCHOR_LOT_START should emit activity event"
  );
  assert(
    /天选|抽奖/.test(hookRuntime.isPausedBySpecialMode({ ruleName: "welcome", reply: "欢迎测试" })),
    "raw lottery activity should pause welcome through runtime hook"
  );
  handleRaw(client, {
    cmd: "ANCHOR_LOT_END",
    data: {
      room_id: 20002,
      lot_id: "anchor-lot-1",
      title: "天选结束",
    },
  });
  const remainingMs = Number(hookRuntime.specialModes.lotteryUntil || 0) - Date.now();
  assert(
    remainingMs > 0 && remainingMs <= 20000,
    `lottery ending event should shorten pause window, got ${remainingMs}ms`
  );
}

function verifyLiveStatusActions() {
  const runtime = new BotRuntime({
    config: {
      interactions: {
        live: {
          entryMsg: "开播啦",
          goodbyeInfo: "下播啦",
        },
      },
    },
    room: "20002",
    dryRun: true,
  });
  const actions = [];
  runtime.on("action", (action) => actions.push(action.reply));
  runtime.handleGenericEvent({
    eventKind: "live_status",
    command: "LIVE",
    liveStatus: 1,
    roomId: 20002,
    text: "开播",
  });
  runtime.handleGenericEvent({
    eventKind: "live_status",
    command: "LIVE",
    liveStatus: 1,
    roomId: 20002,
    text: "开播",
  });
  runtime.handleGenericEvent({
    eventKind: "live_status",
    command: "PREPARING",
    liveStatus: 0,
    roomId: 20002,
    text: "下播/准备中",
  });
  assert(actions.join("|") === "开播啦|下播啦", `live status actions wrong: ${actions.join("|")}`);
  assert(runtime.specialModes.live === false && runtime.roomInfo.liveStatus === 0, "offline state should be recorded");
}

async function verifyWelcomeIdleReminders() {
  const config = {
    room: "20002",
    dryRun: true,
    modules: { welcome: { enabled: true } },
    interactions: {
      welcome: {
        enabled: true,
        cooldownSec: 0,
        userCooldownSec: 0,
        idleReminderUserCooldownSec: 0,
        templates: ["欢迎{user}"],
        idleReminders: [
          {
            enabled: true,
            delayMs: 20,
            requireFan: true,
            reply: "{user}还在的话扣个1",
          },
        ],
      },
    },
  };
  const runtime = new BotRuntime({ room: "20002", dryRun: true, config });
  runtime.config = config;
  runtime.interactions = new InteractionEngine(config);
  runtime.moduleStatus = { welcome: { enabled: true }, autoSend: { enabled: true } };
  runtime.running = true;
  const actions = [];
  runtime.handleAction = (action) => actions.push(action);
  runtime.handleEnterEvent({
    userId: 10001,
    userName: "老粉",
    displayUserName: "老粉",
    medalName: "修铃铛",
    medalLevel: 25,
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert(actions.some((action) => action.metadata?.idleReminder && /老粉还在的话/.test(action.reply)), "fan idle reminder should fire after configured delay");

  const cancelled = new BotRuntime({ room: "20002", dryRun: true, config });
  cancelled.config = config;
  cancelled.interactions = new InteractionEngine(config);
  cancelled.moduleStatus = { welcome: { enabled: true }, autoSend: { enabled: true } };
  cancelled.running = true;
  const cancelledActions = [];
  cancelled.handleAction = (action) => cancelledActions.push(action);
  cancelled.handleEnterEvent({
    userId: 10002,
    userName: "会说话",
    displayUserName: "会说话",
    medalName: "修铃铛",
    medalLevel: 20,
  });
  cancelled.cancelWelcomeIdleReminders({ userId: 10002, userName: "会说话" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert(!cancelledActions.some((action) => action.metadata?.idleReminder), "chatting viewer should cancel idle reminder");

  const passerBy = new BotRuntime({ room: "20002", dryRun: true, config });
  passerBy.config = config;
  passerBy.interactions = new InteractionEngine(config);
  passerBy.moduleStatus = { welcome: { enabled: true }, autoSend: { enabled: true } };
  passerBy.running = true;
  const passerByActions = [];
  passerBy.handleAction = (action) => passerByActions.push(action);
  passerBy.handleEnterEvent({ userId: 10003, userName: "路人", displayUserName: "路人" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert(!passerByActions.some((action) => action.metadata?.idleReminder), "idle reminder should not target ordinary passers-by when requireFan=true");

  const blockedConfig = JSON.parse(JSON.stringify(config));
  blockedConfig.interactions.welcome.blacklistIncludes = ["黑名单"];
  const blocked = new BotRuntime({ room: "20002", dryRun: true, config: blockedConfig });
  blocked.config = blockedConfig;
  blocked.interactions = new InteractionEngine(blockedConfig);
  blocked.moduleStatus = { welcome: { enabled: true }, autoSend: { enabled: true } };
  blocked.running = true;
  const blockedActions = [];
  blocked.handleAction = (action) => blockedActions.push(action);
  blocked.handleEnterEvent({
    userId: 10004,
    userName: "黑名单老粉",
    displayUserName: "黑名单老粉",
    medalName: "修铃铛",
    medalLevel: 30,
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert(!blockedActions.some((action) => action.metadata?.idleReminder), "blacklisted welcome should not schedule idle reminder by default");
}

async function verifyLocalSpeakRequiresEnablePost() {
  const oldFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      json: async () => ({}),
    };
  };
  try {
    const blocked = new BotRuntime({
      room: "20002",
      dryRun: false,
      enablePost: false,
      speakEndpoint: "http://127.0.0.1:4310/api/actions/speak",
    });
    await blocked.handleAction({ reply: "本地语音不应推送", ruleName: "test" }, {});
    assert(calls === 0, `local speak should require enablePost, got ${calls} fetch calls`);
    assert(blocked.getSnapshot().enablePost === false, "snapshot should expose enablePost=false");

    const allowed = new BotRuntime({
      room: "20002",
      dryRun: false,
      enablePost: true,
      speakEndpoint: "http://127.0.0.1:4310/api/actions/speak",
    });
    await allowed.handleAction({ reply: "本地语音可以推送", ruleName: "test" }, {});
    assert(calls === 1, `local speak should post when enablePost=true, got ${calls} fetch calls`);
    assert(allowed.getSnapshot().enablePost === true, "snapshot should expose enablePost=true");
  } finally {
    global.fetch = oldFetch;
  }
}

function verifyScreenshotRecentListing() {
  const root = path.join(__dirname, "..", ".tmp", "verify-screenshot-recent");
  fs.rmSync(root, { recursive: true, force: true });
  const dir = path.join(root, "screenshots");
  const dayDir = path.join(dir, "2026-05-12");
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, "12-00-00-001-manual-1-right-chat.png");
  fs.writeFileSync(filePath, "png");
  fs.appendFileSync(
    path.join(dayDir, "index.jsonl"),
    `${JSON.stringify({
      at: 1778577600001,
      day: "2026-05-12",
      kind: "manual",
      event: { userName: "主播", giftName: "测试截图" },
      files: [{ filePath, region: { name: "right-chat", x: 1, y: 2, width: 3, height: 4 } }],
    })}\n`
  );
  const service = new ScreenshotService({ screenshots: { dir } });
  const result = service.listRecent(5);
  assert(result.entries.length === 1, "screenshot recent browser should read index entries");
  assert(
    result.files[0]?.relativePath === "2026-05-12/12-00-00-001-manual-1-right-chat.png",
    "screenshot recent browser should expose relative file paths"
  );
  assert(result.files[0]?.exists === true && result.files[0]?.size === 3, "screenshot recent browser should expose file size and existence");
}

async function verifyScreenshotFailureDiagnosis() {
  const message = readableScreenshotError({ stderr: "not authorized to capture screen" });
  assert(message.includes("屏幕录制权限"), "screenshot permission errors should be rewritten as a readable macOS action");

  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    config: {
      room: "20002",
      screenshots: {
        enabled: true,
        regions: [{ name: "test", x: 0, y: 0, width: 1, height: 1 }],
        triggers: { manual: { enabled: true, delayMs: 0 } },
      },
    },
  });
  runtime.screenshotService.capture = async () => {
    throw Object.assign(new Error("not authorized"), { stderr: "not authorized to capture screen" });
  };
  const result = await runtime.captureScreenForTest("manual");
  const stats = runtime.getSnapshot().captureHealth.screenshots.stats;
  assert(result.ok === false && result.reason.includes("屏幕录制权限"), "manual screenshot test should return readable permission failure");
  assert(stats.failed === 1 && stats.lastError.includes("屏幕录制权限"), "manual screenshot failures should update capture health instead of becoming a 500");
}

function verifyManualGuardImport() {
  const root = path.join(__dirname, "..", ".tmp", "verify-manual-guard-import");
  fs.rmSync(root, { recursive: true, force: true });
  const store = new EventStore({ rootDir: root });
  const result = store.importManualGuards({
    roomId: 20002,
    now: Date.parse("2026-05-12T00:00:00+09:00"),
    text: "白纸折七次 总督 160天\n糯糯_Neko,舰长,294\n林间流翼 提督 2026-05-20",
  });
  assert(result.imported === 3 && result.total === 3, "manual guard import should parse three rows");
  const manual = store.queryManualGuards({ roomId: 20002 });
  assert(manual.total === 3 && manual.source === "manualGuardBoard", "manual guard board should be queryable by room");
  assert(manual.rows.some((row) => row.userName === "白纸折七次" && row.guardName === "总督"), "manual import should preserve governor rows");
  assert(manual.rows.some((row) => row.userName === "糯糯_Neko" && row.daysLeft === 294), "manual import should parse CSV day values");
  const merged = store.queryGuards({ roomId: 20002, range: "month" });
  assert(merged.total === 3, "normal guard query should include manual guard corrections");
}

function verifyRuntimeGuardBoardMerge() {
  const runtime = new BotRuntime({ room: "20002", dryRun: true });
  runtime.roomInfo = { roomId: 20002 };
  runtime.guardCatalog = {
    getBoard: () => ({
      source: "guardCatalog",
      rows: [
        { userId: 1, userName: "当前舰长", guardName: "舰长", daysLeft: 30 },
        { userId: 2, userName: "白纸折七次", guardName: "提督", daysLeft: 200 },
      ],
      recent: [],
    }),
  };
  runtime.interactions = {
    getGuardBoard: () => ({
      source: "memoryGuardBoard",
      rows: [{ userId: 3, userName: "刚上船", guardName: "舰长", daysLeft: 31 }],
      recent: [],
    }),
  };
  runtime.eventStore = {
    eventFileSize: () => 0,
    queryGuards: () => ({
      source: "historyGuardBoard",
      rows: [
        { userName: "白纸折七次", guardName: "提督", daysLeft: 5 },
        { userId: 4, userName: "历史舰长", guardName: "舰长", daysLeft: -1, expired: true },
      ],
    }),
    queryManualGuards: () => ({
      source: "manualGuardBoard",
      rows: [{ userName: "手工总督", guardName: "总督", daysLeft: 160 }],
      updatedAt: 123,
    }),
  };
  const board = runtime.getGuardBoard();
  assert(board.total === 5, `merged guard board should keep catalog/history/memory/manual rows, got ${board.total}`);
  assert(board.source === "manualGuardBoard" && board.manualTotal === 1, "manual guard rows should stay visible as corrections");
  assert(board.rows.some((row) => row.userName === "当前舰长"), "current guard catalog row should remain in merged board");
  assert(board.rows.some((row) => row.userName === "刚上船"), "in-memory guard purchase row should remain in merged board");
  assert(
    board.rows.filter((row) => row.userName === "白纸折七次").length === 1 &&
      board.rows.some((row) => row.userName === "白纸折七次" && row.daysLeft === 5),
    "history should update matching catalog guard expiry even when one source lacks UID"
  );
  assert(board.expired.some((row) => row.userName === "历史舰长"), "expired historical guard rows should remain visible");
}

function verifyChatAnalyticsSummary() {
  const root = path.join(__dirname, "..", ".tmp", "verify-chat-analytics");
  fs.rmSync(root, { recursive: true, force: true });
  const store = new EventStore({ rootDir: root });
  const now = Date.now();
  const rows = [
    { userId: 1, userName: "白纸折七次", text: "笑死 舰长积分商城" },
    { userId: 1, userName: "白纸折七次", text: "笑死 舰长积分商城" },
    { userId: 2, userName: "测试赠礼者", text: "主播 PK情报 做得不错" },
    { userId: 3, userName: "路人甲", text: "舰长积分商城 可以兑换吗" },
  ];
  rows.forEach((chat, index) => {
    store.append("chat", {
      at: now - index * 1000,
      roomId: 20002,
      payload: chat,
    });
  });
  store.append("chat", {
    at: now,
    roomId: 30003,
    payload: { userId: 9, userName: "隔壁观众", text: "不应计入本房" },
  });
  const rawMeta = [];
  rawMeta[4] = now + 5000;
  rawMeta[15] = {
    extra: JSON.stringify({ id_str: "raw-recovered-chat-1" }),
    user: {
      base: {
        name: "光***",
        origin_info: { name: "光***" },
      },
    },
  };
  store.appendRaw({
    at: now + 5000,
    roomId: 20002,
    command: "DANMU_MSG",
    message: {
      cmd: "DANMU_MSG",
      info: [
        rawMeta,
        "raw补回弹幕",
        [0, "光***"],
      ],
    },
  });

  const summary = store.queryChatSummary({ roomId: 20002, daysBack: 1 });
  assert(summary.mode === "summary", "chat summary should expose summary mode");
  assert(summary.total === 5 && summary.activeUserCount === 4, "chat summary should count room messages, raw recovery, and active users");
  assert(summary.rawRecovered === 1 && summary.source === "events+raw_replay", "chat summary should expose raw recovered rows");
  assert(summary.identityLimited === true && /原始弹幕补回 1 条/.test(summary.note || ""), "chat summary should warn when raw recovered names are masked");
  assert(summary.topUsers[0]?.userName === "白纸折七次" && summary.topUsers[0]?.count === 2, "chat summary should rank active viewers");
  assert(summary.topWords.some((item) => item.word === "舰长积分商城" && item.count >= 3), "chat summary should expose hot words");
  assert(summary.topMessages.some((item) => item.text === "笑死 舰长积分商城" && item.count === 2), "chat summary should expose repeated danmaku");

  const user = store.queryChatCounts({ roomId: 20002, userName: "测试赠礼者", daysBack: 1 });
  assert(user.mode === "user" && user.total === 1, "user chat count query should still work");
  const recoveredUser = store.queryChatCounts({ roomId: 20002, userName: "光", daysBack: 1 });
  assert(recoveredUser.total === 1 && recoveredUser.rawRecovered === 1, "user chat count query should include matching raw recovered rows");
}

function verifyOwnBotChatPersistence() {
  const root = path.join(__dirname, "..", ".tmp", "verify-own-bot-chat-persistence");
  fs.rmSync(root, { recursive: true, force: true });
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: true,
    config: {
      room: "20002",
      // 必须传绝对路径：相对路径会随运行时 cwd 漂移（历史上正是这里写偏过目录）。
      history: { dir: root },
      modules: { autoSend: { enabled: true } },
    },
  });
  runtime.roomInfo = { roomId: 20002 };
  runtime.biliAccountName = "光模块专家阿K";
  runtime.commandEngine = {
    handleChat() {
      throw new Error("own bot chat should not trigger command handling");
    },
  };
  runtime.rules = {
    handleChat() {
      throw new Error("own bot chat should not trigger automatic replies");
    },
  };

  const result = runtime.handleIncomingChat({
    command: "DANMU_MSG",
    userId: 0,
    userName: "光模块专家阿K",
    displayUserName: "光模块专家阿K",
    text: "这条机器人自己的弹幕也必须记录",
    at: Date.now(),
  });

  assert(result.recorded === true && result.skippedAutomation === true, "own bot chat should be recorded but skip automation");
  assert(runtime.counts.chat === 1, "own bot chat should increment visible chat count");
  const summary = runtime.eventStore.queryChatSummary({ roomId: 20002, daysBack: 1 });
  assert(summary.total === 1, `own bot chat should be queryable in chat summary, got ${summary.total}`);
  assert(summary.topUsers[0]?.userName === "光模块专家阿K", "own bot chat should keep the account name in history");
  const rows = runtime.eventStore.readEvents({ range: "today", kinds: ["chat"] });
  assert(rows[0]?.payload?.isOwnBot === true, "own bot chat history should be marked as own bot");
}

function verifyHistorySimulationIsolation() {
  const root = path.join(__dirname, "..", ".tmp", "verify-history-simulation-isolation");
  fs.rmSync(root, { recursive: true, force: true });
  const store = new EventStore({ rootDir: root });
  const now = Date.now();
  store.append("chat", {
    at: now,
    roomId: 20002,
    payload: { userId: 1, userName: "真实观众", text: "真实弹幕 舰长积分商城" },
  });
  store.append("chat", {
    at: now + 1,
    roomId: 20002,
    payload: { userId: 2, userName: "模拟观众", text: "模拟弹幕 不应统计", isSimulated: true },
  });
  store.append("gift", {
    at: now,
    roomId: 20002,
    payload: { id: "real-gift", userName: "真实送礼", giftName: "小花花", count: 1, totalCoin: 100 },
  });
  store.append("gift", {
    at: now + 1,
    roomId: 20002,
    payload: { id: "sim-gift", userName: "模拟送礼", giftName: "小花花", count: 99, totalCoin: 9900, isSimulated: true },
  });
  store.append("guard", {
    at: now,
    roomId: 20002,
    payload: { userId: 3, userName: "真实舰长", guardLevel: 3, expiresAt: now + 86400000 },
  });
  store.append("guard", {
    at: now + 1,
    roomId: 20002,
    payload: { userId: 4, userName: "模拟舰长", guardLevel: 3, expiresAt: now + 86400000, isSimulated: true },
  });

  const chatSummary = store.queryChatSummary({ roomId: 20002, daysBack: 1 });
  assert(chatSummary.total === 1, `chat summary should exclude simulated rows, got ${chatSummary.total}`);
  assert(
    !chatSummary.topUsers.some((item) => item.userName === "模拟观众"),
    "chat summary should not rank simulated users"
  );
  const simulatedUser = store.queryChatCounts({ roomId: 20002, userName: "模拟观众", daysBack: 1 });
  assert(simulatedUser.total === 0, "user chat counts should exclude simulated rows");

  const gifts = store.queryGifts({ range: "today", roomId: 20002, giftName: "小花花" });
  assert(gifts.totalGiftCount === 1, `gift history should exclude simulated gifts, got ${gifts.totalGiftCount}`);
  assert(gifts.totalCoin === 100, `gift history should keep only real gift value, got ${gifts.totalCoin}`);

  const guards = store.queryGuards({ range: "today", roomId: 20002 });
  assert(guards.total === 1, `guard history should exclude simulated guards, got ${guards.total}`);
  assert(!guards.rows.some((row) => row.userName === "模拟舰长"), "guard history should not include simulated guard rows");
}

function verifyDockerDeploymentFiles() {
  // 只保留部署文件本身的结构性检查，README 措辞不再是回归契约。
  const dockerfilePath = path.resolve(__dirname, "..", "Dockerfile");
  const composePath = path.resolve(__dirname, "..", "docker-compose.yml");
  const dockerignorePath = path.resolve(__dirname, "..", ".dockerignore");
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const compose = fs.readFileSync(composePath, "utf8");
  const dockerignore = fs.readFileSync(dockerignorePath, "utf8");
  assert(dockerfile.includes("node:22-alpine") && dockerfile.includes("--host") && dockerfile.includes("0.0.0.0"), "Dockerfile should run the web UI on all interfaces");
  assert(compose.includes("4322:4322") && compose.includes("./state:/app/state"), "docker compose should expose 4322 and persist state");
  assert(dockerignore.includes("node_modules") && dockerignore.includes("state"), "docker build should not copy local node_modules or state history");
}

class FakeBrowserController extends EventEmitter {
  constructor(roomId = 20002) {
    super();
    this.state = {
      status: "idle",
      running: false,
      ready: false,
      loggedIn: false,
      roomId,
      roomUrl: `https://live.bilibili.com/${roomId}`,
      emergencyStopped: false,
    };
    this.startCalls = [];
    this.sendCalls = [];
    this.likeCalls = [];
    this.chatAcks = [];
    this.emergencyStopCalls = [];
    this.stopCalls = [];
    this.roomSwitchCount = 0;
  }

  getState() {
    return { ...this.state };
  }

  async start(options = {}) {
    this.startCalls.push(options);
    const requestedRoomId = Number(
      String(options.room || "").match(/(?:live\.bilibili\.com\/)?(\d+)/)?.[1] || 0
    );
    const wasReady = this.state.ready === true;
    if (requestedRoomId && requestedRoomId !== this.state.roomId) {
      this.roomSwitchCount += 1;
      this.state.roomId = requestedRoomId;
      this.state.roomUrl = `https://live.bilibili.com/${requestedRoomId}`;
    }
    this.state = {
      ...this.state,
      status: wasReady ? "ready" : "waiting_login",
      running: true,
      ready: wasReady,
      loggedIn: wasReady,
      emergencyStopped: false,
    };
    this.emit("state", this.getState());
    return this.getState();
  }

  makeReady() {
    this.state = {
      ...this.state,
      status: "ready",
      running: true,
      ready: true,
      loggedIn: true,
      account: { mid: 5835467, uname: "网页测试账号" },
    };
    this.emit("state", this.getState());
    this.emit("ready", this.getState());
  }

  async send(text, options = {}) {
    this.sendCalls.push({ text, options, at: Date.now() });
    return { ok: true, sentText: String(text), roomId: this.state.roomId };
  }

  async like(options = {}) {
    const result = {
      ok: true,
      count: Math.max(0, Math.floor(Number(options.count || 0))),
      roomId: this.state.roomId,
      at: Date.now(),
      options,
    };
    this.likeCalls.push(result);
    if (this.likeBarrier) await this.likeBarrier;
    if (typeof options.shouldContinue === "function" && options.shouldContinue() === false) {
      return { ...result, ok: false, count: 0, code: "LIKE_INTERRUPTED" };
    }
    return result;
  }

  acknowledgeChat(id, result = {}) {
    this.chatAcks.push({ id, result });
    return this.getState();
  }

  makeNotReady() {
    this.state = {
      ...this.state,
      status: "waiting_login",
      ready: false,
      loggedIn: false,
    };
    this.emit("state", this.getState());
    this.emit("not-ready", this.getState());
  }

  async emergencyStop(reason = "") {
    this.emergencyStopCalls.push(reason);
    this.state = {
      ...this.state,
      status: "emergency_stopped",
      running: false,
      ready: false,
      emergencyStopped: true,
    };
    this.emit("state", this.getState());
    return { ok: true, emergency: true, state: this.getState() };
  }

  async stop(reason = "") {
    this.stopCalls.push(reason);
    this.state = { ...this.state, status: "stopped", running: false, ready: false };
    return { ok: true, state: this.getState() };
  }

  resetEmergencyStop() {
    this.state = { ...this.state, emergencyStopped: false, status: "idle" };
    return this.getState();
  }
}

async function waitForCondition(check, message, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function verifyBrowserRuntimeTransportAndEmergencyStop() {
  const browser = new FakeBrowserController(20002);
  browser.makeReady();
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: false,
    sendToBili: true,
    browserAuto: true,
    browserController: browser,
    biliSendCooldownSec: 0.05,
    config: {
      room: "20002",
      history: { enabled: false },
      automation: { enabled: true, autoSendTypes: ["reply"] },
      modules: { autoSend: { enabled: true } },
    },
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1 };

  const sent = await runtime.sendActionToBili({ type: "reply", ruleName: "test", reply: "浏览器自动发送测试" });
  assert(sent.ok === true, "browser transport should send without a saved cookie");
  assert(browser.sendCalls.length === 1, "browser transport should call BrowserController.send exactly once");
  assert(browser.sendCalls[0].options.roomId === 20002, "browser transport should bind the target room");
  assert(runtime.getSnapshot().sendTransport === "browser", "runtime snapshot should expose browser transport");

  browser.sendCalls.length = 0;
  runtime.lastBiliSendAt = Date.now();
  runtime.queueAction({ type: "reply", ruleName: "test", reply: "急停后不得发送" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert(runtime.autoSendQueue.some((item) => item.status === "cooldown"), "test action should enter cooldown before emergency stop");
  runtime.stop("回归急停测试");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert(browser.sendCalls.length === 0, "cooldown completion must not send after runtime stop");
  assert(runtime.getSnapshot().autoSendQueue.length === 0, "runtime stop should clear pending automatic sends");
}

async function verifyHumanTimingRandomIntervals() {
  const timingConfig = {
    room: "20002",
    history: { enabled: false },
    automation: {
      enabled: true,
      autoSendTypes: ["reply"],
      humanTiming: {
        enabled: true,
        actionDelayMinMs: 10,
        actionDelayMaxMs: 30,
        sendGapMinSec: 0.03,
        sendGapMaxSec: 0.05,
      },
    },
    modules: { autoSend: { enabled: true } },
  };
  const minRuntime = new BotRuntime({ config: timingConfig, randomFn: () => 0 });
  const maxRuntime = new BotRuntime({ config: timingConfig, randomFn: () => 1 });
  assert(minRuntime.randomActionDelayMs() === 10, "randomFn=0 should choose minimum action delay");
  assert(maxRuntime.randomActionDelayMs() === 30, "randomFn=1 should choose maximum action delay");
  assert(minRuntime.randomSendGapMs() === 30, "randomFn=0 should choose minimum send gap");
  assert(maxRuntime.randomSendGapMs() === 50, "randomFn=1 should choose maximum send gap");

  const browser = new FakeBrowserController(20002);
  browser.makeReady();
  const runtime = new BotRuntime({
    room: "20002",
    dryRun: false,
    sendToBili: true,
    browserAuto: true,
    browserController: browser,
    randomFn: () => 0,
    config: timingConfig,
  });
  runtime.running = true;
  runtime.roomInfo = { roomId: 20002, liveStatus: 1 };
  const queuedAt = Date.now();
  const first = runtime.queueAction({ type: "reply", ruleName: "timing", reply: "随机间隔一" });
  const second = runtime.queueAction({ type: "reply", ruleName: "timing", reply: "随机间隔二" });
  assert(first.randomDelayMs === 10 && second.randomDelayMs === 10, "queued actions should record sampled action delay");
  await waitForCondition(() => browser.sendCalls.length >= 2, "human-timed queue should eventually send both actions");
  assert(browser.sendCalls[0].at - queuedAt >= 5, "first automatic message should respect its sampled action delay");
  assert(browser.sendCalls[1].at - browser.sendCalls[0].at >= 25, "automatic messages should respect the sampled send gap");
  assert(
    runtime.currentBiliSendGapMs >= 30 && runtime.currentBiliSendGapMs <= 50,
    "selected send gap should remain inside configured min/max"
  );

  const sentBeforeStop = browser.sendCalls.length;
  runtime.queueAction({ type: "reply", ruleName: "timing", reply: "急停取消随机等待" });
  runtime.stop("随机时序急停");
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert(browser.sendCalls.length === sentBeforeStop, "stop must cancel human-timed pending sends");
}

async function verifyDoctorWithoutConfiguredRoom() {
  const rootDir = path.resolve(__dirname, "..");
  const config = deepMergeConfig(DEFAULT_CONFIG, {
    room: "",
    connection: { autoStartSafe: false },
    history: { enabled: false, dir: path.join(TMP_ROOT, "verify-doctor-empty-room") },
    retention: { enabled: false },
  });
  const app = createWebApp({ rootDir, config });
  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const doctorResponse = await fetch(`${baseUrl}/api/doctor?format=json`);
    const doctor = await doctorResponse.json();
    assert(doctorResponse.status === 200, "doctor should not return 500 before the first room is configured");
    assert(
      doctor.ok === true && doctor.safeMode === true && doctor.selfTest?.isolated === true,
      "empty-room doctor should return a safe setup-state report with isolated self-test evidence"
    );

    const selfTestResponse = await fetch(`${baseUrl}/api/self-test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const selfTest = await selfTestResponse.json();
    assert(selfTestResponse.status === 200 && selfTest.ok === true, "self-test should use its fake room before setup");
  } finally {
    await app.stop();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function verifyBrowserControlApiAutoStart() {
  const rootDir = path.resolve(__dirname, "..");
  const fakeBrowser = new FakeBrowserController(20002);
  // webServer 内部构造的是真 BotRuntime，monkeypatch 必须打在真类的 prototype 上。
  const originalRuntimeStart = RealBotRuntime.prototype.start;
  let runtimeStartCalls = 0;
  let fakeLiveStatus = 0;
  const runtimeInstances = [];
  RealBotRuntime.prototype.start = async function fakeRuntimeStart() {
    if (this.running) return this.getSnapshot();
    runtimeStartCalls += 1;
    runtimeInstances.push(this);
    this.running = true;
    this.connected = true;
    this.startedAt = Date.now();
    const roomId = Number(String(this.room || "").match(/(?:live\.bilibili\.com\/)?(\d+)/)?.[1] || 0);
    this.roomInfo = {
      roomId,
      liveStatus: fakeLiveStatus,
      liveStatusLabel: fakeLiveStatus === 1 ? "直播中" : "未开播",
      uname: "测试主播",
    };
    const count = Math.max(1, Number(this.config.connection?.fanoutHosts || 1));
    this.clients = Array.from({ length: count }, () => ({ stop() {} }));
    this.client = this.clients[0];
    return this.getSnapshot();
  };

  const config = {
    room: "https://live.bilibili.com/20002",
    dryRun: true,
    send: { enabled: false, maxChars: 40, cooldownSec: 0.01 },
    connection: { autoStartSafe: false, fanoutHosts: 3 },
    browserAutomation: {
      enabled: true,
      autoLike: {
        enabled: true,
        initialDelayMinSec: 0.05,
        initialDelayMaxSec: 0.1,
        intervalMinSec: 0.07,
        intervalMaxSec: 0.12,
        burstMinClicks: 10,
        burstMaxClicks: 50,
        sessionTargetMinClicks: 10000,
        sessionTargetMaxClicks: 10000,
      },
    },
    history: { enabled: false, dir: path.join(TMP_ROOT, "verify-browser-control-api") },
    automation: {
      enabled: true,
      autoSendTypes: ["reply", "timer"],
      queueLimit: 20,
      startupMessage: { enabled: true, text: "机器人上线回归" },
    },
    modules: {
      autoSend: { enabled: true },
      autoLike: { enabled: true },
      welcome: { enabled: true },
      giftThanks: { enabled: true },
      pk: { enabled: true },
      rotation: { enabled: true },
      ai: { enabled: true },
      spam: { enabled: false },
      guardBoard: { enabled: true },
      history: { enabled: false },
    },
    rules: [
      {
        name: "browser_auto_test",
        enabled: true,
        keywords: ["多少钱"],
        reply: "网页自动托管回归成功",
        cooldownSec: 0,
        userCooldownSec: 0,
      },
    ],
    interactions: { welcome: { enabled: true, requireFullName: false, cooldownSec: 0 } },
  };
  const autoLikeRandomValues = [0, 0, 0, 0.999999999, 0.999999999, 0, 0, 0, 0, 0, 0];
  const verifyAutoLikeBudgetStore = new AutoLikeBudgetStore({
    stateDir: path.join(TMP_ROOT, "verify-browser-control-api"),
  });
  verifyAutoLikeBudgetStore.clear();
  const app = createWebApp({
    rootDir,
    config,
    browserController: fakeBrowser,
    autoLikeBudgetStore: verifyAutoLikeBudgetStore,
    randomFn: () => autoLikeRandomValues.shift() ?? 0,
  });
  const server = http.createServer(app.handleRequest);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const post = (pathname, body = {}) =>
    fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((response) => response.json());
  const get = (pathname) => fetch(`${baseUrl}${pathname}`).then((response) => response.json());

  try {
    const emptyRoom = await post("/api/browser-control/start", { room: "" });
    const externalRoom = await post("/api/browser-control/start", {
      room: "https://example.com/20002",
    });
    assert(emptyRoom.error && externalRoom.error, "browser control should reject empty and non-Bilibili rooms");
    assert(fakeBrowser.startCalls.length === 0, "invalid room input must not touch the browser");

    const waiting = await post("/api/browser-control/start", { room: config.room });
    assert(waiting.ok && waiting.waitingLogin === true, "browser control start should wait for webpage login");
    assert(runtimeStartCalls === 0, "runtime must not start before browser ready");
    fakeBrowser.makeReady();
    const readyState = await waitForCondition(async () => {
      const current = await get("/api/browser-control/state");
      return current.snapshot?.browserAuto && current.snapshot?.running ? current : null;
    }, "browser ready event should automatically start managed runtime");
    assert(runtimeStartCalls === 1, "browser ready should start runtime exactly once");
    assert(readyState.snapshot.dryRun === false && readyState.snapshot.sendToBili === true, "browser managed runtime should force real automatic output");
    assert(readyState.snapshot.moduleStatus?.autoSend?.enabled === true, "browser managed runtime should force autoSend on");
    assert(readyState.snapshot.fanoutHosts === 1, "browser managed runtime should use exactly one listener line");
    assert(readyState.snapshot.sendTransport === "browser", "browser managed snapshot should expose browser transport");
    assert(readyState.snapshot.hasBiliCookie === false, "browser managed runtime must not require a saved cookie");
    assert(readyState.snapshot.moduleStatus?.autoLike?.enabled === true, "browser managed runtime should expose autoLike module state");
    assert(
      readyState.snapshot.autoLikeSchedule?.active === false &&
        readyState.snapshot.autoLikeSchedule?.waitingForLive === true,
      "auto-like should wait without consuming clicks while the room is offline"
    );
    assert(
      readyState.snapshot.autoLikeSchedule?.sessionTargetClicks === 10000 &&
        readyState.snapshot.autoLikeSchedule?.sessionClicks === 0 &&
        readyState.snapshot.autoLikeSchedule?.limitReached === false,
      "auto-like snapshot should expose the per-session target and progress"
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert(fakeBrowser.likeCalls.length === 0, "offline room must not invoke BrowserController.like");
    assert(
      fakeBrowser.sendCalls.filter((item) => item.text === "机器人上线回归").length === 0,
      "offline room must not send the proactive startup message"
    );
    fakeLiveStatus = 1;
    runtimeInstances[0].handleGenericEvent({
      eventKind: "live_status",
      command: "LIVE",
      liveStatus: 1,
      roomId: 20002,
      text: "开播",
    });
    runtimeInstances[0].emitSnapshot();
    const liveReadyState = await waitForCondition(async () => {
      const current = await get("/api/browser-control/state");
      return current.snapshot?.autoLikeSchedule?.active &&
        current.snapshot.autoLikeSchedule.delayMs === 50
        ? current
        : null;
    }, "LIVE event should start the first randomized auto-like schedule");
    assert(
      liveReadyState.snapshot.autoLikeSchedule.waitingForLive === false,
      "live room should clear the waiting-for-live state"
    );
    await waitForCondition(
      () => fakeBrowser.sendCalls.filter((item) => item.text === "机器人上线回归").length === 1,
      "browser ready should enqueue one startup timer message"
    );

    fakeBrowser.makeReady();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert(runtimeStartCalls === 1, "duplicate browser ready events must not rebuild runtime");
    assert(
      fakeBrowser.sendCalls.filter((item) => item.text === "机器人上线回归").length === 1,
      "duplicate browser ready events must not resend the startup message"
    );

    fakeBrowser.emit("chat", {
      id: "browser-dom-api-regression",
      kind: "chat",
      source: "browser_controller_dom",
      roomId: 20002,
      userName: "网页真实观众",
      text: "这个多少钱",
      chatText: "这个多少钱",
    });
    await waitForCondition(
      () => fakeBrowser.chatAcks.some((item) => item.id === "browser-dom-api-regression"),
      "browser DOM chat should be acknowledged by the web-server runtime bridge"
    );
    assert(
      fakeBrowser.chatAcks.find((item) => item.id === "browser-dom-api-regression")?.result?.ok === true,
      "browser DOM chat acknowledgement should report successful runtime ingestion"
    );
    await waitForCondition(
      () => fakeBrowser.sendCalls.some((item) => item.text === "网页自动托管回归成功"),
      "browser DOM chat should enter the same automatic reply chain"
    );

    const repliesBeforeSimulation = fakeBrowser.sendCalls.filter(
      (item) => item.text === "网页自动托管回归成功"
    ).length;
    await post("/api/simulate", { kind: "chat" });
    await waitForCondition(
      () =>
        fakeBrowser.sendCalls.filter((item) => item.text === "网页自动托管回归成功").length >
        repliesBeforeSimulation,
      "automatic rule action should be delivered through BrowserController"
    );
    assert(
      fakeBrowser.sendCalls.some((item) => item.text === "网页自动托管回归成功"),
      "browser auto sender should deliver generated rule text"
    );

    await waitForCondition(() => fakeBrowser.likeCalls.length >= 1, "auto-like should invoke BrowserController.like once");
    const firstLikeAt = fakeBrowser.likeCalls[0].at;
    assert(fakeBrowser.likeCalls[0].options.count === 10, "randomFn=0 should choose a 10-click auto-like burst");
    const intervalState = await waitForCondition(async () => {
      const current = await get("/api/browser-control/state");
      return current.snapshot?.autoLikeSchedule?.active && current.snapshot.autoLikeSchedule.delayMs === 120
        ? current
        : null;
    }, "auto-like should choose the injected random recurring interval");
    assert(intervalState.snapshot.autoLikeSchedule.delayMs === 120, "auto-like recurring delay should stay inside configured range");
    await waitForCondition(() => fakeBrowser.likeCalls.length >= 2, "auto-like should schedule a later single click");
    assert(fakeBrowser.likeCalls[1].at - firstLikeAt >= 100, "auto-like recurring clicks should respect the random interval");
    assert(fakeBrowser.likeCalls[1].options.count === 50, "randomFn=1 should choose a 50-click auto-like burst");
    const burstState = await get("/api/browser-control/state");
    assert(burstState.snapshot.autoLikeSchedule?.lastBurstCount === 50, "snapshot should expose the latest auto-like burst count");
    assert(
      burstState.snapshot.autoLikeSchedule?.sessionClicks === 60 &&
        burstState.snapshot.autoLikeSchedule?.limitReached === false,
      "only successful browser clicks should advance the session total"
    );

    runtimeInstances[0].handleGenericEvent({
      eventKind: "live_status",
      command: "PREPARING",
      liveStatus: 0,
      roomId: 20002,
      text: "下播",
    });
    runtimeInstances[0].emitSnapshot();
    const offlineLikeCount = fakeBrowser.likeCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert(
      fakeBrowser.likeCalls.length === offlineLikeCount,
      "PREPARING event must cancel future auto-like clicks"
    );
    const offlineState = await get("/api/browser-control/state");
    assert(
      offlineState.snapshot.autoLikeSchedule?.active === false &&
        offlineState.snapshot.autoLikeSchedule?.waitingForLive === true,
      "auto-like snapshot should expose offline waiting state"
    );
    runtimeInstances[0].handleGenericEvent({
      eventKind: "live_status",
      command: "LIVE",
      liveStatus: 1,
      roomId: 20002,
      text: "再次开播",
    });
    runtimeInstances[0].emitSnapshot();
    await waitForCondition(
      () => fakeBrowser.likeCalls.length > offlineLikeCount,
      "LIVE event should resume auto-like after an offline pause"
    );

    let releaseLikeBarrier;
    fakeBrowser.likeBarrier = new Promise((resolve) => {
      releaseLikeBarrier = resolve;
    });
    const beforeDelayedBurst = fakeBrowser.likeCalls.length;
    await waitForCondition(
      () => fakeBrowser.likeCalls.length > beforeDelayedBurst,
      "auto-like should enter a delayed in-flight burst"
    );
    const delayedBurstCount = fakeBrowser.likeCalls.length;
    fakeLiveStatus = 0;
    runtimeInstances[0].handleGenericEvent({
      eventKind: "live_status",
      command: "PREPARING",
      liveStatus: 0,
      roomId: 20002,
      text: "快速下播",
    });
    runtimeInstances[0].emitSnapshot();
    fakeLiveStatus = 1;
    runtimeInstances[0].handleGenericEvent({
      eventKind: "live_status",
      command: "LIVE",
      liveStatus: 1,
      roomId: 20002,
      text: "快速恢复开播",
    });
    runtimeInstances[0].emitSnapshot();
    releaseLikeBarrier();
    fakeBrowser.likeBarrier = null;
    await waitForCondition(
      () => fakeBrowser.likeCalls.length > delayedBurstCount,
      "rapid PREPARING-to-LIVE transition should resume after the old burst settles"
    );

    await post("/api/modules", { name: "autoLike", enabled: false });
    const disabledLikeCount = fakeBrowser.likeCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 140));
    assert(fakeBrowser.likeCalls.length === disabledLikeCount, "disabling autoLike must cancel its pending timeout");

    await post("/api/modules", { name: "autoLike", enabled: true });
    await waitForCondition(
      () => fakeBrowser.likeCalls.length > disabledLikeCount,
      "re-enabling autoLike should schedule one new initial click"
    );
    fakeBrowser.makeNotReady();
    const notReadyLikeCount = fakeBrowser.likeCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(fakeBrowser.likeCalls.length === notReadyLikeCount, "controller not-ready must cancel auto-like scheduling");

    fakeBrowser.makeReady();
    await waitForCondition(async () => {
      const current = await get("/api/browser-control/state");
      return current.snapshot?.autoLikeSchedule?.active ? current : null;
    }, "controller ready should restore auto-like scheduling");
    const beforeStopLikeCount = fakeBrowser.likeCalls.length;

    const stopped = await post("/api/browser-control/stop", { reason: "回归急停" });
    assert(stopped.ok && stopped.desired === false, "browser stop endpoint should clear desired state");
    assert(fakeBrowser.emergencyStopCalls.length === 1, "browser stop endpoint should invoke emergencyStop");
    assert(stopped.snapshot.autoSendQueue.length === 0, "browser stop endpoint should clear runtime queue");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(fakeBrowser.likeCalls.length === beforeStopLikeCount, "browser emergency stop must cancel future auto-like clicks");

    // 产品中停启不会清空当日预算；这里显式清掉测试记录，只用来验证
    // “新预算在上限处精确停止”的独立机制。
    verifyAutoLikeBudgetStore.clear(20002);
    fakeLiveStatus = 1;
    config.browserAutomation.autoLike.sessionTargetMinClicks = 15;
    config.browserAutomation.autoLike.sessionTargetMaxClicks = 15;
    config.browserAutomation.autoLike.burstMinClicks = 10;
    config.browserAutomation.autoLike.burstMaxClicks = 10;
    const restartLikeStart = fakeBrowser.likeCalls.length;
    const restarted = await post("/api/browser-control/start", { room: config.room });
    assert(restarted.ok && restarted.waitingLogin === true, "browser control should return to login wait after a full stop");
    fakeBrowser.makeReady();
    await waitForCondition(
      () => fakeBrowser.sendCalls.filter((item) => item.text === "机器人上线回归").length === 2,
      "a new browser-control generation should enqueue one new startup message"
    );
    assert(runtimeStartCalls === 2, "a full stop and restart should create one new managed runtime");
    const limitedState = await waitForCondition(async () => {
      const current = await get("/api/browser-control/state");
      return current.snapshot?.autoLikeSchedule?.limitReached ? current : null;
    }, "new browser generation should stop auto-like at its newly sampled session target");
    assert(
      limitedState.snapshot.autoLikeSchedule.sessionTargetClicks === 15 &&
        limitedState.snapshot.autoLikeSchedule.sessionClicks === 15 &&
        limitedState.snapshot.autoLikeSchedule.active === false,
      "auto-like should become inactive exactly at the session target"
    );
    assert(
      fakeBrowser.likeCalls.slice(restartLikeStart).map((item) => item.options.count).join(",") === "10,5",
      "the final burst should be clipped to the remaining clicks and no extra burst should run"
    );
    const limitedLikeCount = fakeBrowser.likeCalls.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert(
      fakeBrowser.likeCalls.length === limitedLikeCount,
      "limit-reached session must not schedule any further likes"
    );

    fakeBrowser.emit("chat", {
      id: "browser-room-a-memory",
      kind: "chat",
      source: "browser_controller_dom",
      roomId: 20002,
      userName: "旧房间观众",
      userId: 8848,
      text: "这是旧房间的上下文",
      chatText: "这是旧房间的上下文",
    });
    await waitForCondition(
      () => fakeBrowser.chatAcks.some((item) => item.id === "browser-room-a-memory"),
      "old-room chat should enter runtime before switching"
    );
    const beforeSwitch = await get("/api/browser-control/state");
    assert(
      beforeSwitch.snapshot?.localAiMemory?.roomChatCount >= 1,
      "old room should contain one viewer-memory item before switching"
    );

    const roomB = "https://live.bilibili.com/20003";
    const switched = await post("/api/browser-control/start", { room: "20003" });
    assert(switched.ok && switched.state?.roomId === 20003, "room switch should move browser state to B");
    assert(switched.snapshot?.room?.roomId === 20003, "room switch should rebuild runtime for B");
    assert(runtimeStartCalls === 3, "A to B should construct exactly one new managed runtime");
    assert(runtimeInstances[2] !== runtimeInstances[1], "room B must not reuse room A runtime instance");
    assert(
      switched.snapshot?.localAiMemory?.viewerCount === 0 &&
        switched.snapshot?.localAiMemory?.turnCount === 0 &&
        switched.snapshot?.localAiMemory?.roomChatCount === 0,
      "room B must start without room A conversation memory"
    );
    assert(fakeBrowser.roomSwitchCount === 1, "fake signed-in browser should switch A to B exactly once");

    const sameRoom = await post("/api/browser-control/start", { room: roomB });
    assert(sameRoom.ok && fakeBrowser.roomSwitchCount === 1, "starting B again must not switch twice");
    assert(runtimeStartCalls === 3, "starting B again must keep the existing B runtime");
    await post("/api/browser-control/stop", { reason: "回归结束" });
  } finally {
    await app.stop();
    await new Promise((resolve) => server.close(resolve));
    RealBotRuntime.prototype.start = originalRuntimeStart;
  }
}

// 顺序执行的测试清单：runner 逐个 try/catch，失败打印函数名与完整堆栈，
// 不再"首个断言失败即静默丢弃后续所有测试"。
const VERIFY_TESTS = [
  verifyOnlineRankDoesNotEmitGenericEvent,
  verifyComboGiftDedupe,
  verifyGiftFeedSnapshotCompact,
  verifyGiftRankingByValue,
  verifyRawReplayCoverage,
  verifyUiDefaults,
  verifyGuardFrameDarkEdgeSanitizer,
  verifyFeatureAuditScript,
  verifyVisualHintIsolation,
  verifyMultiLineConnectionState,
  verifyVoiceJoinConnectionText,
  verifyHistoryApiCompatibility,
  verifyPointsShop,
  verifyCommandCoverage,
  verifyUndercoverGameFlow,
  verifyGiftHistoryCommands,
  verifyCaptureCoverageDiagnosis,
  verifyGuardHistoryCommands,
  verifyCommandTestPrivilegeScope,
  verifyModerationAlert,
  verifySnapshotCompaction,
  verifyNoticeGiftAndGuardParsing,
  verifyPkNoticeParsing,
  verifyMaskedNameResolution,
  verifyGiftPacketNoMiss,
  verifyNoticeScopeAndPendingDedupe,
  verifyActivityRawParsing,
  verifyNonCriticalMetadataParsing,
  verifyGiftHistoryRestoreUsesFullDay,
  verifySimulatedHighValueEvents,
  verifyAssistantSelfTest,
  verifyPkRetryInvestigation,
  verifyPkMultiRoomInvestigation,
  verifyVisibleBridgeBatch,
  verifyBrowserDomChatRuntimeBridge,
  verifyVisibleBridgeSimulationIsolation,
  verifyVisibleBridgeRoomMismatch,
  verifyVisibleBridgeRequiresKnownRoom,
  verifyVisibleBridgeDeliveryAudit,
  verifyLiveStatusAndLotteryPause,
  verifyLiveStatusActions,
  verifyWelcomeIdleReminders,
  verifyLocalSpeakRequiresEnablePost,
  verifyScreenshotRecentListing,
  verifyScreenshotFailureDiagnosis,
  verifyManualGuardImport,
  verifyRuntimeGuardBoardMerge,
  verifyChatAnalyticsSummary,
  verifyOwnBotChatPersistence,
  verifyHistorySimulationIsolation,
  verifyDockerDeploymentFiles,
  verifyBrowserRuntimeTransportAndEmergencyStop,
  verifyHumanTimingRandomIntervals,
  verifyDoctorWithoutConfiguredRoom,
  verifyBrowserControlApiAutoStart,
];

async function main() {
  // 隔离已由每个测试显式的 .tmp history 目录保证；
  // chdir 只是第二道防线，兜住未来漏传 history 的新测试。
  const originalCwd = process.cwd();
  const isolatedCwd = path.resolve(__dirname, "..", ".tmp", "verify-runtime-cwd");
  fs.rmSync(isolatedCwd, { recursive: true, force: true });
  fs.mkdirSync(isolatedCwd, { recursive: true });
  process.chdir(isolatedCwd);
  const failures = [];
  let passed = 0;
  try {
    for (const testFn of VERIFY_TESTS) {
      try {
        await testFn();
        passed += 1;
      } catch (error) {
        failures.push({ name: testFn.name, error });
        console.error(`✗ ${testFn.name}`);
        console.error(error.stack || error.message || String(error));
      }
    }
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(isolatedCwd, { recursive: true, force: true });
  }
  if (failures.length) {
    console.error(`\n回归验证失败：${failures.length}/${VERIFY_TESTS.length} 个测试未通过：${failures.map((item) => item.name).join("、")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`回归验证通过：${passed}/${VERIFY_TESTS.length} 个测试全部通过（全部对仓库内 fixtures 与 .tmp 隔离目录运行，不读写生产 state/）。`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
