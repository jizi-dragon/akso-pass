/**
 * `verify-frameisolation.mjs` 的**反证**（v4.2.33）。
 *
 *     node tools/verify/verify-falsify-frameisolation.mjs      # 秒级、不需要浏览器
 *
 * ## 为什么需要
 *
 * 本仓规矩（`tools/verify/README.md`「写新验证脚本的四条规矩」之 4）：
 * **写完断言先问"拆掉什么它才会红"**，答不上来说明它没在验任何东西。
 *
 * `verify-frameisolation.mjs` 的十组断言**全是静态形状**，而静态形状最容易写成
 * 恒真（锚点选错、正则太松、窗口划错都会让它永远绿）。这里把仓库复制到 `tmp/`，
 * 对副本逐个注入"修复前"的写法，要求判据**必须变红，且必须红在对的那一节**。
 *
 * ★ 刻意不碰真实工作区：中途失败会把缺陷留在源码里（本仓规则 18 的同类风险）。
 *
 * ## 反证与断言的对应
 *
 * | 注入的"修复前"写法 | 应当变红的节 |
 * |---|---|
 * | 去掉 `{ frameId: 0 }`（回到广播） | A |
 * | hello 的来源校验改成 `if (false)` | B |
 * | 导航护栏换回"恒假"（等价于不看归属） | D |
 * | 删掉 `initiatorDomains` | E |
 * | `hasHostAccess` 的 catch 改回 `return true` | F |
 * | 回放侧删掉 `saneCookiePair` | G |
 * | 删掉"裸 JWT"打码规则 | H |
 * | 删掉 `locationMatchesHost` 调用 | I |
 * | 删掉 `regexFilter: '^https://'` | J |
 * | 删掉 Cookie 子资源规则的 `initiatorDomains` | K |
 * | 兜底资源类型漏掉 `ping` | K |
 * | 去掉 Cookie 回放的 https 限定 | K |
 * | scheme 翻转不再重建回放规则 | K |
 *
 * ★ 每个 `poke()` 的锚点**必须唯一**：`String.replace` 只改第一处，"第一处不是想的
 *   那处"不会报错，症状是"判据没变红"，很容易被误读成"判据恒真"。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const COPY = path.join(ROOT, 'tmp', 'falsify-frameisolation');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  bad++;
};

/* ── 复制一份可运行的副本（判据只读 src 与 tools/verify，不需要 node_modules） ── */
function buildCopy() {
  fs.rmSync(COPY, { recursive: true, force: true });
  for (const rel of ['packages/extension/src', 'tools/verify']) {
    fs.cpSync(path.join(ROOT, rel), path.join(COPY, rel), { recursive: true });
  }
}

/** 注入"修复前"的写法；返回 false 表示锚点没命中（判据脚本本身该改） */
function poke(rel, from, to) {
  const p = path.join(COPY, rel);
  // ★ 行尾归一化：本仓同目录混用 CRLF/LF（service-worker.ts / shield-main.ts 是 CRLF），
  //   多行锚点按 LF 写会在 CRLF 文件里永远匹配不上，症状却像"判据写错了"。
  const src = fs.readFileSync(p, 'utf8');
  const crlf = src.includes('\r\n');
  const norm = (s) => s.replace(/\r\n/g, '\n');
  const srcN = norm(src);
  const fromN = norm(from);
  const hits = srcN.split(fromN).length - 1;
  if (hits !== 1) {
    console.log(`      （锚点命中 ${hits} 次，应为 1 —— ${rel}）`);
    return false;
  }
  const outN = srcN.replace(fromN, norm(to));
  fs.writeFileSync(p, crlf ? outN.replace(/\n/g, '\r\n') : outN, 'utf8');
  return true;
}

/** 取出某一节的输出（从该节标题到下一个 `=== ` 标题） */
function sectionOf(out, heading) {
  const at = out.indexOf(heading);
  if (at < 0) return null;
  const rest = out.slice(at + heading.length);
  const nextAt = rest.indexOf('\n=== ');
  return nextAt < 0 ? rest : rest.slice(0, nextAt);
}

function runVerifier() {
  const r = spawnSync(
    process.execPath,
    [path.join(COPY, 'tools', 'verify', 'verify-frameisolation.mjs')],
    { encoding: 'utf8', cwd: COPY },
  );
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/* ── 九个反证 ── */
const CASES = [
  {
    name: 'A. 把 bind 改回"广播到所有 frame"',
    section: '=== A.',
    file: 'packages/extension/src/background/core/parallel-session.ts',
    apply: () => poke(
      'packages/extension/src/background/core/parallel-session.ts',
      `      { type: CONTENT_MESSAGE.bridgeDown, payload },
      { frameId: 0 },`,
      '      { type: CONTENT_MESSAGE.bridgeDown, payload },',
    ),
  },
  {
    name: 'B. 拆掉 hello 的来源归属校验',
    section: '=== B.',
    file: 'packages/extension/src/background/core/parallel-session.ts',
    // ★ 保留后续 op 的那道（4 空格缩进），只拆 hello 的（10 空格）：
    //   两道都拆会连带 C 变化，反证就不再是"只动一处"。
    apply: () => poke(
      'packages/extension/src/background/core/parallel-session.ts',
      '          if (!senderMatchesBinding(sender, binding)) {',
      '          if (false) {',
    ),
  },
  {
    name: 'D. 导航护栏不再看归属',
    section: '=== D.',
    file: 'packages/extension/src/background/core/parallel-session.ts',
    apply: () => poke(
      'packages/extension/src/background/core/parallel-session.ts',
      '    if (!ownedBy(url, binding.host)) {',
      '    if (false) {',
    ),
  },
  {
    name: 'E. 删掉 DNR 的 initiatorDomains',
    section: '=== E.',
    file: 'packages/extension/src/background/core/tab-rules.ts',
    apply: () => poke(
      'packages/extension/src/background/core/tab-rules.ts',
      '      initiatorDomains: [hostNoPortOf(host)],\n',
      '',
    ),
  },
  {
    name: 'F. hasHostAccess 的 catch 改回 fail-open',
    section: '=== F.',
    file: 'packages/extension/src/background/core/cloud-store.ts',
    // ★ 必须整段换掉：只把 `return false` 改成 `true` 的话，
    //   注释/别处的 `return false` 仍会让判据绿，反证会假绿。
    apply: () => poke(
      'packages/extension/src/background/core/cloud-store.ts',
      `  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }`,
      `  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return true;
  }`,
    ),
  },
  {
    name: 'G. 回放侧不再校验 Cookie 形状',
    section: '=== G.',
    file: 'packages/extension/src/background/core/parallel-session.ts',
    apply: () => poke(
      'packages/extension/src/background/core/parallel-session.ts',
      '.filter((c) => !IDENTITY_COOKIE_BLACKLIST.has(c.name) && saneCookiePair(c.name, c.value))',
      '.filter((c) => !IDENTITY_COOKIE_BLACKLIST.has(c.name))',
    ),
  },
  {
    name: 'H. 删掉裸 JWT 打码规则',
    section: '=== H.',
    file: 'packages/extension/src/shared/redact.ts',
    // ★ 必须**整行删掉**，不能只改规则名：`redact.ts` 的注释里也写着"裸 JWT"，
    //   而该文件的剥离器会被正则字面量里的引号带偏（见判据 H 的注释），
    //   只改名会因为注释残留而假绿。
    apply: () => poke(
      'packages/extension/src/shared/redact.ts',
      "  { name: '裸 JWT', re: /\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]*/g, to: REDACTED },\n",
      '',
    ),
  },
  {
    name: 'I. handleBind 不再校验当前 frame 的 host',
    section: '=== I.',
    file: 'packages/extension/src/content/shield-main.ts',
    apply: () => poke(
      'packages/extension/src/content/shield-main.ts',
      "    if (!locationMatchesHost(siteHost ?? '')) {",
      '    if (false) {',
    ),
  },
  {
    name: 'J. 去掉 AUTH 规则的 https 限定',
    section: '=== J.',
    file: 'packages/extension/src/background/core/tab-rules.ts',
    apply: () => poke(
      'packages/extension/src/background/core/tab-rules.ts',
      "      ...(scheme === 'https' ? { regexFilter: '^https://' } : {}),\n",
      '',
    ),
  },
  {
    name: 'K. 去掉 Cookie 子资源规则的 initiatorDomains',
    section: '=== K.',
    file: 'packages/extension/src/background/core/tab-rules.ts',
    apply: () => poke(
      'packages/extension/src/background/core/tab-rules.ts',
      "      ...(kind === 'sub' ? { initiatorDomains: [hostNoPortOf(host)] } : {}),\n",
      '',
    ),
  },
  {
    name: 'L. 兜底资源类型漏掉 ping',
    section: '=== K.',
    file: 'packages/extension/src/background/core/tab-rules.ts',
    apply: () => poke(
      'packages/extension/src/background/core/tab-rules.ts',
      "  'ping',\n",
      '',
    ),
  },
  {
    name: 'M. 去掉 Cookie 回放的 https 限定',
    section: '=== K.',
    file: 'packages/extension/src/background/core/tab-rules.ts',
    apply: () => poke(
      'packages/extension/src/background/core/tab-rules.ts',
      "      ...(kind !== 'strip' && scheme === 'https' ? { regexFilter: '^https://' } : {}),\n",
      '',
    ),
  },
  {
    name: 'N. scheme 翻转不再重建回放规则',
    section: '=== K.',
    file: 'packages/extension/src/background/core/tab-rules.ts',
    apply: () => poke(
      'packages/extension/src/background/core/tab-rules.ts',
      '      || meta.cookieScheme !== scheme\n',
      '',
    ),
  },
];

console.log('=== 建立副本 ===');
buildCopy();
ok(`副本已建：${path.relative(ROOT, COPY)}`);

console.log('\n=== 基线：未注入时判据必须绿 ===');
{
  const { code, out } = runVerifier();
  if (code === 0) {
    ok('基线绿（RESULT: OK）');
  } else {
    fail(`基线就红了 —— 后续反证无意义。输出：\n${out.trim().split('\n').slice(-12).join('\n')}`);
  }
}

console.log('\n=== 逐个注入"修复前"的写法：判据必须变红，且红在对的一节 ===');
for (const c of CASES) {
  buildCopy();
  if (!c.apply()) {
    fail(`${c.name} —— **锚点没命中**（判据脚本里的 poke 目标与源码不符，先修判据）`);
    continue;
  }
  const { code, out } = runVerifier();
  if (code === 0) {
    fail(`${c.name} —— 判据**没有变红**：这条断言是恒真的，它没在验任何东西`);
    continue;
  }
  const section = sectionOf(out, c.section);
  if (section === null) {
    fail(`${c.name} —— 判据红了，但**不是在这一节**（找不到 ${c.section}）`);
  } else if (!section.includes('✗')) {
    fail(`${c.name} —— 判据红了，但 ${c.section} 这一节里没有 ✗（红在别处）`);
  } else {
    const line = section.split('\n').find((l) => l.includes('✗'))?.trim() ?? '';
    ok(`${c.name} ⇒ 变红：${line.slice(0, 96)}`);
  }
}

console.log('\n=== 清理副本 ===');
fs.rmSync(COPY, { recursive: true, force: true });
ok('副本已删除（真实工作区**从未被改动**）');

console.log(`\n${bad === 0 ? 'RESULT: OK（反证有效且已还原）' : `RESULT: ${bad} 处不符`}`);
process.exit(bad === 0 ? 0 : 1);
