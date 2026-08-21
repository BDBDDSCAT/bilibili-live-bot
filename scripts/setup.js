#!/usr/bin/env node
"use strict";

// 首次部署引导：从模板生成 config.json，并可直接写入直播间房号。
// 用法：npm run setup            （只生成配置）
//       npm run setup -- --room 12345   （生成并写入房间号）

const fs = require("node:fs");
const path = require("node:path");
const { loadConfig } = require("../src/configLoader");

const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "config.json");
const templatePath = path.join(rootDir, "config.example.json");

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[arg.slice(2)] = true;
    } else {
      args[arg.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

function normalizeRoom(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  if (/^\d+$/.test(input)) return `https://live.bilibili.com/${input}`;
  try {
    const parsed = new URL(input);
    if (parsed.hostname.toLowerCase() === "live.bilibili.com") {
      const roomId = parsed.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1];
      if (roomId) return `https://live.bilibili.com/${roomId}`;
    }
  } catch {
    // 落到下面的报错。
  }
  throw new Error(`--room 无法识别：${input}（支持纯房间号或 live.bilibili.com 链接）`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const room = normalizeRoom(args.room);

  if (fs.existsSync(configPath) && !args.force) {
    console.log(`config.json 已存在：${configPath}`);
    if (room) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      config.room = room;
      if (config.browserAutomation) config.browserAutomation.roomUrl = room;
      fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      console.log(`已更新直播间：${room}`);
    } else {
      console.log("如需覆盖重建请加 --force；只想改房间号请加 --room <房间号>。");
    }
  } else {
    const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
    if (room) {
      template.room = room;
      if (template.browserAutomation) template.browserAutomation.roomUrl = room;
    }
    fs.writeFileSync(configPath, `${JSON.stringify(template, null, 2)}\n`);
    console.log(`已生成 ${configPath}${room ? `（直播间：${room}）` : ""}`);
  }

  // 用真实加载器过一遍，语法/取值问题当场暴露。
  const merged = loadConfig({ rootDir });
  console.log("");
  console.log("配置检查通过。当前关键设置：");
  console.log(`  直播间        ：${merged.room || "（还没填，启动后在网页里填）"}`);
  console.log(`  浏览器托管    ：${merged.browserAutomation?.enabled ? "开" : "关"}`);
  console.log(`  自动点赞      ：${merged.browserAutomation?.autoLike?.enabled ? "开" : "关"}`);
  console.log(`  本地 AI       ：${merged.localAi?.enabled ? `开（${merged.localAi.model}）` : "关"}`);
  console.log(`  启动自动监听  ：${merged.connection?.autoStartSafe === false ? "关" : "开"}`);
  console.log("");
  console.log("下一步：");
  console.log("  npm start                     启动主播工作台（http://127.0.0.1:4322）");
  if (process.platform === "darwin") {
    console.log("  npm run service:install       安装为 macOS 常驻服务（开机自启+崩溃自动重启）");
  } else if (process.platform === "win32") {
    console.log("  WINDOWS-2-START.cmd           启动 Windows 主播工作台");
  }
}

main();
