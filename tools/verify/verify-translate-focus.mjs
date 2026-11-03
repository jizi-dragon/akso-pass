/**
 * verify-translate-focus（v4.2.30）：**输入框在"我们到之前"就聚焦了 / 输入框在 shadow root 里，
 * 翻译也不能失效**
 *
 * 为什么需要这个探针（PITFALLS #54）：
 *  · 内容脚本跑在 `document_idle`，而登录页、弹窗首个字段、聊天框都会在**更早**就 `focus()`
 *    自己的输入框 ⇒ 那一次 `focusin` 我们根本没听见，`targetEl` 会一直是 `null`：
 *    图标不出现、按 Ctrl+X **完全无声**（连"请先把光标放进输入框"都不弹）。
 *  · `FocusEvent.target` 在 Web Component 里会被**重定向**到 shadow host，真正承载输入的
 *    `host.shadowRoot.activeElement` 拿不到 ⇒ 同一类无声失效。
 *  · 两种情况下浏览器都会继续执行**自己的剪切**，用户看到的是"文字没了 + 翻译没反应"。
 *
 * 断言（改前 1/2/3/4 全挂，改后 6 项全过）：
 *   1. 自动聚焦页：图标出现（`display:flex`）
 *   2. 自动聚焦页：Ctrl+X 把译文写进剪贴板，且原输入框内容没被动过
 *   3. shadow DOM 页：图标出现
 *   4. shadow DOM 页：Ctrl+X 把译文写进剪贴板，原输入框内容没被剪走
 *   5. 焦点不在可翻译元素上时，Ctrl+X **不接管**（剪贴板保持哨兵值）
 *   6. 普通输入框回归：图标照旧出现
 *
 * 用法：node tools/verify/verify-translate-focus.mjs
 * 改前对照：`PROBE_DIST=tmp/verify-focus-dist-before node tools/verify/verify-translate-focus.mjs`
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const TMP = path.join(ROOT, 'tmp');

const fails = [];
function check(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
  } else {
    console.log(`  FAIL ${name}${detail ? ` —— ${detail}` : ''}`);
    fails.push(name);
  }
}

function findPwChromium() {
  const mp = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  const dirs = fs.readdirSync(mp).filter((d) => /^chromium/i.test(d)).sort().reverse();
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

const CHROME = findPwChromium();
if (!CHROME) {
  console.error('找不到 playwright chromium（先跑一次其他 browser 用例让它落盘）');
  process.exit(1);
}

const PAGE_AUTO = `<!doctype html><meta charset="utf-8"><title>auto</title>
<body style="padding:40px;font:16px sans-serif">
<input id="auto" value="你好世界" style="width:320px;height:34px">
<script>document.getElementById('auto').focus();</script>`;

const PAGE_SHADOW = `<!doctype html><meta charset="utf-8"><title>shadow</title>
<body style="padding:40px;font:16px sans-serif">
<div id="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({mode:'open'});
  root.innerHTML = '<input value="你好世界" style="width:320px;height:34px">';
</script>`;

const PAGE_PLAIN = `<!doctype html><meta charset="utf-8"><title>plain</title>
<body style="padding:40px;font:16px sans-serif">
<input id="plain" value="你好世界" style="width:320px;height:34px">
<button id="btn" style="margin-left:12px">按钮</button>`;

const HTML = { '/auto': PAGE_AUTO, '/shadow': PAGE_SHADOW, '/plain': PAGE_PLAIN };
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(HTML[req.url ?? ''] ?? PAGE_PLAIN);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// 被测构建：默认 dist；PROBE_DIST 可指向"改前"的另一份产物（同样要打 host_permissions 补丁）
const SRC = process.env.PROBE_DIST ? path.resolve(ROOT, process.env.PROBE_DIST) : DIST;
const PATCHED = path.join(TMP, 'verify-focus-dist');
fs.rmSync(PATCHED, { recursive: true, force: true });
fs.cpSync(SRC, PATCHED, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(PATCHED, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['*://*/*'];
fs.writeFileSync(path.join(PATCHED, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const EXT_ID = extensionIdFromKey(manifest.key);

const profile = fs.mkdtempSync(path.join(TMP, 'verify-focus-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: true,
  args: [
    `--disable-extensions-except=${PATCHED}`,
    `--load-extension=${PATCHED}`,
    '--no-first-run',
    '--disable-features=Translate',
  ],
});
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });

const iconState = (page) => page.evaluate(() => {
  const el = document.getElementById('ql_translate_icon');
  if (!el) return { exists: false };
  return { exists: true, display: getComputedStyle(el).display };
});
const readClip = (page) => page.evaluate(async () => {
  try { return await navigator.clipboard.readText(); } catch { return '__READ_ERR__'; }
});
const primeClip = (page, text) => page.evaluate(async (t) => {
  await navigator.clipboard.writeText(t);
}, text);

try {
  console.log(`dist = ${SRC}`);

  // ① 自动聚焦（页面在我们的 content script 注入之前就 focus 了输入框）
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/auto`);
    await page.waitForTimeout(1200);
    const st = await iconState(page);
    check('自动聚焦页出现图标', st.exists && st.display !== 'none', JSON.stringify(st));

    await primeClip(page, '__sentinel__');
    await page.keyboard.press('Control+x');
    await page.waitForTimeout(2500);
    const clip = await readClip(page);
    const value = await page.evaluate(() => document.getElementById('auto').value);
    check('自动聚焦页 Ctrl+X 写入译文', clip === 'hello world', `clip=${clip}`);
    check('自动聚焦页原输入未被改动', value === '你好世界', `value=${value}`);
    await page.close();
  }

  // ② shadow DOM 里的输入框
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/shadow`);
    await page.waitForTimeout(900);
    await page.evaluate(() => document.querySelector('#host').shadowRoot.querySelector('input').focus());
    await page.waitForTimeout(500);
    const st = await iconState(page);
    check('shadow 输入框出现图标', st.exists && st.display !== 'none', JSON.stringify(st));

    await primeClip(page, '__sentinel__');
    await page.keyboard.press('Control+x');
    await page.waitForTimeout(2500);
    const clip = await readClip(page);
    const value = await page.evaluate(() => document.querySelector('#host').shadowRoot.querySelector('input').value);
    check('shadow 输入框 Ctrl+X 写入译文', clip === 'hello world', `clip=${clip}`);
    check('shadow 输入框内容未被剪走', value === '你好世界', `value=${value}`);
    await page.close();
  }

  // ③ 焦点离开输入框后，Ctrl+X 不许再翻译上一个框
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/plain`);
    await page.waitForTimeout(900);
    await page.click('#plain');
    await page.waitForTimeout(300);
    await page.click('#btn');
    await page.waitForTimeout(400);
    await primeClip(page, '__sentinel__');
    await page.keyboard.press('Control+x');
    await page.waitForTimeout(1800);
    const clip = await readClip(page);
    check('焦点不在输入框时不接管 Ctrl+X', clip === '__sentinel__', `clip=${clip}`);
    await page.close();
  }

  // ④ 普通输入框回归
  {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/plain`);
    await page.waitForTimeout(900);
    await page.click('#plain');
    await page.waitForTimeout(400);
    const st = await iconState(page);
    check('普通输入框图标仍在（回归）', st.exists && st.display !== 'none', JSON.stringify(st));
    await page.close();
  }
} finally {
  await ctx.close().catch(() => undefined);
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log('');
if (fails.length) {
  console.log(`FAILED ${fails.length} 项：${fails.join(' / ')}`);
  process.exit(1);
}
console.log('全部通过');
