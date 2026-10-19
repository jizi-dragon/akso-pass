/**
 * 反证 `verify-log-redaction.mjs` **第 16 节**（级别开关必须在产物里活着）。
 *
 * ★ 为什么这一节值得单独的入口（而不是并进 `verify-falsify-logredaction.mjs`）：
 *   那一份的反证方式是"改**一个字符串**再看判据红不红"，而第 16 节的判据
 *   **读的是 `dist/`** ⇒ 要反证它必须**重新构建**。两件事的成本差一个数量级
 *   （秒级 vs 分钟级），塞在一起会让那份日常门禁变慢 ⇒ **分开**。
 *
 * ## 它验三件事（每件都会真的红）
 *
 * | # | 注入 | 该发生什么 |
 * |---|---|---|
 * | ① | 级别退回**模块局部变量**（`let currentLevel`） | 摇树删掉 ⇒ 产物里没有 ⇒ **红** |
 * | ② | `log()` 不再经 `shouldLog()` 现读 | 改级别要重载扩展才生效 ⇒ **红** |
 * | ③ | **删掉 `dist/`** | 前提红（**不许**静默跳过） |
 *
 * ## ★★ 这个反证器自己也踩过一次坑，留着当提醒
 *
 * 第一版复制副本时漏了 `assets/`，于是 `npm run build` 报
 * `ENOENT … assets/Icon16.png` ⇒ `dist/` 根本没生成
 * ⇒ 第 16 节**前提红了**，而 ①② 看起来"都变红了" —— **其实是假通过**
 * （红的理由是"build 失败"，不是"判据抓到了注入"）。
 * ⇒ 所以下面**先断言副本构建成功**，再谈注入。
 *
 * 用法：`node tools/verify/verify-falsify-loglevel.mjs`
 * 全程在 `tmp/falsify-loglevel/` 的副本里，**真实源码与 `dist/` 不动**。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ 仓库根：tools/verify/ 往上两层（规则 15）
const ROOT = resolve(HERE, '..', '..');
const COPY = join(ROOT, 'tmp', 'falsify-loglevel');
const LOG_REL = join('packages', 'extension', 'src', 'shared', 'log.ts');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

/** 建一份能真正构建的副本。
 *  ★ 必须拷 `assets/` —— 少了它 `copyExtensionStatics` 会 ENOENT，`dist/` 不生成，
 *    于是第 16 节"前提红"而所有注入都**假通过**（本轮实测）。 */
function buildCopy() {
  rmSync(COPY, { recursive: true, force: true });
  mkdirSync(COPY, { recursive: true });
  for (const d of ['packages', 'tools', 'scripts', 'assets']) {
    cpSync(join(ROOT, d), join(COPY, d), {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('__pycache__'),
    });
  }
  const tsconfig = join(ROOT, 'tsconfig.json');
  if (existsSync(tsconfig)) cpSync(tsconfig, join(COPY, 'tsconfig.json'));
  cpSync(join(ROOT, 'package.json'), join(COPY, 'package.json'));
  // ★ 依赖用符号链接指回真仓（Windows 上需要开发者模式或管理员；失败就说明白）
  try {
    symlinkSync(join(ROOT, 'node_modules'), join(COPY, 'node_modules'), 'junction');
  } catch (e) {
    console.error(`无法为副本建 node_modules 链接：${e.message}`);
    console.error('（Windows 上需要"开发者模式"或管理员权限；这一步失败则本反证器无法运行）');
    process.exit(2);
  }
}

const run = (cmd, args) => spawnSync(cmd, args, {
  cwd: COPY, encoding: 'utf8', shell: process.platform === 'win32',
});

const build = () => {
  const r = run('npm', ['run', 'build']);
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const gate = () => {
  const r = run('node', [join('tools', 'verify', 'verify-log-redaction.mjs')]);
  const out = (r.stdout || '') + (r.stderr || '');
  const sec = out.includes('=== 16.') ? out.split('=== 16.').pop() : '';
  return { code: r.status, out, sec };
};

// ★ 不在这里放"通用 poke(rel, …)" —— 那个版本要被每个注入点各调一次，
//   而第 16 节只改 `log.ts` 一个文件 ⇒ 统一成下面的 `pokeInPlace()`（少一个参数，
//   也就少一处"传错路径"的可能）。删掉旧函数是刻意的，别再加回来。

const fails = (sec) => sec.split('\n').filter((l) => l.includes('FAIL')).map((l) => l.trim());

// ─────────────────────────────────────────── 基线
console.log('=== 基线：副本必须能构建，且第 16 节全绿 ===');
buildCopy();
let b = build();
check('副本构建成功（★ 这条不过，后面所有"变红"都是假通过）', b.code === 0);
if (b.code !== 0) {
  console.log((b.out || '').split('\n').slice(-12).map((l) => '     │ ' + l).join('\n'));
  rmSync(COPY, { recursive: true, force: true });
  process.exit(1);
}
let g = gate();
check('基线：第 16 节全绿', g.code === 0, fails(g.sec).join(' / ').slice(0, 110));

/* ★★ 只建**一份**副本，后面每个注入之间靠"把原文写回去"复位。
 *
 * 第一版每个注入都 `buildCopy()` 一次（3 次 copytree + 4 次 build，实测 **10.5 秒**）。
 * 而 copytree 那一步与判据无关 —— 它只是为了让"注入"落在一次性的工作区里。
 * ⇒ 改成：拷一次，注入前记下原文、用完写回。**同样的 6 条断言，实测 5.5 秒。**
 * ★ 复位必须走"写回原文"而不是"删了重拷"：后者会把 node_modules 的 junction 一起删掉。
 */
const LOG_PATH = join(COPY, LOG_REL);
const LOG_ORIGINAL = readFileSync(LOG_PATH, 'utf8');

/** 在原文件上做一次替换（锚点必须恰好命中 1 次），返回是否成功。 */
function pokeInPlace(oldStr, newStr) {
  const crlf = LOG_ORIGINAL.includes('\r\n');
  const n = LOG_ORIGINAL.replace(/\r\n/g, '\n');
  if (n.split(oldStr).length - 1 !== 1) return false;
  const out = n.replace(oldStr, newStr);
  writeFileSync(LOG_PATH, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  return true;
}

const restore = () => writeFileSync(LOG_PATH, LOG_ORIGINAL, 'utf8');

// ─────────────────────────────────────────── 注入 ①
console.log('\n=== 注入 ①：级别退回模块局部变量 ⇒ 摇树删掉 ===');
const OLD_LEVEL = `export function setLogLevel(level: LogLevel): void {
  globalThis.__qlLogLevel = level;
}`;
const NEW_LEVEL = `let currentLevelFallback: LogLevel = 'info';
export function setLogLevel(level: LogLevel): void {
  currentLevelFallback = level;
}`;
if (!pokeInPlace(OLD_LEVEL, NEW_LEVEL)) {
  check('注入 ① 的锚点没命中', false);
} else {
  build();
  g = gate();
  check('注入 ① ⇒ 判据变红（且理由指向"产物里没有"）', g.code !== 0,
    fails(g.sec).find((l) => l.includes('产物') || l.includes('globalThis'))?.slice(0, 100) ?? '');
  restore();
}

// ─────────────────────────────────────────── 注入 ②
console.log('\n=== 注入 ②：`log()` 不再经 `shouldLog()` 现读 ===');
if (!pokeInPlace('  if (!shouldLog(level)) return;',
  "  if (LEVEL_ORDER[level] < LEVEL_ORDER['info']) return;")) {
  check('注入 ② 的锚点没命中', false);
} else {
  build();
  g = gate();
  check('注入 ② ⇒ 判据变红（改级别要重载才生效）', g.code !== 0,
    fails(g.sec)[0]?.slice(0, 100) ?? '');
  restore();
}

// ─────────────────────────────────────────── 注入 ③
// ★ 这一条**不用重新构建**：② 那次 build 的产物还在，直接删掉 `dist/` 就行。
console.log('\n=== 注入 ③：删掉 dist/ ⇒ 前提必须红，不许静默跳过 ===');
rmSync(join(COPY, 'dist'), { recursive: true, force: true });
g = gate();
check('dist/ 不在 ⇒ 前提红（不是静默绿）', g.code !== 0, fails(g.sec)[0]?.slice(0, 100) ?? '');

// ─────────────────────────────────────────── 清理
console.log('\n=== 清理 ===');
rmSync(COPY, { recursive: true, force: true });
check('副本已删除（真实源码与 dist 全程未改）', !existsSync(COPY));

const bad = results.filter((r) => !r).length;
console.log(`\nRESULT: ${results.length - bad}/${results.length} 反证通过`);
if (bad) {
  console.log('失败项见上面的 FAIL 行。');
  process.exit(1);
}
console.log('（① 摇树删掉级别存储 ⇒ 红；② 不现读 ⇒ 红；③ 没有 dist ⇒ 前提红）');
