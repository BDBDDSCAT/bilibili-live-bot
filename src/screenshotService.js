"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function dayKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function timeKey(input = Date.now()) {
  const date = input instanceof Date ? input : new Date(input);
  return [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds()),
  ].join("-");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function sanitizePart(value = "") {
  return String(value || "")
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "screen";
}

function normalizeRegion(region = {}, index = 0) {
  if (!region || typeof region !== "object") return null;
  const x = Number(region.x ?? region.left ?? 0);
  const y = Number(region.y ?? region.top ?? 0);
  const width = Number(region.width ?? region.w ?? 0);
  const height = Number(region.height ?? region.h ?? 0);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return null;
  }
  return {
    name: sanitizePart(region.name || region.label || `region-${index + 1}`),
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

function eventValue(kind, event = {}) {
  if (kind === "superChat") return Number(event.price || 0) * 100;
  if (kind === "guard") return Number(event.totalCoin || event.price || event.value || 0);
  return Number(event.totalCoin || event.actualTotalCoin || event.price || 0);
}

function execFilePromise(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readableScreenshotError(error = {}) {
  const text = [error.stderr, error.stdout, error.message, String(error || "")]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (/not authorized|screen recording|permission|privacy|TCC|denied/i.test(text)) {
    return "macOS 没有屏幕录制权限：到 系统设置 -> 隐私与安全性 -> 屏幕录制，允许运行本程序的终端/Node 进程后重试";
  }
  if (/timed out|timeout/i.test(text)) {
    return "系统截图超时：请确认直播窗口没有卡住，再重试";
  }
  if (/ENOENT|not found|no such file/i.test(text)) {
    return "系统截图工具不可用：当前机器找不到 screencapture";
  }
  return text || "系统截图失败";
}

class ScreenshotService {
  constructor(config = {}, eventStore = null) {
    this.config = config || {};
    this.eventStore = eventStore || null;
    const screenshotConfig = this.config.screenshots || {};
    const dir = screenshotConfig.dir || "screenshots";
    const rootDir = this.eventStore?.rootDir || process.cwd();
    this.dir = path.isAbsolute(dir) ? dir : path.resolve(rootDir, dir);
  }

  get enabled() {
    return this.config.screenshots?.enabled === true;
  }

  getTriggerConfig(kind = "") {
    const screenshots = this.config.screenshots || {};
    const triggers = screenshots.triggers || {};
    return {
      ...(screenshots.defaultTrigger || {}),
      ...(triggers[kind] || {}),
    };
  }

  getRegions(kind = "") {
    const screenshots = this.config.screenshots || {};
    const trigger = this.getTriggerConfig(kind);
    const rawRegions = [
      ...(Array.isArray(screenshots.regions) ? screenshots.regions : []),
      ...(Array.isArray(trigger.regions) ? trigger.regions : []),
      trigger.region,
    ].filter(Boolean);
    const regions = rawRegions
      .map((region, index) => normalizeRegion(region, index))
      .filter(Boolean);
    const seen = new Set();
    return regions.filter((region) => {
      const key = `${region.x},${region.y},${region.width},${region.height}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  shouldCapture(kind = "", event = {}) {
    if (!this.enabled) return { ok: false, skipped: true, reason: "截图留档未开启" };
    if (process.platform !== "darwin") {
      return { ok: false, skipped: true, reason: "当前系统不支持 screencapture" };
    }

    const trigger = this.getTriggerConfig(kind);
    if (trigger.enabled !== true) {
      return { ok: false, skipped: true, reason: `${kind || "事件"}截图触发未开启` };
    }

    // 阈值统一用 minCoin（金瓜子），旧热改期的 minBattery 已废弃
    const minCoin = Number(trigger.minCoin || 0);
    const value = eventValue(kind, event);
    if (minCoin > 0 && value < minCoin) {
      return { ok: false, skipped: true, reason: `价值低于截图门槛 ${minCoin}` };
    }

    const regions = this.getRegions(kind);
    if (!regions.length) {
      return { ok: false, skipped: true, reason: "没有配置截图区域" };
    }

    return {
      ok: true,
      skipped: false,
      // 延迟封顶 10 秒：配太大截到的画面早已错过事件，还会让统计长期不平
      delayMs: Math.min(10000, Math.max(0, Number(trigger.delayMs || 0))),
      regions,
      value,
    };
  }

  async capture(kind = "", event = {}) {
    const decision = this.shouldCapture(kind, event);
    if (!decision.ok) return decision;

    await delay(decision.delayMs);
    const at = Date.now();
    const day = dayKey(at);
    const dayDir = path.join(this.dir, day);
    ensureDir(dayDir);

    const eventInfo = {
      command: event.command || "",
      userName: event.displayUserName || event.userName || "",
      giftName: event.giftName || "",
      count: event.count || 0,
      price: event.price || 0,
      totalCoin: event.totalCoin || event.actualTotalCoin || 0,
    };
    const files = [];
    for (const [index, region] of decision.regions.entries()) {
      const fileName = `${timeKey(at)}-${sanitizePart(kind || "event")}-${index + 1}-${region.name}.png`;
      const filePath = path.join(dayDir, fileName);
      const rect = `${region.x},${region.y},${region.width},${region.height}`;
      try {
        await execFilePromise("/usr/sbin/screencapture", ["-x", `-R${rect}`, filePath], {
          timeout: 15000,
        });
      } catch (error) {
        // 已成功的截图也要进索引，不然会变成 listRecent 永远列不到的孤儿文件
        if (files.length) {
          const partialEntry = {
            at,
            day,
            kind,
            value: decision.value,
            event: eventInfo,
            files,
            partial: true,
            reason: readableScreenshotError(error),
          };
          try {
            fs.appendFileSync(path.join(dayDir, "index.jsonl"), `${JSON.stringify(partialEntry)}\n`);
          } catch {
            // 索引写不进也别吞掉真正的失败原因
          }
        }
        return {
          ok: false,
          skipped: false,
          at,
          day,
          kind,
          value: decision.value,
          files,
          partial: files.length > 0,
          reason: readableScreenshotError(error),
        };
      }
      files.push({
        filePath,
        region,
        size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0,
      });
    }

    const entry = {
      at,
      day,
      kind,
      value: decision.value,
      event: eventInfo,
      files,
    };
    fs.appendFileSync(path.join(dayDir, "index.jsonl"), `${JSON.stringify(entry)}\n`);
    return {
      ok: true,
      skipped: false,
      ...entry,
    };
  }

  listRecent(limit = 20) {
    const max = Math.max(1, Math.min(100, Number(limit || 20)));
    if (!fs.existsSync(this.dir)) {
      return {
        dir: this.dir,
        entries: [],
        files: [],
      };
    }
    const days = fs
      .readdirSync(this.dir, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
      .reverse();
    const entries = [];
    for (const day of days) {
      const indexPath = path.join(this.dir, day, "index.jsonl");
      if (!fs.existsSync(indexPath)) continue;
      const lines = fs
        .readFileSync(indexPath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .reverse();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const files = (entry.files || []).map((file) => {
            const filePath = file.filePath || "";
            return {
              ...file,
              fileName: path.basename(filePath),
              relativePath: path.relative(this.dir, filePath).split(path.sep).join("/"),
              exists: filePath ? fs.existsSync(filePath) : false,
              size: filePath && fs.existsSync(filePath) ? fs.statSync(filePath).size : Number(file.size || 0),
            };
          });
          entries.push({
            ...entry,
            files,
          });
          if (entries.length >= max) break;
        } catch {
          // Ignore a partially written line and keep the screenshot browser usable.
        }
      }
      if (entries.length >= max) break;
    }
    return {
      dir: this.dir,
      entries,
      files: entries.flatMap((entry) =>
        (entry.files || []).map((file) => ({
          ...file,
          at: entry.at,
          day: entry.day,
          kind: entry.kind,
          userName: entry.event?.userName || "",
          giftName: entry.event?.giftName || "",
        }))
      ),
    };
  }

  getStatus() {
    const screenshots = this.config.screenshots || {};
    return {
      enabled: this.enabled,
      dir: this.dir,
      supported: process.platform === "darwin",
      triggers: screenshots.triggers || {},
      regions: this.getRegions("manual"),
    };
  }
}

module.exports = {
  ScreenshotService,
  readableScreenshotError,
};
