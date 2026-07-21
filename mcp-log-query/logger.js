/**
 * 轻量日志模块：本地文件追加（默认不走 stderr）
 *
 * ⚠️ 重要背景（3.6.1）：
 * Windsurf 根本没有 MCP 专属的 Output 频道，从不读取子进程的 stderr。
 * Node 默认 stderr pipe buffer ~64KB，满了后 `console.error` 会**同步阻塞 event loop**
 * → 整个 MCP 进程冻结，新请求来了不处理，已发出的 fetch 不推进，cancel signal 也接收不到。
 *
 * 因此默认只写文件，stderr 仅在显式要求时开启（用于单独调试，MCP server 场景禁用）。
 *
 * 用法：
 *   import { log } from './logger.js';
 *   log('[SSH-Sem] acquire ...');
 *
 * 诊断卡住时：
 *   Get-Content $env:TEMP\mcp-log-query.log -Tail 20 -Wait   (Windows)
 *   tail -F /tmp/mcp-log-query.log                           (Linux/Mac)
 *
 * 环境变量：
 * - MCP_LOG_FILE: 自定义日志文件路径（默认 <tmpdir>/mcp-log-query.log）
 * - MCP_LOG_MAX_BYTES: 单文件最大字节数（默认 10MB，超过则轮转到 .1）
 * - MCP_LOG_DISABLE: 设为 '1' 则完全禁用日志（文件+stderr 都不写）
 * - MCP_LOG_STDERR: 设为 '1' 时**同时**写 stderr（独立调试用，MCP 子进程模式下不要开）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOG_FILE = process.env.MCP_LOG_FILE || path.join(os.tmpdir(), 'mcp-log-query.log');
const MAX_BYTES = parseInt(process.env.MCP_LOG_MAX_BYTES || `${10 * 1024 * 1024}`, 10);
const DISABLED = process.env.MCP_LOG_DISABLE === '1';
// 默认不走 stderr（MCP 子进程下会被 host 无限 backpressure 阻塞 event loop）
const WRITE_STDERR = process.env.MCP_LOG_STDERR === '1';

// 懒初始化：首次写入时再检查目录
let initialized = false;

function ensureInit() {
  if (initialized) return;
  initialized = true;
  if (DISABLED) return;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    // 启动时打一条 banner，方便判断是不是新进程
    fs.appendFileSync(
      LOG_FILE,
      `\n========== [${new Date().toISOString()}] MCP log-query 进程启动 pid=${process.pid} ==========\n`
    );
  } catch {
    // 文件初始化失败，静默（同 log 函数的考虑）
  }
}

function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size < MAX_BYTES) return;
    const backup = `${LOG_FILE}.1`;
    try { fs.rmSync(backup, { force: true }); } catch {}
    try { fs.renameSync(LOG_FILE, backup); } catch {}
  } catch {
    // 文件不存在等错误忽略
  }
}

/**
 * 写一条日志：默认仅本地文件；MCP_LOG_STDERR=1 时同时写 stderr
 *
 * ⚠️ 重要：MCP 子进程下 stderr 管道会被 host 无限 backpressure 阻塞 event loop，
 * 所以默认禁用 stderr 输出。只在独立调试（非 MCP 模式）时开启。
 *
 * @param {string} msg - 日志内容（不需要带时间戳，本函数自动加）
 */
export function log(msg) {
  if (DISABLED) return;

  ensureInit();

  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // 文件写失败静默忽略：不能为了日志去打 stderr（会阻塞 event loop）
    // 也不缓存 warning；调试请检查磁盘 / 权限
  }

  // 可选 stderr 输出（独立调试用）
  if (WRITE_STDERR) {
    // 直接 write，失败忽略；不用 console.error 以免同步阻塞
    try { process.stderr.write(msg + '\n'); } catch {}
  }
}

/**
 * 获取当前日志文件路径（方便 MCP 工具返回给调用方）
 */
export function getLogFilePath() {
  return DISABLED ? null : LOG_FILE;
}
