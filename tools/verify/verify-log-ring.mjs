/**
 * 环形缓冲**合并写**的判据（`ql:diag` / `ql:forensics` 的并发丢日志缺陷）。
 * 运行：node tools/verify/verify-log-ring.mjs
 *
 * # 为什么需要这条判据
 *
 * 2026-11-09 审计发现：`diag()` / `forensics()` 原先各自做裸的
 * `get → 拼接 → set`，**没有串行化**。同一 tick 里的第二条会读到写入前的数组，
 * 于是把第一条覆盖掉。实测（真 Edge + 真 `chrome.storage`）：
 *
 * | 写法 | 20 条并发后环里剩下的 |
 * |---|---|
 * | 原样（get→set） | **1 条** |
 * | 串行化 | 20 条 |
 *
 * 而"同一个 tick 多条"恰是本扩展的常态（`open()` 连续埋点、多账号同时开、
 * 多页签并发流程）⇒ 环 60 / 环 120 的设计前提不成立，证据是**写不进去**丢的。
 *
 * # 怎么测（静态脚本，不真起浏览器）
 *
 * 用 esbuild 把 `ring-write.ts` 现场打成 cjs，注入一个**带人工延迟**的
 * `chrome.storage.local` 桩 —— 延迟是必须的：同步桩会让竞态窗口消失，
 * 判据就变成"永远绿"的空判据（规则 24 的空集陷阱）。
 *
 * ★ 里面有一条**对照组**：用同样的桩跑"裸读改写"，必须只剩 1 条。
 *   它保证"这个桩确实能复现竞态" —— 否则就算被测代码坏了，本脚本也会绿。
 *   这正是 PITFALLS #37 / 规则 17 的要求：**先证明判据会红**。
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SRC = join(ROOT, 'packages', 'extension', 'src');
const RING_SRC = join(SRC, 'background', 'core', 'ring-write.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 1. 打包被测模块 ---------------- */
console.log('\n=== 1. 前提：模块能打包、导出齐全 ===');

const built = await build({
  entryPoints: [RING_SRC],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
});
const code = built.outputFiles[0].text;
const mod = { exports: {} };
// ★ 不要把 `chrome` 当作包装函数的**形参**：那会遮蔽 `globalThis.chrome`，
//   模块里读到的永远是 `undefined`（本轮踩过：所有用例都写成 0 条，看起来像被测代码坏了）。
//   让它从全局取，用例只需换 `globalThis.chrome`。
new Function('module', 'exports', code)(mod, mod.exports);
const { appendRing, ringIdle } = mod.exports;

check('打到 cjs 且编译无警告', typeof code === 'string' && code.length > 0, `${code.length} 字节`);
check('导出 appendRing', typeof appendRing === 'function');
check('导出 ringIdle（判据要能"写完再读"）', typeof ringIdle === 'function');

/* ---------------- 2. 带延迟的 chrome.storage.local 桩 ----------------
 *
 * ★ 延迟是判据的一部分，不是装饰：
 *   · `get` 延迟 ⇒ 并发调用能看到**同一个**旧数组（竞态窗口）
 *   · `set` 延迟 ⇒ 写序与调用序可交错（真实 storage 就是异步 IPC）
 */
const makeStore = ({ delay = 2, throwOn = null } = {}) => {
  const data = new Map();
  return {
    chrome: {
      storage: {
        local: {
          get: async (key) => {
            await sleep(delay);
            if (throwOn === 'get') throw new Error('stub: get failed');
            return { [key]: data.get(key) };
          },
          set: async (obj) => {
            await sleep(delay);
            if (throwOn === 'set') throw new Error('stub: set failed');
            for (const [k, v] of Object.entries(obj)) data.set(k, v);
          },
        },
      },
    },
    data,
  };
};

// ★ 全局 chrome 由模块在**调用时**读取 ⇒ 每个用例换一次桩即可
const useStub = (stub) => {
  globalThis.chrome = stub.chrome;
  return stub;
};

/* ---------------- 3. 对照组：裸读改写必须复现丢日志 ---------------- */
console.log('\n=== 3. 对照组：裸读改写（改造前的写法）必须复现覆盖 ===');
{
  const stub = useStub(makeStore());
  // 完全照改造前的 `diag()` 写：每次自己 get → 拼 → set，没有串行化
  const naiveAppend = async (key, item) => {
    const cur = (await globalThis.chrome.storage.local.get(key))[key];
    await globalThis.chrome.storage.local.set({ [key]: [...(cur ?? []), item] });
  };
  await Promise.all(Array.from({ length: 50 }, (_, i) => naiveAppend('naive', `v${i}`)));
  const left = stub.data.get('naive') ?? [];
  check(
    '对照组：50 条并发只剩 1 条（证明本桩能复现竞态）',
    left.length === 1,
    `实际 ${left.length} 条`,
  );
}

/* ---------------- 4. 被测实现：50 条并发全在且有序 ---------------- */
console.log('\n=== 4. 合并写：并发 50 条一条不丢、顺序不乱 ===');
{
  const stub = useStub(makeStore());
  for (let i = 0; i < 50; i++) appendRing('k50', 60, `v${i}`);
  await ringIdle();
  const left = stub.data.get('k50') ?? [];
  check('50 条全在', left.length === 50, `实际 ${left.length} 条`);
  check('顺序 = 调用顺序', left.join(',') === Array.from({ length: 50 }, (_, i) => `v${i}`).join(','));
}

/* ---------------- 5. 容量与淘汰方向 ---------------- */
console.log('\n=== 5. 容量 cap：只留**最近** cap 条 ===');
{
  const stub = useStub(makeStore());
  for (let i = 0; i < 12; i++) appendRing('kcap', 5, `v${i}`);
  await ringIdle();
  const left = stub.data.get('kcap') ?? [];
  check('cap=5 时只剩 5 条', left.length === 5, `实际 ${left.length} 条`);
  check('留下的是最后 5 条（丢最老）', left.join(',') === 'v7,v8,v9,v10,v11', left.join(','));
}

/* ---------------- 6. 跨批次不互相覆盖 ---------------- */
console.log('\n=== 6. 跨批次：第二批要接在第一批后面 ===');
{
  const stub = useStub(makeStore());
  for (let i = 0; i < 3; i++) appendRing('kbatch', 60, `a${i}`);
  await ringIdle();
  for (let i = 0; i < 3; i++) appendRing('kbatch', 60, `b${i}`);
  await ringIdle();
  const left = stub.data.get('kbatch') ?? [];
  check('两批合并成 6 条', left.length === 6, `实际 ${left.length} 条`);
  check('批次顺序正确', left.join(',') === 'a0,a1,a2,b0,b1,b2', left.join(','));
}

/* ---------------- 7. 两个环同批写互不干扰 ---------------- */
console.log('\n=== 7. 多键同批：ql:diag 与 ql:forensics 各写各的 ===');
{
  const stub = useStub(makeStore());
  appendRing('ql:diag', 60, 'd1');
  appendRing('ql:forensics', 120, { ev: 'f1' });
  appendRing('ql:diag', 60, 'd2');
  await ringIdle();
  const diag = stub.data.get('ql:diag') ?? [];
  const forensics = stub.data.get('ql:forensics') ?? [];
  check('diag 环有 2 条字符串', diag.length === 2 && diag[0] === 'd1' && diag[1] === 'd2');
  check('forensics 环有 1 条对象', forensics.length === 1 && forensics[0]?.ev === 'f1');
}

/* ---------------- 8. 落盘抛错不能反向影响业务 ---------------- */
console.log('\n=== 8. storage 抛错：appendRing 不抛、ringIdle 正常返回 ===');
{
  const stub = useStub(makeStore({ throwOn: 'set' }));
  let threw = false;
  try {
    appendRing('kfail', 10, 'x');
    await ringIdle();
  } catch {
    threw = true;
  }
  check('落盘失败不抛异常（埋点失败不能影响业务）', !threw);
  // ★ 失败后链条必须还能继续用：换一个好桩再写一条
  const good = useStub(makeStore());
  appendRing('kfail2', 10, 'y');
  await ringIdle();
  check('一次失败之后队列仍可继续工作', (good.data.get('kfail2') ?? []).length === 1);
}

/* ---------------- 9. 极端 burst 不吃穿内存 ---------------- */
console.log('\n=== 9. 极端 burst：同一 tick 2000 条仍能写完、只留最后 cap 条 ===');
{
  const stub = useStub(makeStore({ delay: 1 }));
  for (let i = 0; i < 2000; i++) appendRing('kburst', 60, `v${i}`);
  await ringIdle();
  const left = stub.data.get('kburst') ?? [];
  check('burst 后只剩 cap 条', left.length === 60, `实际 ${left.length} 条`);
  check('留下的是最新的（末条是 v1999）', left[left.length - 1] === 'v1999', String(left[left.length - 1]));
}

/* ---------------- 10. 静态：调用点不得再有裸读改写 ---------------- */
console.log('\n=== 10. 静态：diag/forensics 必须走合并写 ===');
{
  const read = (rel) => readFileSync(join(SRC, rel), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  const ps = strip(read('background/core/parallel-session.ts'));
  const tr = strip(read('background/core/tab-rules.ts'));
  const rw = strip(read('background/core/ring-write.ts'));

  check('parallel-session.ts 导入了 appendRing', /import\s*\{\s*appendRing\s*\}\s*from\s*'\.\/ring-write'/.test(ps));
  check('tab-rules.ts 导入了 appendRing', /import\s*\{\s*appendRing\s*\}\s*from\s*'\.\/ring-write'/.test(tr));
  check('parallel-session.ts 的 diag 走 appendRing', /function diag\([\s\S]{0,300}?appendRing\('ql:diag'/.test(ps));
  check('parallel-session.ts 的 forensics 走 appendRing',
    /function forensics\([\s\S]{0,300}?appendRing\(LOCAL_KEYS\.forensics/.test(ps));
  check('tab-rules.ts 的 diag 走 appendRing', /function diag\([\s\S]{0,300}?appendRing\('ql:diag'/.test(tr));

  // ★ 这一条盯的是"绕过"：两个文件都不许再直接对这两个键 set
  const directSet = (s) => /storage\.local\.set\(\{[^}]*ql:(diag|forensics)/.test(s.replace(/\s+/g, ''));
  check('parallel-session.ts 不再直接 set ql:diag / ql:forensics',
    !/storage\.local\.set\(/.test(ps) || !directSet(ps));
  check('tab-rules.ts 不再直接 set ql:diag', !directSet(tr));

  // ★ 环形合并写的核心机制：一条串行链（去掉它竞态立刻回来）
  check('ring-write.ts 有串行链（chain = chain.then(…)）',
    /chain\s*=\s*chain\s*\.then\(/.test(rw));
  check('ring-write.ts 的 flush 先放开 scheduled（否则同 tick 追加要等下轮）',
    /async function flush\(\)[\s\S]{0,200}?scheduled\s*=\s*false/.test(rw));
}

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  process.exit(1);
}
console.log('RESULT: OK');
