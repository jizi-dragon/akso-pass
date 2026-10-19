/**
 * 判据：**间距刻度**（v4.2.12，与 akso-cloud 的同一套 14 档）。
 *
 * 跑法：`node tools/verify/verify-spacing.mjs` —— 纯静态、秒级、不需要浏览器。
 *
 * ## 它治的是什么
 *
 * 改前本仓**一个间距令牌都没有**，实测 **173 处裸 px 间距声明、61 种数值组合**：
 * `2/3/4/5/6/7/8/9/10/11/12/13/14/15/16/18/20/22/26/30/34/44/56…`。
 * 相邻两档只差 1px —— 人眼分不出来，却让"这里该留多少空"每次都要重新决定。
 * 而 `akso-cloud` 那边**早就有 14 档刻度**，并且有一条判据钉着它
 * （`test_pages.py::test_spacing_scale_covers_most_spacing_declarations`，要求 ≥75%）。
 *
 * ## 判据的形状（每一条都回答"拆掉什么它才会红"）
 *
 * | # | 断言 | 反证 |
 * |---|---|---|
 * | 1 | 14 档的名字与值**逐字等于 akso-cloud 的那 14 档** | 把 `--sp-3` 改成 10px |
 * | 2 | **绝大多数**间距声明在刻度上（阈值与 akso-cloud 同为 **75%**） | 把 40 处换成裸 px |
 * | 3 | `1px` 只允许以 `--sp-hair` 出现（它是**描边**不是留白） | 写 `padding: 1px 6px` |
 * | 4 | **注入宿主页 Shadow DOM 的那份必须带兜底值** | 把 `var(--sp-2, 8px)` 改成 `var(--sp-2)` |
 * | 5 | 兜底值必须等于令牌值（否则两种渲染不同） | 写 `var(--sp-2, 10px)` |
 *
 * ## ★★ 为什么是"绝大多数"而不是"零裸 px"
 *
 * 簇里那几处 `margin-left: auto` / `padding: 0` 是**合法的裸值**（它们不是留白），
 * 而"零裸 px"会逼出"把某个值凑到刻度上只为达标"的假改动 —— akso-cloud 的
 * 注释里写着同一条判断，两端的判据口径因此**刻意一致**（同样是 75%）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');
const CLOUD_CSS = resolve(ROOT, '..', 'akso-cloud', 'app', 'web', 'static', 'site.css');

/** 契约：名字与值（与 akso-cloud 逐字相同） */
const EXPECTED = {
  '--sp-0': '2px', '--sp-1': '4px', '--sp-2': '8px', '--sp-3': '12px',
  '--sp-4': '16px', '--sp-5': '20px', '--sp-6': '24px', '--sp-7': '30px',
  '--sp-8': '40px', '--sp-9': '48px', '--sp-10': '56px', '--sp-11': '64px',
  '--sp-12': '80px', '--sp-13': '88px',
};
/** ★ 唯一一档**不属于刻度**的值：它是描边，不是留白（理由见 tokens.css） */
const HAIR = '--sp-hair';
const HAIR_PX = '1px';
/** ★ 与 akso-cloud 的 `test_pages.py` 同一个阈值 —— 口径不一致会让两端各自漂 */
const MIN_ON_SCALE_RATIO = 0.75;

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
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(css|ts)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

/* ────────────────────────── 前提 + ① 与 akso-cloud 同一套 ────────────────────────── */
console.log('=== 前提 / ① 两端是同一套间距刻度 ===');
const tokensRaw = readFileSync(join(SRC, 'ui', 'tokens.css'), 'utf8');
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(stripCssComments(tokensRaw));
check('取到了 tokens.css 的 :root 块', rootBlock !== null);
const declared = new Map();
for (const m of (rootBlock?.[1] ?? '').matchAll(/^\s*(--sp-[\w-]+)\s*:\s*([^;]+);/gm)) {
  declared.set(m[1], m[2].trim());
}
check('tokens.css 里声明了间距令牌', declared.size > 0, `${declared.size} 个`);

const wrong = Object.entries(EXPECTED).filter(([k, v]) => declared.get(k) !== v)
  .map(([k, v]) => `${k}: 本仓 ${declared.get(k) ?? '(缺)'} ≠ 约定 ${v}`);
check('14 档的名字与值都等于约定值', wrong.length === 0, wrong.join(' / '));
check('`--sp-hair` 存在且为 1px', declared.get(HAIR) === HAIR_PX,
  `${HAIR}=${declared.get(HAIR)}`);
const extra = [...declared.keys()].filter((k) => !(k in EXPECTED) && k !== HAIR);
check('没有约定之外的 `--sp-*`', extra.length === 0, extra.join(' '));

// ★ 跨仓那一半（读不到就 SKIP —— 那一半另有 akso-cloud 的脚本在守）
try {
  const cloudRoot = /:root\s*\{([\s\S]*?)\n\}/.exec(readFileSync(CLOUD_CSS, 'utf8'))?.[1] ?? '';
  const cloudSp = new Map(
    [...cloudRoot.matchAll(/^\s*(--sp-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]),
  );
  const diff = Object.entries(EXPECTED).filter(([k, v]) => cloudSp.get(k) !== v)
    .map(([k, v]) => `${k}: akso-cloud ${cloudSp.get(k) ?? '(缺)'} ≠ ${v}`);
  check('akso-cloud 的那 14 档与本仓逐字相同', diff.length === 0,
    diff.join(' / ') || `两侧各 ${cloudSp.size} / ${Object.keys(EXPECTED).length} 档`);
} catch {
  console.log('  SKIP akso-cloud 不在同级目录 —— 跨仓那一半由它的 verify_two_ends_tokens.py 守');
}

/* ────────────────────────── ② ③ 刻度覆盖率与 1px ────────────────────────── */
console.log('\n=== ② 绝大多数间距声明在刻度上 / ③ 1px 只许是 --sp-hair ===');
const files = walk(SRC);
check('src 下有可扫的源文件', files.length > 0, `${files.length} 个`);

const RX = /(?<![\w-])(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block))?\s*:\s*([^;{}]+)/g;
let total = 0;
let onScale = 0;
const nakedHair = [];
const nakedPx = [];
for (const p of files) {
  const rel = relative(SRC, p).replace(/\\/g, '/');
  const text = stripCssComments(readFileSync(p, 'utf8'));
  for (const m of text.matchAll(RX)) {
    const body = m[2];
    // ★ 与 akso-cloud 同一口径：一条声明"在刻度上" ⟺ 它引用的令牌个数
    //   ≥ 它里面的裸 px 个数。⇒ `padding: var(--sp-2) var(--sp-3)` 算在刻度上，
    //   而 `padding: 8px 12px` 不算。
    const decl = m[0];
    if (!/\d+(?:\.\d+)?px/.test(decl) && !/var\(--sp-/.test(decl)) {
      continue; // `auto` / `0` / `%` / `calc()` 不算间距声明
    }
    total += 1;
    const tokCount = (decl.match(/var\(--sp-/g) ?? []).length;
    const pxCount = (decl.match(/\d+(?:\.\d+)?px/g) ?? []).length;
    if (tokCount >= pxCount) {
      onScale += 1;
    } else {
      nakedPx.push(`${rel}  ${decl.trim().slice(0, 70)}`);
    }
    if (/(?<![\w-])1px/.test(decl) && !/var\(--sp-hair/.test(decl)) {
      nakedHair.push(`${rel}  ${decl.trim().slice(0, 70)}`);
    }
  }
}
check('自证：确实扫到了间距声明（否则下面的比例恒真）', total > 100, `${total} 处`);
const ratio = total ? onScale / total : 0;
check(`在刻度上的比例 ≥ ${MIN_ON_SCALE_RATIO}`, ratio >= MIN_ON_SCALE_RATIO,
  `${onScale}/${total} = ${(ratio * 100).toFixed(0)}%（与 akso-cloud 同一阈值）`);
check('`1px` 只以 `--sp-hair` 出现（它是描边不是留白）', nakedHair.length === 0,
  nakedHair.slice(0, 5).join(' / ') || '0 处裸 1px');
console.log(`      （不在刻度上的剩余 ${nakedPx.length} 处：`
  + `${nakedPx.slice(0, 3).map((s) => s.split('  ')[1].trim()).join(' | ') || '无'}）`);

/* ────────────────────────── ④ ⑤ Shadow DOM 那份的兜底 ────────────────────────── */
console.log('\n=== ④⑤ 注入宿主页 Shadow DOM 的样式必须带兜底、且兜底值等于令牌值 ===');
const gridStyle = readFileSync(join(SRC, 'ui', 'wheel', 'grid-style.ts'), 'utf8');
const strings = [...gridStyle.matchAll(/export const (\w+_CSS) = `([\s\S]*?)`;/g)];
check('grid-style.ts 里找到了导出的样式字符串', strings.length > 0, `${strings.length} 个`);

const noFallback = [];
const mismatch = [];
for (const [, name, body] of strings) {
  body.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--sp-(?:hair|\d+))\s*\)/g)) {
      noFallback.push(`${name}:${i + 1}  var(${m[1]}) 无兜底`);
    }
    for (const m of line.matchAll(/var\(\s*(--sp-(?:hair|\d+))\s*,\s*([\d.]+)px\s*\)/g)) {
      const want = m[1] === HAIR ? HAIR_PX : EXPECTED[m[1]];
      if (want && want !== `${m[2]}px`) {
        mismatch.push(`${name}: ${m[1]} 的兜底 ${m[2]}px ≠ 令牌值 ${want}`);
      }
    }
  });
}
check('Shadow DOM 那份里没有"无兜底的 --sp-* 引用"', noFallback.length === 0,
  noFallback.slice(0, 5).join(' / ') || '全部带兜底');
check('兜底值与令牌值一致（两种情形渲染相同）', mismatch.length === 0,
  [...new Set(mismatch)].slice(0, 5).join(' / ') || '全部一致');
const spInShadow = strings.reduce(
  (n, [, , body]) => n + (body.match(/var\(--sp-/g) ?? []).length, 0);
check('自证：Shadow DOM 那份里确实有间距令牌引用（否则上两条恒真）', spInShadow > 0,
  `${spInShadow} 处`);

/* ────────────────────────── 汇总 ────────────────────────── */
const bad = results.filter((r) => !r).length;
console.log(`\n=== 汇总：${results.length - bad}/${results.length} 通过 ===`);
console.log(bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
