/**
 * 环形缓冲的**合并写**（`ql:diag` 环 60 / `ql:forensics` 环 120）。
 *
 * ## 为什么需要它（2026-11-09 实测）
 *
 * 原来的 `diag()` / `forensics()` 都是**裸的读-改-写**：
 *
 * ```ts
 * const cur = (await chrome.storage.local.get(key))[key] as string[] | undefined;
 * await chrome.storage.local.set({ [key]: [...(cur ?? []), item] });
 * ```
 *
 * 同一个 tick 里来两条时，第二条的 `get` 读到的仍是**写入前**的数组 ⇒ 前一条被覆盖。
 * 实测（真 Edge 157 + 真 `chrome.storage`，扩展页上下文，按 diag 原样模式跑）：
 *
 * | 写法 | 20 条并发后环里剩下 |
 * |---|---|
 * | 原样（get→set） | **1 条** |
 * | 同一段逻辑串行化 | **20 条** |
 *
 * 而"同一 tick 多条"恰恰是本扩展的常态 —— `open()` 里连续埋点、两个账号同时开、
 * 多页签并发流程。⇒ 环 60 / 环 120 的设计前提**不成立**：
 * 证据不是丢在"没埋点"，是丢在"写不进去"。
 *
 * ## 做法：合并，而不是加锁
 *
 * `appendRing()` 只把条目放进本进程的待写队列，并在**本轮微任务末尾**合并成
 * **一次** `get → concat → set`：
 *
 * · 一次 burst 只写一次 storage（顺带省掉 N-1 次读改写）
 * · 队列内顺序 = 调用顺序 ⇒ 环里的时间顺序不乱
 * · 两次 flush 之间靠一条 promise 链**严格串行**（前一次写完才跑下一次）
 * · 落盘失败只丢那一批，异常一律吞掉（埋点失败不能影响业务，与原约定一致）
 *
 * ★ 刻意**不**做去重/采样：去重会让"同一行出现 30 次"这个事实消失，而那正是
 *   排障时最有用的信息之一。容量控制交给环的 `cap`。
 *   热路径的抑制放在**调用点**（谁知道自己热，谁自己决定要不要降级到 `log.debug`）。
 */

interface Queue {
  /** 待写条目（按调用顺序） */
  items: unknown[];
  /** 该 key 的环容量（以最后一次调用传入的为准） */
  cap: number;
}

/** key → 待写队列 */
const queues = new Map<string, Queue>();

/**
 * 串行链：**上一次落盘写完**才开始下一次。
 *
 * ★ 只靠"凑一批写一次"还不够：两次 flush 之间如果还有 `get` 没回来，
 *   后一次仍会读到旧数组。链保证 `get → set` 是严格串行的。
 */
let chain: Promise<void> = Promise.resolve();

/** 本轮是否已经排过 flush（同一 tick 内只排一次） */
let scheduled = false;

/**
 * 追加一条到环形缓冲（同步、永不抛）。
 *
 * 调用点照旧写 `void diag(...)` 即可 —— 它不再需要 await 存储。
 *
 * @param key `chrome.storage.local` 的键（`ql:diag` / `LOCAL_KEYS.forensics`）
 * @param cap 环容量（超出后保留**最近的** cap 条）
 * @param item 已打码的条目
 */
export function appendRing(key: string, cap: number, item: unknown): void {
  let q = queues.get(key);
  if (q === undefined) {
    q = { items: [], cap };
    queues.set(key, q);
  }
  q.cap = cap;
  q.items.push(item);
  // 极端 burst（同一 tick 几千条）不许把内存吃穿：只留最近 3 倍容量的待写项。
  // ★ 这里是**丢最老的**，与环本身的淘汰方向一致。
  if (q.items.length > q.cap * 3) {
    q.items.splice(0, q.items.length - q.cap * 2);
  }
  schedule();
}

function schedule(): void {
  if (scheduled) return;
  scheduled = true;
  chain = chain.then(flush).catch(() => {
    /* 落盘失败不影响业务；下一批照常写（与原来 diag/forensics 的 catch 等价） */
  });
}

async function flush(): Promise<void> {
  // ★ 先放开 scheduled：flush 期间新追加的条目要能**再排一次**，
  //   否则它们要等到下一次外部触发才落盘。
  scheduled = false;
  if (queues.size === 0) {
    return;
  }
  const batch = [...queues.entries()];
  queues.clear();
  for (const [key, q] of batch) {
    if (q.items.length === 0) {
      continue;
    }
    const cap = Math.max(1, q.cap);
    try {
      const stored = await chrome.storage.local.get(key);
      const cur: unknown = stored[key];
      const prev = Array.isArray(cur) ? (cur as unknown[]) : [];
      await chrome.storage.local.set({ [key]: [...prev, ...q.items].slice(-cap) });
    } catch {
      /* 这一批丢了就丢了 —— 埋点失败绝不能反过来影响业务 */
    }
  }
}

/**
 * 等队列**彻底写完**。
 *
 * ★ 只给验证脚本 / 台架用（判据必须能"写完再读"，否则会与合并写竞态）。
 *   业务代码不该 await 它 —— 那等于把 `diag()` 变回一次存储往返。
 */
export async function ringIdle(): Promise<void> {
  do {
    await chain;
  } while (scheduled || queues.size > 0);
}
