/**
 * Wheel Overlay —— 快捷键选择器的「页面内浮层」主机制（v4.1：**网格平铺**，此前是环形扇区）。
 * background 对当前 https 标签页 executeScript 注入本脚本；再次注入 = 关闭（幂等开关）。
 * Shadow DOM 完全隔离宿主页样式；打开期间锁滚动、聚焦遮罩，数字键不干扰页面输入。
 * 视觉：盒子一页的**网格**（无边框卡片，账号色竖条 + 运行态文字），
 * 标题栏显示盒子名与计数，左右箭头 / 页码点 / 滚轮切盒；**账号不再被截断**（超出滚动）。
 * 交互：悬停高亮 → 点击切换；Esc / 再次快捷键 / 点击遮罩关闭。无任何窗口控制元素。
 */
import { LOCAL_KEYS } from '../shared/constants';
import { DEFAULT_BOX, groupPagesByBox, type WheelAccount } from '../ui/wheel/wheel-core';
import { buildAccountGrid } from '../ui/wheel/grid-core';
import { ACCT_GRID_CSS, OVERLAY_CHROME_CSS } from '../ui/wheel/ring-wheel-style';

const WIN = window as typeof window & { __QL_WHEEL_ACTIVE__?: boolean };
const PARALLEL_PAGE = chrome.runtime.getURL('ui/parallel/parallel.html');

/* 再次注入 = 关闭 */
if (WIN.__QL_WHEEL_ACTIVE__) {
  closeExisting();
} else {
  void mount();
}

function closeExisting(): void {
  const prev = document.getElementById('ql-wheel-overlay-host') as HTMLDivElement | null;
  if (prev) {
    prev.dataset.forceClose = '1';
    prev.dispatchEvent(new CustomEvent('ql-wheel-close'));
    prev.remove();
  }
  document.documentElement.style.removeProperty('overflow');
  WIN.__QL_WHEEL_ACTIVE__ = false;
}

async function fetchAccounts(): Promise<WheelAccount[]> {
  const res = (await chrome.runtime.sendMessage({ kind: 'par.list' })) as
    | { kind: 'par.list'; result: { ok: boolean; data?: WheelAccount[] } }
    | undefined;
  return res?.result?.ok && Array.isArray(res.result.data) ? res.result.data : [];
}

/** 轮盘分页 = 账号归属盒子 + 管理页记忆的空盒子（修复「新建空盒子切换不到」） */
async function fetchPages(): Promise<{ label: string; accounts: WheelAccount[] }[]> {
  const [accounts, remembered, defaultBoxStore, disabledStore] = await Promise.all([
    fetchAccounts(),
    chrome.storage.local
      .get(LOCAL_KEYS.boxList)
      .then((s) => (s[LOCAL_KEYS.boxList] as string[] | undefined) ?? [])
      .catch(() => [] as string[]),
    chrome.storage.local
      .get(LOCAL_KEYS.defaultBox)
      .then((s) => (s[LOCAL_KEYS.defaultBox] as string | undefined)?.trim() ?? '')
      .catch(() => ''),
    chrome.storage.local
      .get(LOCAL_KEYS.disabledBoxes)
      .then((s) => (s[LOCAL_KEYS.disabledBoxes] as string[] | undefined) ?? [])
      .catch(() => [] as string[]),
  ]);
  const disabled = new Set(disabledStore);
  // 禁用盒不进轮盘（即使盒内有账号）；空默认盒自动禁用（groupPagesByBox 只为有未归盒账号的默认盒出页）
  const pages = groupPagesByBox(accounts, defaultBoxStore || DEFAULT_BOX).filter((p) => !disabled.has(p.label));
  const seen = new Set(pages.map((p) => p.label));
  for (const name of remembered) {
    if (!seen.has(name) && name !== defaultBoxStore && !disabled.has(name)) {
      pages.push({ label: name, accounts: [] });
    }
  }
  return pages;
}

async function mount(): Promise<void> {
  let pages = await fetchPages();
  let pageIndex = 0;

  /* ---------- 宿主节点与 Shadow 根 ---------- */
  const host = document.createElement('div');
  host.id = 'ql-wheel-overlay-host';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  // ★★ v4.1.2：不再内联整段样式 —— 改用 `grid-style.ts` 的**共用常量**。
  //   此前本文件把浮层外壳 + 环形扇区样式整段抄了一遍，与 `status-overlay` /
  //   `favorites-overlay` 三份并存 ⇒ 改一处必漂（规则 12 的同类风险）。
  //   现在三个浮层共用 `ACCT_GRID_CSS + OVERLAY_CHROME_CSS`，
  //   网格本体还与**小窗** `acct-grid.css` 同源同字节（构建时从同一文件生成）。
  style.textContent = ACCT_GRID_CSS + OVERLAY_CHROME_CSS;
  shadow.append(style);

  const wheelRoot = document.createElement('div');
  wheelRoot.className = 'wheel-root';

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML =
    '<span><kbd>1-9</kbd> 快速选择</span><i></i><span>滚轮 / ← → / 点页码切盒</span><i></i><span><kbd>Esc</kbd> 关闭</span>';

  shadow.append(wheelRoot, hint);

  let closed = false;
  const refreshTimer = window.setInterval(() => void refresh(), 3000);
  function close(): void {
    if (closed) {
      return;
    }
    closed = true;
    window.clearInterval(refreshTimer);
    document.removeEventListener('keydown', onKeyDown, true);
    document.documentElement.style.removeProperty('overflow');
    host.classList.remove('show');
    WIN.__QL_WHEEL_ACTIVE__ = false;
    window.setTimeout(() => host.remove(), 220);
  }

  function onKeyDown(e: KeyboardEvent): void {
    // 遮罩期间输入框仍可能持有焦点：不劫持编辑键
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
    const page = pages[pageIndex];
    if (!page) {
      return;
    }
    const idx = Number(e.key) === 0 ? 9 : Number(e.key) - 1;
    if (!Number.isNaN(idx) && idx >= 0 && idx < 10 && idx < page.accounts.length) {
      void pick(page.accounts[idx].id);
    }
  }

  async function pick(accountId: string): Promise<void> {
    close();
    try {
      await chrome.runtime.sendMessage({ kind: 'par.open', id: accountId });
    } catch {
      // 忽略
    }
  }

  function render(): void {
    buildAccountGrid(wheelRoot, {
      pages,
      pageIndex,
      onPage: (delta) => {
        if (!pages.length) {
          return;
        }
        pageIndex = (pageIndex + delta + pages.length) % pages.length;
        render();
        requestAnimationFrame(() => requestAnimationFrame(() => wheelRoot.classList.add('in')));
      },
      onPick: (id) => void pick(id),
      emptyAction: {
        label: '去并行管理页添加',
        run: () => {
          close();
          void chrome.tabs.create({ url: PARALLEL_PAGE });
        },
      },
    });
    requestAnimationFrame(() => requestAnimationFrame(() => wheelRoot.classList.add('in')));
  }

  /* ---------- 盒子/账号/禁用名单变化联动：3s 轮询（指纹未变不重绘） ---------- */
  let lastFingerprint = JSON.stringify(pages.map((p) => [p.label, p.accounts.map((a) => a.id)]));
  const refresh = async (): Promise<void> => {
    try {
      const grouped = await fetchPages();
      const fp = JSON.stringify(grouped.map((p) => [p.label, p.accounts.map((a) => a.id)]));
      if (fp === lastFingerprint) {
        return;
      }
      lastFingerprint = fp;
      pages = grouped;
      if (pageIndex >= pages.length) {
        pageIndex = Math.max(0, pages.length - 1);
      }
      render();
    } catch {
      // 轮询失败静默，下个周期重试
    }
  };
  window.setInterval(() => void refresh(), 3000);

  /* ---------- 挂载 & 入场 ---------- */
  document.addEventListener('keydown', onKeyDown, true);
  document.documentElement.style.setProperty('overflow', 'hidden');
  document.documentElement.append(host);
  WIN.__QL_WHEEL_ACTIVE__ = true;
  render();
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      host.classList.add('show');
    }),
  );
}
