/**
 * 定尺网格（三个轮盘共用）的回归判据 —— v4.1.2。
 *
 *     node tools/verify/verify-acct-grid.mjs        # 真起 Chromium，约 15 秒
 *
 * ## 它防的四类事（全部来自真实缺陷）
 *
 * | # | 症状 | 判据 |
 * |---|---|---|
 * | 1 | **静默丢项**：`WHEEL_MAX = 10` / `slice(0, 10)`，超出直接丢弃（Hub 只写一行"仅显示前 10 个"） | 18 项必须渲染 **18 格**；26 项必须**全部进 DOM** |
 * | 2 | **文字随位置倾斜**：径向标签沿切线 `rotate()`，左半侧再翻 180° | 断言网格里**零旋转** |
 * | 3 | ★★ **空页死角**：滚轮守卫写成"这一页有没有内容" ⇒ 切到**空盒子**后滚轮失效，**用户被困住** | `wheelIntent()` 的**纯函数**判据：空页、不足一屏、滚到边界 ⇒ 都必须返回 `'page'` |
 * | 4 | **样式两处维护**：网格要给 4 个表面用，小窗用 `<link>`、浮层只能内联 ⇒ 各写一份必漂 | ① 构建产物 `acct-grid.css` 与 `grid-style.ts` 的常量**逐字节一致** ② 三个浮层都引用**共用常量**（不是各抄一份） |
 *
 * ★ 第 1 条只能靠**计数**：截图里少 8 个账号，人眼不一定数得出来（它们本来被排成环形）。
 * ★ 第 3 条只能靠**纯函数**：它是个"边界判定"，真机里要制造空盒子 + 滚轮事件才能复现，
 *   而拿合成数据直接调它既快又准（真机那条另在 ③-运行期 里用事件验一次）。
 */
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripComments } from './_lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'packages/extension/src');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); bad++; };

console.log('=== 前提 ===');
if (!existsSync(path.join(DIST, 'manifest.json'))) {
  console.error('  ✗ 缺少 dist/manifest.json —— 请先 `npm run build`');
  process.exit(2);
}
ok('dist/manifest.json 存在（跑前必须 npm run build）');

/* ══════════════ ① 源码：不得再有硬截断、环形原语 ══════════════ */
// ★★ 必须**剥注释**：删除说明里会逐字写出被删掉的名字（规则 23/24、PITFALLS #35）。
console.log('\n=== ① 源码：无硬截断、无环形残留 ===');
const code = (rel) => stripComments(readFileSync(path.join(SRC, rel), 'utf8'));
const gridSrc = code('ui/wheel/grid-core.ts');
const itemSrc = code('ui/wheel/item-grid.ts');
const coreSrc = code('ui/wheel/wheel-core.ts');

if (/\.slice\(0,\s*(?:GRID_SLOTS|KEY_MAX|WHEEL_MAX|10)\s*\)/.test(gridSrc + itemSrc)) {
  fail('网格里仍在对项目列表做 slice(0, N) —— 那就是"静默丢项"');
} else {
  ok('网格不对项目列表做 slice（不截断）');
}
if (/WHEEL_MAX|buildSectorWheel|buildRingWheel/.test(coreSrc + gridSrc + itemSrc)) {
  fail('wheel-core/grid-core/item-grid 里仍有旧渲染器的名字');
} else {
  ok('环形渲染器（buildSectorWheel / buildRingWheel）已全部删除');
}
for (const [name, re] of [
  ['polar(', /\bpolar\s*\(/],
  ['radialText(', /\bradialText\s*\(/],
  ['sectorPath(', /\bsectorPath\s*\(/],
]) {
  // 几何原语若还在，会让人以为"还有地方在画环"（PITFALLS #19 的形态）
  const hits = readdirSync(path.join(SRC, 'ui/wheel'))
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => re.test(stripComments(readFileSync(path.join(SRC, 'ui/wheel', f), 'utf8'))));
  if (hits.length) {
    fail(`径向原语 ${name} 仍在 ${hits.join(', ')} —— 已无使用者，应删除`);
  } else {
    ok(`径向原语 ${name} 已清除`);
  }
}

/* ══════════════ ② 样式：唯一源 + 构建产物一致 ══════════════ */
console.log('\n=== ② 样式：唯一源，且构建产物与它逐字节一致 ===');
const styleSrc = readFileSync(path.join(SRC, 'ui/wheel/grid-style.ts'), 'utf8');
const generated = readFileSync(path.join(SRC, 'ui/wheel/acct-grid.css'), 'utf8');
const inDist = readFileSync(path.join(DIST, 'ui/wheel/acct-grid.css'), 'utf8');

// 从 grid-style.ts 里取出 ACCT_GRID_CSS 的模板串内容（不剥注释：CSS 注释是内容的一部分）
const m = /export const ACCT_GRID_CSS = `([\s\S]*?)`;\n/.exec(styleSrc);
if (!m) {
  fail('grid-style.ts 里找不到 ACCT_GRID_CSS 模板串');
} else if (m[1] !== generated) {
  fail('生成的 src/ui/wheel/acct-grid.css 与 grid-style.ts 的常量不一致 —— 跑一次 npm run build');
} else {
  ok('acct-grid.css == grid-style.ts 的 ACCT_GRID_CSS（唯一源，逐字节一致）');
}
if (inDist === generated) {
  ok('dist/ui/wheel/acct-grid.css 与源一致（小窗 <link> 拿到的就是这份）');
} else {
  fail('dist 里的 acct-grid.css 与源不一致 —— 没构建或构建漏拷');
}

// 三个浮层必须**引用共用常量**，而不是各抄一份 CSS
const overlays = ['wheel-overlay.ts', 'status-overlay.ts', 'favorites-overlay.ts'];
for (const f of overlays) {
  const t = readFileSync(path.join(SRC, 'content', f), 'utf8');
  if (!/style\.textContent\s*=\s*ACCT_GRID_CSS\s*\+\s*OVERLAY_CHROME_CSS/.test(t)) {
    fail(`${f} 没有用共用常量注入样式 —— Shadow DOM 拿不到 <link>，会变成没样式且不报错`);
  } else if (/\.ag-grid\s*\{/.test(t)) {
    fail(`${f} 里又出现了一份内联 .ag-grid —— 样式源又分叉了`);
  } else {
    ok(`${f} 引用共用常量（无第二份样式）`);
  }
}

/* ══════════════ ③ wheelIntent：空页/边界必须能切页（纯函数） ══════════════ */
console.log('\n=== ③ 滚轮意图：空页与边界都必须能切页（纯函数）===');
{
  const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
  const outfile = path.join(ROOT, 'tmp', 'item-grid-under-test.mjs');
  await build({
    entryPoints: [path.join(SRC, 'ui/wheel/item-grid.ts')],
    outfile, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);

  /** 造一个假 grid（只需要 scrollHeight/clientHeight/scrollTop 三个数） */
  const fake = (scrollHeight, clientHeight, scrollTop) => ({ scrollHeight, clientHeight, scrollTop });

  const cases = [
    ['空页（内容 0、可视 300）', 1, fake(0, 300, 0), 'page'],
    ['不足一屏（200 / 300）', 1, fake(200, 300, 0), 'page'],
    ['可滚且在中段（向下）', 1, fake(600, 300, 100), 'scroll'],
    ['可滚且在中段（向上）', -1, fake(600, 300, 100), 'scroll'],
    ['已滚到底（向下）⇒ 该切页', 1, fake(600, 300, 300), 'page'],
    ['已滚到顶（向上）⇒ 该切页', -1, fake(600, 300, 0), 'page'],
    ['没有 grid 元素', 1, null, 'page'],
  ];
  let mismatched = 0;
  for (const [label, dir, g, want] of cases) {
    const got = mod.wheelIntent(dir, g);
    if (got !== want) {
      fail(`${label}：期望 ${want}，实际 ${got}`);
      mismatched++;
    }
  }
  if (!mismatched) {
    ok(`${cases.length} 个边界用例全部正确（**空页能切、边界能切**）`);
  }
  // ★ 这条是本次事故的**直接判据**：空页绝不能被判成 'scroll'（那就等于滚轮失效、用户被困）
  if (mod.wheelIntent(1, fake(0, 300, 0)) === 'page' && mod.wheelIntent(-1, fake(0, 300, 0)) === 'page') {
    ok('空页双向都能切页（事故场景：切到空盒子后滚轮失效 —— 已修）');
  } else {
    fail('空页仍会被判成 scroll ⇒ 用户会被困在空页里（正是本次要修的缺陷）');
  }
}

/* ══════════════ ④ 运行期：渲染计数 + 定尺几何 ══════════════ */
function findChromium() {
  const base = path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base).filter((d) => d.startsWith('chromium-')).sort();
  for (const d of dirs.reverse()) {
    const exe = path.join(base, d, 'chrome-win64', 'chrome.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}
const exe = findChromium();
if (!exe) {
  console.log('\n  ⚠ 找不到 playwright 的 Chromium，跳过运行期断言');
} else {
  console.log('\n=== ④ 运行期：计数（不丢项）+ 定尺几何 ===');
  const { chromium } = await import(pathToFileURL(path.join(ROOT, 'node_modules/playwright-core/index.mjs')).href);
  const { build } = await import(pathToFileURL(path.join(ROOT, 'node_modules/esbuild/lib/main.js')).href);
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  const page = await browser.newPage({ viewport: { width: 704, height: 720 } });

  // ★ 注入**真实样式**：不注入的话网格是 display:block，永远不溢出
  //   ⇒ "可滚动"那条判据恒为假红（第一版就栽在这）。
  await page.setContent('<!doctype html><html><head></head><body></body></html>');
  await page.addStyleTag({ content: generated });

  const outfile = path.join(ROOT, 'tmp', 'grid-under-test.mjs');
  await build({
    entryPoints: [path.join(SRC, 'ui/wheel/grid-core.ts')],
    outfile, bundle: true, format: 'esm', platform: 'browser', target: 'chrome110', logLevel: 'silent',
  });
  const bundle = readFileSync(outfile, 'utf8');

  const result = await page.evaluate(async ({ bundleSrc }) => {
    const url = URL.createObjectURL(new Blob([bundleSrc], { type: 'text/javascript' }));
    const mod = await import(url);
    URL.revokeObjectURL(url);

    const render = (N, squeeze) => {
      const accounts = Array.from({ length: N }, (_, i) => ({
        id: `a${i}`, tabName: `账号${i + 1}`, username: `user${i + 1}`,
        color: '#1e6fff', box: '通桥',
        tabIds: i % 3 === 0 ? [1] : [], hasToken: i % 3 === 0,
      }));
      const root = document.createElement('div');
      document.body.append(root);
      mod.buildAccountGrid(root, {
        pages: [{ label: '通桥', accounts }], pageIndex: 0, onPage: () => {}, onPick: () => {},
      });
      const grid = root.querySelector('.ag-grid');
      if (squeeze && grid) grid.style.maxHeight = '180px';
      // ★ 位置用**相对容器**的偏移，不用视口坐标：本判据连续渲染多次，它们纵向堆叠
      //   ⇒ 视口坐标当然不同（第一版就是这么假红的）。
      const first = grid?.querySelector('.ag-cell');
      const r = first?.getBoundingClientRect();
      const g = grid?.getBoundingClientRect();
      return {
        cells: root.querySelectorAll('.ag-cell').length,
        slots: root.querySelectorAll('.ag-slot').length,
        names: [...root.querySelectorAll('.ag-name')].map((e) => e.textContent),
        rotated: [...root.querySelectorAll('.ag-name')].filter((e) => {
          const t = getComputedStyle(e).transform;
          return t && t !== 'none';
        }).length,
        keys: root.querySelectorAll('.ag-key').length,
        meta: root.querySelector('.ag-meta')?.textContent ?? '',
        rows: grid ? getComputedStyle(grid).gridTemplateRows.split(' ').length : 0,
        canScroll: grid ? grid.scrollHeight > grid.clientHeight : null,
        geo: r && g ? [Math.round(r.width), Math.round(r.height), Math.round(r.top - g.top)] : null,
      };
    };

    const base = render(18, false);
    const small = render(8, false);
    const full = render(20, false);
    const many = render(26, true);
    return {
      ...base,
      smallSlots: small.slots, smallGeo: small.geo,
      fullCells: full.cells, fullSlots: full.slots, fullRows: full.rows,
      manyCells: many.cells, manyLastName: many.names[many.names.length - 1], canScroll: many.canScroll,
    };
  }, { bundleSrc: bundle });

  console.log(`     18 个 → ${result.cells} 格 + ${result.slots} 占位，${result.rows} 行；首格 ${JSON.stringify(result.geo)}`);
  console.log(`      8 个 → 占位 ${result.smallSlots}，首格 ${JSON.stringify(result.smallGeo)}`);
  console.log(`     20 个 → ${result.fullCells} 格 + ${result.fullSlots} 占位`);
  console.log(`     26 个 → ${result.manyCells} 格，可滚动 ${result.canScroll}`);

  if (result.cells === 18 && result.names[17] === '账号18') ok('18 项全部渲染（第 18 个在 DOM 里）');
  else fail(`18 项只渲染了 ${result.cells} 个`);
  if (result.keys === 10) ok('数字键角标恰好 10 个');
  else fail(`数字键角标 ${result.keys} 个，应为 10`);
  if (result.rotated === 0) ok('文字零旋转（径向倾斜已消失）');
  else fail(`仍有 ${result.rotated} 个带旋转`);
  if (result.manyCells === 26 && result.manyLastName === '账号26' && result.canScroll) {
    ok('26 项全部进 DOM 且可滚动（绝不截断）');
  } else {
    fail(`26 项：cells=${result.manyCells} 末位=${result.manyLastName} 可滚动=${result.canScroll}`);
  }
  if (result.rows === 4 && result.fullRows === 4) ok('行数恒为 4（5 列 × 4 行）');
  else fail(`行数不是 4（${result.rows}/${result.fullRows}）`);
  if (result.cells + result.slots === 20 && result.fullSlots === 0) ok('槽位恒为 20；满 20 时无占位格');
  else fail(`槽位不是 20（${result.cells}+${result.slots}；满页占位 ${result.fullSlots}）`);
  if (JSON.stringify(result.geo) === JSON.stringify(result.smallGeo)) {
    ok('8 与 18 项的首格几何逐项相同（换页不重排）');
  } else {
    fail(`首格几何随项目数变了：${JSON.stringify(result.geo)} vs ${JSON.stringify(result.smallGeo)}`);
  }
  if (/^\d+\/20 个 · 在线 \d+/.test(result.meta)) ok(`标题栏容量口径正确（${result.meta}）`);
  else fail(`标题栏容量口径不对：「${result.meta}」`);

  /* ── 真机再验一次"空页不死角"：8 个项 + 2 页，滚轮必须能换页 ── */
  const wheeled = await page.evaluate(async ({ bundleSrc }) => {
    const url = URL.createObjectURL(new Blob([bundleSrc], { type: 'text/javascript' }));
    const mod = await import(url);
    URL.revokeObjectURL(url);
    const mk = (n, box) => Array.from({ length: n }, (_, i) => ({
      id: `${box}-${i}`, tabName: `${box}${i + 1}`, username: 'u', color: '#1e6fff', box, tabIds: [], hasToken: false,
    }));
    const root = document.createElement('div');
    document.body.append(root);
    let pages_ = [
      { label: '通桥', accounts: mk(8, 'T') },
      { label: '空盒子', accounts: [] },     // ★ 事故场景：空页
      { label: '内网', accounts: mk(3, 'N') },
    ];
    let idx = 0;
    const paint = () => mod.buildAccountGrid(root, {
      pages: pages_, pageIndex: idx, onPage: (d) => { idx = (idx + d + pages_.length) % pages_.length; paint(); }, onPick: () => {},
    });
    paint();
    const wrap = root.querySelector('.ag-wrap');
    const fire = (deltaY) => wrap.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    // 从"通桥"往下滚 ⇒ 应进入空盒子；**在空盒子里再滚 ⇒ 必须能继续走**（事故点）
    fire(120);
    const afterFirst = root.querySelector('.ag-box')?.textContent;
    fire(120);
    const afterSecond = root.querySelector('.ag-box')?.textContent;
    fire(-120);
    const afterBack = root.querySelector('.ag-box')?.textContent;
    return { afterFirst, afterSecond, afterBack };
  }, { bundleSrc: bundle });

  console.log(`     真机滚轮：通桥 → ${wheeled.afterFirst} → ${wheeled.afterSecond} →（上滚）${wheeled.afterBack}`);
  if (wheeled.afterFirst === '空盒子' && wheeled.afterSecond === '内网') {
    ok('★ 从空盒子能继续滚走（事故场景已修：不再被困在空页）');
  } else {
    fail(`空页滚轮仍失效：第二滚后停在「${wheeled.afterSecond}」`);
  }
  if (wheeled.afterBack === '空盒子') {
    ok('空页反向也能滚回（双向都不死角）');
  } else {
    fail(`空页反向滚轮异常：停在「${wheeled.afterBack}」`);
  }

  await browser.close();
}

console.log(`\n${bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`}`);
process.exit(bad === 0 ? 0 : 1);
