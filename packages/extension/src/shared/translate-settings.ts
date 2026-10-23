/**
 * 翻译设置的**唯一定义处**（类型 + 默认值 + 读写 + 越界修正）。
 *
 * # 存储位置：`chrome.storage.sync`（与 akso-pass 的账号数据刻意分开）
 *
 * | 数据 | 存哪 | 为什么 |
 * |---|---|---|
 * | **账号库**（站名/账号/口令） | **云端**（`akso-cloud`） | v3.18 起强制云端，本机不留 |
 * | **翻译偏好**（目标语言/引擎/开关） | `storage.sync` | 它不是账号数据；跨设备同步是原本就有的行为，零迁移成本 |
 * | **翻译次数统计** | `storage.local` | 高频写；`sync` 有写入配额（原扩展也是这么分的，理由成立） |
 *
 * ★ **翻译设置里绝不能出现账号信息** —— `storage.sync` 会同步到用户的 Google 账号。
 *   本文件只放偏好，不放任何口令/站名（与规则 3 同一条纪律）。
 *
 * # ★ 所有取值都必须过一遍 `normalize()` 才能用
 *
 * 设置可能存在三种"不是我们写进去的"状态：① 老版本写的（引擎值已改名）；
 * ② 用户在别的设备改过（sync 同步过来）；③ 用户手改 storage（排障时真会这么干）。
 * ⇒ 任何一处直接用 `settings.xxx` 都是**信任外部输入**。所以只暴露 `load()`，
 *   它在返回前一律 `normalize()`。
 */
import { normalizeEngineId, type EngineId } from './engines';

/** 目标语言白名单（15 种，与原扩展一致）。`code` 是引擎侧语言码，`label` 是面板显示名 */
export const TARGET_LANGUAGES = [
  { code: 'en', label: '英语 (English)' },
  { code: 'zh-CN', label: '中文简体' },
  { code: 'zh-TW', label: '中文繁体' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'pt', label: '葡萄牙语' },
  { code: 'ru', label: '俄语' },
  { code: 'ar', label: '阿拉伯语' },
  { code: 'it', label: '意大利语' },
  { code: 'vi', label: '越南语' },
  { code: 'th', label: '泰语' },
  { code: 'id', label: '印尼语' },
] as const;

export interface TranslationSettings {
  /** 翻译功能总开关（关掉后：图标不出现、Ctrl+X 不响应） */
  translate_enabled: boolean;
  /** ★ 浮动翻译图标是否出现（用户 2026-10-12 明确要求把它变成"可选项"） */
  floating_icon_enabled: boolean;
  /**
   * ★ 2026-10-21：点击浮动图标时的落地方式。
   *
   * - `true`（默认，保持旧行为）：翻译并**覆盖输入框**；
   * - `false`：翻译并**只复制到剪贴板**，原输入不动。
   *
   * `Ctrl+X` 不受此开关影响，始终只复制。
   */
  icon_fill_enabled: boolean;
  target_language: string;
  source_language: string;
  translation_provider: EngineId;
  /** 命名规范模式：结果转 snake_case（字段名场景） */
  naming_convention_mode: boolean;
}

export const TRANSLATION_DEFAULTS: TranslationSettings = {
  translate_enabled: true,
  floating_icon_enabled: true,
  icon_fill_enabled: true,
  target_language: 'en',
  source_language: 'auto',
  translation_provider: 'auto',
  naming_convention_mode: false,
};

const SYNC_KEYS = Object.keys(TRANSLATION_DEFAULTS) as (keyof TranslationSettings)[];

/** 语言码白名单（防止把手改过的野值直接喂给引擎拼 URL） */
const LANG_CODES = new Set<string>(TARGET_LANGUAGES.map((l) => l.code));

/** 把任意来源的设置修成**一定可用**的形态。导出是为了让判据能直接测它（纯函数，零依赖） */
export function normalizeTranslationSettings(raw: unknown): TranslationSettings {
  const r = (raw ?? {}) as Partial<Record<keyof TranslationSettings, unknown>>;
  const lang = String(r.target_language ?? '');
  return {
    // 布尔一律 `=== true`：`"false"` 字符串是 truthy，而手改 storage 真的会产生它
    translate_enabled: r.translate_enabled !== false,
    floating_icon_enabled: r.floating_icon_enabled !== false,
    icon_fill_enabled: r.icon_fill_enabled !== false,
    target_language: LANG_CODES.has(lang) ? lang : TRANSLATION_DEFAULTS.target_language,
    source_language: String(r.source_language ?? TRANSLATION_DEFAULTS.source_language),
    translation_provider: normalizeEngineId(r.translation_provider),
    naming_convention_mode: r.naming_convention_mode === true,
  };
}

/** 读设置（已 normalize）。`area` 可注入以便判据用假 storage 测 */
export async function loadTranslationSettings(
  area: chrome.storage.StorageArea = chrome.storage.sync,
): Promise<TranslationSettings> {
  const stored = await area.get(TRANSLATION_DEFAULTS as unknown as Record<string, unknown>);
  return normalizeTranslationSettings(stored);
}

/** 写设置（只写白名单键，不整包覆盖 —— 避免把同 area 里别人的键抹掉） */
export async function saveTranslationSettings(
  patch: Partial<TranslationSettings>,
  area: chrome.storage.StorageArea = chrome.storage.sync,
): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const k of SYNC_KEYS) {
    if (k in patch) {
      out[k] = patch[k];
    }
  }
  await area.set(out);
}
