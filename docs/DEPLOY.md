# 部署指南

## 形态一：macOS 本机常驻（推荐，全功能）

自动发弹幕/点赞依赖本机 Chrome 的登录态，AI 依赖本机 Ollama，所以完整功能建议部署在主播自己的 Mac。公开模板默认只监听，发送、点赞和 AI 需要显式开启。

```bash
npm install
npm run setup -- --room 你的房间号
npm start        # 先前台跑一次确认正常
```

确认 <http://127.0.0.1:4322> 正常后，装成常驻服务：

```bash
npm run service:install
```

- launchd 标签：`com.bilibili-live-bot.web`，plist 在 `~/Library/LaunchAgents/`。
- 开机自启；进程异常退出 10 秒后自动拉起（正常 `service:uninstall` 停止不会拉起）。
- 服务的 stdout/stderr 在 `state/logs/launchd.out.log` / `launchd.err.log`；业务日志在 `state/logs/bot-*.log`。
- 升级代码后执行 `npm run service:install` 会自动用新 plist 重装并重启。
- plist 里的 node 路径会优先写 Homebrew 的版本无关链接（`/opt/homebrew/opt/node/bin/node`），`brew upgrade node` 后服务不会失效；保险起见大版本升级后重跑一次 `npm run service:install`。

注意事项：

- 第一次启动浏览器托管会弹出 Chrome 窗口要求登录 B 站，这是设计行为；登录态保存在 `state/browser-profile/`，之后重启不用再登录。
- 若用到直播画面截图留档，macOS 会请求屏幕录制权限，需要授一次权。
- Ollama 默认随登录启动；若 AI 不回复，先 `curl http://127.0.0.1:11434/api/tags` 确认 Ollama 活着。

## 形态二：Docker（仅监听模式）

容器内没有 Chrome 与桌面环境，**浏览器托管（自动发弹幕、自动点赞）不可用**；截图留档也不可用。适合：长期监听 + 统计 + 网页控制台 + 礼物挂件。

```bash
npm run setup -- --room 你的房间号   # 先在宿主机生成 config.json
docker compose up -d --build
```

- 端口只发布到宿主机回环：`127.0.0.1:4322`。
- `./config.json` 与 `./state` 挂载进容器，数据与宿主机共享。
- 要在容器里用 AI：把 `config.json` 的 `localAi.endpoint` 改为 `http://host.docker.internal:11434`。
- 容器模式不作为真实发送方案维护；需要发送或点赞时使用本机浏览器托管。

## Linux（参考）

代码本身可在 Linux 跑（监听 + Cookie 发送 + AI + 挂件生成需装 chromium 供 playwright 使用）。常驻建议 systemd：

```ini
[Unit]
Description=bilibili-live-bot
After=network-online.target

[Service]
WorkingDirectory=/opt/bilibili-live-bot
ExecStart=/usr/bin/node src/webServer.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

## 升级流程

```bash
git pull
npm install
npm test && npm run verify
npm run service:install   # 重装并重启服务
```

配置兼容性：新版本新增的配置键都有内置默认值，旧 `config.json` 不改也能启动；启动日志会提示需要注意的配置项。
