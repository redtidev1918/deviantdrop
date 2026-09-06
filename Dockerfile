# DeviantDrop - Node 版运行时
FROM node:22-alpine

WORKDIR /app

# 只装运行时依赖（undici），wrangler 等开发工具不进镜像
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./

# 缓存目录与认证文件由 named volume 持久化（/data/cache.json、/data/auth/*.json），容器重建后仍可复用。
RUN mkdir -p /data/auth && chown -R node:node /data

# 以非 root 运行（镜像自带 node 用户）
USER node

ENV NODE_ENV=production
CMD ["node", "src/main.js"]
