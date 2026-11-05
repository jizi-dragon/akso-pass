/**
 * v4.2.36 回归：**回放 Cookie 只给本账号站点自己发起的请求**。
 *
 * 背景（审计 V5 的 Cookie 分支）：旧的单条 COOKIE 规则是「全类型 + set + 无
 * initiatorDomains」，于是绑定页签里的跨域第三方 iframe 向账号站点发的请求也会被
 * 塞进账号 Cookie —— 它读不到响应，但能触发以账号本人身份执行的写请求（CSRF）。
 *
 * 修复是三层优先级（Chrome 对同一请求取优先级最高的 modifyHeaders 规则）：
 *   - priority 1：全类型 remove（无 initiator）—— 真实 jar 隐身，也是跨域 iframe 的兜底；
 *   - priority 2：main_frame/other 的 set（无 initiator）—— 地址栏/reload/SSO 不掉登录；
 *   - priority 2：其余子资源 set + initiatorDomains=本账号站点。
 *
 * 本脚本按产品规则的**同一形状**装会话规则，断言：
 *   A 基线（无规则）：真实 jar 的 real=1 会随请求出去（这就是要堵的泄漏面）；
 *   B 装三层后：顶层子资源拿到回放值 SID=ACC，且 real=1 被剥掉；
 *   C 跨域 iframe 向账号站点发的请求**没有 Cookie**（既不回放也不漏真实 jar）；
 *   D main_frame 导航仍拿到回放值（initiatorDomains 没误伤导航）；
 *   E 反证：把子资源规则的 initiatorDomains 去掉，同一个 iframe 请求立刻拿到 SID=ACC。
 *
 * 同源构造：本地 HTTP 服务，顶层用 `localhost`（= 账号站点），iframe 用
 * `127.0.0.1`（= 第三方 origin）。扩展 host_permissions 在临时副本里放宽到
 * `*://localhost/*` + `*://127.0.0.1/*`（modifyHeaders 需要宿主权限）。
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, 'tmp');

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  let dirs;
  try {
    dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  } catch {
    return null;
  }
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

/* ---------- 测试副本：只给本地两个 host 授权（够 DNR modifyHeaders 用） ---------- */
const TESTDIST = path.join(TMP, 'verify-cookiereplay-dist');
fs.rmSync(TESTDIST, { recursive: true, force: true });
fs.cpSync(DIST, TESTDIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(TESTDIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://localhost/*', '*://127.0.0.1/*'];
fs.writeFileSync(path.join(TESTDIST, 'manifest.json'), JSON.stringify(mf, null, 2));
const extId = extensionIdFromKey(mf.key);

/* ---------- 本地站点 ---------- */
const SID = 'SID=ACC';
const ALL_TYPES = [
  'main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'script',
  'stylesheet', 'image', 'font', 'media', 'other',
];
const SUB_TYPES = ALL_TYPES.filter((t) => t !== 'main_frame' && t !== 'other');
const hits = [];

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const probe = u.searchParams.get('probe') ?? '';
  const phase = u.searchParams.get('phase') ?? '';
  if (u.pathname === '/api' || u.pathname === '/nav') {
    hits.push({ probe, phase, cookie: req.headers.cookie ?? '', path: u.pathname });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    res.end('{"ok":true}');
    return;
  }
  if (u.pathname === '/frame') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`<!doctype html><meta charset="utf-8"><title>frame</title>
<script>
fetch('http://localhost:${server.address().port}/api?probe=frame&phase=${phase}', { credentials: 'include' })
  .catch(() => {});
</script>
<p>third-party frame</p>`);
    return;
  }
  // /top
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    // SameSite=None 才能让 127.0.0.1 的 iframe 把这份"真实 jar"带过站；
    // localhost 被视为 secure context，http 上也允许 Secure cookie。
    'set-cookie': 'real=1; Path=/; SameSite=None; Secure',
  });
  res.end(`<!doctype html><meta charset="utf-8"><title>top</title>
<script>
fetch('/api?probe=top&phase=${phase}', { credentials: 'include' }).catch(() => {});
</script>
<iframe src="http://127.0.0.1:${server.address().port}/frame?phase=${phase}" width="320" height="100"></iframe>
<p>account site</p>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TOP_URL = `http://localhost:${PORT}/top?phase=`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`);
};

const profile = path.join(TMP, 'verify-cookiereplay-profile');
fs.rmSync(profile, { recursive: true, force: true });
const exe = findPwChromium();
if (!exe) {
  console.error('找不到 Playwright Chromium');
  process.exit(2);
}
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: exe,
  headless: true,
  args: [
    `--disable-extensions-except=${TESTDIST}`,
    `--load-extension=${TESTDIST}`,
    '--no-first-run',
    // ★ 本机系统代理会绕过 localhost 直连判定，DNR 测试会全 miss（verify-dnrscheme 的教训）。
    '--no-proxy-server',
  ],
});

const setRules = (ext, rules) => ext.evaluate(async (rs) => {
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  const ours = existing.filter((r) => r.id >= 9300 && r.id < 9400).map((r) => r.id);
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: ours,
    addRules: rs,
  });
}, rules);

const ruleFor = (id, kind, tabId) => ({
  id,
  priority: kind === 'strip' ? 1 : 2,
  action: {
    type: 'modifyHeaders',
    requestHeaders: [
      kind === 'strip'
        ? { header: 'Cookie', operation: 'remove' }
        : { header: 'Cookie', operation: 'set', value: SID },
    ],
  },
  condition: {
    resourceTypes: kind === 'strip' ? ALL_TYPES : kind === 'nav' ? ['main_frame', 'other'] : SUB_TYPES,
    requestDomains: ['localhost'],
    ...(kind === 'sub' ? { initiatorDomains: ['localhost'] } : {}),
    tabIds: [tabId],
  },
});

try {
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
  await ext.waitForTimeout(400);

  const site = await ctx.newPage();
  await site.goto(TOP_URL + 'baseline', { waitUntil: 'load' });
  await site.waitForTimeout(900);

  const tabId = await ext.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url ?? '').startsWith(url))?.id ?? null;
  }, `http://localhost:${PORT}/`);
  check('前置：找到账号站点所在页签', typeof tabId === 'number', `tabId=${tabId}`);

  const cookiesOf = (probe, phase) => hits.filter((h) => h.probe === probe && h.phase === phase).map((h) => h.cookie);

  // A. 基线：真实 jar 的 real=1 出得去（顶层与第三方 iframe 都是）
  const baseTop = cookiesOf('top', 'baseline');
  const baseFrame = cookiesOf('frame', 'baseline');
  check('A0 基线：顶层子资源带真实 jar 的 real=1', baseTop.some((c) => /(?:^|;\s*)real=1(?:;|$)/.test(c)), JSON.stringify(baseTop));
  check('A1 基线：跨域 iframe 的请求也带 real=1（这就是回放前的泄漏面）', baseFrame.some((c) => /(?:^|;\s*)real=1(?:;|$)/.test(c)), JSON.stringify(baseFrame));

  // B/C/D. 装三层规则
  await setRules(ext, [ruleFor(9301, 'strip', tabId), ruleFor(9302, 'nav', tabId), ruleFor(9303, 'sub', tabId)]);
  await site.goto(TOP_URL + 'rules', { waitUntil: 'load' });
  await site.waitForTimeout(900);

  const rulesTop = cookiesOf('top', 'rules');
  const rulesFrame = cookiesOf('frame', 'rules');
  check('B 顶层子资源拿到回放值 SID=ACC 且真实 jar 被剥掉',
    rulesTop.some((c) => /(?:^|;\s*)SID=ACC(?:;|$)/.test(c) && !/real=1/.test(c)),
    JSON.stringify(rulesTop));
  check('C 跨域 iframe 向账号站点发的请求没有任何 Cookie',
    rulesFrame.length > 0 && rulesFrame.every((c) => c === ''), JSON.stringify(rulesFrame));

  await site.goto(`http://localhost:${PORT}/nav?probe=nav&phase=rules`, { waitUntil: 'load' });
  await site.waitForTimeout(500);
  const nav = cookiesOf('nav', 'rules');
  check('D main_frame 导航仍拿到回放值（initiatorDomains 没误伤无发起方的导航）',
    nav.some((c) => /(?:^|;\s*)SID=ACC(?:;|$)/.test(c)), JSON.stringify(nav));

  // E. 反证：去掉子资源规则的 initiatorDomains，同一个 iframe 立刻能借到 Cookie
  await setRules(ext, [ruleFor(9301, 'strip', tabId), ruleFor(9302, 'nav', tabId), ruleFor(9304, 'sub-noreinit', tabId)]);
  await site.goto(TOP_URL + 'control', { waitUntil: 'load' });
  await site.waitForTimeout(900);
  const ctrlFrame = cookiesOf('frame', 'control');
  check('E 反证：子资源规则去掉 initiatorDomains 后，跨域 iframe 立刻拿到 SID=ACC（说明 C 不是没匹配上）',
    ctrlFrame.some((c) => /(?:^|;\s*)SID=ACC(?:;|$)/.test(c)), JSON.stringify(ctrlFrame));
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(TESTDIST, { recursive: true, force: true });
}

console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
process.exit(results.every(Boolean) ? 0 : 1);
