/**
 * 反证：证明 `verify-log-redaction.mjs` 真的会红。
 *
 * 依据 akso-pass AGENTS.md 规则 17：**写完判据先问"拆掉什么它才会红？"**
 * 答不上来说明它没在验任何东西。
 *
 * 做法：临时制造缺陷版，跑验收并断言**必须失败**，
 *       最后无论成败都把文件逐字节还原（放 `finally`）。
 *
 * ★ 2026-10-09 泛化：原先只支持改 `log.ts` 一个文件，而验收脚本后来长出了
 *   **闭环**那一节（第 6 节：日志必须有消费者）—— 那节改的是
 *   `service-worker.ts` 与 `parallel.ts`。单文件版**没法反证它**
 *   ⇒ 一条没人反证过的判据，正是"永远绿"的候选。
 *   现在每个用例自带 `file` 字段。
 *
 * 跑法：node tools/verify/verify-falsify-logredaction.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // tools/verify/ → 仓库根（两层）
const CHECK = join(HERE, 'verify-log-redaction.mjs');

const SRC = join(ROOT, 'packages', 'extension', 'src');
const LOG_TS = join(SRC, 'shared', 'log.ts');
const SW_TS = join(SRC, 'background', 'service-worker.ts');
const PANEL_TS = join(SRC, 'ui', 'parallel', 'parallel.ts');
const PS_TS = join(SRC, 'background', 'core', 'parallel-session.ts');
// ★ 名字相近、容易拿错的两个文件：`parallel-session`（运行时编排）
//   与 `parallel-store`（数据层门面）。第 ⑥ 条要改的是**后者**。
const PSTORE_TS = join(SRC, 'background', 'core', 'parallel-store.ts');
const MSGS_TS = join(SRC, 'shared', 'messages.ts');
const TABRULES_TS = join(SRC, 'background', 'core', 'tab-rules.ts');
const CDEV_TS = join(SRC, 'background', 'core', 'cloud-device.ts');
const PH_TS = join(SRC, 'ui', 'parallel', 'parallel.html');
// ★ 第 13 节（静默失败必须留痕）的三个目标
const ACACHE_TS = join(SRC, 'background', 'core', 'account-cache.ts');
const FAV_TS = join(SRC, 'background', 'core', 'favorites.ts');
const SAUTH_TS = join(SRC, 'background', 'core', 'site-auth.ts');

const CASES = [
  {
    label: '① 打码被绕过（formatArgs 直接返回原文）⇒ 凭据原样输出',
    file: LOG_TS,
    anchor: '  return redact(text);',
    broken: '  return text;  // 缺陷版：不调用 redact',
  },
  {
    label: '② 只打码第一个参数（漏掉分隔参数）⇒ password=%s 形态失效',
    file: LOG_TS,
    anchor: "  const text = typeof first === 'string' ? interpolate(first, rest) : args.map(stringify).join(' ');",
    broken: "  const text = typeof first === 'string' ? first : args.map(stringify).join(' ');",
  },
  {
    // ★ 本节判据（闭环）的反证 —— 原先没有
    //   ★★ 锚点**不带 `\n`**：实测带行尾的锚点在这里匹配不上（文件行尾会变），
    //     于是文件没被改、判据当然绿 ⇒ 反证器报 `空断言`。
    //     （规则 25 记过"锚点不要带 \n"；本轮它又咬了两次。）
    label: '③ 拆掉 `ql.diag` 里的 drain() ⇒ 日志又没人读了',
    file: SW_TS,
    anchor: 'out.logs = drain();',
    broken: '',
  },
  {
    label: '④ 拆掉诊断包的 `appLogs` ⇒ handler 带了前端也不收',
    file: PANEL_TS,
    anchor: '      appLogs: (diagRes as { result?: { data?: { logs?: unknown[]; logLevel?: string } } } | null)\n'
          + '        ?.result?.data?.logs ?? [],\n',
    broken: '',
  },
  {
    // ★ 第 7 节（三通道分工）的反证 —— 把**热路径**改回写 storage 缓冲
    label: '⑤ 热路径改回 `diag()` ⇒ 环形 60 又被刷满、真实失败被挤掉',
    file: PS_TS,
    anchor: "    log.debug('isEnforceable(%s) → 缓存 %s', host, cached);\n",
    broken: '    void diag(`isEnforceable(${host}) → 缓存 ${cached}`);\n',
  },
  {
    // ★ 第 8 节（离线判定只有一处）的反证 —— 重新引入重复的类定义。
    //   这一条尤其值得反证：重复定义**当时不会出问题**（判定用标记字段），
    //   所以"没有报错"完全不能说明判据在验东西。
    label: '⑥ `parallel-store` 又自定义一份 `OfflineError` ⇒ 判定改 `instanceof` 就会静默失效',
    file: PSTORE_TS,
    anchor: "export { OfflineError, isOfflineError } from './offline';\n",
    broken: "export { OfflineError, isOfflineError } from './offline';\n"
          + 'export class OfflineError extends Error { readonly isOfflineError = true; }\n',
  },
  {
    // ★ 第 9 节（SW 入口不静默落空）的反证 ①：拆掉 `default`
    //   ★★ 锚点同样去掉了行尾 `\n`（见 ③ 的说明）。
    label: '⑦ 拆掉 `dispatch` 的 `default` ⇒ 未知 kind 又静默落空',
    file: SW_TS,
    anchor: '    default: {',
    broken: '    // 缺陷版：把 default 注释掉',
  },
  {
    // ★ 反证 ②：契约里加一个 kind 而 dispatch 不实现。
    //   ★★ 这一条**必须**有：第 9 节的"契约同步"判据曾经**退化成永远绿** ——
    //     因为 `stripLiterals` 把 `kind: 'x'` 里的字符串剥成了 `''`，
    //     于是契约 kind 集合为空，而 `[].every()` **恒返回 true**。
    //     ⇒ 只有真的加一个 kind 才能证明它现在会红。
    label: '⑧ 契约加一个 kind 而 dispatch 不实现 ⇒ 契约同步判据必须红',
    file: MSGS_TS,
    anchor: "  | { kind: 'par.list' }\n",
    broken: "  | { kind: 'par.list' }\n  | { kind: 'definitely.not.implemented' }\n",
  },
  {
    // ★ 第 10 节（网络平面失败可见）的反证 —— 把"规则装不上"的 `log.error`
    //   **降级为 `log.debug`**（这正是本轮要修的那个缺陷形态）。
    //
    //   ★ 这一条尤其值得反证：DNR 装不上时页签会**以错误身份继续跑**，
    //     而它与"装好了"在界面上长得一样 ⇒ 少了这条 `error` 就再也查不出来
    //     （`debug` 默认不输出，等于没有）。
    //
    //   ★ 缺陷版必须让 `log.error(` **真的消失**（本反证器是字符串替换，
    //     若只把调用拆成两半，marker 仍在源码里 ⇒ 反证**永远不会红**）。
    //
    //   ★ 锚点**不带换行**：带 `\n` 时匹配不上（实测 SKIP，行尾是 CRLF）。
    //     用"整行内容"作为锚点即可，替换后那两行参数仍然接得上。
    label: '⑨ 把 `addOne` 失败的 `log.error` 降级为 `log.debug` ⇒ 装不上又变静默',
    file: TABRULES_TS,
    anchor: "    log.error('addRule #%d **失败**：%s',",
    broken: "    log.debug('addRule #%d **失败**：%s',",
  },
  {
    // ★ 第 11 节（凭据不进日志调用）的反证 —— **静态判据**验的是"根本没把凭据交给 log()"。
    //
    //   ★★ 值得反证的理由：`log()` **运行时确实会打码**，
    //   所以这一类缺陷在功能上**看不出任何异常**（DevTools 里显示的是打码后的值），
    //   只有静态判据能发现它。⇒ 必须证明这条静态判据真的会红。
    //
    //   缺陷版：把"判断有没有令牌"改成"把令牌带上"（无存在性判断痕迹 ⇒ 必红）。
    //   锚点用 `cloud-device.ts` 里那行 `log.info` 的**参数行**（实测原文）。
    label: '⑩ 日志参数直接带 `token` 值（无存在性判断）⇒ 静态判据必须红',
    file: CDEV_TS,
    anchor: "      token ? '有' : '无', fernetKey ? '有' : '无', email ? '有' : '无');",
    broken: '      token, fernetKey ? \'有\' : \'无\', email ? \'有\' : \'无\');',
  },
  {
    // ★ 反证 ② —— **模板串插值**里出现凭据标识符。
    //   这一条验的是 ① 那条断言（"插值里不得出现凭据标识符"）。
    label: '⑪ 模板串插值含 `${deviceCode}` ⇒ 明文交给 log()',
    file: CDEV_TS,
    anchor: "  log.debug('device-start 发起（clientName=%s，丢弃上一个会话=%s）', clientName, replaced);",
    broken: '  log.debug(`device-start 发起（clientName=${clientName}，deviceCode=${deviceCode}）`);',
  },
  {
    // ★ 第 12 节（DOM 双向一致性）的反证 —— **反方向**：重新放一个孤儿 id。
    //   ★ 这一条验的是规则 20 的**另一半**（HTML 有、TS 零引用）。
    //     它不会崩，所以没有任何运行期信号 —— 只有静态判据能发现它。
    //   ★ 锚点用**实测原文**（猜标签名会 SKIP）。
    //   ★★ v4.2.1：这块从 `<span>` 改成了 `<button>`（它现在是可点开身份菜单的身份入口）。
    //     改标记会让这条反证的锚点**静默失配**，报"锚点没找到" —— 那是判据**如实报错**，
    //     不是源码坏了。⇒ 改 `parallel.html` 里这一行时必须同步改这里
    //     （同 AGENTS 规则 39：同一事实的声明会跨文件；这里是"跨判据"）。
    label: '⑫ 重新放一个孤儿 id（HTML 有、TS 零引用）⇒ 双向判据必须红',
    file: PH_TS,
    anchor: '            <button id="cloud-account" class="cloud-account hidden" type="button"',
    broken: '            <button id="cloud-account" class="cloud-account hidden" type="button"\n'
          + '              aria-haspopup="menu" aria-expanded="false"></button>\n'
          + '            <div id="definitely-orphan-id"></div>',
  },
  {
    // ★ 第 13 节（静默失败必须留痕）的反证 —— 形态 A：`catch` 里的留痕被拆掉。
    //   ★★ 关键：把 `log.warn(` 拆成两半会让 marker **仍然留在源码里** ⇒ 判据不红
    //      ⇒ 反证 SKIP（"验的是空气"）。规则 25 已经踩过这个坑。
    //      所以这里改成**整个调用换成一句注释**，让被断言的字符串真的消失。
    //   ★ 锚点用**实测原文**（不带 `\n` —— 行尾可能是 CRLF）。
    label: '⑬ 拆掉 loadSnapshot 的 catch 留痕 ⇒ 离线读缓存失败又变静默',
    file: ACACHE_TS,
    anchor: "    log.warn('loadSnapshot 读缓存失败 ⇒ 离线时没有可回落的数据：%s', (e as Error)?.message ?? e);",
    broken: '    // 缺陷版：留痕被拆掉，失败与"从未同步过"又长得一样',
  },
  {
    // ★ 形态 B：`fallback` 形态（函数里没有 catch）的留痕被拆掉。
    //   ⇒ 这一条验的是第 13 节认的**第二种形态** —— 如果判据只写"catch 里有 log"，
    //     那么这条反证不会红（因为 probeScheme 里根本没有 catch 可查）。
    label: '⑭ 拆掉 probeScheme 的失败留痕 ⇒ 两个探测都失败又变静默',
    file: SAUTH_TS,
    anchor: "  log.warn('probeScheme(%s) 两个探测都失败（https 与 http 的 favicon 都不通）⇒ '",
    broken: "  void 0; // 缺陷版：失败留痕被拆掉",
  },
  {
    // ★ 形态 A 的第二个目标 —— 验"逐条白名单"不是只保住了第一个。
    //   ★ 它防的形态很具体：**用户自建的收藏整份消失，界面显示默认书签**。
    label: '⑮ 拆掉 listFavorites 的 catch 留痕 ⇒ 收藏静默变成默认书签',
    file: FAV_TS,
    anchor: "    log.warn('listFavorites 读 storage.local 失败 ⇒ 回落到内置默认书签（用户的收藏这次看不到）：%s',",
    broken: '    // 缺陷版：留痕被拆掉',
  },
  {
    // ★ 第 14 节（落盘通道必须接线）的反证 —— 把**模块级的安装调用**注释掉，
    //   回到"接口摆在那里从没接线"的状态。
    //   ★ 这一条防的具体后果：日志只活在 SW 内存里，而 MV3 空闲会回收 SW
    //     ⇒ 用户**事后**导出诊断包时环已经空了 —— **最需要日志时日志已经没了**。
    //   ★★★ 用**单行锚点**：实测带 `\n` 的多行锚点在这里没匹配上，
    //     于是文件没被改、判据当然绿 ⇒ 反证器报 `空断言`。
    //     （规则 25 记过"锚点不要带 \n"；这次是它第二次咬人。）
    label: '⑯ 注释掉 installLogPersist() 的模块级调用 ⇒ 落盘通道又断线',
    file: SW_TS,
    anchor: 'installLogPersist();',
    broken: '// 缺陷版：不装 sink（日志只活在内存里，SW 一回收就没了）',
  },
  {
    // ★ 第 14 节的第二半：读回来的那一半断掉。
    //   ⇒ 日志**写了盘却没进诊断包**（`drain()` 读的是内存环）。
    //   ★ 与 ⑯ 是两个独立的反向 —— 只拆一个都还能"看起来在工作"。
    label: '⑰ 拆掉 replayLogPersist 的模块级调用 ⇒ 历史日志进不了诊断包',
    file: SW_TS,
    anchor: 'void replayLogPersist();',
    broken: '// 缺陷版：不回灌历史日志',
  },
  {
    // ★ 第 14 节 ⑥ 的反证：让 `restoreToRing` 把记录**再喂回 sink**。
    //   ⇒ 每启动一次就把落盘内容重写一遍，而队列自己喂自己（越滚越大）。
    //   ★ 这一条防的是"回灌那条路把落盘通道变成反馈回路"。
    label: '⑱ restoreToRing 里调 sink ⇒ 回灌变成自我重写的回路',
    file: LOG_TS,
    anchor: '  const keep = usable.slice(-RING_SIZE);',
    broken: '  const keep = usable.slice(-RING_SIZE);\n'
          + '  // 缺陷版：把记录喂回 sink（回路）\n'
          + '  if (sink) for (const r of keep) sink(r);',
  },
  {
    // ★ 第 15 节（跨环境转发）的反证 —— 拆掉**模块级**的 setForwarder 调用。
    //   ⇒ 前端日志又只留在自己的环境里，永远进不了诊断包。
    //   ★ 锚点不带 `\n`（规则 25 的教训）。
    label: '⑲ 拆掉 parallel.ts 的 setForwarder() 调用 ⇒ 前端日志又出不去',
    file: PANEL_TS,
    anchor: 'setForwarder((rec) => {',
    broken: 'const _unusedForwarder = ((rec) => {',
  },
  {
    // ★ 第 15 节的第二半：SW 收到 ql.log 后**不入环** ⇒ 转发白做。
    label: '⑳ ql.log 不再 restoreToRing（转发白做）',
    file: SW_TS,
    anchor: 'const accepted = restoreToRing(records);',
    broken: 'const accepted = records.length; // 缺陷版：不入环',
  },
  {
    // ★ 第 15 节：转发前不再打码 ⇒ 若前端把凭据拼进消息，跨环境会泄露。
    label: '㉑ getForwardingLogger 转发前不打码',
    file: LOG_TS,
    anchor: '        forwarder({ t: Date.now(), level, ns, msg: redact(formatArgs(a)) });',
    broken: '        forwarder({ t: Date.now(), level, ns, msg: formatArgs(a) });',
  },
  {
    // ★ 第 15 节的第三条：`sendSafe` 又变回静默（用户看不到"设备流停住了"）。
    label: '㉒ sendSafe 的 catch 又变静默 ⇒ 后台不通时界面一切照旧',
    file: PANEL_TS,
    anchor: "    log.debug('sendSafe(%s) 失败 ⇒ 折成 null（后台重启/无接收端？）：%s',",
    broken: '    // 缺陷版：静默',
  },
];

function runCheck() {
  try {
    execFileSync(process.execPath, [CHECK], { stdio: 'pipe', encoding: 'utf8' });
    return false; // 退出码 0 = 没红
  } catch {
    return true; // 非 0 = 红了
  }
}

const failures = [];

// 基线：未改动时必须通过
console.log('=== 基线（未改动）：验收必须通过 ===');
const baselineGreen = !runCheck();
console.log(`  ${baselineGreen ? 'OK  ' : 'FAIL'} 基线${baselineGreen ? '通过' : '不通过 —— 先修验收本身'}`);
if (!baselineGreen) failures.push('基线就不通过');

for (const c of CASES) {
  const original = readFileSync(c.file, 'utf8');
  const short = c.file.slice(ROOT.length + 1);
  if (!original.includes(c.anchor)) {
    console.log(`\n=== ${c.label} ===\n  SKIP 锚点没找到（源码变了？）${short}`);
    failures.push(`${c.label}：锚点没找到`);
    continue;
  }
  try {
    writeFileSync(c.file, original.replace(c.anchor, c.broken), 'utf8');
    console.log(`\n=== ${c.label} ===`);
    const red = runCheck();
    if (red) {
      console.log('  OK   如期变红 —— 反证有效');
    } else {
      console.log('  FAIL 缺陷版下仍然绿 ⇒ 这条验收是空断言！');
      failures.push(`${c.label}：缺陷版下仍绿`);
    }
  } finally {
    // ★ 写回时用 utf8 且内容与原文完全一致 —— 逐字节还原
    writeFileSync(c.file, original, 'utf8');
    if (readFileSync(c.file, 'utf8') !== original) failures.push(`${c.label}：还原失败`);
  }
}

console.log('\n=== 还原核对 ===');
// ★ 每个"被用例改过的文件"都必须出现在这里。
//   漏一个的后果：那个文件的还原失败不会被发现，而工作区会留下一个**缺陷版**
//   —— 下一轮的全量验收会红，但原因指向别处。
//   判据（自证）：本列表与 CASES 里出现的 `file` **集合相等**。
const touched = [...new Set(CASES.map((c) => c.file))];
const COVERED = [LOG_TS, SW_TS, PANEL_TS, PS_TS, PSTORE_TS, MSGS_TS, TABRULES_TS, CDEV_TS, PH_TS,
  ACACHE_TS, SAUTH_TS, FAV_TS];
const uncovered = touched.filter((f) => !COVERED.includes(f));
if (uncovered.length) failures.push(`还原核对漏了：${uncovered.join(', ')}`);

for (const f of COVERED) {
  const short = f.slice(ROOT.length + 1);
  // 每个文件里那个"本轮修好的东西"必须仍在
  const marker = f === LOG_TS ? 'return redact(text);'
    : f === SW_TS ? 'out.logs = drain();'
    : f === PANEL_TS ? 'appLogs:'
    : f === PS_TS ? "log.debug('isEnforceable(%s) → 缓存 %s', host, cached);"
    : f === PSTORE_TS ? "export { OfflineError, isOfflineError } from './offline';"
    // ★ `messages.ts` 的 marker = 那个**真 kind** 仍在。
    //   配合下面那条"假 kind 必须不在"，两侧都钉住还原真的发生了。
    : f === MSGS_TS ? "| { kind: 'par.list' }"
    : f === TABRULES_TS ? "log.error('addRule #%d **失败**：%s',"
    : f === PH_TS ? 'id="cloud-account"'
    // ★ 第 13 节那三个 marker = 各自的**留痕语句**仍在（不是注释里的转述）。
    : f === ACACHE_TS ? 'log.warn(\'loadSnapshot 读缓存失败'
    : f === SAUTH_TS ? "log.warn('probeScheme(%s) 两个探测都失败"
    : f === FAV_TS ? 'log.warn(\'listFavorites 读 storage.local 失败'
    // ★ `cloud-device.ts` 的 marker = 那条"只记有没有凭据"的既有形态仍在。
    : "token ? '有' : '无'";
  const restored = readFileSync(f, 'utf8');
  const ok = restored.includes(marker)
    // 反证用的那些"缺陷版痕迹"必须**已经不在**（否则还原没做成）
    && !restored.includes('definitely.not.implemented')
    && !restored.includes('// 缺陷版：不记 error')
    && !restored.includes('// 缺陷版：留痕被拆掉')
    && !restored.includes('// 缺陷版：失败留痕被拆掉');
  if (!ok) failures.push(`${short} 还原不完整（marker=${marker}）`);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${short} 已还原（含 ${marker.slice(0, 40)}）`);
}

const total = CASES.length + 1;
const passed = total - failures.length;
console.log(`\nRESULT: ${passed}/${total} ${failures.length ? '—— 失败：' + failures.join('; ') : '反证通过（验收有效且已还原）'}`);
process.exit(failures.length ? 1 : 0);
