"use strict";

const mode = document.body.dataset.overlayMode || "static";
const overlayParams = new URLSearchParams(window.location.search);
const exportMode = overlayParams.get("export") === "1";
const exportDurationSec = Math.max(0, Number(overlayParams.get("exportDuration") || 0));
let lastSignature = "";

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function number(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function valueText(item = {}) {
  if (text(item.valueText)) return text(item.valueText);
  const coin = number(item.totalCoin);
  return coin > 0 ? `${new Intl.NumberFormat("zh-CN").format(coin / 100)}电池` : "0电池";
}

function totalValueText(stats = {}) {
  if (text(stats.totalValueText)) return text(stats.totalValueText);
  return valueText({ totalCoin: stats.totalCoin });
}

function safeImageUrl(value) {
  try {
    const url = new URL(text(value), window.location.href);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    const host = url.hostname.toLowerCase();
    if (
      host === "hdslb.com" ||
      host.endsWith(".hdslb.com") ||
      host === "bilibili.com" ||
      host.endsWith(".bilibili.com")
    ) {
      return `/api/image?url=${encodeURIComponent(url.href)}`;
    }
    // 白名单外的外站图片一律不热链，跟非法协议同样处理
    return "";
  } catch {
    return "";
  }
}

function setImage(image, value) {
  const source = safeImageUrl(value);
  if (!source) {
    image.removeAttribute("src");
    return;
  }
  image.src = source;
  image.onerror = () => image.removeAttribute("src");
}

function giftRows(stats = {}) {
  return (Array.isArray(stats.giftFeed) ? stats.giftFeed : [])
    .filter((item) => item && item.isSimulated !== true)
    .slice(0, 12);
}

function giftDescription(item = {}) {
  const action = text(item.action, "送出");
  const sourceGift = text(item.sourceGiftName);
  if (sourceGift && sourceGift !== text(item.giftName)) {
    return `${action} ${sourceGift} → ${text(item.giftName, "礼物")}`;
  }
  return `${action} ${text(item.giftName, "礼物")}`;
}

function renderStatic(stats = {}) {
  const latest = giftRows(stats)[0];
  document.querySelector("#giftTotal").textContent = totalValueText(stats);
  document.querySelector("#giftTotalCount").textContent = `${number(stats.totalGiftCount)} 份`;

  if (!latest) {
    document.querySelector("#giftUser").textContent = "等待送礼";
    document.querySelector("#giftAction").textContent = "礼物出现后会自动展示";
    document.querySelector("#giftName").textContent = "还没有礼物";
    document.querySelector("#giftValue").textContent = "—";
    document.querySelector("#giftCount").textContent = "";
    setImage(document.querySelector("#giftFace"), "");
    setImage(document.querySelector("#giftIcon"), "");
    return;
  }

  document.querySelector("#giftUser").textContent = text(latest.displayUserName, text(latest.userName, "观众"));
  document.querySelector("#giftAction").textContent = text(latest.action, "送出礼物");
  document.querySelector("#giftName").textContent = text(latest.giftName, "礼物");
  document.querySelector("#giftValue").textContent = valueText(latest);
  document.querySelector("#giftCount").textContent = `×${Math.max(1, number(latest.count, 1))}`;
  setImage(document.querySelector("#giftFace"), latest.face);
  setImage(document.querySelector("#giftIcon"), latest.giftIcon);
}

function makeMarqueeItem(item) {
  const card = document.createElement("article");
  card.className = "marquee-gift";

  const avatar = document.createElement("img");
  avatar.className = "marquee-avatar";
  avatar.alt = "";
  setImage(avatar, item.face);

  const copy = document.createElement("span");
  copy.className = "marquee-copy";
  const user = document.createElement("strong");
  user.textContent = text(item.displayUserName, text(item.userName, "观众"));
  const detail = document.createElement("small");
  detail.textContent = `${giftDescription(item)} ×${Math.max(1, number(item.count, 1))}`;
  copy.append(user, detail);

  const icon = document.createElement("img");
  icon.className = "marquee-icon";
  icon.alt = "";
  setImage(icon, item.giftIcon);

  const value = document.createElement("span");
  value.className = "marquee-value";
  value.textContent = valueText(item);

  card.append(avatar, copy, icon, value);
  return card;
}

function renderScroll(stats = {}) {
  document.querySelector("#scrollGiftTotal").textContent = totalValueText(stats);
  document.querySelector("#scrollGiftCount").textContent = `${number(stats.totalGiftCount)} 份`;

  const rows = giftRows(stats);
  const track = document.querySelector("#giftTrack");
  if (!rows.length) {
    track.className = "gift-marquee-track";
    track.replaceChildren(Object.assign(document.createElement("div"), {
      className: "gift-marquee-empty",
      textContent: "等待第一份礼物",
    }));
    return;
  }

  const displayRows = [];
  while (displayRows.length < Math.max(6, rows.length)) displayRows.push(...rows);
  displayRows.length = Math.max(6, rows.length);

  const groups = [0, 1].map((groupIndex) => {
    const group = document.createElement("div");
    group.className = "gift-marquee-group";
    group.setAttribute("aria-hidden", groupIndex ? "true" : "false");
    displayRows.forEach((item) => group.appendChild(makeMarqueeItem(item)));
    return group;
  });
  track.replaceChildren(...groups);
  const tickerDuration = exportMode && exportDurationSec > 0
    ? exportDurationSec
    : Math.max(24, displayRows.length * 6);
  track.style.setProperty("--ticker-duration", `${tickerDuration}s`);
  track.className = "gift-marquee-track is-running";
}

function render(stats = {}) {
  const rows = giftRows(stats);
  const signature = JSON.stringify({
    totalCoin: number(stats.totalCoin),
    totalValueText: text(stats.totalValueText),
    totalGiftCount: number(stats.totalGiftCount),
    rows: rows.map((item) => [
      item.id,
      item.at,
      item.displayUserName,
      item.userName,
      item.face,
      item.action,
      item.giftName,
      item.giftIcon,
      item.count,
      item.totalCoin,
      item.valueText,
    ]),
  });
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (mode === "scroll") renderScroll(stats);
  else renderStatic(stats);
}

let refreshBusy = false;
let exportRetryCount = 0;

async function refresh() {
  // 上一次请求还没回来就跳过本轮，避免慢响应后到覆盖新数据
  if (refreshBusy) return;
  refreshBusy = true;
  const status = document.querySelector("#overlayStatus");
  try {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    render(payload.snapshot?.giftStats || payload.giftStats || {});
    status.textContent = "礼物已同步";
    window.__giftOverlayExportReady = true;
    window.__giftOverlayExportError = "";
  } catch (error) {
    status.textContent = "等待重新连接";
    if (exportMode && window.__giftOverlayExportReady !== true) {
      // 导出模式下把失败原因留给导出端读取，并有限次重试，别让一次网络抖动毁掉整次导出
      window.__giftOverlayExportError = `状态拉取失败：${(error && error.message) || error}`;
      exportRetryCount += 1;
      if (exportRetryCount < 8) window.setTimeout(refresh, 600);
    }
  } finally {
    refreshBusy = false;
  }
}

refresh();
if (!exportMode) window.setInterval(refresh, 1500);
