#!/usr/bin/env node

/**
 * Log Query MCP Server
 *
 * 提供以下工具：
 * - query_log: 查询服务日志
 * - search_log: 搜索日志关键词
 * - list_services: 列出可用服务
 * - test_connection: 测试 SSH 连接
 * - list_pods: 列出 pods 及状态
 * - describe_pod: 获取 pod 详情
 * - get_pod_logs: 获取 pod 日志
 * - get_events: 获取 namespace 事件
 * - trace_log: 根据 traceId 跨服务查询日志
 * - detect_context: 根据工作目录自动检测 namespace 和服务
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { queryLog, testConnection, executeKubectl } from './ssh-client.js';
import { findService, getAllServices, DEFAULTS, DEFAULT_NAMESPACE, SERVICES, NAMESPACES, detectContextFromPath } from './config.js';

// 创建 MCP Server
const server = new Server(
  {
    name: 'mcp-log-query',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 定义工具列表
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'query_log',
        description: '查询服务容器的日志文件。返回最近的日志内容。',
        inputSchema: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: '服务名称，如 clife-senior-health、clife-senior-archive，或别名如 health、archive'
            },
            namespace: {
              type: 'string',
              description: 'K8s namespace，如 saas-itest、whood-itest。不指定则使用服务默认配置'
            },
            lines: {
              type: 'number',
              description: '返回的日志行数，默认 100',
              default: 100
            }
          },
          required: ['service']
        }
      },
      {
        name: 'search_log',
        description: '在服务日志中搜索关键词。支持正则表达式。',
        inputSchema: {
          type: 'object',
          properties: {
            service: {
              type: 'string',
              description: '服务名称或别名'
            },
            namespace: {
              type: 'string',
              description: 'K8s namespace，如 saas-itest、whood-itest。不指定则使用服务默认配置'
            },
            keyword: {
              type: 'string',
              description: '搜索关键词，支持正则表达式'
            },
            context_lines: {
              type: 'number',
              description: '显示匹配行前后的上下文行数，默认 5',
              default: 5
            },
            case_sensitive: {
              type: 'boolean',
              description: '是否区分大小写，默认 false',
              default: false
            }
          },
          required: ['service', 'keyword']
        }
      },
      {
        name: 'list_services',
        description: '列出所有可查询日志的服务',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'test_connection',
        description: '测试到堡垒机的 SSH 连接是否正常',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      // ========== 新增 K8s 工具 ==========
      {
        name: 'list_pods',
        description: '列出指定 namespace 的所有 pods 及其状态，用于快速定位问题 pod',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: {
              type: 'string',
              description: 'K8s namespace，默认 saas-itest',
              default: 'saas-itest'
            },
            label: {
              type: 'string',
              description: '标签选择器，如 app=clife-senior-health'
            }
          }
        }
      },
      {
        name: 'describe_pod',
        description: '获取 pod 详细信息，包括事件、状态、退出码等，用于排查 pod 崩溃原因',
        inputSchema: {
          type: 'object',
          properties: {
            pod: {
              type: 'string',
              description: 'Pod 名称或名称模式（支持部分匹配）'
            },
            namespace: {
              type: 'string',
              description: 'K8s namespace，默认 saas-itest',
              default: 'saas-itest'
            }
          },
          required: ['pod']
        }
      },
      {
        name: 'get_pod_logs',
        description: '获取 pod 日志，支持查看崩溃前的日志（--previous）',
        inputSchema: {
          type: 'object',
          properties: {
            pod: {
              type: 'string',
              description: 'Pod 名称或名称模式'
            },
            namespace: {
              type: 'string',
              description: 'K8s namespace，默认 saas-itest',
              default: 'saas-itest'
            },
            previous: {
              type: 'boolean',
              description: '是否查看上一个容器的日志（崩溃前日志），默认 false',
              default: false
            },
            tail: {
              type: 'number',
              description: '返回的日志行数，默认 100',
              default: 100
            }
          },
          required: ['pod']
        }
      },
      {
        name: 'get_events',
        description: '获取 namespace 级别的 K8s 事件，用于排查集群问题',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: {
              type: 'string',
              description: 'K8s namespace，默认 saas-itest',
              default: 'saas-itest'
            },
            pod: {
              type: 'string',
              description: '过滤指定 pod 的事件（可选）'
            }
          }
        }
      },
      {
        name: 'trace_log',
        description: '根据 traceId 跨服务查询日志，用于追踪完整调用链',
        inputSchema: {
          type: 'object',
          properties: {
            traceId: {
              type: 'string',
              description: '链路追踪 ID'
            },
            namespace: {
              type: 'string',
              description: 'K8s namespace，如 saas-itest、whood-itest。不指定则使用服务默认配置'
            },
            services: {
              type: 'array',
              items: { type: 'string' },
              description: '要搜索的服务列表，不指定则搜索所有服务'
            },
            context_lines: {
              type: 'number',
              description: '显示匹配行前后的上下文行数，默认 3',
              default: 3
            }
          },
          required: ['traceId']
        }
      },
      // ========== 上下文检测工具 ==========
      {
        name: 'detect_context',
        description: '根据当前工作目录自动检测对应的 namespace 和服务名。AI 可以先调用此工具获取上下文，再调用 query_log 等工具时传入正确的 namespace。',
        inputSchema: {
          type: 'object',
          properties: {
            workspace_path: {
              type: 'string',
              description: '当前工作目录路径，如 D:\\shulian\\whood\\clife-senior-mall 或 /home/user/shulian/saas/clife-senior-health'
            }
          },
          required: ['workspace_path']
        }
      }
    ]
  };
});
// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'query_log': {
        // 支持传入 namespace 参数覆盖默认值
        const service = findService(args.service, args.namespace);
        if (!service) {
          return {
            content: [{
              type: 'text',
              text: `错误: 未找到服务 "${args.service}"。使用 list_services 查看可用服务。`
            }]
          };
        }

        const lines = args.lines || DEFAULTS.lines;
        const command = `tail -${lines}`;

        console.error(`[MCP] 查询日志: ${service.name} (namespace: ${service.namespace}), 命令: ${command}`);
        const result = await queryLog(service, command);

        return {
          content: [{
            type: 'text',
            text: `## ${service.name} 日志 (namespace: ${service.namespace}, 最近 ${lines} 行)\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      case 'search_log': {
        // 支持传入 namespace 参数覆盖默认值
        const service = findService(args.service, args.namespace);
        if (!service) {
          return {
            content: [{
              type: 'text',
              text: `错误: 未找到服务 "${args.service}"。使用 list_services 查看可用服务。`
            }]
          };
        }

        const keyword = args.keyword;
        const contextLines = args.context_lines || 5;
        const caseSensitive = args.case_sensitive || false;

        const grepFlags = caseSensitive ? '' : '-i';
        const command = `grep ${grepFlags} -C ${contextLines} "${keyword}"`;

        console.error(`[MCP] 搜索日志: ${service.name} (namespace: ${service.namespace}), 关键词: ${keyword}`);
        const result = await queryLog(service, command);

        return {
          content: [{
            type: 'text',
            text: `## ${service.name} 日志搜索结果 (namespace: ${service.namespace})\n\n**关键词**: ${keyword}\n\n\`\`\`\n${result || '未找到匹配内容'}\n\`\`\``
          }]
        };
      }

      case 'list_services': {
        const services = getAllServices();
        const list = services.map(s =>
          `- **${s.name}**: ${s.description}\n  别名: ${s.aliases.join(', ')}`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: `## 可用服务列表\n\n${list}`
          }]
        };
      }

      case 'test_connection': {
        console.error('[MCP] 测试 SSH 连接');
        const result = await testConnection();

        return {
          content: [{
            type: 'text',
            text: `## SSH 连接测试\n\n✅ ${result.message}`
          }]
        };
      }

      // ========== 新增 K8s 工具处理 ==========
      case 'list_pods': {
        const namespace = args.namespace || DEFAULT_NAMESPACE;
        let cmd = `kubectl get pods -n ${namespace} -o wide`;
        if (args.label) {
          cmd += ` -l ${args.label}`;
        }

        console.error(`[MCP] 列出 pods: namespace=${namespace}`);
        const result = await executeKubectl(cmd);

        return {
          content: [{
            type: 'text',
            text: `## Pods 列表 (namespace: ${namespace})\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      case 'describe_pod': {
        const namespace = args.namespace || DEFAULT_NAMESPACE;
        const podPattern = args.pod;

        // 先查找匹配的 pod
        const findCmd = `kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1`;
        console.error(`[MCP] 查找 pod: ${podPattern}`);
        
        const describeCmd = `kubectl describe $(kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1) -n ${namespace}`;
        const result = await executeKubectl(describeCmd);

        return {
          content: [{
            type: 'text',
            text: `## Pod 详情: ${podPattern}\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      case 'get_pod_logs': {
        const namespace = args.namespace || DEFAULT_NAMESPACE;
        const podPattern = args.pod;
        const previous = args.previous || false;
        const tail = args.tail || 100;

        let cmd = `kubectl logs $(kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1) -n ${namespace} --tail=${tail}`;
        if (previous) {
          cmd += ' --previous';
        }

        console.error(`[MCP] 获取 pod 日志: ${podPattern}, previous=${previous}`);
        const result = await executeKubectl(cmd);

        const logType = previous ? '崩溃前日志' : '当前日志';
        return {
          content: [{
            type: 'text',
            text: `## Pod 日志: ${podPattern} (${logType})\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      case 'get_events': {
        const namespace = args.namespace || DEFAULT_NAMESPACE;
        let cmd = `kubectl get events -n ${namespace} --sort-by='.lastTimestamp'`;
        
        if (args.pod) {
          cmd = `kubectl get events -n ${namespace} --field-selector involvedObject.name=${args.pod} --sort-by='.lastTimestamp'`;
        }

        console.error(`[MCP] 获取事件: namespace=${namespace}`);
        const result = await executeKubectl(cmd);

        return {
          content: [{
            type: 'text',
            text: `## K8s 事件 (namespace: ${namespace})\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      case 'trace_log': {
        const traceId = args.traceId;
        const contextLines = args.context_lines || 3;
        const targetNamespace = args.namespace || null;  // 支持指定 namespace
        let servicesToSearch = args.services || [];

        // 如果没有指定服务，搜索所有服务
        if (servicesToSearch.length === 0) {
          servicesToSearch = Object.keys(SERVICES);
        } else {
          // 解析服务别名
          servicesToSearch = servicesToSearch.map(s => {
            const service = findService(s, targetNamespace);
            return service ? service.name : s;
          }).filter(Boolean);
        }

        console.error(`[MCP] 追踪日志: traceId=${traceId}, namespace=${targetNamespace || 'default'}, 服务数=${servicesToSearch.length}`);

        const results = [];
        for (const serviceName of servicesToSearch) {
          // 使用 findService 获取服务配置，支持 namespace 覆盖
          const service = findService(serviceName, targetNamespace);
          if (!service) continue;

          try {
            const command = `grep -i -C ${contextLines} "${traceId}"`;
            const result = await queryLog(service, command);

            if (result && result.trim() && !result.includes('未找到')) {
              results.push({
                service: serviceName,
                namespace: service.namespace,
                logs: result
              });
            }
          } catch (err) {
            // 忽略单个服务的错误，继续搜索其他服务
            console.error(`[MCP] 搜索 ${serviceName} 失败: ${err.message}`);
          }
        }

        if (results.length === 0) {
          return {
            content: [{
              type: 'text',
              text: `## TraceId 追踪结果\n\n**traceId**: ${traceId}\n**namespace**: ${targetNamespace || '默认'}\n\n❌ 未在任何服务中找到匹配的日志`
            }]
          };
        }

        const output = results.map(r =>
          `### ${r.service} (${r.namespace})\n\`\`\`\n${r.logs}\n\`\`\``
        ).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `## TraceId 追踪结果\n\n**traceId**: ${traceId}\n**namespace**: ${targetNamespace || '默认'}\n**匹配服务数**: ${results.length}\n\n${output}`
          }]
        };
      }

      case 'detect_context': {
        const workspacePath = args.workspace_path;
        const result = detectContextFromPath(workspacePath);

        if (!result.success) {
          return {
            content: [{
              type: 'text',
              text: `## 上下文检测失败\n\n**错误**: ${result.error}\n**默认 namespace**: ${result.namespace}`
            }]
          };
        }

        // 构建返回信息
        let responseText = `## 上下文检测结果\n\n`;
        responseText += `**工作目录**: ${result.originalPath}\n`;
        responseText += `**检测到的 namespace**: ${result.namespace}\n`;
        responseText += `**namespace 来源**: ${result.namespaceSource}\n`;

        if (result.serviceName) {
          responseText += `**检测到的服务**: ${result.serviceName}\n`;
          if (result.service) {
            responseText += `**服务描述**: ${result.service.description}\n`;
            responseText += `**服务别名**: ${result.service.aliases.join(', ')}\n`;
          }
        } else {
          responseText += `**检测到的服务**: 未能从路径中识别服务名\n`;
        }

        responseText += `\n### 建议\n`;
        responseText += `在调用 query_log、search_log 等工具时，请使用:\n`;
        responseText += `- **namespace**: \`${result.namespace}\`\n`;
        if (result.serviceName) {
          responseText += `- **service**: \`${result.serviceName}\`\n`;
        }

        console.error(`[MCP] 上下文检测: path=${workspacePath}, namespace=${result.namespace}, service=${result.serviceName}`);

        return {
          content: [{
            type: 'text',
            text: responseText
          }]
        };
      }

      default:
        return {
          content: [{
            type: 'text',
            text: `错误: 未知工具 "${name}"`
          }]
        };
    }
  } catch (error) {
    console.error(`[MCP] 错误: ${error.message}`);
    return {
      content: [{
        type: 'text',
        text: `## 执行错误\n\n❌ ${error.message}`
      }],
      isError: true
    };
  }
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Log Query Server v2.0 已启动');
}

main().catch((error) => {
  console.error('[MCP] 启动失败:', error);
  process.exit(1);
});
