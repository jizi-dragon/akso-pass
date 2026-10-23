/**
 * Status Overlay —— 实例状态轮盘的「页面内浮层」主机制（v3.15，快捷键 Alt+W）。
 *
 * background 对当前活动标签页 `executeScript` 注入本脚本；再次注入 = 关闭（幂等开关）。
 * Shadow DOM 完全隔离宿主页样式；打开期间锁滚动；数字键在输入框聚焦时不劫持。
 * 外壳样式与书签轮盘共用（`ring-wheel-style.ts`），不再各写一份。
 *
 * ## 交互约定（v3.15 定稿）
 *  - **点即执行**：不弹二次确认，但悬停时 Hub 会预演「将把「当前」改为「X」」，改完 toast 回显；
 *  - 成功 → 由 background 延时刷新该页签（页面需要重载才能反映新状态）；
 *  - 失败 → toast 红字并**保持浮层打开**，用户可以改选另一个状态重试。
 *
 * ## 数据来源
 * 全部经 background 转发，且 background 只认 `sender.tab.id`（不接收页面自报的 tabId）——
 * 平台请求在**该页签的页面主世界**发出，从而拿到 DNR 的按账号改头与 `_qlck` 缓存分区。
 */
import type { StatusContext, StatusList } from '../shared/messages';
import { ACCT_GRID_CSS, OVERLAY_CHROME_CSS } from '../ui/wheel/ring-wheel-style';
import { buildStatusWheel, type StatusWheelItem } from '../ui/wheel/status-core';

const WIN = window as typeof window & {
  __QL_STATUS_ACTIVE__?: boolean;
  /**
   * 上一个实例的清理函数。**故意不用「派发自定义事件」那套**：
   * 账号轮盘的 closeExisting 派发 `ql-wheel-close` 但全仓库没有监听者，
   * 结果旧实例的 document keydown 与 3s 轮询永久驻留（评审 §四·4 记录的坑）。
   * 这里把 close 直接挂在 window 上，新实例注入时一定能调到。
   */
  __QL_STATUS_CLEANUP__?: () => void;
};
const HOST_ID = 'ql-status-overlay-host';

/** 切换成功后等页面刷新的宽限（只留 toast 一闪，不再让用户干等 1.2s） */
const RELOAD_GRACE_MS = 300;

if (WIN.__QL_STATUS_ACTIVE__) {
  closeExisting();
} else {
  void mount().catch(() => {
    // 挂载失败（宿主页 DOM 异常等，极罕见）→ 复位开关，
    // 否则下一次快捷键只会走「关闭」分支，浮层再也打不开
    WIN.__QL_STATUS_ACTIVE__ = false;
    WIN.__QL_STATUS_CLEANUP__ = undefined;
    document.getElementById(HOST_ID)?.remove();
  });
}

function closeExisting(): void {
  try {
    WIN.__QL_STATUS_CLEANUP__?.();
  } catch {
    // 旧实例清理失败不阻断新实例
  }
  WIN.__QL_STATUS_CLEANUP__ = undefined;
  document.getElementById(HOST_ID)?.remove();
  document.documentElement.style.removeProperty('overflow');
  WIN.__QL_STATUS_ACTIVE__ = false;
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
  WIN.__QL_STATUS_ACTIVE__ = true;

  /* ---------- 宿主节点与 Shadow 根 ---------- */
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

  let items: StatusWheelItem[] = [];
  let busy = false;
  let closed = false;

  function showToast(text: string, kind: 'info' | 'ok' | 'err'): void {
    toast.textContent = text;
    toast.className = `toast show ${kind}`;
  }

  function setHint(currentName: string): void {
    hint.textContent = '';
    const seg = (html: string): void => {
      const span = document.createElement('span');
      span.innerHTML = html;
      hint.append(span);
    };
    const dot = (): void => hint.append(document.createElement('i'));
    seg('<kbd>1-9</kbd> 快速切换');
    if (currentName) {
      dot();
      seg('当前：<b></b>');
      const b = hint.querySelector('b');
      if (b) {
        b.textContent = currentName;
      }
    }
    dot();
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
    WIN.__QL_STATUS_ACTIVE__ = false;
    WIN.__QL_STATUS_CLEANUP__ = undefined;
    window.setTimeout(() => host.remove(), 220);
  }
  // 让「再次按快捷键」注入的新实例能立刻把本实例的监听器摘掉
  WIN.__QL_STATUS_CLEANUP__ = close;

  function renderEmpty(instanceLabel: string, reason: string): void {
    items = [];
    buildStatusWheel(wheelRoot, {
      statuses: [],
      instanceLabel,
      lifecycleName: '',
      disabledReason: reason,
      onPick: () => undefined,
    });
  }

  function renderWheel(list: StatusList, label: string): void {
    items = list.statuses.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      isCurrent: Boolean(list.currentName) && s.name === list.currentName,
    }));
    buildStatusWheel(wheelRoot, {
      statuses: items,
      instanceLabel: label,
      lifecycleName: list.lifecycleName,
      onPick: (item) => void pick(item),
    });
    setHint(list.currentName);
  }

  async function pick(item: StatusWheelItem): Promise<void> {
    if (busy || closed || !item.code) {
      return;
    }
    busy = true;
    showToast(`正在切换为「${item.name}」…`, 'info');
    const r = await ask<{ name: string }>({ kind: 'status.change', code: item.code, name: item.name });
    if (closed) {
      return;
    }
    if (r.ok) {
      // background 会在宽限期后刷新本页签；这里只负责把结果说清楚
      showToast(`已切换为「${item.name}」，正在刷新页面…`, 'ok');
      window.setTimeout(() => close(), RELOAD_GRACE_MS);
      return;
    }
    showToast(`切换失败：${r.error ?? '未知错误'}`, 'err');
    busy = false;
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
    // ★ 只认数字键（账号轮盘用 Number(e.key) 判等，空格也会被当成 0 —— 这里不重蹈）
    if (!/^[0-9]$/.test(e.key)) {
      return;
    }
    const idx = e.key === '0' ? 9 : Number(e.key) - 1;
    const item = items[idx];
    if (item) {
      e.preventDefault();
      e.stopPropagation();
      void pick(item);
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
  const pageLabel = document.title || location.hostname;
  renderEmpty(pageLabel, '正在读取状态…');

  const ctxRes = await ask<StatusContext>({ kind: 'status.context' });
  if (closed) {
    return;
  }
  if (!ctxRes.ok || !ctxRes.data) {
    renderEmpty(pageLabel, ctxRes.error ?? '无法读取当前页面信息');
    setHint('');
    return;
  }
  const ctx = ctxRes.data;
  if (!ctx.operable) {
    renderEmpty(pageLabel, ctx.reason || '当前页面不是对象实例页');
    setHint('');
    return;
  }

  const listRes = await ask<StatusList>({ kind: 'status.load' });
  if (closed) {
    return;
  }
  if (!listRes.ok || !listRes.data) {
    renderEmpty(pageLabel, listRes.error ?? '读取状态列表失败');
    setHint('');
    return;
  }
  renderWheel(listRes.data, pageLabel);
}
