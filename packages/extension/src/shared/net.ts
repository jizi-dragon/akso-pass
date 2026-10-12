/** 通用网络/异步小工具（`shared/` 层，background 与 UI 页共用；**不进 content 注入**） */

/**
 * 给 Promise 套一个超时。
 *
 * ★ 为什么必须有：MV3 的 `fetch` **没有默认超时**。国内两路引擎偶发"连上了但不返回"，
 *   而 `Promise.any` 只在**有人 reject 时**才结束 —— 少一个超时门，赛马就会变成
 *   "等到天荒地老"。原扩展在这一点上是对的（`with_timeout`），照搬并注明。
 *
 * ★ `clearTimeout` 两个分支都要清：只清成功分支的话，**失败路径会留下一个悬挂的定时器**
 *   （MV3 的 SW 本来就会被回收，但 UI 页不会 ⇒ 长开的管理页会慢慢攒定时器）。
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
