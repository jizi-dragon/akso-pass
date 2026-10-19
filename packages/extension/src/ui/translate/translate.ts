/**
 * 翻译面板（原扩展的 popup 设置面板迁移到这里）。
 *
 * # 为什么不再用 popup 承载设置
 *
 * 原设置面板是工具栏小窗（`action.default_popup`，约 360px 宽）。设置项涨到
 * "3 个开关 + 15 语言 + 5 引擎 + 实时预览 + 统计 + 合规告知"之后那个小窗放不下，
 * 而且 popup **一失焦就关** —— 用户没法"改了设置再对着页面看效果"。
 * `ui/popup/popup.*` 保留，但只做"打开管理页"的入口。
 *
 * # 与 background 的职责边界
 *
 * | 谁 | 做什么 |
 * |---|---|
 * | 本页面 | 只**读写设置**（`storage.sync`）+ 读统计（`storage.local`） |
 * | background | 真正调引擎；**命名规范转换也在那边**（两个入口共用一份结果） |
 *
 * ⇒ 本页的"实时预览"直接 `import` `shared/snake-case.ts` —— 与 background
 *   用的是**同一份代码**，所以预览与实际结果不可能漂移。
 *
 * # 信息层级（2026-10-12 重排，用户反馈"杂乱无序、无法配置"）
 *
 * ① 总开关 → ② 怎么用（含"试一次"） → ③ 命名规范（带预览）
 * → ④ 高级（语言/引擎，默认折叠但 summary 回显当前值） → ⑤ 统计 → ⑥ 吸底保存
 */
import { EXT_VERSION, TRANSLATE_COMMAND, TRANSLATE_MESSAGE } from '../../shared/constants';
import { getForwardingLogger } from '../../shared/log';
import { toSnakeCase } from '../../shared/snake-case';

/* ★ 用 `getForwardingLogger` 而不是 `getLogger`：**与 `ui/parallel/parallel.ts` 同一形状**。
 *
 * 为什么（`parallel.ts:17` 那条注释讲得很清楚）：UI 页面跑在**自己的进程**里，
 * `getLogger()` 记的日志进的是**这个页面的**内存环 ⇒ **永远到不了诊断包**。
 * 而转发 logger 会把行送回 background ⇒ 排障时在诊断包的 `appLogs` 里看得到。
 *
 * ★ 这一条对"读设置失败"尤其要紧：它是**用户报告"我的设置没了"**时
 *   唯一能证明"其实是读失败"的证据，而诊断包正是用户会导出的东西。 */
const log = getForwardingLogger('translate');
import {
  loadTranslationSettings,
  saveTranslationSettings,
  TARGET_LANGUAGES,
  type TranslationSettings,
} from '../../shared/translate-settings';
import { readStats, dateKeys } from '../../shared/translate-stats';
import type { EngineId } from '../../shared/engines';

/* ── DOM ── */
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) {
    // ★ 不静默：id 写错时 `null.textContent` 会抛，而抛在 init 里会让**整页什么都不响应**。
    //   直接报出是哪个 id，比"页面点了没反应"好定位。
    throw new Error(`翻译面板缺少 DOM 元素 #${id}（HTML 与 TS 的 id 约定漂了？）`);
  }
  return el as T;
};

const el = {
  enabled: $<HTMLInputElement>('translate_enabled'),
  enabledLabel: $<HTMLElement>('enabled_label'),
  enabledSub: $<HTMLElement>('enabled_sub'),
  disabledBanner: $<HTMLDivElement>('disabled-banner'),
  floatingIcon: $<HTMLInputElement>('floating_icon_enabled'),
  naming: $<HTMLInputElement>('naming_convention_mode'),
  targetLang: $<HTMLSelectElement>('target_language'),
  engineList: $<HTMLDivElement>('engine-list'),
  adv: $<HTMLDetailsElement>('adv'),
  advCurrent: $<HTMLElement>('adv-current'),
  previewIn: $<HTMLInputElement>('preview-input'),
  previewOut: $<HTMLElement>('preview-output'),
  statToday: $<HTMLElement>('stat-today'),
  statMonth: $<HTMLElement>('stat-month'),
  statTotal: $<HTMLElement>('stat-total'),
  hotkeyDisplay: $<HTMLElement>('hotkey-display'),
  shortcutLink: $<HTMLAnchorElement>('shortcut-link'),
  testBtn: $<HTMLButtonElement>('test-btn'),
  verChip: $<HTMLElement>('ver-chip'),
  saveBtn: $<HTMLButtonElement>('btn-save'),
  saveFeedback: $<HTMLElement>('save-feedback'),
};

/* ── 引擎元数据（文案与能力边界一处集中，便于改） ── */
interface EngineMeta {
  id: EngineId;
  name: string;
  desc: string;
  tag?: string;
}

const ENGINES: EngineMeta[] = [
  {
    id: 'auto',
    name: '自动模式',
    tag: '推荐',
    desc: '并行赛马腾讯 + 有道两个国内引擎，谁快用谁；都失败再依次用 MyMemory、Lingva 兜底。要 4 路同时挂才会失败。',
  },
  {
    id: 'transmart',
    name: '腾讯交互翻译 TranSmart',
    tag: '最快',
    desc: '国内直连、无需 Key，通常 100–500ms，通用场景覆盖广。',
  },
  {
    id: 'youdao',
    name: '网易有道词典',
    tag: '国内',
    desc: '词典式「网络释义」，短词/术语质量高（字段名场景好）。★ 只服务中↔英方向，选其它目标语言会失败并由兜底引擎接管。',
  },
  { id: 'mymemory', name: 'MyMemory', tag: '海外备用', desc: '国际公共接口，每天约 1000 次免费额度。' },
  { id: 'lingva', name: 'Lingva', tag: '最终兜底', desc: 'Google 翻译开源镜像，前序全挂时用。' },
];

const engineName = (id: EngineId): string => ENGINES.find((e) => e.id === id)?.name ?? id;
const langName = (code: string): string => TARGET_LANGUAGES.find((l) => l.code === code)?.label ?? code;

/* ── 渲染：目标语言 ── */
function renderLangOptions(): void {
  el.targetLang.innerHTML = '';
  for (const l of TARGET_LANGUAGES) {
    const opt = document.createElement('option');
    opt.value = l.code;
    opt.textContent = l.label;
    el.targetLang.appendChild(opt);
  }
}

/* ── 渲染：引擎卡 ── */
function renderEngines(current: EngineId): void {
  el.engineList.innerHTML = '';
  for (const meta of ENGINES) {
    const label = document.createElement('label');
    label.className = `t-engine${meta.id === current ? ' is-active' : ''}`;
    label.dataset.engine = meta.id;
    // 用 <label> 包住 radio：整卡可点 + 键盘可达，不需要 JS 手动改 checked
    label.innerHTML =
      `<input type="radio" name="engine" value="${meta.id}"${meta.id === current ? ' checked' : ''} />`
      + '<span class="t-engine-body">'
      + `<span class="t-engine-name">${meta.name}`
      + (meta.tag ? `<span class="t-tag${meta.id === 'auto' ? '' : ' t-tag-plain'}">${meta.tag}</span>` : '')
      + '</span>'
      + `<span class="t-engine-desc">${meta.desc}</span>`
      + '</span>';
    el.engineList.appendChild(label);
  }
  renderAdvCurrent();
}

function selectedEngine(): EngineId {
  const checked = el.engineList.querySelector<HTMLInputElement>('input[name="engine"]:checked');
  return (checked?.value as EngineId | undefined) ?? 'auto';
}

/** 折叠状态下 summary 上回显"现在配的是什么"（否则用户得展开才知道） */
function renderAdvCurrent(): void {
  el.advCurrent.textContent = `${langName(el.targetLang.value)} · ${engineName(selectedEngine())}`;
}

/* ── 渲染：预览与启用态 ── */
function renderPreview(): void {
  const src = el.previewIn.value;
  el.previewOut.textContent = src.trim() ? toSnakeCase(src) : '—';
}

function renderEnabledState(enabled: boolean): void {
  el.enabledLabel.textContent = enabled ? '翻译功能已开启' : '翻译功能已关闭';
  el.enabledSub.textContent = enabled
    ? '页面会出现翻译图标，Alt+T 可用'
    : '图标不会出现，Alt+T 也不响应';
  el.disabledBanner.classList.toggle('hidden', enabled);
}

/* ── 渲染：统计 ── */
async function renderStats(): Promise<void> {
  const stats = await readStats();
  const { day, month } = dateKeys();
  el.statToday.textContent = String(stats.days[day] ?? 0);
  el.statMonth.textContent = String(stats.months[month] ?? 0);
  el.statTotal.textContent = String(stats.total ?? 0);
}

/* ── 保存 ── */
async function collect(): Promise<TranslationSettings> {
  return {
    translate_enabled: el.enabled.checked,
    floating_icon_enabled: el.floatingIcon.checked,
    naming_convention_mode: el.naming.checked,
    target_language: el.targetLang.value,
    source_language: 'auto',
    translation_provider: selectedEngine(),
  };
}

let feedbackTimer: number | undefined;

function showFeedback(msg: string, ok = true): void {
  el.saveFeedback.textContent = msg;
  el.saveFeedback.style.color = ok ? '' : 'var(--sb-danger)';
  if (feedbackTimer !== undefined) {
    window.clearTimeout(feedbackTimer);
  }
  feedbackTimer = window.setTimeout(() => {
    el.saveFeedback.textContent = '';
  }, 2600);
}

async function onSave(): Promise<void> {
  try {
    const settings = await collect();
    await saveTranslationSettings(settings);
    renderEnabledState(settings.translate_enabled);
    showFeedback('✓ 设置已保存');
  } catch (e) {
    showFeedback(`保存失败：${e instanceof Error ? e.message : String(e)}`, false);
  }
}

/* ── 快捷键真实键位（不要写死 "Alt+T"：用户可能已在快捷键页改过） ── */
async function renderHotkey(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const hit = commands.find((c) => c.name === TRANSLATE_COMMAND);
    const key = hit?.shortcut;
    if (key && key.length > 0) {
      el.hotkeyDisplay.textContent = key;
    } else {
      // ★ 这条分支很重要：`shortcut` 为空 = 键位被清掉 or 被别的扩展占用，
      //   而**用户只会看到"按了没反应"**。必须在这里说清楚。
      el.hotkeyDisplay.textContent = '未设置（可能被别的扩展占用）';
    }
  } catch {
    // `chrome.commands` 极少数环境不可用 —— 保留 HTML 里的默认文案，不要显示空白
  }
}

/**
 * "试一次"：**不开新页面、不碰用户输入**地在当前标签页触发一次翻译。
 *
 * ★ 为什么要有它：用户报"翻译功能没有生效"时，无法区分
 *   ① 快捷键没注册 / 被占用、② 内容脚本没注入该页、③ 引擎不通、④ 光标不在输入框。
 *   这个按钮把 ①②④ 一次性排掉（它走的是**和快捷键完全相同的那条消息链路**），
 *   剩下的如果还失败，页面上的 Toast 会直接报出引擎层的具体错误。
 *
 * ★★ 2026-10-12：`chrome://` / 应用商店这类**浏览器内部页**必须给出**可理解**的说明。
 *   它们是**浏览器安全边界**（Chrome 不往这些页面注入任何扩展脚本），不是本扩展的缺陷 ——
 *   但用户看到的只是"按了没反应"，于是会以为功能坏了。
 *   实测边界：以 `chrome:` 与 `chrome-extension:` 开头的内部页、应用商店域名、
 *   以及 PDF 查看器（后者反而**可以**注入）。
 *   ★ 这里刻意不写出带通配的 URL 字面量 —— 它们含注释开始/结束标记，
 *     会让"块注释配平"判据误判（我已在这上面栽过六次，见 PITFALLS #43）。
 */
async function onTest(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) {
      showFeedback('拿不到当前标签页', false);
      return;
    }
    const url = tab.url ?? '';
    const isInternal = /^(chrome|edge|about|devtools|view-source):/i.test(url)
      || /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i.test(url);
    if (isInternal) {
      showFeedback('当前是浏览器内部页/应用商店 —— 浏览器不允许任何扩展在这里注入，换个普通网页试', false);
      return;
    }
    if (!/^(https?|file):/i.test(url)) {
      showFeedback('当前页签类型不支持翻译，请在普通网页上使用', false);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: TRANSLATE_MESSAGE.hotkey });
      showFeedback('已发出（若失败，请看页面底部的提示）');
    } catch {
      // 走到这里通常是：页面在扩展加载/更新**之前**就打开了（内容脚本不在），或 file:// 未授权
      showFeedback('当前页面没有翻译脚本 —— 刷新该页面后重试；若是本地文件请在扩展详情里开启「允许访问文件网址」', false);
    }
  } catch (e) {
    showFeedback(`试一次失败：${e instanceof Error ? e.message : String(e)}`, false);
  }
}

/* ── 装配 ── */
async function init(): Promise<void> {
  el.verChip.textContent = `v${EXT_VERSION}`;

  // `chrome://` 链接不能在扩展页里直接 href 跳转（会被拦），用 tabs.create 打开。
  el.shortcutLink.addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  renderLangOptions();
  renderEngines('auto');

  let settings: TranslationSettings;
  try {
    settings = await loadTranslationSettings();
  } catch (e) {
    /* ★★ 2026-10-16：原来是裸吞（只留一句"页面也要可用"的注释）。
     *
     * 「回落保证页面可用（否则整页空白，用户以为扩展坏了）」**是对的**，
     * 但"不留痕"是错的 —— 用户看到的是**"我的设置被重置了"**，
     * 而不是"读失败了"。这与**已被判据点名的** `favorites.listFavorites`
     * （"读失败 ⇒ 回落内置默认 ⇒ 界面对用户说谎"）**逐字同形**，
     * 而这一条当时没被点名。⇒ 现在补上，并进 `verify-log-redaction.mjs` §13 的 CASES。
     */
    log.warn('读翻译设置失败 ⇒ 本次渲染用默认值（用户之前改的设置这一次看不到）：%s',
      e instanceof Error ? e.message : String(e));
    settings = {
      translate_enabled: true,
      floating_icon_enabled: true,
      naming_convention_mode: false,
      target_language: 'en',
      source_language: 'auto',
      translation_provider: 'auto',
    };
  }

  el.enabled.checked = settings.translate_enabled;
  el.floatingIcon.checked = settings.floating_icon_enabled;
  el.naming.checked = settings.naming_convention_mode;
  el.targetLang.value = settings.target_language;
  renderEngines(settings.translation_provider);
  renderEnabledState(settings.translate_enabled);

  // 高级区默认展开：**宁可多露一点，也不要"藏在折叠里等于没做"**
  // （本仓规则 40 的同族：读不到 = 不存在）。用户嫌长可以自己折起来。
  el.adv.open = true;

  renderPreview();
  el.previewIn.addEventListener('input', renderPreview);
  el.naming.addEventListener('change', () => {
    renderPreview();
    void onSave();
  });

  // 总开关与图标开关**改动即存**（这两个是高频动作，用户不会愿意再点一次"保存"）
  el.enabled.addEventListener('change', () => {
    renderEnabledState(el.enabled.checked);
    void onSave();
  });
  el.floatingIcon.addEventListener('change', () => void onSave());

  el.saveBtn.addEventListener('click', () => void onSave());
  el.testBtn.addEventListener('click', () => void onTest());

  // 引擎卡高亮跟随选择（只改视觉，不改行为）
  el.engineList.addEventListener('change', () => {
    const cur = selectedEngine();
    for (const card of Array.from(el.engineList.querySelectorAll<HTMLElement>('.t-engine'))) {
      card.classList.toggle('is-active', card.dataset.engine === cur);
    }
    renderAdvCurrent();
  });

  el.targetLang.addEventListener('change', renderAdvCurrent);

  await Promise.all([renderStats(), renderHotkey()]);

  // 别处改了设置（另一个页面 / 别的设备同步过来）→ 本页跟着刷新，不留旧值
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'sync') {
      void loadTranslationSettings().then((next) => {
        el.enabled.checked = next.translate_enabled;
        el.floatingIcon.checked = next.floating_icon_enabled;
        el.naming.checked = next.naming_convention_mode;
        el.targetLang.value = next.target_language;
        renderEngines(next.translation_provider);
        renderEnabledState(next.translate_enabled);
        renderPreview();
      });
    } else if (area === 'local') {
      // 翻译发生在别的页面 → 统计变了就刷新（不需要轮询）
      void renderStats();
    }
  });
}

void init();
