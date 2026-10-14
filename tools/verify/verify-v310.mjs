/** v3.10.0 全量验证：Bug1 广播隔离 / Bug2+F2 轮盘规则 / F1 节点标签 / F3 删除弹窗 / F4 导出导入 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
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
const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const profile = path.join(ROOT, 'tmp', 'ui-v310-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(800);

/* ★★ 2026-10-13：**会话闸门**。
 *
 * 本脚本整篇都建立在"能造账号"之上，而它用的是 `par.create`（打到云端）。
 * v3.18（2026-10-09）废除本地数据源之后，**没有云端会话时那些 create 全部失败**
 * ⇒ 脚本会一路走到 `wheelSnap()` 才崩（`document.querySelector('.sector-svg')` 为 null，
 * 因为一个账号都没有）。
 *
 * ★ 为什么必须显式说清楚：那次崩溃**看起来像"这次改动弄坏了它"** ——
 *   而它与改动无关。本仓反复记的那条"归因错误比失败更贵"说的就是这个形状。
 * ⇒ 现在没会话时**明确 SKIP 并退出 0**，而不是给一个看不懂的 TypeError。
 *   （`verify-boxmgmt` / `verify-defbox` 已经重写成"结构段永远跑"的双段式，
 *     本脚本没有不依赖会话的部分，所以整篇 SKIP。）
 */
const cloudState = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'cloud.state' }).catch(() => null));
if (!(cloudState?.result?.ok && cloudState.result.data?.authorized)) {
  console.log('SKIP v310 需要云端会话（本脚本靠 par.create 造账号，而账号现在只存在于云端）');
  console.log('     先在管理页点「重新登录」，再跑本脚本。');
  await ctx.close();
  process.exit(0);
}

const diag = () => page.evaluate(() => chrome.runtime.sendMessage({ kind: 'ql.diag' }));
const bindingsOf = async () => (await diag())?.result?.data?.parallel?.bindings ?? [];
const listAccounts = async () => (await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.list' })))?.result?.data ?? [];

/* ===== B1: BroadcastChannel 跨账号隔离 ===== */
const mk = async (name, box) => (await page.evaluate(({ name, box }) => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: name, username: name, password: 'p', open: true, box }), { name, box }))?.result?.data?.id;
const acc1 = await mk('A1', '开发组');
await page.waitForTimeout(1200);
// acc1 第二个页签（forceNewTab）
await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.open', id, forceNewTab: true }), acc1);
await page.waitForTimeout(1500);
const acc2 = await mk('A2', '开发组');
await page.waitForTimeout(1500);
const pages = ctx.pages().filter((p) => p.url().includes('example.com'));
console.log(`B1 准备: 绑定=${JSON.stringify(await bindingsOf())} example页签数=${pages.length}`);
if (pages.length < 3) { console.log('B1 页签不足，跳过'); } else {
  // A1-t1 与 A1-t2 同账号：应互通；A2-t 不同账号：应隔离
  const t1 = pages[0], t2 = pages[1], t3 = pages[2];
  await t1.evaluate(() => { const c = new BroadcastChannel('ql-iso-test'); c.onmessage = (e) => { window.__bcRecv = (window.__bcRecv || []); window.__bcRecv.push(e.data); }; window.__bc = c; });
  await t2.evaluate(() => { const c = new BroadcastChannel('ql-iso-test'); c.postMessage('from-same-acc'); });
  await t3.evaluate(() => { const c = new BroadcastChannel('ql-iso-test'); c.postMessage('from-other-acc'); });
  await page.waitForTimeout(500);
  const recv = await t1.evaluate(() => window.__bcRecv ?? []);
  console.log(`B1 t1 收到: ${JSON.stringify(recv)}`);
  console.log(`B1 同账号互通+跨账号隔离: ${JSON.stringify(recv) === '["from-same-acc"]' ? '✔' : '✖'}`);
}

/* ===== B2+F2+F1: 轮盘页面规则 + 节点标签 ===== */
// 布局：开发组有 acc1/acc2；建 空盒「测试盒」；禁用盒「封存盒」有 1 账号；默认盒当前空
await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'Z1', username: 'z1', password: 'p', open: false, box: '封存盒' }));
await page.evaluate(() => chrome.storage.local.set({ 'ql:boxes': ['测试盒', '封存盒'], 'ql:disabledBoxes': ['封存盒'] }));
await page.reload();
await page.waitForTimeout(1000);
const wheelPage = await ctx.newPage();
await wheelPage.goto(`chrome-extension://${extId}/ui/wheel/wheel.html`);
await wheelPage.waitForTimeout(1200);
const wheelSnap = () => wheelPage.evaluate(() => {
  const svg = document.querySelector('.sector-svg');
  return {
    nodes: svg.querySelectorAll('.box-node').length,
    labels: [...svg.querySelectorAll('.box-node-label')].map((t) => t.textContent),
    hub: document.querySelector('.hub-box')?.textContent ?? '',
  };
});
let w = await wheelSnap();
console.log(`W1 节点=${w.nodes} (期望2: 开发组+测试盒; 默认盒空自动禁用/封存盒手动禁用) → ${w.nodes === 2 ? '✔' : '✖'}`);
console.log(`W1 标签=${JSON.stringify(w.labels)} → ${w.labels.length === 1 && w.labels[0] === '开发组' ? '✔' : '✖'}`);
// 加一个未归盒账号 → 默认盒解禁出现
await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.create', siteHost: 'example.com', tabName: 'D0', username: 'd0', password: 'p', open: false }));
await page.waitForTimeout(3500);
w = await wheelSnap();
console.log(`W2 默认盒有账号后节点=${w.nodes} (期望3) → ${w.nodes === 3 ? '✔' : '✖'}`);
// 解禁封存盒 → 出现（有账号）；再验证禁用盒跳过切换: 直接看 nodes
await page.evaluate(() => chrome.storage.local.set({ 'ql:disabledBoxes': [] }));
await page.waitForTimeout(3500);
w = await wheelSnap();
console.log(`W3 封存盒解禁后节点=${w.nodes} (期望4) → ${w.nodes === 4 ? '✔' : '✖'}`);

/* ===== F3: 删除盒子两步弹窗 ===== */
await page.reload();
await page.waitForTimeout(1000);
// 删除「封存盒」（1 账号）：第一步确认=接受，第二步=取消（归默认盒）
const answers = [true, false];
page.on('dialog', (d) => { const a = answers.shift(); if (a) { void d.accept(); } else { void d.dismiss(); } });
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.querySelector('span')?.textContent === '封存盒');
  chip.querySelector('.chip-act-del').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1500);
const afterMove = await listAccounts();
const z1 = afterMove.find((a) => a.tabName === 'Z1');
console.log(`F3 两步取消路径: Z1 归默认盒=${z1 && !z1.box ? '✔' : '✖'} (box=${JSON.stringify(z1?.box)})`);
// 再删「测试盒」（空盒）: 单确认
await page.evaluate(() => {
  const chip = [...document.querySelectorAll('#box-chips .chip')].find((c) => c.querySelector('span')?.textContent === '测试盒');
  chip.querySelector('.chip-act-del').dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForTimeout(1200);

/* ===== F4: 导出/导入 ===== */
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }),
  page.evaluate(() => document.getElementById('data-export').click()),
]);
const exportPath = path.join(ROOT, 'tmp', 'export-roundtrip.json');
await download.saveAs(exportPath);
const backup = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
console.log(`F4 导出: format=${backup.format} v${backup.version} 账号=${backup.accounts.length} 种子=${backup.cryptoSeed ? '有' : '无'}`);
console.log(`F4 导出结构: ${backup.format === 'quicklogin-backup' && backup.cryptoSeed && backup.accounts.length >= 4 ? '✔' : '✖'}`);
// 用导出的种子按扩展加密格式新造一条账号（PBKDF2→AES-GCM），导入应 created=1
const subtle = globalThis.crypto.subtle;
const te = new TextEncoder();
const km = await subtle.importKey('raw', te.encode(backup.cryptoSeed), { name: 'PBKDF2' }, false, ['deriveKey']);
const key = await subtle.deriveKey({ name: 'PBKDF2', salt: te.encode('sessionbox-salt-v1'), iterations: 100000, hash: 'SHA-256' }, km, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const enc = async (text) => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(text));
  const b64 = (buf) => Buffer.from(buf).toString('base64');
  return { enc: b64(ct), iv: b64(iv) };
};
const u = await enc('d0-imported');
const p = await enc('p');
backup.accounts.push({ siteHost: 'example.com', tabName: 'D0-imported', credentials: { encryptedUsername: u.enc, encryptedPassword: p.enc, iv: u.iv, ivPassword: p.iv } });
backup.sites = []; // 避免权限弹窗
fs.writeFileSync(exportPath, JSON.stringify(backup));
const before = (await listAccounts()).length;
answers.push(true); // 导入确认弹窗 = 接受
await page.setInputFiles('#data-import-file', exportPath);
await page.waitForTimeout(2500);
const after = (await listAccounts()).length;
console.log(`F4 导入: 账号 ${before} → ${after} (期望+1) → ${after === before + 1 ? '✔' : '✖'}`);

await ctx.close();
