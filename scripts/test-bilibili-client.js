"use strict";

const assert = require("node:assert/strict");
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
