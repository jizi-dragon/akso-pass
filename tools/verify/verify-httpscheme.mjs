/** v3.10.9 验证：scheme 自动化（用户零维护）。
 *  A1 探测：纯 http 站点（443 不开）→ probeScheme 返回 'http'
 *  A2 hint 直选：带 scheme 创建 → 打开一次成功（http 直达）→ 自动登录 hasToken=true
 *  B  自学习：默认 https 创建（模拟误判）→ 打开落 chrome-error → onErrorOccurred 翻转 http 重开 → 登录成功且 scheme 写回
 *  C  https 回归：qllocal.test(443 自签) → scheme=https 正常登录，保证不误伤 */
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
mf.host_permissions = ['*://example.com/*', '*://127.0.0.1/*', '*://qllocal.test/*'];
fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

/* ---- 证书（qllocal.test，与 dynsnap 同方案） ---- */
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

/* ---- 模拟平台（登录页：顶层用户名 + srcdoc iframe 密码 + 协议勾选；api/login 下发 __auth_token__ Cookie） ---- */
const loginPage = `
<!doctype html><html><body>
<form onsubmit="return false">
  <input placeholder="请输入用户名" type="text" />
  <iframe id="pwbox" srcdoc='<input type="password" placeholder="密码" />'></iframe>
  <label><input type="checkbox" /> 同意协议</label>
  <button type="button">登 录</button>
</form>
<script>
document.querySelector('button').addEventListener('click', () => {
  const u = document.querySelector('input[type=text]').value;
  const f = document.getElementById('pwbox').contentDocument.querySelector('input[type=password]');
  fetch('/api/login', { method: 'POST', body: JSON.stringify({ u, p: f ? f.value : '' }) }).then((r) => r.json()).then((j) => {
    if (j.ok) { localStorage.setItem('__auth_token__', j.token); localStorage.setItem('__auth_user__', JSON.stringify({ name: u })); location.href = '/web'; }
    else { document.title = '登录失败'; }
  });
});
</script>
login page</body></html>`;
const makeHandler = () => (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(loginPage);
    return;
  }
  if (url.pathname === '/web') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body>WEB-WORKBENCH</body></html>');
    return;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let u = '', p = '';
      try { ({ u, p } = JSON.parse(body || '{}')); } catch { /* */ }
      if (u === 'T01' && p === '88888888') {
        // JWT 形态 token（captureToken 只认三段式）
        const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
        const token = `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ uid: 1, name: u })}.sA`;
        res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': `__auth_token__=${token}; Path=/` });
        res.end(JSON.stringify({ ok: true, token }));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }
  res.writeHead(404); res.end('nf');
};
const httpServer = http.createServer(makeHandler());
await new Promise((resolve, reject) => { httpServer.once('error', reject); httpServer.listen(80, '127.0.0.1', resolve); });
// httpsServer 绑 127.0.0.2:443（qllocal.test 经 host-resolver-rules 解析到 .2）——
// 127.0.0.1 的 443 保持无监听，构造「纯 http 内网站点（443 无服务）」的真实形态
const httpsServer = https.createServer({ key: KEY_PEM, cert: CERT_PEM }, makeHandler());
await new Promise((resolve, reject) => { httpsServer.once('error', reject); httpsServer.listen(443, '127.0.0.2', resolve); });
console.log('[S] 模拟平台就绪：http://127.0.0.1（80）+ https://qllocal.test（443，经 host-resolver-rules）');

/* ---- 扩展环境 ---- */
function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) { for (const s of ['chrome-win64', 'chrome-win']) { const p = path.join(mp, d, s, 'chrome.exe'); if (fs.existsSync(p)) return p; } }
  return null;
}
const manifest = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
const extId = [...createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, extra = '') => { results.push(ok); console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`); };

/* ============================================================ 等待：**轮询条件**，不是"睡固定秒数"
 *
 * ★★ 2026-10-16 优化（本轮实测出来的最大一笔）：本脚本原先有三处
 *    `await sleep(16000)` / `sleep(20000)` / `sleep(16000)` —— **合计 52 秒**，
 *    而整个脚本原本要 67 秒（占 akso-pass 全套 151 秒的 **44%**）。
 *
 * ## 为什么"睡固定秒数"是**双重**的坏
 *
 *  ① **慢**：条件通常 2–4 秒就满足了，而它一定等满 16/20 秒。
 *  ② ★★ **不可靠**：它是一个**猜出来的上限**。机器快时白等，
 *     机器慢（或 CI 上负载高）时**等不够** ⇒ 判据变成"看运气"，
 *     而失败信息是 `URL=''` —— 读起来像"功能坏了"，实际是"没等够"。
 *
 * ⇒ 改成**轮询到条件成立**：好路径下立刻返回（快一个数量级），
 *   坏路径下等满上限再报错（信息不变）。**这是一次纯粹的改进，没有取舍。**
 *
 * ★ 为什么用 `chrome.runtime.sendMessage` 的 `par.list` 而不是 `DOM` 查询：
 *   这里要等的是"**后台**记账完成"（`hasToken` / `scheme`），
 *   而它不是页面上某个元素的状态 —— 查 DOM 会得到"看起来好了、其实还没落库"的假通过。
 */
async function pollUntil(fn, { timeout = 20000, step = 250, label = '条件' } = {}) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); } catch (e) { last = { __err: String(e) }; }
    if (last) return last;
    if (Date.now() - t0 >= timeout) return null;
    await sleep(step);
  }
}

/** 等"某个 host 的账号记录满足 cond"。返回记录或 null（超时）。 */
const waitAccount = (page, host, cond = (r) => r?.hasToken === true, timeout = 20000) =>
  pollUntil(async () => {
    const list = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.list' }));
    const rec = (list?.result?.data ?? []).find?.((a) => a.siteHost === host);
    return cond(rec) ? rec : null;
  }, { timeout });

/** 等"站点页签的 URL 变成 want 前缀"。返回 url 或 null（超时）。 */
const waitUrl = (ctx, prefix, timeout = 20000) =>
  pollUntil(async () => {
    const u = siteTabOf(ctx)?.url() ?? '';
    return u.startsWith(prefix) ? u : null;
  }, { timeout });

/* ★★ 环境前置：**云端未登录**时 `par.open` 必然失败，而它**与我们验的 scheme 逻辑无关**。
 *
 * ## 为什么必须显式处理（而不是"让它自己超时"）
 *
 * 本脚本要真起 Chromium + 扩展，而 `par.open` 需要云端的账号库快照。
 * 在没有云端登录的机器上（CI、别人的机器），原来的写法是：
 *   每条断言都**等满 16–20 秒**再报 `URL=''` ⇒ 一个脚本白跑 **67 秒**，
 *   而失败信息**指向不了根因**（读起来像"scheme 逻辑坏了"）。
 *
 * ⇒ 认出这个前置条件之后**立刻停止**，并把"缺什么"写在结论里。
 *   ★ 这不是"把红变绿"：脚本仍然 **exit 1**（它确实没验成），
 *     只是把"为什么没验成"说清楚，并且不再白等 50 多秒。
 */
const NEEDS_CLOUD = '云端未授权';
function skipRest(reason) {
  console.log(`\n⚠️ 环境前置不满足，**跳过后续需要云端快照的用例**：${reason}`);
  console.log('   这不是判据失败，而是"这台机器上跑不了这一组"——');
  console.log('   要真跑它：先在管理页点「重新登录」登录云端账号库，再重跑本脚本。');
}

async function launch(tag) {
  const profile = path.join(ROOT, 'tmp', `ui-scheme-${tag}`);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: findPwChromium(), headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run', '--ignore-certificate-errors', '--host-resolver-rules=MAP qllocal.test 127.0.0.2'],
  });
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
  await page.waitForTimeout(800);
  return { ctx, page };
}
const siteTabOf = (ctx) => ctx.pages().find((p) => /10\.100|127\.0\.0\.1|qllocal\.test/.test(p.url()) && !p.url().includes('chrome-extension'));

/* ---- A1+A2：纯 http 站点（127.0.0.1，443 无服务）——probe 返回 http；带 scheme 创建一次成功 ---- */
{
  const { ctx, page } = await launch('a');
  const probe = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.probeScheme', host: '127.0.0.1' }));
  check('A1 探测纯 http 站点返回 http', probe?.result?.ok === true && probe?.result?.data === 'http', JSON.stringify(probe?.result));
  // hint 直选路径：用户在站点表单粘贴 http:// 前缀 → hint 已写（此处直接写 storage 等效）
  await page.evaluate(() => chrome.storage.local.set({ 'ql:siteSchemes': { '127.0.0.1': 'http' } }));
  const cr = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: '127.0.0.1', tabName: 'A-账号', username: 'T01', password: '88888888', open: false, scheme: 'http' }));
  const id = cr?.result?.data?.id;
  const op = await page.evaluate((i) => chrome.runtime.sendMessage({ kind: 'par.open', id: i }), id);
  /* ★★ `par.open` 失败时**当场报出来**，不要再去等那个 20 秒的上限 ——
   *   判据的价值在于"**这条信息指向根因**"。原来它只报 `URL=''`，
   *   而真正的原因是 open 的 `error` 字段（读起来完全不一样）。 */
  const aErr = String(op?.result?.error ?? '');
  if (op?.result?.ok !== true) {
    check('A2a open 调用成功', false, `error=${aErr || JSON.stringify(op)?.slice(0, 200)}`);
    if (aErr.includes(NEEDS_CLOUD)) {
      skipRest(aErr);
      await ctx.close();
      httpServer.close(); httpsServer.close();
      console.log(`\n=== ${results.filter(Boolean).length}/${results.length} 通过（因环境前置提前结束）===`);
      process.exit(1);
    }
  } else {
    check('A2a open 调用成功', true);
  }
  // ★ 等"自动登录真的记账了"，而不是睡 16 秒
  const rec = await waitAccount(page, '127.0.0.1');
  const tab = siteTabOf(ctx);
  const url = tab?.url() ?? '';
  check('A2b 打开直达 http（无重试）', url.startsWith('http://127.0.0.1/'), `URL=${url.slice(0, 60)}`);
  check('A2c 自动登录成功（hasToken）', rec?.hasToken === true, `hasToken=${rec?.hasToken}`);
  await ctx.close();
}
/* ---- B：自学习——默认 https 创建（模拟误判），打开失败自动翻转 http 并写回 ---- */
{
  const { ctx, page } = await launch('b');
  const cr = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: '127.0.0.1', tabName: 'B-账号', username: 'T01', password: '88888888', open: false }));
  const id = cr?.result?.data?.id;
  await page.evaluate((i) => chrome.runtime.sendMessage({ kind: 'par.open', id: i }), id);
  // ★ 这一段等的是"自学习翻转"——它比 A 多一次失败导航，所以上限给宽一点
  const rec = await waitAccount(page, '127.0.0.1', (r) => r?.scheme === 'http' && r?.hasToken === true, 25000);
  const url = (await waitUrl(ctx, 'http://127.0.0.1/')) ?? siteTabOf(ctx)?.url() ?? '';
  check('B1 打开失败后自学习翻转 http 成功', url.startsWith('http://127.0.0.1/'), `URL=${url.slice(0, 60)}`);
  check('B2 scheme 已写回账号档案', rec?.scheme === 'http', `scheme=${rec?.scheme}`);
  check('B3 自愈后登录成功（hasToken）', rec?.hasToken === true, `hasToken=${rec?.hasToken}`);
  await ctx.close();
}
/* ---- C：https 站点回归（qllocal.test，443 自签） ---- */
{
  const { ctx, page } = await launch('c');
  const probe = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.probeScheme', host: 'qllocal.test' }));
  check('C1 探测 https 站点返回 https', probe?.result?.data === 'https', JSON.stringify(probe?.result));
  const cr = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'qllocal.test', tabName: 'C-账号', username: 'T01', password: '88888888', open: false, scheme: 'https' }));
  const id = cr?.result?.data?.id;
  await page.evaluate((i) => chrome.runtime.sendMessage({ kind: 'par.open', id: i }), id);
  const rec = await waitAccount(page, 'qllocal.test');
  const tab = siteTabOf(ctx);
  const url = tab?.url() ?? '';
  check('C2 https 站点打开直达（不误伤）', url.startsWith('https://qllocal.test/'), `URL=${url.slice(0, 60)}`);
  check('C3 https 自动登录成功（hasToken）', rec?.hasToken === true, `hasToken=${rec?.hasToken}`);
  await ctx.close();
}

httpServer.close();
httpsServer.close();
console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
