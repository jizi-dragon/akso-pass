/**
 * 翻译次数统计（存在 `chrome.storage.local`）。
 *
 * # 为什么是 `local` 而不是 `sync`
 *
 * 它是**高频写**（每成功翻译一次 +1），而 `chrome.storage.sync` 有写入配额
 * （约 120 次/分钟、1800 次/小时），超了会抛错并**静默丢掉这次写入**。
 * 统计丢了不会有人发现，所以这一类数据不能放 sync（原扩展的分法是对的）。
 *
 * # 只统计**成功**的翻译
 *
 * 失败、空结果、被校验拦下的都不 +1 —— 否则"翻译次数"会变成"点击次数"，
 * 而用户拿它判断"我这周用了多少"，虚高就失去意义。
 *
 * # 上界是**刻意**的
 *
 * 1000 天 / 120 个月：不加界的话 `storage.local` 会无限增长
 * （每次翻译都新建一个日期键），几年后单这一个键就能到几百 KB。
 */
import { TRANSLATION_STATS_KEY } from './constants';

export interface TranslationStats {
  total: number;
  /** `YYYY-MM` → 次数 */
  months: Record<string, number>;
  /** `YYYY-MM-DD` → 次数 */
  days: Record<string, number>;
}

const EMPTY_STATS: TranslationStats = { total: 0, months: {}, days: {} };

/** 保留窗口：天 / 月。**不要**把它们当"随手写的常数"——见文件头。 */
export const STATS_KEEP_DAYS = 90;
export const STATS_KEEP_MONTHS = 12;

/** 本地日期键（**不能用 `toISOString()`**：那是 UTC，东八区凌晨会算到前一天） */
export function dateKeys(now: Date = new Date()): { day: string; month: string } {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return { day: `${y}-${m}-${d}`, month: `${y}-${m}` };
}

/** 读统计（总是返回合法结构，不返回 undefined） */
export async function readStats(
  area: chrome.storage.StorageArea = chrome.storage.local,
): Promise<TranslationStats> {
  const stored = await area.get({ [TRANSLATION_STATS_KEY]: EMPTY_STATS });
  const raw = stored[TRANSLATION_STATS_KEY] as Partial<TranslationStats> | undefined;
  return {
    total: typeof raw?.total === 'number' ? raw.total : 0,
    months: raw?.months && typeof raw.months === 'object' ? raw.months : {},
    days: raw?.days && typeof raw.days === 'object' ? raw.days : {},
  };
}

/** +1 并落盘，返回更新后的快照（供 UI 立即刷新，避免再读一次） */
export async function incrementStats(
  area: chrome.storage.StorageArea = chrome.storage.local,
  now: Date = new Date(),
): Promise<TranslationStats> {
  const stats = await readStats(area);
  const { day, month } = dateKeys(now);

  stats.total += 1;
  stats.months[month] = (stats.months[month] ?? 0) + 1;
  stats.days[day] = (stats.days[day] ?? 0) + 1;

  // 裁剪到保留窗口（按**字典序**排序即可：日期键就是为可排序而设计的定长格式）
  const days = Object.keys(stats.days).sort();
  if (days.length > STATS_KEEP_DAYS) {
    for (const k of days.slice(0, days.length - STATS_KEEP_DAYS)) {
      delete stats.days[k];
    }
  }
  const months = Object.keys(stats.months).sort();
  if (months.length > STATS_KEEP_MONTHS) {
    for (const k of months.slice(0, months.length - STATS_KEEP_MONTHS)) {
      delete stats.months[k];
    }
  }

  await area.set({ [TRANSLATION_STATS_KEY]: stats });
  return stats;
}
