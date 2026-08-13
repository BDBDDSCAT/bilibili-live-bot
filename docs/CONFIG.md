# 配置参考（config.json）

加载顺序：内置安全默认值 ← `config.json`（或 `config.local.json`）← 命令行 `--config`。缺任何键都会落回默认值；类型/范围错误会在启动时用中文一次性报出。模板见 `config.example.json`，生成配置用 `npm run setup`。

## 顶层

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `room` | `""` | 直播间链接或房间号。空则启动后需在页面填写 |
| `dryRun` | `true` | true 时只生成建议不真实发送。浏览器托管启动时按托管流程接管 |
| `send.enabled` | `false` | 是否允许真实发送弹幕 |
| `send.maxChars` | `40` | 弹幕最大字数（B 站限制），超长会让 AI 压短 |
| `send.cooldownSec` | `8` | 发送全局冷却 |
| `showAllEvents` | `false` | 控制台是否打印全部事件 |
| `connection.autoStartSafe` | `true` | 服务启动后自动进入只监听模式（不发送） |
| `connection.fanoutHosts` | `1` | 弹幕监听线路数（1–4） |
| `maxRepliesPerMessage` | `1` | 一条弹幕最多触发几条回复 |
| `ignoreUsers` / `ignoreNameIncludes` | `[]` / 助理词表 | 完全忽略的用户/昵称包含词 |
| `blocklist` | 广告词表 | 命中即不回复的入站词 |

## browserAutomation（浏览器托管：自动发送与点赞）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 是否启用 Chrome 托管；公开模板保持关闭 |
| `roomUrl` | `""` | 托管打开的直播间，通常与 `room` 一致 |
| `profileDir` | `state/browser-profile` | Chrome 用户目录（保存登录态） |
| `chromeExecutable` | 自动探测 | 浏览器路径，找不到时启动日志会提示 |
| `headless` | `false` | 托管需要可见窗口登录，保持 false |
| `autoLike.enabled` | `false` | 自动点赞；使用者明确开启后才运行 |
| `autoLike.onlyWhenLive` | `true` | 未开播不消耗点赞额度，收到开播事件后自动开始 |
| `autoLike.initialDelayMinSec/MaxSec` | `2/5` | 就绪后首次点赞随机延迟 |
| `autoLike.intervalMinSec/MaxSec` | `0.85/1.15` | 每批点赞随机间隔 |
| `autoLike.burstMinClicks/MaxClicks` | `10/50` | 每批随机点击数 |
| `autoLike.sessionTargetMinClicks/MaxClicks` | `10000/20000` | 同房间同一天的随机硬上限，停启或切房不会重置 |
| `outboundEchoMs` | `8000` | 公屏回声去重窗口（识别自己刚发的弹幕） |
| `selfUid` / `selfUserName` | 自动探测 | 登录账号身份，用于回声判定；默认从 Chrome 登录态探测 |
| `autoRelaunchOnClose` | `true` | Chrome 被手动关掉后 5 秒起指数退避自动重开 |
| `statusPollMs` | `1500` | 托管状态轮询间隔（旧键 `loginPollMs` 仍兼容） |

## modules（底层模块开关）

`autoSend`、`autoLike`、`welcome`、`giftThanks`、`pk`、`rotation`（主动发言）、`ai`、`spam`、`guardBoard`、`history`。每项 `{ "enabled": true/false }`。公开模板关闭 `autoSend`、`autoLike`、`rotation` 和 `ai`。

主播控制台使用高层功能开关，会原子地同步所有依赖：例如 AI 同时更新 `modules.ai` 和 `localAi.enabled`，自动点赞同时更新模块、浏览器托管和点赞调度开关，礼物感谢同步礼物、SC 与上舰处理。不建议手工只修改某一个底层键。

## roles（权限）

| 键 | 说明 |
| --- | --- |
| `anchorIds` / `adminIds` | 主播/管理员 uid 白名单（权限判定以 uid 为准） |
| `anchorNames` / `adminNames` | 昵称匹配，仅在未配置对应 uid 白名单时生效 |
| `botNames` | 机器人账号昵称：自己的弹幕/点赞不回应 |
| `assistantUids` | 官方小助理 uid 白名单：只有这些 uid 的播报文本才允许全额入账礼物 |

## automation（发送队列）

`autoSendTypes`（允许自动发送的动作类型）、`queueLimit`（队列上限 80）、`pauseWelcomeDuringLottery`/`pauseGiftDuringLottery`（天选/抽奖时暂停欢迎与感谢）、`humanTiming`（队列抖动：动作延迟 500–1800ms、发送间隔 2–5s，不用于规避平台检测）、`startupMessage`（上线弹幕，默认关）。公开模板关闭整个自动发送队列；只有使用者点击“打开 B站并登录”或明确开启自动输出功能后才会授权。

## localAi（本地 Qwen）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | AI 互动总开关（还要 modules.ai 开启） |
| `endpoint` | `http://127.0.0.1:11434` | Ollama 地址 |
| `model` | `qwen3.5:4b` | 模型名 |
| `autoStart` | `true` | 点击启动托管时，若本机 Ollama 不可达则在 macOS 自动打开 Ollama 应用 |
| `startupTimeoutMs` | `15000` | 自动打开 Ollama 后等待服务就绪的最长时间 |
| `numCtx` | `8192` | 上下文长度（大了显存暴涨、响应变慢） |
| `timeoutMs` | `20000` | 单次生成超时 |
| `maxChars` | `36` | 目标回复长度（40 字硬 gate 之内） |
| `viewerReplyCooldownMs` | `1500` | 同一观众回复冷却 |
| `allViewerChats` | `true` | 普通弹幕也交给 AI（false 则只回艾特） |
| `fallbackToRules` | `false` | AI 未处理时是否允许普通关键词固定话术；公开模板关闭，避免模板冒充 AI |
| `proactive.*` | `enabled: false, onlyWhenLive: true` | 仅开播后按配置节奏主动发言（同时受 modules.rotation 控制） |

一键恢复只对 `enabled=true` 的本机 Ollama loopback 地址生效。启动前会读取 `/api/tags` 确认配置模型；服务在线但模型缺失时只报错，不会自动 `pull`。另有 `contextBudget`（提示词背景预算，默认 1800 码点）。

## weather

`enabled`（观众问天气时取实时数据交给 AI 组织回答）、`timeoutMs`、`language`、`cacheTtlMs`（同城天气缓存，默认 10 分钟，0 关闭）。

## overlayExport（挂件导出）

`jobTimeoutMs`（任务总超时，默认 5 分钟）、`commandTimeoutMs`（单次 ffmpeg 超时，默认 2 分钟）、`imageWaitMs`（页面图片等待上限，默认 10 秒）、`ffmpegPath`/`ffprobePath`/`chromeExecutable`（默认自动探测）。

## history / retention（数据落盘与清理）

`history.enabled`、`history.dir`（默认 `state`）、`history.persistKinds`（入库事件类型）、`history.restoreGiftStatsOnStart`（重启恢复今日礼物）、`history.rawAudit.enabled`（原始流水落盘）。

`retention`：`enabled`（默认 true）、`rawDays 60`、`eventsDays 180`、`logsDays 14`（运行日志，由日志器自清）、`auditsDays 90` 与 `observationsDays 30`（文件名无日期前缀时按修改时间判过期）、`overlaysKeep 24`（挂件历史份数，latest 永远保留）、`screenshotsDays`（截图证据留档**默认永不清理**，显式配置大于 0 的天数才会删）。启动即清理一次，此后每 12 小时一次；当天文件与 `.tag`/`current-*` 入口文件永不删除。

## points（积分商城）

`signInPoints`（签到分）、`giftPointsPerBattery`（每电池积分）、`guardPoints`（舰长/提督/总督分）、`signInStreak`（连签奖励与里程碑，跨月不清零）、`streakWindowDays`（连签统计窗口，默认 40 天）、`shopItems`（兑换商品列表）。

## rules / interactions / timers（话术）

- `rules[]`：关键词脚本回复。字段：`name`、`enabled`、`priority`、`keywords`、`matchMode`（可选 `exact`）、`reply`（字符串或数组随机）、`action`（`gift_report`/`pk_report`）、`cooldownSec`、`userCooldownSec`。
- `interactions`：欢迎（含时段模板、舰长模板、黑名单）、礼物/SC/上舰/关注/分享感谢、点赞感谢（默认关）、巡场提示。
- `timers[]`：定时话术，`intervalSec` 不填视为禁用。

## commands / rateLimit / pk / screenshots

- `commands.prefixes`（命令前缀）、`allowPublicGiftQuery`/`allowPublicPkQuery`、`drawLots`（抽签文案）。
- `rateLimit.globalSendCooldownSec`、`spamCooldownSec`。
- `pk.showRawEvents`、`minReportIntervalSec`、`investigator`（对手房间侦查：`enabled`、`cacheMs`、`timeoutMs` 默认 8 秒、`maxCacheEntries` 默认 64）。
- `screenshots`：直播画面留档，默认关，触发项 gift/superChat/guard/manual。
