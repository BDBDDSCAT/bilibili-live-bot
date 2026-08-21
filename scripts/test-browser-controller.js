"use strict";

const assert = require("node:assert/strict");
const EventEmitter = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const BrowserController = require("../src/browserController");

const ROOM_URL =
  "https://live.bilibili.com/20002?live_from=71002&visit_id=aobs9fs8y5mo";
const ROOM_B_URL = "https://live.bilibili.com/20003";

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("fake test wait timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

class FakeLocator {
  constructor(page, kind) {
    this.page = page;
    this.kind = kind;
  }

  first() {
    return this;
  }

  async isVisible() {
    if (this.kind === "like") return this.page.loggedIn && this.page.likeVisible;
    return this.page.loggedIn;
  }

  async isEditable() {
    return this.kind === "input" && this.page.loggedIn;
  }

  async isEnabled() {
    if (this.kind === "input") return this.page.loggedIn;
    if (this.kind === "like") return this.page.loggedIn && this.page.likeEnabled;
    return this.page.loggedIn && this.page.buttonEnabled;
  }

  async fill(value) {
    assert.equal(this.kind, "input");
    this.page.filledText = value;
    this.page.fillCount += 1;
    this.page.buttonEnabled = true;
  }

  async click() {
    if (this.kind === "like") {
      this.page.likeClickCount += 1;
      if (this.page.likeClickError) throw this.page.likeClickError;
      if (this.page.likeClickBarrier) await this.page.likeClickBarrier;
      return;
    }
    assert.equal(this.kind, "button");
    this.page.clickCount += 1;
    if (this.page.clickError) throw this.page.clickError;
    if (this.page.echoSentMessages) {
      this.page.echoSequence += 1;
      this.page.domChatRows.push({
        domKey: `sent-echo-${this.page.echoSequence}`,
        userName: "机器人账号",
        text: this.page.filledText,
        userId: 3,
      });
    }
  }
}

class FakePage extends EventEmitter {
  constructor(url = "about:blank", options = {}) {
    super();
    this.currentUrl = url;
    this.loggedIn = options.loggedIn !== false;
    this.buttonEnabled = false;
    this.likeVisible = options.likeVisible !== false;
    this.likeEnabled = options.likeEnabled !== false;
    this.responseMode = options.responseMode || "success";
    this.responseCode = options.responseCode ?? 0;
    this.closed = false;
    this.gotoCalls = [];
    this.fillCount = 0;
    this.clickCount = 0;
    this.likeClickCount = 0;
    this.bringToFrontCount = 0;
    this.waitForResponseCount = 0;
    this.filledText = "";
    this.clickError = null;
    this.likeClickError = null;
    this.likeClickBarrier = null;
    this.domDocumentKey = options.domDocumentKey || "fake-document-1";
    this.domChatRows = Array.isArray(options.domChatRows) ? [...options.domChatRows] : [];
    this.evaluateCount = 0;
    this.echoSentMessages = false;
    this.echoSequence = 0;
  }

  url() {
    return this.currentUrl;
  }

  isClosed() {
    return this.closed;
  }

  async goto(url, options) {
    this.gotoCalls.push({ url, options });
    this.currentUrl = url;
  }

  locator(selector) {
    if (selector === "textarea.chat-input") return new FakeLocator(this, "input");
    if (selector === "button.send-btn") return new FakeLocator(this, "button");
    if (selector === ".like-btn") return new FakeLocator(this, "like");
    throw new Error(`Unexpected selector: ${selector}`);
  }

  async waitForResponse(predicate) {
    this.waitForResponseCount += 1;
    if (this.responseMode === "missing") throw new Error("fake response timeout");
    const response = {
      url: () => "https://api.live.bilibili.com/msg/send",
      request: () => ({ method: () => "POST" }),
      json: async () => ({
        code: this.responseCode,
        message: this.responseCode === 0 ? "ok" : "fake rejected",
      }),
    };
    assert.equal(predicate(response), true, "controller must wait for POST /msg/send");
    return response;
  }

  async evaluate(callback) {
    assert.equal(typeof callback, "function");
    this.evaluateCount += 1;
    return {
      documentKey: this.domDocumentKey,
      rows: this.domChatRows.map((row) => ({ ...row })),
    };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }

  async bringToFront() {
    this.bringToFrontCount += 1;
  }
}

class FakeContext extends EventEmitter {
  constructor(pages = [new FakePage()]) {
    super();
    this.openPages = pages;
    this.closeCount = 0;
    this.newPageCount = 0;
  }

  pages() {
    return this.openPages;
  }

  async newPage() {
    this.newPageCount += 1;
    const page = new FakePage();
    this.openPages.push(page);
    return page;
  }

  async close() {
    this.closeCount += 1;
    this.emit("close");
  }
}

test("BrowserController detects an installed Windows browser when safe config leaves the path blank", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-detect-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const launches = [];
  const detected = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
  const controller = new BrowserController({
    rootDir,
    config: {
      room: "https://live.bilibili.com/20002",
      browserAutomation: {
        enabled: false,
        roomUrl: ROOM_URL,
        profileDir: "state/browser-profile",
        chromeExecutable: "",
        loginPollMs: 60000,
      },
    },
    detectChromeExecutable: () => detected,
    launch: async (profileDir, launchOptions) => {
      launches.push({ profileDir, launchOptions });
      return new FakeContext([new FakePage()]);
    },
  });

  const started = await controller.start({ room: ROOM_URL });
  assert.equal(started.ready, true);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].launchOptions.executablePath, detected);
  assert.equal("channel" in launches[0].launchOptions, false);
  await controller.stop("Windows browser detection test stop");
});

test("BrowserController uses one persistent fake Chrome profile and sends conservatively", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-controller-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const launches = [];
  const contexts = [];
  const launch = async (profileDir, launchOptions) => {
    launches.push({ profileDir, launchOptions });
    const context = new FakeContext([new FakePage()]);
    contexts.push(context);
    return context;
  };
  const controller = new BrowserController({
    rootDir,
    config: {
      room: "https://live.bilibili.com/20002",
      send: { maxChars: 40 },
      browserAutomation: {
        roomUrl: ROOM_URL,
        profileDir: "state/browser-profile",
        chromeExecutable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        headless: false,
        loginPollMs: 60000,
      },
    },
    launch,
  });

  const started = await controller.start({ room: ROOM_URL });
  assert.equal(started.ready, true);
  assert.equal(started.loggedIn, true);
  assert.equal(started.loginPageOpen, false);
  assert.equal(started.roomId, 20002);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].profileDir, path.join(rootDir, "state/browser-profile"));
  assert.equal(launches[0].launchOptions.headless, false);
  assert.equal(launches[0].launchOptions.viewport, null);
  assert.equal(
    launches[0].launchOptions.executablePath,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  );
  assert.equal("channel" in launches[0].launchOptions, false);
  assert.equal(fs.statSync(launches[0].profileDir).mode & 0o777, 0o700);

  const page = contexts[0].pages()[0];
  assert.equal(contexts[0].newPageCount, 0, "ready room must not open a login page");
  assert.equal(page.gotoCalls.length, 1);
  assert.equal(page.gotoCalls[0].url, ROOM_URL);

  const likedEvents = [];
  const likeFailedEvents = [];
  controller.on("liked", (event) => likedEvents.push(event));
  controller.on("like-failed", (event) => likeFailedEvents.push(event));

  const sent = await controller.send("fake hello", { roomId: 20002, maxChars: 40 });
  assert.equal(sent.ok, true);
  assert.equal(sent.responseCode, 0);
  assert.equal(page.filledText, "fake hello");
  assert.equal(page.clickCount, 1);
  assert.equal(page.waitForResponseCount, 1);

  const cancelledSend = await controller.send("must stay unsent", {
    roomId: 20002,
    maxChars: 40,
    shouldContinue: () => false,
  });
  assert.equal(cancelledSend.ok, false);
  assert.equal(cancelledSend.code, "SEND_CANCELLED");
  assert.equal(page.clickCount, 1, "cancel token must stop the send before clicking");

  const liked = await controller.like({ roomId: 20002, count: 10 });
  assert.equal(liked.ok, true);
  assert.equal(liked.code, "LIKED");
  assert.equal(liked.count, 10);
  assert.equal(page.likeClickCount, 10);
  assert.equal(controller.getState().likeCount, 10);
  assert.equal(controller.getState().lastLikeOk, true);
  assert.ok(controller.getState().lastLikeAt > 0);
  assert.equal(likedEvents.length, 1);

  const wrongRoomLike = await controller.like({ roomId: 1 });
  assert.equal(wrongRoomLike.ok, false);
  assert.equal(wrongRoomLike.code, "WRONG_ROOM");
  assert.equal(page.likeClickCount, 10, "wrong-room like must not click");

  page.loggedIn = false;
  await controller.refreshStatus();
  const notReadyLike = await controller.like({ roomId: 20002 });
  assert.equal(notReadyLike.ok, false);
  assert.equal(notReadyLike.code, "NOT_READY");
  assert.equal(page.likeClickCount, 10, "logged-out like must not click");
  page.loggedIn = true;
  await controller.refreshStatus();

  let releaseLike;
  page.likeClickBarrier = new Promise((resolve) => {
    releaseLike = resolve;
  });
  const firstConcurrentLike = controller.like({ roomId: 20002 });
  await waitUntil(() => page.likeClickCount === 11);
  const secondConcurrentLike = await controller.like({ roomId: 20002 });
  assert.equal(secondConcurrentLike.ok, false);
  assert.equal(secondConcurrentLike.code, "LIKE_BUSY");
  assert.equal(page.likeClickCount, 11, "concurrent like must not add a second click");
  releaseLike();
  const completedConcurrentLike = await firstConcurrentLike;
  page.likeClickBarrier = null;
  assert.equal(completedConcurrentLike.ok, true);
  assert.equal(completedConcurrentLike.count, 1);
  assert.equal(controller.getState().likeCount, 11);
  assert.equal(controller.getState().lastLikeOk, true);
  assert.equal(likedEvents.length, 2);
  assert.equal(likeFailedEvents.length, 3);

  let continueChecks = 0;
  const cancelledLike = await controller.like({
    roomId: 20002,
    count: 10,
    shouldContinue: () => {
      continueChecks += 1;
      return continueChecks <= 3;
    },
  });
  assert.equal(cancelledLike.ok, false);
  assert.equal(cancelledLike.code, "LIKE_INTERRUPTED");
  assert.equal(cancelledLike.count, 3, "cancel token must stop the batch between clicks");
  assert.equal(page.likeClickCount, 14);
  assert.equal(controller.getState().likeCount, 14);
  assert.equal(likeFailedEvents.length, 4);

  const cappedLike = await controller.like({ roomId: 20002, count: 100 });
  assert.equal(cappedLike.ok, true);
  assert.equal(cappedLike.count, 50, "one batch must be capped at 50 clicks");
  assert.equal(page.likeClickCount, 64);
  assert.equal(controller.getState().likeCount, 64);
  assert.equal(likedEvents.length, 3);

  const wrongRoom = await controller.send("must not click", { roomId: 1 });
  assert.equal(wrongRoom.ok, false);
  assert.equal(wrongRoom.code, "WRONG_ROOM");
  assert.equal(page.clickCount, 1);

  page.responseMode = "missing";
  await controller.pollChatsNow();
  const unknown = await controller.send("no retry", { roomId: 20002 });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.code, "NO_SEND_RESPONSE");
  assert.match(unknown.error, /will not be retried/);
  assert.equal(page.clickCount, 2, "a missing response must not cause a second click");
  assert.equal(page.waitForResponseCount, 2);

  page.echoSentMessages = true;
  const domConfirmed = await controller.send("DOM confirms delivery", {
    roomId: 20002,
  });
  assert.equal(domConfirmed.ok, true);
  assert.equal(domConfirmed.code, "SENT_DOM_CONFIRMED");
  assert.equal(domConfirmed.confirmation, "dom_echo");
  assert.equal(controller.getState().lastSendOk, true);
  assert.equal(controller.getState().lastSendText, "DOM confirms delivery");
  assert.equal(controller.getState().chatOwnSkipped, 1);
  assert.equal(page.clickCount, 3, "DOM confirmation must never click twice");

  const stopped = await controller.stop("fake test stop");
  assert.equal(stopped.ok, true);
  assert.equal(contexts[0].closeCount, 1);

  const restarted = await controller.start({ room: ROOM_URL });
  assert.equal(restarted.ready, true);
  assert.equal(launches.length, 2);
  assert.equal(launches[1].profileDir, launches[0].profileDir, "restart must reuse the profile");

  const emergencyPage = contexts[1].pages()[0];
  let releaseEmergencyLike;
  emergencyPage.likeClickBarrier = new Promise((resolve) => {
    releaseEmergencyLike = resolve;
  });
  const interruptedBatchPromise = controller.like({ roomId: 20002, count: 10 });
  await waitUntil(() => emergencyPage.likeClickCount === 1);
  const emergency = await controller.emergencyStop("fake emergency");
  assert.equal(emergency.ok, true);
  assert.equal(emergency.emergency, true);
  assert.equal(controller.getState().emergencyStopped, true);
  releaseEmergencyLike();
  const interruptedBatch = await interruptedBatchPromise;
  assert.equal(interruptedBatch.ok, false);
  assert.equal(interruptedBatch.code, "LIKE_INTERRUPTED");
  assert.equal(interruptedBatch.count, 1);
  assert.equal(emergencyPage.likeClickCount, 1, "emergency stop must interrupt the remaining batch");
  assert.equal(controller.getState().likeCount, 65);
  const afterEmergencyLike = await controller.like({ roomId: 20002 });
  assert.equal(afterEmergencyLike.ok, false);
  assert.equal(afterEmergencyLike.code, "EMERGENCY_STOPPED");
  assert.equal(emergencyPage.likeClickCount, 1, "emergency-stopped like must not click again");
  assert.equal(controller.getState().lastLikeOk, false);
  assert.match(controller.getState().lastLikeError, /emergency-stopped/);
  assert.equal(likeFailedEvents.length, 6);
  await assert.rejects(() => controller.start(), /emergency-stopped/);
});

test("BrowserController opens one official login page and adopts it after room redirect", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-login-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const oldTargetPage = new FakePage("about:blank", { loggedIn: false });
  const context = new FakeContext([oldTargetPage]);
  const controller = new BrowserController({
    rootDir,
    roomUrl: ROOM_URL,
    pollIntervalMs: 60000,
    launch: async () => context,
  });

  const started = await controller.start();
  assert.equal(started.ready, false);
  assert.equal(started.loginPageOpen, true);
  assert.equal(context.newPageCount, 1);
  assert.equal(context.pages().length, 2);

  const loginPage = context.pages()[1];
  const loginUrl = new URL(loginPage.url());
  assert.equal(loginUrl.hostname, "passport.bilibili.com");
  assert.equal(loginUrl.pathname, "/login");
  assert.equal(loginUrl.searchParams.get("gourl"), ROOM_URL);
  assert.equal(loginPage.bringToFrontCount, 1);
  assert.equal(controller.loginPage, loginPage);

  await controller.refreshStatus();
  await controller.refreshStatus();
  assert.equal(context.newPageCount, 1, "polling must reuse the existing login page");
  assert.equal(controller.loginPage, loginPage);
  assert.equal(loginPage.bringToFrontCount, 1, "polling must not repeatedly steal focus");

  loginPage.currentUrl = ROOM_URL;
  loginPage.loggedIn = true;
  const afterLogin = await controller.refreshStatus();
  assert.equal(afterLogin.ready, true);
  assert.equal(afterLogin.loggedIn, true);
  assert.equal(afterLogin.loginPageOpen, false);
  assert.equal(afterLogin.loginPageUrl, "");
  assert.equal(controller.page, loginPage, "returned login page must become the controlled room tab");
  assert.equal(oldTargetPage.closed, true, "old duplicate room tab must be closed");
  assert.equal(loginPage.closed, false);

  await controller.stop("fake login test stop");
});

test("BrowserController switches A to B once in the signed-in tab without relaunching", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-room-switch-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const page = new FakePage(ROOM_URL, { loggedIn: true });
  const context = new FakeContext([page]);
  let launchCount = 0;
  const controller = new BrowserController({
    rootDir,
    roomUrl: ROOM_URL,
    pollIntervalMs: 60000,
    chatPollIntervalMs: 60000,
    launch: async () => {
      launchCount += 1;
      return context;
    },
  });

  await controller.start({ room: ROOM_URL });
  assert.equal(controller.getState().ready, true);
  assert.equal(page.gotoCalls.length, 1);

  const switched = await controller.start({ room: ROOM_B_URL });
  assert.equal(switched.ready, true);
  assert.equal(switched.roomId, 20003);
  assert.equal(switched.roomUrl, ROOM_B_URL);
  assert.equal(switched.pageUrl, ROOM_B_URL);
  assert.equal(launchCount, 1, "room switching must reuse the signed-in browser context");
  assert.equal(context.newPageCount, 0, "room switching must reuse the existing live-room tab");
  assert.equal(page.gotoCalls.length, 2, "A to B should add exactly one navigation");
  assert.equal(page.gotoCalls[1].url, ROOM_B_URL);
  assert.equal(controller.getState().likeCount, 0, "new room should start with room-local counters");

  await controller.start({ room: ROOM_B_URL });
  assert.equal(page.gotoCalls.length, 2, "starting the same room again must not navigate again");
  assert.equal(launchCount, 1);
  await controller.stop("fake switch test stop");
});

test("BrowserController reuses an existing official passport tab after restart", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-login-reuse-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const targetPage = new FakePage("about:blank", { loggedIn: false });
  const existingLoginPage = new FakePage(
    `https://passport.bilibili.com/login?gourl=${encodeURIComponent(ROOM_URL)}`
  );
  const context = new FakeContext([targetPage, existingLoginPage]);
  const controller = new BrowserController({
    rootDir,
    roomUrl: ROOM_URL,
    pollIntervalMs: 60000,
    launch: async () => context,
  });

  const started = await controller.start();
  assert.equal(started.ready, false);
  assert.equal(started.loginPageOpen, true);
  assert.equal(context.newPageCount, 0, "an existing passport tab must be reused");
  assert.equal(existingLoginPage.gotoCalls.length, 0, "a reused login tab must not be navigated again");
  assert.equal(existingLoginPage.bringToFrontCount, 1);
  assert.equal(controller.loginPage, existingLoginPage);

  await controller.stop("fake reused-login test stop");
});

test("BrowserController keeps only one fake tab for the configured live room", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-tabs-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const keep = new FakePage(ROOM_URL);
  const duplicate = new FakePage("https://live.bilibili.com/20002");
  const context = new FakeContext([keep, duplicate]);
  const controller = new BrowserController({
    rootDir,
    roomUrl: ROOM_URL,
    pollIntervalMs: 60000,
    launch: async () => context,
  });

  await controller.start();
  assert.equal(controller.page, keep);
  assert.equal(duplicate.closed, true);
  assert.equal(keep.closed, false);
  await controller.stop("fake tab test stop");
});

test("BrowserController observes new DOM chats once, filters redraws and its own sends", async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "bili-browser-dom-chat-"));
  t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

  const page = new FakePage(ROOM_URL, {
    domChatRows: [
      { domKey: "old-1", userName: "历史用户", text: "启动前旧弹幕", userId: 1 },
    ],
  });
  const context = new FakeContext([page]);
  const controller = new BrowserController({
    rootDir,
    roomUrl: ROOM_URL,
    pollIntervalMs: 60000,
    chatPollIntervalMs: 60000,
    launch: async () => context,
  });
  const chats = [];
  controller.on("chat", (event) => chats.push(event));

  const started = await controller.start();
  assert.equal(started.ready, true);
  assert.equal(started.chatObserverRunning, true);

  const baseline = await controller.pollChatsNow();
  assert.deepEqual(baseline, [], "existing chat history must only establish the baseline");
  assert.equal(chats.length, 0);
  assert.equal(controller.getState().chatBaselineReady, true);

  page.domChatRows.push({
    domKey: "new-1",
    userName: "真实观众",
    text: "东京温度多少",
    userId: 2,
  });
  const firstNew = await controller.pollChatsNow();
  assert.equal(firstNew.length, 1);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].source, "browser_controller_dom");
  assert.equal(chats[0].chatText, "东京温度多少");
  assert.equal(chats[0].roomId, 20002);
  controller.acknowledgeChat(chats[0].id, { ok: true, skipped: false });
  controller.acknowledgeChat(chats[0].id, { ok: true, skipped: false });
  assert.equal(controller.getState().chatAccepted, 1, "acknowledgement must be idempotent");

  await controller.pollChatsNow();
  assert.equal(chats.length, 1, "the same DOM node must not emit twice");
  page.domChatRows.push({
    domKey: "redrawn-new-1",
    userName: "真实观众",
    text: "东京温度多少",
    userId: 2,
  });
  await controller.pollChatsNow();
  assert.equal(chats.length, 1, "an immediate DOM redraw must be fingerprint-deduplicated");
  assert.equal(controller.getState().chatDuplicateCount, 1);

  const sent = await controller.send("机器人自己的回复", { roomId: 20002 });
  assert.equal(sent.ok, true);
  page.domChatRows.push({
    domKey: "own-1",
    userName: "机器人账号",
    text: "机器人自己的回复",
    userId: 3,
  });
  await controller.pollChatsNow();
  assert.equal(chats.length, 1, "the browser's own outgoing echo must not loop back");
  assert.equal(controller.getState().chatOwnSkipped, 1);

  await page.close();
  const reopened = new FakePage(ROOM_URL, {
    domDocumentKey: "fake-document-2",
    domChatRows: [
      { domKey: "reopen-old", userName: "重开前用户", text: "重开页已有弹幕" },
    ],
  });
  context.openPages.push(reopened);
  const recovered = await controller.refreshStatus();
  assert.equal(recovered.ready, true, "a reopened target tab must recover automatically");
  await controller.pollChatsNow();
  assert.equal(chats.length, 1, "reopened-page history must establish a new baseline");
  reopened.domChatRows.push({
    domKey: "reopen-new",
    userName: "重开后用户",
    text: "重开后新弹幕",
  });
  await controller.pollChatsNow();
  assert.equal(chats.length, 2, "new chat after page recovery must be observed");

  await controller.emergencyStop("DOM observer regression stop");
  assert.equal(controller.getState().chatObserverRunning, false);
  assert.equal(controller.getState().chatBaselineReady, false);
  reopened.domChatRows.push({ domKey: "after-stop", userName: "停止后", text: "不能接收" });
  assert.deepEqual(await controller.pollChatsNow(), []);
  assert.equal(chats.length, 2, "emergency stop must fully stop DOM observation");
});
