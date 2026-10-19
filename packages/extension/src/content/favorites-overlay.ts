/**
 * Favorites Overlay —— 常用页面书签轮盘的「页面内浮层」（v3.16，快捷键 Alt+1）。
 *
 * 需求来自同事「阿克索配置助手 v2.1.0」评审的 D1。与状态轮盘同一套外壳：
 * background 对当前活动标签页 `executeScript` 注入；再次注入 = 关闭（幂等开关）。
 *
 * 交互：悬停预演「将打开「名称」」→ 点击后**在新标签页打开**（2026-10-20 用户明确要求，
 *       不再覆盖当前页）。`window.open` 带上 opener，新页签由后台收编成同一账号。
 *       数字键 1-9/0 快选；Esc / 点遮罩关闭。
 *
 * 数据：书签清单由 background 统一归一化（`favorites.list`），浮层不自己读 storage；
 *       只有"弹窗被拦"时才把打开动作交给 background 兜底。
 */
import type { FavoriteItem } from '../shared/messages';
import { buildFavoritesWheel } from '../ui/wheel/favorites-core';
import { ACCT_GRID_CSS, OVERLAY_CHROME_CSS } from '../ui/wheel/ring-wheel-style';

const WIN = window as typeof window & {
  __QL_FAV_ACTIVE__?: boolean;
  /** 旧实例的清理函数（不派发事件——那套在账号轮盘上造成了监听器泄漏） */
  __QL_FAV_CLEANUP__?: () => void;
};
const HOST_ID = 'ql-favorites-overlay-host';
/** 打开后让 toast 可见的宽限 */
const CLOSE_GRACE_MS = 700;

if (WIN.__QL_FAV_ACTIVE__) {
  closeExisting();
} else {
  void mount().catch(() => {
    WIN.__QL_FAV_ACTIVE__ = false;
    WIN.__QL_FAV_CLEANUP__ = undefined;
    document.getElementById(HOST_ID)?.remove();
  });
}

function closeExisting(): void {
  try {
    WIN.__QL_FAV_CLEANUP__?.();
  } catch {
    // 旧实例清理失败不阻断新实例
  }
  WIN.__QL_FAV_CLEANUP__ = undefined;
  document.getElementById(HOST_ID)?.remove();
  document.documentElement.style.removeProperty('overflow');
  WIN.__QL_FAV_ACTIVE__ = false;
}

interface AskResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

async function ask<T>(req: unknown): Promise<AskResult<T>> {
  try {
    const res = (await chrome.runtime.sendMessage(req)) as { result?: AskResult<T> } | undefined;
    return res?.result ?? { ok: false, error: '后台无响应' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function mount(): Promise<void> {
  WIN.__QL_FAV_ACTIVE__ = true;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // 两份一起注入：网格本体（与小窗 <link> 的那份是**同源同字节**）+ 浮层外壳
  style.textContent = ACCT_GRID_CSS + OVERLAY_CHROME_CSS;
  shadow.append(style);

  const wheelRoot = document.createElement('div');
  wheelRoot.className = 'wheel-root';
  const hint = document.createElement('div');
  hint.className = 'hint';
  const toast = document.createElement('div');
  toast.className = 'toast';
  shadow.append(wheelRoot, hint, toast);

  let items: FavoriteItem[] = [];
  let busy = false;
  let closed = false;

  function showToast(text: string, kind: 'info' | 'ok' | 'err'): void {
    toast.textContent = text;
    toast.className = `toast show ${kind}`;
  }

  function setHint(baseOrigin: string): void {
    hint.textContent = '';
    const seg = (html: string): void => {
      const span = document.createElement('span');
      span.innerHTML = html;
      hint.append(span);
    };
    seg('<kbd>1-9</kbd> 快速打开');
    if (baseOrigin) {
      hint.append(document.createElement('i'));
      const span = document.createElement('span');
      span.textContent = `基准：${baseOrigin}`;
      hint.append(span);
    }
    hint.append(document.createElement('i'));
    seg('<kbd>Esc</kbd> 关闭');
  }

  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.removeProperty('overflow');
    host.classList.remove('show');
    WIN.__QL_FAV_ACTIVE__ = false;
    WIN.__QL_FAV_CLEANUP__ = undefined;
    window.setTimeout(() => host.remove(), 220);
  }
  WIN.__QL_FAV_CLEANUP__ = close;

  /**
   * ★★★ 2026-10-20（用户要求变更）：
   * **常用页面一律在新页签打开，不覆盖原页面。**
   *
   * 新页签用 `window.open(...)` 而不是 `chrome.tabs.create`：
   * 前者会带上 `openerTabId`，后台 `parallelSession.adoptFromOpener` 会把新页签
   * 收编成来源页签的账号 —— 这是平台自己 `window.open` / `target=_blank`
   * 已有的继承链路。
   *
   * ★ 必须在**用户手势的同步路径里**调用 `window.open`，晚一步就会被弹窗拦截。
   *   需要异步解析地址时，先同步开 `about:blank`，解析完再 `location.replace`。
   */
  function absoluteTarget(path: string, baseOrigin: string): string | null {
    const raw = path.trim();
    if (!raw) {
      return null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
      try {
        return new URL(raw).href;
      } catch {
        return null;
      }
    }
    return baseOrigin ? baseOrigin + (raw.startsWith('/') ? raw : `/${raw}`) : null;
  }

  /**
   * 平台自己的菜单链接里通常带着完整 query（`?bid=…`）。
   * 只返回**带 query** 的同 pathname 链接 —— 没有 query 的直接用书签路径即可，
   * 剩下的交给 `favorites.resolve` 去平台菜单接口里找完整地址。
   */
  function findMenuHref(path: string): string {
    let want = '';
    try {
      want = new URL(path, location.origin).pathname.replace(/\/+$/, '');
    } catch {
      return '';
    }
    for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
      try {
        const u = new URL(a.href, location.href);
        if (u.origin !== location.origin) {
          continue;
        }
        if (u.pathname.replace(/\/+$/, '') !== want) {
          continue;
        }
        if (u.search) {
          return u.href;
        }
      } catch {
        // 忽略坏链接
      }
    }
    return '';
  }

  async function open(item: FavoriteItem): Promise<void> {
    if (busy || closed) {
      return;
    }
    busy = true;
    showToast(`正在打开「${item.name}」…`, 'info');
    const baseOrigin = /^https?:$/.test(location.protocol) ? location.origin : '';
    const target = absoluteTarget(item.path, baseOrigin);
    if (!target) {
      showToast('打开失败：书签路径无效', 'err');
      busy = false;
      return;
    }
    let targetUrl: URL;
    try {
      targetUrl = new URL(target);
    } catch {
      showToast('打开失败：书签路径无效', 'err');
      busy = false;
      return;
    }

    /** 弹窗被拦 / 页内无法打开：交给 background 开新页签（原函数已是"只开新页签"） */
    const fallback = async (): Promise<void> => {
      const r = await ask<{ url: string }>({ kind: 'favorites.open', path: item.path, baseOrigin });
      if (closed) {
        return;
      }
      if (r.ok) {
        showToast(`已在新标签页打开「${item.name}」`, 'ok');
        window.setTimeout(() => close(), CLOSE_GRACE_MS);
        return;
      }
      showToast(`打开失败：${r.error ?? '未知错误'}`, 'err');
      busy = false;
    };

    // ① 跨站书签：普通新页签（不把账号上下文套到别的站点）
    // ② 书签本身带 query：已经是完整地址，直接开
    // ③ 当前页面已有带 query 的平台菜单链接：用它的完整地址
    const direct = targetUrl.origin !== location.origin
      ? target
      : targetUrl.search
        ? target
        : findMenuHref(item.path);
    if (direct) {
      if (window.open(direct, '_blank')) {
        close();
        return;
      }
      await fallback();
      return;
    }

    /* ④ 只有路径、页面上也没有完整菜单链接：
     *    先同步开一个空白页签（保住用户手势），再让 background 去平台菜单接口
     *    解析带 `?bid=…` 的完整地址，最后把空白页签导航过去。
     *    ★ 空白页签的 opener 是当前账号页签 ⇒ 导航后由 `adoptFromOpener` 收编。 */
    const popup = window.open('about:blank', '_blank');
    if (!popup) {
      await fallback();
      return;
    }
    showToast(`正在新标签页打开「${item.name}」…`, 'info');
    let resolved = target;
    try {
      const r = await ask<{ url: string }>({ kind: 'favorites.resolve', path: item.path });
      if (r.ok && r.data?.url) {
        resolved = r.data.url;
      }
    } catch {
      // 解析失败：用书签原地址
    }
    try {
      popup.location.replace(resolved);
    } catch {
      // 空白页签被用户关闭 / 跨进程限制：退回 background 的普通新页签
      await fallback();
      return;
    }
    close();
  }

  function onKeyDown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }
    if (!/^[0-9]$/.test(e.key)) {
      return;
    }
    const idx = e.key === '0' ? 9 : Number(e.key) - 1;
    const item = items[idx];
    if (item) {
      e.preventDefault();
      e.stopPropagation();
      void open(item);
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  host.addEventListener('click', (e) => {
    if (e.target === host) {
      close();
    }
  });
  document.documentElement.style.setProperty('overflow', 'hidden');
  (document.body ?? document.documentElement).append(host);
  requestAnimationFrame(() => {
    host.classList.add('show');
    requestAnimationFrame(() => wheelRoot.classList.add('in'));
  });

  /* ---------- 数据加载 ---------- */
  const baseOrigin = /^https?:$/.test(location.protocol) ? location.origin : '';
  setHint(baseOrigin);

  const res = await ask<FavoriteItem[]>({ kind: 'favorites.list' });
  if (closed) {
    return;
  }
  if (!res.ok || !res.data) {
    items = [];
    buildFavoritesWheel(wheelRoot, {
      favorites: [],
      baseOrigin,
      disabledReason: res.error ?? '读取书签失败',
      onPick: () => undefined,
    });
    return;
  }
  items = res.data;
  buildFavoritesWheel(wheelRoot, {
    favorites: items,
    baseOrigin,
    ...(items.some((f) => !/^[a-z][a-z0-9+.-]*:\/\//i.test(f.path)) && !baseOrigin
      ? { disabledReason: '相对路径书签需要一个基准域名，请先打开一个平台页面' }
      : {}),
    onPick: (item) => void open(item),
  });
}
