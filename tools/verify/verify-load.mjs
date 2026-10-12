/**
 * 扩展**装载冒烟**（B7 实机验证里**唯一可自动化**的那部分）。
 *
 *     npm run build && node tools/verify/verify-load.mjs
 *
 * ## 它验什么、不验什么
 *
 * ★ **不验**：登录平台、列表、开页签、盒子、设备流、离线降级 ——
 *   那些需要**真实云端账号 + 真实内网平台**，必须人工走一遍（B7 的剩余部分）。
 * ★ **验**：`dist/` 能不能被 Chromium **真的装载**，以及装载后
 *   **SW 注册成功 / 三个自有页面能开 / 没有未捕获的致命错误**。
 *
 * ## 为什么值得单独一条
 *
 * 本仓 `AGENTS.md` 规则 16 说"跑验证前必须先 `npm run build`：所有脚本都要读
 * `dist/manifest.json`"。⇒ 那些脚本验的是 **manifest 的内容**，
 * 而**没有一个验过"Chrome 真的能把它装上"**。
 *
 * ★ 两者差得很远：`content_scripts` 指向一个**不存在**的产物文件、
 *   或 `background.service_worker` 写错路径、或 manifest 里出现 Chrome 拒绝的字段 ——
 *   **manifest 的 JSON 依然合法、`check-dist.mjs` 依然绿，而装载直接失败。**
 *   而**失败信息只在 `chrome://extensions` 上**（人不去点就看不到）。
 */
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(root, 'dist');
const PROFILE = path.join(root, 'tmp', 'ui-load-smoke');

/**
 * ★★ 两处**照抄现有脚本**的做法 —— 我第一版自己发明了另一套，SW 一直等不到：
 *
 * ① **用 playwright 自带的 Chromium**（`ms-playwright/chromium-<ver>/chrome-win64/chrome.exe`）。
 *    ★ 写这段注释时踩过：我原本写的是 `chromium-` 后面紧跟一个星号，
 *      而**那个星号与后一个斜杠连起来正好是注释结束符** ⇒ 注释提前闭合
 *      ⇒ `SyntaxError: Unexpected identifier`。
 *      ⇒ 注释里**不要写出"星号紧跟斜杠"这两个字符的组合**（连"举例说明"都不行）。
 *    实测：`headless: true` + 系统 Chrome 稳定版**不加载扩展**（新版才支持 headless 扩展），
 *    而 playwright 的 Chromium 可以。
 * ② **扩展 ID 从 `manifest.key` 推导**，不靠 `ctx.serviceWorkers()` ——
 *    后者在 headless 下**常常拿不到**（SW 是懒启动的）。
 */
function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (!fs.existsSync(mp)) return null;
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win']) {
      const p = path.join(mp, d, sub, 'chrome.exe');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

/** `sha256(Base64(key))` 前 32 个 hex 位 → a–p（与 `check-dist.mjs` 同一算法） */
function extensionIdFromKey(keyB64) {
  const der = Buffer.from(keyB64, 'base64');
  const hash = createHash('sha256').update(der).digest('hex');
  return [...hash.slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

console.log('=== 前提 ===');
check('dist/manifest.json 存在（跑前必须 npm run build）', existsSync(path.join(DIST, 'manifest.json')));
if (!existsSync(path.join(DIST, 'manifest.json'))) process.exit(1);

const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
check('能从 manifest.key 算出扩展 ID', /^[a-p]{32}$/.test(extId), extId);
const chromePath = findPwChromium();
check('找到了 playwright 自带的 Chromium', Boolean(chromePath),
  chromePath ? path.basename(path.dirname(path.dirname(chromePath))) : 'ms-playwright 下没有 chromium-*');

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: chromePath ?? undefined,
  headless: true,
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
  ],
});

/** 收集页面里的未捕获错误与 console.error */
const hardErrors = [];
ctx.on('page', (p) => {
  p.on('pageerror', (e) => hardErrors.push(`${p.url()} :: pageerror :: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error') hardErrors.push(`${p.url()} :: console.error :: ${m.text()}`);
  });
});

try {
  // ---------------- ① 扩展真的被装载（扩展页面能导航 = 装载成功）
  console.log('\n=== ① 扩展被装载（能导航到自有页面）===');
  const page = await ctx.newPage();
  const resp = await page.goto(`chrome-extension://${extId}/ui/popup/popup.html`,
    { waitUntil: 'domcontentloaded' }).catch((e) => ({ error: String(e) }));
  check('能打开 `chrome-extension://<id>/ui/popup/popup.html`', !resp?.error,
    resp?.error ? resp.error.slice(0, 90) : '');
  if (resp?.error) throw new Error('扩展没装上 ⇒ 后面都验不了');

  await page.waitForTimeout(400);

  // ---------------- ② 产物齐全性（★ 按**访问方式**分两类判，别混）
  //
  // ★★ 这里踩过一次，值得记：我第一版把**所有** manifest 产物都用
  //   `page.request.get('chrome-extension://<id>/…')` 取，结果 4 个 content script
  //   **全部报"缺失"** —— 而它们**就在磁盘上**。
  //
  //   根因：**content script 按设计不在 `web_accessible_resources` 里**
  //   ⇒ 扩展协议下**取不到**（这正是它们"不被网页随意读取"的那道门）。
  //   ⇒ 那条判据测的是**访问控制边界**，不是"文件在不在"。
  //
  //   而图标不受此限（它们必须在 `web_accessible_resources` 里才能被页面引用）。
  //
  // ★★ 而"取图标"这一步我又踩一次：`page.request.get('chrome-extension://…')`
  //   **不可靠** —— 同一批图标我先后看到"能取到"与"全部 ERR"**两次不同结果**
  //   （Playwright 的 request 上下文不在扩展的 origin 里）。
  //   ⇒ 换成**在 popup 页面里 `fetch()`**：那才是"扩展自己取自己的资源"，
  //     也正是 `web_accessible_resources` 那条边界真正约束的场景。
  console.log('\n=== ② 产物齐全性（分两类判：能取的从页面内 fetch，不能取的查磁盘）===');
  const fetchable = [...new Set([
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ])];
  check('前提：至少列出 1 个可取的图标', fetchable.length > 0, `${fetchable.length} 个`);
  const fetched = await page.evaluate(async (rels) => {
    const out = {};
    for (const rel of rels) {
      try {
        const r = await fetch(chrome.runtime.getURL(rel));
        out[rel] = r.status;
      } catch (e) {
        out[rel] = `ERR:${String(e).slice(0, 40)}`;
      }
    }
    return out;
  }, fetchable);
  const badIcons = Object.entries(fetched).filter(([, s]) => s !== 200);
  check('图标能从扩展页面内取到（web_accessible）', badIcons.length === 0,
    badIcons.length ? badIcons.map(([k, v]) => `${k}=${v}`).join(' ')
      : `${fetchable.length} 个全部 200`);

  // ②-b content script 与 SW：**查磁盘**（它们按设计不在 `web_accessible_resources` 里）
  const onDisk = [];
  for (const cs of manifest.content_scripts ?? []) for (const js of cs.js ?? []) onDisk.push(js);
  if (manifest.background?.service_worker) onDisk.push(manifest.background.service_worker);
  check('前提：至少列出 1 个"不可经协议取"的产物', onDisk.length > 0, `${onDisk.length} 个`);
  const missingDisk = [...new Set(onDisk)].filter((rel) => !existsSync(path.join(DIST, rel)));
  check('content script 与 SW 文件都在 dist 里', missingDisk.length === 0,
    missingDisk.length ? `缺 ${missingDisk.join(', ')}`
      : `${new Set(onDisk).size} 个全部存在`);

  // ---------------- ③ 自有页面能开且无未捕获错误
  //
  // ★★ 这份清单是**手写的**，所以新增页面**必须在这里登记** ——
  //   不登记的表现是"新页面从来不被试装"，而**校验仍然全绿**
  //   （2026-10-12 v4.2.0 新增 `ui/translate/translate.html` 时正是靠手动核对发现的）。
  //   ⇒ 判据：`src/ui/**/*.html` 的集合必须等于下面这个数组的集合。
  console.log('\n=== ③ 自有页面能打开且无未捕获错误 ===');
  const OWN_PAGES = [
    'ui/popup/popup.html',
    'ui/parallel/parallel.html',
    'ui/translate/translate.html',
    'ui/wheel/wheel.html',
  ];
  // 反向核对：源码里有多少个 html，清单里就该有多少条（漏登记 = 永远不试装）
  const htmlOnDisk = readdirSync(path.join(root, 'packages', 'extension', 'src', 'ui'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.html'))
    .map((f) => `ui/${f.split(path.sep).join('/')}`)
    .sort();
  const listed = [...OWN_PAGES].sort();
  check(
    '自有页面清单与源码里的 html 一一对应（新增页面必须登记，否则从不试装）',
    htmlOnDisk.length === listed.length && htmlOnDisk.every((f, i) => f === listed[i]),
    `源码 ${htmlOnDisk.length} 个：${htmlOnDisk.join(', ')}`,
  );
  for (const p of OWN_PAGES) {
    const pg = await ctx.newPage();
    const errs = [];
    pg.on('pageerror', (e) => errs.push(e.message));
    await pg.goto(`chrome-extension://${extId}/${p}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForTimeout(400);
    check(`${p} 能打开`, true, `「${await pg.title()}」`);
    check(`${p} 无未捕获错误`, errs.length === 0, errs.slice(0, 1).join(' ').slice(0, 80));
    await pg.close();
  }

  // ---------------- ④ SW 真的活着：能应答一条消息
  console.log('\n=== ④ SW 真的活着（能应答消息，不只是"页面能开"）===');
  const replied = await page.evaluate(async () => {
    try {
      const r = await chrome.runtime.sendMessage({ kind: 'ql.diag' });
      return { ok: true, kind: r?.kind ?? null, logs: r?.result?.data?.logs?.length ?? null };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  });
  check('SW 对 `ql.diag` 有应答（不是"无接收端"）', replied.ok === true,
    replied.ok ? `kind=${replied.kind} logs=${replied.logs}` : replied.err.slice(0, 90));
  check('`ql.diag` 回了 logs 数组（SW 的落盘通道在线）',
    replied.ok && Number.isInteger(replied.logs), String(replied.logs));

  // ---------------- ⑤ 装载期没有致命错误
  console.log('\n=== ⑤ 装载与开页面期间没有致命错误 ===');
  const unexpected = hardErrors.filter((e) =>
    !/Could not establish connection|Receiving end does not exist|net::ERR_|ERR_BLOCKED/i.test(e));
  check('没有未捕获错误', unexpected.length === 0, unexpected.slice(0, 2).join(' | ').slice(0, 160));
  for (const e of unexpected.slice(0, 5)) console.log(`      ${e.slice(0, 130)}`);
} finally {
  await ctx.close();
  rmSync(PROFILE, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
