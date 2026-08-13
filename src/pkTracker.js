"use strict";

const { firstNumber, firstString } = require("./interactionEngine");

function asNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function firstFinite(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function formatDelta(delta) {
  if (delta > 0) return `领先${delta}`;
  if (delta < 0) return `落后${Math.abs(delta)}`;
  return "持平";
}

function getNameFromUserInfo(info) {
  return firstString(
    info?.uname,
    info?.name,
    info?.base?.name,
    info?.origin_info?.name,
    info?.base?.origin_info?.name
  );
}

function normalizeAssistList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item, index) => {
      const userInfo = item.uinfo || item.user_info || item.user || {};
      return {
        rank: item.rank || index + 1,
        uid: item.uid || userInfo.uid || 0,
        uname: firstString(
          item.uname,
          item.name,
          getNameFromUserInfo(userInfo),
          item.user_name
        ),
        value: firstNumber(
          item.pk_votes,
          item.votes,
          item.score,
          item.value,
          item.contribution,
          item.gift_score,
          item.assist_score
        ),
      };
    })
    .filter((item) => item.uname);
}

function formatAssist(list, fallbackName = "") {
  if (list?.length) {
    return list
      .slice(0, 3)
      .map((item) => `${item.rank}.${item.uname}${item.value ? ` ${item.value}` : ""}`)
      .join("，");
  }
  return fallbackName || "暂无";
}

function normalizePkMember(member = {}) {
  const rank = firstFinite(member.rank, member.rank_v2);
  const price = firstFinite(member.price_text, member.price ? Number(member.price) / 100 : undefined);
  return {
    uid: member.uid || 0,
    roomId: member.room_id || member.roomid || 0,
    uname: firstString(
      member.uname,
      member.name,
      member.display_name,
      getNameFromUserInfo(member.uinfo)
    ),
    face: member.face || member.uinfo?.base?.face || "",
    position: firstFinite(member.position),
    votes: firstFinite(member.votes, member.score, member.pk_votes, price),
    votesText: firstString(member.votes_text, member.score_text),
    golds: asNumber(member.golds),
    rank: rank > 0 ? rank : 0,
    displayName: firstString(member.displayName, member.display_name),
    isRoomOwner: Boolean(member.isRoomOwner || member.is_room_owner),
    isWinner: Boolean(member.is_winner),
    assist: normalizeAssistList(member.assist_info || member.assist_list),
  };
}

class PkTracker {
  constructor(options = {}) {
    this.ownRoomId = Number(options.ownRoomId || 0);
    this.minReportIntervalMs = Number(options.minReportIntervalSec || 10) * 1000;
    this.maxInvestigations = Number(options.maxInvestigations || 20);
    this.lastProgressReportAt = 0;
    this.sideWarnedPkId = 0;
    this.state = {
      active: false,
      pkId: 0,
      status: 0,
      voteName: "PK值",
      opponent: {},
      own: {},
      multiMembers: [],
      sourceCommand: "",
      sessionId: "",
      lastVersion: 0,
      displayMode: "single",
      startedAt: 0,
      endsAt: 0,
      punish: {
        active: false,
      },
      widget: null,
      lastNotice: null,
      noticeHistory: [],
      investigations: {},
      lastInvestigationError: "",
    };
  }

  setOwnRoomId(roomId) {
    this.ownRoomId = Number(roomId || this.ownRoomId || 0);
  }

  handle(event) {
    const command = event.command || "";
    const raw = event.raw || {};
    const data = event.data || raw.data || {};
    const actions = [];

    this.state.pkId =
      raw.pk_id ||
      event.pkId ||
      data.pk_basic?.pk_id ||
      data.pk_id ||
      this.state.pkId;
    this.state.status =
      raw.pk_status ||
      event.pkStatus ||
      data.pk_basic?.status ||
      data.pk_status ||
      this.state.status;

    if (data.pk_basic?.end_time) this.state.endsAt = data.pk_basic.end_time;
    if (data.pk_basic?.start_time) this.state.startedAt = data.pk_basic.start_time;

    if (command === "PK_INFO") {
      this.state.active = true;
      this.state.sourceCommand = command;
      this.state.displayMode = (data.members || []).length > 2 ? "multi" : "single";
      this.updateMultiMembers(data.members || []);
      const now = Date.now();
      if (event.forceReport || now - this.lastProgressReportAt >= this.minReportIntervalMs) {
        this.lastProgressReportAt = now;
        actions.push(this.createReportAction("pk_multi_progress"));
      }
      return actions;
    }

    if (command === "PK_MULTI_CONN") {
      const nextVersion = asNumber(data.version);
      const nextSessionId = firstString(data.bizSessionId, data.sessionId, data.interactChannelId);
      if (
        nextSessionId &&
        this.state.sessionId === nextSessionId &&
        nextVersion &&
        this.state.lastVersion &&
        nextVersion < this.state.lastVersion
      ) {
        return actions;
      }
      // 换 session 后旧版本号作废，否则新 session 的低版本更新会被误判过期
      if (nextSessionId && this.state.sessionId && nextSessionId !== this.state.sessionId) {
        this.state.lastVersion = 0;
      }
      this.state.active = data.sessionStatus !== 2;
      this.state.voteName = data.voteName || "分";
      this.state.sourceCommand = command;
      this.state.sessionId = nextSessionId || this.state.sessionId;
      this.state.lastVersion = Math.max(this.state.lastVersion || 0, nextVersion || 0);
      this.state.displayMode = data.members?.length > 2 ? "multi" : "conn";
      this.updateMultiMembers(data.members || []);
      const now = Date.now();
      if (event.forceReport || now - this.lastProgressReportAt >= this.minReportIntervalMs) {
        this.lastProgressReportAt = now;
        actions.push(this.createReportAction("pk_multi_progress"));
      }
      return actions;
    }

    if (command === "PK_BATTLE_PRE" || command === "PK_BATTLE_PRE_NEW") {
      this.state.active = true;
      this.state.sourceCommand = command;
      this.state.displayMode = "single";
      this.updateOpponentFromData(data);
      this.state.voteName = data.pk_votes_name || this.state.voteName;
      actions.push(this.makeInfoAction(`PK预告：对手 ${this.opponentLabel()}，计分 ${this.state.voteName}`));
      return actions;
    }

    if (command === "PK_BATTLE_START" || command === "PK_BATTLE_START_NEW") {
      this.state.active = true;
      this.state.sourceCommand = command;
      this.state.displayMode = "single";
      this.state.voteName = data.pk_votes_name || this.state.voteName;
      this.state.startedAt = data.pk_start_time || raw.timestamp || 0;
      this.state.endsAt = data.pk_end_time || 0;
      this.updateSides(data.init_info, data.match_info);
      actions.push(this.makeInfoAction(`PK开始：对手 ${this.opponentLabel()}，结束时间 ${this.formatEndTime()}`));
      return actions;
    }

    if (
      command === "PK_BATTLE_PROCESS" ||
      command === "PK_BATTLE_PROCESS_NEW" ||
      command === "PK_BATTLE_FINAL_PROCESS"
    ) {
      this.state.active = true;
      this.state.sourceCommand = command;
      this.state.displayMode = "single";
      this.updateSides(data.init_info, data.match_info);
      const now = Date.now();
      if (event.forceReport || now - this.lastProgressReportAt >= this.minReportIntervalMs) {
        this.lastProgressReportAt = now;
        actions.push(this.createReportAction("pk_progress"));
      }
      return actions;
    }

    if (command === "PK_BATTLE_GIFT") {
      const message = firstString(data.gift_msg, data.toast_msg, data.msg);
      if (message) {
        actions.push(this.makeInfoAction(`PK礼物：${message}`));
      }
      return actions;
    }

    if (command === "PK_BATTLE_RANK_CHANGE") {
      const rankName = firstString(data.rank_name, data.first_rank_name);
      if (rankName) {
        actions.push(this.makeInfoAction(`PK榜单变化：${rankName}`));
      }
      return actions;
    }

    if (command === "PK_BATTLE_VIDEO_PUNISH_BEGIN") {
      this.state.sourceCommand = command;
      this.state.displayMode = "single";
      this.updateSides(data.init_info, data.match_info);
      const punish = data.video_punish || data.punish || {};
      const duration = firstFinite(punish.duration, data.duration);
      const startedAt = firstFinite(raw.timestamp, event.timestamp, Math.floor(Date.now() / 1000));
      this.state.punish = {
        active: true,
        name: firstString(punish.punish_name, punish.name, data.punish_name, "惩罚"),
        duration,
        startedAt,
        endsAt: duration ? startedAt + duration : 0,
      };
      actions.push(
        this.makeInfoAction(
          `PK惩罚开始：${this.state.punish.name}${
            duration ? `，${duration}秒` : ""
          }`
        )
      );
      return actions;
    }

    if (command === "PK_BATTLE_PUNISH_END") {
      this.state.sourceCommand = command;
      this.state.punish = {
        ...(this.state.punish || {}),
        active: false,
        endedAt: firstFinite(raw.timestamp, event.timestamp, Math.floor(Date.now() / 1000)),
      };
      actions.push(this.makeInfoAction("PK惩罚结束"));
      return actions;
    }

    if (command === "PK_WIDGET") {
      this.state.widget = {
        taskName: firstString(data.task?.name, data.title),
        needNum: firstFinite(data.task?.need_num),
        currentNum: firstFinite(data.task?.current_num),
        reward: firstString(data.task?.reward),
        show: data.show !== false,
        text: firstString(data.text, data.title),
        icon: firstString(data.task?.icon),
        raw: data,
      };
      return actions;
    }

    if (command === "PK_NOTICE") {
      const notice = {
        text: firstString(event.text, data.text, data.notice?.text),
        type: firstString(event.noticeType, data.noticeType, data.pkNotice?.type, data.notice?.pkNotice?.type, "info"),
        level: firstString(event.noticeLevel, data.noticeLevel, data.pkNotice?.level, data.notice?.pkNotice?.level, "info"),
        at: firstFinite(event.at, data.at, event.timestamp, data.timestamp, Date.now()),
        sourceCommand: firstString(data.sourceCommand, data.notice?.command, "COMMON_NOTICE_DANMAKU"),
      };
      if (!notice.text) return actions;
      this.state.active = true;
      this.state.sourceCommand = command;
      this.state.lastNotice = notice;
      this.state.noticeHistory = [notice, ...(this.state.noticeHistory || [])]
        .filter((item, index, list) => list.findIndex((other) => other.text === item.text && other.type === item.type) === index)
        .slice(0, 8);
      return actions;
    }

    if (
      command === "PK_BATTLE_END" ||
      command === "PK_BATTLE_SETTLE" ||
      command === "PK_BATTLE_SETTLE_USER" ||
      command === "PK_BATTLE_SETTLE_V2" ||
      command === "PK_BATTLE_SETTLE_NEW"
    ) {
      this.updateSides(data.init_info, data.match_info);
      this.updateWinner(data.winner);
      const action = this.createReportAction("pk_end");
      action.reply = `PK结束：${action.reply}`;
      this.state.active = false;
      // 结算播报生成后清场，避免下一场 PK 带着上一场对手的残留数据
      this.resetBattleState();
      return [action];
    }

    return actions;
  }

  resetBattleState() {
    this.state.opponent = {};
    this.state.own = {};
    this.state.multiMembers = [];
    this.state.punish = { active: false };
    this.state.widget = null;
  }

  updateOpponentFromData(data) {
    if (!data) return;
    this.state.opponent = {
      ...this.state.opponent,
      uid: data.uid || this.state.opponent.uid,
      roomId: data.room_id || this.state.opponent.roomId,
      uname: data.uname || this.state.opponent.uname,
      face: data.face || this.state.opponent.face,
      seasonId: data.season_id || this.state.opponent.seasonId,
    };
  }

  updateWinner(winner) {
    if (!winner) return;
    const bestUser = winner.best_user || {};
    const winnerRoomId = Number(winner.room_id || 0);
    const winnerType = firstFinite(winner.winner_type, winner.type);
    let target = null;
    if (winnerRoomId && winnerRoomId === Number(this.state.opponent.roomId || 0)) {
      target = this.state.opponent;
    } else if (
      winnerRoomId &&
      (winnerRoomId === Number(this.state.own.roomId || 0) || winnerRoomId === Number(this.ownRoomId || 0))
    ) {
      target = this.state.own;
    }
    // room_id 无法判定归属时不落账，避免对面获胜记到我方头上
    if (!target) return;

    target.winnerName = winner.uname || target.winnerName;
    target.winnerType = winnerType || target.winnerType;
    target.bestUname = bestUser.uname || target.bestUname;
    target.bestValue = bestUser.pk_votes || target.bestValue;
  }

  updateMultiMembers(members) {
    const normalized = Array.isArray(members)
      ? members.map(normalizePkMember).filter((item) => item.roomId || item.uname)
      : [];
    if (normalized.length === 0) return;

    const hasRank = normalized.some((item) => item.rank > 0);
    if (!hasRank) {
      const hasScore = normalized.some((item) => item.votes > 0);
      normalized
        .slice()
        .sort((left, right) => {
          if (hasScore) return right.votes - left.votes || left.position - right.position;
          return left.position - right.position;
        })
        .forEach((item, index) => {
          item.rank = index + 1;
        });
    }

    this.state.multiMembers = normalized.sort((left, right) => {
      const rankDelta = (left.rank || 9999) - (right.rank || 9999);
      return rankDelta || right.votes - left.votes;
    });

    const ownRoomId = Number(this.ownRoomId || 0);
    const own =
      this.state.multiMembers.find((item) => ownRoomId && Number(item.roomId) === ownRoomId) ||
      this.state.multiMembers.find((item) => item.isRoomOwner) ||
      this.state.multiMembers.find((item) => item.roomId === this.state.own.roomId);
    const leader = this.state.multiMembers.find((item) => item.rank === 1) || this.state.multiMembers[0];
    const opponent =
      this.state.multiMembers.find((item) => item.roomId !== own?.roomId && item.rank === 1) ||
      this.state.multiMembers.find((item) => item.roomId !== own?.roomId) ||
      leader;

    if (own) {
      this.state.own = this.mergeSide(this.state.own, {
        roomId: own.roomId,
        votes: own.votes,
        rank: own.rank,
        uname: own.uname,
        face: own.face,
        assist: own.assist,
      });
    }
    if (opponent) {
      this.state.opponent = this.mergeSide(this.state.opponent, {
        roomId: opponent.roomId,
        uid: opponent.uid,
        uname: opponent.uname,
        face: opponent.face,
        votes: opponent.votes,
        rank: opponent.rank,
        assist: opponent.assist,
      });
    }
  }

  updateSides(initInfo, matchInfo) {
    if (!initInfo && !matchInfo) return;

    const init = this.normalizeSide(initInfo);
    const match = this.normalizeSide(matchInfo);
    const ownRoomId = Number(this.ownRoomId || 0);
    const matchIsOwn = ownRoomId && Number(match.roomId) === ownRoomId;
    const initIsOwn = ownRoomId && Number(init.roomId) === ownRoomId;
    if (ownRoomId && !matchIsOwn && !initIsOwn && this.sideWarnedPkId !== this.state.pkId) {
      // 协议不保证 init_info=我方，两侧都对不上时提醒一次，方向可能整场反转
      this.sideWarnedPkId = this.state.pkId;
      console.warn(
        `[PK] 双方房间号(${init.roomId}/${match.roomId})都不等于本房间 ${ownRoomId}，默认按 init=我方处理`
      );
    }

    const ownSide = matchIsOwn ? match : init;
    const opponentSide = matchIsOwn ? init : match;

    this.state.own = this.mergeSide(this.state.own, ownSide);
    this.state.opponent = this.mergeSide(this.state.opponent, {
      ...opponentSide,
      roomId: opponentSide.roomId || this.state.opponent.roomId,
    });
  }

  mergeSide(previous = {}, next = {}) {
    const merged = { ...previous };
    for (const [key, value] of Object.entries(next || {})) {
      if (value === undefined || value === null || value === "") continue;
      if (Array.isArray(value) && value.length === 0) continue;
      merged[key] = value;
    }
    return merged;
  }

  pruneInvestigations() {
    const limit = Math.max(1, Number(this.maxInvestigations || 20));
    const entries = Object.entries(this.state.investigations || {});
    if (entries.length <= limit) return;
    // 长跑进程按交战房间数无界增长，超限时按侦查时间淘汰最旧的
    entries.sort(
      (left, right) =>
        Number(left[1]?.fetchedAt || left[1]?.investigationAt || 0) -
        Number(right[1]?.fetchedAt || right[1]?.investigationAt || 0)
    );
    for (const [key] of entries.slice(0, entries.length - limit)) {
      delete this.state.investigations[key];
    }
  }

  mergeOpponentInvestigation(info = {}) {
    if (!info || !info.roomId) return;
    this.state.investigations = {
      ...(this.state.investigations || {}),
      [String(info.roomId)]: {
        ...(this.state.investigations?.[String(info.roomId)] || {}),
        ...info,
      },
    };
    this.pruneInvestigations();
    this.state.opponent = this.mergeSide(this.state.opponent, {
      roomId: info.roomId,
      uid: info.uid,
      uname: info.uname,
      face: info.face,
      fans: info.fans,
      guardCount: info.guardCount,
      guardCounts: info.guardCounts,
      guardTop: info.guardTop,
      onlineRankCount: info.onlineRankCount,
      onlineGuardCount: info.onlineGuardCount,
      topScore: info.topScore,
      topRank: info.topRank,
      investigationSource: info.source,
      partialFailures: info.partialFailures,
      investigationAt: info.fetchedAt || Date.now(),
    });
  }

  mergeMemberInvestigation(roomId = 0, info = {}) {
    const targetRoomId = Number(roomId || info.roomId || 0);
    if (!targetRoomId || !info) return;
    this.state.investigations = {
      ...(this.state.investigations || {}),
      [String(targetRoomId)]: {
        ...(this.state.investigations?.[String(targetRoomId)] || {}),
        ...info,
      },
    };
    this.pruneInvestigations();
    this.state.multiMembers = (this.state.multiMembers || []).map((member) => {
      if (Number(member.roomId || 0) !== targetRoomId) return member;
      return {
        ...member,
        uid: member.uid || info.uid,
        uname: member.uname || info.uname,
        face: member.face || info.face,
        fans: info.fans,
        guardCount: info.guardCount,
        guardCounts: info.guardCounts,
        onlineRankCount: info.onlineRankCount,
        onlineGuardCount: info.onlineGuardCount,
        topScore: info.topScore,
        topRank: info.topRank,
        investigationSource: info.source,
        partialFailures: info.partialFailures,
        investigationAt: info.fetchedAt || Date.now(),
      };
    });
    if (Number(this.state.opponent?.roomId || 0) === targetRoomId) {
      this.mergeOpponentInvestigation(info);
    }
  }

  setInvestigationError(message = "") {
    this.state.lastInvestigationError = String(message || "");
  }

  normalizeSide(info = {}) {
    const userInfo = info.uinfo || info.user_info || info.user || {};
    const base = userInfo.base || {};
    const assist = normalizeAssistList(info.assist_info || info.assist_list);
    return {
      uid: firstNumber(info.uid, info.user_id, userInfo.uid),
      roomId: info.room_id || info.roomid || 0,
      uname: firstString(
        info.uname,
        info.name,
        info.user_name,
        getNameFromUserInfo(userInfo),
        base.origin_info?.name,
        base.name
      ),
      face: firstString(info.face, base.origin_info?.face, base.face),
      votes: asNumber(info.votes || info.score || info.pk_votes),
      bestUname: firstString(info.best_uname, info.best_user?.uname),
      bestValue: firstNumber(info.best_value, info.best_user?.pk_votes),
      winnerType: firstFinite(info.winner_type),
      assist,
    };
  }

  opponentLabel() {
    const opponent = this.state.opponent || {};
    const name = opponent.uname || opponent.name || "未知主播";
    return opponent.roomId ? `${name}(房间 ${opponent.roomId})` : name;
  }

  formatEndTime() {
    if (!this.state.endsAt) return "未知";
    return new Date(this.state.endsAt * 1000).toLocaleTimeString("zh-CN", {
      hour12: false,
    });
  }

  makeInfoAction(reply) {
    return {
      type: "pk_info",
      ruleName: "pk",
      reply,
      emotion: "serious",
      priority: 90,
    };
  }

  createReportAction(type = "pk_report") {
    if (this.state.displayMode === "multi" || this.state.multiMembers?.length > 2) {
      return this.createMultiReportAction(type);
    }

    const ownVotes = asNumber(this.state.own.votes);
    const opponentVotes = asNumber(this.state.opponent.votes);
    const delta = ownVotes - opponentVotes;
    const voteName = this.state.voteName || "PK值";

    const ownBest = formatAssist(this.state.own.assist, this.state.own.bestUname);
    const opponentBest = formatAssist(
      this.state.opponent.assist,
      this.state.opponent.bestUname
    );

    const opponent = this.state.opponent || {};
    const investigation = opponent.guardCount || opponent.fans || opponent.onlineRankCount
      ? `对面情报：${opponent.guardCount || 0}船，${opponent.fans || 0}粉，高能榜${opponent.onlineRankCount || 0}人，船员在线${opponent.onlineGuardCount || 0}人，前排贡献${opponent.topScore || 0}。`
      : "";

    return {
      type,
      ruleName: "pk_report",
      reply: `${
        this.state.displayMode === "conn" ? "连线" : "对手"
      } ${this.opponentLabel()}。我方 ${ownVotes}${voteName}，对面 ${opponentVotes}${voteName}，${formatDelta(delta)}。我方大哥：${ownBest}。对面大哥：${opponentBest}。${investigation}`,
      emotion: "serious",
      priority: 100,
    };
  }

  createMultiReportAction(type = "pk_report") {
    const members = this.state.multiMembers || [];
    const ownRoomId = Number(this.ownRoomId || 0);
    const own =
      members.find((item) => ownRoomId && Number(item.roomId) === ownRoomId) ||
      members.find((item) => item.roomId === this.state.own.roomId);
    const leader = members.find((item) => item.rank === 1) || members[0];
    const voteName = this.state.voteName || "分";
    const topText = members
      .slice()
      .sort((left, right) => (left.rank || 9999) - (right.rank || 9999))
      .slice(0, 5)
      .map(
        (item) =>
          `${item.rank || "-"} ${item.uname || item.roomId}:${item.votes}${voteName}`
      )
      .join("，");
    const ownText = own
      ? `我方第${own.rank || "-"}，${own.votes}${voteName}`
      : "我方暂未定位";
    const leaderText = leader
      ? `榜首 ${leader.uname || leader.roomId} ${leader.votes}${voteName}`
      : "榜首未知";

    return {
      type,
      ruleName: "pk_multi_report",
      reply: `多人PK：${ownText}；${leaderText}。前排：${topText}。`,
      emotion: "serious",
      priority: 100,
    };
  }

  getSnapshot() {
    const ownVotes = asNumber(this.state.own.votes);
    const opponentVotes = asNumber(this.state.opponent.votes);
    const delta = ownVotes - opponentVotes;

    return {
      active: this.state.active,
      pkId: this.state.pkId,
      status: this.state.status,
      voteName: this.state.voteName,
      ownRoomId: this.ownRoomId,
      mode: this.state.displayMode || (this.state.multiMembers?.length > 2 ? "multi" : "single"),
      displayMode:
        this.state.displayMode || (this.state.multiMembers?.length > 2 ? "multi" : "single"),
      sourceCommand: this.state.sourceCommand,
      sessionId: this.state.sessionId,
      lastVersion: this.state.lastVersion,
      memberCount: this.state.multiMembers?.length || 0,
      own: {
        ...this.state.own,
        votes: ownVotes,
      },
      opponent: {
        ...this.state.opponent,
        votes: opponentVotes,
        label: this.opponentLabel(),
      },
      multiMembers: this.state.multiMembers || [],
      investigations: this.state.investigations || {},
      lastInvestigationError: this.state.lastInvestigationError || "",
      punish: this.state.punish || { active: false },
      widget: this.state.widget || null,
      lastNotice: this.state.lastNotice || null,
      noticeHistory: this.state.noticeHistory || [],
      delta,
      deltaText: formatDelta(delta),
      endsAt: this.state.endsAt,
      report: this.createReportAction().reply,
    };
  }
}

module.exports = {
  PkTracker,
  normalizeAssistList,
};
