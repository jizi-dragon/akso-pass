/**
 * 死协议判据（2026-10-12）—— 每个协议 kind / 桥 op 都必须能报出它的**对端**。
 *
 *     node tools/verify/verify-deadprotocol.mjs      # 静态、秒级、不需要浏览器
 *
 * ## 它防的是什么
 *
 * 删功能时删的往往是**使用方**（UI 按钮、调用点），而
 * **定义方**（`shared/messages.ts` 的 kind / `shared/types.ts` 的 op）
 * 与**处理方**（`service-worker.ts` 的 `dispatch`）**不在同一个文件、也不在同一次 grep 里**
 * ⇒ 于是留下"有定义、有处理分支、**没有任何人会走到**"的死协议。
 *
 * ★ 它**不会报错**：`typecheck` 绿、`build` 绿、判据也绿 —— 只是永远不被走到。
 *   实测（`docs/PITFALLS.md` #34）本仓曾有 **7 处**：
 *   `site.grants.list` / `site.grant.add` / `wheel.toggle`（有 handler 零发送方）、
 *   `CloudMergeReport`（类型孤儿）、`okOf()`、`registerAuthHandlers()`、
 *   `journalRollbackDone`（有发送方零处理分支）。**2026-10-12 已清理。**
 *
 * ## 判据（两个方向，缺一个方向就会漏一半）
 *
 * 对**每个** `kind` / `op`，要求它出现在**至少两个不同的文件**里，且其中
 * **至少一个不是"纯定义/纯分发"的文件**：
 *
 * | 判定 | 含义 |
 * |---|---|
 * | 只出现在 `messages.ts` / `types.ts` | **类型孤儿** —— 连处理分支都没有 |
 * | 只出现在定义 + `service-worker.ts` / `parallel-session.ts` | **零发送方** —— handler 永不被走到 |
 * | 出现在第三个文件 | 有对端 ⇒ 通过 |
 *
 * ★ 为什么**不**写成"每个 kind 必须有 UI 调用点"：那会把
 *   `content/` 侧发的（如 `status.*`、`favorites.*`）全判成死 ——
 *   **"谁发的"不止 UI 一处**。所以判据放宽到"至少一个第三方文件"，
 *   它恰好能抓住上面那张表的两种形态，而不会误伤 content 侧。
 *
 * ★ 与规则 30 是**对偶**：那条说"机制摆着 ≠ 被接上"（缺**调用**），
 *   本条说"协议留着 ≠ 有人发"（缺**对端**）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as stripCommentsShared } from './_lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); bad++; };

/** 所有 TS 源文件（相对 SRC 的路径） */
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) {
      out.push(...walk(p));
    } else if (e.endsWith('.ts')) {
      out.push(p);
    }
  }
  return out;
}

/**
 * 剥注释（判据要读**代码**；本仓的修复说明里会逐字引用被删的 kind）。
 *
 * ★★ 必须用共享的**字符串感知**剥离器，不能用「非贪婪块注释正则」：
 *   后者会跨字符串字面量匹配。实测 `ui/parallel/parallel.ts` 里的
 *   模板串 `*://${b}/*`（含注释起始符那三个字符）让正则以为注释从此开始，
 *   一路吃掉 **3082 字符**活代码 ⇒ `data.import` 明明有发送方（`parallel.ts:759`）
 *   却被判成"零发送方"（**假红**）。
 *   详见 `tools/verify/_lib/strip-comments.mjs` 的文件头。
 */
const stripComments = stripCommentsShared;

const FILES = walk(SRC).map((abs) => ({
  rel: path.relative(SRC, abs).replace(/\\/g, '/'),
  code: stripComments(readFileSync(abs, 'utf8')),
}));

/**
 * 定义方所在文件 —— 它们"只声明协议、不发起协议"。
 * ★ 这里**必须列全**：漏一个就会把"处理方"误当成"发送方"，
 *   于是死协议被判成活的（那是**假绿**，比假红坏得多）。
 */
const DEF_ONLY = new Set(['shared/messages.ts', 'shared/types.ts']);

/** 收集某个正则在哪些文件里命中 */
function filesMatching(re) {
  const hits = new Set();
  for (const f of FILES) {
    if (re.test(f.code)) {
      hits.add(f.rel);
    }
  }
  return hits;
}

/**
 * 白名单：**结构性只有两个文件**的协议 —— 它们的"对端"就是唯一的那个发送方，
 * 不存在第三个文件，因此上面那条"至少三个文件"的启发式会误报。
 *
 * ★ 每条都要能回答「**为什么它不需要第三个文件**」。答不上来就不该进这张表。
 * ★ 本表**故意保持极短**：它每长一条，判据就弱一分（规则 26：白名单必须先问）。
 */
const ALLOWED_SINGLE_FILE = {
  // 下行载荷：由 background **回**给壳，壳只接不发 ⇒ 天然只有「定义 + 发送方」两个文件。
  hold: '`hold` 是 BridgeDownPayload（background → 壳的应答），壳只接收不发送',
};

console.log('=== 前提 ===');
for (const must of ['shared/messages.ts', 'shared/types.ts', 'background/service-worker.ts']) {
  if (FILES.some((f) => f.rel === must)) {
    ok(`${must} 存在`);
  } else {
    fail(`${must} 读不到 —— 锚点漂了，后面的结论全不可信`);
  }
}
if (bad) {
  console.error('\n前提不成立，直接停。');
  process.exit(2);
}

/**
 * 一个协议名（kind / op）的"对端"判定。
 * @param label 人类可读的类别名
 * @param re    抓取该协议名的正则（必须带捕获组 1）
 */
function checkFamily(label, re) {
  console.log(`\n=== ${label} ===`);
  const defFile = FILES.find((f) => f.rel === (label.includes('桥') ? 'shared/types.ts' : 'shared/messages.ts'));
  const names = new Set();
  for (const m of defFile.code.matchAll(re)) {
    names.add(m[1]);
  }
  if (!names.size) {
    fail(`在 ${defFile.rel} 里一个都没抓到 —— 正则锚点漂了？`);
    return;
  }
  console.log(`  （共 ${names.size} 个：${[...names].join(', ')}）`);

  const dead = [];
  for (const name of names) {
    // 该名字出现在哪些文件（按**协议名字面量**匹配，避免匹配到同名的无关标识符）
    // ★ 每次必须新建正则（带 g 的 `test` 会记住 lastIndex）——这里确实每次 new，安全。
    const hits = filesMatching(new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`));
    const outsideDef = [...hits].filter((h) => !DEF_ONLY.has(h));

    // ★★ 白名单：**结构性只有两个文件**的协议。每条必须写明"为什么它不需要第三个文件"。
    //   漏掉一条会**假红**（把活的说成死的）；随便加一条会**假绿**（那更坏）。
    if (ALLOWED_SINGLE_FILE[name]) {
      ok(`${name} —— 白名单：${ALLOWED_SINGLE_FILE[name]}`);
      continue;
    }

    if (outsideDef.length === 0) {
      dead.push({ name, kind: '类型孤儿（只被声明，没有任何处理方）', hits: [...hits] });
    } else if (outsideDef.length === 1 && /service-worker\.ts|parallel-session\.ts/.test(outsideDef[0])) {
      dead.push({ name, kind: '零发送方（只有处理方，永不被走到）', hits: [...hits] });
    }
  }

  if (dead.length) {
    for (const d of dead) {
      fail(`${d.name} —— ${d.kind}　命中：${d.hits.join(', ')}`);
    }
  } else {
    ok(`${names.size} 个协议都有对端（发送方或处理方之外至少还有一个文件）`);
  }
}

// ── ① 扩展内部消息 kind：定义在 messages.ts 的 RuntimeRequest / RuntimeResponse
checkFamily('扩展内部消息 kind（`messages.ts`）', /\{\s*kind:\s*'([a-z][a-zA-Z0-9.]*)'/g);

// ── ② ISOLATED 桥的上行 op：定义在 types.ts 的 BridgeUpPayload
//    ★ 下行 op 不在此列：它们**只**由 background 发、由壳接，天然"两端各一个文件"，
//      按上面的规则会被误判成"零发送方"。上行才是本次出问题的那一侧。
checkFamily('桥上行 op（`types.ts` 的 BridgeUpPayload）', /\{\s*op:\s*'([a-zA-Z][a-zA-Z0-9]*)'/g);

console.log(`\n${bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`}`);
process.exit(bad === 0 ? 0 : 1);
