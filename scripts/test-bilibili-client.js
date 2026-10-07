"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { BilibiliLiveClient, resolveRoom } = require("../src/bilibiliClient");

// All API payloads are synthetic. Fetch is mocked; no live room or socket is accessed.
function mockRoomApis(t, initialStatus, detail = {}, options = {}) {
  const roomId = 20002;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    requests.push(url.pathname);
    let payload;
    switch (url.pathname) {
      case "/room/v1/Room/room_init":
        assert.equal(url.searchParams.get("id"), "10001");
        payload = {
          code: 0,
          data: { room_id: roomId, short_id: 10001, uid: 30003, live_status: initialStatus },
        };
        break;
      case "/xlive/web-room/v1/index/getRoomBaseInfo":
        assert.equal(url.searchParams.get("room_ids"), String(roomId));
        if (options.infoUnavailable) {
          return { ok: false, status: 403, statusText: "Forbidden" };
        }
        payload = { code: 0, data: { by_room_ids: { [roomId]: detail } } };
        break;
      case "/x/web-interface/card":
        assert.equal(url.searchParams.get("mid"), "30003");
        payload = { code: 0, data: { card: { name: "合成主播", face: "" } } };
        break;
      case "/xlive/web-room/v1/index/getDanmuInfo":
        assert.equal(url.searchParams.get("id"), String(roomId));
        payload = { code: 0, data: { token: "", host_list: [] } };
        break;
      default:
        throw new Error(`Unexpected API request: ${url.pathname}`);
    }
    return { ok: true, async json() { return { fixture: "synthetic", ...payload }; } };
  });
  return requests;
}

for (const [initialStatus, latestStatus] of [[1, 0], [2, 0], [0, 1], [1, 2], [1, "0"]]) {
  test(`room resolution uses latest live status ${JSON.stringify(latestStatus)} after ${initialStatus}`, async (t) => {
    const requests = mockRoomApis(t, initialStatus, {
      live_status: latestStatus,
      title: "合成直播标题",
    });
    const room = await resolveRoom("https://live.bilibili.com/10001");

    assert.equal(room.liveStatus, Number(latestStatus));
    assert.equal(room.roomId, 20002);
    assert.equal(room.requestedRoomId, 10001);
    assert.equal(room.title, "合成直播标题");
    assert.equal(room.uname, "合成主播");
    assert.equal(requests.length, 3);
  });
}

for (const detail of [{}, { live_status: null }]) {
  test(`room resolution preserves initialization status when latest status is ${JSON.stringify(detail)}`, async (t) => {
    mockRoomApis(t, 2, detail);
    const room = await resolveRoom("10001");
    assert.equal(room.liveStatus, 2);
  });
}

test("room resolution preserves initialization status when optional info is unavailable", async (t) => {
  mockRoomApis(t, 1, {}, { infoUnavailable: true });
  const room = await resolveRoom("10001");
  assert.equal(room.liveStatus, 1);
  assert.match(room.infoWarning, /HTTP 403/);
  assert.equal(room.uname, "合成主播");
});

test("client startup emits offline status after the stream ends during room resolution", async (t) => {
  mockRoomApis(t, 1, { live_status: 0 });
  const client = new BilibiliLiveClient({ room: "10001", reconnect: false });
  const openSocket = t.mock.method(client, "openSocket", () => {});
  const rooms = [];
  client.on("room", (room) => rooms.push(room));
  t.after(() => client.stop());

  await client.start();

  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].liveStatus, 0);
  assert.equal(rooms[0].liveStatusLabel, "未开播");
  assert.equal(client.room.liveStatus, 0);
  assert.equal(openSocket.mock.callCount(), 1);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function lifecycleHarness(t, options = {}) {
  const sockets = [];
  const intervals = new Set();
  const timeouts = new Set();
  const timer = (collection) => (callback, delay) => {
    const handle = { callback, delay, unref() { return this; } };
    collection.add(handle);
    return handle;
  };
  t.mock.method(globalThis, "setInterval", timer(intervals));
  t.mock.method(globalThis, "clearInterval", (handle) => intervals.delete(handle));
  t.mock.method(globalThis, "setTimeout", timer(timeouts));
  t.mock.method(globalThis, "clearTimeout", (handle) => timeouts.delete(handle));

  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    constructor(endpoint) {
      super();
      this.endpoint = endpoint;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
    }
    open() { this.readyState = 1; this.emit("open"); }
    send(packet) { this.sent.push(packet); }
    close() {
      this.readyState = 2;
      if (options.synchronousClose) this.finishClose();
    }
    terminate() { this.finishClose(); }
    finishClose() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", 1000, Buffer.alloc(0));
    }
  }

  // Load the real CommonJS client with an isolated ws mock, then restore both caches.
  // No constructor or packet handler is stubbed in the lifecycle tests.
  const clientPath = require.resolve("../src/bilibiliClient");
  const wsModule = require.cache[require.resolve("ws")];
  const originalClientModule = require.cache[clientPath];
  const originalWs = wsModule.exports;
  let TestClient;
  try {
    wsModule.exports = FakeWebSocket;
    delete require.cache[clientPath];
    TestClient = require(clientPath).BilibiliLiveClient;
  } finally {
    wsModule.exports = originalWs;
    require.cache[clientPath] = originalClientModule;
  }

  const harness = {
    sockets, intervals, timeouts, apiHook: null,
    runTimeout(handle) { timeouts.delete(handle); return handle.callback(); },
  };
  const tokenVersions = new Map();
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    const intercepted = await harness.apiHook?.(url);
    if (intercepted) return intercepted;
    const roomId = Number(url.searchParams.get("id") || url.searchParams.get("room_ids"));
    let payload;
    switch (url.pathname) {
      case "/room/v1/Room/room_init":
        payload = { code: 0, data: { room_id: roomId, uid: 30003, live_status: 1 } };
        break;
      case "/xlive/web-room/v1/index/getRoomBaseInfo":
        payload = { code: 0, data: { by_room_ids: { [roomId]: { live_status: 1 } } } };
        break;
      case "/x/web-interface/card":
        payload = { code: 0, data: { card: { name: "合成主播", face: "" } } };
        break;
      case "/xlive/web-room/v1/index/getDanmuInfo": {
        const version = (tokenVersions.get(roomId) || 0) + 1;
        tokenVersions.set(roomId, version);
        payload = { code: 0, data: {
          token: `synthetic-${roomId}-${version}`,
          host_list: [{ host: "synthetic.invalid", wss_port: 443 }],
        } };
        break;
      }
      default:
        throw new Error(`Unexpected API request: ${url.pathname}`);
    }
    return { ok: true, async json() { return { fixture: "synthetic", ...payload }; } };
  });

  harness.client = new TestClient({ room: "10001", heartbeatMs: 100, reconnectBaseMs: 25 });
  harness.rooms = [];
  harness.warnings = [];
  harness.client.on("room", (room) => harness.rooms.push(room));
  harness.client.on("warn", (warning) => harness.warnings.push(warning));
  t.after(() => {
    harness.client.stop();
    for (const socket of sockets) socket.finishClose();
  });
  return harness;
}

function holdApi(harness, pathname, roomId = 10001) {
  const entered = deferred();
  const release = deferred();
  let held = false;
  harness.apiHook = async (url) => {
    if (!held && url.pathname === pathname && Number(url.searchParams.get("id")) === roomId) {
      held = true;
      entered.resolve();
      return await release.promise;
    }
  };
  return { entered, release };
}

for (const [phase, pathname] of [
  ["room initialization", "/room/v1/Room/room_init"],
  ["danmaku token", "/xlive/web-room/v1/index/getDanmuInfo"],
]) {
  for (const stopFirst of [true, false]) {
    test(`new startup supersedes pending ${phase} ${stopFirst ? "after stop" : "without stop"}`, async (t) => {
      const h = lifecycleHarness(t);
      const held = holdApi(h, pathname);
      const oldStart = h.client.start();
      await held.entered.promise;
      if (stopFirst) h.client.stop();
      h.client.roomInput = "20002";
      await h.client.start();
      const currentSocket = h.client.ws;
      held.release.resolve();
      await oldStart;

      assert.deepEqual(h.rooms.map((room) => room.roomId), [20002]);
      assert.equal(h.client.room.roomId, 20002);
      assert.equal(h.client.danmu.token, "synthetic-20002-1");
      assert.equal(h.sockets.length, 1);
      assert.equal(h.client.ws, currentSocket);
    });
  }
}

test("obsolete startup failures do not reject after stop and restart", async (t) => {
  const h = lifecycleHarness(t);
  const held = holdApi(h, "/room/v1/Room/room_init");
  const oldStart = h.client.start();
  await held.entered.promise;
  h.client.stop();
  h.client.roomInput = "20002";
  await h.client.start();
  held.release.resolve({ ok: false, status: 403, statusText: "Forbidden" });
  await assert.doesNotReject(oldStart);
  assert.equal(h.client.room.roomId, 20002);
  assert.deepEqual(h.rooms.map((room) => room.roomId), [20002]);
});

test("current startup failures still reject without opening a socket", async (t) => {
  const h = lifecycleHarness(t);
  h.apiHook = async (url) => url.pathname === "/room/v1/Room/room_init"
    ? { ok: false, status: 403, statusText: "Forbidden" } : undefined;
  await assert.rejects(h.client.start(), /HTTP 403/);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
});

test("socket replacement clears the previous heartbeat and ignores late close events", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  h.sockets[0].open();
  assert.equal(h.intervals.size, 1);
  h.client.openSocket();
  h.sockets[1].open();
  h.sockets[0].emit("close", 1006, Buffer.alloc(0));
  assert.equal(h.intervals.size, 1);
  assert.equal(h.client.ws, h.sockets[1]);
  h.client.stop();
  h.sockets[1].finishClose();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.ok(h.sockets.every((socket) => socket.readyState === 3));
});

test("stopping from the connecting event prevents socket construction", async (t) => {
  const h = lifecycleHarness(t);
  h.client.once("connecting", () => h.client.stop());
  await h.client.start();
  assert.equal(h.client.ws, null);
  assert.equal(h.sockets.length, 0);
  assert.equal(h.timeouts.size, 0);
});

test("stopping from the connected event leaves no heartbeat", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  h.client.once("connected", () => h.client.stop());
  h.sockets[0].open();
  h.sockets[0].finishClose();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.sockets[0].sent.length, 0);
});

test("a stopped socket cannot report late errors into the restarted listener", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  const oldSocket = h.client.ws;
  h.client.stop();
  h.client.roomInput = "20002";
  await h.client.start();
  oldSocket.emit("error", new Error("synthetic obsolete socket error"));
  assert.equal(h.warnings.length, 0);
  assert.equal(h.client.ws, h.sockets[1]);
});

test("a pending reconnect token refresh cannot overwrite or reopen a restarted listener", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  h.sockets[0].open();
  const held = holdApi(h, "/xlive/web-room/v1/index/getDanmuInfo");
  h.client.needConfRefresh = true;
  h.sockets[0].finishClose();
  const retryTimer = [...h.timeouts].find((handle) => handle.delay === 25);
  assert.ok(retryTimer);
  h.runTimeout(retryTimer);
  await held.entered.promise;
  h.client.stop();
  h.client.roomInput = "20002";
  await h.client.start();
  const currentSocket = h.client.ws;
  currentSocket.open();
  held.release.resolve();
  await new Promise(setImmediate);

  assert.equal(h.client.danmu.token, "synthetic-20002-1");
  assert.equal(h.client.ws, currentSocket);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.intervals.size, 1);
});

test("stop cancels a pending reconnect before it can construct another socket", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  h.sockets[0].open();
  h.sockets[0].finishClose();
  assert.equal(h.timeouts.size, 1);
  h.client.stop();
  assert.equal(h.timeouts.size, 0);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.sockets.length, 1);
});

test("restarting from a closed event cannot reconnect before the new room is ready", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  h.sockets[0].open();
  const held = holdApi(h, "/room/v1/Room/room_init", 20002);
  let restarted;
  h.client.once("closed", () => {
    h.client.roomInput = "20002";
    restarted = h.client.start();
  });
  h.sockets[0].finishClose();
  await held.entered.promise;
  const pendingRetries = h.timeouts.size;
  const socketsBeforeReady = h.sockets.length;
  held.release.resolve();
  await restarted;

  assert.equal(pendingRetries, 0);
  assert.equal(socketsBeforeReady, 1);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.client.room.roomId, 20002);
  assert.deepEqual(h.rooms.map((room) => room.roomId), [10001, 20002]);
});

test("a synchronous close does not leave a shutdown guard timer", async (t) => {
  const h = lifecycleHarness(t, { synchronousClose: true });
  await h.client.start();
  h.client.stop();
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.timeouts.size, 0);
});

test("a synchronous closed callback can stop a replacement startup", async (t) => {
  const h = lifecycleHarness(t, { synchronousClose: true });
  await h.client.start();
  h.sockets[0].open();
  h.client.once("closed", () => h.client.stop());
  await h.client.start();

  assert.equal(h.client.stopped, true);
  assert.equal(h.client.ws, null);
  assert.equal(h.sockets.length, 1);
  assert.equal(h.rooms.length, 1);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 0);
});

test("a synchronous closed callback restart wins over the outer startup", async (t) => {
  const h = lifecycleHarness(t, { synchronousClose: true });
  await h.client.start();
  let restarted;
  h.client.once("closed", () => {
    h.client.roomInput = "20002";
    restarted = h.client.start();
  });
  await h.client.start();
  await restarted;

  assert.deepEqual(h.rooms.map((room) => room.roomId), [10001, 20002]);
  assert.equal(h.client.room.roomId, 20002);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.timeouts.size, 0);
});

test("an unresponsive close handshake is terminated after the bounded shutdown guard", async (t) => {
  const h = lifecycleHarness(t);
  await h.client.start();
  h.sockets[0].open();
  h.client.stop();
  assert.equal(h.client.ws, null);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.timeouts.size, 1);
  const guard = [...h.timeouts][0];
  assert.equal(guard.delay, 3000);
  h.runTimeout(guard);
  assert.equal(h.sockets[0].readyState, 3);
  assert.equal(h.timeouts.size, 0);
});
