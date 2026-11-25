/**
 * DeepSeek BYOK 设置（**只存 chrome.storage.local**）。
 *
 * # 为什么不和翻译偏好一起放 sync
 *
 * API Key 是**凭据**，不是偏好。`chrome.storage.sync` 会把内容同步到用户的
 * Google 账号与其它设备；把 Key 放进去等于扩大泄露面。这里刻意只写 local，
 * 并且不让 `translate-settings.ts` 知道 Key 的存在。
 *
 * # 为什么模型选择也放 local
 *
 * 它和 Key 是同一组配置（都用 DeepSeek），放一起避免“Key 在 local、模型在
 * sync，换设备后模型对但 Key 没了”的半套状态。
 *
 * # 隐私约束
 *
 * - 不写日志、不进诊断包、不拼进错误消息；
 * - 设置页只回显脱敏值（`maskKey`），不把完整 Key 塞进 DOM 的 title/placeholder；
 * - 请求由扩展 service worker 直接发往 `https://api.deepseek.com`，不经过本项目服务器。
 */

/** DeepSeek 当前可用的模型（2026-11-26 官方模型页）。 */
export const DEEPSEEK_MODELS = [
  {
    id: 'deepseek-flash',
    label: 'DeepSeek Flash（推荐）',
    desc: '快、便宜，适合日常翻译；非思考模式。',
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    desc: '质量更高、价格更贵，适合长文/术语密集内容。',
  },
] as const;

export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number]['id'];

export interface LlmSettings {
  /** 完整 API Key；空串表示未配置。**绝不出现在日志/诊断包里** */
  api_key: string;
  model: DeepSeekModel;
}

export const LLM_SETTINGS_KEY = 'ql:llmSettings';

export const LLM_DEFAULTS: LlmSettings = {
  api_key: '',
  model: 'deepseek-flash',
};

const MODEL_IDS = new Set<string>(DEEPSEEK_MODELS.map((m) => m.id));

/** 修成一定可用的形状；手改 storage/旧版本值都走这里。 */
export function normalizeLlmSettings(raw: unknown): LlmSettings {
  const r = (raw ?? {}) as Partial<Record<keyof LlmSettings, unknown>>;
  const model = String(r.model ?? '');
  return {
    // 只 trim 首尾空白；Key 中间不可能有空白，但粘贴时常带换行
    api_key: typeof r.api_key === 'string' ? r.api_key.trim() : '',
    model: MODEL_IDS.has(model) ? (model as DeepSeekModel) : LLM_DEFAULTS.model,
  };
}

export async function loadLlmSettings(
  area: chrome.storage.StorageArea = chrome.storage.local,
): Promise<LlmSettings> {
  const stored = await area.get({ [LLM_SETTINGS_KEY]: LLM_DEFAULTS });
  return normalizeLlmSettings(stored[LLM_SETTINGS_KEY]);
}

/** 只写白名单字段，不整包覆盖；`api_key: ''` 表示删除。 */
export async function saveLlmSettings(
  patch: Partial<LlmSettings>,
  area: chrome.storage.StorageArea = chrome.storage.local,
): Promise<void> {
  const current = await loadLlmSettings(area);
  const next: LlmSettings = normalizeLlmSettings({ ...current, ...patch });
  await area.set({ [LLM_SETTINGS_KEY]: next });
}

export function hasDeepSeekKey(settings: LlmSettings): boolean {
  return settings.api_key.length > 0;
}

/** 只用于设置页回显：`sk-abc…wxyz`。空 Key 返回空串。 */
export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 10) return '已配置（长度 ' + key.length + '）';
  return key.slice(0, 6) + '…' + key.slice(-4);
}
