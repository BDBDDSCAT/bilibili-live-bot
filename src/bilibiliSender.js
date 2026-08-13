"use strict";

const fs = require("node:fs");
const path = require("node:path");
const QRCode = require("qrcode");

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
const HTTP_TIMEOUT_MS = 10000;

function requestTimeoutSignal(timeoutMs = HTTP_TIMEOUT_MS) {
  return typeof AbortSignal?.timeout === "function"
    ? AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || HTTP_TIMEOUT_MS))
    : undefined;
}

// Once json() fails the body is already consumed and text() throws again, so
// read the raw body first and keep it in the fallback message.
async function readJsonPayload(response) {
  const rawBody = await response.text().catch(() => "");
  try {
    return JSON.parse(rawBody);
  } catch {
    return {
      code: response.status,
      message: rawBody.trim().slice(0, 200) || response.statusText,
    };
  }
}

function parseCookie(cookieText) {
  const entries = {};
  String(cookieText || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return;
      const key = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      entries[key] = value;
    });
  return entries;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

function cookieInfo(cookieText) {
  const cookie = extractCookie(cookieText);
  const parsed = parseCookie(cookie);
  return {
    cookie,
    hasCookie: Boolean(cookie),
    hasSessdata: Boolean(parsed.SESSDATA),
    hasCsrf: Boolean(parsed.bili_jct),
    csrf: parsed.bili_jct || "",
    uid: Number(parsed.DedeUserID || 0),
  };
}

function loadSavedBiliLogin(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      ok: false,
      cookie: "",
      account: null,
      savedAt: 0,
      filePath,
    };
  }
  try {
    const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const info = cookieInfo(payload.cookie || "");
    if (!info.hasCookie || !info.hasCsrf) {
      return {
        ok: false,
        cookie: "",
        account: payload.account || null,
        savedAt: Number(payload.savedAt || 0),
        filePath,
      };
    }
    return {
      ok: true,
      cookie: info.cookie,
      account: payload.account || null,
      savedAt: Number(payload.savedAt || 0),
      filePath,
      info,
    };
  } catch {
    return {
      ok: false,
      cookie: "",
      account: null,
      savedAt: 0,
      filePath,
    };
  }
}

function saveBiliLogin(filePath, cookieText, account = {}) {
  const info = cookieInfo(cookieText);
  if (!info.hasCookie || !info.hasCsrf) {
    throw new Error("没有可保存的有效 B站 Cookie");
  }
  ensureDir(path.dirname(filePath));
  if (fs.existsSync(filePath)) {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("登录态保存路径不是普通文件");
    }
  }
  const payload = {
    savedAt: Date.now(),
    cookie: info.cookie,
    account: {
      mid: Number(account.mid || account.uid || info.uid || 0),
      uname: account.uname || account.name || "",
      face: account.face || "",
    },
  };
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return {
    ok: true,
    savedAt: payload.savedAt,
    account: payload.account,
    info,
    filePath,
  };
}

function clearSavedBiliLogin(filePath) {
  if (filePath) {
    fs.rmSync(filePath, { force: true });
  }
  return { ok: true };
}

function getCsrf(cookieText) {
  const cookies = parseCookie(extractCookie(cookieText));
  return cookies.bili_jct || "";
}

function extractCookie(input) {
  const text = String(input || "").trim();
  if (!text) return "";

  const headerMatch =
    text.match(/(?:^|\n|\r|\s)-H\s+\$?['"]cookie:\s*([^'"]+)['"]/i) ||
    text.match(/(?:^|\n|\r|\s)--header\s+\$?['"]cookie:\s*([^'"]+)['"]/i) ||
    text.match(/["']cookie["']\s*:\s*["']([^"']+)["']/i) ||
    text.match(/(?:^|\n|\r)\s*cookie:\s*([^\n\r]+)/i) ||
    text.match(/(?:^|\n|\r)\s*cookie\s*\n\s*([^\n\r]+)/i);
  if (headerMatch) {
    return cleanupCookie(headerMatch[1]);
  }

  const cookieFlagMatch =
    text.match(/(?:^|\n|\r|\s)-b\s+\$?['"]([^'"]+)['"]/) ||
    text.match(/(?:^|\n|\r|\s)--cookie\s+\$?['"]([^'"]+)['"]/);
  if (cookieFlagMatch) {
    return cleanupCookie(cookieFlagMatch[1]);
  }

  const directLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(
      (line) =>
        (line.includes("SESSDATA=") || line.includes("bili_jct=")) &&
        line.includes("=") &&
        !line.startsWith("-H ") &&
        !line.startsWith("--header ") &&
        !line.startsWith("{") &&
        !line.toLowerCase().startsWith("curl ")
    );
  if (directLine && !directLine.toLowerCase().startsWith("cookie")) {
    return cleanupCookie(directLine);
  }

  return cleanupCookie(text);
}

function cleanupCookie(cookie) {
  return String(cookie || "")
    .trim()
    .replace(/^cookie:\s*/i, "")
    .replace(/\\\n/g, "")
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .replace(/; /g, "; ")
    .trim();
}

function normalizeReply(text, maxChars = 40) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  // Count and cut by code points so emoji and other astral characters follow
  // the same 40-char rule as the browser channel and never split a surrogate.
  const chars = Array.from(value);
  if (chars.length <= maxChars) return value;
  return `${chars.slice(0, Math.max(1, maxChars - 1)).join("")}…`;
}

async function sendLiveDanmu(options = {}) {
  const cookie = extractCookie(options.cookie);
  const csrf = options.csrf || getCsrf(cookie);
  const roomId = Number(options.roomId || 0);
  const msg = normalizeReply(options.message, options.maxChars || 40);

  if (!cookie) {
    throw new Error("缺少 B 站 Cookie。请先在网页里粘贴当前登录账号的 Cookie。");
  }
  if (!csrf) {
    throw new Error("Cookie 里没有 bili_jct，无法生成 csrf。");
  }
  if (!roomId) {
    throw new Error("缺少真实 room_id，请先开始监听并解析房间。");
  }
  if (!msg) {
    throw new Error("发送内容为空。");
  }

  const body = new URLSearchParams({
    bubble: "0",
    msg,
    color: "16777215",
    mode: "1",
    fontsize: "25",
    rnd: String(Math.floor(Date.now() / 1000)),
    roomid: String(roomId),
    csrf,
    csrf_token: csrf,
  });

  const response = await fetch("https://api.live.bilibili.com/msg/send", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "User-Agent": BROWSER_USER_AGENT,
      Origin: "https://live.bilibili.com",
      Referer: `https://live.bilibili.com/${roomId}`,
      Cookie: cookie,
    },
    body,
    signal: requestTimeoutSignal(options.timeoutMs),
  });

  const payload = await readJsonPayload(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message || payload.msg || `发送失败 HTTP ${response.status}`);
  }

  return {
    ok: true,
    sentText: msg,
    payload,
  };
}

async function checkBiliCookie(cookieText) {
  const cookie = extractCookie(cookieText);
  const csrf = getCsrf(cookie);
  if (!cookie) {
    throw new Error("Cookie 为空。");
  }
  if (!csrf) {
    throw new Error("Cookie 里没有 bili_jct。");
  }

  const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Referer: "https://www.bilibili.com/",
      Cookie: cookie,
    },
    signal: requestTimeoutSignal(),
  });
  const payload = await readJsonPayload(response);

  if (!response.ok || payload.code !== 0) {
    throw new Error(payload.message || payload.msg || `登录态检查失败 HTTP ${response.status}`);
  }

  return {
    ok: Boolean(payload.data?.isLogin),
    hasCsrf: Boolean(csrf),
    mid: payload.data?.mid || 0,
    uname: payload.data?.uname || "",
    face: payload.data?.face || "",
    raw: payload,
  };
}

function getSetCookieList(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const value = headers.get("set-cookie");
  return value ? [value] : [];
}

function cookieStringFromSetCookie(setCookieList) {
  const joined = Array.isArray(setCookieList)
    ? setCookieList.join(", ")
    : String(setCookieList || "");
  const names = [
    "DedeUserID",
    "DedeUserID__ckMd5",
    "SESSDATA",
    "bili_jct",
    "sid",
    "buvid3",
    "buvid4",
    "b_nut",
  ];
  const parts = [];
  for (const name of names) {
    const match = joined.match(new RegExp(`${name}=([^;,]+)`));
    if (match) {
      parts.push(`${name}=${match[1]}`);
    }
  }
  return parts.join("; ");
}

async function createQrLogin() {
  const response = await fetch(
    "https://passport.bilibili.com/x/passport-login/web/qrcode/generate",
    {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Referer: "https://www.bilibili.com/",
      },
      signal: requestTimeoutSignal(),
    }
  );
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || !payload.data?.url) {
    throw new Error(payload.message || payload.msg || "二维码生成失败");
  }
  const qrImage = await QRCode.toDataURL(payload.data.url, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 220,
  });
  return {
    qrUrl: payload.data.url,
    qrcodeKey: payload.data.qrcode_key,
    qrImage,
    expiresInSec: 180,
  };
}

async function pollQrLogin(qrcodeKey) {
  if (!qrcodeKey) {
    throw new Error("缺少 qrcode_key");
  }
  const url = `https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(
    qrcodeKey
  )}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_USER_AGENT,
      Referer: "https://www.bilibili.com/",
    },
    redirect: "manual",
    signal: requestTimeoutSignal(),
  });
  const payload = await response.json();
  const data = payload.data || {};
  let cookie = cookieStringFromSetCookie(getSetCookieList(response.headers));

  if (data.code === 0 && !cookie && data.url) {
    const finish = await fetch(data.url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT,
        Referer: "https://www.bilibili.com/",
      },
      redirect: "manual",
      signal: requestTimeoutSignal(),
    });
    cookie = cookieStringFromSetCookie(getSetCookieList(finish.headers));
  }

  return {
    ok: data.code === 0 && Boolean(cookie),
    code: data.code,
    message: data.message || payload.message || "",
    cookie,
    payload,
  };
}

module.exports = {
  checkBiliCookie,
  clearSavedBiliLogin,
  cookieStringFromSetCookie,
  createQrLogin,
  extractCookie,
  getCsrf,
  loadSavedBiliLogin,
  pollQrLogin,
  normalizeReply,
  parseCookie,
  saveBiliLogin,
  sendLiveDanmu,
};
