/**
 * 缺陷修复的**回归判据**（2026-10-12）。
 *
 *     node tools/verify/verify-defectfix.mjs      # 静态、秒级、不需要浏览器
 *
 * ## 为什么单独一个脚本
 *
 * 本轮的六个缺陷有一个共同特征：**修好之后 `typecheck` 与 `build` 都照样绿**
 * （它们全都不是类型错误，而是"两个事实不一致""走了补丁版 API""文案指向不存在的控件"）。
 * ⇒ 不给它们**能红的判据**，下一次重构会把它们原样带回来，而没人会发现。
 *
 * ## 每条判据都必须能回答「拆掉什么它才会红」
 *
 * | 组 | 断言 | 拆掉什么它会红 |
 * |---|---|---|
 * | A | `open()` 的 `reused` 只有一个来源 | 把 `return` 改回字面量 `reused: false` |
 * | B | 凭据只交给本账号站点自己的 frame | 删掉 `autoLoginRequest` 的来源域校验 |
 * | C | 叛逃清扫走**原生** IDB / CacheStorage | 改回 `indexedDB.databases()`（补丁版，恒不命中） |
 * | D | 界面文案不指向已废除的"数据源"控件 | 把"在数据源处"注回任一用户可见字符串 |
 * | E | 3 秒轮询不再无条件写盘 | 把 `loadSites` 的写盘守卫改回无条件 `set` |
 * | F | UI 通信层不再把 `undefined` 交给调用点 | 把 `send()` 改回裸 `resolve` |
 *
 * ★ 关于**是否剥离注释**（本仓规则 23）：两组判据的取法不同，且**都有理由**——
 *   · A / C / E / F 断言的是**代码结构**（"有没有那个字面量""调的是哪个 API"），
 *     而修复说明里**逐字引用了旧代码**（如注释里的 `reused: false`）⇒ **必须剥注释**，
 *     否则判据会被自己的解释性文字弄红（那正是规则 24 描述的情形）。
 *   · B / D 断言的是**用户可见字符串 / 处理分支的存在性**，它们的载体在运行时，
 *     注释里不该出现 —— 所以**不剥**，让"注释里写了但代码里没有"也能被发现。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as stripCommentsShared } from './_lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); bad++; };

/**
 * 只剥注释（不剥字符串字面量 —— 用户可见文案就在字符串里）。
 *
 * ★★ 必须用共享的**字符串感知**剥离器：非贪婪块注释正则会**跨字符串字面量**匹配，
 *   把真实代码整段吃掉。实测 `ui/parallel/parallel.ts` 的模板串 `*://${b}/*`
 *   让正则以为注释从此开始，一路吃掉 **3082 字符**活代码 ⇒ 本脚本的 E 组
 *   曾因此拿到被截断的函数体（"守卫在截断点之后"）。详见 `_lib/strip-comments.mjs`。
 */
const stripComments = stripCommentsShared;

const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');
const readCode = (rel) => stripComments(read(rel));

/**
 * 从 `signature` 所在处按**花括号配平**取出整个函数体。
 *
 * ★★ 为什么不能用 `/\n\}/` 收尾：本仓的函数体里**有缩进为 0 的内部块**
 *   （`loadSites` 里的 `if (…) { blocked.delete(host); }` 的收尾 `}` 就在第 0 列）
 *   ⇒ 那样取到的"函数体"其实**截断在第一个内部块**，后面的代码全都看不见。
 *   第一版判据正是这样错的：它报告"写盘没有守卫"，而实际上**守卫在截断点之后**。
 *   （教训与规则 23 同源：判据的**范围**没划对，结论就必然是错的 —— 而且错得像是发现了缺陷。）
 *
 * ★★ 必须在**未剥注释的原文**上取函数体，原因是个陷阱：
 *   `stripComments` 的 `/\/\*[\s\S]*?\*\//` 会**跨字符串字面量**匹配 ——
 *   当一行以 `/` 结尾（如 `…baseUrl}/` 或 `'…';` 之后紧跟 `/`），
 *   再遇到下一行的 `*`（如 `/* 注释` 或块注释），就会把**真实代码整段当成注释吃掉**。
 *   ⇒ 在剥过的文本上做配平会 `unbalanced`（实测）。
 *   原文里注释起止符只可能是真注释，配平是安全的。
 *
 * 只做最朴素的配平（忽略字符串/模板串里的花括号）—— 对本仓这几个函数的体量足够；
 * 一旦不成立会明确返回 `null`，而不是给一个错的结论。
 */
function functionBody(rawCode, signature) {
  const at = rawCode.indexOf(signature);
  if (at < 0) {
    return null;
  }
  const open = rawCode.indexOf('{', at);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < rawCode.length; i++) {
    const c = rawCode[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        // 取到的体可能带注释 ⇒ 交给调用方按需再剥
        return rawCode.slice(at, i + 1);
      }
    }
  }
  return null;
}

// ══════════════════════════ 前提
console.log('=== 前提 ===');
const PS = 'background/core/parallel-session.ts';
const SW = 'background/service-worker.ts';
const SHIELD = 'content/shield-main.ts';
const PAR = 'ui/parallel/parallel.ts';
const CLOUD = 'background/core/cloud-store.ts';
const SEND = 'ui/send.ts';

for (const [name, rel] of Object.entries({ PS, SW, SHIELD, PAR, CLOUD, SEND })) {
  try {
    read(rel);
    ok(`${name} 存在（${rel}）`);
  } catch {
    fail(`${name} 读不到（${rel}）—— 文件被挪走了？本判据的锚点要跟着改`);
  }
}
if (bad > 2) {
  console.error('\n前提不成立，后面每条都会误报，直接停。');
  process.exit(2);
}

// ══════════════════════════ A `reused` 单一来源
console.log('\n=== A. `open()` 的 `reused` 只有一个来源（曾经被算成两个值）===');
{
  const code = readCode(PS);
  // A1：不许有"把 reused 写死成字面量"的返回
  //   ★ 捕获组要写对：第一版用了非捕获组 `(?:false|true)`，却在消息里读 `literal[1]`
  //     ⇒ 报出来的是 `reused: undefined`（消息错了，判断是对的）。
  const literal = /reused:\s*(false|true)\b/.exec(code);
  if (literal) {
    fail(`出现了字面量 \`reused: ${literal[1]}\`（${literal[0]}）—— `
      + '该字段必须来自"复用判定"那一次计算，不能就地写死（两个来源迟早不一致，且不一致时不报错）');
  } else {
    ok('没有把 `reused` 写死成字面量');
  }
  // A2：必须真的算了一次，并在 forensics 与 return 两处复用它
  const decl = /const\s+reused\s*=\s*tabId\s*!==\s*null/.exec(code);
  if (!decl) {
    fail('找不到 `const reused = tabId !== null` —— 复用判定的唯一来源没了');
  } else {
    ok('复用判定只算一次（`const reused = tabId !== null`）');
  }
  const uses = (code.match(/\breused\b/g) ?? []).length;
  // 3 = 声明 1 + forensics 1 + return 1；≥3 即说明"算出来的那个值被两处共用"。
  // ★ 这里刻意**不按形状**匹配（第一版写成 `reused,` / `return { tabId, reused }`，
  //   结果把 `reused,` 也算漏了 —— 判据自己的正则比被验的代码更容易错）。
  if (uses < 3) {
    fail(`\`reused\` 全仓只出现 ${uses} 次（应 ≥3：声明 + forensics + return）—— `
      + '少一处就说明又分叉成两个来源了');
  } else {
    ok(`forensics 与 return 共用同一个 \`reused\`（共 ${uses} 次出现）`);
  }
}

// ══════════════════════════ B 凭据只交给本账号站点
console.log('\n=== B. 明文凭据只交给本账号站点自己的 frame（曾经任意 iframe 都能取）===');
{
  // ★★ 断言必须读**剥了注释的代码**，不能读原文：
  //   这批修复在源码里写了大段解释注释，而注释**逐字引用了**被修掉的旧写法
  //   （`reused: false`、`indexedDB.databases()`、`chrome.runtime.lastError`…）。
  //   读原文的话，断言会被**自己的说明文字**满足 —— 即"注释里写了就算通过"。
  //   ★ 这个错误我在 F 组上真的犯过一次：反证跑出来"判据没变红"，
  //     查下去才发现是文件头那两句说明里的 `lastError` 把断言喂饱了。
  const code = readCode(SW);
  const start = code.indexOf('CONTENT_MESSAGE.autoLoginRequest');
  const end = start < 0 ? -1 : code.indexOf('CONTENT_MESSAGE.autoLoginEvent', start);
  const branch = start < 0 || end < 0 ? null : code.slice(start, end);
  if (!branch) {
    fail('找不到 autoLoginRequest 的处理分支（锚点漂了？）');
  } else {
    const body = branch;
    if (!/boundHostOf\(/.test(body)) {
      fail('该分支没有取"本页签绑定的站点 host"（`boundHostOf`）—— 凭据又变成"只要是这个 tab 的 frame 就给"');
    } else {
      ok('取到了页签绑定的站点 host（`boundHostOf`）');
    }
    if (!/originHostOf\(/.test(body)) {
      fail('该分支没有解析请求方的来源域（`originHostOf`）—— 无法判断 frame 属于谁');
    } else {
      ok('解析了请求方 frame 的来源域（`originHostOf`）');
    }
    if (!/senderHost\s*!==\s*boundHostBare|senderHost\s*!==\s*boundHost\b/.test(body)) {
      fail('没有把"请求方来源域"与"绑定站点"做比对 —— 校验存在但没生效');
    } else {
      ok('来源域与绑定站点做了比对（不匹配即拒绝）');
    }
    if (!/hostNoPortOf\(/.test(body)) {
      fail('没有对绑定 host 做去端口归一化 —— 带端口的内网站点会**永远匹配不上**，'
        + '表现为自动填表对这类站点静默失效');
    } else {
      ok('两侧 host 已归一化（去端口），带端口站点不会误伤');
    }
  }
  // B2：归一化助手本身必须在（否则上面的调用是悬空的）
  //   ★ 同样必须读剥过注释的代码：头部说明里提到过这个函数名，
  //     读原文会让这条断言在"函数其实被删了"时照样绿。
  if (!/function\s+originHostOf\(/.test(readCode(SW))) {
    fail('`originHostOf` 没有定义 —— 上面的校验会直接抛（而抛在消息监听器里是静默的）');
  } else {
    ok('`originHostOf` 有定义');
  }
}

// ══════════════════════════ C 清扫走原生 API
console.log('\n=== C. 叛逃清扫走**原生** IDB / CacheStorage（曾经走补丁版 ⇒ 恒不命中）===');
{
  const code = readCode(SHIELD);
  // C1：清扫函数体内不许再出现补丁版的调用
  //   ★ 函数体在**原文**上取（见 functionBody 的说明），取到后再剥链注释。
  const rawFn = functionBody(read(SHIELD), 'function nsWipeShared(');
  if (!rawFn) {
    fail('找不到 `nsWipeShared` 函数体（锚点漂了？）');
  } else {
    const body = stripComments(rawFn);
    const patched = /\bindexedDB\.(?:databases|deleteDatabase)\s*\(|\bcaches\.(?:keys|delete)\s*\(/.exec(body);
    if (patched) {
      fail(`清扫里仍在调补丁版 \`${patched[0].trim()}\` —— 补丁会把 ns 前缀**剥掉**、`
        + '删除时又**再加一次**前缀，于是 `startsWith(ns)` 恒为 false：一个库都删不掉，且不报错');
    } else {
      ok('清扫不调用补丁版 IDB/CacheStorage');
    }
    if (!/rawIdbDatabases|rawCachesKeys/.test(body)) {
      fail('清扫没有使用原生函数引用（`rawIdbDatabases` / `rawCachesKeys`）');
    } else {
      ok('清扫使用原生函数引用（能看到真实库名/缓存名）');
    }
  }
  // C2：原生引用必须在**补丁之前**捕获（否则拿到的就是补丁版）
  const capIdx = code.indexOf('rawIdbDatabases');
  const patchIdx = code.indexOf("patch(idbProto, 'databases'");
  if (capIdx < 0 || patchIdx < 0) {
    fail('找不到原生引用捕获点或 IDB `databases` 补丁点（锚点漂了？）');
  } else if (capIdx > patchIdx) {
    fail('原生引用是在**补丁之后**捕获的 —— 那时它已经是补丁版了，等于没修');
  } else {
    ok('原生引用在补丁之前捕获（顺序正确）');
  }
  // C3：清扫结果必须回报（否则"清掉 0 个"与"根本没生效"不可分）
  if (!/nsWipeSharedDone/.test(readCode(SHIELD)) || !/nsWipeSharedDone/.test(readCode(PS))) {
    fail('清扫结果没有回报（壳侧或后台侧缺 `nsWipeSharedDone`）—— '
      + '"清扫成功且无事可做"与"清扫逻辑没生效"在取证里会长得一模一样');
  } else {
    ok('清扫结果有回报（壳 → 后台 forensics）');
  }
}

// ══════════════════════════ D 文案不指向已废除控件
console.log('\n=== D. 界面文案不指向已废除的"数据源"控件（v3.18 已删）===');
{
  const stale = [
    // ★ 这些是**当时逐字存在的用户可见指令**，允许出现在"修复说明"里 ⇒ 只在
    //   非注释的字符串字面量中搜（本判据的载体是运行时字符串，不是代码结构）。
    { re: /在数据源处/, what: '"在数据源处…"' },
    { re: /重新点击「云端」/, what: '"重新点击「云端」"' },
    { re: /点击「云端」/, what: '"点击「云端」"' },
  ];
  for (const [rel, label] of [[PAR, 'parallel.ts'], [CLOUD, 'cloud-store.ts']]) {
    // ★ 必须剥注释：**我自己的修复说明里逐字引用了那句旧文案**
    //   （"原文是「请…在数据源处…」"）—— 不剥的话，判据会被解释性文字弄红（规则 24）。
    const text = readCode(rel);
    const hits = stale.filter((s) => s.re.test(text));
    if (hits.length) {
      fail(`${label} 里仍有指向不存在控件的文案：${hits.map((h) => h.what).join('、')}`);
    } else {
      ok(`${label} 无"数据源"残留指令（已剥注释，只看代码）`);
    }
  }
  // D2：必须指向真实存在的控件
  const real = /重新登录/.test(read(CLOUD));
  if (!real) {
    fail('cloud-store.ts 的报错文案没有指向「重新登录」—— 用户仍然不知道该点哪里');
  } else {
    ok('报错文案指向真实存在的控件（「重新登录」）');
  }
}

// ══════════════════════════ E 轮询不再无条件写盘
console.log('\n=== E. 3 秒轮询不再无条件写盘（曾经稳态每 3 秒一次磁盘写）===');
{
  const code = readCode(PAR);
  const rawFn = functionBody(read(PAR), 'async function loadSites(');
  if (!rawFn) {
    fail('找不到 `loadSites` 函数体（锚点漂了？）');
  } else {
    const body = stripComments(rawFn);
    // E1：写盘必须被条件守卫包着。
    // ★ 第一版写成 `if\s*\([^)]*\)\s*\{` —— 而守卫的条件里**自己就带括号**
    //   （`JSON.stringify(a) !== JSON.stringify(b)`）⇒ `[^)]*` 在第一个 `)` 处就断了，
    //   于是真守卫被判成"没有守卫"。教训：**别用括号配平的正则去匹配含括号的表达式**。
    //   ⇒ 改成换个角度：找到那次写盘，看它**上一行非空内容**是不是 `if (…) {`。
    const setCall = [...body.matchAll(/chrome\.storage\.local\.set\(\{\s*\[LOCAL_KEYS\.blockedHosts\]/g)];
    if (!setCall.length) {
      fail('`loadSites` 里找不到 `blockedHosts` 的写盘（锚点漂了？）');
    } else if (setCall.length > 1) {
      fail(`\`blockedHosts\` 在 \`loadSites\` 里有 ${setCall.length} 处写盘（应恰好 1 处）`);
    } else {
      // ★ 必须回到**语句所在行的行首**再往上找，且**跳过注释与空行**
      //   （这批修复在上方写了多行说明注释 ⇒ "上一行非空内容"会是 `// ★★ 2026-10-12 修：…`）。
      const lineStart = body.lastIndexOf('\n', setCall[0].index) + 1;
      const above = body.slice(0, lineStart).split('\n').reverse();
      const before = above.find((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)) ?? '';
      if (!/^\s*if\s*\(.*\{\s*$/.test(before)) {
        fail('`blockedHosts` 的写盘没有被条件守卫包住（上一行非空内容是 '
          + `\`${before.trim().slice(0, 60)}\`）—— 它由 3s 轮询驱动，稳态下会一直写同一个值`);
      } else {
        ok('`blockedHosts` 写盘有守卫（仅在名单真的变化时写）');
      }
    }
    // E2：守卫必须比"内容"，不能只比 size（一减一增时 size 不变）
    if (/\.size\s*!==|\.length\s*!==/.test(body)) {
      fail('守卫比较的是**长度/size** —— 名单"一减一增"时长度不变，'
        + '于是该写的没写（而漏写是静默的）。要比较排序后的内容');
    } else {
      ok('守卫比较的是内容而不是长度（不会漏掉"一减一增"）');
    }
  }
}

// ══════════════════════════ F UI 通信层不把 undefined 交给调用点
console.log('\n=== F. UI 通信层不再把 `undefined` 交给调用点（曾经导致 refreshAll 中断）===');
{
  // ★★ 读**剥过注释的代码**：本文件顶部的修复说明里逐字写了
  //   `chrome.runtime.lastError` / "合成失败响应" / "setTimeout" 等词，
  //   读原文的话**四条断言全部会被说明文字满足** —— 实测反证时正是如此
  //   （"判据没变红"，查下去才发现断言读到的是注释）。
  // ★★ 必须**限定在 `send` 的函数体里**断言，不能扫整个文件。
  //   反证时注入的做法是"把修复前的实现另起一个函数名放回文件里" ——
  //   若扫全文件，`lastError` 这类字符串仍在（只是搬到了别的函数里），
  //   断言照样绿：它验的是"文件里有没有这个词"，而不是"`send` 有没有做这件事"。
  //   ★ 这是本判据第二次栽在同一件事上（第一次是读到了自己的注释）——
  //     根因都是**范围没划对**（规则 23）。
  const code = readCode(SEND);
  const sendBody = functionBody(code, 'export function send(');
  if (!sendBody) {
    fail('找不到 `send()` 的函数体（锚点漂了？）—— 后面四条断言无从谈起');
  } else if (!/chrome\.runtime\.lastError/.test(sendBody)) {
    fail('`send()` 没有读 `chrome.runtime.lastError` —— 拿不到失败原因，且浏览器会报 Unchecked runtime.lastError');
  } else {
    ok('`send()` 读了 `lastError`');
  }
  if (sendBody && !/synthFailure|result:\s*\{\s*ok:\s*false/.test(sendBody)) {
    fail('`send()` 不合成失败响应 ⇒ 空应答会把 `undefined` 交给调用点（读 `res.kind` 抛 TypeError）');
  } else if (sendBody) {
    ok('`send()` 合成失败响应（形状与后台 `dispatch` 的失败分支一致）');
  }
  if (sendBody && !/setTimeout\(/.test(sendBody)) {
    fail('`send()` 没有超时 —— 后台忙/SW 未起时调用点会永久 pending');
  } else if (sendBody) {
    ok('`send()` 有超时兜底');
  }
  // ★ 判据落在 `send` 体内的**调用点**（`log.warn(...)`），而不是模块顶部的
  //   `getForwardingLogger(...)` —— 后者在函数体外，把它当判据等于没验"失败时有没有留痕"。
  if (sendBody && !/\blog\.(warn|error|info|debug)\(/.test(sendBody)) {
    fail('`send()` 的失败路径没有留痕（体内无 `log.*` 调用）—— '
      + '静默的合成失败与"后台正常回了空数据"不可分（规则 29）');
  } else if (sendBody) {
    ok('`send()` 的失败有留痕（体内 `log.*` 调用）');
  }
}

console.log(`\n${bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`}`);
process.exit(bad === 0 ? 0 : 1);
