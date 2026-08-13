#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { PNG } = require("pngjs");

const OUTPUT_WIDTH = 520;
const ROW_SLOT_HEIGHT = 189;
const COUNT_BADGE = { x: 460, width: 60, height: 48 };
const REDRAW_WIDTH = 520;
const REDRAW_ROW_HEIGHT = 189;

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

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function verifyAssetHashes(entries = {}, baseDir = process.cwd()) {
  for (const [relativePath, expected] of Object.entries(entries || {})) {
    const filePath = path.resolve(baseDir, relativePath);
    if (!fs.existsSync(filePath)) throw new Error(`生成素材不存在：${filePath}`);
    const actual = sha256Buffer(fs.readFileSync(filePath));
    if (actual !== String(expected || "")) {
      throw new Error(`生成素材 SHA-256 不匹配：${relativePath}`);
    }
  }
}

function visibleRowRuns(image, threshold = 8) {
  const runs = [];
  let start = -1;
  for (let y = 0; y < image.height; y += 1) {
    let visible = false;
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] > threshold) {
        visible = true;
        break;
      }
    }
    if (visible && start < 0) start = y;
    if (!visible && start >= 0) {
      runs.push([start, y - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, image.height - 1]);
  return runs;
}

function copyRect(source, target, sourceRect, targetPoint = {}) {
  const sourceX = Number(sourceRect.x || 0);
  const sourceY = Number(sourceRect.y || 0);
  const width = Number(sourceRect.width || 0);
  const height = Number(sourceRect.height || 0);
  const targetX = Number(targetPoint.x || 0);
  const targetY = Number(targetPoint.y || 0);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = sourceX + x;
      const sy = sourceY + y;
      const tx = targetX + x;
      const ty = targetY + y;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const sourceIndex = (sy * source.width + sx) * 4;
      const targetIndex = (ty * target.width + tx) * 4;
      source.data.copy(target.data, targetIndex, sourceIndex, sourceIndex + 4);
    }
  }
}

function cropPng(source, sourceRect = {}) {
  const width = Math.max(1, Number(sourceRect.width || 1));
  const height = Math.max(1, Number(sourceRect.height || 1));
  const target = new PNG({ width, height });
  target.data.fill(0);
  copyRect(source, target, sourceRect, { x: 0, y: 0 });
  return target;
}

function pngDataUrl(image) {
  return `data:image/png;base64,${PNG.sync.write(image).toString("base64")}`;
}

function resizePng(source, width, height) {
  const target = new PNG({ width, height });
  target.data.fill(0);
  const xScale = source.width / width;
  const yScale = source.height / height;
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, Math.max(0, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const yWeight = sourceY - y0;
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, Math.max(0, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const xWeight = sourceX - x0;
      const targetIndex = (y * width + x) * 4;
      const sample = (xx, yy) => {
        const index = (yy * source.width + xx) * 4;
        const alpha = source.data[index + 3] / 255;
        return [
          source.data[index] * alpha,
          source.data[index + 1] * alpha,
          source.data[index + 2] * alpha,
          source.data[index + 3],
        ];
      };
      const samples = [sample(x0, y0), sample(x1, y0), sample(x0, y1), sample(x1, y1)];
      const interpolate = (channel) => {
        const top = samples[0][channel] + (samples[1][channel] - samples[0][channel]) * xWeight;
        const bottom = samples[2][channel] + (samples[3][channel] - samples[2][channel]) * xWeight;
        return top + (bottom - top) * yWeight;
      };
      const alpha = interpolate(3);
      for (let channel = 0; channel < 3; channel += 1) {
        target.data[targetIndex + channel] = alpha > 0 ? Math.round(interpolate(channel) / (alpha / 255)) : 0;
      }
      target.data[targetIndex + 3] = Math.round(alpha);
    }
  }
  return target;
}

function compositePng(source, target, targetPoint = {}) {
  return compositePngRect(
    source,
    target,
    { x: 0, y: 0, width: source.width, height: source.height },
    targetPoint
  );
}

function compositePngRect(source, target, sourceRect = {}, targetPoint = {}) {
  const targetX = Number(targetPoint.x || 0);
  const targetY = Number(targetPoint.y || 0);
  const sourceX = Number(sourceRect.x || 0);
  const sourceY = Number(sourceRect.y || 0);
  const width = Math.max(0, Number(sourceRect.width || 0));
  const height = Math.max(0, Number(sourceRect.height || 0));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const sx = sourceX + x;
      const sy = sourceY + y;
      const tx = targetX + x;
      const ty = targetY + y;
      if (sx < 0 || sy < 0 || sx >= source.width || sy >= source.height) continue;
      if (tx < 0 || ty < 0 || tx >= target.width || ty >= target.height) continue;
      const sourceIndex = (sy * source.width + sx) * 4;
      const targetIndex = (ty * target.width + tx) * 4;
      const sourceAlpha = source.data[sourceIndex + 3] / 255;
      if (sourceAlpha <= 0) continue;
      const targetAlpha = target.data[targetIndex + 3] / 255;
      const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
      for (let channel = 0; channel < 3; channel += 1) {
        const sourceValue = source.data[sourceIndex + channel] / 255;
        const targetValue = target.data[targetIndex + channel] / 255;
        const outputValue = outputAlpha
          ? (sourceValue * sourceAlpha + targetValue * targetAlpha * (1 - sourceAlpha)) / outputAlpha
          : 0;
        target.data[targetIndex + channel] = Math.round(outputValue * 255);
      }
      target.data[targetIndex + 3] = Math.round(outputAlpha * 255);
    }
  }
}

function imageDataUrl(source = "", baseDir = process.cwd()) {
  const value = String(source || "");
  if (/^(?:data:|https?:)/i.test(value)) return value;
  const filePath = path.resolve(baseDir, value);
  if (!fs.existsSync(filePath)) throw new Error(`图像素材不存在：${filePath}`);
  const extension = path.extname(filePath).toLowerCase();
  const mime =
    extension === ".png"
      ? "image/png"
      : extension === ".webp"
        ? "image/webp"
        : extension === ".svg"
          ? "image/svg+xml"
          : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(filePath).toString("base64")}`;
}

async function loadPngSource(source = "", baseDir = process.cwd()) {
  const value = String(source || "");
  if (!/^https?:/i.test(value)) {
    const filePath = path.resolve(baseDir, value);
    if (!fs.existsSync(filePath)) throw new Error(`头像框素材不存在：${filePath}`);
    return PNG.sync.read(fs.readFileSync(filePath));
  }
  const response = await fetch(value, {
    headers: {
      Referer: "https://live.bilibili.com/",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125 Safari/537.36",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`头像框下载失败：HTTP ${response.status}`);
  return PNG.sync.read(Buffer.from(await response.arrayBuffer()));
}

function resolveChromeExecutable(preferred = "") {
  const candidates = [
    preferred,
    typeof chromium.executablePath === "function" ? chromium.executablePath() : "",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function rowHtml(row = {}) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${OUTPUT_WIDTH}px;height:${ROW_SLOT_HEIGHT}px;background:transparent;overflow:hidden}
.slot{position:relative;width:${OUTPUT_WIDTH}px;height:${ROW_SLOT_HEIGHT}px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.shell,.card{position:absolute;clip-path:polygon(0 0,93% 0,100% 50%,93% 100%,0 100%)}
.shell{left:46px;top:17px;width:468px;height:136px;background:linear-gradient(90deg,#e8fbff 0%,#fff 55%,#d8f7ff 100%);filter:drop-shadow(0 1px 2px rgba(0,49,130,.45))}
.card{inset:3px;background:linear-gradient(105deg,rgba(119,105,247,.95) 0%,rgba(92,132,247,.94) 48%,rgba(61,174,255,.92) 100%);box-shadow:inset 0 3px 0 rgba(255,255,255,.55),inset 0 -3px 0 rgba(0,78,221,.45)}
.shine{position:absolute;left:55px;top:25px;width:430px;height:3px;background:linear-gradient(90deg,rgba(255,255,255,.55),rgba(255,255,255,.1),rgba(255,255,255,.65));z-index:2}
.face{position:absolute;left:24px;top:28px;width:104px;height:104px;border-radius:50%;object-fit:cover;background:#d7e8f7;z-index:3}
.frame{position:absolute;left:0;top:5px;width:151px;height:151px;object-fit:contain;z-index:4}
.name{position:absolute;left:${Number(row.textLeft || 148)}px;top:48px;max-width:238px;color:#fff;font-size:29px;font-weight:600;line-height:34px;letter-spacing:.2px;text-shadow:0 2px 2px rgba(25,54,150,.62);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:5}
.action{position:absolute;left:${Number(row.textLeft || 148)}px;top:89px;max-width:238px;color:#fff;font-size:22px;font-weight:600;line-height:28px;text-shadow:0 2px 2px rgba(25,54,150,.58);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:5}
.gift{position:absolute;left:397px;top:32px;width:105px;height:105px;object-fit:contain;filter:drop-shadow(0 2px 2px rgba(0,48,128,.35));z-index:5}
.count{position:absolute;right:5px;top:0;min-width:54px;height:42px;padding:0 11px;border-radius:21px;background:#fff;color:#7157f5;font-size:27px;font-weight:700;line-height:42px;text-align:center;box-shadow:0 1px 1px rgba(30,54,145,.14);z-index:8}
</style></head><body><div class="slot">
  <div class="shell"><div class="card"></div></div><div class="shine"></div>
  <img class="face" src="${escapeHtml(row.face)}" alt=""><img class="frame" src="${escapeHtml(row.avatarFrameUrl)}" alt="">
  <div class="name">${escapeHtml(row.userName)}</div><div class="action">送出 ${escapeHtml(row.giftName)}</div>
  <img class="gift" src="${escapeHtml(row.giftIcon)}" alt=""><div class="count">x${Number(row.count || 1)}</div>
</div></body></html>`;
}

function redrawTheme(price = 0) {
  const value = Number(price || 0);
  if (value >= 900000) return "gold";
  if (value >= 90000) return "rose";
  if (value >= 9000) return "violet";
  return "blue";
}

function redrawRowHtml(row = {}) {
  const theme = ["gold", "rose", "violet", "blue"].includes(row.theme)
    ? row.theme
    : redrawTheme(row.price);
  const frameHtml = row.avatarFrameUrl
    ? `<img class="frame" src="${escapeHtml(row.avatarFrameUrl)}" alt="">`
    : "";
  const guardClass = row.avatarFrameUrl ? ` has-frame guard-${Number(row.guardLevel || 0)}` : "";
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:${REDRAW_WIDTH}px;height:${REDRAW_ROW_HEIGHT}px;background:transparent;overflow:hidden}
.slot{position:relative;width:${REDRAW_WIDTH}px;height:${REDRAW_ROW_HEIGHT}px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
.shell{position:absolute;left:92px;top:34px;width:424px;height:123px;clip-path:polygon(0 0,91% 0,100% 50%,91% 100%,0 100%);padding:3px;background:rgba(255,255,255,.96);filter:drop-shadow(0 2px 3px rgba(55,65,90,.18))}
.card{width:100%;height:100%;clip-path:inherit;position:relative;overflow:hidden}
.card:before{content:"";position:absolute;inset:0;background:linear-gradient(110deg,rgba(255,255,255,.14),transparent 42%,rgba(255,255,255,.22));pointer-events:none}
.card.blue{background:linear-gradient(90deg,#568ddd 0%,#76b5ef 55%,#a8dbf7 100%)}
.card.violet{background:linear-gradient(90deg,#7567c9 0%,#9d82dd 55%,#c7b4ec 100%)}
.card.rose{background:linear-gradient(90deg,#c65a8e 0%,#e583a9 55%,#f3b5c9 100%)}
.card.gold{background:linear-gradient(90deg,#efa22a 0%,#f6c55e 55%,#ffe5a0 100%)}
.shine{position:absolute;left:102px;top:41px;width:373px;height:3px;border-radius:2px;background:linear-gradient(90deg,rgba(255,255,255,.62),rgba(255,255,255,.12),rgba(255,255,255,.52));z-index:2}
.face{position:absolute;left:24px;top:28px;width:136px;height:136px;border-radius:50%;object-fit:cover;background:#d7e8f7;border:4px solid #4f91db;box-shadow:0 2px 4px rgba(31,57,126,.28);z-index:3}
.slot.violet .face{border-color:#7666c5}.slot.rose .face{border-color:#c85889}.slot.gold .face{border-color:#e89a20}
.frame{position:absolute;left:0;top:4px;width:184px;height:184px;object-fit:contain;z-index:4}
.name{position:absolute;left:172px;top:55px;width:218px;color:#fff;font-size:25px;font-weight:700;line-height:31px;letter-spacing:.1px;text-shadow:0 2px 3px rgba(80,61,44,.48);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:5}
.action{position:absolute;left:172px;top:94px;width:218px;color:rgba(255,255,255,.97);font-size:20px;font-weight:650;line-height:27px;text-shadow:0 2px 3px rgba(80,61,44,.44);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;z-index:5}
.gift{position:absolute;left:399px;top:38px;width:112px;height:112px;object-fit:contain;filter:drop-shadow(0 2px 2px rgba(61,52,65,.2));z-index:5}
.count{position:absolute;right:0;top:0;min-width:56px;height:43px;padding:0 11px;border-radius:22px;background:#fff;color:#5b8fd7;font-size:24px;font-weight:800;line-height:43px;text-align:center;box-shadow:0 1px 3px rgba(30,54,145,.12);z-index:8}
.slot.violet .count{color:#7764c6}.slot.rose .count{color:#c85889}.slot.gold .count{color:#df921c}
.has-frame .face{border-color:transparent;box-shadow:none}.has-frame .name,.has-frame .action{left:184px;width:206px}
</style></head><body><div class="slot ${theme}${guardClass}">
  <div class="shell"><div class="card ${theme}"></div></div><div class="shine"></div>
  <img class="face" src="${escapeHtml(row.face)}" alt="">${frameHtml}
  <div class="name">${escapeHtml(row.userName)}</div><div class="action">送出 ${escapeHtml(row.giftName)}</div>
  <img class="gift" src="${escapeHtml(row.giftIcon)}" alt=""><div class="count">x${Number(row.count || 1)}</div>
</div></body></html>`;
}

async function renderRows(rows = [], options = {}) {
  if (!rows.length) return [];
  const executablePath = resolveChromeExecutable(options.chromeExecutable);
  if (!executablePath) throw new Error("未找到可用于生成长图的 Chrome/Chromium");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-background-networking", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: OUTPUT_WIDTH, height: ROW_SLOT_HEIGHT },
      deviceScaleFactor: 1,
    });
    const images = [];
    for (const row of rows) {
      await page.setContent(rowHtml(row), { waitUntil: "load" });
      await page.waitForFunction(
        () => [...document.images].every((image) => image.complete && image.naturalWidth > 0),
        null,
        { timeout: 20000 }
      );
      images.push(PNG.sync.read(await page.screenshot({ omitBackground: true, type: "png" })));
    }
    return images;
  } finally {
    await browser.close();
  }
}

async function renderRedrawRows(rows = [], options = {}) {
  if (!rows.length) return [];
  const executablePath = resolveChromeExecutable(options.chromeExecutable);
  if (!executablePath) throw new Error("未找到可用于生成长图的 Chrome/Chromium");
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ["--disable-background-networking", "--hide-scrollbars"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: REDRAW_WIDTH, height: REDRAW_ROW_HEIGHT },
      deviceScaleFactor: 1,
    });
    const images = [];
    for (const row of rows) {
      await page.setContent(redrawRowHtml(row), { waitUntil: "load" });
      await page.waitForFunction(
        () => [...document.images].every((image) => image.complete && image.naturalWidth > 0),
        null,
        { timeout: 20000 }
      );
      images.push(PNG.sync.read(await page.screenshot({ omitBackground: true, type: "png" })));
    }
    return images;
  } finally {
    await browser.close();
  }
}

function stackRenderedRows(rows = []) {
  if (!rows.length) throw new Error("完整重绘至少需要一条记录");
  const output = new PNG({ width: REDRAW_WIDTH, height: rows.length * REDRAW_ROW_HEIGHT });
  output.data.fill(0);
  rows.forEach((row, index) => {
    if (row.width !== REDRAW_WIDTH || row.height !== REDRAW_ROW_HEIGHT) {
      throw new Error(`重绘行尺寸错误：${row.width}x${row.height}`);
    }
    copyRect(
      row,
      output,
      { x: 0, y: 0, width: row.width, height: row.height },
      { x: 0, y: index * REDRAW_ROW_HEIGHT }
    );
  });
  return output;
}

function composeLongImage(source, addedRows = [], imageConfig = {}, frameImages = [], edgeRepairImages = []) {
  if (source.width !== OUTPUT_WIDTH) {
    throw new Error(`长图宽度必须是 ${OUTPUT_WIDTH}px，实际为 ${source.width}px`);
  }
  const runs = visibleRowRuns(source);
  const badgeSourceRow = Number(imageConfig.badgeSourceRow || 0);
  if (!badgeSourceRow || !runs[badgeSourceRow - 1]) throw new Error("缺少有效 badgeSourceRow");
  const leftPadding = Math.max(0, Number(imageConfig.leftPadding || 0));
  const rightPadding = Math.max(0, Number(imageConfig.rightPadding || 0));
  const prependHeight = addedRows.length * ROW_SLOT_HEIGHT;
  const output = new PNG({
    width: source.width + leftPadding + rightPadding,
    height: source.height + prependHeight,
  });
  output.data.fill(0);
  addedRows.forEach((row, index) => {
    copyRect(
      row,
      output,
      { x: 0, y: 0, width: row.width, height: row.height },
      { x: leftPadding, y: index * ROW_SLOT_HEIGHT }
    );
  });
  copyRect(
    source,
    output,
    { x: 0, y: 0, width: source.width, height: source.height },
    { x: leftPadding, y: prependHeight }
  );

  const badgeSourceY = runs[badgeSourceRow - 1][0];
  for (const correction of imageConfig.countCorrections || []) {
    const targetRun = runs[Number(correction.row || 0) - 1];
    if (!targetRun) throw new Error(`数量修正行不存在：${correction.row}`);
    if (Number(correction.count || 0) !== 1) {
      throw new Error(`当前校正图只支持从 x1 徽标复制，收到：${correction.count}`);
    }
    copyRect(
      source,
      output,
      { x: COUNT_BADGE.x, y: badgeSourceY, width: COUNT_BADGE.width, height: COUNT_BADGE.height },
      { x: leftPadding + COUNT_BADGE.x, y: prependHeight + targetRun[0] }
    );
  }
  (imageConfig.avatarFrameEdgeRepairs || []).forEach((repair, index) => {
    const frame = edgeRepairImages[index];
    if (!frame) throw new Error(`头像框边缘修复素材缺失：${repair.guardName || index}`);
    const frameX = Number(repair.x ?? -8);
    const missingLeft = Math.max(1, Number(repair.missingLeft || Math.max(0, -frameX)));
    for (const rowNumber of repair.rows || []) {
      const targetRun = runs[Number(rowNumber || 0) - 1];
      if (!targetRun) throw new Error(`头像框边缘修复行不存在：${rowNumber}`);
      compositePngRect(
        frame,
        output,
        { x: 0, y: 0, width: missingLeft, height: frame.height },
        {
          x: leftPadding + frameX,
          y: prependHeight + targetRun[0] + Number(repair.yOffset || 0),
        }
      );
    }
  });
  (imageConfig.avatarFrameCorrections || []).forEach((correction, index) => {
    const targetRun = runs[Number(correction.row || 0) - 1];
    const frame = frameImages[index];
    if (!targetRun || !frame) throw new Error(`头像框修正行不存在或素材缺失：${correction.row}`);
    compositePng(frame, output, {
      x: leftPadding + Number(correction.x ?? 0),
      y: prependHeight + targetRun[0] + Number(correction.yOffset || 0),
    });
  });
  return { output, sourceRows: runs.length, outputRows: runs.length + addedRows.length };
}

async function generate(options = {}) {
  const manifestPath = path.resolve(options.manifestPath || "");
  if (!manifestPath || !fs.existsSync(manifestPath)) throw new Error("请通过 --manifest 提供校正 JSON");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const imageConfig = manifest.longImage || {};
  const resolveManifestPath = (value = "") =>
    value ? path.resolve(path.dirname(manifestPath), String(value)) : "";
  const sourcePath = options.sourcePath
    ? path.resolve(options.sourcePath)
    : resolveManifestPath(imageConfig.sourcePath);
  const outputPath = options.outputPath
    ? path.resolve(options.outputPath)
    : resolveManifestPath(imageConfig.outputPath);
  const hasFullRedraw = Array.isArray(imageConfig.fullRedrawRows) && imageConfig.fullRedrawRows.length > 0;
  const hasGroupOutputs = Array.isArray(imageConfig.outputGroups) && imageConfig.outputGroups.length > 0;
  const writeCombinedConfigured = Boolean(options.outputPath) || imageConfig.writeCombined !== false;
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    throw new Error("请通过 --source 提供原长图，或在 manifest.longImage.sourcePath 配置");
  }
  if (!outputPath && !(hasFullRedraw && hasGroupOutputs && !writeCombinedConfigured)) {
    throw new Error("请通过 --output 提供输出路径，或在 manifest.longImage.outputPath 配置");
  }
  const sameOutput =
    outputPath &&
    (sourcePath === outputPath ||
      (fs.existsSync(outputPath) && fs.realpathSync(sourcePath) === fs.realpathSync(outputPath)));
  if (sameOutput) throw new Error("输出路径不能覆盖原长图");
  const sourceBuffer = fs.readFileSync(sourcePath);
  const sourceSha256 = sha256Buffer(sourceBuffer);
  if (imageConfig.sourceSha256 && imageConfig.sourceSha256 !== sourceSha256) {
    throw new Error(`原长图 SHA-256 不匹配：${sourceSha256}`);
  }
  const source = PNG.sync.read(sourceBuffer);
  const manifestDir = path.dirname(manifestPath);
  verifyAssetHashes(manifest.evidence?.renderAssetSha256 || {}, manifestDir);
  if (hasFullRedraw) {
    const runs = visibleRowRuns(source);
    const faceAssets = imageConfig.faceAssets || {};
    const giftAssets = imageConfig.giftAssets || {};
    const avatarFrames = imageConfig.avatarFrames || {};
    const redrawRows = imageConfig.fullRedrawRows.map((row, index) => {
      const faceSpec = faceAssets[row.faceKey || row.userName] || {};
      let face = "";
      if (faceSpec.path || faceSpec.url) {
        face = imageDataUrl(faceSpec.path || faceSpec.url, manifestDir);
      } else if (Number(faceSpec.sourceRow || 0) > 0) {
        const sourceRun = runs[Number(faceSpec.sourceRow) - 1];
        if (!sourceRun) throw new Error(`头像取样行不存在：${faceSpec.sourceRow}`);
        const cropSize = Math.max(32, Number(faceSpec.size || 84));
        face = pngDataUrl(
          cropPng(source, {
            x: Number(faceSpec.x ?? 32),
            y: sourceRun[0] + Number(faceSpec.yOffset ?? 37),
            width: cropSize,
            height: cropSize,
          })
        );
      }
      if (!face) throw new Error(`完整重绘缺少头像：第 ${index + 1} 行 ${row.userName || ""}`);
      const giftSpec = giftAssets[row.giftName] || {};
      if (imageConfig.giftImagePolicy === "gift_catalog_img_basic_png_only" && row.giftIcon) {
        throw new Error(`列表静态图模式禁止行级覆盖礼物图：${row.giftName || index + 1}`);
      }
      const giftIconSource = giftSpec.path || giftSpec.url;
      if (!giftIconSource) throw new Error(`完整重绘缺少礼物图：${row.giftName || index + 1}`);
      if (
        imageConfig.giftImagePolicy === "gift_catalog_img_basic_png_only" &&
        !/^https:\/\/s1\.hdslb\.com\/bfs\/(?:live|open-live)\/[a-f0-9]+\.png(?:$|[?#])/i.test(giftIconSource)
      ) {
        throw new Error(`礼物图必须使用列表 imgBasic 静态 PNG：${row.giftName || index + 1}`);
      }
      const frameSource = avatarFrames[String(row.guardLevel || 0)] || "";
      return {
        ...row,
        face,
        avatarFrameUrl: frameSource ? imageDataUrl(frameSource, manifestDir) : "",
        giftIcon: imageDataUrl(giftIconSource, manifestDir),
        price: Number(row.price || giftSpec.price || 0),
      };
    });
    const rowSummary = imageConfig.fullRedrawRows.map((row, index) => ({
      manifestRow: index + 1,
      sourceRow: Number(row.sourceRow || 0),
      userName: row.userName,
      giftName: row.giftName,
      count: Number(row.count || 1),
      guardLevel: Number(row.guardLevel || 0),
    }));
    const writeCombined = Boolean(options.outputPath) || imageConfig.writeCombined !== false;
    const groupConfigs = options.outputPath ? [] : imageConfig.outputGroups || [];
    const membership = new Array(rowSummary.length).fill(0);
    const groupPlans = groupConfigs.map((group) => {
      const includeNames = new Set((group.userNames || []).map((value) => String(value)));
      const excludeNames = new Set((group.excludeUserNames || []).map((value) => String(value)));
      if ((includeNames.size ? 1 : 0) + (excludeNames.size ? 1 : 0) !== 1) {
        throw new Error(`分组长图必须且只能配置 userNames 或 excludeUserNames：${group.id || group.title || "unnamed"}`);
      }
      const indexes = rowSummary
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => {
          if (includeNames.size) return includeNames.has(String(row.userName || ""));
          if (excludeNames.size) return !excludeNames.has(String(row.userName || ""));
          return false;
        })
        .map(({ index }) => index);
      if (!indexes.length) throw new Error(`分组长图没有任何记录：${group.id || group.title || "unnamed"}`);
      indexes.forEach((index) => {
        membership[index] += 1;
      });
      const groupOutputPath = resolveManifestPath(group.outputPath);
      if (!groupOutputPath) throw new Error(`分组长图缺少 outputPath：${group.id || group.title || "unnamed"}`);
      if (path.resolve(groupOutputPath) === path.resolve(sourcePath)) {
        throw new Error(`分组长图不能覆盖原图：${group.id || group.title || "unnamed"}`);
      }
      return { group, indexes, groupOutputPath };
    });
    if (groupConfigs.length && imageConfig.outputGroupsMustPartition && membership.some((count) => count !== 1)) {
      const badIndexes = membership
        .map((count, index) => ({ count, index }))
        .filter((item) => item.count !== 1)
        .map((item) => `${item.index + 1}:${item.count}`)
        .join(", ");
      throw new Error(`分组长图未对全部记录做一次性分区：${badIndexes}`);
    }
    const plannedOutputPaths = [
      ...(writeCombined ? [outputPath] : []),
      ...groupPlans.map((plan) => plan.groupOutputPath),
    ];
    const plannedOutputKeys = new Set();
    for (const plannedPath of plannedOutputPaths) {
      const key = path.resolve(plannedPath);
      if (key === path.resolve(sourcePath)) throw new Error(`长图输出不能覆盖原图：${plannedPath}`);
      if (plannedOutputKeys.has(key)) throw new Error(`长图输出路径重复：${plannedPath}`);
      plannedOutputKeys.add(key);
    }
    const renderedRows = await renderRedrawRows(redrawRows, options);
    const output = stackRenderedRows(renderedRows);
    const outputBuffer = PNG.sync.write(output);
    const groupArtifacts = groupPlans.map(({ group, indexes, groupOutputPath }) => {
      const groupOutput = stackRenderedRows(indexes.map((index) => renderedRows[index]));
      const groupBuffer = PNG.sync.write(groupOutput);
      const groupSummary = indexes.map((index, outputIndex) => ({
        ...rowSummary[index],
        outputRow: outputIndex + 1,
      }));
      const groupResult = {
        ok: true,
        renderMode: "full_redraw_group",
        groupId: String(group.id || ""),
        groupTitle: String(group.title || ""),
        giftImagePolicy: imageConfig.giftImagePolicy || "",
        outputPath: path.relative(manifestDir, groupOutputPath) || path.basename(groupOutputPath),
        width: groupOutput.width,
        height: groupOutput.height,
        partitionRows: rowSummary.length,
        outputRows: groupSummary.length,
        sourceSha256,
        renderAssetSha256: manifest.evidence?.renderAssetSha256 || {},
        rowSummary: groupSummary,
        outputSha256: sha256Buffer(groupBuffer),
      };
      return { outputPath: groupOutputPath, buffer: groupBuffer, result: groupResult };
    });
    const result = {
      ok: true,
      renderMode: "full_redraw",
      giftImagePolicy: imageConfig.giftImagePolicy || "",
      outputPath: writeCombined ? path.relative(manifestDir, outputPath) || path.basename(outputPath) : "",
      combinedOutputWritten: writeCombined,
      width: output.width,
      height: output.height,
      sourceRows: runs.length,
      addedRows: rowSummary.filter((row) => row.sourceRow === 0).length,
      outputRows: rowSummary.length,
      sourceSha256,
      renderAssetSha256: manifest.evidence?.renderAssetSha256 || {},
      rowSummary,
      outputSha256: sha256Buffer(outputBuffer),
      groups: groupArtifacts.map((artifact) => artifact.result),
    };
    const artifactPlans = [
      ...(writeCombined ? [{ outputPath, buffer: outputBuffer, result }] : []),
      ...groupArtifacts,
    ];
    const tempPlans = artifactPlans.flatMap((artifact, index) => {
      fs.mkdirSync(path.dirname(artifact.outputPath), { recursive: true });
      const imageTemp = `${artifact.outputPath}.${process.pid}.${index}.tmp`;
      const sidecarPath = `${artifact.outputPath}.json`;
      const sidecarTemp = `${sidecarPath}.${process.pid}.${index}.tmp`;
      return [
        { temp: imageTemp, final: artifact.outputPath, data: artifact.buffer },
        { temp: sidecarTemp, final: sidecarPath, data: `${JSON.stringify(artifact.result, null, 2)}\n` },
      ];
    });
    try {
      tempPlans.forEach((plan) => fs.writeFileSync(plan.temp, plan.data));
      tempPlans.forEach((plan) => fs.renameSync(plan.temp, plan.final));
    } finally {
      tempPlans.forEach((plan) => fs.rmSync(plan.temp, { force: true }));
    }
    return result;
  }
  const renderRowsInput = (imageConfig.prependRows || []).map((row) => ({
    ...row,
    face: imageDataUrl(row.face, manifestDir),
    avatarFrameUrl: imageDataUrl(row.avatarFrameUrl, manifestDir),
    giftIcon: imageDataUrl(row.giftIcon, manifestDir),
  }));
  const addedRows = await renderRows(renderRowsInput, options);
  const frameImages = await Promise.all(
    (imageConfig.avatarFrameCorrections || []).map(async (correction) => {
      const frame = await loadPngSource(correction.framePath || correction.frameUrl, manifestDir);
      const size = Math.max(1, Number(correction.size || 151));
      return resizePng(frame, size, size);
    })
  );
  const edgeRepairImages = await Promise.all(
    (imageConfig.avatarFrameEdgeRepairs || []).map(async (repair) => {
      const frame = await loadPngSource(repair.framePath || repair.frameUrl, manifestDir);
      const size = Math.max(1, Number(repair.size || 160));
      return resizePng(frame, size, size);
    })
  );
  const composed = composeLongImage(source, addedRows, imageConfig, frameImages, edgeRepairImages);
  const outputBuffer = PNG.sync.write(composed.output);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, outputBuffer);
  fs.renameSync(tmpPath, outputPath);
  const result = {
    ok: true,
    outputPath: path.relative(manifestDir, outputPath) || path.basename(outputPath),
    width: composed.output.width,
    height: composed.output.height,
    sourceRows: composed.sourceRows,
    addedRows: addedRows.length,
    outputRows: composed.outputRows,
    sourceSha256,
    renderAssetSha256: manifest.evidence?.renderAssetSha256 || {},
    outputSha256: sha256Buffer(outputBuffer),
    corrections: imageConfig.countCorrections || [],
    avatarFrameCorrections: imageConfig.avatarFrameCorrections || [],
    avatarFrameEdgeRepairs: imageConfig.avatarFrameEdgeRepairs || [],
  };
  fs.writeFileSync(`${outputPath}.json`, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await generate({
    sourcePath: args.source,
    manifestPath: args.manifest,
    outputPath: args.output,
    chromeExecutable: args.chrome,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  COUNT_BADGE,
  OUTPUT_WIDTH,
  REDRAW_ROW_HEIGHT,
  REDRAW_WIDTH,
  ROW_SLOT_HEIGHT,
  composeLongImage,
  compositePng,
  compositePngRect,
  copyRect,
  cropPng,
  generate,
  pngDataUrl,
  parseArgs,
  redrawRowHtml,
  renderRows,
  renderRedrawRows,
  resizePng,
  sha256Buffer,
  stackRenderedRows,
  visibleRowRuns,
  imageDataUrl,
  loadPngSource,
  verifyAssetHashes,
};
