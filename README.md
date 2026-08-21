# Bilibili Live Bot

一个本地优先的 B 站直播间机器人与主播控制台。它可以监听弹幕、礼物、SC、大航海和 PK；在使用者明确开启后，通过本机 Chrome 或 Edge 发送弹幕、点赞，并调用本地 Ollama/Qwen 做互动；同时提供礼物历史、积分、透明 OBS 挂件和可审计礼物长图工具。

> 默认配置只监听，不发送、不点赞、不启动 AI。任何会对直播间产生动作的功能都需要使用者自行开启，并应遵守 B 站规则及适用法律。

## 功能

- 实时监听弹幕、进房、礼物、SC、大航海、点赞、PK 和系统通知
- 浏览器登录托管、弹幕发送、直播状态门禁和有限额点赞
- Ollama 本地模型回复、被艾特优先回复、40 字长度 gate、主动互动开关
- 欢迎、礼物感谢、PK 查询、积分签到与互动命令
- 透明 PNG/GIF/WebM OBS 挂件和静态礼物长图
- JSONL 事件历史、原始包审计、快照恢复、保留期清理
- Web 控制台、健康状态、macOS launchd 常驻和 Docker 监听模式
- Windows 双击安装/启动、Chrome/Edge 自动发现和 Ollama 自动恢复

## 快速开始

要求：Node.js 20 或更高版本。浏览器托管需要 Google Chrome 或 Microsoft Edge；AI 需要 [Ollama](https://ollama.com) 和本地模型。

```bash
git clone https://github.com/BDBDDSCAT/bilibili-live-bot.git
cd bilibili-live-bot
npm ci
npm run setup -- --room 你的房间号
npm start
```

打开 <http://127.0.0.1:4322>。首次生成的 `config.json` 采用安全模板：只监听和记录，不会自动向 B 站发送内容。需要浏览器托管时，在控制台中显式启动并登录；需要 AI 时，先执行：

```bash
ollama pull qwen3.5:4b
```

然后在控制台中开启“弹幕 / AI 互动”。页面功能开关会一次性持久化它依赖的后端配置；配置校验或写盘失败时不会留下半开状态。不要提交 `config.json`。

### Windows 快速开始

Windows 便携包可直接双击：

1. `WINDOWS-1-SETUP.cmd`：安装依赖并验证项目。
2. `WINDOWS-2-START.cmd`：启动工作台并自动打开浏览器。
3. 第一次在网页中点“打开 B站并登录”，重新登录一次。
4. 需要本地 AI 时安装 Ollama，再双击 `WINDOWS-3-INSTALL-AI.cmd` 下载 `qwen3.5:4b`。

便携包若带有 `runtime/node` 和 `runtime/npm-cache`，安装依赖不需要另装 Node，也不需要联网访问 npm。完整说明见 [docs/WINDOWS.md](docs/WINDOWS.md)。

## 日常使用

1. 运行 `npm start`；Windows 可双击 `WINDOWS-2-START.cmd`，macOS 可执行 `npm run service:install` 安装常驻服务。
2. 打开控制台，填写或切换直播间。
3. 只需要记录数据时保持默认设置。
4. 需要发送时，点“打开 B站并登录”；这一次明确操作会授权当前浏览器托管，实际动作仍受登录、目标房间、开播状态和各功能开关限制。
5. OBS 挂件可从控制台复制浏览器源地址或导出透明文件。

macOS 停止常驻服务：`npm run service:uninstall`；查看状态：`npm run service:status`。Windows 前台运行时关闭启动窗口即可停止。

## 配置与本地数据

- `config.example.json`：安全模板，可公开。
- `config.json`：真实房间和开关，Git 忽略。
- `state/`：登录资料、事件、日志、快照与挂件，Git 忽略。
- `artifacts/`、`screenshots/`：包含观众资料的生成物，Git 忽略。

全部配置见 [docs/CONFIG.md](docs/CONFIG.md)，部署见 [docs/DEPLOY.md](docs/DEPLOY.md)，排障见 [docs/OPERATIONS.md](docs/OPERATIONS.md)，隐私边界见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 验证

```bash
npm test
npm run verify
npm run public:audit
```

一次执行全部门禁：

```bash
npm run check
```

`npm run verify` 只使用仓库内的脱敏固定样本和临时目录，不读取生产 `state/`。

## 部署形态

- macOS 本机：完整功能，支持 Chrome、Ollama、截图和 launchd。
- Windows 本机：支持 Chrome/Edge 托管、Ollama/Qwen、监听、发送、点赞和挂件；系统截图留档暂不支持。
- Docker：默认只用于监听、统计和 Web 控制台；容器内没有桌面 Chrome。
- Linux：监听、AI 和 Web 可用；浏览器相关能力取决于本机 Chromium 环境。

服务默认绑定 `127.0.0.1` 且没有 Web 登录系统。不要把 `--allow-remote` 暴露到不可信网络。

## 公开发布

若开发仓库历史中曾出现真实观众资料，不要直接推送。使用：

```bash
npm run check
npm run public:export -- --target ../bilibili-live-bot-public
```

它会创建一个没有旧历史的公开副本。完整流程见 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 贡献与许可

贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。项目使用 [MIT License](LICENSE)。Bilibili、Ollama 和 Qwen 是其各自权利人的商标或项目，本仓库与这些平台没有官方从属关系。
