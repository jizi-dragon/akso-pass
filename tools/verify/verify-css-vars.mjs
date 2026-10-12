/**
 * CSS 变量卫生（**静态、不需要浏览器**）。
 *
 *     node tools/verify/verify-css-vars.mjs
 *
 * ## 它防的是哪一类"静默失效"
 *
 * ★ 这是"**存在 vs 被使用**"那一族的**第五个形态**（前四个见 `PITFALLS #19`/`#20`/
 *   `#23`/`#26`/`#29`）：前三者是"东西在、没人用"，而本类是
 *   ★★ "**引用了、却解析不到**" —— 浏览器**不报错**，只是：
 *
 *   · `var(--x)` **无 fallback 且无人定义** ⇒ **整条声明被丢弃**（这条 CSS 等于没写）；
 *   · `--x: var(--x)`（**自引用**）⇒ 变量等于未定义（循环引用），同样静默；
 *   · 同一变量在**同一条链上定义多次** ⇒ 后者胜，前者是**永远不生效的死规则**。
 *
 * ## 实测（2026-10-09）
 *
 * `wheel.css` 里品牌蓝 `#1e6fff` 一共出现 **12 次**（8 处 `var(--acc, ...)` 的 fallback
 * + 4 处裸硬编码），而 `theme.css` 里定义了一次 ⇒ **同一个颜色散在 13 处，改一处必漂**。
 * 整理时我又踩了一次：用全局替换 `#1e6fff → var(--acc)` 把 **`:root` 里那一行自己的值**
 * 也换掉了 ⇒ 变成 `--acc: var(--acc)` 的**自引用**。
 * ★ 而"截图逐字节相同"**没能发现它**（轮盘需要有账号才渲染，我截到的是空态）。
 * ⇒ 所以这条判据必须**静态**做，不能靠截图。
 *
 * ## 判据（逐页面按真实 CSS 依赖链解析）
 *
 * ① 每个页面 `<link rel=stylesheet>` → 递归 `@import`，得到该页的链；
 * ② 链上所有 `--x:` 定义算"已定义"；
 * ③ ★ **`var(--x)` 无 fallback 且解析不到 ⇒ FAIL**（有 fallback 的不算 —— 那是刻意的兜底）；
 * ④ ★ **`--x: var(--x)` 自引用 ⇒ FAIL**；
 * ⑤ ★ **同一个变量在同一条链上定义多次 ⇒ FAIL**（前者是永不生效的死规则）。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI = path.join(ROOT, 'packages', 'extension', 'src', 'ui');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, ' ');

/** 从一个 HTML 出发，按 `<link rel=stylesheet>` + 递归 `@import` 收集 CSS 链。
 *
 *  ★ 返回的 `seen` 已经**去重**，所以"环"不会让它死循环 —— 但那正是问题：
 *    **环会被静默吞掉**（看起来"链很短"），而浏览器对环的处理是实现相关的。
 *    ⇒ 下面 `cssChain` 额外返回 `cycles` 供判据使用。 */
function cssChain(htmlAbs) {
  const seen = [];
  const cycles = [];
  const missing = [];
  const queue = [];
  const html = readFileSync(htmlAbs, 'utf8');
  for (const tag of html.match(/<link[^>]+rel=["']stylesheet["'][^>]*>/gi) ?? []) {
    const m = /href=["']([^"']+)["']/i.exec(tag);
    if (m) queue.push({ p: path.resolve(path.dirname(htmlAbs), decodeURIComponent(m[1])), from: htmlAbs, depth: 0 });
  }
  while (queue.length) {
    const { p, from, depth } = queue.shift();
    if (!existsSync(p)) {
      // ★★ 2026-10-12：**这里原先直接 `continue`，把"缺文件"静默吞掉** ——
      //   于是"链很短"与"一切正常"在输出上长得一模一样。
      //   实测事故：`translate.html` 漏了一行 `<link href="../panel.css">`，
      //   该页**外壳样式一条都没加载**（`.hidden` 不存在 ⇒ 提示条常显、
      //   `.block-head.row` 的 flex 不存在 ⇒ 标题与开关上下堆叠、
      //   `.wrap` 的 min-height 不存在 ⇒ 保存条位置错乱），
      //   三处看起来毫不相干的"布局缺陷"其实是同一个缺失的 link，
      //   而**这个脚本当时是全绿的**。
      //   ⇒ 判据：每个 `<link rel=stylesheet>` 都必须解析到一个**存在**的文件。
      missing.push(`${path.basename(from)} → ${path.relative(UI, p).replace(/\\/g, '/')}`);
      continue;
    }
    if (seen.includes(p)) {
      // 已在链上 ⇒ 这是一条**重复引用**（环，或菱形依赖）
      cycles.push(`${path.basename(from)} → ${path.basename(p)}`);
      continue;
    }
    if (depth > 8) { cycles.push(`深度 > 8：${path.basename(p)}`); continue; }
    seen.push(p);
    const css = stripComments(readFileSync(p, 'utf8'));
    for (const m of css.matchAll(/@import\s+(?:url\()?["']([^"']+)["']/g)) {
      queue.push({ p: path.resolve(path.dirname(p), m[1]), from: p, depth: depth + 1 });
    }
  }
  return { chain: seen, cycles, missing };
}

console.log('=== 前提 ===');
check('src/ui 存在', existsSync(UI));
if (!existsSync(UI)) process.exit(1);
const htmls = readdirSync(UI, { recursive: true })
  .map((f) => path.join(UI, String(f)))
  .filter((f) => f.endsWith('.html'));
check('至少有一个扩展自有页面', htmls.length > 0, `${htmls.length} 个`);
if (!htmls.length) process.exit(1);

//: 全目录的样式文件（"定义的变量有没有人用"要按**全目录**算，见 ③b 的注释）
const allUi = readdirSync(UI, { recursive: true })
  .map((f) => path.join(UI, String(f)))
  .filter((f) => f.endsWith('.css'));
check('至少有一个样式文件', allUi.length > 0, `${allUi.length} 个`);

let totalChainFiles = 0;
for (const html of htmls) {
  const rel = path.relative(UI, html).replace(/\\/g, '/');
  console.log(`\n=== ${rel} ===`);
  const { chain, cycles, missing } = cssChain(html);
  totalChainFiles += chain.length;
  // ★★ 每个 `<link rel=stylesheet>` 都必须指向**存在**的文件。
  //   这是本轮（2026-10-12）真实事故的判据：漏一个 link ⇒ 整页外壳样式不加载，
  //   而"链很短"与"一切正常"在旧输出里长得一模一样（旧实现在缺文件时直接 continue）。
  check(`${rel} 的每个 <link> 都指向存在的文件`, missing.length === 0,
    missing.length ? `缺失：${missing.join(' / ')}` : `${chain.length} 个都命中`);
  check(`${rel} 的样式链非空`, chain.length > 0,
    chain.map((c) => path.basename(c)).join(' → ') || '（空）');
  // ★★ 环 / 重复引用：`@import` 成环时**浏览器行为是实现相关的**，而"去重"会把环静默吞掉
  //    ⇒ 单独一条判据把它暴露出来（抽取 `tokens.css` 这类重构最容易踩）。
  check(`${rel} 的样式链无环、无重复引用`, cycles.length === 0,
    cycles.join(' ') || `${chain.length} 个文件`);
  if (!chain.length) continue;

  // ── 收集:定义与引用
  const defs = new Map();          // 变量名 → [文件, ...]
  const usedNoFb = new Map();      // 无 fallback 的 var()
  const selfRef = [];
  for (const c of chain) {
    const base = path.basename(c);
    const t = stripComments(readFileSync(c, 'utf8'));
    for (const m of t.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) {
      if (!defs.has(m[1])) defs.set(m[1], []);
      if (!defs.get(m[1]).includes(base)) defs.get(m[1]).push(base);
    }
    for (const m of t.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*var\(\s*(--[A-Za-z0-9_-]+)/g)) {
      if (m[1] === m[2]) selfRef.push(`${base}: ${m[1]}`);
    }
    // `var(--x)` 无逗号 ⇒ 无 fallback
    for (const m of t.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
      if (!usedNoFb.has(m[1])) usedNoFb.set(m[1], new Set());
      usedNoFb.get(m[1]).add(base);
    }
  }

  check(`判据前提：链上至少定义 1 个变量（否则下面全是空断言）`, defs.size > 0,
    `${defs.size} 个`);

  // ── ③ 无 fallback 且解析不到
  const unresolved = [...usedNoFb.entries()]
    .filter(([name]) => !defs.has(name))
    .map(([name, where]) => `${name}(在 ${[...where].join(',')})`);
  check(`${rel} 无「var() 无 fallback 又解析不到」`, unresolved.length === 0,
    unresolved.join(' ') || `检查了 ${usedNoFb.size} 个`);

  // ── ③b ★★ **反方向**：链上定义的变量，在**整个 UI 目录**里有没有人用
  //
  // ★ 为什么把范围放到"整个 UI 目录"而不是"本页的链"：
  //   `theme.css` 里的 `--sb-brand-hover` / `--sb-bg` **只在 theme.css 自己的
  //   第 36/48/56 行被用**（按钮渐变、页面底色）——
  //   按"本页的链"算它们是"被用了"，但它们**确实只服务定义它们的那个文件**。
  //   那些是**合法的**（文件内部的自用变量），所以判据必须**按全目录的引用**来算，
  //   而不是按链 —— 否则会把 `theme.css` 的自用变量报成死变量。
  //   ★★ 我第一版探针就栽在这里：它**把 `theme.css` 排除在"使用者"之外** ⇒
  //      造出了两个假缺陷。**"谁算使用者"这个范围，划错一次就是一次假红。**
  const allUiText = allUi.map((p) => stripComments(readFileSync(p, 'utf8'))).join('\n');
  const unused = [...defs.keys()].filter(
    (name) => !new RegExp(`var\\(\\s*${name.replace(/[-]/g, '\\-')}\\b`).test(allUiText));
  check(`${rel} 定义的变量都有人用（反方向）`, unused.length === 0,
    unused.join(' ') || `检查了 ${defs.size} 个`);

  // ── ④ 自引用
  check(`${rel} 无自引用变量（--x: var(--x)）`, selfRef.length === 0, selfRef.join(' '));

  // ── ⑤ 同一条链上重复定义
  const dup = [...defs.entries()].filter(([, files]) => files.length > 1);
  // ★ 重复定义**不一定是缺陷**（子文件刻意覆盖主题是常见手法）⇒ 只报告，不判红
  if (dup.length) {
    console.log(`  （参考）链上重复定义的变量 ${dup.length} 个：` +
      dup.map(([n, f]) => `${n}(${f.join(',')})`).join(' '));
  }
}

console.log('\n=== 自证：确实解析到了多份 CSS（否则上面每页都只看了 1 个文件）===');
check('跨页面累计解析的链文件数 >= 页面数', totalChainFiles >= htmls.length,
  `${totalChainFiles} 个文件 / ${htmls.length} 个页面`);

/* ==================== 块注释配平（v4.2.1 新增）====================
 *
 * ## 为什么要有这条（两次真实事故，都是我造成的）
 *
 * 用 `edit` 把一段"带注释开头的代码块"换掉时，如果锚点**从注释正文中间**开始，
 * 那么注释的开头标记会被留在旧位置、而正文被搬到新位置 ⇒ 结果是一个**没有开头**的
 * 注释正文，紧跟其后的下一条规则被**整个吞掉**（★ 本段自己就踩过这个坑：
 * 我在这里写了一个字面的注释结束标记，把整段注释提前结束了 ⇒ 脚本直接语法错）：
 *   · 第一次：`shared/snake-case.ts` —— 吞掉了 `looksLikeDictionaryEntry` 的文档注释
 *   · 第二次：`ui/popup/popup.css` —— 吞掉了 `.hidden { display:none !important }`，
 *     于是弹窗里所有靠 `.hidden` 显隐的元素**永远显示**
 *   · 第三次：本条判据自己的注释 —— 语法错，脚本起不来（比前两次"好"，因为它响了）
 *
 * ## 为什么它必须是被判据而不是靠"小心"
 *
 * **两种形态都不会报错**：CSS 被吞 ⇒ 浏览器只是少应用一条规则；TS 被吞 ⇒ 只是少一段
 * 注释。`tsc` 绿、`npm run build` 绿、`verify-load` 绿。唯一的信号是**运行时行为不对**，
 * 而那时你会去查业务代码，不会去数注释。
 *
 * ★ 判据：`src/` 下每个 `.ts` / `.css` 文件里，注释**开始标记**与**结束标记**的数量
 *   必须相等，且扫完之后**不能停在注释内部**（`depth !== 0`）。
 *   —— 单靠数量相等会漏掉"多一个开始又多一个结束"的错配，所以要**同时**看最终深度。
 *   ★ 注意：注释里**不能**写出这两个标记的字面量 —— 本段第三次踩坑就是这么来的。
 */
console.log('\n=== 块注释配平（吃掉规则不会报错，只能靠判据）===');
const SRC = path.join(ROOT, 'packages', 'extension', 'src');
const srcFiles = readdirSync(SRC, { recursive: true })
  .map((f) => path.join(SRC, String(f)))
  .filter((f) => f.endsWith('.ts') || f.endsWith('.css'));
check('src 下有可扫的源文件', srcFiles.length > 0, `${srcFiles.length} 个`);
const unbalanced = [];
const lineCommentFakeClosers = [];
for (const f of srcFiles) {
  const text = readFileSync(f, 'utf8');
  /* ★ 逐字符走一遍。**三种上下文必须都处理**，少一种就会误报：
   *   · 字符串 / 模板串   —— 里面的标记是文本，不是注释
   *   · **行注释**（双斜杠）—— ★ 这一条是实测补上的：`parallel.ts` 里有一句讲
   *     "跳过全通配行"的注释，正文里带着一个通配 URL 模式（星号 + 协议 + 双斜杠 +
   *     路径），结尾恰好是"星号紧跟斜杠" —— 那被当成了块注释结束 ⇒ 于是"未闭合"
   *     从错误的地方开始算，最终报出 depth=2 的**假红**。
   *     而假红的代价是这条判据被绕过（规则 17 的同类）。
   *   · 块注释            —— 这一层才是我们真正要数的
   *   正则字面量**不特殊处理**：在本仓 `src/` 下实测零命中"正则里含注释标记"，
   *   为一个不存在的形态加状态机只会引入新误报。
   *   ★ 注意：本段自己**不能**出现那两个标记的字面量 —— 我已经在这上面栽了四次。
   */
  let depth = 0;
  let quote = null;
  let lineComment = false;
  let line = 1;
  let pendingCloseInLineComment = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const n = text[i + 1];
    if (c === '\n') { line += 1; lineComment = false; continue; }
    if (lineComment) {
      // 行注释里出现的块注释结束标记：**不会被吃掉**（行注释先结束），
      // 但它会让"配平"这件事变得不可判定 ⇒ 单独列出来，不当作失衡。
      if (c === '*' && n === '/') { pendingCloseInLineComment += 1; i += 1; }
      continue;
    }
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) { quote = null; }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    // 行注释：只在**不是**块注释内部时才成立（块注释里的 `//` 是文本）
    if (c === '/' && n === '/' && depth === 0) { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { depth += 1; i += 1; continue; }
    if (c === '*' && n === '/') { depth -= 1; i += 1; continue; }
  }
  if (depth !== 0) {
    unbalanced.push(`${path.relative(SRC, f).replace(/\\/g, '/')}(深度 ${depth}，末行 ${line})`);
  }
  if (pendingCloseInLineComment > 0) {
    lineCommentFakeClosers.push(`${path.relative(SRC, f).replace(/\\/g, '/')}(${pendingCloseInLineComment} 处)`);
  }
}
check(`src 下 ${srcFiles.length} 个源文件的块注释都配平`, unbalanced.length === 0,
  (unbalanced.length ? `未配平：${unbalanced.join(' / ')}` : `扫了 ${srcFiles.length} 个文件`)
  // ★ 把"行注释里含注释结束标记"的干扰源**如实报出来**，但**不作为失败**：
  //   那是**完全正常的写法**（`parallel.ts` 那句讲通配 URL 的注释就是），
  //   把它判红等于让一条判据长期假红 —— 而假红会被绕过（规则 17）。
  //   扫描器本身已经正确处理了这种形态（上面刚修），所以这里只是**披露**。
  + (lineCommentFakeClosers.length
    ? `；其中 ${lineCommentFakeClosers.length} 个文件的行注释里含结束标记（扫描器已正确跳过）：${lineCommentFakeClosers.join(' / ')}`
    : '；无行注释干扰源'));

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
