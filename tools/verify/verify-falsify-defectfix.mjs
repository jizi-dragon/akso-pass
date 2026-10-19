/**
 * `verify-defectfix.mjs` 的**反证**（2026-10-12）。
 *
 *     node tools/verify/verify-falsify-defectfix.mjs      # 秒级、不需要浏览器
 *
 * ## 为什么必须有这个脚本
 *
 * 本仓的规矩：**写完断言先问"拆掉什么它才会红"**，答不上来说明它没在验任何东西
 * （规则 17 / `tools/verify/README.md` 的「写新验证脚本的四条规矩」之 4）。
 *
 * `verify-defectfix.mjs` 的处境比一般断言更危险：它验的六条**全部是静态形状**，
 * 而静态形状的断言最容易写成"恒真"（锚点选错、正则太松、范围划错都会让它**永远绿**）。
 * ★ 本脚本的**第一版判据自己就错过四次**（见 `verify-defectfix.mjs` 里的注释），
 *   而那四次全部表现为"✓ 通过"或"✗ 发现了不存在的缺陷" —— 单看绿根本分辨不出来。
 *
 * ## 做法
 *
 * 把仓库复制到 `tmp/`（`node_modules` 用 junction 链接复用），对**副本**逐个注入
 * "修复前"的写法，然后跑判据，要求它**必须变红且必须红在对的那一节**。
 *
 * ★ 刻意**不**在真实工作区上做注入：那样一旦中途失败就会把"缺陷"留在源码里
 *   （本仓规则 18 的同类风险：看起来正常、其实被改过）。
 *   副本在结束时整个删除。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TMP = path.join(ROOT, 'tmp');
const COPY = path.join(TMP, 'falsify-defectfix');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.log(`  ✗ ${m}`); bad++; };

/* ── 复制一份可运行的副本（node_modules 用 junction，避免几万文件的真实拷贝） ── */
function buildCopy() {
  fs.rmSync(COPY, { recursive: true, force: true });
  fs.mkdirSync(COPY, { recursive: true });
  // 只拷判据真正会读到的部分：packages/extension/src 与 tools/verify
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true });
  }
  fs.mkdirSync(path.join(COPY, 'packages', 'extension', 'src'), { recursive: true });
}

/** 注入"修复前"的写法；返回 false 表示锚点没命中（判据脚本本身该改） */
function poke(rel, from, to) {
  const p = path.join(COPY, rel);
  // ★★ 行尾必须归一化后再比对：本仓**同一个目录下混用 CRLF 与 LF**
  //   （实测 `service-worker.ts` / `shield-main.ts` 是 CRLF，其余是 LF）。
  //   多行锚点若按 LF 写，在 CRLF 文件里**永远匹配不上** —— 而症状是
  //   "锚点没命中"，读起来像判据脚本写错了，实际是行尾差异。
  //   ⇒ 两侧都归一化成 LF 再比，命中后按**原文件的**行尾风格写回。
  const src = fs.readFileSync(p, 'utf8');
  const crlf = src.includes('\r\n');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const srcN = norm(src);
  const fromN = norm(from);
  // ★★ 锚点**必须唯一**：`String.replace` 只改第一处，而"第一处不是你想改的那处"
  //   不会报错 —— 注入落在别的地方，判据看起来"没变红"，于是被误读成
  //   "这条断言是恒真的"。实测已因此误判两次（D 与 F）。
  //   ⇒ 数一下出现次数，不是 1 就明确失败。
  const hits = srcN.split(fromN).length - 1;
  if (hits !== 1) {
    console.log(`      （锚点命中 ${hits} 次，应为 1 —— ${rel}）`);
    return false;
  }
  const outN = srcN.replace(fromN, norm(to));
  fs.writeFileSync(p, crlf ? outN.replace(/\n/g, '\r\n') : outN, 'utf8');
  return true;
}

/** 取出"某一节"的输出（从该节标题到下一个 `=== ` 标题） */
function sectionOf(out, heading) {
  const at = out.indexOf(heading);
  if (at < 0) {
    return null;
  }
  const rest = out.slice(at + heading.length);
  const nextAt = rest.indexOf('\n=== ');
  return nextAt < 0 ? rest : rest.slice(0, nextAt);
}

/** 跑副本里的判据，返回 { code, out } */
function runVerifier() {
  const r = spawnSync(process.execPath, [path.join(COPY, 'tools', 'verify', 'verify-defectfix.mjs')], {
    encoding: 'utf8',
    cwd: COPY,
  });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/* ── 六个反证：每个都对应 verify-defectfix.mjs 里的一组断言 ── */
const CASES = [
  {
    name: 'A. 把 `reused` 改回字面量 false',
    section: '=== A.',
    file: 'packages/extension/src/background/core/parallel-session.ts',
    probe: 'reused: false',
    apply: () => poke('packages/extension/src/background/core/parallel-session.ts',
      'return { tabId, reused: reused };', 'return { tabId, reused: false };'),
  },
  {
    name: 'B. 拆掉凭据的来源域校验（改回"只认 tab"的旧分支）',
    section: '=== B.',
    file: 'packages/extension/src/background/service-worker.ts',
    probe: 'boundHostOf',
    // ★ 不能只把 senderHost 弄成 boundHostBare —— 那样校验**照样通过**，
    //   反证会假绿（"判据没红"被误判成"修复没生效"）。必须真的拆掉整段校验。
    apply: () => poke('packages/extension/src/background/service-worker.ts',
      `    const boundHost = parallelSession.boundHostOf(tabId);
    const boundHostBare = boundHost ? hostNoPortOf(boundHost) : undefined;
    const senderHost = originHostOf(sender.origin ?? sender.url);
    if (!boundHostBare || senderHost !== boundHostBare) {`,
      `    if (false) {`),
  },
  {
    name: 'C. 叛逃清扫改回补丁版 indexedDB.databases()',
    section: '=== C.',
    file: 'packages/extension/src/content/shield-main.ts',
    probe: 'indexedDB.databases(',
    apply: () => poke('packages/extension/src/content/shield-main.ts',
      'const dbs = (await rawIdbDatabases.call(rawIdbFactory)) ?? [];',
      'const dbs = (await indexedDB.databases()) ?? [];'),
  },
  {
    name: 'D. 把"在数据源处"注回一条用户可见文案',
    section: '=== D.',
    file: 'packages/extension/src/background/core/cloud-store.ts',
    probe: '在数据源处',
    // ★ 锚点必须**唯一**：`请在管理页点「重新登录」登录云端账号库` 这个短语在
    //   `cloud-store.ts` 里出现了两次（`登录已过期…` 那条也含它），
    //   `String.replace` 只会改**第一处** ⇒ 第一版注到了不相干的字符串上，
    //   于是"判据没红"被误读成"判据恒真"。带上行首的唯一前缀即可。
    apply: () => poke('packages/extension/src/background/core/cloud-store.ts',
      "throw new Error('云端未授权：请先在管理页点「重新登录」登录云端账号库');",
      "throw new Error('云端未授权：请先在数据源处登录云端账号库');"),
  },
  {
    /* ★★ v4.2.12：这条反证的**注入目标跟着判据换向**了。
     *
     * 旧形态：把 `loadSites()` 里 `blockedHosts` 那次写盘的守卫拿掉 ⇒ 判据变红。
     * 新形态（用户要求"站点管理只做增删改，无需关注授权"之后）：那段写盘搬进了
     * `purgeLegacyHostLists()`，而 `loadSites()` 自己**不许**有任何写盘。
     *
     * ⇒ 现在注入两处，对应新判据的两条：
     *   ① 把清理里的守卫拿掉（应当被"清理有守卫"那条抓住）
     *   ② 在 `loadSites()` 里直接塞一句写盘（应当被"自身零写盘"那条抓住）
     * ★ 只注入 ① 是不够的 —— 那样"零写盘"那条判据永远没被反证过，
     *   而它恰恰是这一版新增的、**唯一**能防住"以后有人顺手加回去"的那一条。
     */
    name: 'E. 拿掉旧名单清理的守卫 + 在 loadSites 里直接写盘',
    section: '=== E.',
    file: 'packages/extension/src/ui/parallel/parallel.ts',
    probe: 'purgeLegacyHostLists',
    apply: () => {
      // ★★ 两处都必须成功。**第一版我只写了两次调用、`return` 都没写** ——
      //   于是 `apply()` 返回 `undefined` ⇒ `!applied` 成立 ⇒ 脚本报
      //   "锚点没命中"，而真实原因是**它自己没把结果传出来**。
      //   判据脚本自己报假红，比判据本身写错更坏（它把注意力引到源码上）。
      const a = poke('packages/extension/src/ui/parallel/parallel.ts',
        `  if (!stale.length) {
    return;
  }
  await chrome.storage.local.remove(stale);`,
        '  await chrome.storage.local.remove(stale);');
      const b = poke('packages/extension/src/ui/parallel/parallel.ts',
        '  await purgeLegacyHostLists();',
        "  await chrome.storage.local.set({ 'ql:probe': 1 });\n  await purgeLegacyHostLists();");
      return a && b;
    },
  },
  {
    name: 'F. 把 send() 改回裸 resolve（不读 lastError / 不合成失败）',
    section: '=== F.',
    file: 'packages/extension/src/ui/send.ts',
    probe: 'chrome.runtime.lastError',
    // ★ 直接把整个 `send` 体换成**修复前那一行**。第一版只是把
    //   `chrome.runtime.lastError` 换成 `null` —— 字符串还在文件里，
    //   判据照样绿，于是"没变红"被误读成"判据恒真"。
    apply: () => poke('packages/extension/src/ui/send.ts',
      'export function send(req: RuntimeRequest): Promise<RuntimeResponse> {',
      `export function send(req: RuntimeRequest): Promise<RuntimeResponse> {
  // @ts-expect-error 反证注入：修复前的实现就是这一行
  return new Promise((resolve) => { chrome.runtime.sendMessage(req, resolve); });
}
function sendFixedBody(req: RuntimeRequest): Promise<RuntimeResponse> {`),
  },
];

console.log('=== 建立副本 ===');
buildCopy();
ok(`副本已建：${path.relative(ROOT, COPY)}`);

console.log('\n=== 基线：未注入任何缺陷时判据必须是绿的 ===');
{
  const { code, out } = runVerifier();
  if (code === 0) {
    ok('基线绿（RESULT: OK）');
  } else {
    fail(`基线就红了 —— 后续反证无意义。输出：\n${out.trim().split('\n').slice(-12).join('\n')}`);
  }
}

console.log('\n=== 逐个注入"修复前"的写法：判据必须变红，且红在对的那一节 ===');
for (const c of CASES) {
  buildCopy();
  const applied = c.apply();
  if (!applied) {
    fail(`${c.name} —— **锚点没命中**（判据脚本里的 poke 目标与源码不符，先修判据）`);
    continue;
  }
  const { code, out } = runVerifier();
  if (code === 0) {
    // ★ 诊断：把注入后的关键文件、以及判据对它的实际解读打出来。
    //   "判据恒真"与"注入根本没落地"在只看结论时长得一模一样。
    try {
      const p = path.join(COPY, c.file);
      const src = fs.readFileSync(p, 'utf8');
      const stripped = src.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/^[ \t]*\/\/.*$/gm, ' ');
      console.log(`      （诊断）注入后仍含 "${c.probe}"：原文 ${src.includes(c.probe)}，`
        + `剥注释后 ${stripped.includes(c.probe)}`);
    } catch { /* 诊断失败不影响结论 */ }
    fail(`${c.name} —— 判据**没有变红**：这条断言是恒真的，它没在验任何东西`);
    continue;
  }
  // 必须红在对应小节，而且必须明确指出是"检出缺陷"而不是"判据自己崩了"
  const after = sectionOf(out, c.section);
  if (after === null) {
    fail(`${c.name} —— 判据红了，但**不是在这一节**（找不到 ${c.section}）`);
  } else if (!after.includes('✗')) {
    fail(`${c.name} —— 判据红了，但 ${c.section} 这一节里没有 ✗（红在别处）`);
  } else {
    const line = after.split('\n').find((l) => l.includes('✗'))?.trim() ?? '';
    ok(`${c.name} ⇒ 变红：${line.slice(0, 96)}`);
  }
}

console.log('\n=== 清理副本 ===');
fs.rmSync(COPY, { recursive: true, force: true });
ok('副本已删除（真实工作区**从未被改动**）');

console.log(`\n${bad === 0 ? 'RESULT: OK（反证有效且已还原）' : `RESULT: ${bad} 处不符`}`);
process.exit(bad === 0 ? 0 : 1);
