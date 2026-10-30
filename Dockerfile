# ARRR DataBridge API — image Railway (Node 22, tanpa dependensi sistem tambahan)
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV NODE_ENV=production
EXPOSE 8080
CMD ["npm", "start"]
