# MCP Services Collection

一组用于 AI 编程助手的 MCP (Model Context Protocol) 服务集合。

## 📦 包含的服务

### 1. mcp-log-query
通过 SSH 堡垒机查询 Kubernetes 容器日志的 MCP Server。

**功能：**
- 查询服务容器日志
- 搜索日志关键词
- 列出可用服务
- 测试 SSH 连接
- 根据 traceId 追踪调用链
- 查看 Pod 状态和事件

### 2. sequential-thinking-mcp
顺序思考 MCP 服务，帮助 AI 进行结构化的思考过程。

## 🚀 快速开始

### 前置要求
- Node.js 18+
- npm 或 yarn

### 安装

```bash
# 克隆仓库
git clone https://github.com/YOUR_USERNAME/mcp-services.git
cd mcp-services

# 安装 mcp-log-query 依赖
cd mcp-log-query
npm install

# 安装 sequential-thinking-mcp 依赖
cd ../sequential-thinking-mcp
npm install
npm run build
```

### 配置

#### mcp-log-query 配置

在 MCP 配置的 `env` 中填写你的服务器信息：

```json
{
  "mcpServers": {
    "log-query": {
      "command": "node",
      "args": ["D:\\path\\to\\mcp-log-query\\index.js"],
      "env": {
        "MCP_JUMP_HOST": "你的堡垒机IP",
        "MCP_JUMP_PORT": "22",
        "MCP_JUMP_USERNAME": "你的用户名",
        "MCP_JUMP_PASSWORD": "你的密码",
        "MCP_K8S_HOST": "你的K8s服务器IP",
        "MCP_K8S_SELECT": "1"
      }
    }
  }
}
```

| 环境变量 | 说明 | 必填 |
|----------|------|------|
| `MCP_JUMP_HOST` | 堡垒机 IP 地址 | ✅ |
| `MCP_JUMP_PORT` | 堡垒机 SSH 端口 | 默认 22 |
| `MCP_JUMP_USERNAME` | 堡垒机用户名 | ✅ |
| `MCP_JUMP_PASSWORD` | 堡垒机密码 | ✅ |
| `MCP_K8S_HOST` | K8s 服务器 IP | ✅ |
| `MCP_K8S_SELECT` | 服务器选择选项 | 默认 1 |

### 在 VSCode/Augment 中使用

在 VSCode 设置中添加 MCP Server 配置：

```json
{
  "augment.advanced": {
    "mcpServers": [
      {
        "name": "log-query",
        "command": "node",
        "args": ["/path/to/mcp-services/mcp-log-query/index.js"]
      },
      {
        "name": "sequential-thinking",
        "command": "node",
        "args": ["/path/to/mcp-services/sequential-thinking-mcp/dist/index.js"]
      }
    ]
  }
}
```

## 📖 详细文档

- [mcp-log-query 文档](./mcp-log-query/README.md)

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 License

MIT License

