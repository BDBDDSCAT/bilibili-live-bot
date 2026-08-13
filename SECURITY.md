# 安全说明

## 支持范围

安全修复只保证当前 `main` 分支。请在提交报告前先确认问题仍能在最新版复现。

## 报告漏洞

不要在公开 Issue 中粘贴 Cookie、二维码、直播观众资料、`config.json` 或 `state/` 内容。请通过仓库维护者在 GitHub 个人资料中公布的私密联系方式报告，并提供最小复现步骤、影响范围和脱敏日志。

## 本地安全边界

- Web 控制台没有账号体系，默认只应监听 `127.0.0.1`；不要把 `--allow-remote` 暴露到不可信网络。
- `state/browser-profile/` 和 `state/secrets/` 可能保存 B 站登录态，必须视为密码。
- `config.json`、`state/`、`artifacts/`、`screenshots/` 都不应提交或打包公开。
- 示例配置默认只监听。真实发送、浏览器托管、AI 主动互动和点赞都必须由使用者显式开启。

如怀疑登录态泄露，请立即退出所有 B 站会话、删除本地 `state/browser-profile/` 与 `state/secrets/`，再重新登录。
