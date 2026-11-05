/**
 * 常用页面**编辑器**的浏览器判据（v4.2.44）。
 *
 * 纯逻辑已经由 `verify-favorites.mjs` 钉住（归一化/去重/上限）；这一条补它覆盖不到的那层：
 * **HTML 里的元素 id、事件绑定、与后台的消息往返**是不是真的接上了。
 *
 * 验什么：
 *   ① 「常用页面」页签里的清单是**行**（不是 textarea），默认 6 条且名称对得上；
 *   ② 「＋ 添加一条」新增一行、聚焦到名称输入框；
 *   ③ 改名 + 填路径后出现「有未保存的修改」；
 *   ④ 点保存 → 后台写 `chrome.storage.local`，路径补了前导 `/`，提示「已保存 7 条」；
 *   ⑤ 重新打开页面 → 仍是 7 条（真的落盘了，不是只改了内存）；
 *   ⑥ 「恢复默认」删掉用户键并回到 6 条。
 *
 * ★ 不验拖拽排序（合成 drag 事件在不同 Chromium 版本上不稳定）；
 *   `↑ / ↓` 与删除按钮属于同一段状态机，由 ①–⑥ 的渲染/保存链路间接覆盖。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const PROFILE = path.join(ROOT, 'tmp', 'ui-fav-editor');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  bad++;
};

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(mp)) return null;
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

function extensionIdFromKey(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = createHash('sha256').update(der).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

if (!fs.existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('✗ 跑前必须先 npm run build');
  process.exit(2);
}
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const chromePath = findPwChromium();
if (!chromePath) {
  console.error('✗ ms-playwright 下没有 chromium-*');
  process.exit(2);
}

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: chromePath,
  headless: true,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const pageErrors = [];
ctx.on('page', (p) => {
  p.on('pageerror', (e) => pageErrors.push(`${p.url()} :: ${e.message}`));
});

const url = `chrome-extension://${extId}/ui/parallel/parallel.html`;
const page = await ctx.newPage();

/** 打开管理页 → 切到「常用页面」→ 等清单装载完 */
async function openFavorites() {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  // 未登录时整页盖着 `#login-mask`、`#tabbed` 带 `is-locked`（产品行为，不是 bug）
  // ⇒ 本用例只验书签编辑器，把这两层摘掉再点；书签的读写在 background，与登录态无关。
  await page.evaluate(() => {
    document.getElementById('login-mask')?.remove();
    document.getElementById('tabbed')?.classList.remove('is-locked');
  });
  await page.click('.tabs .tab[data-tab="favorites"]');
  await page.waitForSelector('#fav-rows .fav-row', { timeout: 5000 }).catch(() => null);
  await page.waitForTimeout(250);
}

const rowCount = () => page.$$eval('#fav-rows .fav-row', (els) => els.length);
const rowNames = () => page.$$eval('#fav-rows .fav-name', (els) => els.map((e) => e.value));

try {
  await openFavorites();

  // ① 行结构 + 默认 6 条
  const n0 = await rowCount();
  const hasTextarea = await page.$('#fav-text');
  if (!hasTextarea && n0 === 6) {
    ok(`页签渲染为行编辑器（无 textarea，${n0} 行）`);
  } else {
    fail(`结构不对：textarea=${Boolean(hasTextarea)} rows=${n0}`);
  }
  const names0 = await rowNames();
  if (names0[0] === '用户管理' && names0.includes('工作流')) {
    ok('默认清单名称对得上（用户管理 / 工作流）');
  } else {
    fail(`默认名称不对：${JSON.stringify(names0)}`);
  }

  // ② 添加一行并聚焦
  await page.click('#fav-add');
  await page.waitForTimeout(120);
  const n1 = await rowCount();
  const focused = await page.evaluate(() => document.activeElement?.className ?? '');
  if (n1 === 7 && focused.includes('fav-name')) {
    ok('「＋ 添加一条」新增一行并聚焦名称输入框');
  } else {
    fail(`添加行为不对：rows=${n1} focus=${focused}`);
  }

  // ③ 填写后出现未保存提示
  const last = page.locator('#fav-rows .fav-row').last();
  await last.locator('.fav-name').fill('验证页面');
  await last.locator('.fav-path').fill('admin/verify-page');
  const dirtyShown = await page.isVisible('#fav-dirty');
  if (dirtyShown) {
    ok('编辑后出现「有未保存的修改」');
  } else {
    fail('编辑后没有脏状态提示');
  }

  // ④ 保存 → 后台归一化并写盘
  await page.click('#fav-save');
  await page.waitForFunction(() => (document.querySelector('#fav-tip')?.textContent ?? '').includes('已保存'), null, {
    timeout: 5000,
  });
  const tip = await page.textContent('#fav-tip');
  const stored = await page.evaluate(async () => {
    const o = await chrome.storage.local.get('ql:favorites');
    return o['ql:favorites'];
  });
  if (Array.isArray(stored) && stored.length === 7 && stored[6].path === '/admin/verify-page') {
    ok(`保存后落盘 7 条，相对路径补成 ${stored[6].path}`);
  } else {
    fail(`落盘不对：${JSON.stringify(stored)}`);
  }
  if (tip.includes('已保存 7 条')) {
    ok(`提示如实的条数（${tip.trim()}）`);
  } else {
    fail(`提示文案不对：${tip}`);
  }
  if (!(await page.isVisible('#fav-dirty'))) {
    ok('保存后脏状态消失');
  } else {
    fail('保存后仍显示未保存');
  }

  // ⑤ 重新打开：仍在（真的落盘，不是内存态）
  await openFavorites();
  const names1 = await rowNames();
  if ((await rowCount()) === 7 && names1[6] === '验证页面') {
    ok('重新打开页面后第 7 条仍在');
  } else {
    fail(`重开后条数/名称不对：rows=${await rowCount()} names=${JSON.stringify(names1)}`);
  }

  // ⑥ 恢复默认：删用户键、回 6 条
  await page.click('#fav-reset');
  await page.waitForFunction(() => document.querySelectorAll('#fav-rows .fav-row').length === 6, null, {
    timeout: 5000,
  });
  const keyGone = await page.evaluate(async () => {
    const o = await chrome.storage.local.get('ql:favorites');
    return o['ql:favorites'] === undefined;
  });
  if ((await rowCount()) === 6 && keyGone) {
    ok('「恢复默认」删掉用户键并回到 6 条');
  } else {
    fail(`恢复默认不对：rows=${await rowCount()} keyGone=${keyGone}`);
  }

  if (pageErrors.length === 0) {
    ok('全程无未捕获页面错误');
  } else {
    fail(`页面错误：${pageErrors.slice(0, 3).join(' | ')}`);
  }
} catch (e) {
  fail(`异常：${e instanceof Error ? e.message : String(e)}`);
} finally {
  await ctx.close();
}

console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: FAIL (${bad})`);
process.exit(bad === 0 ? 0 : 1);
