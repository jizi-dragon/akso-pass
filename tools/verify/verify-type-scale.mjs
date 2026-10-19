/**
 * 判据：**字号刻度**（v4.2.12，与 akso-cloud 的同一套）。
 *
 * 跑法：`node tools/verify/verify-type-scale.mjs` —— 纯静态、秒级、不需要浏览器。
 *
 * ## 它治的是什么
 *
 * 改前本仓**一个字号令牌都没有**，实测 5 个 CSS 文件里有 **99 处 `font-size` 字面量、
 * 18 种取值**，而且挤成一团（相邻两档只差 0.5px —— 人眼分不出，
 * 却让"这里该用多大"每次都要重新决定）。
 *
 * 而 `akso-cloud` 那边**早就有刻度**（7 档）并被 `test_type_scale.py` 钉着。
 * ⇒ 用户 2026-10-13 要求"两端页面美学与设计令牌统一"，
 *   这一条就是那个要求的**可执行形式**。
 *
 * ## 判据的形状（每一条都回答"拆掉什么它才会红"）
 *
 * | # | 断言 | 反证（拆掉什么它红） |
 * |---|---|---|
 * | 1 | 7 档的名字与值**逐字等于 akso-cloud 的那 7 档** | 把 `--fs-13` 改成 `14px` |
 * | 2 | `font-size` **不许有裸 px 字面量** | 把任一处换成 `font-size: 12px` |
 * | 3 | 每一处 `font-size` 都必须引用这 7 档之一 | 写 `var(--fs-14)` |
 * | 4 | ≥13px 的档之间相差 **≥2px** | 加一档 `--fs-14` |
 * | 5 | **注入宿主页 Shadow DOM 的那份样式必须带兜底值** | 把 `var(--fs-13, 13px)` 改成 `var(--fs-13)` |
 *
 * ## ★★ 第 5 条为什么单列（这一条是本轮最容易漏的）
 *
 * `ACCT_GRID_CSS` 有**两个消费者**：扩展自有页面用 `<link>`（`:root` 拿得到），
 * 而**三个页内浮层把它内联进宿主页的 Shadow DOM**（`:root` **拿不到**，
 * `:host { all: initial }` 还会重置）。
 * ⇒ 在那里写没有兜底的 `var(--fs-13)`，**整条声明被丢弃**、字号静默退回继承值。
 *   而 `verify-css-vars.mjs` 抓不到它 —— 它按**页面**的解析链算，
 *   而 `wheel.html` 那条链是通的（AGENTS 规则 36：CSS 变量是隐式契约，
 *   要按**页面的依赖链**验；而浮层的依赖链在宿主页，不在我们的页面里）。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');          // tools/verify/ → 仓库根（两层）
const SRC = join(ROOT, 'packages', 'extension', 'src');
/** ★ 跨仓比对的另一侧：与 `verify_two_ends_tokens.py` 同一约定（同级目录） */
const CLOUD_CSS = resolve(ROOT, '..', 'akso-cloud', 'app', 'web', 'static', 'site.css');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

/** 剥块注释（保留换行，让行号仍然对得上）——与仓库里其它判据同一做法 */
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

/* ────────────────────────── 前提：拿到权威令牌 ────────────────────────── */
console.log('=== 前提 ===');
const tokensPath = join(SRC, 'ui', 'tokens.css');
const tokensRaw = readFileSync(tokensPath, 'utf8');
const tokens = stripCssComments(tokensRaw);
const rootBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(tokens);
check('取到了 tokens.css 的 :root 块', rootBlock !== null);
const declared = new Map();
for (const m of (rootBlock?.[1] ?? '').matchAll(/^\s*(--fs-[\w-]+)\s*:\s*([^;]+);/gm)) {
  declared.set(m[1], m[2].trim());
}
check('tokens.css 里声明了字号令牌', declared.size > 0, `${declared.size} 个`);

/* ────────────────────────── ① 与 akso-cloud 逐字相同 ────────────────────────── */
console.log('\n=== ① 两端是同一套刻度 ===');
/** 这一组是**契约**：名字与值都必须逐字相同（见文件头第 1 条） */
const EXPECTED = {
  '--fs-11': '11px', '--fs-12': '12px', '--fs-13': '13px',
  '--fs-15': '15px', '--fs-18': '18px', '--fs-32': '32px', '--fs-54': '54px',
};
const wrongValue = Object.entries(EXPECTED)
  .filter(([k, v]) => declared.get(k) !== v)
  .map(([k, v]) => `${k}: 本仓 ${declared.get(k) ?? '(缺)'} ≠ 约定 ${v}`);
check('7 档的名字与值都等于约定值', wrongValue.length === 0, wrongValue.join(' / '));
const extraTokens = [...declared.keys()].filter((k) => !(k in EXPECTED));
check('没有约定之外的 `--fs-*`', extraTokens.length === 0, extraTokens.join(' '));

// ★ 跨仓那一半：能读到 akso-cloud 就逐字比一次（读不到就跳过 —— 它可能不在这儿）
try {
  const cloudCss = readFileSync(CLOUD_CSS, 'utf8');
  const cloudRoot = /:root\s*\{([\s\S]*?)\n\}/.exec(cloudCss)?.[1] ?? '';
  const cloudFs = new Map(
    [...cloudRoot.matchAll(/^\s*(--fs-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]),
  );
  const diff = Object.entries(EXPECTED)
    .filter(([k, v]) => cloudFs.get(k) !== v)
    .map(([k, v]) => `${k}: akso-cloud ${cloudFs.get(k) ?? '(缺)'} ≠ ${v}`);
  check('akso-cloud 的那 7 档与本仓逐字相同', diff.length === 0,
    diff.join(' / ') || `两侧各 ${cloudFs.size} / ${declared.size} 档`);
} catch {
  console.log('  SKIP akso-cloud 不在同级目录 —— 跨仓那一半由 akso-cloud 的 '
    + 'tools/verify_two_ends_tokens.py 守（它在 acceptance 里跑）');
}

/* ────────────────────────── ② ③ 字面量与引用 ────────────────────────── */
console.log('\n=== ② 不许有裸 px 字号 / ③ 只许引用那 7 档 ===');
const files = walk(SRC);
check('src 下有可扫的源文件', files.length > 0, `${files.length} 个`);

const literalHits = [];
const badVarHits = [];
for (const p of files) {
  const rel = relative(SRC, p).replace(/\\/g, '/');
  const text = stripCssComments(readFileSync(p, 'utf8'));
  text.split('\n').forEach((line, i) => {
    // ★ `font-size: var(--fs-11, 11px)` 里的那个 `11px` 是**兜底值**，不是裸字面量
    const withoutFallbacks = line.replace(/var\(\s*--fs-[\w-]+\s*,\s*[\d.]+px\s*\)/g, 'VAR');
    for (const m of withoutFallbacks.matchAll(/font-size:\s*([\d.]+px)/g)) {
      literalHits.push(`${rel}:${i + 1}  ${m[1]}`);
    }
    for (const m of text.split('\n')[i].matchAll(/var\(\s*(--fs-[\w-]+)/g)) {
      if (!(m[1] in EXPECTED)) {
        badVarHits.push(`${rel}:${i + 1}  ${m[1]}`);
      }
    }
  });
}
check('没有裸 px 的 font-size 字面量', literalHits.length === 0,
  literalHits.slice(0, 6).join(' / ') || '全仓 0 处');
check('每一处 font-size 都引用那 7 档之一', badVarHits.length === 0,
  [...new Set(badVarHits)].slice(0, 6).join(' / ') || '全仓 0 处');

// ★ 自证：真的扫到了字号（否则上面两条在"零处 font-size"时**恒真**）
let fsCount = 0;
for (const p of files) {
  fsCount += (stripCssComments(readFileSync(p, 'utf8')).match(/font-size:/g) ?? []).length;
}
check('自证：全仓确实有 font-size（否则上两条恒真）', fsCount > 40, `${fsCount} 处`);

/* ────────────────────────── ④ ≥13px 的档相差 ≥2px ────────────────────────── */
console.log('\n=== ④ 档与档之间不得只差 1px（≥13px 部分）===');
const grades = [...declared.entries()]
  .map(([k, v]) => [k, parseFloat(v)])
  .filter(([, px]) => Number.isFinite(px) && px >= 13)
  .sort((a, b) => a[1] - b[1]);
const tooClose = [];
for (let i = 1; i < grades.length; i++) {
  const gap = grades[i][1] - grades[i - 1][1];
  if (gap < 2) {
    tooClose.push(`${grades[i - 1][0]}=${grades[i - 1][1]}px 与 ${grades[i][0]}=${grades[i][1]}px 只差 ${gap}px`);
  }
}
check('≥13px 的相邻档相差 ≥2px', tooClose.length === 0,
  tooClose.join(' / ') || `${grades.length} 档参与（小的两档 <13px 属微标签层，不受此约束）`);

/* ────────────────────────── ⑤ Shadow DOM 那份必须带兜底 ────────────────────────── */
console.log('\n=== ⑤ 注入宿主页 Shadow DOM 的样式必须带兜底值 ===');
/*
 * ★ 哪些文件属于这一类，**不能靠文件名猜**：判据必须是"它有没有被内联进 Shadow DOM"。
 *   实测的答案是：`content/` 下那三个 overlay 把 `ACCT_GRID_CSS + OVERLAY_CHROME_CSS`
 *   塞进 `style.textContent`。⇒ 所以这里查的是**那两个导出字符串**里的 font-size，
 *   以及"谁 import 了它们并把它们内联"。
 */
const gridStyle = readFileSync(join(SRC, 'ui', 'wheel', 'grid-style.ts'), 'utf8');
const shadowStrings = [...gridStyle.matchAll(/export const (\w+_CSS) = `([\s\S]*?)`;/g)];
check('grid-style.ts 里找到了导出的样式字符串', shadowStrings.length > 0, `${shadowStrings.length} 个`);

const noFallback = [];
for (const [, name, body] of shadowStrings) {
  body.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*(--fs-[\w-]+)\s*\)/g)) {
      noFallback.push(`${name}:${i + 1}  var(${m[1]}) 无兜底`);
    }
  });
}
check('Shadow DOM 那份里没有"无兜底的 --fs-* 引用"', noFallback.length === 0,
  noFallback.slice(0, 5).join(' / ') || '全部带兜底');

// ★ 自证：那一份里**确实有** font-size 引用（否则上一条在"零引用"时恒真）
const fsInShadow = shadowStrings.reduce(
  (n, [, , body]) => n + (body.match(/font-size:\s*var\(--fs-/g) ?? []).length, 0);
check('自证：Shadow DOM 那份里确实有字号引用（否则上一条恒真）', fsInShadow > 0, `${fsInShadow} 处`);

// ★ 反向自证：兜底值必须与令牌的值**一致**（否则两种情形渲染不同 —— 那正是要防的）
const mismatch = [];
for (const [, name, body] of shadowStrings) {
  for (const m of body.matchAll(/var\(\s*(--fs-[\w-]+)\s*,\s*([\d.]+)px\s*\)/g)) {
    const tokVal = EXPECTED[m[1]];
    if (tokVal && tokVal !== `${m[2]}px`) {
      mismatch.push(`${name}: ${m[1]} 的兜底 ${m[2]}px ≠ 令牌值 ${tokVal}`);
    }
  }
}
check('兜底值与令牌值一致（两种情形渲染相同）', mismatch.length === 0,
  [...new Set(mismatch)].slice(0, 5).join(' / ') || '全部一致');

/* ────────────────────────── 汇总 ────────────────────────── */
const bad = results.filter((r) => !r).length;
console.log(`\n=== 汇总：${results.length - bad}/${results.length} 通过 ===`);
console.log(bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
