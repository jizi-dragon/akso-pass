/**
 * verify-duplicate（v4.2.27）：**复制页签 / 站点开窗的账号归属**
 *
 * 为什么需要这个探针（PITFALLS #51）：
 *  · `chrome.tabs.duplicate()` 复制出来的页签，`openerTabId` 指向的是**复制那一刻的前台页签**，
 *    不是被复制的页签（实测见下）。老实现无条件按 `openerTabId` 继承 ⇒ 前台是别的账号就**串号**，
 *    前台没绑定就连候选都没有 ⇒ 页签永久直通 ⇒ 平台读不到 token ⇒ 直接跳登录页。
 *  · 收编判定里那个 `await parallelStore.get()` 会把"登记候选"和"落下绑定"撕开：离线/慢网时
 *    候选已被摘掉、绑定还没落，壳一直 hold，平台 SPA 首屏读到 null 就跳登录页。
 *
 * 三个场景（都必须绑到**源页签**的账号 accA）：
 *   0. 站点开窗（前台就是源页签）—— 老路径的回归护栏
 *   1. 复制页签，前台是**另一个账号**的页签 B —— 修复前会串到 accB / 或完全没绑定
 *   2. 复制页签，前台是**未绑定**页签 —— 修复前完全没绑定
 *
 * 台架要点（踩过的坑都写在注释里）：
 *  · `par.create` 要云端授权，本机通常不可用 ⇒ 直接往 IDB `accounts` + `ql:cacheMeta` 写
 *    “离线只读快照”，再让 `parallelStore` 因为**网络层失败**回落它。注意：
 *    `--host-resolver-rules=MAP www.dragonrain.top ~NOTFOUND` **不生效**（实测仍打真服务器，
 *    假 token 吃 401 ⇒ `setCloudAuth(null)`），必须用死的 HTTP 代理把云端打成连接失败。
 *  · 假平台文档故意做成“慢文档”（先写 120 字节，400ms 后再写完）：壳收到 bind 时
 *    `document.readyState` 仍是 `loading`，于是走 `activate()` 而不是 BOOT_GUARD 的
 *    `location.reload()` —— 那个 reload 会落到"已提交的旧 URL"，把正在进行的导航吃掉。
 *  · 断言用 URL / 绑定表，**不要用 title**：`applyTitle` 会把 title 改成账号名。
 *
 * 用法：node tools/verify/verify-duplicate.mjs
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
function b64url(s) {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(who) {
  return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ sub: who, name: who, AuthCode: 'x1' }))}.sig`;
}

/* ---------- 测试用扩展副本：host_permissions 打开（安装即授权，避免权限弹窗） ---------- */
const TESTDIST = path.join(TMP, 'verify-duplicate-dist');
fs.rmSync(TESTDIST, { recursive: true, force: true });
fs.cpSync(DIST, TESTDIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(TESTDIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://*/*'];
fs.writeFileSync(path.join(TESTDIST, 'manifest.json'), JSON.stringify(mf, null, 2));
const extId = extensionIdFromKey(mf.key);

/* ---------- 假平台 ---------- */
const reqs = [];
const server = http.createServer((req, res) => {
  reqs.push(req.url);
  const u = new URL(req.url, 'http://x');
  const who = u.searchParams.get('who') ?? '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  const body = `<!doctype html><meta charset="utf-8"><title>${u.pathname}</title>
<body><h1>${u.pathname}</h1>
<script>
  const WHO = ${JSON.stringify(who)};
  const JWT = ${JSON.stringify(fakeJwt(who || 'none'))};
  const onLogin = location.pathname === '/login';
  const t0 = localStorage.getItem('__auth_token__');
  if (onLogin && WHO) {
    // 平台登录动作：等壳激活后再写（真实平台也是首屏渲染之后才拿到 JWT）。
    setTimeout(() => { localStorage.setItem('__auth_token__', JWT); }, 900);
  } else {
    // 应用页只读 token、不自己跳转：要观察的是"页签归属"，不是平台的 401 跳转。
    // 读写到的票据塞进 hash —— title 会被 applyTitle 覆盖，hash 不会，也不产生网络请求。
    const state = 'tok=' + (t0 === null ? 'NULL' : (t0 === JWT ? 'OK(' + WHO + ')' : 'OTHER')) + '@' + location.pathname;
    if (!location.hash) location.hash = state.replace(/[^A-Za-z0-9()@=_%.-]/g, '_');
  }
</script></body>`;
  res.write(body.slice(0, 120));
  setTimeout(() => res.end(body.slice(120)), 400);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const HOST = `127.0.0.1:${server.address().port}`;
console.log(`verify-duplicate：假平台 http://${HOST}/  扩展 ${extId}`);

const profile = path.join(TMP, 'verify-duplicate-profile');
fs.rmSync(profile, { recursive: true, force: true });
const browserPath = findPwChromium();
if (!browserPath) {
  console.log('  SKIP 找不到 Playwright chromium（ms-playwright/chromium*/chrome-win64/chrome.exe）');
  server.close();
  process.exit(0);
}
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: browserPath,
  headless: true,
  // ★ 死代理：把云端打成"网络层失败" ⇒ requestJson 抛 OfflineError ⇒ parallelStore 回落离线快照。
  //   bypass 保证本地假平台照常访问（host-resolver-rules 那招实测无效，别再试）。
  proxy: { server: 'http://127.0.0.1:1', bypass: '127.0.0.1,localhost' },
  args: [`--disable-extensions-except=${TESTDIST}`, `--load-extension=${TESTDIST}`, '--no-first-run'],
});

let page;
try {
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
  await page.waitForTimeout(600);

  const now = Date.now();
  const accA = { id: 'accA', siteHost: HOST, scheme: 'http', tabName: '账号A', username: 'ua', color: '#4f8cff', hasPassword: false, createdAt: now, updatedAt: now };
  const accB = { id: 'accB', siteHost: HOST, scheme: 'http', tabName: '账号B', username: 'ub', color: '#ff7a59', hasPassword: false, createdAt: now, updatedAt: now };
  await page.evaluate(async ({ accounts }) => {
    await chrome.storage.local.set({
      'ql:cloudAuth': { baseUrl: 'https://www.dragonrain.top', token: 'verify-fake-token', email: 'verify@local' },
      'ql:cacheMeta': { savedAt: Date.now(), revision: -1, count: accounts.length, email: 'verify@local' },
    });
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('sessionbox-reborn', 2);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('accounts')) d.createObjectStore('accounts', { keyPath: 'id' });
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction('accounts', 'readwrite');
      const s = t.objectStore('accounts');
      s.clear();
      for (const a of accounts) s.put(a);
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });
  }, { accounts: [accA, accB] });

  const diag = async () => (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'ql.diag' })))?.result?.data;
  const tabInfo = (id) => page.evaluate((t) => chrome.tabs.get(t).then((x) => ({ id: x.id, index: x.index, url: x.url, opener: x.openerTabId ?? null })), id);
  const open = (id) => page.evaluate((a) => chrome.runtime.sendMessage({ kind: 'par.open', id: a }), id);
  const nav = (id, url) => page.evaluate(([t, u]) => chrome.tabs.update(t, { url: u }).then((x) => x.id), [id, url]);
  const activate = (id) => page.evaluate((t) => chrome.tabs.update(t, { active: true }).then((x) => x.id), id);
  const bindingOf = async (tabId) => ((await diag())?.parallel?.bindings ?? []).find((b) => b.t === tabId) ?? null;

  /** 等 token 被 captureToken 收进快照（/login 页面 900ms 后才写 token） */
  async function waitToken(id, ms = 12000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (((await diag())?.parallel?.tokens ?? []).some((t) => t.id === id && t.hasToken)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  }

  /** 开一个账号并登录（登录页写 token ⇒ captureToken），再导航到应用页 */
  async function openAndLogin(accId, appPath) {
    const r = await open(accId);
    const tabId = r?.result?.data?.tabId;
    if (!tabId) return { tabId: null, ok: false, why: JSON.stringify(r?.result) };
    await nav(tabId, `http://${HOST}/login?who=${accId.slice(-1).toLowerCase()}`);
    const ok = await waitToken(accId);
    await nav(tabId, `http://${HOST}${appPath}`);
    await page.waitForTimeout(1200);
    return { tabId, ok };
  }

  const a = await openAndLogin('accA', '/app-a?who=a');
  const b = await openAndLogin('accB', '/app-b?who=b');
  check('前置：两个账号都拿到 token（登录链可用）', a.tabId !== null && b.tabId !== null && a.ok && b.ok, JSON.stringify({ a, b }));
  if (a.tabId !== null && b.tabId !== null) {
    check('前置：A/B 各自绑定在自己的页签上', (await bindingOf(a.tabId))?.accountId === 'accA' && (await bindingOf(b.tabId))?.accountId === 'accB');

    /* ---- 场景 0：站点开窗（前台就是源页签）—— 回归护栏 ---- */
    console.log('\n▶ 场景 0：站点开窗（前台 = 源页签 A）');
    await activate(a.tabId);
    await page.waitForTimeout(300);
    const before0 = new Set((await page.evaluate(() => chrome.tabs.query({}))).map((t) => t.id));
    const srcPage = ctx.pages().find((p) => p.url().startsWith(`http://${HOST}/app-a?who=a`));
    if (srcPage) await srcPage.evaluate((h) => window.open(`http://${h}/app-a?who=pop`), HOST);
    await page.waitForTimeout(2500);
    const pop = (await page.evaluate(() => chrome.tabs.query({}))).find((t) => !before0.has(t.id) && (t.url ?? '').includes('who=pop'));
    check('站点开窗的新页签继承源账号 accA', !!pop && (await bindingOf(pop.id))?.accountId === 'accA', JSON.stringify(pop ?? null));

    /* ---- 场景 1：前台是**另一个账号**的页签，复制 A ---- */
    console.log('\n▶ 场景 1：前台 = B(accB)，复制 A(accA)');
    await activate(b.tabId);
    await page.waitForTimeout(300);
    const dup1 = await page.evaluate((t) => chrome.tabs.duplicate(t).then((x) => ({ id: x.id, opener: x.openerTabId ?? null })), a.tabId);
    await page.waitForTimeout(3000);
    const b1 = await bindingOf(dup1.id);
    check(
      '复制页签绑到**源**账号 accA（不是前台账号 accB）',
      b1?.accountId === 'accA',
      `绑定=${b1?.accountId ?? '无'}（opener=${dup1.opener}）`,
    );

    /* ---- 场景 2：前台是**未绑定**页签，复制 A ---- */
    console.log('\n▶ 场景 2：前台 = 未绑定页签，复制 A(accA)');
    const plain = await page.evaluate((h) => chrome.tabs.create({ url: `http://${h}/plain`, active: true }).then((t) => t.id), HOST);
    await page.waitForTimeout(1500);
    const dup2 = await page.evaluate((t) => chrome.tabs.duplicate(t).then((x) => ({ id: x.id, opener: x.openerTabId ?? null })), a.tabId);
    await page.waitForTimeout(3000);
    const b2 = await bindingOf(dup2.id);
    check('前台未绑定时，复制页签仍绑到源账号 accA', b2?.accountId === 'accA', `绑定=${b2?.accountId ?? '无'}（opener=${dup2.opener}）`);
    check('未绑定的前台页签没有被误绑', (await bindingOf(plain)) === null);
    check(
      '复制页签读到的是 accA 的票据（不是 NULL / 别人的）',
      ((await tabInfo(dup2.id))?.url ?? '').includes('tok=OK(a)'),
      (await tabInfo(dup2.id))?.url ?? '',
    );
  }
} finally {
  await ctx.close().catch(() => {});
  server.close();
}

console.log(`\n=== 汇总：${fails.length === 0 ? '全部通过' : `${fails.length} 项失败`} ===`);
if (fails.length > 0) {
  for (const f of fails) console.log(`  ✖ ${f}`);
  process.exit(1);
}
