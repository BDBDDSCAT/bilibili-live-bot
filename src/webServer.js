#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const {
  checkBiliCookie,
  clearSavedBiliLogin,
  createQrLogin,
  extractCookie,
  loadSavedBiliLogin,
  pollQrLogin,
  saveBiliLogin,
} = require("./bilibiliSender");
const { audit: auditFeatures, printText: printAuditText } = require("../scripts/audit-features");
const { extractRoomId } = require("./bilibiliClient");
const { BotRuntime } = require("./botRuntime");
const { AutoLikeBudgetStore } = require("./autoLikeBudgetStore");
const BrowserControllerModule = require("./browserController");
const { loadConfig: loadMergedConfig } = require("./configLoader");
const { EventStore, summarizeGifts } = require("./eventStore");
const { GiftCatalog } = require("./giftCatalog");
const { formatBattery } = require("./interactionEngine");
const LocalAiService = require("./localAiService");
const { createLogger } = require("./logger");
const OverlayExportService = require("./overlayExportService");
const { runAssistantSelfTest } = require("./selfTest");
const { ScreenshotService } = require("./screenshotService");
const { startRetentionSchedule } = require("./stateRetention");

const BrowserController = BrowserControllerModule.BrowserController || BrowserControllerModule;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webm": "video/webm",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

function parseOrigin(origin = "") {
  try {
    return new URL(String(origin || ""));
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname = "") {
  const host = String(hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function isBilibiliLiveOrigin(origin = "") {
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  const host = parsed.hostname.toLowerCase();
  return parsed.protocol === "https:" && (host === "live.bilibili.com" || host.endsWith(".live.bilibili.com"));
}

function normalizeBilibiliRoomInput(value) {
  const input = String(value || "").trim();
  if (/^\d+$/.test(input) && Number(input) > 0) {
    const roomId = Number(input);
    return { roomId, roomUrl: `https://live.bilibili.com/${roomId}` };
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== "live.bilibili.com"
  ) {
    return null;
  }
  const roomId = Number(parsed.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || 0);
  if (!roomId) return null;
  return {
    roomId,
    roomUrl: `https://live.bilibili.com/${roomId}`,
  };
}

function isTrustedOrigin(req, pathname = "") {
  const origin = req?.headers?.origin || "";
  if (!origin) return true;
  const parsed = parseOrigin(origin);
  if (!parsed) return false;
  if (isLoopbackHost(parsed.hostname)) return true;
  return pathname === "/api/ingest-visible" && isBilibiliLiveOrigin(origin);
}

function corsHeaders(req, pathname = "") {
  const origin = req?.headers?.origin || "";
  const allowOrigin = origin && isTrustedOrigin(req, pathname) ? origin : "";
  return {
    ...(allowOrigin ? { "Access-Control-Allow-Origin": allowOrigin, Vary: "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}


function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    ...corsHeaders(res.__request, res.__pathname),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    ...corsHeaders(res.__request, res.__pathname),
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendDownloadFile(res, filePath) {
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath);
  const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, {
    ...corsHeaders(res.__request, res.__pathname),
    "Content-Type": contentType,
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => {
    res.destroy();
  });
  res.on("close", () => {
    stream.destroy();
  });
  stream.pipe(res);
}

function localRequestBaseUrl(req) {
  const port = Number(req?.socket?.localPort || 0);
  if (!port) throw new Error("无法确定本地工作台端口");
  return `http://127.0.0.1:${port}`;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function requestWantsHtml(req, url) {
  if (url.searchParams.get("format") === "json" || url.searchParams.get("format") === "text") return false;
  if (url.searchParams.get("format") === "html" || url.searchParams.get("view") === "html") return true;
  return String(req.headers.accept || "").includes("text/html");
}

function renderDoctorHtml(payload = {}) {
  const verdict = payload.verdict || {};
  const level = verdict.level || payload.verdictLevel || "warn";
  const evidence = Array.isArray(payload.evidence) ? payload.evidence : [];
  const checklist = Array.isArray(payload.verificationChecklist) ? payload.verificationChecklist : [];
  const statusClass = payload.captureVerified ? "ok" : level === "danger" ? "danger" : "warn";
  const needsBridge = Boolean(
    payload.identityLimited ||
      (Array.isArray(payload.actionItems) && payload.actionItems.some((item) => /网页补抓|完整昵称|头像/.test(String(item || "")))) ||
      (Array.isArray(payload.actionDetails) && payload.actionDetails.some((item) => /网页补抓|完整昵称|头像/.test(String(item || ""))))
  );
  const checklistHtml = checklist
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.label || item.key)}</strong><span class="state-${escapeHtml(
          item.state || "unknown"
        )}">${escapeHtml(doctorChecklistValue(item))}</span><em>${escapeHtml(item.detail || "")}</em></li>`
    )
    .join("");
  const evidenceHtml = evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>B站直播助理体检结果</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202b; background: #f5f7fb; }
    body { margin: 0; padding: 28px; }
    main { max-width: 980px; margin: 0 auto; background: #fff; border: 1px solid #d7e0ea; border-radius: 14px; padding: 24px; box-shadow: 0 12px 40px rgba(33, 46, 63, .08); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .sub { color: #667382; margin: 0 0 20px; }
    .badge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; font-weight: 700; }
    .ok { background: #e9f8ef; color: #14783d; }
    .warn { background: #fff5dc; color: #8a5600; }
    .danger { background: #fdecec; color: #a91d2b; }
    section { margin-top: 22px; }
    h2 { font-size: 18px; margin: 0 0 10px; }
    .detail { line-height: 1.7; color: #2d3845; }
    ul { padding-left: 22px; line-height: 1.7; }
    .checks { list-style: none; padding: 0; display: grid; gap: 8px; }
    .checks li { border: 1px solid #dbe3ed; border-radius: 10px; padding: 10px 12px; display: grid; grid-template-columns: 140px 80px 1fr; gap: 10px; align-items: start; }
    .checks span { font-weight: 700; color: #4b5f75; }
    .checks .state-ok { color: #14783d; }
    .checks .state-action { color: #9a5c00; }
    .checks .state-wait { color: #7c5a00; }
    .checks .state-bad { color: #a91d2b; }
    .checks em { color: #5f6e7e; font-style: normal; }
    pre { white-space: pre-wrap; word-break: break-word; border: 1px solid #dbe3ed; border-radius: 10px; background: #f8fafc; padding: 14px; line-height: 1.6; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    a { color: #1264d8; text-decoration: none; font-weight: 700; }
    .actions a { border: 1px solid #cbd7e5; border-radius: 9px; padding: 9px 12px; background: #fff; }
    @media (max-width: 720px) { body { padding: 12px; } main { padding: 18px; } .checks li { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>B站直播助理体检结果</h1>
    <p class="sub">这是给人看的体检页。需要给我排查时，可以打开 <a href="/api/doctor?format=json">数据版</a>。</p>
    <div class="badge ${statusClass}">${escapeHtml(payload.verificationText || verdict.title || "未确认")}</div>
    <section>
      <h2>${escapeHtml(verdict.title || "体检结果")}</h2>
      <p class="detail">${escapeHtml(verdict.detail || payload.reason || "没有详情")}</p>
    </section>
    <section>
      <h2>核验清单</h2>
      <ul class="checks">${checklistHtml || "<li><strong>未返回</strong><span>--</span><em>请刷新重试</em></li>"}</ul>
    </section>
    <section>
      <h2>证据</h2>
      <ul>${evidenceHtml || "<li>还没有证据，请回控制台点一键体检。</li>"}</ul>
    </section>
    <section>
      <h2>完整文本</h2>
      <pre>${escapeHtml(payload.text || "")}</pre>
    </section>
    <div class="actions">
      ${needsBridge ? '<a href="/?focus=bridge">复制网页核对脚本</a>' : ""}
      <a href="/?focus=doctor">回控制台体检区</a>
      <a href="/api/doctor?format=text">打开纯文本</a>
      <a href="/api/doctor?format=json">打开数据版</a>
    </div>
  </main>
</body>
</html>`;
}

function auditResponse(report = {}) {
  return {
    ok: true,
    report,
    generatedAt: report.generatedAt || "",
    filters: report.filters || {},
    files: report.files || {},
    totals: report.totals || {},
    groups: report.groups || [],
	    parserReplay: report.parserReplay || {},
	    sampleGates: report.sampleGates || [],
	    operatorSummary: report.operatorSummary || {},
	    context: report.context || {},
	    unknownCommands: report.unknownCommands || [],
    gifts: report.gifts || {},
    guards: report.guards || {},
  };
}

function auditStateText(state = "") {
  if (state === "covered") return "已对上";
  if (state === "covered_by_replay") return "历史补回";
  if (state === "missing") return "需要修";
  if (state === "eventOnly") return "来源异常";
  return "未出现";
}

function auditReplayNote(item = {}) {
  if (item.state !== "covered_by_replay") return "";
  if (item.key === "chat") {
    return "查弹幕会从历史样本补回数量和文本，昵称可能仍需网页核对。";
  }
  return "旧入库记录不全，历史样本复查已补回。";
}

function auditGateStateText(gate = {}) {
  if (gate.key === "fallbackGiftText" && gate.state === "eventOnly") return "需核对";
  return auditStateText(gate.state);
}

function renderAuditHtml(report = {}) {
  const groups = Array.isArray(report.groups) ? report.groups : [];
  const gates = Array.isArray(report.sampleGates) ? report.sampleGates : [];
  const totals = report.totals || {};
  const filters = report.filters || {};
  const quality = report.gifts?.quality || {};
  const operatorSummary = report.operatorSummary || {};
  const title = [
    "B站直播助理功能审计",
    filters.room ? `房间 ${filters.room}` : "",
    filters.day ? `日期 ${filters.day}` : "",
  ].filter(Boolean).join(" · ");
  const groupHtml = groups.map((group) => {
    const replay = auditReplayNote(group);
    const label = group.displayLabel || group.label || group.key;
    return `<li><strong>${escapeHtml(label)}</strong><span>${escapeHtml(auditStateText(group.state))}</span><em>${escapeHtml(
      `收到 ${group.rawPackets || 0} 条 / 去重样本 ${group.expectedRaw || 0} 条 -> 入库 ${
        group.capturedEvents || 0
      } 条${replay ? `；${replay}` : ""}`
    )}</em></li>`;
  }).join("");
  const gateHtml = gates.map((gate) => {
    const replay = auditReplayNote(gate);
    const detail = gate.detail || `收到 ${gate.rawCount || 0} 条 -> 入库 ${gate.eventCount || 0} 条`;
    return `<li><strong>${escapeHtml(gate.label || gate.key)}</strong><span>${escapeHtml(auditGateStateText(gate))}</span><em>${escapeHtml(
      `${detail}${replay ? `；${replay}` : ""}；${gate.action || "继续观察"}`
    )}</em></li>`;
  }).join("");
  const unknownHtml = (report.unknownCommands || []).slice(0, 12)
    .map((item) => `<li><strong>${escapeHtml(item.name || "UNKNOWN")}</strong><span>需看</span><em>${escapeHtml(`${item.count || 0} 次`)}</em></li>`)
    .join("");
  const blockerHtml = (operatorSummary.blockers || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const nextStepHtml = (operatorSummary.nextSteps || [])
    .map((item) => `<li>${escapeHtml(item)}</li>`)
    .join("");
  const text = printAuditText(report);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>B站直播助理功能审计</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17202b; background: #f5f7fb; }
    body { margin: 0; padding: 28px; }
    main { max-width: 1040px; margin: 0 auto; background: #fff; border: 1px solid #d7e0ea; border-radius: 14px; padding: 24px; box-shadow: 0 12px 40px rgba(33, 46, 63, .08); }
    h1 { margin: 0 0 8px; font-size: 28px; }
    .sub { color: #667382; margin: 0 0 20px; line-height: 1.6; }
    .summary { display: flex; flex-wrap: wrap; gap: 10px; margin: 14px 0; }
    .summary span { border: 1px solid #dbe3ed; border-radius: 999px; padding: 8px 12px; font-weight: 700; background: #f8fafc; }
    .verdict { border: 1px solid #dbe3ed; border-left: 5px solid #1264d8; border-radius: 12px; padding: 14px 16px; background: #f8fbff; margin: 18px 0; }
    .verdict[data-level="warn"] { border-left-color: #b7791f; background: #fffaf0; }
    .verdict[data-level="danger"] { border-left-color: #c53030; background: #fff5f5; }
    .verdict h2 { margin: 0 0 8px; }
    .verdict p { margin: 0 0 8px; color: #435266; line-height: 1.6; }
    .verdict ul { margin: 8px 0 0 18px; padding: 0; color: #435266; line-height: 1.7; }
    section { margin-top: 22px; }
    h2 { font-size: 18px; margin: 0 0 10px; }
    .checks { list-style: none; padding: 0; display: grid; gap: 8px; }
    .checks li { border: 1px solid #dbe3ed; border-radius: 10px; padding: 10px 12px; display: grid; grid-template-columns: 160px 90px 1fr; gap: 10px; align-items: start; }
    .checks strong { color: #27384c; }
    .checks span { font-weight: 800; color: #1264d8; }
    .checks em { color: #5f6e7e; font-style: normal; line-height: 1.55; }
    pre { white-space: pre-wrap; word-break: break-word; border: 1px solid #dbe3ed; border-radius: 10px; background: #f8fafc; padding: 14px; line-height: 1.6; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    a { color: #1264d8; text-decoration: none; font-weight: 700; }
    .actions a { border: 1px solid #cbd7e5; border-radius: 9px; padding: 9px 12px; background: #fff; }
    @media (max-width: 760px) { body { padding: 12px; } main { padding: 18px; } .checks li { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title || "B站直播助理功能审计")}</h1>
    <p class="sub">这是给人看的抓取审计页。判断“漏没漏”看收到记录、去重样本、已入库结果和历史样本复查；需要给我排查时，可以打开 <a href="${escapeHtml(auditJsonHref(report))}">数据版</a>。</p>
    <div class="summary">
      <span>收到记录 ${escapeHtml(totals.rawRows || 0)} 行</span>
      <span>已入库 ${escapeHtml(totals.eventRows || 0)} 行</span>
      <span>真实入库 ${escapeHtml(totals.realEventRows ?? totals.eventRows ?? 0)} 行</span>
      <span>未分类 ${escapeHtml((report.unknownCommands || []).length)} 类</span>
    </div>
    <section class="verdict" data-level="${escapeHtml(operatorSummary.level || "warn")}">
      <h2>当前结论：${escapeHtml(operatorSummary.title || "等待审计结论")}</h2>
      ${
        blockerHtml
          ? `<p>还不能判满分的原因：</p><ul>${blockerHtml}</ul>`
          : "<p>当前审计范围内没有发现必须处理的缺口。</p>"
      }
      ${nextStepHtml ? `<p>下一步：</p><ul>${nextStepHtml}</ul>` : ""}
    </section>
    <section>
      <h2>覆盖分组</h2>
      <ul class="checks">${groupHtml || "<li><strong>无</strong><span>--</span><em>没有审计分组</em></li>"}</ul>
    </section>
    <section>
      <h2>真实样本门槛</h2>
      <ul class="checks">${gateHtml || "<li><strong>无</strong><span>--</span><em>没有样本门槛</em></li>"}</ul>
    </section>
    <section>
      <h2>素材质检</h2>
      <p class="sub">礼物事件 ${escapeHtml(quality.total || 0)} 条，缺图标 ${escapeHtml(quality.missingIcon || 0)}，缺头像 ${escapeHtml(quality.missingFace || 0)}，打码 ${escapeHtml(quality.maskedName || 0)}，缺价值 ${escapeHtml(quality.missingValue || 0)}。</p>
    </section>
    ${unknownHtml ? `<section><h2>需要关注的新命令</h2><ul class="checks">${unknownHtml}</ul></section>` : ""}
    <section>
      <h2>纯文本</h2>
      <pre>${escapeHtml(text)}</pre>
    </section>
    <div class="actions">
      <a href="/?focus=doctor">回控制台体检区</a>
      <a href="${escapeHtml(auditTextHref(report))}">打开纯文本</a>
      <a href="${escapeHtml(auditJsonHref(report))}">打开数据版</a>
    </div>
  </main>
</body>
</html>`;
}

function auditHref(report = {}, format = "json") {
  const params = new URLSearchParams();
  if (report.filters?.day) params.set("day", report.filters.day);
  if (report.filters?.room) params.set("room", report.filters.room);
  params.set("format", format);
  return `/api/audit?${params.toString()}`;
}

function auditJsonHref(report = {}) {
  return auditHref(report, "json");
}

function auditTextHref(report = {}) {
  return auditHref(report, "text");
}

function selfTestResponse(result = {}) {
  return {
    ok: Boolean(result.ok),
    result,
    isolated: Boolean(result.isolated),
    dryRun: Boolean(result.dryRun),
    checks: result.checks || [],
    summary: result.summary || {},
  };
}

function diagnosticsLine(label, value) {
  return `${label}：${value}`;
}

function doctorRuntimeStateText(snapshot = {}) {
  const liveStatus = Number(snapshot.room?.liveStatus ?? snapshot.roomInfo?.liveStatus ?? -1);
  if (!snapshot.running) return "未启动";
  if (liveStatus === 0) return "未开播，等待实时事件";
  return snapshot.connected ? "已连接，正在监听" : "监听线路正在重连";
}

function doctorOutputModeText(snapshot = {}) {
  if (snapshot.dryRun !== false || (!snapshot.sendToBili && !snapshot.enablePost)) return "只监听，不会发送";
  if (snapshot.sendToBili) return "允许发 B站弹幕";
  if (snapshot.enablePost) return "允许推送本地语音";
  return "未知";
}

function doctorFeatureAuditScopeText(report = {}) {
  const filters = report.filters || {};
  return [filters.day ? `日期 ${filters.day}` : "全部日期", filters.room ? `房间 ${filters.room}` : "全部房间"].join(" · ");
}

function doctorEventCountNote(totals = {}) {
  const rawRows = Number(totals.rawRows || 0);
  const eventRows = Number(totals.realEventRows ?? totals.eventRows ?? 0);
  if (rawRows && eventRows > rawRows) {
    return "入库结果含派生事件和汇总状态，行数可能大于收到记录；判断漏抓看历史样本复查里的缺口。";
  }
  return "判断漏抓看历史样本复查和缺口，不只看行数。";
}

function doctorSampleGateStateText(stateOrGate = "") {
  const gate = typeof stateOrGate === "object" && stateOrGate ? stateOrGate : {};
  const state = gate.state || stateOrGate || "";
  if (gate.key === "fallbackGiftText" && state === "eventOnly") return "需网页核对";
  if (state === "covered") return "已对上";
  if (state === "covered_by_replay") return "历史补回";
  if (state === "missing") return "需要修";
  if (state === "eventOnly") return "来源异常";
  return "未出现";
}

function doctorPendingSampleText(gate = {}) {
  const label = gate.label || "真实样本";
  if (gate.key === "visibleBridge") return `${label}：当前房间还没接入网页核对，用来核对完整昵称、礼物泡泡和榜单`;
  if (gate.key === "superChat") return `${label}：当前房间还没出现真实 SC`;
  if (gate.key === "fallbackGiftText") return `${label}：这是文字补记，不是 B站直接送礼包，需要网页核对或直播间可见内容核对`;
  if (gate.key === "guardBuy") return `${label}：当前范围还没出现上船/续费流水`;
  if (gate.key === "paidGift") return `${label}：当前范围还没出现本房 SEND_GIFT/COMBO_SEND 付费礼物包`;
  if (gate.key === "lotteryRedPocket") return `${label}：当前范围还没出现天选/红包活动`;
  return `${label}：${gate.action || gate.detail || "等待当前房间真实触发"}`;
}

function doctorSampleGateSummary(report = {}) {
  const important = new Set([
    "paidGift",
    "fallbackGiftText",
    "globalGiftNotice",
    "superChat",
    "guardBuy",
    "guardHonor",
    "lotteryRedPocket",
    "multiPkLine",
    "visibleBridge",
  ]);
  const gates = (report.sampleGates || [])
    .filter((gate) => important.has(gate.key))
    .slice(0, 10)
    .map((gate) => {
      const detail = gate.detail || `${gate.rawCount || 0}->${gate.eventCount || 0}`;
      return `${gate.label}：${detail}（${doctorSampleGateStateText(gate)}）`;
    });
  return gates.length ? gates.join("；") : "无真实样本";
}

function doctorSafeMode(snapshot = {}) {
  return snapshot.dryRun !== false && !snapshot.sendToBili && !snapshot.enablePost;
}

function doctorRoomOffline(snapshot = {}) {
  return Number(snapshot.room?.liveStatus ?? snapshot.roomInfo?.liveStatus ?? -1) === 0;
}

function doctorVisibleBridgeGate(gate = {}) {
  return gate.key === "visibleBridge" || /网页可见补抓|网页补抓/.test(String(gate.label || ""));
}

function doctorGateNeedsVisualCheck(gate = {}) {
  return gate.key === "fallbackGiftText" && gate.state === "eventOnly";
}

function doctorBridgeLagText(visualAudit = {}) {
  const lastAt = Number(visualAudit.lastAt || 0);
  if (!lastAt) return "";
  const lagMs = Math.max(0, Number(visualAudit.lagMs || Date.now() - lastAt));
  return doctorLagText(lagMs);
}

function doctorLagText(lagMs = 0) {
  const safeMs = Math.max(0, Number(lagMs || 0));
  if (safeMs < 1000) return "刚刚";
  if (safeMs < 60 * 1000) return `约 ${Math.max(1, Math.round(safeMs / 1000))} 秒前`;
  const minutes = Math.max(1, Math.round(safeMs / 60000));
  if (minutes < 60) return `约 ${minutes} 分钟前`;
  const hours = Math.max(1, Math.round(minutes / 60));
  return `约 ${hours} 小时前`;
}

function latestMtimeFromReportFiles(report = {}, kind = "raw") {
  const files = Array.isArray(report.files?.[kind]) ? report.files[kind] : [];
  let latest = 0;
  for (const file of files) {
    try {
      const fullPath = path.resolve(process.cwd(), file);
      const stat = fs.statSync(fullPath);
      latest = Math.max(latest, Number(stat.mtimeMs || 0));
    } catch {
      // A missing audit file should not break the whole doctor page.
    }
  }
  return latest;
}

function doctorCaptureFreshness(snapshot = {}, report = {}) {
  const health = snapshot.captureHealth || {};
  const liveStatus = Number(snapshot.room?.liveStatus ?? snapshot.roomInfo?.liveStatus ?? -1);
  const running = Boolean(snapshot.running);
  const connected = Boolean(snapshot.running && snapshot.connected);
  const lastRawAt = Number(health.lastRawAt || 0);
  const lastRawFileAt = latestMtimeFromReportFiles(report, "raw");
  const lastEventFileAt = latestMtimeFromReportFiles(report, "events");
  const lastFileAt = Math.max(lastRawFileAt, lastEventFileAt);
  const lastAt = lastRawAt || lastFileAt;
  const lastSource = lastRawAt ? "实时记录" : lastAt && lastAt === lastRawFileAt ? "收到记录文件" : lastAt ? "入库记录文件" : "";
  const ageMs = lastAt ? Math.max(0, Date.now() - lastAt) : Infinity;
  const ageText = Number.isFinite(ageMs) ? doctorLagText(ageMs) : "";
  const command = health.lastRawCommand ? `，最近命令 ${health.lastRawCommand}` : "";

  if (!running) {
    return {
      state: "action",
      detail: "还没启动监听，无法证明实时抓取正在工作",
      evidence: "监听新鲜度：未启动监听",
      ageMs,
      lastAt,
      source: lastSource,
    };
  }
  if (liveStatus === 0 && connected) {
    return {
      state: "ok",
      detail: "WebSocket 已连接；房间未开播，弹幕和新礼物通常要等开播，进房/在线榜/停播心跳仍可能出现",
      evidence: "监听新鲜度：房间未开播，WebSocket 已连接；进房/在线榜/停播心跳仍可能出现",
      ageMs,
      lastAt,
      source: "websocket",
    };
  }
  if (liveStatus === 0 && !lastAt) {
    return {
      state: "wait",
      detail: "房间未开播，还没有实时记录属正常",
      evidence: "监听新鲜度：房间未开播，还没有实时记录属正常",
      ageMs,
      lastAt,
      source: lastSource,
    };
  }
  if (!connected) {
    return {
      state: "action",
      detail: "WebSocket 未稳定连接，实时记录新鲜度不能通过",
      evidence: "监听新鲜度：WebSocket 未稳定连接",
      ageMs,
      lastAt,
      source: lastSource,
    };
  }
  if (lastAt && ageMs <= 2 * 60 * 1000) {
    return {
      state: "ok",
      detail: `${lastSource || "实时记录"} ${ageText}有更新${command}`,
      evidence: `监听新鲜度：${lastSource || "实时记录"} ${ageText}有更新${command}`,
      ageMs,
      lastAt,
      source: lastSource,
    };
  }
  if (lastAt && ageMs <= 5 * 60 * 1000) {
    return {
      state: "wait",
      detail: `${lastSource || "实时记录"} ${ageText}有更新；直播间可能暂时安静，继续观察`,
      evidence: `监听新鲜度：${lastSource || "实时记录"} ${ageText}有更新，继续观察`,
      ageMs,
      lastAt,
      source: lastSource,
    };
  }
  if (lastAt) {
    return {
      state: "action",
      detail: `${lastSource || "实时记录"} 已 ${ageText}没有更新；可能卡住或房间太安静，建议点“安全启动并体检”重连核对`,
      evidence: `监听新鲜度：${lastSource || "实时记录"} 已 ${ageText}没有更新，需重连或继续核对`,
      ageMs,
      lastAt,
      source: lastSource,
    };
  }
  return {
    state: "wait",
    detail: "已连接但还没收到第一条实时记录，等下一条弹幕、进房、在线或礼物事件",
    evidence: "监听新鲜度：已连接但还没收到第一条实时记录",
    ageMs,
    lastAt,
    source: lastSource,
  };
}

function doctorIdentityStatus(snapshot = {}) {
  const visualAudit = snapshot.captureHealth?.visualAudit || {};
  const hints = snapshot.captureHealth?.visualHints || {};
  const offline = doctorRoomOffline(snapshot);
  const bridgeActive = Boolean(visualAudit.active);
  const acceptedTotal = Number(visualAudit.acceptedTotal || 0);
  const bridgeLastAt = Number(visualAudit.lastAt || 0);
  const hintCount = Number(hints.names || 0);
  if (bridgeActive && acceptedTotal > 0) {
    return {
      ok: true,
      limited: false,
      label: "完整昵称",
      detail: `B站直播流仍可能打码，但网页核对在线，已成功入库 ${acceptedTotal} 条可见事件。`,
      evidence: `身份口径：直播流有打码风险，网页核对在线并已入库 ${acceptedTotal} 条可见事件`,
    };
  }
  const bridgeText = bridgeActive ? "网页核对在线，但还没有成功入库的可见样本" : "网页核对未在线";
  if (bridgeActive) {
    return {
      ok: false,
      limited: true,
      label: "完整昵称/头像",
      action: "保持直播页打开，等下一条可见弹幕/礼物样本",
      actionDetail:
        "网页核对已经在线；保持 B站直播页打开，等下一条可见弹幕或礼物泡泡入库。急着核对时，可在本页“网页核对（弹幕/礼物）”里手动确认一条。",
      detail: `B站直播流正在返回星号昵称；${bridgeText}。弹幕/礼物解析可以对账，但用户全名、头像和网页可见礼物泡泡还不能判成完整。`,
      evidence: "身份口径：直播流存在打码昵称，网页核对在线但可见样本未入库；完整昵称、头像和网页可见礼物泡泡需等可见样本入库后再判定",
    };
  }
  if (bridgeLastAt || acceptedTotal > 0) {
    const lagText = doctorBridgeLagText(visualAudit);
    const lastText = lagText ? `，最后心跳${lagText}` : "";
    const acceptedText = acceptedTotal ? `，之前已成功入库 ${acceptedTotal} 条可见事件` : "";
    return {
      ok: false,
      limited: true,
      label: "完整昵称/头像",
      action: "重新打开网页核对，恢复完整昵称/头像核对",
      actionDetail: `网页核对曾经在线但已离线${lastText}${acceptedText}；请保持 B站直播页打开并重新运行网页核对脚本，直到看到新的可见弹幕或礼物泡泡入库。`,
      detail: `B站直播流正在返回星号昵称；网页核对曾经在线但已离线${lastText}。弹幕/礼物解析可以对账，但用户全名、头像和网页可见礼物泡泡还不能判成完整。`,
      evidence: `身份口径：直播流存在打码昵称，网页核对已离线${acceptedText}；完整昵称、头像和网页可见礼物泡泡需重新打开网页核对`,
    };
  }
  if (!offline && !snapshot.identityMasked) {
    return {
      ok: true,
      limited: false,
      label: "完整昵称",
      detail: hintCount ? `当前直播流未提示打码；已缓存 ${hintCount} 条身份线索。` : "当前直播流未提示打码。",
      evidence: hintCount ? `身份口径：当前未打码，已缓存 ${hintCount} 条昵称/头像线索` : "身份口径：当前未打码",
    };
  }
  return {
    ok: false,
    limited: true,
    label: "完整昵称/头像",
    action: offline
      ? "等开播后运行网页核对脚本，核对完整昵称、头像和页面礼物泡泡"
      : "复制网页核对脚本，核对完整昵称、头像和页面礼物泡泡",
    actionDetail: offline
      ? "当前房间未开播；现在保持监听即可。开播后再复制网页核对脚本到直播页运行，出现弹幕、礼物泡泡或榜单变化后看“看到/已发/入库”增长。"
      : "点“复制网页核对脚本”，到 B站直播页地址栏直接粘贴并回车；如果浏览器删掉 javascript:，展开备用方法后复制备用正文。",
    detail: offline
      ? `房间未开播；${bridgeText}。现在不会有新的可见弹幕或礼物泡泡入库，完整昵称、头像和网页礼物泡泡要等开播后用网页核对。`
      : `B站直播流正在返回星号昵称；${bridgeText}。弹幕/礼物解析可以对账，但用户全名、头像和网页可见礼物泡泡还不能判成完整。`,
    evidence: offline
      ? `身份口径：房间未开播且网页核对未在线；完整昵称、头像和网页可见礼物泡泡需等开播后做网页核对`
      : `身份口径：直播流存在打码昵称，${bridgeText}；完整昵称、头像和网页可见礼物泡泡需做网页核对`,
  };
}

function buildDoctorVerificationStatus(snapshot = {}, selfTest = {}, report = {}, verdict = {}) {
  const groups = Array.isArray(report.groups) ? report.groups : [];
  const gates = Array.isArray(report.sampleGates) ? report.sampleGates : [];
  const unknownCommands = Array.isArray(report.unknownCommands) ? report.unknownCommands : [];
  const identityStatus = doctorIdentityStatus(snapshot);
  const captureFreshness = doctorCaptureFreshness(snapshot, report);
  const pendingRealSamples = gates
    .filter((item) => item.state === "idle" && !(identityStatus.limited && doctorVisibleBridgeGate(item)))
    .map((item) => item.label)
    .filter(Boolean);
  const pendingRealSampleDetails = gates
    .filter((item) => item.state === "idle" && !(identityStatus.limited && doctorVisibleBridgeGate(item)))
    .map((item) => doctorPendingSampleText(item))
    .filter(Boolean);
  const actionItems = identityStatus.limited ? [identityStatus.action || identityStatus.label].filter(Boolean) : [];
  const actionDetails = identityStatus.limited
    ? [identityStatus.actionDetail || identityStatus.action || identityStatus.label].filter(Boolean)
    : [];
  const visualCheckItems = gates.filter(doctorGateNeedsVisualCheck).map((item) => item.label).filter(Boolean);
  const visualCheckDetails = gates.filter(doctorGateNeedsVisualCheck).map(doctorVisualCheckDetail).filter(Boolean);
  const replayRecoveredItems = [
    ...groups.filter((item) => item.state === "covered_by_replay").map((item) => item.label),
    ...gates.filter((item) => item.state === "covered_by_replay").map((item) => item.label),
  ].filter(Boolean);
  const missingItems = [
    ...groups.filter((item) => item.state === "missing").map((item) => item.label),
    ...gates
      .filter((item) => item.state === "missing" || (item.state === "eventOnly" && !doctorGateNeedsVisualCheck(item)))
      .map((item) => item.label),
    ...unknownCommands.slice(0, 6).map((item) => `未分类 ${item.name || "UNKNOWN"}`),
  ].filter(Boolean);
  const verdictLevel = verdict.level || "warn";
  const captureVerified =
    verdictLevel === "ok" &&
    Boolean(selfTest.ok) &&
    captureFreshness.state === "ok" &&
    missingItems.length === 0 &&
    visualCheckItems.length === 0 &&
    identityStatus.ok;
  const safeMode = doctorSafeMode(snapshot);
  const verificationState = captureVerified
    ? "verified"
    : verdictLevel === "danger"
      ? "failed"
      : identityStatus.limited
        ? "identity_limited"
        : "needs_real_samples";
  const verificationText = captureVerified
    ? "已验证通过"
      : verdictLevel === "danger"
      ? "发现缺口，不能托管"
      : identityStatus.limited
        ? visualCheckItems.length
          ? "部分通过，完整昵称/头像待网页核对，文字补记礼物待网页核对"
          : "部分通过，完整昵称待网页核对"
        : "部分通过，仍需真实样本";
  return {
    completed: true,
    verified: captureVerified,
    captureVerified,
    verdictLevel,
    needsAttention: !captureVerified,
    safeMode,
    operationSafe: safeMode,
    readyForBeginner: captureVerified && safeMode,
    verificationState,
    verificationText,
    pendingRealSamples,
    pendingRealSampleDetails,
    actionItems,
    actionDetails,
    visualCheckItems,
    visualCheckDetails,
    missingItems,
    replayRecoveredItems,
    captureFreshness,
    identityReliable: identityStatus.ok,
    identityLimited: identityStatus.limited,
    identityDetail: identityStatus.detail,
    identityEvidence: identityStatus.evidence,
    reason: verdict.detail || verdict.title || "",
  };
}

function doctorChecklistStateText(state = "") {
  if (state === "ok") return "通过";
  if (state === "action") return "待处理";
  if (state === "wait") return "等样本";
  if (state === "bad") return "异常";
  return "未确认";
}

function doctorChecklistValue(item = {}) {
  if (item.key === "missing") return item.state === "ok" ? "无" : doctorChecklistStateText(item.state);
  if (item.key === "realSamples") {
    return item.state === "ok" ? "无" : `等 ${item.detail || "真实样本"}`;
  }
  if (item.key === "visualCheck") {
    return item.state === "ok" ? "无" : `核对 ${item.detail || "网页样本"}`;
  }
  return doctorChecklistStateText(item.state);
}

function buildDoctorVerificationChecklist(snapshot = {}, selfTest = {}, report = {}, status = {}) {
  const totals = report.totals || {};
  const parserReplay = report.parserReplay || {};
  const rawRows = Number(totals.rawRows || parserReplay.totalLines || 0);
  const replayed = Number(parserReplay.replayed || 0);
  const totalLines = Number(parserReplay.totalLines || rawRows || 0);
  const parseErrors = Number(parserReplay.parseErrors || 0);
  const uncovered = Array.isArray(parserReplay.uncoveredImportant) ? parserReplay.uncoveredImportant.length : 0;
  const safeMode = doctorSafeMode(snapshot);
  const liveStatus = Number(snapshot.room?.liveStatus ?? snapshot.roomInfo?.liveStatus ?? -1);
  const connected = Boolean(snapshot.running && snapshot.connected);
  const pending = Array.isArray(status.pendingRealSamples) ? status.pendingRealSamples.filter(Boolean) : [];
  const missing = Array.isArray(status.missingItems) ? status.missingItems.filter(Boolean) : [];
  const visualCheck = Array.isArray(status.visualCheckItems) ? status.visualCheckItems.filter(Boolean) : [];
  const parserOk = Boolean(totalLines && replayed >= totalLines && parseErrors === 0 && uncovered === 0);
  const freshness = doctorCaptureFreshness(snapshot, report);

  return [
    {
      key: "safeMode",
      label: "安全输出",
      state: safeMode ? "ok" : "bad",
      detail: safeMode ? "只监听，不真实发送" : "存在发送相关开关，需要人工确认",
    },
    {
      key: "selfTest",
      label: "本地自检",
      state: selfTest.ok ? "ok" : "bad",
      detail: selfTest.ok ? `${selfTest.summary?.passed || 0}/${selfTest.summary?.total || 0} 通过` : "全链路自检未通过",
    },
    {
      key: "parserReplay",
	      label: "历史样本复查",
      state: parserOk ? "ok" : rawRows ? "bad" : "wait",
      detail: rawRows
        ? `${replayed}/${totalLines || rawRows} 行，解析错误 ${parseErrors}，重要缺口 ${uncovered}`
        : "还没有可回放的原始记录",
    },
    {
      key: "realtime",
      label: "实时连接",
      state: connected ? "ok" : liveStatus === 0 ? "wait" : "action",
      detail: connected ? "WebSocket 已连接" : liveStatus === 0 ? "房间未开播，等实时事件" : "监听线路未稳定",
    },
    {
      key: "captureFreshness",
      label: "监听新鲜度",
      state: freshness.state,
      detail: freshness.detail,
    },
    {
      key: "identity",
      label: "完整昵称/头像",
      state: status.identityReliable ? "ok" : status.identityLimited ? "action" : "wait",
      detail: status.identityReliable
        ? "身份线索可用"
        : status.identityDetail || "需要网页核对完整昵称、头像和礼物泡泡",
    },
    {
      key: "realSamples",
      label: "待真实样本",
      state: pending.length ? "wait" : "ok",
      detail: pending.length ? pending.slice(0, 4).join("、") : "当前必需样本已出现或无需等待",
    },
    {
      key: "visualCheck",
      label: "待网页核对",
      state: visualCheck.length ? "action" : "ok",
      detail: visualCheck.length ? visualCheck.slice(0, 4).join("、") : "无",
    },
    {
      key: "missing",
      label: "真实缺口",
      state: missing.length ? "bad" : "ok",
      detail: missing.length ? missing.slice(0, 4).join("、") : "无",
    },
  ];
}

function doctorChecklistText(checklist = []) {
  return checklist
    .map((item) => `${item.label}=${doctorChecklistValue(item)}`)
    .join("；");
}

function doctorChecklistBlockerText(item = {}) {
  if (item.key === "visualCheck") return `${item.detail || item.label} 待网页核对`;
  if (item.state === "wait" && item.key === "realSamples") return `${item.detail || item.label} 待真实出现`;
  if (item.state === "wait") return `${item.label}等样本`;
  if (item.state === "action") return `${item.label}待处理`;
  if (item.state === "bad") return `${item.label}异常`;
  return `${item.label}未确认`;
}

function doctorStrictCorrectnessText(checklist = []) {
  const blockers = checklist.filter((item) => item.state !== "ok");
  if (!blockers.length) return "严格口径：当前可验证项已全部通过。";
  const waiting = blockers.map((item) => doctorChecklistBlockerText(item)).join("、");
  return `严格口径：还不能标记为完全正确；${waiting}。`;
}

function doctorCoveredGroupEvidenceLabel(group = {}, gates = []) {
  if (group.key === "gift") {
    const paidGift = gates.find((item) => item.key === "paidGift") || {};
    const globalNotice = gates.find((item) => item.key === "globalGiftNotice") || {};
    const fallback = gates.find((item) => item.key === "fallbackGiftText") || {};
    const paidCovered = paidGift.state === "covered" || paidGift.state === "covered_by_replay";
    const noticeCovered = globalNotice.state === "covered" || globalNotice.state === "covered_by_replay";
    const parts = [];
    if (paidCovered) parts.push("直播间送礼包");
    if (noticeCovered) parts.push("全站礼物公告");
    if (!parts.length) return group.label || "礼物事件";
    return fallback.state === "eventOnly" ? `${parts.join("、")}（不含文字补记）` : parts.join("、");
  }
  if (group.key !== "guard") return group.label || group.key || "";
  const guardBuy = gates.find((item) => item.key === "guardBuy") || {};
  const guardHonor = gates.find((item) => item.key === "guardHonor") || {};
  const buyCovered = guardBuy.state === "covered" || guardBuy.state === "covered_by_replay";
  const honorCovered = guardHonor.state === "covered" || guardHonor.state === "covered_by_replay";
  if (buyCovered && honorCovered) return "大航海购买/续费、荣誉榜变化";
  if (buyCovered) return "大航海购买/续费";
  if (honorCovered) return "大航海荣誉榜变化（不含购买/续费）";
  return "大航海已出现事件";
}

function doctorVisualCheckDetail(item = {}) {
  if (item.key === "fallbackGiftText") return `${item.label || "文字补记礼物"}：不是 B站直接送礼包`;
  return `${item.label || item.key || "网页样本"}：需网页核对`;
}

function buildDoctorVerdict(snapshot = {}, selfTest = {}, report = {}) {
  const groups = Array.isArray(report.groups) ? report.groups : [];
  const gates = Array.isArray(report.sampleGates) ? report.sampleGates : [];
  const unknown = Array.isArray(report.unknownCommands) ? report.unknownCommands : [];
  const missingGroups = groups.filter((item) => item.state === "missing");
  const missingGates = gates.filter((item) => item.state === "missing");
  const idleGates = gates.filter((item) => item.state === "idle");
  const coveredGates = gates.filter((item) => item.state === "covered" || item.state === "covered_by_replay");
  const totals = report.totals || {};
  const rawRows = Number(totals.rawRows || 0);
  const realEvents = Number(totals.realEventRows ?? totals.eventRows ?? 0);
  const running = Boolean(snapshot.running);
  const connected = Boolean(running && snapshot.connected);
  const liveStatus = Number(snapshot.room?.liveStatus ?? snapshot.roomInfo?.liveStatus ?? -1);
  const identityStatus = doctorIdentityStatus(snapshot);
  const freshness = doctorCaptureFreshness(snapshot, report);
  const actionableIdleGates = identityStatus.limited ? idleGates.filter((item) => !doctorVisibleBridgeGate(item)) : idleGates;
  const visualCheckDetails = gates.filter(doctorGateNeedsVisualCheck).map(doctorVisualCheckDetail).filter(Boolean).slice(0, 3);

  if (!selfTest.ok) {
    return {
      level: "danger",
      title: "本地模块自检没过，先别托管",
      detail: "进房、弹幕、礼物、SC、大航海或 PK 的本地链路有异常。复制诊断报告给我继续修。",
    };
  }
  if (!running) {
    return {
      level: "warn",
      title: "先点安全启动并体检",
      detail: "本地自检和历史对账可以先跑，但当前直播间还没开始监听。填好房间后点“安全启动并体检”。",
    };
  }
	  if (!connected && liveStatus === 0) {
	    return {
	      level: "warn",
	      title: "房间未开播，实时流等开播再验",
	      detail: "本地自检会继续验证模块，历史样本会继续复查；但未开播时通常没有实时弹幕和礼物样本，进房/在线榜/停播心跳可能仍会出现，不能把实时抓取判成通过。",
	    };
	  }
  if (!connected) {
    return {
      level: "warn",
      title: "监听线路正在重连",
      detail: "本地模块和历史样本可以先验证，但当前 WebSocket 还没稳定连上。等状态变成“已连接”后再点一次体检。",
    };
  }
  if (freshness.state === "action") {
    return {
      level: "warn",
      title: "监听可能卡住，先重连核对",
      detail: `${freshness.detail}。本地解析和历史回放可以继续看，但实时抓取不能只凭“已连接”判定通过。`,
    };
  }
  if (missingGroups.length || missingGates.length || unknown.length) {
    const names = [
      ...missingGroups.map((item) => item.label),
      ...missingGates.map((item) => item.label),
      ...unknown.slice(0, 3).map((item) => `未分类 ${item.name}`),
    ].slice(0, 5);
    return {
      level: "danger",
      title: "发现真实缺口，不能说抓取准确",
      detail: `${names.join("、")} 需要继续排查。已收到记录，但入库结果没有完全对上。`,
    };
  }
  if (!rawRows || !coveredGates.length) {
    return {
      level: "warn",
      title: "本地自检通过，但缺少真实样本",
      detail: "这只说明模块能跑；直播间还没积累足够礼物、SC、PK、连线等真实样本，不能冒充绝对正确。",
    };
  }
	  if (identityStatus.limited) {
	    const actionText = (identityStatus.actionDetail || identityStatus.action || identityStatus.detail).replace(/[。；;,.，]+$/u, "");
	    const waiting = actionableIdleGates.map((item) => doctorPendingSampleText(item)).filter(Boolean).slice(0, 3).join("；");
	    const visualCheck = visualCheckDetails.join("；");
	    return {
	      level: "warn",
		      title: visualCheckDetails.length ? "解析对账通过，完整昵称/头像待网页核对，文字补记礼物待核对" : "解析对账通过，完整昵称/头像待网页核对",
	      detail: `历史样本 ${rawRows} 行、已入库结果 ${realEvents} 行；已出现的解析样本对上了，但身份口径还没完全验证。待处理：${actionText}${visualCheck ? `。待网页核对：${visualCheck}` : ""}${waiting ? `。等真实样本：${waiting}` : ""}。`,
	    };
	  }
	  if (actionableIdleGates.length) {
	    const waiting = actionableIdleGates.map((item) => doctorPendingSampleText(item)).slice(0, 3).join("；");
	    return {
	      level: "warn",
	      title: "已有样本对账通过，部分功能等真实触发",
	      detail: `历史样本 ${rawRows} 行、已入库结果 ${realEvents} 行；已出现的样本对上了。待补样本：${waiting || "部分功能等待当前房间真实触发"}。`,
	    };
	  }
	  return {
	    level: "ok",
	    title: "当前样本抓取对账通过",
	    detail: `历史样本 ${rawRows} 行、已入库结果 ${realEvents} 行；本地全链路自检通过，已出现的真实功能都完成对账。`,
	  };
	}

function buildDoctorEvidence(snapshot = {}, selfTest = {}, report = {}) {
  const totals = report.totals || {};
  const parserReplay = report.parserReplay || {};
  const groups = Array.isArray(report.groups) ? report.groups : [];
  const gates = Array.isArray(report.sampleGates) ? report.sampleGates : [];
  const selfSummary = selfTest.summary || {};
  const safeMode = doctorSafeMode(snapshot);
  const liveStatus = Number(snapshot.room?.liveStatus ?? snapshot.roomInfo?.liveStatus ?? -1);
  const currentCounts = snapshot.counts || {};
  const identityStatus = doctorIdentityStatus(snapshot);
  const freshness = doctorCaptureFreshness(snapshot, report);
  const actionableGates = identityStatus.limited ? gates.filter((item) => !doctorVisibleBridgeGate(item)) : gates;
  const coveredGroups = groups
    .filter((item) => item.state === "covered")
    .map((item) => doctorCoveredGroupEvidenceLabel(item, gates))
    .slice(0, 6);
  const replayCoveredItems = [
    ...groups.filter((item) => item.state === "covered_by_replay").map((item) => item.label),
    ...gates.filter((item) => item.state === "covered_by_replay").map((item) => item.label),
  ]
    .filter(Boolean)
    .slice(0, 6);
  const waitingGates = actionableGates
    .filter((item) => item.state === "idle")
    .map((item) => doctorPendingSampleText(item))
    .slice(0, 4);
  const visualCheckGates = gates
    .filter(doctorGateNeedsVisualCheck)
    .map((item) => item.label)
    .slice(0, 4);
  const missingGates = gates
    .filter((item) => item.state === "missing" || (item.state === "eventOnly" && !doctorGateNeedsVisualCheck(item)))
    .map((item) => item.label)
    .slice(0, 4);
  const evidence = [`安全模式：${safeMode ? "只监听，不会发送 B站/语音" : "检测到发送相关开关，请先确认"}`];
  evidence.push(identityStatus.evidence);
  evidence.push(freshness.evidence);
  if (selfTest.ok !== undefined) {
    evidence.push(`本地自检：${selfSummary.passed || 0}/${selfSummary.total || 0} 通过，隔离 dry-run，不污染直播数据`);
  }
  if (parserReplay.totalLines || totals.rawRows) {
    evidence.push(
      `历史样本复查：${parserReplay.replayed || 0}/${parserReplay.totalLines || totals.rawRows || 0} 行，解析错误 ${
        parserReplay.parseErrors || 0
      }，重要缺口 ${parserReplay.uncoveredImportant?.length || 0} 类`
    );
  }
  evidence.push(`计数口径：${doctorEventCountNote(totals)}`);
  if (coveredGroups.length) {
    evidence.push(`已对账分组：${coveredGroups.join("、")}`);
  }
  if (replayCoveredItems.length) {
    evidence.push(`可回放恢复项：${replayCoveredItems.join("、")} 旧记录不足，历史样本复查已补回`);
  }
  if (visualCheckGates.length) {
    evidence.push(`待网页核对：${visualCheckGates.join("、")} 是文字补记，不是 B站直接送礼包`);
  }
  if (missingGates.length) {
    evidence.push(`需排查：${missingGates.join("、")} 已有样本但没完全对上`);
  } else if (waitingGates.length) {
    evidence.push(`等真实触发：${waitingGates.join("、")}，不是本地自检失败`);
  }
  if (liveStatus === 0) {
    evidence.push(
      `当前实时：房间未开播，本次会话弹幕 ${currentCounts.chat || 0}、进房 ${currentCounts.enter || 0}、礼物 ${
        currentCounts.gift || 0
      }；弹幕和新礼物通常要等开播，进房/在线榜/停播心跳可能仍会出现`
    );
  }
  return evidence;
}

function buildDoctorEvidenceText(snapshot = {}, verdict = {}, evidence = [], report = {}, status = {}) {
  const room = snapshot.room || {};
  const totals = report.totals || {};
  const parserReplay = report.parserReplay || {};
  const auditFiles = report.files || {};
  const verificationStatus =
    status && Object.keys(status).length ? status : buildDoctorVerificationStatus(snapshot, {}, report, verdict);
  const verificationChecklist = Array.isArray(verificationStatus.verificationChecklist)
    ? verificationStatus.verificationChecklist
    : buildDoctorVerificationChecklist(snapshot, {}, report, verificationStatus);
  return [
    "B站直播助理体检证据",
    diagnosticsLine("房间", room.roomId ? `${room.roomId} · ${room.uname || ""} · ${room.liveStatusLabel || ""}` : snapshot.roomInput || "未解析"),
    diagnosticsLine("运行", doctorRuntimeStateText(snapshot)),
    diagnosticsLine("输出", doctorOutputModeText(snapshot)),
    diagnosticsLine("安全", doctorSafeMode(snapshot) ? "只监听，不真实发送" : "存在发送相关开关，请人工确认"),
    diagnosticsLine("身份口径", verificationStatus.identityDetail || doctorIdentityStatus(snapshot).detail),
    diagnosticsLine("监听新鲜度", verificationStatus.captureFreshness?.detail || doctorCaptureFreshness(snapshot, report).detail),
    diagnosticsLine("验证状态", verificationStatus.verificationText || "未确认"),
    diagnosticsLine("严格口径", doctorStrictCorrectnessText(verificationChecklist).replace(/^严格口径：/, "")),
    diagnosticsLine("核验清单", doctorChecklistText(verificationChecklist)),
    diagnosticsLine(
      "待处理动作",
      verificationStatus.actionDetails?.length
        ? verificationStatus.actionDetails.slice(0, 8).join("；")
        : verificationStatus.actionItems?.length
          ? verificationStatus.actionItems.slice(0, 8).join("、")
          : "无"
    ),
    diagnosticsLine(
      "待真实样本",
      verificationStatus.pendingRealSampleDetails?.length
        ? verificationStatus.pendingRealSampleDetails.slice(0, 8).join("；")
        : verificationStatus.pendingRealSamples?.length
          ? verificationStatus.pendingRealSamples.slice(0, 8).join("、")
          : "无"
    ),
    diagnosticsLine(
      "待网页核对",
      verificationStatus.visualCheckItems?.length ? verificationStatus.visualCheckItems.slice(0, 8).join("、") : "无"
    ),
    diagnosticsLine(
      "缺口",
      verificationStatus.missingItems?.length ? verificationStatus.missingItems.slice(0, 8).join("、") : "无"
    ),
    diagnosticsLine(
      "旧记录可回放恢复",
      verificationStatus.replayRecoveredItems?.length
        ? `${verificationStatus.replayRecoveredItems.slice(0, 8).join("、")}；旧记录不足，历史样本复查已补回`
        : "无"
    ),
    diagnosticsLine("体检标题", verdict.title || "未运行"),
    diagnosticsLine("体检说明", verdict.detail || "无"),
    "",
    "证据",
    ...(evidence.length ? evidence.map((item, index) => `${index + 1}. ${item}`) : ["还没体检"]),
    "",
    "审计摘要",
    diagnosticsLine("审计范围", doctorFeatureAuditScopeText(report)),
    diagnosticsLine("收到/入库/真实入库", `${totals.rawRows || 0}/${totals.eventRows || 0}/${totals.realEventRows ?? totals.eventRows ?? 0}`),
    diagnosticsLine("计数口径", doctorEventCountNote(totals)),
    diagnosticsLine(
	      "历史样本复查",
      `${parserReplay.replayed || 0}/${parserReplay.totalLines || totals.rawRows || 0} 行，解析错误 ${
        parserReplay.parseErrors || 0
      }，重要缺口 ${parserReplay.uncoveredImportant?.length || 0} 类`
    ),
    diagnosticsLine("真实样本门槛", doctorSampleGateSummary(report)),
    diagnosticsLine("样本文件", `收到记录 ${auditFiles.raw?.length || 0} 个，入库记录 ${auditFiles.events?.length || 0} 个`),
    "",
    "当前计数",
    diagnosticsLine(
      "本次记录/弹幕/进房/礼物",
      `${snapshot.counts?.raw || 0}/${snapshot.counts?.chat || 0}/${snapshot.counts?.enter || 0}/${snapshot.counts?.gift || 0}`
    ),
    diagnosticsLine("更新时间", new Date().toLocaleString("zh-CN", { hour12: false })),
  ].join("\n");
}

function doctorResponse({ snapshot = {}, selfTest = {}, report = {} }) {
  const verdict = buildDoctorVerdict(snapshot, selfTest, report);
  const evidence = buildDoctorEvidence(snapshot, selfTest, report);
  const status = buildDoctorVerificationStatus(snapshot, selfTest, report, verdict);
  const verificationChecklist = buildDoctorVerificationChecklist(snapshot, selfTest, report, status);
  const statusEvidence = [
    `验证状态：${status.verificationText}`,
    doctorStrictCorrectnessText(verificationChecklist),
    `核验清单：${doctorChecklistText(verificationChecklist)}`,
    status.actionDetails.length
      ? `待处理动作：${status.actionDetails.slice(0, 8).join("；")}`
      : status.actionItems.length
        ? `待处理动作：${status.actionItems.slice(0, 8).join("、")}`
        : "待处理动作：无",
    status.pendingRealSampleDetails.length
      ? `待真实样本：${status.pendingRealSampleDetails.slice(0, 8).join("；")}`
      : status.pendingRealSamples.length
        ? `待真实样本：${status.pendingRealSamples.slice(0, 8).join("、")}`
        : "待真实样本：无",
    status.visualCheckDetails?.length
      ? `待网页核对：${status.visualCheckDetails.slice(0, 8).join("；")}`
      : status.visualCheckItems?.length
        ? `待网页核对：${status.visualCheckItems.slice(0, 8).join("、")}`
        : "待网页核对：无",
    status.missingItems.length ? `缺口：${status.missingItems.slice(0, 8).join("、")}` : "缺口：无",
    status.replayRecoveredItems.length
      ? `旧记录可回放恢复：${status.replayRecoveredItems.slice(0, 8).join("、")} 旧记录不足，历史样本复查已补回`
      : "",
  ];
  const visibleEvidence = [...statusEvidence.filter(Boolean), ...evidence];
	  const result = {
	    completed: true,
	    verified: status.verified,
	    captureVerified: status.captureVerified,
    verdictLevel: status.verdictLevel,
    needsAttention: status.needsAttention,
    safeMode: status.safeMode,
    operationSafe: status.operationSafe,
    readyForBeginner: status.readyForBeginner,
    verificationState: status.verificationState,
    verificationText: status.verificationText,
    identityReliable: status.identityReliable,
    identityLimited: status.identityLimited,
    identityDetail: status.identityDetail,
    pendingRealSamples: status.pendingRealSamples,
    pendingRealSampleDetails: status.pendingRealSampleDetails,
    actionItems: status.actionItems,
    actionDetails: status.actionDetails,
    visualCheckItems: status.visualCheckItems,
    visualCheckDetails: status.visualCheckDetails,
    verificationChecklist,
    missingItems: status.missingItems,
    replayRecoveredItems: status.replayRecoveredItems,
    captureFreshness: status.captureFreshness,
    reason: status.reason,
    snapshot,
    selfTest,
    report,
	    audit: report,
	    verdict: { ...verdict, evidence: visibleEvidence },
	    evidence: visibleEvidence,
	  };
	  result.status = {
	    completed: result.completed,
	    verified: result.verified,
	    captureVerified: result.captureVerified,
	    verdictLevel: result.verdictLevel,
	    needsAttention: result.needsAttention,
	    safeMode: result.safeMode,
	    operationSafe: result.operationSafe,
	    readyForBeginner: result.readyForBeginner,
	    verificationState: result.verificationState,
	    verificationText: result.verificationText,
	    identityReliable: result.identityReliable,
	    identityLimited: result.identityLimited,
	    identityDetail: result.identityDetail,
	    pendingRealSamples: result.pendingRealSamples,
	    pendingRealSampleDetails: result.pendingRealSampleDetails,
	    actionItems: result.actionItems,
	    actionDetails: result.actionDetails,
	    visualCheckItems: result.visualCheckItems,
	    visualCheckDetails: result.visualCheckDetails,
	    verificationChecklist: result.verificationChecklist,
	    missingItems: result.missingItems,
	    replayRecoveredItems: result.replayRecoveredItems,
	    captureFreshness: result.captureFreshness,
	    reason: result.reason,
	  };
	  result.doctorVerification = result.status;
	  result.text = buildDoctorEvidenceText(snapshot, verdict, visibleEvidence, report, {
	    ...status,
	    verificationChecklist,
  });
  return result;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("请求体过大");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8").trim();
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    const error = new Error("请求 JSON 格式错误");
    error.statusCode = 400;
    throw error;
  }
}

function safeStaticPath(publicDir, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  let decoded = "";
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const fullPath = path.resolve(publicDir, `.${decoded}`);
  if (fullPath !== publicDir && !fullPath.startsWith(publicDir + path.sep)) {
    return null;
  }
  return fullPath;
}

function isAllowedImageUrl(value) {
  let parsed = null;
  try {
    parsed = new URL(String(value || ""));
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const host = parsed.hostname.toLowerCase();
  return (
    host === "hdslb.com" ||
    host.endsWith(".hdslb.com") ||
    host === "bilibili.com" ||
    host.endsWith(".bilibili.com")
  );
}

function createWebApp({
  rootDir,
  config,
  browserController: injectedBrowserController = null,
  autoLikeBudgetStore: injectedAutoLikeBudgetStore = null,
  localAiService: injectedLocalAiService = null,
  overlayExportService: injectedOverlayExportService = null,
  randomFn: injectedRandomFn = Math.random,
}) {
  const publicDir = path.resolve(rootDir, "public");
  const eventStore = new EventStore({
    rootDir: path.resolve(rootDir, config.history?.dir || "state"),
  });
  const autoLikeBudgetStore =
    injectedAutoLikeBudgetStore || new AutoLikeBudgetStore({ stateDir: eventStore.rootDir });
  const savedLoginPath = path.join(eventStore.rootDir, "secrets", "bili-login.json");
  const overlayExportService =
    injectedOverlayExportService ||
    new OverlayExportService({
      rootDir,
      outputDir: path.join(eventStore.rootDir, "overlays"),
      ...(config.overlayExport || {}),
    });
  const clients = new Set();
  const logs = [];
  const actions = [];
  const browserController =
    injectedBrowserController ||
    new BrowserController({
      rootDir,
      config,
    });
  const localAiService =
    injectedLocalAiService || new LocalAiService(config.localAi || {});
  let localAiServiceState = localAiService.getState?.() || {
    status: "idle",
    message: "尚未检查本地 AI",
    model: String(config.localAi?.model || ""),
    lastCheckedAt: 0,
  };
  let runtime = null;
  let commandTester = null;
  let manualStopped = false;
  let browserControlDesired = false;
  let browserControlRoom = config.room || "";
  let browserControlGeneration = 0;
  let startupMessageGeneration = -1;
  let browserAutoStartPromise = null;
  let autoLikeTimer = null;
  let autoLikeDayRolloverTimer = null;
  let autoLikeGeneration = 0;
  let autoLikeInFlight = false;
  let autoLikeNextAt = 0;
  let autoLikeLastDelayMs = 0;
  let autoLikeLastBurstCount = 0;
  let autoLikeSessionGeneration = -1;
  let autoLikeSessionRoomId = 0;
  let autoLikeSessionDay = "";
  let autoLikeSessionTargetClicks = 0;
  let autoLikeSessionClicks = 0;
  let autoLikeLimitReached = false;
  const randomFn = typeof injectedRandomFn === "function" ? injectedRandomFn : Math.random;
  let lastStartBody = null;
  let watchdogTimer = null;
  let watchdogRestarting = false;
  let lastWatchdogRestartAt = 0;
  let disconnectedSince = 0;
  let snapshot = {
    running: false,
    connected: false,
    roomInput: config.room || "",
    dryRun: config.dryRun !== false,
    showEvents: Boolean(config.showAllEvents),
    speakEndpoint: config.speakEndpoint || "",
    fanoutHosts: Number(config.connection?.fanoutHosts || 1),
    moduleStatus: config.modules || {},
    autoSendQueue: [],
    browserControl: browserController.getState?.() || null,
    localAiService: {
      status: localAiServiceState.status || "idle",
      message: localAiServiceState.message || "",
      model: localAiServiceState.model || "",
      lastCheckedAt: Number(localAiServiceState.lastCheckedAt || 0),
    },
    sendTransport: "disabled",
  };

  function getLocalAiServiceState() {
    const current = localAiServiceState || {};
    const allowedStatuses = new Set(["idle", "checking", "ready", "error", "skipped"]);
    return {
      status: allowedStatuses.has(current.status) ? current.status : "error",
      message: String(current.message || "").replace(/[\r\n\t]/g, " ").trim().slice(0, 300),
      model: String(current.model || config.localAi?.model || "")
        .replace(/[\r\n\t]/g, " ")
        .trim()
        .slice(0, 160),
      lastCheckedAt: Number(current.lastCheckedAt || 0),
    };
  }

  function applyLocalAiServiceState(nextRuntime = runtime) {
    nextRuntime?.localAiClient?.applyServiceProbe?.(getLocalAiServiceState());
  }

  function getBrowserControlState() {
    try {
      return browserController.getState?.() || null;
    } catch (error) {
      return { ready: false, status: "error", error: error.message || String(error) };
    }
  }

  function browserControlReady() {
    return getBrowserControlState()?.ready === true;
  }

  function localDayKey(date = new Date()) {
    const two = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
  }

  // 审计要读全部 raw/events 文件，历史越攒越大，直接在请求路径上全量跑会卡死事件循环。
  // 默认只审当天（day 传 "all" 才全量），30 秒内的重复体检直接吃缓存。
  const auditCache = new Map();
  const AUDIT_CACHE_TTL_MS = 30000;

  function runBoundedAudit({ day = "", room = "", roomLiveStatus } = {}) {
    const effectiveDay = day === "all" ? "" : day || localDayKey();
    // 开播状态写死在报告的操作指引里，必须进缓存键，否则开播/下播后 30 秒内给错指引
    const liveKey = Number.isFinite(Number(roomLiveStatus)) ? Number(roomLiveStatus) : "";
    const key = `${effectiveDay}|${room}|${liveKey}`;
    const cached = auditCache.get(key);
    if (cached && Date.now() - cached.at < AUDIT_CACHE_TTL_MS) return cached.report;
    // stateDir 跟随 history.dir 配置，否则改了数据目录后体检还在读默认 state 得出错误结论。
    const report = auditFeatures({ day: effectiveDay, room, roomLiveStatus, stateDir: eventStore.rootDir });
    auditCache.set(key, { at: Date.now(), report });
    if (auditCache.size > 20) {
      const oldestKey = [...auditCache.entries()].sort((left, right) => left[1].at - right[1].at)[0][0];
      auditCache.delete(oldestKey);
    }
    return report;
  }

  function randomUnit() {
    const sampled = Number(randomFn());
    return Number.isFinite(sampled) ? Math.min(0.999999999, Math.max(0, sampled)) : 0.5;
  }

  function randomRangeMs(minSeconds, maxSeconds) {
    const rawMin = Number(minSeconds);
    const rawMax = Number(maxSeconds);
    const first = Number.isFinite(rawMin) ? Math.max(0, rawMin * 1000) : 0;
    const second = Number.isFinite(rawMax) ? Math.max(0, rawMax * 1000) : first;
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    return Math.round(min + (max - min) * randomUnit());
  }

  function randomBurstCount(settings = {}) {
    const rawMin = Number(settings.burstMinClicks ?? 1);
    const rawMax = Number(settings.burstMaxClicks ?? settings.burstMinClicks ?? 1);
    const first = Number.isFinite(rawMin) ? Math.max(1, Math.round(rawMin)) : 1;
    const second = Number.isFinite(rawMax) ? Math.max(1, Math.round(rawMax)) : first;
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    return Math.floor(min + (max - min + 1) * randomUnit());
  }

  function randomSessionTargetClicks(settings = {}) {
    const rawMin = Number(settings.sessionTargetMinClicks ?? 10000);
    const rawMax = Number(settings.sessionTargetMaxClicks ?? 20000);
    const first = Number.isFinite(rawMin) ? Math.max(1, Math.round(rawMin)) : 10000;
    const second = Number.isFinite(rawMax) ? Math.max(1, Math.round(rawMax)) : 20000;
    const min = Math.min(first, second);
    const max = Math.max(first, second);
    return Math.floor(min + (max - min + 1) * randomUnit());
  }

  function warnWithoutBlocking(label, error) {
    const message = error?.message || String(error);
    if (runtime?.log) {
      runtime.log(label, message, { level: "warn" });
      return;
    }
    const entry = {
      id: `${Date.now().toString(36)}-${label}`,
      at: Date.now(),
      level: "warn",
      label,
      message,
    };
    remember(logs, entry);
    broadcast("log", entry);
  }

  function currentAutoLikeRoomId() {
    return Number(
      runtime?.roomInfo?.roomId ||
        normalizeBilibiliRoomInput(browserControlRoom || config.room)?.roomId ||
        0
    );
  }

  function persistAutoLikeSession() {
    if (!autoLikeSessionRoomId || !autoLikeSessionDay || autoLikeSessionTargetClicks <= 0) {
      return false;
    }
    try {
      autoLikeBudgetStore.save({
        roomId: autoLikeSessionRoomId,
        day: autoLikeSessionDay,
        targetClicks: autoLikeSessionTargetClicks,
        successfulClicks: autoLikeSessionClicks,
        limitReached: autoLikeLimitReached,
        updatedAt: Date.now(),
      });
      return true;
    } catch (error) {
      warnWithoutBlocking("自动点赞预算保存失败", error);
      return false;
    }
  }

  function resetAutoLikeSession(
    generation = browserControlGeneration,
    roomId = currentAutoLikeRoomId()
  ) {
    const settings = config.browserAutomation?.autoLike || {};
    const day = autoLikeBudgetStore.currentDay?.() || localDayKey();
    autoLikeSessionGeneration = generation;
    autoLikeSessionRoomId = Number(roomId || 0);
    autoLikeSessionDay = day;
    let restored = null;
    try {
      restored = autoLikeBudgetStore.load(autoLikeSessionRoomId);
    } catch (error) {
      warnWithoutBlocking("自动点赞预算读取失败", error);
    }
    if (restored) {
      autoLikeSessionTargetClicks = restored.targetClicks;
      autoLikeSessionClicks = restored.successfulClicks;
      autoLikeLimitReached = restored.limitReached;
      autoLikeLastBurstCount = 0;
      return;
    }
    autoLikeSessionTargetClicks = randomSessionTargetClicks(settings);
    autoLikeSessionClicks = 0;
    autoLikeLimitReached = false;
    autoLikeLastBurstCount = 0;
    persistAutoLikeSession();
  }

  function ensureAutoLikeSession() {
    const roomId = currentAutoLikeRoomId();
    const day = autoLikeBudgetStore.currentDay?.() || localDayKey();
    if (
      autoLikeSessionGeneration !== browserControlGeneration ||
      autoLikeSessionRoomId !== roomId ||
      autoLikeSessionDay !== day ||
      autoLikeSessionTargetClicks <= 0
    ) {
      resetAutoLikeSession(browserControlGeneration, roomId);
    }
  }

  function autoLikeEnabled() {
    ensureAutoLikeSession();
    const settings = config.browserAutomation || {};
    const autoLike = settings.autoLike || {};
    const moduleEnabled = runtime?.isModuleEnabled
      ? runtime.isModuleEnabled("autoLike")
      : config.modules?.autoLike?.enabled === true;
    const liveEligible =
      autoLike.onlyWhenLive === false || Number(runtime?.roomInfo?.liveStatus ?? -1) === 1;
    return Boolean(
      browserControlDesired &&
        !manualStopped &&
        browserControlReady() &&
        runtime?.running &&
        runtime?.browserAuto &&
        settings.enabled !== false &&
        autoLike.enabled === true &&
        moduleEnabled &&
        liveEligible &&
        !autoLikeLimitReached
    );
  }

  function clearAutoLikeSchedule() {
    autoLikeGeneration += 1;
    if (autoLikeTimer) clearTimeout(autoLikeTimer);
    if (autoLikeDayRolloverTimer) clearTimeout(autoLikeDayRolloverTimer);
    autoLikeTimer = null;
    autoLikeDayRolloverTimer = null;
    autoLikeNextAt = 0;
  }

  function scheduleAutoLikeDayRollover() {
    if (autoLikeDayRolloverTimer || !browserControlDesired || manualStopped) return false;
    const now = new Date();
    const nextDay = new Date(now);
    nextDay.setHours(24, 0, 1, 0);
    autoLikeDayRolloverTimer = setTimeout(() => {
      autoLikeDayRolloverTimer = null;
      if (!browserControlDesired || manualStopped) return;
      ensureAutoLikeSession();
      ensureAutoLikeSchedule(true);
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
    }, Math.max(1000, nextDay.getTime() - now.getTime()));
    autoLikeDayRolloverTimer.unref?.();
    return true;
  }

  function scheduleAutoLike(generation, initial = false) {
    if (generation !== autoLikeGeneration || !autoLikeEnabled() || autoLikeTimer || autoLikeInFlight) return false;
    const settings = config.browserAutomation?.autoLike || {};
    const delayMs = initial
      ? randomRangeMs(settings.initialDelayMinSec ?? 5, settings.initialDelayMaxSec ?? 12)
      : randomRangeMs(settings.intervalMinSec ?? 18, settings.intervalMaxSec ?? 55);
    autoLikeLastDelayMs = delayMs;
    autoLikeNextAt = Date.now() + delayMs;
    autoLikeTimer = setTimeout(async () => {
      autoLikeTimer = null;
      autoLikeNextAt = 0;
      if (generation !== autoLikeGeneration || !autoLikeEnabled()) return;
      autoLikeInFlight = true;
      const sessionGeneration = autoLikeSessionGeneration;
      const remainingClicks = Math.max(
        0,
        autoLikeSessionTargetClicks - autoLikeSessionClicks
      );
      const burstCount = Math.min(randomBurstCount(settings), remainingClicks);
      autoLikeLastBurstCount = burstCount;
      let likeResult = null;
      try {
        if (burstCount > 0) {
          likeResult = await browserController.like?.({
            roomId: Number(runtime?.roomInfo?.roomId || roomIdFromValue(browserControlRoom || config.room)),
            count: burstCount,
            shouldContinue: () =>
              generation === autoLikeGeneration &&
              autoLikeSessionGeneration === sessionGeneration &&
              autoLikeEnabled(),
          });
        }
      } catch (error) {
        runtime?.log?.("自动点赞失败", error.message || String(error), { level: "warn" });
      } finally {
        autoLikeInFlight = false;
      }
      if (sessionGeneration === autoLikeSessionGeneration && burstCount > 0) {
        const reportedCount = Number(likeResult?.count);
        const successfulClicks = Math.min(
          burstCount,
          Math.max(
            0,
            Number.isFinite(reportedCount)
              ? Math.floor(reportedCount)
              : likeResult?.ok === true
                ? burstCount
                : 0
          )
        );
        autoLikeSessionClicks = Math.min(
          autoLikeSessionTargetClicks,
          autoLikeSessionClicks + successfulClicks
        );
        if (autoLikeSessionClicks >= autoLikeSessionTargetClicks) {
          autoLikeLimitReached = true;
          autoLikeNextAt = 0;
        }
        persistAutoLikeSession();
      }
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
      if (autoLikeEnabled()) {
        if (generation === autoLikeGeneration) scheduleAutoLike(generation, false);
        else ensureAutoLikeSchedule(true);
      } else if (autoLikeLimitReached) {
        scheduleAutoLikeDayRollover();
      }
    }, delayMs);
    return true;
  }

  function ensureAutoLikeSchedule(initial = false) {
    ensureAutoLikeSession();
    if (!autoLikeEnabled()) {
      clearAutoLikeSchedule();
      if (autoLikeLimitReached) scheduleAutoLikeDayRollover();
      return false;
    }
    if (autoLikeDayRolloverTimer) {
      clearTimeout(autoLikeDayRolloverTimer);
      autoLikeDayRolloverTimer = null;
    }
    if (autoLikeTimer || autoLikeInFlight) return true;
    autoLikeGeneration += 1;
    return scheduleAutoLike(autoLikeGeneration, initial);
  }

  function enqueueStartupMessageOnce(generation = browserControlGeneration) {
    if (
      generation !== browserControlGeneration ||
      startupMessageGeneration === generation ||
      !browserControlDesired ||
      manualStopped ||
      !browserControlReady() ||
      !runtime?.running ||
      !runtime?.browserAuto ||
      Number(runtime?.roomInfo?.liveStatus ?? -1) !== 1
    ) {
      return false;
    }
    startupMessageGeneration = generation;
    const settings = config.automation?.startupMessage || {};
    if (settings.enabled === false) return false;
    const reply = String(settings.text || "机器人已上线，欢迎大家来聊天～").trim();
    if (!reply) return false;
    Promise.resolve(
      runtime.handleAction(
        {
          type: "timer",
          ruleName: "startup_message",
          reply,
          emotion: "cheerful",
          priority: 200,
        },
        null
      )
    ).catch((error) => {
      runtime?.log?.("上线弹幕入队失败", error.message || String(error), { level: "warn" });
    });
    return true;
  }

  function syncBrowserControlSnapshot() {
    const browserControl = getBrowserControlState();
    const managedRoom =
      normalizeBilibiliRoomInput(browserControlRoom) ||
      normalizeBilibiliRoomInput(browserControl?.roomUrl) ||
      normalizeBilibiliRoomInput(config.room);
    snapshot = {
      ...(snapshot || {}),
      ...(managedRoom
        ? {
            roomInput: managedRoom.roomUrl,
            managedRoom,
          }
        : {}),
      browserControl,
      localAiService: getLocalAiServiceState(),
      autoLikeSchedule: {
        onlyWhenLive: config.browserAutomation?.autoLike?.onlyWhenLive !== false,
        waitingForLive:
          config.browserAutomation?.autoLike?.onlyWhenLive !== false &&
          Number(runtime?.roomInfo?.liveStatus ?? -1) !== 1 &&
          browserControlDesired &&
          !manualStopped &&
          config.browserAutomation?.autoLike?.enabled === true &&
          (runtime?.isModuleEnabled
            ? runtime.isModuleEnabled("autoLike")
            : config.modules?.autoLike?.enabled === true) &&
          !autoLikeLimitReached,
        active: Boolean(
          (autoLikeTimer || autoLikeInFlight) &&
            (config.browserAutomation?.autoLike?.onlyWhenLive === false ||
              Number(runtime?.roomInfo?.liveStatus ?? -1) === 1)
        ),
        inFlight: autoLikeInFlight,
        nextAt: autoLikeNextAt,
        delayMs: autoLikeLastDelayMs,
        lastBurstCount: autoLikeLastBurstCount,
        generation: autoLikeGeneration,
        sessionTargetClicks: autoLikeSessionTargetClicks,
        sessionClicks: autoLikeSessionClicks,
        limitReached: autoLikeLimitReached,
      },
      sendTransport: runtime?.browserAuto
        ? "browser"
        : snapshot?.sendToBili
          ? "cookie"
          : "disabled",
    };
    return snapshot;
  }

  function clonePlain(value) {
    return JSON.parse(JSON.stringify(value === undefined ? null : value));
  }

  function editableConfigSnapshot() {
    return {
      interactions: clonePlain(config.interactions || {}),
      rules: clonePlain(config.rules || []),
      timers: clonePlain(config.timers || []),
      commands: clonePlain(config.commands || {}),
      points: clonePlain(config.points || {}),
      connection: clonePlain(config.connection || {}),
      automation: clonePlain(config.automation || {}),
      rateLimit: clonePlain(config.rateLimit || {}),
      modules: clonePlain(config.modules || {}),
      pk: clonePlain(config.pk || {}),
      screenshots: clonePlain(config.screenshots || {}),
    };
  }

  function compactGiftCatalogItem(item = {}) {
    return {
      id: Number(item.id || item.giftId || 0),
      giftId: Number(item.giftId || item.id || 0),
      name: item.name || item.giftName || "",
      price: Number(item.price || 0),
      valueText: formatBattery(item.price, item.coinType || item.coin_type || "gold") || "未知",
      coinType: item.coinType || item.coin_type || "",
      icon: item.icon || item.webp || item.imgBasic || item.img_basic || "",
      webp: item.webp || "",
      imgBasic: item.imgBasic || item.img_basic || "",
      gif: item.gif || "",
      roomAvailable: Boolean(item.roomAvailable || item.room_available),
      type: Number(item.type || 0),
      bagGift: Number(item.bagGift || item.bag_gift || 0),
      effect: Number(item.effect || 0),
      desc: item.desc || "",
    };
  }

  function readGiftCatalogSnapshot() {
    const live = runtime?.giftCatalog?.getSnapshot?.();
    if (live?.items?.length) return live;
    const persisted = eventStore.readSnapshot("giftCatalog").giftCatalog || {};
    return {
      roomId: Number(persisted.roomId || 0),
      fetchedAt: Number(persisted.fetchedAt || 0),
      total: Number(persisted.total || persisted.items?.length || 0),
      roomGiftCount: Number(persisted.roomGiftCount || 0),
      items: Array.isArray(persisted.items) ? persisted.items : [],
    };
  }

  function queryGiftCatalog(searchParams = new URLSearchParams()) {
    const catalog = readGiftCatalogSnapshot();
    const keyword = String(searchParams.get("q") || "").trim().toLowerCase();
    const roomOnly = ["1", "true", "yes", "room"].includes(
      String(searchParams.get("roomOnly") || "").toLowerCase()
    );
    const sort = searchParams.get("sort") || "room-price-desc";
    const limit = Math.max(1, Math.min(200, Number(searchParams.get("limit") || 40)));
    const offset = Math.max(0, Number(searchParams.get("offset") || 0));
    const rows = (Array.isArray(catalog.items) ? catalog.items : [])
      .map(compactGiftCatalogItem)
      .filter((item) => item.id && item.name)
      .filter((item) => !roomOnly || item.roomAvailable)
      .filter((item) => {
        if (!keyword) return true;
        return (
          String(item.id).includes(keyword) ||
          item.name.toLowerCase().includes(keyword) ||
          String(item.price || "").includes(keyword)
        );
      })
      .sort((left, right) => {
        if (sort === "price-asc") return Number(left.price || 0) - Number(right.price || 0);
        if (sort === "name") return left.name.localeCompare(right.name, "zh-Hans-CN");
        const roomScore = Number(Boolean(right.roomAvailable)) - Number(Boolean(left.roomAvailable));
        if (sort === "room-price-desc" && roomScore) return roomScore;
        return Number(right.price || 0) - Number(left.price || 0) || left.name.localeCompare(right.name, "zh-Hans-CN");
      });
    const allItems = (Array.isArray(catalog.items) ? catalog.items : []).map(compactGiftCatalogItem);
    return {
      summary: {
        roomId: Number(catalog.roomId || 0),
        fetchedAt: Number(catalog.fetchedAt || 0),
        total: Number(catalog.total || allItems.length || 0),
        roomGiftCount: Number(catalog.roomGiftCount || allItems.filter((item) => item.roomAvailable).length || 0),
        iconCount: allItems.filter((item) => item.icon).length,
        zeroPriceCount: allItems.filter((item) => !Number(item.price || 0)).length,
        queryCount: rows.length,
        roomOnly,
      },
      items: rows.slice(offset, offset + limit),
    };
  }

  function roomIdFromValue(value) {
    try {
      return Number(extractRoomId(value));
    } catch {
      return 0;
    }
  }

  function mergeObject(target, patch, keys) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return;
    for (const key of keys) {
      if (patch[key] === undefined) continue;
      target[key] = clonePlain(patch[key]);
    }
  }

  function mergeInteractionSection(target, name, patch, allowedKeys) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) return;
    target.interactions = target.interactions || {};
    target.interactions[name] = {
      ...(target.interactions[name] || {}),
    };
    mergeObject(target.interactions[name], patch, allowedKeys);
  }

  function mergeEditableConfig(patch = {}, target = config) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      const error = new Error("配置请求格式错误");
      error.statusCode = 400;
      throw error;
    }

    const interactions = patch.interactions || {};
    mergeInteractionSection(target, "welcome", interactions.welcome, [
      "enabled",
      "requireFullName",
      "cooldownSec",
      "userCooldownSec",
      "guardIgnoresBlacklist",
      "blacklist",
      "blacklistIncludes",
      "templates",
      "guardTemplates",
      "specificTemplates",
      "highWealth",
      "timeBuckets",
    ]);
    mergeInteractionSection(target, "gift", interactions.gift, [
      "enabled",
      "cooldownSec",
      "userCooldownSec",
      "aggregateWindowMs",
      "bigThanksMinCoin",
      "dedupeFingerprintWindowMs",
      "minBattery",
      "templates",
      "blindTemplates",
    ]);
    mergeInteractionSection(target, "follow", interactions.follow, [
      "enabled",
      "cooldownSec",
      "userCooldownSec",
      "templates",
    ]);
    mergeInteractionSection(target, "share", interactions.share, [
      "enabled",
      "cooldownSec",
      "userCooldownSec",
      "templates",
    ]);
    mergeInteractionSection(target, "live", interactions.live, ["entryMsg", "goodbyeInfo"]);
    mergeInteractionSection(target, "moderation", interactions.moderation, [
      "showBlockMsg",
      "blockTemplate",
      "keywordAlert",
      "keywordAlertTemplate",
    ]);
    mergeInteractionSection(target, "like", interactions.like, [
      "enabled",
      "minCount",
      "cooldownSec",
      "templates",
    ]);

    if (Array.isArray(patch.rules)) {
      target.rules = clonePlain(patch.rules);
    }
    if (Array.isArray(patch.timers)) {
      target.timers = clonePlain(patch.timers);
    }
    if (patch.commands && typeof patch.commands === "object" && !Array.isArray(patch.commands)) {
      target.commands = {
        ...(target.commands || {}),
      };
      mergeObject(target.commands, patch.commands, [
        "prefixes",
        "allowPublicGiftQuery",
        "allowPublicPkQuery",
        "drawLots",
      ]);
    }
    if (patch.points && typeof patch.points === "object" && !Array.isArray(patch.points)) {
      target.points = {
        ...(target.points || {}),
      };
      mergeObject(target.points, patch.points, [
        "enabled",
        "signInPoints",
        "giftPointsPerBattery",
        "signInStreak",
        "guardPoints",
        "shopItems",
      ]);
    }
    if (patch.connection && typeof patch.connection === "object" && !Array.isArray(patch.connection)) {
      target.connection = {
        ...(target.connection || {}),
      };
      mergeObject(target.connection, patch.connection, ["fanoutHosts", "autoStartSafe"]);
    }
    if (patch.automation && typeof patch.automation === "object" && !Array.isArray(patch.automation)) {
      target.automation = {
        ...(target.automation || {}),
      };
      mergeObject(target.automation, patch.automation, [
        "enabled",
        "autoSendTypes",
        "pauseWelcomeDuringLottery",
        "pauseGiftDuringLottery",
        "queueLimit",
      ]);
    }
    if (patch.rateLimit && typeof patch.rateLimit === "object" && !Array.isArray(patch.rateLimit)) {
      target.rateLimit = {
        ...(target.rateLimit || {}),
      };
      mergeObject(target.rateLimit, patch.rateLimit, [
        "globalSendCooldownSec",
        "spamCooldownSec",
      ]);
    }
    if (patch.pk && typeof patch.pk === "object" && !Array.isArray(patch.pk)) {
      target.pk = {
        ...(target.pk || {}),
      };
      mergeObject(target.pk, patch.pk, ["showRawEvents", "minReportIntervalSec", "investigator"]);
    }
    if (patch.screenshots && typeof patch.screenshots === "object" && !Array.isArray(patch.screenshots)) {
      target.screenshots = {
        ...(target.screenshots || {}),
      };
      mergeObject(target.screenshots, patch.screenshots, [
        "enabled",
        "dir",
        "regions",
        "defaultTrigger",
        "triggers",
      ]);
    }
  }

  function saveConfigFile(source = config) {
    if (!config.__path) {
      const error = new Error("当前配置没有可写路径");
      error.statusCode = 500;
      throw error;
    }
    // 模板文件绝不回写：运行在 example 兜底模式时，改动写到 config.json，之后的启动会优先读它。
    const targetPath = config.__source === "example-fallback"
      ? path.join(path.dirname(config.__path), "config.json")
      : config.__path;
    const draft = clonePlain(source);
    delete draft.__path;
    delete draft.__source;
    const tempPath = `${targetPath}.tmp-${process.pid}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    fs.renameSync(tempPath, targetPath);
    if (targetPath !== config.__path) {
      config.__path = targetPath;
      config.__source = "config.json";
    }
  }

  function persistManagedRoom(target) {
    const roomUrl = target.roomUrl;
    const draft = clonePlain(config);
    draft.__path = config.__path;
    draft.__source = config.__source;
    draft.room = roomUrl;
    draft.browserAutomation = {
      ...(draft.browserAutomation || {}),
      roomUrl,
    };
    try {
      saveConfigFile(draft);
    } catch (error) {
      // 切房已经成功时，配置盘暂时不可写不能把正在工作的浏览器回滚掉。
      warnWithoutBlocking("直播间配置保存失败", error);
    }
    config.room = roomUrl;
    config.browserAutomation = {
      ...(config.browserAutomation || {}),
      roomUrl,
    };
  }

  function applyAndPersistEditableConfig(patch = {}) {
    // 先在克隆上合并并落盘成功，再替换内存配置，避免写盘失败后内存与磁盘分叉。
    const draft = clonePlain(config);
    draft.__path = config.__path;
    draft.__source = config.__source;
    mergeEditableConfig(patch, draft);
    saveConfigFile(draft);
    mergeEditableConfig(patch, config);
  }

  async function restartRuntimeAfterConfigSave() {
    if (!runtime?.running) return false;
    const previous = runtime;
    await startRuntime({
      room: previous.room || config.room,
      speakEndpoint: previous.speakEndpoint || "",
      dryRun: previous.dryRun !== false,
      enablePost: Boolean(previous.enablePost),
      sendToBili: previous.sendToBili,
      biliCookie: "",
      biliMaxChars: previous.biliMaxChars || config.send?.maxChars || 40,
      biliSendCooldownSec: previous.biliSendCooldownMs / 1000 || config.send?.cooldownSec || 8,
      showEvents: previous.showEvents,
      pkShowRawEvents: Boolean(config.pk?.showRawEvents),
      moduleStatus: previous.moduleStatus || config.modules || {},
    });
    runtime?.log("配置", "运营配置已保存，并按当前房间自动重启监听");
    snapshot = runtime?.getSnapshot?.() || snapshot;
    broadcast("snapshot", snapshot);
    return true;
  }

  function rememberStartBody(body = {}) {
    lastStartBody = {
      room: body.room || config.room,
      speakEndpoint: body.speakEndpoint || "",
      dryRun: body.dryRun !== false,
      enablePost: Boolean(body.enablePost),
      sendToBili: Boolean(body.sendToBili),
      biliCookie: "",
      biliMaxChars: Number(body.biliMaxChars || config.send?.maxChars || 40),
      biliSendCooldownSec: Number(body.biliSendCooldownSec || config.send?.cooldownSec || 8),
      fanoutHosts: Math.min(4, Math.max(1, Number(body.fanoutHosts || config.connection?.fanoutHosts || 1))),
      showEvents: Boolean(body.showEvents),
      pkShowRawEvents: Boolean(body.pkShowRawEvents),
      moduleStatus: body.moduleStatus || config.modules || {},
      browserAuto: Boolean(body.browserAuto),
      allowAutoSend: Boolean(body.allowAutoSend),
    };
  }

  function startWatchdog() {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(async () => {
      if (manualStopped || watchdogRestarting || !lastStartBody) return;
      if (browserControlDesired && !browserControlReady()) return;
      const now = Date.now();
      const current = runtime?.getSnapshot?.() || snapshot || {};
      if (current.connected) {
        disconnectedSince = 0;
        return;
      }
      if (!disconnectedSince) disconnectedSince = now;
      const runtimeStopped = runtime && !runtime.running;
      const disconnectedTooLong = Boolean(current.running) && now - disconnectedSince > 45000;
      if (!runtimeStopped && !disconnectedTooLong) return;
      if (now - lastWatchdogRestartAt < 30000) return;

      watchdogRestarting = true;
      lastWatchdogRestartAt = now;
      try {
        const room = current.roomInput || lastStartBody.room || config.room;
        // 故障现场的日志是排障的唯一证据，自动恢复只加分隔线，不清屏。
        runtime?.log?.("守护", "监听异常中断，正在自动恢复");
        await startRuntime({
          ...lastStartBody,
          room,
        });
        runtime?.log?.("守护", "监听已自动恢复");
      } catch (error) {
        remember(logs, {
          id: `${Date.now().toString(36)}-watchdog`,
          at: Date.now(),
          level: "warn",
          label: "守护失败",
          message: error.message || String(error),
          kind: "log",
        });
        broadcast("log", logs[0]);
      } finally {
        disconnectedSince = 0;
        watchdogRestarting = false;
      }
    }, 15000);
  }

  function getSavedLoginPublic() {
    const saved = loadSavedBiliLogin(savedLoginPath);
    return {
      ok: saved.ok,
      savedAt: saved.savedAt || 0,
      account: saved.account || null,
      hasCsrf: Boolean(saved.info?.hasCsrf),
      hasSessdata: Boolean(saved.info?.hasSessdata),
    };
  }

  function resolveBiliCookie(input = "") {
    const provided = extractCookie(input || "");
    if (provided) return provided;
    const saved = loadSavedBiliLogin(savedLoginPath);
    return saved.ok ? saved.cookie : "";
  }

  async function saveLoginAfterCheck(cookie, result = null) {
    const normalized = extractCookie(cookie || "");
    if (!normalized) return null;
    let account = result || null;
    if (!account) {
      account = await checkBiliCookie(normalized);
    }
    if (!account?.ok) return null;
    return saveBiliLogin(savedLoginPath, normalized, account);
  }

  function remember(list, item, limit = 300) {
    list.unshift(item);
    if (list.length > limit) {
      list.length = limit;
    }
  }

  function dropClient(client) {
    clients.delete(client);
    try {
      client.destroy();
    } catch {
      // 客户端已经断开时 destroy 可能重复报错，忽略。
    }
  }

  function sendEvent(res, type, payload) {
    if (res.writableEnded || res.destroyed) {
      dropClient(res);
      return false;
    }
    // 网络停滞的客户端（休眠的 OBS 机器等）不消费数据时，写缓冲会无限堆积，超阈值直接踢掉。
    if (res.writableLength > 1024 * 1024) {
      dropClient(res);
      return false;
    }
    try {
      res.write(`event: ${type}\n`);
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch {
      dropClient(res);
      return false;
    }
  }

  function broadcast(type, payload) {
    for (const client of [...clients]) {
      sendEvent(client, type, payload);
    }
  }

  function attachRuntime(nextRuntime) {
    applyLocalAiServiceState(nextRuntime);
    nextRuntime.on("log", (entry) => {
      if (nextRuntime !== runtime) return;
      remember(logs, entry);
      broadcast("log", entry);
      if (
        ["本地AI", "主动互动"].includes(String(entry?.label || "")) &&
        /失败|超时|不可用/.test(String(entry?.message || ""))
      ) {
        // 真实推理失败后立即广播 LocalAiClient.lastError，不让页面
        // 继续引用旧的 /api/tags 探测结果宣称“AI 正常”。
        snapshot = nextRuntime.getSnapshot?.() || snapshot;
        syncBrowserControlSnapshot();
        broadcast("snapshot", snapshot);
      }
    });
    nextRuntime.on("action", (entry) => {
      if (nextRuntime !== runtime) return;
      remember(actions, entry);
      broadcast("action", entry);
    });
    nextRuntime.on("snapshot", (nextSnapshot) => {
      if (nextRuntime !== runtime) return;
      const previousLiveStatus = Number(snapshot?.room?.liveStatus ?? -1);
      snapshot = nextSnapshot;
      const nextLiveStatus = Number(nextSnapshot?.room?.liveStatus ?? -1);
      if (
        previousLiveStatus !== nextLiveStatus &&
        browserControlDesired &&
        !manualStopped
      ) {
        ensureAutoLikeSchedule(nextLiveStatus === 1);
        if (nextLiveStatus === 1) enqueueStartupMessageOnce(browserControlGeneration);
      }
      // 补回 browserControl/autoLikeSchedule 字段，保证 SSE 推送与轮询拿到同一套字段。
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
    });
  }

  async function ensureLocalAiServiceReady() {
    let pending;
    try {
      pending = Promise.resolve(localAiService.ensureReady());
      localAiServiceState = localAiService.getState?.() || localAiServiceState;
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
      localAiServiceState = (await pending) || localAiService.getState?.() || localAiServiceState;
    } catch (error) {
      localAiServiceState = {
        status: "error",
        message: `本地 AI 检查失败：${error?.message || String(error)}`,
        model: String(config.localAi?.model || ""),
        lastCheckedAt: Date.now(),
      };
    }
    applyLocalAiServiceState();
    // 服务探测会更新 LocalAiClient.available；立即重取运行快照，避免 API/UI
    // 同时出现“模型已就绪”与“AI 不可用”两个互相矛盾的状态。
    snapshot = runtime?.getSnapshot?.() || snapshot;
    syncBrowserControlSnapshot();
    broadcast("snapshot", snapshot);
    return getLocalAiServiceState();
  }

  function getState() {
    syncBrowserControlSnapshot();
    return {
      snapshot,
      logs,
      actions,
      config: {
        room: config.room || "",
        dryRun: config.dryRun !== false,
        speakEndpoint: config.speakEndpoint || "",
        sendToBili: Boolean(config.send?.enabled),
        biliMaxChars: Number(config.send?.maxChars || 40),
        biliSendCooldownSec: Number(config.send?.cooldownSec || 8),
        showAllEvents: Boolean(config.showAllEvents),
        pkShowRawEvents: Boolean(config.pk?.showRawEvents),
        modules: config.modules || {},
        connection: config.connection || {},
        automation: config.automation || {},
        roles: config.roles || {},
        configPath: config.__path,
        editableConfig: editableConfigSnapshot(),
        savedBiliLogin: getSavedLoginPublic(),
      },
    };
  }

  function wait(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
  }

  async function waitForDoctorStableSnapshot(timeoutMs = 6000) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    let latest = runtime?.getSnapshot?.() || snapshot;
    while (Date.now() < deadline) {
      latest = runtime?.getSnapshot?.() || latest || snapshot;
      const running = Boolean(latest?.running);
      const connected = Boolean(running && latest?.connected);
      const lastRawAt = Number(latest?.captureHealth?.lastRawAt || 0);
      if (connected || (running && lastRawAt)) break;
      await wait(250);
    }
    latest = runtime?.getSnapshot?.() || latest || snapshot;
    snapshot = latest;
    broadcast("snapshot", snapshot);
    return snapshot;
  }

  function applyModuleConfig(targetConfig, moduleStatus = {}) {
    if (!moduleStatus || typeof moduleStatus !== "object") return;
    targetConfig.modules = targetConfig.modules || {};
    for (const [name, value] of Object.entries(moduleStatus)) {
      targetConfig.modules[name] = {
        ...(targetConfig.modules[name] || {}),
        ...(typeof value === "object" ? value : {}),
        enabled: typeof value === "object" ? value.enabled !== false : Boolean(value),
      };
    }
  }

  function autoSendEnabledFromStatus(moduleStatus = {}) {
    if (moduleStatus?.autoSend?.enabled !== undefined) return moduleStatus.autoSend.enabled !== false;
    if (typeof moduleStatus?.autoSend === "boolean") return Boolean(moduleStatus.autoSend);
    return config.modules?.autoSend?.enabled !== false;
  }

  function protectUnverifiedAutoSend(body = {}) {
    // forceSafe 是体检/自动安全监听的硬保险：调用方显式要求只监听时，
    // 绝不允许被浏览器托管路径静默升级成真实发送。
    if (body.forceSafe === true) {
      return {
        blocked: false,
        body: {
          ...body,
          browserAuto: false,
          dryRun: true,
          enablePost: false,
          sendToBili: false,
          allowAutoSend: false,
        },
      };
    }
    if (body.browserAuto === true) {
      return {
        blocked: false,
        body: {
          ...body,
          dryRun: false,
          enablePost: false,
          sendToBili: true,
          allowAutoSend: true,
          fanoutHosts: 1,
          moduleStatus: {
            ...(body.moduleStatus || {}),
            autoSend: {
              ...(typeof body.moduleStatus?.autoSend === "object"
                ? body.moduleStatus.autoSend
                : config.modules?.autoSend || {}),
              enabled: true,
            },
          },
        },
      };
    }
    const dryRun = body.dryRun !== false;
    const sendToBili = Boolean(body.sendToBili);
    const autoSendEnabled = autoSendEnabledFromStatus(body.moduleStatus || {});
    if (!sendToBili || dryRun || !autoSendEnabled || body.allowAutoSend === true) {
      return { body, blocked: false };
    }
    const moduleStatus = {
      ...(body.moduleStatus || {}),
      autoSend: {
        ...(typeof body.moduleStatus?.autoSend === "object" ? body.moduleStatus.autoSend : config.modules?.autoSend || {}),
        enabled: false,
      },
    };
    return {
      blocked: true,
      body: {
        ...body,
        moduleStatus,
        autoSendBlocked: true,
        autoSendBlockReason:
          "抓取体检未完全通过，后端已降级为允许手动发 B站，不自动托管",
      },
    };
  }

  // startRuntime 的所有入口（页面按钮、watchdog、浏览器 ready 事件、配置保存重启）
  // 都可能并发触发；不串行会产生无人停止的僵尸 runtime，双份收流甚至双发弹幕。
  let startRuntimeChain = Promise.resolve();
  // 每次用户显式停止 +1；链上排队的启动请求出队时发现代际已变就直接作废，
  // 否则陈旧请求会清掉 manualStopped、污染 lastStartBody，让 watchdog 把停掉的机器人复活。
  let stopEpoch = 0;

  function startRuntime(body) {
    const epochAtEnqueue = stopEpoch;
    const next = startRuntimeChain.then(() => startRuntimeInner(body, epochAtEnqueue));
    startRuntimeChain = next.catch(() => {});
    return next;
  }

  async function startRuntimeInner(body, epochAtEnqueue = stopEpoch) {
    body = { ...(body || {}) };
    if (epochAtEnqueue !== stopEpoch) {
      return runtime?.getSnapshot?.() || snapshot;
    }
    manualStopped = false;
    if (browserControlDesired && browserControlReady() && body.forceSafe !== true) body.browserAuto = true;
    const protectedStart = protectUnverifiedAutoSend(body || {});
    body = protectedStart.body;
    const requestedRoom = body.room || config.room;
    const requestedRoomId = roomIdFromValue(requestedRoom);
    const currentRoomId = Number(runtime?.roomInfo?.roomId || roomIdFromValue(runtime?.room || ""));
    if (
      body.browserAuto === true &&
      runtime?.running &&
      runtime.connected &&
      runtime.browserAuto &&
      requestedRoomId &&
      requestedRoomId === currentRoomId
    ) {
      runtime.dryRun = false;
      runtime.enablePost = false;
      runtime.sendToBili = true;
      runtime.setModule("autoSend", true, { silent: true });
      rememberStartBody(body);
      snapshot = runtime.getSnapshot();
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
      return snapshot;
    }
    rememberStartBody(body);
    startWatchdog();
    if (runtime) {
      runtime.stop("重新启动");
      runtime = null;
    }
    // 保留日志历史便于排障，只推一条分隔线；换房间的清屏在 startBrowserControl 里做。
    remember(logs, {
      id: `${Date.now().toString(36)}-restart`,
      at: Date.now(),
      level: "info",
      label: "重启",
      message: "———— 重新启动监听 ————",
      kind: "log",
    });
    broadcast("log", logs[0]);

    const nextConfig = JSON.parse(JSON.stringify(config));
    delete nextConfig.__path;
    delete nextConfig.__source;
    nextConfig.pk = {
      ...(nextConfig.pk || {}),
      showRawEvents: Boolean(body.pkShowRawEvents),
    };
    nextConfig.connection = {
      ...(nextConfig.connection || {}),
      fanoutHosts: Math.min(4, Math.max(1, Number(body.fanoutHosts || nextConfig.connection?.fanoutHosts || 1))),
    };
    applyModuleConfig(nextConfig, body.moduleStatus);

    runtime = new BotRuntime({
      config: nextConfig,
      room: body.room || nextConfig.room,
      dryRun: body.dryRun !== false,
      showEvents: Boolean(body.showEvents),
      speakEndpoint: body.speakEndpoint || "",
      enablePost: Boolean(body.enablePost),
      sendToBili: Boolean(body.sendToBili),
      biliCookie: body.browserAuto ? "" : resolveBiliCookie(body.biliCookie || ""),
      biliMaxChars: Number(body.biliMaxChars || nextConfig.send?.maxChars || 40),
      biliSendCooldownSec: Number(
        body.biliSendCooldownSec || nextConfig.send?.cooldownSec || 8
      ),
      browserController,
      browserAuto: Boolean(body.browserAuto),
    });
    attachRuntime(runtime);
    await runtime.start();
    if (protectedStart.blocked) {
      runtime.log("发送保护", body.autoSendBlockReason, { level: "warn" });
    }
    snapshot = runtime.getSnapshot();
    broadcast("snapshot", snapshot);
    return snapshot;
  }

  function safeAutoStartPayload(reason = "服务启动自动安全监听") {
    return {
      room: snapshot.roomInput || config.room,
      speakEndpoint: "",
      dryRun: true,
      enablePost: false,
      sendToBili: false,
      forceSafe: true,
      biliCookie: "",
      biliMaxChars: Number(config.send?.maxChars || 40),
      biliSendCooldownSec: Number(config.send?.cooldownSec || 8),
      fanoutHosts: Math.min(4, Math.max(1, Number(config.connection?.fanoutHosts || 1))),
      showEvents: Boolean(config.showAllEvents),
      pkShowRawEvents: Boolean(config.pk?.showRawEvents),
      moduleStatus: config.modules || {},
      reason,
    };
  }

  async function startSafeAutoListen(reason = "服务启动自动安全监听") {
    if (config.connection?.autoStartSafe === false) return false;
    if (manualStopped || runtime?.running) return false;
    const room = snapshot.roomInput || config.room;
    if (!room) return false;
    try {
      await startRuntime(safeAutoStartPayload(reason));
      runtime?.log?.("启动", `${reason}：已自动进入只监听模式，不会真实发送`);
      snapshot = runtime?.getSnapshot?.() || snapshot;
      broadcast("snapshot", snapshot);
      return true;
    } catch (error) {
      remember(logs, {
        id: `${Date.now().toString(36)}-auto-start`,
        at: Date.now(),
        level: "warn",
        label: "自动监听失败",
        message: error.message || String(error),
        kind: "log",
      });
      broadcast("log", logs[0]);
      return false;
    }
  }

  async function ensureBrowserAutoRuntime(reason = "浏览器已就绪") {
    if (!browserControlDesired || manualStopped || !browserControlReady()) {
      syncBrowserControlSnapshot();
      return snapshot;
    }
    // 只复用同一代的启动 promise；换房/重开后旧代的启动结果不能拿来当新房间的。
    // await 旧代 promise 醒来后必须重查：并发调用可能已经建好本代的启动，直接复用而不是再建一份。
    while (browserAutoStartPromise) {
      if (browserAutoStartPromise.generation === browserControlGeneration) {
        return browserAutoStartPromise;
      }
      const waited = browserAutoStartPromise;
      await waited.catch(() => {});
      // 已结算的旧 promise 若还挂在槽位上（finally 因被替换未清），这里兜底清掉保证循环收敛
      if (browserAutoStartPromise === waited) browserAutoStartPromise = null;
      if (!browserControlDesired || manualStopped || !browserControlReady()) {
        syncBrowserControlSnapshot();
        return snapshot;
      }
    }

    const generation = browserControlGeneration;
    const room = browserControlRoom || config.room;
    const roomId = roomIdFromValue(room);
    const currentRoomId = Number(runtime?.roomInfo?.roomId || roomIdFromValue(runtime?.room || ""));
    if (runtime?.running && runtime.browserAuto && roomId && roomId === currentRoomId) {
      enqueueStartupMessageOnce(generation);
      ensureAutoLikeSchedule(true);
      syncBrowserControlSnapshot();
      return snapshot;
    }

    const currentModules = runtime?.moduleStatus || config.modules || {};
    const startPromise = (async () => {
      if (generation !== browserControlGeneration || !browserControlDesired || !browserControlReady()) {
        return syncBrowserControlSnapshot();
      }
      const nextSnapshot = await startRuntime({
        room,
        speakEndpoint: "",
        dryRun: false,
        enablePost: false,
        sendToBili: true,
        allowAutoSend: true,
        browserAuto: true,
        biliCookie: "",
        biliMaxChars: Number(config.send?.maxChars || 40),
        biliSendCooldownSec: Number(config.send?.cooldownSec || 8),
        fanoutHosts: 1,
        showEvents: Boolean(config.showAllEvents),
        pkShowRawEvents: Boolean(config.pk?.showRawEvents),
        moduleStatus: {
          ...currentModules,
          autoSend: {
            ...(currentModules.autoSend || {}),
            enabled: true,
          },
        },
        reason,
      });
      const startedRuntime = runtime;
      if (generation !== browserControlGeneration || !browserControlDesired) {
        // 只能停掉本次启动出来的实例；此时全局 runtime 可能已经换成新房间的了。
        if (startedRuntime && startedRuntime === runtime) {
          startedRuntime.stop("浏览器托管已取消");
        }
      } else {
        enqueueStartupMessageOnce(generation);
        ensureAutoLikeSchedule(true);
      }
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
      return nextSnapshot;
    })();
    // 按 promise 身份清槽位：并发场景下按 generation 数值判等会把别人仍在飞行的 promise 清掉
    const wrapped = startPromise.finally(() => {
      if (browserAutoStartPromise === wrapped) {
        browserAutoStartPromise = null;
      }
    });
    wrapped.generation = generation;
    browserAutoStartPromise = wrapped;
    return wrapped;
  }

  async function startBrowserControl(body = {}) {
    const requestedValue = Object.prototype.hasOwnProperty.call(body, "room")
      ? body.room
      : browserControlRoom || config.room;
    const target = normalizeBilibiliRoomInput(requestedValue);
    if (!target) {
      const error = new Error("请先填写有效的 B站直播间 URL 或房间号");
      error.statusCode = 400;
      throw error;
    }
    // 链接合法后才检查 AI，并与 B 站页面启动并行：登录窗口不应
    // 因 Ollama 最长 15 秒的恢复轮询而迟迟不出现。
    const localAiReadyPromise = ensureLocalAiServiceReady();
    const room = target.roomUrl;
    const previousDesired = browserControlDesired;
    const previousRoom = browserControlRoom;
    const previousManualStopped = manualStopped;
    const previousRoomId = Number(
      normalizeBilibiliRoomInput(browserControlRoom)?.roomId ||
        getBrowserControlState()?.roomId ||
        0
    );
    const nextRoomId = target.roomId;
    const roomChanged = Boolean(previousRoomId && previousRoomId !== nextRoomId);
    const newBrowserSession = !browserControlDesired || roomChanged;
    if (newBrowserSession) {
      browserControlGeneration += 1;
    }
    if (roomChanged) {
      clearAutoLikeSchedule();
      const pendingStart = browserAutoStartPromise;
      if (pendingStart) await pendingStart.catch(() => {});
      if (runtime) {
        runtime.stop("切换直播间");
        snapshot = runtime.getSnapshot?.() || snapshot;
        runtime = null;
      }
      lastStartBody = null;
      disconnectedSince = 0;
      logs.length = 0;
      actions.length = 0;
      broadcast("clear", {});
    }
    browserControlDesired = true;
    browserControlRoom = room;
    manualStopped = false;
    if (browserController.resetEmergencyStop && getBrowserControlState()?.emergencyStopped) {
      browserController.resetEmergencyStop();
    }
    try {
      await browserController.start({ room });
    } catch (error) {
      clearAutoLikeSchedule();
      browserControlDesired = previousDesired;
      browserControlRoom = previousRoom;
      manualStopped = previousManualStopped;
      // 使失败切房前派生的异步任务全部失效。
      browserControlGeneration += 1;
      if (roomChanged && previousRoom) {
        await browserController.start({ room: previousRoom }).catch((restoreError) => {
          warnWithoutBlocking("直播间恢复失败", restoreError);
        });
      }
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
      throw error;
    }
    persistManagedRoom(target);
    if (newBrowserSession) {
      resetAutoLikeSession(browserControlGeneration, nextRoomId);
    } else {
      ensureAutoLikeSession();
    }
    await localAiReadyPromise;
    syncBrowserControlSnapshot();
    if (browserControlReady()) {
      await ensureBrowserAutoRuntime("网页登录已就绪，自动启动托管");
      ensureAutoLikeSchedule(true);
    } else {
      clearAutoLikeSchedule();
    }
    syncBrowserControlSnapshot();
    broadcast("snapshot", snapshot);
    return {
      state: getBrowserControlState(),
      snapshot,
      waitingLogin: !browserControlReady(),
    };
  }

  async function stopBrowserControl(reason = "网页停止自动托管") {
    clearAutoLikeSchedule();
    // 显式停止只暂停动作，不清空当日当房的预算；反复停启不能
    // 绕过用户要求的 1–2 万次硬上限。
    browserControlDesired = false;
    browserControlGeneration += 1;
    stopEpoch += 1;
    manualStopped = true;
    // 显式停止后 watchdog 不允许拿旧启动参数复活机器人
    lastStartBody = null;
    disconnectedSince = 0;
    runtime?.stop?.(reason);
    await browserController.emergencyStop?.(reason);
    snapshot = runtime?.getSnapshot?.() || snapshot;
    syncBrowserControlSnapshot();
    broadcast("snapshot", snapshot);
    return {
      state: getBrowserControlState(),
      snapshot,
    };
  }

  function handleBrowserControlState() {
    if (!browserControlReady()) clearAutoLikeSchedule();
    syncBrowserControlSnapshot();
    broadcast("snapshot", snapshot);
  }

  function handleBrowserControlReady() {
    handleBrowserControlState();
    ensureBrowserAutoRuntime("检测到网页登录，自动启动托管")
      .then(() => {
        ensureAutoLikeSchedule(true);
        syncBrowserControlSnapshot();
        broadcast("snapshot", snapshot);
      })
      .catch((error) => {
        remember(logs, {
          id: `${Date.now().toString(36)}-browser-auto-start`,
          at: Date.now(),
          level: "warn",
          label: "网页托管启动失败",
          message: error.message || String(error),
          kind: "log",
        });
        broadcast("log", logs[0]);
      });
  }

  function handleBrowserControlNotReady() {
    clearAutoLikeSchedule();
    handleBrowserControlState();
  }

  async function handleBrowserDomChat(event = {}) {
    const acknowledge = (result) => {
      try {
        browserController.acknowledgeChat?.(event.id, result);
      } catch {
        // Observation must remain live even if a custom controller cannot ack.
      }
    };
    if (!browserControlDesired || manualStopped) {
      acknowledge({ ok: true, skipped: true, reason: "浏览器自动托管未启用" });
      return;
    }
    try {
      await ensureBrowserAutoRuntime("网页公屏检测到弹幕，自动启动托管");
      if (
        !browserControlDesired ||
        manualStopped ||
        !runtime?.running ||
        !runtime?.browserAuto
      ) {
        acknowledge({ ok: false, skipped: true, reason: "浏览器自动托管尚未就绪" });
        return;
      }
      const result = runtime.ingestVisible({
        ...event,
        kind: "chat",
        source: event.source || "browser_controller_dom",
        bridgeVersion: event.bridgeVersion || "browser-controller-dom-v1",
        roomId: Number(event.roomId || event.room_id || browserController.getState?.()?.roomId || 0),
        chatText: event.chatText || event.text || "",
        text: event.text || event.chatText || "",
      });
      acknowledge(result);
      snapshot = runtime.getSnapshot();
      syncBrowserControlSnapshot();
      broadcast("snapshot", snapshot);
    } catch (error) {
      const message = error.message || String(error);
      acknowledge({ ok: false, error: message });
      remember(logs, {
        id: `${Date.now().toString(36)}-browser-dom-chat`,
        at: Date.now(),
        level: "warn",
        label: "网页弹幕接入失败",
        message,
        kind: "log",
      });
      broadcast("log", logs[0]);
    }
  }

  browserController.on?.("state", handleBrowserControlState);
  browserController.on?.("ready", handleBrowserControlReady);
  browserController.on?.("not-ready", handleBrowserControlNotReady);
  browserController.on?.("chat", handleBrowserDomChat);
  // 服务重启后立即恢复当日点赞进度，即使尚未打开浏览器，
  // 页面也不会把已经成功的点赞数错显为 0。
  resetAutoLikeSession(browserControlGeneration, currentAutoLikeRoomId());
  syncBrowserControlSnapshot();

  function applyRuntimeCookie(cookie, account = {}, reason = "登录态已更新") {
    if (!runtime?.running || !cookie) return false;
    if (typeof runtime.applyBiliLogin === "function") {
      runtime.applyBiliLogin(cookie, account, reason);
    } else {
      runtime.biliCookie = cookie;
      runtime.log("登录态", `${reason}，已应用到发送/权限；弹幕监听不重启`);
    }
    snapshot = runtime?.getSnapshot?.() || snapshot;
    broadcast("snapshot", snapshot);
    return true;
  }

  async function handleRequest(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      res.__request = req;
      res.__pathname = url.pathname;

      if (!isTrustedOrigin(req, url.pathname)) {
        sendJson(res, 403, { error: "不允许的请求来源" });
        return;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          ...corsHeaders(req, url.pathname),
          "Cache-Control": "no-store",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, getState());
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/overlays") {
        sendJson(res, 200, {
          ok: true,
          ...overlayExportService.getState(),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/overlays/export") {
        const body = await readJsonBody(req);
        const result = await overlayExportService.generate({
          format: body.format || "gif",
          mode: body.mode || (body.format === "png" ? "static" : "scroll"),
          includeWebm: body.includeWebm !== false,
          baseUrl: localRequestBaseUrl(req),
        });
        sendJson(res, 200, { ok: true, result, state: overlayExportService.getState() });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/overlays/files/")) {
        const filename = url.pathname.slice("/api/overlays/files/".length);
        const filePath = overlayExportService.resolveArtifact(filename);
        if (!filePath) {
          sendJson(res, 404, { error: "素材不存在，请先点击生成" });
          return;
        }
        sendDownloadFile(res, filePath);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        sendJson(res, 200, {
          ok: true,
          config: editableConfigSnapshot(),
          configPath: config.__path,
          snapshot,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/audit") {
        const room = url.searchParams.get("room") || snapshot.room?.roomId || "";
        const day = url.searchParams.get("day") || "";
        const report = runBoundedAudit({ day, room, roomLiveStatus: snapshot.room?.liveStatus });
        if (url.searchParams.get("format") === "text") {
          sendText(res, 200, printAuditText(report));
          return;
        }
        if (requestWantsHtml(req, url)) {
          sendText(res, 200, renderAuditHtml(report), "text/html; charset=utf-8");
          return;
        }
        sendJson(res, 200, auditResponse(report));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/gift-catalog") {
        sendJson(res, 200, { ok: true, ...queryGiftCatalog(url.searchParams) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/gift-catalog/refresh") {
        const body = await readJsonBody(req);
        const roomId =
          Number(body.roomId || runtime?.roomInfo?.roomId || snapshot?.room?.roomId || 0) ||
          roomIdFromValue(body.room || config.room);
        if (!roomId) {
          sendJson(res, 400, { error: "请先填写直播间房间号，再刷新礼物图鉴" });
          return;
        }
        const catalog = runtime?.refreshGiftCatalog
          ? await runtime.refreshGiftCatalog(roomId)
          : await new GiftCatalog({ eventStore }).refresh(roomId);
        if (!catalog) {
          sendJson(res, 502, { error: "礼物图鉴刷新失败，请稍后重试" });
          return;
        }
        if (runtime) {
          snapshot = runtime.getSnapshot();
          broadcast("snapshot", snapshot);
        }
        sendJson(res, 200, { ok: true, catalog: queryGiftCatalog(new URLSearchParams({ limit: "40" })), snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const body = await readJsonBody(req);
        applyAndPersistEditableConfig(body.config || body);
        const restarted = body.restart !== false ? await restartRuntimeAfterConfigSave() : false;
        sendJson(res, 200, {
          ok: true,
          restarted,
          config: editableConfigSnapshot(),
          configPath: config.__path,
          snapshot,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        res.write(": connected\n\n");
        // 断开与 close 事件之间存在窗口，write 会异步冒出 error；没有监听器就是 uncaughtException。
        res.on("error", () => dropClient(res));
        req.on("error", () => dropClient(res));
        req.on("close", () => clients.delete(res));
        clients.add(res);
        sendEvent(res, "snapshot", snapshot);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/image") {
        const imageUrl = url.searchParams.get("url") || "";
        if (!isAllowedImageUrl(imageUrl)) {
          sendJson(res, 400, { error: "只允许代理 B 站图片地址" });
          return;
        }
        const response = await fetch(imageUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
            Referer: "https://live.bilibili.com/",
          },
          signal: AbortSignal.timeout(10000),
        });
        if (!response.ok) {
          sendJson(res, response.status, { error: `图片获取失败: HTTP ${response.status}` });
          return;
        }
        const contentLength = Number(response.headers.get("content-length") || 0);
        if (contentLength > 5 * 1024 * 1024) {
          sendJson(res, 502, { error: "图片过大，拒绝代理" });
          return;
        }
        const upstreamType = response.headers.get("content-type") || "image/png";
        const lowerType = upstreamType.toLowerCase();
        const imageTypeMap = new Map([
          ["png", "image/png"],
          ["jpg", "image/jpeg"],
          ["jpeg", "image/jpeg"],
          ["webp", "image/webp"],
          ["gif", "image/gif"],
        ]);
        const contentType =
          lowerType.startsWith("image/") ? upstreamType : imageTypeMap.get(lowerType.split(";")[0].trim()) || "";
        if (!contentType) {
          sendJson(res, 400, { error: "目标不是图片" });
          return;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length > 5 * 1024 * 1024) {
          sendJson(res, 502, { error: "图片过大，拒绝代理" });
          return;
        }
        res.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": buffer.length,
          "Cache-Control": "public, max-age=86400",
        });
        res.end(buffer);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/start") {
        const body = await readJsonBody(req);
        const nextSnapshot = await startRuntime(body);
        sendJson(res, 200, { ok: true, snapshot: nextSnapshot });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/browser-control/state") {
        syncBrowserControlSnapshot();
        sendJson(res, 200, {
          ok: true,
          desired: browserControlDesired,
          state: getBrowserControlState(),
          snapshot,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/browser-control/start") {
        const body = await readJsonBody(req);
        const result = await startBrowserControl(body);
        sendJson(res, 200, { ok: true, desired: browserControlDesired, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/local-ai/start") {
        const localAiService = await ensureLocalAiServiceReady();
        sendJson(res, 200, {
          ok: localAiService.status === "ready",
          localAiService,
          snapshot,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/browser-control/stop") {
        const body = await readJsonBody(req);
        const result = await stopBrowserControl(body.reason || "网页停止自动托管");
        sendJson(res, 200, { ok: true, desired: browserControlDesired, ...result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/stop") {
        await stopBrowserControl("网页停止");
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/simulate") {
        const body = await readJsonBody(req);
        if (!runtime) {
          runtime = new BotRuntime({ config, room: config.room, dryRun: true });
          attachRuntime(runtime);
        }
        snapshot = runtime.simulate(body.kind || "enter");
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/self-test") {
        const body = await readJsonBody(req);
        const result = runAssistantSelfTest({
          config,
          room: body.room || runtime?.roomInput || config.room,
          roomId: runtime?.roomInfo?.roomId || roomIdFromValue(body.room || config.room),
        });
        sendJson(res, result.ok ? 200 : 500, selfTestResponse(result));
        return;
      }

      if ((req.method === "POST" || req.method === "GET") && url.pathname === "/api/doctor") {
        const body =
          req.method === "POST"
            ? await readJsonBody(req)
            : {
                room: url.searchParams.get("room") || "",
                day: url.searchParams.get("day") || "",
                scope: url.searchParams.get("scope") || "all",
                startSafely: false,
              };
        let currentSnapshot = snapshot;
        const startSafely = req.method === "POST" && Boolean(body.startSafely);
        if (startSafely) {
          const room = body.room || runtime?.room || snapshot.roomInput || config.room;
          if (!room) {
            sendJson(res, 400, { ok: false, error: "先粘贴 B站直播间链接或房间号" });
            return;
          }
          currentSnapshot = await startRuntime({
            ...body,
            room,
            dryRun: true,
            sendToBili: false,
            enablePost: false,
            forceSafe: true,
          });
          currentSnapshot = await waitForDoctorStableSnapshot();
        } else if (runtime?.getSnapshot) {
          currentSnapshot = runtime.getSnapshot();
          snapshot = currentSnapshot;
        }
        const roomValue = body.room || currentSnapshot.room?.roomId || currentSnapshot.roomInput || runtime?.room || config.room;
        const roomId = Number(currentSnapshot.room?.roomId || roomIdFromValue(roomValue) || 0);
        const selfTest = runAssistantSelfTest({
          config,
          room: roomValue || config.room,
          roomId,
        });
        const report = runBoundedAudit({
          day: body.day || "",
          room: roomId || "",
          roomLiveStatus: currentSnapshot.room?.liveStatus,
        });
        const doctor = doctorResponse({ snapshot: currentSnapshot, selfTest, report });
        const payload = { ok: true, ...doctor };
        if (req.method === "GET" && url.searchParams.get("format") === "text") {
          sendText(res, 200, payload.text || "");
          return;
        }
        if (req.method === "GET" && requestWantsHtml(req, url)) {
          sendText(res, 200, renderDoctorHtml(payload), "text/html; charset=utf-8");
          return;
        }
        sendJson(res, 200, payload);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/ingest-visible") {
        const body = await readJsonBody(req);
        if (!runtime) {
          runtime = new BotRuntime({ config, room: body.room || config.room, dryRun: true });
          attachRuntime(runtime);
        }
        const result = runtime.ingestVisible(body);
        snapshot = runtime.getSnapshot();
        broadcast("snapshot", snapshot);
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, result, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/report") {
        const body = await readJsonBody(req);
        if (!runtime) {
          runtime = new BotRuntime({ config, room: config.room, dryRun: true });
          attachRuntime(runtime);
        }
        snapshot = runtime.triggerReport(body.kind || "gift");
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/pk/retry") {
        const body = await readJsonBody(req);
        if (!runtime) {
          runtime = new BotRuntime({ config, room: body.room || config.room, dryRun: true });
          attachRuntime(runtime);
        }
        const result = runtime.retryPkInvestigation?.(body.roomId || body.room || 0) || {
          ok: false,
          error: "当前运行时不支持 PK 重试",
        };
        snapshot = runtime.getSnapshot();
        broadcast("snapshot", snapshot);
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, result, snapshot, error: result.error });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/send") {
        const body = await readJsonBody(req);
        const requestedDryRun = body.dryRun !== false;
        const requestedSendToBili = body.sendToBili === true;
        if (!runtime) {
          runtime = new BotRuntime({
            config,
            room: body.room || config.room,
            dryRun: requestedDryRun,
            sendToBili: requestedSendToBili,
            biliCookie: resolveBiliCookie(body.biliCookie || ""),
            biliMaxChars: body.biliMaxChars || config.send?.maxChars || 40,
            biliSendCooldownSec:
              body.biliSendCooldownSec || config.send?.cooldownSec || 8,
          });
          attachRuntime(runtime);
        } else {
          runtime.biliCookie = resolveBiliCookie(body.biliCookie || runtime.biliCookie);
          runtime.dryRun = requestedDryRun;
          runtime.sendToBili = requestedSendToBili;
          runtime.biliMaxChars = Number(
            body.biliMaxChars || runtime.biliMaxChars || 40
          );
        }
        const result = await runtime.sendTextToBili(body.text || "");
        snapshot = runtime.getSnapshot();
        sendJson(res, result.ok ? 200 : 400, { ok: result.ok, result, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/send-settings") {
        let body = await readJsonBody(req);
        if (runtime?.browserAuto && browserControlDesired) body = { ...body, browserAuto: true };
        const protectedSendSettings = protectUnverifiedAutoSend(body || {});
        body = protectedSendSettings.body;
        if (!runtime) {
          runtime = new BotRuntime({
            config,
            room: body.room || config.room,
            dryRun: true,
          });
          attachRuntime(runtime);
        }
        const cookie = resolveBiliCookie(body.biliCookie || "");
        runtime.biliCookie = cookie;
        if (body.dryRun !== undefined) runtime.dryRun = body.dryRun !== false;
        runtime.sendToBili = Boolean(body.sendToBili);
        runtime.biliMaxChars = Number(body.biliMaxChars || runtime.biliMaxChars || 40);
        runtime.biliSendCooldownMs =
          Number(body.biliSendCooldownSec || runtime.biliSendCooldownMs / 1000 || 8) *
          1000;
        if (body.moduleStatus && typeof body.moduleStatus === "object") {
          for (const [name, value] of Object.entries(body.moduleStatus)) {
            runtime.setModule(name, value?.enabled !== false, { silent: true });
          }
        }
        if (protectedSendSettings.blocked) {
          runtime.log("发送保护", body.autoSendBlockReason, { level: "warn" });
        }
        if (extractCookie(body.biliCookie || "")) {
          saveLoginAfterCheck(cookie).catch((error) => {
            runtime?.log("登录态保存失败", error.message, { level: "warn" });
          });
        }
        runtime.log(
          "发送设置",
          `B站发送：${runtime.sendToBili ? "开启" : "关闭"}；Cookie：${
            runtime.biliCookie ? "已填写" : "未填写"
          }`
        );
        snapshot = runtime.getSnapshot();
        broadcast("snapshot", snapshot);
        sendJson(res, 200, {
          ok: true,
          snapshot,
          autoSendBlocked: Boolean(protectedSendSettings.blocked),
          autoSendBlockReason: body.autoSendBlockReason || "",
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/history/gifts") {
        const giftName = url.searchParams.get("gift") || url.searchParams.get("giftName") || "";
        const query = {
          range: url.searchParams.get("range") || "today",
          roomId: Number(url.searchParams.get("roomId") || url.searchParams.get("room") || 0),
          userName: url.searchParams.get("user") || url.searchParams.get("userName") || "",
          giftName,
          blindOnly:
            url.searchParams.get("blind") === "1" ||
            /盲盒/.test(giftName),
        };
        // 无 runtime 时也不能把待网页核对的补记算进统计
        const result = runtime?.queryGiftHistory
          ? runtime.queryGiftHistory(query)
          : summarizeGifts(
              (eventStore.queryGiftRows ? eventStore.queryGiftRows(query) : []).filter(
                (row) => row.needsVisualCheck !== true && String(row.source || "") !== "danmu_gift_fallback"
              )
            );
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/history/chats") {
        const roomId = Number(
          url.searchParams.get("roomId") ||
            url.searchParams.get("room") ||
            runtime?.roomInfo?.roomId ||
            snapshot?.room?.roomId ||
            0
        );
        const userName = url.searchParams.get("user") || "";
        const userId = Number(url.searchParams.get("userId") || 0);
        const daysBack = Number(url.searchParams.get("days") || 3);
        const result =
          userName || userId
            ? eventStore.queryChatCounts({
                roomId,
                userName,
                userId,
                daysBack,
              })
            : eventStore.queryChatSummary({
                roomId,
                daysBack,
              });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/guard-board") {
        const result = runtime?.getGuardBoard
          ? runtime.getGuardBoard()
          : eventStore.queryGuards({ range: url.searchParams.get("range") || "month" });
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/guard-board/import") {
        const body = await readJsonBody(req);
        const roomId = Number(
          body.roomId ||
            body.room ||
            runtime?.roomInfo?.roomId ||
            snapshot?.room?.roomId ||
            0
        );
        const result = eventStore.importManualGuards({
          text: body.text || "",
          rows: Array.isArray(body.rows) ? body.rows : [],
          roomId,
        });
        if (runtime) {
          runtime.log("掉舰榜", `已手工导入/修正 ${result.imported} 条大航海记录`);
          // 舰长板有 5 秒缓存，导入后必须失效，否则响应和广播里还是旧板
          runtime.lastGuardBoardAt = 0;
          snapshot = runtime.getSnapshot();
          broadcast("snapshot", snapshot);
        }
        sendJson(res, 200, { ok: true, result, snapshot });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/screenshots/recent") {
        const service = runtime?.screenshotService || new ScreenshotService(config, eventStore);
        const result = service.listRecent(Number(url.searchParams.get("limit") || 20));
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/points/export.csv") {
        if (!runtime?.pointsEngine) {
          sendJson(res, 400, { error: "积分系统还没有启动" });
          return;
        }
        const csv = runtime.pointsEngine.exportCsv(runtime.roomInfo || snapshot.room || {}, {
          range: url.searchParams.get("range") || "month",
        });
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="bilibili-points.csv"',
          "Cache-Control": "no-store",
        });
        res.end(csv);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/points/redemption") {
        const body = await readJsonBody(req);
        if (!runtime?.pointsEngine) {
          sendJson(res, 400, { error: "积分系统还没有启动" });
          return;
        }
        const result = runtime.pointsEngine.markRedemption(
          body.orderId,
          body.status || "done",
          runtime.roomInfo || snapshot.room || {},
          {
            userName: snapshot.biliAccountName || runtime.biliAccountName || "主播",
            note: body.note || body.remark || body.reason || "",
          }
        );
        if (!result) {
          sendJson(res, 404, { error: "没找到这条兑换订单" });
          return;
        }
        runtime.log(
          "积分商城",
          `${result.userName} 的 ${result.itemName} 已标记${result.status === "done" ? "完成" : "取消"}${result.note ? `：${result.note}` : ""}`
        );
        snapshot = runtime.getSnapshot();
        broadcast("snapshot", snapshot);
        sendJson(res, 200, { ok: true, result, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/points/adjust") {
        const body = await readJsonBody(req);
        if (!runtime?.pointsEngine) {
          sendJson(res, 400, { error: "积分系统还没有启动" });
          return;
        }
        const result = runtime.pointsEngine.manualAdjust(body, runtime.roomInfo || snapshot.room || {}, {
          userName: snapshot.biliAccountName || runtime.biliAccountName || "主播",
        });
        if (!result) {
          sendJson(res, 400, { error: "请填写用户昵称或 UID，并输入非 0 积分" });
          return;
        }
        runtime.log("积分调整", `${result.userName} ${result.points > 0 ? "+" : ""}${result.points}，余额 ${result.balance}`);
        snapshot = runtime.getSnapshot();
        broadcast("snapshot", snapshot);
        sendJson(res, 200, { ok: true, result, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/screenshots/test") {
        const body = await readJsonBody(req);
        if (!runtime) {
          runtime = new BotRuntime({
            config,
            room: body.room || config.room,
            dryRun: true,
          });
          attachRuntime(runtime);
        }
        const result = await runtime.captureScreenForTest(body.kind || "manual");
        snapshot = runtime.getSnapshot();
        sendJson(res, result.ok ? 200 : 400, {
          ok: result.ok,
          result,
          snapshot,
          error: result.ok ? undefined : result.reason || result.error || "截图测试失败",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/modules") {
        const body = await readJsonBody(req);
        const name = String(body.name || "").trim();
        if (!name) {
          sendJson(res, 400, { error: "缺少模块名" });
          return;
        }
        config.modules = config.modules || {};
        config.modules[name] = {
          ...(config.modules[name] || {}),
          enabled: body.enabled !== false,
        };
        // 主播在页面上关掉的功能要在重启后保持，落盘失败不阻塞本次开关。
        try {
          saveConfigFile();
        } catch (error) {
          runtime?.log?.("配置", `模块开关未能写入配置文件：${error.message || error}`, { level: "warn" });
        }
        if (runtime) {
          runtime.setModule(name, body.enabled !== false);
          snapshot = runtime.getSnapshot();
        } else {
          snapshot = {
            ...snapshot,
            moduleStatus: {
              ...(snapshot.moduleStatus || config.modules || {}),
              [name]: config.modules[name],
            },
          };
          broadcast("snapshot", snapshot);
        }
        if (name === "autoLike") {
          if (body.enabled === false) clearAutoLikeSchedule();
          else ensureAutoLikeSchedule(true);
          syncBrowserControlSnapshot();
          broadcast("snapshot", snapshot);
        }
        sendJson(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/command-test") {
        const body = await readJsonBody(req);
        // 复用同一个 dry-run 测试实例，避免每次请求都构造一个用完即弃的 BotRuntime。
        if (!runtime && !commandTester) {
          commandTester = new BotRuntime({
            config,
            room: body.room || config.room,
            dryRun: true,
          });
        }
        const tester = runtime || commandTester;
        const result = tester.testCommand(body.text || "", body.userName || "");
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/check-cookie") {
        const body = await readJsonBody(req);
        try {
          const cookie = extractCookie(body.biliCookie || "");
          const result = await checkBiliCookie(cookie || resolveBiliCookie(""));
          let savedLogin = null;
          if (result.ok && cookie) {
            savedLogin = saveBiliLogin(savedLoginPath, cookie, result);
          }
          const applied =
            result.ok && cookie
              ? applyRuntimeCookie(
                  cookie,
                  result,
                  `B站 Cookie 已应用：${result.uname || result.mid || "已登录"}`
                )
              : false;
          if (runtime && result.ok && !applied) {
            runtime.biliCookie = cookie || runtime.biliCookie || resolveBiliCookie("");
            if (body.sendToBili === true) runtime.sendToBili = true;
            runtime.biliMaxChars = Number(
              body.biliMaxChars || runtime.biliMaxChars || 40
            );
            runtime.biliSendCooldownMs =
              Number(body.biliSendCooldownSec || runtime.biliSendCooldownMs / 1000 || 8) *
              1000;
            runtime.log("发送设置", `B站 Cookie 已应用：${result.uname || result.mid || "已登录"}`);
            snapshot = runtime.getSnapshot();
            broadcast("snapshot", snapshot);
          }
          sendJson(res, result.ok ? 200 : 400, {
            ok: result.ok,
            result,
            savedLogin: savedLogin
              ? {
                  ok: true,
                  savedAt: savedLogin.savedAt,
                  account: savedLogin.account,
                }
              : getSavedLoginPublic(),
            error: result.ok ? undefined : "Cookie 可解析，但当前不是已登录状态。",
          });
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error.message || String(error),
          });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login/qr") {
        const result = await createQrLogin();
        sendJson(res, 200, { ok: true, result });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login/poll") {
        const body = await readJsonBody(req);
        const result = await pollQrLogin(body.qrcodeKey || "");
        let savedLogin = null;
        if (result.cookie) {
          try {
            const account = await checkBiliCookie(result.cookie);
            if (account.ok) {
              savedLogin = saveBiliLogin(savedLoginPath, result.cookie, account);
              result.account = savedLogin.account;
            }
          } catch (error) {
            result.saveWarning = error.message;
          }
        }
        if (runtime && result.cookie) {
          const applied = applyRuntimeCookie(result.cookie, result.account || savedLogin?.account || {}, "B站扫码登录成功");
          if (!applied) {
            runtime.biliCookie = result.cookie;
            runtime.log("扫码登录", "B站扫码登录成功，Cookie 已应用到当前小助理；真实发送开关保持当前设置");
            snapshot = runtime.getSnapshot();
            broadcast("snapshot", snapshot);
          }
        }
        const publicResult = { ...result };
        delete publicResult.cookie;
        sendJson(res, 200, {
          ok: publicResult.ok,
          result: publicResult,
          savedLogin: savedLogin
            ? {
                ok: true,
                savedAt: savedLogin.savedAt,
                account: savedLogin.account,
              }
            : getSavedLoginPublic(),
          snapshot,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/login/saved") {
        sendJson(res, 200, { ok: true, savedLogin: getSavedLoginPublic() });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/login/clear") {
        clearSavedBiliLogin(savedLoginPath);
        if (runtime) {
          runtime.biliCookie = "";
          runtime.sendToBili = false;
          runtime.log("扫码登录", "已清除本地保存的 B站登录态");
          snapshot = runtime.getSnapshot();
          broadcast("snapshot", snapshot);
        }
        sendJson(res, 200, { ok: true, savedLogin: getSavedLoginPublic(), snapshot });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/clear") {
        logs.length = 0;
        actions.length = 0;
        broadcast("clear", {});
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET") {
        const staticPath = safeStaticPath(publicDir, url.pathname);
        if (!staticPath) {
          sendJson(res, 403, { error: "Forbidden" });
          return;
        }
        fs.readFile(staticPath, (error, content) => {
          if (error) {
            sendJson(res, 404, { error: "Not found" });
            return;
          }
          const contentType =
            MIME_TYPES[path.extname(staticPath).toLowerCase()] ||
            "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "no-store",
          });
          res.end(content);
        });
        return;
      }

      sendText(res, 405, "Method Not Allowed");
    } catch (error) {
      sendJson(res, error.statusCode || 500, {
        error: error.message || String(error),
      });
    }
  }

  return {
    handleRequest,
    startSafeAutoListen,
    startBrowserControl,
    overlayExportService,
    async stop() {
      clearAutoLikeSchedule();
      browserControlDesired = false;
      browserControlGeneration += 1;
      manualStopped = true;
      if (watchdogTimer) clearInterval(watchdogTimer);
      browserController.off?.("state", handleBrowserControlState);
      browserController.off?.("ready", handleBrowserControlReady);
      browserController.off?.("not-ready", handleBrowserControlNotReady);
      browserController.off?.("chat", handleBrowserDomChat);
      if (runtime) runtime.stop("服务退出");
      // SSE 是永不结束的长连接，不主动断掉它们 server.close 永远等不完。
      for (const client of [...clients]) {
        try {
          client.end();
        } catch {
          // 断开中的客户端 end 可能报错，忽略。
        }
        clients.delete(client);
      }
      await browserController.stop?.("服务退出");
    },
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rootDir = path.resolve(__dirname, "..");
  const config = loadMergedConfig({ configPath: args.config || "", rootDir });
  const stateDir = path.resolve(rootDir, config.history?.dir || "state");
  const logger = createLogger({
    dir: path.join(stateDir, "logs"),
    retentionDays: Number(config.retention?.logsDays || 14),
  });
  const host = args.host || "127.0.0.1";
  const port = Number(args.port || 4322);
  if (!isLoopbackHost(host) && !args["allow-remote"]) {
    throw new Error(
      `拒绝绑定 ${host}：本服务所有接口都没有鉴权，默认只允许 127.0.0.1。确认网络环境安全后可加 --allow-remote 强制放行。`
    );
  }

  // 兜底进程级异常：机器人是长跑服务，单个连接的意外错误不允许带崩整个进程。
  process.on("uncaughtException", (error) => {
    logger.error("process", `未捕获异常：${error?.stack || error?.message || error}`);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("process", `未处理的 Promise 拒绝：${reason?.stack || reason?.message || reason}`);
  });

  const app = createWebApp({ rootDir, config });
  const server = http.createServer(app.handleRequest);
  const retentionTimer = startRetentionSchedule({
    stateDir,
    retention: config.retention || {},
    logger,
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      // 第二次信号说明优雅退出卡住了，直接强退。
      logger.warn("process", "收到重复退出信号，立即强制退出");
      process.exit(130);
    }
    shuttingDown = true;
    logger.info("process", `收到 ${signal}，开始优雅退出`);
    const forceExit = setTimeout(() => {
      logger.error("process", "优雅退出超时，强制退出");
      process.exit(1);
    }, 8000);
    forceExit.unref();
    clearInterval(retentionTimer);
    try {
      await app.stop();
    } catch (error) {
      logger.error("process", `退出清理失败：${error?.message || error}`);
    }
    server.closeAllConnections?.();
    server.close(() => {
      logger.info("process", "已退出");
      logger.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(port, host, () => {
    logger.info(
      "startup",
      `主播工作台已启动 http://${host}:${port}（配置：${config.__path}，自动安全监听：${
        config.connection?.autoStartSafe === false ? "关" : "开"
      }）`
    );
    // 进程重启后自动恢复只监听模式，不需要有人打开页面点按钮；真实发送仍要浏览器登录托管。
    app
      .startSafeAutoListen("服务启动自动安全监听")
      .then((started) => {
        if (started) logger.info("startup", "已按配置房间自动进入只监听模式");
      })
      .catch((error) => {
        logger.warn("startup", `自动安全监听失败：${error?.message || error}`);
      });
  });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  createWebApp,
  normalizeBilibiliRoomInput,
};
