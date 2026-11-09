/**
 * 验收：**取证与诊断通道**的落盘打码（`forensics` / `diag`）。
 *
 * ## 为什么单列一个脚本
 *
 * 扩展端有**三个**写日志的出口，而它们原先只有一个是受控的：
 *
 *   | 出口 | 落点 | 原先 |
 *   |---|---|---|
 *   | `shared/log.ts` 的 `log()` | DevTools + 环形缓冲 | ✅ 强制打码 |
 *   | `forensics()`（本脚本） | `storage.local['ql:forensics']` → **诊断包** | ❌ **无打码** |
 *   | `diag()`（本脚本） | `storage.local['ql:diag']` | ❌ **无打码** |
 *
 * 而 `forensics` 的载荷是 `{ tabId, ...p }`，`p` **完全由内容脚本决定** ——
 * "调用点会记得不传凭据"是一条**约定，不是机制**。
 * 实测那 7 个调用点当时确实没传凭据（所以没有实际泄露），
 * 但安全机制不该建在"下一个人记得住"上面。
 *
 * ## 这个脚本怎么验
 *
 * **真的把模块求值、真的调 `forensics()`**，然后读回 `storage.local` 里那一行。
 * `parallel-session.ts` 的顶层没有任何 `chrome.*` 调用（只有 `new Map()`），
 * 所以用一个极小的 chrome 桩就能把它跑起来 —— 验的是**将要发布的那份代码**，
 * 而不是"我以为它长什么样"。
 *
 * ★ 两侧都要验：**漏**（凭据落盘）与**过度**（正常字段被吞掉，诊断包失去价值）。
 *
 * 跑法：node tools/verify/verify-forensics-redaction.mjs
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ 仓库根：tools/verify/ 往上两层。少一层会静默指向 tools/（AGENTS.md 规则 15）
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- chrome 桩
// 只铺 `forensics` / `diag` 真正会碰的那几个成员。
// ★ 「只铺必需的」是刻意的：桩面越大，越容易把"被测代码调了不该调的东西"掩盖过去。
const store = {};
const chromeStub = {
  storage: {
    local: {
      get: async (key) => (key in store ? { [key]: store[key] } : {}),
      set: async (obj) => { Object.assign(store, obj); },
    },
  },
};

// ---------------------------------------------------------------- 求值被测模块
const esbuild = await import('esbuild');
// ★★ 2026-11-09：**入口用 stdin 而不是直接指向 parallel-session.ts** —— 因为判据现在还要
//   拿到 `ring-write.ts` 的 `ringIdle()`。两个模块必须在**同一个 bundle 图**里求值，
//   否则 `ringIdle` 是另一个模块实例、盯着另一条空队列，`await` 立刻返回 = 假绿。
const bundle = await esbuild.build({
  stdin: {
    contents: [
      "export * from './parallel-session';",
      "export { ringIdle } from './ring-write';",
    ].join('\n'),
    resolveDir: join(SRC, 'background', 'core'),
    sourcefile: 'verify-entry.ts',
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__qlPs',
  target: 'chrome110',
  platform: 'browser',
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;

// ★ `new Function` + 把 chrome 作为参数传进去：不污染 globalThis，
//   也不用引 `vm`。iife 的导出挂在 globalName 上，取回来即可。
const mod = new Function('chrome', `${code}\nreturn __qlPs;`)(chromeStub);
const { forensics } = mod;
// ★★ 2026-11-09：落盘改成**合并写**（`ring-write.ts`）⇒ `await forensics()` 返回时
//   那一条还在待写队列里，**没有进 storage**。判据必须等队列写完再读，
//   否则读到的永远是上一次的状态（会表现成"打码没生效"的假红）。
//   `ringIdle()` 就是为此暴露的（生产代码不该 await 它，判据必须）。
const { ringIdle } = mod;

check('模块能在最小 chrome 桩下求值', typeof forensics === 'function',
  typeof forensics === 'function' ? '' : `拿到的是 ${typeof forensics}`);

// ---------------------------------------------------------------- ① 凭据必须被打掉
console.log('\n=== 1. 凭据落盘必须被打掉（漏了就是明文进诊断包）===');
{
  const SECRET = 'Liyulong0901';
  const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.payload.sig';
  await forensics('autoLogin', {
    tabId: 42,
    password: SECRET,
    username: 'alice@example.com',
    accessToken: TOKEN,
    nested: { userPassword: SECRET, note: 'keep-me' },
    attempts: 3,
    reason: 'fields-reset',
    // 值里嵌着凭据的字符串，走另一条规则（值的形状）
    blob: `connect password=${SECRET} ok`,
  });
  await ringIdle();

  const raw = JSON.stringify(store['ql:forensics'] ?? []);
  check('`password` 字段未落盘原文', !raw.includes(SECRET), raw.includes(SECRET) ? '★ 泄露' : '');
  check('`accessToken`（复合键名）未落盘原文', !raw.includes(TOKEN), raw.includes(TOKEN) ? '★ 泄露' : '');
  check('嵌套对象里的 `userPassword` 也被打掉', !raw.includes(`"userPassword":"${SECRET}"`));
  check('字符串值里嵌的凭据被打掉', !raw.includes(`password=${SECRET}`) || raw.includes('«已打码»'));
  check('落盘里出现了打码占位符', raw.includes('«已打码»'));
}

// ---------------------------------------------------------------- ② 正常字段必须保留
console.log('\n=== 2. 正常字段必须保留（吞掉它们 = 诊断包失去价值）===');
{
  const raw = JSON.stringify(store['ql:forensics'] ?? []);
  check('事件名保留', raw.includes('autoLogin'));
  check('tabId 保留', raw.includes('42'));
  check('attempts 保留', raw.includes('"attempts":3'));
  check('reason 保留', raw.includes('fields-reset'));
  check('非敏感字符串保留', raw.includes('alice@example.com'));
  check('嵌套里的非敏感字段保留', raw.includes('keep-me'));
  check('结构没被压成一个字符串（仍是对象）',
    Array.isArray(store['ql:forensics']) && typeof store['ql:forensics'].at(-1) === 'object');
}

// ---------------------------------------------------------------- ③ 环形缓冲仍然工作
console.log('\n=== 3. 环形缓冲仍然工作（改打码不该改行为）===');
{
  for (let i = 0; i < 130; i++) await forensics('evt', { i });
  await ringIdle();
  const arr = store['ql:forensics'];
  check('环形上限 120 生效', arr.length === 120, `实际 ${arr.length}`);
  check('保留的是**最新**的那批（不是最旧的）', arr.at(-1).i === 129, `末条 i=${arr.at(-1)?.i}`);
}

// ---------------------------------------------------------------- ④ 结构：不许绕过通道
console.log('\n=== 4. 结构：`forensics`/`diag` 的落盘点必须过打码 ===');
{
  const { readFileSync } = await import('node:fs');
  const ps = readFileSync(join(SRC, 'background', 'core', 'parallel-session.ts'), 'utf8');

  // 取 forensics 与 diag 的函数体，断言它们真的调了 redact/redactDetail。
  //
  // ★ 这一小段判据本身踩过**两个**坑，都值得留着：
  //   ① 第一版写成 `ps.indexOf('function ' + name + '(')` ⇒ 找**不到**
  //      `export async function forensics(`（前面有 `export async`）⇒ 返回空串，
  //      两条断言恒假（**假红**）。
  //   ② 改成正则后仍在假红 —— 因为花括号配平**从签名开头**开始数，
  //      而参数表里就有 `detail: Record<string, unknown> = {}`：
  //      那个 `{}` 让 depth 先 +1 再 -1，于是**数到参数表末尾就归零了**，
  //      只截到 81 个字符。
  //      ⇒ 必须先**跳过参数表**（匹配到 `)` 之后的第一个 `{`）再开始配平。
  //
  // ⇒ 判据的写法：`)\s*{` 定位函数体起点，从那个 `{` 起配平；
  //   且**找不到就判失败**，绝不静默返回空串。
  const bodyOf = (name) => {
    const head = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
    ).exec(ps);
    if (!head) return null;
    // 从签名开头扫到"参数表闭合的 `)` 之后的第一个 `{`"
    let depth = 0;
    let bodyStart = -1;
    for (let j = ps.indexOf('(', head.index); j < ps.length; j++) {
      const c = ps[j];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          const brace = ps.indexOf('{', j);
          if (brace < 0) return null;
          bodyStart = brace;
          break;
        }
      }
    }
    if (bodyStart < 0) return null;
    let d = 0;
    for (let j = bodyStart; j < ps.length; j++) {
      if (ps[j] === '{') d++;
      else if (ps[j] === '}') { d--; if (d === 0) return ps.slice(bodyStart, j + 1); }
    }
    return null;
  };

  const fBody = bodyOf('forensics');
  const dBody = bodyOf('diag');
  check('能定位到 `forensics` 的函数体（判据自身的前提）', fBody !== null);
  check('能定位到 `diag` 的函数体（判据自身的前提）', dBody !== null);
  check('`forensics` 用了 redactDetail（对象级打码）', !!fBody && fBody.includes('redactDetail('));
  check('`forensics` 用了 redact（值形状打码）', !!fBody && fBody.includes('redact('));
  check('`diag` 用了 redact', !!dBody && dBody.includes('redact('));

  // ★ 反向：不许有"裸写 storage.local.set"的日志式落盘点绕过打码
  const suspicious = [];
  for (const key of ['ql:diag', 'ql:forensics']) {
    const re = new RegExp(`local\\.set\\(\\{[^}]*${key.replace(':', '\\:')}`, 'g');
    for (const m of ps.matchAll(re)) {
      const around = ps.slice(Math.max(0, m.index - 400), m.index + 200);
      if (!around.includes('redact')) suspicious.push(key);
    }
  }
  check('没有绕过打码的 storage.local 落盘点', suspicious.length === 0,
    suspicious.length ? `可疑：${[...new Set(suspicious)].join(', ')}` : '');
}

// ---------------------------------------------------------------- ⑤ 绝不抛
console.log('\n=== 5. 打码代码绝不能抛（抛异常会终止 MV3 的 worker）===');
{
  const circular = { name: 'x' }; circular.self = circular;
  let threw = null;
  try {
    await forensics('weird', {
      circular,
      big: 123n,
      fn: () => 1,
      sym: Symbol('s'),
      undef: undefined,
      nil: null,
      deep: { a: { b: { c: { d: 'password=oops12345' } } } },
    });
  } catch (e) { threw = e; }
  check('循环引用 / BigInt / 函数 / Symbol 都不抛', threw === null, threw ? String(threw) : '');
  await ringIdle();
  const raw = JSON.stringify(store['ql:forensics'].at(-1));
  check('深层的口令也打掉了', !raw.includes('oops12345'));
  check('循环引用被标注', raw.includes('[circular]'));
  check('BigInt 被安全串化', raw.includes('123n'));
}

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
