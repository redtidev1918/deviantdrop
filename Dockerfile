# DeviantDrop - Node 版运行时
FROM node:22-alpine

WORKDIR /app

# 只装运行时依赖（undici），wrangler 等开发工具不进镜像
#
# 国内 VPS 只能经本机代理（127.0.0.1:7890）出网；compose build 的构建容器
# 不继承 SSH shell 的 HTTP(S)_PROXY，一旦这一层缓存失效，npm 直连 registry
# 会 ETIMEDOUT（2026-09-13 实测 241s 后失败）。下面是 Docker 预定义代理
# ARG：buildkit 自动注入为该 RUN 的 *_proxy 环境变量；空默认值保证无代理
# 环境（CI、海外机器）行为不变。它们只在构建期存在，不进运行时镜像 ENV。
ARG HTTP_PROXY=""
ARG HTTPS_PROXY=""
ARG NO_PROXY=""
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
# 运行时 secret 的写入端：容器内 node scripts/dd-token.mjs set telegram
COPY scripts/dd-token.mjs ./scripts/dd-token.mjs
COPY README.md ./

# 缓存目录与认证文件由 named volume 持久化（/data/cache.json、/data/auth/*.json），容器重建后仍可复用。
RUN mkdir -p /data/auth && chown -R node:node /data

# 以非 root 运行（镜像自带 node 用户）
USER node

ENV NODE_ENV=production
CMD ["node", "src/main.js"]
