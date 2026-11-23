/**
 * `verify-shot.mjs` 的反证：把每条判据对应的**真实缺陷**注进去，看它红不红。
 *
 *     node tools/verify/verify-falsify-shot.mjs
 *
 * 纯静态、秒级。改的是**真实源码**，每条之后立刻还原，末尾做逐字节核对。
 *
 * ## 为什么反证要"指名道姓"
 *
 * 只断言"退出码是 1"是不够的：**脚本自己崩了也是 1**（本仓已经因此假绿过一次）。
 * 所以每条反证都要断言"红的是**哪一条**"—— 期望的判据标签必须出现在某条 FAIL 行里。
 *
 * ## 每条缺陷都是"用户真会遇到的形态"
 *
 * | 注入的缺陷 | 用户那边的表现 |
 * |---|---|
 * | 去掉「所有网站」权限 | 每一步都只有文字、没有截图 |
 * | 把手势请求挪到 await 之后 | 授权气泡不弹，`permissions.request` 直接失败 |
 * | 按 windowId 过滤页签 | 新窗口里的操作一条都不记 |
 * | 授权 pattern 带端口 | 报"缺少站点授权"，按提示重授权也没用 |
 * | 标注里加一块压暗 | 框外黑糊糊（用户原话） |
 * | md 默认不内嵌图片 | 用户只拿到 .md ⇒ 图片全裂 |
 * | docx 去掉页脚 | 打印出来的手册没有页码 |
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'extension', 'src');
const EXT = join(ROOT, 'packages', 'extension');
const CHECK = join(HERE, 'verify-shot.mjs');

/** @type {{file:string,find:string,replace:string,expect:string,why:string}[]} */
const CASES = [
  {
    // ★ 本仓的源码是 CRLF：注入片段里的换行必须写 `\r\n`，否则"找不到注入点"⇒ 反证是空的
    file: join(EXT, 'manifest.json'),
    find: ',\r\n    "<all_urls>"',
    replace: '',
    expect: 'manifest 的可选主机权限里有「所有网站」',
    why: '没有 all-sites 权限 ⇒ captureVisibleTab 必然抛错，每步都只剩文字',
  },
  {
    file: join(SRC, 'ui/popup/popup.ts'),
    find: "shotRunning === null ? chrome.permissions.request({ origins: ['<all_urls>'] })",
    replace: "shotRunning === null ? (await Promise.resolve(), chrome.permissions.request({ origins: ['<all_urls>'] }))",
    expect: 'permissions.request 出现在该处理器**第一个 await 之前**',
    why: '手势在 await 之后失效 ⇒ 授权气泡不弹',
  },
  {
    file: join(SRC, 'background/core/shot-capture.ts'),
    // 不带换行的锚点：CRLF/LF 两边都能命中（上一版本带 `\n` 导致注入落空）
    find: 'if (running && running.sessionId === sessionId) {',
    replace: 'if (running && running.windowId !== 0) return false;\r\n  if (running && running.sessionId === sessionId) {',
    expect: '没有按 windowId 过滤页签',
    why: '按窗口过滤 ⇒ 新窗口/新页签的操作全丢（本功能的原始缺陷）',
  },
  {
    file: join(SRC, 'background/core/shot-capture.ts'),
    find: 'const pattern = `*://${hostBare}/*`;',
    replace: 'const pattern = `*://${host}/*`;',
    expect: '站点授权 pattern 用不带端口的 host',
    why: 'match pattern 不接受端口 ⇒ 带端口的站点永远"缺少授权"',
  },
  {
    file: join(SRC, 'shared/shot-annotate.ts'),
    find: '  ctx.save();\n  ctx.lineJoin =',
    replace: '  ctx.save();\n  ctx.fillStyle = "rgba(15, 23, 42, 0.55)";\n  ctx.fillRect(0, 0, 10, 10);\n  ctx.lineJoin =',
    expect: '标注里没有任何填充',
    why: '压暗遮罩会盖住框外内容（用户明确反感）',
  },
  {
    file: join(SRC, 'shared/markdown.ts'),
    find: 'opts.embedImages ?? true',
    replace: 'opts.embedImages ?? false',
    expect: 'md 默认内嵌图片',
    why: '不内嵌就退回到"另发一个 assets.zip"，用户只拿 .md 时图片全裂',
  },
  {
    file: join(SRC, 'shared/docx.ts'),
    // 整段删掉（不要只改 id：`footerReference` 这几个字还在 ⇒ 判据不红 ⇒ 反证是假的）
    find: '<w:footerReference w:type="default" r:id="rIdFooter"/>',
    replace: '',
    expect: 'docx 有页脚页码',
    why: '没有页脚 ⇒ 打印出来的手册翻页即散',
  },
];

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
}

/** 跑一次判据，返回 {code, out} */
function runCheck() {
  const r = spawnSync(process.execPath, [CHECK], { cwd: ROOT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

console.log('=== 前提：判据现在是绿的 ===');
const base = runCheck();
check('基线：verify-shot.mjs 全绿', base.code === 0, `exit=${base.code}`);

for (const [i, c] of CASES.entries()) {
  console.log(`\n=== 反证 ${i + 1}/${CASES.length}：${c.why} ===`);
  const original = readFileSync(c.file, 'utf8');
  if (!original.includes(c.find)) {
    check(`注入点存在（${c.file.split(/[\\/]/).slice(-2).join('/')}）`, false, '找不到要替换的片段 ⇒ 这条反证是空的');
    continue;
  }
  try {
    writeFileSync(c.file, original.replace(c.find, c.replace));
    const bad = runCheck();
    const failLine = bad.out
      .split(/\r?\n/)
      .find((line) => line.includes('FAIL') && line.includes(c.expect));
    check(`注入缺陷后变红，且红的是「${c.expect}」`, bad.code === 1 && Boolean(failLine), failLine ? '命中' : `exit=${bad.code}`);
  } finally {
    writeFileSync(c.file, original);
  }
}

console.log('\n=== 还原：逐字节核对 ===');
const after = runCheck();
check('还原后判据重新全绿', after.code === 0, `exit=${after.code}`);

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => {
    if (!ok) console.log(`  第 ${i + 1} 项失败`);
  });
  process.exit(1);
}
console.log('RESULT: OK');
