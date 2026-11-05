/**
 * 调试跳转浮层（v4.2.45，Alt+2）。
 *
 * background 对当前标签页 `executeScript` 注入本脚本；再次注入 = 关闭（幂等开关）。
 *
 * 三个按钮的目标地址**全部由 background 拼**（origin 取目标页签 URL），本脚本只负责
 * 展示与把点击转回 background —— 页面即使被 XSS，也改不了按钮指向哪里。
 *
 * Esc 在任意焦点下都关闭（与 v4.2.43 的三个轮盘一致，输入框守卫不拦 Esc）。
 */
import type { DebugLinks, Result } from '../shared/messages';
import { OVERLAY_CHROME_CSS } from '../ui/wheel/ring-wheel-style';

const WIN = window as typeof window & {
  __QL_DEBUG_ACTIVE__?: boolean;
  __QL_DEBUG_CLEANUP__?: () => void;
};
const HOST_ID = 'ql-debug-overlay-host';

const DEBUG_CSS = `
.dbg-root{width:min(92vw,460px)}
.dbg-card{
  background:#fff;border:1px solid #e6ecf6;border-radius:var(--sb-radius-lg,16px);
  box-shadow:0 24px 60px rgba(23,42,84,.18);
  padding:var(--sp-5,20px);display:flex;flex-direction:column;gap:var(--sp-3,12px);
}
.dbg-head{display:flex;align-items:flex-start;gap:var(--sp-2,8px)}
.dbg-kicker{font-size:var(--fs-11,11px);letter-spacing:.08em;color:#8494b4;font-weight:600}
.dbg-title{font-size:var(--fs-18,18px);font-weight:700;color:#1b2a4a;margin-top:2px;word-break:break-all}
.dbg-sub{font-size:var(--fs-12,12px);color:#66759b;margin-top:2px;word-break:break-all}
.dbg-x{
  margin-left:auto;flex:none;width:28px;height:28px;border:0;border-radius:var(--sb-radius-sm,8px);
  background:#f3f6fc;color:#5b6b8f;font-size:var(--fs-18,18px);line-height:1;cursor:pointer;
}
.dbg-x:hover{background:#e8eefb;color:#1b2a4a}
.dbg-rows{display:flex;flex-direction:column;gap:var(--sp-2,8px)}
.dbg-row{
  display:grid;grid-template-columns:1fr auto;grid-template-areas:"t a" "s a";
  gap:var(--sp-hair,1px) var(--sp-2,8px);align-items:center;text-align:left;
  padding:var(--sp-3,12px) var(--sp-4,16px);border:1px solid #e6ecf6;border-radius:var(--sb-radius,12px);
  background:#fbfdff;cursor:pointer;font:inherit;
}
.dbg-row:hover{border-color:#1e6fff;background:#f5f9ff}
.dbg-row:disabled{opacity:.55;cursor:not-allowed;border-color:#e6ecf6;background:#fafbfe}
.dbg-row-t{grid-area:t;font-size:var(--fs-15,15px);font-weight:600;color:#1b2a4a}
.dbg-row-s{grid-area:s;font-size:var(--fs-12,12px);color:#7b8aab}
.dbg-arrow{grid-area:a;color:#9fb0cc;font-size:var(--fs-13,13px)}
.dbg-row:not(:disabled):hover .dbg-arrow{color:#1e6fff}
.dbg-foot{display:flex;align-items:center;gap:var(--sp-2,8px);flex-wrap:wrap;margin-top:2px}
.dbg-mini{
  border:1px solid #e6ecf6;background:#fff;border-radius:var(--sb-radius-sm,8px);
  padding:var(--sp-1,4px) var(--sp-2,8px);
  font:inherit;font-size:var(--fs-11,11px);color:#5b6b8f;cursor:pointer;
}
.dbg-mini:hover{border-color:#1e6fff;color:#1e6fff}
.dbg-msg{margin-left:auto;font-size:var(--fs-11,11px);color:#8494b4;min-height:14px}
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
  style.textContent = OVERLAY_CHROME_CSS + DEBUG_CSS;
  shadow.append(style);

  const root = document.createElement('div');
  root.className = 'wheel-root dbg-root';
  root.innerHTML = `
    <div class="dbg-card" role="dialog" aria-label="调试跳转">
      <div class="dbg-head">
        <div>
          <div class="dbg-kicker">调试跳转</div>
          <div class="dbg-title" data-el="title">正在解析当前对象…</div>
          <div class="dbg-sub" data-el="sub"></div>
        </div>
        <button class="dbg-x" data-el="close" title="关闭（Esc）" aria-label="关闭">×</button>
      </div>
      <div class="dbg-rows">
        <button class="dbg-row" data-go="object" disabled>
          <span class="dbg-row-t">对象配置</span>
          <span class="dbg-row-s">基础信息 / 字段 / 布局入口</span>
          <span class="dbg-arrow">→</span>
        </button>
        <button class="dbg-row" data-go="lifecycle" disabled>
          <span class="dbg-row-t">对象生命周期</span>
          <span class="dbg-row-s">状态、阶段与流转配置</span>
          <span class="dbg-arrow">→</span>
        </button>
        <button class="dbg-row" data-go="workflow" disabled>
          <span class="dbg-row-t">工作流</span>
          <span class="dbg-row-s">工作流列表页（按对象自己搜）</span>
          <span class="dbg-arrow">→</span>
        </button>
      </div>
      <div class="dbg-foot">
        <button class="dbg-mini" data-copy="object" disabled>复制 objectId</button>
        <button class="dbg-mini" data-copy="lifecycle" disabled>复制 lifecycleId</button>
        <span class="dbg-msg" data-el="msg"></span>
      </div>
    </div>`;
  shadow.append(root);

  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = '<b>调试跳转</b><i></i>Esc 关闭 · 已登录平台即可使用';
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

  const titleEl = $<HTMLElement>('[data-el="title"]');
  const subEl = $<HTMLElement>('[data-el="sub"]');
  const msgEl = $<HTMLElement>('[data-el="msg"]');
  const closeBtn = $<HTMLButtonElement>('[data-el="close"]');
  const rows = Array.from(shadow.querySelectorAll<HTMLButtonElement>('.dbg-row'));
  const copyBtns = Array.from(shadow.querySelectorAll<HTMLButtonElement>('[data-copy]'));

  let links: DebugLinks | null = null;
  let closing = false;

  const prevOverflow = document.documentElement.style.overflow;
  document.documentElement.style.overflow = 'hidden';

  const setMsg = (text: string, kind: 'ok' | 'bad' | '' = ''): void => {
    msgEl.textContent = text;
    msgEl.className = `dbg-msg${kind ? ` ${kind}` : ''}`;
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

  closeBtn.addEventListener('click', close);

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
    subEl.textContent = [data.object.code, data.lifecycle ? `生命周期：${data.lifecycle.name || data.lifecycle.id}` : '未启用生命周期']
      .filter(Boolean)
      .join(' · ');
    for (const row of rows) {
      const key = row.dataset.go as 'object' | 'lifecycle' | 'workflow';
      const url = key === 'lifecycle' ? data.urls.lifecycle : data.urls[key];
      row.disabled = !url;
      row.title = url || (key === 'lifecycle' ? '该对象未启用生命周期' : '');
    }
    copyBtns[0].disabled = !data.object.id;
    copyBtns[1].disabled = !data.lifecycle?.id;
  };

  const fail = (message: string): void => {
    titleEl.textContent = '无法定位当前对象';
    subEl.textContent = message;
    for (const row of rows) {
      row.disabled = true;
    }
    for (const btn of copyBtns) {
      btn.disabled = true;
    }
    setMsg('重试请先按 Esc 关闭，再按 Alt+2', '');
  };

  for (const row of rows) {
    row.addEventListener('click', () => {
      const key = row.dataset.go as 'object' | 'lifecycle' | 'workflow';
      if (!links) {
        return;
      }
      void openTarget(key === 'lifecycle' ? links.urls.lifecycle : links.urls[key]);
    });
  }
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
    setMsg('');
    closeBtn.focus();
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}
