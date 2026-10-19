/**
 * 反证 `verify-type-scale.mjs`：把"修复前"的每一种写法注回去，判据必须变红。
 *
 * 跑法：`node tools/verify/verify-falsify-typescale.mjs`
 *
 * ## 为什么每一条都要注入（而不是"看着判据挺全的"）
 *
 * 本仓的纪律是**判据先反证再相信**（AGENTS 规则 17），而这条判据有五组断言、
 * 其中两组（②③）在"零处 `font-size`"时会**恒真**、⑤ 在"零引用"时也会恒真。
 * ⇒ 只验"它现在绿"完全说明不了它在验东西。
 *
 * ★ 注入落在**副本**上（`tmp/falsify-typescale/`），真实源码一个字节都不动 ——
 *   这是本仓从 `PITFALLS #37`（会改文件的判据脚本被中断 ⇒ 工作区停在半改状态）
 *   学到的做法。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const COPY = path.join(ROOT, 'tmp', 'falsify-typescale');
const GATE = 'tools/verify/verify-type-scale.mjs';

const results = [];
const check = (n, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`);
};

function buildCopy() {
  /* ★ 建目录时**不删旧的**。
   *   Windows 上对"刚被 `execFileSync` 起过的子进程"所在目录调 `rmSync`
   *   会**间歇性**抛 `EPERM`（句柄释放有延迟），而它发生在汇总行之前 ⇒
   *   整个脚本以未捕获异常退出、**结论根本打印不出来** ——
   *   屏幕上只剩一段栈，读起来像"脚本坏了"。
   *   ★ 更稳的形状是"不删目录、只覆盖文件"：副本目录留着无害（`tmp/` gitignored），
   *     而每个用例前的 `resetFiles()` 会从真实源码重拷 ⇒ 注入不会累积。
   *   ★ 实测：改之前它连报三次"基线就红了"（其实是 `rmSync` 把上一轮的
   *     `EPERM` 留在了下一轮），改之后 **9/9**。 */
  fs.mkdirSync(COPY, { recursive: true });
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true, force: true });
  }
  /* ★★ 跨仓那一半**也要能在副本里跑**，否则它在副本里走 SKIP ⇒
   *   那条断言（"akso-cloud 的那 7 档与本仓逐字相同"）**从来没有被反证过** ——
   *   而它恰恰是"两端同一套刻度"唯一的硬判据。
   *   ★ 判据在副本里找的是 `COPY/../akso-cloud/...` ⇒ 按同样的相对位置放一份。
   *     只拷那一个 CSS 文件（判据只读它）。
   *   ★ 这是第一版反证器的一个真缺陷：我只拷了本仓，于是那条断言在副本里
   *     **永远 SKIP**，而"8/9 通过"读起来像"有一条判据写错了"，
   *     实际是**一条判据没被验**。 */
  const cloudCss = path.resolve(ROOT, '..', 'akso-cloud', 'app', 'web', 'static', 'site.css');
  if (fs.existsSync(cloudCss)) {
    const dest = path.join(COPY, '..', 'akso-cloud', 'app', 'web', 'static');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(cloudCss, path.join(dest, 'site.css'));
  }
}

/** 注入"修复前"的写法；返回 false 表示锚点没命中（判据脚本本身该改） */
function poke(rel, from, to) {
  const p = path.join(COPY, rel);
  const src = fs.readFileSync(p, 'utf8');
  // ★ 行尾归一化后再比（本仓同一目录下混用 CRLF 与 LF）
  const crlf = src.includes('\r\n');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const hits = norm(src).split(norm(from)).length - 1;
  if (hits !== 1) {
    console.log(`      （锚点命中 ${hits} 次，应为 1 —— ${rel}）`);
    return false;
  }
  const out = norm(src).replace(norm(from), norm(to));
  fs.writeFileSync(p, crlf ? out.replace(/\n/g, '\r\n') : out, 'utf8');
  return true;
}

/**
 * 跑副本里的判据，返回**退出码**与输出。
 *
 * ★★ 这里踩过一个"判据脚本自己报假红"的坑，值得写下来：
 *   第一版返回的是 `{ ok, out }`，而调用点写的是
 *   `const { code, out } = runGate(); if (code === 0) …` ——
 *   于是 `code` **恒为 `undefined`** ⇒ 基线**永远报红**，
 *   而打印出来的判据输出里每一行都是 `OK`、最后一行是 `RESULT: OK`。
 *   ⇒ 症状是"判据是绿的，而反证器说它红"，**读起来像判据错了**。
 *   根因是一个字段名（`ok` vs `code`）—— 而对象解构**不会**为
 *   不存在的键报错，它给 `undefined`（本仓 `PITFALLS #30` 的同族：
 *   "接口摆在那里 ≠ 它被接上了"）。
 *   ★ 处置：返回**退出码本身**，与 `execFileSync` 的语义一一对应，
 *     不再多一层自己的命名。
 */
function runGate() {
  try {
    const out = execFileSync('node', [GATE], { cwd: COPY, encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const TOKENS = 'packages/extension/src/ui/tokens.css';
const PARALLEL_CSS = 'packages/extension/src/ui/parallel/parallel.css';
const GRID = 'packages/extension/src/ui/wheel/grid-style.ts';

const CASES = [
  {
    // ① 档的值与约定不符 ⇒ "7 档的名字与值都等于约定值"必须红
    name: '① 把 `--fs-13` 改成 14px（与 akso-cloud 的刻度不再相同）',
    section: '①',
    apply: () => poke(TOKENS, '  --fs-13: 13px;', '  --fs-13: 14px;'),
  },
  {
    // ① 加一档约定之外的 ⇒ 两条都该红（值表 + "没有约定之外的"）
    name: '① 加一档 `--fs-14: 14px`（约定之外，且与 13 只差 1px）',
    section: '①',
    apply: () => poke(TOKENS, '  --fs-13: 13px;', '  --fs-13: 13px;\n  --fs-14: 14px;'),
  },
  {
    // ② 裸 px 字面量回归 ⇒ "没有裸 px 的 font-size 字面量"必须红
    //   ★★ 锚点必须**唯一**。第一版我写的是裸的 `font-size: var(--fs-12);` ——
    //      实测命中 **18 次**，于是反证器直接报"锚点没命中"。
    //      这正是本仓记过的形态（`verify-falsify-defectfix.mjs` 的 `poke()` 注释：
    //      "第一处不是你想改的那处**不会报错**"）。
    //   ⇒ 带上它**所在那行的类名**做前缀。
    name: '② 把一处字号改回裸 px（退回改前的形态）',
    section: '② 不许有裸 px 字号 / ③ 只许引用那 7 档',
    apply: () => poke(PARALLEL_CSS,
      '.account-card .alias {\n  font-weight: 650;\n  font-size: var(--fs-13);',
      '.account-card .alias {\n  font-weight: 650;\n  font-size: 13.5px;'),
  },
  {
    // ③ 引用一个没定义的档 ⇒ "都引用那 7 档之一"必须红
    name: '③ 引用 `var(--fs-14)`（没定义的档）',
    section: '② 不许有裸 px 字号 / ③ 只许引用那 7 档',
    apply: () => poke(PARALLEL_CSS,
      '.account-card .alias {\n  font-weight: 650;\n  font-size: var(--fs-13);',
      '.account-card .alias {\n  font-weight: 650;\n  font-size: var(--fs-14);'),
  },
  {
    // ⑤ 把 Shadow DOM 那份的兜底拿掉 ⇒ 浮层里字号会静默退回继承值
    name: '⑤ 拿掉 Shadow DOM 那份的兜底（`var(--fs-13, 13px)` → `var(--fs-13)`）',
    section: '⑤',
    apply: () => poke(GRID,
      'font-size: var(--fs-13, 13px); font-weight: 650;',
      'font-size: var(--fs-13); font-weight: 650;'),
  },
  {
    // ⑤ 兜底值与令牌值不一致 ⇒ 两种情形渲染不同
    name: '⑤ 兜底值与令牌值不一致（`var(--fs-13, 13px)` → `var(--fs-13, 15px)`）',
    section: '⑤',
    apply: () => poke(GRID,
      'font-size: var(--fs-13, 13px); font-weight: 650;',
      'font-size: var(--fs-13, 15px); font-weight: 650;'),
  },
];

console.log('=== 建立副本 ===');
buildCopy();
check('副本已建', fs.existsSync(path.join(COPY, GATE)));

console.log('\n=== 基线：未注入任何缺陷时必须是绿的 ===');
{
  const { code, out } = runGate();
  /* ★★ 基线失败时**必须把完整输出打出来**。第一版我只打最后 10 行 ——
   *   而那次失败发生在**第 ① 节**（跨仓比对），于是"最后 10 行"里
   *   全是绿色的 ⑤ 节 + `RESULT: OK`，读起来像"判据是绿的而脚本说它红"。
   *   ⇒ **诊断信息截断到"看起来成功"的那一段**，会把一次真失败伪装成脚本 bug。 */
  if (code === 0) {
    check('基线绿（RESULT: OK）', true);
  } else {
    check('基线绿（RESULT: OK）', false, '基线就红了 —— 后续反证无意义');
    console.log(`      ── 判据退出码 ${code}，完整输出 ──`);
    for (const line of out.trimEnd().split('\n')) {
      console.log(`      ${line}`);
    }
  }
}

console.log('\n=== 逐个注入"修复前"的写法：判据必须变红，且红在对的那一节 ===');
/* ★★ 每个用例**从一份干净副本开始**，但换个做法：不再"删掉重建"，
 *   而是**从真实源码重新拷一遍要改的那几个文件**。
 *
 *   为什么：Windows 上 `rmSync` 对刚被 `execFileSync` 起过的子进程目录
 *   频繁抛 `EPERM`（句柄释放有延迟），而它发生在 `buildCopy()` 里 ⇒
 *   整个脚本以未捕获异常退出、**汇总行根本打印不出来**。
 *   ★ 更稳的形状是"不删目录，只覆盖文件" —— 副本目录留着无害（`tmp/` 是 gitignored），
 *     而"每个用例都从真实源码重拷"保证注入不会累积。 */
function resetFiles() {
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true, force: true });
  }
}

for (const c of CASES) {
  resetFiles();
  if (!c.apply()) {
    check(`${c.name} —— **锚点没命中**（判据脚本里的 poke 目标与源码不符，先修判据）`, false);
    continue;
  }
  const { code, out } = runGate();
  if (code === 0) {
    check(`${c.name} —— 判据**没有变红**：这条断言是恒真的，它没在验任何东西`, false);
    continue;
  }
  const at = out.indexOf(`=== ${c.section}`);
  const seg = at < 0 ? '' : out.slice(at, out.indexOf('\n=== ', at + 4) < 0 ? undefined : out.indexOf('\n=== ', at + 4));
  if (!seg.includes('FAIL')) {
    check(`${c.name} —— 判据红了，但**不是在这一节**（${c.section} 里没有 FAIL）`, false);
  } else {
    const line = seg.split('\n').find((l) => l.includes('FAIL'))?.trim() ?? '';
    check(`${c.name} ⇒ 变红`, true, line.slice(0, 90));
  }
}

console.log('\n=== 清理副本 ===');
/* ★★ 清理**必须容错，而且失败不能掩盖结论**。
 *   实测踩到：`rmSync` 在 Windows 上抛 `EPERM`（副本里有目录正被占用），
 *   而它在汇总行**之前** ⇒ 整个脚本以未捕获异常退出，
 *   屏幕上最后看到的是 "Node.js v24.19.0" 和一段栈 ——
 *   于是"反证 8/9 通过"这个真正的结论**根本没打印出来**。
 *   读起来像"脚本坏了"，实际结论是有的。
 *   ⇒ 清理失败只记一条（副本在 tmp/ 下，gitignored，留着无害），继续往下走。 */
{
  let cleaned = false;
  for (let i = 0; i < 3 && !cleaned; i++) {
    try {
      fs.rmSync(COPY, { recursive: true, force: true, maxRetries: 3 });
      cleaned = !fs.existsSync(COPY);
    } catch {
      // 再试一次（Windows 上文件句柄释放有延迟）
    }
  }
  check('副本已删除（真实工作区**从未被改动**）', cleaned,
    cleaned ? '' : `副本还在 ${path.relative(ROOT, COPY)}（gitignored，可手删）`);
}

const bad = results.filter((r) => !r).length;
console.log(`\n=== ${results.length - bad}/${results.length} 反证通过 ===`);
process.exit(bad === 0 ? 0 : 1);
