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
const { objectConfigUrl, lifecycleConfigUrl, workflowListUrl, workflowEditUrl, objectInterfaceUrl, objectListLayoutUrl, objectFormLayoutUrl, buildDebugTargets } = await import(
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

console.log('A. 深链的形状');
eq('对象配置页', objectConfigUrl(BASE, OBJ), `${BASE}/admin/config/basic-objects/edit/base?id=${OBJ}&__edit=2`);
eq('对象列表布局页', objectListLayoutUrl(BASE, OBJ), `${BASE}/admin/config/basic-objects/edit/list-layout?id=${OBJ}`);
eq('对象表单布局页', objectFormLayoutUrl(BASE, OBJ), `${BASE}/admin/config/form-layout/list?bid=${OBJ}`);
eq('对象生命周期页', lifecycleConfigUrl(BASE, LIFE), `${BASE}/admin/config/lifecycle/${LIFE}?__edit=2`);
eq('工作流列表页', workflowListUrl(BASE), `${BASE}/admin/config/workflow`);
eq('工作流编辑器（config id）', workflowEditUrl(BASE, 'cfg 1'), `${BASE}/admin/config/workflow/edit?__edit=2&id=cfg%201`);

console.log('B. 非默认端口 / http 站点');
eq('保留 origin 端口', objectConfigUrl('http://127.0.0.1:8080', OBJ), `http://127.0.0.1:8080/admin/config/basic-objects/edit/base?id=${OBJ}&__edit=2`);
eq('http 内网 origin', workflowListUrl('http://10.100.0.105'), 'http://10.100.0.105/admin/config/workflow');

console.log('C. id 必须被编码（防 query 注入）');
eq('对象 id 里的 & 被编码', objectConfigUrl(BASE, 'a&b=c'), `${BASE}/admin/config/basic-objects/edit/base?id=a%26b%3Dc&__edit=2`);
eq('列表布局 ?id= 里的 & 被编码', objectListLayoutUrl(BASE, 'a&b=c'), `${BASE}/admin/config/basic-objects/edit/list-layout?id=a%26b%3Dc`);
eq('表单布局 ?bid= 里的 & 被编码', objectFormLayoutUrl(BASE, 'a&b=c'), `${BASE}/admin/config/form-layout/list?bid=a%26b%3Dc`);
eq('生命周期 id 里的斜杠被编码', lifecycleConfigUrl(BASE, '../x'), `${BASE}/admin/config/lifecycle/..%2Fx?__edit=2`);
eq('对象 id 里的空格被编码', objectConfigUrl(BASE, 'a b'), `${BASE}/admin/config/basic-objects/edit/base?id=a%20b&__edit=2`);

console.log('D. 工作流列表不带假参数');
const wf = workflowListUrl(BASE);
if (wf.includes('?')) {
  fail(`工作流列表不应带 query：${wf}`);
} else {
  ok('工作流列表没有 query（不伪造 objectId 筛选）');
}

/* ---- E. 候选矩阵是「数据驱动」的（v4.2.47） ----
   用户要的是**可以继续加页面**的候选矩阵，不是写死的三格。这里直接钉住：
   加一条 extra，数组就多一条，浮层按数组渲染 ⇒ 加页面只改一个函数。 */
console.log('E. 候选矩阵可扩展（加一条就多一格）');
const object = { id: OBJ, code: 'change_control__c', name: '变更控制' };
const lifecycle = { id: LIFE, name: '变更控制生命周期' };
const baseTargets = buildDebugTargets(BASE, object, lifecycle);
eq('默认六条候选', baseTargets.length, 6);
eq('候选顺序稳定', baseTargets.map((t) => t.kind).join(','), 'object,listLayout,formLayout,lifecycle,workflow,interfaces');
eq('第一格指向对象配置', baseTargets[0].href, objectConfigUrl(BASE, OBJ));
eq('第二格指向列表布局', baseTargets[1].href, objectListLayoutUrl(BASE, OBJ));
eq('第三格指向表单布局', baseTargets[2].href, objectFormLayoutUrl(BASE, OBJ));
eq('第四格指向生命周期', baseTargets[3].href, lifecycleConfigUrl(BASE, LIFE));
eq('第五格指向工作流列表', baseTargets[4].href, workflowListUrl(BASE));
eq('第五格是浮层内二级视图（不落平台列表页）', baseTargets[4].subview === 'workflows', true);
eq('第六格指向对象接口', baseTargets[5].href, objectInterfaceUrl(BASE, OBJ));

const extra = [{ kind: 'fields', title: '对象字段', subtitle: '预留的扩展位', href: `${BASE}/admin/config/x`, accent: '#d97706' }];
const withExtra = buildDebugTargets(BASE, object, lifecycle, extra);
eq('额外候选被追加（不是替换）', withExtra.length, 7);
eq('额外候选保留自己的地址', withExtra[6].href, `${BASE}/admin/config/x`);

const noLife = buildDebugTargets(BASE, object, null);
eq('没有生命周期时该格仍占位', noLife.length, 6);
eq('没有生命周期时该格不可跳', noLife[3].href === null, true);
eq('置灰格带原因', noLife[3].disabledReason === '该对象未启用生命周期', true);

console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: FAIL（${bad} 项）`);
process.exit(bad === 0 ? 0 : 1);



