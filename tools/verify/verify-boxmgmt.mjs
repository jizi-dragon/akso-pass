/**
 * 盒子管理：**账号页只筛选 + 「盒子管理」台账**（2026-10-13 重写）。
 *
 * ## 一、为什么重写：判据指向的功能已经被取消了
 *
 * 旧版（v3.9.2）断言的是"芯片上悬停出现 ✎ 改名 / ✕ 删除 两个行内操作"。
 * 用户 2026-10-13 的要求是：「在账号处，就可以不需要编辑，更名和删除的功能了」
 * ⇒ 那三个行内操作（改名 / 禁用启用 / 删除）与「＋ 新建盒子」**一起搬进了
 *   「盒子管理」面板**。旧断言从此在验一个**不存在的东西**。
 *
 * ★ 本仓纪律：**功能被取消时，判据必须换向**（先例：侧边栏折叠那 8 条）。
 *   不换向的后果不是"红"，而是**继续为绿** —— 它占着"这里验过了"的位置。
 *
 * ## 二、顺带修掉一处更安静的缺陷：这个脚本**从 v3.18 起就跑不动了**
 *
 * 它靠 `par.create` 造账号，而 v3.18（2026-10-09）整体废除了本地数据源
 * ⇒ 没有云端会话时那几条 create 全部失败（`云端未授权：请先在管理页点「重新登录」`），
 *   脚本在 R1 处**抛异常崩掉**。
 * ★ 崩溃的形状看起来像"这次改动弄坏了它"，而它与改动无关 ——
 *   这正是本仓反复记的"归因错误比失败更贵"。
 *
 * ## 三、现在的结构：两段
 *
 * | 段 | 何时跑 | 验什么 |
 * |---|---|---|
 * | **结构段** | **永远**（不需要会话） | 这次改动的形状：芯片无行内操作 / 台账面板在 / 表单控件在 / 离线时不给操作按钮 |
 * | **流程段** | 仅当 `AKSO_BOX_LIVE=1` **且**有云端会话 | 建盒 → 禁用 → 改名 → 删除，真的走一遍云端 |
 *
 * ★★ 流程段为什么要**显式开启**：它会**碰用户真实的云端账号库**（建盒/删盒）。
 *   本脚本以前这么干是因为当时数据在本机；现在账号库在云上、是生产数据
 *   ⇒ 默认只跑结构段，流程段要人主动按开关。
 *
 * 用法：
 *     node tools/verify/verify-boxmgmt.mjs                            # 结构段
 *     $env:AKSO_BOX_LIVE='1'; node tools/verify/verify-boxmgmt.mjs    # 结构 + 流程
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
const profile = path.join(ROOT, 'tmp', 'ui-boxmgmt-profile');
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
console.log('=== 结构段 ① 芯片上不再有任何行内操作 ===');
const chips = await page.evaluate(() => ({
  acts: document.querySelectorAll('#box-chips .chip-act').length,
  add: document.querySelectorAll('#box-chips .chip-add').length,
  names: [...document.querySelectorAll('#box-chips .chip span:first-child')].map((s) => s.textContent),
}));
console.log(`     芯片: ${chips.names.join(' | ')}`);
if (chips.acts === 0) ok('芯片上没有 .chip-act（改名/禁用/删除三个行内操作已搬走）');
else fail(`芯片上还有 ${chips.acts} 个 .chip-act —— 用户要求撤掉`);
if (chips.add === 0) ok('芯片上没有「＋ 新建盒子」（已搬进台账）');
else fail('芯片上还有 .chip-add');
if (chips.names[0] === '全部') ok('「全部」仍在（这一排的用途是筛选，不是管理）');
else fail(`第一个芯片不是「全部」而是 ${chips.names[0]}`);

console.log('\n=== 结构段 ② 「盒子管理」面板与表单在，且点得开 ===');
const panel = await page.evaluate(() => ({
  tab: Boolean(document.querySelector('.tabs .tab[data-tab="boxes"]')),
  pane: Boolean(document.getElementById('pane-boxes')),
  form: Boolean(document.getElementById('box-form')),
  name: Boolean(document.getElementById('b-name')),
  site: Boolean(document.getElementById('b-site')),
  list: Boolean(document.getElementById('box-list')),
  tabs: [...document.querySelectorAll('.tabs .tab')].map((t) => t.dataset.tab),
}));
console.log(`     页签: ${panel.tabs.join(' | ')}`);
for (const k of ['tab', 'pane', 'form', 'name', 'site', 'list']) {
  if (panel[k]) ok(`存在：${k}`);
  else fail(`缺：${k}`);
}
/*
 * ★ 用**合成点击**（`el.click()`）而不是 Playwright 的真实点击：
 *   未登录时整块被 `#login-mask` 盖住（那是**指针**层面的锁），
 *   而这里要验的是"页签的接线通不通" —— 合成点击照样走真的监听器。
 *   真实点击留给流程段（那里有会话，遮罩不在）。
 */
await page.evaluate(() => document.querySelector('.tabs .tab[data-tab="boxes"]')?.click());
await page.waitForTimeout(300);
const shown = await page.evaluate(() => {
  const p = document.getElementById('pane-boxes');
  return { hidden: p?.hidden === true, activeTab: document.querySelector('.tabs .tab.is-active')?.dataset.tab };
});
if (!shown.hidden && shown.activeTab === 'boxes') ok('点页签能切到「盒子管理」（面板真的显示出来）');
else fail(`页签切不过去：hidden=${shown.hidden} activeTab=${shown.activeTab}`);

console.log('\n=== 结构段 ③ 离线（无云端会话）时不给操作按钮 ===');
const offline = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#box-list li')];
  return {
    rows: rows.length,
    buttons: rows.reduce((n, r) => n + r.querySelectorAll('.site-actions button').length, 0),
    text: rows.map((r) => r.textContent.trim()).join(' / ').slice(0, 140),
  };
});
console.log(`     台账行=${offline.rows}  按钮=${offline.buttons}`);
console.log(`     文本=${offline.text}`);
if (offline.buttons === 0) ok('没有操作按钮 —— 每个操作都要打到云端，离线时给了也点不动');
else fail(`离线时画出了 ${offline.buttons} 个按钮（点了必然失败，而那不是用户的错）`);

console.log('\n=== 结构段 ④ 关联站点是**选择列表**，不是让用户记序号 ===');
const picker = await page.evaluate(() => ({
  modal: Boolean(document.getElementById('site-modal')),
  list: Boolean(document.getElementById('site-modal-list')),
  inputs: document.querySelectorAll('#site-modal input').length,
}));
if (picker.modal) ok('存在 #site-modal 弹层');
else fail('缺 #site-modal —— 关联站点没有选择列表');
if (picker.list) ok('存在 #site-modal-list 列表容器');
else fail('缺 #site-modal-list');
if (picker.inputs === 0) ok('选择弹层里没有输入框（用户不必手输序号/站点）');
else fail(`选择弹层里有 ${picker.inputs} 个输入框 ⇒ 仍然要求用户输入`);
const built = fs.readFileSync(path.join(DIST, 'ui', 'parallel', 'parallel.js'), 'utf8');
if (built.includes('bindSitePicker') && !built.includes('输入序号')) {
  ok('构建产物走 bindSitePicker，旧「输入序号」文案已清');
} else {
  fail('构建产物里仍找不到 bindSitePicker，或还残留「输入序号」文案');
}

/* ==================== 流程段（要显式开启 + 有会话） ==================== */
console.log('\n=== 流程段：建盒 / 禁用 / 改名 / 删除（走真实云端） ===');
const state = await page.evaluate(() => chrome.runtime.sendMessage({ kind: 'cloud.state' }).catch(() => null));
const authorized = Boolean(state?.result?.ok && state.result.data?.authorized);
if (!LIVE) {
  skip('未开启 —— 它会改**用户真实的云端账号库**（建盒/删盒），所以默认不跑');
  skip("要跑：$env:AKSO_BOX_LIVE='1'; node tools/verify/verify-boxmgmt.mjs");
} else if (!authorized) {
  skip('没有云端会话（先在管理页点「重新登录」）');
} else {
  const stamp = `验证盒${Date.now() % 100000}`;
  const ledger = () => page.evaluate(() => [...document.querySelectorAll('#box-list li')].map((r) => ({
    name: r.querySelector('.site-card-name')?.textContent ?? '',
    actions: [...r.querySelectorAll('.site-actions button')].map((b) => b.textContent),
    fixed: r.querySelector('.site-actions .muted')?.textContent ?? '',
  })));
  const clickRow = (name, label) => page.evaluate(({ n, l }) => {
    const row = [...document.querySelectorAll('#box-list li')]
      .find((r) => r.querySelector('.site-card-name')?.textContent === n);
    [...(row?.querySelectorAll('.site-actions button') ?? [])].find((b) => b.textContent === l)?.click();
  }, { n: name, l: label });

  // ① 建盒（表单提交 → par.createBox → POST /api/boxes）
  //    ★ 走 `requestSubmit()` 而不是 Playwright 的 `fill` + 真实点击：
  //      前者触发的是**真的 submit 事件**（与用户按按钮同一条路），
  //      而且不受遮罩/可见性影响。
  await page.evaluate((n) => {
    const input = document.getElementById('b-name');
    input.value = n;
    document.getElementById('box-form').requestSubmit();
  }, stamp);
  await page.waitForTimeout(1600);
  let rows = await ledger();
  const mine = rows.find((r) => r.name === stamp);
  if (mine) ok(`新建的盒子出现在台账里：「${stamp}」操作=[${mine.actions.join(',')}]`);
  else fail(`新建的盒子没出现在台账里：${JSON.stringify(rows)}`);

  // ② 默认盒那一行必须**只有**「固定」、没有任何按钮
  //    （服务端的 renameable / deletable / bindable 三个都是 false）
  const def = rows.find((r) => r.fixed === '固定');
  if (def && def.actions.length === 0) ok('默认盒那一行没有任何操作按钮（只有「固定」标记）');
  else fail(`默认盒那一行的操作=${JSON.stringify(def?.actions)} —— 它不该有可点的按钮`);

  if (mine) {
    // ③ 禁用 → 按钮变「启用」、芯片变灰（两处口径必须一致）
    await clickRow(stamp, '禁用');
    await page.waitForTimeout(1700);
    rows = await ledger();
    const after = rows.find((r) => r.name === stamp);
    if (after?.actions.includes('启用')) ok('禁用后按钮变成「启用」（状态来自云端）');
    else fail(`禁用后按钮=${JSON.stringify(after?.actions)}`);
    const chipOff = await page.evaluate((n) => {
      const c = [...document.querySelectorAll('#box-chips .chip')].find((x) => x.querySelector('span')?.textContent === n);
      return c ? c.classList.contains('chip-off') : null;
    }, stamp);
    if (chipOff) ok('芯片同步变灰（chip-off）—— 台账与芯片读的是同一份云端状态');
    else fail('芯片没有跟着变灰 —— 两处口径不一致');

    // ④ 改名（dialog 里填新名）
    const renamed = `${stamp}改`;
    page.once('dialog', (d) => d.accept(renamed));
    await clickRow(stamp, '改名');
    await page.waitForTimeout(1700);
    rows = await ledger();
    if (rows.some((r) => r.name === renamed)) ok(`改名成功：「${stamp}」→「${renamed}」`);
    else fail(`改名后台账里没有「${renamed}」`);

    // ⑤ 删除（空盒 ⇒ 只有一次 confirm）
    page.once('dialog', (d) => d.accept());
    await clickRow(renamed, '删除');
    await page.waitForTimeout(1700);
    rows = await ledger();
    if (!rows.some((r) => r.name === renamed || r.name === stamp)) ok('删除成功（台账里已消失）');
    else fail('删了但台账里还在');
  }
}

await ctx.close();
console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
