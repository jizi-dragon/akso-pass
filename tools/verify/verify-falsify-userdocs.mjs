/**
 * `verify-user-docs.mjs` 的反证：把**那五处真缺陷的原文**注回去，看判据红不红。
 *
 *     node tools/verify/verify-falsify-userdocs.mjs
 *
 * ★★ 为什么反证必须用**真缺陷的原文**（而不是我编一个差不多的）：
 *   本仓 `PITFALLS #23` 记过一次"我构造了一个假的缺陷版 ⇒ 反证 GREEN ⇒
 *   我一度以为判据失效，实际是缺陷没注进去"。
 *   ⇒ 下面的 `broken` 全是**从 git 历史里取出的原始句子**。
 *
 * ★★ 还原用**文件副本**，不用 `git checkout`：
 *   本仓本轮实测踩过 —— `git checkout -- site.css` 把**同一轮里其他未提交的成功改动**
 *   一起还原了，而没有任何提示。⇒ 只备份/恢复**我改的那一个文件**。
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const MANUAL = join(ROOT, 'docs', 'USER-MANUAL.md');
const CHECK = join(HERE, 'verify-user-docs.mjs');

const BACKUP = `${MANUAL}.falsify-bak`;
copyFileSync(MANUAL, BACKUP);
const ORIGINAL = readFileSync(MANUAL, 'utf8');

function checkPasses() {
  const r = spawnSync(process.execPath, [CHECK], { encoding: 'utf8', cwd: ROOT });
  return { pass: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

/** 五处真缺陷的**原文**（从修复前的内容里逐字取出） */
const CASES = [
  {
    name: '① §4.1 表单说明又说「AES-GCM 加密保存在本机，不上传任何服务器」',
    find: '| **密码** | ✔ | **上传到云端账号库**（服务端 Fernet 加密后落库），本机**不保存口令** |',
    repl: '| **密码** | ✔ | **AES-GCM 加密保存在本机**，不上传任何服务器 |',
  },
  {
    name: '② §十 又说「密码 AES-GCM 加密存放本机，任何服务器都拿不到」',
    find: '- 账号（含平台口令）存在**云端账号库**：口令由**服务端**用 Fernet 加密后落库，扩展本机**不留口令**。',
    repl: '- 密码 **AES-GCM 加密存放本机**（IndexedDB），任何服务器（包括扩展作者）都拿不到；',
  },
  {
    name: '③ §十 又说「备份文件等效密码本（内含解密种子）」',
    find: '- **备份文件不含任何秘密**：v3.18 起导出物只有**配置**（站点 / 页签名 / 盒子 / 用户名），',
    repl: '- **备份文件等效密码本**（内含解密种子），务必像密码一样保管；',
  },
  {
    name: '④ §4.3 又说导出物「含加密密码」',
    find: '**导出数据**：把当前的**授权站点、盒子名与禁用名单、每个账号的元数据（站点 / 页签名 / 盒子 / 账号名）**',
    repl: '**导出数据**：把当前的**授权站点、全部账号（含加密密码）、盒子配置**',
  },
  {
    name: '⑤ Q7 又教「换机走导出→导入」且说数据在本机',
    find: '★ **在的** —— 账号与口令存在**云端账号库**（服务端加密落库），**不跟着浏览器配置走**。',
    repl: '账号与加密密码存在**本机浏览器配置**里，不随浏览器账号同步。换机请走「导出数据 → 新机导入数据」（见 4.3）。',
  },
];

const results = [];
console.log('=== 基线（未改动）：判据必须通过 ===');
const base = checkPasses();
console.log(`  ${base.pass ? 'OK  ' : 'FAIL'} 基线${base.pass ? '通过' : '不通过 —— 先修判据本身'}`);
if (!base.pass) results.push(false);

try {
  for (const c of CASES) {
    const mutated = ORIGINAL.replace(c.find, c.repl);
    if (mutated === ORIGINAL) {
      console.log(`\n=== ${c.name} ===`);
      console.log('  SKIP  锚点没匹配上 —— 这条反证**没验到东西**（源码变了？）');
      results.push(false);
      continue;
    }
    writeFileSync(MANUAL, mutated, 'utf8');
    const { pass, out } = checkPasses();
    const ok = !pass;
    results.push(ok);
    console.log(`\n=== ${c.name} ===`);
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${ok ? '如期变红 —— 反证有效' : '★ 缺陷版下仍然绿 ⇒ 这条验收是空断言！'}`);
    if (!ok) console.log(out.split('\n').slice(-6).map((l) => `      ${l}`).join('\n'));
    writeFileSync(MANUAL, ORIGINAL, 'utf8'); // 立刻还原
  }
} finally {
  writeFileSync(MANUAL, ORIGINAL, 'utf8');
  try { unlinkSync(BACKUP); } catch { /* 已删 */ }
}

console.log('\n=== 还原核对 ===');
const restored = readFileSync(MANUAL, 'utf8') === ORIGINAL;
console.log(`  ${restored ? 'OK  ' : 'FAIL'} USER-MANUAL.md 已还原（逐字节）`);
const after = checkPasses();
console.log(`  ${after.pass ? 'OK  ' : 'FAIL'} 判据恢复全绿`);

const passed = results.filter(Boolean).length;
console.log(`\nRESULT: ${passed}/${results.length} 反证通过`
  + `${restored && after.pass ? '（验收有效且已还原）' : '（★ 还原或基线有问题）'}`);
