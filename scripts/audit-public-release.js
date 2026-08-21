#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const forbiddenPaths = [
  /^state\//,
  /^artifacts\//,
  /^screenshots\//,
  /^coverage\//,
  /^config(?:\.local)?\.json$/,
  /^docs\/gift-corrections\//,
  /^docs\/GOAL_EVIDENCE_/,
  /(^|\/)\.env(?:\.|$)/,
  /\.log$/,
];
const textExtensions = new Set([
  "", ".cjs", ".css", ".html", ".ini", ".js", ".json", ".jsonl", ".md",
  ".cmd", ".mjs", ".ps1", ".sh", ".toml", ".txt", ".yaml", ".yml",
]);
const secretPatterns = [
  { label: "Bilibili Cookie", regex: /\b(?:SESSDATA|bili_jct|DedeUserID)\s*[:=]\s*["']?[A-Za-z0-9_%.-]{16,}/g },
  { label: "private key", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { label: "generic API secret", regex: /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][A-Za-z0-9_./+%-]{20,}["']/gi },
];

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function main() {
  const files = trackedFiles();
  const errors = [];

  for (const file of files) {
    if (forbiddenPaths.some((pattern) => pattern.test(file))) {
      errors.push(`${file}: 不允许进入公开仓库的路径`);
      continue;
    }
    const extension = path.extname(file).toLowerCase();
    if (!textExtensions.has(extension)) continue;
    const absolute = path.join(root, file);
    if (!fs.existsSync(absolute)) continue;
    const text = fs.readFileSync(absolute, "utf8");
    for (const pattern of secretPatterns) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) errors.push(`${file}: 疑似包含 ${pattern.label}`);
    }
  }

  if (errors.length) {
    process.stderr.write(`公开发布门禁失败（${errors.length} 项）：\n- ${errors.join("\n- ")}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`公开发布门禁通过：检查 ${files.length} 个 Git 跟踪文件，未发现私有运行目录或明文凭据。\n`);
}

main();
