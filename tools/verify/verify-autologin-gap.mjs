/** 回归用例：自动填表「值进了 DOM，但平台表单状态没收到」⇒ 点登录后报「请输入密码」（PITFALLS #55）。
 *
 * 复现的机制（真机证据 `tmp/vpn-recon-after-login.png`：用户名已填、密码框空且红框、下方红字「请输入密码」）：
 *   1. 密码框在**同源 srcdoc iframe** 里，那个 iframe 自己的应用要等 hydration 完才挂 `input` 监听；
 *   2. 我们在 iframe 一出现就填（此时监听器还不存在）⇒ 这一次写入对平台**永久丢失**：
 *      DOM 有值、平台状态是空；
 *   3. 此后 `fillPasswordInIframes()` 见 `field.value === credentials.password` 就跳过写入 ⇒
 *      平台永远收不到事件，而我们的"回读"读的是 DOM（正确）⇒ 守卫看不见问题 ⇒ 点下去校验失败。
 *
 * 本用例的假平台把这三件事都做出来：顶层监听器立刻挂、iframe 内监听器 `PWD_DELAY`(默认 1200ms) 后才挂、
 * 按钮点击时**只看平台状态**（不看 DOM），空就渲染 `.ant-form-item-explain-error`「请输入密码」。
 * 断言用「平台状态里有没有密码」这种外部可观测结果，不看实现内部。
 *
 * 基线（改之前 / `PROBE_DIST` 指向旧构建）：C/D/E 三项失败 —— 正是线上报的那条。
 * 修复（v4.2.31）：填值一律派发事件（不再因"值已相同"静默跳过）；点击落地前强制重派发一次；
 *   首击给 1500ms 下限；平台报校验错而 DOM 里仍有密码 ⇒ 判为"事件没送到"，强制重填并重试（不计服务端拒绝配额）。
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_DIST = process.env.PROBE_DIST ? path.resolve(ROOT, process.env.PROBE_DIST) : path.join(ROOT, 'dist');
/** 密码监听器晚挂多少毫秒（模拟 iframe 内框架 hydration 慢于我们的首次填充） */
const PWD_DELAY = Number(process.env.PWD_DELAY || 1200);
const DIST = path.join(ROOT, 'tmp', 'autologin-gap-dist');
const USD = path.join(ROOT, 'tmp', 'autologin-gap-profile');

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  for (const d of fs.readdirSync(mp).filter((x) => /^chromium/i.test(x)).sort().reverse()) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
function extensionIdFromKey(keyB64) {
  const hash = createHash('sha256').update(Buffer.from(keyB64, 'base64')).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.cpSync(SRC_DIST, DIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://127.0.0.1/*'];
fs.writeFileSync(path.join(DIST, 'manifest.json'), JSON.stringify(mf, null, 2));
const extId = extensionIdFromKey(mf.key);
console.log(`dist=${path.basename(SRC_DIST)} extId=${extId}`);

/* ---------------- 假登录页 ---------------- */
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>登录</title>
<style>
 body{font-family:system-ui;margin:40px}
 .box{width:360px}
 .ant-input{border:1px solid #d9d9d9;border-radius:6px;width:100%;height:36px;padding:0 10px;margin:6px 0 14px}
 .ant-input.err{border-color:#ff4d4f}
 .ant-form-item-explain-error{color:#ff4d4f;font-size:12px;margin:-8px 0 8px}
 .ant-btn{width:100%;height:40px;background:#1677ff;color:#fff;border:0;border-radius:6px;font-size:15px}
</style></head><body>
<div class="box">
  <h3>Akso eGMP</h3>
  <input class="ant-input" id="u" placeholder="请输入用户名" type="text" autocomplete="off" />
  <div id="pw-host"></div>
  <div id="err"></div>
  <label><input type="checkbox" id="privacyChecked" /> 已阅读并同意</label>
  <button class="ant-btn" id="go">登 录</button>
</div>
<iframe id="pwf" style="width:0;height:0;border:0" srcdoc='<input class="ant-input" id="p" type="password" placeholder="密码" autocomplete="off" />'></iframe>
<script>
  // 平台表单状态（antd 的 field store）
  window.__model = { username: '', password: '' };
  window.__events = [];
  const u = document.getElementById('u');
  const go = document.getElementById('go');
  const errBox = document.getElementById('err');
  const f = document.getElementById('pwf');

  // 顶层：监听器已经挂好（模拟顶层表单先完成 hydration）
  u.addEventListener('input', () => {
    window.__events.push('u-input:' + u.value);
    if (u.value !== window.__model.username) window.__model.username = u.value;
  });

  // 密码在 iframe 里 —— 框架 hydration 比顶层晚，监听器 1200ms 后才挂上
  const attachPwd = () => {
    const doc = f.contentDocument;
    const p = doc && doc.getElementById('p');
    if (!p) return;
    if (p.__bound) return;
    p.__bound = true;
    p.addEventListener('input', () => {
      window.__events.push('p-input:' + p.value);
      if (p.value !== window.__model.password) window.__model.password = p.value;
    });
    window.__pwdBoundAt = Date.now();
  };
  setTimeout(attachPwd, ${PWD_DELAY});
  f.addEventListener('load', () => setTimeout(attachPwd, ${PWD_DELAY}));

  go.addEventListener('click', () => {
    window.__clicks = (window.__clicks || 0) + 1;
    const p = f.contentDocument && f.contentDocument.getElementById('p');
    const domP = p ? p.value : '(no-field)';
    window.__lastSubmit = { modelU: window.__model.username, modelP: window.__model.password, domP };
    errBox.innerHTML = '';
    const miss = [];
    if (!window.__model.username) miss.push('请输入用户名');
    if (!window.__model.password) miss.push('请输入密码');
    if (miss.length) {
      errBox.innerHTML = miss.map((m) => '<div class="ant-form-item-explain-error">' + m + '</div>').join('');
      // ★ 刻意**不清空** DOM 里的值：这正是本用例的判别点 —— 老实现见"值已相同"就跳过写入，
      //   于是 DOM 有值、平台状态空；若我们在这里替真机把 DOM 也清空，老实现下一轮就会因为
      //   "值不同"而重填，反而自愈，用例就抓不到旧行为了（实测：清空后改前也能通过）。
      //   真机那种"报错后密码框也被清空"的形态由源码里的 looksLikeMissingInput 分支覆盖。
      if (!window.__model.password && p) p.classList.add('err');
      window.__errors = (window.__errors || 0) + 1;
    } else {
      document.title = 'LOGIN_OK';
      window.__loginOk = true;
    }

    // 登录成功会跳转，统计要跨文档留存 ⇒ 每次点击都写进 sessionStorage（同源，/home 也读得到）
    try {
      sessionStorage.setItem('probe_state', JSON.stringify({
        clicks: window.__clicks || 0,
        errors: window.__errors || 0,
        events: window.__events,
        model: window.__model,
        lastSubmit: window.__lastSubmit,
        loginOk: !!window.__loginOk,
        pwdBoundAt: window.__pwdBoundAt || 0,
        errText: errBox.textContent || '',
        domPwd: domP,
      }));
    } catch {}
    // ★ 刻意**不跳转**：断言要读同一份文档里的模型状态（跳转后统计只能靠 sessionStorage，
    //   实测在本台架里读不回来）。真机是登录成功后平台自己跳 /home，与这里无关。
  });
</script></body></html>`;

const HOME = '<!doctype html><title>home</title><h1>工作台</h1>';

let origin = '';
const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/login')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }
  if (req.url?.startsWith('/home')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(HOME);
    return;
  }
  if (req.url?.startsWith('/favicon')) { res.writeHead(204); res.end(); return; }
  res.writeHead(404); res.end('nf');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
origin = `http://127.0.0.1:${port}`;
console.log(`fake login: ${origin}/login`);

fs.rmSync(USD, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(USD, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const errors = [];
ctx.on('page', (p) => p.on('pageerror', (e) => errors.push(String(e).slice(0, 120))));

await new Promise((r) => setTimeout(r, 1500));
const ext = await ctx.newPage();
for (let i = 0; i < 4; i++) {
  try {
    await ext.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`, { timeout: 8000 });
    break;
  } catch (e) {

    if (i === 3) throw e;
    await new Promise((r) => setTimeout(r, 800));
  }
}
await ext.waitForTimeout(600);

// 造一个页签：先 about:blank，拿到 tabId 后写绑定 + 待登录凭证，再重启扩展让 restore() 读到
const opened = await ext.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: true }));
const host = `127.0.0.1:${port}`;
await ext.evaluate(async ([tabId, host]) => {
  await chrome.storage.session.set({
    'ql:parTabBindings': { [String(tabId)]: { accountId: 'probeA', host } },
    ['sb:pendingAutoLogins:' + tabId]: { username: 'probe-user', password: 'probe-pass', at: Date.now() },
  });
}, [opened.id, host]);
// 让 SW 重新读一次 storage.session：不 reload 扩展（headless 里 reload 后扩展页永久 BLOCKED），
// 而是通过 browser 级 CDP 关掉 SW 的 target，下一条消息会把它重新拉起并跑 registerParallelHandlers → restore()。
const cdp = await ctx.browser().newBrowserCDPSession();
const { targetInfos } = await cdp.send('Target.getTargets');
const swInfos = targetInfos.filter((t) => t.type === 'service_worker' || /background\.js/.test(t.url));

for (const t of swInfos) {
  if (!/background\.js/.test(t.url)) continue;
  await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
}
await new Promise((r) => setTimeout(r, 1200));

await ext.evaluate(([tabId, origin]) => chrome.tabs.update(tabId, { url: origin + '/login' }), [opened.id, origin]);

let target = null;
for (let i = 0; i < 40; i++) {
  target = ctx.pages().find((p) => p.url().startsWith(origin + '/login'));
  if (target) break;
  await new Promise((r) => setTimeout(r, 250));
}
if (!target) throw new Error('登录页未加载');

await new Promise((r) => setTimeout(r, 9000));

const probe = await target.evaluate(() => {
  let s = null;
  try { s = JSON.parse(sessionStorage.getItem('probe_state') || 'null'); } catch {}
  const live = {
    model: window.__model || { username: '', password: '' },
    events: window.__events || [],
    clicks: window.__clicks || 0,
    errors: window.__errors || 0,
    loginOk: !!window.__loginOk,
    lastSubmit: window.__lastSubmit || null,
    errText: document.getElementById('err')?.textContent || '',
    domPwd: (() => { const d = document.getElementById('pwf')?.contentDocument; const p = d && d.getElementById('p'); return p ? p.value : '(none)'; })(),
    pwdBoundAt: window.__pwdBoundAt || 0,
  };
  const merged = s && (s.clicks || 0) >= (live.clicks || 0) ? s : live;
  return { ...merged, url: location.href };
});

const fail = [];
const ok = (cond, name, extra) => { console.log(`${cond ? '✔' : '✖'} ${name}${extra ? '  ' + extra : ''}`); if (!cond) fail.push(name); };
console.log('events=' + JSON.stringify(probe.events));
console.log('lastSubmit=' + JSON.stringify(probe.lastSubmit));
ok(probe.clicks >= 1, 'A 扩展确实点了登录', `clicks=${probe.clicks}`);
ok(probe.domPwd === 'probe-pass', 'B DOM 里密码已被填上', `dom=${probe.domPwd}`);
ok(probe.model.password === 'probe-pass', 'C 平台状态收到了密码（修复目标）', `modelP=${probe.model.password || '(空)'}`);
const landed = probe.loginOk === true || target.url().endsWith('/home');
ok(landed, 'D 登录成功（未被客户端校验拦下）', `url=${target.url()} errText=${probe.errText}`);
ok(probe.clicks <= 2, 'F 没有无限补点', `clicks=${probe.clicks}`);
ok(probe.pwdBoundAt > 0, 'G 假平台的密码监听器确实晚挂（复现前提成立）', `delay=${PWD_DELAY}ms`);
ok(!/请输入密码/.test(probe.errText), 'E 没有出现「请输入密码」');

console.log(`\n=== ${fail.length === 0 ? '全部通过' : fail.length + ' 项失败: ' + fail.join(' / ')} ===`);
if (errors.length) console.log('pageerror: ' + JSON.stringify(errors.slice(0, 5)));
await ctx.close();
server.close();
process.exit(fail.length ? 1 : 0);
