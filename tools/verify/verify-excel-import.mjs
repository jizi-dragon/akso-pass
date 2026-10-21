/**
 * Excel 导入的**纯逻辑**判据（不碰 DOM / chrome / 云端）。
 *
 * 用户 2026-10-21 要求：
 *   - 表头只有五项且全部必填：站点名称 / 站点地址 / 用户名 / 密码 / 页签名；
 *   - 盒子不填，由站点名称自动创建并关联；
 *   - 有问题的行必须能定位并说明原因。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src', 'ui', 'parallel', 'excel-import.ts');
const OUT = path.join(ROOT, 'tmp', 'excel-import.cjs');

let bad = 0;
const fail = (m) => { console.log(`  ✗ ${m}`); bad++; };
const ok = (m) => console.log(`  ✓ ${m}`);

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到 ${SRC}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await build({
  entryPoints: [SRC],
  outfile: OUT,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['xlsx'],
  logLevel: 'silent',
});
const { parseExcelFile, validateExcelRows, buildExcelTemplate, MAX_SITE_NAME } = await import(pathToFileURL(OUT).href);
if (typeof parseExcelFile !== 'function' || typeof validateExcelRows !== 'function') {
  console.error('✗ excel-import.ts 没有导出解析/校验函数');
  process.exit(2);
}

function workbook(rows, sheetName = '导入') {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], 'test.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

const headers = ['站点名称', '站点地址', '用户名', '密码', '页签名'];
const file = workbook([
  ['这是一行标题，应该被跳过'],
  headers,
  ['生产', 'https://a.test', 'alice', 'pw', '爱丽丝'],
  ['生产', 'https://a.test', 'alice', 'pw2', '爱丽丝2'],
  ['新环境', 'https://b.test/path', 'bob', 'pw', 'Bob'],
  ['', 'https://x.test', 'no-site-name', 'pw', '无站点名'],
  ['新环境2', 'https://b2.test', 'empty-pass', '', '空密码'],
  ['新环境3', 'https://b3.test', 'empty-tab', 'pw', ''],
  ['坏地址', 'bad host/x', 'eve', 'pw', 'Eve'],
  ['生产', 'https://a.test', 'existing', 'pw', 'Existing'],
  ['共享名', 'https://c.test', 'u1', 'pw', 'U1'],
  ['共享名', 'https://d.test', 'u2', 'pw', 'U2'],
]);

console.log('=== ① 表头 / 五项必填 / 行号 ===');
const parsed = await parseExcelFile(file);
console.log(`     rows=${parsed.rows.length} ignored=${JSON.stringify(parsed.ignoredHeaders)}`);
if (parsed.rows.length !== 10) fail(`应解析 10 行，实际 ${parsed.rows.length}`);
else ok('解析出 10 行（标题行与空行被跳过）');
if (!parsed.rows.every((r) => r.rowNumber >= 3)) fail('行号没有回到 Excel 的 1-based');
else ok('行号是 Excel 行号');
if (parsed.rows[0]?.siteName !== '生产' || parsed.rows[0]?.tabName !== '爱丽丝') {
  fail('五个表头没有映射到字段');
} else ok('五个表头已映射');

console.log('\n=== ② 五项全部必填 + 站点/账号/盒子 ===');
const sites = [{
  id: 's1', host: 'a.test', name: '生产', displayName: '生产',
  baseUrl: 'https://a.test', note: '', accountCount: 1,
}];
const accounts = [{ id: 'x', siteHost: 'a.test', username: 'existing' }];
const rows = validateExcelRows(parsed.rows, { sites, accounts });
const byN = (n) => rows.find((r) => r.rowNumber === n);
console.log(rows.map((r) => `${r.rowNumber}:${r.errors.join('|') || 'OK'} box=${r.boxName}`).join('\n'));

if (!byN(3) || byN(3).errors.length) fail('有效行被误判');
else ok('有效行通过（盒子=站点名称）');
if (byN(3)?.boxName !== '生产') fail('盒子没有同步站点名称');
else ok('盒子名 = 站点名称');
if (byN(3)?.siteKnown !== true) fail('已存在站点没有被识别');
else ok('已存在站点被识别');
if (!byN(4)?.errors.some((e) => e.includes('文件内重复'))) fail('文件内重复没报错');
else ok('文件内重复标红');
if (byN(5)?.errors.length) fail('新站点行被误判');
else if (byN(5)?.boxName !== '新环境') fail('新站点盒子名没有用站点名称');
else ok('新站点行有效，盒子名=站点名称');
if (!byN(6)?.errors.some((e) => e.includes('站点名称'))) fail('空站点名称没报错');
else ok('空站点名称标红');
if (!byN(7)?.errors.some((e) => e.includes('密码'))) fail('空密码没报错');
else ok('空密码标红');
if (!byN(8)?.errors.some((e) => e.includes('页签名'))) fail('空页签名没报错');
else ok('空页签名标红');
if (!byN(9)?.errors.some((e) => e.includes('域名'))) fail('坏地址没报错');
else ok('坏地址标红');
if (!byN(10)?.errors.some((e) => e.includes('云端已有'))) fail('云端已存在没报错');
else ok('云端已存在标红');
if (!byN(11)?.errors.some((e) => e.includes('同一个站点名称')) || !byN(12)?.errors.some((e) => e.includes('同一个站点名称'))) {
  fail('不同站点同名导致盒子冲突没报错');
} else ok('不同站点同名导致盒子冲突标红');
if (MAX_SITE_NAME !== 60) fail(`站点名上限应为 60，实际 ${MAX_SITE_NAME}`);
else ok('站点名上限 60（适配盒子名）');

console.log('\n=== ③ 模板只有五个表头 ===');
const blob = buildExcelTemplate();
if (!(blob instanceof Blob) || blob.size < 100) {
  fail('模板不是有效 Blob');
} else {
  const buf = await blob.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const head = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })[0];
  if (JSON.stringify(head) !== JSON.stringify(headers)) fail(`模板表头不对：${JSON.stringify(head)}`);
  else ok('模板恰好五个表头');
}

console.log('\n=== ④ UI 接线（HTML id ↔ TS） ===');
const html = fs.readFileSync(path.join(ROOT, 'packages', 'extension', 'src', 'ui', 'parallel', 'parallel.html'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'packages', 'extension', 'src', 'ui', 'parallel', 'parallel.ts'), 'utf8');
for (const id of ['data-import-excel', 'excel-import-toggle', 'excel-panel', 'excel-import-file', 'excel-pick', 'excel-template', 'excel-run', 'excel-rows']) {
  if (!html.includes(`id="${id}"`)) fail(`HTML 缺少 #${id}`);
  else ok(`HTML 有 #${id}`);
}
if (!/from '\.\/excel-import'/.test(ui) || !/parseExcelFile/.test(ui) || !/validateExcelRows/.test(ui)) {
  fail('parallel.ts 没有把 excel-import 接到 UI');
} else ok('parallel.ts 已接入解析/校验');
if (!/par\.createBox/.test(ui) || !/par\.bindBoxSite/.test(ui) || !/kind: 'par\.create'/.test(ui)) {
  fail('导入没有建盒/关联/建账号的完整链路');
} else ok('导入走建盒 → 关联站点 → 建账号');

fs.rmSync(OUT, { force: true });
console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
