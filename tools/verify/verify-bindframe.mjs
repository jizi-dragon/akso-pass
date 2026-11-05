/**
 * v4.2.32 回归：**跨域 iframe 收不到 bind 载荷**（凭据不外溢到第三方 origin）。
 *
 * 背景（审计 V1）：`pushDown` 曾经不带 frameId，`chrome.tabs.sendMessage` 会把
 * `{op:'bind', seed:{__auth_token__}, bag}` 广播到页签内**所有 frame**；跨域 iframe
 * 的 MAIN 壳 `applySeed` 会把 Bearer 与整袋 Cookie 写进**第三方 origin** 的
 * localStorage / `document.cookie`，页面自己的 JS 直接读走。
 *
 * 修复有两层：
 *   1. 后台只投 `{frameId: 0}`（本脚本不依赖后台，故直接模拟"万一又广播了"）；
 *   2. `handleBind` 用 `locationMatchesHost(siteHost)` 自校验，跨域 iframe 必须拒收。
 * 本脚本验证**第 2 层**：即便 bind 被广播到 iframe，第三方 origin 也拿不到任何凭据。
 *
 * 构造：同一台本地 HTTP 服务，用 `localhost`（顶层，= 账号站点）与 `127.0.0.1`
 * （iframe，= 第三方 origin）两个**不同源**访问。扩展 host_permissions 在临时副本里
 * 放宽到全部 http/https host，避免安装期权限弹窗（与 verify-ui-select 同法）。
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

/* ---------- 测试副本：host_permissions 全开 ---------- */
const TESTDIST = path.join(TMP, 'verify-bindframe-dist');
fs.rmSync(TESTDIST, { recursive: true, force: true });
fs.cpSync(DIST, TESTDIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(TESTDIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://*/*'];
fs.writeFileSync(path.join(TESTDIST, 'manifest.json'), JSON.stringify(mf, null, 2));
const extId = extensionIdFromKey(mf.key);

/* ---------- 本地站点：顶层 localhost / iframe 127.0.0.1 ---------- */
const TOP_TOKEN = 'tok-bindframe-TOP';
const hits = { top: 0, frame: 0 };
const server = http.createServer((req, res) => {
  if (req.url === '/frame') {
    hits.frame++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>frame</title>
<script>
window.__downs = 0;
window.addEventListener('message', (e) => {
  if (e.source === window && e.data && e.data.src === 'QL_BRIDGE_TO_PAGE') window.__downs++;
});
</script>
<p>third-party frame</p>`);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  hits.top++;
  res.end(`<!doctype html><meta charset="utf-8"><title>top</title>
<iframe id="f" src="http://127.0.0.1:${server.address().port}/frame" width="320" height="120"></iframe>
<p>account site</p>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const TOP_URL = `http://localhost:${PORT}/`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`);
};

const profile = path.join(TMP, 'verify-bindframe-profile');
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
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
  await ext.waitForTimeout(400);

  const site = await ctx.newPage();
  await site.goto(TOP_URL, { waitUntil: 'load' });
  await site.waitForTimeout(700); // document_start 的两个壳都装好

  const tabId = await ext.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => (t.url ?? '').startsWith(url))?.id ?? null;
  }, `http://localhost:${PORT}/`);
  check('前置：找到账号站点所在页签', typeof tabId === 'number', `tabId=${tabId}`);

  /* 模拟"最坏情况"：bind 被广播给所有 frame（而不是只发 frameId 0）。
     旧代码下跨域 iframe 会 applySeed；修复后必须因 host 不符拒收。
     发两次：第一次可能落在"直通已定"的迟到 bind 路径（先刷新重来），
     刷新后第二次一定会被激活并灌种子 —— 这样顶层有正向对照。 */
  const sendBind = () => ext.evaluate(async ({ id, token }) => {
    await chrome.tabs.sendMessage(id, {
      type: 'ql:bridgeDown',
      payload: {
        op: 'bind',
        accountId: 'acc-bindframe',
        tabId: id,
        host: 'localhost',
        seed: { __auth_token__: token, __auth_user__: '{"username":"bindframe"}' },
        bag: { sid: 'SID-BINDFRAME', theme: 'dark' },
      },
    });
  }, { id: tabId, token: TOP_TOKEN });
  await sendBind();
  await site.waitForTimeout(900);
  await sendBind();
  await site.waitForTimeout(700);

  // 注意：激活后 `Storage.prototype.getItem` 已带命名空间补丁，这里读**逻辑键**。
  const top = await site.evaluate(() => ({
    token: localStorage.getItem('__auth_token__'),
    cookie: document.cookie,
  }));
  check('顶层（= 站点 host）拿到种子 token', top.token === TOP_TOKEN);
  check('顶层拿到 Cookie 袋（sid）', /(?:^|;\s*)sid=SID-BINDFRAME(?:;|$)/.test(top.cookie), top.cookie);

  const frame = site.frames().find((f) => f.url().includes('127.0.0.1'));
  check('前置：跨域 iframe 已加载', Boolean(frame), frame?.url() ?? '');
  const third = await frame.evaluate(() => ({
    keys: Object.keys(localStorage).filter((k) => k.startsWith('__ql_ns_')),
    cookie: document.cookie,
    downs: window.__downs,
  }));
  check('跨域 iframe 确实收到了下行 bind（不是没投递）', third.downs >= 1, `downs=${third.downs}`);
  check('跨域 iframe 的 localStorage 没有任何账号命名空间键', third.keys.length === 0, JSON.stringify(third.keys));
  check('跨域 iframe 的 document.cookie 为空（袋未落进第三方 origin）', third.cookie === '', third.cookie);
  check('跨域 iframe 未被 bind 触发刷新（host 校验在迟到路径之前就拒了）', hits.frame === 1, `hits=${hits.frame}`);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(TESTDIST, { recursive: true, force: true });
}

console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
process.exit(results.every(Boolean) ? 0 : 1);
