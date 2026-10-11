import { buildItemGrid } from './item-grid';
import type { GridItem } from './item-grid';

/**
 * **常用页面书签**网格（Alt+1；v4.1.2 由环形改为定尺网格）。
 *
 * 语义（沿用 v3.16 的交互约定，只换布局）：
 * - 一格 = 一个书签；**没有"当前项"**概念，全格同色；
 * - 相对路径会在格子里标出"将打开哪个域名"（换布局后这行更有用：
 *   环形时它只在 Hub 里、且要悬停才出现；现在直接写在格上）。
 *
 * ★ 顺带修掉一处旧行为：v3.16 的环形版对超过 10 个书签会在 Hub 写
 *   "共 N 个 · 仅显示前 10" —— 也就是**同样会丢**。网格一页 20 格且超出滚动，
 *   ⇒ 书签不再被丢弃。
 */
export interface FavoriteWheelItem {
  name: string;
  path: string;
}

export interface FavoritesWheelOpts {
  favorites: FavoriteWheelItem[];
  /** 基准域名（相对路径会拼到它上面） */
  baseOrigin: string;
  /** 有值 = 只展示原因，不响应点击 */
  disabledReason?: string;
  onPick: (item: FavoriteWheelItem) => void;
}

export function buildFavoritesWheel(root: HTMLElement, opts: FavoritesWheelOpts): void {
  root.innerHTML = '';
  root.classList.add('acct-grid');

  const n = opts.favorites.length;
  const isAbsolute = (p: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(p.trim());
  const host = (() => {
    try {
      return opts.baseOrigin ? new URL(opts.baseOrigin).host : '';
    } catch {
      return '';
    }
  })();

  const items: GridItem[] = opts.favorites.map((f) => ({
    key: f.path,
    label: f.name,
    // 副行：相对路径写出目标域名（书签名相近时这是最有用的一行）
    sub: isAbsolute(f.path) ? '完整网址' : host || '相对路径',
    subKind: 'idle',
    title: `${f.name}\n${f.path}`,
  }));

  const wrap = buildItemGrid({
    items: opts.disabledReason ? [] : items,
    pageCount: 1,
    pagePos: 0,
    title: '常用页面',
    meta: n ? `${n}/${Math.max(20, n)} 个${host ? ` · ${host}` : ''}` : '暂无书签',
    onPage: () => undefined,
    onPick: (path) => {
      if (opts.disabledReason) {
        return;
      }
      const it = opts.favorites.find((f) => f.path === path);
      if (it) {
        opts.onPick(it);
      }
    },
    empty: {
      line1: opts.disabledReason || '还没有任何书签',
      line2: opts.disabledReason ? undefined : '到并行管理页的「常用页面」里添加',
    },
    tip: opts.disabledReason ? '当前不可用' : `点击或按数字键打开 · 共 ${n} 个`,
  });
  root.append(wrap);
}
