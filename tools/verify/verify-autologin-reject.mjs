/**
 * 判据：**「后台明确回绝 ⇒ 内容脚本立刻停」与「诊断包只许一种时间基准」各自要有判据**。
 *
 * 跑法：`node tools/verify/verify-autologin-reject.mjs` —— 纯静态、秒级（不启浏览器）。
 *
 * ## 为什么要有这一条（v4.6.3，2026-11-25）
 *
 * 两个都是**静默**缺陷 —— 不红、不报错，只是把证据糊掉：
 *
 * ① `autoLoginRejected` 在 `www.kdocs.cn` 一次会话打了 **18 条**（= 2 次页面加载 × 9 次退避），
 *    把 `ql:forensics` 环（**120**）刷掉 15%，真实失败被挤没了；9 条消息还会持续唤醒 MV3 的 SW。
 *    修法是让后台**明确回** `{ retry: false, reason }`、内容脚本收到就停 —— 而这类
 *    **跨文件契约**最容易被单边改动打破：后台换了回答形状、内容脚本照旧重试（或反过来），
 *    行为照样"看起来正常"，只是那 9 次空转与噪声又回来了，**没有任何门禁会红**。
 *
 * ② 诊断包里 `diagLog` 是 **UTC 的 `HH:mm:ss.SSS`、且没有日期**，`appLogs`/`forensics` 是
 *    epoch 毫秒、`exportedAt` 是 `Z` 的 ISO ⇒ **同一份证据三种基准**，我看错过一次
 *    （把 `06:21:36` 当成早上，实际是本地 `14:21:36`）。修法是统一走 `shared/time.ts`
 *    的 `stampLocal()`（本地时间 + 显式偏移 + 带日期）。
 *
 * ## 判据的形状
 *
 * | # | 断言 |
 * |---|---|
 * | 1 | 前提：三个源文件都在；`stampLocal` 是**唯一**实现（`getTimezoneOffset` 只在 time.ts） |
 * | 2 | 后台拒绝分支回 `{ retry: false, reason }`，且拒绝日志走降噪函数（带 `suppressed`） |
 * | 3 | 后台「绑定对了但没有待登录凭据」也回 `retry: false`（`no-pending-creds`） |
 * | 4 | 内容脚本的 `retry === false` 守卫**排在退避调度之前**，且守卫里 `return` |
 * | 5 | 全仓没有 `toISOString().slice(11, 23)`；两处 diag 走 `stampLocal()`；`exportedAt` 也是 |
 * | 6 | 自证（in-memory 反证）：把上述任一处改回缺陷形态，本脚本必须**变红** |
 *
 * ★ 第 6 条是**在内存里改字符串**，不落盘 —— 与 `verify-falsify-*.mjs` 那套"改文件再还原"
 *   相比，它不会因为中途异常把源码留在缺陷态（本仓踩过：判据自己把文件改坏、还原失败）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');
const TOOLS = join(ROOT, 'tools', 'verify');

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

const read = (rel, base = SRC) => readFileSync(join(base, rel), 'utf8');
const countOf = (hay, needle) => {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
};
/**
 * ★ 判据只认**代码**，不认注释：本仓的注释里会**故意**引用旧形态
 *   （`shared/time.ts` 的头注释就写着旧的 `toISOString().slice(11, 23)`，
 *   那是"为什么改"的证据，不该被判红）。⇒ 扫之前先把注释剥掉。
 *   `//` 前面要求有空白，避免把 `https://…` 当成注释。
 */
const stripComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/* ────────────────────────── 前提 ────────────────────────── */
const SW = 'background/service-worker.ts';
const CONTENT = 'content/auto-login.ts';
const TIME = 'shared/time.ts';
const PS = 'background/core/parallel-session.ts';
const TR = 'background/core/tab-rules.ts';
const UI = 'ui/parallel/parallel.ts';
const FALSIFY_FORENSICS = 'verify-falsify-forensics.mjs';

const sw = read(SW);
const content = read(CONTENT);
const time = read(TIME);
const ps = read(PS);
const tr = read(TR);
const ui = read(UI);
const falsifyForensics = read(FALSIFY_FORENSICS, TOOLS);
const allSrc = [sw, content, time, ps, tr, ui];
const allCode = stripComments(allSrc.join('\n'));

console.log('=== 前提 ===');
check('三个源文件都读得到（service-worker / auto-login / time）',
  [sw, content, time].every((s) => s.length > 500));
check('`stampLocal` 只有一处实现（代码里 `getTimezoneOffset` 只出现 1 次）',
  countOf(allCode, 'getTimezoneOffset') === 1,
  `${countOf(allCode, 'getTimezoneOffset')} 次（注释里的引用不算）`);
check('`shared/time.ts` 导出 `stampLocal`（导出名就是契约）',
  /export function stampLocal\(/.test(time));

/* ────────────────────────── ② 后台拒绝分支 ────────────────────────── */
/* 只取"拒绝分支"那段：从 `if (!boundHostBare || senderHost !== boundHostBare) {` 起 1200 字符。
 * ★ 范围要按语义划：整份文件里搜 `retry: false` 会把"没有凭据"那条也搜进来（那不是拒绝）。 */
const REJECT_IF = "if (!boundHostBare || senderHost !== boundHostBare) {";
const rejectAt = sw.indexOf(REJECT_IF);
const rejectWin = rejectAt === -1 ? '' : sw.slice(rejectAt, rejectAt + 1600);

console.log('\n=== ② 后台：拒绝必须明确回 `retry: false` ===');
check('找得到拒绝分支（`!boundHostBare || senderHost !== boundHostBare`）',
  rejectAt !== -1, rejectAt === -1 ? '锚点没匹配上' : '');
check('拒绝分支回 `{ retry: false, reason: … }`（不是 `null` —— 那会让内容脚本继续退避）',
  /sendResponse\(\{\s*retry:\s*false,\s*reason:[\s\S]{0,120}?\}\);/.test(rejectWin));
check('拒绝日志走降噪函数 `noteAutoLoginRejected(`（同 tab+frame+reason 十秒内只记首条）',
  /noteAutoLoginRejected\(\{/.test(rejectWin) && /function noteAutoLoginRejected\(/.test(sw));
check('降噪函数把被吞掉的次数带出来（`suppressed`）',
  /suppressed/.test(sw) && /forensics\('autoLoginRejected'/.test(sw));
check('降噪窗口是显式常量 `REJECT_DEDUPE_MS`（不是散落的魔法数）',
  /const REJECT_DEDUPE_MS = 10_000;/.test(sw));

console.log('\n=== ③ 后台：没有待登录凭据也要回绝 ===');
check('没有 pending 时回 `retry: false` + `no-pending-creds`',
  /sendResponse\(creds \?\? \{\s*retry:\s*false,\s*reason:\s*'no-pending-creds'\s*\}\)/.test(sw));

/* ────────────────────────── ④ 内容脚本 ────────────────────────── */
const GUARD = "if (res && typeof res === 'object' && (res as { retry?: unknown }).retry === false) {";
const SCHED = 'window.setTimeout(() => void requestCredentials(attempt + 1)';
const guardAt = content.indexOf(GUARD);
const schedAt = content.indexOf(SCHED);

console.log('\n=== ④ 内容脚本：收到回绝就停（且排在退避之前） ===');
check('找得到 `retry === false` 守卫', guardAt !== -1, guardAt === -1 ? '锚点没匹配上' : '');
check('守卫**排在**退避调度之前（顺序反了 = 还会再问一次，且这一条最难从行为上看出来）',
  guardAt !== -1 && schedAt !== -1 && guardAt < schedAt,
  guardAt === -1 || schedAt === -1 ? '锚点缺失' : `guard@${guardAt} sched@${schedAt}`);
const guardWin = guardAt === -1 ? '' : content.slice(guardAt, guardAt + 600);
check('守卫块里 `return`（不是 `return requestCredentials(...)` 之类的续命写法）',
  /return;\s*\}/.test(guardWin));
check('守卫之后没有"先排下一次、再判断"的残留（代码里该形态只出现 1 次）',
  countOf(stripComments(content), '(res as { retry?: unknown }).retry === false') === 1,
  `${countOf(stripComments(content), '(res as { retry?: unknown }).retry === false')} 次`);

/* ────────────────────────── ⑤ 时间基准 ────────────────────────── */
const diagNeedle = '${stampLocal()} ${msg}';
const isoSlice = 'toISOString().slice(11, 23)';

console.log('\n=== ⑤ 诊断包只许一种时间基准（本地 + 偏移 + 日期） ===');
check('代码里没有 `toISOString().slice(11, 23)`（UTC 无日期，正是要被消灭的形态）',
  countOf(allCode, isoSlice) === 0, `${countOf(allCode, isoSlice)} 次（注释里的引用不算）`);
check('两处 diag 环写入都走 `stampLocal()`（parallel-session + tab-rules）',
  countOf(allSrc.join('\n'), diagNeedle) === 2, `${countOf(allSrc.join('\n'), diagNeedle)} 处`);
check('`exportedAt` 两处都用 `stampLocal()`（备份包 + 诊断包）',
  countOf(allSrc.join('\n'), 'exportedAt: stampLocal()') === 2,
  `${countOf(allSrc.join('\n'), 'exportedAt: stampLocal()')} 处`);
check('没有 `exportedAt: new Date().toISOString()` 残留',
  countOf(allSrc.join('\n'), 'exportedAt: new Date().toISOString()') === 0);
check('反证脚本的两个注入锚点也跟上了（`verify-falsify-forensics.mjs` 不再钉旧形态）',
  countOf(falsifyForensics, isoSlice) === 0 && countOf(falsifyForensics, 'stampLocal()') === 2,
  `${countOf(falsifyForensics, isoSlice)} / ${countOf(falsifyForensics, 'stampLocal()')}`);

/* ────────────────────────── ⑥ 自证（in-memory 反证） ────────────────────────── */
/*
 * ★ 只在内存里改，不落盘。每项都断言"改成缺陷形态之后，对应那条判据**确实**会红"，
 *   否则这条判据就只是"字符串在不在"，而不是"这件事还成不成立"。
 */
console.log('\n=== ⑥ 自证：改回缺陷形态必须变红 ===');

const redOf = (name, mutate) => {
  const m = mutate();
  if (m === null) return false;
  const preds = {
    '后台拒绝回 null': () => /sendResponse\(\{\s*retry:\s*false,\s*reason:[\s\S]{0,120}?\}\);/.test(m.sw ?? ''),
    '内容脚本继续退避': () => {
      const g = (m.content ?? '').indexOf(GUARD);
      const s = (m.content ?? '').indexOf(SCHED);
      return g !== -1 && s !== -1 && g < s;
    },
    'exportedAt 回到 ISO': () => countOf(m.ui ?? '', 'exportedAt: stampLocal()') === 2,
    '诊断包出现 UTC 无日期': () => countOf(m.ps ?? '', isoSlice) === 0,
  }[name];
  return preds ? preds() : false;
};

const f1 = redOf('后台拒绝回 null', () => ({
  sw: sw.replace(/sendResponse\(\{\s*retry:\s*false,\s*reason:[\s\S]{0,160}?\}\);/, 'sendResponse(null);'),
}));
check('① 拒绝分支改回 `sendResponse(null)` ⇒ ②-a 的判据变红', f1 === false);

const f2 = redOf('内容脚本继续退避', () => ({
  content: content.replace(GUARD, "if (res && typeof res === 'object' && (res as { retry?: unknown }).retry === true) {"),
}));
check('② 内容脚本把 `retry === false` 改成 `=== true` ⇒ ④-a 的判据变红', f2 === false);

const f3 = redOf('exportedAt 回到 ISO', () => ({
  ui: ui.replace('exportedAt: stampLocal(),', 'exportedAt: new Date().toISOString(),'),
}));
check('③ 诊断包 `exportedAt` 回到 `toISOString()` ⇒ ⑤-c 的判据变红', f3 === false);

const f4 = redOf('诊断包出现 UTC 无日期', () => ({
  ps: ps.replace(diagNeedle, '${new Date().toISOString().slice(11, 23)} ${msg}'),
}));
check('④ diag 环写入回到 UTC 无日期 ⇒ ⑤-a 的判据变红', f4 === false);

/* ────────────────────────── 汇总 ────────────────────────── */
const bad = results.filter((r) => !r.ok).length;
console.log(`\n=== 汇总：${results.length - bad}/${results.length} 通过 ===`);
if (bad) {
  console.log('\n★ 修法：按上面 FAIL 的那一条，把源码改回「明确回绝」/「stampLocal」形态；');
  console.log('  两条契约分别落在 `service-worker.ts` 的拒绝分支与 `content/auto-login.ts` 的守卫。');
}
console.log(bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
