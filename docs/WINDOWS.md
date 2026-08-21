# Windows 迁移与使用

## 最简单的用法

先把整个项目目录从 U 盘复制到 Windows 本机磁盘，例如 `D:\直播机器人`。不要直接在 U 盘上长期运行，避免拔盘或 FAT32 写入中断损坏历史文件。

依次双击：

1. `WINDOWS-4-VERIFY.cmd`：校验便携包文件；Git 源码检出没有清单时可跳过。
2. `WINDOWS-1-SETUP.cmd`：安装依赖、生成或检查配置并运行测试。
3. `WINDOWS-2-START.cmd`：启动 `http://127.0.0.1:4322`。
4. 在网页中点“打开 B站并登录”，完成 Windows 上的首次登录。

需要 Qwen 时，先从 <https://ollama.com/download/windows> 安装 Ollama，再双击 `WINDOWS-3-INSTALL-AI.cmd`。Ollama 要求 Windows 10 22H2 或更新版本，程序安装至少预留 4 GB，Qwen 模型还会另占数 GB。

## 便携包包含什么

- 当前项目源代码、前端和文档。
- 可选的 Windows x64 便携 Node.js。
- 可选的 npm 离线缓存；首次安装无需访问 npm。
- 私人迁移包可包含礼物、弹幕、积分、点赞额度、挂件和导出历史。

以下内容不会从 macOS 迁移：

- 浏览器登录 Profile：跨系统不可用，且包含敏感登录数据。
- B站 Cookie 文件：避免明文凭据进入 U 盘包。
- macOS `node_modules`、launchd、日志、缓存和临时截图。
- Ollama 模型：Windows 通过安装 AI 脚本重新下载。

## Windows 功能边界

- 监听、Web 控制台、Chrome/Edge 登录托管、自动回复、有限额点赞、Ollama/Qwen、礼物静态图和浏览器挂件均可运行。
- 透明 GIF/WebM 文件导出需要另装 FFmpeg，并确保 `ffmpeg.exe`、`ffprobe.exe` 在 PATH。
- 系统窗口截图留档目前只实现了 macOS `screencapture`，Windows 会明确跳过，不影响机器人其他功能。
- `npm run service:*` 是 macOS launchd 命令，Windows 不要执行；Windows 关闭启动窗口即停止本次前台服务。

## 切换电脑的安全顺序

1. Windows 先在安全模式完成文件校验、安装和页面打开。
2. 停止旧 Mac 上的机器人。
3. Windows 重新登录 B站。
4. 逐项开启 AI、主动互动和点赞。
5. 确认只剩一台电脑在操作同一个 B站账号。

## 排障

- 提示找不到 Node：使用带 `runtime/node` 的便携包，或安装 Node.js 20 以上。
- 提示找不到浏览器：确认 Google Chrome 或 Microsoft Edge 安装在默认目录，然后重新运行启动脚本。
- AI 暂时断开：先启动 Ollama，再运行 `WINDOWS-3-INSTALL-AI.cmd`。
- 端口 4322 被占用：关闭旧的机器人窗口，或在任务管理器中结束旧 `node.exe`。
- 路径包含中文和空格没有关系；四个 CMD 都会从自身目录启动。
