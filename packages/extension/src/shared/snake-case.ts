/**
 * 命名规范转换（snake_case）——**字段名场景的核心逻辑**。
 *
 * ★ 为什么放在 `shared/`：它有两个消费方 ——
 *   ① `content/translate.ts`（真实翻译结果落地前转换）；
 *   ② `ui/translate/translate.ts`（设置面板里的**实时预览**）。
 *   两边各写一份 = 同一套规则两份维护，而"改了一边"不会报错，
 *   只会让**预览与实际结果不一致**（用户看到 preview 是对的就信了）。
 *
 * ★ 本节规则逐条对应原扩展 `content.js` 的实现（2026-10-12 迁移），
 *   **但修掉了原实现里一处"注释承诺了代码没做"的地方** —— 见 `KEEP_AS_IS` 的说明。
 */

/** 长度上限：超过则按**完整单词**截断（不切断单词，否则字段名会变成半个词） */
export const SNAKE_MAX_LEN = 60;
/** 长度下限：短于它就不转换（3 个字母以下的词转出来没有意义，还会把 "OK" 变成 ""） */
export const SNAKE_MIN_LEN = 3;

/**
 * ★★ 原扩展 `content.js:212` 的注释写着「保留行业通用缩写（gmp/sop/qa 等）不拆分」，
 * 但**代码里从来没有这个实现** —— 全仓 `ABBR` / `abbrev` / `glossary` 零命中。
 *
 * 它当时"看起来是对的"纯属巧合：源文本是中文、`GMP`/`SOP` 本来就是大写，
 * 走一遍 `.toLowerCase()` 之后仍是 `gmp`/`sop` ——**没被拆分是因为压根没有拆分这一步**，
 * 不是因为有一条保留表在起作用。
 *
 * ⇒ 本文件把这件事**明确写下来**：下面这张表是**真正生效**的保留表（转小写后再还原），
 *   而不是注释。它修的是"引擎自己把缩写改大小写"这一类真实输入：
 *   `Gmp Document Management` / `Sop approval` / `Qa manager`。
 */
const KEEP_AS_IS = new Set([
  'gmp', 'sop', 'qa', 'qc', 'api', 'ui', 'ux', 'id', 'url', 'uri', 'http', 'https',
  'json', 'xml', 'sql', 'csv', 'pdf', 'html', 'css', 'js', 'ts', 'ip', 'os', 'db',
  'capa', 'dms', 'tms', 'erp', 'mes', 'lims', 'bom', 'sku', 'kpi', 'sla', 'rbac',
]);

/**
 * 把一段已翻译的文本转成 snake_case 字段名。
 *
 * 规则（顺序有意义，不要重排）：
 *   1. 含换行 ⇒ **原样返回**（多行是段落，不是字段名；转成一行会把内容毁掉）
 *   2. 全小写
 *   3. 括号内容拆成独立词：`Quality Deviation (QD)` → `quality_deviation_qd`
 *   4. 连字符 / 斜杠 / 点 → 下划线
 *   5. 空白（含连续）→ 下划线
 *   6. 剔除非法字符（只留 `a-z0-9_`）
 *   7. 合并连续下划线、去首尾下划线
 *   8. 超 60 按完整单词截断；短于 3 或为空 ⇒ 返回原文
 */
export function toSnakeCase(text: string): string {
  if (!text || typeof text !== 'string') {
    return text;
  }
  const trimmed = text.trim();

  // 1. 多行原样返回（v1.4.0 的行为：**只**跳过含换行的，单行不论多长都转）
  if (trimmed.includes('\n')) {
    return trimmed;
  }

  let result = trimmed
    .toLowerCase()
    // 3. 括号内容 → 独立词
    .replace(/\s*\(([^)]*)\)/g, (_m, inner: string) => `_${inner.trim()}`)
    // 4. 连字符/斜杠/点 → 下划线
    .replace(/[-/.]/g, '_')
    // 5. 空白 → 下划线
    .replace(/\s+/g, '_')
    // 6. 只留字母数字下划线
    .replace(/[^a-z0-9_]/g, '')
    // 7. 合并 / 去首尾
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  // ★ 缩写还原（把上表里的词还原成大写形态？不 —— 字段名规范要求**全小写**，
  //   所以这里的"保留"= **不把 `gmp` 再拆成 `g_m_p`**。它本来就不会被拆，
  //   这一步真正的价值是：**把引擎可能输出的 `Gmp`/`Sop` 归一成 `gmp`/`sop`**，
  //   并保证将来若加入分词逻辑时这些词不会被切碎。）
  result = result
    .split('_')
    .map((w) => (KEEP_AS_IS.has(w) ? w.toLowerCase() : w))
    .join('_');

  // 8. 超长按完整单词截断
  if (result.length > SNAKE_MAX_LEN) {
    const parts = result.split('_');
    let capped = '';
    for (const part of parts) {
      const candidate = capped ? `${capped}_${part}` : part;
      if (candidate.length <= SNAKE_MAX_LEN) {
        capped = candidate;
      } else {
        break;
      }
    }
    // 单个词就超长（没有下划线可切）⇒ 只能硬截
    result = capped || result.substring(0, SNAKE_MAX_LEN);
  }

  // 过短或空 ⇒ 返回原文（宁可不转，也不要给用户一个空字段名）
  if (!result || result.length < SNAKE_MIN_LEN) {
    return trimmed;
  }
  return result;
}

/**
 * 汉字检测（含扩展区与兼容区）。用于"目标语言是英文但结果还是中文"的失败判定 */
export function containsChinese(text: string): boolean {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/.test(text);
}

/**
 * 从站点地址推导一个**默认显示名**。
 *
 * # 为什么不是直接用完整 host
 *
 * 用户 2026-10-12 明确要求：没填名称时，**从地址里截取**，例如
 * `tonbridge-config.aksoegmp.com` → `tonbridge-config`。
 * 完整 host 当名字的问题是它把"识别"这件事推给用户：一排
 * `tonbridge-config.aksoegmp.com` / `standard-val.aksoegmp.com` / `www.dragonrain.top`
 * 各不相同却同样长，扫视时分不出谁是谁。
 *
 * # 规则（保持简单，方便预测）
 *
 * 1. 去掉端口（`10.100.0.105:8080` → `10.100.0.105`）
 * 2. 取第一个点号之前的部分（`a.b.c` → `a`）
 * 3. 结果若是 `www` ⇒ 用**第二段**（`www.dragonrain.top` → `dragonrain`）；
 *    只取 `www` 当名字等于什么都没说
 * 4. IP 字面量（全数字段）⇒ **整串原样返回**：`10.100` 比 `10.100.0.105` 更难认
 * 5. 兜底：算出来为空就返回原 host（宁可长，不要空）
 */
export function deriveSiteNameFromHost(host: string): string {
  const raw = (host ?? '').trim().toLowerCase();
  if (!raw) {
    return '';
  }
  const noPort = raw.replace(/:\d+$/, '');
  const parts = noPort.split('.').filter(Boolean);
  if (parts.length === 0) {
    return raw;
  }
  // IP 字面量：所有段都是数字 ⇒ 整串返回（截成 10.100 反而更难认）
  if (parts.every((p) => /^\d+$/.test(p))) {
    return noPort;
  }
  if (parts[0] === 'www') {
    return parts[1] ?? parts[0];
  }
  return parts[0];
}

/**
 * 识别**词典释义**而不是翻译结果。
 *
 * # 为什么需要它（2026-10-12 实测事故）
 *
 * 「网易有道词典」走的是 `dict.youdao.com/jsonapi` 的**网络释义**接口 ——
 * 它返回的是**词条**，不是句子。实测 `行动措施` 拿回来的是：
 *
 * ```
 * take action /measures /steps to do sth
 * ```
 *
 * ` / ` 分隔多个候选词条，末尾还有 `to do sth` 这种语法标注。
 * 在"自动模式"里它是赛马的一方 ⇒ **谁先返回用谁** ⇒ 用户拿到的是这串东西，
 * 贴到下一个输入框里完全不可用，而页面还提示"✅ 已翻译"。
 *
 * ⇒ 判据（保守，宁可误拒也不要放垃圾过去）：
 *   ① 含 ` / ` 或 `/ `（词典用斜杠并列词条；正常译文极少这样写）
 *   ② 含 `sth` / `sb`（词典的语法占位符）
 *
 * ★ 为什么放在"结果校验"而不是"有道的适配器里"：
 *   放适配器里，**用户手动选中「有道」时**就会直接失败，报错也不指向真正原因；
 *   放在校验里，它和其他"引擎给了不可用结果"的情况走同一条路 ——
 *   自动模式会**落到下一个引擎**，单独选有道时给出明确原因。
 */
export function looksLikeDictionaryEntry(text: string): boolean {
  if (/ \/ |\/ /.test(text)) {
    return true;
  }
  if (/\b(?:sth|sb)\b/i.test(text)) {
    return true;
  }
  return false;
}

/**
 * 翻译**有效性**校验：返回 `null` = 通过，返回字符串 = 失败原因。
 *
 * ★ 这是 v1.4.1 的修复，必须保留：引擎在**识别不了源语言**时会**原样返回输入**，
 *   而那是 HTTP 200 + 非空 ⇒ 不做这项检查就会「✅ 翻译完成」把中文原样填回输入框，
 *   用户以为翻好了、实际什么都没发生（原扩展实测踩过）。
 */
export function validateTranslation(translated: string, targetLang: string): string | null {
  if (!translated || !translated.trim()) {
    return '翻译引擎返回空结果，请稍后重试';
  }
  // 仅当目标语言是英语时才做中文残留检测：目标是中文时结果里当然全是汉字
  if (targetLang === 'en' || !targetLang) {
    if (containsChinese(translated)) {
      return '翻译失败：结果仍为中文，引擎未能正确识别源语言，请稍后重试或切换翻译引擎';
    }
  }
  return null;
}
