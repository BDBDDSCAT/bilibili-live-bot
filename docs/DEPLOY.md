# 部署指南

## 形态一：Windows 本机便携运行

从发布包迁移时，先把整个目录复制到本机磁盘；不要直接从 U 盘长期运行。双击：

1. `WINDOWS-4-VERIFY.cmd`（带校验清单的便携包）确认文件未损坏。
2. `WINDOWS-1-SETUP.cmd` 安装依赖并运行测试。
3. `WINDOWS-2-START.cmd` 启动工作台。
4. 在网页里点“打开 B站并登录”，Windows 必须建立自己的浏览器登录资料。
5. AI 需要先安装 Ollama，再运行 `WINDOWS-3-INSTALL-AI.cmd`。

要求：64 位 Windows 10/11，以及 Google Chrome 或 Microsoft Edge。源码检出若没有随包的 `runtime/node`，还需要 Node.js 20 以上。AI 功能所需的 Ollama 要求 Windows 10 22H2 或更新版本，安装程序至少预留 4 GB，模型需另外空间。动态 GIF/WebM 导出另需 FFmpeg/ffprobe 在 PATH；Windows 暂不支持 macOS 风格的系统截图留档。

不要让 macOS 与 Windows 两台机器同时开启自动发送或自动点赞，同一账号会产生重复动作。迁移包不会携带 macOS 浏览器 Profile 或 Cookie，必须重新登录。

## 形态二：macOS 本机常驻（推荐，全功能）

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

## 形态三：Docker（仅监听模式）

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
