"use strict";

const { BotRuntime } = require("./botRuntime");

// 模拟专用假房号：自检绝不指向任何真实直播间。
const SELF_TEST_ROOM_ID = 100000;

// expectAction 标记该用例在对应模块开启时必须产出至少一个动作，
// 只看计数自增会被 simulate 内部的无条件 counts+=1 糊弄成恒真。
const SELF_TEST_CASES = [
  { key: "enter", label: "进房欢迎", count: "enter", expectAction: true, moduleGate: "welcome" },
  { key: "chat", label: "弹幕命令", count: "chat" },
  { key: "gift", label: "礼物感谢", count: "gift", expectAction: true, moduleGate: "giftThanks" },
  { key: "blind_gift", label: "盲盒兜底", count: "gift" },
  { key: "superChat", label: "醒目留言 SC", count: "superChat" },
  { key: "guard", label: "大航海/掉舰榜", count: "guard" },
  { key: "lottery", label: "天选/红包暂停", count: "event" },
  { key: "pk", label: "单人 PK", count: "pk" },
  { key: "multi", label: "多人 PK/连线", count: "pk" },
];

function cloneConfig(config = {}) {
  try {
    return JSON.parse(JSON.stringify(config || {}));
  } catch {
    return {};
  }
}

function makeSafeConfig(config = {}) {
  const safe = cloneConfig(config);
  safe.history = {
    ...(safe.history || {}),
    enabled: false,
    restoreGiftStatsOnStart: false,
    giftStatsRestoreMode: "none",
  };
  safe.screenshots = {
    ...(safe.screenshots || {}),
    enabled: false,
  };
  return safe;
}

function countValue(snapshot = {}, key = "") {
  return Number(snapshot.counts?.[key] || 0);
}

function moduleGateEnabled(config = {}, name = "") {
  if (!name) return true;
  return config.modules?.[name]?.enabled !== false;
}

function checkCase(testCase, before = {}, after = {}, config = {}) {
  const beforeCount = countValue(before, testCase.count);
  const afterCount = countValue(after, testCase.count);
  if (afterCount <= beforeCount) {
    return {
      ok: false,
      detail: `${testCase.count} 未增加（${beforeCount} -> ${afterCount}）`,
    };
  }
  if (testCase.expectAction) {
    if (!moduleGateEnabled(config, testCase.moduleGate)) {
      return { ok: true, skipped: true, detail: `模块 ${testCase.moduleGate} 已关闭，仅验证事件解析` };
    }
    const beforeActions = countValue(before, "action");
    const afterActions = countValue(after, "action");
    if (afterActions <= beforeActions) {
      return {
        ok: false,
        detail: `${testCase.label} 没有产出任何动作（模块开启时应有回复/入队）`,
      };
    }
  }
  if (testCase.key === "gift" && Number(after.giftStats?.totalGiftCount || 0) <= 0) {
    return { ok: false, detail: "礼物统计没有更新" };
  }
  if (testCase.key === "superChat" && Number(after.giftStats?.superChatTotal || 0) <= 0) {
    return { ok: false, detail: "SC 金额统计没有更新" };
  }
  if (testCase.key === "guard" && !after.guardBoard?.rows?.length) {
    return { ok: false, detail: "大航海/掉舰榜没有更新" };
  }
  return {
    ok: true,
    detail: `${testCase.count} ${beforeCount} -> ${afterCount}`,
  };
}

function runAssistantSelfTest(options = {}) {
  const safeConfig = makeSafeConfig(options.config || {});
  const runtime = new BotRuntime({
    config: safeConfig,
    room: options.room || options.config?.room || "",
    dryRun: true,
  });
  runtime.roomInfo = {
    roomId: Number(options.roomId || 0) || SELF_TEST_ROOM_ID,
    uname: "本地自检房间",
    liveStatus: 1,
  };

  const checks = [];
  for (const testCase of SELF_TEST_CASES) {
    const before = runtime.getSnapshot();
    let after = before;
    let ok = false;
    let skipped = false;
    let detail = "";
    try {
      after = runtime.simulate(testCase.key);
      const checked = checkCase(testCase, before, after, safeConfig);
      ok = checked.ok;
      skipped = Boolean(checked.skipped);
      detail = checked.detail;
    } catch (error) {
      detail = error.message;
    }
    checks.push({
      key: testCase.key,
      label: testCase.label,
      ok,
      skipped,
      detail,
    });
  }

  const snapshot = runtime.getSnapshot();
  return {
    ok: checks.every((item) => item.ok),
    isolated: true,
    dryRun: true,
    checks,
    summary: {
      passed: checks.filter((item) => item.ok).length,
      total: checks.length,
      counts: snapshot.counts,
      giftStats: {
        totalGiftCount: snapshot.giftStats?.totalGiftCount || 0,
        superChatTotal: snapshot.giftStats?.superChatTotal || 0,
      },
      guardRows: snapshot.guardBoard?.rows?.length || 0,
      actionCount: snapshot.counts?.action || 0,
    },
  };
}

module.exports = {
  SELF_TEST_CASES,
  runAssistantSelfTest,
};
