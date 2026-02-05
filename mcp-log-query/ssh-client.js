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

/**
 * 执行日志查询
 * @param {Object} service - 服务配置
 * @param {string} command - 日志查询命令（如 tail -100 *.log）
 * @param {Object} options - 选项
 * @returns {Promise<string>} 日志内容
 */
export async function queryLog(service, command, options = {}) {
  const timeout = options.timeout || DEFAULTS.timeout;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let buffer = '';  // 累积所有输出
    let timeoutId;
    let stage = 'init';  // init -> opt -> host -> server -> kubectl -> done
    let kubectlOutput = '';
    let collectingOutput = false;

    // 设置超时
    timeoutId = setTimeout(() => {
      conn.end();
      reject(new Error(`命令执行超时 (${timeout}ms)`));
    }, timeout);

    conn.on('ready', () => {
      console.error('[SSH] 已连接到堡垒机');

      conn.shell({ term: 'xterm', rows: 24, cols: 500 }, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          reject(err);
          return;
        }

        stream.on('close', () => {
          clearTimeout(timeoutId);
          conn.end();

          // 清理输出
          const cleanOutput = cleanTerminalOutput(kubectlOutput || buffer);
          resolve(cleanOutput);
        });

        stream.on('data', (data) => {
          const text = data.toString();
          buffer += text;

          if (collectingOutput) {
            kubectlOutput += text;
          }

          // JumpServer 状态机 - 检查累积的 buffer

          // 阶段1: 等待 Opt> 提示符
          if (stage === 'init' && buffer.includes('Opt>')) {
            stage = 'opt';
            console.error('[SSH] 输入目标服务器 IP');
            stream.write(K8S_SERVER.host + '\r');
          }
          // 阶段2: 等待 [Host]> 提示符（搜索结果列表后）
          else if (stage === 'opt' && buffer.includes('[Host]>')) {
            stage = 'host';
            console.error('[SSH] 选择服务器 ID: ' + K8S_SERVER.selectOption);
            stream.write(K8S_SERVER.selectOption + '\r');
          }
          // 阶段3: 等待进入服务器 shell（检测 ~]$ 或 ~]# 提示符）
          else if (stage === 'host' && (buffer.includes('~]$') || buffer.includes('~]#'))) {
            stage = 'server';
            console.error('[SSH] 已进入服务器，执行 kubectl 命令');

            // 构建并执行 kubectl 命令
            const kubectlCmd = buildKubectlCommand(service, command);
            console.error(`[SSH] 命令: ${kubectlCmd.substring(0, 80)}...`);

            // 重置 buffer，开始收集 kubectl 输出
            kubectlOutput = '';
            collectingOutput = true;

            stream.write(kubectlCmd + '\r');
            stage = 'kubectl';
          }
          // 阶段4: kubectl 执行完成
          else if (stage === 'kubectl' && collectingOutput && kubectlOutput.length > 50) {
            // 检测命令执行完成（返回到 shell 提示符）
            if (kubectlOutput.includes('~]$') || kubectlOutput.includes('~]#')) {
              stage = 'done';
              collectingOutput = false;
              console.error('[SSH] 命令执行完成，退出');

              // 立即退出
              stream.write('exit\r');
              stream.write('exit\r');
              setTimeout(() => stream.end(), 500);
            }
          }
        });

        stream.stderr.on('data', (data) => {
          console.error('[SSH stderr]', data.toString());
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`SSH 连接错误: ${err.message}`));
    });

    // 连接堡垒机
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
 * 构建 kubectl exec 命令
 * @param {Object} service - 服务配置
 * @param {string} logCommand - 日志命令，如 "tail -100" 或 "grep error"
 */
function buildKubectlCommand(service, logCommand) {
  const { namespace, podPattern, logPath, logFile } = service;
  const file = logFile || 'normal.log';
  const fullPath = `${logPath}/${file}`;

  // 构建完整命令
  // 例如: kubectl exec pod/xxx -n namespace -- tail -100 /path/to/normal.log
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

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let buffer = '';
    let timeoutId;
    let stage = 'init';
    let kubectlOutput = '';
    let collectingOutput = false;

    // 设置超时
    timeoutId = setTimeout(() => {
      conn.end();
      reject(new Error(`命令执行超时 (${timeout}ms)`));
    }, timeout);

    conn.on('ready', () => {
      console.error('[SSH] 已连接到堡垒机');

      conn.shell({ term: 'xterm', rows: 24, cols: 500 }, (err, stream) => {
        if (err) {
          clearTimeout(timeoutId);
          reject(err);
          return;
        }

        stream.on('close', () => {
          clearTimeout(timeoutId);
          conn.end();

          // 清理输出
          const cleanOutput = cleanTerminalOutput(kubectlOutput || buffer);
          resolve(cleanOutput);
        });

        stream.on('data', (data) => {
          const text = data.toString();
          buffer += text;

          if (collectingOutput) {
            kubectlOutput += text;
          }

          // JumpServer 状态机

          // 阶段1: 等待 Opt> 提示符
          if (stage === 'init' && buffer.includes('Opt>')) {
            stage = 'opt';
            console.error('[SSH] 输入目标服务器 IP');
            stream.write(K8S_SERVER.host + '\r');
          }
          // 阶段2: 等待 [Host]> 提示符
          else if (stage === 'opt' && buffer.includes('[Host]>')) {
            stage = 'host';
            console.error('[SSH] 选择服务器 ID: ' + K8S_SERVER.selectOption);
            stream.write(K8S_SERVER.selectOption + '\r');
          }
          // 阶段3: 等待进入服务器 shell
          else if (stage === 'host' && (buffer.includes('~]$') || buffer.includes('~]#'))) {
            stage = 'server';
            console.error('[SSH] 已进入服务器，执行 kubectl 命令');
            console.error(`[SSH] 命令: ${kubectlCommand.substring(0, 100)}...`);

            // 重置 buffer，开始收集 kubectl 输出
            kubectlOutput = '';
            collectingOutput = true;

            stream.write(kubectlCommand + '\r');
            stage = 'kubectl';
          }
          // 阶段4: kubectl 执行完成
          else if (stage === 'kubectl' && collectingOutput && kubectlOutput.length > 50) {
            // 检测命令执行完成（返回到 shell 提示符）
            if (kubectlOutput.includes('~]$') || kubectlOutput.includes('~]#')) {
              stage = 'done';
              collectingOutput = false;
              console.error('[SSH] 命令执行完成，退出');

              // 立即退出
              stream.write('exit\r');
              stream.write('exit\r');
              setTimeout(() => stream.end(), 500);
            }
          }
        });

        stream.stderr.on('data', (data) => {
          console.error('[SSH stderr]', data.toString());
        });
      });
    });

    conn.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`SSH 连接错误: ${err.message}`));
    });

    // 连接堡垒机
    conn.connect({
      host: JUMP_HOST.host,
      port: JUMP_HOST.port,
      username: JUMP_HOST.username,
      password: JUMP_HOST.password,
      readyTimeout: DEFAULTS.connectTimeout
    });
  });
}