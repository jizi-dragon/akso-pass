/**
 * 验收：日志打码通道（`src/shared/redact.ts` + `src/shared/log.ts`）。
 *
 * 两侧都要验：
 *   · **漏**（false negative）⇒ 凭据真的进了 DevTools / 诊断缓冲，最严重的失败；
 *   · **过度**（false positive）⇒ 正常信息被打掉，日志失去价值，
 *     于是有人会去把打码关掉 —— 那是**下一条**泄露路径。
 *
 * ★ 这个脚本**必须能红**。改完打码规则后如果它仍然全绿，先怀疑它没在验东西。
 *
 * 跑法：node tools/verify/verify-log-redaction.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// ★ 仓库根：tools/verify/ 往上两层。少一层会静默指向 tools/（AGENTS.md 规则 15）
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');

// 直接把 TS 源当文本读进来太脆（要剥类型）。改用 esbuild 现场转译，
// 它与真实构建用同一个编译器 ⇒ 验的就是将要发布的那份代码。
//
// ★ 用 iife + globalName 而不是 format:'esm'：esm 产物导出来时拿不到命名导出
//   （实测 `redact is not a function`）。iife 把导出挂到一个名字上，
//   再用 `new Function` 求值取回来 —— 不依赖 Node 的模块解析，也就不用引 `vm`。
const esbuild = await import('esbuild');
const REDACT_TS = join(SRC, 'shared', 'redact.ts');
const LOG_TS = join(SRC, 'shared', 'log.ts');

const bundle = await esbuild.build({
  entryPoints: [LOG_TS],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: '__qlLog',
  target: 'chrome110',
  platform: 'browser',
  logLevel: 'silent',
});
const code = bundle.outputFiles[0].text;
const mod = new Function(`${code}\nreturn __qlLog;`)();
const { redact, REDACTED, formatArgs, getLogger, setLogLevel, drain, clearBuffer } = mod;
void formatArgs; // 目前只用它做内部拼接，保留解构以便后续加用例

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

// ---------------------------------------------------------------- ① 必须打掉
console.log('\n=== 1. 必须被打掉的（漏了就是凭据外泄）===');
const SECRETS = [
  ['等号赋值', 'password=Liyulong0901', 'Liyulong0901'],
  ['冒号赋值', 'token: abcdef1234567890', 'abcdef1234567890'],
  ['大写键名', 'PASSWORD=hunter2xyz', 'hunter2xyz'],
  ['连字符键名', 'api-key=sk-abcdefghijklmn', 'sk-abcdefghijklmn'],
  ['下划线键名', 'private_key=secretvalue', 'secretvalue'],
  // ★ 下面几条是实测踩过的边界，都曾经**完全绕过**打码
  ['JSON 键名带引号', '"secret": "s3cr3t-value-here"', 's3cr3t-value-here'],
  ['整个 JSON 对象', '{"password": "p@ss", "token": "t0k3n9x"}', 'p@ss'],
  ['JSON 第二个键', '{"password": "p@ss", "token": "t0k3n9x"}', 't0k3n9x'],
  ['单引号包键名', "secret='x'", 'x'],
  ['Bearer 头', 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def', 'eyJhbGciOiJIUzI1NiJ9'],
  ['Basic 头', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
  ['设备流 device_code', 'GET /device-token?device_code=9f8e7d6c5b4a', '9f8e7d6c5b4a'],
  ['设备流 user_code', 'GET /approve?user_code=WXYZ-1234', 'WXYZ-1234'],
  ['Fernet 密钥', 'fernetKey = dGhpcy1pcy1hLWZha2UtMzJieXRlLWtleS1mb3ItdGVzdA==',
    'dGhpcy1pcy1hLWZha2UtMzJieXRlLWtleS1mb3ItdGVzdA=='],
  ['裸长十六进制', 'hash 8f14e45fceea167a5a36dedd4bea2543 end',
    '8f14e45fceea167a5a36dedd4bea2543'],
  ['平台的 encKey', 'encKey: 3c9909afec25354d551dae21590bb26e', '3c9909afec25354d551dae21590bb26e'],
];
for (const [label, sample, secret] of SECRETS) {
  const out = redact(sample);
  check(`${label}: ${sample.slice(0, 46)}`, !out.includes(secret), `-> ${out.slice(0, 58)}`);
}

// ★ 单字符凭据要**单独**断言：不能查"这个字符在不在结果里" ——
//   占位符 `«已打码»` **本身就含 `a`**（"打码"的拼音），
//   于是 `!out.includes('a')` 会因占位符而失败，看起来像漏打码，其实是打码成功了。
{
  const out = redact('password="a"');
  check('单字符短口令（单独断言，避开占位符里的 a）',
    out === `password="${REDACTED}"`, `-> ${out}`);
}

// ---------------------------------------------------------------- ② 不该打掉
console.log('\n=== 2. 不该被打掉的（过度匹配会让日志失去价值）===');
const KEEP = [
  'user@example.com',
  '115.231.78.4:44791',
  'GET /api/vault/snapshot HTTP/1.1 200 OK',
  'ql:auto-login',
  '账号 42 个，站点 7 个',
  '9f2c1b3a-4d5e-6f70-8192-a3b4c5d6e7f8',
  '2026-10-09 13:08:19.123',
  'status=active',
  'tabId=12345 frameId=0',
];
for (const sample of KEEP) {
  const out = redact(sample);
  check(`${sample.slice(0, 46)}`, out === sample, out === sample ? '' : `-> ${out}`);
}

// ---------------------------------------------------------------- ③ 幂等
console.log('\n=== 3. 幂等（Formatter / sink 可能被复用多层）===');
{
  const once = redact('password=abc12345');
  check('打两次与打一次相同', redact(once) === once, `${once} -> ${redact(once)}`);
}

// ---------------------------------------------------------------- ④ log() 端到端
console.log('\n=== 4. log() 的端到端（对象序列化 + 打码）===');
{
  clearBuffer();
  setLogLevel('debug');
  const captured = [];
  const realConsole = { ...console };
  for (const m of ['debug', 'info', 'warn', 'error']) console[m] = (...a) => captured.push(a.join(' '));

  const lg = getLogger('test');
  lg.info('password=%s', 'Liyulong0901');
  lg.warn('token=abcdef1234567890');
  // ★ 对象直传 —— 这正是"今天只有计数、明天塞进口令"的那个形态
  lg.error('submit rejected', { username: 'alice', password: 'sup3rs3cret', attempts: 3 });
  lg.debug('正常信息：user@example.com tabId=42');

  for (const m of ['debug', 'info', 'warn', 'error']) console[m] = realConsole[m];

  const joined = captured.join('\n');
  check('log() 里的分隔参数口令被打掉', !joined.includes('Liyulong0901'));
  check('log() 里的 token 被打掉', !joined.includes('abcdef1234567890'));
  check('★ 对象里的 password 被打掉（对象直传路径）', !joined.includes('sup3rs3cret'));
  check('对象的其它字段仍可读（没被整个吞掉）', joined.includes('alice') && joined.includes('attempts'));
  check('正常信息保留', joined.includes('user@example.com') && joined.includes('tabId=42'));
  check('命名空间前缀存在', joined.includes('ql:test'));

  const buf = drain();
  check('环形缓冲里也没有凭据', !JSON.stringify(buf).includes('sup3rs3cret'));
  check('环形缓冲真的收到了记录', buf.length >= 4, `${buf.length} 条`);
  check('缓冲里的 msg 已打码', buf.every((r) => !r.msg.includes('Liyulong0901')));
}

// ---------------------------------------------------------------- ⑤ 结构化：绕不过去
console.log('\n=== 5. 结构：除 log.ts 外不许直接调 console ===');
{
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.ts')) continue;
      if (full === LOG_TS) continue;                       // 唯一允许的地方
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        // 只看**代码**：跳过整行注释
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug)\b/.test(line)) {
          offenders.push(`${full.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
  };
  walk(SRC);
  check(
    '源码里零裸 console.*（log.ts 除外）',
    offenders.length === 0,
    offenders.length ? `命中 ${offenders.length} 处：${offenders.join(', ')}` : '',
  );
}

// ---------------------------------------------------------------- ⑥ 闭环：日志必须有人读
console.log('\n=== 6. 闭环：`shared/log.ts` 的产出必须有消费者 ===');
{
  // ★ 这一节是"零裸 console"的**对偶**，两者缺一不可：
  //
  //   | 判据 | 防的是 |
  //   |---|---|
  //   | 零裸 console | 绕开通道**写**出去（凭据外泄） |
  //   | 有人 `drain()` | 写进通道**没人读**（等于没有日志） |
  //
  // 实测发现（2026-10-09）：`drain()` 的调用点是**零** ——
  // `shared/log.ts` 只被 `content/auto-login.ts` import（取 `getLogger`），
  // 而环形缓冲是**纯内存**的。于是日志只出现在 DevTools 控制台，
  // **诊断包里一条都没有**，SW 一被回收就永远看不到了。
  // 那不是"日志少"，是**日志系统没闭环**。
  const consumers = [];
  const walk2 = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walk2(full); continue; }
      if (!name.endsWith('.ts') || full === LOG_TS) continue;
      const text = readFileSync(full, 'utf8');
      text.split('\n').forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/\bdrain\s*\(/.test(line)) {
          consumers.push(`${full.replace(ROOT + '\\', '').replace(ROOT + '/', '')}:${i + 1}`);
        }
      });
    }
  };
  walk2(SRC);
  check('`drain()` 至少有一个消费者（否则日志没人读）', consumers.length > 0,
    consumers.length ? consumers.join(', ') : '★ 零调用点');

  // 消费者必须是**能带上诊断包**的那条路：`ql.diag` handler。
  const sw = readFileSync(join(SRC, 'background', 'service-worker.ts'), 'utf8');
  const diagCase = /case 'ql\.diag'[\s\S]*?return \{ kind: 'ql\.diag'/.exec(sw);
  check('`ql.diag` handler 把日志缓冲带上（诊断包才拿得到）',
    !!diagCase && /out\.logs\s*=\s*drain\(\)/.test(diagCase[0]));

  // 前端诊断包必须**收**它（否则 handler 带了也没人写进文件）
  const panel = readFileSync(join(SRC, 'ui', 'parallel', 'parallel.ts'), 'utf8');
  const bundle = /const bundle = \{[\s\S]*?\n    \};/.exec(panel);
  check('诊断包的 bundle 里含 `appLogs`', !!bundle && /appLogs\s*:/.test(bundle[0]));
  check('诊断包的 bundle 里含 `logLevel`', !!bundle && /logLevel\s*:/.test(bundle[0]));

  // ★ 判据自身的前提：确认我读到了那两段代码（见 PITFALLS #13 —— 取不到时代码
  //   会静默返回空串、断言恒假，而报错读起来像"被测代码有问题"）
  check('判据前提：确实取到了 `ql.diag` 的 case 块', !!diagCase);
  check('判据前提：确实取到了诊断包的 bundle 块', !!bundle);
}

// ---------------------------------------------------------------- 工具

/**
 * 剥掉**注释**与**字符串字面量**后的代码。
 *
 * ## ★ 为什么每个"结构判据"都要先用它（本仓第四次踩同一个坑）
 *
 * 我曾在代码旁写"这里原先写的是 `diag(...)`"来解释降级原因 ——
 * 而裸的 `/\bdiag\s*\(/` **命中了那句注释**，判据假红。
 * 同一个坑的历史：`urlTransform`（PITFALLS #1）、`RETURNING`（#14）、
 * `is_admin`（akso-cloud #19）。规律：**「解释为什么不用 X」的文本必然包含 X。**
 *
 * ⇒ 判据只看**运行时会执行的东西**。
 *   ★ 顺序要紧：**先剥字符串再剥行注释**，否则 `'//'` 这种字面量会把后面的
 *     真代码当注释吃掉（反向失效，那是更坏的一类）。
 */
const stripLiterals = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, ' ')                       // ① 块注释
  .replace(/`(?:\\[\s\S]|[^`\\])*`/g, '``')                // ② 模板串
  .replace(/'(?:\\[\s\S]|[^'\\\n])*'/g, "''")              // ③ 单引号串
  .replace(/"(?:\\[\s\S]|[^"\\\n])*"/g, '""')              // ④ 双引号串
  .replace(/\/\/[^\n]*/g, ' ');                            // ⑤ 行注释（必须在字符串之后）

// ---------------------------------------------------------------- ⑦ 三通道分工
console.log('\n=== 7. 三通道分工：`diag()` 不许写在热路径上 ===');
{
  // ## 为什么需要这一节
  //
  // `ql:diag` 是 **环形 60** 的 `storage.local` 缓冲，而写它的调用点有 **45 个**
  // （`tab-rules.ts` 5 + `parallel-session.ts` 40）。也就是说它的容量是**稀缺资源**。
  //
  // 实测发现（2026-10-09）：`parallel-session.ts` 的 `isEnforceable()` **缓存命中**
  // 那一支在**每次调用**时都写一条 `diag()` —— 而它在每一次导航 / 每一次请求判定上
  // 都会被调用。后果不是"日志多"，而是**把有用的日志挤掉**：
  // `tab-rules.ts` 的 `addRule #N 失败`（DNR 规则装不上 —— 历史上整个网络平面
  // 因此一起死过）会在几秒内被"缓存命中"刷出缓冲。
  //
  // ⇒ 这是一条**设计规则**，不是风格偏好：
  //
  //   | 通道 | 存储 | 谁该用 |
  //   |---|---|---|
  //   | `log.debug()` | 内存环形 200 + DevTools | **热路径**（默认 `info` 级 ⇒ 生产静默、零存储开销） |
  //   | `diag()` | `storage.local` 环形 60 | **罕见但关键**：失败 / 降级 / 状态跃迁 |
  //   | `forensics()` | `storage.local` 环形 120 | **结构化事件**（可按字段过滤、进诊断包） |
  const ps = readFileSync(join(SRC, 'background', 'core', 'parallel-session.ts'), 'utf8');

  // 取指定函数体（跳过参数表再配平 —— 见 PITFALLS #13，别从签名开头数花括号）
  const bodyOf = (src, name) => {
    const head = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
    ).exec(src);
    if (!head) return null;
    let depth = 0;
    let bodyStart = -1;
    for (let j = src.indexOf('(', head.index); j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          const brace = src.indexOf('{', j);
          if (brace < 0) return null;
          bodyStart = brace;
          break;
        }
      }
    }
    if (bodyStart < 0) return null;
    let d = 0;
    for (let j = bodyStart; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) return src.slice(bodyStart, j + 1); }
    }
    return null;
  };

  const enfBody = bodyOf(ps, 'isEnforceable');
  check('判据前提：确实取到了 `isEnforceable` 的函数体', enfBody !== null);

  const enfCode = enfBody ? stripLiterals(enfBody) : '';

  // ★★ 判据必须落在**那个具体分支**上，不能落在整个函数体上。
  //
  // 第一版写的是"整个 `isEnforceable` 里没有 `diag()`" —— 实测**假红**，
  // 而且假红得**很有道理**：函数里另外两处 `diag()`（停用名单 / 授权实查）
  // **每个 host 只走一次**（之后进 `enforcement` 缓存）⇒ 它们根本不是热路径，
  // 留在 `diag()` 里是对的（它们是"罕见但关键"：网络平面能否执行的判定依据）。
  //
  // 真正每次调用都会走到的是**缓存命中**那一支。⇒ 只断言它。
  // （教训：判据的范围要按**代码的真实控制流**划，不能按"我改过这个函数"划。）
  const quickReturn = /if\s*\(\s*cached\s*!==\s*undefined\s*\)\s*\{([\s\S]*?)\n\s*\}/.exec(enfCode);
  check('判据前提：确实取到了 `isEnforceable` 的缓存命中分支', quickReturn !== null);
  const branch = quickReturn ? quickReturn[1] : '';
  check(
    '缓存命中分支（真热路径）里没有 `diag()` —— 它每次调用都会走到',
    !!quickReturn && !/\bdiag\s*\(/.test(branch),
    /\bdiag\s*\(/.test(branch) ? '★ 热路径又在写 storage 缓冲了' : '',
  );
  check('缓存命中分支有 `log.debug` 轨迹（降级不是删掉）', /log\.debug\(/.test(branch));

  // 反向：`diag()` 必须**仍然**用在罕见失败面（否则这次"降级"被误读成"日志都该删"）
  check('`diag()` 仍被用于罕见失败面（未被一刀切删掉）',
    /\bvoid diag\(/.test(stripLiterals(ps)));

  // 三通道的命名空间前缀必须一致（都经 `getLogger`，不直接 console）
  check('`parallel-session` 模块取 logger 走 `getLogger`',
    /getLogger\('parallel-session'\)/.test(ps));
}

// ---------------------------------------------------------------- ⑧ 离线判定只有一处
console.log('\n=== 8. 离线判定：`OfflineError` / `isOfflineError` 只有一处声明 ===');
{
  // ## 为什么这条值得单列
  //
  // 实测（2026-10-09）：`parallel-store.ts` **自己又定义了一份** `OfflineError`
  // 与 `isOfflineError`（与 `offline.ts` 逐字相同的第二个副本）。
  //
  // 它当时**没有**出问题 —— 因为判定看的是**标记字段**
  // （`e.isOfflineError === true`）而不是 `instanceof`，所以两份类定义的实例互相认得。
  //
  // ★ 但这正是 `offline.ts` 文件头警告过的形态：只要有人把判定
  //   "顺手改成 `instanceof`"（那看起来是**更正规**的写法），
  //   离线回落就会**静默失效** —— 表现是"离线时列表空了"，而不是任何报错。
  //   ⇒ 一个类型只有一处声明，是这条静默失效路径的**唯一**结构性防线。
  //
  // ★ 顺带钉住"判定必须用标记字段"：那是让两份定义也能互通的**唯一**原因，
  //   也是跨打包边界（esbuild `iife`）仍然正确的原因。
  const walkTypes = [];
  const walkDir = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkDir(full); continue; }
      if (name.endsWith('.ts')) walkTypes.push(full);
    }
  };
  walkDir(SRC);

  const classDefs = [];
  const fnDefs = [];
  for (const f of walkTypes) {
    const code = stripLiterals(readFileSync(f, 'utf8'));
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    if (/export\s+class\s+OfflineError\b/.test(code)) classDefs.push(rel);
    if (/export\s+function\s+isOfflineError\s*\(/.test(code)) fnDefs.push(rel);
  }

  check('`OfflineError` 类只声明一处', classDefs.length === 1,
    classDefs.length === 1 ? classDefs[0] : `★ ${classDefs.length} 处：${classDefs.join(', ')}`);
  check('`isOfflineError` 只声明一处', fnDefs.length === 1,
    fnDefs.length === 1 ? fnDefs[0] : `★ ${fnDefs.length} 处：${fnDefs.join(', ')}`);

  // 判定必须用**标记字段**，不能用 `instanceof`
  const offlineSrc = readFileSync(join(SRC, 'background', 'core', 'offline.ts'), 'utf8');
  const fnBody = /export\s+function\s+isOfflineError[\s\S]*?\n\}/.exec(stripLiterals(offlineSrc));
  check('判据前提：取到了 `isOfflineError` 的函数体', fnBody !== null);
  check('判定用标记字段（`isOfflineError === true`），**不用** `instanceof`',
    !!fnBody && /isOfflineError\s*===\s*true/.test(fnBody[0]) && !/instanceof/.test(fnBody[0]));

  // 离线回落的分支必须有日志（否则"为什么离线还能看/为什么改不了"无从查起）
  const psrc = stripLiterals(readFileSync(join(SRC, 'background', 'core', 'parallel-store.ts'), 'utf8'));
  check('离线回落分支有日志（`log.warn` 出现在 loadSnapshot 附近）',
    /log\.warn\([^)]*离线[\s\S]{0,200}?loadSnapshot\(/.test(psrc)
    || /loadSnapshot\(\)[\s\S]{0,120}?log\.warn\(/.test(psrc));
}

// ---------------------------------------------------------------- ⑨ SW 入口不静默
console.log('\n=== 9. SW 入口：消息分流不许静默落空 ===');
{
  // ## 这一节防的是什么
  //
  // 实测（2026-10-09）：`service-worker.ts` 的 `dispatch()` 的 switch **没有 `default`**。
  //
  // 后果很隐蔽：一个未知（拼错 / 已删 / UI 与 SW **版本不匹配**）的 `kind`
  // 让 switch 静默落空，而 `dispatch()` 的返回类型是 `Promise<RuntimeResponse>`
  // ⇒ TypeScript 认为**一定有返回值** ⇒ `undefined` 静默流向 `sendResponse(undefined)`。
  // UI 侧拿到 `undefined`，一句"点了没反应"背后**没有任何线索**，
  // 而 `fail()`（所有 handler 失败的收口）当时也**完全静默**。
  //
  // ⇒ 三件事一起钉住：① 有 `default`；② `default` 与 `fail` 都记日志；
  //   ③ `dispatch` 的 case 与消息契约**同步**（那是"两处声明同一事实"，
  //      不一致时的失败形态正是上面那个静默落空）。
  // ★★ 这里的**剥离范围**踩了两个坑，都值得记：
  //
  //   ① `@ts-expect-error` **本身是注释** ⇒ 在 `stripLiterals` 之后**查不到**。
  //      它必须去**原始**源码里找。
  //   ② 契约里的 `kind: 'par.list'` —— 那个 `'par.list'` **是字符串字面量**，
  //      被剥成 `''` ⇒ 提取到 **0 个 kind**。
  //      而 `[...].every()` 对**空集合返回 true** ⇒ "契约同步"那条判据
  //      会**退化成永远绿**（正是 akso-cloud PITFALLS #10 那个形态：
  //      `check_deps.mjs` 的检查数掉到 0 而它打印「检查 0 处」看起来完全正常）。
  //
  //   ⇒ 规则：**"剥注释"只用于"怕被自己的解释性文字弄红"的断言**；
  //     凡是要**读字符串字面量的内容**的断言，必须用**原始**源码。
  //     并且对"集合可能为空"的判据一律加**自证前提**。
  const swSrc = readFileSync(join(SRC, 'background', 'service-worker.ts'), 'utf8');
  const swCode = stripLiterals(swSrc);

  // dispatch 的函数体：结构（有 default / 有 log.error）用剥过的版本，
  // 但 `@ts-expect-error` 要从**原始**里取对应区间。
  const dispatchBody = /async function dispatch\(req: RuntimeRequest\)[\s\S]*?\n\}/.exec(swCode);
  check('判据前提：取到了 `dispatch` 的函数体', dispatchBody !== null);
  const d = dispatchBody ? dispatchBody[0] : '';

  check('`dispatch` 有 `default` 分支（未知 kind 不再静默落空）', /^\s*default:\s*\{/m.test(d));
  check('`default` 分支记了日志', /default:\s*\{[\s\S]{0,400}?log\.error\(/.test(d));

  // ★ 用**原始**源码取 default 分支那一段，再找注释。
  //
  // ★★★ 锚点换过两次，都值得记：
  //   ① 第一版用 `/async function dispatch\(…\)[\s\S]*?\n  \}\n\}/`
  //      —— 它**靠缩进猜函数的收尾**。我在文件顶部插入新的顶层代码后，
  //      这个假设不成立了 ⇒ `rawDefault` 为空 ⇒ 报出来的是
  //      "`default` 没标 @ts-expect-error"（**指向错误的根因**）。
  //   ② 第二版我改成匹配注释里的句子，而**我把 `⇒` 漏了**
  //      ⇒ 仍然匹配不上，而这次我差点又去改断言而不是改锚点。
  //   ⇒ 定稿：从 **`default: {` 标签本身**起捕获，到那句**独特的 `fail(`** 为止。
  //     它不依赖缩进、不依赖函数边界、也不依赖注释措辞 —— 只依赖这段代码自己的内容。
  //   ★ 而"那句 unique 尾部"我**第一版也写错了**：我以为 default 分支里是
  //     `throw new Error(...)`（它其实是 `return { kind, result: fail(...) }`）。
  //     ⇒ 锚点必须是**实测读出来的**，不能从记忆里写（规则 23：先实证打印，别猜）。
  const rawDefault = (/\n\s*default:\s*\{[\s\S]*?fail\(/.exec(swSrc) ?? [''])[0];
  check('`default` 用 `@ts-expect-error` 显式标注类型逃逸',
    /@ts-expect-error/.test(rawDefault));
  check('判据前提：确实取到了 `default` 分支的原文', rawDefault.length > 0);

  // `fail()` 是全部 26 个消息类型的失败收口 —— 它必须记日志
  const failBody = /function fail\(error: unknown\)[\s\S]*?\n\}/.exec(swCode);
  check('判据前提：取到了 `fail` 的函数体', failBody !== null);
  check('`fail()` 记了日志（26 个 handler 的失败收口）',
    !!failBody && /log\.error\(/.test(failBody[0]));

  // `dispatch` 入口有 trace（"消息到底有没有到 SW"）
  check('`dispatch` 入口有 `log.debug` trace', /log\.debug\(/.test(d));

  // ---------- 契约与实现同步（用**原始**源码：kind 名是字符串字面量） ----------
  /*
   * ★★ v4.2.12：这一段**返工了两次，两次都是"锚点自己坏了"**，值得完整记下来。
   *
   * ## 第一次：行尾（CRLF）
   *
   * 原来的正则结尾写作 `;\n`，而 `messages.ts` 是 **CRLF** ⇒ `;\r\n` 匹配不上
   * ⇒ `reqUnion === null` ⇒ kind 集合**恒为空** ⇒
   * 「契约里的每个 kind 都有处理分支」在空集上 `every()` **恒真**（假绿）。
   * 屏幕上只有三条读起来像"脚本自己坏了"的红。
   * ⇒ 我先加了 `replace(/\r\n/g, '\n')`，变成"10 个 kind"。
   *
   * ## 第二次：**注释里的一句分号**
   *
   * 归一化之后只剩 10 个 kind，而实际有 35 个。根因：正则是**非贪婪**的
   * `([\s\S]*?);\n` —— 它停在**第一个** "分号 + 换行" 处，而那个位置是
   * 我刚写进 `par.deleteSite` 的 JSDoc 里的一句普通文字（`…先建再写名）。`）。
   * ⇒ 联合被从注释中间截断。
   *
   * ★ 两次的**同一个病根**：**用"文本形态"去圈定一段类型定义**。
   *   而 `messages.ts` 这个文件里，注释本来就可能包含任何字符
   *   （它甚至大量引用 `kind: 'x'` 这种字面量来讲解协议）。
   *
   * ⇒ 定稿：**不再用正则圈范围，改用 TypeScript 自己的解析器**
   *   （`typescript` 已是本仓 devDependency，与 `tsc` 用的是同一个版本）。
   *   它按**语法**取联合成员，注释、行尾、缩进、成员顺序一概不影响。
   *   ★ 这也让下面那条"契约 kind 集合非空"的自证变得**真的有意义**：
   *     以前它在"解析宽度漂了但恰好非空"时会照样绿。
   */
  const ts = await import('typescript');
  const msgsRaw = readFileSync(join(SRC, 'shared', 'messages.ts'), 'utf8');
  const sf = ts.createSourceFile('messages.ts', msgsRaw, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let reqUnionType = null;
  sf.forEachChild((n) => {
    if (ts.isTypeAliasDeclaration(n) && n.name.text === 'RuntimeRequest') {
      reqUnionType = n.type;
    }
  });
  const reqUnion = reqUnionType ? { 1: msgsRaw.slice(reqUnionType.pos, reqUnionType.end) } : null;
  check('判据前提：取到了 `RuntimeRequest` 联合', reqUnion !== null);
  const reqKinds = new Set(
    (reqUnionType && ts.isUnionTypeNode(reqUnionType) ? reqUnionType.types : [])
      .map((t) => {
        // 成员形如 `{ kind: 'par.list' }`；取那个 kind 属性的**字面量文本**
        const m = ts.isTypeLiteralNode(t)
          ? t.members.find((x) => ts.isPropertySignature(x) && x.name?.getText(sf) === 'kind')
          : undefined;
        const lit = m?.type;
        return lit && ts.isLiteralTypeNode(lit) && ts.isStringLiteral(lit.literal) ? lit.literal.text : null;
      })
      .filter(Boolean),
  );
  const caseKinds = new Set(
    (swSrc.match(/case\s*'[^']+':/g) ?? []).map((s) => /'([^']+)'/.exec(s)[1]),
  );
  // 在 `onMessage` 里**前置分流**（不进 dispatch 的 switch）的 kind
  const preKinds = new Set(
    (swSrc.match(/\.kind === '[^']+'/g) ?? []).map((s) => /'([^']+)'/.exec(s)[1]),
  );

  // ★★ 空集自证：集合为空时下面两条 `every` 会**恒真**（假绿）。
  //   实测踩过：剥离把 kind 名弄成空串，于是 `reqKinds` 为空，
  //   两条断言"都通过"而其实什么都没验。
  check('判据前提：契约 kind 集合非空', reqKinds.size > 0, `${reqKinds.size} 个`);
  check('判据前提：dispatch case 集合非空', caseKinds.size > 0, `${caseKinds.size} 个`);

  check('契约里的每个 kind 都有处理分支（dispatch 或前置分流）',
    [...reqKinds].every((k) => caseKinds.has(k) || preKinds.has(k)),
    [...reqKinds].filter((k) => !caseKinds.has(k) && !preKinds.has(k)).join(', '));
  check('`dispatch` 没有契约之外的孤例 case',
    [...caseKinds].every((k) => reqKinds.has(k)),
    [...caseKinds].filter((k) => !reqKinds.has(k)).join(', '));
  console.log(`      （契约 ${reqKinds.size} 个 kind；dispatch 侧 ${caseKinds.size} 个 case；`
    + `前置分流 ${preKinds.size} 个）`);
}

// ---------------------------------------------------------------- ⑩ 网络平面失败可见
console.log('\n=== 10. 网络平面：规则装不上/摘不掉必须可见 ===');
{
  // ## 这一节防的是什么
  //
  // `tab-rules.ts` 是**七个隔离平面里的网络平面**（AUTH + COOKIE 两条 DNR 规则）。
  // 历史教训（`PITFALLS #1`、`#8`）：`updateSessionRules` 的失败会让
  // **整个网络平面一起死**，而当时唯一的信号只有一行 `diag()`（环形 60，会被挤掉）。
  //
  // ★★ 更危险的是**两条规则都装失败**那种形态：
  //   页签**完全没有网络平面保护**（既不回放 Cookie，也不改 AUTH 头），
  //   而它与"装好了"在界面上**长得一样** —— 平台照样能打开，
  //   只是**以错误的身份在跑**（串号）。
  //
  // ⇒ 钉住三件事：① `addOne` 失败必须 `log.error`；② `applyBinding` 必须对
  //   "该装却装不上"报 `log.error`（而不是只写 `debug` 轨迹）；
  //   ③ 移除失败也必须 `log.error`（它的方向与安装失败**相反**：
  //   装了没生效 vs 该失效的还生效）。
  //
  // ★ 读取方式遵循规则 24：这些断言找的都是**代码标识符**（`log.error(` / `getLogger(`），
  //   不是字符串字面量的内容 ⇒ 用剥过的源码（避免被自己的注释弄红）。
  //   而"哪个函数体"用与第 7 节相同的 `bodyOf`（跳过参数表再配平）。
  // ★★ 这一节**又踩了规则 24 那个坑的变体**，两次都值得记：
  //
  //   ① `getLogger('tab-rules')` 里的 `'tab-rules'` 是**字符串字面量** ⇒
  //      剥过之后变成 `getLogger('')` ⇒ 断言查不到。
  //   ② 更隐蔽：我要断言的 AUTH / COOKIE / "移除" 这些关键字
  //      **也都在 `log.error('...')` 的字符串里** ⇒ 同样被剥掉。
  //
  //   ⇒ 规则（与 #24 一致，但这次要**在同一节里混用两种源码**）：
  //     · 找**标识符**（`log.error(` / `diag(` / `log.debug(` / `getLogger`）→ 用**剥过的**
  //     · 找**字面量的内容**（`'tab-rules'` / `AUTH` / `COOKIE` / `移除`）→ 用**原文**
  //     ★ 而"哪个函数体"必须从**同一份**源码里切出来 —— 不能拿剥过的边界去原文里查
  //       （行号虽然一致，但混用容易出错）。所以下面切两遍，各查各的。
  const trSrc = readFileSync(join(SRC, 'background', 'core', 'tab-rules.ts'), 'utf8');
  const trCode = stripLiterals(trSrc);

  const bodyOfFn = (src, name) => {
    const head = new RegExp(
      `(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`,
    ).exec(src);
    if (!head) return null;
    let depth = 0;
    let bodyStart = -1;
    for (let j = src.indexOf('(', head.index); j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') {
        depth--;
        if (depth === 0) {
          const brace = src.indexOf('{', j);
          if (brace < 0) return null;
          bodyStart = brace;
          break;
        }
      }
    }
    if (bodyStart < 0) return null;
    let d = 0;
    for (let j = bodyStart; j < src.length; j++) {
      if (src[j] === '{') d++;
      else if (src[j] === '}') { d--; if (d === 0) return src.slice(bodyStart, j + 1); }
    }
    return null;
  };
  /** `applyBinding` 是对象方法而非 function 声明，单独取（剥过/原文各切一次） */
  const applyOf = (src) => {
    const m = /async applyBinding\([\s\S]*?\n  \},/.exec(src);
    return m ? m[0] : null;
  };

  // ① 找标识符 ⇒ 用剥过的
  check('`tab-rules` 取 logger 走 `getLogger`', /getLogger\(/.test(trCode));
  // ② 找字面量内容 ⇒ 用原文
  check('`tab-rules` 的 logger 命名空间是 `tab-rules`', /getLogger\('tab-rules'\)/.test(trSrc));

  const addOne = bodyOfFn(trCode, 'addOne');
  check('判据前提：取到了 `addOne` 的函数体', addOne !== null);
  check('`addOne` 失败时 `log.error`（装不上必须显眼）',
    !!addOne && /log\.error\(/.test(addOne));
  check('`addOne` 仍然写 `diag()`（人读文本，进诊断包）',
    !!addOne && /diag\(/.test(addOne));

  const abCode = applyOf(trCode);
  const abRaw = applyOf(trSrc);
  check('判据前提：取到了 `applyBinding` 的实现（剥过）', abCode !== null);
  check('判据前提：取到了 `applyBinding` 的实现（原文）', abRaw !== null);
  check('`applyBinding` 有 `log.debug` 轨迹', !!abCode && /log\.debug\(/.test(abCode));
  // ★ 关键：对"该装却装不上"必须 `log.error` —— 那才是"静默以错误身份运行"的探针
  check('`applyBinding` 对"有 token 却装不上 AUTH"报 `log.error`',
    !!abRaw && /AUTH/.test(abRaw) && /log\.error\(/.test(abRaw));
  check('`applyBinding` 对"COOKIE 规则未装上"报 `log.error`',
    !!abRaw && /COOKIE/.test(abRaw) && /log\.error\(/.test(abRaw));
  check('移除规则失败报 `log.error`（方向与安装失败相反）',
    !!abRaw && /移除/.test(abRaw) && /log\.error\(/.test(abRaw));
}

// ---------------------------------------------------------------- ⑪ 凭据不进日志调用
console.log('\n=== 11. 凭据**不进日志调用**（纵深防御）===');
{
  // ## 这一节防的是什么
  //
  // 前面十节验的都是"`log()` **运行时**会打码"。那是**一道**防线。
  // 这一节验的是**第二道**：**根本没有把凭据值交给 `log()`**。
  //
  // ## 为什么需要第二道
  //
  // 打码靠的是 `redact()` 里的 6 条正则。正则**会被绕过**：
  // 一个没见过的键名、一个被 Base64 过、一个被拼进 URL 的凭据 ——
  // 都可能漏过。而"从不把明文交出去"**不依赖任何正则**。
  //
  // ⇒ 两种形态必须分开：
  //   · 安全：`log.info('token=%s', token ? '有' : '无')`  ← 交出去的是**判断结果**
  //   · 危险：``log.info(`token=${token}`)``               ← 交出去的是**明文**
  //
  // ★ 判据（两条，都要）：
  //   ① 模板串**插值**里不得出现凭据标识符；
  //   ② 模板串**之外**的参数里出现凭据标识符时，必须同时出现"存在性判断"的痕迹
  //      （`有` / `无` / `缺` / `Boolean(` / `.length`）—— 否则视为把值传了出去。
  //
  // ★ 实现要点：参数区必须**配平括号**取出（不能用 `[\s\S]*?\)` ——
  //   那样会在第一个 `)` 就截断，而括号在日志里很常见）。
  const CRED = [
    'deviceCode', 'userCode', 'token', 'fernetKey', 'password', 'passwd', 'pwd',
    'secret', 'credential', 'credentials', 'authorization', 'cookieValue', 'cookie',
  ];
  const credRe = (s) => CRED.filter((c) => new RegExp(`(?<![\\w.])${c}(?![\\w])`).test(s));

  const walkAll = [];
  const walkDir2 = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkDir2(full); continue; }
      if (name.endsWith('.ts')) walkAll.push(full);
    }
  };
  walkDir2(SRC);

  const interpolationLeaks = [];
  const argLeaks = [];
  let callCount = 0;

  for (const f of walkAll) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    const src = readFileSync(f, 'utf8');
    const code = stripLiterals(src); // 剥掉注释：别被"解释为什么不用 X"的说明弄红（规则 23）
    for (const m of code.matchAll(/\blog\.(?:debug|info|warn|error)\(/g)) {
      callCount += 1;
      // 配平括号取参数区
      let d = 1;
      let j = m.index + m[0].length;
      const start = j;
      while (j < code.length && d > 0) {
        if (code[j] === '(') d += 1;
        else if (code[j] === ')') d -= 1;
        j += 1;
      }
      const args = code.slice(start, j - 1);
      const ln = code.slice(0, m.index).split('\n').length;
      // ① 模板串插值（剥过之后模板串内容为空，所以这里其实查不到 —— 见下面的说明）
      for (const tm of args.matchAll(/\$\{([^}]*)\}/g)) {
        const hit = credRe(tm[1]);
        if (hit.length) interpolationLeaks.push(`${rel}:${ln} \${…${hit[0]}…}`);
      }
      // ② 参数区（模板串之外）——有凭据标识符就必须有"存在性判断"痕迹
      //    ★ 剥过之后字符串内容变空，所以"有/无/缺"这些**痕迹也在字符串里**，
      //      会被剥掉 ⇒ 判据会**假红**。
      //      ⇒ 这里必须用**原文**的参数区（与规则 24 一致：读字面量内容用原文）。
    }
  }

  // ★★ 上面 ② 的说明暴露了一个实现选择：`stripLiterals` 会把 `'有'` 也剥掉，
  //   导致"有存在性判断"这个**证据**消失 ⇒ 那条断言会假红。
  //   ⇒ ② 改用**原文**重跑一遍（① 也一并重跑，因为模板串内容同样被剥掉了）。
  for (const f of walkAll) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    const raw = readFileSync(f, 'utf8');
    // 注释剥掉（但保留字符串）——手工做：只去块注释与行注释，**保留字符串**
    const noComment = raw
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
    for (const m of noComment.matchAll(/\blog\.(?:debug|info|warn|error)\(/g)) {
      let d = 1;
      let j = m.index + m[0].length;
      const start = j;
      while (j < noComment.length && d > 0) {
        if (noComment[j] === '(') d += 1;
        else if (noComment[j] === ')') d -= 1;
        j += 1;
      }
      const args = noComment.slice(start, j - 1);
      const ln = noComment.slice(0, m.index).split('\n').length;
      // ① 模板串插值
      for (const tm of args.matchAll(/\$\{([^}]*)\}/g)) {
        const hit = credRe(tm[1]);
        if (hit.length) interpolationLeaks.push(`${rel}:${ln} 插值含 ${hit[0]}`);
      }
      // ② 参数区（去掉第一个格式串之后的部分）
      const afterFmt = args.replace(/^\s*(`(?:\\[\s\S]|[^`\\])*`|'(?:\\[\s\S]|[^'\\\n])*')/, '');
      // ★★ 判定必须**逐个凭据标识符**看它**自己**处于什么形态，
      //   不能看"整段里有没有痕迹"。
      //
      //   实测（反证 ⑩）：我第一版写的是"整段含 `有|无|缺|Boolean(|.length` 就算 benign"，
      //   于是缺陷版
      //       log.info('...', token, fernetKey ? '有' : '无', ...)
      //   里那个**裸 `token`** 因为**旁边 `fernetKey` 的 `'有'`** 而被判为 benign
      //   ⇒ 反证报"缺陷版下仍然绿"⇒ **判据有洞**。
      //
      //   ⇒ 安全形态只有三种，且必须**紧贴该标识符**：
      //     · `cred ? … : …`（三元判断）        · `cred.length` / `cred?.length`
      //     · `Boolean(cred)`                    · `cred != null` / `cred !== null`
      //   其余一律视为"把值传了出去"。
      for (const c of credRe(afterFmt)) {
        const benign = new RegExp(
          `(?<![\\w.])${c}(?![\\w])\\s*(\\?|\\.length|\\?\\.length|\\.slice\\(|!==?\\s*null|===?\\s*null)`
          + `|Boolean\\(\\s*${c}\\s*\\)`
          + `|(?<![\\w.])${c}(?![\\w])[^,)]*\\?[^,)]*:`,
        ).test(afterFmt);
        if (!benign) argLeaks.push(`${rel}:${ln} 裸传 ${c}`);
      }
    }
  }

  // ★ 空集自证（规则 24）：callCount 为 0 时上面两条断言恒真
  check('判据前提：确实扫到了 `log.*` 调用', callCount > 0, `${callCount} 处`);
  check('没有任何 `log.*` 的模板串插值里出现凭据标识符',
    interpolationLeaks.length === 0, interpolationLeaks.join(' | '));
  check('凭据标识符只以"存在性判断/长度"形式出现在日志参数里',
    argLeaks.length === 0, argLeaks.join(' | '));
  console.log(`      （扫过 ${callCount} 处 \`log.*\` 调用；凭据清单 ${CRED.length} 个）`);
}

// ---------------------------------------------------------------- ⑫ DOM 一致性（双向）
console.log('\n=== 12. DOM 一致性：HTML ↔ TS 双向 ===');
{
  // ## 这一节补的是规则 20 的**另一半**
  //
  // 规则 20 现在只查一个方向：`getElementById('x')` 的 x 必须在 HTML 里有 `id="x"`
  // （缺了 ⇒ `null` 被 `as HTMLElement` 骗过 ⇒ 运行时崩）。
  //
  // ★ 而本轮发现的缺陷是**反方向**：**HTML 有 id、TS 零引用**。
  //   它不一定崩，但用户会看到：
  //     · 一个**不工作的控件**（`#source-switch` 是个空容器），或
  //     · 一段**讲废弃功能、与当前行为相反**的说明文字
  //       （`#source-help-pop` 在讲"本地 → 云端合并上传、本地数据不会被删除"，
  //        而本地数据源**已整体废除**）。
  //   —— 后者不是崩溃，是**对用户说谎**，而没有门禁会抓到它。
  //
  // ⇒ 白名单：**确实只作静态内容、不需要 TS 触碰**的 id 才允许"零引用"。
  //   加进这个列表时必须写清**为什么它可以不被引用** ——
  //   否则它就退化成"新增孤儿 id 的合法通道"。
  const STATIC_ONLY_IDS = {
    // 盒子弹窗的标题，当前只有"移入盒子"一种用法 ⇒ 静态写死即可。
    // 保留 id 是为了将来出现第二种用法时能改（渐进增强），而不是因为它现在被用着。
    'box-modal-title': '静态标题（当前只有一种用法）',
  };

  // ★ 剥 HTML 注释再找 id —— 这一条**本轮又踩了同一个坑**：
  //   我在清理时写了注释"原先有个 `<span id="auth-bar-text">`"，
  //   而裸正则 `\bid="([^"]+)"` **命中了注释里的那个字面量** ⇒ 探针误报"还有 2 个孤儿"。
  //   这是 PITFALLS #14 / #18 那条教训的**第三次**（规则 23 / 26）。
  const stripHtmlComments = (s) => s.replace(/<!--[\s\S]*?-->/g, ' ');

  const htmlFiles = [];
  const walkHtml = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkHtml(full); continue; }
      if (name.endsWith('.html')) htmlFiles.push(full);
    }
  };
  walkHtml(SRC);

  // TS 的全部文本（id 的引用面）。用它当"被引用"的判据足够：
  // 少引用的代价是"多报一个孤儿"（人工看一眼即可），而漏报的代价是缺陷溜过。
  const tsAll = [];
  const walkTs = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { walkTs(full); continue; }
      if (name.endsWith('.ts')) tsAll.push(readFileSync(full, 'utf8'));
    }
  };
  walkTs(SRC);
  const tsText = tsAll.join('\n');

  const orphans = [];
  let idTotal = 0;
  for (const f of htmlFiles) {
    const rel = f.replace(ROOT + '\\', '').replace(ROOT + '/', '');
    const ids = [...stripHtmlComments(readFileSync(f, 'utf8')).matchAll(/\bid="([^"]+)"/g)]
      .map((m) => m[1]);
    idTotal += ids.length;
    for (const id of ids) {
      if (!tsText.includes(id) && !(id in STATIC_ONLY_IDS)) {
        orphans.push(`${rel}: ${id}`);
      }
    }
  }

  // ★ 空集自证（规则 24）：一个 id 都没扫到时上面恒真
  check('判据前提：确实扫到了 HTML 里的 id', idTotal > 0, `${idTotal} 个`);
  check('没有"HTML 有 id、TS 零引用"的孤儿标记（白名单除外）',
    orphans.length === 0, orphans.join(' | '));
  console.log(`      （${htmlFiles.length} 个页面 / ${idTotal} 个 id；`
    + `白名单 ${Object.keys(STATIC_ONLY_IDS).length} 个）`);
}

// ---------------------------------------------------------------- 13. 静默失败
console.log('\n=== 13. 静默失败必须留痕（"失败与成功长得一样"的那几条）===');
{
  // ★★ 为什么单独一节、且**逐条白名单**，而不是"扫所有空 catch"：
  //
  //   本仓有 100+ 个 catch，其中**绝大多数是有意的静默** ——
  //   存储命名空间清扫、单键回滚、CacheStorage 封控、"读失败不阻断写入"…
  //   它们的共同点是"**一条失败不阻断其余**"，而且**跑在热路径上**
  //   （每个页面每次存储操作）。给它们加 `diag/error` 会挤爆 `ql:diag` 环形 60，
  //   把真正重要的记录挤掉（规则 22）。
  //
  //   ⇒ 所以"哪个 catch 必须留痕"**不能机械化**（这与规则 28 的教训同源：
  //     语义判断没有便宜的判据）。这里用**显式白名单**：每条写明
  //     "失败时用户看到什么"，只有答案是"和成功一样"的才进来。
  //
  //   ★ 关键实现细节：判据必须落在 **catch 块内部**。
  //     如果只查"函数体里有 log"，那么函数里**别处**的 log 会让它假绿 ——
  //     而那种假绿正是本条要防的形态。
  //
  //   ★★ 而这里承认**两种形态**（第一版只认第一种，于是对 `probeScheme` 假红）：
  //     · `kind: 'catch'`  —— 函数里有 catch，留痕必须在 **catch 块内**
  //     · `kind: 'fallback'` —— 函数里**根本没有 catch**，失败路径是一个
  //       兜底 `if` 链的末端（`probeScheme` 就是这种：异常在 `probeOnce` 里被
  //       吞成 `false`，`probeScheme` 只看到"都没探到"）。这时断言改为
  //       "**函数体内**有 ≥minLevel 的留痕"。
  //     ⇒ 把不适用的形态硬套一个判据，就会得到 `[].every()` 那种"恒真/恒假"
  //       （规则 24）。**先确认形态，再选判据。**
  const CASES = [
    {
      file: 'background/core/account-cache.ts',
      fn: 'loadSnapshot',
      kind: 'catch',
      minLevel: 'warn',
      why: '读缓存抛错 ⇒ 静默返回 null ⇒ 离线时列表是空的，'
        + '与"从未同步过"长得一样。用户归因到网络，真因是本机缓存读不出来',
    },
    {
      file: 'background/core/favorites.ts',
      fn: 'listFavorites',
      kind: 'catch',
      minLevel: 'warn',
      why: '读 storage 失败 ⇒ 回落内置默认 ⇒ **用户自建的收藏整份消失，'
        + '界面上显示的是默认书签**（对用户说谎）',
    },
    {
      file: 'background/core/site-auth.ts',
      fn: 'probeScheme',
      kind: 'fallback',
      minLevel: 'warn',
      why: '两个 scheme 探测都失败 ⇒ 静默按 https 兜底 ⇒ '
        + '用户只看到"页签打开后一片错误页"，没有别的信号',
    },
    /* ══════════ ★★ 2026-10-16 新增的 5 条：**审计时发现"该点名却没点名"的站点**
     *
     * 判据取法：拿**已在白名单里的那几条**当模板，去找"**逐字同形**却没进名单"的地方。
     * 下面每一条都能在名单里找到它的"同形兄弟"（写在 `why` 里）——
     * 这说明**白名单当时是按印象挑的，不是按形态扫的**。
     * ★ 现在补进来，判据从 5 条变 10 条；再加新站点时请**顺手说出它的同形兄弟是谁**。
     */
    {
      file: 'background/core/parallel-session.ts',
      fn: 'schemeOfAccount',
      kind: 'catch',
      minLevel: 'warn',
      why: '读账号失败 ⇒ 按 https 兜底，而**内网平台是纯 http**（10.100.0.105）'
        + '⇒ 页签按 https 打开 = 打不开。'
        + '★ 与 `site-auth.ts::probeScheme`（上面那条）**逐字同形**，当时却没被点名',
    },
    {
      file: 'background/core/parallel-session.ts',
      fn: 'terminateLoginState',
      kind: 'catch',
      minLevel: 'warn',
      why: '最后页签关闭时 jar 清扫失败 ⇒ **该账号的 Cookie 仍留在真实 jar 里**，'
        + '而"真实 jar 不驻留扩展账号的会话"是规则 4 / 隔离平面 4 的核心不变量。'
        + '★ 失败与成功在日志里完全一样（`diag` 只写在入口）',
    },
    {
      file: 'ui/translate/translate.ts',
      fn: 'init',
      kind: 'catch',
      minLevel: 'warn',
      why: '读翻译设置失败 ⇒ 回落硬编码默认 ⇒ 用户看到"**我的设置被重置了**"，'
        + '而不是"读失败了"。★ 与 `favorites.listFavorites`（上面那条）**逐字同形**',
    },
  ];

  /** 取出 `function <name>(...)` **或类方法** `<name>(...) {` 之后配对的花括号体。
   *
   *  ★★ 2026-10-16：第一版只认 `function name(`，于是我对**类方法**白名单时
   *    `前提：取到了 … 的 restore()` 直接红了 —— 而 `restore` 是
   *    `class TabRules { async restore(...) }`，源码里**没有** `function restore`。
   *    ★ 那一次红是**判据的提取器不够宽**，不是被测代码有问题。
   *    ⇒ 改成"两种形态都认"，并且**保留自证**（取不到就红）：
   *      取不到时红是对的，它逼着下一个人把提取器改宽，而不是悄悄跳过这条。
   */
  const fnBody = (src, name) => {
    const m = new RegExp(`(?:function\\s+|async\\s+|^\\s*)${name}\\s*\\(`, 'm').exec(src);
    if (!m) return null;
    const open = src.indexOf('{', m.index);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) return src.slice(open, i + 1);
      }
    }
    return null;
  };

  /** 取出**每一个** catch 子句的块体。 */
  const catchBodies = (src) => {
    const out = [];
    for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{/g)) {
      const open = src.indexOf('{', m.index + m[0].length - 1);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') {
          depth--;
          if (depth === 0) { out.push(src.slice(open, i + 1)); break; }
        }
      }
    }
    return out;
  };

  const LEVELS = ['debug', 'info', 'warn', 'error'];
  const hasLog = (text, minIdx) => {
    for (const m of text.matchAll(/\blog\.(debug|info|warn|error)\s*\(/g)) {
      if (LEVELS.indexOf(m[1]) >= minIdx) return true;
    }
    // 也接受 diag()/forensics()（它们是落盘通道）
    return /\b(diag|forensics)\s*\(/.test(text);
  };

  for (const c of CASES) {
    const src = readFileSync(join(SRC, c.file), 'utf8');
    const body = fnBody(src, c.fn);
    // ★ 自证前提（规则 23）：先确认真的取到了那段代码
    check(`前提：取到了 ${c.file} 的 ${c.fn}()`, body !== null);
    if (!body) continue;

    const minIdx = LEVELS.indexOf(c.minLevel);
    const short = c.why.slice(0, 34);

    if (c.kind === 'catch') {
      const catches = catchBodies(body);
      check(`前提：${c.fn}() 里有 catch`, catches.length > 0, `${catches.length} 个`);
      check(`${c.fn}() 的 catch 里有 ≥${c.minLevel} 级留痕 —— ${short}…`,
        catches.some((b) => hasLog(b, minIdx)));
    } else {
      // `fallback`：函数里**没有** catch，失败路径是兜底分支 ⇒ 断言整个函数体。
      check(`前提：${c.fn}() 是 fallback 形态（无 catch）`,
        catchBodies(body).length === 0);
      check(`${c.fn}() 内有 ≥${c.minLevel} 级留痕 —— ${short}…`, hasLog(body, minIdx));
    }
  }

  /* ══════════ ★★ 追加：**锚点 + 邻域**口径（2026-10-16）
   *
   * ## 为什么还要第二种口径（而不是把 `fnBody` 改到能认所有形态）
   *
   * `fnBody` 靠"从名字往后数配对花括号"，它对"这个函数到底从哪开始"很敏感 ——
   * 实测踩了两次：
   *   · 类方法 `class X { async restore() }` 里**没有** `function restore`（第一版红）；
   *   · 把匹配放宽成 `(?:function|async|^\s*)name\s*\(` 之后，
   *     它匹配到了**调用点**（体里没有 catch）⇒ 又红。
   * ⇒ "猜函数边界"这条路**每加一条白名单就要再猜一次**，而每次猜错都表现为
   *   "判据红了"，读起来像被测代码坏了。
   *
   * ## 换成"锚点 + 邻域"，它只依赖两件可核对的事实
   *
   * | 事实 | 怎么核 |
   * |---|---|
   * | 那段**失败处理**的代码在哪 | 一个**唯一**的锚点字符串（必须恰好命中 1 次） |
   * | 它有没有留痕 | 锚点往后 `WINDOW` 字符内出现 ≥`minLevel` 的 `log.*` |
   *
   * ★ 它比"取函数体"**更弱**（不做语法分析），但**更能红**：
   *   把留痕删掉就一定红，而"取不到函数体"不会再来干扰。
   * ★ 锚点要求**唯一**（命中次数 ≠ 1 就报前提失败）——
   *   否则"改错地方"会被当成"判据通过"（本仓 `poke()` 那条注释的同一条教训）。
   */
  /* ★ `WINDOW` 是**按最坏情况量的**，不是随手写的：
   *   `tab-rules.ts` 那条的留痕离锚点约 **700 字符** —— 中间隔着一段解释
   *   "为什么这条必须记、不记会怎样"的注释（本仓要求留痕处说明后果，规则 25）。
   *   ⇒ 取 **900** 留余量。
   * ★ 窗口越大判据越弱（可能"蹭"到别处的 log）⇒ 它**不替代** `CASES` 那套
   *   "catch 块内"的严格口径，只用于"函数边界取不到"的那几条。
   *   两条口径都在，各自写清了自己覆盖什么。 */
  const WINDOW = 900;
  const ANCHORED = [
    {
      file: 'background/core/parallel-session.ts',
      // ★ 锚点用**那个 catch 本身**（它在文件里唯一），留痕在它后面约 500 字符处。
      //   ★★ 我在这里连错两次，两次都表现为"反证下仍绿"，值得记下来：
      //      ① 先用 `const jarNow = …` 当锚点 —— 留痕在它后面 **957** 字符，
      //         超出 900 的窗口 ⇒ 窗口里**根本没有** log ⇒ 断言恒假；
      //      ② 改用 `delete snap.token;` —— 那个字符串在文件里**出现两次**
      //         （另一处在 `evictJarCookie`），我匹配到了**后面那个**（44279 vs 21587）
      //         ⇒ 又一次恒假。
      //   ⇒ 教训：**锚点必须唯一、且必须贴着被断言的东西**。
      //     ★ 最终用的是**反向窗口**（`before: true`）：锚点 = 留痕那行自己的**前缀**
      //       `log.warn('terminateLoginState(%s) jar` —— 它唯一、单行，
      //       而窗口取它**前面** 900 字符 ⇒ 正好覆盖整条留痕语句。
      //     ★ 为什么不用别处的代码行当锚点：实测这一段周围的行**大量重复**
      //       （`const attr = cookieAttribution.get(…)` 与 `accountId, e instanceof Error …`
      //       各出现 **2 次**），而换行锚点在 CRLF 上**匹配 0 次** ⇒
      //       唯一 + 单行这两条同时满足的只有"留痕自己的前缀"。
      //     ★ "窗口里本来就有留痕"那条自证会让任何一次挑错**当场暴露**。
      anchor: "log.warn('terminateLoginState(%s) jar",
      before: true,
      minLevel: 'warn',
      why: '最后页签关闭时 jar 清扫失败 ⇒ **该账号的 Cookie 仍留在真实 jar 里**，'
        + '而"真实 jar 不驻留扩展账号的会话"是规则 4 / 隔离平面 4 的核心不变量。'
        + '★ 失败与成功在日志里完全一样（`diag` 只写在入口）',
    },
    {
      file: 'background/core/tab-rules.ts',
      anchor: 'existing = await chrome.declarativeNetRequest.getSessionRules();',
      minLevel: 'error',
      why: '读 session 规则失败 ⇒ ① 孤儿 DNR 规则**永久留在浏览器里**；'
        + '② 规则 id 从 BASE 重新分配而旧规则还活着 ⇒ `updateSessionRules`（原子批量）'
        + '整批被拒 ⇒ **AUTH 与 COOKIE 两个平面一起失效**，而运维只看到下游那句"addRule 失败"',
    },
    {
      file: 'ui/wheel/wheel.ts',
      anchor: 'const failed = [a, b, c].filter((r) => r.status ===',
      minLevel: 'warn',
      why: '三处盒子配置读失败 ⇒ 轮盘按默认值渲染：盒子可能少、**已停用的盒子重新出现** ⇒ '
        + '用户看到"我停用的盒子又回来了"',
    },
  ];
  for (const c of ANCHORED) {
    const src = readFileSync(join(SRC, c.file), 'utf8');
    const hits = src.split(c.anchor).length - 1;
    check(`前提：锚点在 ${c.file} 里唯一（命中 ${hits} 次）`, hits === 1);
    if (hits !== 1) continue;
    const at = src.indexOf(c.anchor);
    /* ★★ 方向必须显式声明：`before: true` = 留痕在锚点**前面**。
     *
     * ## 为什么（一次真实的"空断言"，2026-10-16 实测）
     *
     * `terminateLoginState` 那条我一开始把锚点放在 `const jarNow = …` 上，
     * 而留痕在它**后面 957 字符**（中间的 `for` 循环把距离拉长了）
     * ⇒ 窗口 `[at, at+900)` **根本不含**任何 log
     * ⇒ **反证器注入"拆掉留痕"时判据仍然绿**，而报出来的话是
     *   "缺陷版下仍绿" —— 读起来像**判据**坏了，实际是**窗口取错了方向**。
     *
     * ★★ 而 `before` 的**末端必须含锚点自己**（`at + anchor.length`）：锚点是
     *    "留痕那行的前缀"，不含它的话窗口里连那条留痕都看不到 ——
     *    实测就是这么又红了一次（"窗口里本来就有留痕"那条自证第二次立功）。
     * ⇒ 现在：方向写在用例里，并且**多一条自证**（见下面 `前提：窗口里本来就有留痕`）——
     *   窗口如果一开始就不含留痕，那就成了一条**恒假**的断言，
     *   必须**当场报出来**，而不是等反证器去发现。
     */
    const window = c.before
      ? src.slice(Math.max(0, at - WINDOW), at + c.anchor.length)
      : src.slice(at, at + WINDOW);
    const minIdx = LEVELS.indexOf(c.minLevel);
    // ★ 自证：这条断言**有机会为真**吗？—— 先看窗口里有没有任何留痕调用。
    //   没有 ⇒ 它是一条恒假断言（不是"被测代码没留痕"，而是"窗口取错了"）。
    check(`前提：${c.file} 的窗口里本来就有留痕调用（否则断言恒假）`,
      /\blog\.(debug|info|warn|error)\s*\(/.test(window) || /\b(diag|forensics)\s*\(/.test(window));
    check(`${c.file} 的失败处理处有 ≥${c.minLevel} 级留痕 —— ${c.why.slice(0, 30)}…`,
      hasLog(window, minIdx));
  }
}

// ---------------------------------------------------------------- 14. 落盘通道
console.log('\n=== 14. 日志落盘通道必须接线（接口摆着 ≠ 接上了）===');
{
  // ★★ 为什么单独一节：
  //
  //   `log.ts` 早就提供了 `setSink()` 这个**可选落盘注入点**，而它
  //   **全仓零调用** —— 一个摆在那里、从没接线的接口。
  //   后果：环形缓冲只在 **service worker 的内存里**，而 **MV3 空闲会回收 SW**
  //   ⇒ 用户**事后**去导出诊断包时，环往往已经空了。
  //   **最需要日志的时刻，日志已经没了。**
  //
  // ★ 与 v3.19 修掉的 `.side-collapsed` 同型（接口/样式齐备，没人接线），
  //   也是规则 21 的镜像：那条说"安全靠约定时要问『违反了谁会知道』"，
  //   这里是"**机制摆在那里时要问『它真的被接上了吗』**"。
  //
  // ★ 为什么之前的判据发现不了：判据一直是"`drain()` 有没有调用点"。
  //   修好那个之后它**有**调用点了 ⇒ 那条判据**变绿**，
  //   而"**读得到吗**"这个问题从来没被问到。
  const SW = join(SRC, 'background', 'service-worker.ts');
  const LOG = join(SRC, 'shared', 'log.ts');
  const swRaw = readFileSync(SW, 'utf8');
  const logSrc = readFileSync(LOG, 'utf8');
  // ★★ 必须**剥注释**再断言调用点。
  //   实测踩过：第一版写 `/setSink\s*\(/`，而 SW 里我自己那句注释
  //   "★ `setSink()` 收到的是**同步**回调…" 里就有 `` `setSink()` `` ⇒
  //   **拆掉真实调用后判据仍然绿**，反证器直接报
  //   `FAIL 缺陷版下仍然绿 ⇒ 这条验收是空断言！`
  //   ⇒ 这是 PITFALLS #19 那条（"解释为什么用 X"的文本必然包含 X）的**又一次**，
  //     也是规则 23（零命中类判据先剥注释）在"正向断言"上的同型形态。
  const sw = swRaw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  // ① log.ts 必须**导出** setSink（它是公开面）
  check('log.ts 导出了 setSink', /export function setSink\(/.test(logSrc));
  check('log.ts 导出了 restoreToRing（读回来的那一半）',
    /export function restoreToRing\(/.test(logSrc));

  // ② ★★ SW 必须**在模块级调用安装函数**（这一条是本节的要害）
  //
  //   ★★★ 判据设计踩过一次，值得写下来：
  //     第一版写的是"文件里有没有 `setSink(` 调用"，并通过了。
  //     而**把 `installLogPersist();` 那行注释掉之后判据仍然全绿** ——
  //     因为 `setSink((r) => {…})` 就在 `installLogPersist` 的**函数体内部**，
  //     "文件里出现 `setSink(`"在**函数定义**处就已满足，与"有没有调用它"无关。
  //     ⇒ 反证器报 `FAIL 缺陷版下仍然绿 ⇒ 这条验收是空断言！`
  //
  //   ⇒ 判据必须盯**模块级的那个调用**，而不是"某处出现过某个 token"。
  //     用 `/^installLogPersist\(\);$/m`（行首行尾）：它只匹配**模块级裸调用**，
  //     不匹配函数声明 `function installLogPersist(): void {`。
  check('service-worker.ts **模块级调用**了 installLogPersist（落盘那半接线）',
    /^installLogPersist\(\);$/m.test(sw));

  // ③ 读回来的那一半也要接（否则日志落盘了却进不了诊断包）
  check('service-worker.ts **模块级调用**了 replayLogPersist（回灌那半接线）',
    /^void replayLogPersist\(\);$/m.test(sw));

  // ③b `setSink` 确实被用于装配（装配点在安装函数里）
  check('installLogPersist 里调了 setSink（装配点存在）',
    /function installLogPersist\(\)[\s\S]*?\bsetSink\s*\(/.test(sw));

  // ④ 两个健壮性约束（写错会变成 worker 崩溃或无限递归）
  //    · sink 里**不能调 log()** —— 会 log → sink → log 无限递归
  const sinkFn = /function installLogPersist\(\)[\s\S]*?\n\}/.exec(sw);
  check('前提：取到了 installLogPersist 的函数体', sinkFn !== null);
  if (sinkFn) {
    const body = sinkFn[0];
    // sink 回调体内不许出现 log.* 调用
    const callbacks = [...body.matchAll(/setSink\(\([^)]*\)\s*=>\s*\{[\s\S]*?\n\s*\}\)/g)];
    check('前提：setSink 的回调被取到', callbacks.length > 0);
    for (const cb of callbacks) {
      check('sink 回调里没有 log() 调用（否则无限递归 → SW 终止）',
        !/\blog\s*\.\s*(debug|info|warn|error)\s*\(/.test(cb[0]));
    }
  }
  //    · 异步写必须自己 catch（`log()` 的 try 只拦同步抛）
  check('落盘写有 .catch（log() 的 try 拦不住 Promise 拒绝）',
    /flushLogPersist\(\)\.catch\(/.test(sw));

  // ⑤ 键在 LOCAL_KEYS 里集中声明（规则：不要裸键名字符串）
  const consts = readFileSync(join(SRC, 'shared', 'constants.ts'), 'utf8');
  check('落盘键在 LOCAL_KEYS 里声明', /logPersist:\s*'[^']+'/.test(consts));
  check('SW 用的是 LOCAL_KEYS.logPersist 而不是裸字符串',
    /LOCAL_KEYS\.logPersist/.test(sw));

  // ⑥ ★ `restoreToRing` **不得**把记录再喂给 sink
  //   ⇒ 否则每启动一次就把落盘内容重写一遍，且队列自己喂自己（越滚越大）。
  //   ★ 判据落在**函数体内部**：只查"整个文件里没调 sink"会被别处的调用放过。
  const restoreFn = /export function restoreToRing\([\s\S]*?\n\}/.exec(logSrc);
  check('前提：取到了 restoreToRing 的函数体', restoreFn !== null);
  if (restoreFn) {
    check('restoreToRing **不调 sink**（否则回灌会自己喂自己）',
      !/\bsink\s*\(/.test(restoreFn[0]));
    check('restoreToRing **不调 log()**（回灌不是新事件）',
      !/\blog\s*\(/.test(restoreFn[0]));
  }
}

// ---------------------------------------------------------------- 15. 跨环境转发
console.log('\n=== 15. 前端日志必须能到落盘通道（跨环境转发）===');
{
  // ★★ 为什么单独一节：
  //
  //   `log()` 的环形缓冲与 `setSink()` 的落盘都在 **service worker 里**。
  //   而 content script 与扩展页面**各有自己的 JS 环境** ⇒
  //   它们在**本环境**记的日志永远进不了诊断包。
  //   实测（v3.19）：`ui/` 下 **9 个文件全部零日志**、`content/` 下 6/7 零日志。
  //   ★ 不是"忘了加"，是**加了也看不到** ⇒ 于是没人加。
  //     与 `PITFALLS #22`（`setSink()` 从没被调用）是**同一形态的第二处**。
  //
  //   与第 14 节的分工：14 节管"SW 自己的日志有没有落盘"，
  //   本节管"**别的环境的**日志有没有到 SW"。
  const LOG = join(SRC, 'shared', 'log.ts');
  const MSGS = join(SRC, 'shared', 'messages.ts');
  const SW = join(SRC, 'background', 'service-worker.ts');
  const PANEL = join(SRC, 'ui', 'parallel', 'parallel.ts');

  const logSrc = readFileSync(LOG, 'utf8');
  const msgSrc = readFileSync(MSGS, 'utf8');
  const swRaw = readFileSync(SW, 'utf8');
  const panelRaw = readFileSync(PANEL, 'utf8');
  // 剥注释（否则"解释为什么加转发"的注释会命中 —— PITFALLS #19 那条）
  const sw = swRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  const panel = panelRaw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

  // ① 契约里有这个 kind（两侧都要）
  check('RuntimeRequest 契约里有 ql.log',
    /\{\s*kind:\s*'ql\.log';\s*records:/.test(msgSrc));
  check('RuntimeResponse 契约里有 ql.log',
    /\{\s*kind:\s*'ql\.log';\s*result:/.test(msgSrc));

  // ② log.ts 提供转发器与"会转发的 logger"（两者缺一不可）
  check('log.ts 导出 setForwarder', /export function setForwarder\(/.test(logSrc));
  check('log.ts 导出 getForwardingLogger',
    /export function getForwardingLogger\(/.test(logSrc));
  // ★ 转发的 msg 必须**再打一次码** —— 进通道的文本必须已打码是硬约定
  check('getForwardingLogger 转发前调用 redact()',
    /forwarder\(\{[^}]*msg:\s*redact\(/.test(logSrc));

  // ③ SW 有 handler，且**喂给 restoreToRing**（不是另起一个环）
  check('SW 的 dispatch 里有 ql.log 分支', /case\s*'ql\.log':/.test(sw));
  check('ql.log 用 restoreToRing 入环（与诊断包同一个环）',
    /case\s*'ql\.log':[\s\S]{0,400}?restoreToRing\(/.test(sw));

  // ④ 前端**真的装了**转发器（模块级调用，不是只定义）
  //   ★ 与第 14 节同一个教训：判据要盯**调用**，不是"文件里出现过某个 token"。
  check('parallel.ts 模块级调了 setForwarder',
    /^setForwarder\(/m.test(panel));
  check('parallel.ts 用的是 getForwardingLogger（不是 getLogger）',
    /getForwardingLogger\(/.test(panel) && !/\bgetLogger\(/.test(panel));

  // ⑤ 三条真实静默失败必须留痕（与第 13 节同一套白名单思路）
  const CASES = [
    { fn: 'sendSafe', minLevel: 'debug',
      why: '所有后台通信的收口 —— 静默 null 时设备流轮询会无声停住' },
    { fn: 'loadBrowserAccounts', minLevel: 'warn',
      why: 'par.offline 取不到 ⇒ 不显示"只读副本"提示 ⇒ 界面说谎' },
  ];
  for (const c of CASES) {
    // 取函数体（配对花括号）
    const m = new RegExp(`(?:async\\s+)?function\\s+${c.fn}\\s*\\(`).exec(panel);
    check(`前提：取到了 parallel.ts 的 ${c.fn}()`, m !== null);
    if (!m) continue;
    const open = panel.indexOf('{', m.index);
    let depth = 0; let body = null;
    for (let i = open; i < panel.length; i++) {
      if (panel[i] === '{') depth++;
      else if (panel[i] === '}') { depth--; if (!depth) { body = panel.slice(open, i + 1); break; } }
    }
    check(`前提：取到了 ${c.fn}() 的函数体`, body !== null);
    if (!body) continue;
    const levels = ['debug', 'info', 'warn', 'error'];
    const minIdx = levels.indexOf(c.minLevel);
    let hit = false;
    for (const mm of body.matchAll(/\blog\.(debug|info|warn|error)\s*\(/g)) {
      if (levels.indexOf(mm[1]) >= minIdx) hit = true;
    }
    check(`${c.fn}() 内有 ≥${c.minLevel} 级留痕 —— ${c.why.slice(0, 30)}…`, hit);
  }
}

// ---------------------------------------------------------------- 16. 级别开关
console.log('\n=== 16. 级别开关必须在**产物**里活着（摇树删掉 = 排障入口不存在）===');
{
  /* ★★ 为什么这一节必须查 `dist/` 而不是 `src/`（PITFALLS #46）
   *
   * `setLogLevel()` 是 `export function`，而 `src/` 里**一个调用点都没有** ——
   * 唯一的使用者是**排障时人在控制台手敲**。esbuild 看到"导出了但没人 import"
   * 就把它整段删掉 ⇒ 实测 `dist/background.js` 里 `setLogLevel` 出现 **0 次**。
   *
   * 三种伪装因此同时成立：
   *   · 排障的人敲 `Site.setLogLevel('debug')` ⇒ 那个属性不存在；
   *   · 读代码的人以为所有 `log.debug` 是"可开启的轨迹" ⇒ 其实**永远不输出**；
   *   · 读文档的人看到"没人开过 debug" ⇒ 读成"不需要"，实际是"打不开"。
   *
   * ★ 而 `typecheck` / `build` / **在源码里 grep 到它** 三样都是绿的 ——
   *   摇树发生在打包那一层。⇒ 判据**必须落到 `dist/`**。
   *
   * ★ 修法是让级别的存储变成"有副作用的形式"（`globalThis.__qlLogLevel`），
   *   它摇不掉；而控制台里直接写它也**立刻生效**（`log()` 每次现读）。
   */
  const DIST_BG = join(ROOT, 'dist', 'background.js');
  const logSrc = readFileSync(LOG_TS, 'utf8');
  const distSrc = existsSync(DIST_BG) ? readFileSync(DIST_BG, 'utf8') : '';

  check('前提：dist/background.js 存在（先跑 `npm run build`）', existsSync(DIST_BG));
  if (existsSync(DIST_BG)) {
    // ① 源码：级别必须存在 `globalThis` 上（不能是模块局部变量 —— 那才会被摇掉）
    check('源码把级别存在 `globalThis.__qlLogLevel` 上（摇树删不掉的形式）',
      /globalThis\.__qlLogLevel/.test(logSrc));
    // ② 产物：那个属性真的还在
    const n = (distSrc.match(/__qlLogLevel/g) || []).length;
    check('★★ 产物 `dist/background.js` 里 `__qlLogLevel` 仍在（≥1 次）', n >= 1, `${n} 次`);
    // ③ 反方向：级别**不许**再退回模块局部变量
    //    ★ 退回的形态是 `let currentLevel: LogLevel = …` —— 它一旦没人 import 就会被删，
    //      而"删掉"在源码里看不出来（源码里它是合法的 TS）。
    check('源码里没有退回模块局部的 `let currentLevel`',
      !/^\s*let\s+currentLevel\b/m.test(logSrc));
    // ④ 过滤必须走"现读"的入口（否则控制台改级别要重载扩展才生效）
    check('`log()` 经 `shouldLog()` 现读级别（改完立刻生效）',
      /if\s*\(!shouldLog\(level\)\)/.test(logSrc));
  }
}

// ---------------------------------------------------------------- 汇总
const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
