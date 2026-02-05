# Log Query MCP Server Docker Image
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 安装依赖
COPY package.json ./
RUN npm install --production

# 复制源代码
COPY *.js ./

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3100

# 暴露 SSE 端口
EXPOSE 3100

# 健康检查
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3100/health || exit 1

# 启动 SSE 模式
CMD ["node", "server-sse.js"]

