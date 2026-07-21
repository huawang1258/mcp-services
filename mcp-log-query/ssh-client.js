/**
 * SSH Client - 通过 JumpServer 堡垒机连接 K8s 服务器并执行命令
 *
 * JumpServer 交互流程：
 * 1. SSH 连接堡垒机，等待 Opt> 提示符
 * 2. 输入目标服务器 IP，等待 [Host]> 提示符
 * 3. 输入服务器 ID (如 1)，等待进入服务器 shell
 * 4. 执行 kubectl 命令查询日志
 * 5. 退出
 *
 * 注意：
 * - 堡垒机只有 30 秒等待时间，必须快速响应！
 * - 使用 \r 而不是 \n 发送命令
 */

import { Client } from 'ssh2';
import { JUMP_HOST, K8S_SERVER, DEFAULTS } from './config.js';
import { log } from './logger.js';

// ============================================================
// 并发信号量：防止同时打开过多堡垒机会话被踢
// ============================================================
const SSH_MAX_CONCURRENT = parseInt(process.env.SSH_MAX_CONCURRENT || '3', 10);
const SSH_QUEUE_MAX = parseInt(process.env.SSH_QUEUE_MAX || '50', 10);
// 排队等待最长时间（毫秒），防止前面请求卡死后面无限等
const SSH_ACQUIRE_TIMEOUT = parseInt(process.env.SSH_ACQUIRE_TIMEOUT || '60000', 10);

const _sshSem = {
  active: 0,
  queue: [],
  max: SSH_MAX_CONCURRENT,
  queueMax: SSH_QUEUE_MAX,
};

/**
 * 获取 SSH 信号量槽位
 * @param {number} [timeoutMs] - 排队超时（默认 60s），防止无限等
 * @param {AbortSignal} [signal] - 用户 cancel 信号，abort 时立即从队列移除并 reject
 * @returns {Promise<void>}
 */
function sshAcquire(timeoutMs = SSH_ACQUIRE_TIMEOUT, signal) {
  if (signal && signal.aborted) {
    return Promise.reject(new Error('CANCELLED before SSH acquire'));
  }
  if (_sshSem.active < _sshSem.max) {
    _sshSem.active++;
    log(`[SSH-Sem] acquire 直接通过 (active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length})`);
    return Promise.resolve();
  }
  if (_sshSem.queue.length >= _sshSem.queueMax) {
    return Promise.reject(new Error(`SSH 并发队列已满（>${_sshSem.queueMax}），请稍后重试`));
  }
  log(`[SSH-Sem] acquire 进入排队 (active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length + 1}, timeout=${timeoutMs}ms)`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let onAbort;
    const cleanup = () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const enterQueue = () => {
      if (settled) return; // 已超时/已取消，放弃并立刻腾位给下一个
      settled = true;
      cleanup();
      _sshSem.active++;
      log(`[SSH-Sem] acquire 出队获得槽位 (active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length})`);
      resolve();
    };
    _sshSem.queue.push(enterQueue);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const idx = _sshSem.queue.indexOf(enterQueue);
      if (idx >= 0) _sshSem.queue.splice(idx, 1);
      log(`[SSH-Sem] acquire 排队超时 (${timeoutMs}ms, active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length})`);
      reject(new Error(`SSH 排队等待超时 (${timeoutMs}ms)：前面请求卡住，或并发过高。可调整 SSH_MAX_CONCURRENT / SSH_ACQUIRE_TIMEOUT`));
    }, timeoutMs);
    // 用户 cancel：立即从队列移除
    onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const idx = _sshSem.queue.indexOf(enterQueue);
      if (idx >= 0) _sshSem.queue.splice(idx, 1);
      log(`[SSH-Sem] acquire 用户 cancel，从队列移除 (active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length})`);
      reject(new Error('CANCELLED in SSH queue'));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sshRelease() {
  _sshSem.active = Math.max(0, _sshSem.active - 1);
  // 超时的 entry 已在 timer 里从 queue 移除，这里 shift 到的都是活的
  const next = _sshSem.queue.shift();
  if (next) next();
  log(`[SSH-Sem] release (active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length})`);
}

/**
 * 执行日志查询
 * @param {Object} service - 服务配置
 * @param {string} command - 日志查询命令（如 tail -100 *.log）
 * @param {Object} options - 选项
 * @returns {Promise<string>} 日志内容
 */
export async function queryLog(service, command, options = {}) {
  const timeout = options.timeout || DEFAULTS.timeout;
  const signal = options.signal;

  await sshAcquire(undefined, signal);
  try {
    return await new Promise((resolve, reject) => {
    const conn = new Client();
    let buffer = '';  // 累积所有输出
    let timeoutId;
    let stage = 'init';  // init -> opt -> host -> server -> kubectl -> done
    let kubectlOutput = '';
    let collectingOutput = false;

    // 设置超时 - 使用 destroy() 强制关闭
    let settled = false;
    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { conn.destroy(); } catch {};
        reject(new Error(`命令执行超时 (${timeout}ms)`));
      }
    }, timeout);

    // 用户 cancel：立即 destroy 连接
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      log(`[SSH] ⊗ 用户 cancel，destroy 连接 (${service.name})`);
      try { conn.destroy(); } catch {};
      reject(new Error('CANCELLED during SSH'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm', rows: 24, cols: 500 }, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          if (!settled) { settled = true; reject(err); }
          return;
        }

        stream.on('close', () => {
          clearTimeout(timeoutId);
          try { conn.destroy(); } catch {}
          if (!settled) {
            settled = true;
            resolve(cleanTerminalOutput(kubectlOutput || buffer));
          }
        });

        stream.on('data', (data) => {
          if (settled) return; // 已超时，忽略后续数据
          const text = data.toString();
          buffer += text;

          if (collectingOutput) {
            kubectlOutput += text;
          }

          // JumpServer 状态机
          if (stage === 'init' && buffer.includes('Opt>')) {
            stage = 'opt';
            stream.write(K8S_SERVER.host + '\r');
          }
          else if (stage === 'opt' && buffer.includes('[Host]>')) {
            stage = 'host';
            stream.write(K8S_SERVER.selectOption + '\r');
          }
          else if (stage === 'host' && (buffer.includes('~]$') || buffer.includes('~]#'))) {
            stage = 'server';
            const kubectlCmd = buildKubectlCommand(service, command);
            kubectlOutput = '';
            collectingOutput = true;
            stream.write(kubectlCmd + '\r');
            stage = 'kubectl';
          }
          else if (stage === 'kubectl' && collectingOutput && kubectlOutput.length > 50) {
            if (kubectlOutput.includes('~]$') || kubectlOutput.includes('~]#')) {
              stage = 'done';
              collectingOutput = false;
              stream.write('exit\r');
              stream.write('exit\r');
              setTimeout(() => { try { stream.end(); } catch {} }, 300);
            }
          }
        });

        stream.stderr.on('data', () => {});
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      if (!settled) { settled = true; reject(new Error(`SSH 连接错误: ${err.message}`)); }
    });

    conn.connect({
      host: JUMP_HOST.host,
      port: JUMP_HOST.port,
      username: JUMP_HOST.username,
      password: JUMP_HOST.password,
      readyTimeout: DEFAULTS.connectTimeout
    });
  });
  } finally {
    sshRelease();
  }
}

/**
 * 构建 kubectl exec 命令
 * @param {Object} service - 服务配置
 * @param {string} logCommand - 日志命令，如 "tail -100" 或 "grep error"
 */
function buildKubectlCommand(service, logCommand) {
  const { namespace, podPattern, logPath, logFile } = service;
  const file = logFile || 'normal.log';
  const fullPath = `${logPath}/${file}`;

  return `kubectl exec $(kubectl get pod -n ${namespace} -o name | grep ${podPattern} | head -1) -n ${namespace} -- ${logCommand} ${fullPath}`;
}

/**
 * 清理终端输出中的控制字符
 */
function cleanTerminalOutput(output) {
  return output
    // 移除 ANSI 转义序列
    .replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
    // 移除其他控制字符
    .replace(/\x1B\][^\x07]*\x07/g, '')
    // 移除回车符
    .replace(/\r/g, '')
    // 移除堡垒机提示信息（根据实际情况调整）
    .split('\n')
    .filter(line => {
      // 过滤掉提示行和空行
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith('Last login:')) return false;
      if (trimmed.includes('Welcome')) return false;
      if (trimmed.match(/^\[.*@.*\][$#]/)) return false;
      return true;
    })
    .join('\n')
    .trim();
}

/**
 * 测试 SSH 连接
 */
export async function testConnection() {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    const timeoutId = setTimeout(() => {
      conn.end();
      reject(new Error('连接超时'));
    }, DEFAULTS.connectTimeout);
    
    conn.on('ready', () => {
      clearTimeout(timeoutId);
      conn.end();
      resolve({ success: true, message: '堡垒机连接成功' });
    });
    
    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`连接失败: ${err.message}`));
    });
    
    conn.connect({
      host: JUMP_HOST.host,
      port: JUMP_HOST.port,
      username: JUMP_HOST.username,
      password: JUMP_HOST.password,
      readyTimeout: DEFAULTS.connectTimeout
    });
  });
}


/**
 * 执行通用 kubectl 命令
 * @param {string} kubectlCommand - 完整的 kubectl 命令
 * @param {Object} options - 选项
 * @returns {Promise<string>} 命令输出
 */
export async function executeKubectl(kubectlCommand, options = {}) {
  const timeout = options.timeout || DEFAULTS.timeout;
  const signal = options.signal;

  await sshAcquire(undefined, signal);
  try {
    return await new Promise((resolve, reject) => {
    const conn = new Client();
    let buffer = '';
    let timeoutId;
    let stage = 'init';
    let kubectlOutput = '';
    let collectingOutput = false;

    // 设置超时 - 使用 destroy() 强制关闭
    let settled = false;
    timeoutId = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { conn.destroy(); } catch {}
        reject(new Error(`命令执行超时 (${timeout}ms)`));
      }
    }, timeout);

    // 用户 cancel：立即 destroy 连接
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      log(`[SSH] ⊗ 用户 cancel，destroy 连接 (kubectl: ${kubectlCommand.substring(0, 50)}...)`);
      try { conn.destroy(); } catch {};
      reject(new Error('CANCELLED during kubectl'));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    conn.on('ready', () => {
      conn.shell({ term: 'xterm', rows: 24, cols: 500 }, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          if (!settled) { settled = true; reject(err); }
          return;
        }

        stream.on('close', () => {
          clearTimeout(timeoutId);
          try { conn.destroy(); } catch {}
          if (!settled) {
            settled = true;
            resolve(cleanTerminalOutput(kubectlOutput || buffer));
          }
        });

        stream.on('data', (data) => {
          if (settled) return;
          const text = data.toString();
          buffer += text;

          if (collectingOutput) {
            kubectlOutput += text;
          }

          // JumpServer 状态机
          if (stage === 'init' && buffer.includes('Opt>')) {
            stage = 'opt';
            stream.write(K8S_SERVER.host + '\r');
          }
          else if (stage === 'opt' && buffer.includes('[Host]>')) {
            stage = 'host';
            stream.write(K8S_SERVER.selectOption + '\r');
          }
          else if (stage === 'host' && (buffer.includes('~]$') || buffer.includes('~]#'))) {
            stage = 'server';
            kubectlOutput = '';
            collectingOutput = true;
            stream.write(kubectlCommand + '\r');
            stage = 'kubectl';
          }
          else if (stage === 'kubectl' && collectingOutput && kubectlOutput.length > 50) {
            if (kubectlOutput.includes('~]$') || kubectlOutput.includes('~]#')) {
              stage = 'done';
              collectingOutput = false;
              stream.write('exit\r');
              stream.write('exit\r');
              setTimeout(() => { try { stream.end(); } catch {} }, 300);
            }
          }
        });

        stream.stderr.on('data', () => {});
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      if (!settled) { settled = true; reject(new Error(`SSH 连接错误: ${err.message}`)); }
    });

    conn.connect({
      host: JUMP_HOST.host,
      port: JUMP_HOST.port,
      username: JUMP_HOST.username,
      password: JUMP_HOST.password,
      readyTimeout: DEFAULTS.connectTimeout
    });
  });
  } finally {
    sshRelease();
  }
}