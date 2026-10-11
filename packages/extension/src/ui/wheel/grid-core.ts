import type { WheelAccount } from './wheel-core';
import { DEFAULT_BOX, truncate } from './wheel-core';
import { GRID_SLOTS, buildItemGrid, h } from './item-grid';
import type { GridItem } from './item-grid';

/**
 * **账号**选择网格（v4.1；v4.1.2 改为复用 `item-grid.ts` 的通用内核）。
 *
 * 本文件只放"账号特有"的那部分：
 * - 把 `WheelAccount` 的运行态翻成用户能读的一句话（在线/待登录/离线/未授权·已暂停）；
 * - 标题栏口径 `N/20 个 · 在线 M · 盒 i/j`；
 * - "盒子 = 一页"的分页语义（`groupPagesByBox` 由调用方算好传进来）。
 *
 * ★ 排版（定尺 5×4=20 格）、占位格、滚轮语义、空态、页脚 —— 全在 `item-grid.ts`，
 *   三个轮盘（Alt+Q / Alt+W / Alt+1）**共用同一套**，改一处三处生效。
 */
export interface GridOpts {
  /** 每个盒子一页（**不裁剪**；超过 20 个则网格滚动） */
  pages: { label: string; accounts: WheelAccount[] }[];
  pageIndex: number;
  onPage: (delta: number) => void;
  onPick: (accountId: string) => void;
  emptyAction?: { label: string; run: () => void };
}

/** 运行态短语：把 `hasToken` / `tabIds` / `enforcementOff` 翻成用户能读的一句话 */
function statusText(a: WheelAccount): { text: string; cls: 'on' | 'wait' | 'idle' | 'off' } {
  if (a.enforcementOff) {
    return { text: '未授权 · 已暂停', cls: 'off' };
  }
  const n = a.tabIds?.length ?? 0;
  if (n > 0 && a.hasToken) {
    return { text: n > 1 ? `在线 ×${n}` : '在线', cls: 'on' };
  }
  if (n > 0) {
    return { text: '待登录', cls: 'wait' };
  }
  return { text: '离线', cls: 'idle' };
}

function toGridItem(a: WheelAccount): GridItem {
  const st = statusText(a);
  return {
    key: a.id,
    label: a.tabName || a.username,
    sub: st.text,
    subKind: st.cls,
    accent: a.color,
    title: `${a.tabName || a.username}${a.username ? `（${a.username}）` : ''}`,
  };
}

export function buildAccountGrid(root: HTMLElement, opts: GridOpts): void {
  root.innerHTML = '';
  root.classList.add('acct-grid');

  const pages = opts.pages;
  const page = pages[opts.pageIndex];
  const accounts = page?.accounts ?? [];
  const pageCount = pages.length;
  const pagePos = pageCount > 0 ? ((opts.pageIndex % pageCount) + pageCount) % pageCount : 0;

  const onlineCount = accounts.filter((a) => (a.tabIds?.length ?? 0) > 0).length;
  // 分母取 `max(容量, 实际数)`：某盒真有 26 个时写 `26/26` 而不是 `26/20`
  // —— 后者会读成"超编了"，而实际是"这盒确实有 26 个，网格滚动显示"。
  const capacity = Math.max(GRID_SLOTS, accounts.length);
  const meta = accounts.length
    ? `${accounts.length}/${capacity} 个 · 在线 ${onlineCount}${pageCount > 1 ? ` · 盒 ${pagePos + 1}/${pageCount}` : ''}`
    : '空盒子';

  const allEmpty = pages.every((p) => p.accounts.length === 0);
  const wrap = buildItemGrid({
    items: accounts.map(toGridItem),
    pageCount,
    pagePos,
    title: truncate(page?.label ?? DEFAULT_BOX, 12),
    meta,
    onPage: opts.onPage,
    onPick: opts.onPick,
    empty: {
      line1: allEmpty ? '暂无并行账号' : '这个盒子还没有账号',
      line2: allEmpty
        ? undefined
        : pageCount > 1
          ? '滚轮或 ← → 换到别的盒子'
          : '到并行管理页把它加进任意盒子',
      action: opts.emptyAction,
    },
  });
  root.append(wrap);

  // 空态下也把"能滚走"说出来：实测用户曾**被困在空盒子里**（以为卡住了）
  if (accounts.length === 0 && pageCount > 1) {
    const wrapEl = root.querySelector('.ag-wrap');
    if (wrapEl) {
      wrapEl.querySelector('.ag-tip')?.replaceChildren(document.createTextNode('滚轮 / ← → 换到别的盒子'));
    }
  }
}

export { h };
