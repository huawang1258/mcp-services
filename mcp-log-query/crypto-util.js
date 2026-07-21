/**
 * 配置加密/解密工具
 *
 * 目的：config.js 中不再出现明文密码。默认配置存密文（ENC:v1: 前缀），
 * 运行时从 MCP 配置注入的环境变量 MCP_CONFIG_KEY 解密。
 *
 * 算法：AES-256-GCM，密钥用 scrypt 从 MCP_CONFIG_KEY 派生（随机 salt 存在密文里）
 * 密文格式：ENC:v1:base64( salt(16) | iv(12) | authTag(16) | ciphertext )
 *
 * 生成密文（CLI）：
 *   node crypto-util.js encrypt "明文密码"            # key 取自环境变量 MCP_CONFIG_KEY
 *   node crypto-util.js encrypt "明文密码" <key>       # 显式指定 key
 *   node crypto-util.js decrypt "ENC:v1:..." [key]    # 验证解密
 *   node crypto-util.js genkey                        # 生成一个随机密钥
 *
 * MCP 配置（mcp_config.json）示例：
 *   "env": { "MCP_CONFIG_KEY": "<密钥>" }
 */

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { log } from './logger.js';

const PREFIX = 'ENC:v1:';
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * 加密明文
 * @param {string} plaintext
 * @param {string} key - 密钥口令（任意字符串）
 * @returns {string} ENC:v1: 前缀密文
 */
export function encryptValue(plaintext, key) {
  if (!key) throw new Error('缺少加密密钥');
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const derived = scryptSync(key, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', derived, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([salt, iv, tag, encrypted]).toString('base64');
}

/**
 * 解密配置值
 * - 非 ENC:v1: 前缀的值原样返回（兼容明文/环境变量覆盖）
 * - 缺密钥或解密失败返回空字符串并记日志（服务可启动，对应环境查询时会 401）
 *
 * @param {string} value - 配置值（密文或明文）
 * @param {string} [key] - 密钥，默认读环境变量 MCP_CONFIG_KEY
 * @returns {string}
 */
export function decryptValue(value, key = process.env.MCP_CONFIG_KEY) {
  if (!value || typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  if (!key) {
    log('[Crypto] ⚠️ 配置含加密值但未设置 MCP_CONFIG_KEY 环境变量，解密跳过（请在 mcp_config.json 的 env 中配置）');
    return '';
  }
  try {
    const buf = Buffer.from(value.slice(PREFIX.length), 'base64');
    const salt = buf.subarray(0, SALT_LEN);
    const iv = buf.subarray(SALT_LEN, SALT_LEN + IV_LEN);
    const tag = buf.subarray(SALT_LEN + IV_LEN, SALT_LEN + IV_LEN + TAG_LEN);
    const data = buf.subarray(SALT_LEN + IV_LEN + TAG_LEN);
    const derived = scryptSync(key, salt, 32);
    const decipher = createDecipheriv('aes-256-gcm', derived, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (e) {
    log(`[Crypto] ⚠️ 解密失败（密钥不对或密文损坏）: ${e.message}`);
    return '';
  }
}

// ============================================================
// CLI 入口：node crypto-util.js encrypt|decrypt|genkey ...
// ============================================================
const isCli = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('crypto-util.js');
if (isCli) {
  const [, , action, value, keyArg] = process.argv;
  const key = keyArg || process.env.MCP_CONFIG_KEY;

  if (action === 'genkey') {
    console.log(randomBytes(32).toString('hex'));
  } else if (action === 'encrypt') {
    if (!value) { console.error('用法: node crypto-util.js encrypt "明文" [key]'); process.exit(1); }
    if (!key) { console.error('缺少密钥: 传第二个参数或设置 MCP_CONFIG_KEY'); process.exit(1); }
    console.log(encryptValue(value, key));
  } else if (action === 'decrypt') {
    if (!value) { console.error('用法: node crypto-util.js decrypt "ENC:v1:..." [key]'); process.exit(1); }
    if (!key) { console.error('缺少密钥: 传第二个参数或设置 MCP_CONFIG_KEY'); process.exit(1); }
    console.log(decryptValue(value, key));
  } else {
    console.error('用法: node crypto-util.js genkey | encrypt "明文" [key] | decrypt "密文" [key]');
    process.exit(1);
  }
}
