# Log Query MCP Server

通过 SSH 堡垒机查询 Kubernetes 容器日志的 MCP Server。

## 功能

- **query_log**: 查询服务容器的最近日志
- **search_log**: 在日志中搜索关键词
- **list_services**: 列出可用服务
- **test_connection**: 测试 SSH 连接

## 安装

```bash
cd mcp-log-query
npm install
```

## 配置

### 1. 修改服务器配置

编辑 `config.js` 文件，配置：

- `JUMP_HOST`: 堡垒机连接信息
- `K8S_SERVER`: K8s 服务器信息
- `SERVICES`: 服务/容器映射

### 2. 添加到 VSCode MCP 配置

在 VSCode 设置中添加 MCP Server 配置：

**方式一：settings.json**

```json
{
  "augment.advanced": {
    "mcpServers": [
      {
        "name": "log-query",
        "command": "node",
        "args": ["D:/project/main/aug2api-master/mcp-log-query/index.js"],
        "env": {}
      }
    ]
  }
}
```

**方式二：mcp.json**

在项目根目录创建 `.augment/mcp.json`：

```json
{
  "mcpServers": {
    "log-query": {
      "command": "node",
      "args": ["./mcp-log-query/index.js"]
    }
  }
}
```

## 使用示例

### 查询日志

```
帮我查一下 clife-senior-health 的最近 200 行日志
```

AI 会调用：
```json
{
  "tool": "query_log",
  "arguments": {
    "service": "clife-senior-health",
    "lines": 200
  }
}
```

### 搜索错误

```
搜索 health 服务的 error 日志
```

AI 会调用：
```json
{
  "tool": "search_log",
  "arguments": {
    "service": "health",
    "keyword": "error"
  }
}
```

### 列出服务

```
有哪些服务可以查日志？
```

AI 会调用：
```json
{
  "tool": "list_services",
  "arguments": {}
}
```

## 添加新服务

在 `config.js` 的 `SERVICES` 对象中添加：

```javascript
'new-service': {
  name: 'new-service',
  description: '新服务描述',
  namespace: 'saas-itest',
  podPattern: 'new-service-app',
  logPath: '/www/logs/new-service-app/normal_logs/',
  aliases: ['new', '新服务']
}
```

## 故障排除

### 连接超时

1. 检查网络是否能访问堡垒机
2. 确认堡垒机账号密码正确
3. 增加 `DEFAULTS.connectTimeout` 值

### 命令执行失败

1. 确认 K8s 服务器 IP 正确
2. 确认 Pod 名称模式正确
3. 确认日志路径存在

### 调试模式

运行时查看 stderr 输出：

```bash
node index.js 2>&1
```

