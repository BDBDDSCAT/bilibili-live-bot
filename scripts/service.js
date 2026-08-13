#!/usr/bin/env node
"use strict";

// macOS launchd 常驻服务管理：开机自启 + 崩溃自动重启。
// 用法：npm run service:install / service:uninstall / service:status

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const LABEL = "com.bilibili-live-bot.web";
const rootDir = path.resolve(__dirname, "..");
const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const logDir = path.join(rootDir, "state", "logs");

function launchctl(args, { allowFail = false } = {}) {
  try {
    return execFileSync("launchctl", args, { encoding: "utf8" });
  } catch (error) {
    if (allowFail) return "";
    throw error;
  }
}

function domainTarget() {
  return `gui/${process.getuid()}`;
}

function stableNodePath() {
  // Homebrew 下 process.execPath 是版本化的 Cellar 路径，brew upgrade 后就失效且 launchd
  // 静默拉不起来。优先用版本无关的稳定链接（realpath 与当前 node 一致才采用）。
  const execPath = process.execPath;
  const cellarMatch = execPath.match(/^(.*)\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node$/);
  if (!cellarMatch) return execPath;
  const prefix = cellarMatch[1];
  for (const candidate of [path.join(prefix, "opt", "node", "bin", "node"), path.join(prefix, "bin", "node")]) {
    try {
      if (fs.existsSync(candidate) && fs.realpathSync(candidate) === execPath) return candidate;
    } catch {
      // 探测失败继续下一个候选。
    }
  }
  return execPath;
}

function buildPlist() {
  const nodePath = stableNodePath();
  const entry = path.join(rootDir, "src", "webServer.js");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entry}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${rootDir}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${path.join(logDir, "launchd.out.log")}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(logDir, "launchd.err.log")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;
}

function install() {
  if (process.platform !== "darwin") {
    console.error("service:install 目前只支持 macOS（launchd）。Linux 请参考 docs/DEPLOY.md 用 systemd。");
    process.exit(1);
  }
  if (!fs.existsSync(path.join(rootDir, "config.json"))) {
    console.error("还没有 config.json，请先执行 npm run setup。");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });
  // 已装过就先卸掉旧的，保证 plist 内容是最新的（node 路径可能变化）。
  launchctl(["bootout", domainTarget(), plistPath], { allowFail: true });
  fs.writeFileSync(plistPath, buildPlist());
  launchctl(["bootstrap", domainTarget(), plistPath]);
  console.log(`已安装常驻服务 ${LABEL}`);
  console.log(`  plist：${plistPath}`);
  console.log("  开机自启：是；崩溃自动重启：是（异常退出 10 秒后拉起）");
  console.log("  工作台：http://127.0.0.1:4322");
  console.log(`  服务日志：${path.join(logDir, "launchd.out.log")}`);
}

function uninstall() {
  launchctl(["bootout", domainTarget(), plistPath], { allowFail: true });
  if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  console.log(`已卸载常驻服务 ${LABEL}（正在运行的进程已停止）`);
}

function status() {
  const output = launchctl(["print", `${domainTarget()}/${LABEL}`], { allowFail: true });
  if (!output) {
    console.log(`服务 ${LABEL} 未安装或未加载。安装：npm run service:install`);
    return;
  }
  const pid = output.match(/pid = (\d+)/)?.[1] || "";
  const state = output.match(/state = (\w+)/)?.[1] || "unknown";
  console.log(`服务 ${LABEL}：state=${state}${pid ? ` pid=${pid}` : ""}`);
  console.log("  工作台：http://127.0.0.1:4322");
}

const command = process.argv[2] || "status";
if (command === "install") install();
else if (command === "uninstall") uninstall();
else if (command === "status") status();
else {
  console.error(`未知子命令：${command}（支持 install / uninstall / status）`);
  process.exit(1);
}
