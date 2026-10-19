import type { ParallelAccount, ParallelAccountStatus } from '../../shared/types';

/**
 * 账号侧的数据模型与分组（原 `wheel-core.ts`）。
 *
 * ## ★★ 这个文件曾经是"环形轮盘的几何内核"
 *
 * v3.9–v4.1 它导出的是 `SIZE` / `C` / `R_OUT` / `R_IN` / `polar` / `sectorPath` /
 * `radialText` / `el`（SVG 命名空间建元素）—— 一整套**极坐标渲染原语**，
 * 供环形扇区轮盘使用。
 *
 * v4.1.2 起三个轮盘（账号 Alt+Q / 生命周期 Alt+W / 常用地址 Alt+1）**全部改为定尺网格**
 * ⇒ 那套原语**一个使用者都没有了**（连最后一个 `buildRingWheel` 都随
 * `ring-wheel.ts` 一起删除）⇒ 整体移除。
 *
 * ★ 留着它们的代价不是"多几行"：`polar` / `radialText` 的存在会让人以为
 *   **还有地方在画环**，从而去找一个不存在的渲染路径（同 `PITFALLS #19` 的形态）。
 *   ⇒ 判据：`grep -r "polar(\|radialText(\|sectorPath(" packages/extension/src` **零命中**。
 *
 * ## 剩下来的都是"与布局无关"的东西
 *
 * - `WheelAccount`：三个网格共用的账号视图类型；
 * - `groupPagesByBox`：**盒子 = 一页**的分页语义（账号轮盘用）；
 * - `truncate` / `DEFAULT_BOX`：小的显示工具；
 * - `fetchPreferredBox` / `applyPreferredPage`：**当前站点优先盒子**（2026-10-19，
 *   两个消费者：小窗 + 页内浮层）。它们不画东西，只决定"从第几页开始"。
 *
 * ⇒ 布局无关 ⇒ 将来再换形式（列表/树/看板）这些都不用动。
 */

export type WheelAccount = Pick<ParallelAccount, 'id' | 'tabName' | 'username' | 'color' | 'box'> &
  Partial<ParallelAccountStatus>;

/** 缺省盒子名（调用方可通过参数传入自定义名） */
export const DEFAULT_BOX = '默认盒子';

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** 按盒子分页（保持账号固有顺序；缺省归「默认盒子」，可自定义其显示名） */
export function groupPagesByBox(
  accounts: WheelAccount[],
  defaultBoxName: string = DEFAULT_BOX,
): { label: string; accounts: WheelAccount[] }[] {
  const pages: { label: string; accounts: WheelAccount[] }[] = [];
  const byName = new Map<string, WheelAccount[]>();
  for (const a of accounts) {
    const name = a.box?.trim() || defaultBoxName;
    if (!byName.has(name)) {
      byName.set(name, []);
      pages.push({ label: name, accounts: byName.get(name)! });
    }
    byName.get(name)!.push(a);
  }
  return pages;
}

/**
 * ★★ 2026-10-19（用户要求 ⑦）：向后台要"当前站点优先的盒子"。
 *
 * `host` 由**小窗**传（它的页签没有站点上下文）；页内浮层不传 ——
 * 后台用 `sender.tab` 取当前页，身份归属不能交给页面自报。
 *
 * 取不到（后台无应答 / 离线 / 老版本）一律返回空串 ⇒ 轮盘从第一页开始，
 * 与改动前完全一致。**不猜**一个盒子。
 */
export async function fetchPreferredBox(host = ''): Promise<string> {
  /* ★ 1.5 秒上限：后台要打两次云端（盒子 + 站点）。冷启动/弱网时它可能很久，
   *   而**轮盘不能因此不显示** —— 拿不到就当没有偏好，先按默认盒画出来。 */
  const timeout = new Promise<string>((resolve) => {
    setTimeout(() => resolve(''), 1500);
  });
  try {
    const res = (await Promise.race([
      chrome.runtime.sendMessage({
        kind: 'par.wheelContext',
        ...(host ? { host } : {}),
      }),
      timeout,
    ])) as
      | { kind?: string; result?: { ok?: boolean; data?: { preferredBox?: string } } }
      | undefined;
    const data = res?.result?.ok ? res.result.data : undefined;
    return typeof data?.preferredBox === 'string' ? data.preferredBox : '';
  } catch {
    return '';
  }
}

/**
 * 把"优先盒子"落到页序号上。
 *
 * - 该盒已有页 ⇒ 返回它的下标
 * - 后台说有这个盒子、但轮盘页里还没有（空盒没被记住）⇒ **补一页空页**
 *   （用户要求"跳转到关联了站点 A 的盒子"，而不是悄悄回到第一页）
 * - 默认盒为空时**不补** —— 空默认盒是自动禁用的（`groupPagesByBox` 不为它出页），
 *   补出来会与"禁用盒不进轮盘"的既有规则冲突
 * - 没有偏好 ⇒ `-1`（调用方保持第 0 页）
 */
export function applyPreferredPage(
  pages: { label: string; accounts: WheelAccount[] }[],
  preferred: string,
  defaultBoxName: string = DEFAULT_BOX,
): number {
  const want = preferred.trim();
  if (!want) {
    return -1;
  }
  const hit = pages.findIndex((p) => p.label === want);
  if (hit >= 0) {
    return hit;
  }
  if (want === defaultBoxName) {
    return -1;
  }
  pages.push({ label: want, accounts: [] });
  return pages.length - 1;
}
