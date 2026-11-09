/**
 * **Edge 兼容性**回归（真起 Edge，不是"读 manifest 猜"）。
 *
 *     npm run build && node tools/verify/verify-edge.mjs
 *
 * ## 为什么单独一条
 *
 * 本仓的浏览器门禁（`verify-load.mjs` 及其它 `BROWSER_SCRIPTS`）**只起 playwright 自带的
 * Chromium**。而 2026-10-12 用户报的是「**Edge 上打开账号卡死/闪退**」
 * （CHANGELOG §4.1.3），那件事至今**没有复现**。在没有任何一条 Edge 判据之前，
 * "Edge 兼容"这句话只能靠人在 Edge 上手工点一遍 —— 而人不会每次都点。
 *
 * ⇒ 这条脚本把**能自动化验证的那一层**钉住：扩展在 Edge 里装得上、SW 活着、
 *   四个自有页面能开、MAIN world 注入、命令键位、DNR 会话规则往返、
 *   兜底小窗能开、以及**提示文案按家族给地址**（`edge://extensions`）。
 *
 * ## 它**不**验什么（诚实边界）
 *
 * 不验：登录平台 / 列表 / 开页签 / 盒子 / 设备流 / 离线降级 / **那次卡死本身**。
 * 前六项要真实云端账号 + 真实内网平台（`AGENTS.md` §3 已注明必须人工）。
 * 最后一项需要 `edge://crashes` 的 EXCEPTION_ 码或事件查看器里的 WER 记录 ——
 * 没有用户现场数据就复现不了，**本脚本不宣称它能验到**。
 *
 * ## 反证（规则 17：门禁必须先弄红一次）
 *
 * 2026-11-09 实测过的三次"故意弄红"，都按预期失败并 exit 1：
 *  ① 把 `browser-env.ts` 的 `extensionsPageText()` 改回固定返回 `chrome://extensions`
 *    ⇒ 「界面文案按家族给」那条红（translate 页链接文案变成 chrome://）。
 *  ② 在 `ui/popup/popup.ts` 里加一行渲染字符串 `'chrome://extensions'`
 *    ⇒ 静态那条红。
 *  ③ 把 `EDGE_PATH` 指到一个不存在的路径 ⇒ 走 SKIP 分支，exit 0（不是红）——
 *    这**故意**是 SKIP 而不是 FAIL：没装 Edge 的机器不该因此判失败，
 *    否则所有人都会开始忽略这条门禁（规则 13 的同类风险）。
 */
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(root, 'dist');
const SRC = path.join(root, 'packages', 'extension', 'src');
const PROFILE = path.join(root, 'tmp', 'edge-verify');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

/** 家族 → 协议：Edge 用 `edge://`，其余 `chrome://`（理由见 src/shared/browser-env.ts 头注释） */
const EDGE_SHORTCUTS_PAGE = 'edge://extensions/shortcuts';

function findEdge() {
  // ★ 显式给了 `EDGE_PATH` 就**只认它**（指错了要看得见，而不是静默回落到默认路径）。
  if (process.env.EDGE_PATH) {
    return existsSync(process.env.EDGE_PATH) ? process.env.EDGE_PATH : null;
  }
  const candidates = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/** `sha256(Base64(key))` 前 32 hex 位 → a–p（与 check-dist / verify-load 同一算法） */
function extensionIdFromKey(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = createHash('sha256').update(der).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * 静态判据：**渲染字符串**里不许硬编码扩展管理页地址。
 *
 * ★ 为什么按"行首像注释就跳过"这么粗的判据：本仓的注释风格是每行以 `*` 或 `//` 开头
 *   （块注释续行也带 `*`），所以这条规则**只会漏判"行尾注释"**，不会把真代码当注释放过 ——
 *   方向是"宁红不绿"。用完整的 `strip-comments.mjs` 反而更危险：它会**跨字符串字面量**
 *   匹配块注释（PITFALLS #35），而 `chrome://…` 正好长在字符串里。
 */
function staticHardcodedHits() {
  const hits = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (/\.(ts|html)$/.test(ent.name)) {
        const rel = path.relative(root, p).split(path.sep).join('/');
        readFileSync(p, 'utf8').split(/\r?\n/).forEach((ln, i) => {
          const t = ln.trim();
          if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return;
          if (t.includes('chrome://extensions')) hits.push(`${rel}:${i + 1}`);
        });
      }
    }
  };
  walk(path.join(SRC, 'ui'));
  return hits;
}

console.log('=== 前提 ===');
check('dist/manifest.json 存在（跑前必须 npm run build）', existsSync(path.join(DIST, 'manifest.json')));
if (!existsSync(path.join(DIST, 'manifest.json'))) process.exit(1);

const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
check('能从 manifest.key 算出扩展 ID', /^[a-p]{32}$/.test(extId), extId);

const edgePath = findEdge();
if (!edgePath) {
  console.log('  SKIP 本机没有 Edge（可用 $env:EDGE_PATH 指定）⇒ 只跑静态判据，动态部分整段跳过');
  const hitsS = staticHardcodedHits();
  check('UI 渲染字符串里没有硬编码 chrome://extensions（静态）', hitsS.length === 0,
    hitsS.length ? hitsS.join(' ') : '0 处');
  const passedS = results.filter(Boolean).length;
  console.log(`\n=== 汇总：${passedS}/${results.length} 通过（跳过动态部分）===`);
  // ★ 静态部分红了仍然 exit 1 —— "没有 Edge"放过的是**动态**判据，不是全部判据。
  //   这条边界很要紧：否则在没装 Edge 的机器上，静态那条退化成一个永远绿的点缀。
  process.exit(passedS === results.length ? 0 : 1);
}
check('找到 Edge 可执行文件', true, edgePath);

// ---------------- 静态判据（不需要浏览器，先跑：它红了就不必起 Edge）
console.log('\n=== ① 提示文案的来源是 browser-env（静态）===');
const hits = staticHardcodedHits();
check('UI 渲染字符串里没有硬编码 chrome://extensions（Edge 无此协议）', hits.length === 0,
  hits.length ? hits.join(' ') : '0 处');

const parallelSrc = readFileSync(path.join(SRC, 'ui', 'parallel', 'parallel.ts'), 'utf8');
const translateSrc = readFileSync(path.join(SRC, 'ui', 'translate', 'translate.ts'), 'utf8');
const callCount = (src, name) => [...src.matchAll(new RegExp(`${name}\\(`, 'g'))].length;
check('parallel.ts 三处提示都改走 extensionsPageText()',
  callCount(parallelSrc, 'extensionsPageText') >= 3,
  `${callCount(parallelSrc, 'extensionsPageText')} 处调用`);
check('translate.ts 的改键链接走 shortcutsPageUrl()/shortcutsPageText()',
  callCount(translateSrc, 'shortcutsPageUrl') >= 1 && callCount(translateSrc, 'shortcutsPageText') >= 1,
  `${callCount(translateSrc, 'shortcutsPageUrl')} + ${callCount(translateSrc, 'shortcutsPageText')} 处`);

// ---------------- 真起 Edge
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

/** 本地页：验 MAIN world 注入用（`<all_urls>` 覆盖 127.0.0.1，实测两边都会注入） */
const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body>edge-probe</body></html>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const localUrl = `http://127.0.0.1:${server.address().port}/edge-probe`;

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: edgePath,
  // ★ 2026-11-09 实测：Edge 的 **headless** 也装载 `--load-extension`
  //   （新版 headless 支持扩展；旧结论"headless 不加载扩展"只对老实 Chrome 成立）。
  headless: true,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

const hardErrors = [];
ctx.on('page', (p) => {
  p.on('pageerror', (e) => hardErrors.push(`${p.url()} :: pageerror :: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') hardErrors.push(`${p.url()} :: console.error :: ${m.text()}`);
  });
});

try {
  // ---------------- ② 扩展真的被装载
  console.log('\n=== ② Edge 里扩展被装载 ===');
  const page = await ctx.newPage();
  const resp = await page.goto(`chrome-extension://${extId}/ui/popup/popup.html`,
    { waitUntil: 'domcontentloaded' }).catch((e) => ({ error: String(e) }));
  check('能打开 chrome-extension://<id>/ui/popup/popup.html', !resp?.error,
    resp?.error ? resp.error.slice(0, 90) : '');
  if (resp?.error) throw new Error('扩展没装上 ⇒ 后面都验不了');
  await page.waitForTimeout(400);

  // ---------------- ③ SW 活着，且诊断里带浏览器家族
  console.log('\n=== ③ SW 活着 + 诊断带上浏览器家族 ===');
  const diag = await page.evaluate(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ kind: 'ql.diag' });
      return { ok: true, data: r?.result?.data ?? null };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  });
  check('SW 对 `ql.diag` 有应答', diag.ok === true,
    diag.ok ? `logs=${Array.isArray(diag.data?.logs) ? diag.data.logs.length : 'n/a'}` : diag.err.slice(0, 90));
  const b = diag.data?.browser ?? {};
  check('诊断里 browser.family === "edge"', b.family === 'edge', String(b.family));
  check('browser.version 是主版本级的数字串（Edg/ 令牌只剩主版本）',
    /^\d+\./.test(String(b.version)), String(b.version));
  check('browser.tag 形如 edge/<version>', String(b.tag).startsWith('edge/'), String(b.tag));
  check('诊断里带完整 ua（家族判据的原始证据）',
    typeof diag.data?.ua === 'string' && diag.data.ua.includes('Edg/'),
    String(diag.data?.ua ?? '').slice(0, 60));

  // ---------------- ④ 四个自有页面（清单必须与源码一一对应）
  console.log('\n=== ④ 自有页面能开且无未捕获错误 ===');
  const OWN_PAGES = [
    'ui/popup/popup.html',
    'ui/parallel/parallel.html',
    'ui/translate/translate.html',
    'ui/wheel/wheel.html',
  ];
  const htmlOnDisk = readdirSync(path.join(SRC, 'ui'), { recursive: true })
    .map(String).filter((f) => f.endsWith('.html'))
    .map((f) => `ui/${f.split(path.sep).join('/')}`).sort();
  const listed = [...OWN_PAGES].sort();
  check('自有页面清单与源码里的 html 一一对应',
    htmlOnDisk.length === listed.length && htmlOnDisk.every((f, i) => f === listed[i]),
    `源码 ${htmlOnDisk.length} 个`);
  for (const p of OWN_PAGES) {
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`chrome-extension://${extId}/${p}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(300);
    check(`${p} 能开且无未捕获错误`, errs.length === 0, errs.slice(0, 1).join(' ').slice(0, 80));
    await pg.close();
  }

  // ---------------- ⑤ 文案按家族给：translate 页的改键链接必须落在 edge://
  console.log('\n=== ⑤ 界面文案按家族给（端到端：不看源码，看渲染结果）===');
  const tp = await ctx.newPage();
  await tp.goto(`chrome-extension://${extId}/ui/translate/translate.html`, { waitUntil: 'domcontentloaded' });
  await tp.waitForTimeout(500);
  const linkText = await tp.evaluate(() => document.getElementById('shortcut-link')?.textContent ?? '');
  check(`改写键链接文案 === ${EDGE_SHORTCUTS_PAGE}`, linkText === EDGE_SHORTCUTS_PAGE, `「${linkText}」`);
  await tp.close();

  // ---------------- ⑥ 命令键位
  console.log('\n=== ⑥ 五个命令都在且带键位 ===');
  const cmds = await page.evaluate(async () => (await chrome.commands.getAll()).map((c) => `${c.name}=${c.shortcut ?? ''}`));
  // ★ `chrome.commands.getAll()` 会把 **action 命令**（`_execute_action`）也算一条 ——
  //   它不在 manifest 的 `commands` 里，所以判据要用 manifest 的 key 集合，不能数总条数。
  const declared = Object.keys(manifest.commands ?? {});
  check('manifest 声明了 5 个命令', declared.length === 5, declared.join(' '));
  const unlisted = declared.filter((n) => !cmds.some((s) => s.startsWith(`${n}=`)));
  check('这 5 个命令 `getAll()` 都报了出来', unlisted.length === 0,
    unlisted.length ? `缺 ${unlisted.join(',')}` : `${cmds.length} 条（含 _execute_action）`);
  const bound = ['quick-wheel', 'quick-status', 'quick-favorites', 'translate-input'];
  const missing = bound.filter((n) => !cmds.some((s) => s.startsWith(`${n}=`) && !s.endsWith('=')));
  check('4 个带默认键位的命令都拿到了快捷键（Edge 没吞掉默认值）', missing.length === 0,
    missing.length ? `缺 ${missing.join(',')}` : cmds.filter((s) => !s.endsWith('=')).join(' '));

  // ---------------- ⑦ MAIN world 注入（七平面的入口）
  console.log('\n=== ⑦ MAIN world 的隔离层真的注入了（在普通网页上）===');
  const site = await ctx.newPage();
  await site.goto(localUrl, { waitUntil: 'domcontentloaded' });
  await site.waitForTimeout(600);
  const shield = await site.evaluate(() => {
    const w = window;
    return { installed: w.__QL_SHIELD_INSTALLED__ === true, patched: typeof Storage.prototype.getItem === 'function' };
  });
  check('`window.__QL_SHIELD_INSTALLED__ === true`（shield-main 落在 MAIN world）', shield.installed === true);
  await site.close();

  // ---------------- ⑧ DNR 会话规则往返（七平面里最核心的按页签隔离原语）
  console.log('\n=== ⑧ DNR 会话规则能装能撤（按 tabIds 隔离的原语）===');
  const dnr = await page.evaluate(async () => {
    const id = 777123;
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        addRules: [{
          id, priority: 1,
          action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Cookie', operation: 'remove' }] },
          condition: { resourceTypes: ['main_frame'], requestDomains: ['example.com'], tabIds: [999999] },
        }],
      });
      const added = (await chrome.declarativeNetRequest.getSessionRules()).some((r) => r.id === id);
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
      const removed = !(await chrome.declarativeNetRequest.getSessionRules()).some((r) => r.id === id);
      return { added, removed };
    } catch (e) {
      return { err: String(e) };
    }
  });
  check('addSessionRules 生效（getSessionRules 能看到）', dnr.added === true, dnr.err ?? '');
  check('removeSessionRules 生效（撤得干净）', dnr.removed === true, dnr.err ?? '');

  // ---------------- ⑨ 兜底小窗（内容脚本注入不了时的备用唤起路径）
  console.log('\n=== ⑨ windows.create({type:"popup"}) —— 轮盘兜底路径 ===');
  const popup = await page.evaluate(async () => {
    try {
      const w = await chrome.windows.create({
        url: chrome.runtime.getURL('ui/wheel/wheel.html'),
        type: 'popup', width: 1180, height: 760, focused: false,
      });
      // ★ 尺寸判据**不写"宽度 === 1180"**：实测 headless Edge 把它压到 800
      //   （headed 时是 1180）—— 那是窗口管理器的钳制，不是兼容缺陷。
      //   真正要验的是"这条兜底路径给出的窗口里**是我们的轮盘页**"。
      await new Promise((r) => setTimeout(r, 800));
      const tabs = w?.id != null ? await chrome.tabs.query({ windowId: w.id }) : [];
      const out = { type: w?.type ?? null, urls: tabs.map((t) => t.url ?? ''), id: w?.id ?? null };
      if (w?.id != null) await chrome.windows.remove(w.id).catch(() => {});
      return out;
    } catch (e) {
      return { err: String(e) };
    }
  });
  check('Edge 能开 type=popup 的小窗', popup.type === 'popup', popup.err ?? '');
  check('小窗里装的是轮盘页（兜底路径真的能唤起）',
    (popup.urls ?? []).some((u) => u.includes('/ui/wheel/wheel.html')),
    (popup.urls ?? []).join(' ').slice(0, 90));

  // ---------------- ⑩ 装载期没有致命错误
  console.log('\n=== ⑩ 全程没有未捕获错误 ===');
  const unexpected = hardErrors
    .filter((e) => !/Could not establish connection|Receiving end does not exist|net::ERR_|ERR_BLOCKED/i.test(e))
    // 小窗被我们自己 close 掉时 Edge 会记一条，不算缺陷
    .filter((e) => !/ui\/wheel\/wheel\.html/i.test(e));
  check('没有未捕获错误', unexpected.length === 0, unexpected.slice(0, 2).join(' | ').slice(0, 160));
  for (const e of unexpected.slice(0, 5)) console.log(`      ${e.slice(0, 130)}`);
} finally {
  await ctx.close();
  server.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
