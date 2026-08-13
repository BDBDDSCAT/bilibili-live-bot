"use strict";

const fs = require("node:fs");
const path = require("node:path");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function two(value) {
  return String(value).padStart(2, "0");
}

function dayKeyOf(date) {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function timeText(date) {
  return `${dayKeyOf(date)} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function serializeExtra(extra) {
  if (extra === undefined || extra === null) return "";
  if (typeof extra === "string") return extra;
  try {
    return JSON.stringify(extra);
  } catch {
    return String(extra);
  }
}

/**
 * 落盘日志：state/logs/bot-YYYY-MM-DD.log，按天切文件，超过保留天数自动清理。
 * 日志本身绝不能把进程带崩：所有文件操作失败都只降级为控制台输出。
 */
class Logger {
  constructor({ dir, filePrefix = "bot", retentionDays = 14, mirrorConsole = true, minLevel = "info" } = {}) {
    this.dir = dir || "";
    this.filePrefix = filePrefix;
    this.retentionDays = Math.max(1, Number(retentionDays) || 14);
    this.mirrorConsole = mirrorConsole !== false;
    this.minLevel = LEVELS[minLevel] || LEVELS.info;
    this.stream = null;
    this.streamDay = "";
    this.lastPruneDay = "";
    this.failedOnce = false;
  }

  child(category) {
    const parent = this;
    return {
      debug: (message, extra) => parent.log("debug", category, message, extra),
      info: (message, extra) => parent.log("info", category, message, extra),
      warn: (message, extra) => parent.log("warn", category, message, extra),
      error: (message, extra) => parent.log("error", category, message, extra),
    };
  }

  debug(category, message, extra) {
    this.log("debug", category, message, extra);
  }

  info(category, message, extra) {
    this.log("info", category, message, extra);
  }

  warn(category, message, extra) {
    this.log("warn", category, message, extra);
  }

  error(category, message, extra) {
    this.log("error", category, message, extra);
  }

  log(level, category, message, extra) {
    if ((LEVELS[level] || LEVELS.info) < this.minLevel) return;
    const now = new Date();
    const extraText = serializeExtra(extra);
    const line = `[${timeText(now)}] [${String(level).toUpperCase()}] [${category || "app"}] ${message}${
      extraText ? ` ${extraText}` : ""
    }`;
    if (this.mirrorConsole) {
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
    this.writeLine(line, now);
  }

  writeLine(line, now) {
    if (!this.dir) return;
    try {
      const day = dayKeyOf(now);
      if (!this.stream || this.streamDay !== day) {
        this.rotate(day);
      }
      this.stream?.write(`${line}\n`);
      if (this.lastPruneDay !== day) {
        this.lastPruneDay = day;
        this.prune();
      }
    } catch (error) {
      if (!this.failedOnce) {
        this.failedOnce = true;
        console.warn(`[logger] 日志写入失败，仅保留控制台输出：${error.message || error}`);
      }
    }
  }

  rotate(day) {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // 旧日志流关闭失败不影响新文件。
      }
    }
    fs.mkdirSync(this.dir, { recursive: true });
    const filePath = path.join(this.dir, `${this.filePrefix}-${day}.log`);
    this.stream = fs.createWriteStream(filePath, { flags: "a" });
    this.stream.on("error", () => {
      this.stream = null;
    });
    this.streamDay = day;
  }

  prune() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const pattern = new RegExp(`^${this.filePrefix}-(\\d{4}-\\d{2}-\\d{2})\\.log$`);
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of names) {
      const match = name.match(pattern);
      if (!match) continue;
      const fileDate = new Date(`${match[1]}T00:00:00`);
      if (!Number.isFinite(fileDate.getTime()) || fileDate.getTime() >= cutoff) continue;
      try {
        fs.unlinkSync(path.join(this.dir, name));
      } catch {
        // 清理失败等下一天再试。
      }
    }
  }

  close() {
    if (this.stream) {
      try {
        this.stream.end();
      } catch {
        // 退出路径不因日志流报错。
      }
      this.stream = null;
      this.streamDay = "";
    }
  }
}

function createLogger(options) {
  return new Logger(options || {});
}

module.exports = { Logger, createLogger };
