/**
 * 判据：**免费翻译引擎只许两路（有道 / MyMemory），已停运的两路不许回来**。
 *
 * 跑法：`node tools/verify/verify-engines.mjs` —— 纯静态、秒级（不启浏览器）。
 *
 * ## 为什么要有这一条（v4.6.6，2026-11-26）
 *
 * 2026-11-26 实测：`transmart.qq.com:443` **TCP 连不上**（20s 超时、DNS 一致、
 * 外部已报该服务停运），`lingva.ml` **20/20 都是 403**（Cloudflare）。而它们
 * 当时还在自动模式的赛马里 —— 一条死腿让**每次整句翻译都白等满 8s**
 * （端到端实测 9867ms / 10043ms）。
 *
 * 这不是"报错"，是**慢到让人以为坏了**：界面照样提示"翻译完成"，日志里没有
 * 一条 error，`typecheck` / `build` / 全部既有门禁**都不会红**。
 *
 * 本地修法（4.6.6）：移除两路、自动模式改成串行 有道 → MyMemory、有道单独 3s 超时。
 * 判据要防的回归有三类：
 *
 * | # | 会安静发生的回归 |
 * |---|---|
 * | ① | 有人"顺手"把死引擎加回列表 —— 代码看着完全正常 |
 * | ② | 老设置值 `transmart` / `lingva` 没落回 `auto`，界面显示一个不存在的引擎 |
 * | ③ | 自动模式又变回"并行等最慢的一路"（这次吃过 8s 的亏） |
 *
 * ## 判据的形状
 *
 * | # | 断言 |
 * |---|---|
 * | 1 | 前提：四个源文件都在 |
 * | 2 | `EngineId` 恰好四值：auto / deepseek / youdao / mymemory |
 * | 3 | `IMPL` 恰好两路（viaYoudao / viaMyMemory），全仓零 `viaTransmart` / `viaLingva` |
 * | 4 | 自动顺序是 `FREE_ENGINES` = youdao → mymemory（有道在前） |
 * | 5 | 去掉注释后 `transmart` / `lingva` **各只出现一次**，且都在 `normalizeEngineId` 的回落表里 |
 * | 6 | 有道超时 3s，且显式分支走 `timeoutOf(engine)`（不再是固定 8s 一把梭） |
 * | 7 | UI 引擎卡 4 条、无下架项；界面/错误文案不再提「腾讯 / Lingva」 |
 * | 8 | 自证：把上述任一处改回缺陷形态，本脚本必须**变红**（内存内改，不落盘） |
 *
 * ★ 第 8 条是 in-memory 改字符串（同 `verify-autologin-reject.mjs`）——
 *   与 `verify-falsify-*.mjs` 那套"改文件再还原"相比，不会因为中途异常把源码留在缺陷态。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
const countOf = (hay, needle) => {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
};
/** 判据只认**代码**：注释里故意引用的历史形态（`transmart.qq.com` 之类）不算 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/* ────────────────────────── 0. 读源 ────────────────────────── */

let engines;
let uiTs;
let uiHtml;
let sw;
try {
  engines = read('shared/engines.ts');
  uiTs = read('ui/translate/translate.ts');
  uiHtml = read('ui/translate/translate.html');
  sw = read('background/service-worker.ts');
} catch (e) {
  console.log(`  FAIL 前提：源文件读不到 —— ${e.message}`);
  process.exit(1);
}
/** 源码是 CRLF，判据里的锚点按 `\n` 写 ⇒ 读进来先统一换行，否则多行锚点一字不中 */
const nl = (s) => s.replace(/\r\n/g, '\n');
const E = stripComments(nl(engines));
const U = stripComments(nl(uiTs));
const H = nl(uiHtml);
const W = stripComments(nl(sw));

/* ────────────────────────── 1. 提取器（判据与自证共用同一个） ────────────────────────── */

const engineIds = (s) => {
  const m = /export type EngineId =([^;]+);/.exec(s);
  return m ? m[1].split('|').map((v) => v.trim().replace(/'/g, '')) : [];
};
const implOf = (s) => {
  const m = /const IMPL[^{]*\{([\s\S]*?)\n\};/.exec(s);
  return m ? m[1] : '';
};
const orderOf = (s) => {
  const m = /const FREE_ENGINES[^=]*=\s*\[([^\]]*)\]/.exec(s);
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : [];
};
const uiIds = (s) => {
  const m = /const ENGINES: EngineMeta\[\] = \[([\s\S]*?)\n\];/.exec(s);
  return m ? [...m[1].matchAll(/id: '([a-z]+)'/g)].map((x) => x[1]) : [];
};
const legacyOf = (s) => {
  const m = /const legacy[^{]*\{([\s\S]*?)\n  \};/.exec(s);
  return m ? m[1] : '';
};

/* ────────────────────────── 2. 谓词（判据 = 自证用同一份） ────────────────────────── */

const preds = {
  ids: (s) => engineIds(s).join(',') === 'auto,deepseek,youdao,mymemory',
  impl: (s) => {
    const b = implOf(s);
    return (
      countOf(b, 'viaYoudao') === 1 &&
      countOf(b, 'viaMyMemory') === 1 &&
      countOf(b, 'via') === 2 &&
      !s.includes('viaTransmart') &&
      !s.includes('viaLingva')
    );
  },
  order: (s) => orderOf(s).join(',') === 'youdao,mymemory',
  legacy: (s) => {
    const b = legacyOf(s);
    return countOf(s, 'transmart') === 1 &&
      countOf(s, 'lingva') === 1 &&
      b.includes("transmart: 'auto'") &&
      b.includes("lingva: 'auto'");
  },
  timeout: (s) =>
    s.includes('const YOUDAO_TIMEOUT_MS = 3000;') &&
    s.includes('timeoutOf(engine)') &&
    countOf(s, 'timeoutOf(') >= 3,
  ui: (s) => {
    const ids = uiIds(s);
    return (
      ids.join(',') === 'auto,deepseek,youdao,mymemory' &&
      !U.includes("id: 'transmart'") &&
      !U.includes("id: 'lingva'")
    );
  },
};

/* ────────────────────────── 3. 逐条判据 ────────────────────────── */

console.log('=== ① 引擎清单：只剩两路 ===');
check('② `EngineId` 恰好四值（auto / deepseek / youdao / mymemory）', preds.ids(E), `实际 ${engineIds(E).join(' | ')}`);
check('③ `IMPL` 恰好两路，且全仓没有 viaTransmart / viaLingva', preds.impl(E));
check('④ 自动顺序是 youdao → mymemory（有道在前）', preds.order(E), `实际 ${orderOf(E).join(' → ')}`);
check('⑤ transmart / lingva 各只出现一次且都落回 auto', preds.legacy(E));

console.log('\n=== ② 超时：查词不该陪整句等满 8s ===');
check('⑥ 有道 3s + 显式分支走 `timeoutOf(engine)`', preds.timeout(E));

console.log('\n=== ③ 界面与文案不再提下架的引擎 ===');
check('⑦ UI 引擎卡恰好 4 条且无下架项', preds.ui(U));
check('⑦-b 翻译面板的告知条只提 网易有道 / MyMemory', H.includes('网易有道 / MyMemory') && !H.includes('腾讯') && !H.includes('Lingva'));
check(
  '⑦-c 词典释义的报错文案指向 MyMemory，不再指向腾讯',
  W.includes('「MyMemory」') && !W.includes('腾讯交互翻译'),
);
check('⑦-d 历史记录的引擎占用注释不再是 transmart', !E.includes('transmart /') && !U.includes('transmart /'));

/* ────────────────────────── 4. 自证：改回缺陷形态必须变红 ────────────────────────── */

console.log('\n=== ④ 自证：改回缺陷形态必须变红 ===');

const red = (label, mutate, key) => {
  const m = mutate();
  const empty = m === null || m === undefined;
  check(`⑧ ${label} ⇒ 判据变红`, !empty && preds[key](m) === false);
};

red('把 transmart 加回 `EngineId`', () =>
  E.replace(
    "export type EngineId = 'auto' | 'deepseek' | 'youdao' | 'mymemory';",
    "export type EngineId = 'auto' | 'deepseek' | 'transmart' | 'youdao' | 'mymemory';",
  ), 'ids');

red('把 `lingva: viaLingva` 加回 `IMPL`', () =>
  E.replace('  mymemory: viaMyMemory,\n};', '  mymemory: viaMyMemory,\n  lingva: viaLingva,\n};'), 'impl');

red('把自动顺序改回 MyMemory 优先', () =>
  E.replace("const FREE_ENGINES: readonly FreeEngineId[] = ['youdao', 'mymemory'];",
    "const FREE_ENGINES: readonly FreeEngineId[] = ['mymemory', 'youdao'];"), 'order');

red('把老设置值的回落表删掉一格', () =>
  E.replace("    lingva: 'auto',\n", ''), 'legacy');

red('把有道的超时改回 8s 一把梭', () =>
  E.replace('const YOUDAO_TIMEOUT_MS = 3000;', 'const YOUDAO_TIMEOUT_MS = 8000;'), 'timeout');

red('把「腾讯」引擎卡加回设置页', () =>
  U.replace("  {\n    id: 'youdao',", "  {\n    id: 'transmart',\n    name: '腾讯交互翻译 TranSmart',\n    desc: 'x',\n  },\n  {\n    id: 'youdao',"), 'ui');

/* ────────────────────────── 5. 汇总 ────────────────────────── */

const bad = results.filter((r) => !r.ok).length;
console.log(`\n=== 汇总：${results.length - bad}/${results.length} 通过 ===`);
if (bad) {
  console.log('\n★ 修法：`shared/engines.ts` 的 EngineId / IMPL / FREE_ENGINES / normalizeEngineId 四处对齐；');
  console.log('  界面文案在 `ui/translate/translate.html` 与 `translate.ts` 的 ENGINES 表。');
}
console.log(bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
