/**
 * 常用页面书签的**纯逻辑**判据（v4.2.44，不碰 DOM / chrome 网络）。
 *
 * 用户 2026-11-05 要求：常用页面改成可视化编辑。前端换成行编辑器后，
 * 「存的到底是什么」这件事必须仍然只有一个出口 —— `background/core/favorites.ts`。
 * 这里钉住那个出口的契约：
 *   1) 相对路径补前导 `/`；完整 http(s) 网址原样保留；
 *   2) 非 http(s) 协议（`javascript:` / `data:`）、协议相对地址（`//host`）、反斜杠一律拒绝；
 *   3) 同一条路径只留第一次出现的（`/a` 与 `a` 归一化后算同一条）；
 *   4) **空数组就是空**（用户删光了不能复活默认）；只有 storage 里没有这个键才回落默认；
 *   5) 超过上限按顺序截断，并把「少了几条」如实回报给界面。
 *
 * ★ 为什么要连 `isEnabled` 那一类问题一起看：保存链路一旦「静默丢条目」，
 *   界面上是「我明明加过这条，怎么没了」，而不是报错 —— 所以这里每条都断言计数。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src', 'background', 'core', 'favorites.ts');
const OUT = path.join(ROOT, 'tmp', 'favorites.cjs');
const KEY = 'ql:favorites';
const FAVORITES_MAX = 60;

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

// chrome.storage.local 的最小替身：`get` 只回「存在的键」，与真实 API 一致
const store = new Map();
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          store.set(k, v);
        }
      },
      remove: async (k) => {
        store.delete(k);
      },
    },
  },
};

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
const { listFavorites, saveFavorites, resetFavorites, resolveFavoriteUrl } = await import(
  pathToFileURL(OUT).href
);
for (const [name, fn] of Object.entries({ listFavorites, saveFavorites, resetFavorites, resolveFavoriteUrl })) {
  if (typeof fn !== 'function') {
    console.error(`✗ favorites.ts 没有导出 ${name}`);
    process.exit(2);
  }
}

const pathsOf = (items) => items.map((x) => x.path);

// 1. 归一化：补前导 `/`、绝对网址原样、名称去空白
{
  store.clear();
  const r = await saveFavorites([
    { name: '  用户管理  ', path: 'admin/user-mgmt/users/list' },
    { name: '外部看板', path: 'https://bi.example.com/dash?x=1' },
  ]);
  if (r.items.length === 2 && r.items[0].name === '用户管理' && r.items[0].path === '/admin/user-mgmt/users/list') {
    ok('相对路径补前导 /，名称去空白');
  } else {
    fail(`归一化不对：${JSON.stringify(r.items)}`);
  }
  if (r.items[1].path === 'https://bi.example.com/dash?x=1') {
    ok('完整 https 网址原样保留');
  } else {
    fail(`绝对地址被改：${r.items[1]?.path}`);
  }
  if (Array.isArray(store.get(KEY)) && store.get(KEY).length === 2) {
    ok('写入 storage.local 的是归一化后的两条');
  } else {
    fail('storage.local 没有写对');
  }
}

// 2. 非法协议 / 协议相对地址 / 反斜杠 / 空名称 —— 全部计入 skipped
{
  store.clear();
  const r = await saveFavorites([
    { name: 'XSS', path: 'javascript:alert(1)' },
    { name: 'Data', path: 'data:text/html,<b>x</b>' },
    { name: '协议相对', path: '//evil.example.com/x' },
    { name: '反斜杠', path: '\\\\evil\\x' },
    { name: '   ', path: '/ok' },
    { name: '正常', path: '/ok' },
  ]);
  if (r.items.length === 1 && r.items[0].path === '/ok' && r.skipped === 5) {
    ok('非法协议/协议相对/反斜杠/空名称被忽略（skipped=5）');
  } else {
    fail(`非法项处理不对：items=${JSON.stringify(r.items)} skipped=${r.skipped}`);
  }
}

// 3. 路径去重：`/a` 与 `a` 归一化后是同一条，保留第一次出现的名称
{
  store.clear();
  const r = await saveFavorites([
    { name: '第一次', path: '/a' },
    { name: '第二次', path: 'a' },
    { name: '大小写不同', path: '/A' },
  ]);
  if (r.items.length === 2 && r.items[0].name === '第一次' && r.duplicates === 1) {
    ok('归一化后同路径去重，保留先出现的（duplicates=1）');
  } else {
    fail(`去重不对：${JSON.stringify(r.items)} duplicates=${r.duplicates}`);
  }
}

// 4. 空数组就是空：用户删光了不能复活默认
{
  store.clear();
  await saveFavorites([]);
  const list = await listFavorites();
  if (Array.isArray(list) && list.length === 0) {
    ok('保存空数组后 listFavorites 返回空（不回落默认）');
  } else {
    fail(`删光后仍有 ${list.length} 条，默认值复活了`);
  }
}

// 5. 键不存在 ⇒ 回落内置默认
{
  store.clear();
  const list = await listFavorites();
  if (list.length > 0 && list[0].name && list[0].path) {
    ok(`未配置过时回落内置默认（${list.length} 条）`);
  } else {
    fail('未配置过时没有回落默认');
  }
}

// 6. 超上限截断，并在结果里如实回报 truncated
{
  store.clear();
  const many = Array.from({ length: FAVORITES_MAX + 5 }, (_, i) => ({ name: `P${i}`, path: `/p/${i}` }));
  const r = await saveFavorites(many);
  if (r.items.length === FAVORITES_MAX && r.truncated === 5) {
    ok(`超过上限截到 ${FAVORITES_MAX} 条，truncated=5`);
  } else {
    fail(`截断不对：kept=${r.items.length} truncated=${r.truncated}`);
  }
  const list = await listFavorites();
  if (list.length === FAVORITES_MAX && pathsOf(list)[0] === '/p/0') {
    ok('读回顺序与截断顺序一致（保留前 60 条）');
  } else {
    fail('读回顺序/条数不对');
  }
}

// 7. resetFavorites：删键并回默认；之后的 listFavorites 也回默认
{
  store.clear();
  await saveFavorites([{ name: '临时', path: '/tmp' }]);
  const r = await resetFavorites();
  const list = await listFavorites();
  if (r.length > 0 && list.length === r.length && !store.has(KEY)) {
    ok('resetFavorites 删除用户键并回默认');
  } else {
    fail(`reset 不对：reset=${r.length} list=${list.length} hasKey=${store.has(KEY)}`);
  }
}

// 8. resolveFavoriteUrl：非 http(s) 的绝对地址点不开；相对路径拼到 base
{
  store.clear();
  const evil = await resolveFavoriteUrl('javascript:alert(1)', 'https://a.test');
  if (evil === null) {
    ok('resolveFavoriteUrl 拒绝 javascript:');
  } else {
    fail(`resolveFavoriteUrl 放过了 javascript: → ${evil}`);
  }
  const rel = await resolveFavoriteUrl('admin/x', 'https://a.test');
  if (rel === 'https://a.test/admin/x') {
    ok('resolveFavoriteUrl 相对路径按 base 拼接并补 /');
  } else {
    fail(`相对路径解析不对：${rel}`);
  }
}

// 9. 名称过长截断（不因为一个超长名称让整条被忽略）
{
  store.clear();
  const r = await saveFavorites([{ name: '名'.repeat(80), path: '/long' }]);
  if (r.items.length === 1 && r.items[0].name.length === 60) {
    ok('名称超长截到 60 字，条目保留');
  } else {
    fail(`长名称处理不对：len=${r.items[0]?.name.length}`);
  }
}

console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 1);
