/**
 * 翻译面板（原扩展的 popup 设置面板迁移到这里）。
 *
 * # 为什么不再用 popup 承载设置
 *
 * 原设置面板是工具栏小窗（`action.default_popup`，约 360px 宽）。设置项涨到
 * "3 个开关 + 15 语言 + 4 个引擎 + 统计 + 合规告知"之后那个小窗放不下，
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
 * ⇒ 本页**不再** import `shared/snake-case.ts`：4.6.5 起命名规范恒定开启、预览卡已移除，
 *   转换只在 background 做一次（本页只负责显示"已按命名规范转换"的说明）。
 *
 * # 信息层级（2026-11-26 调整：命名规范卡移除后重排）
 *
 * ① 总开关 → ② 怎么用（含"试一次"） → ③ 高级（语言/引擎，默认折叠但 summary 回显当前值）
 * → ④ 统计 → ⑤ 吸底保存
 */
import {
  EXT_VERSION,
  TRANSLATE_COMMAND,
  TRANSLATION_HISTORY_KEY,
  TRANSLATE_MESSAGE,
} from '../../shared/constants';
import { getForwardingLogger } from '../../shared/log';
import { installLogForwarding } from '../../shared/forward-log';

/* ★ 用 `getForwardingLogger` 而不是 `getLogger`：**与 `ui/parallel/parallel.ts` 同一形状**。
 *
 * 为什么（`parallel.ts:17` 那条注释讲得很清楚）：UI 页面跑在**自己的进程**里，
 * `getLogger()` 记的日志进的是**这个页面的**内存环 ⇒ **永远到不了诊断包**。
 * 而转发 logger 会把行送回 background ⇒ 排障时在诊断包的 `appLogs` 里看得到。
 *
 * ★ 这一条对"读设置失败"尤其要紧：它是**用户报告"我的设置没了"**时
 *   唯一能证明"其实是读失败"的证据，而诊断包正是用户会导出的东西。
 *
 * ★★ 2026-11-09：**光用 `getForwardingLogger` 不够** —— 转发器不装的话它
 *   `if (forwarder && …)` 恒假，与 `getLogger` 一模一样（本文件原先就是这种状态）。
 *   现在紧跟着一行 `installLogForwarding()`。 */
const log = getForwardingLogger('translate');
installLogForwarding();
import {
  loadTranslationSettings,
  saveTranslationSettings,
  TARGET_LANGUAGES,
  type TranslationSettings,
} from '../../shared/translate-settings';
import { readStats, dateKeys } from '../../shared/translate-stats';
// ★ 改键页的地址与文案按家族给（Edge = `edge://`，理由见该模块头注释）。
import { shortcutsPageText, shortcutsPageUrl } from '../../shared/browser-env';
import { ENGINE_LABEL, type EngineId } from '../../shared/engines';
import {
  clearTranslationHistory,
  loadTranslationHistory,
  type TranslationHistoryEntry,
} from '../../shared/translate-history';
import {
  DEEPSEEK_MODELS,
  LLM_SETTINGS_KEY,
  loadLlmSettings,
  maskKey,
  saveLlmSettings,
  type DeepSeekModel,
  type LlmSettings,
} from '../../shared/llm-settings';

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
  iconFill: $<HTMLInputElement>('icon_fill_enabled'),
  iconFillLabel: $<HTMLElement>('icon-fill-label'),
  iconPathTitle: $<HTMLElement>('icon-path-title'),
  iconActionDesc: $<HTMLElement>('icon-action-desc'),
  targetLang: $<HTMLSelectElement>('target_language'),
  engineList: $<HTMLDivElement>('engine-list'),
  llmPanel: $<HTMLDivElement>('llm-panel'),
  llmState: $<HTMLElement>('llm-state'),
  llmKey: $<HTMLInputElement>('deepseek_key'),
  llmModel: $<HTMLSelectElement>('deepseek_model'),
  llmTest: $<HTMLButtonElement>('deepseek-test'),
  llmClear: $<HTMLButtonElement>('deepseek-clear'),
  llmFeedback: $<HTMLElement>('deepseek-feedback'),
  adv: $<HTMLDetailsElement>('adv'),
  advCurrent: $<HTMLElement>('adv-current'),
  statToday: $<HTMLElement>('stat-today'),
  statMonth: $<HTMLElement>('stat-month'),
  statTotal: $<HTMLElement>('stat-total'),
  historyList: $<HTMLDivElement>('history-list'),
  historyEmpty: $<HTMLDivElement>('history-empty'),
  historyClear: $<HTMLButtonElement>('history-clear'),
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
    desc: '配置 DeepSeek Key 时先试大模型，失败再回落免费链路；未配置时先用有道查词（短词 20–50ms），查不到再用 MyMemory 翻整句（1–2s）。',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    tag: '自带 Key',
    desc: '使用你自己的 DeepSeek API Key，翻译质量更高；Key 只存本机，不随账号同步。未配置 Key 时选择它会直接报错，不会悄悄换成免费引擎。',
  },
  {
    id: 'youdao',
    name: '网易有道词典',
    tag: '国内·查词',
    desc: '词典式「网络释义」，短词/术语质量高（字段名场景好）。★ 只服务中↔英方向，选其它目标语言会失败并由 MyMemory 接管。',
  },
  {
    id: 'mymemory',
    name: 'MyMemory',
    tag: '海外·整句',
    desc: '国际公共接口，翻整句；每天约 1000 次免费额度，实测 0.4–2.1s。',
  },
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

/* ── DeepSeek（BYOK） ── */

let llmSettings: LlmSettings = { api_key: '', model: 'deepseek-flash' };

function renderLlmModels(selected: DeepSeekModel): void {
  el.llmModel.innerHTML = '';
  for (const model of DEEPSEEK_MODELS) {
    const opt = document.createElement('option');
    opt.value = model.id;
    opt.textContent = model.label;
    opt.title = model.desc;
    el.llmModel.appendChild(opt);
  }
  el.llmModel.value = selected;
}

function renderLlmState(): void {
  const on = llmSettings.api_key.length > 0;
  el.llmState.textContent = on ? `已配置 · ${maskKey(llmSettings.api_key)}` : '未配置';
  el.llmState.classList.toggle('is-on', on);
  el.llmKey.placeholder = on
    ? '已配置，输入新 Key 可替换（留空保存不会删除）'
    : 'sk-…（只存本机，不随账号同步）';
}

async function loadLlmOrDefault(): Promise<LlmSettings> {
  try {
    return await loadLlmSettings();
  } catch (e) {
    log.warn('读 DeepSeek 设置失败 ⇒ 本次按未配置处理：%s',
      e instanceof Error ? e.message : String(e));
    return { api_key: '', model: 'deepseek-flash' };
  }
}

/**
 * 把表单里的 Key/模型写回 local。
 *
 * ★ Key 输入框留空 = **保留**已存 Key，而不是清空：用户改模型时不该被迫重输 Key。
 *   删除走「清除 Key」按钮，避免“保存一下 Key 没了”的意外。
 */
async function persistLlm(): Promise<void> {
  const typed = el.llmKey.value.trim();
  const model = (el.llmModel.value as DeepSeekModel) || 'deepseek-flash';
  await saveLlmSettings(typed ? { api_key: typed, model } : { model });
  llmSettings = await loadLlmSettings();
  el.llmKey.value = '';
  renderLlmState();
}

async function onDeepseekTest(): Promise<void> {
  el.llmTest.disabled = true;
  el.llmFeedback.textContent = '正在测试…';
  try {
    // 先把刚输入的 Key/模型落盘，否则用户“输入后直接点测试”会测到旧 Key。
    if (el.llmKey.value.trim() || el.llmModel.value !== llmSettings.model) {
      await persistLlm();
    }
    if (!llmSettings.api_key) {
      el.llmFeedback.textContent = '请先填写 API Key 并保存';
      return;
    }
    const resp = await chrome.runtime.sendMessage({
      type: TRANSLATE_MESSAGE.testDeepseek,
    }) as { success?: boolean; text?: string; error?: string; model?: string } | undefined;
    if (resp?.success) {
      el.llmFeedback.textContent = `✅ 连接成功（${resp.model ?? llmSettings.model}）：${resp.text ?? ''}`;
    } else {
      el.llmFeedback.textContent = `❌ ${resp?.error ?? '测试失败'}`;
    }
  } catch (e) {
    el.llmFeedback.textContent = `❌ ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    el.llmTest.disabled = false;
  }
}

async function onClearDeepseek(): Promise<void> {
  try {
    await saveLlmSettings({ api_key: '' });
    llmSettings = await loadLlmSettings();
    el.llmKey.value = '';
    renderLlmState();
    el.llmFeedback.textContent = '已清除本机保存的 DeepSeek Key';
  } catch (e) {
    el.llmFeedback.textContent = `清除失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 折叠状态下 summary 上回显"现在配的是什么"（否则用户得展开才知道） */
function renderAdvCurrent(): void {
  el.advCurrent.textContent = `${langName(el.targetLang.value)} · ${engineName(selectedEngine())}`;
}

/* ─────────────────────── 键位文案的唯一来源 ───────────────────────
 * ★ 2026-10-26：面板里原来有 **4 处**写死 `Ctrl+X`（标题、总开关副标题、关闭提示条、
 *   "怎么用"的键帽），而界面上又明确请用户去 `chrome://extensions/shortcuts` 改键 ——
 *   改完键位后那 4 处就变成**对用户说谎的描述**（用户实测报的就是这个）。
 *   ⇒ 现在全部走 `applyHotkeyText()`：一个 `hotkeyLabel` 变量 + `[data-hotkey]` 标记。
 *   HTML 里那几处字只是**无 JS 时的兜底**，运行时一律被覆盖。
 * ★ 唯一事实源是 `chrome.commands.getAll()`（用户改键后的**实际**值）；
 *   `getManifest()` 只给**默认值**，用来在异步结果回来之前先显示一个不会错的值。
 */

/** manifest 里登记的默认键位（同步可读；拿不到就是空串）。 */
function manifestDefaultHotkey(): string {
  try {
    const cmd = chrome.runtime.getManifest().commands?.[TRANSLATE_COMMAND];
    return cmd?.suggested_key?.default ?? '';
  } catch {
    return '';
  }
}

/** 原始键位（`''` = 没有生效键位）。要传给内容脚本，故与展示文案分开存。 */
let hotkeyShortcut = manifestDefaultHotkey();

/** 展示文案：没有键位时说清原因，而不是显示空白。 */
let hotkeyLabel = hotkeyShortcut || '未设置（可能被别的扩展占用）';

/** 把页面里所有提到键位的地方刷成当前键位（`[data-hotkey]` + 两处 JS 拼的文案）。 */
function applyHotkeyText(): void {
  for (const node of Array.from(document.querySelectorAll<HTMLElement>('[data-hotkey]'))) {
    node.textContent = hotkeyLabel;
  }
  // 总开关副标题按 enabled 状态拼，键位变了要按**当前**开关状态重拼一次
  renderEnabledState(el.enabled.checked);
}

function renderEnabledState(enabled: boolean): void {
  el.enabledLabel.textContent = enabled ? '翻译功能已开启' : '翻译功能已关闭';
  el.enabledSub.textContent = enabled
    ? `页面会出现翻译图标，${hotkeyLabel} 可用`
    : `图标不会出现，${hotkeyLabel} 也不响应`;
  el.disabledBanner.classList.toggle('hidden', enabled);
}

/**
 * 点图标落地方式的文案必须跟着开关变。
 *
 * ★ 只改 checkbox 不改文案，用户会看到「点图标回填原文」而实际行为是复制 ——
 *   那是界面在说谎，且**没有任何报错**。
 */
function renderIconFillState(fill: boolean): void {
  el.iconPathTitle.textContent = fill ? '点图标回填原文' : '点图标复制译文';
  el.iconActionDesc.textContent = fill
    ? '翻译并覆盖原框（会改掉你写的中文）。'
    : '翻译并复制到剪贴板（原输入一字不动），到别处直接粘贴。';
  el.iconFillLabel.textContent = fill ? '点图标时填充输入框' : '点图标时复制到剪贴板';
}

/* ── 渲染：翻译历史 ── */

const HISTORY_DISPLAY_MAX = 20;

function historyTime(at: number): string {
  try {
    return new Date(at).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function historyText(text: string, className: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = className;
  // ★ 不用 innerHTML：原文/译文来自用户输入，必须按纯文本渲染。
  div.textContent = text;
  return div;
}

async function copyHistoryTranslation(text: string, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = '已复制';
  } catch {
    button.textContent = '复制失败';
  } finally {
    window.setTimeout(() => {
      button.textContent = '复制译文';
      button.disabled = false;
    }, 1200);
  }
}

function renderHistoryEntry(entry: TranslationHistoryEntry): HTMLElement {
  const item = document.createElement('article');
  item.className = 't-history-item';
  item.setAttribute('role', 'listitem');

  const meta = document.createElement('div');
  meta.className = 't-history-meta';
  const time = document.createElement('span');
  time.className = 't-history-time';
  time.textContent = historyTime(entry.at);
  const engine = document.createElement('span');
  engine.className = 't-history-engine';
  engine.textContent = ENGINE_LABEL[entry.engine as Exclude<EngineId, 'auto'>] ?? entry.engine;
  const target = document.createElement('span');
  target.className = 't-history-target';
  target.textContent = `→ ${langName(entry.target)}`;
  meta.append(time, engine, target);
  if (entry.naming) {
    const naming = document.createElement('span');
    naming.className = 't-history-naming';
    naming.textContent = 'snake_case';
    meta.append(naming);
  }

  const pair = document.createElement('div');
  pair.className = 't-history-pair';
  const original = document.createElement('div');
  original.className = 't-history-side';
  const originalLabel = document.createElement('span');
  originalLabel.className = 't-history-label';
  originalLabel.textContent = '原文';
  original.append(originalLabel, historyText(entry.original, 't-history-text'));

  const translated = document.createElement('div');
  translated.className = 't-history-side';
  const translatedLabel = document.createElement('span');
  translatedLabel.className = 't-history-label';
  translatedLabel.textContent = '译文';
  translated.append(translatedLabel, historyText(entry.translated, 't-history-text is-result'));
  pair.append(original, translated);

  const actions = document.createElement('div');
  actions.className = 't-history-actions';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn-ghost btn-sm';
  copy.textContent = '复制译文';
  copy.addEventListener('click', () => void copyHistoryTranslation(entry.translated, copy));
  actions.append(copy);

  item.append(meta, pair, actions);
  return item;
}

async function renderHistory(): Promise<void> {
  const entries = (await loadTranslationHistory()).slice(0, HISTORY_DISPLAY_MAX);
  el.historyList.replaceChildren();
  el.historyEmpty.classList.toggle('hidden', entries.length > 0);
  el.historyClear.disabled = entries.length === 0;
  for (const entry of entries) {
    el.historyList.append(renderHistoryEntry(entry));
  }
}

async function onClearHistory(): Promise<void> {
  if (!window.confirm('清空本机保存的全部翻译历史？此操作不可恢复。')) return;
  el.historyClear.disabled = true;
  try {
    await clearTranslationHistory();
    await renderHistory();
  } catch (e) {
    log.warn('清空翻译历史失败：%s', e instanceof Error ? e.message : String(e));
    el.historyClear.disabled = false;
  }
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
    icon_fill_enabled: el.iconFill.checked,
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
    // Key 与模型也在 local；留空 Key 只保存模型，不会误删已配置的 Key。
    await persistLlm();
    renderEnabledState(settings.translate_enabled);
    showFeedback('✓ 设置已保存');
  } catch (e) {
    showFeedback(`保存失败：${e instanceof Error ? e.message : String(e)}`, false);
  }
}

/* ── 快捷键真实键位（不要写死 "Ctrl+X"：用户可能已在快捷键页改过） ── */
async function renderHotkey(): Promise<void> {
  try {
    const commands = await chrome.commands.getAll();
    const hit = commands.find((c) => c.name === TRANSLATE_COMMAND);
    const key = hit?.shortcut ?? '';
    hotkeyShortcut = key;
    // ★ 空键位这条分支很重要：`shortcut` 为空 = 键位被清掉 or 被别的扩展占用，
    //   而**用户只会看到"按了没反应"**。必须在这里说清楚。
    hotkeyLabel = key || '未设置（可能被别的扩展占用）';
  } catch {
    // `chrome.commands` 极少数环境不可用 —— 保留 manifest 里的默认键位
  }
  applyHotkeyText();
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
      // 把**真实键位**一起带过去：内容脚本拿不到 `chrome.commands`，而它的 Toast
      // 要告诉用户"再按 <键位>"——写死就会在用户改键之后说谎。
      await chrome.tabs.sendMessage(tab.id, {
        type: TRANSLATE_MESSAGE.hotkey,
        shortcut: hotkeyShortcut,
      });
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

  // 改键页按**家族**给地址：Edge 上 `chrome://…` 会被自动改写成 `edge://…`，
  // 但反过来不行（Chrome 打开 `edge://` 只得到空地址死页签，2026-11-09 实测）。
  el.shortcutLink.textContent = shortcutsPageText();
  el.shortcutLink.addEventListener('click', (e) => {
    e.preventDefault();
    void chrome.tabs.create({ url: shortcutsPageUrl() });
  });

  renderLangOptions();
  renderLlmModels('deepseek-flash');
  llmSettings = await loadLlmOrDefault();
  renderLlmModels(llmSettings.model);
  renderLlmState();
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
      icon_fill_enabled: true,
      target_language: 'en',
      source_language: 'auto',
      translation_provider: 'auto',
    };
  }

  el.enabled.checked = settings.translate_enabled;
  el.floatingIcon.checked = settings.floating_icon_enabled;
  el.iconFill.checked = settings.icon_fill_enabled;
  el.targetLang.value = settings.target_language;
  renderEngines(settings.translation_provider);
  renderEnabledState(settings.translate_enabled);
  renderIconFillState(settings.icon_fill_enabled);

  // 高级区默认展开：**宁可多露一点，也不要"藏在折叠里等于没做"**
  // （本仓规则 40 的同族：读不到 = 不存在）。用户嫌长可以自己折起来。
  el.adv.open = true;

  // 总开关与图标开关**改动即存**（这两个是高频动作，用户不会愿意再点一次"保存"）
  el.enabled.addEventListener('change', () => {
    renderEnabledState(el.enabled.checked);
    void onSave();
  });
  el.floatingIcon.addEventListener('change', () => void onSave());
  el.iconFill.addEventListener('change', () => {
    renderIconFillState(el.iconFill.checked);
    void onSave();
  });

  el.saveBtn.addEventListener('click', () => void onSave());
  el.testBtn.addEventListener('click', () => void onTest());
  el.llmTest.addEventListener('click', () => void onDeepseekTest());
  el.llmClear.addEventListener('click', () => void onClearDeepseek());
  el.historyClear.addEventListener('click', () => void onClearHistory());

  // 引擎卡高亮跟随选择（只改视觉，不改行为）
  el.engineList.addEventListener('change', () => {
    const cur = selectedEngine();
    for (const card of Array.from(el.engineList.querySelectorAll<HTMLElement>('.t-engine'))) {
      card.classList.toggle('is-active', card.dataset.engine === cur);
    }
    renderAdvCurrent();
  });

  el.targetLang.addEventListener('change', renderAdvCurrent);

  await Promise.all([renderStats(), renderHotkey(), renderHistory()]);

  // 别处改了设置（另一个页面 / 别的设备同步过来）→ 本页跟着刷新，不留旧值
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      void loadTranslationSettings().then((next) => {
        el.enabled.checked = next.translate_enabled;
        el.floatingIcon.checked = next.floating_icon_enabled;
        el.iconFill.checked = next.icon_fill_enabled;
        el.targetLang.value = next.target_language;
        renderEngines(next.translation_provider);
        renderEnabledState(next.translate_enabled);
        renderIconFillState(next.icon_fill_enabled);
      });
    } else if (area === 'local') {
      // 翻译发生在别的页面 → 统计变了就刷新（不需要轮询）
      void renderStats();
      if (changes[TRANSLATION_HISTORY_KEY]) {
        void renderHistory();
      }
      // Key/模型可能被另一个设置页改了；只在这一个键变化时重读，避免统计刷新也读凭据
      if (changes[LLM_SETTINGS_KEY]) {
        void loadLlmOrDefault().then((next) => {
          llmSettings = next;
          renderLlmModels(next.model);
          renderLlmState();
        });
      }
    }
  });
}

void init();
