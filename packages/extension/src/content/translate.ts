/**
 * 页面内翻译：浮动图标（可选）+ `Ctrl+X` 快捷键 → 剪贴板。
 *
 * # 两条路径的**语义差异**（用户 2026-10-12 明确要求并存）
 *
 * | 触发 | 行为 |
 * |---|---|
 * | **点浮动图标** | 翻译并**回填到输入框**（覆盖原文）—— 原扩展的行为 |
 * | **`Ctrl+X`** | 翻译并**只写剪贴板**，**不动输入框** —— 便于到下一个输入框直接粘贴 |
 *
 * ⇒ 两条路径共用同一套"翻译 + 校验 + 命名规范转换"，**只有落地方式不同**。
 *
 * # ★ 与 akso-pass 既有注入脚本共存的三条纪律
 *
 * 1. **幂等**：本脚本挂在 `<all_urls>` + `all_frames`，而 akso-pass 已有 4 个内容脚本
 *    在同页同 frame 跑。重复注入（bfcache / 再次 executeScript）时必须**立刻退出**，
 *    否则会出现两个图标、两次翻译、两次剪贴板写入。守卫用 `window` 上的 Symbol 键
 *    （不是 DOM 标记 —— DOM 可能被站点清掉，而站点清掉后守卫就失效了）。
 * 2. **id 带 `ql_` 前缀**：原扩展用 `akso_translate_*`。两个扩展若同时装着，
 *    同 id 会互相 `getElementById` 拿到对方的节点。见 `TRANSLATE_UI_ID`。
 * 3. **绝不往页面命名空间写东西**：本模块**不碰** `localStorage` / `sessionStorage` /
 *    `document.cookie`。读取设置走 `chrome.storage.sync`（扩展自己的域），
 *    而 akso-pass 的存储平面补丁只重定向**页面**的 storage ⇒ 两者天然不交叉。
 *    ★ 但设置读取会被 3 秒缓存：翻译是高频动作，每次读 storage 是没必要的往返。
 */
import { TRANSLATE_MESSAGE, TRANSLATE_UI_ID } from '../shared/constants';
import { getLogger } from '../shared/log';

const log = getLogger('translate');

/** 幂等守卫（Symbol 键：站点看不到、也删不掉） */
const GUARD = '__ql_translate_installed__';

interface TranslateReply {
  success: boolean;
  /** 已按设置做过 snake_case 转换的最终结果 */
  text?: string;
  /** 实际生效的引擎（自动模式赛马后是谁赢的） */
  engine?: string;
  error?: string;
}

interface CachedSettings {
  translate_enabled: boolean;
  floating_icon_enabled: boolean;
  /** 点图标时是否回填输入框；false 时只复制 */
  icon_fill_enabled: boolean;
  naming_convention_mode: boolean;
  target_language: string;
  ts: number;
}

const SETTINGS_TTL_MS = 3000;
let settingsCache: CachedSettings | null = null;

/** 当前获得焦点的可翻译元素（焦点跟踪的结果；`Ctrl+X` 就是冲它来的） */
let targetEl: HTMLElement | null = null;
let hideTimer: number | undefined;

/* ────────────────────────── 元素判定 ────────────────────────── */

/**
 * 哪些 `<input type>` **不参与翻译**。
 *
 * ★★ 2026-10-12 实测补 `number`：`<input type="number">` **不可能含中文**
 *   （浏览器拒收非数字字符），给它出图标是**纯噪音** —— 实测聚焦 number 框会出图标，
 *   点了/按了才失败，而报的是「结果仍为中文，引擎未能正确识别源语言」。
 *   用户无法从这句话理解"为什么数字框翻译失败"，而真因是**这里根本没有可译的东西**。
 *   ⇒ 与 `checkbox`/`radio` 同类：**不是可翻译元素**，直接不出图标、不占一次 API 调用。
 *
 * ★ `hidden`：元素不可见，出了图标也无处可点。
 */
const EXCLUDED_INPUT_TYPES = new Set([
  'checkbox', 'radio', 'file', 'submit', 'button', 'reset', 'image', 'range', 'color', 'hidden', 'number',
]);

function isTranslatable(el: EventTarget | null): el is HTMLElement {
  // ★ 收 `EventTarget | null` 而不是 `Element | null`：焦点事件的 `e.target` 就是
  //   `EventTarget`，在这里收窄一次比让**每个调用点各写一次类型断言**好
  //   （各写一次 = 各错一次的机会）。
  if (!el || !(el instanceof HTMLElement)) {
    return false;
  }
  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    return !EXCLUDED_INPUT_TYPES.has(type);
  }
  if (tag === 'textarea') {
    return true;
  }
  return el.isContentEditable;
}

function isEditableHost(el: HTMLElement): boolean {
  return el.isContentEditable;
}

function readText(el: HTMLElement): string {
  if (isEditableHost(el)) {
    return el.innerText || el.textContent || '';
  }
  return (el as HTMLInputElement | HTMLTextAreaElement).value || '';
}

/**
 * 回填文本（只给"点图标"这条路径用）。
 *
 * ★ 受控组件兼容：React/Vue 会**缓存 value 的 setter**，直接 `el.value = x` 之后
 *   框架内部状态仍是旧值，一渲染就把我们写的东西冲掉。所以走原型上的**原生 setter**
 *   再派发 `input`/`change` —— 与 `auto-login.ts` 处理登录表单是同一套办法
 *   （那里的密码框还在 iframe 里，更麻烦）。
 */
function writeText(el: HTMLElement, text: string): void {
  if (isEditableHost(el)) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel?.removeAllRanges();
    sel?.addRange(range);
    // execCommand 已废弃但仍是 contenteditable 最可靠的路径（保留原扩展做法）
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !el.innerText.includes(text.substring(0, 10))) {
      el.innerText = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return;
  }
  el.focus();
  const proto = el.tagName.toLowerCase() === 'textarea'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, text);
  } else {
    (el as HTMLInputElement).value = text;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/* ────────────────────────── 剪贴板 ────────────────────────── */

/**
 * 写剪贴板，**两级**降级。
 *
 * ★ 为什么不用 background 的 `chrome.clipboard`：那是 MV2 时代的 API，
 *   在 MV3 不存在；而离屏文档（`chrome.offscreen`）要额外权限 + 生命周期管理，
 *   为一次 `writeText` 不值得（本仓规则 10 的同族判断：别为一行功能加一个权限）。
 *
 * ★ 为什么这里能成功：两条路径**都在用户手势里**发起 ——
 *   `Ctrl+X` 的 keydown、或图标的 mousedown。缺了这个手势，
 *   `navigator.clipboard` 会以 `NotAllowedError` 拒绝，而**页面不给任何提示**。
 *   ⇒ 所以这里绝不许把 `writeClipboard` 挪到 `await` 之后（与 `permissions.request`
 *     必须最先发起是同一条纪律，AGENTS.md §2 有先例）。
 */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    log.debug('navigator.clipboard 失败，回落 execCommand: %s', e instanceof Error ? e.message : String(e));
  }
  // 降级：临时 textarea + execCommand（旧路径，但在非安全上下文/无权限时仍有效）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.documentElement.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    log.debug('execCommand(copy) 也失败: %s', e instanceof Error ? e.message : String(e));
    return false;
  }
}

/* ────────────────────────── 页面内反馈 ────────────────────────── */

/**
 * 底部 Toast（成功/失败都在这里）。
 * ★ 用户明确要求"翻译成功保留页面内反馈" ⇒ 这条**不能**因为合并而丢掉。
 */
function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
  let toast = document.getElementById(TRANSLATE_UI_ID.toast);
  if (!toast) {
    toast = document.createElement('div');
    toast.id = TRANSLATE_UI_ID.toast;
    document.documentElement.appendChild(toast);
  }
  toast.textContent = message;
  // 类名合约与 content.css 对齐：ql_toast / ql_toast_<type> / ql_toast_show
  toast.className = `ql_toast ql_toast_${type} ql_toast_show`;
  const anyToast = toast as HTMLElement & { _qlHideTimer?: number };
  if (anyToast._qlHideTimer !== undefined) {
    window.clearTimeout(anyToast._qlHideTimer);
  }
  anyToast._qlHideTimer = window.setTimeout(() => {
    toast?.classList.remove('ql_toast_show');
  }, 2600);
}

/* ────────────────────────── 设置（带缓存） ────────────────────────── */

async function getSettings(): Promise<CachedSettings> {
  const now = Date.now();
  if (settingsCache && now - settingsCache.ts < SETTINGS_TTL_MS) {
    return settingsCache;
  }
  // 默认值：即使 storage 读不到也必须能翻译（隐私模式下 storage.sync 会失败）
  let out: CachedSettings = {
    translate_enabled: true,
    floating_icon_enabled: true,
    icon_fill_enabled: true,
    naming_convention_mode: false,
    target_language: 'en',
    ts: now,
  };
  try {
    const stored = await chrome.storage.sync.get({
      translate_enabled: true,
        floating_icon_enabled: true,
      icon_fill_enabled: true,
      naming_convention_mode: false,
      target_language: 'en',
    });
    out = {
      translate_enabled: stored.translate_enabled !== false,
      floating_icon_enabled: stored.floating_icon_enabled !== false,
      icon_fill_enabled: stored.icon_fill_enabled !== false,
      naming_convention_mode: stored.naming_convention_mode === true,
      target_language: typeof stored.target_language === 'string' ? stored.target_language : 'en',
      ts: now,
    };
  } catch (e) {
    log.debug('读设置失败，用默认值: %s', e instanceof Error ? e.message : String(e));
  }
  settingsCache = out;
  return out;
}

try {
  chrome.storage.onChanged.addListener(() => {
    settingsCache = null;
  });
} catch {
  // 隐私模式下可能不可用，忽略（下次读取会用默认值）
}

/* ────────────────────────── 浮动图标 ────────────────────────── */

const ICON_SIZE = 20;
const ICON_OFFSET = 4;

function getOrCreateIcon(): HTMLElement {
  const existed = document.getElementById(TRANSLATE_UI_ID.icon);
  if (existed) {
    return existed;
  }
  const icon = document.createElement('div');
  icon.id = TRANSLATE_UI_ID.icon;
  icon.title = '翻译此输入框（Akso Pass）';
  icon.setAttribute('role', 'button');
  icon.setAttribute('aria-label', '翻译此输入框');
  icon.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" fill="white" aria-hidden="true">'
    + '<path d="M12.87 15.07l-2.54-2.51.03-.03A17.52 17.52 0 0 0 14.07 6H17V4h-7V2H8v2H1v2h11.17C11.5 7.92 10.44 9.75 9 11.35 8.07 10.32 7.3 9.19 6.69 8h-2c.73 1.63 1.73 3.17 2.98 4.56l-5.09 5.02L4 19l5-5 3.11 3.11.76-2.04zM18.5 10h-2L12 22h2l1.12-3h4.75L21 22h2l-4.5-12zm-2.62 7l1.62-4.33L19.12 17h-3.24z"/></svg>'
    + '<span class="ql_spinner"></span>';
  // mousedown 而不是 click：mousedown 在**焦点离开输入框之前**触发，
  // 用 click 的话 blur 已经把 targetEl 清掉了（原扩展在这一点上是对的）
  icon.addEventListener('mousedown', onIconClick);
  document.documentElement.appendChild(icon);
  return icon;
}

function positionIcon(el: HTMLElement): void {
  const icon = getOrCreateIcon();
  const rect = el.getBoundingClientRect();
  const sx = window.pageXOffset || document.documentElement.scrollLeft;
  const sy = window.pageYOffset || document.documentElement.scrollTop;
  const top = rect.bottom + sy - ICON_SIZE - ICON_OFFSET;
  const left = rect.right + sx - ICON_SIZE - ICON_OFFSET;
  icon.style.top = `${Math.max(sy, top)}px`;
  icon.style.left = `${Math.max(0, left)}px`;
  icon.style.display = 'flex';
  icon.classList.remove('ql_icon_loading');
}

function hideIcon(): void {
  const icon = document.getElementById(TRANSLATE_UI_ID.icon);
  if (icon) {
    icon.style.display = 'none';
    icon.classList.remove('ql_icon_loading');
  }
}

/* ────────────────────────── 翻译请求 ────────────────────────── */

/**
 * 发翻译请求，带 **MV3 SW 冷启动重试**。
 *
 * ★ 为什么需要：MV3 的 service worker 空闲约 30s 就被回收。用户隔一会儿再点图标时
 *   第一次 `sendMessage` 会撞上"正在唤醒"而抛 `Receiving end does not exist` ——
 *   而**这不是错误，是正常时序**。不重试的话表现是"第一次点没反应，再点才行"。
 */
async function requestTranslation(text: string, maxRetries = 3): Promise<TranslateReply> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const reply = (await chrome.runtime.sendMessage({
        type: TRANSLATE_MESSAGE.request,
        text,
      })) as TranslateReply | undefined;
      return reply ?? { success: false, error: '后台没有返回结果' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const swNotReady = msg.includes('Receiving end does not exist')
        || msg.includes('Could not establish connection');
      if (swNotReady && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      // ★ 扩展刚更新过时，旧页面的 content script 上下文会失效 —— 这条提示要具体
      if (msg.includes('Extension context invalidated')) {
        return { success: false, error: '插件已更新，请刷新页面后重试' };
      }
      return { success: false, error: msg };
    }
  }
  return { success: false, error: '翻译服务未响应' };
}

/* ────────────────────────── 两条落地路径 ────────────────────────── */

/** 路径 A：点图标 → 按设置**回填**输入框，或**只复制**到剪贴板 */
async function onIconClick(e: MouseEvent): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  const el = targetEl;
  if (!el) {
    return;
  }
  const settings = await getSettings();
  if (!settings.translate_enabled) {
    return; // 总开关刚关掉、图标还没隐藏的瞬间：不产生任何副作用
  }
  const source = readText(el).trim();
  if (!source) {
    showToast('⚠️ 输入框为空', 'warning');
    return;
  }

  const icon = document.getElementById(TRANSLATE_UI_ID.icon);
  icon?.classList.add('ql_icon_loading');
  try {
    const reply = await requestTranslation(source);
    if (!reply.success) {
      showToast(`❌ ${firstLine(reply.error ?? '翻译失败')}`, 'error');
      return;
    }
    if (settings.icon_fill_enabled) {
      writeText(el, reply.text ?? '');
      showToast(
        settings.naming_convention_mode ? '✅ 翻译完成（已转换为命名规范格式）' : '✅ 翻译完成',
        'success',
      );
      return;
    }

    /* ★ 2026-10-21：用户在翻译面板关掉「点图标时填充」⇒ 点图标与 Ctrl+X 一样只复制。
     *   ★ 绝不能在复制分支里再调 writeText：那会覆盖原文，正好是用户关掉它的原因。 */
    const copied = await writeClipboard(reply.text ?? '');
    if (copied) {
      showToast('✅ 已翻译并复制到剪贴板（原输入未改动）', 'success');
    } else {
      showToast('⚠️ 翻译完成但复制失败，请检查浏览器剪贴板权限', 'warning');
    }
  } finally {
    icon?.classList.remove('ql_icon_loading');
  }
}

/**
 * 路径 B：`Ctrl+X` → 翻译并**只写剪贴板**（不回填）。
 *
 * ★ 为什么"不回填"是刻意的：用户要的是"拿到译文去别的输入框粘贴"，
 *   回填会**毁掉原中文**（很多场景原文还要留着，比如对照、或多处复用同一译文）。
 */
async function translateToClipboard(shortcutLabel = ''): Promise<void> {
  const settings = await getSettings();
  if (!settings.translate_enabled) {
    return; // 总开关关掉时**静默**不做 —— 不是错误，用户自己关的
  }
  const el = targetEl;
  if (!el) {
    // ★ 这条提示是"翻译看起来没生效"最常见的真实原因：焦点不在输入框里。
    //   给的是**可执行的下一步**，不是"操作失败"。
    // ★ 键位由调用方带进来（SW 转发的命令 / 面板的"试一次"都带 `shortcut`）：
    //   内容脚本拿不到 `chrome.commands`，写死 `Ctrl+X` 会在用户改键后说谎。
    showToast(`⚠️ 请先把光标放进输入框（网页上的文本框/多行框/富文本都可以），${shortcutLabel ? `再按 ${shortcutLabel}` : '再按一次翻译快捷键'}`, 'warning');
    return;
  }
  const source = readText(el).trim();
  if (!source) {
    showToast('⚠️ 输入框为空', 'warning');
    return;
  }

  const icon = document.getElementById(TRANSLATE_UI_ID.icon);
  icon?.classList.add('ql_icon_loading');
  try {
    const reply = await requestTranslation(source);
    if (!reply.success) {
      showToast(`❌ ${firstLine(reply.error ?? '翻译失败')}`, 'error');
      return;
    }
    const text = reply.text ?? '';
    const copied = await writeClipboard(text);
    if (copied) {
      showToast('✅ 已翻译并复制到剪贴板（原输入未改动）', 'success');
    } else {
      // 剪贴板失败要**明说**：否则用户以为复制好了，粘出来是上一次的内容
      showToast('⚠️ 翻译完成但复制失败，请检查浏览器剪贴板权限', 'warning');
    }
  } finally {
    icon?.classList.remove('ql_icon_loading');
  }
}

function firstLine(s: string): string {
  return s.split('\n')[0].trim().slice(0, 80);
}

/* ────────────────────────── 焦点跟踪与快捷键 ────────────────────────── */

function onFocusIn(e: Event): void {
  const el = e.target;
  if (!isTranslatable(el)) {
    return;
  }
  if (hideTimer !== undefined) {
    window.clearTimeout(hideTimer);
    hideTimer = undefined;
  }
  // ★ 只记在闭包变量里，**不往页面元素上写任何标记**。
  //   曾经想过加 `dataset.qlFocused` 给 CSS 做"聚焦态"样式，但那会：
  //   ① 每聚焦一次就**改一次站点的 DOM**（站点可能监听 attribute 变化并重渲染）；
  //   ② 需要一个没人读的属性（死状态）。
  //   ⇒ 图标只在自己 hover/active 时有视觉变化，不需要知道"输入框是否聚焦"。
  targetEl = el;
  void refreshIconVisibility();
}

function onFocusOut(e: Event): void {
  // 只有"当前目标"失焦才隐藏；切到另一个输入框时不隐藏（`focusout` 先于 `focusin`）
  if (e.target !== targetEl) {
    return;
  }
  hideTimer = window.setTimeout(() => {
    const icon = document.getElementById(TRANSLATE_UI_ID.icon);
    // 鼠标停在图标上时不隐藏（否则用户永远点不到它）
    if (icon && icon.matches(':hover')) {
      return;
    }
    hideIcon();
    targetEl = null;
  }, 200);
}

/** 按设置决定图标现在该不该显示（图标是**可选功能**，开关一改要立刻生效） */
async function refreshIconVisibility(): Promise<void> {
  const settings = await getSettings();
  if (!settings.translate_enabled || !settings.floating_icon_enabled) {
    hideIcon();
    return;
  }
  if (targetEl) {
    positionIcon(targetEl);
  }
}

function onKeyDown(e: KeyboardEvent): void {
  // Ctrl+X：只在已聚焦可翻译输入框时接管，避免把页面其它地方的文字剪切掉。
  // `e.code` 用物理键，避免布局/输入法把 key 改掉。
  if (targetEl && e.ctrlKey && !e.altKey && !e.metaKey && e.code === 'KeyX') {
    e.preventDefault();
    e.stopPropagation();
    void translateToClipboard();
  }
}

/* ────────────────────────── 装配 ────────────────────────── */

function init(): void {
  if ((window as unknown as Record<string, unknown>)[GUARD]) {
    return; // 幂等：重复注入必须立刻退出
  }
  (window as unknown as Record<string, unknown>)[GUARD] = true;

  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', () => {
    void refreshIconVisibility();
  }, { passive: true });
  window.addEventListener('resize', () => {
    void refreshIconVisibility();
  }, { passive: true });

  // 设置变了（面板里改开关）→ 图标立刻跟着变，不用刷新页面
  try {
    chrome.storage.onChanged.addListener(() => {
      settingsCache = null;
      void refreshIconVisibility();
    });
  } catch {
    /* 隐私模式忽略 */
  }

  // background 收到 Ctrl+X 命令后转过来（`chrome.commands` 的 onCommand 只在 SW 里触发）
  chrome.runtime.onMessage.addListener((msg: unknown) => {
    if (!msg || typeof msg !== 'object') {
      return undefined;
    }
    const m = msg as { type?: string; shortcut?: string };
    if (m.type === TRANSLATE_MESSAGE.hotkey) {
      // `shortcut` = 转发方带来的**实际键位**（SW 从 `chrome.commands.getAll()` 取）。
      // 空串时 Toast 退回"再按一次翻译快捷键"，不猜键位。
      void translateToClipboard(m.shortcut ?? '');
    }
    return undefined;
  });

  log.debug('translate content script installed');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
