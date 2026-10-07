"use strict";

const EventEmitter = require("node:events");
const zlib = require("node:zlib");
const WebSocketImpl = require("ws");

const PACKET_HEADER_LENGTH = 16;
const OP_HEARTBEAT = 2;
const OP_HEARTBEAT_REPLY = 3;
const OP_MESSAGE = 5;
const OP_AUTH = 7;
const OP_AUTH_REPLY = 8;
const SOCKET_OPEN = WebSocketImpl.OPEN || 1;
const CONF_REFRESH_EVERY_ATTEMPTS = 3;
const IDENTITY_SWEEP_INTERVAL_MS = 60000;

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
  Referer: "https://live.bilibili.com/",
};

const FALLBACK_HOSTS = [
  {
    host: "broadcastlv.chat.bilibili.com",
    wss_port: 443,
  },
];

const EXTRA_HOSTS = [
  {
    host: "hw-sg-live-comet-01.chat.bilibili.com",
    wss_port: 443,
  },
  {
    host: "hw-sg-live-comet-02.chat.bilibili.com",
    wss_port: 443,
  },
  {
    host: "hw-sg-live-comet-03.chat.bilibili.com",
    wss_port: 443,
  },
  {
    host: "bd-sz-live-comet-mixed-01.chat.bilibili.com",
    wss_port: 443,
  },
  {
    host: "broadcastlv-mixed.chat.bilibili.com",
    wss_port: 443,
  },
  {
    host: "broadcastlv.chat.bilibili.com",
    wss_port: 443,
  },
];

function extractRoomId(input) {
  const value = String(input || "").trim();
  if (!value) {
    throw new Error("缺少直播间 room id 或 URL");
  }

  if (/^\d+$/.test(value)) {
    return value;
  }

  try {
    const url = new URL(value);
    const match = url.pathname.match(/\/(?:blanc\/)?(\d+)/);
    if (match) {
      return match[1];
    }
  } catch {
    // Fall through to loose matching.
  }

  const loose = value.match(/live\.bilibili\.com\/(?:blanc\/)?(\d+)/);
  if (loose) {
    return loose[1];
  }

  throw new Error(`无法从输入中识别 B 站直播间 id: ${input}`);
}

const FETCH_TIMEOUT_MS = 10000;
const FETCH_RETRY_LIMIT = 2;

async function fetchJson(url, headers = {}, options = {}) {
  const timeoutMs = Number(options.timeoutMs || FETCH_TIMEOUT_MS);
  const retries = Number.isFinite(Number(options.retries))
    ? Number(options.retries)
    : FETCH_RETRY_LIMIT;
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          ...DEFAULT_HEADERS,
          ...headers,
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} ${response.statusText}: ${url}`);
        error.status = response.status;
        throw error;
      }

      return await response.json();
    } catch (error) {
      lastError = error;
      const status = Number(error.status || 0);
      // 仅对超时/网络类错误与 5xx/429 重试，4xx 风控类直接抛出
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }

  throw lastError;
}

async function fetchUserCard(mid) {
  if (!mid) return null;
  const url = `https://api.bilibili.com/x/web-interface/card?mid=${encodeURIComponent(mid)}`;
  const result = await fetchJson(url, {
    Referer: `https://space.bilibili.com/${mid}`,
  });
  return result?.data?.card || null;
}

async function resolveRoom(roomInput) {
  const requestedRoomId = extractRoomId(roomInput);
  const initUrl = `https://api.live.bilibili.com/room/v1/Room/room_init?id=${encodeURIComponent(
    requestedRoomId
  )}`;
  const init = await fetchJson(initUrl, {
    Referer: `https://live.bilibili.com/${requestedRoomId}`,
  });

  if (init.code !== 0 || !init.data?.room_id) {
    throw new Error(`直播间初始化失败: ${JSON.stringify(init)}`);
  }

  const roomId = Number(init.data.room_id);
  const room = {
    requestedRoomId: Number(requestedRoomId),
    roomId,
    shortId: Number(init.data.short_id || 0),
    uid: Number(init.data.uid || 0),
    liveStatus: Number(init.data.live_status || 0),
    title: "",
    uname: "",
    face: "",
    avatarFrameUrl: "",
    avatarFrameName: "",
    areaName: "",
    parentAreaName: "",
  };

  try {
    const infoUrl = `https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo?room_ids=${roomId}&req_biz=web_room_componet`;
    const info = await fetchJson(infoUrl, {
      Referer: `https://live.bilibili.com/${roomId}`,
    });
    const detail = info.data?.by_room_ids?.[String(roomId)];
    if (detail) {
      // 0 是明确的下播状态；只有缺失状态时才沿用初始化接口的值。
      room.liveStatus = Number(detail.live_status ?? room.liveStatus);
      room.title = detail.title || "";
      room.uname = detail.uname || "";
      room.areaName = detail.area_name || "";
      room.parentAreaName = detail.parent_area_name || "";
    }
  } catch (error) {
    room.infoWarning = error.message;
  }

  try {
    const card = await fetchUserCard(room.uid);
    if (card) {
      room.uname = card.name || room.uname;
      room.face = cleanFaceUrl(card.face || "");
      room.avatarFrameUrl = cleanFaceUrl(
        card.pendant?.image_enhance_frame ||
          card.pendant?.image_enhance ||
          card.pendant?.image ||
          ""
      );
      room.avatarFrameName = card.pendant?.name || "";
    }
  } catch (error) {
    room.cardWarning = error.message;
  }

  return room;
}

async function getDanmuConf(roomId, options = {}) {
  const headers = {
    Referer: `https://live.bilibili.com/${roomId}`,
    ...(options.cookie ? { Cookie: options.cookie } : {}),
  };
  const normalizeHosts = (hosts = [], fallback = {}) => {
    if (hosts.length > 0) {
      return hosts.map((host) => ({
        host: host.host,
        wss_port: host.wss_port || host.wssPort || 443,
        ws_port: host.ws_port || host.wsPort || 2244,
        port: host.port || 2243,
      }));
    }
    return [
      {
        host: fallback.host || "broadcastlv.chat.bilibili.com",
        wss_port: fallback.wss_port || 443,
        ws_port: fallback.ws_port || 2244,
        port: fallback.port || 2243,
      },
    ];
  };

  let token = "";
  let baseHosts = [];
  let lastError = null;

  const preferredUrl = `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?id=${encodeURIComponent(
    roomId
  )}&type=0`;
  try {
    const info = await fetchJson(preferredUrl, headers);
    if (info.code !== 0 || !info.data) {
      throw new Error(`弹幕服务器配置获取失败: ${JSON.stringify(info)}`);
    }
    token = info.data.token || "";
    baseHosts = normalizeHosts(info.data.host_list || []);
  } catch (error) {
    lastError = error;
    const fallbackUrl = `https://api.live.bilibili.com/room/v1/Danmu/getConf?room_id=${encodeURIComponent(
      roomId
    )}&platform=pc&player=web`;
    const conf = await fetchJson(fallbackUrl, headers);

    if (conf.code !== 0 || !conf.data) {
      throw new Error(`弹幕服务器配置获取失败: ${lastError?.message || ""}; ${JSON.stringify(conf)}`);
    }

    token = conf.data.token || "";
    baseHosts = normalizeHosts(conf.data.host_server_list || [], conf.data);
  }

  const seenHosts = new Set();
  const expandedHosts = [...baseHosts, ...EXTRA_HOSTS].filter((host) => {
    if (!host.host || seenHosts.has(host.host)) return false;
    seenHosts.add(host.host);
    return true;
  });

  return {
    token,
    hosts: expandedHosts,
  };
}

function chooseEndpoint(hosts, index = 0) {
  const list = hosts?.length ? hosts : FALLBACK_HOSTS;
  const host = list[index % list.length];
  return `wss://${host.host}:${host.wss_port || 443}/sub`;
}

function encodePacket(operation, body = {}, version = 1) {
  const payload =
    Buffer.isBuffer(body) || body instanceof Uint8Array
      ? Buffer.from(body)
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const packet = Buffer.alloc(PACKET_HEADER_LENGTH + payload.length);

  packet.writeUInt32BE(packet.length, 0);
  packet.writeUInt16BE(PACKET_HEADER_LENGTH, 4);
  packet.writeUInt16BE(version, 6);
  packet.writeUInt32BE(operation, 8);
  packet.writeUInt32BE(1, 12);
  payload.copy(packet, PACKET_HEADER_LENGTH);

  return packet;
}

function decodePackets(buffer, output = []) {
  let offset = 0;

  while (offset + PACKET_HEADER_LENGTH <= buffer.length) {
    const packetLength = buffer.readUInt32BE(offset);
    const headerLength = buffer.readUInt16BE(offset + 4);
    const version = buffer.readUInt16BE(offset + 6);
    const operation = buffer.readUInt32BE(offset + 8);

    if (
      packetLength < PACKET_HEADER_LENGTH ||
      headerLength < PACKET_HEADER_LENGTH ||
      offset + packetLength > buffer.length
    ) {
      break;
    }

    const body = buffer.subarray(offset + headerLength, offset + packetLength);

    if (operation === OP_MESSAGE && version === 2) {
      decodePackets(zlib.inflateSync(body), output);
    } else if (operation === OP_MESSAGE && version === 3) {
      decodePackets(zlib.brotliDecompressSync(body), output);
    } else {
      output.push({
        operation,
        version,
        body,
      });
    }

    offset += packetLength;
  }

  return output;
}

function parseJsonBody(body) {
  const text = body.toString("utf8").replace(/\0+$/g, "").trim();
  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

function getCommandName(command) {
  return String(command || "").split(":")[0];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function cleanUserName(value) {
  return String(value || "")
    .replace(/[\x00-\x1f\x7f]+/g, "")
    .trim()
    .replace(/^[`"'“”‘’]+|[`"'“”‘’]+$/g, "")
    .trim();
}

function firstUserName(...values) {
  for (const value of values) {
    const name = cleanUserName(value);
    if (name) return name;
  }
  return "";
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function pickFaceCandidate(candidates = []) {
  for (const [source, value] of candidates) {
    const face = cleanFaceUrl(value);
    if (face) {
      return {
        face,
        faceSource: source,
        faceCandidates: candidates
          .map(([candidateSource, candidateValue]) => ({
            source: candidateSource,
            url: cleanFaceUrl(candidateValue),
          }))
          .filter((item) => item.url),
      };
    }
  }
  return {
    face: "",
    faceSource: "",
    faceCandidates: [],
  };
}

function mapLiveStatus(status) {
  if (status === 1) return "直播中";
  if (status === 2) return "轮播中";
  return "未开播";
}

function isMaskedName(name) {
  return /\*{2,}/.test(String(name || ""));
}

function cleanImageUrl(url) {
  return String(url || "").trim().replace(/^J(?=https?:\/\/)/, "");
}

function cleanFaceUrl(face) {
  return cleanImageUrl(face);
}

function colorHex(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return "";
  return `#${number.toString(16).padStart(6, "0").slice(-6)}`;
}

function guardNameFromLevel(level) {
  const value = Number(level || 0);
  if (value === 1) return "总督";
  if (value === 2) return "提督";
  if (value === 3) return "舰长";
  return "";
}

function findImageUrlDeep(value, seen = new Set()) {
  if (!value) return "";
  if (typeof value === "string") {
    const image = value.match(/https?:\/\/[^\s"'<>]+?\.(?:png|jpe?g|webp|gif|avif)/i);
    return cleanImageUrl(image?.[0] || "");
  }
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);

  const preferredKeys = [
    "url",
    "src",
    "image",
    "image_url",
    "img",
    "frame_url",
    "frame_img",
    "face_frame",
    "frame",
    "value",
    "webp",
    "png",
    "icon",
  ];
  for (const key of preferredKeys) {
    const image = findImageUrlDeep(value[key], seen);
    if (image) return image;
  }
  for (const item of Object.values(value)) {
    const image = findImageUrlDeep(item, seen);
    if (image) return image;
  }
  return "";
}

function normalizeAvatarFrame(frame = {}) {
  if (typeof frame === "string") {
    const url = cleanImageUrl(frame);
    return url ? { url, name: "", raw: frame } : null;
  }
  if (!frame || typeof frame !== "object") return null;
  const url = findImageUrlDeep(frame);
  if (!url) return null;
  return {
    url,
    id: firstNumber(frame.id, frame.frame_id),
    name: firstString(frame.name, frame.frame_name, frame.title, frame.desc),
    raw: frame,
  };
}

const DEFAULT_GUARD_AVATAR_FRAMES = {
  1: "https://i0.hdslb.com/bfs/live/3b46129e796df42ec7356fcba77c8a79d47db682.png",
  2: "https://i0.hdslb.com/bfs/live/3b46129e796df42ec7356fcba77c8a79d47db682.png",
  3: "https://i0.hdslb.com/bfs/live/80f732943cc3367029df65e267960d56736a82ee.png",
};

function normalizeProtoAvatarFrame(value, guardLevel = 0) {
  if (!Buffer.isBuffer(value)) return null;
  const fields = readProtoFields(value);
  const find = (number) => fields.find((item) => item.field === number);
  const url = cleanImageUrl(decodeUtf8Field(find(2)?.value) || findImageUrlDeep(value));
  if (!url || /\/bfs\/face\//.test(url)) return null;
  return {
    id: firstNumber(find(1)?.value),
    url,
    name: guardNameFromLevel(guardLevel),
    raw: {
      fields: fields.map((field) => ({
        field: field.field,
        wire: field.wire,
        value: field.wire === 2 ? decodeUtf8Field(field.value) : field.value,
      })),
    },
  };
}

function extractOnlineRankAvatarFrame(rowFields = [], guardLevel = 0) {
  const find = (number) => rowFields.find((item) => item.field === number);
  const topFrame = normalizeProtoAvatarFrame(find(7)?.value, guardLevel);
  if (topFrame) return { ...topFrame, source: "online_rank" };

  const detail = find(8);
  if (Buffer.isBuffer(detail?.value)) {
    const detailFields = readProtoFields(detail.value);
    const detailFrame = detailFields.find((item) => item.field === 7);
    const nestedFrame = normalizeProtoAvatarFrame(detailFrame?.value, guardLevel);
    if (nestedFrame) return { ...nestedFrame, source: "online_rank" };
  }

  const fallbackUrl = DEFAULT_GUARD_AVATAR_FRAMES[Number(guardLevel || 0)] || "";
  if (!fallbackUrl) return null;
  return {
    id: 0,
    url: fallbackUrl,
    name: guardNameFromLevel(guardLevel),
    source: "guard_default",
    raw: null,
  };
}

function normalizeMedalVisual(medal = {}, medalArray = []) {
  return {
    name: firstString(medal.name, medalArray?.[1]),
    level: firstNumber(medal.level, medalArray?.[0]),
    guardLevel: firstNumber(medal.guard_level, medalArray?.[10]),
    guardIcon: firstString(medal.guard_icon, medalArray?.[5]),
    colors: {
      start: colorHex(medal.v2_medal_color_start || medal.color_start || medalArray?.[8]),
      end: colorHex(medal.v2_medal_color_end || medal.color_end || medalArray?.[9]),
      border: colorHex(medal.v2_medal_color_border || medal.color_border || medalArray?.[7]),
      level: colorHex(medal.v2_medal_color_level || medal.color || medalArray?.[4]),
      text: colorHex(medal.v2_medal_color_text || "#FFFFFF"),
    },
  };
}

function roomMatchedMedalInfo(data = {}) {
  const medal = data.medal_info || {};
  if (!medal || typeof medal !== "object") return {};
  const receiverUid = Number(data.receive_user_info?.uid || data.receiver_uinfo?.uid || 0);
  const medalTarget = Number(medal.target_id || medal.ruid || 0);
  if (!receiverUid || !medalTarget || receiverUid === medalTarget) return medal;
  return {};
}

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [Number(value), cursor];
    }
    shift += 7n;
    if (shift > 70n) break;
  }

  return [null, cursor];
}

function readProtoFields(buffer) {
  const fields = [];
  let offset = 0;

  while (offset < buffer.length) {
    const start = offset;
    const [tag, tagEnd] = readVarint(buffer, offset);
    if (tag === null) break;
    offset = tagEnd;
    const field = tag >> 3;
    const wire = tag & 7;

    if (wire === 0) {
      const [value, next] = readVarint(buffer, offset);
      if (value === null) break;
      offset = next;
      fields.push({ field, wire, value, start });
    } else if (wire === 2) {
      const [length, next] = readVarint(buffer, offset);
      if (length === null || next + length > buffer.length) break;
      const value = buffer.subarray(next, next + length);
      offset = next + length;
      fields.push({ field, wire, value, start });
    } else if (wire === 1 && offset + 8 <= buffer.length) {
      const value = buffer.readBigUInt64LE(offset).toString();
      offset += 8;
      fields.push({ field, wire, value, start });
    } else if (wire === 5 && offset + 4 <= buffer.length) {
      const value = buffer.readUInt32LE(offset);
      offset += 4;
      fields.push({ field, wire, value, start });
    } else {
      break;
    }
  }

  return fields;
}

function decodeUtf8Field(value) {
  if (!Buffer.isBuffer(value)) return "";
  const text = value.toString("utf8").trim();
  if (!text || text.includes("\uFFFD")) return "";
  return text;
}

function parseOnlineRankV3(data = {}) {
  const pb = data.pb || "";
  if (!pb) return [];

  try {
    const buffer = Buffer.from(pb, "base64");
    return readProtoFields(buffer)
      .filter((field) => field.field === 3 && Buffer.isBuffer(field.value))
      .map((field) => {
        const fields = readProtoFields(field.value);
        const find = (number) => fields.find((item) => item.field === number);
        const guardLevel = firstNumber(find(6)?.value);
        const avatarFrame = extractOnlineRankAvatarFrame(fields, guardLevel);
        return {
          uid: find(1)?.value || 0,
          face: cleanFaceUrl(decodeUtf8Field(find(2)?.value)),
          score: decodeUtf8Field(find(3)?.value),
          userName: decodeUtf8Field(find(4)?.value),
          rank: find(5)?.value || 0,
          guardLevel,
          guardName: guardNameFromLevel(guardLevel),
          avatarFrame,
          avatarFrameUrl: avatarFrame?.url || "",
          avatarFrameName: avatarFrame?.name || "",
          avatarFrameSource: avatarFrame?.source || "",
        };
      })
      .filter((item) => item.userName && !isMaskedName(item.userName));
  } catch {
    return [];
  }
}

function defaultGuardAvatarFrame(guardLevel = 0, source = "guard_default") {
  const fallbackUrl = DEFAULT_GUARD_AVATAR_FRAMES[Number(guardLevel || 0)] || "";
  if (!fallbackUrl) return null;
  return {
    id: 0,
    url: fallbackUrl,
    name: guardNameFromLevel(guardLevel),
    source,
    raw: null,
  };
}

function parseOnlineRankV2(data = {}) {
  const rows = Array.isArray(data.list) ? data.list : [];
  return rows
    .map((item) => {
      const info = item.uinfo || {};
      const base = info.base || {};
      const guard = info.guard || {};
      const medal = info.medal || {};
      const guardLevel = firstNumber(item.guard_level, guard.level, medal.guard_level);
      const avatarFrame =
        normalizeAvatarFrame(info.uhead_frame || item.uhead_frame) ||
        defaultGuardAvatarFrame(guardLevel);
      const medalVisual = normalizeMedalVisual(medal, []);
      return {
        uid: firstNumber(item.uid, info.uid),
        userId: firstNumber(item.uid, info.uid),
        face: firstString(
          item.face,
          base.origin_info?.face,
          base.risk_ctrl_info?.face,
          base.face
        ),
        score: String(item.score || ""),
        userName: firstString(
          item.uname,
          base.origin_info?.name,
          base.risk_ctrl_info?.name,
          base.name
        ),
        rank: firstNumber(item.rank),
        guardLevel,
        guardName: guardNameFromLevel(guardLevel),
        medalName: medalVisual.name,
        medalLevel: medalVisual.level,
        medalColors: medalVisual.colors,
        avatarFrame,
        avatarFrameUrl: avatarFrame?.url || "",
        avatarFrameName: avatarFrame?.name || "",
        avatarFrameSource: avatarFrame?.source || (avatarFrame ? "online_rank_v2" : ""),
        wealthLevel: firstNumber(info.wealth?.level),
      };
    })
    .filter((item) => item.userName && !isMaskedName(item.userName));
}

function parseOnlineRankTop(data = {}) {
  const rows = [data.list, data.rank_list, data.online_rank_list, data.top3, data.items]
    .find(Array.isArray) || [];
  return rows
    .map((item, index) => {
      const info = item.uinfo || item.user_info || {};
      const base = info.base || {};
      const medal = info.medal || item.medal_info || {};
      const guard = info.guard || {};
      const medalVisual = normalizeMedalVisual(medal, []);
      const guardLevel = firstNumber(item.guard_level, guard.level, medal.guard_level, medalVisual.guardLevel);
      const avatarFrame =
        normalizeAvatarFrame(info.uhead_frame || item.uhead_frame || item.face_frame) ||
        defaultGuardAvatarFrame(guardLevel, "online_rank_top");
      return {
        uid: firstNumber(item.uid, info.uid),
        userId: firstNumber(item.uid, info.uid),
        userName: firstString(
          item.uname,
          item.username,
          item.name,
          base.origin_info?.name,
          base.risk_ctrl_info?.name,
          base.name
        ),
        face: cleanFaceUrl(
          firstString(
            item.face,
            base.origin_info?.face,
            base.risk_ctrl_info?.face,
            base.face
          )
        ),
        score: firstString(item.score_text, String(firstFiniteNumber(item.score, item.contribution, item.value) || "")),
        rank: firstNumber(item.rank, item.user_rank, index + 1),
        guardLevel,
        guardName: guardNameFromLevel(guardLevel),
        medalName: firstString(item.medal_name, medalVisual.name),
        medalLevel: firstNumber(item.medal_level, medalVisual.level),
        medalColors: medalVisual.colors,
        avatarFrame,
        avatarFrameUrl: avatarFrame?.url || "",
        avatarFrameName: avatarFrame?.name || "",
        avatarFrameSource: avatarFrame?.source || (avatarFrame ? "online_rank_top" : ""),
        wealthLevel: firstNumber(info.wealth?.level, item.wealth_level),
      };
    })
    .filter((item) => item.userName && !isMaskedName(item.userName));
}

function normalizeLiveStatusEvent(message = {}, command = "") {
  const data = message.data || {};
  const liveStatus = command === "LIVE" ? 1 : command === "PREPARING" ? 0 : firstNumber(data.live_status);
  return {
    command,
    eventKind: "live_status",
    liveStatus,
    liveStatusLabel: mapLiveStatus(liveStatus),
    liveKey: firstString(message.live_key, data.live_key),
    roomId: firstNumber(message.roomid, data.roomid, data.room_id),
    text: command === "LIVE" ? "开播" : command === "PREPARING" ? "下播/准备中" : "",
    raw: message,
  };
}

function connectionTypeFromCommand(command = "") {
  if (command.startsWith("VOICE_JOIN")) return "voice";
  if (command.startsWith("VIDEO_CONNECTION")) return "video";
  if (command === "LIVE_ROOM_TOAST_MESSAGE") return "toast";
  return "connection";
}

function connectionStatusLabel(roomStatus = 0, rootStatus = 0) {
  if (Number(roomStatus) === 1 || Number(rootStatus) === 1) return "可连麦";
  if (Number(roomStatus) === 0 && Number(rootStatus) === 0) return "未开启";
  return "状态变化";
}

function connectionTextFromFields(command = "", data = {}, fallbackText = "", members = []) {
  if (fallbackText) return fallbackText;
  const applyCount = firstFiniteNumber(data.apply_count);
  const notifyCount = firstFiniteNumber(data.notify_count);
  const roomStatus = firstFiniteNumber(data.room_status);
  const rootStatus = firstFiniteNumber(data.root_status);
  if (command === "VOICE_JOIN_ROOM_COUNT_INFO") {
    const parts = [`语音连麦${connectionStatusLabel(roomStatus, rootStatus)}`];
    if (applyCount) parts.push(`申请${applyCount}人`);
    if (notifyCount) parts.push(`提醒${notifyCount}人`);
    return parts.join("，");
  }
  if (command === "VOICE_JOIN_LIST") {
    const parts = ["语音连麦列表刷新"];
    if (members.length) parts.push(`${members.length}人`);
    if (applyCount) parts.push(`申请${applyCount}人`);
    return parts.join("，");
  }
  if (command.startsWith("VOICE_JOIN")) return "语音连麦状态变化";
  if (command.startsWith("VIDEO_CONNECTION")) return "视频连线状态变化";
  return "连线状态变化";
}

function normalizeConnectionEvent(message = {}, command = "") {
  const data = message.data || {};
  const memberList = [
    data.members,
    data.member_list,
    data.list,
    data.room_list,
    data.anchor_list,
    data.channel_users,
  ].find(Array.isArray) || [];
  const members = memberList
    .map((member, index) => ({
      uid: firstNumber(member.uid, member.user_id, member.anchor_uid),
      userId: firstNumber(member.uid, member.user_id, member.anchor_uid),
      roomId: firstNumber(member.room_id, member.roomid),
      uname: firstString(member.uname, member.user_name, member.name, member.anchor_name),
      userName: firstString(member.uname, member.user_name, member.name, member.anchor_name),
      face: cleanFaceUrl(firstString(member.face, member.avatar, member.anchor_face)),
      position: firstFiniteNumber(member.position, index + 1),
      score: firstFiniteNumber(member.score, member.votes, member.pk_votes),
    }))
    .filter((member) => member.userName || member.roomId || member.userId);
  const text = firstString(
    data.message,
    data.toast_msg,
    data.title,
    data.text,
    data.msg,
    message.message,
    message.msg
  );
  const applyCount = firstFiniteNumber(data.apply_count);
  const notifyCount = firstFiniteNumber(data.notify_count);
  const roomStatus = firstFiniteNumber(data.room_status);
  const rootStatus = firstFiniteNumber(data.root_status);
  return {
    command,
    eventKind: "connection",
    connectionType: connectionTypeFromCommand(command),
    roomId: firstNumber(data.room_id, message.room_id, message.roomid),
    applyCount,
    notifyCount,
    roomStatus,
    rootStatus,
    statusLabel: connectionStatusLabel(roomStatus, rootStatus),
    category: firstFiniteNumber(data.category),
    refresh: firstFiniteNumber(data.refresh),
    members,
    memberCount: members.length,
    text: connectionTextFromFields(command, data, text, members),
    raw: message,
  };
}

function normalizeRoomRealtimeEvent(message = {}, command = "") {
  const data = message.data || {};
  return {
    command,
    eventKind: "room_realtime",
    roomId: firstNumber(data.roomid, data.room_id),
    fans: firstFiniteNumber(data.fans),
    fansClub: firstFiniteNumber(data.fans_club),
    redNotice: firstFiniteNumber(data.red_notice),
    raw: message,
  };
}

function normalizeRankEvent(message = {}, command = "") {
  const data = message.data || {};
  const rank = firstFiniteNumber(data.rank_by_type, data.rank);
  const rankName = firstString(
    data.on_rank_name_by_type,
    data.rank_name_by_type,
    data.rank_name,
    data.name
  );
  const url = firstString(data.url_by_type, data.url, data.default_url);
  return {
    command,
    eventKind: "rank",
    uid: firstNumber(data.uid),
    rank,
    countdown: firstFiniteNumber(data.countdown),
    rankType: firstFiniteNumber(data.rank_type),
    subRankType: firstFiniteNumber(data.sub_rank_type),
    rankName,
    url,
    text: rank > 0 ? `${rankName || "榜单"} 第${rank}` : `${rankName || "榜单"} 状态变化`,
    timestamp: firstFiniteNumber(data.timestamp, message.timestamp),
    raw: message,
  };
}

function normalizeWidgetEvent(message = {}, command = "") {
  const data = message.data || {};
  const widgetMap = data.widget_list && typeof data.widget_list === "object" ? data.widget_list : {};
  const widgets = Object.values(widgetMap)
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: firstNumber(item.id),
      title: firstString(item.title, item.tip_text, item.name),
      type: firstFiniteNumber(item.type),
      site: firstFiniteNumber(item.site),
      isAdd: item.is_add !== false,
      position: firstFiniteNumber(item.position),
      jumpUrl: firstString(item.jump_url, item.target_url, item.url),
      cover: cleanImageUrl(firstString(item.cover, item.web_cover, item.icon)),
      raw: item,
    }))
    .filter((item) => item.title || item.id);
  const settings = Array.isArray(data.setting_list)
    ? data.setting_list
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          bizId: firstNumber(item.biz_id),
          title: firstString(item.title, item.note),
          statusType: firstFiniteNumber(item.status_type),
          jumpUrl: firstString(item.jump_url),
          icon: cleanImageUrl(firstString(item.icon, item.panel_icon)),
        }))
    : [];
  const giftPlans = Array.isArray(data.gift_list)
    ? data.gift_list
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          giftId: firstNumber(item.gift_id),
          specialType: firstFiniteNumber(item.special_type),
          show: item.show !== false,
        }))
    : [];
  const titles = [
    ...widgets.map((item) => item.title),
    ...settings.map((item) => item.title),
  ].filter(Boolean);
  return {
    command,
    eventKind: "widget",
    widgetCount: widgets.length,
    settingCount: settings.length,
    giftPlanCount: giftPlans.length,
    action: firstFiniteNumber(data.action),
    tabId: firstFiniteNumber(data.tab_id),
    widgets,
    settings,
    giftPlans,
    text: titles.slice(0, 5).join("，") || command,
    raw: message,
  };
}

function normalizeActivityEvent(message = {}, command = "") {
  const data = message.data || {};
  let extra = {};
  if (typeof data.data === "string" && data.data.trim()) {
    try {
      extra = JSON.parse(data.data);
    } catch {
      extra = {};
    }
  }
  const gameName = firstString(data.game_name, data.gameName);
  const suffixText = firstString(extra.suffix_text, data.suffix_text, data.text, data.game_msg);
  const count = firstFiniteNumber(extra.cnt, data.count, data.cnt);
  const activityType = /分享/.test(suffixText)
    ? "share"
    : gameName || /GAME/.test(command)
      ? "game"
      : "activity";
  const text =
    activityType === "share" && count
      ? `${count}${suffixText}`
      : firstString(suffixText, gameName, command);
  return {
    command,
    eventKind: "activity",
    activityType,
    text,
    count,
    status: firstFiniteNumber(data.status, data.game_status, data.panel_status),
    type: firstFiniteNumber(data.type, data.msg_type),
    gameName,
    gameCode: firstString(data.game_code),
    gameId: firstString(data.game_id),
    jumpUrl: firstString(data.jump_url),
    raw: message,
  };
}

function normalizeDanmuAggregationEvent(message = {}, command = "") {
  const data = message.data || {};
  return {
    command,
    eventKind: "activity",
    activityType: "danmu_aggregation",
    activityId: firstString(data.activity_identity),
    activitySource: firstFiniteNumber(data.activity_source),
    aggregationCount: firstFiniteNumber(data.aggregation_num),
    aggregationCycle: firstFiniteNumber(data.aggregation_cycle),
    broadcastMessageType: firstFiniteNumber(data.broadcast_msg_type),
    text: firstString(data.msg, "弹幕聚合活动"),
    icon: cleanImageUrl(data.aggregation_icon),
    showRows: firstFiniteNumber(data.show_rows),
    showTime: firstFiniteNumber(data.show_time),
    timestamp: firstFiniteNumber(data.timestamp, message.timestamp),
    sourceScope: "platform_activity",
    interactionEligible: false,
    raw: message,
  };
}

function normalizeFlowRewardCardEvent(message = {}, command = "") {
  const data = message.data || {};
  const anchorName = firstString(data.anchor_name);
  const description = firstString(data.description);
  return {
    command,
    eventKind: "system_notice",
    systemType: "platform_flow_recommendation",
    sourceScope: "platform_recommendation",
    recommendedRoomId: firstNumber(data.room_id),
    anchorUserId: firstNumber(data.ruid),
    anchorName,
    anchorFace: cleanFaceUrl(data.anchor_face),
    anchorIcon: cleanImageUrl(data.anchor_icon_url),
    description,
    buttonText: firstString(data.button_text),
    jumpUrl: firstString(data.route),
    cover: cleanImageUrl(data.cover),
    label: cleanImageUrl(data.label_url),
    rank: firstFiniteNumber(data.rank),
    expireTime: firstFiniteNumber(data.expire_time),
    text: [anchorName, description].filter(Boolean).join("：") || "全站直播推荐",
    interactionEligible: false,
    raw: message,
  };
}

function normalizePopularityRankTabEvent(message = {}, command = "") {
  const data = message.data || {};
  const rankTabType = firstString(data.type);
  return {
    command,
    eventKind: "rank",
    rankEventType: "popularity_tab_change",
    roomId: firstNumber(data.room_id),
    anchorUserId: firstNumber(data.ruid),
    rankTabType,
    needRefreshTab: Boolean(data.need_refresh_tab),
    text: `人气榜单${rankTabType ? ` ${rankTabType}` : ""}标签变化`,
    interactionEligible: false,
    raw: message,
  };
}

function normalizeRoomChangeEvent(message = {}, command = "") {
  const data = message.data || {};
  const title = firstString(data.title);
  const areaName = firstString(data.area_name);
  const parentAreaName = firstString(data.parent_area_name);
  return {
    command,
    eventKind: "room_metadata",
    title,
    areaId: firstNumber(data.area_id),
    parentAreaId: firstNumber(data.parent_area_id),
    areaName,
    parentAreaName,
    liveKey: firstString(data.live_key),
    subSessionKey: firstString(data.sub_session_key),
    text: [title, parentAreaName, areaName].filter(Boolean).join("，") || "直播间信息变化",
    interactionEligible: false,
    raw: message,
  };
}

function isLotteryActivityCommand(command = "") {
  const name = String(command || "");
  return /LOTTERY|RAFFLE|ANCHOR_LOT|POPULARITY_RED_POCKET|RED_POCKET/.test(name);
}

function normalizeLotteryActivityEvent(message = {}, command = "") {
  const data = message.data || {};
  const text = firstString(
    data.toast_msg,
    data.msg,
    data.title,
    data.name,
    data.gift_name,
    data.lot_name,
    data.lottery_name,
    data.content,
    command
  );
  const statusText = /END|FINISH|AWARD|WINNER|CLOSE|STOP/.test(command)
    ? "end"
    : /START|BEGIN|NEW|OPEN/.test(command)
      ? "start"
      : "active";
  return {
    command,
    eventKind: "activity",
    activityType: /RED_POCKET|POPULARITY_RED_POCKET/.test(command) ? "red_pocket" : "lottery",
    activityStatus: statusText,
    text,
    roomId: firstNumber(data.room_id, data.roomid, message.roomid, message.real_roomid),
    userId: firstNumber(data.uid, data.sender_uid),
    userName: firstString(data.uname, data.sender_name, data.user_name),
    giftId: firstNumber(data.gift_id, data.giftId),
    giftName: firstString(data.gift_name, data.giftName),
    count: firstNumber(data.num, data.count),
    lotId: firstString(data.lot_id, data.id, data.lottery_id, data.anchor_lot_id),
    raw: message,
  };
}

function normalizeBlockEvent(message = {}, command = "") {
  const data = message.data || {};
  return {
    command,
    eventKind: "room_moderation",
    userName: firstString(data.uname, data.username, data.name),
    userId: firstNumber(data.uid, data.tuid, data.target_id),
    targetId: firstNumber(data.target_id),
    recallType: firstNumber(data.recall_type),
    text: firstString(data.msg, data.message, data.toast_msg),
    raw: message,
  };
}

function normalizeSystemEvent(message = {}, command = "") {
  const data = message.data || {};
  if (command === "ROOM_SKIN_MSG") {
    return {
      command,
      eventKind: "room_skin",
      skinId: firstNumber(message.skin_id, data.skin_id),
      status: firstFiniteNumber(message.status, data.status),
      endTime: firstFiniteNumber(message.end_time, data.end_time),
      currentTime: firstFiniteNumber(message.current_time, data.current_time),
      text: firstFiniteNumber(message.status, data.status) ? "直播间皮肤已启用" : "直播间皮肤状态变化",
      raw: message,
    };
  }
  return {
    command,
    eventKind: "system_notice",
    text: firstString(data.notice_msg, data.msg, message.msg, message.message, command),
    url: firstString(data.url, message.url),
    image: cleanImageUrl(firstString(data.image_web, data.image_app, message.image_web, message.image_app)),
    raw: message,
  };
}

function normalizeMedalChangeEvent(message = {}, command = "") {
  const data = message.data || {};
  const medal = data.uinfo_medal || data.medal_info || data.medal || {};
  const medalVisual = normalizeMedalVisual(medal, []);
  return {
    command,
    eventKind: "medal_change",
    userId: firstNumber(data.uid, data.user_id),
    targetUid: firstNumber(data.up_uid, data.target_id, medal.ruid),
    changeType: firstFiniteNumber(data.type),
    medalName: firstString(data.medal_name, medal.name, medalVisual.name),
    medalLevel: firstNumber(data.medal_level, medal.level, medalVisual.level),
    guardLevel: firstNumber(data.guard_level, medal.guard_level, medalVisual.guardLevel),
    guardName: guardNameFromLevel(firstNumber(data.guard_level, medal.guard_level, medalVisual.guardLevel)),
    medalColors: medalVisual.colors,
    text: firstString(data.upper_bound_content, data.msg, data.message, "粉丝勋章状态变化"),
    raw: message,
  };
}

function normalizeWealthNotifyEvent(message = {}, command = "") {
  const data = message.data || {};
  const info = data.info || {};
  const level = firstNumber(data.level, info.level);
  return {
    command,
    eventKind: "wealth",
    wealthLevel: level,
    status: firstFiniteNumber(data.status, info.status),
    flag: firstFiniteNumber(data.flag),
    effectKey: firstFiniteNumber(info.effect_key),
    hasItemsChanged: firstFiniteNumber(info.has_items_changed),
    text: level ? `财富等级 ${level} 状态变化` : "财富等级状态变化",
    raw: message,
  };
}

function normalizeSuperChatEvent(message = {}, command = "") {
  const data = message.data || {};
  const userInfo = data.user_info || {};
  const medalVisual = normalizeMedalVisual(data.medal_info || userInfo.medal || {}, []);
  const guardLevel = firstNumber(data.guard_level, data.guard?.level, userInfo.guard?.level, medalVisual.guardLevel);
  const deletedIds = data.message_ids || data.ids || message.message_ids || [];
  return {
    command,
    userName: firstString(userInfo.uname, data.uname, data.user_name, "匿名用户"),
    userId: firstNumber(data.uid, data.UID, data.open_id),
    face: cleanImageUrl(firstString(userInfo.face, userInfo.uface, data.face, data.uface)),
    text: firstString(data.message, data.message_jpn, data.msg),
    price: firstFiniteNumber(data.price, data.rmb),
    messageId: firstString(data.id, data.message_id, message.message_id),
    medalName: firstString(medalVisual.name, data.medal_info?.medal_name),
    medalLevel: firstNumber(medalVisual.level, data.medal_info?.medal_level),
    medalColors: medalVisual.colors,
    guardLevel,
    guardName: guardNameFromLevel(guardLevel),
    guardIcon: firstString(medalVisual.guardIcon, data.guard_icon),
    startTime: firstNumber(data.start_time, data.startTime),
    endTime: firstNumber(data.end_time, data.endTime),
    backgroundColor: colorHex(data.background_color || data.bg_color),
    deletedIds: Array.isArray(deletedIds) ? deletedIds : [deletedIds].filter(Boolean),
    isDelete: /DELETE/.test(command),
    raw: message,
  };
}

function normalizeOpenSuperChatEvent(message = {}, command = "") {
  const data = message.data || {};
  const medalVisual = normalizeMedalVisual(data.medal_info || data.medal || {}, []);
  const guardLevel = firstNumber(data.guard_level, data.guard?.level, medalVisual.guardLevel);
  return {
    command,
    userName: firstString(data.uname, data.user_name, data.name, "匿名用户"),
    userId: firstNumber(data.uid, data.user_id, data.open_id),
    face: cleanImageUrl(firstString(data.face, data.uface, data.avatar)),
    text: firstString(data.message, data.msg, data.content),
    price: firstFiniteNumber(data.rmb, data.price),
    messageId: firstString(data.id, data.message_id),
    medalName: firstString(medalVisual.name, data.medal_name),
    medalLevel: firstNumber(medalVisual.level, data.medal_level),
    medalColors: medalVisual.colors,
    guardLevel,
    guardName: guardNameFromLevel(guardLevel),
    guardIcon: firstString(medalVisual.guardIcon, data.guard_icon),
    startTime: firstNumber(data.start_time, data.startTime),
    endTime: firstNumber(data.end_time, data.endTime),
    backgroundColor: colorHex(data.background_color || data.bg_color),
    raw: message,
  };
}

function extractWelcomeNames(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value.includes("欢迎")) return [];

  const names = [];
  const patterns = [
    /欢迎[『「]?([^『「』」,，~!！。]{2,32})[』」]?(?:来到直播间|进入直播间|回家|来啦|你来啦|来玩)/g,
    /欢迎[『「]?([^『「』」,，~!！。]{2,32})[』」]?[,，](?:晚上好|你来啦|来啦)/g,
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const name = String(match[1] || "").trim();
      if (
        name &&
        !isMaskedName(name) &&
        !/^(关注主播|大家|新来的朋友|这位朋友)$/.test(name)
      ) {
        names.push(name);
      }
    }
  }

  return [...new Set(names)];
}

function maskedPrefix(name) {
  return String(name || "").split("*")[0].trim();
}

function extractNameFromCopyWriting(...values) {
  const text = firstString(...values);
  if (!text) return "";

  return firstString(
    text.match(/<%(.+?)%>/)?.[1],
    text.match(/欢迎\s*[『「]?([^,，\s』」]+)[』」]?\s*(?:来玩|进入|来到|回家)?/)?.[1],
    text.match(/^(.+?)\s*来了/)?.[1]
  );
}

function decodeInteractWordV2(data = {}) {
  const pb = data.pb || "";
  if (!pb) return {};

  try {
    const buffer = Buffer.from(pb, "base64");
    const text = buffer.toString("utf8");
    const maskedName = firstUserName(
      text.match(/([\p{L}\p{N}_\-]{1,16}\*{2,})/u)?.[1],
      text.match(/(?:\n|\u0012)[\x00-\x1f]*([^\x00-\x1f]{1,24})/)?.[1]
    );
    const face = text.match(/https:\/\/[^\x00-\x20"'<>]+?\.(?:jpg|png|webp)/)?.[0] || "";
    const medalName = firstString(
      [...text.matchAll(/[\x00-\x1f]([\u4e00-\u9fa5A-Za-z0-9_]{2,8})[\x00-\x1f]/g)]
        .map((match) => match[1])
        .find((name) => name !== maskedName)
    );

    return {
      userName: cleanUserName(maskedName),
      isMaskedName: isMaskedName(maskedName),
      face: cleanFaceUrl(face),
      medalName,
      message: text.includes("曾经活跃过") ? "曾经活跃过，近期互动较少" : "",
    };
  } catch {
    return {};
  }
}

function scoreFromMultiConn(value) {
  if (!value || typeof value !== "object") return 0;
  const textScore = firstFiniteNumber(value.price_text, value.score_text);
  if (textScore) return textScore;
  const price = firstFiniteNumber(value.price, value.score, value.votes);
  return price >= 100 ? price / 100 : price;
}

function normalizeMultiConnScore(value = {}) {
  if (!value || typeof value !== "object") {
    return {
      votes: 0,
      votesText: "0",
      price: 0,
      priceText: "",
      raw: value || null,
    };
  }

  const votes = scoreFromMultiConn(value);
  const price = firstFiniteNumber(value.price, value.score, value.votes, value.pk_votes);
  const priceText = firstString(value.price_text, value.score_text, value.votes_text);
  return {
    votes,
    votesText: priceText || String(votes || 0),
    price,
    priceText,
    raw: value,
  };
}

function normalizeUniversalMultiData(data = {}, sourceCommand = "") {
  const info = data.info || data;
  const template = info.interact_template || data.interact_template || {};
  const templateId = template.template_id || "";
  const businessLabel = info.business_label || data.business_label || "";
  const multiConnInfo = info.multi_conn_info || data.multi_conn_info || {};
  const rootExtra = info.biz_extra_data || data.biz_extra_data || {};
  const rootMultiExtra = rootExtra.multi_conn || {};
  const isMulti =
    businessLabel === "universal_multi_conn" ||
    templateId.includes("multi_conn") ||
    Array.isArray(multiConnInfo.scores) ||
    Array.isArray(info.members);

  if (!isMulti) return null;

  const scoreMap = new Map();
  const scores = Array.isArray(multiConnInfo.scores) ? multiConnInfo.scores : [];
  for (const score of scores) {
    const uid = Number(score.uid || 0);
    if (uid) scoreMap.set(uid, normalizeMultiConnScore(score));
  }

  const members = (Array.isArray(info.members) ? info.members : []).map((member) => {
    const uid = Number(member.uid || 0);
    const extraScore = normalizeMultiConnScore(member.biz_extra_data?.multi_conn);
    const mappedScore = scoreMap.get(uid);
    const votes = firstFiniteNumber(
      mappedScore?.votes,
      extraScore.votes,
      member.votes,
      member.score
    );
    const votesText = firstString(
      mappedScore?.votesText,
      extraScore.votesText,
      member.votes_text,
      member.score_text,
      String(votes || 0)
    );
    return {
      uid,
      userId: uid,
      room_id: member.room_id || member.roomid || 0,
      roomId: member.room_id || member.roomid || 0,
      uname: member.uname || member.display_name || "",
      userName: member.uname || member.display_name || "",
      face: cleanFaceUrl(member.face || ""),
      position: firstFiniteNumber(member.position),
      votes,
      votes_text: votesText,
      votesText,
      score: votes,
      score_text: votesText,
      price: firstFiniteNumber(mappedScore?.price, extraScore.price),
      price_text: firstString(mappedScore?.priceText, extraScore.priceText),
      rank: firstNumber(member.rank, member.rank_v2),
      display_name: member.display_name || "",
      displayName: member.display_name || "",
      join_time: member.join_time || 0,
      joinTime: member.join_time || 0,
      join_time_ts: member.join_time_ts || 0,
      link_id: member.link_id || "",
      gender: member.gender,
      fans_num: member.fans_num || 0,
      is_room_owner:
        Number(info.room_owner || data.room_owner || 0) === uid ||
        member.display_name === "本房主播",
      isRoomOwner:
        Number(info.room_owner || data.room_owner || 0) === uid ||
        member.display_name === "本房主播",
      biz_extra_data: member.biz_extra_data || null,
    };
  });

  const normalizedScores = scores.map((score) => {
    const normalized = normalizeMultiConnScore(score);
    return {
      uid: score.uid || 0,
      votes: normalized.votes,
      votes_text: normalized.votesText,
      votesText: normalized.votesText,
      price: normalized.price,
      price_text: normalized.priceText,
      raw: score,
    };
  });
  const roomOwner = firstNumber(
    info.room_owner,
    data.room_owner,
    multiConnInfo.room_owner,
    data.anchor_uid
  );

  return {
    sourceCommand,
    mode: "multi_conn",
    businessLabel,
    templateId,
    layoutId: template.layout_id || "",
    layoutVersion: template.layout_version || 0,
    showInteractUi: Boolean(template.show_interact_ui),
    template,
    roomId: firstNumber(data.room_id, info.room_id),
    anchorUid: firstNumber(data.anchor_uid, info.anchor_uid),
    bizSessionId: info.biz_session_id || data.biz_session_id || "",
    interactChannelId: info.interact_channel_id || data.interact_channel_id || "",
    sessionStatus: info.session_status,
    roomStatus: info.room_status || data.room_status || 0,
    roomOwner,
    roomOwnerUid: roomOwner,
    voteName: firstString(multiConnInfo.vote_name, rootMultiExtra.vote_name, "分"),
    version: info.version || data.version || 0,
    membersVersion: info.members_version || data.members_version || 0,
    invokingTime: info.invoking_time || data.invoking_time || 0,
    systemTimeUnix: info.system_time_unix || data.system_time_unix || 0,
    sessionStartAt: info.session_start_at || data.session_start_at || "",
    sessionStartAtTs: info.session_start_at_ts || data.session_start_at_ts || 0,
    roomStartAt: info.room_start_at || data.room_start_at || "",
    roomStartAtTs: info.room_start_at_ts || data.room_start_at_ts || 0,
    traceId: info.trace_id || data.trace_id || "",
    showScore: firstNumber(multiConnInfo.show_score, rootMultiExtra.show_score),
    supportFullZoom: firstNumber(rootMultiExtra.support_full_zoom),
    channelUsers: Array.isArray(info.channel_users)
      ? info.channel_users
      : Array.isArray(data.channel_users)
        ? data.channel_users
        : [],
    memberCount: members.length,
    members,
    scores,
    normalizedScores,
    multiConnInfo,
    bizExtraData: rootExtra,
  };
}

function normalizeBlindGift(blindGift) {
  if (!blindGift || typeof blindGift !== "object") return null;
  return {
    originalGiftId: blindGift.original_gift_id || blindGift.originalGiftId || 0,
    originalGiftName: blindGift.original_gift_name || blindGift.originalGiftName || "",
    originalGiftPrice: blindGift.original_gift_price || blindGift.originalGiftPrice || 0,
    action: blindGift.gift_action || blindGift.action || "爆出",
    resultPrice: blindGift.gift_tip_price || blindGift.result_price || 0,
    configId: blindGift.blind_gift_config_id || blindGift.config_id || 0,
    from: blindGift.from ?? null,
    raw: blindGift,
  };
}

function timestampFromComboId(...values) {
  for (const value of values) {
    const match = String(value || "").match(/:(\d{10,13}(?:\.\d+)?)$/);
    if (!match) continue;
    const number = Number(match[1]);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return 0;
}

function normalizeGiftPacket(message = {}, command = "") {
  const data = message.data || {};
  const batch = data.batch_combo_send || {};
  const combo = data.combo_send || {};
  const senderInfo = data.sender_uinfo || data.uinfo || {};
  const senderBase = senderInfo.base || data.user_info?.base || {};
  const senderMedal = senderInfo.medal || {};
  const senderGuard = senderInfo.guard || {};
  const senderFrame = normalizeAvatarFrame(
    senderInfo.uhead_frame || data.user_info?.face_frame || data.face_frame
  );
  const senderMedalVisual = normalizeMedalVisual(senderMedal, []);
  const matchedMedalInfo = roomMatchedMedalInfo(data);
  const receiverInfo = data.receiver_uinfo || data.receive_user_info || {};
  const receiverBase = receiverInfo.base || {};
  const blindGift = normalizeBlindGift(
    data.blind_gift || batch.blind_gift || combo.blind_gift || null
  );
  const faceInfo = pickFaceCandidate([
    ["sender_origin", senderBase.origin_info?.face],
    ["sender_base", senderBase.face],
    ["data_face", data.face],
    ["user_info_face", data.user_info?.face],
  ]);
  const count =
    command === "COMBO_SEND"
      ? firstNumber(
          data.combo_num,
          data.total_num,
          data.gift_num,
          data.num,
          data.super_gift_num,
          1
        )
      : firstNumber(
          data.num,
          data.gift_num,
          data.giftNum,
          batch.gift_num,
          combo.gift_num,
          data.super_gift_num,
          1
        );
  const price = firstFiniteNumber(
    data.price,
    data.r_price,
    data.discount_price,
    data.gift?.price,
    batch.price,
    combo.price
  );
  const totalCoin = firstNumber(
    data.total_coin,
    data.totalCoin,
    data.combo_total_coin,
    data.r_price ? Number(data.r_price) * count : 0,
    data.price ? Number(data.price) * count : 0
  );
  const comboTotalCoin = firstNumber(
    data.combo_total_coin,
    combo.combo_total_coin,
    batch.combo_total_coin
  );
  const batchComboId = firstString(data.batch_combo_id, batch.batch_combo_id);
  const comboId = firstString(data.combo_id, combo.combo_id);
  const giftName = firstString(
    data.giftName,
    data.gift_name,
    data.gift?.gift_name,
    data.gift?.name,
    batch.gift_name,
    combo.gift_name
  );
  const giftId = firstNumber(
    data.giftId,
    data.gift_id,
    data.gift?.gift_id,
    data.gift?.id,
    batch.gift_id,
    combo.gift_id
  );
  const giftIcon = firstString(
    data.gift_info?.webp,
    data.gift_info?.img_basic,
    data.gift_info?.gif,
    data.gift?.webp,
    data.gift?.img_basic,
    data.gift?.gif,
    data.gift?.icon,
    data.gift?.image
  );
  const guardLevel = firstNumber(
    senderMedalVisual.guardLevel,
    senderGuard.level,
    data.guard_level,
    matchedMedalInfo.guard_level
  );
  const receiverUserId = firstNumber(receiverInfo.uid, data.receive_user_info?.uid, data.ruid);
  const receiverUserName = firstString(
    data.r_uname,
    data.receive_user_info?.uname,
    receiverBase.origin_info?.name,
    receiverBase.name
  );
  const coinType =
    data.coin_type || data.gift?.coin_type || (data.paid === false ? "silver" : "gold");

  return {
    command,
    userName: firstString(
      senderBase.origin_info?.name,
      senderBase.risk_ctrl_info?.name,
      senderBase.name,
      data.uname,
      data.user_info?.uname,
      batch.uname,
      combo.uname,
      "匿名用户"
    ),
    displayUserName: firstString(
      senderBase.origin_info?.name,
      senderBase.risk_ctrl_info?.name,
      senderBase.name,
      data.uname,
      batch.uname,
      combo.uname
    ),
    userId: firstNumber(senderInfo.uid, data.uid, data.UID, batch.uid, combo.uid, data.open_id),
    face: faceInfo.face,
    faceSource: faceInfo.faceSource,
    faceCandidates: faceInfo.faceCandidates,
    action: firstString(data.action, batch.action, combo.action, "投喂"),
    giftId,
    giftIcon,
    giftName,
    giftType: firstFiniteNumber(data.giftType, data.gift_type),
    giftTag: Array.isArray(data.gift_tag) ? data.gift_tag : [],
    giftInfo: data.gift_info || data.gift || null,
    medalName: firstString(senderMedalVisual.name, matchedMedalInfo.medal_name),
    medalLevel: firstNumber(senderMedalVisual.level, matchedMedalInfo.medal_level),
    medalColors: senderMedalVisual.colors,
    guardLevel,
    guardName: guardNameFromLevel(guardLevel),
    guardIcon: firstString(senderMedalVisual.guardIcon, matchedMedalInfo.guard_icon),
    avatarFrame: senderFrame,
    avatarFrameUrl: senderFrame?.url || "",
    avatarFrameName: senderFrame?.name || "",
    wealthLevel: firstNumber(senderInfo.wealth?.level, data.wealth_level),
    count,
    giftNum: firstFiniteNumber(
      data.gift_num,
      data.giftNum,
      batch.gift_num,
      combo.gift_num,
      data.num
    ),
    comboNum: firstNumber(data.combo_num, combo.combo_num, data.total_num),
    batchComboNum: firstNumber(data.batch_combo_num, batch.batch_combo_num),
    superGiftNum: firstNumber(data.super_gift_num),
    superBatchGiftNum: firstNumber(data.super_batch_gift_num),
    price,
    discountPrice: firstFiniteNumber(data.discount_price),
    totalCoin,
    comboTotalCoin,
    actualTotalCoin: firstNumber(comboTotalCoin, totalCoin, price ? price * count : 0),
    coinType,
    paid: data.paid !== false && coinType !== "silver",
    blindGift,
    sourceGiftId: blindGift?.originalGiftId || 0,
    sourceGiftName: blindGift?.originalGiftName || "",
    sourceGiftPrice: blindGift?.originalGiftPrice || 0,
    resultGiftPrice: blindGift?.resultPrice || price || 0,
    receiverUserId,
    receiverUid: receiverUserId,
    receiverUserName,
    receiverName: receiverUserName,
    receiverFace: cleanFaceUrl(receiverBase.origin_info?.face || receiverBase.face || ""),
    receiverRoomId: firstNumber(
      data.receive_room_id,
      data.receiver_room_id,
      data.medal_info?.anchor_roomid
    ),
    ruid: receiverUserId,
    rUname: receiverUserName,
    roomId: firstNumber(data.room_id, data.roomid),
    tid: firstString(data.tid),
    rnd: firstString(data.rnd),
    timestamp: firstFiniteNumber(
      data.timestamp,
      message.timestamp,
      timestampFromComboId(batchComboId, comboId)
    ),
    comboId,
    batchComboId,
    comboSend: combo && Object.keys(combo).length ? combo : null,
    batchComboSend: batch && Object.keys(batch).length ? batch : null,
    comboStayTime: firstFiniteNumber(data.combo_stay_time),
    comboResourcesId: firstFiniteNumber(data.combo_resources_id),
    sendMaster: data.send_master || batch.send_master || combo.send_master || null,
    isFirst: Boolean(data.is_first),
    isBatchPart: Boolean(batchComboId),
    isSpecialBatch: Boolean(data.is_special_batch),
    isJoinReceiver: Boolean(data.is_join_receiver),
    nameColor: firstString(data.name_color, senderBase.name_color_str),
    topList: Array.isArray(data.top_list) ? data.top_list : [],
    dedupeKey: firstString(batchComboId, comboId, data.tid, data.rnd, message.msg_id),
    source: "gift_packet",
    sourcePriority: "primary",
    raw: message,
  };
}

function normalizePopularityRedPocketGift(message = {}) {
  const data = message.data || {};
  const sender = data.sender_info || data.sender_uinfo || {};
  const base = sender.base || {};
  const medalVisual = normalizeMedalVisual(sender.medal || data.medal_info || {}, []);
  const guardLevel = firstNumber(data.guard?.level, sender.guard?.level, medalVisual.guardLevel);
  const avatarFrame = normalizeAvatarFrame(sender.uhead_frame || data.uhead_frame);
  const faceInfo = pickFaceCandidate([
    ["sender_origin", base.origin_info?.face],
    ["sender_base", base.face],
    ["data_face", data.face],
  ]);
  const count = firstNumber(data.num, 1);
  const price = firstFiniteNumber(data.price);
  const totalCoin = firstNumber(data.total_price, price ? price * count : 0);

  return {
    command: message.cmd || "POPULARITY_RED_POCKET_NEW",
    userName: firstString(
      base.origin_info?.name,
      base.risk_ctrl_info?.name,
      base.name,
      data.uname,
      data.sender_name,
      "匿名用户"
    ),
    displayUserName: firstString(
      base.origin_info?.name,
      base.risk_ctrl_info?.name,
      base.name,
      data.uname,
      data.sender_name
    ),
    userId: firstNumber(data.uid, sender.uid, data.sender_uid),
    face: faceInfo.face,
    faceSource: faceInfo.faceSource,
    faceCandidates: faceInfo.faceCandidates,
    action: firstString(data.action, "送出"),
    giftId: firstNumber(data.gift_id, data.giftId),
    giftName: firstString(data.gift_name, data.giftName, "红包"),
    giftIcon: firstString(data.gift_icon, data.icon_url, data.animation_icon_url),
    medalName: medalVisual.name,
    medalLevel: medalVisual.level,
    medalColors: medalVisual.colors,
    guardLevel,
    guardName: guardNameFromLevel(guardLevel),
    guardIcon: medalVisual.guardIcon,
    avatarFrame,
    avatarFrameUrl: avatarFrame?.url || "",
    avatarFrameName: avatarFrame?.name || "",
    wealthLevel: firstNumber(sender.wealth?.level, data.wealth_level),
    count,
    price,
    totalCoin,
    coinType: "gold",
    paid: true,
    roomId: firstNumber(data.room_id, data.roomid),
    timestamp: firstFiniteNumber(data.timestamp, message.timestamp, data.current_time),
    dedupeKey: firstString(
      data.lot_id && `${message.cmd || "RED_POCKET"}:${data.lot_id}:${data.uid}:${data.gift_id}:${data.num}:${data.current_time}`,
      `${message.cmd || "RED_POCKET"}:${firstNumber(data.uid, sender.uid, data.sender_uid)}:${firstNumber(data.gift_id, data.giftId)}:${count}:${firstFiniteNumber(data.timestamp, message.timestamp, data.current_time) || Date.now()}`
    ),
    source: "red_pocket",
    sourcePriority: "primary",
    raw: message,
  };
}

function parseNoticeGiftText(text = "") {
  const value = String(text || "")
    .replace(/<%(.+?)%>/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/投喂|赠送|送出|爆出|开出|礼物|盲盒/.test(value)) return null;

  const blind = value.match(/^(.{1,40}?)\s*投喂\s*(.+?盲盒)\s*(?:爆出|开出|获得)\s*(.+?)(?:\s*[x×*]\s*(\d+)|\s+(\d+)个)?(?:[，,。]|$)/);
  if (blind) {
    return {
      userName: blind[1].trim(),
      sourceGiftName: blind[2].trim(),
      giftName: blind[3].trim(),
      count: firstNumber(blind[4], blind[5], 1),
      blind: true,
    };
  }

  const normal = value.match(/^(.{1,40}?)\s*投喂\s*(?:.{1,40}?)?\s*(\d+)个(.+?)(?:[，,。]|$)/);
  if (normal) {
    return {
      userName: normal[1].trim(),
      giftName: normal[3].trim(),
      count: firstNumber(normal[2], 1),
      blind: false,
    };
  }

  return null;
}

function guardLevelFromName(name = "") {
  if (/总督/.test(name)) return 1;
  if (/提督/.test(name)) return 2;
  if (/舰长|船长/.test(name)) return 3;
  return 0;
}

function parseNoticeGuardText(text = "", fallbackName = "") {
  const value = String(text || "")
    .replace(/<%(.+?)%>/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
  if (!/开通|续费|上船|大航海|舰长|提督|总督/.test(`${value} ${fallbackName || ""}`)) return null;
  const match = value.match(
    /^(.{1,40}?)\s*在主播\s*(.{1,40}?)\s*的直播间\s*(开通了|续费了)?\s*(?:(\d{1,3})个月)?\s*(总督|提督|舰长|船长)/
  );
  const fallbackGuard = String(fallbackName || "").match(/(总督|提督|舰长|船长)/)?.[1] || "";
  if (!match && !fallbackGuard) return null;
  const guardName = match?.[5] || fallbackGuard;
  return {
    userName: match?.[1]?.trim() || "直播公告",
    anchorName: match?.[2]?.trim() || "",
    action: match?.[3] || "",
    count: firstNumber(match?.[4], 1),
    guardName: guardName === "船长" ? "舰长" : guardName,
    guardLevel: guardLevelFromName(guardName),
  };
}

function normalizeNoticeGift(message = {}, command = "") {
  const data = message.data && typeof message.data === "object" ? message.data : message;
  const segments = Array.isArray(data.content_segments) ? data.content_segments : [];
  const segmentText = segments.map((segment) => firstString(segment.text, segment.content)).join("");
  const parsed = parseNoticeGiftText(
    firstString(data.content, data.text, data.msg, data.notice_msg, data.msg_self, data.msg_common, message.msg_self, message.msg_common, segmentText)
  );
  if (!parsed?.giftName) return null;

  return {
    command: `${command}_GIFT`,
    userName: parsed.userName || "直播公告",
    displayUserName: parsed.userName || "直播公告",
    userId: 0,
    action: parsed.blind
      ? `投喂 ${parsed.sourceGiftName || "盲盒"} 爆出`
      : "投喂",
    giftName: parsed.giftName,
    sourceGiftName: parsed.sourceGiftName || "",
    blindGift: parsed.blind
      ? {
          originalGiftName: parsed.sourceGiftName || "",
          action: "爆出",
        }
      : null,
    // 跑马灯只有业务通知 id，没有真实礼物 id，置 0 只保留 giftName 文本
    giftId: 0,
    noticeBusinessId: firstString(data.business_id, message.business_id),
    count: parsed.count || 1,
    giftIcon: cleanImageUrl(
      firstString(
        data.full?.head_icon,
        data.half?.head_icon,
        message.full?.head_icon,
        message.half?.head_icon
      )
    ),
    price: 0,
    totalCoin: 0,
    coinType: "gold",
    roomId: firstNumber(data.room_id, data.roomid, message.roomid, message.real_roomid),
    timestamp: firstFiniteNumber(data.timestamp, message.timestamp),
    source: "notice_gift",
    // 跑马灯合成礼物为次级来源：同窗口内 gift_packet/red_pocket 优先，下游据此去重
    sourcePriority: "secondary",
    dedupeKey: firstString(
      message.marquee_id,
      data.marquee_id,
      `${command}:gift:${parsed.userName}:${parsed.sourceGiftName || ""}:${parsed.giftName}:${parsed.count}:${data.send_time || message.timestamp || data.timestamp || ""}`
    ),
    raw: message,
  };
}

function normalizeNoticeGuard(message = {}, command = "") {
  const data = message.data && typeof message.data === "object" ? message.data : message;
  const segments = Array.isArray(data.content_segments) ? data.content_segments : [];
  const segmentText = segments.map((segment) => firstString(segment.text, segment.content)).join("");
  const text = firstString(
    data.content,
    data.text,
    data.msg,
    data.notice_msg,
    data.msg_self,
    data.msg_common,
    message.msg_self,
    message.msg_common,
    segmentText
  );
  const parsed = parseNoticeGuardText(text, firstString(data.name, message.name));
  if (!parsed?.guardLevel) return null;
  const roomId = firstNumber(data.room_id, data.roomid, message.roomid, message.real_roomid);
  return {
    command: `${command}_GUARD`,
    userName: parsed.userName || "直播公告",
    displayUserName: parsed.userName || "直播公告",
    userId: 0,
    guardLevel: parsed.guardLevel,
    guardName: parsed.guardName,
    count: parsed.count || 1,
    unit: "月",
    message: text.replace(/<%(.+?)%>/g, " $1 ").replace(/\s+/g, " ").trim(),
    roomId,
    timestamp: firstFiniteNumber(data.timestamp, message.timestamp),
    source: "notice_guard",
    dedupeKey: firstString(
      message.marquee_id,
      `${command}:guard:${roomId}:${parsed.userName}:${parsed.guardName}:${parsed.count}:${message.timestamp || data.timestamp || ""}`
    ),
    raw: message,
  };
}

function classifyPkNoticeText(text = "") {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/PK玩法小贴士|双方主播.*一比高下|一比高下|守塔|逆转比赛|快要输掉|暂时领先|对面感觉|送个礼物.*主播|惩罚|\bpk\b/i.test(value) === false) {
    return null;
  }
  let type = "info";
  let level = "info";
  if (/快要输掉|落后|逆转比赛|赶紧冲|救一下|上票|加油/i.test(value)) {
    type = "behind";
    level = "warn";
  } else if (/暂时领先|守塔|保护好|领先/i.test(value)) {
    type = "ahead";
    level = "success";
  } else if (/PK玩法小贴士|一比高下/i.test(value)) {
    type = "tip";
  } else if (/对面感觉|送个礼物|拿下比赛/i.test(value)) {
    type = "call";
    level = "warn";
  } else if (/惩罚/i.test(value)) {
    type = "punish";
  }
  return {
    type,
    level,
    text: value,
  };
}

function normalizeNoticeDanmaku(message = {}, command = "") {
  const data = message.data && typeof message.data === "object" ? message.data : message;
  const contentSegments = Array.isArray(data.content_segments) ? data.content_segments : [];
  const segments = contentSegments.map((segment) => ({
    type: segment.type,
    text: firstString(segment.text, segment.content),
    imageUrl: cleanImageUrl(segment.img_url),
    imageWidth: firstFiniteNumber(segment.img_width),
    imageHeight: firstFiniteNumber(segment.img_height),
    fontColor: firstString(segment.font_color),
    fontColorDark: firstString(segment.font_color_dark),
    highlightFontColor: firstString(segment.highlight_font_color),
    highlightFontColorDark: firstString(segment.highlight_font_color_dark),
    fontBold: Boolean(segment.font_bold),
    backgroundColor: segment.background_color || null,
    backgroundColorDark: segment.background_color_dark || null,
    raw: segment,
  }));
  const segmentText = segments.map((segment) => segment.text).filter(Boolean).join("");
  const rawText = firstString(
    data.content,
    data.text,
    data.msg,
    data.notice_msg,
    data.msg_self,
    data.msg_common,
    message.msg_self,
    message.msg_common,
    segmentText
  );
  const text = rawText.replace(/<%(.+?)%>/g, " $1 ").replace(/\s+/g, " ").trim();
  const pkNotice = classifyPkNoticeText(text);
  const noticeKind = /投喂|赠送|送出|礼物|盲盒|爆出|开出|小亏|血赚|电池/.test(text)
    ? "gift"
    : pkNotice
      ? "pk"
    : "announcement";

  return {
    command,
    text,
    noticeKind,
    pkNotice,
    segments,
    images: segments.map((segment) => segment.imageUrl).filter(Boolean),
    style: data.danmaku_style || {
      full: message.full || null,
      half: message.half || null,
      side: message.side || null,
    },
    terminals: Array.isArray(data.terminals) ? data.terminals : [],
    dmscore: firstFiniteNumber(data.dmscore),
    roomId: firstNumber(data.room_id, data.roomid, message.roomid, message.real_roomid),
    linkUrl: firstString(data.link_url, message.link_url),
    msgType: firstFiniteNumber(data.msg_type, message.msg_type),
    noticeType: firstFiniteNumber(data.notice_type, message.notice_type),
    businessId: firstString(data.business_id, message.business_id),
    raw: message,
  };
}

class BilibiliLiveClient extends EventEmitter {
  constructor(options) {
    super();
    this.roomInput = options.room;
    this.uid = Number(options.uid || 0);
    this.cookie = options.cookie || "";
    this.reconnect = options.reconnect !== false;
    this.heartbeatMs = options.heartbeatMs || 30000;
    this.reconnectBaseMs = options.reconnectBaseMs || 3000;
    this.reconnectMaxMs = options.reconnectMaxMs || 30000;
    // 收包看门狗：超过约 2.5 个心跳周期无任何包（含心跳应答）则强制断开重连
    this.watchdogMs = Number(options.watchdogMs || 0) || Math.round(this.heartbeatMs * 2.5);
    this.identityTtlMs = Number(options.identityTtlMs || 0) || 24 * 60 * 60 * 1000;
    this.identityMaxEntries = Number(options.identityMaxEntries || 0) || 50000;
    this.ws = null;
    this.stopped = false;
    this.lifecycleGeneration = 0;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.hostIndex = Number(options.hostIndex || 0);
    this.reconnectAttempts = 0;
    this.lastPacketAt = 0;
    this.needConfRefresh = false;
    this.lastIdentitySweepAt = 0;
    this.room = null;
    this.danmu = null;
    this.identityByFace = new Map();
    this.identityByUid = new Map();
    this.pendingMaskedEntries = [];
  }

  async start() {
    // 每次启动独占一个代次；停止或再次启动后，旧请求不得再写回状态。
    const generation = this.lifecycleGeneration + 1;
    this.stop();
    if (generation !== this.lifecycleGeneration) return;
    this.stopped = false;
    const active = () => !this.stopped && generation === this.lifecycleGeneration;
    let room;
    try {
      room = await resolveRoom(this.roomInput);
    } catch (error) {
      if (!active()) return;
      throw error;
    }
    if (!active()) return;

    let danmu;
    try {
      danmu = await getDanmuConf(room.roomId, {
        cookie: this.cookie,
      });
    } catch (error) {
      if (!active()) return;
      danmu = {
        token: "",
        hosts: FALLBACK_HOSTS,
        warning: error.message,
      };
    }
    if (!active()) return;
    this.room = room;
    this.danmu = danmu;
    this.rememberIdentity({
      uid: room.uid,
      userName: room.uname,
      face: room.face,
    });

    this.emit("room", {
      ...this.room,
      liveStatusLabel: mapLiveStatus(this.room.liveStatus),
      danmuWarning: this.danmu.warning || "",
      hosts: this.danmu.hosts,
    });
    if (active()) this.openSocket();
  }

  stop() {
    this.lifecycleGeneration += 1;
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      // 对端不应答 close 握手时 socket 会挂 ~30 秒拖住进程退出，兜底强制断开。
      const closeGuard = setTimeout(() => {
        try {
          ws.terminate();
        } catch {
          // Ignore terminate races.
        }
      }, 3000);
      closeGuard.unref?.();
      ws.once?.("close", () => clearTimeout(closeGuard));
      try {
        ws.close();
      } catch {
        // Ignore close races; the guard still terminates this socket.
      }
    }
  }

  openSocket() {
    if (this.stopped) return;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    if (this.ws) {
      // 防御双 start：替换前掐断旧连接，避免孤儿 socket 常驻
      const previous = this.ws;
      this.ws = null;
      try {
        previous.terminate();
      } catch {
        // Ignore terminate races.
      }
    }
    const generation = this.lifecycleGeneration;
    const endpoint = chooseEndpoint(this.danmu?.hosts, this.hostIndex);
    this.emit("connecting", { endpoint });
    if (this.stopped || generation !== this.lifecycleGeneration) return;

    const headers = {
      ...DEFAULT_HEADERS,
      Origin: "https://live.bilibili.com",
      ...(this.cookie ? { Cookie: this.cookie } : {}),
    };
    const ws = new WebSocketImpl(endpoint, {
      headers,
      handshakeTimeout: 10000,
      perMessageDeflate: false,
    });
    this.ws = ws;

    ws.on("open", () => {
      if (this.stopped || ws !== this.ws) {
        // 迟到的孤儿连接，直接掐断避免双连接互杀
        try {
          ws.terminate();
        } catch {
          // Ignore terminate races.
        }
        return;
      }
      this.reconnectAttempts = 0;
      this.lastPacketAt = Date.now();
      this.emit("connected", { endpoint });
      if (this.stopped || ws !== this.ws || generation !== this.lifecycleGeneration) return;
      this.sendAuth();
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (ws !== this.ws) return;
        if (this.lastPacketAt && Date.now() - this.lastPacketAt > this.watchdogMs) {
          this.emit("warn", {
            message: `超过 ${this.watchdogMs}ms 未收到任何数据包，判定连接半开，强制重连`,
          });
          try {
            ws.terminate();
          } catch {
            // Ignore terminate races.
          }
          return;
        }
        this.sendHeartbeat();
      }, this.heartbeatMs);
    });

    ws.on("message", (data) => {
      if (ws !== this.ws) return;
      this.lastPacketAt = Date.now();
      try {
        this.handleMessage(data);
      } catch (error) {
        this.emit("warn", {
          message: `弹幕包解析失败: ${error.message}`,
          error,
        });
      }
    });

    ws.on("error", (error) => {
      if (this.stopped || ws !== this.ws) return;
      this.emit("warn", {
        message: "WebSocket 连接错误",
        error,
      });
    });

    ws.on("close", (code, reason) => {
      const isCurrent = ws === this.ws;
      if (!isCurrent && !this.stopped) {
        // 已被替换的旧连接迟到的 close，不能动新连接的定时器
        return;
      }
      if (isCurrent) {
        this.ws = null;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.emit("closed", {
        code,
        reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
      });

      // closed 的订阅者可能已经重新启动或替换连接，旧关闭事件不得再调度重连。
      if (
        isCurrent && !this.stopped && generation === this.lifecycleGeneration &&
        !this.ws && this.reconnect
      ) {
        this.scheduleReconnect();
      }
    });
  }

  sendAuth() {
    let buvid = "";
    const buvidMatch = String(this.cookie || "").match(/(?:^|;\s*)buvid3=([^;]+)/);
    if (buvidMatch) {
      try {
        buvid = decodeURIComponent(buvidMatch[1].trim());
      } catch {
        buvid = buvidMatch[1].trim();
      }
    }
    const auth = {
      uid: this.uid || 0,
      roomid: this.room.roomId,
      protover: 3,
      ...(buvid ? { buvid } : {}),
      platform: "web",
      type: 2,
      key: this.danmu?.token || "",
    };
    this.sendPacket(OP_AUTH, auth, 1);
  }

  sendHeartbeat() {
    this.sendPacket(OP_HEARTBEAT, {}, 1);
  }

  sendPacket(operation, body, version) {
    if (!this.ws || this.ws.readyState !== SOCKET_OPEN) {
      return;
    }
    this.ws.send(encodePacket(operation, body, version));
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const generation = this.lifecycleGeneration;
    const active = () => !this.stopped && generation === this.lifecycleGeneration;
    clearTimeout(this.reconnectTimer);
    this.hostIndex += 1;
    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts - 1, 5),
      this.reconnectMaxMs
    );
    // 认证被拒或连续多次失败时，重连前刷新弹幕 token（token 有时效，复用旧值会死循环）
    const shouldRefresh =
      this.needConfRefresh ||
      (this.reconnectAttempts > 0 && this.reconnectAttempts % CONF_REFRESH_EVERY_ATTEMPTS === 0);
    this.emit("reconnecting", { delayMs: delay, refreshConf: shouldRefresh });
    if (!active()) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!active()) return;
      if (!shouldRefresh) {
        this.openSocket();
        return;
      }
      this.refreshDanmuConf(generation).then(() => {
        if (active()) this.openSocket();
      });
    }, delay);
  }

  async refreshDanmuConf(generation = this.lifecycleGeneration) {
    const active = () => !this.stopped && generation === this.lifecycleGeneration;
    if (!active()) return;
    try {
      const danmu = await getDanmuConf(this.room.roomId, {
        cookie: this.cookie,
      });
      if (active() && danmu && (danmu.token || danmu.hosts?.length)) {
        this.danmu = danmu;
        this.needConfRefresh = false;
      }
    } catch (error) {
      if (!active()) return;
      this.emit("warn", {
        message: `刷新弹幕服务器配置失败: ${error.message}`,
        error,
      });
    }
  }

  handleMessage(data) {
    const buffer = Buffer.from(data);
    const packets = decodePackets(buffer);

    for (const packet of packets) {
      // 单包坏数据只丢自己，不能拖垮同帧内其余包（B 站惯用一帧压几十条）
      try {
        this.handlePacket(packet);
      } catch (error) {
        this.emit("warn", {
          message: `弹幕单包处理失败(op=${packet.operation}): ${error.message}`,
          error,
        });
      }
    }
  }

  handlePacket(packet) {
    if (packet.operation === OP_AUTH_REPLY) {
      let body = null;
      try {
        body = parseJsonBody(packet.body);
      } catch {
        body = null;
      }
      const code = Number(body?.code ?? 0);
      if (code !== 0) {
        // 认证被拒（通常是 token 过期），标记刷新配置后强制走重连
        this.needConfRefresh = true;
        this.emit("warn", {
          message: `弹幕认证被拒绝 (code=${code})，将刷新配置后重连`,
        });
        if (this.ws) {
          try {
            this.ws.terminate();
          } catch {
            // Ignore terminate races.
          }
        }
        return;
      }
      this.emit("authenticated", body || { code: 0 });
      return;
    }

    if (packet.operation === OP_HEARTBEAT_REPLY) {
      const popularity =
        packet.body.length >= 4 ? packet.body.readUInt32BE(0) : undefined;
      this.emit("popularity", { popularity });
      return;
    }

    if (packet.operation !== OP_MESSAGE) {
      this.emit("packet", packet);
      return;
    }

    const message = parseJsonBody(packet.body);
    if (!message) return;

    const command = getCommandName(message.cmd);
    this.emit("raw", {
      command,
      message,
    });

    if (command === "ONLINE_RANK_V3" || command === "ONLINE_RANK_V2") {
      const rows =
        command === "ONLINE_RANK_V3"
          ? parseOnlineRankV3(message.data || {})
          : parseOnlineRankV2(message.data || {});
      for (const identity of rows) {
        this.rememberIdentity(identity);
      }
      this.emit("onlineRank", {
        command,
        rows,
        raw: message,
      });
      return;
    }

    if (command === "ONLINE_RANK_TOP3") {
      const rows = parseOnlineRankTop(message.data || {});
      for (const identity of rows) {
        this.rememberIdentity(identity);
      }
      this.emit("onlineRank", {
        command,
        rows,
        raw: message,
      });
      return;
    }

    if (command === "ONLINE_RANK_COUNT") {
      const data = message.data || {};
      this.emit("onlineStats", {
        command,
        onlineCount: firstNumber(data.online_count, data.count),
        onlineText: firstString(data.online_count_text, data.count_text),
        raw: message,
      });
      return;
    }

    if (command === "WATCHED_CHANGE") {
      const data = message.data || {};
      this.emit("watchedStats", {
        command,
        watchedCount: firstNumber(data.num, data.watched_count, data.count),
        watchedText: firstString(data.text_large, data.text_small, data.num_text),
        raw: message,
      });
      return;
    }

    if (command === "LIVE" || command === "PREPARING") {
      this.emit("event", normalizeLiveStatusEvent(message, command));
      return;
    }

    if (command === "LOG_IN_NOTICE" || command === "SYS_MSG" || command === "ROOM_SKIN_MSG") {
      this.emit("event", normalizeSystemEvent(message, command));
      return;
    }

    if (command === "MESSAGEBOX_USER_MEDAL_CHANGE") {
      this.emit("event", normalizeMedalChangeEvent(message, command));
      return;
    }

    if (command === "WEALTH_NOTIFY") {
      this.emit("event", normalizeWealthNotifyEvent(message, command));
      return;
    }

    if (command === "ROOM_REAL_TIME_MESSAGE_UPDATE") {
      this.emit("event", normalizeRoomRealtimeEvent(message, command));
      return;
    }

    if (
      command === "POPULAR_RANK_CHANGED" ||
      command === "RANK_CHANGED" ||
      command === "RANK_CHANGED_V2"
    ) {
      this.emit("event", normalizeRankEvent(message, command));
      return;
    }

    if (
      command === "WIDGET_BANNER" ||
      command === "WIDGET_GIFT_STAR_PROCESS" ||
      command === "WIDGET_GIFT_STAR_PROCESS_V2" ||
      command === "LIVE_PANEL_CHANGE_CONTENT" ||
      command === "GIFT_PANEL_PLAN" ||
      command === "CUSTOM_NOTICE_CARD"
    ) {
      this.emit("event", normalizeWidgetEvent(message, command));
      return;
    }

    if (
      command === "DM_INTERACTION" ||
      command === "LIVE_INTERACT_GAME_STATE_CHANGE" ||
      command === "OPENPLATFORM_GAME_BUTTON_STATUS_CHANGE" ||
      command === "LIVE_OPEN_PLATFORM_GAME"
    ) {
      this.emit("event", normalizeActivityEvent(message, command));
      return;
    }

    if (command === "DANMU_AGGREGATION") {
      this.emit("event", normalizeDanmuAggregationEvent(message, command));
      return;
    }

    if (command === "FLOW_REWARD_CARD") {
      this.emit("event", normalizeFlowRewardCardEvent(message, command));
      return;
    }

    if (command === "POPULARITY_RANK_TAB_CHG") {
      this.emit("event", normalizePopularityRankTabEvent(message, command));
      return;
    }

    if (command === "ROOM_CHANGE") {
      this.emit("event", normalizeRoomChangeEvent(message, command));
      return;
    }

    if (
      isLotteryActivityCommand(command) &&
      command !== "POPULARITY_RED_POCKET_NEW" &&
      command !== "POPULARITY_RED_POCKET_V2_NEW"
    ) {
      this.emit("event", normalizeLotteryActivityEvent(message, command));
      return;
    }

    if (
      command === "ROOM_BLOCK_MSG" ||
      command === "ROOM_SILENT_ON" ||
      command === "ROOM_SILENT_OFF" ||
      command === "ROOM_BLOCK_INTO" ||
      command === "RECALL_DANMU_MSG"
    ) {
      this.emit("event", normalizeBlockEvent(message, command));
      return;
    }

    if (
      command.startsWith("VOICE_JOIN") ||
      command.startsWith("VIDEO_CONNECTION") ||
      command === "LIVE_ROOM_TOAST_MESSAGE"
    ) {
      const connectionEvent = normalizeConnectionEvent(message, command);
      this.emit("event", connectionEvent);
      return;
    }

    if (command === "GUARD_HONOR_THOUSAND") {
      const data = message.data || {};
      this.emit("event", {
        command,
        eventKind: "guard_honor",
        text: firstString(data.toast_msg, data.msg, data.text, "大航海荣誉事件"),
        roomId: firstNumber(data.room_id, data.roomid, message.roomid),
        addUids: Array.isArray(data.add) ? data.add.map(Number).filter(Boolean) : [],
        delUids: Array.isArray(data.del) ? data.del.map(Number).filter(Boolean) : [],
        raw: message,
      });
      return;
    }

    if (command.startsWith("PK_")) {
      this.emit("pk", {
        command,
        pkId: message.pk_id || message.data?.pk_basic?.pk_id || message.data?.pk_id || 0,
        pkStatus:
          message.pk_status ||
          message.data?.pk_basic?.status ||
          message.data?.pk_status ||
          0,
        timestamp: message.timestamp || 0,
        data: message.data || {},
        raw: message,
      });
      return;
    }

    if (
      command === "UNIVERSAL_EVENT_GIFT" ||
      command === "UNIVERSAL_EVENT_GIFT_V2"
    ) {
      const multiData = normalizeUniversalMultiData(message.data || {}, command);
      if (multiData) {
        this.emit("pk", {
          command: "PK_MULTI_CONN",
          pkId: message.pk_id || 0,
          pkStatus: multiData.sessionStatus || 0,
          timestamp: message.timestamp || message.data?.system_time_unix || 0,
          data: multiData,
          raw: message,
        });
        return;
      }
    }

    if (command === "COMMON_NOTICE_DANMAKU" || command === "NOTICE_MSG") {
      const notice = normalizeNoticeDanmaku(message, command);
      this.emit("notice", notice);
      const noticeGift = normalizeNoticeGift(message, command);
      const noticeGuard = normalizeNoticeGuard(message, command);
      const noticeRoomId = Number(noticeGift?.roomId || noticeGuard?.roomId || notice.roomId || 0);
      const isRoomLocalNotice =
        !noticeRoomId ||
        Number(noticeRoomId) === Number(this.room?.roomId || 0);
      if (noticeGift && isRoomLocalNotice) {
        this.emit("gift", noticeGift);
      }
      if (noticeGuard && isRoomLocalNotice) {
        this.emit("guard", noticeGuard);
      }
      if (notice.pkNotice && isRoomLocalNotice) {
        this.emit("pk", {
          command: "PK_NOTICE",
          eventKind: "pk_notice",
          at: Date.now(),
          text: notice.text,
          noticeType: notice.pkNotice.type,
          noticeLevel: notice.pkNotice.level,
          timestamp: firstFiniteNumber(message.timestamp, message.data?.timestamp, Math.floor(Date.now() / 1000)),
          data: {
            text: notice.text,
            noticeType: notice.pkNotice.type,
            noticeLevel: notice.pkNotice.level,
            sourceCommand: command,
            notice,
          },
          raw: message,
        });
      }
      if (command === "COMMON_NOTICE_DANMAKU" && notice.noticeKind === "gift" && isRoomLocalNotice) {
        this.emit("chat", {
          command,
          text: notice.text,
          userName: "直播公告",
          displayUserName: "直播公告",
          userId: 0,
          source: "notice_danmaku",
          isNotice: true,
          noticeKind: notice.noticeKind,
          raw: message,
        });
      }
      this.emit("event", {
        command,
        text: notice.text,
        noticeKind: notice.noticeKind,
        notice,
        raw: message,
      });
      return;
    }

    if (command === "DANMU_MSG") {
      const text = message.info?.[1] || "";
      const user = message.info?.[2] || [];
      const medal = message.info?.[3] || [];
      const richUser = message.info?.[0]?.[15]?.user || {};
      const richBase = richUser.base || {};
      const richMedal = richUser.medal || {};
      const richGuard = richUser.guard || {};
      const medalVisual = normalizeMedalVisual(richMedal, medal);
      const avatarFrame = normalizeAvatarFrame(
        richUser.uhead_frame || richUser.face_frame || message.info?.[0]?.[15]?.user_info?.face_frame
      );
      const rawUserName = firstString(
        richBase.origin_info?.name,
        richBase.risk_ctrl_info?.name,
        richBase.name,
        user[1],
        "匿名用户"
      );
      this.learnIdentityFromWelcomeText(text);
      const face = cleanFaceUrl(
        richBase.origin_info?.face ||
          richBase.risk_ctrl_info?.face ||
          richBase.face ||
          message.info?.[0]?.[15]?.user?.base?.face ||
          ""
      );
      const cached = this.resolveIdentity({
        uid: user[0] || 0,
        face,
        userName: rawUserName,
      });
      this.rememberIdentity({
        uid: user[0] || 0,
        userName: cached.userName,
        face,
      });
      const guardLevel = firstNumber(medalVisual.guardLevel, richGuard.level);
      this.emit("chat", {
        command,
        text,
        userName: cached.userName || rawUserName,
        displayUserName: cached.displayUserName,
        isMaskedName: cached.isMaskedName,
        identityResolved: cached.identityResolved,
        userId: user[0] || 0,
        medalName: medalVisual.name,
        medalLevel: medalVisual.level,
        medalColors: medalVisual.colors,
        guardLevel,
        guardName: guardNameFromLevel(guardLevel),
        guardIcon: medalVisual.guardIcon,
        avatarFrame,
        avatarFrameUrl: avatarFrame?.url || "",
        avatarFrameName: avatarFrame?.name || "",
        wealthLevel: firstNumber(richUser.wealth?.level, message.info?.[16]?.[0]),
        titleCssId: firstString(richUser.title?.title_css_id, message.info?.[5]?.[1]),
        face,
        raw: message,
      });
      return;
    }

    if (
      command === "OPEN_LIVEROOM_DM" ||
      command === "LIVE_OPEN_PLATFORM_DM"
    ) {
      const data = message.data || {};
      this.learnIdentityFromWelcomeText(data.msg || "");
      this.emit("chat", {
        command,
        text: data.msg || "",
        userName: data.uname || "匿名用户",
        userId: data.uid || data.open_id || 0,
        medalName: data.fans_medal_name || "",
        medalLevel: data.fans_medal_level || 0,
        raw: message,
      });
      return;
    }

	    if (
	      command === "INTERACT_WORD" ||
	      command === "INTERACT_WORD_V2" ||
	      command === "OPEN_PLATFORM_LIVE_ROOM_ENTER" ||
	      command === "OPEN_LIVEROOM_LIVE_ROOM_ENTER" ||
	      command === "LIVE_OPEN_PLATFORM_ENTER_ROOM" ||
	      command === "ENTRY_EFFECT" ||
	      command === "ENTRY_EFFECT_MUST_RECEIVE"
	    ) {
      const data = message.data || {};
      const decodedV2 =
        command === "INTERACT_WORD_V2" ? decodeInteractWordV2(data) : {};
      const userInfo = data.uinfo || {};
      const base = userInfo.base || {};
      const medalVisual = normalizeMedalVisual(userInfo.medal || {}, []);
      const avatarFrame = normalizeAvatarFrame(
        userInfo.uhead_frame || data.user_info?.face_frame || data.face_frame
      );
      const copyName = cleanUserName(extractNameFromCopyWriting(
        data.copy_writing_v2,
        data.copy_writing
      ));
      const userName = firstUserName(
        base.origin_info?.name,
        base.risk_ctrl_info?.name,
        base.name,
        data.uname,
        copyName,
        decodedV2.userName,
        "匿名用户"
      );
      const face = cleanFaceUrl(data.face || base.face || decodedV2.face || "");
      const cached = this.resolveIdentity({
        uid: data.uid || data.open_id || base.uid || 0,
        face,
        userName,
      });
      this.rememberIdentity({
        uid: data.uid || data.open_id || base.uid || 0,
        userName: cached.userName,
        face,
      });
      if (cached.isMaskedName) {
        this.rememberMaskedEntry({
          userName,
          face,
          roomId: data.room_id,
        });
      }
      this.emit("interact", {
        command,
        userName: cached.userName || userName,
        displayUserName: cached.displayUserName,
        isMaskedName: cached.isMaskedName,
        identityResolved: cached.identityResolved,
	        userId: data.uid || data.open_id || base.uid || 0,
	        msgType: data.msg_type,
	        interactKind:
	          command === "ENTRY_EFFECT" || command === "ENTRY_EFFECT_MUST_RECEIVE"
	            ? "entry_effect"
	            : Number(data.msg_type || 0) === 2 || Number(data.msg_type || 0) === 5
              ? "follow"
              : Number(data.msg_type || 0) === 3
                ? "share"
                : "enter",
        roomId: data.room_id,
        face,
        medalName: data.medal_name || medalVisual.name || decodedV2.medalName || "",
        medalLevel: firstNumber(medalVisual.level, data.medal_level),
        medalColors: medalVisual.colors,
        guardLevel: firstNumber(userInfo.guard?.level, medalVisual.guardLevel, data.privilege_type),
        guardName: guardNameFromLevel(
          firstNumber(userInfo.guard?.level, medalVisual.guardLevel, data.privilege_type)
        ),
        guardIcon: medalVisual.guardIcon,
        avatarFrame,
        avatarFrameUrl: avatarFrame?.url || "",
        avatarFrameName: avatarFrame?.name || "",
        wealthLevel: firstNumber(userInfo.wealth?.level, data.wealthy_info?.level),
        message: firstString(data.copy_writing, data.copy_writing_v2, decodedV2.message),
        raw: message,
      });
      return;
    }

	    if (command === "SEND_GIFT" || command === "OPEN_LIVEROOM_SEND_GIFT" || command === "LIVE_OPEN_PLATFORM_SEND_GIFT") {
	      this.emit("gift", normalizeGiftPacket(message, command));
	      return;
	    }
	
	    if (command === "COMBO_SEND" || command === "GIFT_COMBO") {
	      this.emit("gift", normalizeGiftPacket(message, command));
	      return;
	    }

    if (
      command === "POPULARITY_RED_POCKET_NEW" ||
      command === "POPULARITY_RED_POCKET_V2_NEW"
    ) {
      this.emit("gift", normalizePopularityRedPocketGift(message));
      return;
    }

    if (
      command === "SUPER_CHAT_MESSAGE" ||
      command === "SUPER_CHAT_MESSAGE_JPN" ||
      command === "SUPER_CHAT_MESSAGE_DELETE"
    ) {
      this.emit("superChat", normalizeSuperChatEvent(message, command));
      return;
    }

    if (
      command === "OPEN_LIVEROOM_SUPER_CHAT" ||
      command === "LIVE_OPEN_PLATFORM_SUPER_CHAT"
    ) {
      this.emit("superChat", normalizeOpenSuperChatEvent(message, command));
      return;
    }

	    if (
	      command === "GUARD_BUY" ||
	      command === "USER_TOAST_MSG" ||
	      command === "USER_TOAST_MSG_V2" ||
	      command === "OPEN_LIVEROOM_GUARD" ||
	      command === "LIVE_OPEN_PLATFORM_GUARD"
	    ) {
	      const data = message.data || {};
	      const userInfo = data.user_info || {};
	      const sender = data.sender_uinfo || data.sender_info || {};
	      const senderBase = sender.base || {};
	      const guardInfo = data.guard_info || {};
	      const payInfo = data.pay_info || {};
	      const base = data.uinfo?.base || data.user_info?.base || senderBase || {};
	      const medal = data.uinfo?.medal || data.user_info?.medal || data.medal_info || {};
	      const guard = data.uinfo?.guard || data.user_info?.guard || {};
	      const avatarFrame = normalizeAvatarFrame(
	        data.uinfo?.uhead_frame || data.user_info?.uhead_frame || data.user_info?.face_frame
	      );
	      const medalVisual = normalizeMedalVisual(medal, []);
	      const guardLevel = firstNumber(
	        data.guard_level,
	        data.guardLevel,
	        guardInfo.guard_level,
	        medalVisual.guardLevel,
	        guard.level
	      );
      this.emit("guard", {
        command,
        userName:
	          data.username ||
	          data.uname ||
	          userInfo.uname ||
	          data.user_info?.username ||
	          senderBase.origin_info?.name ||
	          senderBase.risk_ctrl_info?.name ||
	          senderBase.name ||
	          base.origin_info?.name ||
	          base.risk_ctrl_info?.name ||
	          base.name ||
	          "匿名用户",
	        userId: data.uid || data.open_id || userInfo.open_id || sender.uid || 0,
	        face: firstString(
	          data.face,
	          userInfo.face,
	          senderBase.origin_info?.face,
	          senderBase.face,
	          base.origin_info?.face,
	          base.face
	        ),
	        guardLevel,
	        guardName: data.role_name || data.guard_name || guardInfo.role_name || guardNameFromLevel(guardLevel),
	        count: data.num || data.guard_num || payInfo.num || 1,
	        unit: data.unit || data.guard_unit || payInfo.unit || "月",
	        price: data.price || payInfo.price || 0,
	        totalCoin: data.total_coin || data.price || payInfo.price || 0,
	        guardIcon: firstString(data.guard_icon, medalVisual.guardIcon),
        medalName: firstString(medal.medal_name, medalVisual.name),
        medalLevel: firstNumber(medal.medal_level, medalVisual.level),
        medalColors: medalVisual.colors,
        avatarFrame,
        avatarFrameUrl: avatarFrame?.url || "",
        avatarFrameName: avatarFrame?.name || "",
        wealthLevel: firstNumber(data.uinfo?.wealth?.level, data.user_info?.wealth?.level),
        message: data.toast_msg || "",
        raw: message,
      });
      return;
    }

    if (
      command === "LIKE_INFO_V3_CLICK" ||
      command === "LIKE_INFO_V3_UPDATE" ||
      command === "LIKE_GUIDE_USER" ||
      command === "OPEN_LIVEROOM_LIKE" ||
      command === "LIVE_OPEN_PLATFORM_LIKE"
    ) {
      const data = message.data || {};
      const userInfo = data.uinfo || {};
      const base = userInfo.base || {};
      const medalVisual = normalizeMedalVisual(userInfo.medal || data.fans_medal || {}, []);
      const guardLevel = firstNumber(userInfo.guard?.level, medalVisual.guardLevel);
      const avatarFrame = normalizeAvatarFrame(userInfo.uhead_frame);
      this.emit("like", {
        command,
        userName: firstString(
          base.origin_info?.name,
          base.risk_ctrl_info?.name,
          base.name,
          data.uname,
          "匿名用户"
        ),
        displayUserName: firstString(
          base.origin_info?.name,
          base.risk_ctrl_info?.name,
          base.name,
          data.uname
        ),
        userId: data.uid || data.open_id || 0,
        likeCount: data.like_count || data.click_count || data.count || 1,
        text: data.like_text || "",
        face: cleanFaceUrl(
          firstString(base.origin_info?.face, base.risk_ctrl_info?.face, base.face)
        ),
        medalName: medalVisual.name,
        medalLevel: medalVisual.level,
        medalColors: medalVisual.colors,
        guardLevel,
        guardName: guardNameFromLevel(guardLevel),
        guardIcon: medalVisual.guardIcon,
        avatarFrame,
        avatarFrameUrl: avatarFrame?.url || "",
        avatarFrameName: avatarFrame?.name || "",
        wealthLevel: firstNumber(userInfo.wealth?.level),
        raw: message,
      });
      return;
    }

    this.emit("event", {
      command,
      raw: message,
    });
  }

  rememberIdentity(identity = {}) {
    const userName = firstUserName(identity.userName, identity.uname, identity.name);
    if (!userName || isMaskedName(userName) || userName === "匿名用户") return;

    const record = {
      uid: Number(identity.uid || 0),
      userName,
      face: cleanFaceUrl(identity.face),
      at: Date.now(),
    };

    // 先删后写保持 Map 插入序即活跃序，容量淘汰时先淘汰最久未活跃的
    if (record.uid) {
      this.identityByUid.delete(String(record.uid));
      this.identityByUid.set(String(record.uid), record);
    }
    if (record.face) {
      this.identityByFace.delete(record.face);
      this.identityByFace.set(record.face, record);
    }
    this.pruneIdentityMaps();
  }

  pruneIdentityMaps() {
    const now = Date.now();
    if (now - this.lastIdentitySweepAt >= IDENTITY_SWEEP_INTERVAL_MS) {
      this.lastIdentitySweepAt = now;
      for (const map of [this.identityByUid, this.identityByFace]) {
        for (const [key, record] of map) {
          if (now - Number(record?.at || 0) > this.identityTtlMs) {
            map.delete(key);
          }
        }
      }
    }
    for (const map of [this.identityByUid, this.identityByFace]) {
      while (map.size > this.identityMaxEntries) {
        const oldestKey = map.keys().next().value;
        if (oldestKey === undefined) break;
        map.delete(oldestKey);
      }
    }
  }

  rememberMaskedEntry(entry = {}) {
    const face = cleanFaceUrl(entry.face);
    const prefix = maskedPrefix(entry.userName);
    if (!face || !prefix) return;

    const now = Date.now();
    this.pendingMaskedEntries = this.pendingMaskedEntries.filter(
      (item) => now - item.at < 20000
    );
    this.pendingMaskedEntries.push({
      face,
      prefix,
      userName: entry.userName,
      roomId: entry.roomId || 0,
      at: now,
    });
  }

  learnIdentityFromWelcomeText(text) {
    const names = extractWelcomeNames(text);
    if (!names.length) return;

    const now = Date.now();
    this.pendingMaskedEntries = this.pendingMaskedEntries.filter(
      (item) => now - item.at < 20000
    );

    for (const fullName of names) {
      // 只认打码前缀的严格前缀匹配，宽松首字匹配会把 A 的头像错绑到 B 的真名上
      const candidates = this.pendingMaskedEntries
        .filter((item) => fullName.startsWith(item.prefix))
        .sort((left, right) => right.at - left.at);
      const target = candidates[0];
      if (!target) continue;
      // 命中即消费，避免同一张脸被后续人名重复绑定
      this.pendingMaskedEntries = this.pendingMaskedEntries.filter(
        (item) => item !== target
      );
      this.rememberIdentity({
        userName: fullName,
        face: target.face,
      });
    }
  }

  resolveIdentity({ uid = 0, face = "", userName = "" } = {}) {
    const inputName = cleanUserName(userName);
    const masked = isMaskedName(inputName);
    const now = Date.now();
    const fresh = (record) =>
      record && now - Number(record.at || 0) <= this.identityTtlMs ? record : null;
    const byUid = uid ? fresh(this.identityByUid.get(String(uid))) : null;
    const byFace = face ? fresh(this.identityByFace.get(cleanFaceUrl(face))) : null;
    const resolved = byUid || byFace;
    const finalName = masked && resolved?.userName ? resolved.userName : inputName;
    const finalMasked = isMaskedName(finalName);

    return {
      userName: finalName,
      displayUserName: finalMasked ? "新来的朋友" : finalName,
      isMaskedName: finalMasked,
      identityResolved: masked && Boolean(resolved?.userName),
    };
  }
}

module.exports = {
  BilibiliLiveClient,
  extractRoomId,
  resolveRoom,
  getDanmuConf,
  mapLiveStatus,
  parseOnlineRankV2,
  parseOnlineRankV3,
};
