/**
 * 调试跳转深链的**纯逻辑**判据（v4.2.45，不起浏览器）。
 *
 * 三个按钮最终都落到平台管理端，路径一旦拼错，用户看到的是 404 或空白页，
 * 而扩展这边不会报任何错 —— 所以这里把 URL 的形状钉死：
 *   1) 对象配置：`/admin/config/basic-objects/edit/base?id=<objectId>&__edit=2`
 *   2) 对象生命周期：`/admin/config/lifecycle/<lifeCycleId>?__edit=2`
 *   3) 工作流：`/admin/config/workflow`（**不加** objectId —— 列表接口会忽略筛选）
 *
 * ★ 还要钉住「id 必须被编码」：objectId 来自页面 URL，若直接拼进 query，
 *   一个带 `&` 的伪造 id 就能往 URL 里塞参数。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src', 'shared', 'deeplinks.ts');
const OUT = path.join(ROOT, 'tmp', 'deeplinks.cjs');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  bad++;
};

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到 ${SRC}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
await build({
  entryPoints: [SRC],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { objectConfigUrl, lifecycleConfigUrl, workflowListUrl } = await import(
  pathToFileURL(OUT).href + `?t=${Date.now()}`
);

const OBJ = '3a1934a8-738a-dd93-dfb0-de2669ba0a11';
const LIFE = '3a1934a8-738a-f302-f044-e3dd70e30e6a';
const BASE = 'https://standard-val.aksoegmp.com';

const eq = (label, actual, expected) => {
  if (actual === expected) {
    ok(label);
  } else {
    fail(`${label}\n      期望: ${expected}\n      实际: ${actual}`);
  }
};

console.log('A. 三个深链的形状');
eq('对象配置页', objectConfigUrl(BASE, OBJ), `${BASE}/admin/config/basic-objects/edit/base?id=${OBJ}&__edit=2`);
eq('对象生命周期页', lifecycleConfigUrl(BASE, LIFE), `${BASE}/admin/config/lifecycle/${LIFE}?__edit=2`);
eq('工作流列表页', workflowListUrl(BASE), `${BASE}/admin/config/workflow`);

console.log('B. 非默认端口 / http 站点');
eq('保留 origin 端口', objectConfigUrl('http://127.0.0.1:8080', OBJ), `http://127.0.0.1:8080/admin/config/basic-objects/edit/base?id=${OBJ}&__edit=2`);
eq('http 内网 origin', workflowListUrl('http://10.100.0.105'), 'http://10.100.0.105/admin/config/workflow');

console.log('C. id 必须被编码（防 query 注入）');
eq('对象 id 里的 & 被编码', objectConfigUrl(BASE, 'a&b=c'), `${BASE}/admin/config/basic-objects/edit/base?id=a%26b%3Dc&__edit=2`);
eq('生命周期 id 里的斜杠被编码', lifecycleConfigUrl(BASE, '../x'), `${BASE}/admin/config/lifecycle/..%2Fx?__edit=2`);
eq('对象 id 里的空格被编码', objectConfigUrl(BASE, 'a b'), `${BASE}/admin/config/basic-objects/edit/base?id=a%20b&__edit=2`);

console.log('D. 工作流列表不带假参数');
const wf = workflowListUrl(BASE);
if (wf.includes('?')) {
  fail(`工作流列表不应带 query：${wf}`);
} else {
  ok('工作流列表没有 query（不伪造 objectId 筛选）');
}

console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: FAIL（${bad} 项）`);
process.exit(bad === 0 ? 0 : 1);
