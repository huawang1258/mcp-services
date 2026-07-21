/**
 * 服务自动发现模块
 *
 * 解决 SERVICES 静态配置表滞后问题：新服务上线后无需手动改 config.js。
 *
 * 两条发现路径：
 * 1. Loki（生产/预发/私有化）：从 filename 标签值动态解析服务目录名 + 日志子路径
 * 2. K8s（测试环境 SSH）：kubectl get deploy 发现服务，pod 内探测真实日志文件路径
 *
 * 静态 SERVICES 仍然优先（提供中文别名和快速路径），未命中时走动态发现。
 * 发现结果带 TTL 缓存，避免每次查询都打 Loki / SSH。
 */

import { SERVICES, findService, DEFAULT_NAMESPACE } from './config.js';
import { getLokiLabelValues } from './loki-client.js';
import { executeKubectl } from './ssh-client.js';
import { log } from './logger.js';

// 发现结果缓存 TTL（毫秒）
const DISCOVERY_CACHE_TTL = 10 * 60 * 1000;

// cacheKey -> { ts, data }
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > DISCOVERY_CACHE_TTL) {
    _cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  _cache.set(key, { ts: Date.now(), data });
}

/** 手动清空发现缓存（服务刚部署时可用） */
export function clearDiscoveryCache() {
  _cache.clear();
}

// ============================================================
// Loki 侧发现
// ============================================================

/**
 * 从 Loki filename 标签构建服务注册表
 * filename 形如:
 *   有 project 标签: /data/services/logs/senior/clife-senior-health-app/normal_logs/normal.log
 *   无 project 标签: /data/services/logs/clife-senior-health-app/application.out
 *
 * @param {string} envName - Loki 环境 key（已 resolve）
 * @param {Object} envConfig - LOKI_ENVIRONMENTS[envName]
 * @returns {Map<string, {serviceName, dirName, logSubPath}>} key 为 serviceName（去掉 -app/-service 后缀）
 */
export async function discoverLokiRegistry(envName, envConfig) {
  const cacheKey = `loki:${envName}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const hasProject = envConfig.hasProjectLabel !== false;
  const pathProject = envConfig.pathProject || envConfig.defaultProject || 'senior';
  const labelProject = envConfig.defaultProject || 'senior';

  let filenames;
  if (hasProject) {
    filenames = await getLokiLabelValues(envName, 'filename', `{project="${labelProject}"}`);
  } else {
    filenames = await getLokiLabelValues(envName, 'filename');
  }

  const registry = new Map();
  for (const f of filenames) {
    const parsed = parseLokiFilename(f, hasProject ? pathProject : null);
    if (!parsed) continue;
    // 同一服务可能有多个日志文件，优先 normal.log，其次 application.out，忽略其他
    const existing = registry.get(parsed.serviceName);
    if (existing && existing.logSubPath.endsWith('normal.log')) continue;
    if (!parsed.logSubPath.endsWith('normal.log') && !parsed.logSubPath.endsWith('application.out')) continue;
    registry.set(parsed.serviceName, parsed);
  }

  log(`[Discovery] Loki ${envName}: 发现 ${registry.size} 个服务`);
  cacheSet(cacheKey, registry);
  return registry;
}

/**
 * 解析单个 Loki filename
 * @param {string} filename
 * @param {string|null} pathProject - 有 project 标签的环境传路径中的 project 段，无则 null
 * @returns {{serviceName, dirName, logSubPath}|null}
 */
function parseLokiFilename(filename, pathProject) {
  if (!filename) return null;
  const prefix = pathProject
    ? `/data/services/logs/${pathProject}/`
    : '/data/services/logs/';
  if (!filename.startsWith(prefix)) return null;

  const rest = filename.slice(prefix.length); // e.g. clife-senior-health-app/normal_logs/normal.log
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;

  const dirName = rest.slice(0, slash);
  const logSubPath = rest.slice(slash + 1);
  if (!dirName || !logSubPath) return null;

  return { serviceName: stripDirSuffix(dirName), dirName, logSubPath };
}

/** clife-senior-health-app -> clife-senior-health；fulfill-center 原样返回（后缀集与 loki-client.parseServiceFromFilename 保持一致） */
function stripDirSuffix(dirName) {
  return dirName.replace(/-(app|service|start)$/, '');
}

/** namespace 防呆校验：只允许 k8s 合法字符，防拼接进 shell 的意外输入 */
function assertSafeNamespace(ns) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(ns)) {
    throw new Error(`非法 namespace: ${ns}`);
  }
}

/**
 * 从 deployment 名剥离部署后缀，得到服务基名
 * 例: clife-senior-svc-fulfill-saas-itest -> clife-senior-svc-fulfill
 *     clife-common-ai-app-saas-itest-dm -> clife-common-ai-app
 */
function deploymentBaseName(deployment, namespace) {
  let base = deployment.replace(/-dm$/, '');
  if (namespace && base.endsWith(`-${namespace}`)) {
    base = base.slice(0, -(namespace.length + 1));
  }
  return base;
}

/**
 * 解析 Loki 查询目标：静态配置优先，未命中走动态发现，最后回退猜测
 * @param {string} envName - Loki 环境 key（已 resolve）
 * @param {Object} envConfig - LOKI_ENVIRONMENTS[envName]
 * @param {string} nameOrAlias - 用户输入的服务名/别名
 * @returns {{dirName, logSubPath, source, resolvedName}}
 */
export async function resolveLokiTarget(envName, envConfig, nameOrAlias) {
  // 1. 静态配置命中（支持中文别名）
  const staticSvc = findService(nameOrAlias);
  const staticDirName = staticSvc ? staticSvc.podPattern : null;
  const staticSubPath = staticSvc ? staticLogSubPath(staticSvc) : null;

  // 2. 动态发现（发现失败不阻塞，降级用静态/猜测）
  let registry = null;
  try {
    registry = await discoverLokiRegistry(envName, envConfig);
  } catch (e) {
    log(`[Discovery] Loki ${envName} 发现失败，降级: ${e.message.substring(0, 120)}`);
  }

  if (registry) {
    const hit = matchInRegistry(registry, nameOrAlias, staticSvc ? staticSvc.name : null);
    if (hit) {
      return { dirName: hit.dirName, logSubPath: hit.logSubPath, source: 'discovery', resolvedName: hit.serviceName };
    }
  }

  // 3. 静态配置兜底
  if (staticSvc) {
    return { dirName: staticDirName, logSubPath: staticSubPath, source: 'static', resolvedName: staticSvc.name };
  }

  // 4. 最后回退旧行为：猜 clife-senior-{name}-app
  const guess = nameOrAlias.startsWith('clife-senior-')
    ? (nameOrAlias.endsWith('-app') || nameOrAlias.endsWith('-service') ? nameOrAlias : `${nameOrAlias}-app`)
    : `clife-senior-${nameOrAlias}-app`;
  return { dirName: guess, logSubPath: 'normal_logs/normal.log', source: 'guess', resolvedName: nameOrAlias };
}

/** 从静态配置推算日志子路径（对齐 getLokiLogSubPath 逻辑，避免循环依赖） */
function staticLogSubPath(serviceConfig) {
  const logFile = serviceConfig.logFile || 'normal.log';
  const logPath = serviceConfig.logPath || '';
  return logPath.endsWith('/normal_logs') ? `normal_logs/${logFile}` : logFile;
}

/**
 * 注册表内匹配：精确名 -> 静态解析名 -> 唯一子串
 * @param {Map} registry
 * @param {string} nameOrAlias
 * @param {string|null} staticName - 静态配置解析出的标准名（别名映射结果）
 */
function matchInRegistry(registry, nameOrAlias, staticName) {
  const lower = nameOrAlias.toLowerCase();
  const normalized = stripDirSuffix(lower);

  // 精确匹配（含去后缀）
  if (registry.has(lower)) return registry.get(lower);
  if (registry.has(normalized)) return registry.get(normalized);

  // 静态别名解析出的标准名
  if (staticName && registry.has(staticName)) return registry.get(staticName);

  // 子串匹配：取名字最短的命中（最精确）
  let best = null;
  for (const [svcName, entry] of registry) {
    if (svcName.includes(normalized) || normalized.includes(svcName)) {
      if (!best || svcName.length < best.serviceName.length) best = entry;
    }
  }
  return best;
}

// ============================================================
// K8s 侧发现（测试环境 SSH）
// ============================================================

/**
 * 发现 namespace 下所有 deployment 名
 * @param {string} namespace
 * @param {AbortSignal} [signal]
 * @returns {string[]} deployment 名列表
 */
export async function discoverK8sDeployments(namespace, signal) {
  assertSafeNamespace(namespace);
  const cacheKey = `k8s-deploy:${namespace}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const cmd = `kubectl get deploy -n ${namespace} -o name`;
  const output = await executeKubectl(cmd, { signal });

  const deployments = output
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.includes('deployment.apps/'))
    .map(l => l.slice(l.indexOf('deployment.apps/') + 'deployment.apps/'.length))
    .map(l => l.replace(/[^a-zA-Z0-9-].*$/, '')) // 去掉行尾终端噪音
    .filter(Boolean);

  log(`[Discovery] K8s ${namespace}: 发现 ${deployments.length} 个 deployment`);
  cacheSet(cacheKey, deployments);
  return deployments;
}

/**
 * 在 pod 内探测真实日志文件路径
 * 注意: /www/logs/ 是节点共享卷，会列出同节点所有服务的日志目录，
 * 必须按服务基名精确匹配目录，匹配不到宁可返回 null 也不能乱选
 *
 * @param {string} namespace
 * @param {string} podPattern - 用于 grep pod 的 deployment 名
 * @param {string} serviceBase - 服务基名（已剥离部署后缀），用于匹配日志目录
 * @param {AbortSignal} [signal]
 * @returns {{logPath, logFile}|null}
 */
async function probeLogTarget(namespace, podPattern, serviceBase, signal) {
  assertSafeNamespace(namespace);
  const cacheKey = `k8s-probe:${namespace}:${podPattern}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const shellScript = `for d in /www/logs/*; do if [ -f "$d/normal_logs/normal.log" ]; then echo "FOUND:$d/normal_logs/normal.log"; elif [ -f "$d/application.out" ]; then echo "FOUND:$d/application.out"; fi; done`;
  const cmd = `kubectl exec $(kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1) -n ${namespace} -- sh -c '${shellScript}'`;
  const output = await executeKubectl(cmd, { signal });

  const found = output
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('FOUND:'))
    .map(l => l.slice('FOUND:'.length));

  if (found.length === 0) return null;

  // 按服务基名匹配目录: /www/logs/{dir}/... 中 dir === base 或 dir 以 base- 开头
  const base = serviceBase.toLowerCase();
  const matches = found.filter(f => {
    const m = f.match(/^\/www\/logs\/([^/]+)\//);
    if (!m) return false;
    const dir = m[1].toLowerCase();
    return dir === base || dir.startsWith(`${base}-`);
  });

  if (matches.length === 0) {
    log(`[Discovery] 探测到 ${found.length} 个日志目录，但无一匹配服务基名 ${serviceBase}`);
    return null;
  }

  // 优先 normal.log（结构化 logback 日志），其次 application.out；同类取目录名最短（最精确）
  const sorted = matches.sort((a, b) => {
    const aNormal = a.endsWith('normal.log') ? 0 : 1;
    const bNormal = b.endsWith('normal.log') ? 0 : 1;
    if (aNormal !== bNormal) return aNormal - bNormal;
    return a.length - b.length;
  });
  const preferred = sorted[0];

  const lastSlash = preferred.lastIndexOf('/');
  const result = {
    logPath: preferred.slice(0, lastSlash),
    logFile: preferred.slice(lastSlash + 1)
  };

  log(`[Discovery] 探测日志路径: ${serviceBase} -> ${preferred}`);
  cacheSet(cacheKey, result);
  return result;
}

/**
 * 解析 K8s 测试环境服务：静态配置优先，未命中走 deployment 发现 + 日志探测
 * @param {string} nameOrAlias - 服务名/别名
 * @param {string|null} namespace - 指定 namespace（null 用默认）
 * @param {AbortSignal} [signal]
 * @param {Object} [options]
 * @param {boolean} [options.skipProbe] - 跳过 pod 内日志路径探测（trace_log 全量扫描等批量场景，
 *   每次探测是一次 SSH exec 往返 3-5s，批量时改用约定路径猜测）
 * @returns {Object|null} 服务配置对象（结构同 SERVICES 条目，动态发现的带 discovered: true）
 */
export async function resolveK8sService(nameOrAlias, namespace, signal, options = {}) {
  // 1. 静态配置命中
  const staticSvc = findService(nameOrAlias, namespace);
  if (staticSvc) return staticSvc;

  const ns = namespace || DEFAULT_NAMESPACE;

  // 2. deployment 发现
  let deployments;
  try {
    deployments = await discoverK8sDeployments(ns, signal);
  } catch (e) {
    log(`[Discovery] K8s ${ns} deployment 发现失败: ${e.message.substring(0, 120)}`);
    return null;
  }

  const lower = nameOrAlias.toLowerCase();
  const matches = deployments.filter(d => d.toLowerCase().includes(lower));
  if (matches.length === 0) return null;
  // 多个命中取最短（最精确）
  const deployment = matches.sort((a, b) => a.length - b.length)[0];
  const serviceBase = deploymentBaseName(deployment, ns);

  // 3. 探测日志路径（按服务基名匹配共享卷里的目录；批量场景 skipProbe 直接猜测）
  let target = null;
  if (!options.skipProbe) {
    try {
      target = await probeLogTarget(ns, deployment, serviceBase, signal);
    } catch (e) {
      log(`[Discovery] 日志路径探测失败 (${deployment}): ${e.message.substring(0, 120)}`);
    }
  }

  if (!target) {
    // 探测失败/跳过探测按约定猜路径：/www/logs/{serviceBase}/normal_logs/normal.log
    target = { logPath: `/www/logs/${serviceBase}/normal_logs`, logFile: 'normal.log' };
  }

  return {
    name: serviceBase,
    description: `动态发现的服务（deployment: ${deployment}）`,
    namespace: ns,
    podPattern: deployment,
    logPath: target.logPath,
    logFile: target.logFile,
    aliases: [],
    discovered: true
  };
}

/**
 * 获取 trace_log 全量搜索的服务清单：静态表 + K8s 动态发现合并
 * 发现失败时降级为纯静态表
 * @param {string|null} namespace
 * @param {AbortSignal} [signal]
 * @returns {string[]} 服务名列表
 */
export async function getAllServiceNames(namespace, signal) {
  const staticNames = Object.keys(SERVICES);
  const ns = namespace || DEFAULT_NAMESPACE;

  let deployments = [];
  try {
    deployments = await discoverK8sDeployments(ns, signal);
  } catch (e) {
    log(`[Discovery] trace_log 服务发现失败，使用静态表: ${e.message.substring(0, 120)}`);
    return staticNames;
  }

  // 静态表已覆盖的 deployment 不重复加入（用服务基名比较）
  const staticPatterns = Object.values(SERVICES).map(s => s.podPattern.toLowerCase());
  const extra = deployments
    .map(d => deploymentBaseName(d, ns))
    .filter(base => {
      const bl = base.toLowerCase();
      return !staticPatterns.some(p => bl.includes(p) || p.includes(bl));
    });

  if (extra.length > 0) {
    log(`[Discovery] trace_log 额外发现 ${extra.length} 个未注册服务: ${extra.join(', ')}`);
  }
  return [...staticNames, ...extra];
}
