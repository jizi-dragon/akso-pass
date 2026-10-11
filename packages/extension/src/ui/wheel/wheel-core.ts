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
 * - `truncate` / `DEFAULT_BOX`：小的显示工具。
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
