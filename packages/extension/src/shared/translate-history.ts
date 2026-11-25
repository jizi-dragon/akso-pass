/**
 * 翻译历史（本地，纯展示）。
 *
 * # 为什么放在 service worker 的成功回调里
 *
 * 翻译有两个入口：Ctrl+X（内容脚本）和翻译面板的“试一次”。它们最终都走
 * `handleTranslateRequest()`；在面板里单独记会漏掉 Ctrl+X，在内容脚本里记
 * 会漏掉面板。只有成功回调这一处能保证“用户拿到的译文”和“历史里的译文”
 * 是同一份（也包含命名规范转换后的结果）。
 *
 * # 为什么只存 local
 *
 * 历史含用户翻译过的原文，可能包含业务字段/客户名。它只用于本机回看：
 * - 不放 `sync`（不跟浏览器账号走）；
 * - 不进日志、诊断包；
 * - 用户可一键清空。
 *
 * # 为什么上限 100 条
 *
 * 单条原文上限 8000 字符，100 条约 1.6 MB，仍在 `storage.local` 的安全范围内；
 * 面板只展示最近 20 条，避免把设置页撑得过长。
 */
import { TRANSLATION_HISTORY_KEY, TRANSLATION_HISTORY_MAX } from './constants';

export interface TranslationHistoryEntry {
  id: string;
  /** Unix ms */
  at: number;
  original: string;
  translated: string;
  /** 实际生效的引擎 id，如 deepseek / transmart */
  engine: string;
  target: string;
  /** 结果是否经过 snake_case 转换（历史里要看得出来） */
  naming: boolean;
}

type Area = chrome.storage.StorageArea;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function normalizeOne(raw: unknown): TranslationHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const original = typeof raw.original === 'string' ? raw.original : '';
  const translated = typeof raw.translated === 'string' ? raw.translated : '';
  if (!original || !translated) return null;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : Date.now();
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `${at}-${Math.random().toString(36).slice(2, 8)}`,
    at,
    original,
    translated,
    engine: typeof raw.engine === 'string' ? raw.engine : 'unknown',
    target: typeof raw.target === 'string' ? raw.target : '',
    naming: raw.naming === true,
  };
}

export function normalizeTranslationHistory(raw: unknown): TranslationHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(normalizeOne)
    .filter((e): e is TranslationHistoryEntry => e !== null)
    .slice(0, TRANSLATION_HISTORY_MAX);
}

export async function loadTranslationHistory(area: Area = chrome.storage.local): Promise<TranslationHistoryEntry[]> {
  try {
    const got = await area.get(TRANSLATION_HISTORY_KEY);
    return normalizeTranslationHistory(got[TRANSLATION_HISTORY_KEY]);
  } catch {
    // 读失败按“没有历史”处理：历史是辅助功能，不能影响翻译主链路。
    return [];
  }
}

/**
 * 串行化写入：SW 可能同时处理多个翻译请求，两个 `get` 都读到旧数组再 `set`
 * 会丢其中一条。用一个模块级 promise 链把“读-改-写”串起来。
 */
let writeChain: Promise<unknown> = Promise.resolve();

export function appendTranslationHistory(
  input: Omit<TranslationHistoryEntry, 'id' | 'at'>,
  area: Area = chrome.storage.local,
): Promise<TranslationHistoryEntry[]> {
  const run = writeChain.then(async () => {
    const list = await loadTranslationHistory(area);
    const entry: TranslationHistoryEntry = {
      ...input,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
    };
    const next = [entry, ...list].slice(0, TRANSLATION_HISTORY_MAX);
    await area.set({ [TRANSLATION_HISTORY_KEY]: next });
    return next;
  });
  // 单次失败不拖垮后续写入；调用方仍能拿到 rejection 自行决定是否忽略。
  writeChain = run.catch(() => undefined);
  return run;
}

export function clearTranslationHistory(area: Area = chrome.storage.local): Promise<void> {
  const run = writeChain.then(async () => {
    await area.remove(TRANSLATION_HISTORY_KEY);
  });
  writeChain = run.catch(() => undefined);
  return run;
}
