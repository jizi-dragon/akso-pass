/**
 * 调试跳转浮层（v4.2.45，Alt+2；v4.2.46 统一视觉；v4.2.48 改用共用网格内核）。
 *
 * background 对当前标签页 `executeScript` 注入本脚本；再次注入 = 关闭（幂等开关）。
 *
 * 目标地址**全部由 background 拼**（origin 取目标页签 URL），本脚本只负责展示、
 * 以及把点击转回 background —— 页面即使被 XSS，也改不了按钮指向哪里。
 *
 * ## 与另外三个浮层同一条渲染口径（v4.2.48，用户质疑「没有统一弹出窗口径」）
 *
 * 不再自己拼 head / grid / foot：直接调 `buildItemGrid`（`ui/wheel/item-grid.ts`），
 * 与账号（Alt+Q）、生命周期（Alt+W）、常用页面（Alt+1）**同一套 5 列 × 4 行定尺网格**：
 * 页码点、左右箭头、滚轮翻页、不足 20 格补虚线占位、空态、页脚提示都来自同一个内核。
 *
 * 本文件只做两件事：
 * 1. 把 `DebugLinks.targets` 映射成 `GridItem[]`（数组有几条就渲染几格）；
 * 2. 给页脚左侧塞「复制 objectId / lifecycleId」——通过内核的 `footStart` 槽位。
 *
 * **要加新的可跳转页面，只改 `shared/deeplinks.ts` 的 `buildDebugTargets`**，
 * 本文件不需要认识任何具体页面。
 */
import type { DebugLinks, Result } from '../shared/messages';
import { buildItemGrid, GRID_SLOTS, type GridItem } from '../ui/wheel/item-grid';
import { ACCT_GRID_CSS, OVERLAY_CHROME_CSS } from '../ui/wheel/ring-wheel-style';

const WIN = window as typeof window & {
  __QL_DEBUG_ACTIVE__?: boolean;
  __QL_DEBUG_CLEANUP__?: () => void;
};
const HOST_ID = 'ql-debug-overlay-host';

/** 一页容量直接复用内核常量（5 × 4 = 20），避免两处数字各写一遍后漂移 */
const PER_PAGE = GRID_SLOTS;

const DEBUG_CSS = `
.dbg-root{width:min(92vw,720px)}
.dbg-copies{display:flex;align-items:center;gap:var(--sp-2,8px);min-width:0;overflow:hidden}
.dbg-copy{
  border:0;background:transparent;color:#66759b;font:inherit;font-size:var(--fs-11,11px);
  cursor:pointer;padding:var(--sp-hair,1px) var(--sp-2,8px);border-radius:var(--sb-radius-sm,8px);
  white-space:nowrap;
}
.dbg-copy:hover{background:#f2f6ff;color:var(--acc,#1e6fff)}
.dbg-copy:disabled{opacity:.45;cursor:default;background:transparent;color:#66759b}
.dbg-msg{
  min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right;
}
.dbg-msg.bad{color:#dc2626}
.dbg-msg.ok{color:#16a34a}
`;

if (WIN.__QL_DEBUG_ACTIVE__) {
  closeExisting();
} else {
  void mount().catch(() => {
    WIN.__QL_DEBUG_ACTIVE__ = false;
    WIN.__QL_DEBUG_CLEANUP__ = undefined;
    document.getElementById(HOST_ID)?.remove();
  });
}

function closeExisting(): void {
  try {
    WIN.__QL_DEBUG_CLEANUP__?.();
  } catch {
    // 清理失败不阻断新实例
  }
  WIN.__QL_DEBUG_CLEANUP__ = undefined;
  document.getElementById(HOST_ID)?.remove();
  WIN.__QL_DEBUG_ACTIVE__ = false;
}

async function mount(): Promise<void> {
  WIN.__QL_DEBUG_ACTIVE__ = true;

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = ACCT_GRID_CSS + OVERLAY_CHROME_CSS + DEBUG_CSS;
  shadow.append(style);

  const root = document.createElement('div');
  root.className = 'wheel-root acct-grid dbg-root';

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML =
    '<b>调试跳转</b><i></i><span data-el="hint-text">正在解析…</span><i></i><span><kbd>Esc</kbd> 关闭</span>';
  shadow.append(root, hint);
  document.documentElement.append(host);

  const hintText = hint.querySelector('[data-el="hint-text"]') as HTMLElement | null;

  /* 页脚左侧：复制按钮 + 消息。节点跨页复用，每次 draw 由内核重新挂到 ag-foot。 */
  const foot = document.createElement('div');
  foot.className = 'dbg-copies';
  const copyObj = makeCopyButton('复制 objectId');
  const copyLife = makeCopyButton('复制 lifecycleId');
  const msg = document.createElement('span');
  msg.className = 'dbg-msg';
  foot.append(copyObj, copyLife, msg);

  let links: DebugLinks | null = null;
  let page = 0;
  let failText = '';
  let closing = false;

  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';

  const setMsg = (text: string, kind: 'ok' | 'bad' | '' = ''): void => {
    msg.textContent = text;
    msg.className = `dbg-msg${kind ? ` ${kind}` : ''}`;
  };

  const close = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    document.removeEventListener('keydown', onKey, true);
    document.documentElement.style.overflow = prevOverflow;
    host.remove();
    WIN.__QL_DEBUG_ACTIVE__ = false;
    WIN.__QL_DEBUG_CLEANUP__ = undefined;
  };
  WIN.__QL_DEBUG_CLEANUP__ = close;

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const pages = links ? Math.max(1, Math.ceil(links.targets.length / PER_PAGE)) : 1;
      if (pages <= 1) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      page += e.key === 'ArrowRight' ? 1 : -1;
      draw();
      return;
    }
    if (e.key !== 'Escape') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  document.addEventListener('keydown', onKey, true);

  // 与三个轮盘一致：点遮罩空白处关闭（点面板内部不关）
  host.addEventListener('click', (e) => {
    if (e.target === host) {
      close();
    }
  });

  const openTarget = async (url: string | null): Promise<void> => {
    if (!url) {
      setMsg('该对象没有可跳转的目标', 'bad');
      return;
    }
    try {
      const res = (await chrome.runtime.sendMessage({ kind: 'debug.open', url })) as
        | { result?: Result<null> }
        | undefined;
      const r = res?.result;
      if (!r?.ok) {
        setMsg(r?.error ?? '打开失败', 'bad');
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e), 'bad');
    }
  };

  const copyText = async (text: string | undefined): Promise<void> => {
    if (!text) {
      setMsg('没有可复制的 id', 'bad');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setMsg('已复制', 'ok');
    } catch {
      setMsg('复制失败（浏览器拒绝剪贴板）', 'bad');
    }
  };

  /** 唯一绘制入口：候选 → GridItem，几何/分页/滚轮全部交给 buildItemGrid */
  function draw(): void {
    const data = links;
    const pages = data ? Math.max(1, Math.ceil(data.targets.length / PER_PAGE)) : 1;
    page = Math.min(Math.max(page, 0), pages - 1);
    const slice = data ? data.targets.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE) : [];

    const items: GridItem[] = slice.map((target) => ({
      key: target.kind,
      label: target.title,
      sub: target.subtitle,
      accent: target.accent,
      disabled: !target.href,
      title: target.href ? (target.hint ?? `${target.title} — ${target.subtitle}`) : (target.disabledReason ?? target.title),
    }));

    copyObj.disabled = !data?.object.id;
    copyLife.disabled = !data?.lifecycle?.id;

    const grid = buildItemGrid({
      items,
      pageCount: pages,
      pagePos: page,
      title: data ? data.object.name || data.object.code || data.object.id : '调试跳转',
      meta: data
        ? [
            data.object.code,
            data.lifecycle ? `生命周期：${data.lifecycle.name || data.lifecycle.id}` : '未启用生命周期',
            pages > 1 ? `第 ${page + 1}/${pages} 页` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '正在解析…',
      onPage: (delta) => {
        page += delta;
        draw();
      },
      onPick: (kind) => {
        const target = data?.targets.find((t) => t.kind === kind);
        void openTarget(target?.href ?? null);
      },
      empty: data
        ? { line1: '没有可跳转的目标', line2: '当前对象没有可用的管理端入口' }
        : failText
          ? { line1: '无法定位当前对象', line2: failText }
          : { line1: '正在解析当前对象…', line2: '读取页面上下文与菜单权限' },
      tip: pages > 1 ? '点击跳转 · 滚轮 / ← → 翻页' : '点击跳转',
      footStart: foot,
    });

    // 判据与排错都按 kind 定位；内核给的是 data-item-key，这里补一个同名 data-kind
    grid.querySelectorAll<HTMLElement>('.ag-cell').forEach((cell) => {
      cell.classList.add('dbg-cell');
      if (cell.dataset.itemKey) {
        cell.dataset.kind = cell.dataset.itemKey;
      }
    });

    root.textContent = '';
    root.append(grid);
    // ★ 共用样式里有 `.wheel-root:not(.in){opacity:.35}` —— 不加 `in` 整层半透明
    requestAnimationFrame(() => {
      host.classList.add('show');
      root.classList.add('in');
    });
    if (hintText) {
      hintText.textContent = pages > 1 ? '滚轮 / ← → / 点页码翻页' : '点击格子跳转';
    }
  }

  copyObj.addEventListener('click', () => void copyText(links?.object.id));
  copyLife.addEventListener('click', () => void copyText(links?.lifecycle?.id));

  // 先画「正在解析…」的空态，解析完成再换成候选矩阵
  draw();

  try {
    const res = (await Promise.race([
      chrome.runtime.sendMessage({ kind: 'debug.resolve' }) as Promise<
        { result?: Result<DebugLinks> } | undefined
      >,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000)),
    ])) as { result?: Result<DebugLinks> } | undefined;

    if (!res) {
      failText = '后台没有响应（8 秒超时）';
      draw();
      return;
    }
    const r = res.result;
    if (!r?.ok) {
      failText = r?.error ?? '解析失败';
      draw();
      return;
    }
    links = r.data;
    page = 0;
    draw();
    setMsg('');
  } catch (e) {
    failText = e instanceof Error ? e.message : String(e);
    draw();
  }
}

function makeCopyButton(label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dbg-copy';
  btn.textContent = label;
  btn.disabled = true;
  return btn;
}
