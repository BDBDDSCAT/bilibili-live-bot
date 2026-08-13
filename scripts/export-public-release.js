#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target" && argv[index + 1]) {
      result.target = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

function run(command, args, cwd = root, options = {}) {
  return execFileSync(command, args, { cwd, stdio: options.capture ? "pipe" : "inherit" });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.target) throw new Error("用法：npm run public:export -- --target ../bilibili-live-bot-public");
  const target = path.resolve(root, args.target);
  const relative = path.relative(root, target);
  if (!relative || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new Error("公开副本必须位于当前仓库之外，避免递归复制");
  }
  if (fs.existsSync(target)) throw new Error(`目标已存在，不会覆盖：${target}`);

  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], root, { capture: true }).toString("utf8");
  if (status.trim()) throw new Error("工作树不干净；请先提交或处理所有改动，再导出公开副本");

  run(process.execPath, [path.join(root, "scripts/audit-public-release.js")]);
  const files = run("git", ["ls-files", "-z"], root, { capture: true }).toString("utf8").split("\0").filter(Boolean);
  fs.mkdirSync(target, { recursive: false });
  for (const file of files) {
    const source = path.join(root, file);
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
    else {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, stat.mode & 0o777);
    }
  }

  run("git", ["init", "-b", "main"], target);
  run("git", ["add", "--all"], target);
  const publicName = String(process.env.PUBLIC_GIT_NAME || "Yuanhao Jiang").replace(/[\r\n]/g, "").trim();
  const publicEmail = String(process.env.PUBLIC_GIT_EMAIL || "maintainer@users.noreply.github.com").replace(/[\r\n]/g, "").trim();
  const commit = spawnSync(
    "git",
    ["-c", `user.name=${publicName}`, "-c", `user.email=${publicEmail}`, "commit", "-m", "Initial public release"],
    { cwd: target, encoding: "utf8" }
  );
  if (commit.status !== 0) {
    process.stderr.write(commit.stdout || "");
    process.stderr.write(commit.stderr || "");
    throw new Error(`文件已安全导出，但初始提交失败；请在 ${target} 配置 Git 身份后提交`);
  }
  process.stdout.write(commit.stdout || "");
  process.stdout.write(`公开副本已生成：${target}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
