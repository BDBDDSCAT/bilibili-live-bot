"use strict";

const LAST_ROOM_STORAGE_KEY = "bili-live-bot:last-room-url";

const state = {
  phase: "stopped",
  busy: false,
  control: {},
  snapshot: {},
  latestChat: "",
  latestReply: "",
  // 浏览器托管与发送队列是同一批发送的两个观测口径，分开计数取较大值，
  // 相加或混着累加都会把“已回复 N 条”算虚高。
  sentFromControl: 0,
  sentFromQueue: 0,
  activity: [],
  roomId: 0,
  roomUrl: "",
  roomInfo: {},
  roomBusy: false,
};

function sentCount() {
  return Math.max(state.sentFromControl, state.sentFromQueue);
}

const els = {
  statusDot: document.querySelector("#statusDot"),
  statusText: document.querySelector("#statusText"),
  statusDetail: document.querySelector("#statusDetail"),
  aiStatus: document.querySelector("#aiStatus"),
  restartAiButton: document.querySelector("#restartAiButton"),
  startButton: document.querySelector("#startButton"),
  stopButton: document.querySelector("#stopButton"),
  sendSummary: document.querySelector("#sendSummary"),
  roomForm: document.querySelector("#roomForm"),
  roomInput: document.querySelector("#roomInput"),
  switchRoomButton: document.querySelector("#switchRoomButton"),
  roomMessage: document.querySelector("#roomMessage"),
  roomHeading: document.querySelector("#roomHeading"),
  roomLink: document.querySelector("#roomLink"),
  featureMessage: document.querySelector("#featureMessage"),
  pointsButton: document.querySelector("#pointsButton"),
  gameButton: document.querySelector("#gameButton"),
  gameState: document.querySelector("#gameState"),
  latestChat: document.querySelector("#latestChat"),
  replyCount: document.querySelector("#replyCount"),
  likeCount: document.querySelector("#likeCount"),
  giftToday: document.querySelector("#giftToday"),
  pkScore: document.querySelector("#pkScore"),
  pendingOrders: document.querySelector("#pendingOrders"),
  activityDetails: document.querySelector("#activityDetails"),
  activityText: document.querySelector("#activityText"),
  overlayMessage: document.querySelector("#overlayMessage"),
  overlayDownloads: document.querySelector("#overlayDownloads"),
};

function normalizeRoomInput(value) {
  const input = String(value || "").trim();
  if (/^\d+$/.test(input) && Number(input) > 0) {
    const roomId = Number(input);
    return { roomId, roomUrl: `https://live.bilibili.com/${roomId}` };
  }
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }
  if (
    !["https:", "http:"].includes(parsed.protocol) ||
    parsed.hostname.toLowerCase() !== "live.bilibili.com"
  ) {
    return null;
  }
  const roomId = Number(parsed.pathname.match(/^\/(\d+)(?:\/|$)/)?.[1] || 0);
  return roomId > 0
    ? { roomId, roomUrl: `https://live.bilibili.com/${roomId}` }
    : null;
}

function savedRoomTarget() {
  try {
    return normalizeRoomInput(window.localStorage.getItem(LAST_ROOM_STORAGE_KEY));
  } catch {
    return null;
  }
}

function saveRoomTarget(target) {
  try {
    window.localStorage.setItem(LAST_ROOM_STORAGE_KEY, target.roomUrl);
  } catch {
    // The current server state remains authoritative when storage is unavailable.
  }
}

function roomTargetFromPayload(payload = {}) {
  const candidates = [
    payload.state?.roomUrl,
    payload.browserControl?.roomUrl,
    payload.snapshot?.browserControl?.roomUrl,
    payload.snapshot?.managedRoom?.roomUrl,
    payload.snapshot?.roomInput,
    payload.result?.state?.roomUrl,
  ];
  for (const value of candidates) {
    const target = normalizeRoomInput(value);
    if (target) return target;
  }
  const roomId = Number(
    payload.state?.roomId ||
      payload.browserControl?.roomId ||
      payload.snapshot?.browserControl?.roomId ||
      payload.snapshot?.managedRoom?.roomId ||
      0
  );
  return normalizeRoomInput(roomId ? String(roomId) : "");
}

function renderManagedRoom(target, message = "") {
  if (!target) return;
  state.roomId = target.roomId;
  state.roomUrl = target.roomUrl;
  const sameRoomInfo = Number(state.roomInfo?.roomId || 0) === target.roomId ? state.roomInfo : {};
  els.roomHeading.textContent = sameRoomInfo.uname || `房间 ${target.roomId}`;
  els.roomLink.href = target.roomUrl;
  els.roomLink.textContent = sameRoomInfo.title
    ? `房间 ${target.roomId} · ${sameRoomInfo.title} · ${sameRoomInfo.liveStatusLabel || "状态未知"}`
    : `live.bilibili.com/${target.roomId}`;
  if (document.activeElement !== els.roomInput || message) {
    els.roomInput.value = target.roomUrl;
  }
  els.roomMessage.textContent = message || `当前托管：房间 ${target.roomId}`;
}

function renderRoomIdentity(room = {}) {
  const roomId = Number(room.roomId || 0);
  if (!roomId) return;
  state.roomInfo = { ...room };
  if (state.roomId && state.roomId !== roomId) return;
  state.roomId = roomId;
  state.roomUrl = `https://live.bilibili.com/${roomId}`;
  els.roomHeading.textContent = room.uname || `房间 ${roomId}`;
  els.roomLink.href = state.roomUrl;
  els.roomLink.textContent = [
    `房间 ${roomId}`,
    room.title,
    room.liveStatusLabel,
  ]
    .filter(Boolean)
    .join(" · ");
}

function setRoomBusy(busy) {
  state.roomBusy = busy;
  els.roomInput.disabled = busy;
  els.switchRoomButton.disabled = busy;
  els.switchRoomButton.textContent = busy ? "切换中…" : "切换房间";
}

function formatNumber(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function formatTime(value = Date.now()) {
  const date = new Date(Number(value || Date.now()));
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

function postJson(url, body = {}) {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function controlFromPayload(payload = {}) {
  const candidates = [
    payload.browserControl,
    payload.snapshot?.browserControl,
    payload.state,
    payload.result?.state,
    payload.result,
    payload,
  ];
  return (
    candidates.find(
      (item) => item && typeof item === "object" && !Array.isArray(item) && (item.status || item.ready !== undefined)
    ) || {}
  );
}

function phaseFromControl(control = {}) {
  const status = String(control.status || "").toLowerCase();
  if (control.ready === true || status === "ready") return "running";
  if (
    control.running === true ||
    [
      "starting",
      "switching_room",
      "waiting_for_login",
      "waiting_for_room",
      "room_tab_closed",
    ].includes(status)
  ) {
    return "waiting";
  }
  return "stopped";
}

function renderPhase(phase, detail = "") {
  state.phase = phase;
  const labels = {
    waiting: "等待登录",
    running: "自动运行中",
    stopped: "已停止",
  };
  const details = {
    waiting: "请在打开的 B站页面登录，登录成功后会自动开始。",
    running: "B站已连接，已开启的功能正在运行。",
    stopped: "点击登录按钮即可开始。",
  };
  els.statusDot.className = `status-dot ${phase}`;
  els.statusText.textContent = labels[phase];
  els.statusDetail.textContent = detail || details[phase];
  els.startButton.hidden = phase !== "stopped";
  els.stopButton.hidden = phase === "stopped";
  els.startButton.disabled = state.busy;
  els.stopButton.disabled = state.busy;
}

function controlStatusDetail(control = {}, phase = phaseFromControl(control)) {
  const status = String(control.status || "").toLowerCase();
  if (status === "starting") return "正在打开 B站…";
  if (status === "switching_room") return "正在切换直播间…";
  if (status === "waiting_for_login") return "请在打开的 B站页面完成登录，登录后会自动开始。";
  if (status === "waiting_for_room") return "正在进入直播间…";
  if (status === "room_tab_closed") return "B站页面被关了，正在自动恢复…";
  if (phase === "running" && Number(state.snapshot?.room?.liveStatus ?? -1) === 0) {
    return "已登录；直播间未开播，开播后会自动回复、发言和点赞。";
  }
  if (phase === "running" && localAiProblem(state.snapshot)) {
    return "B站已连接；AI 暂时断开，其他已开启的功能继续运行。";
  }
  if (phase === "running") return "B站已连接，已开启的功能正在运行。";
  if (phase === "waiting") return "正在准备 B站页面，完成后会自动开始。";
  return "点击登录按钮即可开始。";
}

function localAiProblem(snapshot = {}) {
  const service = snapshot.localAiService || {};
  const ai = snapshot.localAi || {};
  if (ai.enabled === false) return "";
  if (String(service.status || "").toLowerCase() === "error") {
    return String(service.message || "AI 服务不可用");
  }
  if (ai.available === false && String(ai.lastError || "").trim()) {
    return String(ai.lastError).trim();
  }
  return "";
}

function renderLocalAiStatus(snapshot = {}) {
  if (!els.aiStatus) return;
  const service = snapshot.localAiService || {};
  const ai = snapshot.localAi || {};
  const status = String(service.status || "idle").toLowerCase();
  let stateName = "idle";
  let text = "AI：将在开始时自动启动";
  if (ai.enabled === false) {
    stateName = "off";
    text = "AI：已关闭";
  } else if (status === "checking") {
    stateName = "checking";
    text = "AI：正在启动…";
  } else if (localAiProblem(snapshot)) {
    stateName = "error";
    text = "AI：已断开，暂时不会回复";
  } else if (status === "ready" || ai.available === true) {
    stateName = "ready";
    text = "AI：正常";
  } else if (snapshot.browserControl?.ready) {
    text = "AI：等待首次回复";
  }
  els.aiStatus.dataset.state = stateName;
  els.aiStatus.textContent = text;
  if (els.restartAiButton) els.restartAiButton.hidden = stateName !== "error";
}

function renderSendSummary() {
  const parts = [`已发送 ${formatNumber(sentCount())} 条`];
  if (state.latestReply) parts.push(`最近自动回复：${state.latestReply}`);
  els.sendSummary.textContent = parts.join(" · ");
  els.sendSummary.hidden = !sentCount() && !state.latestReply;
}

function updateControl(control = {}) {
  state.control = { ...state.control, ...control };
  const phase = phaseFromControl(state.control);
  if (state.control.lastSendOk === true && state.control.lastSendText) {
    if (state.control.lastSendAt !== state.controlRenderedSendAt) {
      state.sentFromControl += 1;
      state.controlRenderedSendAt = state.control.lastSendAt;
    }
    state.latestReply = state.control.lastSendText;
  }
  renderSendSummary();
  if (Number(state.snapshot?.autoLikeSchedule?.sessionTargetClicks || 0) <= 0) {
    els.likeCount.textContent = `${formatNumber(state.control.likeCount || 0)} 次`;
  }
  renderPhase(phase, controlStatusDetail(state.control, phase));
}

function moduleEnabled(moduleStatus = {}, names = []) {
  return names.every((name) => moduleStatus?.[name]?.enabled !== false);
}

function renderFeatureSwitches(moduleStatus = {}) {
  document.querySelectorAll("[data-modules]").forEach((input) => {
    if (input === document.activeElement) return;
    const names = String(input.dataset.modules || "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    input.checked = moduleEnabled(moduleStatus, names);
  });
}

function giftText(giftStats = {}) {
  if (giftStats.totalValueText) return giftStats.totalValueText;
  if (Number(giftStats.totalCoin || 0) > 0) return `${formatNumber(giftStats.totalCoin)} 电池`;
  return `${formatNumber(giftStats.totalGiftCount || 0)} 份`;
}

function renderSnapshot(snapshot = {}) {
  state.snapshot = snapshot;
  renderRoomIdentity(snapshot.room || {});
  if (snapshot.browserControl) updateControl(snapshot.browserControl);
  renderLocalAiStatus(snapshot);
  renderFeatureSwitches(snapshot.moduleStatus || {});

  const queue = Array.isArray(snapshot.autoSendQueue) ? snapshot.autoSendQueue : [];
  const sentInQueue = queue.filter((item) => item.status === "sent").length;
  // Only count messages confirmed as sent. Generated or blocked replies are not
  // presented to the streamer as successful output.
  state.sentFromQueue = Math.max(state.sentFromQueue, sentInQueue);
  const latestSent = queue.find((item) => item.status === "sent");
  if (latestSent?.sentText || latestSent?.reply) {
    state.latestReply = latestSent.sentText || latestSent.reply;
  }
  renderSendSummary();

  els.latestChat.textContent = state.latestChat || "还没有弹幕";
  els.replyCount.textContent = `${formatNumber(sentCount())} 条`;
  const likeSchedule = snapshot.autoLikeSchedule || {};
  const likeTarget = Number(likeSchedule.sessionTargetClicks || 0);
  const likeProgress = Number(likeSchedule.sessionClicks || 0);
  if (likeTarget > 0) {
    els.likeCount.textContent = likeSchedule.limitReached
      ? `本场完成 ${formatNumber(likeProgress)} 次`
      : likeSchedule.waitingForLive
        ? `${formatNumber(likeProgress)} / ${formatNumber(likeTarget)} 次 · 等待开播`
      : `${formatNumber(likeProgress)} / ${formatNumber(likeTarget)} 次`;
  }
  els.giftToday.textContent = giftText(snapshot.giftStats || {});

  const pk = snapshot.pk || {};
  const own = Number(pk.own?.votes || 0);
  const opponent = Number(pk.opponent?.votes || 0);
  els.pkScore.textContent = pk.active || own || opponent ? `${formatNumber(own)} : ${formatNumber(opponent)}` : "未开始";

  const pending = Number(snapshot.points?.redemptions?.pendingCount || 0);
  els.pendingOrders.textContent = `${formatNumber(pending)} 个`;

  const game = snapshot.commandState?.game || {};
  els.gameState.textContent = game.active ? `${game.playerCount || 0} 人正在玩` : "等待开局";
}

function addActivity(entry = {}) {
  const label = String(entry.label || entry.kind || "");
  const message = String(entry.message || entry.text || "").trim();
  if (!message) return;
  if (!/弹幕|礼物|醒目|上舰|大航海|PK|已发B站|建议回复|欢迎|积分|兑换/.test(`${label} ${entry.kind || ""}`)) {
    return;
  }
  state.activity.unshift(`[${formatTime(entry.at)}] ${label ? `${label} ` : ""}${message}`);
  state.activity = state.activity.slice(0, 40);
  els.activityText.textContent = state.activity.join("\n");
  els.activityDetails.hidden = state.activity.length === 0;

  if (entry.kind === "chat" || label === "弹幕") {
    const user = entry.event?.displayUserName || entry.event?.userName || "观众";
    const text = entry.event?.text || message.replace(/^.*?:\s*/, "");
    state.latestChat = `${user}：${text}`;
    els.latestChat.textContent = state.latestChat;
  }
}

function updateFromPayload(payload = {}) {
  const managedRoom = roomTargetFromPayload(payload);
  if (managedRoom) renderManagedRoom(managedRoom);
  if (payload.snapshot) renderSnapshot(payload.snapshot);
  const control = controlFromPayload(payload);
  if (Object.keys(control).length) updateControl(control);
}

async function refreshControl() {
  try {
    updateFromPayload(await fetchJson("/api/browser-control/state"));
    return true;
  } catch {
    // The buttons keep working even if one background refresh is missed.
    return false;
  }
}

async function startRobot() {
  if (state.busy) return;
  const typedRoom = String(els.roomInput.value || "").trim();
  const target = typedRoom
    ? normalizeRoomInput(typedRoom)
    : normalizeRoomInput(state.roomUrl) || savedRoomTarget();
  if (!target) {
    els.roomMessage.textContent = typedRoom
      ? "这个直播间链接不对，没有启动旧房间。请重新粘贴 B站直播间链接或房间号。"
      : "请粘贴有效的 B站直播间链接，或输入房间号。";
    els.roomInput.focus();
    return;
  }
  state.busy = true;
  renderPhase("waiting");
  els.stopButton.hidden = false;
  try {
    updateFromPayload(await postJson("/api/browser-control/start", { room: target.roomUrl }));
    saveRoomTarget(target);
    if (state.phase === "stopped") renderPhase("waiting");
  } catch {
    renderPhase("stopped", "没能打开 B站，请再点一次。");
  } finally {
    state.busy = false;
    renderPhase(state.phase, els.statusDetail.textContent);
  }
}

async function switchManagedRoom(event) {
  event?.preventDefault?.();
  if (state.roomBusy) return;
  const target = normalizeRoomInput(els.roomInput.value);
  if (!target) {
    els.roomMessage.textContent = "只支持 B站直播间链接或纯房间号。";
    els.roomInput.focus();
    return;
  }
  if (target.roomId === state.roomId) {
    renderManagedRoom(target, `当前已是房间 ${target.roomId}。`);
    saveRoomTarget(target);
    return;
  }

  setRoomBusy(true);
  els.roomMessage.textContent = `正在切换到房间 ${target.roomId}…`;
  try {
    const payload = await postJson("/api/browser-control/start", { room: target.roomUrl });
    updateFromPayload(payload);
    saveRoomTarget(target);
    const control = controlFromPayload(payload);
    const message = control.ready
      ? `已切换到房间 ${target.roomId}，机器人继续运行。`
      : `已打开房间 ${target.roomId}；如果 B站要求登录，登录后会自动运行。`;
    renderManagedRoom(target, message);
  } catch (error) {
    els.roomMessage.textContent = `切换失败：${error.message || "请再试一次"}`;
  } finally {
    setRoomBusy(false);
  }
}

async function stopRobot() {
  if (state.busy) return;
  state.busy = true;
  els.stopButton.disabled = true;
  let stopped = false;
  let stopError = "";
  try {
    const payload = await postJson("/api/browser-control/stop");
    updateFromPayload(payload);
    stopped = phaseFromControl(controlFromPayload(payload)) === "stopped";
  } catch (error) {
    stopError = error.message || "停止请求失败";
    const refreshed = await refreshControl();
    if (refreshed) stopped = phaseFromControl(state.control) === "stopped";
  } finally {
    state.busy = false;
    els.stopButton.disabled = false;
    if (stopped) {
      state.control = { ...state.control, status: "stopped", running: false, ready: false };
      renderPhase("stopped", "机器人已停止。");
    } else {
      const phase = phaseFromControl(state.control);
      renderPhase(
        phase,
        `停止失败，机器人可能仍在运行，请再点一次。${stopError ? `（${stopError}）` : ""}`
      );
    }
  }
}

async function restartLocalAi() {
  if (!els.restartAiButton || els.restartAiButton.disabled) return;
  els.restartAiButton.disabled = true;
  els.restartAiButton.textContent = "正在启动…";
  els.aiStatus.dataset.state = "checking";
  els.aiStatus.textContent = "AI：正在启动…";
  try {
    const payload = await postJson("/api/local-ai/start");
    updateFromPayload(payload);
    if (payload.localAiService?.status !== "ready") {
      els.aiStatus.dataset.state = "error";
      els.aiStatus.textContent = "AI：仍未启动，请确认 Ollama 已安装";
    }
  } catch {
    els.aiStatus.dataset.state = "error";
    els.aiStatus.textContent = "AI：启动失败，请再点一次";
  } finally {
    els.restartAiButton.disabled = false;
    els.restartAiButton.textContent = "启动AI";
    els.restartAiButton.hidden = els.aiStatus.dataset.state !== "error";
  }
}

async function setFeature(input) {
  const enabled = input.checked;
  const names = String(input.dataset.modules || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  input.disabled = true;
  try {
    for (const name of names) {
      const payload = await postJson("/api/modules", { name, enabled });
      if (payload.snapshot) renderSnapshot(payload.snapshot);
    }
    const label = input.closest(".feature-row")?.querySelector("strong")?.textContent || "这项功能";
    els.featureMessage.textContent = `${label}已${enabled ? "开启" : "关闭"}。`;
  } catch {
    input.checked = !enabled;
    els.featureMessage.textContent = "没有改成功，请再点一次。";
  } finally {
    input.disabled = false;
  }
}

async function copyOverlayAddress(button) {
  const address = new URL(String(button.dataset.copyOverlay || "/"), window.location.origin).href;
  const originalLabel = button.textContent;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(address);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = address;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      try {
        textarea.select();
        if (!document.execCommand("copy")) throw new Error("复制失败");
      } finally {
        textarea.remove();
      }
    }
    button.textContent = "已复制";
    els.overlayMessage.textContent = `已复制：${address}`;
  } catch {
    els.overlayMessage.textContent = `请手动复制：${address}`;
  } finally {
    window.setTimeout(() => {
      button.textContent = originalLabel;
    }, 1600);
  }
}

function formatFileSize(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function renderOverlayArtifacts(artifacts = []) {
  if (!els.overlayDownloads) return;
  const rows = (Array.isArray(artifacts) ? artifacts : []).filter((item) => item?.downloadUrl);
  els.overlayDownloads.replaceChildren();
  els.overlayDownloads.hidden = rows.length === 0;
  if (!rows.length) return;

  const heading = document.createElement("strong");
  heading.className = "overlay-downloads-title";
  heading.textContent = "可直接下载";
  els.overlayDownloads.appendChild(heading);

  const appendDownload = (artifact, parent = els.overlayDownloads) => {
    const row = document.createElement("div");
    row.className = "overlay-download-row";
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = artifact.label || String(artifact.format || "").toUpperCase();
    const meta = document.createElement("small");
    meta.textContent = `透明背景 · ${formatFileSize(artifact.bytes)}`;
    copy.append(label, meta);
    const download = document.createElement("a");
    download.href = artifact.downloadUrl;
    download.download = artifact.filename || "";
    const format = String(artifact.format || "").toLowerCase();
    download.textContent = format === "png" ? "下载静态图" : format === "gif" ? "下载动图" : "下载高清动图";
    row.append(copy, download);
    parent.appendChild(row);
  };

  rows.filter((item) => ["png", "gif"].includes(String(item.format || "").toLowerCase())).forEach((item) =>
    appendDownload(item)
  );
  const advancedRows = rows.filter(
    (item) => !["png", "gif"].includes(String(item.format || "").toLowerCase())
  );
  if (advancedRows.length) {
    const details = document.createElement("details");
    details.className = "overlay-download-advanced";
    const summary = document.createElement("summary");
    summary.textContent = "OBS 高清备用（一般不用管）";
    details.appendChild(summary);
    advancedRows.forEach((item) => appendDownload(item, details));
    els.overlayDownloads.appendChild(details);
  }
}

async function refreshOverlayArtifacts() {
  try {
    const payload = await fetchJson("/api/overlays");
    renderOverlayArtifacts(payload.artifacts || []);
  } catch {
    // 尚未生成素材时保持界面安静。
  }
}

async function generateOverlay(button) {
  const buttons = [...document.querySelectorAll("[data-generate-overlay]")];
  const originalLabel = button.textContent;
  buttons.forEach((item) => { item.disabled = true; });
  button.textContent = "正在生成…";
  const format = button.dataset.generateOverlay || "gif";
  els.overlayMessage.textContent =
    format === "png"
      ? "正在抓取透明 PNG，完成后会自动显示下载。"
      : "正在生成透明 GIF，并同时准备 OBS 高质量 WebM…";
  try {
    const payload = await postJson("/api/overlays/export", {
      format,
      mode: button.dataset.overlayMode || (format === "png" ? "static" : "scroll"),
      includeWebm: format === "gif",
    });
    const artifacts = payload.result?.artifacts || payload.state?.artifacts || [];
    renderOverlayArtifacts(artifacts);
    els.overlayMessage.textContent =
      format === "png"
        ? "透明静态图已生成，直接点下载即可。"
        : "透明动图已生成，直接点下载即可。";
  } catch (error) {
    els.overlayMessage.textContent = `素材生成失败：${error.message || "请再试一次"}`;
  } finally {
    button.textContent = originalLabel;
    buttons.forEach((item) => { item.disabled = false; });
  }
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.addEventListener("snapshot", (event) => {
    try {
      renderSnapshot(JSON.parse(event.data));
    } catch {
      // Ignore a malformed update and wait for the next one.
    }
  });
  source.addEventListener("log", (event) => {
    try {
      addActivity(JSON.parse(event.data));
    } catch {
      // Ignore a malformed update and wait for the next one.
    }
  });
  source.addEventListener("action", (event) => {
    try {
      JSON.parse(event.data);
      // action 只表示已生成，并不等于 B 站已确认发出；成功后由
      // browserControl.lastSendOk 或 sent 队列快照更新页面。
    } catch {
      // Ignore a malformed update and wait for the next one.
    }
  });
  source.addEventListener("clear", () => {
    // 换房间/手动清屏时服务端会广播 clear，旧房间的动态不能留在屏上。
    state.activity = [];
    state.latestChat = "";
    state.latestReply = "";
    state.sentFromControl = 0;
    state.sentFromQueue = 0;
    state.controlRenderedSendAt = 0;
    els.activityText.textContent = "";
    els.activityDetails.hidden = true;
    els.latestChat.textContent = "还没有弹幕";
    renderSendSummary();
  });
}

function bindEvents() {
  els.startButton.addEventListener("click", startRobot);
  els.stopButton.addEventListener("click", stopRobot);
  els.restartAiButton?.addEventListener("click", restartLocalAi);
  els.roomForm.addEventListener("submit", switchManagedRoom);
  document.querySelectorAll("[data-modules]").forEach((input) => {
    input.addEventListener("change", () => setFeature(input));
  });
  document.querySelectorAll("[data-copy-overlay]").forEach((button) => {
    button.addEventListener("click", () => copyOverlayAddress(button));
  });
  document.querySelectorAll("[data-generate-overlay]").forEach((button) => {
    button.addEventListener("click", () => generateOverlay(button));
  });
  els.pointsButton.addEventListener("click", () => {
    els.featureMessage.textContent = "观众发“签到”、“我的积分”或“积分商城”就能使用。";
  });
  els.gameButton.addEventListener("click", () => {
    els.featureMessage.textContent = "观众发“#卧底开始”即可开局，其他观众发“加入卧底”。";
  });
}

if (window.location.protocol === "file:") {
  window.location.replace("http://127.0.0.1:4322/");
} else {
  const savedRoom = savedRoomTarget();
  if (savedRoom) renderManagedRoom(savedRoom, "正在读取当前托管的直播间…");
  bindEvents();
  connectEvents();
  refreshControl();
  refreshOverlayArtifacts();
  window.setInterval(refreshControl, 1500);
}
