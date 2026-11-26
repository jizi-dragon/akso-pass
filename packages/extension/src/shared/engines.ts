/**
 * 2 路免费翻译引擎（**无 API Key，公网直连**）。
 *
 * # 为什么在 `shared/` 而不是 `content/`
 *
 * 本仓规则 10：`content_scripts` 的注入体积是**敏感资源**。引擎适配器（含语言码
 * 映射表）合起来几 KB，而它**只在 background 里跑**（页面只发一条消息）。
 * ⇒ 放 `content/` 等于给**每一个页面、每一个 frame** 白送这几 KB。
 *
 * # ★ 数据出境（必须让用户知道）
 *
 * 这 2 个引擎都是**公网第三方接口**，翻译请求会把**输入框原文**发出去：
 * 有道（网易，国内）、MyMemory（海外）。用户已在 2026-10-12 确认"内部工具、
 * 可用公网引擎"，但**这条事实要写在翻译面板上**——不能只在代码注释里（规则 25：
 * 先问"失败时用户会看到什么"）。
 *
 * # 4.6.6 起只剩两路（2026-11-26 实测后移除）
 *
 * | 引擎 | 处置 | 依据 |
 * |---|---|---|
 * | 腾讯 TranSmart | **移除** | `transmart.qq.com:443` TCP 连不上（20s 超时、DNS 一致、外部已报服务停运），每次请求都白等满 8s |
 * | Lingva | **移除** | `lingva.ml` 20/20 都是 **HTTP 403**（Cloudflare），从来没成功过 |
 *
 * 留下的两路**互补**：有道是"查词"（短词 20–50ms，命中率高，但整句 no-entry）、
 * MyMemory 是"翻整句"（1–2s）。所以自动模式是**串行 有道 → MyMemory**：
 * 句子只多花有道的约 40ms；短词命中时**根本不会**把原文再发给海外那一跳
 * （规则 25 的另一半：既让用户看到结果，也把数据出境面压到最小）。
 *
 * # 语言码两套并存（这不是冗余，是各家的真实要求）
 *
 * | 引擎 | 语言码形态 | 例 |
 * |---|---|---|
 * | MyMemory | ISO 639-1 + 地区 | `en-US` / `zh-CN` |
 * | 有道 | **不接受语言参数** ⇒ 只服务中↔英方向 | — |
 *
 * ⇒ 有道那一格是**能力缺口**而不是写法问题：选日语时它会返回中文释义或直接失败，
 *   由 MyMemory 接管。翻译面板里已按此标注。
 */
import { withTimeout } from './net';
import { looksLikeDictionaryEntry } from './snake-case';
import { loadLlmSettings, type LlmSettings } from './llm-settings';
import { translateWithDeepSeek } from './deepseek';

export type EngineId = 'auto' | 'deepseek' | 'youdao' | 'mymemory';

/** 单路免费引擎的超时上限（原扩展=8000ms；MyMemory 实测 p99≈2.1s，8s 是海外抖动余量） */
export const TRANSLATE_TIMEOUT_MS = 8000;

/** 有道是"查词"，正常 20–50ms；3s 还不回来就是真卡住，不值得让整句陪它等满 8s */
const YOUDAO_TIMEOUT_MS = 3000;

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/** MyMemory 用 ISO 639-1 + 地区 */
const MYMEMORY_LANG_MAP: Record<string, string> = {
  auto: 'zh-CN',
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-TW',
  en: 'en-US',
  ja: 'ja-JP',
  ko: 'ko-KR',
  fr: 'fr-FR',
  de: 'de-DE',
  es: 'es-ES',
  pt: 'pt-BR',
  ru: 'ru-RU',
  ar: 'ar-SA',
  it: 'it-IT',
  vi: 'vi-VN',
  th: 'th-TH',
  id: 'id-ID',
};

/** 引擎的**人类可读名**（错误信息里要报得出是谁失败了） */
export const ENGINE_LABEL: Record<Exclude<EngineId, 'auto'>, string> = {
  deepseek: 'DeepSeek',
  youdao: '网易有道词典',
  mymemory: 'MyMemory',
};

/* ────────────────────────── 1. 有道词典（主引擎：查词） ────────────────────────── */

/**
 * 网易有道 `GET https://dict.youdao.com/jsonapi`（国内托管，无需签名/Key）。
 *
 * ★ 它取的是**网络释义首条**——这是"词典"而不是"翻译器"。原扩展刻意选它，
 *   因为**命名规范场景都是短字段名**（查词典比整句翻译更准）。
 * ★ 不接受语言参数 ⇒ 只服务中↔英。其余方向靠兜底引擎。
 * ★ 两个"看起来成功其实没翻"的坑都在这里挡住：无收录、以及结果与原文完全相同。
 */
async function viaYoudao(text: string, _target: string, _source: string): Promise<string> {
  const url =
    `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(text)}` +
    `&dicts=${encodeURIComponent('{"count":99,"dicts":[["web_trans"]]}')}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'User-Agent': BROWSER_UA, Referer: 'https://dict.youdao.com/' },
  });
  if (!resp.ok) {
    throw new Error(`有道 HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    web_trans?: { 'web-translation'?: { trans?: { value?: string }[] }[] };
  };
  const wt = data.web_trans?.['web-translation'];
  if (!Array.isArray(wt) || wt.length === 0) {
    throw new Error('有道未收录该词（生僻短语），自动切换兜底引擎');
  }

  const raw = wt[0]?.trans?.[0]?.value;
  // 去掉可能夹带的 HTML 标签（该接口的 value 有时是 `<b>xx</b>` 形态）
  const result = String(raw ?? '')
    .replace(/<[^>]+>/g, '')
    .trim();

  if (!result) {
    throw new Error('有道返回数据为空');
  }
  if (result.toLowerCase() === text.trim().toLowerCase()) {
    throw new Error('有道未提供有效翻译');
  }
  return result;
}

/* ────────────────────────── 2. MyMemory（翻整句的那一路） ────────────────────────── */

async function viaMyMemory(text: string, target: string, source: string): Promise<string> {
  const from = source === 'auto' ? 'zh-CN' : MYMEMORY_LANG_MAP[source] || source;
  const to = MYMEMORY_LANG_MAP[target] || target;
  const url =
    `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(`${from}|${to}`)}`;

  const resp = await fetch(url, { method: 'GET' });
  if (!resp.ok) {
    throw new Error(`MyMemory HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as {
    responseStatus?: number | string;
    responseDetails?: string;
    responseData?: { translatedText?: string };
  };
  if (Number(data.responseStatus) !== 200) {
    throw new Error(`MyMemory: ${data.responseDetails || data.responseStatus}`);
  }
  const result = data.responseData?.translatedText;
  if (!result) {
    throw new Error('MyMemory 返回数据为空');
  }
  // ★ 该接口把"额度用尽"当成**正常返回**塞进正文 —— 不查这两个串就会把警告当译文填进输入框
  if (result.includes('MYMEMORY WARNING') || result.toUpperCase().includes('QUOTA')) {
    throw new Error('MyMemory 今日免费额度已用完');
  }
  return result;
}

/* ────────────────────────── 调度 ────────────────────────── */

type FreeEngineId = Exclude<EngineId, 'auto' | 'deepseek'>;

const IMPL: Record<FreeEngineId, (t: string, tg: string, s: string) => Promise<string>> = {
  youdao: viaYoudao,
  mymemory: viaMyMemory,
};

/** 自动模式的尝试顺序（4.6.6：有道查词 → MyMemory 翻整句；顺序即优先级） */
const FREE_ENGINES: readonly FreeEngineId[] = ['youdao', 'mymemory'];

/** 每一路自己的超时：查词不该陪整句一起等满 8s */
function timeoutOf(id: FreeEngineId): number {
  return id === 'youdao' ? YOUDAO_TIMEOUT_MS : TRANSLATE_TIMEOUT_MS;
}

/** 读取本地 Key；读失败（隐私模式等）按“未配置”处理，不影响免费链路。 */
async function loadDeepSeekSettings(): Promise<LlmSettings | null> {
  try {
    return await loadLlmSettings();
  } catch {
    return null;
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface TranslateResult {
  text: string;
  /** 实际生效的引擎（自动模式下最后成功的那一路——诊断与统计都要） */
  engine: Exclude<EngineId, 'auto'>;
}

/**
 * 自动模式：**串行 有道 → MyMemory**（4.6.6 起的两路）。
 *
 * ★ 为什么不再赛马：赛马的前提是"两路都活着、都能出可用结果"。4.6.6 移除了
 *   TranSmart（服务停运，TCP 连不上）与 Lingva（403），剩下的两路是**先后互补**的：
 *   有道查词只要 20–50ms，MyMemory 才是翻整句的那一路。
 *   ⇒ 串行比赛马**少一次出站请求**（短词命中时原文不会发去海外），
 *     最坏延迟也不再被一条死腿拖满 8s。
 * ★ 错误**全量累积**到最终消息里 —— 只报"翻译失败"会让现场无法定位是哪一路挂了。
 */
async function translateAuto(text: string, target: string, source: string): Promise<TranslateResult> {
  const errors: string[] = [];

  /* ★ 2026-11-26：auto 的优先级从“免费赛马”变成“有 Key 先 DeepSeek”。
   *
   * 为什么失败后**不直接抛**：auto 的契约是“尽量给结果”，用户配了 Key 但
   * 额度/网络临时不可用时，退回免费引擎比让快捷键整条失败更有用。显式选
   * `deepseek` 则相反——见 `translate()`。
   *
   * 为什么先读完 Key 再跑免费链路：没有 Key 时不能多发一次 storage 往返；
   * 也不能把 Key 读取失败当成“用户没配 Key”而静默——那只影响 auto，
   * 后面免费链路仍照常工作；显式 DeepSeek 会在 `translate()` 里报清楚。
   */
  const llm = await loadDeepSeekSettings();
  if (llm?.api_key) {
    try {
      return {
        text: await translateWithDeepSeek(text, target, source, llm),
        engine: 'deepseek',
      };
    } catch (e) {
      errors.push(`${ENGINE_LABEL.deepseek}: ${describeError(e)}`);
    }
  }

  /**
   * ★★ 免费这一轮仍要**过滤掉词典释义**（2026-10-12 实测事故）。
   *
   * 有道走的是"网络释义"接口，返回词条而非句子 —— 实测 `行动措施` 得到
   * `take action /measures /steps to do sth`。不拦的话，用户拿到一串带 `/` 与
   * `to do sth` 的词典文本，贴进下一个输入框完全不可用，而界面还提示"✅ 已翻译"。
   *
   * ⇒ 判据是"**返回了可用结果**"才算成功：拿到词典释义就**主动 reject**，
   *   继续落到 MyMemory（它是真正的翻译器）。
   */
  for (const id of FREE_ENGINES) {
    try {
      const out = await withTimeout(
        IMPL[id](text, target, source),
        timeoutOf(id),
        ENGINE_LABEL[id],
      );
      if (looksLikeDictionaryEntry(out)) {
        throw new Error(`${ENGINE_LABEL[id]} 返回的是词典释义（含「/」或「sth/sb」），不是可用译文`);
      }
      return { text: out, engine: id };
    } catch (e) {
      errors.push(`${ENGINE_LABEL[id]}: ${describeError(e)}`);
    }
  }

  throw new Error(`所有翻译引擎均不可用，请检查网络。\n详情: ${errors.join(' | ')}`);
}

/**
 * 按设置翻译。`engine='auto'` 走自动链路（DeepSeek → 有道 → MyMemory）；指定引擎则单路。
 *
 * ★ 单独指定引擎时**不做词典过滤**：那是用户明确的选择，把结果原样给他，
 *   由上层的结果校验决定要不要报错（这样"为什么没结果"能说清楚，而不是被这里悄悄换掉）。
 */
export async function translate(
  text: string,
  target: string,
  source: string,
  engine: EngineId,
): Promise<TranslateResult> {
  if (engine === 'auto') {
    return translateAuto(text, target, source);
  }

  /* ★ 显式选 DeepSeek 时**失败就报错**，不回落免费引擎。
   *
   * 用户选“DeepSeek”是为了质量；如果悄悄换成免费引擎，界面仍显示 DeepSeek，
   * 用户会以为大模型在生效。这里把“未配置 Key”和“调用失败”都如实抛出。
   */
  if (engine === 'deepseek') {
    const llm = await loadDeepSeekSettings();
    if (!llm?.api_key) {
      throw new Error('未配置 DeepSeek API Key，请在「翻译面板 → DeepSeek」中填写');
    }
    return { text: await translateWithDeepSeek(text, target, source, llm), engine: 'deepseek' };
  }

  const out = await withTimeout(IMPL[engine](text, target, source), timeoutOf(engine), ENGINE_LABEL[engine]);
  return { text: out, engine };
}

/**
 * ★ 旧引擎值的向后兼容（含 4.6.6 下架的两个）。
 *
 * 为什么必须有：设置存在 `chrome.storage.sync`，**升级不会清掉旧值**。
 * `transmart` / `lingva` 是 4.6.4 及以前能选的引擎，`tencent_web` / `google_free`
 * 更早 —— 这些值现在统一落回 `auto`。不这样的话，老用户升级后界面上会显示一个
 * 已经不存在的引擎，而**看不出原因**（用户会以为自己选的引擎"没生效"）。
 */
export function normalizeEngineId(raw: unknown): EngineId {
  const legacy: Record<string, EngineId> = {
    tencent_web: 'auto',
    google_free: 'auto',
    transmart: 'auto',
    lingva: 'auto',
  };
  const v = String(raw ?? '');
  if (v in legacy) return legacy[v];
  if (v === 'youdao' || v === 'mymemory' || v === 'deepseek' || v === 'auto') {
    return v;
  }
  return 'auto';
}
