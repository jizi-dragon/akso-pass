/**
 * verify-ui-select（v4.2.29）：**"添加账号"表单里的选择不能被 3 秒轮询改回去**
 *
 * 为什么需要这个探针（PITFALLS #53）：
 *  · `parallel.ts` 每 3 秒跑一次 `refreshAll()`；在线时它走 `loadAtomicState()`（`par.state`），
 *    而那个函数**每轮都把 `lastHostOptions` / `lastBoxOptions` 清空**（为了强制重画），
 *    于是 `fillSiteOptions()` / `fillBoxOptions()` 每 3 秒重建一次 `<select>`，重建后又把
 *    `value` 写回 `preferred`（上次提交的站点 → 首选站点 → 列表第一个）——
 *    用户在"添加账号"里刚选的站点，三秒后被静默改回默认值。
 *  · 离线时走的是三段读取（`loadSites()` 只在**站点数据真变了**时失效下拉），所以这个
 *    缺陷**只在在线态复现** —— 台架必须让 `par.state` 成功，所以这里起一个**假云端**
 *    （`/api/ui/state`），而不是像 `verify-duplicate.mjs` 那样把云端打死走离线快照。
 *
 * 断言：
 *   1. 下拉里有 3 个站点（假云端给的），且初始值 = 列表第一个（`akso-devops`）
 *   2. 手动选第三个站点后，**11 秒内（≥3 个轮询周期）值不变**
 *   3. 盒子下拉同理（选第二个盒子后保持不变）
 *   4. 选项集合在这 11 秒里保持稳定（没有被反复重建/插入）
 *
 * 用法：node tools/verify/verify-ui-select.mjs
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, 'tmp');

const fails = [];
function check(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
    fails.push(name);
  }
}

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
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

/* ---------- 测试用扩展副本：host_permissions 打开（安装即授权，避免权限弹窗） ---------- */
// `PROBE_DIST=<路径>` 可指向别的构建产物（做"改前/改后"对比用）
const SRC_DIST = process.env.PROBE_DIST ? path.resolve(ROOT, process.env.PROBE_DIST) : DIST;
const TESTDIST = path.join(TMP, 'verify-ui-select-dist');
fs.rmSync(TESTDIST, { recursive: true, force: true });
fs.cpSync(SRC_DIST, TESTDIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(TESTDIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://*/*'];
fs.writeFileSync(path.join(TESTDIST, 'manifest.json'), JSON.stringify(mf, null, 2));
const extId = extensionIdFromKey(mf.key);

/* ---------- 假云端：/api/ui/state（在线态原子读取） ---------- */
// 站点标题全用 ASCII，`buildSiteRows()` 按 title 排序后 `akso-devops` 稳定排第一。
const SITES = [
  { id: 's1', host: 'akso-devops.example.com', name: 'akso-devops', displayName: 'akso-devops', baseUrl: 'https://akso-devops.example.com', accountCount: 0, note: '' },
  { id: 's2', host: 'beta-site.example.com', name: 'beta-site', displayName: 'beta-site', baseUrl: 'https://beta-site.example.com', accountCount: 0, note: '' },
  { id: 's3', host: 'cangjie-site.example.com', name: 'cangjie-site', displayName: 'cangjie-site', baseUrl: 'https://cangjie-site.example.com', accountCount: 0, note: '' },
];
const BOXES = [
  { name: '默认盒子', isDefault: true, disabled: false },
  { name: '第二盒子', isDefault: false, disabled: false },
];
const hits = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  hits.push(u.pathname);
  const json = (obj) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (u.pathname === '/api/ui/state') {
    return json({
      format: 'akso-cloud-ui-state',
      revision: 1,
      defaultBox: '默认盒子',
      accounts: [],
      sites: SITES,
      boxes: BOXES,
    });
  }
  // 兜底：其余端点返回空表（让 UI 的回落路径也安静失败，别把错误横幅刷满）
  if (u.pathname === '/api/accounts') return json({ format: 'akso-cloud-accounts', accounts: [], boxes: BOXES });
  if (u.pathname === '/api/sites') return json({ format: 'akso-cloud-sites', sites: SITES });
  return json({ format: 'unknown', items: [] });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const profile = path.join(TMP, 'verify-ui-select-profile');
fs.rmSync(profile, { recursive: true, force: true });
const exe = findPwChromium();
if (!exe) {
  console.error('找不到 Playwright Chromium');
  process.exit(2);
}
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe,
  headless: true,
  args: [`--disable-extensions-except=${TESTDIST}`, `--load-extension=${TESTDIST}`, '--no-first-run'],
});
try {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
  // 云端授权指向假云端（`cloudRequest` 会用它拼 `/api/...`）
  await page.evaluate((base) => chrome.storage.local.set({
    'ql:cloudAuth': { baseUrl: base, token: 'verify-fake-token', email: 'verify@local', displayName: 'verify' },
  }), BASE);
  await page.reload();
  await page.waitForTimeout(800);

  /* ---- 前置：表单里的下拉被填好了 ---- */
  await page.click('[data-tab="add"]');
  // 注意：`<option>` 在 Playwright 眼里不算 visible（且 `#pane-add` 切换靠 hidden 属性），
  // 所以只能按 attached 等，选中动作也走 evaluate（别依赖可见性）。
  await page.waitForSelector('#p-host option', { state: 'attached', timeout: 15000 });
  const paneVisible = await page.evaluate(() => !document.getElementById('pane-add').hasAttribute('hidden'));
  check('「添加账号」面板已打开', paneVisible);
  // 等一次轮询（3s）落地，确保拿到的是"在线态"填充出来的选项
  await page.waitForTimeout(1200);

  const readOptions = () => page.evaluate(() => {
    const sel = document.getElementById('p-host');
    return { value: sel.value, values: [...sel.options].map((o) => o.value) };
  });
  const pick = (id, v) => page.evaluate(([elId, val]) => {
    const sel = document.getElementById(elId);
    sel.value = val;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, v]);
  const initial = await readOptions();
  check('假云端生效：站点下拉有 3 个站点', initial.values.length === 3, JSON.stringify(initial.values));
  check('初始值 = 列表第一个（akso-devops）', initial.value === 'akso-devops.example.com', initial.value);

  /* ---- 场景1：手动选第三个站点，之后 11 秒内不得被改回 ---- */
  await pick('p-host', 'cangjie-site.example.com');
  const picks = [];
  for (let i = 0; i < 44; i++) {
    await page.waitForTimeout(250);
    const now = await readOptions();
    picks.push(now.value);
  }
  const drifted = [...new Set(picks)];
  check(
    '选中第三个站点后 11 秒（≥3 个轮询周期）没被改回',
    picks.every((v) => v === 'cangjie-site.example.com'),
    `期间出现过：${JSON.stringify(drifted)}`,
  );
  const after = await readOptions();
  check('选项集合保持稳定（没有反复重建出多余项）', JSON.stringify(after.values) === JSON.stringify(initial.values), JSON.stringify(after.values));

  /* ---- 场景2：盒子下拉同理 ---- */
  const readBoxes = () => page.evaluate(() => {
    const sel = document.getElementById('p-box');
    return { value: sel.value, values: [...sel.options].map((o) => o.value) };
  });
  const boxInit = await readBoxes();
  if (boxInit.values.includes('第二盒子')) {
    await pick('p-box', '第二盒子');
    const boxPicks = [];
    for (let i = 0; i < 16; i++) {
      await page.waitForTimeout(250);
      boxPicks.push((await readBoxes()).value);
    }
    check('盒子下拉同样不被轮询改回', boxPicks.every((v) => v === '第二盒子'), JSON.stringify([...new Set(boxPicks)]));
  } else {
    check('盒子下拉里应有第二个盒子（假云端给了两个）', false, JSON.stringify(boxInit.values));
  }

  console.log(`\n  （假云端收到的请求：${[...new Set(hits)].slice(0, 6).join(', ')}… 共 ${hits.length} 次）`);
} finally {
  await ctx.close().catch(() => {});
  server.close();
}

console.log(`\n=== 汇总：${fails.length === 0 ? '全部通过' : `${fails.length} 项失败`} ===`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exit(1);
}

