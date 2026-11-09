/**
 * 判据：**更新提醒在真实扩展里真的"只提醒、不自动更新"**（真起 Chromium，约 10 秒）。
 *
 * 跑法：`node tools/verify/verify-update-ui.mjs`
 *
 * 为什么要真机：`verify-update-logic.mjs` 只证明纯函数对，证明不了
 *   ① 后台的 `update.state` 消息真的被接上；
 *   ② 横幅真的会出现在管理页、文案里真的有"不会自动更新"；
 *   ③ 角标真的亮；点「忽略此版本」后真的收起且落盘。
 * 这四步任何一步断了，纯逻辑判据**照样全绿** —— 所以单独一条。
 *
 * 做法：装载 `dist/`，往 `chrome.storage.local` 写一份"最新版 9.9.9"的状态，
 * 重开管理页，断言横幅/角标；再点「忽略此版本」，断言横幅消失、状态落盘。
 * ★ 不触网：状态是直接写入的，GitHub API 不参与本判据。
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const DIST = join(ROOT, 'dist');
const PROFILE = join(ROOT, 'tmp', 'ui-update-check');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

function extensionIdFromKey(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = createHash('sha256').update(der).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * 读 `ql:updateState`，**轮询到断言的条件成立或超时**。
 *
 * ★★ 2026-11-09：这两处原来是"点完立刻读一次"。单独跑 3/3 全绿，但在 `--browser-only`
 *   的全量批次里偶发读到 `null`（一次批次里两条同时红）—— 因为**写这个键的是后台**，
 *   而页面先拿到了应答（弹窗已经显示 9.9.10），落盘是随后的事。
 *   ⇒ 判据要盯的是"最终写成什么"，不是"点完那一瞬间是几"。加**有界轮询**，
 *   断言本身一个字没放宽（仍然严格要求等于 9.9.10），只是不再和调度赛跑。
 *   这和 PITFALLS #57 的推广第 2 条是同一件事：**判据与写入之间有一层异步**。
 */
async function waitUpdateState(page, pred, timeout = 8_000) {
  const started = Date.now();
  let last;
  for (;;) {
    last = await page.evaluate(async () => (await chrome.storage.local.get('ql:updateState'))['ql:updateState']);
    if (pred(last)) return last;
    if (Date.now() - started > timeout) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
}

function findPwChromium() {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'ms-playwright') : null;
  if (base === null || !existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    if (!dir.startsWith('chromium-')) continue;
    for (const exe of [join(base, dir, 'chrome-win64', 'chrome.exe'), join(base, dir, 'chrome-win', 'chrome.exe')]) {
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

console.log('=== 前提 ===');
check('dist/manifest.json 存在（跑前必须 npm run build）', existsSync(join(DIST, 'manifest.json')));
if (!existsSync(join(DIST, 'manifest.json'))) process.exit(1);
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const currentVersion = manifest.version;
check('能从 manifest.key 算出扩展 ID', /^[a-p]{32}$/.test(extId), extId);
const chromePath = findPwChromium();
check('找到了 playwright 自带的完整 Chromium（不是 headless shell）', Boolean(chromePath), chromePath ?? 'ms-playwright 下没有 chromium-*/chrome.exe');
if (chromePath === null) process.exit(1);

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: chromePath,
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--no-default-browser-check'],
});

try {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
  await page.waitForLoadState('domcontentloaded');

  // 写一份"有新版本"的状态：latest 远大于当前，未忽略
  await page.evaluate(async (state) => {
    await chrome.storage.local.set({ 'ql:updateState': state });
  }, {
    currentVersion,
    latestVersion: '9.9.9',
    releaseUrl: 'https://github.com/jizi-dragon/akso-pass/releases/tag/v9.9.9',
    releaseName: 'v9.9.9',
    publishedAt: '2026-11-09T00:00:00Z',
    checkedAt: Date.now(),
    error: null,
    dismissedVersion: null,
    etag: null,
  });

  await page.reload();
  const banner = page.locator('#update-banner');
  await banner.waitFor({ state: 'visible', timeout: 10_000 });

  console.log('\n=== ① 横幅出现，且用户看得到"不会自动更新" ===');
  const text = (await page.locator('#update-text').innerText()).replace(/\s+/g, ' ');
  check('横幅可见', await banner.isVisible());
  check('文案含最新版本号', text.includes('9.9.9'), text.slice(0, 80));
  check('文案含"不会自动更新"（用户知情）', text.includes('不会自动更新'));
  check('文案含当前版本号', text.includes(currentVersion));

  console.log('\n=== ② 角标亮起（不是只改页面） ===');
  const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
  const badge = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check('工具栏角标为 1', badge === '1', `badge=${JSON.stringify(badge)}`);

  console.log('\n=== ②b 手动「检查更新」按钮：点一次就真的查一次（不受 6h 节流） ===');
  const checkBtn = page.locator('#update-check');
  check('侧栏有常驻「检查更新」按钮', await checkBtn.isVisible());
  check('按钮文案为「检查更新」', (await checkBtn.innerText()).trim() === '检查更新', (await checkBtn.innerText()).trim());
  // 把后台这一次的 GitHub 响应换成 9.9.10：只桩 fetch，不改存储，模拟"服务器上出了更新版"
  await worker.evaluate((ver) => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: `v${ver}`,
      name: `v${ver}`,
      html_url: `https://github.com/jizi-dragon/akso-pass/releases/tag/v${ver}`,
      published_at: '2026-11-09T00:00:00Z',
      body: '',
    }), { status: 200, headers: { 'content-type': 'application/json', etag: '"probe"' } });
  }, '9.9.10');
  await checkBtn.click();
  const modal = page.locator('#update-modal');
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  check('点击后弹出对话框（不是横幅）', await modal.isVisible());
  const modalStatus = (await page.locator('#update-modal-status').innerText()).trim();
  check('弹窗写明发现 9.9.10', modalStatus.includes('9.9.10'), modalStatus);
  check('弹窗给出「去 GitHub 下载」入口', await page.locator('#update-modal-open').isVisible());
  const manualState = await waitUpdateState(page, (s) => s?.latestVersion === '9.9.10');
  check('后台把最新版本写成 9.9.10', manualState?.latestVersion === '9.9.10', JSON.stringify(manualState?.latestVersion));
  check('按钮检查后恢复可用', await checkBtn.isEnabled());
  await page.locator('#update-modal-close').click();
  await modal.waitFor({ state: 'hidden', timeout: 5_000 });
  check('「知道了」能关掉对话框', !(await modal.isVisible()));

  console.log('\n=== ②c 检查失败时：弹窗说清原因，不糊成「后台没有响应」 ===');
  await worker.evaluate(() => {
    globalThis.fetch = async () => {
      throw new TypeError('Failed to fetch');
    };
  });
  await checkBtn.click();
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  const failTitle = (await page.locator('#update-modal-title').innerText()).trim();
  const failStatus = (await page.locator('#update-modal-status').innerText()).trim();
  check('失败时弹窗标题为「检查更新失败」', failTitle === '检查更新失败', failTitle);
  check('失败原因能被用户读懂（不是「后台没有响应」）',
    failStatus.includes('无法访问') && !failStatus.includes('后台没有响应'), failStatus);
  await page.locator('#update-modal-close').click();
  await modal.waitFor({ state: 'hidden', timeout: 5_000 });

  console.log('\n=== ③「忽略此版本」：横幅收起且落盘 ===');
  await page.locator('#update-dismiss').click();
  await banner.waitFor({ state: 'hidden', timeout: 10_000 });
  check('横幅已收起', !(await banner.isVisible()));
  const stored = await waitUpdateState(page, (s) => s?.dismissedVersion === '9.9.10');
  check('忽略的版本已写入存储', stored?.dismissedVersion === '9.9.10', JSON.stringify(stored?.dismissedVersion));
  const badgeAfter = await worker.evaluate(() => chrome.action.getBadgeText({}));
  check('角标已清空', badgeAfter === '', `badge=${JSON.stringify(badgeAfter)}`);

  console.log('\n=== ④ 没有"自动更新"入口 ===');
  const html = await page.content();
  check('页面里没有下载/安装按钮', !/自动更新并安装|立即安装|downloadAndInstall/i.test(html));

  console.log('\n=== ⑤ 弹窗里也能手动检查 ===');
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/ui/popup/popup.html`);
  await popup.waitForLoadState('domcontentloaded');
  const popupBtn = popup.locator('#popup-check');
  check('弹窗有「检查更新」按钮', await popupBtn.isVisible());
  await worker.evaluate((ver) => {
    globalThis.fetch = async () => new Response(JSON.stringify({
      tag_name: `v${ver}`,
      name: `v${ver}`,
      html_url: `https://github.com/jizi-dragon/akso-pass/releases/tag/v${ver}`,
      published_at: '2026-11-09T00:00:00Z',
      body: '',
    }), { status: 200, headers: { 'content-type': 'application/json', etag: '"probe"' } });
  }, '9.9.11');
  await popupBtn.click();
  await popup.waitForFunction(() => document.querySelector('#update-status')?.textContent?.includes('9.9.11'), null, { timeout: 10_000 });
  check('弹窗提示发现 9.9.11', (await popup.locator('#update-status').innerText()).includes('9.9.11'));
  const hint = popup.locator('#update-hint');
  check('弹窗出现去下载入口', await hint.isVisible());
  check('入口文案指向 GitHub 下载', (await hint.innerText()).includes('GitHub'));
  await popup.close();
} finally {
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

const failed = results.filter((value) => !value).length;
console.log(`\n=== 汇总：${results.length - failed}/${results.length} 通过 ===`);
process.exit(failed === 0 ? 0 : 1);
