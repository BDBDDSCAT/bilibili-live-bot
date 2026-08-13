"use strict";

const fs = require("node:fs");
const path = require("node:path");

// 所有键的安全默认值：不发送、不点赞、不接管浏览器。
// 用户真实配置（config.json）在这份默认值之上做深合并，缺什么键都不会崩。
const DEFAULT_CONFIG = {
  room: "",
  dryRun: true,
  speakEndpoint: "",
  send: {
    enabled: false,
    maxChars: 40,
    cooldownSec: 8,
  },
  showAllEvents: false,
  connection: {
    autoStartSafe: true,
    fanoutHosts: 1,
  },
  browserAutomation: {
    enabled: false,
    roomUrl: "",
    profileDir: "state/browser-profile",
    chromeExecutable: "",
    headless: false,
    loginPollMs: 1500,
    autoLike: {
      enabled: false,
      onlyWhenLive: true,
      initialDelayMinSec: 2,
      initialDelayMaxSec: 5,
      intervalMinSec: 0.85,
      intervalMaxSec: 1.15,
      burstMinClicks: 10,
      burstMaxClicks: 50,
      sessionTargetMinClicks: 10000,
      sessionTargetMaxClicks: 20000,
    },
  },
  modules: {
    autoSend: { enabled: false },
    autoLike: { enabled: false },
    welcome: { enabled: true },
    giftThanks: { enabled: true, minCoin: 0 },
    pk: { enabled: true },
    rotation: { enabled: true },
    ai: { enabled: true },
    spam: { enabled: true },
    guardBoard: { enabled: true },
    history: { enabled: true },
  },
  roles: {
    anchorNames: [],
    anchorIds: [],
    adminNames: [],
    adminIds: [],
    botNames: [],
    assistantUids: [],
  },
  automation: {
    enabled: true,
    autoSendTypes: [
      "reply",
      "command_reply",
      "gift_report",
      "pk_report",
      "pk_multi_report",
      "pk_info",
      "timer",
      "spam",
    ],
    pauseWelcomeDuringLottery: true,
    pauseGiftDuringLottery: true,
    queueLimit: 80,
    humanTiming: {
      enabled: true,
      actionDelayMinMs: 500,
      actionDelayMaxMs: 1800,
      sendGapMinSec: 2,
      sendGapMaxSec: 5,
    },
    startupMessage: {
      enabled: false,
      text: "机器人已上线，陪大家一起看直播～",
    },
  },
  localAi: {
    enabled: false,
    provider: "ollama",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen3.5:4b",
    autoStart: true,
    startupTimeoutMs: 15000,
    localOnly: true,
    timeoutMs: 20000,
    numCtx: 8192,
    maxChars: 36,
    temperature: 0.4,
    think: false,
    numPredict: 80,
    keepAlive: "30m",
    viewerReplyCooldownMs: 1500,
    fallbackToRules: false,
    allViewerChats: true,
    proactive: {
      enabled: false,
      onlyWhenLive: true,
      initialMinSec: 45,
      initialMaxSec: 90,
      intervalMinSec: 90,
      intervalMaxSec: 180,
      silenceMinSec: 30,
    },
  },
  weather: {
    enabled: true,
    timeoutMs: 7000,
    language: "zh",
  },
  history: {
    enabled: true,
    dir: "state",
    restoreGiftStatsOnStart: true,
    persistKinds: [
      "chat",
      "enter",
      "follow",
      "share",
      "gift",
      "superChat",
      "guard",
      "like",
      "online",
      "onlineRank",
      "watched",
      "pk",
      "notice",
      "event",
      "audit",
    ],
    rawAudit: {
      enabled: true,
    },
  },
  retention: {
    enabled: true,
    rawDays: 60,
    eventsDays: 180,
    logsDays: 14,
    auditsDays: 90,
    observationsDays: 30,
    overlaysKeep: 24,
  },
  screenshots: {
    enabled: false,
    dir: "screenshots",
    regions: [],
    triggers: {
      gift: { enabled: false, minCoin: 0, delayMs: 1200 },
      superChat: { enabled: false, minCoin: 0, delayMs: 1200 },
      guard: { enabled: false, minCoin: 0, delayMs: 1200 },
      manual: { enabled: false, delayMs: 0 },
    },
  },
  points: {
    enabled: true,
    signInPoints: 10,
    giftPointsPerBattery: 1,
    guardPoints: { 1: 20000, 2: 2000, 3: 300 },
    signInStreak: {
      enabled: true,
      bonusPerDay: 2,
      maxBonus: 20,
      milestones: { 7: 20, 30: 100 },
    },
    shopItems: [
      { id: "song", name: "点歌一次", cost: 30, description: "主播方便时安排" },
      { id: "title", name: "弹幕称号", cost: 80, description: "主播人工确认后生效" },
      { id: "snapshot", name: "礼物长图点名", cost: 120, description: "生成礼物图时优先展示" },
    ],
  },
  commands: {
    prefixes: ["#", "@"],
    allowPublicGiftQuery: true,
    allowPublicPkQuery: true,
    drawLots: [
      "上上签，今天适合留在直播间。",
      "吉签，好运在路上。",
      "小吉签，弹幕多说两句会更顺。",
      "平签，稳住就赢。",
      "小凶签，今天少冲动，多喝水。",
    ],
  },
  rateLimit: {
    globalSendCooldownSec: 8,
    spamCooldownSec: 120,
  },
  ignoreUsers: [],
  ignoreNameIncludes: ["小助理", "助理", "助手", "机器人", "管家"],
  maxRepliesPerMessage: 1,
  blocklist: ["加微信", "私信返利", "刷单"],
  rules: [],
  interactions: {
    ignoreUsers: [],
    ignoreNameIncludes: ["小助理", "助理", "助手", "机器人", "管家"],
    welcome: {
      enabled: true,
      requireFullName: true,
      maskedResolveDelayMs: 5000,
      cooldownSec: 4,
      userCooldownSec: 300,
      guardIgnoresBlacklist: true,
      blacklist: [],
      blacklistIncludes: [],
      specificTemplates: {},
      guardTemplates: {
        舰长: "欢迎舰长『{user}』上船回家",
        提督: "欢迎提督『{user}』，排面拉满",
      },
      idleReminderUserCooldownSec: 1800,
      idleRemindersRequireWelcome: true,
      idleReminders: [],
      highWealth: { enabled: false, minLevel: 20, templates: [] },
      timeBuckets: [],
      templates: [
        "欢迎『{user}』来玩",
        "欢迎{user}，今天也来啦",
        "{user}来了，找个舒服的位置坐",
        "欢迎{user}，有问题直接发弹幕",
      ],
    },
    gift: {
      enabled: true,
      cooldownSec: 3,
      userCooldownSec: 8,
      aggregateWindowMs: 3000,
      bigThanksMinCoin: 50000,
      dedupeFingerprintWindowMs: 300,
      minBattery: 0,
      blindTemplates: [
        "感谢{user}投喂{sourceGiftName}，爆出{giftName}x{count}",
        "{user}这发{sourceGiftName}开出{giftName}x{count}，已记账",
      ],
      templates: [
        "感谢{user}的{giftName}~",
        "谢谢{user}投喂{giftName}x{count}",
        "{user}的{giftName}收到啦，感谢支持",
      ],
    },
    superChat: {
      enabled: true,
      templates: ["感谢{user}的醒目留言：{message}", "{user}的SC收到，主播一定能看到"],
    },
    guard: {
      enabled: true,
      templates: ["感谢{user}上船，排面拉满", "{user}的大航海收到，主播快看"],
    },
    follow: {
      enabled: true,
      cooldownSec: 10,
      userCooldownSec: 600,
      templates: ["感谢{user}的关注，欢迎常来玩", "{user}关注收到，开播不迷路"],
    },
    share: {
      enabled: true,
      cooldownSec: 15,
      userCooldownSec: 600,
      templates: ["感谢{user}分享直播间", "{user}帮忙分享啦，感谢支持"],
    },
    live: { entryMsg: "", goodbyeInfo: "" },
    moderation: {
      showBlockMsg: false,
      blockTemplate: "{user} 被禁言了，大家注意直播间秩序。",
      keywordAlert: true,
      keywordAlertTemplate: "{user} 的弹幕命中巡场词，建议房管确认。",
    },
    like: {
      enabled: false,
      minCount: 20,
      cooldownSec: 45,
      templates: ["谢谢{user}的点赞x{likeCount}", "点赞收到，感谢{user}"],
    },
  },
  pk: {
    showRawEvents: false,
    minReportIntervalSec: 10,
    investigator: {
      enabled: true,
      cacheMs: 30000,
    },
  },
  timers: [],
};

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? clone(base) : clone(patch);
  const result = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = clone(value);
    }
  }
  return result;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function detectChromeExecutable(preferred = "") {
  const candidates = preferred ? [preferred, ...CHROME_CANDIDATES] : CHROME_CANDIDATES;
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // 探测失败继续下一个候选。
    }
  }
  return "";
}

function pushNumberError(errors, config, keyPath, { min, max, integer = false } = {}) {
  const parts = keyPath.split(".");
  let value = config;
  for (const part of parts) {
    if (!isPlainObject(value)) return;
    value = value[part];
  }
  if (value === undefined || value === null) return;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    errors.push(`${keyPath} 必须是数字，当前是 ${JSON.stringify(value)}`);
    return;
  }
  if (integer && !Number.isInteger(numberValue)) {
    errors.push(`${keyPath} 必须是整数，当前是 ${numberValue}`);
  }
  if (min !== undefined && numberValue < min) {
    errors.push(`${keyPath} 不能小于 ${min}，当前是 ${numberValue}`);
  }
  if (max !== undefined && numberValue > max) {
    errors.push(`${keyPath} 不能大于 ${max}，当前是 ${numberValue}`);
  }
}

function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (config.room !== undefined && config.room !== "" && typeof config.room !== "string" && typeof config.room !== "number") {
    errors.push("room 必须是直播间 URL 字符串或房间号");
  }
  for (const listKey of ["ignoreUsers", "blocklist", "rules", "timers"]) {
    if (config[listKey] !== undefined && !Array.isArray(config[listKey])) {
      errors.push(`${listKey} 必须是数组`);
    }
  }
  pushNumberError(errors, config, "send.maxChars", { min: 1, max: 100, integer: true });
  pushNumberError(errors, config, "send.cooldownSec", { min: 0, max: 600 });
  pushNumberError(errors, config, "connection.fanoutHosts", { min: 1, max: 4, integer: true });
  pushNumberError(errors, config, "automation.queueLimit", { min: 1, max: 1000, integer: true });
  pushNumberError(errors, config, "localAi.timeoutMs", { min: 1000, max: 300000 });
  pushNumberError(errors, config, "localAi.startupTimeoutMs", { min: 1000, max: 60000, integer: true });
  pushNumberError(errors, config, "localAi.numCtx", { min: 512, max: 262144, integer: true });
  pushNumberError(errors, config, "retention.rawDays", { min: 1, integer: true });
  pushNumberError(errors, config, "retention.eventsDays", { min: 1, integer: true });
  pushNumberError(errors, config, "retention.logsDays", { min: 1, integer: true });
  pushNumberError(errors, config, "retention.overlaysKeep", { min: 1, integer: true });

  const autoLike = config.browserAutomation?.autoLike || {};
  if (autoLike.onlyWhenLive !== undefined && typeof autoLike.onlyWhenLive !== "boolean") {
    errors.push("browserAutomation.autoLike.onlyWhenLive 必须是布尔值");
  }
  if (autoLike.enabled === true) {
    pushNumberError(errors, config, "browserAutomation.autoLike.burstMinClicks", { min: 1, integer: true });
    pushNumberError(errors, config, "browserAutomation.autoLike.burstMaxClicks", { min: 1, integer: true });
    pushNumberError(errors, config, "browserAutomation.autoLike.sessionTargetMaxClicks", { min: 1, integer: true });
  }

  if (config.browserAutomation?.enabled === true && !config.room && !config.browserAutomation?.roomUrl) {
    warnings.push("browserAutomation 已开启但没有配置 room/roomUrl，启动后需要在网页里填直播间");
  }
  if (config.localAi?.enabled === true && !config.localAi?.model) {
    errors.push("localAi.enabled=true 时必须配置 localAi.model");
  }
  if (
    config.localAi?.proactive?.onlyWhenLive !== undefined &&
    typeof config.localAi.proactive.onlyWhenLive !== "boolean"
  ) {
    errors.push("localAi.proactive.onlyWhenLive 必须是布尔值");
  }
  return { errors, warnings };
}

function resolveConfigPath({ configPath, rootDir }) {
  if (configPath) {
    const resolved = path.resolve(process.cwd(), configPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`--config 指定的配置文件不存在：${resolved}`);
    }
    return { resolved, source: "explicit" };
  }
  const candidates = [
    { file: path.resolve(rootDir, "config.json"), source: "config.json" },
    { file: path.resolve(rootDir, "config.local.json"), source: "config.local.json" },
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate.file)) return { resolved: candidate.file, source: candidate.source };
  }
  const legacy = path.resolve(rootDir, "config.example.json");
  if (fs.existsSync(legacy)) {
    return { resolved: legacy, source: "example-fallback" };
  }
  throw new Error(
    `找不到配置文件。请在项目目录执行 npm run setup 生成 config.json（会从 config.example.json 复制模板），或用 --config 指定路径。查找过：${candidates
      .map((item) => item.file)
      .join("、")}`
  );
}

function loadConfig({ configPath = "", rootDir, logger = null } = {}) {
  const root = rootDir || path.resolve(__dirname, "..");
  const { resolved, source } = resolveConfigPath({ configPath, rootDir: root });
  let userConfig;
  try {
    userConfig = JSON.parse(fs.readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`配置文件 ${resolved} 解析失败：${error.message}。请检查 JSON 语法，或从最近一次备份恢复。`);
  }
  if (!isPlainObject(userConfig)) {
    throw new Error(`配置文件 ${resolved} 的顶层必须是 JSON 对象`);
  }
  const merged = deepMerge(DEFAULT_CONFIG, userConfig);
  const { errors, warnings } = validateConfig(merged);
  if (errors.length) {
    throw new Error(`配置文件 ${resolved} 有 ${errors.length} 处错误：\n- ${errors.join("\n- ")}`);
  }
  const warn = (message) => {
    if (logger?.warn) logger.warn("config", message);
    else console.warn(`[config] ${message}`);
  };
  for (const message of warnings) warn(message);
  if (source === "example-fallback") {
    warn("正在用 config.example.json 兜底运行。请执行 npm run setup 生成正式的 config.json，模板文件不应承载真实配置。");
  }
  if (merged.browserAutomation?.enabled === true) {
    const detected = detectChromeExecutable(merged.browserAutomation.chromeExecutable);
    if (!detected) {
      warn("没有找到可用的 Chrome/Chromium 浏览器，浏览器托管（自动发弹幕/点赞）将无法启动");
    } else if (detected !== merged.browserAutomation.chromeExecutable) {
      merged.browserAutomation.chromeExecutable = detected;
      warn(`browserAutomation.chromeExecutable 自动探测为 ${detected}`);
    }
  }
  merged.__path = resolved;
  merged.__source = source;
  return merged;
}

module.exports = {
  DEFAULT_CONFIG,
  deepMerge,
  detectChromeExecutable,
  loadConfig,
  resolveConfigPath,
  validateConfig,
};
