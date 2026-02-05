/**
 * Log Query MCP Server - 配置文件
 * 
 * 包含：
 * - 堡垒机连接信息
 * - K8s 服务器信息
 * - 服务/容器映射
 */

// 堡垒机配置 - 从环境变量读取
export const JUMP_HOST = {
  host: process.env.MCP_JUMP_HOST || '',
  port: parseInt(process.env.MCP_JUMP_PORT || '22'),
  username: process.env.MCP_JUMP_USERNAME || '',
  password: process.env.MCP_JUMP_PASSWORD || ''
};

// K8s 服务器配置 - 从环境变量读取
export const K8S_SERVER = {
  host: process.env.MCP_K8S_HOST || '',
  // 堡垒机选择服务器后的选项
  selectOption: process.env.MCP_K8S_SELECT || '1'
};

// 服务配置映射
// key: 服务名称
// value: 容器和日志路径信息
export const SERVICES = {
  'clife-senior-admin': {
    name: 'clife-senior-admin',
    description: '养老管理后台服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-admin-app',
    logPath: '/www/logs/clife-senior-admin-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['admin', '管理', '后台']
  },
  'clife-senior-approval': {
    name: 'clife-senior-approval',
    description: '养老审批服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-approval-app',
    logPath: '/www/logs/clife-senior-approval-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['approval', '审批']
  },
  'clife-senior-archives': {
    name: 'clife-senior-archives',
    description: '养老档案服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-archives-app',
    logPath: '/www/logs/clife-senior-archives-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['archives', '档案']
  },
  'clife-senior-assess': {
    name: 'clife-senior-assess',
    description: '养老评估服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-assess-app',
    logPath: '/www/logs/clife-senior-assess-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['assess', '评估']
  },
  'clife-senior-common': {
    name: 'clife-senior-common',
    description: '养老公共服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-common-app',
    logPath: '/www/logs/clife-senior-common-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['common', '公共']
  },
  'clife-senior-core': {
    name: 'clife-senior-core',
    description: '养老核心服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-core-app',
    logPath: '/www/logs/clife-senior-core-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['core', '核心']
  },
  'clife-senior-device-center': {
    name: 'clife-senior-device-center',
    description: '养老设备中心服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-device-center-app',
    logPath: '/www/logs/clife-senior-device-center-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['device-center', '设备中心']
  },
  'clife-senior-device-warn': {
    name: 'clife-senior-device-warn',
    description: '养老设备告警服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-device-warn-app',
    logPath: '/www/logs/clife-senior-device-warn-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['device-warn', '设备告警']
  },
  'clife-senior-dispatch': {
    name: 'clife-senior-dispatch',
    description: '养老调度服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-dispatch-app',
    logPath: '/www/logs/clife-senior-dispatch-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['dispatch', '调度']
  },
  'clife-senior-evaluation': {
    name: 'clife-senior-evaluation',
    description: '养老评价服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-evaluation-app',
    logPath: '/www/logs/clife-senior-evaluation-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['evaluation', '评价']
  },
  'clife-senior-finance-new': {
    name: 'clife-senior-finance-new',
    description: '养老财务服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-finance-new-app',
    logPath: '/www/logs/clife-senior-finance-new-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['finance-new', 'finance', '财务']
  },
  'clife-senior-gateway': {
    name: 'clife-senior-gateway',
    description: '养老网关服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-gateway-app',
    logPath: '/www/logs/clife-senior-gateway-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['gateway', '网关']
  },
  'clife-senior-generate': {
    name: 'clife-senior-generate',
    description: '养老生成服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-generate-app',
    logPath: '/www/logs/clife-senior-generate-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['generate', '生成']
  },
  'clife-senior-gov': {
    name: 'clife-senior-gov',
    description: '养老政务服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-gov-app',
    logPath: '/www/logs/clife-senior-gov-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['gov', '政务']
  },
  'clife-senior-health': {
    name: 'clife-senior-health',
    description: '养老健康服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-health-app',
    logPath: '/www/logs/clife-senior-health-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['health', '健康']
  },
  'clife-senior-health-scene': {
    name: 'clife-senior-health-scene',
    description: '养老健康场景服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-health-scene-app',
    logPath: '/www/logs/clife-senior-health-scene-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['health-scene', '健康场景']
  },
  'clife-senior-home': {
    name: 'clife-senior-home',
    description: '养老居家服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-home-app',
    logPath: '/www/logs/clife-senior-home-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['home', '居家']
  },
  'clife-senior-logger': {
    name: 'clife-senior-logger',
    description: '养老日志服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-logger-app',
    logPath: '/www/logs/clife-senior-logger-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['logger', '日志']
  },
  'clife-senior-mall': {
    name: 'clife-senior-mall',
    description: '养老商城服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-mall-app',
    logPath: '/www/logs/clife-senior-mall-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['mall', '商城']
  },
  'clife-senior-meal-asst-app': {
    name: 'clife-senior-meal-asst-app',
    description: '养老助餐服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-meal-asst-app',
    logPath: '/www/logs/clife-senior-meal-asst-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['meal-asst', 'meal', '助餐']
  },
  'clife-senior-message': {
    name: 'clife-senior-message',
    description: '养老消息服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-message-app',
    logPath: '/www/logs/clife-senior-message-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['message', '消息']
  },
  'clife-senior-open': {
    name: 'clife-senior-open',
    description: '养老开放平台服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-open-app',
    logPath: '/www/logs/clife-senior-open-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['open', '开放平台']
  },
  'clife-senior-optimal-aging': {
    name: 'clife-senior-optimal-aging',
    description: '养老优化服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-optimal-aging-app',
    logPath: '/www/logs/clife-senior-optimal-aging-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['optimal-aging', '优化']
  },
  'clife-senior-org-manage': {
    name: 'clife-senior-org-manage',
    description: '养老机构管理服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-org-manage-app',
    logPath: '/www/logs/clife-senior-org-manage-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['org-manage', 'org', '机构管理', '机构']
  },
  'clife-senior-public': {
    name: 'clife-senior-public',
    description: '养老公共服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-public-app',
    logPath: '/www/logs/clife-senior-public-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['public', '公共服务']
  },
  'clife-senior-scene': {
    name: 'clife-senior-scene',
    description: '养老场景服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-scene-app',
    logPath: '/www/logs/clife-senior-scene-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['scene', '场景']
  },
  'clife-senior-state-engine': {
    name: 'clife-senior-state-engine',
    description: '养老状态引擎服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-state-engine-app',
    logPath: '/www/logs/clife-senior-state-engine-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['state-engine', '状态引擎']
  },
  'clife-senior-statistic': {
    name: 'clife-senior-statistic',
    description: '养老统计服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-statistic-app',
    logPath: '/www/logs/clife-senior-statistic-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['statistic', '统计']
  },
  'clife-senior-subsidy': {
    name: 'clife-senior-subsidy',
    description: '养老补贴服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-subsidy-app',
    logPath: '/www/logs/clife-senior-subsidy-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['subsidy', '补贴']
  },
  'clife-senior-third-request': {
    name: 'clife-senior-third-request',
    description: '养老第三方请求服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-third-request-app',
    logPath: '/www/logs/clife-senior-third-request-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['third-request', '第三方请求']
  },
  'clife-senior-third-service': {
    name: 'clife-senior-third-service',
    description: '养老第三方服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-third-service-app',
    logPath: '/www/logs/clife-senior-third-service-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['third-service', '第三方服务']
  },
  'clife-senior-work-order-center': {
    name: 'clife-senior-work-order-center',
    description: '养老工单中心服务',
    namespace: 'saas-itest',
    podPattern: 'clife-senior-work-order-center-app',
    logPath: '/www/logs/clife-senior-work-order-center-app/normal_logs',
    logFile: 'normal.log',
    aliases: ['work-order-center', 'work-order', '工单中心', '工单']
  }
};

// 根据别名查找服务
// @param {string} nameOrAlias - 服务名称或别名
// @param {string} namespace - 可选，指定 namespace（覆盖服务配置中的默认值）
export function findService(nameOrAlias, namespace = null) {
  const lower = nameOrAlias.toLowerCase();
  let service = null;

  // 精确匹配
  if (SERVICES[lower]) {
    service = SERVICES[lower];
  }

  // 别名匹配
  if (!service) {
    for (const [key, svc] of Object.entries(SERVICES)) {
      if (svc.aliases.some(alias => alias.toLowerCase() === lower)) {
        service = svc;
        break;
      }
      // 部分匹配
      if (key.includes(lower) || svc.name.includes(lower)) {
        service = svc;
        break;
      }
    }
  }

  // 如果找到服务且指定了 namespace，则覆盖默认值
  if (service && namespace) {
    return {
      ...service,
      namespace: namespace
    };
  }

  return service;
}

// 获取所有服务列表
export function getAllServices() {
  return Object.values(SERVICES).map(s => ({
    name: s.name,
    description: s.description,
    aliases: s.aliases
  }));
}

// 默认配置
export const DEFAULTS = {
  // 默认查询行数
  lines: 100,
  // 命令超时（毫秒）
  timeout: 30000,
  // SSH 连接超时
  connectTimeout: 10000
};



// 默认 namespace 配置
export const DEFAULT_NAMESPACE = 'saas-itest';

// 支持的 namespace 列表
export const NAMESPACES = {
  'saas-itest': { description: 'SAAS测试环境', default: true },
  'saas-prod': { description: 'SAAS生产环境' },
  'whood-itest': { description: 'WHOOD测试环境' },
  'whood-prod': { description: 'WHOOD生产环境' }
};

// 工作目录到 namespace 的映射规则
// 根据本地项目目录自动推断应该查询哪个 namespace
export const WORKSPACE_MAPPINGS = [
  {
    // D:\shulian\whood\* 目录下的项目 → whood-itest
    pathPattern: /[/\\]shulian[/\\]whood[/\\]/i,
    namespace: 'whood-itest',
    description: 'WHOOD项目目录'
  },
  {
    // D:\shulian\saas\* 目录下的项目 → saas-itest
    pathPattern: /[/\\]shulian[/\\]saas[/\\]/i,
    namespace: 'saas-itest',
    description: 'SAAS项目目录'
  }
];

/**
 * 根据工作目录路径自动检测 namespace 和服务名
 * @param {string} workspacePath - 当前工作目录路径，如 D:\shulian\whood\clife-senior-mall
 * @returns {Object} 检测结果 { namespace, service, serviceName, confidence }
 */
export function detectContextFromPath(workspacePath) {
  if (!workspacePath) {
    return {
      success: false,
      error: '未提供工作目录路径',
      namespace: DEFAULT_NAMESPACE,
      service: null,
      serviceName: null
    };
  }

  // 标准化路径分隔符
  const normalizedPath = workspacePath.replace(/\\/g, '/');

  // 1. 检测 namespace
  let detectedNamespace = DEFAULT_NAMESPACE;
  let namespaceSource = 'default';

  for (const mapping of WORKSPACE_MAPPINGS) {
    if (mapping.pathPattern.test(workspacePath)) {
      detectedNamespace = mapping.namespace;
      namespaceSource = mapping.description;
      break;
    }
  }

  // 2. 从路径中提取服务名
  // 尝试匹配 clife-senior-xxx 格式的目录名
  const serviceMatch = normalizedPath.match(/clife-senior-([a-zA-Z0-9-]+)/i);
  let detectedServiceName = null;
  let detectedService = null;

  if (serviceMatch) {
    // 尝试查找完整的服务名
    const fullServiceName = `clife-senior-${serviceMatch[1]}`;
    detectedService = findServiceByName(fullServiceName);

    if (detectedService) {
      detectedServiceName = detectedService.name;
    } else {
      // 服务名可能是别名
      detectedServiceName = serviceMatch[1];
    }
  }

  return {
    success: true,
    namespace: detectedNamespace,
    namespaceSource: namespaceSource,
    service: detectedService,
    serviceName: detectedServiceName,
    originalPath: workspacePath
  };
}

/**
 * 根据服务名精确查找服务配置（不做别名匹配）
 * @param {string} serviceName - 服务名称
 * @returns {Object|null} 服务配置
 */
function findServiceByName(serviceName) {
  const lower = serviceName.toLowerCase();
  return SERVICES[lower] || null;
}