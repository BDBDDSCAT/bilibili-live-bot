#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { EventStore, dayKey, summarizeGifts } = require("../src/eventStore");
const { formatBattery } = require("../src/interactionEngine");

function parseArgs(argv = []) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) result[key] = true;
    else {
      result[key] = value;
      index += 1;
    }
  }
  return result;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function findGift(items = [], correction = {}) {
  const giftId = Number(correction.giftId || 0);
  const giftName = String(correction.giftName || "").trim();
  const allowUnavailable = correction.allowUnavailable === true;
  if (allowUnavailable && (!giftId || !giftName)) {
    throw new Error("补录已下架活动礼物时必须同时提供 giftId 和 giftName");
  }
  const usable = (item) =>
    item &&
    (item.roomAvailable !== false || allowUnavailable) &&
    Number.isFinite(Number(item.price)) &&
    Number(item.price) > 0;
  if (giftId) {
    const gift = items.find((item) => Number(item.giftId || item.id || 0) === giftId);
    if (!gift) throw new Error(`礼物目录里找不到 ID ${giftId}`);
    if (giftName && String(gift.name || "") !== giftName) {
      throw new Error(`礼物 ID/名称不匹配：${giftId} 实际是「${gift.name || ""}」，不是「${giftName}」`);
    }
    if (!usable(gift)) throw new Error(`礼物不可用或价格无效：${gift.name || giftId}`);
    return gift;
  }
  const matches = items.filter((item) => String(item.name || "") === giftName && usable(item));
  if (matches.length !== 1) {
    throw new Error(matches.length ? `礼物名称不唯一，请同时提供 giftId：${giftName}` : `礼物目录里找不到：${giftName}`);
  }
  return matches[0];
}

function findGuard(items = [], correction = {}) {
  const userId = Number(correction.userId || 0);
  const userName = String(correction.userName || "").trim();
  const byId = userId ? items.find((item) => Number(item.userId || 0) === userId) : null;
  const byName = userName ? items.find((item) => String(item.userName || "") === userName) : null;
  if (byId && userName && String(byId.userName || "") !== userName) {
    throw new Error(`用户 ID/昵称不匹配：${userId} 实际是「${byId.userName || ""}」，不是「${userName}」`);
  }
  if (byName && userId && Number(byName.userId || 0) !== userId) {
    throw new Error(`用户昵称/ID 不匹配：${userName}`);
  }
  return byId || byName || {};
}

function sameCoreGift(left = {}, right = {}) {
  return (
    String(left.id || "") === String(right.id || "") &&
    Number(left.userId || 0) === Number(right.userId || 0) &&
    String(left.userName || "") === String(right.userName || "") &&
    Number(left.giftId || 0) === Number(right.giftId || 0) &&
    String(left.giftName || "") === String(right.giftName || "") &&
    Number(left.count || 0) === Number(right.count || 0)
  );
}

function canonicalGift(value = {}) {
  return {
    id: String(value.id || ""),
    at: Number(value.at || 0),
    userId: Number(value.userId || 0),
    userName: String(value.userName || ""),
    displayUserName: String(value.displayUserName || ""),
    face: String(value.face || ""),
    faceSource: String(value.faceSource || ""),
    action: String(value.action || ""),
    giftId: Number(value.giftId || 0),
    giftName: String(value.giftName || ""),
    giftIcon: String(value.giftIcon || ""),
    resultGiftPrice: Number(value.resultGiftPrice || 0),
    outputTotalCoin: Number(value.outputTotalCoin || 0),
    profitCoin: Number(value.profitCoin || 0),
    count: Number(value.count || 0),
    totalCoin: Number(value.totalCoin || 0),
    valueText: String(value.valueText || ""),
    coinType: String(value.coinType || ""),
    medalName: String(value.medalName || ""),
    medalLevel: Number(value.medalLevel || 0),
    guardLevel: Number(value.guardLevel || 0),
    guardName: String(value.guardName || ""),
    guardIcon: String(value.guardIcon || ""),
    avatarFrameUrl: String(value.avatarFrameUrl || value.avatarFrame?.url || ""),
    avatarFrameName: String(value.avatarFrameName || value.avatarFrame?.name || ""),
    source: String(value.source || ""),
    sourceCommand: String(value.sourceCommand || ""),
    isSimulated: Boolean(value.isSimulated),
    manualVerified: Boolean(value.manualVerified),
    verification: value.verification || {},
  };
}

function sameCanonicalGift(left = {}, right = {}) {
  return JSON.stringify(canonicalGift(left)) === JSON.stringify(canonicalGift(right));
}

function validateEventShape(correction = {}, day = "", label = "礼物校正") {
  const at = Number(correction.at);
  if (!Number.isInteger(at) || at <= 0) throw new Error(`${label} at 必须是有效毫秒时间戳`);
  if (dayKey(at) !== day) throw new Error(`${label} at 不属于 manifest.day ${day}`);
  if (label === "礼物校正") {
    const count = correction.count === undefined ? 1 : Number(correction.count);
    if (!Number.isInteger(count) || count <= 0) throw new Error("礼物校正 count 必须是正整数");
  }
}

function isTrustedGift(value = {}) {
  return value.needsVisualCheck !== true && String(value.source || "") !== "danmu_gift_fallback";
}

function buildManualGift(correction = {}, context = {}) {
  validateEventShape(correction, context.day, "礼物校正");
  const gift = findGift(context.gifts, correction);
  if (!gift) throw new Error(`礼物目录里找不到：${correction.giftName || correction.giftId}`);
  const guard = findGuard(context.guards, correction);
  const count = correction.count === undefined ? 1 : Number(correction.count);
  const price = Number(gift.price || 0);
  const totalCoin = price * count;
  const correctionGuardLevel = Number(correction.guardLevel || 0);
  const correctionGuardName = String(correction.guardName || "").trim();
  if (correctionGuardLevel) {
    const expectedGuardName = correctionGuardLevel === 1 ? "总督" : correctionGuardLevel === 2 ? "提督" : correctionGuardLevel === 3 ? "舰长" : "";
    if (!expectedGuardName || (correctionGuardName && correctionGuardName !== expectedGuardName)) {
      throw new Error(`礼物校正大航海等级/名称不匹配：${correction.userName || correction.userId}`);
    }
  }
  const id = `manual_verified:${String(correction.id || "").trim()}`;
  if (id === "manual_verified:") throw new Error("人工礼物校正缺少稳定 id");
  const evidence = {
    ...(context.evidence || {}),
    ...(correction.evidence || {}),
  };
  return {
    id,
    at: Number(correction.at || Date.now()),
    userId: Number(correction.userId || guard.userId || 0),
    userName: String(correction.userName || guard.userName || "").trim(),
    displayUserName: String(correction.userName || guard.userName || "").trim(),
    face: correction.face || guard.face || "",
    faceSource: "manual_verified",
    action: "投喂",
    giftId: Number(gift.giftId || gift.id || 0),
    giftName: gift.name,
    giftIcon: gift.icon || gift.webp || gift.imgBasic || "",
    sourceGiftId: 0,
    sourceGiftName: "",
    sourceGiftPrice: 0,
    resultGiftPrice: price,
    inputTotalCoin: 0,
    outputTotalCoin: totalCoin,
    profitCoin: totalCoin,
    blindGift: null,
    count,
    totalCoin,
    valueText: formatBattery(totalCoin) || "0电池",
    coinType: gift.coinType || "gold",
    medalName: guard.medalName || "",
    medalLevel: Number(guard.medalLevel || 0),
    guardLevel: correctionGuardLevel || Number(guard.guardLevel || 0),
    guardName: correctionGuardName || guard.guardName || "",
    guardIcon: correction.guardIcon || guard.guardIcon || "",
    avatarFrame: correction.avatarFrameUrl
      ? {
          url: String(correction.avatarFrameUrl),
          name: String(correction.guardName || guard.guardName || ""),
          source: "manual_user_confirmed",
        }
      : guard.avatarFrame || null,
    avatarFrameUrl: correction.avatarFrameUrl || guard.avatarFrameUrl || "",
    avatarFrameName: correction.guardName || guard.avatarFrameName || "",
    source: "manual_verified",
    sourceCommand: "USER_CONFIRMED_CORRECTION",
    isSimulated: false,
    manualVerified: true,
    verification: {
      source: evidence.source || "user_confirmed",
      note: evidence.note || "",
      longImageSha256: evidence.longImageSha256 || "",
      identityImageSha256: evidence.identityImageSha256 || "",
      guardFrameEvidenceSha256: evidence.guardFrameEvidenceSha256 || "",
    },
  };
}

function buildManualGuard(correction = {}, context = {}) {
  validateEventShape(correction, context.day, "大航海校正");
  const catalogGuard = findGuard(context.guards, correction);
  const guardLevel = Number(correction.guardLevel || 0);
  const guardName = String(correction.guardName || "").trim();
  if (![1, 2, 3].includes(guardLevel)) throw new Error(`大航海校正等级无效：${correction.userName || correction.userId}`);
  const expectedName = guardLevel === 1 ? "总督" : guardLevel === 2 ? "提督" : "舰长";
  if (guardName && guardName !== expectedName) {
    throw new Error(`大航海等级/名称不匹配：${correction.userName || correction.userId}`);
  }
  return {
    ...catalogGuard,
    ...correction,
    roomId: Number(context.roomId || 0),
    userId: Number(correction.userId || catalogGuard.userId || 0),
    userName: String(correction.userName || catalogGuard.userName || "").trim(),
    guardLevel,
    guardName: expectedName,
    avatarFrameUrl: String(correction.avatarFrameUrl || ""),
    avatarFrame: correction.avatarFrameUrl
      ? { url: String(correction.avatarFrameUrl), name: expectedName, source: "manual_user_confirmed" }
      : catalogGuard.avatarFrame || null,
    avatarFrameName: expectedName,
    avatarFrameSource: "manual_user_confirmed",
    source: "manual_guard_user_confirmed",
    verification: context.evidence || {},
  };
}

function applyCorrections(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.join(__dirname, ".."));
  const stateDir = path.resolve(options.stateDir || path.join(rootDir, "state"));
  const filePath = path.resolve(options.filePath || "");
  if (!filePath || !fs.existsSync(filePath)) throw new Error("请通过 --file 提供校正 JSON");
  const manifest = readJson(filePath);
  const roomId = Number(manifest.roomId || 0);
  const day = String(manifest.day || "").trim();
  if (!roomId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("校正 JSON 缺少有效 roomId/day");

  const giftCatalog = readJson(path.join(stateDir, "snapshots", "giftCatalog.json"));
  const guardCatalog = readJson(path.join(stateDir, "snapshots", "guardCatalog.json"));
  const gifts = giftCatalog.giftCatalog?.items || [];
  const guards = guardCatalog.guardCatalog?.rows || [];
  const store = new EventStore({ rootDir: stateDir });
  const existingRows = store.queryGiftRows({ range: day, roomId });
  const applied = [];
  const updated = [];
  const skipped = [];
  const pending = [];
  const seenIds = new Set();
  const pendingGuards = (manifest.guardCorrections || []).map((correction) =>
    buildManualGuard(correction, { guards, roomId, day, evidence: manifest.evidence || {} })
  );

  for (const correction of manifest.events || []) {
    const row = buildManualGift(correction, { gifts, guards, day, evidence: manifest.evidence || {} });
    if (seenIds.has(row.id)) throw new Error(`校正文件里的 id 重复：${row.id}`);
    seenIds.add(row.id);
    const existing = existingRows.find((item) => String(item.id || "") === row.id);
    if (existing) {
      if (sameCanonicalGift(existing, row)) {
        skipped.push(row.id);
        continue;
      }
      if (!options.updateExisting) {
        const change = sameCoreGift(existing, row) ? "详细内容" : "用户/礼物核心内容";
        throw new Error(`校正 id 已存在但${change}已变更：${row.id}（确认后使用 --update-existing 追加修订）`);
      }
      pending.push({
        ...row,
        manualRevision: Math.max(1, Number(existing.manualRevision || 1)) + 1,
        revisionOf: row.id,
      });
      updated.push(row.id);
      continue;
    }
    pending.push(row);
    applied.push(row.id);
  }

  store.appendMany(
    "gift",
    pending.map((row) => ({ at: row.at, roomId, payload: row }))
  );

  const summary = summarizeGifts(store.queryGiftRows({ range: day, roomId }).filter(isTrustedGift));
  store.writeSnapshot("giftHistorySummary", { giftHistorySummary: summary });
  store.writeSnapshot("manualGiftCorrections", {
    roomId,
    day,
    sourceFile: path.relative(rootDir, filePath),
    evidence: manifest.evidence || {},
    ids: (manifest.events || []).map((item) => `manual_verified:${item.id}`),
  });
  const guardResult = pendingGuards.length
    ? store.importManualGuards({
        roomId,
        now: Math.max(...pendingGuards.map((item) => Number(item.at || 0)), Date.now()),
        rows: pendingGuards,
      })
    : { imported: 0, total: store.queryManualGuards({ roomId }).total || 0 };
  return {
    ok: true,
    roomId,
    day,
    applied,
    updated,
    skipped,
    guardsUpdated: guardResult.imported,
    manualGuardTotal: guardResult.total,
    totalGiftCount: summary.totalGiftCount,
    totalCoin: summary.totalCoin,
    totalValueText: summary.totalValueText,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, "..");
  const result = applyCorrections({
    rootDir,
    filePath: args.file,
    stateDir: args.state,
    updateExisting: Boolean(args["update-existing"]),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  }
}

module.exports = {
  applyCorrections,
  buildManualGuard,
  buildManualGift,
  canonicalGift,
  findGift,
  findGuard,
  isTrustedGift,
  parseArgs,
  sameCanonicalGift,
  sameCoreGift,
  validateEventShape,
};
