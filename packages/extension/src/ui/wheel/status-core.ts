import { buildItemGrid } from './item-grid';
import type { GridItem } from './item-grid';

/**
 * **生命周期状态**网格（Alt+W；v4.1.2 由环形改为定尺网格）。
 *
 * 语义（沿用 v3.15 的交互约定，只换布局）：
 * - 一格 = 一个状态；**当前状态**加高亮环（`.ag-cell-current`）；
 * - 点即执行 —— 但格子里直接把"当前"标出来，不必再靠 Hub 预演；
 * - 状态数常有十几个（实测 13 个），而**网格一页 20 格** ⇒ 一屏全见。
 *
 * ★ 为什么状态轮盘比账号轮盘更该用网格：状态是**固定枚举**，用户不需要空间记忆，
 *   而"一眼看全 + 当前项高亮"正好是网格的强项。
 */
export interface StatusWheelItem {
  id: string;
  code: string;
  name: string;
  isCurrent: boolean;
}

export interface StatusWheelOpts {
  statuses: StatusWheelItem[];
  /** 标题栏主行：生命周期名（更稳定），缺省退到实例名 */
  lifecycleName: string;
  /** 实例 / 对象展示名（空态用） */
  instanceLabel: string;
  /** 有值 = 只展示原因，不响应点击（例如缺 instanceId） */
  disabledReason?: string;
  onPick: (item: StatusWheelItem) => void;
}

export function buildStatusWheel(root: HTMLElement, opts: StatusWheelOpts): void {
  root.innerHTML = '';
  root.classList.add('acct-grid');

  const current = opts.statuses.find((s) => s.isCurrent);
  const currentName = current?.name ?? '';
  const n = opts.statuses.length;

  const items: GridItem[] = opts.statuses.map((s) => ({
    key: s.code,
    label: s.name,
    // 副行只给当前项写"当前"，其余留空 —— 避免 13 行都在喊同一句话
    sub: s.isCurrent ? '当前' : undefined,
    subKind: s.isCurrent ? 'on' : undefined,
    accent: s.isCurrent ? undefined : '#94A3B8',
    current: s.isCurrent,
  }));

  const meta = opts.disabledReason
    ? '不可切换'
    : n
      ? `${n}/${n} 个${currentName ? ` · 当前 ${currentName}` : ' · 当前状态未知'}`
      : '无状态';

  const wrap = buildItemGrid({
    items: opts.disabledReason ? [] : items,
    // 状态是固定枚举、一页装得下 ⇒ 不做分页（pageCount=1 时内核自动隐藏翻页控件）
    pageCount: 1,
    pagePos: 0,
    title: opts.lifecycleName || opts.instanceLabel || '当前实例',
    meta,
    onPage: () => undefined,
    onPick: (code) => {
      if (opts.disabledReason) {
        return;
      }
      const it = opts.statuses.find((s) => s.code === code);
      if (it) {
        opts.onPick(it);
      }
    },
    empty: {
      line1: opts.disabledReason || '没有读到可切换的状态',
      line2: opts.disabledReason ? '请切到对象实例页再试' : '可能是当前账号无权查看该生命周期',
    },
    tip: opts.disabledReason ? '当前不可切换' : `点击或按数字键切换 · 共 ${n} 个状态`,
  });
  root.append(wrap);
}
