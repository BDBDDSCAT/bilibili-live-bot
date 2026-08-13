# 参与贡献

## 本地开发

```bash
npm ci
npm test
npm run verify
npm run public:audit
```

Node.js 版本要求见 `package.json`。提交前请保证 `npm run check` 全绿。

## 数据与隐私

- 不要提交真实 Cookie、UID、昵称、头像、房间历史、日志、截图或礼物长图。
- 回归样本必须是合成或充分脱敏的数据，并在说明中写清来源。
- 修复监听解析时请同时提供最小 fixture；修复发送逻辑时默认使用 `dryRun`，不要在测试中真实发弹幕或点赞。

## 代码约定

- 保持 CommonJS 与 Node.js 内置测试框架，除非变更确有必要。
- 配置新增项必须同时补：安全默认值、`config.example.json`、`docs/CONFIG.md` 和测试。
- 自动化必须可关闭、有限额、有日志，并在最终执行前重新检查直播状态。

## Pull Request

PR 请包含：问题、改动、验证命令、风险和隐私检查结果。不要把本机生成的 `state/` 或 `artifacts/` 作为附件提交。
