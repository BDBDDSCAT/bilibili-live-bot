"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})/;

function fileDayMs(name) {
  const match = String(name || "").match(DATE_PREFIX);
  if (!match) return 0;
  const time = new Date(`${match[1]}T00:00:00`).getTime();
  return Number.isFinite(time) ? time : 0;
}

function pruneDatedDir(dir, keepDays, summary, label, { mtimeFallback = false } = {}) {
  if (!keepDays || keepDays <= 0) return;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - keepDays * DAY_MS;
  for (const name of names) {
    // 入口/标签文件永远保留（如 current-long-observe.tag）
    if (name.startsWith("current-") || name.endsWith(".tag") || name.endsWith(".tmp")) continue;
    const target = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      continue;
    }
    const dayMs = fileDayMs(name);
    // observations/audits 等目录的文件名不带日期前缀，退回按修改时间判过期
    const ageBasis = dayMs || (mtimeFallback ? Number(stat.mtimeMs || 0) : 0);
    if (!ageBasis || ageBasis >= cutoff) continue;
    try {
      if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
      else fs.unlinkSync(target);
      summary.removed += 1;
      summary.freedBytes += Number(stat.size || 0);
      summary.details.push(`${label}/${name}`);
    } catch {
      summary.failed += 1;
    }
  }
}

function pruneOverlays(dir, keepCount, summary) {
  if (!keepCount || keepCount <= 0) return;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  // latest 文件是控制台/OBS 的固定入口，永远保留；.job-* 残留交给 overlay 服务清。
  const removable = names
    .filter((name) => !name.includes("latest") && !name.startsWith(".job-"))
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return stat.isFile() ? { name, mtimeMs: stat.mtimeMs, size: stat.size } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const item of removable.slice(keepCount)) {
    try {
      fs.unlinkSync(path.join(dir, item.name));
      summary.removed += 1;
      summary.freedBytes += Number(item.size || 0);
      summary.details.push(`overlays/${item.name}`);
    } catch {
      summary.failed += 1;
    }
  }
}

/**
 * 按配置的保留天数清理 state 目录，防止 raw/events/日志无限膨胀。
 * 只删除文件名带日期前缀的历史文件，当天文件永远不动。
 */
function runStateRetention({ stateDir, retention = {}, logger = null } = {}) {
  const summary = { removed: 0, failed: 0, freedBytes: 0, details: [] };
  if (!stateDir || retention.enabled === false) return summary;
  pruneDatedDir(path.join(stateDir, "raw"), Number(retention.rawDays || 60), summary, "raw");
  pruneDatedDir(path.join(stateDir, "events"), Number(retention.eventsDays || 180), summary, "events");
  pruneDatedDir(path.join(stateDir, "audits"), Number(retention.auditsDays || 90), summary, "audits", { mtimeFallback: true });
  pruneDatedDir(path.join(stateDir, "observations"), Number(retention.observationsDays || 30), summary, "observations", { mtimeFallback: true });
  // 截图是主播的证据留档（SC/上舰凭证），默认永不清理；只有显式配置 screenshotsDays > 0 才删
  const screenshotsDays = Number(retention.screenshotsDays);
  if (Number.isFinite(screenshotsDays) && screenshotsDays > 0) {
    pruneDatedDir(path.join(stateDir, "screenshots"), screenshotsDays, summary, "screenshots");
  }
  pruneOverlays(path.join(stateDir, "overlays"), Number(retention.overlaysKeep || 24), summary);
  if (summary.removed || summary.failed) {
    const message = `state 清理：删除 ${summary.removed} 项，释放 ${(summary.freedBytes / 1024 / 1024).toFixed(1)}MB${
      summary.failed ? `，失败 ${summary.failed} 项` : ""
    }`;
    if (logger?.info) logger.info("retention", message);
    else console.log(`[retention] ${message}`);
  }
  return summary;
}

function startRetentionSchedule(options) {
  runStateRetention(options);
  const timer = setInterval(() => runStateRetention(options), 12 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}

module.exports = { runStateRetention, startRetentionSchedule };
