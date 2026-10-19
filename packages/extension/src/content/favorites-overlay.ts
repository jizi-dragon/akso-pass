/**
 * Favorites Overlay —— 常用页面书签轮盘的「页面内浮层」（v3.16，快捷键 Alt+1）。
 *
 * 需求来自同事「阿克索配置助手 v2.1.0」评审的 D1。与状态轮盘同一套外壳：
 * background 对当前活动标签页 `executeScript` 注入；再次注入 = 关闭（幂等开关）。
 *
 * 交互：悬停预演「将打开「名称」」→ 点击后由 background 导航；
 *       若当前页已绑定账号且同源，则在**当前页签内跳转**（只是路由变化），
 *       否则新开页签。数字键 1-9/0 快选；Esc / 点遮罩关闭。
 *
 * 数据：书签清单由 background 统一归一化（`favorites.list`），浮层不自己读 storage；
 *       打开动作也走 background（内容脚本拿不到 `chrome.tabs`，这是同事实现里踩过的坑）。
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

  async function open(item: FavoriteItem): Promise<void> {
    if (busy || closed) {
      return;
    }
    busy = true;
    showToast(`正在打开「${item.name}」…`, 'info');
    // 基准域名：优先当前页 origin（书签里的相对路径就拼在它上面）
    const baseOrigin = /^https?:$/.test(location.protocol) ? location.origin : '';
    const r = await ask<{ url: string }>({ kind: 'favorites.open', path: item.path, baseOrigin });
    if (closed) {
      return;
    }
    if (r.ok) {
      showToast(`已打开「${item.name}」`, 'ok');
      window.setTimeout(() => close(), CLOSE_GRACE_MS);
      return;
    }
    showToast(`打开失败：${r.error ?? '未知错误'}`, 'err');
    busy = false;
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
