/**
 * 反证 `verify-radius.mjs`：把"修复前"的每一种写法注回去，判据必须变红。
 *
 * 跑法：`node tools/verify/verify-falsify-radius.mjs`
 *
 * ★ 从本轮前面几个反证器学到的三条（都踩过，都写在这里）：
 *   ① 注入落在**副本**上，真实源码不动；
 *   ② 锚点必须**唯一**（数不对就报"锚点没命中"，而不是静默改错地方）；
 *   ③ 定位用**断言名**而不是小节号（小节号在判据里是合并标题，且会重复）；
 *   ④ 清理**容错**，且失败不能掩盖结论（它在汇总之前）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const COPY = path.join(ROOT, 'tmp', 'falsify-radius');
const GATE = 'tools/verify/verify-radius.mjs';

const results = [];
const check = (n, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${n}${extra ? '  ' + extra : ''}`);
};

function syncFiles() {
  fs.mkdirSync(COPY, { recursive: true });
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true, force: true });
  }
  const cloudCss = path.resolve(ROOT, '..', 'akso-cloud', 'app', 'web', 'static', 'site.css');
  if (fs.existsSync(cloudCss)) {
    const dest = path.join(COPY, '..', 'akso-cloud', 'app', 'web', 'static');
    fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(cloudCss, path.join(dest, 'site.css'));
  }
}

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

function runGate() {
  try {
    return { code: 0, out: execFileSync('node', [GATE], { cwd: COPY, encoding: 'utf8' }) };
  } catch (e) {
    return { code: typeof e.status === 'number' ? e.status : 1,
      out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const TOKENS = 'packages/extension/src/ui/tokens.css';
const PARALLEL = 'packages/extension/src/ui/parallel/parallel.css';
const GRID = 'packages/extension/src/ui/wheel/grid-style.ts';

const CASES = [
  {
    name: '① 把 `--sb-radius` 改回 10px（退回改前那一档）',
    assert: '四档的名字与值都等于约定',
    apply: () => poke(TOKENS, '  --sb-radius: 12px;', '  --sb-radius: 10px;'),
  },
  {
    name: '① 删掉 `--sb-radius-sm`（少一档 ⇒ 小元件又没档可用）',
    assert: '四档的名字与值都等于约定',
    apply: () => poke(TOKENS, '  --sb-radius-sm: 8px;\n', ''),
  },
  {
    name: '② 把一处圆角改回裸 `5px`（退回改前的形态）',
    assert: '没有裸 px 的 border-radius',
    apply: () => poke(PARALLEL,
      '.block .desc code {\n  background: var(--sb-brand-soft);\n  padding: var(--sp-hair) var(--sp-2);\n  border-radius: var(--sb-radius-sm);',
      '.block .desc code {\n  background: var(--sb-brand-soft);\n  padding: var(--sp-hair) var(--sp-2);\n  border-radius: 5px;'),
  },
  {
    name: '③ 引用一个没定义的档（`var(--sb-radius-xl)`）',
    assert: '每一处都引用那四档之一',
    apply: () => poke(PARALLEL, '  border-radius: var(--sb-radius-lg);\n  transition: border-color 0.14s ease',
      '  border-radius: var(--sb-radius-xl);\n  transition: border-color 0.14s ease'),
  },
  {
    name: '④ 拿掉 Shadow DOM 那份的兜底（`var(--sb-radius, 12px)` → `var(--sb-radius)`）',
    assert: '无兜底的 --sb-radius* 引用',
    apply: () => poke(GRID,
      'border-radius: var(--sb-radius, 12px); background: var(--acc, #1e6fff);',
      'border-radius: var(--sb-radius); background: var(--acc, #1e6fff);'),
  },
  {
    name: '⑤ 兜底值与令牌值不一致（`var(--sb-radius, 12px)` → `var(--sb-radius, 8px)`）',
    assert: '兜底值与令牌值一致',
    apply: () => poke(GRID,
      'border-radius: var(--sb-radius, 12px); background: var(--acc, #1e6fff);',
      'border-radius: var(--sb-radius, 8px); background: var(--acc, #1e6fff);'),
  },
];

console.log('=== 建立副本 ===');
syncFiles();
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

console.log('\n=== 逐个注入"修复前"的写法：必须红在指名的那条断言上 ===');
for (const c of CASES) {
  syncFiles();
  if (!c.apply()) {
    check(`${c.name} —— **锚点没命中**（poke 目标与源码不符，先修反证器）`, false);
    continue;
  }
  const { code, out } = runGate();
  if (code === 0) {
    check(`${c.name} —— 判据**没有变红**：这条断言是恒真的`, false);
    continue;
  }
  const hit = out.split('\n').find((l) => l.includes(c.assert) && l.includes('FAIL'));
  if (hit) {
    check(`${c.name} ⇒ 变红`, true, hit.trim().slice(0, 84));
  } else {
    check(`${c.name} —— 红了，但**不是「${c.assert}」这条**`, false);
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
    } catch { /* Windows 句柄释放有延迟 */ }
  }
  check('副本已删除（真实工作区**从未被改动**）', cleaned,
    cleaned ? '' : `副本还在 ${path.relative(ROOT, COPY)}（gitignored，可手删）`);
}

const bad = results.filter((r) => !r).length;
console.log(`\n=== ${results.length - bad}/${results.length} 反证通过 ===`);
process.exit(bad === 0 ? 0 : 1);
