FROM node:22-alpine

WORKDIR /app

# 先裝相依，利用 layer cache
COPY package.json package-lock.json ./
RUN npm ci

# 編譯 TypeScript
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# 預設啟動 batch-creator，compose 中各服務以 command 覆寫
CMD ["node", "dist/services/batch-creator/index.js"]
