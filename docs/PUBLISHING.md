# GitHub 发布流程

## 为什么不能直接推现有开发仓库

如果旧提交曾包含真实观众昵称、UID、头像、截图或礼物长图，即使最新版已经删除，Git 历史仍会携带它们。安全做法是保留本地开发仓库，再导出一个全新历史的公开副本。

## 导出

先在开发仓库完成并提交变更，然后运行：

```bash
npm run check
npm run public:export -- --target ../bilibili-live-bot-public
```

导出器只复制当前 Git 跟踪文件，先执行隐私门禁，再在目标目录创建新的 `main` 分支和单一初始提交。目标目录必须不存在，防止覆盖已有文件。公开初始提交默认使用隐私友好的 noreply 地址；如需绑定自己的 GitHub 身份，可在导出前设置 `PUBLIC_GIT_NAME` 和 `PUBLIC_GIT_EMAIL`。

## 发布前复核

在公开副本中运行：

```bash
npm ci
npm run check
git log --oneline --all
git status --short
```

确认只有一个干净的公开初始提交，并再次人工搜索真实身份、房间号、Cookie 和截图。之后再自行创建 GitHub 仓库并推送；本项目不会自动创建远程仓库或上传代码。

## 版本建议

首次公开可标记为 `v0.1.0`，待真实用户验证安装、监听、浏览器托管与卸载流程后再发布 `v1.0.0`。Release Notes 应明确默认只监听，以及自动发送/点赞可能受平台规则和账号风控影响。
