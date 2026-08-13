# 隐私与本地数据

本项目会处理直播间公开事件，也可能在本机保存登录态和观众互动历史。仓库代码公开不代表这些运行数据可以公开。

## 本地目录

| 路径 | 内容 | 是否可提交 |
| --- | --- | --- |
| `config.json` | 房间号、本机开关和自定义话术 | 否 |
| `state/browser-profile/` | Chrome 登录资料 | 绝对禁止 |
| `state/secrets/` | 登录态或其他敏感数据 | 绝对禁止 |
| `state/raw/`、`state/events/` | 原始包和观众事件 | 否 |
| `state/logs/` | 运行日志 | 否 |
| `artifacts/`、`screenshots/` | 礼物图和页面截图 | 否 |

这些路径已被 `.gitignore` 排除，但 Git 不会忘记曾经提交过的文件。若历史提交中出现过真实数据，不要直接推送该仓库；应使用 `npm run public:export` 生成没有旧历史的公开副本。

## 分享排障材料

分享前至少移除 Cookie、CSRF、UID、昵称、头像 URL、房间号、弹幕正文和时间戳。优先构造合成 fixture，不要把生产流水简单改名后上传。

## 数据保留

`retention` 只能清理运行目录，不能清理 Git 历史、云盘或已经发出的附件。公开发布前运行 `npm run public:audit`，并人工复核 `git status` 和即将发布的提交。
