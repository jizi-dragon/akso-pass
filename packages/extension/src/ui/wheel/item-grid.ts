/**
 * 通用**定尺网格**内核（v4.1.2）—— 三个轮盘（账号 Alt+Q / 生命周期 Alt+W / 常用地址 Alt+1）
 * 共用同一套排版与交互。
 *
 * ## 定尺：5 列 × 4 行 = 20 格
 *
 * 小窗固定 720×760（`service-worker.ts` 的 `WHEEL_W/H`），一侧内容区约 704 宽
 * ⇒ 20 格一屏放得下、不需要滚动 ⇒ 几何可以写死：
 *
 * | 纪律 | 为什么 |
 * |---|---|
 * | **槽位恒为 20**，不足补**占位格** | "8 个"和"20 个"的网格几何**完全一样**（格宽/行高/行位置都不跳）⇒ 切页时不整页重排 |
 * | 行高固定（`grid-auto-rows`） | 名字长短不影响格高 |
 * | 列宽 `minmax(0,1fr)` | 随容器均分 |
 *
 * ## 两件必须做对的事（都来自真实事故）
 *
 * 1. **不截断**：超出 20 个时 `overflow-y:auto` **滚动**显示 ——
 *    v4.1 之前是 `slice(0, 10)` **直接丢弃**，用户静默少看到账号。
 * 2. ★★ **滚轮不许有死角**：滚轮切页的守卫**不能写成"这一页有没有内容"** ——
 *    空盒子/空列表时"没内容可滚"不等于"不许切页"，否则用户会**被困在空页里出不来**
 *    （实测事故：切到空盒子后滚轮失效）。判据见本文件 `wheelIntent`。
 */

/** 网格列数（5 列 × 4 行 = 20） */
export const GRID_COLS = 5;

/** 一页的**固定容量** = 5 × 4 */
export const GRID_SLOTS = 20;

/** 数字键可用数：`1-9` + `0` */
export const KEY_MAX = 10;

/** 一个格子的数据（三个轮盘共用；各自的语义差异用 `sub`/`current`/`disabled` 表达） */
export interface GridItem {
  /** 稳定标识（回传给 onPick） */
  key: string;
  /** 主行文字（账号名 / 状态名 / 书签名） */
  label: string;
  /** 副行文字（运行态 / 说明）。空则不渲染副行 */
  sub?: string;
  /** 副行的语义色 */
  subKind?: 'on' | 'wait' | 'idle' | 'off';
  /** 左侧色条（账号色 / 状态色）。缺省用品牌色 */
  accent?: string;
  /** 当前项（状态轮盘用）：加高亮环 + `ag-cell-current` */
  current?: boolean;
  /** 只展示不可点（例如"未授权·已暂停"的账号） */
  disabled?: boolean;
  /** 悬停时的 title（放下完整信息，弥补格内截断） */
  title?: string;
}

export interface ItemGridOpts {
  items: GridItem[];
  /** 页数（>1 才渲染页码点与左右箭头） */
  pageCount: number;
  /** 当前页序号（0 基） */
  pagePos: number;
  /** 标题栏主行（盒子名 / 生命周期名 / 基准域名） */
  title: string;
  /** 标题栏右侧的口径（如 `18/20 个 · 在线 10`） */
  meta: string;
  /** 切页 */
  onPage: (delta: number) => void;
  /** 选中 */
  onPick: (key: string) => void;
  /** 空态 */
  empty: { line1: string; line2?: string; action?: { label: string; run: () => void } };
  /** 页脚提示（缺省按"要不要提示数字键边界"自动生成） */
  tip?: string;
  /** 是否显示左右箭头（单页时隐藏） */
  showNav?: boolean;
}

/** 建 HTML 元素（★ 不能用 `wheel-core.el()` —— 那个建的是 SVG 命名空间的元素） */
export function h(
  name: string,
  cls: string,
  attrs: Record<string, string | number> = {},
): HTMLElement {
  const node = document.createElement(name);
  node.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

/**
 * ★★ 滚轮意图判定 —— 这个函数存在的唯一理由是**修一个真实死角**。
 *
 * 事故：切到**空盒子**后滚轮失效，用户被困在空页里。
 * 根因是守卫写成了"这一页有没有内容"（空页 ⇒ 不处理滚轮）——
 * 而**"没内容可滚"与"不许切页"是两件事**：空页恰恰最需要能滚走。
 *
 * 正确语义：
 * - 列表**能滚且还没滚到头** ⇒ 让列表自己滚（把超出的项滚出来）；
 * - 其余一切情况（空页 / 内容不足一屏 / 已滚到边界） ⇒ **切页**。
 *
 * @returns 'scroll' = 交给列表滚；'page' = 切页
 */
export function wheelIntent(
  dir: 1 | -1,
  grid: HTMLElement | null,
): 'scroll' | 'page' {
  if (!grid) {
    return 'page';
  }
  const canScroll = grid.scrollHeight > grid.clientHeight + 1;
  if (!canScroll) {
    return 'page'; // 一屏放得下（含空页）⇒ 没有任何理由拦住切页
  }
  const atTop = grid.scrollTop <= 0;
  const atBottom = grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 1;
  if (dir === 1) {
    return atBottom ? 'page' : 'scroll';
  }
  return atTop ? 'page' : 'scroll';
}

/**
 * 构建定尺网格。返回根元素（调用方负责挂载与 `.in` 入场）。
 */
export function buildItemGrid(opts: ItemGridOpts): HTMLElement {
  const wrap = h('div', 'ag-wrap');

  /* ---------------- 标题栏 ---------------- */
  const head = h('div', 'ag-head');
  const showNav = opts.showNav !== false && opts.pageCount > 1;

  if (showNav) {
    const prev = h('button', 'ag-nav', { type: 'button', 'aria-label': '上一页' });
    prev.textContent = '‹';
    prev.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onPage(-1);
    });
    head.append(prev);
  }

  const title = h('div', 'ag-title');
  const name = h('span', 'ag-box');
  name.textContent = opts.title;
  const meta = h('span', 'ag-meta');
  meta.textContent = opts.meta;
  title.append(name, meta);
  head.append(title);

  if (showNav) {
    const next = h('button', 'ag-nav', { type: 'button', 'aria-label': '下一页' });
    next.textContent = '›';
    next.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onPage(1);
    });
    head.append(next);
  }
  wrap.append(head);

  /* ---------------- 空态 ---------------- */
  if (opts.items.length === 0) {
    const empty = h('div', 'ag-empty');
    const l1 = h('div', 'ag-empty-t');
    l1.textContent = opts.empty.line1;
    empty.append(l1);
    if (opts.empty.line2) {
      const l2 = h('div', 'ag-empty-s');
      l2.textContent = opts.empty.line2;
      empty.append(l2);
    }
    if (opts.empty.action) {
      const btn = h('button', 'ag-empty-btn', { type: 'button' });
      btn.textContent = opts.empty.action.label;
      btn.addEventListener('click', () => opts.empty.action!.run());
      empty.append(btn);
    }
    // ★ 空态也保留页脚提示：让用户知道"还能滚走"，而不是以为卡住了
    wrap.append(empty);
    const foot0 = h('div', 'ag-foot');
    const tip0 = h('div', 'ag-tip');
    tip0.textContent = opts.pageCount > 1 ? '滚轮 / ← → 换页' : '没有可选项';
    foot0.append(tip0);
    wrap.append(foot0);
    return wrap;
  }

  /* ---------------- 网格：全部项都渲染（刻意不 slice）+ 补足 20 格 ---------------- */
  const grid = h('div', 'ag-grid');
  grid.style.setProperty('--ag-cols', String(GRID_COLS));

  opts.items.forEach((it, i) => {
    const cell = h('button', `ag-cell${it.current ? ' ag-cell-current' : ''}`, { type: 'button' });
    cell.dataset.itemKey = it.key;
    cell.style.setProperty('--acct', it.accent || 'var(--acc, #1e6fff)');
    cell.title = it.title || it.label;
    if (it.disabled) {
      cell.classList.add('ag-cell-disabled');
      cell.setAttribute('aria-disabled', 'true');
    }

    const nm = h('span', 'ag-name');
    nm.textContent = it.label;
    cell.append(nm);

    if (it.sub) {
      const sub = h('span', `ag-status ${it.subKind ?? 'idle'}`);
      sub.textContent = it.sub;
      cell.append(sub);
    }

    // 数字键角标：**只有前 10 个**（键位就这么多）
    if (i < KEY_MAX) {
      const k = h('span', 'ag-key');
      k.textContent = String((i + 1) % 10);
      cell.append(k);
    }

    if (!it.disabled) {
      cell.addEventListener('click', () => opts.onPick(it.key));
    }
    grid.append(cell);
  });

  /* 补足到 20 个占位格：让"少项的页"与"满页"**几何完全一致**。
     占位格不可点、无角标、不进 tab 序（用 div 而不是 button）。 */
  for (let i = opts.items.length; i < GRID_SLOTS; i++) {
    grid.append(h('div', 'ag-slot'));
  }
  wrap.append(grid);

  /* ---------------- 页脚 ---------------- */
  const foot = h('div', 'ag-foot');
  if (opts.pageCount > 1) {
    const dots = h('div', 'ag-dots');
    for (let i = 0; i < opts.pageCount; i++) {
      const d = h('button', `ag-dot${i === opts.pagePos ? ' on' : ''}`, {
        type: 'button',
        'aria-label': `第 ${i + 1} 页`,
      });
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        opts.onPage(i - opts.pagePos);
      });
      dots.append(d);
    }
    foot.append(dots);
  }
  const tip = h('div', 'ag-tip');
  tip.textContent = opts.tip
    ?? (opts.items.length > KEY_MAX
      ? `前 ${KEY_MAX} 个可用数字键 · 其余点击选择`
      : '点击或按数字键' + (opts.pageCount > 1 ? ' · 滚轮换页' : ''));
  foot.append(tip);
  wrap.append(foot);

  /* ---------------- 滚轮：**永不设死角** ---------------- */
  wrap.addEventListener(
    'wheel',
    (e) => {
      if (opts.pageCount <= 1) {
        return;
      }
      const dir: 1 | -1 = e.deltaY > 0 ? 1 : -1;
      // ★★ 顺序很要紧：**先判意图，再决定要不要 preventDefault**。
      //   第一版我无条件 `preventDefault()` 才判意图 ⇒ 意图为 'scroll' 时
      //   原生滚动已经被禁掉 ⇒ "让列表自己滚"永远不成立（静默失效）。
      if (wheelIntent(dir, grid) === 'page') {
        e.preventDefault();
        opts.onPage(dir);
      }
      // 'scroll' ⇒ **不** preventDefault，交给 `.ag-grid` 原生滚动
    },
    { passive: false },
  );

  return wrap;
}
