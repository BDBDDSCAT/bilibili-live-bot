# 仅监听模式镜像：容器里没有 Chrome，也连不到宿主机的登录浏览器，
# 所以浏览器托管（自动发弹幕/自动点赞）在容器里不可用；本地 AI 需要
# 在配置里把 localAi.endpoint 指向 host.docker.internal:11434。
# 完整功能（发送/点赞/AI/截图）请直接在 macOS 上 npm start，见 docs/DEPLOY.md。
FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p state/raw state/events state/snapshots state/secrets state/logs

EXPOSE 4322

CMD ["node", "src/webServer.js", "--host", "0.0.0.0", "--port", "4322", "--allow-remote"]
