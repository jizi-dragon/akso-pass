/** 反证 G 组与 H 组判据（`verify-defectfix.mjs`）：拆掉对应实现后必须变红。
 *
 * ★ 注入必须**自证**（第一版反证就是死在"注入没生效而我把没红读成判据假绿"）。
 *
 * ★ 本脚本从 `tmp/` 提升到 `tools/verify/` 时，**仓库根算法必须重算**
 *   （AGENTS 规则 15）：在 `tmp/` 里是上一级，在这里是上**两**级。
 *   第一版提升后没改，它去找的是 `tools/packages/...` ⇒ ENOENT。
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SW = path.join(ROOT, 'packages', 'extension', 'src', 'background', 'service-worker.ts');
const PAR = path.join(ROOT, 'packages', 'extension', 'src', 'ui', 'parallel', 'parallel.ts');
const BAK = { sw: path.join(ROOT, 'tmp', 'fx-sw.bak'), par: path.join(ROOT, 'tmp', 'fx-par.bak') };
copyFileSync(SW, BAK.sw);
copyFileSync(PAR, BAK.par);
const ORIG = { sw: readFileSync(SW, 'utf8'), par: readFileSync(PAR, 'utf8') };

const results = [];
const check = (n, ok, extra = '') => { results.push(ok); console.log(`${n}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`); };
const runGate = () => {
  try {
    const out = execFileSync('node', ['tools/verify/verify-defectfix.mjs'], { cwd: ROOT, encoding: 'utf8' });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const restore = () => {
  writeFileSync(SW, ORIG.sw, 'utf8');
  writeFileSync(PAR, ORIG.par, 'utf8');
};

try {
  console.log('=== 前提：基线绿 ===');
  const base = runGate();
  check('  基线绿', base.ok === true && /RESULT: OK/.test(base.out));

  const cases = [
    {
      name: '① 去掉 `permissions.onAdded` 监听',
      file: 'sw',
      mutate(s) { return s.replace('chrome.permissions.onAdded.addListener(', 'void 0; // REMOVED onAdded\nfunction _unused('); },
    },
    {
      name: '② 去掉 `permissions.onRemoved` 监听',
      file: 'sw',
      mutate(s) { return s.replace('chrome.permissions.onRemoved.addListener(', 'void 0; // REMOVED onRemoved\nfunction _unused2('); },
    },
    {
      name: '③ 授权变化时不再 `restore()`（只清缓存 = 半个修复）',
      file: 'sw',
      mutate(s) { return s.replace('void parallelSession.restore().catch((e: unknown) => {', 'void 0; // REMOVED restore\n  ((e: unknown) => { void e; })('); },
    },
    {
      name: '④ 残留判定退回"包含通配"的恒真形态',
      file: 'par',
      mutate(s) { return s.replace(
        "  const hostOrigins = allOrigins.filter((o) => originToHost(o) === displayHost);",
        "  const hostOrigins = allOrigins.filter((o) => originToHost(o) === displayHost || o.includes('*://*/*'));"); },
    },
  ];

  for (const c of cases) {
    console.log(`\n=== 反证 ${c.name} ===`);
    const target = c.file === 'sw' ? SW : PAR;
    const before = readFileSync(target, 'utf8');
    const after = c.mutate(before);
    check('  注入确实改变了文件', before !== after);
    if (before === after) { continue; }
    writeFileSync(target, after, 'utf8');
    const r = runGate();
    check('  判据如期变红', r.ok === false, r.ok ? '⚠ 没红 —— 这条判据是假绿！' : '如期变红');
    if (!r.ok) {
      const first = r.out.split('\n').find((l) => /✗|不符|FAIL/.test(l)) ?? '';
      console.log(`     ${first.trim().slice(0, 140)}`);
    }
    restore();
  }
} finally {
  restore();
  for (const f of Object.values(BAK)) if (existsSync(f)) unlinkSync(f);
}

console.log('\n=== 还原复核 ===');
const back = runGate();
check('  还原后判据回到绿', back.ok === true && /RESULT: OK/.test(back.out));
check('  两个源文件与备份逐字节一致',
  readFileSync(SW, 'utf8') === ORIG.sw && readFileSync(PAR, 'utf8') === ORIG.par);

const passed = results.filter(Boolean).length;
console.log(`\n=== ${passed}/${results.length} 反证通过 ===`);
process.exit(passed === results.length ? 0 : 1);
