/**
 * ★★ 盒子与**云端**对账的验证（2026-10-12）。
 *
 * 用户报："云端账号库，盒子的数据没有做好同步。"
 * 实测：**扩展显示 5 个盒子、云端只有 2 个**，而两边都不报错。
 *
 * ## 验的是什么（以及为什么不是端到端）
 *
 * `verify-boxmgmt.mjs` 覆盖"扩展**自己**的重命名/删除"；
 * 本脚本覆盖**它没覆盖的那一半**：`ql:boxes`（本地记住的）与云端名单不一致时怎么收敛。
 *
 * ★ 第一版我写成真起 Chromium + 真打云端 —— 结果**只能 SKIP**：
 *   扩展在验证档案里没有云端授权（`par.create` 回"云端未授权"），
 *   于是"对账"那条路径**从来没被执行过**，而那正是要验的东西。
 *   ⇒ 把规则抽成**纯函数** `shared/box-reconcile.ts`（不碰 chrome / 不碰 DOM），
 *     本脚本用 **esbuild 就地把它转成 CJS** 再加载，用**合成数据**把三种情形钉住。
 *   （用 esbuild 而不是手搓 TS 剥离器：后者在源码形状一变就会**静默错**，
 *     而那正是本仓规则 31「产物对不能推出源对」的镜像。）
 *
 * ## 三条判据里有两条是**反方向**的
 *
 * 只验"剪掉了多余的"是不够的 —— "一律清空"也能过那一条。所以还要验：
 *   · 云端**没答复**（离线）时**一个都不许剪**；
 *   · **账号里正在用的**盒名**永远不许剪**（哪怕它暂时不在云端名单里）。
 */
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src', 'shared', 'box-reconcile.ts');
const OUT = path.join(ROOT, 'tmp', 'box-reconcile.cjs');

let bad = 0;
const fail = (m) => { console.log(`  ✗ ${m}`); bad++; };
const ok = (m) => console.log(`  ✓ ${m}`);

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到 ${SRC} —— 对账规则被挪走了？本判据的锚点需要跟着改`);
  process.exit(2);
}

// ★ 就地转译（不写进 dist/，也不手工剥类型）
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await build({
  entryPoints: [SRC],
  outfile: OUT,
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  logLevel: 'silent',
});
const { reconcileBoxes } = await import(pathToFileURL(OUT).href);
if (typeof reconcileBoxes !== 'function') {
  console.error('✗ box-reconcile.ts 没有导出 reconcileBoxes');
  process.exit(2);
}

const DEF = '默认盒子';

// ══════════════════════════ ① 云端有答复：多余的本地盒名必须被剪掉
console.log('=== ① 云端有答复时：本地记住的多余盒名必须被剪掉 ===');
{
  const out = reconcileBoxes({
    remembered: ['通桥', '本地幽灵盒子A', '本地幽灵盒子B'],
    fromAccounts: ['通桥'],
    cloudNames: [DEF, '通桥'],
    defaultBox: DEF,
  });
  console.log(`     boxes=${JSON.stringify(out.boxes)}  dropped=${JSON.stringify(out.dropped)}  changed=${out.changed}`);
  if (out.boxes.includes('本地幽灵盒子A') || out.boxes.includes('本地幽灵盒子B')) {
    fail('云端没有的盒名还在列表里（对账没生效）');
  } else ok('云端没有的盒名已被剪掉');
  if (!out.dropped.includes('本地幽灵盒子A')) fail('dropped 没记下被剪掉的名字（调用点无法记账）');
  else ok('dropped 记下了被剪掉的名字');
  if (!out.boxes.includes('通桥')) fail('把**云端确实有的**盒子也剪掉了');
  else ok('云端确实有的盒子保留着');
  if (out.boxes[0] !== DEF) fail(`默认盒不在第一位（${out.boxes[0]}）—— 它是"未归盒账号的归宿"`);
  else ok('默认盒在第一位');
  if (!out.changed) fail('changed 应为 true');
}

// ══════════════════════════ ② 离线：一个都不许剪（反方向）
console.log('\n=== ② 云端没答复（离线）：一个都不许剪 ===');
{
  const out = reconcileBoxes({
    remembered: ['通桥', '离线时也要看得见的盒子'],
    fromAccounts: ['通桥'],
    cloudNames: [],            // ★ 没拿到
    defaultBox: DEF,
  });
  console.log(`     boxes=${JSON.stringify(out.boxes)}  changed=${out.changed}`);
  if (!out.boxes.includes('离线时也要看得见的盒子')) {
    fail('离线时把本地记住的盒子剪掉了 —— 用户会看到"自己的盒子全没了"');
  } else ok('离线时本地那份完好（刻意：离线时它是唯一真相）');
  if (out.changed) fail('离线时不该报 changed（调用点会白写一次 storage）');
  else ok('离线时不报 changed');
}

// ══════════════════════════ ③ 账号在用的盒名：永远不许剪（反方向）
console.log('\n=== ③ 账号里正在用的盒名：云端名单里没有也不许剪 ===');
{
  const out = reconcileBoxes({
    remembered: ['账号在用但云端暂时没有'],
    fromAccounts: ['账号在用但云端暂时没有'],
    cloudNames: [DEF],          // 云端名单里确实没有它
    defaultBox: DEF,
  });
  console.log(`     boxes=${JSON.stringify(out.boxes)}  dropped=${JSON.stringify(out.dropped)}`);
  if (!out.boxes.includes('账号在用但云端暂时没有')) {
    fail('账号在用的盒名被剪掉了 —— 用户会看到"账号挂在一个不存在的盒子上"');
  } else ok('账号在用的盒名保住了（它不依赖云端名单）');
  if (out.dropped.length) fail('它不该出现在 dropped 里');
}

// ══════════════════════════ ④ 默认盒去重 + 空值兜底
console.log('\n=== ④ 默认盒去重与空值兜底 ===');
{
  const out = reconcileBoxes({
    remembered: [DEF, '通桥', ''],
    fromAccounts: [DEF, '通桥'],
    cloudNames: [DEF, '通桥'],
    defaultBox: DEF,
  });
  const dup = out.boxes.filter((b) => b === DEF).length;
  console.log(`     boxes=${JSON.stringify(out.boxes)}  默认盒出现 ${dup} 次`);
  if (dup !== 1) fail(`默认盒出现了 ${dup} 次（应恰好 1 次）`);
  else ok('默认盒恰好一次');
  if (out.boxes.some((b) => b === '')) fail('空串混进了盒子列表');
  else ok('空串被兜掉');
}

// ══════════════════════════ ⑤ 云端独有的空盒子必须出现（2026-10-19）
console.log('\n=== ⑤ 云端独有的空盒子：必须进列表，且报 changed ===');
{
  /* 用户 2026-10-19：「盒子管理不要显示离线未同步提示，该部分应当自动同步」。
   * 这一组钉的是同步的**另一半**：云端新建的空盒（含建站点时自动建的）此前
   * 只存在于 `cloudNames`，而并集没把它算进去 ⇒ 扩展里**永远看不到它**。
   * ★ 反证：把函数里 `...cloudNames.filter(...)` 那行删掉 ⇒ 本条当场红。 */
  const out = reconcileBoxes({
    remembered: [],
    fromAccounts: [],
    cloudNames: [DEF, '新建的空盒子'],
    defaultBox: DEF,
  });
  console.log(`     boxes=${JSON.stringify(out.boxes)}  changed=${out.changed}`);
  if (!out.boxes.includes('新建的空盒子')) {
    fail('云端独有的空盒子没有进列表 —— 网页上新建的盒子在扩展里看不见');
  } else ok('云端独有的空盒子进了列表');
  if (!out.changed) fail('新增盒子没有报 changed ⇒ 调用点不会写回 ql:boxes，下一次刷新又会消失');
  else ok('新增盒子报了 changed（会被写回本地记住的名单）');
}

// ══════════════════════════ ⑥ 数据同步纪律（2026-10-21）
console.log('\n=== ⑥ 读取不写、账号自足、刷新顺序 ===');
{
  const cloudStore = fs.readFileSync(
    path.join(ROOT, 'packages', 'extension', 'src', 'background', 'core', 'cloud-store.ts'),
    'utf8',
  );
  const parallel = fs.readFileSync(
    path.join(ROOT, 'packages', 'extension', 'src', 'ui', 'parallel', 'parallel.ts'),
    'utf8',
  );

  /* 用户 2026-10-21 报"两端数据不同步"；根因之一是读页面时自动建站：
   * 云端刚删站点、扩展旧账号缓存还在 5 秒 TTL 内 ⇒ 自动把站点建回来。
   * ★ 这里只认**函数定义**，不认历史注释里的名字。 */
  if (parallel.includes('async function ensureMissingSites')) {
    fail('读取路径仍在自动建站（ensureMissingSites）—— 删站点可能被复活');
  } else {
    ok('读取路径不再自动建站');
  }

  if (cloudStore.includes("CLOUD_DEFAULT_BASE_URL = 'https://www.dragonrain.top'")) {
    ok('默认云端地址已归一为 443');
  } else {
    fail('默认云端地址没有归一为 443');
  }

  if (cloudStore.includes("cache: 'no-store'")) {
    ok('云端请求显式 no-store（不读浏览器 HTTP 缓存）');
  } else {
    fail('云端请求没有 no-store，可能读到浏览器缓存的旧 JSON');
  }

  if (cloudStore.includes('accountCount: num(rec.accountCount)')) {
    ok('站点账号数读取云端 accountCount');
  } else {
    fail('站点账号数没有读取云端 accountCount');
  }
  if (parallel.includes('count: s.accountCount ?? countAccountsFor(s.host)')) {
    ok('站点卡片优先使用云端 accountCount');
  } else {
    fail('站点卡片没有优先使用云端 accountCount');
  }

  const refreshAt = parallel.indexOf('async function refreshAll');
  const refreshSection = refreshAt >= 0 ? parallel.slice(refreshAt) : '';
  const accountAt = refreshSection.indexOf("await step('账号'");
  const reconcileAt = refreshSection.indexOf("await step('盒子对账'");
  if (accountAt >= 0 && reconcileAt > accountAt) {
    ok('账号刷新后会再对账盒子（避免旧账号保留幽灵盒）');
  } else {
    fail('refreshAll 没有在账号刷新后补盒子对账');
  }

  if (cloudStore.includes("cloudRequest<unknown>('/api/ui/state')")
      && parallel.includes('async function loadAtomicState')
      && parallel.includes("kind: 'par.state'")) {
    ok('扩展已接入 /api/ui/state 与 par.state');
  } else {
    fail('扩展没有完整接入原子 UI 状态（fetch/load/消息任一处缺失）');
  }
  const sw = fs.readFileSync(
    path.join(ROOT, 'packages', 'extension', 'src', 'background', 'service-worker.ts'),
    'utf8',
  );
  if (sw.includes("case 'par.state'")) {
    ok('Service Worker 有 par.state 处理分支');
  } else {
    fail('Service Worker 没有 par.state 分支 —— 页面会永远回落三次读取');
  }
  if (refreshSection.includes('loadAtomicState()')
      && refreshSection.includes("await step('盒子'")) {
    ok('refreshAll 优先原子读取，并保留旧读路径兜底');
  } else {
    fail('refreshAll 没有“原子读取优先 + 三次读取兜底”');
  }
}

fs.rmSync(OUT, { force: true });
console.log(bad === 0 ? '\nRESULT: OK' : `\nRESULT: ${bad} 处不符`);
process.exit(bad === 0 ? 0 : 1);
