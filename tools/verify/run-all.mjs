// run-all.mjs —— 批量跑 tools/verify/ 下的验证脚本
//
// 为什么需要它：这批脚本原先散落在 gitignored 的 tmp/ 里，
// 没有任何入口能一次跑完（只能靠 SESSION-STATE.md 里手写的"七套回归"清单）。
//
// ★ 刻意的设计：**默认拒绝运行**。
//   每个脚本都会真起一个带扩展的 Chromium（数十秒、且会往 tmp/ 写档案），
//   一次全跑要几分钟。默认就跑完会让人不敢按，于是"批量验证"这件事会重新退化。
//   ⇒ 必须显式给 --browser。
//
// 用法：
//   node tools/verify/run-all.mjs --browser              跑全部（数量见 --list，别在注释里写死）
//   node tools/verify/run-all.mjs --browser --only v310  只跑匹配的
//   node tools/verify/run-all.mjs --list                 只列清单
//
// ★★ 这里**刻意不写"跑全部 N 个"**：这个注释曾长期写着 `12 个`，而脚本是
//   `readdirSync` 自动发现的 —— 实测那时盘上已有 25 个。
//   一个没人会去核对的数字会安静地过期，而它旁边就有一行能算出真值的命令。
//   ⇒ 要数字就跑 `--list`（它打印的正是运行时真实数量）。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const args = process.argv.slice(2);
const wantBrowser = args.includes('--browser');
const listOnly = args.includes('--list');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;
const timeoutIdx = args.indexOf('--timeout-ms');
const TIMEOUT_MS = timeoutIdx >= 0 ? Number(args[timeoutIdx + 1]) : 180_000;

// probe-create 是诊断探针（无断言），不列入批量回归
const scripts = fs.readdirSync(HERE)
  .filter((f) => f.startsWith('verify-') && f.endsWith('.mjs'))
  .filter((f) => (only ? f.includes(only) : true))
  .sort();

if (listOnly) {
  console.log(`可用验证脚本 ${scripts.length} 个（另有 probe-create.mjs 为诊断探针，不含在内）：`);
  scripts.forEach((s) => console.log('  ' + s));
  process.exit(0);
}

if (!scripts.length) {
  console.error(only ? `--only ${only} 没有匹配到任何脚本` : '未找到任何 verify-*.mjs');
  process.exit(2);
}

if (!wantBrowser) {
  console.error('拒绝运行：本命令会真起 Chromium（每个脚本数十秒），请显式确认。\n');
  console.error(`  待运行 ${scripts.length} 个脚本：`);
  scripts.forEach((s) => console.error('    ' + s));
  console.error('\n用法：');
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
