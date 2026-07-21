/**
 * Grafana Loki API 客户端
 *
 * 通过 Grafana 代理接口查询 Loki 日志，支持：
 * - 日志查询（LogQL）
 * - 标签/标签值获取
 * - traceId 自动提取
 * - 服务名自动识别（从 filename 标签解析）
 * - 时间范围自动递进（1h → 24h → 72h → 7d）
 */

import { LOKI_ENVIRONMENTS, LOKI_DEFAULTS } from './config.js';
import { log } from './logger.js';

// Loki 查询超时（毫秒）
const LOKI_FETCH_TIMEOUT = 30000;

// 时间范围自动递进策略（毫秒）
const AUTO_RANGE_STEPS = [
  { range: 5 * 60 * 1000,            label: '5 分钟' },
  { range: 30 * 60 * 1000,           label: '30 分钟' },
  { range: 1 * 60 * 60 * 1000,       label: '1 小时' },
  { range: 3 * 60 * 60 * 1000,       label: '3 小时' },
  { range: 24 * 60 * 60 * 1000,      label: '24 小时' },
];

// 递进总预算（毫秒）：避免多步累计超过 MCP 请求兑底超时（60s）
const AUTO_RANGE_BUDGET = 45000;

/** 超时类错误识别（兼容 TIMEOUT/timeout/超时/504） */
function isTimeoutError(msg) {
  return /timeout|超时|504/i.test(msg || '');
}

// ============================================================
// 核心查询
// ============================================================

/**
 * 执行 Loki 日志查询
 * @param {string} envName - 环境名称，如 'cms'
 * @param {string} expr - LogQL 表达式
 * @param {Object} options - 查询选项
 * @param {number} options.from - 起始时间（毫秒时间戳），默认 1 小时前
 * @param {number} options.to - 结束时间（毫秒时间戳），默认当前
 * @param {number} options.maxLines - 最大返回行数，默认 100
 * @param {string} options.direction - 排序方向 'backward'|'forward'，默认 'backward'
 * @returns {Object} { logs: string[], labels: Object[], traceIds: string[], stats: Object }
 */
export async function queryLoki(envName, expr, options = {}) {
  const env = getLokiEnv(envName);
  const now = Date.now();
  const from = options.from || (now - LOKI_DEFAULTS.defaultTimeRange);
  const to = options.to || now;
  const maxLines = options.maxLines || LOKI_DEFAULTS.maxLines;
  const direction = options.direction || 'backward';

  const url = `${env.grafanaUrl}/api/ds/query?ds_type=loki`;
  const body = {
    queries: [{
      refId: 'A',
      expr,
      queryType: 'range',
      datasource: { type: 'loki', uid: env.datasourceUid },
      editorMode: 'builder',
      direction,
      maxLines,
      datasourceId: env.datasourceId,
      intervalMs: 1000,
      maxDataPoints: 1000
    }],
    from: String(from),
    to: String(to)
  };

  log(`[Loki] 查询: env=${envName}, expr=${expr}`);

  // 带超时 + 用户 cancel 的 fetch —— AbortController 覆盖 fetch + body 读取全过程
  // 用户 signal (options.signal) 一旦 abort，立即中断；内部 30s timer 也触发 abort
  const controller = new AbortController();
  const timer = setTimeout(() => {
    log(`[Loki] ⏱ 超时 ${LOKI_FETCH_TIMEOUT}ms，主动 abort: env=${envName}, expr=${expr.substring(0, 80)}`);
    controller.abort(new Error('TIMEOUT'));
  }, LOKI_FETCH_TIMEOUT);

  // 用户 cancel 穿透
  const userSignal = options.signal;
  const onUserAbort = () => {
    log(`[Loki] ⊗ 用户 cancel，主动 abort: env=${envName}`);
    controller.abort(new Error('USER_CANCELLED'));
  };
  if (userSignal) {
    if (userSignal.aborted) onUserAbort();
    else userSignal.addEventListener('abort', onUserAbort, { once: true });
  }

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(env),
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!resp.ok) {
      // 读错误响应体同样受 signal 保护
      const text = await resp.text();
      throw new Error(`Loki 查询失败 (${resp.status}): ${text}`);
    }

    // 读 body 仍在 controller.signal 保护之下：body 卡住会被 abort
    const data = await resp.json();
    return parseLokiResponse(data);
  } catch (e) {
    // abort(reason) 时 fetch 抛出的可能是 reason 本身（message='TIMEOUT'/'USER_CANCELLED'），
    // 也可能是 AbortError，统一按 signal 状态区分原因
    if (e.name === 'AbortError' || controller.signal.aborted) {
      if (userSignal && userSignal.aborted) {
        const err = new Error('CANCELLED');
        err.name = 'AbortError';
        throw err;
      }
      throw new Error(`Loki 查询超时（${LOKI_FETCH_TIMEOUT}ms）`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (userSignal) userSignal.removeEventListener('abort', onUserAbort);
  }
}

/**
 * 带时间范围自动递进的 Loki 查询
 *
 * 策略：1h → 24h → 72h → 7d，找到结果立即返回
 * 如果用户指定了 from/to，则直接使用指定范围，不递进
 *
 * @param {string} envName - 环境名称
 * @param {string} expr - LogQL 表达式
 * @param {Object} options - 查询选项
 * @param {number} options.from - 起始时间戳（毫秒），指定后不递进
 * @param {number} options.to - 结束时间戳（毫秒），指定后不递进
 * @param {number} options.maxLines - 最大返回行数
 * @param {string} options.direction - 排序方向
 * @returns {Object} { logs, labels, traceIds, stats, timeRange: { label, from, to } }
 */
export async function queryLokiAutoRange(envName, expr, options = {}) {
  // 只要指定了 from 就走固定范围（to 缺省取当前时间），不递进
  if (options.from) {
    const to = options.to || Date.now();
    log(`[Loki] 使用指定时间范围查询: ${new Date(options.from).toLocaleString()} ~ ${new Date(to).toLocaleString()}`);
    try {
      const result = await queryLoki(envName, expr, { ...options, to });
      result.timeRange = { label: '指定范围', from: options.from, to };
      return result;
    } catch (e) {
      const isTimeout = isTimeoutError(e.message);
      log(`[Loki] ❌ 指定时间范围查询${isTimeout ? '超时' : '失败'}: ${e.message.substring(0, 200)}`);
      return {
        logs: [], labels: [], traceIds: [], stats: null,
        timeRange: { label: '指定范围', from: options.from, to },
        notFound: true,
        error: isTimeout
          ? '指定范围查询超时（该时间窗内数据量过大），请缩小 from/to 窗口后重试'
          : `查询失败: ${e.message.substring(0, 200)}`
      };
    }
  }

  // 自动递进：从小范围到大范围（总预算 AUTO_RANGE_BUDGET，避免撞 MCP 60s 兑底超时）
  const now = Date.now();
  const startedAt = Date.now();
  const tried = [];
  for (const step of AUTO_RANGE_STEPS) {
    const from = now - step.range;
    const to = now;

    // 总预算检查：剩余时间不足以支撑一次查询时停止递进
    const elapsed = Date.now() - startedAt;
    if (elapsed > AUTO_RANGE_BUDGET - 5000) {
      log(`[Loki] ⏱ 递进总耗时 ${elapsed}ms 接近预算，停止在 ${tried.join(' → ') || '(未开始)'}`);
      return {
        logs: [], labels: [], traceIds: [], stats: null,
        timeRange: { label: tried[tried.length - 1] || '未开始', from: null, to: null },
        notFound: true,
        triedLabels: tried,
        error: `已搜索 ${tried.join(' → ')} 范围未找到，更大范围因耗时预算未尝试。建议用 from/to 指定具体时间窗查询`
      };
    }

    log(`[Loki] 自动递进: 尝试 ${step.label} 范围...`);
    tried.push(step.label);

    try {
      const result = await queryLoki(envName, expr, { ...options, from, to });

      if (result.logs.length > 0) {
        log(`[Loki] ✅ 在 ${step.label} 范围内找到 ${result.logs.length} 行日志`);
        result.timeRange = { label: step.label, from, to };
        result.triedLabels = tried;
        return result;
      }

      log(`[Loki] ⏭️ ${step.label} 范围内无结果，扩大范围...`);
    } catch (e) {
      // 查询超时或失败，停止递进，返回优雅降级结果
      const isTimeout = isTimeoutError(e.message);
      log(`[Loki] ⚠️ ${step.label} 范围查询${isTimeout ? '超时' : '失败'}: ${e.message.substring(0, 200)}`);
      return {
        logs: [], labels: [], traceIds: [], stats: null,
        timeRange: { label: step.label, from, to },
        notFound: true,
        triedLabels: tried,
        error: isTimeout
          ? `${step.label} 范围查询超时（该服务日志量大，已完成 ${tried.slice(0, -1).join(' → ') || '无'} 范围搜索未命中）。建议用 from/to 指定更精确的时间窗查询`
          : `查询在 ${step.label} 范围失败: ${e.message.substring(0, 200)}`
      };
    }
  }

  // 所有范围都没找到
  log(`[Loki] ❌ 所有时间范围均未找到结果`);
  return {
    logs: [],
    labels: [],
    traceIds: [],
    stats: null,
    timeRange: { label: '未找到', from: null, to: null },
    triedLabels: tried,
    notFound: true
  };
}

/**
 * 解析用户传入的时间字符串为毫秒时间戳
 * 支持格式: "2026-02-06 12:00:00", "2026-02-06", ISO 8601 等
 * @param {string} timeStr - 时间字符串
 * @returns {number|null} 毫秒时间戳，解析失败返回 null
 */
export function parseTimeStr(timeStr) {
  if (!timeStr) return null;
  // 如果是纯数字，当作时间戳
  if (/^\d{10,13}$/.test(timeStr)) {
    const ts = parseInt(timeStr);
    return ts < 1e12 ? ts * 1000 : ts; // 秒 → 毫秒
  }
  const d = new Date(timeStr);
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ============================================================
// 标签查询
// ============================================================

/** 获取 Loki 标签列表 */
export async function getLokiLabels(envName) {
  const env = getLokiEnv(envName);
  const now = Date.now();
  const start = (now - LOKI_DEFAULTS.defaultTimeRange) * 1_000_000;
  const end = now * 1_000_000;
  const url = `${env.grafanaUrl}/api/datasources/uid/${env.datasourceUid}/resources/labels?start=${start}&end=${end}`;
  const resp = await fetch(url, { headers: buildHeaders(env) });
  if (!resp.ok) throw new Error(`获取标签失败 (${resp.status})`);
  const data = await resp.json();
  return data.data || [];
}

/** 获取 Loki 标签值 */
export async function getLokiLabelValues(envName, label, query = '') {
  const env = getLokiEnv(envName);
  const now = Date.now();
  const start = (now - LOKI_DEFAULTS.defaultTimeRange) * 1_000_000;
  const end = now * 1_000_000;
  let url = `${env.grafanaUrl}/api/datasources/uid/${env.datasourceUid}/resources/label/${label}/values?start=${start}&end=${end}`;
  if (query) url += `&query=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: buildHeaders(env) });
  if (!resp.ok) throw new Error(`获取标签值失败 (${resp.status})`);
  const data = await resp.json();
  return data.data || [];
}

// ============================================================
// 响应解析
// ============================================================

/** 解析 Grafana Loki 查询响应 */
export function parseLokiResponse(data) {
  const result = { logs: [], labels: [], traceIds: [], stats: null };
  const frames = data?.results?.A?.frames;
  if (!frames || frames.length === 0) return result;

  for (const frame of frames) {
    const values = frame?.data?.values;
    if (!values || values.length < 3) continue;
    // values[0]: 标签数组, values[1]: 时间戳数组, values[2]: 日志行数组
    const labelsArr = values[0] || [];
    const linesArr = values[2] || [];
    for (let i = 0; i < linesArr.length; i++) {
      result.logs.push(linesArr[i]);
      result.labels.push(labelsArr[i] || {});
    }
  }

  result.traceIds = extractTraceIds(result.logs);

  const stats = frames[0]?.schema?.meta?.stats;
  if (stats) {
    result.stats = {};
    for (const s of stats) { result.stats[s.displayName] = s.value; }
  }
  return result;
}

// ============================================================
// traceId 提取
// ============================================================

/**
 * 从日志行中提取 traceId（32位十六进制，在方括号中）
 * 日志格式: [clife-senior] 时间 级别 [服务] [pod] [线程] [OT-spanId] [traceId] 类名 - 内容
 */
export function extractTraceIds(lines) {
  const traceIdSet = new Set();

  const regex = /\[([a-f0-9]{32})\]/gi;
  for (const line of lines) {
    let match;
    while ((match = regex.exec(line)) !== null) {
      traceIdSet.add(match[1].toLowerCase());
    }
    regex.lastIndex = 0;
  }
  return [...traceIdSet];
}

// ============================================================
// 服务名解析
// ============================================================

/**
 * 从 Loki filename 标签中解析服务名
 * filename 格式: /data/services/logs/senior/clife-senior-health-app/normal_logs/normal.log
 * 解析结果: clife-senior-health
 */
export function parseServiceFromFilename(filename) {
  if (!filename) return null;
  // 提取日志目录段: .../{dir}/normal_logs/normal.log 或 .../{dir}/application.out
  // 再剥离部署后缀（-app/-service/-start），兼容无后缀目录（如 clife-senior-svc-fulfill）
  const m = filename.match(/\/([^/]+)\/(?:normal_logs\/[^/]+|application\.out)$/);
  if (m) return m[1].replace(/-(app|service|start)$/, '');
  // 兜底：匹配 /{service-name}-app/ 或 /{service-name}-service/ 模式
  const match = filename.match(/\/([a-zA-Z0-9-]+?)(?:-app|-service)\//);
  if (match) return match[1];
  return null;
}

/**
 * 将查询结果按服务分组
 * @param {Object} lokiResult - parseLokiResponse 的返回值
 * @returns {Object} { serviceName: { logs: string[], traceIds: string[] } }
 */
export function groupLogsByService(lokiResult) {
  const groups = {};

  for (let i = 0; i < lokiResult.logs.length; i++) {
    const label = lokiResult.labels[i] || {};
    const serviceName = parseServiceFromFilename(label.filename) || 'unknown';
    const logLine = lokiResult.logs[i];

    if (!groups[serviceName]) {
      groups[serviceName] = { logs: [], traceIds: new Set() };
    }
    groups[serviceName].logs.push(logLine);

    // 从该行提取 traceId
    const ids = extractTraceIds([logLine]);
    ids.forEach(id => groups[serviceName].traceIds.add(id));
  }

  // Set → Array
  for (const key of Object.keys(groups)) {
    groups[key].traceIds = [...groups[key].traceIds];
  }

  return groups;
}

// ============================================================
// LogQL 构建辅助
// ============================================================

/**
 * 构建按服务查询的 LogQL 表达式
 * 根据环境是否有 project 标签，自动选择不同的 filename 路径格式：
 *   - 有 project 标签（CMS / 预发布）: /data/services/logs/senior/clife-senior-health-app/normal_logs/normal.log
 *   - 无 project 标签（私有化）: /data/services/logs/clife-senior-health-app/normal_logs/normal.log
 *
 * 注意 path 与 label 的差异：
 *   - 预发布 label 是 'pre-senior'（用于 LogQL 标签匹配，不在这里）
 *   - 预发布 path 仍然是 'senior'（写在 filename 路径里）
 *   通过环境配置的 pathProject 字段单独控制路径段，避免与 label 混用
 *
 * @param {string} project - 项目 label，如 'senior' / 'pre-senior'（仅当环境无 pathProject 字段时回退使用）
 * @param {string} servicePodPattern - 服务目录名，如 'clife-senior-health-app'
 * @param {string} keyword - 搜索关键词（可选）
 * @param {string} envName - 环境名称，如 'cms'、'pre'、'chengyang'
 * @param {string} logSubPath - 日志子路径，如 'normal_logs/normal.log' 或 'application.out'（默认 'normal_logs/normal.log'）
 */
export function buildServiceLogQL(project, servicePodPattern, keyword = '', envName = '', logSubPath = 'normal_logs/normal.log') {
  const env = envName ? LOKI_ENVIRONMENTS[envName] : null;
  const hasProject = env ? env.hasProjectLabel !== false : true;
  // 路径段优先使用 env.pathProject（预发布需要 label='pre-senior' 但 path='senior'），回退到 project
  const pathSegment = (env && env.pathProject) || project;

  // 有 project 标签的环境: /data/services/logs/{pathSegment}/xxx-app/...
  // 无 project 标签的环境: /data/services/logs/xxx-app/...
  const filename = hasProject
    ? `/data/services/logs/${pathSegment}/${servicePodPattern}/${logSubPath}`
    : `/data/services/logs/${servicePodPattern}/${logSubPath}`;

  let expr = `{filename="${filename}"}`;
  if (keyword) {
    expr += keywordFilter(keyword);
  }
  return expr;
}

/**
 * 根据关键词形态选择 line filter：
 * - 含正则元字符（| ( ) [ ] 等）→ |~ 正则匹配（支持 a|b 多关键词）
 * - 纯字面量 → |= 子串匹配（Loki 快一个量级，大日志量服务不易超时）
 * 字符串形式：默认 backtick（无转义语义）；关键词本身含反引号时切双引号并转义
 */
function keywordFilter(keyword) {
  const hasRegexMeta = /[|()\[\]{}.*+?^$\\]/.test(keyword);
  const op = hasRegexMeta ? '|~' : '|=';
  if (keyword.includes('`')) {
    const escaped = keyword.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return ` ${op} "${escaped}"`;
  }
  return ` ${op} \`${keyword}\``;
}

/**
 * 构建按项目查询的 LogQL 表达式（搜索整个项目所有服务）
 * 根据环境是否有 project 标签，自动选择不同的查询方式：
 *   - 有 project 标签（CMS）: {project="senior"} |= `keyword`
 *   - 无 project 标签（私有化）: {filename=~"/data/services/logs/clife-senior-.*normal.log"} |= `keyword`
 *
 * @param {string} project - 项目名，如 'senior'
 * @param {string} keyword - 搜索关键词
 * @param {string} envName - 环境名称，如 'cms'、'chengyang'
 */
export function buildProjectLogQL(project, keyword, envName = '') {
  const env = envName ? LOKI_ENVIRONMENTS[envName] : null;
  const hasProject = env ? env.hasProjectLabel !== false : true;

  if (hasProject) {
    // CMS: 直接用 project 标签，高效精确
    return `{project="${project}"}${keywordFilter(keyword)}`;
  } else {
    // 私有化: 用 filename 正则匹配所有 clife-{project}-* 服务的 normal.log
    return `{filename=~"/data/services/logs/clife-${project}-.*normal.log"}${keywordFilter(keyword)}`;
  }
}

// ============================================================
// 内部辅助函数
// ============================================================

/** 获取 Loki 环境配置 */
function getLokiEnv(envName) {
  const env = LOKI_ENVIRONMENTS[envName];
  if (!env) {
    const available = Object.keys(LOKI_ENVIRONMENTS).join(', ');
    throw new Error(`未知的 Loki 环境 "${envName}"，可用环境: ${available}`);
  }
  return env;
}

/** 构建请求头 */
function buildHeaders(env) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'x-grafana-org-id': String(env.orgId || 1),
    'x-plugin-id': 'loki',
    'x-datasource-uid': env.datasourceUid
  };

  // 如果配置了认证信息，添加 Basic Auth
  if (env.username && env.password) {
    const auth = Buffer.from(`${env.username}:${env.password}`).toString('base64');
    headers['Authorization'] = `Basic ${auth}`;
  }

  return headers;
}

// ============================================================
// 公共辅助函数
// ============================================================

/** 获取所有可用的 Loki 环境列表 */
export function listLokiEnvironments() {
  return Object.entries(LOKI_ENVIRONMENTS).map(([key, env]) => ({
    name: key,
    description: env.description,
    grafanaUrl: env.grafanaUrl,
    project: env.defaultProject
  }));
}

/**
 * 获取指定环境下的服务列表（从 Loki filename 标签动态获取）
 * 根据环境是否有 project 标签，使用不同的查询方式：
 *   - 有 project 标签（CMS）: 用 {project="senior"} 过滤
 *   - 无 project 标签（私有化）: 获取全部 filename 后按 clife-{project}- 前缀过滤
 *
 * @param {string} envName - 环境名称
 * @param {string} project - 项目名，如 'senior'
 * @returns {string[]} 服务名列表
 */
export async function listLokiServices(envName, project = 'senior') {
  const env = LOKI_ENVIRONMENTS[envName];
  const hasProject = env ? env.hasProjectLabel !== false : true;

  let filenames;
  if (hasProject) {
    // CMS: 直接用 project 标签过滤
    filenames = await getLokiLabelValues(envName, 'filename', `{project="${project}"}`);
  } else {
    // 私有化: 获取全部 filename，然后按 clife-{project}- 前缀过滤
    filenames = await getLokiLabelValues(envName, 'filename');
    filenames = filenames.filter(f => f.includes(`/clife-${project}-`));
  }

  const serviceSet = new Set();
  for (const f of filenames) {
    // 匹配标准日志 normal_logs/normal.log 和非标准日志（如 application.out）
    if (!f.includes('/normal_logs/normal.log') && !f.endsWith('/application.out')) continue;
    const svc = parseServiceFromFilename(f);
    if (svc) serviceSet.add(svc);
  }

  return [...serviceSet].sort();
}

/**
 * 根据服务简称获取 Loki 中的服务目录名
 * 例如: 'health' → 'clife-senior-health-app'
 * @param {string} serviceName - 服务简称，如 'health', 'core', 'gateway'
 * @returns {string} 服务目录名
 */
export function getLokiServiceDirName(serviceName) {
  // 如果已经是完整名称，直接返回
  if (serviceName.startsWith('clife-senior-')) {
    return serviceName.endsWith('-app') ? serviceName : `${serviceName}-app`;
  }
  // 简称转完整名称
  return `clife-senior-${serviceName}-app`;
}

/**
 * 根据 config.js 中的服务配置，推算 Loki 中的日志子路径
 * 大多数服务: normal_logs/normal.log
 * 特殊服务（如 device-warn）: application.out
 *
 * @param {Object|null} serviceConfig - config.js 中的服务配置对象（findService 返回值）
 * @returns {string} 日志子路径，如 'normal_logs/normal.log' 或 'application.out'
 */
export function getLokiLogSubPath(serviceConfig) {
  if (!serviceConfig) return 'normal_logs/normal.log';
  const logFile = serviceConfig.logFile || 'normal.log';
  // logPath 以 /normal_logs 结尾 → 标准结构: normal_logs/normal.log
  // logPath 不含 normal_logs → 非标准（如 device-warn）: 直接用 logFile
  const logPath = serviceConfig.logPath || '';
  if (logPath.endsWith('/normal_logs')) {
    return `normal_logs/${logFile}`;
  }
  // 非标准路径，直接使用 logFile（如 application.out）
  return logFile;
}
