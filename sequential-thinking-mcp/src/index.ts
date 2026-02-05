#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// 思考历史记录
interface ThoughtData {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;
  nextThoughtNeeded: boolean;
}

const thoughtHistory: ThoughtData[] = [];
const branches: Record<string, ThoughtData[]> = {};

// 创建 MCP 服务器
const server = new Server(
  {
    name: "sequential-thinking-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 注册工具列表处理器
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "sequentialthinking",
        description: `一个用于动态和反思性问题解决的详细工具。
通过灵活的思考过程来分析问题，可以适应和演变。
每个思考可以建立在、质疑或修改之前的见解上。

使用场景：
- 将复杂问题分解为步骤
- 需要修订空间的规划和设计
- 可能需要纠正方向的分析
- 初始范围不明确的问题
- 需要多步骤解决方案的问题

关键特性：
- 可以随时调整总思考数
- 可以质疑或修改之前的思考
- 可以在看似结束后添加更多思考
- 可以表达不确定性并探索替代方案
- 生成解决方案假设并验证`,
        inputSchema: {
          type: "object",
          properties: {
            thought: {
              type: "string",
              description: "当前的思考步骤内容",
            },
            nextThoughtNeeded: {
              type: "boolean",
              description: "是否需要下一个思考步骤",
            },
            thoughtNumber: {
              type: "number",
              description: "当前思考编号（从1开始）",
            },
            totalThoughts: {
              type: "number",
              description: "预计总思考数（可调整）",
            },
            isRevision: {
              type: "boolean",
              description: "是否是对之前思考的修订",
            },
            revisesThought: {
              type: "number",
              description: "正在修订的思考编号",
            },
            branchFromThought: {
              type: "number",
              description: "分支起点的思考编号",
            },
            branchId: {
              type: "string",
              description: "分支标识符",
            },
            needsMoreThoughts: {
              type: "boolean",
              description: "是否需要更多思考",
            },
          },
          required: ["thought", "nextThoughtNeeded", "thoughtNumber", "totalThoughts"],
        },
      },
    ],
  };
});

// 注册工具调用处理器
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "sequentialthinking") {
    throw new Error(`未知工具: ${request.params.name}`);
  }

  const args = request.params.arguments as unknown as ThoughtData;

  // 调整 totalThoughts
  if (args.thoughtNumber > args.totalThoughts) {
    args.totalThoughts = args.thoughtNumber;
  }

  // 保存到历史
  thoughtHistory.push(args);

  // 处理分支
  if (args.branchFromThought && args.branchId) {
    if (!branches[args.branchId]) {
      branches[args.branchId] = [];
    }
    branches[args.branchId].push(args);
  }

  // 构建思考标题
  let thoughtPrefix = "💭 Thought";
  let thoughtContext = "";
  if (args.isRevision) {
    thoughtPrefix = "🔄 Revision";
    thoughtContext = ` (修订思考 #${args.revisesThought})`;
  } else if (args.branchFromThought) {
    thoughtPrefix = "🌿 Branch";
    thoughtContext = ` (从思考 #${args.branchFromThought} 分支, ID: ${args.branchId})`;
  }

  // 构建 Markdown 格式的返回内容
  const markdownContent = `## ${thoughtPrefix} ${args.thoughtNumber}/${args.totalThoughts}${thoughtContext}

${args.thought}

---

**状态**: ${args.nextThoughtNeeded ? "⏳ 继续思考中..." : "✅ 思考完成"}
**历史记录**: ${thoughtHistory.length} 条思考`;

  // 输出到 stderr（用于调试）
  console.error(`\n${thoughtPrefix} ${args.thoughtNumber}/${args.totalThoughts}${thoughtContext}`);
  console.error(args.thought);
  console.error("---\n");

  return {
    content: [
      {
        type: "text",
        text: markdownContent,
      },
    ],
  };
});

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Sequential Thinking MCP Server 已启动 (stdio)");
}

main().catch((error) => {
  console.error("服务器启动失败:", error);
  process.exit(1);
});

