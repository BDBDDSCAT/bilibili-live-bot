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
    assert.equal(saved.browserAutomation.enabled, true);
    assert.equal(saved.automation.enabled, true);
    assert.equal(saved.modules.autoSend.enabled, true);
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

test("点赞预算读取失败时 fail-closed，不抽新上限也不继续调度", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "like-budget-fail-closed-"));
  const configPath = path.join(rootDir, "config.json");
  const room = "https://live.bilibili.com/40004";
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room,
      connection: { autoStartSafe: false },
      browserAutomation: { enabled: true, roomUrl: room, autoLike: { enabled: true } },
      modules: { autoLike: { enabled: true } },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  let saveCalls = 0;
  const failingBudgetStore = {
    currentDay: () => "2026-08-13",
    load: () => {
      throw new Error("模拟预算文件损坏");
    },
    save: () => {
      saveCalls += 1;
    },
  };
  const browserController = new FakeBrowserController(40004);
  const localAiService = {
    getState: () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
    ensureReady: async () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
  };
  const app = createWebApp({
    rootDir,
    config: loadConfig({ configPath, rootDir }),
    browserController,
    localAiService,
    autoLikeBudgetStore: failingBudgetStore,
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
    const payload = await response.json();
    assert.equal(payload.snapshot.autoLikeSchedule.budgetHealthy, false);
    assert.match(payload.snapshot.autoLikeSchedule.budgetError, /预算文件损坏/);
    assert.equal(payload.snapshot.autoLikeSchedule.sessionTargetClicks, 0);
    assert.equal(payload.snapshot.autoLikeSchedule.active, false);
    assert.equal(payload.snapshot.autoLikeSchedule.waitingForLive, false);
    assert.equal(saveCalls, 0);
    assert.ok(
      payload.snapshot.featureStatus.autoLike.blockers.some((item) => item.includes("额度无法安全保存"))
    );
  } finally {
    await app.stop();
    await close(server);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("并发切换 A 再 B 会串行收敛到最后一个房间", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-switch-serial-"));
  const configPath = path.join(rootDir, "config.json");
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room: "https://live.bilibili.com/10001",
      connection: { autoStartSafe: false },
      browserAutomation: { enabled: false, roomUrl: "https://live.bilibili.com/10001" },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  let releaseFirst;
  let firstStartedResolve;
  const firstStarted = new Promise((resolve) => {
    firstStartedResolve = resolve;
  });
  const firstBarrier = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  class DelayedBrowserController extends FakeBrowserController {
    async start({ room }) {
      const roomId = Number(String(room).match(/(\d+)$/)?.[1] || 0);
      if (roomId === 20002) {
        firstStartedResolve();
        await firstBarrier;
      }
      this.roomId = roomId;
      return this.getState();
    }
  }
  const browserController = new DelayedBrowserController(10001);
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
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const postRoom = (room) =>
      fetch(`${baseUrl}/api/browser-control/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room }),
      });
    const first = postRoom("20002");
    await firstStarted;
    const second = postRoom("30003");
    releaseFirst();
    assert.equal((await first).status, 200);
    assert.equal((await second).status, 200);
    const state = await fetch(`${baseUrl}/api/browser-control/state`).then((response) => response.json());
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(browserController.roomId, 30003);
    assert.equal(state.state.roomId, 30003);
    assert.equal(state.snapshot.managedRoom.roomId, 30003);
    assert.equal(saved.room, "https://live.bilibili.com/30003");
    assert.equal(saved.browserAutomation.roomUrl, "https://live.bilibili.com/30003");
  } finally {
    await app.stop();
    await close(server);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("停止操作必须赢过仍在飞行的浏览器启动，旧请求不得写回授权", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-start-stop-race-"));
  const configPath = path.join(rootDir, "config.json");
  const originalRoom = "https://live.bilibili.com/10001";
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room: originalRoom,
      connection: { autoStartSafe: false },
      automation: { enabled: false },
      browserAutomation: { enabled: false, roomUrl: originalRoom },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  let releaseStart;
  let startEnteredResolve;
  const startEntered = new Promise((resolve) => {
    startEnteredResolve = resolve;
  });
  const startBarrier = new Promise((resolve) => {
    releaseStart = resolve;
  });
  class StopWinsBrowserController extends FakeBrowserController {
    constructor(roomId) {
      super(roomId);
      this.running = false;
      this.ready = false;
    }

    getState() {
      return {
        ...super.getState(),
        status: this.running ? (this.ready ? "ready" : "starting") : "emergency_stopped",
        running: this.running,
        ready: this.ready,
        loggedIn: this.ready,
      };
    }

    async start({ room }) {
      startEnteredResolve();
      await startBarrier;
      this.roomId = Number(String(room).match(/(\d+)$/)?.[1] || 0);
      this.running = true;
      this.ready = true;
      return this.getState();
    }

    async emergencyStop() {
      this.running = false;
      this.ready = false;
    }
  }
  const browserController = new StopWinsBrowserController(10001);
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
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const starting = app
      .startBrowserControl({ room: "https://live.bilibili.com/20002" })
      .then(() => 200, (error) => error.statusCode || 500);
    await startEntered;
    const queuedBeforeStop = app
      .startBrowserControl({ room: "https://live.bilibili.com/30003" })
      .then(() => 200, (error) => error.statusCode || 500);
    const stopped = await fetch(`${baseUrl}/api/browser-control/stop`, { method: "POST" });
    assert.equal(stopped.status, 200);
    releaseStart();
    assert.equal(await starting, 409);
    assert.equal(await queuedBeforeStop, 409);

    const finalState = await fetch(`${baseUrl}/api/browser-control/state`).then((item) => item.json());
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(finalState.desired, false);
    assert.equal(finalState.state.running, false);
    assert.equal(finalState.state.ready, false);
    assert.equal(saved.room, originalRoom);
    assert.equal(saved.browserAutomation.enabled, false);
    assert.equal(saved.automation.enabled, false);
  } finally {
    releaseStart?.();
    await app.stop();
    await close(server);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("切房启动因停止而拒绝时，不得偷偷恢复旧房间托管", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-switch-stop-reject-"));
  const configPath = path.join(rootDir, "config.json");
  const roomA = "https://live.bilibili.com/10001";
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room: roomA,
      connection: { autoStartSafe: false },
      automation: { enabled: true },
      browserAutomation: { enabled: true, roomUrl: roomA },
      modules: { autoSend: { enabled: true } },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  let rejectSwitch;
  let switchEnteredResolve;
  const switchEntered = new Promise((resolve) => {
    switchEnteredResolve = resolve;
  });
  class RejectOnStopBrowserController extends FakeBrowserController {
    constructor(roomId) {
      super(roomId);
      this.running = true;
      this.ready = false;
    }

    getState() {
      return {
        ...super.getState(),
        status: this.running ? "waiting_login" : "emergency_stopped",
        running: this.running,
        ready: this.ready,
        loggedIn: this.ready,
      };
    }

    async start({ room }) {
      const roomId = Number(String(room).match(/(\d+)$/)?.[1] || 0);
      if (roomId === 20002) {
        switchEnteredResolve();
        await new Promise((_, reject) => {
          rejectSwitch = reject;
        });
      }
      this.roomId = roomId;
      this.running = true;
      return this.getState();
    }

    async emergencyStop() {
      this.running = false;
      this.ready = false;
      rejectSwitch?.(new Error("start cancelled by emergency stop"));
      rejectSwitch = null;
    }
  }
  const browserController = new RejectOnStopBrowserController(10001);
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
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const switching = fetch(`${baseUrl}/api/browser-control/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ room: "https://live.bilibili.com/20002" }),
    });
    await switchEntered;
    assert.equal(
      (await fetch(`${baseUrl}/api/browser-control/stop`, { method: "POST" })).status,
      200
    );
    assert.equal((await switching).status, 409);

    const finalState = await fetch(`${baseUrl}/api/browser-control/state`).then((item) => item.json());
    const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(finalState.desired, false);
    assert.equal(finalState.state.running, false);
    assert.equal(saved.room, roomA);
  } finally {
    rejectSwitch?.(new Error("test cleanup"));
    await app.stop();
    await close(server);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("浏览器已启动但配置无法保存时必须向页面明报", async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "room-persistence-warning-"));
  const configPath = path.join(rootDir, "config.json");
  const room = "https://live.bilibili.com/50005";
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      room,
      connection: { autoStartSafe: false },
      browserAutomation: { enabled: false, roomUrl: room },
      history: { dir: "state" },
      localAi: { enabled: false },
    }, null, 2)}\n`
  );
  const config = loadConfig({ configPath, rootDir });
  config.__path = path.join(rootDir, "missing-parent", "config.json");
  const browserController = new FakeBrowserController(50005);
  const localAiService = {
    getState: () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
    ensureReady: async () => ({ status: "skipped", message: "disabled", model: "", lastCheckedAt: 0 }),
  };
  const app = createWebApp({ rootDir, config, browserController, localAiService });
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
    const payload = await response.json();
    assert.equal(payload.persisted, false);
    assert.match(payload.warning, /本次会话已运行.*未能保存/);
    assert.equal(payload.snapshot.roomPersistenceWarning, payload.warning);
    const polled = await fetch(
      `http://127.0.0.1:${server.address().port}/api/browser-control/state`
    ).then((item) => item.json());
    assert.equal(polled.snapshot.roomPersistenceWarning, payload.warning);
    assert.equal(JSON.parse(fs.readFileSync(configPath, "utf8")).automation?.enabled, undefined);

    fs.mkdirSync(path.dirname(config.__path), { recursive: true });
    const retry = await fetch(
      `http://127.0.0.1:${server.address().port}/api/browser-control/start`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ room }),
      }
    ).then((item) => item.json());
    assert.equal(retry.persisted, true);
    assert.equal(retry.warning, "");
    assert.equal(retry.snapshot.roomPersistenceWarning, "");
  } finally {
    await app.stop();
    await close(server);
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
