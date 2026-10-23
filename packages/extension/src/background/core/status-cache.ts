/**
 * 状态轮盘的短 TTL 缓存（纯逻辑，不碰 chrome API）。
 *
 * 为什么要缓存：打开一次轮盘要串行发 `GetFormInstance` + `GetListByBasicId`
 * 两次请求；同一页签在短时间内反复打开（选中失败重试、改完又打开）没有必要重付。
 *
 * 三条边界：
 * - **按 tabId 进入 key**：不同页签可能是不同账号，状态列表不能跨账号复用；
 * - **TTL 30s**：平台侧状态/权限可能被别人改，缓存不能当权威；
 * - **切换成功必须失效**：否则轮盘会把刚切走的旧状态继续标成“当前”。
 */

export interface StatusCacheEntry<T> {
  value: T;
  at: number;
}

export class StatusCache<T> {
  private readonly entries = new Map<string, StatusCacheEntry<T>>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 30,
  ) {}

  get(key: string, now = Date.now()): T | null {
    const hit = this.entries.get(key);
    if (!hit) {
      return null;
    }
    if (now - hit.at > this.ttlMs) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    // Map 按插入顺序迭代；超上限时删最旧的一条，避免长期挂着已关闭页签的键。
    if (!this.entries.has(key) && this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(key, { value, at: now });
  }

  /** 页签切换状态/刷新后，清掉它的全部实例键。 */
  invalidateTab(tabId: number): void {
    const prefix = `${tabId}|`;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
