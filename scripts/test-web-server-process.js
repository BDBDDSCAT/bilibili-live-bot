"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("Web 端口被占用时必须非零退出，便于 launchd 接管恢复", async () => {
  const rootDir = path.resolve(__dirname, "..");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bilibot-port-conflict-"));
  const configPath = path.join(tempDir, "config.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room: "",
      connection: { autoStartSafe: false },
      history: { dir: path.join(tempDir, "state") },
      retention: { enabled: false },
    }, null, 2)}\n`,
    "utf8"
  );
  const blocker = net.createServer();
  await listen(blocker);
  const port = blocker.address().port;
  const child = spawn(
    process.execPath,
    ["src/webServer.js", "--config", configPath, "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  try {
    let stderr = "";
    let timeout;
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const result = await Promise.race([
      new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))),
      new Promise((_, reject) =>
        (timeout = setTimeout(() => reject(new Error("端口冲突子进程 5 秒内未退出")), 5000))
      ),
    ]);
    clearTimeout(timeout);
    assert.notEqual(result.code, 0, `端口冲突不得成功退出：${stderr}`);
    assert.equal(result.signal, null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await close(blocker);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
