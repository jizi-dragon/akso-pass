/**
 * 供验证脚本共用的**字符串感知**注释剥离器。
 *
 *     import { stripComments } from '../_lib/strip-comments.mjs';
 *
 * ## ★★ 为什么不能用「一个非贪婪的块注释正则」（本文件存在的唯一理由）
 *
 * 那种正则**会跨字符串字面量匹配**，于是把**真实代码整段当成注释吃掉**。
 * 实测（2026-10-12，`ui/parallel/parallel.ts`）：
 *
 * ```ts
 * const still = await chrome.permissions.contains({ origins: [`*://${b}/*`] })
 * ```
 *
 * 模板串里出现了「注释起始符」这三个字符（斜杠加星号），于是正则以为**注释从这里开始**，
 * 而它一路吃到 **3082 字符之后**某个真注释的收尾符才停下 ——
 * 中间那 3 KB **全是活代码**（`blockedHosts` 自愈、`renderSites`、
 * `removeSiteGrant` 的整个函数体）。
 *
 * ★ 后果不是"报错"，而是**判据静默失效**：被吃掉的区域里再也搜不到任何东西，
 *   于是"该出现的没出现" ⇒ **假红**；反之若被吃掉的正是缺陷本身 ⇒ **假绿**。
 *   本仓的 `verify-defectfix.mjs` 与 `verify-deadprotocol.mjs` 都曾因此拿到错的输入
 *   （实测：`data.import` 明明有发送方，却被判成"零发送方"）。
 *
 * ## 做法
 *
 * 逐字符扫描，维护"当前是否在字符串/模板串里"的状态；
 * **只有不在字符串里**时，注释起始符与收尾符才算数。
 * 注释被替换为**等量空格**（保留换行）⇒ **行号不变**，报错能直接指到原文。
 *
 * ★ 已知取舍：不解析正则字面量里的斜杠（那需要完整词法分析）。
 *   但本仓不会在正则里写注释起始符，故不构成风险；
 *   若将来出现，判据会**假红**（比假绿安全）。
 *
 * ★ 本文件自己的注释也在演示这条规矩：**不要在块注释里写出收尾符**，
 *   否则注释会在这里提前闭合（写这段时我踩了一次，`SyntaxError` 当场可见）。
 */

/**
 * 把注释替换成空格（保留换行 ⇒ 行号不变）。
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  // 当前字符串定界符：null=不在字符串里；否则是单引号、双引号或反引号
  let quote = null;

  while (i < n) {
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : '';

    if (quote) {
      // ── 在字符串/模板串里：只找它的收尾
      if (c === '\\') {
        // 转义：连同下一个字符一起原样保留（`\'` 不该结束字符串）
        out += c + d;
        i += 2;
        continue;
      }
      if (c === quote) {
        quote = null;
      }
      out += c;
      i += 1;
      continue;
    }

    // ── 不在字符串里
    if (c === '/' && d === '/') {
      // 行注释：吃到行尾（保留换行本身）
      while (i < n && src[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      // 块注释：吃到第一个收尾符（此刻我们确定不在字符串里 ⇒ 它是真的）
      out += '  ';
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
