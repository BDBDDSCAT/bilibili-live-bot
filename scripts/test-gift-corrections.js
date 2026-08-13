"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PNG } = require("pngjs");
const { applyCorrections } = require("./apply-manual-gift-corrections");
const { composeLongImage, generate, verifyAssetHashes, visibleRowRuns } = require("./generate-gift-long-image");

function localAt(day, hour = 12, minute = 0, second = 0) {
  const [year, month, date] = String(day).split("-").map(Number);
  return new Date(year, month - 1, date, hour, minute, second, 0).getTime();
}

function fillRect(image, x, y, width, height, rgba) {
  for (let yy = y; yy < y + height; yy += 1) {
    for (let xx = x; xx < x + width; xx += 1) {
      const index = (yy * image.width + xx) * 4;
      image.data[index] = rgba[0];
      image.data[index + 1] = rgba[1];
      image.data[index + 2] = rgba[2];
      image.data[index + 3] = rgba[3];
    }
  }
}

test("人工礼物校正可追溯且重复执行不会重复落盘", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-correction-"));
  const stateDir = path.join(rootDir, "state");
  const snapshotDir = path.join(stateDir, "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "giftCatalog.json"),
    JSON.stringify({
      giftCatalog: {
        items: [
          { id: 35683, giftId: 35683, name: "任意门", price: 999900, coinType: "gold", icon: "gift.png" },
        ],
      },
    })
  );
  fs.writeFileSync(
    path.join(snapshotDir, "guardCatalog.json"),
    JSON.stringify({
      guardCatalog: {
        rows: [
          { userId: 7, userName: "测试舰长", face: "face.png", guardLevel: 3, guardName: "舰长" },
        ],
      },
    })
  );
  const manifestPath = path.join(rootDir, "correction.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      roomId: 123,
      day: "2026-08-09",
      evidence: { source: "user_confirmed" },
      events: [
        {
          id: "door-1",
          at: localAt("2026-08-09"),
          userId: 7,
          userName: "测试舰长",
          giftId: 35683,
          giftName: "任意门",
          count: 1,
          guardLevel: 3,
          guardName: "舰长",
          avatarFrameUrl: "captain-event.png",
        },
      ],
      guardCorrections: [
        {
          at: localAt("2026-08-09"),
          userId: 7,
          userName: "测试舰长",
          guardLevel: 3,
          guardName: "舰长",
          avatarFrameUrl: "captain.png",
        },
      ],
    })
  );
  try {
    const first = applyCorrections({ rootDir, stateDir, filePath: manifestPath });
    const second = applyCorrections({ rootDir, stateDir, filePath: manifestPath });
    assert.deepEqual(first.applied, ["manual_verified:door-1"]);
    assert.deepEqual(second.skipped, ["manual_verified:door-1"]);
    assert.equal(first.totalGiftCount, 1);
    assert.equal(first.totalCoin, 999900);
    const lines = fs
      .readFileSync(path.join(stateDir, "events", "2026-08-09.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].payload.source, "manual_verified");
    assert.equal(lines[0].payload.giftName, "任意门");
    assert.equal(lines[0].payload.guardLevel, 3);
    assert.equal(lines[0].payload.guardName, "舰长");
    assert.equal(lines[0].payload.avatarFrameUrl, "captain-event.png");
    const manualGuards = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manualGuardBoard.json"), "utf8"));
    assert.equal(manualGuards.rows.length, 1);
    assert.equal(manualGuards.rows[0].guardName, "舰长");
    assert.equal(manualGuards.rows[0].avatarFrameUrl, "captain.png");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("用户确认的已下架活动礼物必须显式放行且使用事件级证据", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-unavailable-"));
  const stateDir = path.join(rootDir, "state");
  const snapshotDir = path.join(stateDir, "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "giftCatalog.json"),
    JSON.stringify({
      giftCatalog: {
        items: [
          {
            id: 35732,
            giftId: 35732,
            name: "护城大王",
            price: 300000,
            coinType: "gold",
            roomAvailable: false,
          },
        ],
      },
    })
  );
  fs.writeFileSync(
    path.join(snapshotDir, "guardCatalog.json"),
    JSON.stringify({
      guardCatalog: {
        rows: [
          { userId: 9, userName: "测试提督", face: "face.png", guardLevel: 2, guardName: "提督" },
        ],
      },
    })
  );
  const manifestPath = path.join(rootDir, "correction.json");
  const manifest = {
    roomId: 123,
    day: "2026-08-10",
    evidence: { source: "user_confirmed", note: "另一条记录的全局证据", identityImageSha256: "other" },
    events: [
      {
        id: "aibo-hucheng",
        at: localAt("2026-08-10", 1, 24, 57),
        userId: 9,
        userName: "测试提督",
        giftId: 35732,
        giftName: "护城大王",
        count: 1,
        guardLevel: 2,
        guardName: "提督",
        evidence: { note: "爱播活动礼物证据", identityImageSha256: "" },
      },
    ],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  try {
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /礼物不可用/);
    assert.equal(fs.existsSync(path.join(stateDir, "events", "2026-08-10.jsonl")), false);

    manifest.events[0].allowUnavailable = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const result = applyCorrections({ rootDir, stateDir, filePath: manifestPath });
    assert.deepEqual(result.applied, ["manual_verified:aibo-hucheng"]);
    assert.equal(result.totalGiftCount, 1);
    assert.equal(result.totalCoin, 300000);
    const row = JSON.parse(fs.readFileSync(path.join(stateDir, "events", "2026-08-10.jsonl"), "utf8")).payload;
    assert.equal(row.giftId, 35732);
    assert.equal(row.giftName, "护城大王");
    assert.equal(row.verification.note, "爱播活动礼物证据");
    assert.equal(row.verification.identityImageSha256, "");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("校正文件有后续错误时不会部分落盘", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-atomic-"));
  const stateDir = path.join(rootDir, "state");
  const snapshotDir = path.join(stateDir, "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "giftCatalog.json"),
    JSON.stringify({ giftCatalog: { items: [{ id: 1, name: "正确礼物", price: 100, roomAvailable: true }] } })
  );
  fs.writeFileSync(path.join(snapshotDir, "guardCatalog.json"), JSON.stringify({ guardCatalog: { rows: [] } }));
  const manifestPath = path.join(rootDir, "correction.json");
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      roomId: 123,
      day: "2026-08-09",
      events: [
        { id: "good", at: localAt("2026-08-09"), userId: 1, userName: "A", giftId: 1, giftName: "正确礼物", count: 1 },
        { id: "bad", at: localAt("2026-08-09", 12, 1), userId: 2, userName: "B", giftId: 1, giftName: "错误名称", count: 1 },
      ],
    })
  );
  try {
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /ID\/名称不匹配/);
    assert.equal(fs.existsSync(path.join(stateDir, "events", "2026-08-09.jsonl")), false);

    const invalid = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    invalid.events = [
      {
        ...invalid.events[0],
        count: "abc",
      },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(invalid));
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /count 必须是正整数/);
    assert.equal(fs.existsSync(path.join(stateDir, "events", "2026-08-09.jsonl")), false);

    invalid.events[0].count = 1;
    invalid.events[0].at = localAt("2026-08-10", 0, 1);
    fs.writeFileSync(manifestPath, JSON.stringify(invalid));
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /at 不属于 manifest\.day/);
    assert.equal(fs.existsSync(path.join(stateDir, "events", "2026-08-09.jsonl")), false);
    assert.equal(fs.existsSync(path.join(stateDir, "events", "2026-08-10.jsonl")), false);

    invalid.events[0].at = localAt("2026-08-09");
    invalid.guardCorrections = [
      { at: "abc", userId: 1, userName: "A", guardLevel: 3, guardName: "舰长" },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(invalid));
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /大航海校正 at/);
    assert.equal(fs.existsSync(path.join(stateDir, "events", "2026-08-09.jsonl")), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("已有校正详细内容变更必须显式追加修订", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-revision-"));
  const stateDir = path.join(rootDir, "state");
  const snapshotDir = path.join(stateDir, "snapshots");
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, "giftCatalog.json"),
    JSON.stringify({ giftCatalog: { items: [{ id: 1, name: "礼物", price: 100, roomAvailable: true }] } })
  );
  fs.writeFileSync(path.join(snapshotDir, "guardCatalog.json"), JSON.stringify({ guardCatalog: { rows: [] } }));
  const manifestPath = path.join(rootDir, "correction.json");
  const manifest = {
    roomId: 123,
    day: "2026-08-09",
    evidence: { source: "user_confirmed", note: "v1" },
    events: [{ id: "one", at: localAt("2026-08-09"), userId: 1, userName: "A", giftId: 1, giftName: "礼物", count: 1 }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  try {
    applyCorrections({ rootDir, stateDir, filePath: manifestPath });
    manifest.evidence.note = "v2";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /--update-existing/);
    const updated = applyCorrections({ rootDir, stateDir, filePath: manifestPath, updateExisting: true });
    assert.deepEqual(updated.updated, ["manual_verified:one"]);
    const final = applyCorrections({ rootDir, stateDir, filePath: manifestPath });
    assert.deepEqual(final.skipped, ["manual_verified:one"]);
    const lines = fs.readFileSync(path.join(stateDir, "events", "2026-08-09.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);

    manifest.events[0].count = 2;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => applyCorrections({ rootDir, stateDir, filePath: manifestPath }), /--update-existing/);
    const coreUpdated = applyCorrections({ rootDir, stateDir, filePath: manifestPath, updateExisting: true });
    assert.deepEqual(coreUpdated.updated, ["manual_verified:one"]);
    const store = new (require("../src/eventStore").EventStore)({ rootDir: stateDir });
    const rows = store.queryGiftRows({ range: "2026-08-09", roomId: 123 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].count, 2);
    assert.equal(store.queryGifts({ range: "2026-08-09", roomId: 123 }).totalGiftCount, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("长图合成会增加完整行并把指定数量徽标替换成 x1 源徽标", () => {
  const source = new PNG({ width: 520, height: 190 });
  source.data.fill(0);
  fillRect(source, 0, 5, 520, 50, [10, 20, 30, 255]);
  fillRect(source, 0, 70, 520, 50, [40, 50, 60, 255]);
  fillRect(source, 0, 135, 520, 50, [70, 80, 90, 255]);
  fillRect(source, 460, 70, 60, 48, [255, 255, 255, 255]);
  const added = new PNG({ width: 520, height: 189 });
  added.data.fill(0);
  fillRect(added, 0, 7, 520, 40, [100, 110, 120, 255]);

  assert.deepEqual(visibleRowRuns(source), [
    [5, 54],
    [70, 119],
    [135, 184],
  ]);
  const result = composeLongImage(source, [added], {
    leftPadding: 12,
    rightPadding: 8,
    badgeSourceRow: 2,
    countCorrections: [{ row: 1, count: 1 }],
  });
  assert.equal(result.output.height, 379);
  assert.equal(result.output.width, 540);
  assert.equal(result.sourceRows, 3);
  assert.equal(result.outputRows, 4);
  const correctedIndex = ((189 + 5) * result.output.width + 472) * 4;
  assert.deepEqual([...result.output.data.slice(correctedIndex, correctedIndex + 4)], [255, 255, 255, 255]);
});

test("旧长图已裁掉的头像框左缘会用原素材补回", () => {
  const source = new PNG({ width: 520, height: 60 });
  source.data.fill(0);
  fillRect(source, 0, 5, 520, 50, [10, 20, 30, 255]);
  const frame = new PNG({ width: 10, height: 10 });
  frame.data.fill(0);
  fillRect(frame, 0, 0, 2, 10, [200, 100, 50, 255]);
  const result = composeLongImage(
    source,
    [],
    {
      leftPadding: 4,
      badgeSourceRow: 1,
      avatarFrameEdgeRepairs: [{ rows: [1], x: -2, missingLeft: 2, yOffset: 0 }],
    },
    [],
    [frame]
  );
  const repairedIndex = (5 * result.output.width + 2) * 4;
  assert.deepEqual([...result.output.data.slice(repairedIndex, repairedIndex + 4)], [200, 100, 50, 255]);
  const untouchedSourceIndex = (5 * result.output.width + 4) * 4;
  assert.deepEqual([...result.output.data.slice(untouchedSourceIndex, untouchedSourceIndex + 4)], [10, 20, 30, 255]);
});

test("完整重绘拒绝 GIF、WebP 和其他非列表静态 PNG 礼物图", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-static-only-"));
  const sourcePath = path.join(rootDir, "source.png");
  const facePath = path.join(rootDir, "face.png");
  const manifestPath = path.join(rootDir, "manifest.json");
  const outputPath = path.join(rootDir, "output.png");
  const source = new PNG({ width: 520, height: 30 });
  source.data.fill(0);
  fillRect(source, 0, 5, 520, 20, [1, 2, 3, 255]);
  const face = new PNG({ width: 32, height: 32 });
  fillRect(face, 0, 0, 32, 32, [20, 30, 40, 255]);
  fs.writeFileSync(sourcePath, PNG.sync.write(source));
  fs.writeFileSync(facePath, PNG.sync.write(face));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      longImage: {
        sourcePath: "source.png",
        outputPath: "output.png",
        giftImagePolicy: "gift_catalog_img_basic_png_only",
        faceAssets: { A: { path: "face.png" } },
        giftAssets: { 礼物: { url: "https://example.com/gift.webp" } },
        fullRedrawRows: [
          { sourceRow: 1, userName: "A", giftName: "礼物", count: 1, guardLevel: 0 },
        ],
      },
    })
  );
  try {
    await assert.rejects(
      generate({ sourcePath, manifestPath, outputPath }),
      /必须使用列表 imgBasic 静态 PNG/
    );
    assert.equal(fs.existsSync(outputPath), false);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.longImage.giftAssets.礼物.url =
      "https://s1.hdslb.com/bfs/live/0123456789abcdef0123456789abcdef01234567.png";
    manifest.longImage.fullRedrawRows[0].giftIcon = "face.png";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(
      generate({ sourcePath, manifestPath, outputPath }),
      /禁止行级覆盖礼物图/
    );
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("完整重绘只落两张互斥分组图，sidecar 可证明无重复无遗漏", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-groups-"));
  const sourcePath = path.join(rootDir, "source.png");
  const facePath = path.join(rootDir, "face.png");
  const giftPath = path.join(rootDir, "gift.png");
  const manifestPath = path.join(rootDir, "manifest.json");
  const source = new PNG({ width: 520, height: 30 });
  source.data.fill(0);
  fillRect(source, 0, 5, 520, 20, [1, 2, 3, 255]);
  const asset = new PNG({ width: 32, height: 32 });
  asset.data.fill(0);
  fillRect(asset, 0, 0, 32, 32, [20, 30, 40, 255]);
  fs.writeFileSync(sourcePath, PNG.sync.write(source));
  fs.writeFileSync(facePath, PNG.sync.write(asset));
  fs.writeFileSync(giftPath, PNG.sync.write(asset));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      longImage: {
        sourcePath: "source.png",
        outputPath: "combined.png",
        writeCombined: false,
        faceAssets: { A: { path: "face.png" }, B: { path: "face.png" } },
        giftAssets: { 礼物: { path: "gift.png", price: 100 } },
        fullRedrawRows: [
          { sourceRow: 1, userName: "A", giftName: "礼物", count: 1, guardLevel: 0 },
          { sourceRow: 0, userName: "B", giftName: "礼物", count: 2, guardLevel: 0 },
        ],
        outputGroupsMustPartition: true,
        outputGroups: [
          { id: "a", outputPath: "a.png", userNames: ["A"] },
          { id: "other", outputPath: "other.png", excludeUserNames: ["A"] },
        ],
      },
    })
  );
  try {
    const result = await generate({ manifestPath });
    assert.equal(result.combinedOutputWritten, false);
    assert.equal(fs.existsSync(path.join(rootDir, "combined.png")), false);
    assert.equal(result.groups.length, 2);
    assert.deepEqual(result.groups.map((group) => group.outputRows), [1, 1]);
    const first = JSON.parse(fs.readFileSync(path.join(rootDir, "a.png.json"), "utf8"));
    const second = JSON.parse(fs.readFileSync(path.join(rootDir, "other.png.json"), "utf8"));
    assert.equal(first.partitionRows, 2);
    assert.equal(second.partitionRows, 2);
    assert.deepEqual(first.rowSummary.map((row) => [row.manifestRow, row.outputRow]), [[1, 1]]);
    assert.deepEqual(second.rowSummary.map((row) => [row.manifestRow, row.outputRow]), [[2, 1]]);
    assert.equal(fs.existsSync(path.join(rootDir, "a.png")), true);
    assert.equal(fs.existsSync(path.join(rootDir, "other.png")), true);

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.longImage.outputGroups[1] = {
      id: "overlap",
      outputPath: "overlap.png",
      userNames: ["A"],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(generate({ manifestPath }), /一次性分区/);
    assert.equal(fs.existsSync(path.join(rootDir, "overlap.png")), false);

    const explicitOutput = path.join(rootDir, "explicit.png");
    const explicit = await generate({ manifestPath, outputPath: explicitOutput });
    assert.equal(explicit.combinedOutputWritten, true);
    assert.equal(explicit.groups.length, 0);
    assert.equal(fs.existsSync(explicitOutput), true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("长图导出拒绝覆盖原图", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-overwrite-"));
  const sourcePath = path.join(rootDir, "source.png");
  const manifestPath = path.join(rootDir, "manifest.json");
  const image = new PNG({ width: 520, height: 20 });
  image.data.fill(0);
  fillRect(image, 0, 2, 520, 10, [1, 2, 3, 255]);
  fs.writeFileSync(sourcePath, PNG.sync.write(image));
  fs.writeFileSync(manifestPath, JSON.stringify({ longImage: { badgeSourceRow: 1 } }));
  try {
    await assert.rejects(
      generate({ sourcePath, manifestPath, outputPath: sourcePath }),
      /不能覆盖原长图/
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("长图生成素材会校验 SHA-256", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-gift-assets-"));
  const filePath = path.join(rootDir, "asset.bin");
  fs.writeFileSync(filePath, "asset");
  try {
    verifyAssetHashes(
      { "asset.bin": "d59386e0ae435e292fbe0ebcdb954b75ed5fb3922091277cb19f798fc5d50718" },
      rootDir
    );
    assert.throws(() => verifyAssetHashes({ "asset.bin": "bad" }, rootDir), /SHA-256/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
