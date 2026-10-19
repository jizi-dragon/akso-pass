// run-all.mjs —— 批量跑 tools/verify/ 下的验证脚本
//
// 为什么需要它：这批脚本原先散落在 gitignored 的 tmp/ 里，
// 没有任何入口能一次跑完（只能靠 SESSION-STATE.md 里手写的"七套回归"清单）。
//
// ## ★★ 2026-10-16 修正一处**长期说反了的**描述
//
// 本文件此前一直写着"每个脚本都会真起一个带扩展的 Chromium（数十秒…）"，
// 并据此**拒绝**不带 `--browser` 的运行。**实测那句话是错的**：
// 37 个脚本里只有 **8 个**真起 Chromium，其余 **29 个是纯静态、秒级**的
// （打码、图标、CSS 变量、品牌色、文档、规则预算、缺陷回归、刻度判据…）。
//
// ⇒ 那个说法有一个真实的代价：**为了改一行 CSS 而被迫等 88 秒**（实测全量耗时），
//   于是"跑一下验证"这件事会被跳过 —— 而"没人愿意按的门禁等于没有门禁"。
//
// ## 现在分两组，且**分类是可核对的**
//
// | 组 | 数量 | 耗时（2026-10-16 实测） | 怎么跑 |
// |---|---|---|---|
// | 静态（不需要浏览器） | 23 | ~45 s | `--static` |
// | 浏览器（真起 Chromium） | 14 | ~43 s | `--browser-only` |
// | 全部 | 37 | ~88 s | `--browser`（保持原语义，仍然要显式确认） |
//
// ★ 静态那 45 秒里 **29 秒是两个 `falsify` 脚本**（`logredaction` 16.5s +
//   `typescale` 12.7s）—— 它们各自要把仓库拷进 `tmp/` 再逐个注入缺陷。
//   其余 21 个静态脚本合计约 16 秒。⇒ 想更快就 `--only <名字>`。
//
// ★ 分类写在下面的 `BROWSER_SCRIPTS` 里，并且**有一条自证**：
//   凡是会加载 `playwright-core` 的脚本**必须**在名单里，反之亦然。
//   ⇒ 新加一个起浏览器的脚本却忘了登记，会**当场报出来**，而不是悄悄混进快组。
//
// 用法：
//   node tools/verify/run-all.mjs --list                 只列清单（分组显示）
//   node tools/verify/run-all.mjs --static               只跑 29 个静态脚本（~33 s）
//   node tools/verify/run-all.mjs --browser-only         只跑 8 个浏览器脚本（~55 s）
//   node tools/verify/run-all.mjs --browser              跑全部（数量见 --list，别在注释里写死）
//   node tools/verify/run-all.mjs --browser --only v310  只跑匹配的
//
// ★★ 这里**刻意不写"跑全部 N 个"**：这个注释曾长期写着 `12 个`，而脚本是
//   `readdirSync` 自动发现的 —— 实测那时盘上已有 25 个。
//   一个没人会去核对的数字会安静地过期，而它旁边就有一行能算出真值的命令。
//   ⇒ 要数字就跑 `--list`（它打印的正是运行时真实数量）。
//   （上面表格里的数量与秒数是 **2026-10-16 实测值**，
//     它们是"这个划分值不值得"的依据，不是需要保持准确的契约。）

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const wantBrowser = args.includes('--browser');
const wantStatic = args.includes('--static');
const wantBrowserOnly = args.includes('--browser-only');
const listOnly = args.includes('--list');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const timeoutIdx = args.indexOf('--timeout-ms');
const TIMEOUT_MS = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 180_000;

/** 真起 Chromium 的那些（判据：加载 `playwright-core`）。
 *  ★ 这份名单由下面的 `assertRoster()` 与源码**双向核对**，不会静默过期。
 *  ★★ 2026-10-16：`verify-track.mjs` 已下线（它验 v3.9 的环形扇区，而那个形态
 *     v4.1 已被网格平铺取代 ⇒ 它**永远不可能通过**）。名单里也随之移除 ——
 *     而 `assertRoster()` 那条 `ghost` 检查**当场把它报了出来**
 *     （"名单里有不存在的脚本：verify-track.mjs"），这正是那条自证存在的意义。 */
const BROWSER_SCRIPTS = new Set([
  'verify-acct-grid.mjs',
  'verify-adopt.mjs',
  'verify-autologin.mjs',
  'verify-boxmgmt.mjs',
  'verify-defbox.mjs',
  'verify-defect.mjs',
  'verify-dynsnap.mjs',
  'verify-fillrhythm.mjs',
  'verify-httpscheme.mjs',
  'verify-impgrant.mjs',
  'verify-jarhygiene.mjs',
  'verify-load.mjs',
  'verify-v310.mjs',
]);

// probe-create 是诊断探针（无断言），不列入批量回归
const all = fs.readdirSync(HERE)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
  .sort();

/* ---- 自证：名单必须与源码一致（两个方向都查）----
 * ★ 只查一个方向是不够的：漏登记 ⇒ 它悄悄混进"秒级"那一组拖慢快跑；
 *   多登记 ⇒ 一个静态脚本被无谓地排除在快跑之外，而**没人会发现**。
 *
 * ★★ 判据的取法（第一版在这里报了一个**假红**）：
 *   第一版查的是"源码里有 `from 'playwright…'`"—— 那是**静态 import 的形状**，
 *   而 `verify-acct-grid.mjs` 用的是**动态** `await import(pathToFileURL(…'node_modules/playwright-core/index.mjs'))`
 *   ⇒ 它被报成"多登记"，而它确实起浏览器。
 *   ⇒ 改成查"**有没有真的加载那个模块**"：任何形态（静态/动态）都会出现那个路径片段。
 *     这个形状更贴近判据想表达的语义（"它会不会去加载 playwright"），
 *     而不是"它用了哪种 import 语法"。
 */
function assertRoster() {
  const actually = new Set();
  for (const f of all) {
    const src = fs.readFileSync(path.join(HERE, f), 'utf8');
    if (/playwright-core|from\s+['"]playwright/.test(src)) actually.add(f);
  }
  const missing = [...actually].filter((f) => !BROWSER_SCRIPTS.has(f));
  const extra = [...BROWSER_SCRIPTS].filter((f) => !actually.has(f) && all.includes(f));
  const ghost = [...BROWSER_SCRIPTS].filter((f) => !all.includes(f));
  if (missing.length || extra.length || ghost.length) {
    console.error('BROWSER_SCRIPTS 名单与源码不一致 —— 快/慢分组会分错：');
    if (missing.length) console.error(`  漏登记（真的起了 Chromium 却没进名单）：${missing.join(', ')}`);
    if (extra.length) console.error(`  多登记（没起 Chromium 却在名单里）：${extra.join(', ')}`);
    if (ghost.length) console.error(`  名单里有不存在的脚本：${ghost.join(', ')}`);
    console.error('  修法：改本文件顶部的 BROWSER_SCRIPTS（它是唯一权威）。');
    process.exit(3);
  }
}
assertRoster();

const scripts = all
  .filter((f) => (only ? f.includes(only) : true))
  .filter((f) => {
    if (wantStatic && !wantBrowserOnly) return !BROWSER_SCRIPTS.has(f);
    if (wantBrowserOnly && !wantStatic) return BROWSER_SCRIPTS.has(f);
    return true;
  });

if (listOnly) {
  const stat = all.filter((f) => !BROWSER_SCRIPTS.has(f));
  const brow = all.filter((f) => BROWSER_SCRIPTS.has(f));
  console.log(`可用验证脚本 ${all.length} 个（另有 probe-create.mjs 为诊断探针，不含在内）：`);
  console.log(`\n  ── 静态 ${stat.length} 个（不需要浏览器，秒级）──`);
  stat.forEach((s) => console.log('    ' + s));
  console.log(`\n  ── 浏览器 ${brow.length} 个（真起 Chromium）──`);
  brow.forEach((s) => console.log('    ' + s));
  process.exit(0);
}

if (!scripts.length) {
  console.error(only ? `--only ${only} 没有匹配到任何脚本` : '未找到任何 verify-*.mjs');
  process.exit(2);
}

if (!wantBrowser && !wantStatic && !wantBrowserOnly) {
  console.error('拒绝运行：跑全部会真起 Chromium，请显式确认。\n');
  console.error(`  待运行 ${scripts.length} 个脚本：`);
  scripts.forEach((s) => console.error('    ' + s));
  console.error('\n用法：');
  console.error('  node tools/verify/run-all.mjs --static              只跑静态脚本（秒级，日常改一行就跑它）');
  console.error('  node tools/verify/run-all.mjs --browser-only        只跑浏览器脚本');
  console.error('  node tools/verify/run-all.mjs --browser              跑全部');
  console.error('  node tools/verify/run-all.mjs --browser --only v310  只跑匹配的');
  console.error('  node tools/verify/run-all.mjs --list                 只列清单');
  process.exit(2);
}

// 前置：脚本要从 dist/manifest.json 读扩展 key
if (!fs.existsSync(path.join(ROOT, 'dist', 'manifest.json'))) {
  console.error('缺少 dist/manifest.json —— 请先 `npm run build`');
  console.error('（每个脚本都用 manifest 的 key 反推稳定扩展 ID，没有 dist 会直接抛错）');
  process.exit(2);
}

function runOne(file) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(HERE, file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ file, code: 'TIMEOUT', ms: Date.now() - started, out });
    }, TIMEOUT_MS);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ file, code, ms: Date.now() - started, out });
    });
  });
}

console.log(`=== 运行 ${scripts.length} 个验证脚本（单个超时 ${TIMEOUT_MS / 1000}s）===\n`);

const results = [];
for (const file of scripts) {
  process.stdout.write(`▶ ${file} ... `);
  const r = await runOne(file);
  const mark = r.code === 0 ? '✔ 通过' : `✖ 失败(${r.code})`;
  console.log(`${mark}  ${(r.ms / 1000).toFixed(1)}s`);
  if (r.code !== 0) {
    // 失败时把尾部输出打出来，便于直接定位
    const tail = r.out.trim().split(/\r?\n/).slice(-18).join('\n');
    console.log(tail.split('\n').map((l) => '    │ ' + l).join('\n'));
    console.log('');
  }
  results.push(r);
}

const passed = results.filter((r) => r.code === 0).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
for (const r of results) {
  if (r.code !== 0) console.log(`  ✖ ${r.file}  (exit ${r.code})`);
}

// 把结果落盘，便于对照 tools/verify/baseline/ 里的历史输出
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const logPath = path.join(ROOT, 'tmp', `verify-run-${stamp}.log`);
try {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, results.map((r) =>
    `\n${'='.repeat(70)}\n# ${r.file}  exit=${r.code}  ${(r.ms / 1000).toFixed(1)}s\n${'='.repeat(70)}\n${r.out}`
  ).join('\n'), 'utf8');
  console.log(`明细已写入 ${path.relative(ROOT, logPath)}`);
} catch (e) {
  console.log(`（明细落盘失败，不影响结论：${e.message}）`);
}

process.exit(passed === results.length ? 0 : 1);
