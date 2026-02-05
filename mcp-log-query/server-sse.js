/**
 * Log Query MCP Server - SSE/HTTP 模式
 * 
 * 支持通过 HTTP 和 Server-Sent Events 与 MCP 客户端通信
 * 适用于 Docker 部署
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express from 'express';
import cors from 'cors';
import { findService, getAllServices, DEFAULTS } from './config.js';
import { queryLog, testConnection } from './ssh-client.js';

const app = express();
const PORT = process.env.PORT || 3100;

// 启用 CORS
app.use(cors());
app.use(express.json());

// 存储活跃的 SSE 连接
const transports = {};

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'mcp-log-query' });
});

// SSE 端点 - 客户端连接
app.get('/sse', async (req, res) => {
  console.log('[SSE] 新客户端连接');

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  // 生成 sessionId
  const sessionId = Date.now().toString();

  // 创建 SSE transport，传入 sessionId
  const transport = new SSEServerTransport(`/message?sessionId=${sessionId}`, res);
  transports[sessionId] = transport;

  // 创建 MCP Server
  const server = new McpServer({
    name: 'mcp-log-query',
    version: '1.0.0'
  });

  // 注册工具
  registerTools(server);

  // 连接 transport
  try {
    await server.connect(transport);
    console.log(`[SSE] 客户端已连接, sessionId: ${sessionId}`);
  } catch (err) {
    console.error('[SSE] 连接错误:', err);
  }

  // 保持连接活跃 - 每 30 秒发送心跳
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': heartbeat\n\n');
    }
  }, 30000);

  // 清理断开的连接
  res.on('close', () => {
    console.log(`[SSE] 客户端断开, sessionId: ${sessionId}`);
    clearInterval(heartbeat);
    delete transports[sessionId];
  });
});

// 消息端点 - 接收客户端请求
app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  
  if (!transport) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  
  await transport.handlePostMessage(req, res);
});

/**
 * 注册 MCP 工具
 */
function registerTools(server) {
  // query_log 工具
  server.tool('query_log', {
    description: '查询服务容器的日志文件。返回最近的日志内容。',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: '服务名称，如 clife-senior-health、clife-senior-archive，或别名如 health、archive'
        },
        lines: {
          type: 'number',
          description: '返回的日志行数，默认 100',
          default: 100
        }
      },
      required: ['service']
    }
  }, async (args) => {
    const service = findService(args.service);
    if (!service) {
      return { content: [{ type: 'text', text: `错误: 未找到服务 "${args.service}"` }] };
    }
    
    const lines = args.lines || DEFAULTS.lines;
    const command = `tail -${lines}`;
    
    console.log(`[MCP] 查询日志: ${service.name}`);
    const result = await queryLog(service, command);
    
    return {
      content: [{
        type: 'text',
        text: `## ${service.name} 日志 (最近 ${lines} 行)\n\n\`\`\`\n${result}\n\`\`\``
      }]
    };
  });
  
  // search_log 工具
  server.tool('search_log', {
    description: '在服务日志中搜索关键词',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: '服务名称或别名' },
        keyword: { type: 'string', description: '搜索关键词' },
        context_lines: { type: 'number', description: '上下文行数', default: 5 },
        case_sensitive: { type: 'boolean', description: '区分大小写', default: false }
      },
      required: ['service', 'keyword']
    }
  }, async (args) => {
    const service = findService(args.service);
    if (!service) {
      return { content: [{ type: 'text', text: `错误: 未找到服务 "${args.service}"` }] };
    }
    
    const grepFlags = args.case_sensitive ? '' : '-i';
    const contextLines = args.context_lines || 5;
    const command = `grep ${grepFlags} -C ${contextLines} "${args.keyword}"`;
    
    console.log(`[MCP] 搜索日志: ${service.name}, 关键词: ${args.keyword}`);
    const result = await queryLog(service, command);
    
    return {
      content: [{
        type: 'text',
        text: `## ${service.name} 日志搜索结果\n\n**关键词**: ${args.keyword}\n\n\`\`\`\n${result || '未找到匹配内容'}\n\`\`\``
      }]
    };
  });
  
  // list_services 工具
  server.tool('list_services', {
    description: '列出所有可查询日志的服务',
    inputSchema: { type: 'object', properties: {} }
  }, async () => {
    const services = getAllServices();
    const text = services.map(s => 
      `- **${s.name}**: ${s.description}\n  别名: ${s.aliases.join(', ')}`
    ).join('\n');
    
    return { content: [{ type: 'text', text: `## 可用服务\n\n${text}` }] };
  });
  
  // test_connection 工具
  server.tool('test_connection', {
    description: '测试 SSH 连接',
    inputSchema: { type: 'object', properties: {} }
  }, async () => {
    const result = await testConnection();
    return {
      content: [{
        type: 'text',
        text: result.success ? '✅ SSH 连接正常' : `❌ 连接失败: ${result.error}`
      }]
    };
  });
}

// 启动服务器
app.listen(PORT, () => {
  console.log(`[MCP] Log Query Server (SSE) 已启动，端口: ${PORT}`);
  console.log(`[MCP] SSE 端点: http://localhost:${PORT}/sse`);
  console.log(`[MCP] 健康检查: http://localhost:${PORT}/health`);
});

