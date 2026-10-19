/**
 * 判据：**"加脚本要同步 README 表格"这条约定，本身必须有一条判据**。
 *
 * 跑法：`node tools/verify/verify-script-roster.mjs` —— 纯静态、秒级。
 *
 * ## 为什么要有这一条（这不是洁癖，是已经退化过两次的事故）
 *
 * `tools/verify/README.md` 那张脚本表**已经漏收过两次**：
 * `verify-agents-budget.mjs` 与 `verify-boxsync.mjs` —— 它们**在盘上跑了很久、
 * 却从未出现在表里**。而那次是**靠人肉对账**发现的（把 `run-all.mjs --list`
 * 与表格逐个比对）。
 *
 * ★ README 里写着一句诚实的话：
 *   > ★ 注意：**"脚本清单 vs 本表"的自动比对目前仍然没有**
 *   > （本轮补的是"死协议"，不是"清单同步"）。
 * 这一条判据就是把那句话补上 —— **约定没有判据 = 约定会退化**（本仓规则 13 的同族）。
 *
 * ## 判据的形状
 *
 * | # | 断言 |
 * |---|---|
 * | 1 | 盘上每个 `verify-*.mjs` 都在 README 里**被提到**（漏收 = 别人不知道它存在） |
 * | 2 | 反向：README 表格里不留**指向不存在的脚本**的条目 |
 * | 3 | README 里那个"共 N 个"的**活数字**必须等于盘上实际个数 |
 * | 4 | 自证：盘上脚本数 > 20（否则前三条在"几乎没脚本"时恒真） |
 *
 * ★ 第 3 条治的是 README 自己记过的那件事：那个数字**连续写错过五次**
 *   （`14/20/24/26/27/28/29` 各错过一次），因为"一个没人会去核对的数字，
 *   会安静地过期好几个月"。⇒ 现在它是被算出来的，不是被数出来的。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIR = join(ROOT, 'tools', 'verify');
const README = join(DIR, 'README.md');

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${extra ? '  ' + extra : ''}`);
};

/* ────────────────────────── 前提 ────────────────────────── */
const onDisk = readdirSync(DIR).filter((f) => /^verify-.*\.mjs$/.test(f)).sort();
const readme = readFileSync(README, 'utf8');

console.log('=== 前提 ===');
check('扫到了 `verify-*.mjs`', onDisk.length > 0, `${onDisk.length} 个`);
/* ★ 自证：脚本太少时，"每个都在 README 里"必然为真 —— 那条断言会退化成恒真 */
check('自证：盘上脚本数 > 20（否则下面的"都在"会恒真）', onDisk.length > 20,
  `${onDisk.length} 个`);

/* ────────────────────────── ① 漏收 ────────────────────────── */
console.log('\n=== ① 盘上每个脚本都在 README 里 ===');
const notListed = onDisk.filter((f) => !readme.includes(f));
check('没有"在盘上却从未进过 README"的脚本', notListed.length === 0,
  notListed.join(' ') || `${onDisk.length} 个全部在册`);

/* ────────────────────────── ② 反向：表格里不留幽灵 ────────────────────────── */
console.log('\n=== ② 反向：README 里不许提到不存在的脚本 ===');
/*
 * ★ 只扫**表格里的代码片段**（`` `verify-xxx.mjs` ``），不扫正文 ——
 *   正文里会**故意**提到"曾经漏收的 `verify-agents-budget.mjs`"这类历史叙述，
 *   而那不是"幽灵条目"。⇒ **判据的范围要按它的语义划**（本仓规则 23）。
 */
/* ★★ 2026-10-16：判据要认得"**已下线**"这件事，否则它会逼出一个更坏的写法。
 *
 * 背景：`verify-track.mjs` 验的是 **v3.9 的环形扇区**，而那个形态在 v4.1
 * 已被网格平铺取代（`ui/wheel/*.ts` 里 `arc` / `扇形` / `轨道` 的匹配数 = 0）
 * ⇒ 它**永远不可能通过**（第一条断言就 `TypeError`）。
 * 一个永远红的判据比没有判据更坏：它训练所有人"红的是正常的"。
 *
 * ⇒ 我把它删了，并在 README 表格里留了一行说明（**保留记录**，别让下一个人
 *   以为这块从没验过）。于是本条判据报"幽灵条目"——**那次红是对的**，
 *   它指出的是"判据只认'在盘上'，不认'已下线'"。
 *
 * ★★ 而错误的修法有两种，都比留着一个红判据更坏：
 *   ① 把那行的文件名**去掉 `.mjs`** 让它不被正则匹配 ⇒ 躲过判据（自欺）；
 *   ② 把已下线的脚本**留着不删** ⇒ 继续红（训练忽略红色）。
 * ⇒ 正解是让判据**显式认得"下线"**：维护一张 `RETIRED` 名单，
 *   名单里的脚本**必须在 README 里被提到且标了"下线"**，盘上**必须不存在**。
 *   这样"下线"变成一个**被校验的状态**，而不是一个可以随手糊过去的口子。
 */
const RETIRED = new Map([
  ['verify-track.mjs', '验 v3.9 环形扇区；该形态 v4.1 已被网格取代（覆盖转到 '
    + 'verify-acct-grid / verify-boxmgmt / verify-defbox）。网格版的切盒/页码点目前无覆盖'],
]);

const ghosts = [];
const ghostRetired = [];
for (const line of readme.split('\n')) {
  if (!line.trim().startsWith('|')) continue; // 只看表格行
  for (const m of line.matchAll(/`(verify-[\w-]+\.mjs)`/g)) {
    if (onDisk.includes(m[1])) continue;
    // 已下线的：允许提到，但那一行必须**写明"下线"**（否则读者以为它还在跑）
    if (RETIRED.has(m[1])) {
      if (!/下线|已删|retired/i.test(line)) ghostRetired.push(m[1]);
      continue;
    }
    ghosts.push(m[1]);
  }
}
check('表格里没有指向不存在脚本的条目（已下线的除外）', ghosts.length === 0,
  [...new Set(ghosts)].join(' ') || '0 条幽灵');
// ★ 自证：已下线名单里的脚本，那一行必须**明说下线**（否则等于悄悄藏起来）
check('已下线的脚本在 README 里被明说"下线"（不是悄悄消失）',
  ghostRetired.length === 0, [...new Set(ghostRetired)].join(' ') || '0 条未标注');
// ★ 自证：已下线的**必须真的不在盘上**（否则名单过期，而它会继续假装被下线）
const resurrected = [...RETIRED.keys()].filter((f) => onDisk.includes(f));
check('已下线的脚本确实不在盘上（名单没过期）', resurrected.length === 0,
  resurrected.join(' ') || '0 个复活');

/* ────────────────────────── ③ 活数字 ────────────────────────── */
console.log('\n=== ③ README 里那个"共 N 个"必须等于实际 ===');
/*
 * ★ 只认**明确的计数声明**这一种形状：`` `N 个` `` 紧跟在"本表"或"共"后面，
 *   或者 `(Get-ChildItem tools/verify/verify-*.mjs).Count   # N` 那条命令的注释。
 *   ⇒ 不去猜"随便一个数字"，因为 README 里到处是 `14/20/24` 这类**历史修正记录**
 *     （它们是**故意**留着的，不该被判红）。
 */
const declared = new Set();
for (const m of readme.matchAll(/本表里的"(\d+) 个"/g)) declared.add(Number(m[1]));
for (const m of readme.matchAll(/verify-\*\.mjs\)\.Count\s*#\s*(\d+)/g)) declared.add(Number(m[1]));
const wrongCounts = [...declared].filter((n) => n !== onDisk.length);
check('计数声明与实际个数一致', wrongCounts.length === 0,
  wrongCounts.length
    ? `声明 ${wrongCounts.join('/')} ≠ 实际 ${onDisk.length}`
    : `声明与实际都是 ${onDisk.length}`);
check('自证：README 里确实有计数声明（否则上一条恒真）', declared.size > 0,
  `${declared.size} 处：${[...declared].join('/')}`);

/* ────────────────────────── 汇总 ────────────────────────── */
const bad = results.filter((r) => !r).length;
console.log(`\n=== 汇总：${results.length - bad}/${results.length} 通过 ===`);
if (bad) {
  console.log('\n★ 修法：把新脚本补进 `tools/verify/README.md` 的那张表（一行），');
  console.log('  并把"本表里的 `N 个`"与 `(Get-ChildItem …).Count  # N` 那个数字改成实际值。');
}
console.log(bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
