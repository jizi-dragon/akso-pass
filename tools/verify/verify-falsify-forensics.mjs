/**
 * 反证：`verify-forensics-redaction.mjs` 的断言真的会红吗？
 *
 * 做法：临时把 `forensics()` 的打码摘掉，跑验收脚本，**断言它必须失败**，
 * 然后无论成败都逐字节还原（放 finally）。
 *
 * ★ 依据 AGENTS.md 规则 17/21：写完判据先问"拆掉什么它才会红"。
 *   一个永远绿的检查比没有检查更坏 —— 它占着"这里验过了"的位置。
 *
 * 跑法：node tools/verify/verify-falsify-forensics.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const TARGET = join(ROOT, 'packages', 'extension', 'src', 'background', 'core', 'parallel-session.ts');
const REDACT = join(ROOT, 'packages', 'extension', 'src', 'shared', 'redact.ts');
const CHECK = join(HERE, 'verify-forensics-redaction.mjs');

const originals = new Map([
  [TARGET, readFileSync(TARGET, 'utf8')],
  [REDACT, readFileSync(REDACT, 'utf8')],
]);

/** 跑验收脚本，返回它在本次修改下是否通过。 */
function checkPasses() {
  const r = spawnSync(process.execPath, [CHECK], { encoding: 'utf8', cwd: ROOT });
  return { pass: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

const CASES = [
  {
    // ★ 2026-11-09：锚点随实现改写过一次。`forensics()` 现在把条目交给 `appendRing()`
    //   （合并写），打码在**入队前**做 ⇒ 反证要摘的是 `appendRing(...)` 里那两个打码调用，
    //   而不是原来那条 `chrome.storage.local.set({...})`。
    name: '① forensics 不打码（回到修复前）',
    file: TARGET,
    apply: (s) => s.replace(
      // ★ 用正则而不是多行字面量：本仓源码是 **CRLF**，多行 `\n` 锚点永远匹配不上
      //   （第一次改这里就踩了：只有 ① 报"锚点没匹配上"，② 单行锚点却是好的）。
      /appendRing\(LOCAL_KEYS\.forensics, 120, \{[\s\S]*?\}\);/,
      'appendRing(LOCAL_KEYS.forensics, 120, { t: Date.now(), ev, ...detail });',
    ),
  },
  {
    name: '② diag 不打码',
    file: TARGET,
    apply: (s) => s.replace(
      "  appendRing('ql:diag', 60, redact(`${new Date().toISOString().slice(11, 23)} ${msg}`));",
      "  appendRing('ql:diag', 60, `${new Date().toISOString().slice(11, 23)} ${msg}`);",
    ),
  },
  {
    name: '③ 敏感键名单只剩裸 `password`（漏掉 accessToken/userPassword 这类复合键名）',
    file: REDACT,
    apply: (s) => s.replace(
      /const SENSITIVE_KEYS = \[[\s\S]*?\];/,
      "const SENSITIVE_KEYS = ['password'];",
    ),
  },
];

const results = [];
try {
  for (const c of CASES) {
    const orig = originals.get(c.file);
    const mutated = c.apply(orig);
    if (mutated === orig) {
      console.log(`  ??    ${c.name} —— 锚点没匹配上，这条反证**没验到东西**`);
      results.push(false);
      continue;
    }
    writeFileSync(c.file, mutated, 'utf8');
    const { pass, out } = checkPasses();
    const ok = !pass;   // 必须**失败**
    results.push(ok);
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${c.name} ⇒ ${pass ? '★ 仍然全绿（判据无效）' : '如期变红 ✓'}`);
    if (!ok) console.log(out.split('\n').slice(-8).join('\n'));
    writeFileSync(c.file, orig, 'utf8');   // 每条之后都还原，避免用例互相污染
  }
} finally {
  for (const [f, s] of originals) writeFileSync(f, s, 'utf8');
}

// 还原核对
const same = [...originals].every(([f, s]) => readFileSync(f, 'utf8') === s);
const { pass: stillGreen } = checkPasses();
console.log(`\n=== 还原核对 ===`);
console.log(`  逐字节一致: ${same ? 'OK' : '★ 不一致'}`);
console.log(`  验收脚本恢复全绿: ${stillGreen ? 'OK' : '★ 仍红'}`);

const passed = results.filter(Boolean).length;
console.log(`\nRESULT: ${passed}/${results.length} 反证通过${same && stillGreen ? '（验收有效且已还原）' : '（★ 还原或基线有问题）'}`);
process.exit(passed === results.length && same && stillGreen ? 0 : 1);
