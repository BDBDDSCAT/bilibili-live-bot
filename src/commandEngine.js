"use strict";

const { normalizeText } = require("./ruleEngine");

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function lastDayOfMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function currentMonthRange(monthNumber) {
  const now = new Date();
  const month = Number(monthNumber || now.getMonth() + 1);
  const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
  return `${year}-${String(month).padStart(2, "0")}`;
}

function dateRangeFromDay(dayNumber) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = Math.min(Math.max(1, Number(dayNumber)), lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function dateRangeFromMonthDay(monthNumber, dayNumber) {
  const now = new Date();
  const month = Math.min(12, Math.max(1, Number(monthNumber)));
  const year = month > now.getMonth() + 1 ? now.getFullYear() - 1 : now.getFullYear();
  const day = Math.min(Math.max(1, Number(dayNumber)), lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function stripBotMention(text = "") {
  return String(text || "")
    .trim()
    .replace(/^@[^\s:：,，]{1,24}[\s:：,，]+/, "")
    .trim();
}

function parseHistoryRangeText(text = "") {
  const value = String(text || "");
  const monthDayMatch = value.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/);
  if (monthDayMatch) {
    return {
      range: dateRangeFromMonthDay(monthDayMatch[1], monthDayMatch[2]),
      label: `${Number(monthDayMatch[1])}月${Number(monthDayMatch[2])}日`,
    };
  }

  const dayMatch = value.match(/(?:^|[^\d月])(\d{1,2})\s*(?:日|号)/);
  if (dayMatch) {
    return {
      range: dateRangeFromDay(dayMatch[1]),
      label: `${Number(dayMatch[1])}日`,
    };
  }

  const monthMatch = value.match(/(?:^|[^\d])(\d{1,2})\s*月/);
  if (monthMatch) {
    return {
      range: currentMonthRange(monthMatch[1]),
      label: `${Number(monthMatch[1])}月`,
    };
  }

  if (/昨日|昨天/.test(value)) return { range: "yesterday", label: "昨日" };
  if (/本周|这周|近7天|七天/.test(value)) return { range: "week", label: "本周" };
  if (/本月|这个月/.test(value)) return { range: "month", label: "本月" };
  return { range: "today", label: "今日" };
}

function extractGiftKeyword(text = "") {
  return String(text || "")
    .replace(/^我的/, "")
    .replace(/(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)/g, "")
    .replace(/(?:^|[^\d月])(\d{1,2})\s*(?:日|号)/g, "")
    .replace(/(?:^|[^\d])(\d{1,2})\s*月/g, "")
    .replace(/今日|今天|昨日|昨天|本周|这周|近7天|七天|本月|这个月/g, "")
    .replace(/礼物|统计|查询|查一下|查|截图|长图|我的|全场|全房|本房|房间/g, "")
    .replace(/盲盒/g, "")
    .replace(/[，,。！？!?\s]/g, "")
    .trim();
}

function isGiftHistoryQuery(text = "") {
  const value = String(text || "");
  const hasGiftSignal = /礼物|盲盒|人气票|掉头|电池/.test(value);
  const hasQuerySignal =
    /^我的/.test(value) ||
    /今日|今天|昨日|昨天|本周|这周|近7天|七天|本月|这个月|统计|查询|查一下/.test(value) ||
    /\d{1,2}\s*月|\d{1,2}\s*(?:日|号)/.test(value);
  return hasGiftSignal && hasQuerySignal;
}

function commandReply(reply, ruleName = "command", priority = 120) {
  return {
    type: "command_reply",
    ruleName,
    reply,
    emotion: "calm",
    priority,
  };
}

function moduleReply(moduleName, enabled) {
  return commandReply(
    `${moduleName} 已${enabled ? "开启" : "关闭"}`,
    "module_toggle",
    140
  );
}

class CommandEngine {
  constructor(config = {}) {
    this.config = config;
    this.roles = config.roles || {};
    this.aiEnabled = config.modules?.ai?.enabled !== false;
    this.game = {
      active: false,
      players: [],
      votes: new Map(),
      locked: false,
      civilianWord: "",
      undercoverWord: "",
      undercover: "",
    };
    this.lastSpamAt = 0;
  }

  isPrivileged(event = {}, roomInfo = {}) {
    const userId = String(event.userId || "");
    const adminIds = toArray(this.roles.adminIds).map(String).filter(Boolean);
    const anchorIds = toArray(this.roles.anchorIds).map(String).filter(Boolean);
    const roomAnchorId = String(roomInfo?.uid || "");
    if (userId && userId !== "0") {
      if (adminIds.includes(userId) || anchorIds.includes(userId)) return true;
      if (roomAnchorId && roomAnchorId !== "0" && userId === roomAnchorId) return true;
    }
    // 昵称白名单按"对应列表"降级：配了 adminIds 只压制 adminNames，配了 anchorIds 只压制
    // anchorNames 与房主昵称兜底。B 站 web 弹幕 uid 普遍脱敏为 0，全局压制会让主播失权。
    const userName = normalizeText(event.displayUserName || event.userName);
    if (!userName) return false;
    const adminNames = toArray(this.roles.adminNames || this.roles.admins).map(normalizeText);
    const anchorNames = toArray(this.roles.anchorNames).map(normalizeText);
    const roomAnchor = normalizeText(roomInfo?.uname || "");
    if (!adminIds.length && adminNames.includes(userName)) return true;
    if (!anchorIds.length && (anchorNames.includes(userName) || (Boolean(roomAnchor) && userName === roomAnchor))) {
      return true;
    }
    return false;
  }

  handleChat(event = {}, context = {}) {
    const text = stripBotMention(event.text);
    if (!text) return { handled: false, actions: [], moduleUpdates: [] };

    const result = {
      handled: false,
      actions: [],
      moduleUpdates: [],
    };
    const privileged = this.isPrivileged(event, context.roomInfo);

    if (/^(@?帮助|#?帮助|help)$/i.test(text)) {
      result.handled = true;
      result.actions.push(
        commandReply(
          "可用命令：签到、查询弹幕、抽签、我的积分、积分榜、积分商城、兑换 商品名、截图今日礼物、我的今日礼物、3月盲盒、掉舰榜、pk情况、@我是谁、#hey 问题。主播可用 弹幕活跃/#礼物关闭/#pk关闭。",
          "help",
          130
        )
      );
      return result;
    }

    if (/^@?我是谁$/.test(text)) {
      result.handled = true;
      const name = firstString(event.displayUserName, event.userName, "这位朋友");
      const medal = event.medalName
        ? `，粉丝牌 ${event.medalName}${event.medalLevel || ""}`
        : "";
      const guard = event.guardName ? `，${event.guardName}` : "";
      result.actions.push(commandReply(`你是 ${name}${medal}${guard}。`, "whoami", 120));
      return result;
    }

    if (/^(签到|打卡)$/.test(text)) {
      result.handled = true;
      result.actions.push(context.points?.signIn(event, context.roomInfo) || commandReply("积分系统未启用。", "points"));
      return result;
    }

    if (/^查询弹幕$/.test(text)) {
      result.handled = true;
      result.actions.push(this.createDanmuCountReply(event, context.history, context.roomInfo));
      return result;
    }

    const danmuSummaryMatch = text.match(/^#?\s*(弹幕活跃|弹幕榜|热词|今日弹幕|全房弹幕)(?:\s*(\d{1,2})\s*天?)?$/);
    if (danmuSummaryMatch) {
      result.handled = true;
      if (!privileged) {
        result.actions.push(commandReply("全房弹幕复盘主播/管理员可用；观众可以发 查询弹幕 看自己的记录。", "danmu_summary", 115));
        return result;
      }
      result.actions.push(
        this.createDanmuSummaryReply(context.history, context.roomInfo, danmuSummaryMatch[2] || 3)
      );
      return result;
    }

    if (/^抽签$/.test(text)) {
      result.handled = true;
      result.actions.push(this.createDrawLotReply(event));
      return result;
    }

    if (/^(我的)?积分$|^查积分$|^积分查询$/.test(text)) {
      result.handled = true;
      result.actions.push(
        context.points?.createBalanceAction(event, context.roomInfo) || commandReply("积分系统未启用。", "points")
      );
      return result;
    }

    if (/^(积分榜|积分排行|本月积分榜)$/.test(text)) {
      result.handled = true;
      result.actions.push(
        context.points?.createLeaderboardAction(context.roomInfo) || commandReply("积分系统未启用。", "points")
      );
      return result;
    }

    if (/^(积分商城|商城|兑换列表)$/.test(text)) {
      result.handled = true;
      result.actions.push(context.points?.createShopAction() || commandReply("积分商城未启用。", "points_shop"));
      return result;
    }

    if (/^兑换\s*.+/.test(text)) {
      result.handled = true;
      result.actions.push(
        context.points?.createRedeemAction(text, event, context.roomInfo) ||
          commandReply("积分商城未启用。", "points_shop")
      );
      return result;
    }

    const moduleToggle = this.parseModuleToggle(text, privileged);
    if (moduleToggle) {
      result.handled = true;
      result.moduleUpdates.push(moduleToggle);
      result.actions.push(moduleReply(moduleToggle.label, moduleToggle.enabled));
      if (moduleToggle.name === "ai") this.aiEnabled = moduleToggle.enabled;
      return result;
    }

    const spam = this.parseSpam(text, privileged, context.moduleStatus);
    if (spam) {
      result.handled = true;
      result.actions.push(...spam);
      return result;
    }

    const gameActions = this.handleGame(text, event, privileged);
    if (gameActions.length) {
      result.handled = true;
      result.actions.push(...gameActions);
      return result;
    }

    if (/^#?hey\b/i.test(text) || /^#?ai[\s:：]/i.test(text)) {
      result.handled = true;
      const aiEnabled = context.moduleStatus?.ai
        ? context.moduleStatus.ai.enabled !== false
        : this.aiEnabled;
      if (!aiEnabled) {
        result.actions.push(commandReply("AI互动当前关闭，可由主播重新开启。", "ai"));
        return result;
      }
      const question = text.replace(/^#?(hey|ai)[\s:：]*/i, "").trim();
      if (!question) {
        result.actions.push(commandReply("想问什么可以发 #hey 加问题。", "ai"));
        return result;
      }
      result.actions.push({
        type: "local_ai_query",
        text: question,
        user: firstString(event.displayUserName, event.userName),
        userId: event.userId || 0,
      });
      return result;
    }

    if (/截图.*礼物|礼物.*截图|礼物长图/.test(text)) {
      result.handled = true;
      const rangeInfo = parseHistoryRangeText(text);
      const reportAction = context.interactions?.createGiftReportAction?.({
        range: rangeInfo.range,
        label: rangeInfo.label,
      });
      result.actions.push(reportAction || commandReply("礼物统计还没就绪，稍后再试。", "gift_report"));
      return result;
    }

    const guardQuery = this.parseGuardQuery(text, event, context.history, context.roomInfo);
    if (guardQuery) {
      result.handled = true;
      result.actions.push(guardQuery);
      return result;
    }

    const giftQuery = this.parseGiftQuery(text, event, context.history, context.roomInfo, privileged);
    if (giftQuery) {
      result.handled = true;
      result.actions.push(giftQuery);
      return result;
    }

    if (/掉舰榜|舰长榜|大航海榜/.test(text)) {
      result.handled = true;
      const board = context.guardBoard || context.history?.queryGuards?.({ range: "month" });
      const rows = (board?.expiring?.length ? board.expiring : board?.rows || []).slice(0, 5);
      const summary = rows.length
        ? rows
            .map((item, index) => {
              const days = item.daysLeft === null ? "未知" : item.daysLeft < 0 ? "已掉" : `${item.daysLeft}天`;
              return `${index + 1}.${item.userName} ${item.guardName || item.guardLevel || ""} ${days}`;
            })
            .join("；")
        : "暂无掉舰记录";
      result.actions.push(commandReply(`掉舰榜：${summary}`, "guard_board", 120));
      return result;
    }

    if (/^(?:pk|PK)(?:情况|比分)$|对面大哥|对面榜一|pk多少了|PK多少了/.test(text)) {
      result.handled = true;
      if (context.moduleStatus?.pk?.enabled === false) {
        result.actions.push(commandReply("PK播报当前关闭，可由主播发 #pk开启。", "pk_report"));
        return result;
      }
      const pkAction = context.pkTracker?.createReportAction?.("pk_report");
      result.actions.push(pkAction || commandReply("PK模块还没就绪，稍后再试。", "pk_report"));
      return result;
    }

    return result;
  }

  getCatalog(moduleStatus = {}) {
    const enabled = (name) => moduleStatus?.[name]?.enabled !== false;
    return [
      {
        group: "观众互动",
        commands: [
          { command: "帮助", role: "观众", module: "commands", enabled: true, description: "查看直播间可用命令" },
          { command: "@我是谁", role: "观众", module: "identity", enabled: true, description: "检查昵称、粉丝牌、大航海识别是否正确" },
          { command: "签到", role: "观众", module: "points", enabled: true, description: "每日签到领取积分" },
          { command: "我的积分", role: "观众", module: "points", enabled: true, description: "查询本月积分" },
          { command: "积分榜", role: "观众", module: "points", enabled: true, description: "查看本月积分排行" },
          { command: "积分商城", role: "观众", module: "points", enabled: true, description: "查看可兑换商品" },
          { command: "兑换 商品名", example: "兑换 点歌一次", role: "观众", module: "points", enabled: true, description: "登记兑换，进入主播待处理列表" },
          { command: "抽签", role: "观众", module: "commands", enabled: true, description: "抽一条配置里的签文" },
        ],
      },
      {
        group: "礼物/历史",
        commands: [
          { command: "截图今日礼物", role: "观众", module: "giftThanks", enabled: enabled("giftThanks"), description: "生成今日礼物长图" },
          { command: "我的今日礼物", role: "观众", module: "giftThanks", enabled: enabled("giftThanks"), description: "查询自己今天送礼统计" },
          { command: "我的昨日盲盒", role: "观众", module: "giftThanks", enabled: enabled("giftThanks"), description: "查询历史盲盒统计" },
          { command: "3月盲盒 / 25日盲盒", example: "我的3月盲盒", role: "观众", module: "giftThanks", enabled: enabled("giftThanks"), description: "按月份或日期查询礼物历史" },
          { command: "查询弹幕", role: "观众", module: "history", enabled: true, description: "查询自己的近几日弹幕计数" },
          { command: "弹幕活跃 / 弹幕榜 / 热词", example: "弹幕活跃 3天", role: "主播", module: "history", enabled: true, description: "全房弹幕活跃、观众榜和热词复盘" },
        ],
      },
      {
        group: "PK/大航海",
        commands: [
          { command: "pk情况", role: "观众", module: "pk", enabled: enabled("pk"), description: "查看比分、对手、大哥和贡献榜摘要" },
          { command: "对面大哥", role: "观众", module: "pk", enabled: enabled("pk"), description: "查看对面贡献榜/榜一信息" },
          { command: "掉舰榜", role: "观众", module: "guardBoard", enabled: enabled("guardBoard"), description: "查询即将到期的大航海" },
          { command: "舰长榜", role: "观众", module: "guardBoard", enabled: enabled("guardBoard"), description: "查看当前记录的大航海榜" },
        ],
      },
      {
        group: "脚本回复/小游戏",
        commands: [
          { command: "#hey 问题", example: "#hey 今晚播什么", role: "观众", module: "ai", enabled: enabled("ai"), description: "本地 Qwen 娱乐陪聊，普通弹幕也会自动互动" },
          { command: "#卧底开始", role: "观众", module: "game", enabled: true, description: "开一局谁是卧底" },
          { command: "加入卧底", role: "观众", module: "game", enabled: true, description: "加入当前卧底局" },
          { command: "#卧底发词 平民词 卧底词", example: "#卧底发词 苹果 梨", role: "主播", module: "game", enabled: true, description: "锁定玩家并记录词语；公屏发词全员可见，建议走后台" },
          { command: "投票 昵称", example: "投票 小明", role: "观众", module: "game", enabled: true, description: "给谁是卧底投票" },
          { command: "卧底票数", role: "观众", module: "game", enabled: true, description: "查看当前投票排行" },
          { command: "#卧底公布", role: "主播", module: "game", enabled: true, description: "公布卧底和词语" },
          { command: "#卧底结束", role: "主播", module: "game", enabled: true, description: "结束谁是卧底" },
        ],
      },
      {
        group: "主播权限",
        commands: [
          { command: "#弹幕开启 / #弹幕关闭", example: "#弹幕关闭", role: "主播", module: "autoSend", enabled: enabled("autoSend"), description: "切换自动发送总开关" },
          { command: "#欢迎开启 / #欢迎关闭", example: "#欢迎关闭", role: "主播", module: "welcome", enabled: enabled("welcome"), description: "切换进房欢迎" },
          { command: "#礼物开启 / #礼物关闭", example: "#礼物关闭", role: "主播", module: "giftThanks", enabled: enabled("giftThanks"), description: "切换礼物感谢" },
          { command: "#pk开启 / #pk关闭", example: "#pk关闭", role: "主播", module: "pk", enabled: enabled("pk"), description: "切换 PK 侦查" },
          { command: "#ai开启 / #ai关闭", example: "#ai关闭", role: "主播", module: "ai", enabled: enabled("ai"), description: "切换AI互动" },
          { command: "#轮播开启 / #轮播关闭", example: "#轮播关闭", role: "主播", module: "rotation", enabled: enabled("rotation"), description: "切换轮播弹幕" },
          { command: "#刷屏 表情 3", example: "#刷屏 哈哈 3", role: "主播", module: "spam", enabled: enabled("spam"), description: "限频刷表情，最多 10 条" },
        ],
      },
    ];
  }

  getState() {
    const voteCounts = new Map();
    for (const target of this.game.votes?.values?.() || []) {
      voteCounts.set(target, (voteCounts.get(target) || 0) + 1);
    }
    return {
      aiEnabled: this.aiEnabled,
      spamCooldownSec: Number(this.config.rateLimit?.spamCooldownSec || 0),
      spamLastAt: Number(this.lastSpamAt || 0),
      game: {
        active: Boolean(this.game.active),
        locked: Boolean(this.game.locked),
        playerCount: this.game.players.length,
        players: this.game.players.slice(0, 12),
        voteCount: this.game.votes?.size || 0,
        topVotes: [...voteCounts.entries()]
          .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hans-CN"))
          .slice(0, 5)
          .map(([name, count]) => ({ name, count })),
      },
    };
  }

  parseModuleToggle(text, privileged) {
    if (!privileged) return null;
    const originalWelcome = text.match(/^(关闭|开启|打开)\s*欢迎弹幕$/);
    const match =
      originalWelcome ||
      text.match(/^#?\s*(弹幕|自动发言|ai|AI|欢迎|礼物|pk|PK|轮播|刷屏)\s*(开启|打开|关闭|暂停)$/);
    if (!match) return null;
    const rawName = originalWelcome ? "欢迎" : match[1].toLowerCase();
    const enabled = originalWelcome
      ? match[1] === "开启" || match[1] === "打开"
      : match[2] === "开启" || match[2] === "打开";
    const mapping = {
      "弹幕": ["autoSend", "自动发言"],
      "自动发言": ["autoSend", "自动发言"],
      "ai": ["ai", "AI聊天"],
      "欢迎": ["welcome", "进房欢迎"],
      "礼物": ["giftThanks", "礼物感谢"],
      "pk": ["pk", "PK侦查"],
      "轮播": ["rotation", "轮播弹幕"],
      "刷屏": ["spam", "刷屏"],
    };
    const [name, label] = mapping[rawName] || [];
    if (!name) return null;
    return { name, label, enabled };
  }

  parseSpam(text, privileged, moduleStatus = null) {
    if (!privileged) return null;
    const match = text.match(/^#?\s*刷屏\s+(.{1,12}?)(?:\s+(\d{1,2}))?$/);
    if (!match) return null;
    if (moduleStatus?.spam?.enabled === false) {
      return [commandReply("刷屏功能当前关闭，可发 #刷屏开启 重新打开。", "spam", 100)];
    }
    const phrase = match[1].trim();
    const count = Math.max(1, Math.min(10, Number(match[2] || 5)));
    const cooldownSec = Number(this.config.rateLimit?.spamCooldownSec || 0);
    const now = Date.now();
    if (cooldownSec > 0 && this.lastSpamAt && now - this.lastSpamAt < cooldownSec * 1000) {
      return [
        commandReply(
          `刷屏冷却中，还剩 ${Math.ceil((cooldownSec * 1000 - (now - this.lastSpamAt)) / 1000)} 秒。`,
          "spam",
          100
        ),
      ];
    }
    this.lastSpamAt = now;
    return Array.from({ length: count }, (_, index) => ({
      type: "spam",
      ruleName: "spam",
      reply: phrase,
      emotion: "excited",
      priority: 80 - index,
    }));
  }

  handleGame(text, event, privileged) {
    const actions = [];
    if (/谁是卧底.*(开始|开局)|#卧底开始/.test(text)) {
      if (this.game.active && this.game.locked && !privileged) {
        actions.push(commandReply("当前对局进行中，等主播公布或结束后再开新局。", "undercover", 100));
        return actions;
      }
      this.game = {
        active: true,
        players: [],
        votes: new Map(),
        locked: false,
        civilianWord: "",
        undercoverWord: "",
        undercover: "",
      };
      actions.push(commandReply("谁是卧底开局啦，想玩的发：加入卧底。", "undercover", 110));
      return actions;
    }
    if (/^(?:加入卧底|卧底加入)$/.test(text)) {
      if (!this.game.active) return [];
      if (this.game.locked) {
        actions.push(commandReply("本局已经锁定玩家，等下一局再加入。", "undercover", 90));
        return actions;
      }
      const name = firstString(event.displayUserName, event.userName, "观众");
      if (!this.game.players.includes(name)) this.game.players.push(name);
      actions.push(commandReply(`${name} 已加入谁是卧底，目前 ${this.game.players.length} 人。`, "undercover", 90));
      return actions;
    }
    if (/^#?\s*卧底发词/.test(text)) {
      if (!privileged) {
        actions.push(commandReply("只有主播/管理员能发词，公屏发词会泄底，建议走后台。", "undercover", 100));
        return actions;
      }
      const wordMatch = text.match(/^#?\s*卧底发词\s+(.{1,16})\s+(.{1,16})$/);
      if (!wordMatch) {
        actions.push(commandReply("发词格式：#卧底发词 平民词 卧底词。", "undercover", 100));
        return actions;
      }
      if (!this.game.active) {
        actions.push(commandReply("还没有开局，先发 #卧底开始。", "undercover", 100));
        return actions;
      }
      if (this.game.players.length < 3) {
        actions.push(commandReply(`至少 3 人再发词，目前 ${this.game.players.length} 人。`, "undercover", 100));
        return actions;
      }
      const undercoverIndex = Math.floor(Math.random() * this.game.players.length);
      this.game.locked = true;
      this.game.civilianWord = wordMatch[1].trim();
      this.game.undercoverWord = wordMatch[2].trim();
      this.game.undercover = this.game.players[undercoverIndex];
      this.game.votes = new Map();
      actions.push(
        commandReply(
          `谁是卧底已锁定 ${this.game.players.length} 人，词语已记录（公屏发词全员可见，下次建议走后台）。公屏可开始描述，投票格式：投票 昵称。`,
          "undercover",
          110
        )
      );
      return actions;
    }
    if (/^卧底玩家$/.test(text)) {
      if (!this.game.active) return [];
      const players = this.game.players.join("、") || "暂无玩家";
      actions.push(commandReply(`本局玩家：${players}${this.game.locked ? "。已锁定" : "。未锁定"}`, "undercover", 90));
      return actions;
    }
    const voteMatch = text.match(/^投票\s*(.+)$/);
    if (voteMatch) {
      if (!this.game.active || !this.game.locked) return [];
      const voter = firstString(event.displayUserName, event.userName, "观众");
      const target = this.findUndercoverPlayer(voteMatch[1]);
      if (!target) {
        actions.push(commandReply(`没找到玩家 ${voteMatch[1].trim()}（重名请发全名），可发 卧底玩家 查看名单。`, "undercover", 80));
        return actions;
      }
      this.game.votes.set(voter, target);
      actions.push(commandReply(`${voter} 已投 ${target}，当前 ${this.game.votes.size} 票。`, "undercover", 80));
      return actions;
    }
    if (/^卧底票数$|^投票情况$/.test(text)) {
      if (!this.game.active || !this.game.locked) return [];
      actions.push(commandReply(`卧底票数：${this.undercoverVoteSummary()}`, "undercover", 90));
      return actions;
    }
    if (/^#?\s*卧底公布$/.test(text) && privileged) {
      if (!this.game.active || !this.game.locked) {
        actions.push(commandReply("本局还没锁定发词，无法公布。", "undercover", 100));
        return actions;
      }
      actions.push(
        commandReply(
          `公布：卧底是 ${this.game.undercover || "未知"}。平民词「${this.game.civilianWord || "未设置"}」，卧底词「${this.game.undercoverWord || "未设置"}」。票数：${this.undercoverVoteSummary()}`,
          "undercover",
          120
        )
      );
      return actions;
    }
    if (/卧底结束|#卧底结束/.test(text) && privileged) {
      const players = this.game.players.join("、") || "暂无玩家";
      this.game.active = false;
      this.game.locked = false;
      this.game.votes = new Map();
      actions.push(commandReply(`谁是卧底结束，本局玩家：${players}`, "undercover", 110));
      return actions;
    }
    return actions;
  }

  findUndercoverPlayer(input = "") {
    const keyword = normalizeText(input);
    if (!keyword) return "";
    const exact = this.game.players.find((name) => normalizeText(name) === keyword);
    if (exact) return exact;
    const fuzzy = this.game.players.filter((name) => normalizeText(name).includes(keyword));
    return fuzzy.length === 1 ? fuzzy[0] : "";
  }

  undercoverVoteSummary() {
    if (!this.game.votes?.size) return "暂无投票";
    const counts = new Map();
    for (const target of this.game.votes.values()) {
      counts.set(target, (counts.get(target) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-Hans-CN"))
      .map(([name, count]) => `${name}${count}票`)
      .join("，");
  }

  createDrawLotReply(event = {}) {
    const lots = toArray(
      this.config.commands?.drawLots ||
        this.config.drawLots ||
        this.config.DrawLotsList ||
        [
          "上上签，今天适合留在直播间。",
          "吉签，好运在路上。",
          "小吉签，弹幕多说两句会更顺。",
          "平签，稳住就赢。",
          "小凶签，今天少冲动，多喝水。",
        ]
    ).filter(Boolean);
    const name = firstString(event.displayUserName, event.userName, "这位朋友");
    const lot = lots[Math.floor(Math.random() * lots.length)] || "吉签";
    return commandReply(`${name}抽到：${lot}`, "draw_lot", 110);
  }

  createDanmuCountReply(event = {}, history, roomInfo = {}) {
    if (!history?.queryChatCounts) return commandReply("弹幕计数还没有开启。", "danmu_count");
    const summary = history.queryChatCounts({
      userName: firstString(event.displayUserName, event.userName),
      userId: event.userId,
      roomId: roomInfo.roomId,
      daysBack: 3,
    });
    const rows = summary.rows || [];
    const text = rows
      .map((row, index) => {
        const label = index === 0 ? "今日" : index === 1 ? "昨日" : "前日";
        return `${label}${row.count}条`;
      })
      .join("，");
    return commandReply(`${summary.userName || "你"}的弹幕：${text || "暂无记录"}。`, "danmu_count", 115);
  }

  createDanmuSummaryReply(history, roomInfo = {}, daysBack = 3) {
    if (!history?.queryChatSummary) return commandReply("弹幕活跃分析还没有开启。", "danmu_summary");
    const days = Math.max(1, Math.min(31, Number(daysBack || 3)));
    const summary = history.queryChatSummary({
      roomId: roomInfo.roomId,
      daysBack: days,
    });
    const users = (summary.topUsers || [])
      .slice(0, 3)
      .map((item) => `${item.rank || ""}.${item.userName || "匿名"}${item.count || 0}条`)
      .join("，");
    const words = (summary.topWords || [])
      .slice(0, 5)
      .map((item) => `${item.word}x${item.count}`)
      .join("，");
    const repeats = (summary.topMessages || [])
      .slice(0, 2)
      .map((item) => `「${item.text}」x${item.count}`)
      .join("，");
    return commandReply(
      `近${days}天弹幕${summary.total || 0}条，活跃${summary.activeUserCount || 0}人。活跃榜：${users || "暂无"}。热词：${words || "暂无"}。重复：${repeats || "暂无"}。`,
      "danmu_summary",
      118
    );
  }

  parseGiftQuery(text, event, history, roomInfo = {}, privileged = false) {
    if (!history) return null;
    const isMine = text.startsWith("我的");
    if (!isGiftHistoryQuery(text)) return null;

    const rangeInfo = parseHistoryRangeText(text);
    let keyword = extractGiftKeyword(text);
    const blindOnly = /盲盒/.test(text);
    if (/人气票/.test(text)) keyword = "人气票";

    const userName = isMine || !privileged ? firstString(event.displayUserName, event.userName) : "";
    const summary = history.queryGifts({
      range: rangeInfo.range,
      userName,
      giftName: keyword,
      blindOnly,
      roomId: roomInfo.roomId,
    });
    const scope = userName ? `${userName}的` : "全场";
    const giftText = summary.topGifts.length
      ? summary.topGifts
          .slice(0, 3)
          .map((item) => `${item.giftName}x${item.count}`)
          .join("，")
      : "暂无记录";
    const blindText =
      blindOnly && summary.blindBoxes
        ? `盲盒投入${summary.blindBoxes.sourceValueText}，产出${summary.blindBoxes.resultValueText}，差值${summary.blindBoxes.deltaValueText}。`
        : "";
    return commandReply(
      `${scope}${rangeInfo.label}礼物统计：共${summary.totalValueText}，${summary.totalGiftCount}件。${blindText}${giftText}`,
      "gift_history",
      120
    );
  }

  parseGuardQuery(text, event, history, roomInfo = {}) {
    if (!history) return null;
    const isMine = text.startsWith("我的");
    if (!/船长|舰长|提督|总督|大航海/.test(text)) return null;
    if (!isMine) return null;

    let range = "month";
    const dayMatch = text.match(/我的(\d{1,2})日/);
    const monthMatch = text.match(/我的(\d{1,2})月/);
    if (/今日|今天/.test(text)) range = "today";
    if (/昨日|昨天/.test(text)) range = "yesterday";
    if (/本周|这周/.test(text)) range = "week";
    if (/本月|这个月/.test(text)) range = "month";
    if (dayMatch) range = dateRangeFromDay(dayMatch[1]);
    if (monthMatch) range = currentMonthRange(monthMatch[1]);

    const userName = firstString(event.displayUserName, event.userName);
    const board = history.queryGuards({
      range,
      userName,
      roomId: roomInfo.roomId,
    });
    const rows = board.rows || [];
    const countByLevel = rows.reduce((acc, item) => {
      const name = item.guardName || (Number(item.guardLevel) === 1 ? "总督" : Number(item.guardLevel) === 2 ? "提督" : "舰长");
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});
    const detail = rows
      .slice(0, 3)
      .map((item) => `${item.userName || "匿名"} ${item.guardName || item.guardLevel || ""}`)
      .join("，");
    const scope = `${userName || "你"}的`;
    return commandReply(
      `${scope}大航海记录：共${rows.length}条，总督${countByLevel["总督"] || 0}、提督${countByLevel["提督"] || 0}、舰长${countByLevel["舰长"] || 0}${detail ? `。${detail}` : "。"}`,
      "guard_history",
      120
    );
  }
}

module.exports = {
  CommandEngine,
};
