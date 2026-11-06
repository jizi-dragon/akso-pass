/**
 * 调试跳转浮层（v4.2.45，Alt+2；v4.2.46 统一视觉）。
 *
 * background 对当前标签页 `executeScript` 注入本脚本；再次注入 = 关闭（幂等开关）。
 *
 * 三个按钮的目标地址**全部由 background 拼**（origin 取目标页签 URL），本脚本只负责
 * 展示与把点击转回 background —— 页面即使被 XSS，也改不了按钮指向哪里。
 *
 * ## 候选矩阵，不是固定三格（v4.2.47，用户反馈"未来还要加页面"）
 *
 * 网格内容由 `DebugLinks.targets` 驱动：数组有几条就渲染几格，3 列自动换行、
 * 超出高度可滚动（`ACCT_GRID_CSS` 的 `.ag-grid` 本来就带 `max-height + overflow-y`）。
 * **要加新的可跳转页面，只改 `shared/deeplinks.ts` 的 `buildDebugTargets`**，
 * 本文件不需要认识任何具体页面。
 *
 * ## 视觉与另外三个轮盘一致（v4.2.46，用户反馈"风格不一致"）
 *
 * 复用 `ACCT_GRID_CSS` 的同一套骨架：`.ag-head`（标题 + meta）、`.ag-cell`
 * （左侧色条 + 名称 + 说明）、`.ag-foot`、以及 `OVERLAY_CHROME_CSS` 的 `.hint` 药丸。
 * 不再自己画一张"对话框卡片"（kicker / 右上角 × / 大按钮列表）——那套视觉只此一家，
 * 和账号、状态、常用页面三个浮层放在一起明显不是同一个产品。
 *
 * 关闭方式也与它们一致：Esc（任意焦点）+ 点击遮罩空白处；不再提供 × 按钮。
 */
import type { DebugLinks, Result } from '../shared/messages';
import { ACCT_GRID_CSS, OVERLAY_CHROME_CSS } from '../ui/wheel/ring-wheel-style';

const WIN = window as typeof window & {
  __QL_DEBUG_ACTIVE__?: boolean;
  __QL_DEBUG_CLEANUP__?: () => void;
};
const HOST_ID = 'ql-debug-overlay-host';

const DEBUG_CSS = `
.dbg-root{width:min(92vw,560px)}
/* 3 列候选矩阵：行数由 targets 数量决定，多了换行、超出 66vh 滚动 */
.dbg-grid{grid-auto-rows:86px;grid-auto-flow:row}
.dbg-cell{align-items:flex-start;justify-content:center}
.dbg-sub{
  font-size:var(--fs-11,11px);line-height:1.35;color:#8494b4;white-space:normal;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
}
.dbg-meta{min-width:0;flex:0 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dbg-copies{display:flex;align-items:center;gap:var(--sp-2,8px);min-width:0}
.dbg-copy{
  border:0;background:transparent;color:#66759b;font:inherit;font-size:var(--fs-11,11px);
  cursor:pointer;padding:var(--sp-hair,1px) var(--sp-2,8px);border-radius:var(--sb-radius-sm,8px);
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
  root.innerHTML = `
    <div class="ag-wrap">
      <div class="ag-head">
        <div class="ag-title">
          <span class="ag-box" data-el="title">调试跳转</span>
          <span class="ag-meta dbg-meta" data-el="meta"></span>
        </div>
      </div>
      <div class="ag-grid dbg-grid" data-el="grid" style="--ag-cols:3"></div>
      <div class="ag-foot">
        <div class="dbg-copies">
          <button class="dbg-copy" data-copy="object" type="button" disabled>复制 objectId</button>
          <button class="dbg-copy" data-copy="lifecycle" type="button" disabled>复制 lifecycleId</button>
        </div>
        <span class="ag-tip dbg-msg" data-el="msg">正在解析…</span>
      </div>
    </div>`;
  shadow.append(root);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = '<b>调试跳转</b><i></i><span>已登录平台即可使用</span><i></i><span><kbd>Esc</kbd> 关闭</span>';
  shadow.append(hint);

  document.documentElement.append(host);
  // ★ 共用网格样式里有 `.wheel-root:not(.in){opacity:.35}` —— 不加 `in` 整个浮层是半透明的
  //   （截图时才会发现：浏览器里看着"能读"，但对比度已经掉了）。
  requestAnimationFrame(() => {
    host.classList.add('show');
    root.classList.add('in');
  });

  const $ = <T extends Element>(sel: string): T => {
    const el = shadow.querySelector(sel);
    if (!el) {
      throw new Error(`调试浮层缺少节点：${sel}`);
    }
    return el as T;
  };

  const wrapEl = $<HTMLElement>('.ag-wrap');
  const titleEl = $<HTMLElement>('[data-el="title"]');
  const metaEl = $<HTMLElement>('[data-el="meta"]');
  const msgEl = $<HTMLElement>('[data-el="msg"]');
  const gridEl = $<HTMLElement>('[data-el="grid"]');
  const copyBtns = Array.from(shadow.querySelectorAll<HTMLButtonElement>('[data-copy]'));

  let links: DebugLinks | null = null;
  let closing = false;

  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';

  const setMsg = (text: string, kind: 'ok' | 'bad' | '' = ''): void => {
    msgEl.textContent = text;
    msgEl.className = `ag-tip dbg-msg${kind ? ` ${kind}` : ''}`;
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
    if (e.key !== 'Escape') {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  document.addEventListener('keydown', onKey, true);
  // 与三个轮盘一致：点遮罩空白处关闭（点卡片内部不关）
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

  const render = (data: DebugLinks): void => {
    links = data;
    titleEl.textContent = data.object.name || data.object.code || data.object.id;
    metaEl.textContent = [data.object.code, data.lifecycle ? `生命周期：${data.lifecycle.name || data.lifecycle.id}` : '未启用生命周期']
      .filter(Boolean)
      .join(' · ');

    // ★ 候选由 background 给（v4.2.47）：数组有几条就渲染几格，多了自动换行。
    //   这里**不认识任何具体页面**，加新跳转只改 shared/deeplinks.ts。
    gridEl.textContent = '';
    for (const target of data.targets) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'ag-cell dbg-cell';
      cell.style.setProperty('--acct', target.accent);
      cell.dataset.kind = target.kind;

      const name = document.createElement('span');
      name.className = 'ag-name';
      name.textContent = target.title;
      const sub = document.createElement('span');
      sub.className = 'dbg-sub';
      sub.textContent = target.subtitle;
      cell.append(name, sub);

      if (!target.href) {
        cell.disabled = true;
        cell.classList.add('ag-cell-disabled');
        cell.title = target.disabledReason ?? '暂不可跳转';
      } else {
        cell.addEventListener('click', () => void openTarget(target.href));
      }
      gridEl.append(cell);
    }

    copyBtns[0].disabled = !data.object.id;
    copyBtns[1].disabled = !data.lifecycle?.id;
    setMsg('');
  };

  /** 与另外三个浮层同样的空态：`.ag-empty` 两行文案，而不是自定义错误框 */
  const fail = (message: string): void => {
    links = null;
    wrapEl.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'ag-empty';
    const t = document.createElement('div');
    t.className = 'ag-empty-t';
    t.textContent = '无法定位当前对象';
    const s = document.createElement('div');
    s.className = 'ag-empty-s';
    s.textContent = message;
    empty.append(t, s);
    wrapEl.append(empty);
  };

  copyBtns[0].addEventListener('click', () => void copyText(links?.object.id));
  copyBtns[1].addEventListener('click', () => void copyText(links?.lifecycle?.id));

  try {
    const res = (await Promise.race([
      chrome.runtime.sendMessage({ kind: 'debug.resolve' }) as Promise<{ result?: Result<DebugLinks> } | undefined>,
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 8000)),
    ])) as { result?: Result<DebugLinks> } | undefined;
    if (!res) {
      fail('后台没有响应（8 秒超时）');
      return;
    }
    const r = res.result;
    if (!r?.ok) {
      fail(r?.error ?? '解析失败');
      return;
    }
    render(r.data);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
