/**
 * 自动截图 · 页面侧录制器（v4.5.1）
 *
 * 职责只有两件：
 *   ① 把「点了谁 / 填了哪个框」连同**视口坐标**报给后台；
 *   ② 后台在事件瞬间截图（`captureVisibleTab`），这里不碰像素。
 *
 * ★ 按需注入（`chrome.scripting.executeScript`），不是常驻 content_scripts：
 *   录制是低频动作，常驻监听会让每个页面都多背一个脚本。
 * ★ 坐标必须是**视口**坐标：截图就是视口截图，两者同一坐标系；
 *   用文档坐标就得减 `scrollY`，而且长页面里会直接落到截图外面。
 */
import { SHOT_MESSAGE } from '../shared/constants';
import type { ShotEventPayload, ShotKind } from '../shared/types';

interface RecorderHandle {
  stop: () => void;
}
const holder = window as unknown as { __qlShotRecorder?: RecorderHandle };

/** 元素名截断，免得把整段正文塞进时间线 */
function short(text: string, max = 40): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 密码/令牌类输入框：值一律打码（截图会进手册，凭据绝不能跟着走） */
function looksSecret(el: Element): boolean {
  const hint = `${el.getAttribute('type') ?? ''} ${el.getAttribute('name') ?? ''} ${el.id} ${el.getAttribute('autocomplete') ?? ''}`;
  return /password|passwd|pwd|secret|token|otp/i.test(hint);
}

function labelOf(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria?.trim()) return short(aria);
  const placeholder = el.getAttribute('placeholder');
  if (placeholder?.trim()) return short(placeholder);
  const title = el.getAttribute('title');
  if (title?.trim()) return short(title);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const id = el.id;
    if (id) {
      const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id;
      const lab = document.querySelector(`label[for="${escaped}"]`);
      if (lab?.textContent?.trim()) return short(lab.textContent);
    }
    const wrap = el.closest('label');
    if (wrap?.textContent?.trim()) return short(wrap.textContent);
  }

  const text = (el as HTMLElement).innerText;
  if (text?.trim()) return short(text);
  const name = el.getAttribute('name');
  if (name?.trim()) return short(name);
  return `<${el.tagName.toLowerCase()}>`;
}

function selectorOf(el: Element): string {
  if (el.id) return `#${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(el.id) : el.id}`;
  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node !== document.documentElement && depth < 4) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    if (parent.id) {
      parts.unshift(`#${parent.id} > ${tag}`);
      break;
    }
    const same = Array.from(parent.children).filter((c) => c.tagName === node?.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    node = parent;
    depth += 1;
  }
  return parts.join(' > ');
}

function valueOf(el: Element): string | undefined {
  if (el instanceof HTMLInputElement) {
    if (looksSecret(el)) return '••••••';
    if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '已勾选' : '未勾选';
    if (el.type === 'file') return el.files?.[0]?.name;
    return el.value ? short(el.value, 120) : undefined;
  }
  if (el instanceof HTMLTextAreaElement) return el.value ? short(el.value, 120) : undefined;
  if (el instanceof HTMLSelectElement) return short(el.selectedOptions[0]?.textContent ?? el.value);
  if (el instanceof HTMLElement && el.isContentEditable) return short(el.textContent ?? '', 120) || undefined;
  return undefined;
}

function init(): void {
  let sessionId: string | null = null;
  let detach: (() => void) | null = null;

  const emit = (kind: ShotKind, el: Element, box: { x: number; y: number; w: number; h: number }): void => {
    if (!sessionId) return;
    const payload: ShotEventPayload = {
      sessionId,
      kind,
      at: Date.now(),
      url: location.href,
      title: document.title,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      x: Math.max(0, box.x),
      y: Math.max(0, box.y),
      w: Math.max(1, box.w),
      h: Math.max(1, box.h),
      label: labelOf(el),
      selector: selectorOf(el),
      value: kind === 'input' ? valueOf(el) : undefined,
    };
    try {
      void chrome.runtime.sendMessage({ type: SHOT_MESSAGE.event, payload }).catch(() => undefined);
    } catch {
      // 扩展被重载后旧内容脚本会报 "Extension context invalidated"：静默退出
      detach?.();
    }
  };

  const onPointerDown = (ev: Event): void => {
    const e = ev as PointerEvent;
    if (e.button !== 0) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el || el === document.documentElement || el === document.body) return;
    const rect = el.getBoundingClientRect();
    // 大容器（整页/整表）用元素矩形没意义，改成「点击点周围一小圈」
    const big = rect.width > window.innerWidth * 0.7 && rect.height > window.innerHeight * 0.7;
    const box = big
      ? { x: e.clientX - 14, y: e.clientY - 14, w: 28, h: 28 }
      : { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
    emit('click', el, box);
  };

  const onChange = (ev: Event): void => {
    const el = ev.target;
    if (!(el instanceof Element)) return;
    if (!el.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
    const rect = el.getBoundingClientRect();
    emit('input', el, { x: rect.left, y: rect.top, w: rect.width, h: rect.height });
  };

  const install = (): void => {
    if (detach) return;
    document.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true });
    document.addEventListener('change', onChange, { capture: true, passive: true });
    detach = () => {
      document.removeEventListener('pointerdown', onPointerDown, { capture: true });
      document.removeEventListener('change', onChange, { capture: true });
      detach = null;
    };
  };

  const uninstall = (): void => {
    detach?.();
  };

  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    const m = msg as { type?: string; sessionId?: string } | undefined;
    if (m?.type === SHOT_MESSAGE.start && typeof m.sessionId === 'string') {
      sessionId = m.sessionId;
      install();
      sendResponse({ ok: true });
      return false;
    }
    if (m?.type === SHOT_MESSAGE.stop) {
      uninstall();
      sessionId = null;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  holder.__qlShotRecorder = { stop: uninstall };
}

if (!holder.__qlShotRecorder) init();
