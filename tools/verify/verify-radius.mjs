/**
 * 判据：**圆角刻度**（v4.2.12，与 akso-cloud 同一套 `8 / 12 / 16 / 999`）。
 *
 * 跑法：`node tools/verify/verify-radius.mjs` —— 纯静态、秒级、不需要浏览器。
 *
 * ## 它治的是什么
 *
 * 改前本仓的圆角是**两档 + 一堆裸值**：`--sb-radius`(10px) / `--sb-radius-lg`(16px)，
 * 外加 **22 处小元件各自写 `5/6/8/9/10/11/13px`** —— 七种取值挤在 5–13 之间，
 * 相邻两档只差 1px，人眼分不出来。而 `akso-cloud` 那边是 `8 / 12 / 16` 三档 + `999px`。
 *
 * ⇒ 用户 2026-10-13 拍板「**akso-pass 用 8 / 12 / 16**」，这一条就是那个决定的可执行形式。
 *
 * ## 判据的形状
 *
 * | # | 断言 | 反证 |
 * |---|---|---|
 * | 1 | 四档的值等于约定（`8 / 12 / 16 / 999`） | 把 `--sb-radius` 改成 10px |
 * | 2 | `border-radius` 里**不许有裸 px 值**（`50%` / `0` 除外） | 写 `border-radius: 5px` |
 * | 3 | 每一处都必须引用那四档之一 | 写 `var(--sb-radius-xl)` |
 * | 4 | 注入宿主页 Shadow DOM 的那份必须带兜底值 | 把 `var(--sb-radius, 12px)` 改成 `var(--sb-radius)` |
 * | 5 | 兜底值等于令牌值 | 写 `var(--sb-radius, 10px)` |
 *
 * ## ★★ 为什么 `50%` 允许裸写，而 `999px` 不允许
 *
 * `50%` 不是"圆角多大"，是"**做成圆**"—— 它与元素尺寸成比例，**没有第二个合理值**，
 * 所以它有令牌也只会有一个取值（那是"令牌化的形式主义"）。
 * 而 `999px` 是**胶囊**弧度，它是个**具体的设计选择**（可以改成 12px 做成"很圆的矩形"）
 * ⇒ 改前它在 5 个文件里裸写 **16 处**，想调就得搜全仓。现在它是 `--sb-radius-pill`。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');
const CLOUD_CSS = resolve(ROOT, '..', 'akso-cloud', 'app', 'web', 'static', 'site.css');

/** 四档的值（**与 akso-cloud 的 `--r-s/-m/-l/-full` 逐字相同**） */
const EXPECTED = {
  '--sb-radius-sm': '8px',
  '--sb-radius': '12px',
  '--sb-radius-lg': '16px',
  '--sb-radius-pill': '999px',
};
/** akso-cloud 那一侧的名字（跨仓比对时按**值**配，因为两端的名字刻意不同） */
const CLOUD_NAMES = ['--r-s', '--r-m', '--r-l', '--r-full'];
/** 令牌 → 档号（0 小 / 1 中 / 2 大 / 3 胶囊）—— 与 akso-cloud 的 `verify_two_ends_roles.py` 同一口径 */
const EXPECTED_TIER = {
  '--sb-radius-sm': 0, '--sb-radius': 1, '--sb-radius-lg': 2, '--sb-radius-pill': 3,
};
const RADIUS_RX = /(?<![\w-])border-radius\s*:\s*([^;{}]+)/;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

function stripCssComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|ts)$/.test(name)) out.push(p);
  }
  return out;
}

/* ────────────────────────── 前提 + ① ────────────────────────── */
console.log('=== 前提 / ① 圆角四档 ===');
const tokensRaw = readFileSync(join(SRC, 'ui', 'tokens.css'), 'utf8');
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(stripCssComments(tokensRaw));
check('取到了 tokens.css 的 :root 块', rootBlock !== null);
const declared = new Map();
for (const m of (rootBlock?.[1] ?? '').matchAll(/^\s*(--sb-radius[\w-]*)\s*:\s*([^;]+);/gm)) {
  declared.set(m[1], m[2].trim());
}
const wrong = Object.entries(EXPECTED).filter(([k, v]) => declared.get(k) !== v)
  .map(([k, v]) => `${k}: 本仓 ${declared.get(k) ?? '(缺)'} ≠ 约定 ${v}`);
check('四档的名字与值都等于约定', wrong.length === 0, wrong.join(' / '));
const extra = [...declared.keys()].filter((k) => !(k in EXPECTED));
check('没有约定之外的 `--sb-radius*`', extra.length === 0, extra.join(' '));

// ★ 跨仓那一半：**按值的有序三元组**比（两端名字刻意不同）
try {
  const cloudRoot = /:root\s*\{([\s\S]*?)\n\}/.exec(readFileSync(CLOUD_CSS, 'utf8'))?.[1] ?? '';
  const cloudR = new Map(
    [...cloudRoot.matchAll(/^\s*(--r-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]),
  );
  const mine = ['--sb-radius-sm', '--sb-radius', '--sb-radius-lg', '--sb-radius-pill']
    .map((k) => EXPECTED[k]);
  const theirs = CLOUD_NAMES.map((k) => cloudR.get(k));
  const same = mine.length === theirs.length && mine.every((v, i) => v === theirs[i]);
  check('akso-cloud 的四档值与本仓逐字相同（按值的次序比）', same,
    same ? `${mine.join(' / ')}` : `本仓 ${mine.join('/')} ≠ 那边 ${theirs.join('/')}`);
} catch {
  console.log('  SKIP akso-cloud 不在同级目录 —— 跨仓那一半由它的 verify_two_ends_tokens.py 守');
}

/* ────────────────────────── ② ③ 裸值与引用 ────────────────────────── */
console.log('\n=== ② 不许有裸 px 圆角 / ③ 只许引用那四档 ===');
const files = walk(SRC);
const RX = /(?<![\w-])border-radius\s*:\s*([^;{}]+)/g;
const naked = [];
const badVar = [];
let total = 0;
for (const p of files) {
  const rel = relative(SRC, p).replace(/\\/g, '/');
  const text = stripCssComments(readFileSync(p, 'utf8'));
  for (const m of text.matchAll(RX)) {
    total += 1;
    const body = m[1];
    // `50%` 是"做成圆"，`0` 是"不要圆角" —— 两者都不是"圆角多大"
    const rest = body.replace(/var\(\s*--sb-radius[\w-]*\s*(?:,\s*[\d.]+px\s*)?\)/g, 'VAR');
    for (const mm of rest.matchAll(/([\d.]+px)/g)) {
      naked.push(`${rel}  border-radius: ${body.trim().slice(0, 60)}  (${mm[1]})`);
    }
    for (const mm of body.matchAll(/var\(\s*(--sb-radius[\w-]*)/g)) {
      if (!(mm[1] in EXPECTED)) badVar.push(`${rel}  ${mm[1]}`);
    }
  }
}
check('自证：确实扫到了 border-radius（否则下面两条恒真）', total > 30, `${total} 处`);
check('没有裸 px 的 border-radius', naked.length === 0,
  naked.slice(0, 5).join(' / ') || `${total} 处全部走令牌`);
check('每一处都引用那四档之一', badVar.length === 0,
  [...new Set(badVar)].slice(0, 5).join(' / ') || '全仓 0 处');

/* ────────────────────────── ④ ⑤ Shadow DOM 那份 ────────────────────────── */
console.log('\n=== ④⑤ 注入宿主页 Shadow DOM 的样式必须带兜底、且兜底值等于令牌值 ===');
const gridStyle = readFileSync(join(SRC, 'ui', 'wheel', 'grid-style.ts'), 'utf8');
const strings = [...gridStyle.matchAll(/export const (\w+_CSS) = `([\s\S]*?)`;/g)];
const noFb = [];
const mismatch = [];
for (const [, name, body] of strings) {
  body.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--sb-radius[\w-]*)\s*\)/g)) {
      noFb.push(`${name}:${i + 1}  var(${m[1]}) 无兜底`);
    }
    for (const m of line.matchAll(/var\(\s*(--sb-radius[\w-]*)\s*,\s*([\d.]+px)\s*\)/g)) {
      const want = EXPECTED[m[1]];
      if (want && want !== m[2]) mismatch.push(`${name}: ${m[1]} 的兜底 ${m[2]} ≠ 令牌值 ${want}`);
    }
  });
}
check('Shadow DOM 那份里没有"无兜底的 --sb-radius* 引用"', noFb.length === 0,
  noFb.slice(0, 5).join(' / ') || '全部带兜底');
check('兜底值与令牌值一致（两种情形渲染相同）', mismatch.length === 0,
  [...new Set(mismatch)].slice(0, 5).join(' / ') || '全部一致');
const inShadow = strings.reduce((n, [, , b]) => n + (b.match(/var\(--sb-radius/g) ?? []).length, 0);
check('自证：Shadow DOM 那份里确实有圆角引用（否则上两条恒真）', inShadow > 0, `${inShadow} 处`);

/* ────────────────────────── ⑥ 按角色登记的档位（跨仓判据的"另一端"） ────────────────────────── */
console.log('\n=== ⑥ 几个同名选择器必须停在指定档 ===');
/*
 * ★★ 为什么要在这里**额外**钉一份"角色 → 档"的小名单：
 *
 * `akso-cloud/tools/verify_two_ends_roles.py` 会拿**两端同名的选择器**逐个比档位 ——
 * 那是**测量**，不是判断，所以可靠。但它只覆盖**两端都存在的**那些名字（13 个）。
 *
 * 而它上线之前，我自己犯过一个错：看名字猜"角色是卡片"，把 akso-cloud 的
 * `.box-option` / `.import-panel` / `.batch-bar` 一起提到了 16px，而本仓那边是 12px ——
 * **我一边在修"两端不一致"，一边造了 5 处新的不一致**。
 *
 * ⇒ 于是把"这些名字对应哪一档"**写死在这里**：本仓改档位时会当场红，
 *   而跨仓判据负责"另一端有没有跟着改"。
 * ★ 这份名单**只收两端同名的那些**（那些才有唯一正确答案）；本仓独有的元件不进名单。
 */
const ROLES = {
  // 选择器                 期望档
  '.card': 2,                 // 卡片 → 16
  '.account-card': 2,
  '.site-list .site-card': 2,
  '.empty': 2,
  '.modal-card': 2,
  '.import-panel': 1,         // 面板/容器 → 12
  '.batch-bar': 1,
  '.box-option': 1,
  button: 1,                  // 控件 → 12
};
const filesAll = walk(SRC);
const roleRows = [];
for (const p of filesAll) {
  const rel = relative(SRC, p).replace(/\\/g, '/');
  const text = stripCssComments(readFileSync(p, 'utf8'));
  const cur = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.endsWith('{') && !t.startsWith('@')) { cur.push(t.slice(0, -1).trim()); continue; }
    if (t === '}') { cur.pop(); continue; }
    const m = RADIUS_RX.exec(line);
    if (!m || cur.length !== 1) continue;   // ★ 只看**单层**选择器（与跨仓判据同一口径）
    const sel = cur[0];
    if (!(sel in ROLES)) continue;
    const toks = [...m[1].matchAll(/var\(\s*(--[\w-]+)/g)].map((x) => x[1]);
    if (toks.length !== 1) continue;
    roleRows.push({ rel, sel, tier: EXPECTED_TIER[toks[0]], want: ROLES[sel] });
  }
}
const roleBad = roleRows.filter((r) => r.tier !== r.want)
  .map((r) => `${r.rel}  ${r.sel}: 档 ${r.tier} ≠ 期望 ${r.want}`);
check('自证：确实匹配到了名单里的选择器（否则上一条恒真）', roleRows.length > 0,
  `${roleRows.length} 处`);
check('名单里的选择器都停在指定档', roleBad.length === 0,
  roleBad.slice(0, 5).join(' / ') || `${roleRows.length} 处全部就位`);

/* ────────────────────────── 汇总 ────────────────────────── */
const bad = results.filter((r) => !r).length;
console.log(`\n=== 汇总：${results.length - bad}/${results.length} 通过 ===`);
console.log(bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
