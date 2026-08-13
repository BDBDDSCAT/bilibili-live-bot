# 运维排障手册

## 快速判断

| 现象 | 先看什么 |
| --- | --- |
| 页面打不开 | `npm run service:status`；`state/logs/launchd.err.log` |
| 机器人不回复弹幕 | 页面状态是否「自动运行中」；`state/logs/bot-*.log` 里搜「AI」「发送」 |
| 显示等待登录 | 弹出的 Chrome 里重新登录 B 站；登录页没弹就点一次「打开B站并登录」 |
| 抓不到弹幕/礼物 | 开 <http://127.0.0.1:4322/api/doctor> 看体检结论 |
| AI 不说话 | `curl http://127.0.0.1:11434/api/tags` 确认 Ollama；`ollama pull qwen3.5:4b` |
| 磁盘涨得快 | `du -sh state/*`；确认 `config.json` 里 `retention.enabled` 为 true |

## 日志

- 业务日志：`state/logs/bot-YYYY-MM-DD.log`（连接、发送、AI、守护、进程异常都在这里），按 `retention.logsDays` 自动清理。
- launchd 服务日志：`state/logs/launchd.out.log` / `launchd.err.log`。
- 页面「查看最近动态」是内存里最近 300 条，自动恢复时不清空，只加分隔线。

## 自愈机制（知道它们存在，出问题先别急着重启）

- WebSocket 断线自动重连；认证 token 过期会重新取配置再连。
- 收包看门狗：超过数个心跳周期收不到任何包会强制断开重连（对付半开 TCP）。
- 服务 watchdog：监听中断 45 秒后自动重启监听（日志里有「守护」记录）。
- 托管的 Chrome 被手动关掉/崩溃后约 5 秒自动重开（指数退避）；不想要这个行为配 `browserAutomation.autoRelaunchOnClose: false`。
- 进程崩溃：launchd 10 秒后自动拉起。
- 单个页面连接出错不会再带崩整个进程（SSE/下载流都有兜底）。

## 手动操作

```bash
npm run service:status      # 服务状态
npm run service:uninstall   # 停止并卸载常驻
npm start                   # 前台跑（调试用，Ctrl+C 优雅退出）
npm run verify              # 回归门禁
npm run audit -- --room 你的房间号   # 抓取对账
```

强制重启服务：`npm run service:install`（重装即重启）。

## 已知边界

- `/api/audit` 默认只审当天（`?day=all` 才全量，历史大时会慢）。
- 「本地自检 9/9 通过」只说明模块能跑，不代表真实样本都出现过；看体检页的「真实样本门槛」。
- 礼物「文字补记」（弹幕文本里解析出的礼物）只做展示与待核对记录，不计统计、不加积分、不触发感谢——防止观众发假文本刷积分。
- 登录态 `state/secrets/bili-login.json` 是明文，别把 `state/` 目录同步到不可信的地方。
- Web 控制台没有账号体系，保持绑定 `127.0.0.1`，不要直接暴露到公网。
- 开源仓库只包含代码和脱敏 fixture；真实截图、礼物图、房间流水统一放在 Git 忽略目录。

## 数据恢复

- 快照写入是原子的（tmp+rename）；若发现 `state/snapshots/*.json.corrupt` 备份文件，说明发生过损坏，可人工比对恢复。
- 手工导入的大航海名单在 `state/snapshots/manualGuardBoard.json`。
- 积分、礼物历史都在 `state/events/*.jsonl`，纯 JSONL，可直接文本处理。
