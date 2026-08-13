"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { AutoLikeBudgetStore } = require("../src/autoLikeBudgetStore");
const { loadConfig } = require("../src/configLoader");
const { createWebApp } = require("../src/webServer");

class FakeBrowserController extends EventEmitter {
  constructor(roomId) {
    super();
    this.roomId = roomId;
    this.failNextStart = false;
  }

  getState() {
    return {
      status: "waiting_login",
      running: true,
      ready: false,
      loggedIn: false,
      roomId: this.roomId,
      roomUrl: `https://live.bilibili.com/${this.roomId}`,
      emergencyStopped: false,
    };
  }

  async start({ room }) {
    if (this.failNextStart) {
      this.failNextStart = false;
      throw new Error("simulated browser start failure");
    }
    this.roomId = Number(String(room).match(/(\d+)$/)?.[1] || 0);
    return this.getState();
  }

  async stop() {}
  async emergencyStop() {}
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("successful room switch is atomically persisted and reloadable", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-persistence-"));
  const configPath = path.join(rootDir, "config.json");
  const roomA = "https://live.bilibili.com/10001";
  const roomB = "https://live.bilibili.com/20002";
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room: roomA,
      browserAutomation: { enabled: false, roomUrl: roomA },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  const config = loadConfig({ configPath, rootDir });
  const browserController = new FakeBrowserController(10001);
  const localAiService = {
    getState: () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
    ensureReady: async () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
  };
  const app = createWebApp({ rootDir, config, browserController, localAiService });
  const server = http.createServer(app.handleRequest);
  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const post = (body) =>
      fetch(`${baseUrl}/api/browser-control/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await post({ room: "not-a-room" })).status, 400);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).room, roomA);

    browserController.failNextStart = true;
    assert.equal((await post({ room: roomB })).status, 500);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).room, roomA);
    const failedState = await fetch(`${baseUrl}/api/browser-control/state`).then((response) =>
      response.json()
    );
    assert.equal(failedState.desired, false);
    assert.equal(failedState.snapshot.managedRoom.roomId, 10001);
    assert.equal(failedState.state.roomId, 10001);

    assert.equal((await post({ room: roomB })).status, 200);
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(saved.room, roomB);
    assert.equal(saved.browserAutomation.roomUrl, roomB);
    assert.equal(
      fs.readdirSync(rootDir).some((name) => name.startsWith("config.json.tmp-")),
      false
    );

    const reloaded = loadConfig({ configPath, rootDir });
    assert.equal(reloaded.room, roomB);
    assert.equal(reloaded.browserAutomation.roomUrl, roomB);

    const budgetPath = path.join(rootDir, "state", "snapshots", "auto-like-budget.json");
    assert.equal(fs.existsSync(budgetPath), true);
    const budgetStore = new AutoLikeBudgetStore({ stateDir: path.join(rootDir, "state") });
    const budgetBeforeStop = budgetStore.load(20002);
    const stopResponse = await fetch(`${baseUrl}/api/browser-control/stop`, { method: "POST" });
    assert.equal(stopResponse.status, 200);
    assert.equal(fs.existsSync(budgetPath), true);
    assert.deepEqual(budgetStore.load(20002), budgetBeforeStop);
    const restarted = await post({ room: roomB });
    const restartedPayload = await restarted.json();
    assert.equal(restarted.status, 200);
    assert.equal(
      restartedPayload.snapshot.autoLikeSchedule.sessionTargetClicks,
      budgetBeforeStop.targetClicks
    );
  } finally {
    await app.stop();
    await close(server);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("web app restores the same-day like budget after an abnormal restart", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "like-budget-restart-"));
  const configPath = path.join(rootDir, "config.json");
  const room = "https://live.bilibili.com/30003";
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room,
      browserAutomation: { enabled: false, roomUrl: room },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  const budgetStore = new AutoLikeBudgetStore({ stateDir: path.join(rootDir, "state") });
  budgetStore.save({
    roomId: 30003,
    day: budgetStore.currentDay(),
    targetClicks: 17777,
    successfulClicks: 4567,
    limitReached: false,
  });
  const browserController = new FakeBrowserController(30003);
  const localAiService = {
    getState: () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
    ensureReady: async () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
  };
  const app = createWebApp({
    rootDir,
    config: loadConfig({ configPath, rootDir }),
    browserController,
    localAiService,
  });
  const server = http.createServer(app.handleRequest);
  try {
    await listen(server);
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/api/browser-control/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room }),
      }
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.snapshot.autoLikeSchedule.sessionTargetClicks, 17777);
    assert.equal(body.snapshot.autoLikeSchedule.sessionClicks, 4567);
    assert.equal(body.snapshot.autoLikeSchedule.limitReached, false);
  } finally {
    // app.stop 模拟进程退出：不能清掉预算，下一进程仍需续用。
    await app.stop();
    await close(server);
    assert.equal(budgetStore.load(30003).successfulClicks, 4567);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
