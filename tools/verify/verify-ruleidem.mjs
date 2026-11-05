/**
 * v4.2.39 回归：**SW 冷启动不能把 DNR 规则越叠越多**（旧规则必须被摘掉再重建）。
 *
 * 背景（round 10 自查发现）：`tabRules.restore()` 只清理「孤儿」规则（`tabIds` 全不在
 * 期望集），对**期望集里的 tab** 一条都不动；而 `installed` 是模块级 Map，SW 一被回收
 * 就空了 ⇒ `applyBinding` 认为"这个 tab 什么都没装"，于是**再装一套**。session 规则
 * 活到浏览器关闭（不随 SW 回收），于是：
 *   · 每个 SW 冷启 × 每个绑定页签，多 4 条规则（strip/nav/sub/auth）；
 *   · 旧规则不在 `installed` 里 ⇒ `clearTab` 永远摘不掉它们 ——
 *     **解绑后，旧 token / 旧 Cookie 会继续被改写进该页签的请求**，直到关闭浏览器；
 *   · 规则数逼近 5000 上限后 `updateSessionRules` 整批被拒（`addOne` 失败），网络平面全灭。
 *
 * 本脚本不依赖云端：直接往 `chrome.storage.session` 写 `ql:parTabBindings` /
 * `ql:parTokens`（`readState()` 的输入），再用 CDP 关掉 SW，让下一条消息把它拉起并跑
 * `restore()`。重复两轮，断言规则数**不增长**。
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

const TESTDIST = path.join(TMP, 'verify-ruleidem-dist');
fs.rmSync(TESTDIST, { recursive: true, force: true });
fs.cpSync(DIST, TESTDIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(TESTDIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://*/*'];
fs.writeFileSync(path.join(TESTDIST, 'manifest.json'), JSON.stringify(mf, null, 2));
const extId = extensionIdFromKey(mf.key);

const PAGE = '<!doctype html><meta charset="utf-8"><title>rule-idem</title><p>account site</p>';
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const HOST = `127.0.0.1:${PORT}`;

const TOKEN = 'RULE-IDEM-TOKEN';
const COOKIE = 'sid=RULEIDEM';
const EXPECTED = 4; // strip + nav + sub + auth

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`);
};

const profile = path.join(TMP, 'verify-ruleidem-profile');
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
    '--no-proxy-server',
  ],
});

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

async function killSW() {
  const cdp = await ctx.browser().newBrowserCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  for (const t of targetInfos) {
    if (t.type !== 'service_worker' || !/background\.js/.test(t.url)) continue;
    await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  }
  await cdp.detach().catch(() => undefined);
  await sleep(700);
}

async function readRules(ext, tabId) {
  return ext.evaluate(async (id) => {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const mine = rules.filter((r) => (r.condition.tabIds ?? []).includes(id));
    const auth = mine.find((r) => (r.action.requestHeaders ?? []).some((h) => h.header === 'Authorization'));
    const cookieSet = mine
      .filter((r) => (r.action.requestHeaders ?? []).some((h) => h.header === 'Cookie' && h.operation === 'set'))
      .map((r) => (r.action.requestHeaders ?? []).find((h) => h.header === 'Cookie').value);
    return {
      count: mine.length,
      ids: mine.map((r) => r.id),
      auth: auth ? (auth.action.requestHeaders ?? []).find((h) => h.header === 'Authorization').value : null,
      cookieSet,
    };
  }, tabId);
}

try {
  const ext = await ctx.newPage();
  for (let i = 0; i < 4; i++) {
    try {
      await ext.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`, { timeout: 8000 });
      break;
    } catch (e) {
      if (i === 3) throw e;
      await sleep(800);
    }
  }
  await sleep(600);

  const tab = await ext.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: true }));
  await ext.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [tab.id, `http://${HOST}/page`]);
  await sleep(1200);

  // readState() 的输入：绑定表 + token/Cookie 快照
  await ext.evaluate(
    async ([id, host, token, cookie]) => {
      await chrome.storage.session.set({
        'ql:parTabBindings': { [String(id)]: { accountId: 'acc-ruleidem', host } },
        'ql:parTokens': {
          'acc-ruleidem': {
            token,
            cookies: [{ name: 'sid', value: cookie.split('=')[1] }],
          },
        },
      });
    },
    [tab.id, HOST, TOKEN, COOKIE],
  );

  // ── 第一轮：SW 冷启 → restore()
  await killSW();
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'ql.diag' }).catch(() => null));
  await sleep(1800);
  const first = await readRules(ext, tab.id);
  check('A 首轮冷启装出 4 条规则（strip/nav/sub/auth）', first.count === EXPECTED, `count=${first.count} ids=${first.ids.join(',')}`);
  check('B AUTH 规则的值是当前 token', first.auth === `Bearer ${TOKEN}`, `auth=${first.auth}`);
  check(
    'C 回放 Cookie 是当前快照',
    first.cookieSet.length === 2 && first.cookieSet.every((v) => v === COOKIE),
    `set=${JSON.stringify(first.cookieSet)}`,
  );

  // ── 第二轮：再冷启一次
  await killSW();
  await ext.evaluate(() => chrome.runtime.sendMessage({ type: 'ql.diag' }).catch(() => null));
  await sleep(1800);
  const second = await readRules(ext, tab.id);
  check(
    'D 第二次冷启后规则数不增长（旧规则被摘掉再重建）',
    second.count === EXPECTED,
    `count=${second.count} ids=${second.ids.join(',')}`,
  );
  check('E 第二轮 AUTH 仍是当前 token', second.auth === `Bearer ${TOKEN}`, `auth=${second.auth}`);

  console.log(`\n${results.every(Boolean) ? 'RESULT: OK' : 'RESULT: FAIL'}（${results.filter(Boolean).length}/${results.length}）`);
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
}

process.exit(results.every(Boolean) ? 0 : 1);
