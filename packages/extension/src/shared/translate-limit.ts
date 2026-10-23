/**
 * 译文长度限制：**优先在完整句子/单词边界截断**，而不是硬切。
 *
 * 用户明确要求（2026-10-23）："不能硬切断，要有完整单词，或者是单词缩写；
 * 至少保持翻译后的内容是读得通的。"
 *
 * 优先级：
 * 1. 原文本身就 ≤ 上限 → 原样返回；
 * 2. 上限内最后一个**句末标点**（. ! ? 。！？；;）→ 保留完整句子；
 * 3. 用 `Intl.Segmenter` 找最后一个**完整词**边界 → 去尾空格 + `…`；
 *    没有 Segmenter 时退回空白/中文标点边界；
 * 4. 单 token（如 snake_case 字段名 / 超长单词）→ 尽量保留完整 `_` 段，
 *    否则保留前缀 + `…`，至少让截断位置可见，而不是静默吞掉半截。
 *
 * 返回长度**永不超过** `limit`（`…` 也计入）。
 */

const SENTENCE_END = /[.!?。！？；;]/;
const CJK_BOUNDARY = /[，、。；：！？]/;

function trimTail(text: string): string {
  return text.replace(/[\s,，、;；:：\-–—]+$/u, '');
}

function lastSentenceBoundary(chars: string[], budget: number): number {
  for (let i = Math.min(budget, chars.length) - 1; i >= 0; i -= 1) {
    if (SENTENCE_END.test(chars[i] ?? '')) {
      return i;
    }
  }
  return -1;
}

function segmentBoundary(text: string, budget: number): number {
  // `Intl.Segmenter` 在 Chrome 110+ 都有；它同时懂英文空格和中文分词。
  try {
    const Segmenter = (Intl as unknown as {
      Segmenter?: new (locale?: string, opts?: { granularity: string }) => {
        segment: (value: string) => Iterable<{ index: number; segment: string }>;
      };
    }).Segmenter;
    if (Segmenter) {
      const seg = new Segmenter(undefined, { granularity: 'word' });
      let end = -1;
      for (const item of seg.segment(text)) {
        const next = item.index + item.segment.length;
        if (next > budget) break;
        if (item.segment.trim().length > 0) {
          end = next;
        }
      }
      return end;
    }
  } catch {
    // 老环境忽略，走下面的空白/中文标点回退
  }
  const head = Array.from(text).slice(0, budget).join('');
  const bySpace = head.search(/\s+\S*$/u);
  if (bySpace > 0) {
    return Array.from(head.slice(0, bySpace)).length;
  }
  for (let i = head.length - 1; i >= 0; i -= 1) {
    if (CJK_BOUNDARY.test(head[i] ?? '')) {
      return i + 1;
    }
  }
  return -1;
}

function singleTokenAbbreviation(text: string, head: string, limit: number): string {
  // snake_case / kebab-case：从**完整原文**的段边界取，绝不把头截出来的半个段补进去。
  const parts = text.split(/([_-])/u);
  let out = '';
  for (const part of parts) {
    if (Array.from(out + part).length >= limit) break;
    out += part;
  }
  out = out.replace(/[_-]+$/u, '');
  if (Array.from(out).length >= 4) {
    return out + '…';
  }
  return Array.from(head).slice(0, limit - 1).join('') + '…';
}

export function limitTranslation(text: string, limit = 50): string {
  const clean = String(text ?? '').trim();
  if (!clean || limit < 2) {
    return clean;
  }
  const chars = Array.from(clean);
  if (chars.length <= limit) {
    return clean;
  }
  const budget = limit - 1; // 给省略号留 1 个字符

  const sentence = lastSentenceBoundary(chars, budget);
  if (sentence >= Math.max(6, Math.floor(budget * 0.35))) {
    // 句末标点已在预算内，完整句子不再补省略号。
    return chars.slice(0, sentence + 1).join('').trimEnd();
  }

  const boundary = segmentBoundary(clean, budget);
  if (boundary >= Math.max(6, Math.floor(budget * 0.35))) {
    const cut = trimTail(chars.slice(0, boundary).join(''));
    if (Array.from(cut).length >= 4) {
      return Array.from(cut).slice(0, budget).join('') + '…';
    }
  }

  const head = chars.slice(0, budget).join('');
  return singleTokenAbbreviation(clean, head, limit);
}
