/**
 * 扩展端日志 —— **唯一出口 + 强制打码**。
 *
 * # 设计的三条硬约束（都来自本仓的既有约定，不是偏好）
 *
 * 1. **`content/` 会被注入用户的每一个页面**（AGENTS.md 规则 10）⇒
 *    本模块**零依赖**、体积必须小、且**不能碰 `chrome.*`**（content script 只有
 *    部分 API）。所以"写 `chrome.storage`"这件事是**可选注入的 sink**，
 *    不是本模块的内建行为。
 * 2. **MV3 的 SW 会被随时终止** ⇒ 内存里的东西会丢。所以环形缓冲是"尽力而为的
 *    现场证据"，不是可靠存储；真正的持久化由调用方决定。
 * 3. **CSP 是 `script-src 'self'`**（规则 9）⇒ 不用 `eval`、不引外链。
 *
 * # 为什么打码必须在 `log()` 里、而不是在每个调用点
 *
 * 改造前本仓只有 3 处裸 `console.*`，都"看起来没用凭据"。但
 * `console.debug('...', { errorSeen })` 这种**对象直传**是典型形态 ——
 * 今天对象里只有计数，明天有人往里塞 `{ username, password }` 做"排障方便"，
 * 凭据就出去了，**而没有任何东西会拦住**。
 *
 * ⇒ 所有出口都只经由 `log()`，而 `log()` 无条件先打码。绕不过去。
 */

import { redact } from './redact';

// ★ 转发导出打码 API，让 `log.ts` 成为日志相关的**唯一公开面**。
//
// 这不只是整洁问题 —— 实测踩过：验证脚本从 `log.ts` 解构 `redact` / `REDACTED`
// 时报 `redact is not a function`，因为 log.ts 原来只 `import { redact }`，
// esbuild 的**摇树**把 `redact.ts` 里没被用到的导出（包括 `REDACTED`）整段删掉了。
// ⇒ 调用方（验证脚本、背景脚本）**只能从本模块取**，所以这里必须显式转发。
export { redact, redactDetail, REDACTED, REDACTION_RULES } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const CONSOLE_METHOD: Record<LogLevel, 'debug' | 'info' | 'warn' | 'error'> = {
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/** 一条已经打码过的日志记录。 */
export interface LogRecord {
  /** 毫秒时间戳 */
  t: number;
  level: LogLevel;
  /** 模块名（`getLogger('auto-login')` ⇒ `ql:auto-login`） */
  ns: string;
  /** **已经打码**的消息文本 */
  msg: string;
}

/** 命名空间前缀。所有 logger 都在它下面，便于在 DevTools 里过滤 `ql:`。 */
export const NS_PREFIX = 'ql';

// ---------------------------------------------------------------- 级别

/**
 * 全局最低级别。**存在 `globalThis` 上，而不是模块局部变量里** ——
 * 理由见 `setLogLevel()` 的注释（这是一个被摇树删掉过一次的真实缺陷）。
 */
declare global {
  // eslint-disable-next-line no-var
  var __qlLogLevel: LogLevel | undefined;
}

/**
 * ★★ 2026-10-16：级别**必须挂在 `globalThis` 上**，不能是模块局部变量。
 *
 * ## 为什么（这是一个"文档承诺了、而产物里不存在"的真实缺陷）
 *
 * 原先 `setLogLevel()` 是 `export function`，而 `src/` 里**一个调用点都没有** ——
 * 唯一的调用者是**排障时人在控制台手敲**（`docs/PITFALLS.md` 的排障指引与
 * `service-worker.ts` 的注释都这么写）。
 *
 * 而 esbuild 会**摇树删掉"导出了但没人 import"的函数** ⇒ 实测
 * **`dist/background.js` 里 `setLogLevel` 出现 0 次**：
 *
 * | 谁 | 以为 | 实际 |
 * |---|---|---|
 * | 排障的人 | 敲 `Site.setLogLevel('debug')` 就能看到 debug 轨迹 | 那个函数**不存在** |
 * | 读代码的人 | 所有 `log.debug(...)` 是"可开启的轨迹" | 那些行**结构性不可达**（永远是 info） |
 *
 * ★ 这正是本仓 AGENTS 规则 30 那条：「**接口摆在那里 ≠ 它被接上了**」，
 *   以及规则 32：「**工具不可用会伪装成没人用**」——
 *   "没人开过 debug" 读起来像"不需要"，实际是"打不开"。
 *
 * ## 修法：把级别放到 `globalThis` 上
 *
 * 访问 `globalThis.__qlLogLevel` 是**有副作用的形式**，摇树不能删；
 * 而且排障的人可以在 **DevTools 控制台**里直接写：
 *
 * ```js
 * globalThis.__qlLogLevel = 'debug'   // 后台页 / 任意扩展页面的控制台
 * ```
 *
 * 服务号 `Site.setLogLevel` 也保留（见 `service-worker.ts` 的 handler），
 * 但**即使那条路也没接线，控制台这条路一定通** —— 这是"排障开关"该有的冗余。
 */
export function setLogLevel(level: LogLevel): void {
  globalThis.__qlLogLevel = level;
}

export function getLogLevel(): LogLevel {
  return globalThis.__qlLogLevel ?? 'info';
}

/** 当前级别（读 `globalThis`，不缓存）—— `log()` 每次都问它，所以控制台里的改动**立刻生效**。 */
function levelNow(): LogLevel {
  return globalThis.__qlLogLevel ?? 'info';
}

/** 这条记录该不该输出。★ 用 `levelNow()` 而不是闭包里的常量 ⇒ 控制台改了立刻生效。 */
export function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[levelNow()];
}

// ---------------------------------------------------------------- 环形缓冲

/**
 * 现场证据缓冲。**不落盘**（见文件头约束 2）—— 调用方若要持久化，
 * 用 `drain()` 取走再自己写。
 */
const RING_SIZE = 200;
const ring: LogRecord[] = [];
let ringCursor = 0;

export function drain(): LogRecord[] {
  return ring.slice(ringCursor).concat(ring.slice(0, ringCursor));
}

export function clearBuffer(): void {
  ring.length = 0;
  ringCursor = 0;
}

// ---------------------------------------------------------------- 序列化

/**
 * 把一个任意值变成**可读的**字符串。
 *
 * ★ 这一步是整个模块里最容易做错的地方。
 *   如果只做 `String(arg)`，对象会变成 `[object Object]` —— 打码是生效的，
 *   但**日志失去全部诊断价值**，于是下一个人会去"顺手改成 JSON.stringify 再打码"
 *   （或者干脆在调用点自己拼字符串绕过本模块）。
 *
 * ★ 而 `JSON.stringify` 会**抛异常**（循环引用）或返回 `undefined`
 *   （`undefined` / 函数 / `Symbol`）。**日志代码抛异常比丢一条日志坏得多**：
 *   MV3 的 SW 里一个未捕获异常会终止整个 worker。
 */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (typeof value === 'function') return '[function]';
  if (typeof value === 'symbol') return value.toString();
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(value, (_k, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      // BigInt 不能进 JSON.stringify，会抛 TypeError
      if (typeof v === 'bigint') return `${v.toString()}n`;
      return v;
    }) ?? String(value);
  } catch {
    // 最后一道：宁可给个粗描述，也**绝不能**抛
    return '[unserializable]';
  }
}

/**
 * 做 `console` 风格的 `%s/%d/%i/%f/%o/%O/%c` 替换。
 *
 * ★ **这一步是必须的，不是"顺手对齐 console 习惯"。**
 *   实测踩过：如果只是把参数用空格拼起来，
 *   `logger.info('password=%s', 'Liyulong0901')` 会拼成
 *   `password=%s Liyulong0901` —— **`%s` 把值和键名分开了**，
 *   打码规则看到的是"一个孤立的词"，于是**完全失效**。
 *
 *   先替换、再打码，两者顺序不能反：替换让"键 = 值"重新贴在一起，
 *   打码才有东西可认。
 */
function interpolate(fmt: string, rest: unknown[]): string {
  let i = 0;
  const substituted = fmt.replace(/%[sdifjoOc%]/g, (token) => {
    if (token === '%%') return '%';
    if (i >= rest.length) return token; // 参数不够，原样保留（console 也是这个行为）
    return stringify(rest[i++]);
  });
  const extra = rest.slice(i).map(stringify);
  return [substituted, ...extra].join(' ');
}

/**
 * 把一次日志调用的全部参数拼成一条**已打码**的文本。
 *
 * 顺序：**先做 `%s` 替换 → 再拼多余参数 → 最后整体打码**。
 * 打码作用在整串上而不是逐个参数，因为凭据可能横跨参数边界
 * （`logger.info('token=%s', t)` 里键名在第一个参数、值在第二个）。
 */
export function formatArgs(args: unknown[]): string {
  if (args.length === 0) return '';
  const [first, ...rest] = args;
  const text = typeof first === 'string' ? interpolate(first, rest) : args.map(stringify).join(' ');
  return redact(text);
}

// ---------------------------------------------------------------- sink

/** 可选的外部 sink（例如写入 `chrome.storage.local` 的诊断缓冲）。**必须自己保证不抛**。 */
let sink: ((r: LogRecord) => void) | null = null;

export function setSink(fn: ((r: LogRecord) => void) | null): void {
  sink = fn;
}

// ---------------------------------------------------------------- 出口

function log(level: LogLevel, ns: string, args: unknown[]): void {
  // ★ 走 `shouldLog()`（它每次读 `globalThis`）⇒ 在控制台里改级别**立刻生效**，
  //   而不是"要重新加载扩展"。见 `setLogLevel()` 的注释。
  if (!shouldLog(level)) return;

  const msg = formatArgs(args);
  const record: LogRecord = { t: Date.now(), level, ns, msg };

  // 环形缓冲（现场证据）
  const entry: LogRecord = record;
  if (ring.length < RING_SIZE) {
    ring.push(entry);
  } else {
    ring[ringCursor] = entry;
    ringCursor = (ringCursor + 1) % RING_SIZE;
  }

  // 外部 sink —— **包在 try 里**：sink 出错不能把调用方的业务逻辑带崩
  if (sink) {
    try {
      sink(record);
    } catch {
      /* 刻意吞掉：日志通道的故障不该影响业务 */
    }
  }

  // console（主出口）
  // eslint-disable-next-line no-console -- 本模块是唯一允许直接调 console 的地方
  console[CONSOLE_METHOD[level]](`${record.ns} ${msg}`);
}

/** 一个绑定到某个模块名的 logger。 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/**
 * 把**已落盘的历史记录**放回内存环（v3.19）。
 *
 * ## 为什么需要它
 *
 * 环形缓冲在 **service worker 的内存里**，而 **MV3 空闲会回收 SW**
 * ⇒ 用户事后导出诊断包时，环往往已经空了。`setSink()` 负责**写出去**，
 * 本函数负责**读回来** —— 缺任一半，"日志活不到被读的时候"这个问题就没解决。
 *
 * ## ★ 三个刻意的设计
 *
 * ① **不进 sink**：这些记录本来就是从 sink 里落盘的，再喂回去会立刻重写一遍
 *    storage，且每启动一次就滚一遍。
 * ② **不再打码**：进来的 `msg` 是**落盘前就已经打过码的**（`log()` 里 `formatArgs`
 *    的产物）。再打一次是无害的，但会让人误以为"历史记录没打码"。
 *    ⇒ 这里只接受 `LogRecord`，调用方无法塞原始文本进来。
 * ③ **不做级别过滤**：它们**确实发生过**。若按当前 `currentLevel` 丢掉，
 *    环里的时间线就会缺段，而缺段比"多几条 debug"坏得多
 *    （排障时最怕的就是"以为看到的全貌其实不是全貌"）。
 *
 * @param records 已落盘的记录（`{t, level, ns, msg}`）；超长时只保留最后 `RING_SIZE` 条
 */
export function restoreToRing(records: readonly LogRecord[]): number {
  const usable = records.filter(
    (r) => r && typeof r.msg === 'string' && typeof r.t === 'number',
  );
  if (!usable.length) return 0;
  const keep = usable.slice(-RING_SIZE);
  for (const r of keep) {
    const entry: LogRecord = { t: r.t, level: r.level, ns: r.ns, msg: r.msg };
    if (ring.length < RING_SIZE) {
      ring.push(entry);
    } else {
      ring[ringCursor] = entry;
      ringCursor = (ringCursor + 1) % RING_SIZE;
    }
  }
  return keep.length;
}

/**
 * 取一个 logger。**产出留在本环境**（见 `forwardToSw` 的说明）。
 *
 * ★ 与服务器端同形（那边是 `logging_setup.get_logger("模块名")`）——
 *   两端形状一致能让"读日志的人"少一次上下文切换。
 */
export function getLogger(name: string): Logger {
  const ns = `${NS_PREFIX}:${name}`;
  return {
    debug: (...a: unknown[]) => log('debug', ns, a),
    info: (...a: unknown[]) => log('info', ns, a),
    warn: (...a: unknown[]) => log('warn', ns, a),
    error: (...a: unknown[]) => log('error', ns, a),
  };
}

// ---------------------------------------------------------------- 跨环境转发
//
// ★★ 为什么需要它（v3.19）：
//
//   `log()` 的环形缓冲与 `setSink()` 的落盘都在 **service worker 里**。
//   而 **content script 与扩展页面各有自己的 JS 环境** —— 它们调 `getLogger`
//   写进的是**另一个进程的内存**，那个环**永远不会**进诊断包
//   （诊断包由 SW 的 `ql.diag` 产）。
//
//   ⇒ 实测：`ui/` 下 **9 个文件全部零日志**，`content/` 下 6/7 零日志。
//     不是"忘了加"，而是**加了也看不到** ⇒ 于是没人加。
//     ★ 这是 `PITFALLS #22`（落盘通道没接线）的**同类**：
//       机制只接到了 SW 这一端，另外两个环境从来没接上。
//
// ★ 做法：让前端把**已打码**的 `LogRecord` 交给一个**注入的发送函数**，
//   由它转给 SW；SW 收到后直接喂进 `restoreToRing()` ⇒ 进内存环 + 走 sink 落盘。
//
// ★ 为什么用**注入**而不是直接 `import` 消息类型：
//   那会让 `shared/log.ts` 依赖 `shared/messages.ts`，而 messages 又被
//   service-worker 引用 —— 编译期不一定成环，但**耦合方向反了**
//   （日志是最底层的工具，不该知道业务消息契约）。注入一个
//   `(rec: LogRecord) => void` 就够了，且**可测**。

/** 前端把日志交给谁（由 UI 侧注入，通常是发一条 `ql.log` 消息给 SW）。 */
let forwarder: ((rec: LogRecord) => void) | null = null;

/**
 * 装上跨环境转发器。传 `null` 取消。
 *
 * ★ **发送方自己保证不抛**（照 `setSink` 的约定）—— 日志通道的故障不该影响业务。
 *   转发器内部抛出的异常会被这里吞掉，并且**不会再产生一条日志**
 *   （否则失败 → 记日志 → 再失败 → 无限放大）。
 */
export function setForwarder(fn: ((rec: LogRecord) => void) | null): void {
  forwarder = fn;
}

/**
 * 取一个**会转发到 SW** 的 logger（前端环境用）。
 *
 * ★ 与 `getLogger` 的区别只有一点：每条日志**额外**交给 forwarder。
 *   本环境的 console/内存环行为完全不变 ⇒ 即使 SW 不可达，DevTools 里照样看得到。
 *
 * ★ 转发的 `msg` 是**已打码**的（`log()` 里 `formatArgs` 的产物）——
 *   所以跨环境不引入新的泄露面。
 */
export function getForwardingLogger(name: string): Logger {
  // ★ 刻意**不**复用 `getLogger(name)` 的四个方法：这里要的是"本环境产出 + 转发"，
  //   而直接调模块级 `log()` 更直白（复用的话还要再解析一遍 ns）。
  const wrap = (level: LogLevel) => (...a: unknown[]) => {
    const ns = `${NS_PREFIX}:${name}`;
    // 先按本环境规则产出（打码 + 级别过滤都在 log() 里）
    log(level, ns, a);
    // 再转发**已打码的文本**
    if (forwarder && shouldLog(level)) {
      try {
        forwarder({ t: Date.now(), level, ns, msg: redact(formatArgs(a)) });
      } catch {
        /* 转发失败不能影响业务，也不能再记一条日志（会放大） */
      }
    }
  };
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    error: wrap('error'),
  };
}
