#!/usr/bin/env node

/**
 * Log Query MCP Server
 *
 * 提供以下工具：
 * - query_log: 查询服务日志（支持测试环境 SSH + 生产环境 Loki）
 * - search_log: 搜索日志关键词（生产环境自动提取 traceId）
 * - list_services: 列出可用服务
 * - test_connection: 测试 SSH 连接
 * - list_pods: 列出 pods 及状态
 * - describe_pod: 获取 pod 详情
 * - get_pod_logs: 获取 pod 日志
 * - get_events: 获取 namespace 事件
 * - trace_log: 根据 traceId 跨服务查询日志（生产环境一次查询所有服务）
 * - detect_context: 根据工作目录自动检测 namespace 和服务
 * - list_loki_environments: 列出可用的 Loki 生产环境
 * - list_loki_services: 列出 Loki 环境下的服务
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { queryLog, testConnection, executeKubectl } from './ssh-client.js';
import { findService, getAllServices, DEFAULTS, DEFAULT_NAMESPACE, SERVICES, NAMESPACES, detectContextFromPath, isLokiEnv, resolveLokiEnvName, LOKI_ENVIRONMENTS } from './config.js';
import { log, getLogFilePath } from './logger.js';
import {
  queryLoki, queryLokiAutoRange, parseTimeStr,
  extractTraceIds, parseServiceFromFilename, groupLogsByService,
  buildServiceLogQL, buildProjectLogQL, getLokiServiceDirName, getLokiLogSubPath,
  listLokiEnvironments as getLokiEnvList, listLokiServices as getLokiSvcList
} from './loki-client.js';
import { resolveLokiTarget, resolveK8sService, getAllServiceNames } from './service-discovery.js';

// 超时配置
const REQUEST_TIMEOUT = 60000;             // MCP 请求兑底超时 60s（withTimeout 强制终止）
const WATCHDOG_WARN_TIMEOUT = 120000;      // 看门狗 120s，仅记录告警（不再 process.exit）

/** shell 双引号内安全转义：处理 \\ " $ ` ，防 grep 关键词破坏命令结构 */
function escapeShellArg(s) {
  return String(s).replace(/[\\"$`]/g, '\\$&');
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms)
    ),
  ]);
}

// 安全序列化工具参数（截断超长值，容错循环引用）
function safeStringify(obj, maxLen = 200) {
  try {
    const s = JSON.stringify(obj);
    return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
  } catch {
    return '<unserializable>';
  }
}

// 合并多个 AbortSignal：任何一个 abort 则聚合 signal abort
// Node 20+ 原生支持 AbortSignal.any；低版本回退到手工监听
function anySignal(signals) {
  const valid = signals.filter(Boolean);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(valid);
  // 回退方案
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  for (const s of valid) {
    if (s.aborted) { ctrl.abort(); break; }
    s.addEventListener('abort', onAbort, { once: true });
  }
  return ctrl.signal;
}

// 进程级安全网：只记录日志，不退出进程
// 退出会导致 stdio 断开，整个 MCP 不可用直到 IDE 重启；单次请求错误不应拖死服务
process.on('unhandledRejection', (err) => log(`[unhandledRejection] ${err && err.stack || err}`));
process.on('uncaughtException', (err) => log(`[uncaughtException] ${err && err.stack || err}`));

// 创建 MCP Server
const server = new Server(
  {
    name: 'mcp-log-query',
    version: '3.8.2',
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
        description: '查询服务容器的日志文件。返回最近的日志内容。支持通过 env 参数查询生产环境日志（Loki）。',
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
            },
            env: {
              type: 'string',
              description: '环境标识。默认 saas-itest（测试环境，走 SSH）。可选值：saas-itest（测试环境）、cms/prod/生产（CMS生产环境）、pre/预发/预发布（预发布环境，与 CMS 共用 Grafana）、城阳/cy/chengyang、临颖/ly/linying、漯河/lh/luohe、德阳/dy/deyang、旌阳/jy/jingyang（私有化环境）',
              default: 'saas-itest'
            },
            from: {
              type: 'string',
              description: '(Loki) 查询起始时间，如 "2026-02-05 10:00:00"。指定后禁用自动递进'
            },
            to: {
              type: 'string',
              description: '(Loki) 查询结束时间，如 "2026-02-06 12:00:00"。不指定则为当前时间'
            }
          },
          required: ['service', 'env']
        }
      },
      {
        name: 'search_log',
        description: '在服务日志中搜索关键词。支持正则表达式。生产环境会自动提取 traceId 列表。',
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
            },
            env: {
              type: 'string',
              description: '环境标识。默认 saas-itest（测试环境，走 SSH）。可选值：saas-itest（测试环境）、cms/prod/生产（CMS生产环境）、pre/预发/预发布（预发布环境，与 CMS 共用 Grafana）、城阳/cy/chengyang、临颖/ly/linying、漯河/lh/luohe、德阳/dy/deyang、旌阳/jy/jingyang（私有化环境）',
              default: 'saas-itest'
            },
            from: {
              type: 'string',
              description: '(Loki) 查询起始时间，如 "2026-02-05 10:00:00"。指定后禁用自动递进'
            },
            to: {
              type: 'string',
              description: '(Loki) 查询结束时间，如 "2026-02-06 12:00:00"。不指定则为当前时间'
            }
          },
          required: ['service', 'keyword', 'env']
        }
      },
      {
        name: 'list_services',
        description: '列出所有可查询日志的服务。新部署的服务无需注册即可直接查询（自动发现）；传 discover=true 可额外列出 K8s 中已部署但未静态注册的服务',
        inputSchema: {
          type: 'object',
          properties: {
            discover: {
              type: 'boolean',
              description: '是否通过 kubectl 动态发现未注册的新服务，默认 false',
              default: false
            },
            namespace: {
              type: 'string',
              description: '动态发现使用的 K8s namespace，默认 saas-itest'
            }
          }
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
        description: '根据 traceId 跨服务查询日志，用于追踪完整调用链。生产环境使用 Loki API 一次查询所有服务。',
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
            },
            env: {
              type: 'string',
              description: '环境标识。默认 saas-itest（测试环境，走 SSH）。可选值：saas-itest（测试环境）、cms/prod/生产（CMS生产环境）、pre/预发/预发布（预发布环境，与 CMS 共用 Grafana）、城阳/cy/chengyang、临颖/ly/linying、漯河/lh/luohe、德阳/dy/deyang、旌阳/jy/jingyang（私有化环境）',
              default: 'saas-itest'
            },
            from: {
              type: 'string',
              description: '(Loki) 查询起始时间，如 "2026-02-05 10:00:00"。指定后禁用自动递进'
            },
            to: {
              type: 'string',
              description: '(Loki) 查询结束时间，如 "2026-02-06 12:00:00"。不指定则为当前时间'
            }
          },
          required: ['traceId', 'env']
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
      },
      // ========== 自定义命令工具 ==========
      {
        name: 'exec_in_pod',
        description: '在指定 pod 内执行自定义命令。适用于日志文件路径不在默认配置中、需要 ls/cat/wc 等探索性操作、或需要自定义 grep/tail 参数的场景。',
        inputSchema: {
          type: 'object',
          properties: {
            pod: {
              type: 'string',
              description: 'Pod 名称或名称模式（支持部分匹配）'
            },
            command: {
              type: 'string',
              description: '要在 pod 内执行的命令，如 grep -C 5 "keyword" /www/logs/app/application.out'
            },
            namespace: {
              type: 'string',
              description: 'K8s namespace，默认 saas-itest',
              default: 'saas-itest'
            }
          },
          required: ['pod', 'command']
        }
      },
      // ========== Loki 生产环境工具 ==========
      {
        name: 'list_loki_environments',
        description: '列出所有可用的 Loki 生产环境',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'list_loki_services',
        description: '列出指定 Loki 环境下的所有可用服务',
        inputSchema: {
          type: 'object',
          properties: {
            env: {
              type: 'string',
              description: '环境标识。可选值：cms/prod/生产（CMS生产环境）、pre/预发/预发布（预发布环境，与 CMS 共用 Grafana）、城阳/cy/chengyang、临颖/ly/linying、漯河/lh/luohe、德阳/dy/deyang、旌阳/jy/jingyang（私有化环境）',
              default: 'cms'
            },
            project: {
              type: 'string',
              description: '项目名，默认 senior',
              default: 'senior'
            }
          }
        }
      }
    ]
  };
});
// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  const startTime = Date.now();
  // SDK 传入的 signal：Cascade 发 notifications/cancelled 时 signal.aborted=true
  const signal = extra && extra.signal;
  log(`[Tool] → ${name} start args=${safeStringify(args)}`);

  // 提前 cancel：立即抛错，让 SDK 检测到 signal.aborted 不发 response
  if (signal && signal.aborted) {
    log(`[Tool] ⊗ ${name} 收到请求时已 aborted，立即返回`);
    throw new Error('Request cancelled before handler');
  }

  // 看门狗：仅记录长时间未完成的请求，不再退出进程
  const watchdog = setTimeout(() => {
    log(`[Watchdog] ${name} 仍在运行超过 ${WATCHDOG_WARN_TIMEOUT}ms（仅记录，不退出进程）`);
  }, WATCHDOG_WARN_TIMEOUT);
  watchdog.unref();

  // cancel race：signal abort 时立即 reject，handler 不再等下游
  const cancelPromise = new Promise((_, reject) => {
    if (!signal) return;
    const onAbort = () => {
      log(`[Tool] ⊗ ${name} 收到 cancel signal (${Date.now() - startTime}ms)`);
      reject(new Error('CANCELLED'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

  try {
    const result = await Promise.race([
      withTimeout(handleToolCall(name, args, signal), REQUEST_TIMEOUT, name),
      cancelPromise,
    ]);
    clearTimeout(watchdog);
    log(`[Tool] ✓ ${name} done ${Date.now() - startTime}ms`);
    return result;
  } catch (error) {
    clearTimeout(watchdog);
    // 取消场景：抛错让 SDK 知道（SDK 检测 signal.aborted 不发 response）
    if (signal && signal.aborted) {
      log(`[Tool] ⊗ ${name} CANCELLED ${Date.now() - startTime}ms`);
      throw error;
    }
    log(`[Tool] ✗ ${name} FAIL ${Date.now() - startTime}ms: ${error.message}`);
    return {
      content: [{ type: 'text', text: `## 执行错误\n\n❌ ${error.message}` }],
      isError: true
    };
  }
});

/**
 * 实际的工具调用处理逻辑
 * @param {string} name - 工具名
 * @param {object} args - 工具参数
 * @param {AbortSignal} [signal] - Cascade 传入的取消信号；层层传给 Loki/SSH/kubectl
 */
async function handleToolCall(name, args, signal) {
  try {
    switch (name) {
      case 'query_log': {
        // 判断是否走 Loki（生产环境）
        if (isLokiEnv(args.env)) {
          const envKey = resolveLokiEnvName(args.env);
          const envConfig = LOKI_ENVIRONMENTS[envKey];
          const project = envConfig.defaultProject || 'senior';
          const target = await resolveLokiTarget(envKey, envConfig, args.service);
          const maxLines = args.lines || DEFAULTS.lines;

          const expr = buildServiceLogQL(project, target.dirName, '', envKey, target.logSubPath);
          log(`[MCP] Loki 查询日志: env=${envKey}, service=${args.service} (${target.source}: ${target.dirName}), expr=${expr}`);

          // 构建时间范围选项
          const timeOpts = { maxLines };
          if (args.from) timeOpts.from = parseTimeStr(args.from);
          if (args.to) timeOpts.to = parseTimeStr(args.to);
          timeOpts.signal = signal;

          const lokiResult = await queryLokiAutoRange(envKey, expr, timeOpts);

          if (lokiResult.logs.length === 0) {
            const errorHint = lokiResult.error ? `\n\n⚠️ **${lokiResult.error}**` : '';
            const rangeDesc = lokiResult.triedLabels && lokiResult.triedLabels.length > 0
              ? `已搜索 ${lokiResult.triedLabels.join(' → ')} 范围`
              : `已搜索${lokiResult.timeRange.label}`;
            return { content: [{ type: 'text', text: `## ${args.service} 日志 (${envKey} 生产环境)\n\n⚠️ ${rangeDesc}，未找到日志。${errorHint}\n\n请确认：\n1. 服务名是否正确\n2. 如需查询更早的日志，请使用 \`from\`/\`to\` 参数指定具体时间范围` }] };
          }

          let text = `## ${args.service} 日志 (${envKey} 生产环境, ${lokiResult.timeRange.label}内, ${lokiResult.logs.length} 行)\n\n`;
          text += `\`\`\`\n${lokiResult.logs.join('\n')}\n\`\`\``;
          if (lokiResult.traceIds.length > 0) {
            text += `\n\n🔑 **提取到的 traceId** (${lokiResult.traceIds.length} 个):\n`;
            lokiResult.traceIds.slice(0, 20).forEach((id, i) => { text += `  ${i + 1}. \`${id}\`\n`; });
            if (lokiResult.traceIds.length > 20) text += `  ... 还有 ${lokiResult.traceIds.length - 20} 个\n`;
          }
          return { content: [{ type: 'text', text }] };
        }

        // 测试环境：走 SSH（静态配置未命中时自动发现）
        const service = await resolveK8sService(args.service, args.namespace, signal);
        if (!service) {
          return { content: [{ type: 'text', text: `错误: 未找到服务 "${args.service}"（静态配置和 K8s deployment 均未匹配）。使用 list_services 查看可用服务，或用 list_pods 确认服务是否已部署。` }] };
        }

        const lines = args.lines || DEFAULTS.lines;
        const command = `tail -${lines}`;

        log(`[MCP] 查询日志: ${service.name} (namespace: ${service.namespace}), 命令: ${command}`);
        const result = await queryLog(service, command, { signal });

        return {
          content: [{
            type: 'text',
            text: `## ${service.name} 日志 (namespace: ${service.namespace}, 最近 ${lines} 行)\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      case 'search_log': {
        // 判断是否走 Loki（生产环境）
        if (isLokiEnv(args.env)) {
          const envKey = resolveLokiEnvName(args.env);
          const envConfig = LOKI_ENVIRONMENTS[envKey];
          const project = envConfig.defaultProject || 'senior';
          const target = await resolveLokiTarget(envKey, envConfig, args.service);
          const keyword = args.keyword;

          const expr = buildServiceLogQL(project, target.dirName, keyword, envKey, target.logSubPath);
          log(`[MCP] Loki 搜索日志: env=${envKey}, service=${args.service} (${target.source}: ${target.dirName}), keyword=${keyword}`);

          // 构建时间范围选项
          const timeOpts = { maxLines: 200 };
          if (args.from) timeOpts.from = parseTimeStr(args.from);
          if (args.to) timeOpts.to = parseTimeStr(args.to);
          timeOpts.signal = signal;

          const lokiResult = await queryLokiAutoRange(envKey, expr, timeOpts);

          if (lokiResult.logs.length === 0) {
            const errorHint = lokiResult.error ? `\n\n⚠️ **${lokiResult.error}**` : '';
            const rangeDesc = lokiResult.triedLabels && lokiResult.triedLabels.length > 0
              ? `已搜索 ${lokiResult.triedLabels.join(' → ')} 范围`
              : `已搜索${lokiResult.timeRange.label}`;
            return { content: [{ type: 'text', text: `## ${args.service} 日志搜索结果 (${envKey} 生产环境)\n\n**关键词**: ${keyword}\n\n⚠️ ${rangeDesc}，未找到匹配内容。${errorHint}\n\n请确认：\n1. 关键词是否正确（纯字面量用子串匹配；含 | ( ) 等元字符时按正则匹配）\n2. 服务名是否正确\n3. 如需查询更早的日志，请使用 \`from\`/\`to\` 参数指定具体时间范围` }] };
          }

          let text = `## ${args.service} 日志搜索结果 (${envKey} 生产环境, ${lokiResult.timeRange.label}内)\n\n`;
          text += `**关键词**: ${keyword}\n**匹配行数**: ${lokiResult.logs.length}\n**时间范围**: ${lokiResult.timeRange.label}\n\n`;
          text += `\`\`\`\n${lokiResult.logs.join('\n')}\n\`\`\``;

          // 自动提取 traceId（核心功能：帮助用户获取 traceId 进行链路追踪）
          if (lokiResult.traceIds.length > 0) {
            text += `\n\n🔑 **提取到的 traceId** (${lokiResult.traceIds.length} 个):\n`;
            lokiResult.traceIds.slice(0, 20).forEach((id, i) => { text += `  ${i + 1}. \`${id}\`\n`; });
            if (lokiResult.traceIds.length > 20) text += `  ... 还有 ${lokiResult.traceIds.length - 20} 个\n`;
            text += `\n💡 **提示**: 可以使用 \`trace_log(traceId: "xxx", env: "${args.env}")\` 查看完整调用链`;
          }
          return { content: [{ type: 'text', text }] };
        }

        // 测试环境：走 SSH（静态配置未命中时自动发现）
        const service = await resolveK8sService(args.service, args.namespace, signal);
        if (!service) {
          return { content: [{ type: 'text', text: `错误: 未找到服务 "${args.service}"（静态配置和 K8s deployment 均未匹配）。使用 list_services 查看可用服务，或用 list_pods 确认服务是否已部署。` }] };
        }

        const keyword = args.keyword;
        const contextLines = args.context_lines || 5;
        const caseSensitive = args.case_sensitive || false;

        const grepFlags = caseSensitive ? '' : '-i';
        const command = `grep ${grepFlags} -C ${parseInt(contextLines) || 5} "${escapeShellArg(keyword)}"`;

        log(`[MCP] 搜索日志: ${service.name} (namespace: ${service.namespace}), 关键词: ${keyword}`);
        const result = await queryLog(service, command, { signal });

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

        let text = `## 可用服务列表（静态注册）\n\n${list}`;

        // 可选：动态发现未注册服务
        if (args.discover) {
          try {
            const namespace = args.namespace || DEFAULT_NAMESPACE;
            const allNames = await getAllServiceNames(namespace, signal);
            const staticNames = new Set(services.map(s => s.name));
            const extra = allNames.filter(n => !staticNames.has(n));
            if (extra.length > 0) {
              text += `\n\n## 动态发现的未注册服务 (namespace: ${namespace})\n\n${extra.map(n => `- ${n}`).join('\n')}\n\n💡 这些服务可直接用于 query_log / search_log，无需手动注册`;
            } else {
              text += `\n\n✅ 未发现静态表之外的新服务`;
            }
          } catch (e) {
            text += `\n\n⚠️ 动态发现失败: ${e.message.substring(0, 120)}`;
          }
        } else {
          text += `\n\n💡 新部署的服务无需注册：query_log / search_log 会自动从 K8s deployment（测试环境）或 Loki filename（生产环境）发现。传 discover: true 可列出未注册服务。`;
        }

        return {
          content: [{
            type: 'text',
            text
          }]
        };
      }

      case 'test_connection': {
        log('[MCP] 测试 SSH 连接');
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

        log(`[MCP] 列出 pods: namespace=${namespace}`);
        const result = await executeKubectl(cmd, { signal });

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
        log(`[MCP] 查找 pod: ${podPattern}`);
        
        const describeCmd = `kubectl describe $(kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1) -n ${namespace}`;
        const result = await executeKubectl(describeCmd, { signal });

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

        log(`[MCP] 获取 pod 日志: ${podPattern}, previous=${previous}`);
        const result = await executeKubectl(cmd, { signal });

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

        log(`[MCP] 获取事件: namespace=${namespace}`);
        const result = await executeKubectl(cmd, { signal });

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

        // 判断是否走 Loki（生产环境）- 一次 API 调用搜索所有服务
        if (isLokiEnv(args.env)) {
          const envKey = resolveLokiEnvName(args.env);
          const envConfig = LOKI_ENVIRONMENTS[envKey];
          const project = envConfig.defaultProject || 'senior';

          // 构建时间范围选项
          const timeOpts = {};
          if (args.from) timeOpts.from = parseTimeStr(args.from);
          if (args.to) timeOpts.to = parseTimeStr(args.to);

          // 如果指定了服务列表，按服务查询；否则按项目查询（一次搜索所有服务）
          let lokiResult;
          const targetServices = args.services || [];

          if (targetServices.length > 0) {
            // 指定服务：逐个查询
            const allLogs = [];
            const allLabels = [];
            for (const svc of targetServices) {
              const target = await resolveLokiTarget(envKey, envConfig, svc);
              const expr = buildServiceLogQL(project, target.dirName, traceId, envKey, target.logSubPath);
              log(`[MCP] Loki trace: env=${envKey}, service=${svc}, traceId=${traceId}`);
              const r = await queryLokiAutoRange(envKey, expr, { ...timeOpts, maxLines: 500, signal });
              allLogs.push(...r.logs);
              allLabels.push(...r.labels);
            }
            lokiResult = { logs: allLogs, labels: allLabels, traceIds: extractTraceIds(allLogs), timeRange: { label: '自动递进' } };
          } else {
            // 未指定服务：按项目一次查询所有服务（高效！）
            const expr = buildProjectLogQL(project, traceId, envKey);
            log(`[MCP] Loki trace (全项目): env=${envKey}, project=${project}, traceId=${traceId}`);
            lokiResult = await queryLokiAutoRange(envKey, expr, { ...timeOpts, maxLines: 1000, signal });
          }

          if (lokiResult.logs.length === 0) {
            const errorHint = lokiResult.error ? `\n\n⚠️ **${lokiResult.error}**` : '';
            return { content: [{ type: 'text', text: `## TraceId 追踪结果 (${envKey} 生产环境)\n\n**traceId**: \`${traceId}\`\n\n❌ 已自动搜索 5分钟 → 30分钟 → 1小时 → 3小时 → 24小时 范围，均未找到匹配日志。${errorHint}\n\n请确认：\n1. traceId 是否正确\n2. 如需查询更早的日志，请使用 \`from\`/\`to\` 参数指定具体时间范围` }] };
          }

          // 按服务分组展示
          const groups = groupLogsByService(lokiResult);
          const serviceNames = Object.keys(groups).sort();

          let text = `## TraceId 追踪结果 (${envKey} 生产环境, ${lokiResult.timeRange.label}内)\n\n`;
          text += `**traceId**: \`${traceId}\`\n`;
          text += `**匹配服务数**: ${serviceNames.length}\n`;
          text += `**总日志行数**: ${lokiResult.logs.length}\n\n`;

          for (const svcName of serviceNames) {
            const group = groups[svcName];
            text += `### ${svcName}\n`;
            text += `\`\`\`\n${group.logs.join('\n')}\n\`\`\`\n\n`;
          }

          return { content: [{ type: 'text', text }] };
        }

        // 测试环境：走 SSH（逐个服务搜索）
        const targetNamespace = args.namespace || null;
        let servicesToSearch = args.services || [];

        if (servicesToSearch.length === 0) {
          // 静态表 + K8s 动态发现合并（发现失败自动降级为静态表）
          servicesToSearch = await getAllServiceNames(targetNamespace, signal);
        } else {
          servicesToSearch = servicesToSearch.map(s => {
            const service = findService(s, targetNamespace);
            return service ? service.name : s;
          }).filter(Boolean);
        }

        log(`[MCP] 追踪日志: traceId=${traceId}, namespace=${targetNamespace || 'default'}, 服务数=${servicesToSearch.length}`);

        const TRACE_TOTAL_TIMEOUT = 50000;  // 总耗时上限 50s
        const TRACE_PER_SERVICE = 10000;    // 单服务超时 10s
        const traceStart = Date.now();
        const results = [];
        let searched = 0;
        let skipped = 0;

        for (const serviceName of servicesToSearch) {
          // 总耗时检查
          if (Date.now() - traceStart > TRACE_TOTAL_TIMEOUT) {
            skipped = servicesToSearch.length - searched;
            log(`[MCP] trace_log 总耗时超过 ${TRACE_TOTAL_TIMEOUT}ms，跳过剩余 ${skipped} 个服务`);
            break;
          }

          // 批量扫描跳过 pod 内探测（每次探测 = 一次 SSH 往返，几十个服务会烧光预算），动态服务用约定路径
          const service = await resolveK8sService(serviceName, targetNamespace, signal, { skipProbe: true });
          if (!service) { searched++; continue; }

          try {
            const command = `grep -i -C ${parseInt(contextLines) || 3} "${escapeShellArg(traceId)}"`;
            const result = await queryLog(service, command, { timeout: TRACE_PER_SERVICE, signal });

            if (result && result.trim() && !result.includes('未找到')) {
              results.push({ service: serviceName, namespace: service.namespace, logs: result });
            }
          } catch (err) {
            // 快速跳过失败/超时的服务
            log(`[MCP] ${serviceName} 跳过: ${err.message.substring(0, 80)}`);
          }
          searched++;
        }

        const elapsed = Date.now() - traceStart;
        const timeNote = skipped > 0 ? `\n**注意**: 已搜索 ${searched}/${servicesToSearch.length} 个服务（耗时 ${elapsed}ms，跳过 ${skipped} 个）` : '';

        if (results.length === 0) {
          return { content: [{ type: 'text', text: `## TraceId 追踪结果\n\n**traceId**: ${traceId}\n**namespace**: ${targetNamespace || '默认'}\n\n❌ 未在已搜索的 ${searched} 个服务中找到匹配的日志${timeNote}` }] };
        }

        const output = results.map(r => `### ${r.service} (${r.namespace})\n\`\`\`\n${r.logs}\n\`\`\``).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `## TraceId 追踪结果\n\n**traceId**: ${traceId}\n**namespace**: ${targetNamespace || '默认'}\n**匹配服务数**: ${results.length}${timeNote}\n\n${output}`
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

        log(`[MCP] 上下文检测: path=${workspacePath}, namespace=${result.namespace}, service=${result.serviceName}`);

        return {
          content: [{
            type: 'text',
            text: responseText
          }]
        };
      }

      // ========== 自定义命令工具处理 ==========
      case 'exec_in_pod': {
        const namespace = args.namespace || DEFAULT_NAMESPACE;
        const podPattern = args.pod;
        const command = args.command;

        const cmd = `kubectl exec $(kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1) -n ${namespace} -- ${command}`;
        log(`[MCP] exec_in_pod: pod=${podPattern}, command=${command}`);
        const result = await executeKubectl(cmd, { signal });

        return {
          content: [{
            type: 'text',
            text: `## Pod 命令执行结果\n\n**Pod**: ${podPattern}\n**Namespace**: ${namespace}\n**Command**: \`${command}\`\n\n\`\`\`\n${result}\n\`\`\``
          }]
        };
      }

      // ========== Loki 生产环境工具处理 ==========
      case 'list_loki_environments': {
        const envs = getLokiEnvList();
        if (envs.length === 0) {
          return { content: [{ type: 'text', text: '## Loki 环境列表\n\n⚠️ 未配置任何 Loki 环境' }] };
        }

        const list = envs.map(e =>
          `- **${e.name}**: ${e.description}\n  Grafana: ${e.grafanaUrl}\n  默认项目: ${e.project}`
        ).join('\n');

        return { content: [{ type: 'text', text: `## Loki 生产环境列表\n\n${list}` }] };
      }

      case 'list_loki_services': {
        const envKey = resolveLokiEnvName(args.env || 'cms');
        const project = args.project || 'senior';

        if (!envKey || !LOKI_ENVIRONMENTS[envKey]) {
          return { content: [{ type: 'text', text: `错误: 未知环境 "${args.env}"。使用 list_loki_environments 查看可用环境。` }] };
        }

        log(`[MCP] 列出 Loki 服务: env=${envKey}, project=${project}`);
        const services = await getLokiSvcList(envKey, project);

        if (services.length === 0) {
          return { content: [{ type: 'text', text: `## Loki 服务列表 (${envKey})\n\n⚠️ 未找到任何服务` }] };
        }

        const list = services.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
        return { content: [{ type: 'text', text: `## Loki 服务列表 (${envKey}, project=${project})\n\n共 ${services.length} 个服务:\n${list}` }] };
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
    log(`[MCP] 工具内部错误: ${error.message}`);
    return {
      content: [{
        type: 'text',
        text: `## 执行错误\n\n❌ ${error.message}`
      }],
      isError: true
    };
  }
}

// 优雅关闭（对齐 auggie MCP 启动代码）
function gracefulShutdown() {
  log('[MCP] 优雅关闭...');
  server.close().catch(() => {});
  // 给 close 一点时间完成，然后强制退出
  setTimeout(() => process.exit(0), 500).unref();
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// 启动服务器
async function main() {
  // 对齐 auggie: 监听 stdin end/close，宿主进程断开时优雅关闭
  process.stdin.on('end', () => {
    log('[MCP] stdin end, initiating graceful shutdown');
    gracefulShutdown();
  });
  process.stdin.on('close', () => {
    log('[MCP] stdin close, initiating graceful shutdown');
    gracefulShutdown();
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  const logPath = getLogFilePath();
  log(`[MCP] Log Query Server v3.8.2 已启动 (仅文件日志，避免 stderr backpressure 阻塞 event loop)`);
  if (logPath) log(`[MCP] 本地日志文件: ${logPath}`);
}

main().catch((error) => {
  log(`[MCP] 启动失败: ${error && error.stack || error}`);
  process.exit(1);
});
