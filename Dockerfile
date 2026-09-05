# DeviantDrop - Node 版运行时
FROM node:22-alpine

WORKDIR /app

# 只装运行时依赖（undici），wrangler 等开发工具不进镜像
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY README.md ./

ENV NODE_ENV=production
CMD ["node", "src/main.js"]
