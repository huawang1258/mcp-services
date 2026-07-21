# MCP 卡住/失联 调试手册

> 本手册记录 `mcp-log-query` 从 v3.5.0 → v3.6.1 的**真实排障历程**，以及日后遇到类似问题的**快速定位流程**。
>
> 每个历史 bug 都曾让 MCP **中途卡住或无响应**，外在表现几乎一样（"一批都没抗住"、"第 N 个调用卡住了"、"MCP 不响应新请求了"），但根因截然不同。

---

## 🚨 出现卡住时先做这一步

```powershell
# Windows
Get-Content $env:TEMP\mcp-log-query.log -Tail 50
```

```bash
# Linux/Mac
tail -50 /tmp/mcp-log-query.log
```

看**最后一行**，对照下面的表找根因：

| 最后一行形态 | 判断 | 跳转章节 |
|---|---|---|
| `[Tool] → xxx start` 之后**长时间没更新** | 进程冻结（最严重） | [§6 stderr backpressure](#6-v361-stderr-backpressure-阻塞-event-loop) |
| `[Loki] 自动递进` 之后没 done | Loki body 读取卡住 | [§4 Loki body timeout](#4-v353-loki-body-读取无超时) |
| `[SSH-Sem] acquire 进入排队 queue=N` 长时间不出队 | SSH 积压 | [§3 SSH 排队超时](#3-v352-ssh-队列无限等待) |
| `[SSH] 连接错误` / `readyTimeout` | 堡垒机被踢/网络问题 | [§2 堡垒机被踢](#2-v351-堡垒机会话被踢) |
| **完全没新进程 banner** + MCP 进程不存在 | 自杀退出 | [§1 进程自杀](#1-v350-process-exit-自杀) |
| `[Tool] ⊗ xxx CANCELLED` | 正常取消，不是 bug | — |

---

## 📜 版本修复历程（按时间逆序）

| 版本 | 根因 | 表现 | 修复 |
|---|---|---|---|
| **v3.6.1** | `console.error` 阻塞 event loop | 第 14+ 个请求后 MCP 完全不响应 | `log()` 只写文件，不走 stderr |
| **v3.6.0** | handler 不接 cancel signal | Cascade cancel 后 MCP 不接受新请求 | signal 层层透传到 Loki/SSH/kubectl |
| **v3.5.3** | Loki body 读取无超时 | `resp.json()` 卡住无限等 | AbortController 覆盖 fetch + body 全过程 |
| **v3.5.2** | SSH 排队无超时 | 前面请求卡死后，后面永远排队 | 排队 60s 超时 + 文件日志 |
| **v3.5.1** | 无 SSH 并发限制 | 堡垒机被踢，连接全失败 | 信号量 max=3 |
| **v3.5.0** | `process.exit(1)` 自杀 | 单个错误拖死整个 MCP | 捕获但不退出 |

---

## 1. v3.5.0: `process.exit` 自杀

### 症状
- 一个错误把整个 MCP 搞死
- Windsurf 需要 reload 才能恢复
- 文件日志：**没有新 banner**（进程没重启），但旧进程已经不存在

### 根因
```js
// ❌ 原代码
process.on('uncaughtException', (err) => {
  console.error(err);
  process.exit(1);  // 自杀！
});

// watchdog 也会 exit
setTimeout(() => {
  if (stillRunning) process.exit(1);
}, 60_000);
```

MCP 是长驻服务，**单次请求错误不应拖死整个进程**。

### 修复
```@d:\project\main\MCP\mcp-log-query\index.js:78-81
// 进程级安全网：只记录日志，不退出进程
// 退出会导致 stdio 断开，整个 MCP 不可用直到 IDE 重启；单次请求错误不应拖死服务
process.on('unhandledRejection', (err) => log(`[unhandledRejection] ${err && err.stack || err}`));
process.on('uncaughtException', (err) => log(`[uncaughtException] ${err && err.stack || err}`));
```

Watchdog 也改成**只记录不退出**。

### 经验
> MCP server 属于"客户端长驻服务"范畴，任何 `process.exit` 都要非常慎重。

---

## 2. v3.5.1: 堡垒机会话被踢

### 症状
- 并发发多个 `query_log` 时，**部分请求 SSH 连接错误**
- 错误：`SSH 连接错误: All configured authentication methods failed`
- 现象：**堡垒机 30 秒内只允许有限并发**

### 根因
代码里没有并发限制，用户发 10 个 `query_log` 就同时开 10 个 SSH，堡垒机直接踢人。

### 修复
```@d:\project\main\MCP\mcp-log-query\ssh-client.js:23-33
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
```

每个 `queryLog` / `executeKubectl` 都需要 `await sshAcquire()`，超过 max 就进队列。

### 经验
> 对外部资源（堡垒机、数据库、HTTP 服务）做操作的 MCP，**一定要加并发信号量**。

---

## 3. v3.5.2: SSH 队列无限等待

### 症状
- SSH 信号量有了，但**队列里第 4-50 个请求永远不返回**
- 日志停在 `[SSH-Sem] acquire 进入排队 queue=N`

### 根因
前面 3 个正在跑的 SSH 如果**真的卡死**（比如堡垒机网络故障），后面排队的请求**没有 timeout 机制**，会一直等到天荒地老。

更糟的是，没有任何日志可查（v3.5.2 之前只有 stderr，Windsurf 不抓）。

### 修复
**两件事**：

**A. 排队加 60s 超时**
```@d:\project\main\MCP\mcp-log-query\ssh-client.js:70-78
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const idx = _sshSem.queue.indexOf(enterQueue);
      if (idx >= 0) _sshSem.queue.splice(idx, 1);
      log(`[SSH-Sem] acquire 排队超时 (${timeoutMs}ms, active=${_sshSem.active}/${_sshSem.max}, queue=${_sshSem.queue.length})`);
      reject(new Error(`SSH 排队等待超时 (${timeoutMs}ms)：前面请求卡住，或并发过高。可调整 SSH_MAX_CONCURRENT / SSH_ACQUIRE_TIMEOUT`));
    }, timeoutMs);
```

**B. 新增文件日志模块** `logger.js`
不依赖 Windsurf 的 stderr 抓取，所有关键事件都写到 `%TEMP%\mcp-log-query.log`，这样**中途卡住时能立即定位**。

### 经验
> 任何队列/等待机制都要有**超时兜底**，失败也比挂起强。

---

## 4. v3.5.3: Loki body 读取无超时

### 症状
- Loki 查询某个服务（尤其 `mall`、`health` 等日志量大的服务）**偶发卡 20-30 分钟**
- 日志停在 `[Tool] → query_log start args={"env":"cms","lines":3,"service":"mall"}`
- **30s abort 完全不生效**

### 根因
```js
// ❌ 原代码
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), LOKI_FETCH_TIMEOUT);

try {
  const resp = await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timer);  // ← fetch resolve 后立刻清！
}

// 下面读 body 已经没有超时保护了
const data = await resp.json();  // ← 这里可能卡 30 分钟
```

**`fetch` 返回 Response 只代表收到 headers，不代表 body 全部到齐**。Loki 后端如果 body 传输中断，`resp.json()` 会无限等。但我们在 `finally` 里提前 clearTimeout 了，AbortController 形同虚设。

### 修复
```@d:\project\main\MCP\mcp-log-query\loki-client.js:72-102
  const controller = new AbortController();
  const timer = setTimeout(() => {
    log(`[Loki] ⏱ 超时 ${LOKI_FETCH_TIMEOUT}ms，主动 abort: env=${envName}, expr=${expr.substring(0, 80)}`);
    controller.abort(new Error('TIMEOUT'));
  }, LOKI_FETCH_TIMEOUT);

  try {
    const resp = await fetch(url, { ..., signal: controller.signal });
    if (!resp.ok) {
      const text = await resp.text();  // ← 仍在 signal 保护下
      throw new Error(`Loki 查询失败 (${resp.status}): ${text}`);
    }
    const data = await resp.json();  // ← 仍在 signal 保护下
    return parseLokiResponse(data);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Loki 查询超时（${LOKI_FETCH_TIMEOUT}ms）`);
    throw e;
  } finally {
    clearTimeout(timer);  // ← 只在真正结束时清
  }
```

**关键**：`clearTimeout(timer)` 只在最终 `finally` 里做，保证 AbortController 覆盖 fetch + body 读取全过程。

### 经验
> 任何 `fetch(...)` 之后读 body 的操作（`.json()`, `.text()`, `.arrayBuffer()`）都要**在同一个 AbortController 保护下**。

---

## 5. v3.6.0: Cascade cancel 后 MCP 锁死

### 症状
- 头儿在 Windsurf 里 cancel 一批 tool call
- **之后 MCP 不再接受新请求**（好几分钟）
- 文件日志在 cancel 时刻后**完全无更新**
- MCP 进程本身活着（CPU 低），但 Cascade 不再给它发消息

### 根因
MCP SDK 的 handler 签名是 `(request, extra)`，其中 `extra.signal` 是 Cascade 发 `notifications/cancelled` 时触发的 AbortSignal。

**我们原来根本没接 extra**：

```js
// ❌ 原代码
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  // 没接 extra，cancel signal 看不到
  const result = await handleToolCall(name, args);
  return result;
});
```

结果：
1. Cascade cancel → signal abort
2. 但 handler 继续傻跑 Loki/SSH（几十秒）
3. MCP stdio 这段时间被占用
4. **Cascade 认为 MCP "还在忙"，不发新请求**
5. 用户看起来 MCP 就是卡死了

### 修复
**两件事**：

**A. handler 接 extra.signal + cancel race**
```@d:\project\main\MCP\mcp-log-query\index.js:367-400
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const signal = extra && extra.signal;
  ...
  const cancelPromise = new Promise((_, reject) => {
    if (!signal) return;
    signal.addEventListener('abort', () => {
      log(`[Tool] ⊗ ${name} 收到 cancel signal`);
      reject(new Error('CANCELLED'));
    }, { once: true });
  });

  const result = await Promise.race([
    withTimeout(handleToolCall(name, args, signal), REQUEST_TIMEOUT, name),
    cancelPromise,
  ]);
```

**B. signal 层层透传到所有下游**
- `handleToolCall(name, args, signal)` → `queryLokiAutoRange(env, expr, { signal })` → `queryLoki(...)` → `fetch(..., { signal: combinedSignal })`
- `queryLog(service, cmd, { signal })` → `sshAcquire(timeout, signal)` → 队列内 `onAbort` 立即从队列移除并 reject
- `executeKubectl(cmd, { signal })` → SSH 连接建立后收到 abort → `conn.destroy()`

### 经验
> 任何长耗时 MCP handler 都要**接 `extra.signal` 并层层传导**。否则 cancel 时 MCP 会被 host 视为"忙"，触发限流。

---

## 6. v3.6.1: stderr backpressure 阻塞 event loop

### 症状（最隐蔽）
- 前 13-14 个请求飞快返回（< 100ms）
- **第 14+ 个请求开始 MCP 完全冻结**
- 文件日志停在 `[Tool] → xxx start`，连 `[Loki] 自动递进` 都打不出来
- 这不是 Loki 卡，也不是 SSH 卡，是**整个 Node event loop 卡了**

### 根因（深埋）

`logger.js` 原来是这样写的：
```js
// ❌ 原代码
export function log(msg) {
  console.error(msg);              // ← 每次都写 stderr
  fs.appendFileSync(LOG_FILE, ...);
}
```

Windsurf 启动 MCP 子进程是通过 stdio pipe，**但 Windsurf 根本没有 MCP 专属的 Output 频道**（可以在 Windsurf Output 下拉菜单里确认）。也就是说，**Windsurf 从不读取 MCP 子进程的 stderr**。

Node.js 默认 stderr pipe buffer **~64KB**。一旦满了：
- `process.stderr.write(...)` 会**同步阻塞**等消费者读
- `console.error` 底层就是 `stderr.write`
- event loop 冻结，**所有 Promise、fetch、setTimeout、signal 都停摆**

前 14 个请求打出约 60-70KB 日志后，stderr pipe 满了，第 15 个请求调用 `log()` 就直接卡死。

### 修复
```@d:\project\main\MCP\mcp-log-query\logger.js:75-94
export function log(msg) {
  if (DISABLED) return;
  ensureInit();

  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    rotateIfNeeded();
    fs.appendFileSync(LOG_FILE, line);  // 只写文件
  } catch {
    // 文件写失败静默忽略：不能为了日志去打 stderr（会阻塞 event loop）
  }

  // 可选 stderr 输出（仅用于独立调试，MCP 子进程模式下不要开）
  if (WRITE_STDERR) {
    try { process.stderr.write(msg + '\n'); } catch {}
  }
}
```

同时把 `index.js` 里所有 `console.error(...)` 批量换成 `log(...)`（18 处）：

```powershell
(Get-Content index.js) -replace 'console\.error\(', 'log(' | Set-Content index.js -Encoding UTF8
```

### 经验（最重要！）

> **MCP server 子进程下，禁止向 stderr 写任何东西**，除非你 100% 确定 host（IDE）会消费。否则 stderr pipe 满了会**静悄悄地冻结整个 event loop**，表现为神秘的"中途卡住"。
>
> 正确做法：**只写本地文件**。想实时看日志就 `tail -f`。

---

## 🛠️ 关键环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `MCP_LOG_FILE` | `$TEMP/mcp-log-query.log` | 自定义日志路径 |
| `MCP_LOG_MAX_BYTES` | `10485760` (10MB) | 单文件最大，超过则轮转到 `.1` |
| `MCP_LOG_DISABLE` | `0` | 设 `1` 完全禁用日志 |
| `MCP_LOG_STDERR` | `0` | 设 `1` 同时写 stderr（**MCP 子进程禁用**） |
| `SSH_MAX_CONCURRENT` | `3` | 堡垒机最大并发 SSH |
| `SSH_QUEUE_MAX` | `50` | 最大排队数 |
| `SSH_ACQUIRE_TIMEOUT` | `60000` | 排队最长等待 ms |

---

## 📋 日志标签字典

| 标签 | 含义 |
|---|---|
| `[Tool] → xxx start` | 收到 MCP 工具调用 |
| `[Tool] ✓ xxx done Nms` | 工具调用成功 |
| `[Tool] ✗ xxx FAIL Nms: msg` | 工具调用失败 |
| `[Tool] ⊗ xxx CANCELLED Nms` | 工具调用被 Cascade 取消 |
| `[SSH-Sem] acquire 直接通过` | 信号量有空位 |
| `[SSH-Sem] acquire 进入排队 queue=N` | 需要排队 |
| `[SSH-Sem] acquire 出队获得槽位` | 排到了 |
| `[SSH-Sem] acquire 排队超时` | 排队 60s 未轮到 |
| `[SSH-Sem] acquire 用户 cancel` | 排队中被 cancel |
| `[SSH-Sem] release` | 释放槽位 |
| `[SSH] ⊗ 用户 cancel` | SSH 执行中被 cancel，destroy 连接 |
| `[Loki] 自动递进: 尝试 X 范围` | Loki 时间范围递进 |
| `[Loki] 查询: env=xxx, expr=...` | 实际 LogQL 请求 |
| `[Loki] ✅ 在 X 范围内找到 N 行` | 查询成功 |
| `[Loki] ⏱ 超时 30000ms，主动 abort` | 内部 30s 超时触发 |
| `[Loki] ⊗ 用户 cancel，主动 abort` | 用户 cancel 触发 abort |
| `[Watchdog] xxx 仍在运行超过 120000ms` | 超长请求告警（仅记录） |
| `[MCP] Log Query Server vX.X.X 已启动` | 进程启动 |
| `[unhandledRejection] / [uncaughtException]` | 进程级异常（不自杀） |

---

## 🧪 快速冒烟测试

reload MCP 后，验证稳定性：

```
发 20 个混合工具调用：
- list_services × 2
- query_log × 16 (不同服务，env=cms 和测试环境混合)
- list_pods × 1
- get_events × 1
```

观察：
1. **文件日志持续更新**（打开 `Get-Content -Wait` 看）
2. 每条 `[Tool] → start` 后不超过 30s 有 `done` / `FAIL`
3. 没有 `[unhandledRejection]` / `[uncaughtException]`
4. 没有**几分钟静止期**

v3.6.1 + 当前测试环境典型表现：**20 个 16 秒跑完，0 失败**。

---

## 📖 推荐实时监控命令

```powershell
# Windows (PowerShell)
Get-Content $env:TEMP\mcp-log-query.log -Tail 30 -Wait
```

```bash
# Linux/Mac
tail -F /tmp/mcp-log-query.log
```

日志文件 10MB 自动轮转到 `.1`，不会无限膨胀。

---

## 🎯 排障流程（SOP）

1. **确认症状**：用户说"卡住了" / "一批没抗住"
2. **看文件日志末尾 50 行** → 对照本文 §开头表格定位
3. **统计**：
   ```powershell
   $f = "$env:TEMP\mcp-log-query.log"
   $lines = Get-Content $f
   "start: $(@($lines | Where-Object { $_ -match '\[Tool\] →' }).Count)"
   "done:  $(@($lines | Where-Object { $_ -match '\[Tool\] ✓' }).Count)"
   "FAIL:  $(@($lines | Where-Object { $_ -match '\[Tool\] ✗' }).Count)"
   "CANCEL:$(@($lines | Where-Object { $_ -match '\[Tool\] ⊗' }).Count)"
   ```
4. **start ≠ done+FAIL+CANCEL** → 有请求卡在处理中，看最后 start 的时间戳和现在相差多久
5. **`[SSH-Sem] queue=N` 长时间不变** → SSH 积压，调大 `SSH_MAX_CONCURRENT` 或减少并发
6. **没有新 banner 但进程消失** → 代码还有 `process.exit` 漏网之鱼
7. **实在定位不到** → 重启 MCP，保留日志文件做 post-mortem

---

## 🏁 设计原则总结

基于本次排障沉淀的 MCP server 编写原则：

1. **绝不 `process.exit`**：MCP 是长驻服务，错误捕获但不退出
2. **不要往 stderr 打日志**：host 不一定消费，写满了阻塞 event loop
3. **全链路 AbortSignal**：handler 接 `extra.signal` 并层层透传到 fetch / SSH / kubectl
4. **AbortController 覆盖 fetch + body**：别在 fetch resolve 后立刻 clearTimeout
5. **外部资源加信号量**：SSH / DB / HTTP 都要限制并发
6. **所有等待加 timeout**：排队、连接、fetch 都要兜底
7. **文件日志先行**：实时可查，不依赖 host

遵循以上 7 条，MCP server 就能稳定运行。

---

**文档维护**：huawang  
**最后更新**：2026-04-17（v3.6.1 发布后）
