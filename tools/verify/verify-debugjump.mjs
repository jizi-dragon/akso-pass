/**
 * v4.2.45 回归：**调试跳转能在真实页签里解析出对象 / 生命周期 / 工作流地址**。
 *
 * 为什么必须真浏览器：解析函数是在**页面主世界**注入执行的（要走 DNR 的 Bearer、
 * 读页面自己的 `__auth_token__`、拿 `chrome.tabs.get(tabId).url` 的 origin），
 * 静态判据只能证明 URL 拼接对，证明不了这条链路真的通。
 *
 * 构造：本地 HTTP 服务同时扮演「平台业务页」与三个平台接口：
 *   - `/web/view?mid=m-1`  只有 mid → 走菜单反查 objectId；
 *   - `/web/view?bid=…`    直接带 bid；
 *   - `/web/plain`         有 token、没有对象上下文；
 *   - `/web/notoken`       没有 token。
 * 断言四个场景 + 三个地址形状 + 「带 bid 时不再请求菜单」。
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, 'tmp');

/* ---- 口径判据（v4.2.48）：调试浮层必须复用共用网格内核，不能自绘一套 ---- */
{
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'packages', 'extension', 'src', 'content', 'debug-overlay.ts'), 'utf8'),
  );
  const usesKernel = /import \{[^}]*\bbuildItemGrid\b[^}]*\bGRID_SLOTS\b[^}]*\} from '\.\.\/ui\/wheel\/item-grid'/.test(src);
  const callsKernel = /buildItemGrid\(\{/.test(src);
  const sharesFoot = /footStart:\s*foot/.test(src);
  const noHandShell = !/ag-head/.test(src) && !/class="ag-cell/.test(src);
  if (usesKernel && callsKernel && sharesFoot && noHandShell) {
    console.log('  ✓ 调试浮层复用 buildItemGrid（5×4 定尺网格与另外三个浮层同一口径）');
  } else {
    console.log('  ✗ 调试浮层又变成自绘外壳了（应调用 buildItemGrid / 使用 GRID_SLOTS / footStart）');
    process.exitCode = 1;
    process.exit(1);
  }
}


{
  const src = stripComments(
    fs.readFileSync(path.join(ROOT, 'packages', 'extension', 'src', 'background', 'service-worker.ts'), 'utf8'),
  );
  const bound = /parallelSession\.open\(accountId, true, \{ targetUrl: target\.href, stageCredentials: false \}\)/.test(src);
  const owner = /parallelSession\.boundAccountOf\(tabId\)/.test(src) && /parallelSession\.boundHostOf\(tabId\)/.test(src);
  const fallback = /debug\.open 以账号身份打开失败，退回普通新页签/.test(src);
  if (bound && owner && fallback) {
    console.log('  ✓ 跳转走账号绑定（含取不到账号时的可解释回退）');
  } else {
    console.log('  ✗ debug.open 的账号绑定链路缺失或退化');
    process.exitCode = 1;
    process.exit(1);
  }
}


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

const TESTDIST = path.join(TMP, 'verify-debugjump-dist');
fs.rmSync(TESTDIST, { recursive: true, force: true });
fs.cpSync(DIST, TESTDIST, { recursive: true });
const mf = JSON.parse(fs.readFileSync(path.join(TESTDIST, 'manifest.json'), 'utf8'));
mf.host_permissions = ['*://*/*'];
fs.writeFileSync(path.join(TESTDIST, 'manifest.json'), JSON.stringify(mf, null, 2));

const OBJ = '3a1934a8-738a-dd93-dfb0-de2669ba0a11';
const LIFE = '3a1934a8-738a-f302-f044-e3dd70e30e6a';
const TOKEN = 'tok-debugjump';
const calls = { menu: 0, form: 0 };

function html(body, token) {
  return `<!doctype html><meta charset="utf-8"><title>probe</title>
${token ? `<script>sessionStorage.setItem('__auth_token__', ${JSON.stringify(token)});</script>` : ''}
<p>${body}</p>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/platform/Menu/GetUserMenuPermission') {
    calls.menu++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: [{ menuId: 'm-1', objectId: OBJ, linkurl: `/web/view?mid=m-1&bid=${OBJ}` }] }));
    return;
  }
  if (u.pathname === '/api/platform/Layout/GetFormInstance') {
    calls.form++;
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        code: 0,
        data: {
          basicObject: { id: OBJ, code: 'demo__c', name: '演示对象', lifeCycleId: LIFE, enableLifeCycle: true },
          lifecycle: { id: LIFE, name: '演示生命周期' },
          echo: body.length,
        },
      }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (u.pathname === '/web/notoken') {
    res.end(html('no token', ''));
  } else if (u.pathname === '/web/plain') {
    res.end(html('plain', TOKEN));
  } else {
    res.end(html('view', TOKEN));
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(ok);
  console.log(`${name}: ${ok ? '✔' : '✖'}${extra ? ' ' + extra : ''}`);
};

const profile = path.join(TMP, 'verify-debugjump-profile');
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

try {
  const ext = await ctx.newPage();
  await ext.goto(`chrome-extension://${extensionIdFromKey(mf.key)}/ui/parallel/parallel.html`);
  await ext.waitForTimeout(300);

  const resolveFor = async (page) => {
    const tabId = await ext.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((t) => (t.url ?? '').startsWith(prefix))?.id ?? null;
    }, page.url());
    if (typeof tabId !== 'number') {
      return { ok: false, error: '找不到页签' };
    }
    const r = await ext.evaluate(
      async (id) => chrome.runtime.sendMessage({ kind: 'debug.resolve', tabId: id }),
      tabId,
    );
    return r?.result ?? { ok: false, error: '后台无响应' };
  };

  /* A. 只有 mid：走菜单反查 */
  const p1 = await ctx.newPage();
  await p1.goto(`${BASE}/web/view?mid=m-1`);
  await p1.waitForTimeout(600);
  const a = await resolveFor(p1);
  check('A 只有 mid 时能解析出对象', a.ok && a.data?.object?.id === OBJ, JSON.stringify(a).slice(0, 200));
  check('A 菜单接口被调用', calls.menu >= 1, `menu=${calls.menu}`);
  check('A 生命周期拿到', a.data?.lifecycle?.id === LIFE && a.data?.lifecycle?.name === '演示生命周期');
  const targetOf = (kind) => a.data?.targets?.find((t) => t.kind === kind);
  check(
    'A 对象配置地址',
    targetOf('object')?.href === `${BASE}/admin/config/basic-objects/edit/base?id=${OBJ}&__edit=2`,
    targetOf('object')?.href ?? '',
  );
  check(
    'A 列表布局地址',
    targetOf('listLayout')?.href === `${BASE}/admin/config/basic-objects/edit/list-layout?id=${OBJ}`,
    targetOf('listLayout')?.href ?? '',
  );
  check(
    'A 表单布局地址',
    targetOf('formLayout')?.href === `${BASE}/admin/config/form-layout/list?bid=${OBJ}`,
    targetOf('formLayout')?.href ?? '',
  );
  check(
    'A 生命周期地址',
    targetOf('lifecycle')?.href === `${BASE}/admin/config/lifecycle/${LIFE}?__edit=2`,
    targetOf('lifecycle')?.href ?? '',
  );
  check('A 工作流列表地址', targetOf('workflow')?.href === `${BASE}/admin/config/workflow`, targetOf('workflow')?.href ?? '');
  check(
    'A 候选是数据数组（顺序 + 每格自带标题/说明）',
    a.data?.targets?.length === 6 &&
      a.data.targets.map((t) => t.kind).join(',') === 'object,listLayout,formLayout,lifecycle,workflow,interfaces' &&
      a.data.targets.every((t) => t.title && typeof t.accent === 'string'),
    JSON.stringify(a.data?.targets ?? []).slice(0, 160),
  );
  check('A 对象名与 code 透传', a.data?.object?.name === '演示对象' && a.data?.object?.code === 'demo__c');

  /* E. Alt+2 页面热键：页面侧监听 → 后台注入浮层 → Esc 关闭 */
  await p1.bringToFront();
  await p1.keyboard.press('Alt+2');
  await p1.waitForTimeout(1200);
  const overlay = await p1.evaluate(() => {
    const host = document.getElementById('ql-debug-overlay-host');
    const sr = host?.shadowRoot;
    const cells = Array.from(sr?.querySelectorAll('.dbg-cell') ?? []);
    return {
      host: !!host,
      title: sr?.querySelector('.ag-box')?.textContent ?? '',
      kinds: cells.map((c) => c.dataset.kind ?? ''),
      names: cells.map((c) => c.querySelector('.ag-name')?.textContent ?? ''),
      hint: !!sr?.querySelector('.hint'),
    };
  });
  check('E Alt+2 能打开调试浮层', overlay.host);
  check('E 浮层里显示对象名', /演示对象/.test(overlay.title), overlay.title);
  check(
    'E 候选矩阵由数据渲染（6 格，顺序与后台 targets 一致）',
    overlay.kinds.join(',') === 'object,listLayout,formLayout,lifecycle,workflow,interfaces' &&
      overlay.names.join(',') === '对象配置,列表布局,表单布局,对象生命周期,工作流,对象接口' &&
      overlay.hint,
    `${overlay.kinds.join(',')} / ${overlay.names.join(',')}`,
  );
  await p1.keyboard.press('Escape');
  await p1.waitForTimeout(300);
  const closed = await p1.evaluate(() => !document.getElementById('ql-debug-overlay-host'));
  check('E Esc 关闭浮层', closed);

  /* B. 带 bid：不该再打菜单接口 */
  const menuBefore = calls.menu;
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/web/view?bid=${OBJ}`);
  await p2.waitForTimeout(600);
  const b = await resolveFor(p2);
  check('B 带 bid 时直接解析', b.ok && b.data?.object?.id === OBJ);
  check('B 没有重复请求菜单接口', calls.menu === menuBefore, `menu ${menuBefore}→${calls.menu}`);

  /* C. 有 token、没有对象上下文 */
  const p3 = await ctx.newPage();
  await p3.goto(`${BASE}/web/plain`);
  await p3.waitForTimeout(500);
  const c = await resolveFor(p3);
  check('C 没有 bid/mid 时明确报错', !c.ok && /业务对象上下文/.test(c.error ?? ''), c.error ?? '');

  /* D. 没有 token */
  const p4 = await ctx.newPage();
  await p4.goto(`${BASE}/web/notoken`);
  await p4.waitForTimeout(500);
  const d = await resolveFor(p4);
  check('D 未登录时明确报错', !d.ok && /未登录/.test(d.error ?? ''), d.error ?? '');
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(TESTDIST, { recursive: true, force: true });
}

console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
process.exit(results.every(Boolean) ? 0 : 1);

