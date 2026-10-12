/**
 * 4 路免费翻译引擎（**无 API Key，公网直连**）。
 *
 * # 为什么在 `shared/` 而不是 `content/`
 *
 * 本仓规则 10：`content_scripts` 的注入体积是**敏感资源**。引擎适配器（含 4 个
 * 语言码映射表）合起来约 8 KB，而它**只在 background 里跑**（页面只发一条消息）。
 * ⇒ 放 `content/` 等于给**每一个页面、每一个 frame** 白送 8 KB。
 *
 * # ★ 数据出境（必须让用户知道）
 *
 * 这 4 个引擎都是**公网第三方接口**，翻译请求会把**输入框原文**发出去：
 * TranSmart / 有道（腾讯 / 网易，国内）、MyMemory / Lingva（海外）。
 * 用户已在 2026-10-12 确认"内部工具、可用公网引擎"，但**这条事实要写在
 * 翻译面板上**——不能只在代码注释里（规则 25：先问"失败时用户会看到什么"）。
 *
 * # 语言码三套并存（这不是冗余，是各家的真实要求）
 *
 * | 引擎 | 语言码形态 | 例 |
 * |---|---|---|
 * | MyMemory | ISO 639-1 + 地区 | `en-US` / `zh-CN` |
 * | TranSmart | BCP-47 主标签 | `zh` / `en` |
 * | Lingva | 主标签（`zh-*` 一律压成 `zh`） | `zh` / `en` |
 * | 有道 | **不接受语言参数** ⇒ 只服务中↔英方向 | — |
 *
 * ⇒ 有道那一格是**能力缺口**而不是写法问题：选日语时它会返回中文释义或直接失败，
 *   由兜底引擎接管。翻译面板里已按此标注。
 */
import { withTimeout } from './net';
import { looksLikeDictionaryEntry } from './snake-case';

export type EngineId = 'auto' | 'transmart' | 'youdao' | 'mymemory' | 'lingva';

/** 单个引擎的超时（原扩展=8000ms，实测国内引擎 100-500ms、海外常在 1-3s） */
export const TRANSLATE_TIMEOUT_MS = 8000;

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

/** TranSmart 用 BCP-47 主标签 */
const TRANSMART_LANG_MAP: Record<string, string> = {
  auto: 'auto',
  'zh-CN': 'zh',
  'zh-TW': 'zh',
  en: 'en',
  ja: 'ja',
  ko: 'ko',
  fr: 'fr',
  de: 'de',
  es: 'es',
  pt: 'pt',
  ru: 'ru',
  ar: 'ar',
  it: 'it',
  vi: 'vi',
  th: 'th',
  id: 'id',
};

function mapLang(map: Record<string, string>, code: string, fallback: string): string {
  const hit = map[code];
  return hit !== undefined ? hit : fallback;
}

/** 引擎的**人类可读名**（错误信息里要报得出是谁失败了） */
export const ENGINE_LABEL: Record<Exclude<EngineId, 'auto'>, string> = {
  transmart: '腾讯交互翻译 TranSmart',
  youdao: '网易有道词典',
  mymemory: 'MyMemory',
  lingva: 'Lingva',
};

/* ────────────────────────── 1. TranSmart（主引擎） ────────────────────────── */

/**
 * 腾讯交互翻译 `POST https://transmart.qq.com/api/imt`（国内直连、无需 Key）。
 *
 * ★ `client_key` 每次请求都换一个：这是照搬原扩展的做法，实测能提高稳定性。
 *   `credentials: 'omit'` 是刻意的 —— 这是第三方接口，不该带任何 cookie。
 */
async function viaTransmart(text: string, target: string, source: string): Promise<string> {
  const clientKey =
    `browser-chrome-${navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || '120'}` +
    `-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const resp = await fetch('https://transmart.qq.com/api/imt', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Referer: 'https://transmart.qq.com/',
      Origin: 'https://transmart.qq.com',
      'User-Agent': BROWSER_UA,
    },
    body: JSON.stringify({
      header: { fn: 'auto_translation', session: '', client_key: clientKey, user: '' },
      type: 'plain',
      model_category: 'normal',
      text_domain: 'general',
      source: { lang: mapLang(TRANSMART_LANG_MAP, source, 'auto'), text_list: [text] },
      target: { lang: mapLang(TRANSMART_LANG_MAP, target, 'en') },
    }),
    credentials: 'omit',
  });

  if (!resp.ok) {
    throw new Error(`TranSmart HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as {
    header?: { ret_code?: string };
    auto_translation?: unknown;
  };
  if (data.header?.ret_code && data.header.ret_code !== 'succ') {
    throw new Error(`TranSmart 返回错误: ${data.header.ret_code}`);
  }
  const out = data.auto_translation;
  if (!Array.isArray(out) || out.length === 0) {
    throw new Error('TranSmart 返回数据为空');
  }
  return out.map(String).join('\n');
}

/* ────────────────────────── 2. 有道词典（第二国内引擎） ────────────────────────── */

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

/* ────────────────────────── 3. MyMemory（海外备用） ────────────────────────── */

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

/* ────────────────────────── 4. Lingva（最终兜底） ────────────────────────── */

async function viaLingva(text: string, target: string, source: string): Promise<string> {
  const code = (c: string): string => {
    if (c === 'auto') return 'auto';
    if (c === 'zh-CN' || c === 'zh-TW') return 'zh';
    return c.split('-')[0];
  };
  const url =
    `https://lingva.ml/api/v1/${code(source)}/${code(target)}/${encodeURIComponent(text)}`;

  const resp = await fetch(url, { method: 'GET' });
  if (!resp.ok) {
    throw new Error(`Lingva HTTP ${resp.status}`);
  }
  const data = (await resp.json()) as { translation?: string };
  if (!data.translation) {
    throw new Error('Lingva 返回数据为空');
  }
  return data.translation;
}

/* ────────────────────────── 调度 ────────────────────────── */

const IMPL: Record<Exclude<EngineId, 'auto'>, (t: string, tg: string, s: string) => Promise<string>> = {
  transmart: viaTransmart,
  youdao: viaYoudao,
  mymemory: viaMyMemory,
  lingva: viaLingva,
};

export interface TranslateResult {
  text: string;
  /** 实际生效的引擎（自动模式赛马后，调用方需要知道是谁赢的——诊断与统计都要） */
  engine: Exclude<EngineId, 'auto'>;
}

/**
 * 自动模式：**第一轮两个国内引擎并行赛马**（谁快用谁）→ MyMemory → Lingva。
 *
 * ★ 为什么用 `Promise.any` 而不是串行：国内两路各有 ~1% 的偶发慢/挂，
 *   串行会把最坏延迟叠加成"两次超时"；赛马只取最快那次，最坏延迟 = 单次超时。
 * ★ 错误**全量累积**到最终消息里 —— 只报"翻译失败"会让现场无法定位是哪一路挂了。
 */
async function translateAuto(text: string, target: string, source: string): Promise<TranslateResult> {
  const errors: string[] = [];
  /**
   * ★★ 第一轮赛马要**过滤掉词典释义**（2026-10-12 实测事故）。
   *
   * 有道走的是"网络释义"接口，返回词条而非句子 —— 实测 `行动措施` 得到
   * `take action /measures /steps to do sth`。在赛马里它是**最快返回**的一方，
   * 于是 `Promise.any` 直接把它当赢家 ⇒ 用户拿到一串带 `/` 与 `to do sth` 的词典文本，
   * 贴进下一个输入框完全不可用，而界面还提示"✅ 已翻译"。
   *
   * ⇒ 判据改成"**返回了可用结果**"才算赢：拿到词典释义就**主动 reject**，
   *   让 `Promise.any` 继续等另一路（TranSmart 是真正的翻译器），
   *   两路都不可用才落到海外兜底。
   */
  const race = (['transmart', 'youdao'] as const).map((id) =>
    withTimeout(IMPL[id](text, target, source), TRANSLATE_TIMEOUT_MS, ENGINE_LABEL[id])
      .then((t) => {
        if (looksLikeDictionaryEntry(t)) {
          throw new Error(`${ENGINE_LABEL[id]} 返回的是词典释义（含「/」或「sth/sb」），不是可用译文`);
        }
        return { text: t, engine: id };
      })
      .catch((e: unknown) => {
        errors.push(`${ENGINE_LABEL[id]}: ${e instanceof Error ? e.message : String(e)}`);
        throw e;
      }),
  );

  try {
    return await Promise.any(race);
  } catch {
    // 两路国内引擎都不可用（失败 / 或结果不可用）—— 继续走海外兜底，这里**不抛**
  }

  for (const id of ['mymemory', 'lingva'] as const) {
    try {
      const text2 = await withTimeout(IMPL[id](text, target, source), TRANSLATE_TIMEOUT_MS, ENGINE_LABEL[id]);
      if (looksLikeDictionaryEntry(text2)) {
        throw new Error(`${ENGINE_LABEL[id]} 返回的结果不可用（词典式）`);
      }
      return { text: text2, engine: id };
    } catch (e) {
      errors.push(`${ENGINE_LABEL[id]}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  throw new Error(`所有翻译引擎均不可用，请检查网络。\n详情: ${errors.join(' | ')}`);
}

/**
 * 按设置翻译。`engine='auto'` 走赛马 + 兜底；指定引擎则单路。
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
  const out = await withTimeout(IMPL[engine](text, target, source), TRANSLATE_TIMEOUT_MS, ENGINE_LABEL[engine]);
  return { text: out, engine };
}

/**
 * ★ 旧引擎值的向后兼容（原扩展 v1.4.1 之前的设置值）。
 *
 * 为什么必须有：设置存在 `chrome.storage.sync`，**升级不会清掉旧值**。
 * 不认这两个值的话，老用户升级后落进 `default` 分支（自动模式）——
 * 那不是错，但用户会以为自己选的引擎"没生效"，而**界面上看不出原因**。
 */
export function normalizeEngineId(raw: unknown): EngineId {
  const legacy: Record<string, EngineId> = { tencent_web: 'transmart', google_free: 'transmart' };
  const v = String(raw ?? '');
  if (v in legacy) return legacy[v];
  if (v === 'transmart' || v === 'youdao' || v === 'mymemory' || v === 'lingva' || v === 'auto') {
    return v;
  }
  return 'auto';
}
