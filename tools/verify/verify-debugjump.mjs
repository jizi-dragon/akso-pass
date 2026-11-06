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
const calls = { menu: 0, form: 0, workflows: 0, wfBasic: 0, allObjects: 0, formBodies: [] };

function html(body, token) {
  return `<!doctype html><meta charset="utf-8"><title>probe</title>
${token ? `<script>sessionStorage.setItem('__auth_token__', ${JSON.stringify(token)});</script>` : ''}
<p>${body}</p>`;
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/platform/Menu/GetUserMenuPermission') {
    calls.menu++;
    const noMenu = (req.headers.referer ?? '').includes('noform=1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: noMenu ? [] : [{ menuId: 'm-1', name: '变更控制单', code: 'dc_menu__c', objectId: OBJ, linkurl: `/web/view?mid=m-1&bid=${OBJ}` }] }));
    return;
  }
  if (u.pathname === '/api/platform/Layout/GetFormInstance') {
    calls.form++;
    // 页面地址带 noform=1 时模拟「该对象没有可读的表单实例」：接口 500，
    // 解析应当继续（对象 id 来自 URL），只是拿不到名称/生命周期，不能整次失败。
    if ((req.headers.referer ?? '').includes('noform=1')) {
      req.resume();
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 500, message: 'no form instance' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls.formBodies.push(body);
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
  if (u.pathname === '/api/platform/Workflow/GetWorkflowBasic') {
    calls.wfBasic++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      data: { objectId: OBJ, lifecycleId: LIFE, name: '流程A', code: 'FLOW_A__c', status: 20 },
    }));
    return;
  }
  if (u.pathname === '/api/platform/BasicObject/AllEnableObjects') {
    calls.allObjects++;
    const noObjects = (req.headers.referer ?? '').includes('noobjects=1');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: noObjects ? [] : [{ id: OBJ, code: 'demo__c', name: '演示对象', lifeCycleId: LIFE }] }));
    return;
  }
  if (u.pathname === '/api/platform/Workflow/GetObjectWorkflowList') {
    calls.workflows++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      code: 0,
      data: [
        { id: 'wf-1', name: '变更审批流程', code: 'DC_FLOW__c', status: 20, newVersionWorkflowConfigId: 'cfg-1', lifecycleStatusIds: null },
        { id: 'wf-2', name: '变更关闭流程', code: 'DC_CLOSE__c', status: 20, newVersionWorkflowConfigId: 'cfg-2', lifecycleStatusIds: null },
        // 停用（30）/ 未启用（10）都要被过滤掉：列表里留着只会点进空编辑器
        { id: 'wf-3', name: '已停用的旧流程', code: 'OLD__c', status: 30, newVersionWorkflowConfigId: 'cfg-3', lifecycleStatusIds: null },
        { id: 'wf-4', name: '还没启用', code: 'DRAFT__c', status: 10, newVersionWorkflowConfigId: 'cfg-4', lifecycleStatusIds: null },
      ],
    }));
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
    'A 对象关系地址',
    targetOf('relation')?.href === `${BASE}/admin/config/basic-objects/edit/relation?id=${OBJ}`,
    targetOf('relation')?.href ?? '',
  );
  check(
    'A 生命周期地址',
    targetOf('lifecycle')?.href === `${BASE}/admin/config/lifecycle/${LIFE}?__edit=2`,
    targetOf('lifecycle')?.href ?? '',
  );
  check('A 工作流列表地址', targetOf('workflow')?.href === `${BASE}/admin/config/workflow`, targetOf('workflow')?.href ?? '');
  check('A 业务菜单回到业务页', targetOf('menu')?.href === `${BASE}/web/view?mid=m-1&bid=${OBJ}`, targetOf('menu')?.href ?? '');
  check('A 菜单名透传', a.data?.menus?.[0]?.name === '变更控制单', JSON.stringify(a.data?.menus ?? []));
  check(
    'A 候选是数据数组（顺序 + 每格自带标题/说明）',
    a.data?.targets?.length === 7 &&
      a.data.targets.map((t) => t.kind).join(',') === 'object,listLayout,formLayout,relation,lifecycle,workflow,menu' &&
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
    'E 候选矩阵由数据渲染（7 格，顺序与后台 targets 一致）',
    overlay.kinds.join(',') === 'object,listLayout,formLayout,relation,lifecycle,workflow,menu' &&
      overlay.names.join(',') === '对象配置,列表布局,表单布局,对象关系,对象生命周期,工作流,业务菜单' &&
      overlay.hint,
    `${overlay.kinds.join(',')} / ${overlay.names.join(',')}`,
  );
  /* F. 第二层：点「工作流」直接列该对象上启用的工作流（v4.2.50）
     ★ 用 el.click() 而不是 dispatchEvent：click() 的事件带 composed=true，会真的
       穿过 shadow 边界冒泡到 host —— 正是 v4.2.51 踩过的「点面板内任意处把浮层关掉」。 */
  const clickCell = (key) =>
    p1.evaluate((k) => {
      const sr = document.getElementById('ql-debug-overlay-host')?.shadowRoot;
      const cell = Array.from(sr?.querySelectorAll('.ag-cell') ?? []).find((c) => (c.dataset.itemKey ?? '') === k);
      cell?.click();
      return !!cell;
    }, key);
  check('F 找到工作流格', await clickCell('workflow'));
  await p1.waitForTimeout(900);
  check('F 点面板内不会把浮层关掉（shadow 点击不误关）', await p1.evaluate(() => !!document.getElementById('ql-debug-overlay-host')));
  const wfView = await p1.evaluate(() => {
    const sr = document.getElementById('ql-debug-overlay-host')?.shadowRoot;
    const cells = Array.from(sr?.querySelectorAll('.ag-cell') ?? []);
    return {
      keys: cells.map((c) => c.dataset.itemKey ?? ''),
      names: cells.map((c) => c.querySelector('.ag-name')?.textContent ?? ''),
      meta: sr?.querySelector('.ag-meta')?.textContent ?? '',
      tip: sr?.querySelector('.ag-tip')?.textContent ?? '',
    };
  });
  check('F 只列启用中的工作流（2 个；停用 30 / 未启用 10 被过滤）', wfView.keys.join(',') === 'wf-1,wf-2', JSON.stringify(wfView));
  check('F 顶部计数如实', /启用 2 个/.test(wfView.meta), wfView.meta);
  check('F 页脚提示切到编辑器', /编辑器/.test(wfView.tip), wfView.tip);
  check('F 工作流接口只调一次', calls.workflows === 1, `workflows=${calls.workflows}`);

  /* G. 点工作流 → 打开编辑器深链（必须用 config id，不是 workflowBasicId） */
  const newPage = ctx.waitForEvent('page', { timeout: 6000 }).catch(() => null);
  await clickCell('wf-1');
  const popup = await newPage;
  check('G 点击工作流打开新页签', !!popup, popup?.url() ?? '');
  check('G 编辑器地址用 config id', /\/admin\/config\/workflow\/edit\?__edit=2&id=cfg-1/.test(popup?.url() ?? ''), popup?.url() ?? '');
  await popup?.close().catch(() => {});

  await p1.bringToFront();
  await p1.keyboard.press('Escape');
  await p1.waitForTimeout(300);
  const closed = await p1.evaluate(() => !document.getElementById('ql-debug-overlay-host'));
  check('E Esc 关闭浮层', closed);

  /* B. 带 bid：直接解析；菜单表仍只取一次（业务菜单入口要用） */
  const menuBefore = calls.menu;
  const p2 = await ctx.newPage();
  await p2.goto(`${BASE}/web/view?bid=${OBJ}`);
  await p2.waitForTimeout(600);
  const b = await resolveFor(p2);
  check('B 带 bid 时直接解析', b.ok && b.data?.object?.id === OBJ);
  check('B 每页只取一次菜单权限表', calls.menu - menuBefore === 1, `menu ${menuBefore}→${calls.menu}`);

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

  /* H. 反向解析：对象配置页（?id= 就是 objectId，v4.2.51） */
  const p5 = await ctx.newPage();
  await p5.goto(`${BASE}/admin/config/basic-objects/edit/base?id=${OBJ}`);
  await p5.waitForTimeout(500);
  const h = await resolveFor(p5);
  check('H 对象配置页能反查', h.ok && h.data?.object?.id === OBJ, JSON.stringify(h).slice(0, 200));
  check(
    'H 管理端 ?id= 不会被当成 instanceId 传给 GetFormInstance',
    (() => {
      const body = calls.formBodies[calls.formBodies.length - 1] ?? '';
      try { return JSON.parse(body).instanceId === ''; } catch { return false; }
    })(),
    calls.formBodies[calls.formBodies.length - 1] ?? '(no body)',
  );
  check('H 反查后仍有业务菜单', h.ok && h.data?.menus?.[0]?.name === '变更控制单', JSON.stringify(h.data?.menus ?? []));

  /* H2. 反向解析：对象关系页（同属 basic-objects/edit，?id= 取参，v4.2.52） */
  await p5.goto(`${BASE}/admin/config/basic-objects/edit/relation?id=${OBJ}`);
  await p5.waitForTimeout(500);
  const h2 = await resolveFor(p5);
  check('H2 对象关系页能反查', h2.ok && h2.data?.object?.id === OBJ, JSON.stringify(h2).slice(0, 160));

  /* K. 对象没有可读表单实例时：不整次失败，只少名称/生命周期，其余入口照常（v4.2.53） */
  await p5.goto(`${BASE}/admin/config/basic-objects/edit/base?id=${OBJ}&noform=1`);
  await p5.waitForTimeout(500);
  const k = await resolveFor(p5);
  const kTargets = k.ok ? k.data?.targets ?? [] : [];
  check('K 表单实例失败仍能解析出对象 id', k.ok && k.data?.object?.id === OBJ, JSON.stringify(k).slice(0, 160));
  check('K 没有菜单就不出业务菜单格', k.ok && kTargets.every((t) => t.kind !== 'menu'), kTargets.map((t) => t.kind).join(','));
  check(
    'K 生命周期从启用对象表兜底出来（不置灰）',
    k.ok && kTargets.find((t) => t.kind === 'lifecycle')?.href !== null && kTargets.length === 6,
    `${kTargets.length} 格 / ${kTargets.map((t) => t.kind).join(',')}`,
  );

  // K2. 表单实例与启用对象表都拿不到时，才允许生命周期置灰（仍然整页可用）
  await p5.goto(`${BASE}/admin/config/basic-objects/edit/base?id=${OBJ}&noform=1&noobjects=1`);
  await p5.waitForTimeout(500);
  const k2 = await resolveFor(p5);
  const k2Targets = k2.ok ? k2.data?.targets ?? [] : [];
  check(
    'K2 两处都拿不到时生命周期置灰、不整次报错',
    k2.ok && k2Targets.find((t) => t.kind === 'lifecycle')?.href === null && k2Targets.length === 6,
    `${k2Targets.length} 格 / ${k2Targets.map((t) => t.kind).join(',')}`,
  );

  /* I. 反向解析：生命周期页（只有 lifecycleId，扫 AllEnableObjects 反查对象） */
  const allBefore = calls.allObjects;
  const p6 = await ctx.newPage();
  await p6.goto(`${BASE}/admin/config/lifecycle/${LIFE}?__edit=2`);
  await p6.waitForTimeout(500);
  const i = await resolveFor(p6);
  check('I 生命周期页能反查对象', i.ok && i.data?.object?.id === OBJ, JSON.stringify(i).slice(0, 200));
  check('I 生命周期页确实扫了对象表', calls.allObjects > allBefore, `allObjects ${allBefore}→${calls.allObjects}`);

  /* J. 反向解析：工作流编辑页（?id= 是 config id，必须换成 objectId） */
  const p7 = await ctx.newPage();
  await p7.goto(`${BASE}/admin/config/workflow/edit?__edit=2&id=cfg-1`);
  await p7.waitForTimeout(500);
  const j = await resolveFor(p7);
  check('J 工作流编辑页能反查对象', j.ok && j.data?.object?.id === OBJ, JSON.stringify(j).slice(0, 200));
  check('J 用 GetWorkflowBasic 换 config id', calls.wfBasic >= 1, `wfBasic=${calls.wfBasic}`);
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(TESTDIST, { recursive: true, force: true });
}

console.log(`=== ${results.filter(Boolean).length}/${results.length} 通过 ===`);
process.exit(results.every(Boolean) ? 0 : 1);





