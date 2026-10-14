/**
 * 默认盒子的语义（2026-10-13 重写）。
 *
 * ## ★★ 换向：这一条判据此前验的是"默认盒**可以**改名"
 *
 * 旧版 D1：把默认盒改名成「我的主场」，然后断言账号卡片上的盒标签跟着变。
 * 而服务端 2026-10-13 起**默认盒名是常量「默认盒子」、改名一律 400**
 * （用户要求"默认盒锁死"）⇒ 那条断言指向的是一个**已被取消的能力**。
 *
 * ★ 本仓纪律：**功能被取消时判据必须换向**，否则它会一直为绿 —— 而它守的
 *   是一个不存在的东西（先例：侧边栏折叠那 8 条）。
 * ★ 更要紧的是：旧版那条路是**本地**改 `ql:defaultBox`，它**看起来成功了**，
 *   而服务端仍叫「默认盒子」⇒ 上下行两个方向的默认盒翻译口径
 *   （`uploadBoxName` / `toAccount`：等于默认盒名 ⇒ 翻译成空串）从此对不上，
 *   账号会被归到一个**字面量同名的新盒**里。那比"失败"隐蔽得多。
 *
 * ## 两段
 *
 * | 段 | 何时跑 | 验什么 |
 * |---|---|---|
 * | **结构段** | **永远**（不需要会话） | 默认盒在任何地方都**没有改名入口**：芯片上无行内操作、台账里离线不给按钮 |
 * | **流程段** | 仅当 `AKSO_BOX_LIVE=1` **且**有云端会话 | ① **改名被拒**（`par.renameBox` 回 ok=false 且文案说清"不能改名"）② 未归盒账号计入默认盒 ③ 冷启持久化 ④ 轮盘 Hub 显示默认盒名 |
 *
 * ★ 流程段要显式开启：它会在用户**真实的云端账号库**里建账号（`par.create`）。
 *
 * 用法：
 *     node tools/verify/verify-defbox.mjs                            # 结构段
 *     $env:AKSO_BOX_LIVE='1'; node tools/verify/verify-defbox.mjs    # 结构 + 流程
 */
import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const LIVE = process.env.AKSO_BOX_LIVE === '1';

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

let bad = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const fail = (m) => { console.log(`  FAIL ${m}`); bad += 1; };
const skip = (m) => console.log(`  SKIP ${m}`);

const manifest = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.json'), 'utf8'));
const extId = extensionIdFromKey(manifest.key);
const profile = path.join(ROOT, 'tmp', 'ui-defbox-profile');
try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* */ }

const ctx = await chromium.launchPersistentContext(profile, {
  executablePath: findPwChromium(),
  headless: true,
  args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`, '--no-first-run'],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${extId}/ui/parallel/parallel.html`);
await page.waitForTimeout(900);

/* ==================== 结构段（永远跑） ==================== */
console.log('=== 结构段：默认盒没有任何改名入口 ===');
const structure = await page.evaluate(() => {
  const chipActs = document.querySelectorAll('#box-chips .chip-act').length;
  const chipAdd = document.querySelectorAll('#box-chips .chip-add').length;
  const rows = [...document.querySelectorAll('#box-list li')];
  return {
    chipActs,
    chipAdd,
    ledgerButtons: rows.reduce((n, r) => n + r.querySelectorAll('.site-actions button').length, 0),
    // 页面上**任何**写着"改名"的可点元素都算入口（不只是芯片那一条路）
    renameEntries: [...document.querySelectorAll('button, .chip-act')]
      .filter((el) => (el.textContent ?? '').includes('改名')).length,
  };
});
console.log(`     芯片行内操作=${structure.chipActs} 新建盒子芯片=${structure.chipAdd} 台账按钮=${structure.ledgerButtons} 改名入口=${structure.renameEntries}`);
if (structure.chipActs === 0 && structure.renameEntries === 0) {
  ok('没有任何"改名"入口（默认盒此前那条本地改名路已删除）');
} else {
  fail(`页面上还能找到改名入口（chip-act=${structure.chipActs}, 文本含"改名"=${structure.renameEntries}）`);
}
if (structure.ledgerButtons === 0) ok('离线时台账不给任何操作按钮（改名/禁用/删除都要打到云端）');
else fail(`离线时台账画出了 ${structure.ledgerButtons} 个按钮`);

/* ==================== 流程段（要显式开启 + 有会话） ==================== */
console.log('\n=== 流程段：默认盒语义（走真实云端） ===');
const state = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'cloud.state' }).catch(() => null));
const authorized = Boolean(state?.result?.ok && state.result.data?.authorized);
if (!LIVE) {
  skip('未开启 —— 它会在**用户真实的云端账号库**里建账号，所以默认不跑');
  skip("要跑：$env:AKSO_BOX_LIVE='1'; node tools/verify/verify-defbox.mjs");
} else if (!authorized) {
  skip('没有云端会话（先在管理页点「重新登录」）');
} else {
  /* ---- D1（换向后）：**默认盒改名必须被拒** ---- */
  const boxes = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.boxes' }).catch(() => null));
  const defName = boxes?.result?.ok ? boxes.result.data?.default : '';
  if (!defName) {
    fail('拿不到默认盒名（par.boxes 没答复）');
  } else {
    const res = await page.evaluate((n) => chrome.runtime.sendMessage({ kind: 'par.renameBox', from: n, to: '我的主场' }), defName);
    const msg = res?.result?.ok === false ? String(res.result.error) : '';
    console.log(`     D1 改名「${defName}」→「我的主场」：ok=${res?.result?.ok} error=${msg}`);
    if (res?.result?.ok === false && msg.includes('不能改名')) {
      ok('默认盒改名被拒，且错误文案说清了原因（"不能改名"）');
    } else {
      fail('默认盒改名**没有**被拒 —— 这一条是"默认盒锁死"的核心');
    }
  }

  /* ---- D2：新建账号（不带 box）→ 落入默认盒 ---- */
  const created = await page.evaluate((idx) => chrome.runtime.sendMessage({
    kind: 'par.create', siteHost: 'example.com', tabName: `验收号${idx}`, username: `defbox${idx}`, password: 'p', open: false,
  }), Date.now() % 10000);
  if (!created?.result?.ok) {
    fail(`建号失败：${JSON.stringify(created)?.slice(0, 160)}`);
  } else {
    await page.reload();
    await page.waitForTimeout(1200);
    const tags = await page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
    console.log(`     D2 账号盒标签: ${tags.join(',')}`);
    if (tags.includes(defName)) ok('未归盒账号显示为默认盒名（上传时翻译成空串的那一条口径）');
    else fail(`账号的盒标签里没有默认盒名「${defName}」`);

    /* ---- D3：冷启持久化 ---- */
    await page.reload();
    await page.waitForTimeout(1200);
    const tags2 = await page.evaluate(() => [...document.querySelectorAll('#browser-list .box-tag')].map((t) => t.textContent));
    if (tags2.join(',') === tags.join(',')) ok('冷启后一致（默认盒名来自云端，不再依赖本地那个键）');
    else fail(`冷启后变了：${tags.join(',')} → ${tags2.join(',')}`);

    /* ---- D4：轮盘 Hub 显示默认盒名 ---- */
    const wheelPage = await ctx.newPage();
    await wheelPage.goto(`chrome-extension://${extId}/ui/wheel/wheel.html`);
    await wheelPage.waitForTimeout(1200);
    const hub = await wheelPage.evaluate(() => document.querySelector('.hub-box')?.textContent ?? '');
    console.log(`     D4 轮盘 Hub: ${hub}`);
    if (hub.includes(defName)) ok('轮盘 Hub 显示的是云端默认盒名');
    else fail(`轮盘 Hub=${hub} 里没有「${defName}」`);

    /* ---- 清理：把验收账号删掉（不留痕） ---- */
    const list = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'par.list' }).catch(() => null));
    const mine = (list?.result?.ok ? list.result.data : []).filter((a) => String(a.username).startsWith('defbox'));
    for (const a of mine) {
      await page.evaluate((id) => chrome.runtime.sendMessage({ kind: 'par.delete', id }), a.id);
    }
    console.log(`     清理：删掉 ${mine.length} 个验收账号`);
  }
}

await ctx.close();
console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
