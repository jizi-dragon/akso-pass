/**
 * 反证 `verify-spacing.mjs`：把"修复前"的每一种写法注回去，判据必须变红。
 *
 * 跑法：`node tools/verify/verify-falsify-spacing.mjs`
 *
 * ## 为什么每一条都要注入
 *
 * 本仓纪律是**判据先反证再相信**（AGENTS 规则 17）。这条判据有五组断言，
 * 其中三组在"零处间距声明"/"零引用"时会**恒真**：
 *   ② 的比例在 `total === 0` 时是 `0/0`
 *   ④⑤ 在"那一份里没有 `--sp-*`"时永远绿
 * ⇒ 只验"它现在绿"完全说明不了它在验东西。
 *
 * ★ 三条从上一轮（字号反证）学到的纪律，都在这里落实：
 *   ① 注入落在**副本**上，真实源码一个字节都不动；
 *   ② 锚点必须**唯一**（带上所在行/附近的上下文），否则 poke 直接报"锚点没命中"；
 *   ③ 清理**容错**，而且失败不能掩盖结论（清理在汇总之前的坑踩过一次）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const COPY = path.join(ROOT, 'tmp', 'falsify-spacing');
const GATE = 'tools/verify/verify-spacing.mjs';

const results = [];
const check = (n, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`);
};

function buildCopy() {
  /* ★ 不删目录、只覆盖文件：Windows 上对"刚被 execFileSync 起过的子进程"目录
   *   调 `rmSync` 会间歇性抛 EPERM，而它在汇总行之前 ⇒ 结论根本打印不出来。 */
  fs.mkdirSync(COPY, { recursive: true });
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true, force: true });
  }
  /* ★★ 跨仓那一半也要能在副本里跑，否则它在副本里走 SKIP ⇒
   *   "两端 14 档逐字相同"这条断言**从来没有被反证过**。 */
  const cloudCss = path.resolve(ROOT, '..', 'akso-cloud', 'app', 'web', 'static', 'site.css');
  if (fs.existsSync(cloudCss)) {
    const dest = path.join(COPY, '..', 'akso-cloud', 'app', 'web', 'static');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(cloudCss, path.join(dest, 'site.css'));
  }
}

function resetFiles() {
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true, force: true });
  }
}

/** 注入；返回 false 表示锚点没唯一命中（判据脚本本身该改） */
function poke(rel, from, to) {
  const p = path.join(COPY, rel);
  const src = fs.readFileSync(p, 'utf8');
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

/** 跑副本里的判据，返回**退出码**与输出（★ 不再自造 `ok` 字段 —— 那个笔误让基线
 *  永远报红过一次：`const { code } = runGate()` 而返回的是 `{ ok }`） */
function runGate() {
  try {
    return { code: 0, out: execFileSync('node', [GATE], { cwd: COPY, encoding: 'utf8' }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const TOKENS = 'packages/extension/src/ui/tokens.css';
const PARALLEL_CSS = 'packages/extension/src/ui/parallel/parallel.css';
const GRID = 'packages/extension/src/ui/wheel/grid-style.ts';

const CASES = [
  {
    name: '① 把 `--sp-3` 改成 10px（与 akso-cloud 的刻度不再相同）',
    assert: '14 档的名字与值都等于约定值',
    apply: () => poke(TOKENS, '  --sp-3:  12px;', '  --sp-3:  10px;'),
  },
  {
    name: '① 删掉 `--sp-13`（少一档 ⇒ 不叫"同一套刻度"）',
    assert: '14 档的名字与值都等于约定值',
    apply: () => poke(TOKENS, '  --sp-13: 88px;\n', ''),
  },
  {
    name: '② 把 40 处间距改回裸 px（退回改前的形态）',
    assert: '在刻度上的比例',
    // 把整个 parallel.css 里的间距令牌全部还原成 px ⇒ 比例必然跌破 75%
    apply: () => {
      const p = path.join(COPY, PARALLEL_CSS);
      const src = fs.readFileSync(p, 'utf8');
      const px = { '--sp-hair': '1px', '--sp-0': '2px', '--sp-1': '4px', '--sp-2': '8px',
        '--sp-3': '12px', '--sp-4': '16px', '--sp-5': '20px', '--sp-6': '24px',
        '--sp-7': '30px', '--sp-8': '40px', '--sp-9': '48px', '--sp-10': '56px',
        '--sp-11': '64px', '--sp-12': '80px', '--sp-13': '88px' };
      let out = src.replace(/\r\n/g, '\n');
      let n = 0;
      for (const [tok, v] of Object.entries(px)) {
        const re = new RegExp(`var\\(\\${tok}\\)`, 'g');
        const m = out.match(re);
        if (m) { n += m.length; out = out.replace(re, v); }
      }
      console.log(`      （注入了 ${n} 处裸 px）`);
      fs.writeFileSync(p, src.includes('\r\n') ? out.replace(/\n/g, '\r\n') : out, 'utf8');
      return n > 20;
    },
  },
  {
    name: '③ 把一处 `--sp-hair` 改回裸 `1px`（描边令牌被绕过）',
    assert: '只以 `--sp-hair` 出现',
    /* ★★ 这一条的注入**同时**会让「比例」那条变红 —— 那不是"判据串味"：
     *   把 `var(--sp-hair)` 换成裸 `1px` 之后，那条声明里的令牌数（0）就少于
     *   裸 px 数（1）⇒ 它**真的**掉出刻度了。两条断言对同一处改动各自说真话，
     *   所以定位按**断言名**（`c.assert`）而不是按"哪一节先红"。
     *   ★ 断言名必须**逐字**照抄判据里的原文（含全角引号）—— 半角引号匹配不上，
     *     而匹配不上的表现是"红了但不是这条"，读起来像判据写错了。 */
    // ★ 锚点必须唯一：裸的 `padding: var(--sp-hair) var(--sp-2);` 实测命中 **3 次**
    //   ⇒ 带上它前面那行（`.account-card .sub .box-tag` 那条规则独有的 `font-size`）。
    apply: () => poke(PARALLEL_CSS,
      '.account-card .sub .box-tag {\n  display: inline-block;\n  font-size: var(--fs-11);\n  padding: var(--sp-hair) var(--sp-2);',
      '.account-card .sub .box-tag {\n  display: inline-block;\n  font-size: var(--fs-11);\n  padding: 1px var(--sp-2);'),
  },
  {
    name: '④ 拿掉 Shadow DOM 那份的兜底（`var(--sp-3, 12px)` → `var(--sp-3)`）',
    assert: '无兜底的 --sp-* 引用',  // ★ 避开全角引号：那两个字符不好辨认，而匹不上的表现是“红了但不是这条”
    apply: () => poke(GRID, 'padding: var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-3, 12px);',
      'padding: var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-3);'),
  },
  {
    name: '⑤ 兜底值与令牌值不一致（`var(--sp-9, 48px)` → `var(--sp-9, 40px)`）',
    assert: '兜底值与令牌值一致',
    apply: () => poke(GRID, 'padding: var(--sp-9, 48px) var(--sp-4, 16px) var(--sp-8, 40px);',
      'padding: var(--sp-9, 40px) var(--sp-4, 16px) var(--sp-8, 40px);'),
  },
];

console.log('=== 建立副本 ===');
buildCopy();
check('副本已建', fs.existsSync(path.join(COPY, GATE)));

console.log('\n=== 基线：未注入任何缺陷时必须是绿的 ===');
{
  const { code, out } = runGate();
  if (code === 0) {
    check('基线绿（RESULT: OK）', true);
  } else {
    check('基线绿（RESULT: OK）', false, '基线就红了 —— 后续反证无意义');
    console.log(`      ── 判据退出码 ${code}，完整输出 ──`);
    for (const line of out.trimEnd().split('\n')) console.log(`      ${line}`);
  }
}

console.log('\n=== 逐个注入"修复前"的写法：判据必须变红，且**红在指名的那条断言上** ===');
/* ★★ 断言定位用「**断言名**」而不是「小节号」。
 *
 *   第一版按 `=== ① ` 去找小节，而那套标号在判据里是**合并标题**
 *   （`=== ② 不许有裸 px 字号 / ③ 只许引用那 7 档 ===` 那种），
 *   于是三条反证都被判成"红了但不是在这一节" —— 而它们**确实红了、也确实红在对的断言上**。
 *   ⇒ 判据脚本报"假红"，而假红会让人去改**本来正确**的判据（本仓规则 17 的同族）。
 *   ★ 附带好处：`① 两端是同一套间距刻度` 这个标号在判据里**出现了两次**
 *     （前提 与 ① 各一次），按标号找还会挑错那一节。
 */
for (const c of CASES) {
  resetFiles();
  if (!c.apply()) {
    check(`${c.name} —— **锚点没命中**（poke 目标与源码不符，先修反证器）`, false);
    continue;
  }
  const { code, out } = runGate();
  if (code === 0) {
    check(`${c.name} —— 判据**没有变红**：这条断言是恒真的，它没在验任何东西`, false);
    continue;
  }
  const hit = out.split('\n').find((l) => l.includes(c.assert) && l.includes('FAIL'));
  if (hit) {
    check(`${c.name} ⇒ 变红`, true, hit.trim().slice(0, 86));
  } else {
    // 附上判据的完整输出 —— 否则"红了但不是这条"这句话无法核对
    check(`${c.name} —— 判据红了，但**不是「${c.assert}」这条**（见下方完整输出）`, false);
    for (const line of out.trimEnd().split('\n')) console.log(`      ${line}`);
  }
}

console.log('\n=== 清理副本 ===');
{
  let cleaned = false;
  for (let i = 0; i < 3 && !cleaned; i++) {
    try {
      fs.rmSync(COPY, { recursive: true, force: true, maxRetries: 3 });
      cleaned = !fs.existsSync(COPY);
    } catch { /* Windows 句柄释放有延迟，再试 */ }
  }
  check('副本已删除（真实工作区**从未被改动**）', cleaned,
    cleaned ? '' : `副本还在 ${path.relative(ROOT, COPY)}（gitignored，可手删）`);
}

const bad = results.filter((r) => !r).length;
console.log(`\n=== ${results.length - bad}/${results.length} 反证通过 ===`);
process.exit(bad === 0 ? 0 : 1);
