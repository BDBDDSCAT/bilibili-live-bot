"use strict";

const EventEmitter = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { detectChromeExecutable } = require("./configLoader");

const DEFAULT_PROFILE_DIR = path.resolve(__dirname, "../state/browser-profile");
const CHAT_INPUT_SELECTOR = "textarea.chat-input";
const SEND_BUTTON_SELECTOR = "button.send-btn";
const LIKE_BUTTON_SELECTOR = ".like-btn";
const PASSPORT_LOGIN_URL = "https://passport.bilibili.com/login";
const DEFAULT_CHAT_POLL_INTERVAL_MS = 500;
// Deliberate trade-off: fingerprint dedupe within this window also swallows a
// viewer genuinely repeating the same text from a new DOM node. The poller
// prefers missing a repeat over replying twice to one redraw.
const DOM_REDRAW_DEDUPE_MS = 3500;
const OUTBOUND_ECHO_DEDUPE_MS = 8000;
// A suffix-only echo match on a very short outbound text would swallow real
// viewer chats; below this length only an exact match counts as an echo.
const OUTBOUND_ECHO_MIN_SUFFIX_CHARS = 6;
const DEFAULT_AUTO_RELAUNCH_DELAY_MS = 5000;
const MAX_AUTO_RELAUNCH_DELAY_MS = 60000;

let activeController = null;

function normalizeRoomTarget(value) {
  const input = String(value || "").trim();
  if (/^\d+$/.test(input) && Number(input) > 0) {
    const roomId = Number(input);
    return { roomId, roomUrl: `https://live.bilibili.com/${roomId}` };
  }
  try {
    const url = new URL(input);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.hostname.toLowerCase() !== "live.bilibili.com"
    ) {
      return null;
    }
    const roomId = Number(url.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || 0);
    return roomId > 0 ? { roomId, roomUrl: url.href } : null;
  } catch {
    return null;
  }
}

function roomIdFromUrl(value) {
  return Number(normalizeRoomTarget(value)?.roomId || 0);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || "unknown error");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeChatValue(value) {
  return String(value || "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function chatFingerprint(row = {}) {
  return `${normalizeChatValue(row.userName).toLowerCase()}\u0000${normalizeChatValue(
    row.text
  ).toLowerCase()}`;
}

// This function is serialized by Playwright and runs inside the live-room page.
// Keep it self-contained: it deliberately reads only the visible DOM and never
// touches cookies, storage, or Bilibili's private APIs.
function extractVisibleChatRowsFromPage() {
  const clean = (value) =>
    String(value || "")
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const hash = (value) => {
    let output = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      output ^= value.charCodeAt(index);
      output = Math.imul(output, 16777619);
    }
    return (output >>> 0).toString(36);
  };
  const state =
    window.__biliBotVisibleChatObserver ||
    (window.__biliBotVisibleChatObserver = {
      documentKey: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      nodeKeys: new WeakMap(),
      sequence: 0,
    });
  const roots = [
    document.querySelector("#chat-items"),
    document.querySelector(".chat-history-list"),
    document.querySelector(".chat-history-panel"),
    document.querySelector('[class*="chat-history"]'),
  ].filter(Boolean);
  const scopes = roots.length ? roots : [document];
  const explicitRowSelector = [
    ".chat-item",
    ".danmaku-item",
    "[data-danmaku-id]",
    "[data-msg-id]",
  ].join(",");
  let nodes = [];
  for (const scope of scopes) nodes.push(...scope.querySelectorAll(explicitRowSelector));
  if (!nodes.length) {
    const fallbackSelector = [
      '[class*="chat-item"]',
      '[class*="danmaku-item"]',
      '[class*="message-item"]',
    ].join(",");
    for (const scope of scopes) nodes.push(...scope.querySelectorAll(fallbackSelector));
  }

  const rows = [];
  for (const row of Array.from(new Set(nodes)).slice(-250)) {
    if (!(row instanceof HTMLElement)) continue;
    const userElement = row.querySelector(
      [
        "[data-uname]",
        "[data-user-name]",
        ".user-name",
        ".username",
        ".uname",
        '[class*="user-name"]',
        '[class*="username"]',
        '[class*="nickname"]',
      ].join(",")
    );
    const contentElement = row.querySelector(
      [
        ".danmaku-content",
        ".chat-content",
        ".message-content",
        '[class*="danmaku-content"]',
        '[class*="chat-content"]',
        '[class*="message-content"]',
      ].join(",")
    );
    let userName = clean(
      row.getAttribute("data-uname") ||
        row.getAttribute("data-user-name") ||
        userElement?.getAttribute("data-uname") ||
        userElement?.getAttribute("data-user-name") ||
        userElement?.innerText ||
        userElement?.textContent
    ).replace(/[：:]\s*$/, "");
    let text = clean(contentElement?.innerText || contentElement?.textContent);
    const line = clean(row.innerText || row.textContent);
    if (text && userName) {
      const escapedName = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const prefixed = text.match(new RegExp(`${escapedName}\\s*[：:]\\s*([\\s\\S]+)$`));
      if (prefixed?.[1]) text = clean(prefixed[1]);
    }
    if (!text && userName && line) {
      const escapedName = userName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      text = clean(line.replace(new RegExp(`^${escapedName}\\s*[：:]?\\s*`), ""));
    }
    if (!userName || !text || text === userName) continue;

    const explicitId = clean(
      row.getAttribute("data-danmaku-id") ||
        row.getAttribute("data-msg-id") ||
        row.getAttribute("data-message-id") ||
        ""
    );
    let nodeKey = state.nodeKeys.get(row);
    if (!nodeKey) {
      state.sequence += 1;
      nodeKey = `node-${state.sequence}`;
      state.nodeKeys.set(row, nodeKey);
    }
    const signature = hash(`${userName}\u0000${text}`);
    const domKey = explicitId ? `id-${explicitId}-${signature}` : `${nodeKey}-${signature}`;
    const userId = Number(
      row.getAttribute("data-uid") || userElement?.getAttribute("data-uid") || 0
    );
    rows.push({ domKey, userName, text, userId, line });
  }
  return { documentKey: state.documentKey, rows };
}

function isPassportLoginUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return (
      url.protocol === "https:" &&
      url.hostname === "passport.bilibili.com" &&
      url.pathname.startsWith("/login")
    );
  } catch {
    return false;
  }
}

class BrowserController extends EventEmitter {
  constructor(options = {}) {
    super();
    const browserConfig = options.config?.browserAutomation || {};
    this.rootDir = path.resolve(options.rootDir || path.resolve(__dirname, ".."));
    // There is no built-in default room: an unconfigured controller stays
    // idle and start() fails with a clear message instead of joining a
    // hard-coded live room.
    const initialTarget = normalizeRoomTarget(
      options.roomUrl || browserConfig.roomUrl || options.config?.room || ""
    );
    this.roomUrl = initialTarget?.roomUrl || "";
    this.roomId = Number(options.roomId || initialTarget?.roomId || 0);
    if (!this.roomUrl && this.roomId > 0) {
      this.roomUrl = `https://live.bilibili.com/${this.roomId}`;
    }
    const configuredProfileDir =
      options.profileDir || browserConfig.profileDir || DEFAULT_PROFILE_DIR;
    this.profileDir = path.isAbsolute(configuredProfileDir)
      ? path.normalize(configuredProfileDir)
      : path.resolve(this.rootDir, configuredProfileDir);
    this.executablePath = String(options.executablePath || browserConfig.chromeExecutable || "");
    this.detectChromeExecutable = options.detectChromeExecutable || detectChromeExecutable;
    this.headless = options.headless ?? browserConfig.headless === true;
    // statusPollMs is the accurate name for the overall status poll interval;
    // loginPollMs stays accepted for existing configs.
    this.pollIntervalMs = Math.max(
      250,
      Number(
        options.pollIntervalMs || browserConfig.statusPollMs || browserConfig.loginPollMs || 1500
      )
    );
    this.chatPollIntervalMs = Math.max(
      100,
      Number(
        options.chatPollIntervalMs ||
          browserConfig.chatPollMs ||
          DEFAULT_CHAT_POLL_INTERVAL_MS
      )
    );
    this.navigationTimeoutMs = Math.max(1000, Number(options.navigationTimeoutMs || 30000));
    this.sendTimeoutMs = Math.max(1000, Number(options.sendTimeoutMs || 10000));
    this.buttonReadyTimeoutMs = Math.max(250, Number(options.buttonReadyTimeoutMs || 3000));
    this.maxChars = Math.max(1, Number(options.maxChars || options.config?.send?.maxChars || 40));
    this.outboundEchoMs = Math.max(
      1000,
      Number(options.outboundEchoMs || browserConfig.outboundEchoMs || OUTBOUND_ECHO_DEDUPE_MS)
    );
    // The signed-in identity used by the echo filter. When left unset the uid
    // is detected from the persistent profile's DedeUserID cookie.
    this.configuredSelfUid = Math.max(0, Number(options.selfUid || browserConfig.selfUid || 0) || 0);
    this.selfUid = this.configuredSelfUid;
    this.selfUserName = normalizeChatValue(
      options.selfUserName || browserConfig.selfUserName || ""
    ).toLowerCase();
    this.autoRelaunchOnClose = Boolean(
      options.autoRelaunchOnClose ?? browserConfig.autoRelaunchOnClose ?? true
    );
    this.autoRelaunchDelayMs = Math.max(
      1000,
      Number(
        options.autoRelaunchDelayMs ||
          browserConfig.autoRelaunchDelayMs ||
          DEFAULT_AUTO_RELAUNCH_DELAY_MS
      )
    );

    // Tests can inject either a chromium-like object or the launch function itself.
    this.injectedChromium = options.chromium || null;
    this.injectedLaunch = options.launchPersistentContext || options.launch || null;
    this.launchOptions = { ...(options.launchOptions || {}) };

    this.context = null;
    this.page = null;
    this.loginPage = null;
    this.running = false;
    this.emergencyStopped = false;
    this.sending = false;
    this.liking = false;
    this.pollTimer = null;
    this.chatPollTimer = null;
    this.relaunchTimer = null;
    this.relaunchBackoffMs = 0;
    this.startPromise = null;
    this.stopPromise = null;
    this.refreshPromise = null;
    this.chatPollPromise = null;
    this.sendPromise = null;
    this.likePromise = null;
    this.closing = false;
    this.chatObserverGeneration = 0;
    this.chatObservedPage = null;
    this.chatObservedDocumentKey = "";
    this.chatBaselineReady = false;
    this.seenDomChatKeys = new Map();
    this.recentDomFingerprints = new Map();
    this.recentOutboundTexts = [];
    this.acknowledgedChatIds = new Set();

    this.state = {
      status: "idle",
      running: false,
      ready: false,
      loggedIn: false,
      onTargetRoom: false,
      roomId: this.roomId,
      roomUrl: this.roomUrl,
      pageUrl: "",
      inputVisible: false,
      inputEditable: false,
      sendButtonVisible: false,
      sendButtonEnabled: false,
      loginPageOpen: false,
      loginPageUrl: "",
      chatObserverRunning: false,
      chatBaselineReady: false,
      chatObserved: 0,
      chatAccepted: 0,
      chatSkipped: 0,
      chatRejected: 0,
      chatDuplicateCount: 0,
      chatOwnSkipped: 0,
      lastChatObservedAt: 0,
      lastChatAcceptedAt: 0,
      lastChatError: "",
      emergencyStopped: false,
      lastCheckedAt: 0,
      lastSendAt: 0,
      lastSendText: "",
      lastSendOk: null,
      lastSendError: "",
      lastLikeAt: 0,
      likeCount: 0,
      lastLikeOk: null,
      lastLikeError: "",
      updatedAt: Date.now(),
    };
  }

  getState() {
    return { ...this.state };
  }

  isRunning() {
    return Boolean(this.running && this.context);
  }

  async start(options = {}) {
    if (this.startPromise) return this.startPromise;
    this._clearRelaunch();
    // A stop that is still closing the old Chrome holds the profile's
    // ProcessSingleton lock; wait for it instead of racing a second launch.
    while (this.stopPromise) await this.stopPromise.catch(() => {});
    if (this.emergencyStopped) {
      throw new Error("BrowserController is emergency-stopped; call resetEmergencyStop() before restarting");
    }
    const requestedTarget = normalizeRoomTarget(options.room || options.roomUrl || "");
    if ((options.room || options.roomUrl) && !requestedTarget) {
      throw new Error("请填写有效的 B站直播间链接或房间号");
    }
    if (this.isRunning()) {
      if (requestedTarget && requestedTarget.roomId !== this.roomId) {
        return this.switchRoom(requestedTarget.roomUrl);
      }
      return this.getState();
    }
    if (
      activeController &&
      activeController !== this &&
      (activeController.isRunning() || activeController.startPromise)
    ) {
      throw new Error("Another BrowserController instance is already running");
    }

    if (requestedTarget && requestedTarget.roomId !== this.roomId) {
      this.roomId = requestedTarget.roomId;
      this.roomUrl = requestedTarget.roomUrl;
      this.state = {
        ...this.state,
        roomId: this.roomId,
        roomUrl: this.roomUrl,
      };
    }
    if (!(this.roomId > 0) || !this.roomUrl) {
      throw new Error(
        "未配置直播间：请在 config.room 或 browserAutomation.roomUrl 填写 B站直播间链接或房间号"
      );
    }

    activeController = this;
    this.startPromise = this._start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async switchRoom(value) {
    const target = normalizeRoomTarget(value);
    if (!target) throw new Error("请填写有效的 B站直播间链接或房间号");
    if (target.roomId === this.roomId) return this.getState();

    // Let any in-flight send/like finish first so its click can never land in
    // the next room after the tab navigates away.
    while (this.sendPromise || this.likePromise) {
      await Promise.allSettled([this.sendPromise, this.likePromise].filter(Boolean));
    }

    const previousRoomId = this.roomId;
    this.roomId = target.roomId;
    this.roomUrl = target.roomUrl;
    this._clearPoll();
    this._stopChatObservation({ resetBaseline: true });
    this.recentOutboundTexts = [];
    this.acknowledgedChatIds.clear();
    this._setState({
      status: this.isRunning() ? "switching_room" : "idle",
      ready: false,
      onTargetRoom: false,
      roomId: this.roomId,
      roomUrl: this.roomUrl,
      pageUrl: "",
      chatObserved: 0,
      chatAccepted: 0,
      chatSkipped: 0,
      chatRejected: 0,
      chatDuplicateCount: 0,
      chatOwnSkipped: 0,
      lastChatObservedAt: 0,
      lastChatAcceptedAt: 0,
      lastChatError: "",
      lastSendAt: 0,
      lastSendText: "",
      lastSendOk: null,
      lastSendError: "",
      lastLikeAt: 0,
      likeCount: 0,
      lastLikeOk: null,
      lastLikeError: "",
    });

    if (!this.isRunning() || !this.context) return this.getState();
    const page = await this._ensureTargetPage(false);
    try {
      await page.goto(this.roomUrl, {
        waitUntil: "domcontentloaded",
        timeout: this.navigationTimeoutMs,
      });
    } catch (error) {
      if (!this._isTargetUrl(page.url?.())) {
        this._setState({ status: "room_switch_failed", lastSendError: errorMessage(error) });
        this._schedulePoll();
        throw error;
      }
      this._emitControllerError(error);
    }
    if (this.loginPage && !this._pageClosed(this.loginPage)) {
      const loginPage = this.loginPage;
      if (isPassportLoginUrl(loginPage.url?.())) {
        await loginPage
          .goto(this._loginUrl(), {
            waitUntil: "domcontentloaded",
            timeout: this.navigationTimeoutMs,
          })
          .catch((error) => this._emitControllerError(error));
      }
    }
    const nextState = await this.refreshStatus();
    this._schedulePoll();
    this.emit("room-changed", {
      previousRoomId,
      roomId: this.roomId,
      roomUrl: this.roomUrl,
      state: nextState,
    });
    return nextState;
  }

  async _start() {
    this.closing = false;
    this._resetChatObservation(null);
    this._setState({
      status: "starting",
      running: false,
      ready: false,
      loggedIn: false,
      chatObserverRunning: false,
      chatBaselineReady: false,
      lastChatError: "",
      lastSendError: "",
    });

    try {
      fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(this.profileDir, 0o700);
      } catch {
        // Best effort on filesystems that do not support POSIX permissions.
      }
      const chromium = this.injectedChromium || require("playwright-core").chromium;
      const launch =
        this.injectedLaunch || chromium?.launchPersistentContext?.bind(chromium);
      if (typeof launch !== "function") {
        throw new Error("playwright-core chromium.launchPersistentContext is unavailable");
      }

      if (!this.executablePath && typeof this.detectChromeExecutable === "function") {
        this.executablePath = String(this.detectChromeExecutable() || "").trim();
      }
      const launchOptions = {
        ...(this.executablePath ? { executablePath: this.executablePath } : { channel: "chrome" }),
        viewport: null,
        ...this.launchOptions,
        // headless always follows the controller's own config and can not be
        // overridden through injected launchOptions.
        headless: this.headless,
      };
      if (launchOptions.executablePath) delete launchOptions.channel;

      this.context = await launch(this.profileDir, launchOptions);
      this._bindContext(this.context);
      this.running = true;
      await this._ensureTargetPage(true);
      this._setState({ running: true, status: "waiting_for_login" });
      await this.refreshStatus();
      this._schedulePoll();
      this.relaunchBackoffMs = 0;
      return this.getState();
    } catch (error) {
      this.running = false;
      if (activeController === this) activeController = null;
      const context = this.context;
      this.context = null;
      this.page = null;
      this.loginPage = null;
      this._stopChatObservation({ resetBaseline: true });
      this.closing = true;
      if (context) await context.close().catch(() => {});
      this.closing = false;
      this._setState({
        status: "launch_failed",
        running: false,
        ready: false,
        loggedIn: false,
        loginPageOpen: false,
        loginPageUrl: "",
        lastSendError: errorMessage(error),
      });
      this._emitControllerError(error);
      throw error;
    }
  }

  _bindContext(context) {
    if (typeof context?.once !== "function") return;
    context.once("close", () => {
      if (this.closing) return;
      this.running = false;
      this.context = null;
      this.page = null;
      this.loginPage = null;
      this._clearPoll();
      this._stopChatObservation({ resetBaseline: true });
      if (activeController === this) activeController = null;
      this._setState({
        status: "browser_closed",
        running: false,
        ready: false,
        loggedIn: false,
        loginPageOpen: false,
        loginPageUrl: "",
      });
      this.emit("stopped", { emergency: false, reason: "browser closed", state: this.getState() });
      // The browser disappeared without stop()/emergencyStop(): crash or a
      // manual window close. Relaunch with backoff so the bot heals itself.
      this._scheduleRelaunch();
    });
  }

  _scheduleRelaunch() {
    if (!this.autoRelaunchOnClose || this.emergencyStopped || this.closing) return;
    if (this.relaunchTimer || this.startPromise || this.isRunning()) return;
    const delayMs = Math.min(
      MAX_AUTO_RELAUNCH_DELAY_MS,
      Math.max(this.autoRelaunchDelayMs, this.relaunchBackoffMs)
    );
    this.relaunchBackoffMs = Math.min(MAX_AUTO_RELAUNCH_DELAY_MS, delayMs * 2);
    this.relaunchTimer = setTimeout(() => {
      this.relaunchTimer = null;
      if (this.emergencyStopped || this.closing || this.startPromise || this.isRunning()) return;
      this.start().catch((error) => {
        this._emitControllerError(error);
        this._scheduleRelaunch();
      });
    }, delayMs);
    this.relaunchTimer.unref?.();
  }

  _clearRelaunch(options = {}) {
    if (this.relaunchTimer) clearTimeout(this.relaunchTimer);
    this.relaunchTimer = null;
    if (options.resetBackoff) this.relaunchBackoffMs = 0;
  }

  async _ensureTargetPage(navigate = false) {
    if (!this.context) throw new Error("Browser context is not running");
    if (this.page && !this._pageClosed(this.page)) return this.page;

    const pages = (this.context.pages?.() || []).filter((page) => !this._pageClosed(page));
    let page = pages.find((candidate) => this._isTargetUrl(candidate.url?.())) || null;
    if (!page) {
      page = pages.find((candidate) => /^(?:about:blank)?$/.test(candidate.url?.() || "")) || null;
    }
    if (!page) page = await this.context.newPage();
    if (this.page !== page) this._resetChatObservation(page);
    this.page = page;
    this._bindPage(page);

    if (navigate || !this._isTargetUrl(page.url?.())) {
      try {
        await page.goto(this.roomUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.navigationTimeoutMs,
        });
      } catch (error) {
        if (!this._isTargetUrl(page.url?.())) throw error;
        this._emitControllerError(error);
      }
    }

    await this._closeDuplicateRoomTabs(page);
    return page;
  }

  _loginUrl() {
    const url = new URL(PASSPORT_LOGIN_URL);
    url.searchParams.set("gourl", this.roomUrl);
    return url.href;
  }

  async _adoptReturnedLoginPage() {
    const page = this.loginPage;
    if (!page || this._pageClosed(page) || !this._isTargetUrl(page.url?.())) return false;
    this.loginPage = null;
    if (this.page !== page) this._resetChatObservation(page);
    this.page = page;
    this._bindPage(page);
    await page.bringToFront?.().catch(() => {});
    await this._closeDuplicateRoomTabs(page);
    return true;
  }

  async _ensureLoginPage() {
    if (!this.context || !this.running || this.emergencyStopped) return null;
    if (await this._adoptReturnedLoginPage()) return null;

    // A known login page may temporarily visit another official auth route.
    // Keep reusing the same tab until it returns to the configured live room.
    if (this.loginPage && !this._pageClosed(this.loginPage)) return this.loginPage;

    const pages = (this.context.pages?.() || []).filter((page) => !this._pageClosed(page));
    let page = pages.find((candidate) => isPassportLoginUrl(candidate.url?.())) || null;
    const reused = Boolean(page);
    if (!page) page = await this.context.newPage();
    this.loginPage = page;
    this._bindLoginPage(page);

    if (!reused) {
      const loginUrl = this._loginUrl();
      try {
        await page.goto(loginUrl, {
          waitUntil: "domcontentloaded",
          timeout: this.navigationTimeoutMs,
        });
      } catch (error) {
        if (!isPassportLoginUrl(page.url?.())) throw error;
        this._emitControllerError(error);
      }
    }
    await page.bringToFront?.().catch(() => {});
    return page;
  }

  _bindPage(page) {
    if (typeof page?.once !== "function") return;
    page.once("close", () => {
      if (this.page !== page) return;
      this.page = null;
      this._stopChatObservation({ resetBaseline: true });
      this._resetChatObservation(null);
      if (!this.closing) {
        this._setState({
          status: "room_tab_closed",
          ready: false,
          loggedIn: false,
          pageUrl: "",
        });
      }
    });
  }

  _bindLoginPage(page) {
    if (typeof page?.once !== "function") return;
    page.once("close", () => {
      if (this.loginPage !== page) return;
      this.loginPage = null;
      if (!this.closing) {
        this._setState({
          loginPageOpen: false,
          loginPageUrl: "",
        });
      }
    });
  }

  async _closeDuplicateRoomTabs(keepPage) {
    const pages = this.context?.pages?.() || [];
    for (const page of pages) {
      if (page === keepPage || this._pageClosed(page) || !this._isTargetUrl(page.url?.())) continue;
      await page.close().catch(() => {});
    }
  }

  _pageClosed(page) {
    return !page || (typeof page.isClosed === "function" && page.isClosed());
  }

  _isTargetUrl(value) {
    return this.roomId > 0 && roomIdFromUrl(value) === this.roomId;
  }

  // Resolve the signed-in uid from the persistent profile's DedeUserID cookie
  // so the echo filter can tell the bot's own rows from a viewer repeating the
  // same text. Identity stays unknown on contexts without cookie access.
  async _refreshSelfIdentity() {
    if (this.selfUid > 0) return;
    if (!this.context || typeof this.context.cookies !== "function") return;
    try {
      const cookies = await this.context.cookies("https://live.bilibili.com");
      const dede = (cookies || []).find((cookie) => cookie?.name === "DedeUserID");
      const uid = Number(dede?.value || 0);
      if (Number.isFinite(uid) && uid > 0) this.selfUid = uid;
    } catch {
      // Fall back to text-only echo matching when the identity is unknown.
    }
  }

  async refreshStatus() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this._refreshStatus();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  async _refreshStatus() {
    if (!this.running || !this.context) return this.getState();
    const adoptedLoginPage = await this._adoptReturnedLoginPage();
    const page = await this._ensureTargetPage(false);
    await this._closeDuplicateRoomTabs(page);

    const pageUrl = String(page.url?.() || "");
    const onTargetRoom = this._isTargetUrl(pageUrl);
    let inputVisible = false;
    let inputEditable = false;
    let sendButtonVisible = false;
    let sendButtonEnabled = false;

    if (onTargetRoom) {
      const input = page.locator(CHAT_INPUT_SELECTOR).first();
      const button = page.locator(SEND_BUTTON_SELECTOR).first();
      [inputVisible, inputEditable, sendButtonVisible, sendButtonEnabled] = await Promise.all([
        input.isVisible().catch(() => false),
        input.isEditable().catch(() => false),
        button.isVisible().catch(() => false),
        button.isEnabled().catch(() => false),
      ]);
    }

    // Bilibili disables the send button while the textarea is empty, so its
    // visibility (plus an editable textarea) is the stable logged-in signal.
    const loggedIn = Boolean(onTargetRoom && inputVisible && inputEditable && sendButtonVisible);
    if (loggedIn) await this._refreshSelfIdentity();
    else if (this.selfUid !== this.configuredSelfUid) this.selfUid = this.configuredSelfUid;
    const ready = loggedIn && !this.emergencyStopped;
    if (!ready && !adoptedLoginPage) {
      await this._ensureLoginPage();
      if (await this._adoptReturnedLoginPage()) return this._refreshStatus();
    } else if (ready && this.loginPage && !this._pageClosed(this.loginPage)) {
      const staleLoginPage = this.loginPage;
      this.loginPage = null;
      await staleLoginPage.close().catch(() => {});
    }
    const loginPageOpen = Boolean(this.loginPage && !this._pageClosed(this.loginPage));
    const loginPageUrl = loginPageOpen ? String(this.loginPage.url?.() || "") : "";
    const status = !onTargetRoom
      ? "waiting_for_room"
      : ready
        ? "ready"
        : "waiting_for_login";
    this._setState({
      status,
      running: true,
      ready,
      loggedIn,
      onTargetRoom,
      pageUrl,
      inputVisible,
      inputEditable,
      sendButtonVisible,
      sendButtonEnabled,
      loginPageOpen,
      loginPageUrl,
      lastCheckedAt: Date.now(),
    });
    if (ready) this._ensureChatPoll();
    else this._stopChatObservation({ resetBaseline: true });
    return this.getState();
  }

  _schedulePoll() {
    this._clearPoll();
    if (!this.running || this.emergencyStopped) return;
    this.pollTimer = setTimeout(async () => {
      this.pollTimer = null;
      try {
        await this.refreshStatus();
      } catch (error) {
        this._emitControllerError(error);
      } finally {
        this._schedulePoll();
      }
    }, this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  _clearPoll() {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  _resetChatObservation(page = null, documentKey = "") {
    this.chatObserverGeneration += 1;
    this.chatObservedPage = page;
    this.chatObservedDocumentKey = String(documentKey || "");
    this.chatBaselineReady = false;
    this.seenDomChatKeys.clear();
    this.recentDomFingerprints.clear();
    if (this.state?.chatBaselineReady) this._setState({ chatBaselineReady: false });
  }

  _stopChatObservation(options = {}) {
    if (this.chatPollTimer) clearTimeout(this.chatPollTimer);
    this.chatPollTimer = null;
    this.chatObserverGeneration += 1;
    if (options.resetBaseline) {
      this.chatBaselineReady = false;
      this.chatObservedDocumentKey = "";
      this.seenDomChatKeys.clear();
      this.recentDomFingerprints.clear();
    }
    if (
      this.state &&
      (this.state.chatObserverRunning ||
        (options.resetBaseline && this.state.chatBaselineReady))
    ) {
      this._setState({
        chatObserverRunning: false,
        ...(options.resetBaseline ? { chatBaselineReady: false } : {}),
      });
    }
  }

  _ensureChatPoll() {
    if (
      !this.running ||
      !this.context ||
      !this.page ||
      this._pageClosed(this.page) ||
      this.emergencyStopped ||
      !this.state.ready
    ) {
      this._stopChatObservation({ resetBaseline: true });
      return;
    }
    if (!this.state.chatObserverRunning) {
      this._setState({ chatObserverRunning: true, lastChatError: "" });
    }
    if (this.chatPollTimer || this.chatPollPromise) return;
    this.chatPollTimer = setTimeout(async () => {
      this.chatPollTimer = null;
      try {
        await this.pollChatsNow();
      } catch (error) {
        this._emitControllerError(error);
        if (this.running && !this.emergencyStopped) {
          this._setState({ lastChatError: errorMessage(error) });
        }
      } finally {
        this._ensureChatPoll();
      }
    }, this.chatPollIntervalMs);
    this.chatPollTimer.unref?.();
  }

  async pollChatsNow() {
    if (this.chatPollPromise) return this.chatPollPromise;
    this.chatPollPromise = this._pollVisibleChats();
    try {
      return await this.chatPollPromise;
    } finally {
      this.chatPollPromise = null;
    }
  }

  async _pollVisibleChats() {
    if (
      !this.running ||
      !this.context ||
      !this.page ||
      this._pageClosed(this.page) ||
      this.emergencyStopped ||
      !this.state.ready ||
      !this._isTargetUrl(this.page.url?.())
    ) {
      return [];
    }

    const page = this.page;
    if (this.chatObservedPage !== page) this._resetChatObservation(page);
    const generation = this.chatObserverGeneration;
    let extracted;
    try {
      extracted = await page.evaluate(extractVisibleChatRowsFromPage);
    } catch (error) {
      if (
        generation === this.chatObserverGeneration &&
        this.running &&
        !this.emergencyStopped
      ) {
        this._setState({ lastChatError: errorMessage(error) });
      }
      return [];
    }
    if (
      generation !== this.chatObserverGeneration ||
      page !== this.page ||
      this._pageClosed(page) ||
      !this.running ||
      this.emergencyStopped ||
      !this.state.ready
    ) {
      return [];
    }

    const documentKey = String(extracted?.documentKey || "legacy-document");
    const rows = Array.isArray(extracted) ? extracted : extracted?.rows;
    if (documentKey !== this.chatObservedDocumentKey) {
      this._resetChatObservation(page, documentKey);
    }
    const normalizedRows = (Array.isArray(rows) ? rows : [])
      .slice(-250)
      .map((row, index) => ({
        domKey: normalizeChatValue(row?.domKey || `fallback-${index}-${chatFingerprint(row)}`),
        userName: normalizeChatValue(row?.userName).replace(/[：:]\s*$/, ""),
        text: normalizeChatValue(row?.text),
        userId: Number(row?.userId || 0),
        line: normalizeChatValue(row?.line),
      }))
      .filter((row) => row.domKey && row.userName && row.text);
    const now = Date.now();
    this._pruneChatDedupe(now);

    if (!this.chatBaselineReady) {
      for (const row of normalizedRows) {
        this._rememberDomChatRow(row, now);
      }
      this.chatBaselineReady = true;
      this._setState({
        chatBaselineReady: true,
        chatObserverRunning: true,
        lastChatError: "",
      });
      return [];
    }

    let observedCount = 0;
    let duplicateCount = 0;
    let ownSkipped = 0;
    const events = [];
    for (const row of normalizedRows) {
      if (this.seenDomChatKeys.has(row.domKey)) continue;
      observedCount += 1;
      const fingerprint = chatFingerprint(row);
      const fingerprintAt = Number(this.recentDomFingerprints.get(fingerprint) || 0);
      this._rememberDomChatRow(row, now);
      if (fingerprintAt && now - fingerprintAt <= DOM_REDRAW_DEDUPE_MS) {
        duplicateCount += 1;
        continue;
      }
      if (this._isRecentOutboundText(row.text, now, row)) {
        ownSkipped += 1;
        continue;
      }
      events.push({
        id: `browser-dom:${this.roomId}:${documentKey}:${row.domKey}`,
        domKey: row.domKey,
        kind: "chat",
        source: "browser_controller_dom",
        bridgeVersion: "browser-controller-dom-v1",
        roomId: this.roomId,
        room_id: this.roomId,
        url: String(page.url?.() || this.roomUrl),
        userName: row.userName,
        displayUserName: row.userName,
        userId: row.userId,
        text: row.text,
        chatText: row.text,
        line: row.line || `${row.userName}: ${row.text}`,
        at: now,
      });
    }

    if (observedCount || duplicateCount || ownSkipped || this.state.lastChatError) {
      this._setState({
        chatObserved: Number(this.state.chatObserved || 0) + observedCount,
        chatDuplicateCount:
          Number(this.state.chatDuplicateCount || 0) + duplicateCount,
        chatOwnSkipped: Number(this.state.chatOwnSkipped || 0) + ownSkipped,
        lastChatObservedAt: observedCount ? now : this.state.lastChatObservedAt,
        lastChatError: "",
      });
    }
    for (const event of events) this.emit("chat", event);
    return events;
  }

  _rememberDomChatRow(row, now = Date.now()) {
    this.seenDomChatKeys.set(row.domKey, now);
    this.recentDomFingerprints.set(chatFingerprint(row), now);
    while (this.seenDomChatKeys.size > 2500) {
      this.seenDomChatKeys.delete(this.seenDomChatKeys.keys().next().value);
    }
  }

  _pruneChatDedupe(now = Date.now()) {
    for (const [fingerprint, at] of this.recentDomFingerprints.entries()) {
      if (now - Number(at || 0) > DOM_REDRAW_DEDUPE_MS) {
        this.recentDomFingerprints.delete(fingerprint);
      }
    }
    this.recentOutboundTexts = this.recentOutboundTexts
      .filter((item) => now - Number(item.at || 0) <= this.outboundEchoMs)
      .slice(0, 50);
  }

  _rememberOutboundText(text, now = Date.now(), uid = 0) {
    const value = normalizeChatValue(text).toLowerCase();
    if (!value) return null;
    const item = { text: value, at: now, uid: Number(uid || 0) };
    this.recentOutboundTexts.unshift(item);
    this._pruneChatDedupe(now);
    return item;
  }

  _forgetOutboundText(item) {
    if (!item) return;
    this.recentOutboundTexts = this.recentOutboundTexts.filter((candidate) => candidate !== item);
  }

  // Public hook for the parallel HTTP send channel: text delivered through
  // bilibiliSender never passes send(), so the bridge reports it here to keep
  // the echo filter complete. Pass the sending account's uid when known.
  noteOutboundText(text, options = {}) {
    this._rememberOutboundText(
      text,
      Number(options.at || Date.now()),
      Number(options.uid || 0)
    );
  }

  _isRecentOutboundText(text, now = Date.now(), sender = null) {
    const value = normalizeChatValue(text).toLowerCase();
    if (!value) return false;
    this._pruneChatDedupe(now);
    const matched = this.recentOutboundTexts.filter(
      (item) =>
        (item.text === value ||
          (item.text.length >= OUTBOUND_ECHO_MIN_SUFFIX_CHARS && value.endsWith(item.text))) &&
        now - Number(item.at || 0) <= this.outboundEchoMs
    );
    if (!matched.length) return false;
    // When both sides carry an identity the identity is decisive: a viewer
    // repeating the bot's own text must never be swallowed as an echo.
    const senderUid = Number(sender?.userId || 0);
    const senderName = normalizeChatValue(sender?.userName || "").toLowerCase();
    for (const item of matched) {
      const itemUid = Number(item.uid || 0) || this.selfUid;
      if (senderUid > 0 && itemUid > 0) {
        if (senderUid === itemUid) return true;
        continue;
      }
      if (senderName && this.selfUserName) {
        if (senderName === this.selfUserName) return true;
        continue;
      }
      return true;
    }
    return false;
  }

  acknowledgeChat(id, result = {}) {
    const eventId = normalizeChatValue(id);
    if (!eventId || this.acknowledgedChatIds.has(eventId)) return this.getState();
    this.acknowledgedChatIds.add(eventId);
    while (this.acknowledgedChatIds.size > 1000) {
      this.acknowledgedChatIds.delete(this.acknowledgedChatIds.values().next().value);
    }
    const now = Date.now();
    const accepted = result?.ok === true && result?.skipped !== true;
    const skipped = result?.skipped === true;
    const rejected = !accepted && !skipped;
    this._setState({
      chatAccepted: Number(this.state.chatAccepted || 0) + (accepted ? 1 : 0),
      chatSkipped: Number(this.state.chatSkipped || 0) + (skipped ? 1 : 0),
      chatRejected: Number(this.state.chatRejected || 0) + (rejected ? 1 : 0),
      lastChatAcceptedAt: accepted ? now : this.state.lastChatAcceptedAt,
      lastChatError: rejected ? String(result?.error || result?.reason || "未接收") : "",
    });
    return this.getState();
  }

  async send(text, options = {}) {
    const message = String(text || "").replace(/\s+/g, " ").trim();
    const requestedRoomId = Number(options.roomId || 0);
    const shouldContinue =
      typeof options.shouldContinue === "function" ? options.shouldContinue : () => true;
    const canContinue = () => {
      try {
        return shouldContinue() !== false;
      } catch {
        return false;
      }
    };
    if (requestedRoomId && requestedRoomId !== this.roomId) {
      return this._sendFailure(
        "WRONG_ROOM",
        `browser is fixed to room ${this.roomId}, not ${requestedRoomId}`
      );
    }
    const maxChars = Math.max(1, Number(options.maxChars || this.maxChars));
    if (!message) return this._sendFailure("EMPTY_MESSAGE", "message is empty");
    if (Array.from(message).length > maxChars) {
      return this._sendFailure(
        "MESSAGE_TOO_LONG",
        `message exceeds ${maxChars} characters`
      );
    }
    if (this.sending) return this._sendFailure("SEND_BUSY", "another send is in progress");
    if (this.emergencyStopped) {
      return this._sendFailure("EMERGENCY_STOPPED", "browser controller is emergency-stopped");
    }

    // Take the lock before the first asynchronous readiness check so two
    // callers can never both reach the input box.
    this.sending = true;
    const expectedRoomId = this.roomId;
    let releaseSendPromise;
    this.sendPromise = new Promise((resolve) => {
      releaseSendPromise = resolve;
    });
    try {
      const state = await this.refreshStatus().catch((error) => ({
        ready: false,
        status: "status_check_failed",
        error: errorMessage(error),
      }));
      if (!this.running || !this.page || !state.ready) {
        return this._sendFailure(
          "NOT_READY",
          state.error || `browser is not ready (${state.status || "unknown"})`
        );
      }
      if (!canContinue()) {
        return this._sendFailure("SEND_CANCELLED", "send cancelled before clicking");
      }

      const page = this.page;
      const input = page.locator(CHAT_INPUT_SELECTOR).first();
      const button = page.locator(SEND_BUTTON_SELECTOR).first();
      await input.fill(message);
      const buttonReady = await this._waitForButton(button);
      if (!buttonReady) {
        return this._sendFailure("SEND_BUTTON_DISABLED", "send button did not become enabled");
      }
      if (
        expectedRoomId !== this.roomId ||
        this.page !== page ||
        this._pageClosed(page) ||
        !this._isTargetUrl(page.url?.())
      ) {
        return this._sendFailure(
          "ROOM_CHANGED",
          "room or page changed before the message was clicked"
        );
      }
      if (!canContinue()) {
        return this._sendFailure("SEND_CANCELLED", "send cancelled before clicking");
      }

      // Install the waiter before clicking. A missing response is deliberately
      // treated as failure and is never retried automatically because the click
      // may already have reached Bilibili.
      const responseResult = page
        .waitForResponse(
          (response) => {
            const request = response.request?.();
            if (request?.method?.() !== "POST") return false;
            let onSendPath = false;
            try {
              onSendPath = new URL(response.url()).pathname === "/msg/send";
            } catch {
              onSendPath = /\/msg\/send(?:\?|$)/.test(String(response.url?.() || ""));
            }
            if (!onSendPath) return false;
            // Bind the response to this click: in the visible Chrome a human
            // can post a danmaku at the same moment with a different msg body.
            const postData =
              typeof request?.postData === "function" ? String(request.postData() || "") : "";
            if (!postData) return true;
            try {
              return new URLSearchParams(postData).get("msg") === message;
            } catch {
              return true;
            }
          },
          { timeout: this.sendTimeoutMs }
        )
        .then((response) => ({ response }))
        .catch((error) => ({ error }));

      const ownSkippedBefore = Number(this.state.chatOwnSkipped || 0);
      const pendingOutbound = this._rememberOutboundText(message, Date.now());
      try {
        await button.click();
      } catch (error) {
        this._forgetOutboundText(pendingOutbound);
        return this._sendFailure("CLICK_FAILED", errorMessage(error));
      }

      const outcome = await responseResult;
      if (!outcome.response) {
        // 某些 B 站页面会实际发送，但 Playwright 观察不到 /msg/send
        // 回包。只有当 DOM 观察器看到“本次文本”的新公屏回显时才改判
        // 成功；否则仍然保持未知且绝不自动重发。
        await this.pollChatsNow().catch(() => []);
        if (Number(this.state.chatOwnSkipped || 0) > ownSkippedBefore) {
          const result = {
            ok: true,
            code: "SENT_DOM_CONFIRMED",
            responseCode: null,
            confirmation: "dom_echo",
            sentText: message,
            roomId: this.roomId,
            at: Date.now(),
          };
          this._setState({
            lastSendAt: result.at,
            lastSendText: message,
            lastSendOk: true,
            lastSendError: "",
          });
          this.emit("sent", result);
          return result;
        }
        return this._sendFailure(
          "NO_SEND_RESPONSE",
          `${errorMessage(outcome.error)}; send status is unknown and will not be retried`
        );
      }

      let payload;
      try {
        payload = await outcome.response.json();
      } catch (error) {
        return this._sendFailure("INVALID_SEND_RESPONSE", errorMessage(error));
      }
      if (Number(payload?.code) !== 0) {
        this._forgetOutboundText(pendingOutbound);
        return this._sendFailure(
          "BILIBILI_REJECTED",
          payload?.message || payload?.msg || `Bilibili returned code ${payload?.code}`,
          { responseCode: payload?.code }
        );
      }

      const result = {
        ok: true,
        code: "SENT",
        responseCode: 0,
        sentText: message,
        roomId: this.roomId,
        at: Date.now(),
      };
      this._setState({
        lastSendAt: result.at,
        lastSendText: message,
        lastSendOk: true,
        lastSendError: "",
      });
      this.emit("sent", result);
      return result;
    } catch (error) {
      return this._sendFailure("SEND_FAILED", errorMessage(error));
    } finally {
      this.sending = false;
      releaseSendPromise?.();
      this.sendPromise = null;
    }
  }

  async _waitForButton(button) {
    const deadline = Date.now() + this.buttonReadyTimeoutMs;
    do {
      const visible = await button.isVisible().catch(() => false);
      const enabled = await button.isEnabled().catch(() => false);
      if (visible && enabled) return true;
      await delay(75);
    } while (Date.now() < deadline && this.running && !this.emergencyStopped);
    return false;
  }

  _sendFailure(code, message, extra = {}) {
    const result = {
      ok: false,
      code,
      error: String(message || code),
      roomId: this.roomId,
      at: Date.now(),
      ...extra,
    };
    this._setState({
      lastSendAt: result.at,
      lastSendOk: false,
      lastSendError: result.error,
    });
    this.emit("send-failed", result);
    return result;
  }

  async like(options = {}) {
    const requestedRoomId = Number(options.roomId || 0);
    const rawCount = Number(options.count ?? 1);
    const requestedCount = Math.min(
      50,
      Math.max(1, Number.isFinite(rawCount) ? Math.floor(rawCount) : 1)
    );
    const shouldContinue =
      typeof options.shouldContinue === "function" ? options.shouldContinue : () => true;
    const canContinue = () => {
      try {
        return shouldContinue() !== false;
      } catch {
        return false;
      }
    };
    if (requestedRoomId && requestedRoomId !== this.roomId) {
      return this._likeFailure(
        "WRONG_ROOM",
        `browser is fixed to room ${this.roomId}, not ${requestedRoomId}`
      );
    }
    if (this.emergencyStopped) {
      return this._likeFailure("EMERGENCY_STOPPED", "browser controller is emergency-stopped");
    }
    if (this.liking) return this._likeFailure("LIKE_BUSY", "another like is in progress");

    // Take the lock before the first asynchronous readiness check so two callers
    // can never both reach the button.
    this.liking = true;
    let releaseLikePromise;
    this.likePromise = new Promise((resolve) => {
      releaseLikePromise = resolve;
    });
    let completedCount = 0;
    try {
      const state = await this.refreshStatus().catch((error) => ({
        ready: false,
        onTargetRoom: false,
        status: "status_check_failed",
        error: errorMessage(error),
      }));
      if (!this.running || !this.page || !state.ready || !state.onTargetRoom) {
        return this._likeFailure(
          "NOT_READY",
          state.error || `browser is not ready (${state.status || "unknown"})`
        );
      }
      if (this.emergencyStopped) {
        return this._likeFailure("EMERGENCY_STOPPED", "browser controller is emergency-stopped");
      }

      const page = this.page;
      const button = page.locator(LIKE_BUTTON_SELECTOR).first();
      const [visible, enabled] = await Promise.all([
        button.isVisible().catch(() => false),
        button.isEnabled().catch(() => false),
      ]);
      if (!visible || !enabled) {
        return this._likeFailure("LIKE_BUTTON_UNAVAILABLE", "like button is not visible and enabled");
      }
      if (this.emergencyStopped || !this.running || !this._isTargetUrl(page.url?.())) {
        return this._likeFailure("NOT_READY", "browser stopped or left the target room before like");
      }

      for (let index = 0; index < requestedCount; index += 1) {
        if (
          !canContinue() ||
          this.emergencyStopped ||
          !this.running ||
          this.page !== page ||
          this._pageClosed(page) ||
          !this._isTargetUrl(page.url?.())
        ) {
          return this._likeFailure(
            "LIKE_INTERRUPTED",
            "like batch stopped before all clicks completed or room went offline",
            { count: completedCount }
          );
        }
        // Each requested click is attempted exactly once. A click error aborts
        // the batch; completed clicks are counted but never replayed.
        await button.click();
        completedCount += 1;
      }
      const result = {
        ok: true,
        code: "LIKED",
        count: completedCount,
        roomId: this.roomId,
        at: Date.now(),
      };
      this._setState({
        lastLikeAt: result.at,
        likeCount: Number(this.state.likeCount || 0) + completedCount,
        lastLikeOk: true,
        lastLikeError: "",
      });
      this.emit("liked", result);
      return result;
    } catch (error) {
      return this._likeFailure("LIKE_FAILED", errorMessage(error), { count: completedCount });
    } finally {
      this.liking = false;
      releaseLikePromise?.();
      this.likePromise = null;
    }
  }

  _likeFailure(code, message, extra = {}) {
    const completedCount = Math.max(0, Number(extra.count || 0));
    const result = {
      ok: false,
      code,
      count: completedCount,
      error: String(message || code),
      roomId: this.roomId,
      at: Date.now(),
      ...extra,
    };
    this._setState({
      lastLikeAt: result.at,
      likeCount: Number(this.state.likeCount || 0) + completedCount,
      lastLikeOk: false,
      lastLikeError: result.error,
    });
    this.emit("like-failed", result);
    return result;
  }

  async stop(reason = "stopped") {
    return this._shutdown(false, reason);
  }

  async emergencyStop(reason = "emergency stop") {
    this.emergencyStopped = true;
    return this._shutdown(true, reason);
  }

  async _shutdown(emergency, reason) {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.closing = true;
      this.running = false;
      this._clearPoll();
      this._clearRelaunch({ resetBackoff: true });
      this._stopChatObservation({ resetBaseline: true });
      this._setState({
        status: emergency ? "emergency_stopped" : "stopped",
        running: false,
        ready: false,
        loggedIn: false,
        loginPageOpen: false,
        loginPageUrl: "",
        emergencyStopped: this.emergencyStopped,
      });

      const context = this.context;
      this.context = null;
      this.page = null;
      this.loginPage = null;
      if (context) await context.close().catch((error) => this._emitControllerError(error));
      if (activeController === this) activeController = null;

      const result = {
        ok: true,
        emergency,
        reason: String(reason || ""),
        state: this.getState(),
      };
      this.emit(emergency ? "emergency-stop" : "stopped", result);
      return result;
    })();

    try {
      return await this.stopPromise;
    } finally {
      this.stopPromise = null;
      this.closing = false;
    }
  }

  resetEmergencyStop() {
    if (this.running) throw new Error("cannot reset emergency stop while the browser is running");
    this.emergencyStopped = false;
    this._setState({ emergencyStopped: false, status: "idle", lastSendError: "" });
    return this.getState();
  }

  _setState(patch) {
    const previousReady = this.state.ready;
    this.state = {
      ...this.state,
      ...patch,
      emergencyStopped: this.emergencyStopped,
      updatedAt: Date.now(),
    };
    const snapshot = this.getState();
    this.emit("state", snapshot);
    if (!previousReady && snapshot.ready) this.emit("ready", snapshot);
    if (previousReady && !snapshot.ready) this.emit("not-ready", snapshot);
  }

  _emitControllerError(error) {
    const payload = error instanceof Error ? error : new Error(errorMessage(error));
    this.emit("controller-error", payload);
    if (this.listenerCount("error") > 0) this.emit("error", payload);
  }
}

function getActiveBrowserController() {
  return activeController;
}

module.exports = BrowserController;
module.exports.BrowserController = BrowserController;
module.exports.DEFAULT_PROFILE_DIR = DEFAULT_PROFILE_DIR;
module.exports.CHAT_INPUT_SELECTOR = CHAT_INPUT_SELECTOR;
module.exports.SEND_BUTTON_SELECTOR = SEND_BUTTON_SELECTOR;
module.exports.LIKE_BUTTON_SELECTOR = LIKE_BUTTON_SELECTOR;
module.exports.PASSPORT_LOGIN_URL = PASSPORT_LOGIN_URL;
module.exports.getActiveBrowserController = getActiveBrowserController;
