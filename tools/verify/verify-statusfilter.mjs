/**
 * 生命周期状态过滤的**纯逻辑**判据（不碰 DOM / chrome / 云端）。
 *
 * 用户 2026-11-05 要求：状态轮盘只呈现「启用」的状态，停用/已删除的不再出现。
 *
 * 平台状态对象与 `Status/Create`、`Status/Update` 的入参同名：
 *   { isEnabled: boolean, isDeleted?: boolean, ... }
 * 但服务端响应形状并不稳定，所以这里同时钉住三条：
 *   1) isEnabled=false / isDeleted=true 必须被过滤；
 *   2) 没有这些字段时必须保留 —— 不能把「未知」当「停用」把整张表清空；
 *   3) 全被过滤时 hiddenCount 仍要如实返回，UI 才能说「停用了几个」而不是「没有状态」。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src', 'background', 'core', 'instance-status.ts');
const OUT = path.join(ROOT, 'tmp', 'instance-status.cjs');

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
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
});
const { pageLoadStatuses } = await import(pathToFileURL(OUT).href);
if (typeof pageLoadStatuses !== 'function') {
  console.error('✗ instance-status.ts 没有导出 pageLoadStatuses');
  process.exit(2);
}

// 页面主世界才有的三个全局：location / fetch / document —— 在 Node 里给最小替身
globalThis.location = { origin: 'https://qllocal.test' };
globalThis.document = { querySelector: () => null };

const FORM = {
  code: 0,
  message: '',
  data: { lifecycle: { id: 'LC1', name: '变更控制生命周期' }, statusName: '草稿' },
};

const reply = (body) => ({ status: 200, text: async () => JSON.stringify(body) });

async function run(listData, opts = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/Layout/GetFormInstance')) {
      return reply(opts.form ?? FORM);
    }
    if (u.includes('/Status/GetListByBasicId')) {
      return reply({ code: 0, message: '', data: listData });
    }
    return reply({ code: 0, message: '', data: null });
  };
  return pageLoadStatuses({ objectId: 'OBJ1', instanceId: 'INST1', menuId: '' });
}

const codes = (r) => r.statuses.map((s) => s.code);

// 1. 混合：停用 + 已删除被过滤，缺省字段保留
{
  const r = await run([
    { id: 's1', code: 'draft', name: '草稿', isEnabled: true },
    { id: 's2', code: 'obsolete', name: '已作废', isEnabled: false },
    { id: 's3', code: 'archived', name: '已归档', isDeleted: true },
    { id: 's4', code: 'done', name: '已完成' },
  ]);
  const got = codes(r);
  if (r.ok && got.join(',') === 'draft,done') {
    ok('isEnabled=false 与 isDeleted=true 被过滤，缺省字段保留');
  } else {
    fail(`过滤结果不对：${JSON.stringify(got)} ok=${r.ok}`);
  }
  if (r.hiddenCount === 2) {
    ok('hiddenCount=2');
  } else {
    fail(`hiddenCount=${r.hiddenCount}，期望 2`);
  }
  if (r.lifecycleName === '变更控制生命周期') {
    ok('lifecycleName 透传');
  } else {
    fail(`lifecycleName=${r.lifecycleName}`);
  }
}

// 2. 数值 / 字符串形式的 false 也要认（响应形状不稳定，不赌单一类型）
{
  const r = await run([
    { id: 'a', code: 'a', name: 'A', isEnabled: 0 },
    { id: 'b', code: 'b', name: 'B', isEnabled: 'false' },
    { id: 'c', code: 'c', name: 'C', enabled: false },
    { id: 'd', code: 'd', name: 'D', isEnabled: 1 },
  ]);
  const got = codes(r);
  if (got.join(',') === 'd') {
    ok('0 / "false" / enabled:false 都按停用处理');
  } else {
    fail(`数值形态过滤结果不对：${JSON.stringify(got)}`);
  }
}

// 3. 全停用：列表空、hiddenCount 如实、当前状态标记为「已停用」
{
  const form = {
    code: 0,
    message: '',
    data: { lifecycle: { id: 'LC1', name: 'LC' }, statusName: '已作废' },
  };
  const r = await run(
    [
      { id: 's1', code: 'draft', name: '草稿', isEnabled: false },
      { id: 's2', code: 'void', name: '已作废', isEnabled: false },
    ],
    { form },
  );
  if (r.ok && r.statuses.length === 0) {
    ok('全停用时 statuses 为空');
  } else {
    fail(`全停用仍有 ${r.statuses.length} 项`);
  }
  if (r.hiddenCount === 2) {
    ok('全停用时 hiddenCount=2');
  } else {
    fail(`全停用 hiddenCount=${r.hiddenCount}`);
  }
  if (r.currentDisabled === true) {
    ok('当前状态落在停用项上 → currentDisabled=true');
  } else {
    fail('currentDisabled 没有置位');
  }
}

// 4. 响应里没有任何启停字段：一个都不能少（不能把「未知」当「停用」）
{
  const r = await run([
    { id: 's1', code: 'draft', name: '草稿' },
    { id: 's2', code: 'done', name: '已完成' },
  ]);
  if (r.ok && r.statuses.length === 2 && r.hiddenCount === 0) {
    ok('无启停字段时全部保留（不误杀）');
  } else {
    fail(`无字段时被过滤：${JSON.stringify(codes(r))} hidden=${r.hiddenCount}`);
  }
}

console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 1);
