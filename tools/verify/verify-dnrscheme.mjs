/** v4.2.35 验证：DNR 的 `regexFilter` 能按 scheme 拦住请求，且与 `requestDomains`/`tabIds` 共存。
 *
 *  背景：https 账号的 Authorization 规则要加 `regexFilter: '^https://'`，让账号被
 *  导到同 host 的 http 时**不再带 Bearer**（v4.2.35 修复）。这条判据不依赖云端账号库：
 *  直接在扩展页里装一条与会话规则同形的 `modifyHeaders` 规则，观察本地服务端收到的头。
 *
 *  A https 请求被正则命中（头出现）——证明 regexFilter + requestDomains + tabIds 可共存；
 *  B 同一页签导航到 http ——头消失（正则挡住）；
 *  C 去掉 regexFilter 后 http 请求**又**带上头——证明 B 的"消失"是正则造成的，
 *    不是 main_frame 不匹配或 tabId 不对。
 *  D https 请求命中 Cookie 回放规则（`Cookie: SID=…` 被 set）——v4.2.38 的回落；
 *  E 同一规则在 http 上不命中 ⇒ 会话 Cookie 不会落进明文请求；
 *  F 规则把父域写进 `initiatorDomains` 时，子域页面发起的请求**仍命中** ——
 *    证明「只写账号 host」不会在账号页面被重定向到子域时把 Bearer 关掉。
 *
 *  服务端：http 与 https 都绑 127.0.0.2；`qllocal.test` 经 host-resolver-rules 解析到它，
 *  443 用自签证书（--ignore-certificate-errors）。 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { createHash } from 'node:crypto';
import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const mfPath = path.join(DIST, 'manifest.json');
const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
mf.host_permissions = ['*://qllocal.test/*', '*://sub.qllocal.test/*', '*://127.0.0.1/*'];
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

/* ---- 自签证书（CN=qllocal.test，与 verify-httpscheme 同方案） ---- */
x509.cryptoProvider.set(globalThis.crypto);
const certAlg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) };
const certKeys = await globalThis.crypto.subtle.generateKey(certAlg, true, ['sign', 'verify']);
const certObj = await x509.X509CertificateGenerator.createSelfSigned({
  serial: '01', name: 'CN=qllocal.test',
  notBefore: new Date(Date.now() - 864e5), notAfter: new Date(Date.now() + 365 * 864e5),
  keys: certKeys, alg: certAlg,
  extensions: [new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'qllocal.test' }])],
});
const keyB64 = Buffer.from(await globalThis.crypto.subtle.exportKey('pkcs8', certKeys.privateKey)).toString('base64').replace(/(.{64})/g, '$1\n');
const KEY_PEM = `-----BEGIN PRIVATE KEY-----\n${keyB64}\n-----END PRIVATE KEY-----\n`;
const CERT_PEM = certObj.toString('pem');

/* ---- 记录服务端实际收到的头 ---- */
const hits = [];
const handler = (scheme) => (req, res) => {
  const u = new URL(req.url ?? '/', 'http://x');
  hits.push({ scheme, path: u.pathname, token: req.headers['x-test-token'] ?? null, cookie: req.headers.cookie ?? null });
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (u.pathname === '/subpage') {
    res.end(`<!doctype html><script>
      fetch('http://qllocal.test/api').catch(() => {});
    </script>sub</html>`);
    return;
  }
  res.end(`<!doctype html><html><body>${scheme}${u.pathname}</body></html>`);
};
const httpServer = http.createServer(handler('http'));
await new Promise((resolve, reject) => {
  httpServer.once('error', reject);
  httpServer.listen(80, '127.0.0.2', resolve);
});
const httpsServer = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, handler('https'));
await new Promise((resolve, reject) => {
  httpsServer.once('error', reject);
  httpsServer.listen(443, '127.0.0.2', resolve);
});
console.log('[S] 本地服务就绪：http://qllocal.test（80）+ https://qllocal.test（443）');

/* ---- Chromium + 扩展 ---- */
function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const s of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, s, 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const extId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)]
  .map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`);
};
const waitHit = async (pred, timeout = 8000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const h = hits.find(pred);
    if (h) return h;
    await sleep(120);
  }
  return null;
};
const profile = path.join(ROOT, 'tmp', 'ui-dnrscheme');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--ignore-certificate-errors',
    '--host-resolver-rules=MAP qllocal.test 127.0.0.2, MAP sub.qllocal.test 127.0.0.2',
    // 本机若配了系统代理，请求会绕开 host-resolver-rules 指向的本地服务
    '--no-proxy-server',
  ],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

const tabId = await page.evaluate(async () => {
  const t = await chrome.tabs.create({ url: 'https://qllocal.test/probe', active: true });
  return t.id;
});
const base = await waitHit((h) => h.scheme === 'https' && h.path === '/probe');
check('A0 未装规则时 https 请求无测试头（基线）', base !== null && base.token === null,
  `token=${base?.token ?? '无'}`);

const added = await page.evaluate(async (id) => {
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: 9001,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'X-Test-Token', operation: 'set', value: 'HTTPS-ONLY' }],
      },
      condition: {
        tabIds: [id],
        requestDomains: ['qllocal.test'],
        regexFilter: '^https://',
        resourceTypes: ['main_frame', 'xmlhttprequest'],
      },
    }],
  });
  return (await chrome.declarativeNetRequest.getSessionRules()).length;
}, tabId);
check('A1 带 regexFilter 的会话规则装上（与 requestDomains/tabIds 共存）', added === 1, `rules=${added}`);

await page.evaluate((id) => chrome.tabs.reload(id), tabId);
const httpsHit = await waitHit((h) => h.scheme === 'https' && h.token === 'HTTPS-ONLY');
check('A2 https 请求命中正则，头被加上', httpsHit !== null);

const beforeHttp = hits.length;
await page.evaluate((id) => chrome.tabs.update(id, { url: 'http://qllocal.test/probe' }), tabId);
const httpHit = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const h = hits.slice(beforeHttp).find((x) => x.scheme === 'http' && x.path === '/probe');
    if (h) return h;
    await sleep(120);
  }
  return null;
})();
check('B http 请求不命中 `^https://`，测试头缺席', httpHit !== null && httpHit.token === null,
  `token=${httpHit?.token ?? '无'}`);

await page.evaluate(async (id) => {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [9001],
    addRules: [{
      id: 9002,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'X-Test-Token', operation: 'set', value: 'BOTH-SCHEMES' }],
      },
      condition: {
        tabIds: [id],
        requestDomains: ['qllocal.test'],
        resourceTypes: ['main_frame', 'xmlhttprequest'],
      },
    }],
  });
}, tabId);

const beforeControl = hits.length;
await page.evaluate((id) => chrome.tabs.reload(id), tabId);
const controlHit = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const h = hits.slice(beforeControl).find((x) => x.scheme === 'http' && x.token === 'BOTH-SCHEMES');
    if (h) return h;
    await sleep(120);
  }
  return null;
})();
check('C 去掉 regexFilter 后 http 又带上头（B 的缺席确实来自正则）', controlHit !== null,
  `token=${controlHit?.token ?? '无'}`);

/* ---- D/E：同一机制用在 Cookie 上（v4.2.38 的回放限定）----
 * 产品里 https 账号的 nav/sub 两条 set 规则带 `regexFilter: '^https://'`，
 * 这里用同形的会话规则验证"正则确实只让 Cookie 落在 https 上"。 */
await page.evaluate(async (id) => {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [9002],
    addRules: [{
      id: 9003,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Cookie', operation: 'set', value: 'SID=HTTPS-ONLY' }],
      },
      condition: {
        tabIds: [id],
        requestDomains: ['qllocal.test'],
        regexFilter: '^https://',
        resourceTypes: ['main_frame', 'xmlhttprequest'],
      },
    }],
  });
}, tabId);

const beforeCookieHttps = hits.length;
await page.evaluate((id) => chrome.tabs.update(id, { url: 'https://qllocal.test/cookie' }), tabId);
const cookieHttps = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const h = hits.slice(beforeCookieHttps).find((x) => x.scheme === 'https' && x.path === '/cookie');
    if (h) return h;
    await sleep(120);
  }
  return null;
})();
check('D https 请求命中 Cookie 回放规则（会话 Cookie 被 set）',
  (cookieHttps?.cookie ?? '').includes('SID=HTTPS-ONLY'), `cookie=${cookieHttps?.cookie ?? '无'}`);

const beforeCookieHttp = hits.length;
await page.evaluate((id) => chrome.tabs.update(id, { url: 'http://qllocal.test/cookie' }), tabId);
const cookieHttp = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const h = hits.slice(beforeCookieHttp).find((x) => x.scheme === 'http' && x.path === '/cookie');
    if (h) return h;
    await sleep(120);
  }
  return null;
})();
check('E http 请求不命中 `^https://`，回放 Cookie 不落明文',
  cookieHttp !== null && !(cookieHttp.cookie ?? '').includes('SID=HTTPS-ONLY'),
  `cookie=${cookieHttp?.cookie ?? '无'}`);

/* ---- F：父域条目对子域 initiator 仍然生效（产品里 initiatorDomains 只写账号 host）----
 * 账号站点常被重定向到 www/sub 子域；若 Chrome 不把父域条目匹配到子域 initiator，
 * v4.2.32 的收窄就会在子域页面上把 Bearer 关掉。 */
const subTabId = await page.evaluate(async () => {
  const t = await chrome.tabs.create({ url: 'http://sub.qllocal.test/subpage', active: true });
  return t.id;
});
await page.evaluate(async (id) => {
  await chrome.declarativeNetRequest.updateSessionRules({
    addRules: [{
      id: 9004,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'X-Test-Token', operation: 'set', value: 'SUB-INIT' }],
      },
      condition: {
        tabIds: [id],
        requestDomains: ['qllocal.test'],
        initiatorDomains: ['qllocal.test'],
        resourceTypes: ['xmlhttprequest'],
      },
    }],
  });
}, subTabId);

const beforeSub = hits.length;
await page.evaluate((id) => chrome.tabs.reload(id), subTabId);
const subHit = await (async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const h = hits.slice(beforeSub).find((x) => x.path === '/api' && x.token === 'SUB-INIT');
    if (h) return h;
    await sleep(120);
  }
  return null;
})();
check('F initiatorDomains 写父域时，子域页面发起的请求仍命中（子域重定向不掉 Bearer）',
  subHit !== null, `token=${subHit?.token ?? '无'}`);

await ctx.close();
httpServer.close();
httpsServer.close();
console.log(`\n=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
process.exit(results.every(Boolean) ? 0 : 1);
