/**
 * 判据：**更新提醒的版本比较与状态机**（纯逻辑，不碰 chrome.*，秒级）。
 *
 * 跑法：`node tools/verify/verify-update-logic.mjs`
 *
 * 为什么需要它：更新提醒最怕两种"看起来正常"的坏：
 *   ① 版本比较把 `4.2.9` 判成比 `4.2.10` 新（字符串比较的经典病）⇒ 永远不提醒；
 *   ② 用户点了"忽略此版本"，下次仍弹 ⇒ 提醒变成骚扰。
 * 这两条都不会抛异常，只会让功能静默失效 —— 所以用纯函数判据钉住。
 *
 * ★ 另外钉住"**只提醒、不自动更新**"的产品口径：本模块的全部输出只有
 *   `UpdateState`（版本号与 URL），**没有**任何下载/安装函数可被误用。
 */
import assert from 'node:assert/strict';
import {
  applyUpdateDefaults,
  compareVersions,
  emptyUpdateState,
  isNewerVersion,
  parseReleasePayload,
  shouldAutoCheck,
  shouldPrompt,
  UPDATE_CHECK_INTERVAL_MS,
} from '../../packages/extension/src/shared/update-logic.ts';

let passed = 0;
const ok = (label, cond) => {
  assert.ok(cond, label);
  passed += 1;
  console.log(`  OK  ${label}`);
};

console.log('=== 1. 版本比较（数字段，不是字符串） ===');
ok('4.2.55 > 4.2.54', compareVersions('4.2.55', '4.2.54') > 0);
ok('v4.2.54 == 4.2.54', compareVersions('v4.2.54', '4.2.54') === 0);
ok('4.2.10 > 4.2.9（字符串比较会判反）', compareVersions('4.2.10', '4.2.9') > 0);
ok('4.3.0 > 4.2.99', compareVersions('4.3.0', '4.2.99') > 0);
ok('4.2.55-beta < 4.2.55', compareVersions('4.2.55-beta', '4.2.55') < 0);
ok('4.2.55+build == 4.2.55（构建元数据不参与比较）', compareVersions('4.2.55+build', '4.2.55') === 0);

console.log('\n=== 2. 是否"有更新" ===');
ok('4.2.55 比 4.2.54 新', isNewerVersion('4.2.55', '4.2.54') === true);
ok('同版本不算更新', isNewerVersion('4.2.54', '4.2.54') === false);
ok('旧版本不算更新', isNewerVersion('4.2.53', '4.2.54') === false);
ok('null / 空串不算更新', isNewerVersion(null, '4.2.54') === false && isNewerVersion('', '4.2.54') === false);
ok('不合法的 tag 不算更新', isNewerVersion('latest', '4.2.54') === false);

console.log('\n=== 3. GitHub 响应解析 ===');
const good = parseReleasePayload({
  tag_name: 'v4.2.60',
  html_url: 'https://github.com/jizi-dragon/akso-pass/releases/tag/v4.2.60',
  name: 'v4.2.60 更新提醒',
  published_at: '2026-11-09T00:00:00Z',
});
ok('合法响应 → 版本号去掉 v', good !== null && good.version === '4.2.60');
ok('合法响应 → 保留 html_url', good !== null && good.url.endsWith('/v4.2.60'));
ok('缺 tag_name → null', parseReleasePayload({ html_url: 'x' }) === null);
ok('tag 不是 semver → null', parseReleasePayload({ tag_name: 'nightly' }) === null);
ok('非对象 → null', parseReleasePayload(null) === null);

console.log('\n=== 4. 提醒判定（忽略此版本后不再打扰） ===');
const base = { ...emptyUpdateState('4.2.54'), latestVersion: '4.2.55', releaseUrl: 'https://github.com/jizi-dragon/akso-pass/releases/latest' };
ok('有新版本且未忽略 → 提醒', shouldPrompt(base) === true);
ok('忽略当前最新版 → 不提醒', shouldPrompt({ ...base, dismissedVersion: '4.2.55' }) === false);
ok('忽略旧版、又出了新版 → 仍提醒', shouldPrompt({ ...base, latestVersion: '4.2.56', dismissedVersion: '4.2.55' }) === true);
ok('没有新版本 → 不提醒', shouldPrompt({ ...base, latestVersion: '4.2.54' }) === false);

console.log('\n=== 5. 自动检查节流（6 小时） ===');
const now = 1_800_000_000_000;
ok('从未检查 → 检查', shouldAutoCheck(null, now) === true);
ok('5 分钟前检查过 → 跳过', shouldAutoCheck({ ...base, checkedAt: now - 5 * 60_000 }, now) === false);
ok('刚好 6 小时 → 检查', shouldAutoCheck({ ...base, checkedAt: now - UPDATE_CHECK_INTERVAL_MS }, now) === true);

console.log('\n=== 6. 存储归一化（坏数据不崩） ===');
ok('null → 空状态', applyUpdateDefaults(null, '4.2.54').latestVersion === null);
ok('字符串 → 空状态', applyUpdateDefaults('oops', '4.2.54').currentVersion === '4.2.54');
ok('部分字段 → 保留并补全', (() => {
  const state = applyUpdateDefaults({ latestVersion: '4.2.60', checkedAt: 123 }, '4.2.54');
  return state.latestVersion === '4.2.60' && state.checkedAt === 123 && state.dismissedVersion === null;
})());
ok('currentVersion 永远用运行版本覆盖', applyUpdateDefaults({ currentVersion: '0.0.1' }, '4.2.55').currentVersion === '4.2.55');

console.log('\n=== 7. 口径自证：只提醒，不自动更新 ===');
const source = await (await import('node:fs/promises')).readFile(
  new URL('../../packages/extension/src/background/update-check.ts', import.meta.url),
  'utf8',
);
ok('后台模块里没有下载/解压/安装调用', !/download|unzip|installUpdate|chrome\.management/i.test(source));
ok('打开 Releases 用的是 chrome.tabs.create', source.includes('chrome.tabs.create'));

console.log(`\n=== 汇总：${passed} 条全部通过 ===`);
