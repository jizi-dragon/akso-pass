/**
 * 状态轮盘缓存的纯逻辑判据：TTL / 页签失效 / 容量上限。
 * 运行：node tools/verify/verify-status-cache.mjs
 */
import { build } from 'esbuild';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCE = join(ROOT, 'packages', 'extension', 'src', 'background', 'core', 'status-cache.ts');
const built = await build({
  entryPoints: [SOURCE], bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20',
});
const module = { exports: {} };
new Function('module', 'exports', built.outputFiles[0].text)(module, module.exports);
const { StatusCache } = module.exports;

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

const c = new StatusCache(1000, 3);
c.set('1|a', { name: 'A' }, 100);
check('命中未过期', c.get('1|a', 200)?.name === 'A');
check('过期返回 null', c.get('1|a', 1201) === null);
check('不存在的键返回 null', c.get('1|missing', 100) === null);
check('invalidateTab 只清该页签', (() => {
  c.clear();
  c.set('1|a', 1, 0);
  c.set('2|a', 2, 0);
  c.invalidateTab(1);
  return c.get('1|a', 0) === null && c.get('2|a', 0) === 2;
})());
check('容量上限淘汰最旧', (() => {
  const small = new StatusCache(1000, 2);
  small.set('a', 1, 0);
  small.set('b', 2, 0);
  small.set('c', 3, 0);
  return small.size === 2 && small.get('a', 0) === null && small.get('c', 0) === 3;
})());
check('clear 清空', (() => {
  const x = new StatusCache(1000, 2);
  x.set('a', 1, 0);
  x.clear();
  return x.size === 0;
})());

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  process.exit(1);
}
console.log('RESULT: OK');
