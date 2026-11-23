/**
 * 「自动截图」的三条用户诉求是否真的落进了代码。
 *
 *     node tools/verify/verify-shot.mjs
 *
 * 纯静态、秒级、**不需要浏览器**。
 *
 * ## 它治的是哪三次"看起来正常"的退化
 *
 * | # | 用户诉求 | 退化后会怎样 | 为什么 typecheck/build 抓不到 |
 * |---|---|---|---|
 * | 1 | 录制**整个浏览器**（新页签/新窗口） | 只挂在开录那个页签上，后半段操作**一条都不记** | 少一个监听仍是合法 TS；`tabIds` 只增不减也合法 |
 * | 2 | 截图**只画框、不压暗** | 框外被四块半透明矩形盖住，用户"看着黑糊糊的" | 压暗是**像素**效果，`tsc` 看不见 |
 * | 3 | 导出**可读**且 md 图片能显示 | md 里写 `assets/step-01.png`，用户只拿到 `.md` ⇒ **图片全裂** | 路径字符串合法、Word 照样能生成 |
 *
 * ★ 还有一条**实测出来的坑**：截图权限只认「所有网站」（all-sites），
 *   而本仓登录时请求的全网通配（`permissions.request` 的 `*://` 全域名形态）
 *   在 `captureVisibleTab` 面前**不算授权**（见 `docs/PITFALLS.md` 的两条新坑）。
 *   判据 ①③ 就是钉这两件事。
 *
 * ## 判据的形状
 *
 * 每条断言都问过「**拆掉什么它才会红**」，反证见 `verify-falsify-shot.mjs`。
 * ★ 断言前一律先剥注释（规则 23）：本仓的**说明文字**里就写着这些反向形态
 *   （例如"v4.6.0 这里还有 `running.windowId !== ...`"），不剥会**假红**。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_lib/strip-comments.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const EXT = join(ROOT, 'packages', 'extension');
const SRC = join(EXT, 'src');

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
}

/** 读源码并剥注释（保留行号）；文件不存在时返回 null，由调用方先断言存在 */
function code(rel) {
  const p = join(SRC, rel);
  if (!existsSync(p)) return null;
  return stripComments(readFileSync(p, 'utf8'));
}
function raw(rel) {
  const p = join(SRC, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 截图权限：只有「所有网站」能喂给 captureVisibleTab
 * ══════════════════════════════════════════════════════════════════════ */
console.log('=== ① 截图权限走「所有网站」而不是全网通配 ===');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const optional = manifest.optional_host_permissions ?? [];
const required = manifest.host_permissions ?? [];
check(
  'manifest 的可选主机权限里有「所有网站」(all-sites)',
  optional.some((p) => p === '<all_urls>') || required.some((p) => p === '<all_urls>'),
  `optional=${JSON.stringify(optional)}`,
);
// 全网通配（星号协议 + 星号主机）仍要在 —— 登录流请求的是它，删掉会连带坏掉别的功能
check(
  '全网通配（登录流用）仍在可选主机权限里',
  optional.some((p) => /^\*:\/\/\*\/\*$/.test(p)),
  JSON.stringify(optional),
);

const popup = code('ui/popup/popup.ts');
check('popup.ts 存在且非空', Boolean(popup && popup.length > 1000));
if (popup) {
  // 用户手势：permissions.request 必须在**第一次 await 之前**发起
  // ★ 匹配 `shotBtn?.addEventListener('click'` —— 这里带可选链，写死成 `shotBtn.addEventListener`
  //   会**假红**（本轮就踩了一次：判据找不到处理器，看起来像"没有开录入口"）。
  const mHandler = /shotBtn\??\.addEventListener\(\s*'click'/.exec(popup);
  const idxHandler = mHandler ? mHandler.index : -1;
  check('能在 popup.ts 里定位开录按钮的 click 处理器', idxHandler >= 0, `@${idxHandler}`);
  const body = idxHandler > 0 ? popup.slice(idxHandler) : '';
  const iReq = body.indexOf('permissions.request');
  const iAwait = body.indexOf('await');
  check(
    '开录处理器里有 permissions.request',
    iReq > 0,
    iReq > 0 ? `@+${iReq}` : '没有 ⇒ 截图权限永远拿不到',
  );
  check(
    'permissions.request 出现在该处理器**第一个 await 之前**',
    iReq > 0 && iAwait >= 0 && iReq < iAwait,
    `request@+${iReq} await@+${iAwait}（用户手势在 await 之后就失效了）`,
  );
}

const shotPage = code('ui/shot/shot.ts');
if (shotPage) {
  check('自动截图页有「授予截图权限」的入口（permissions.request）', shotPage.includes('permissions.request'));
  check('自动截图页用 permissions.contains 判断当前是否已授权', shotPage.includes('permissions.contains'));
}
const shotHtml = raw('ui/shot/shot.html');
if (shotHtml) {
  check('shot.html 有授权横幅 #perm-bar 与按钮 #grant', shotHtml.includes('id="perm-bar"') && shotHtml.includes('id="grant"'));
}

/* ══════════════════════════════════════════════════════════════════════
 * ② 录制范围：整个浏览器（多页签 / 多窗口），不再按 windowId 过滤
 * ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== ② 录制范围是整个浏览器 ===');
const capture = code('background/core/shot-capture.ts');
check('shot-capture.ts 存在且非空', Boolean(capture && capture.length > 4000));
if (capture) {
  // ★ 反方向：任何"窗口不等就拒绝/跳过"的比较都意味着又缩回单窗口
  const windowFilters = [...capture.matchAll(/(?:running|state|active)\.windowId\s*!==|tab\.windowId\s*!==/g)];
  check(
    '没有按 windowId 过滤页签（多窗口录制的前提）',
    windowFilters.length === 0,
    windowFilters.length > 0 ? `${windowFilters.length} 处窗口比较` : '零处',
  );
  check('开录时会把录制器铺到整个浏览器（attachAllTabs）', /attachAllTabs\s*\(/.test(capture));
  // 同一函数的定义与调用都要在（"接口摆在那里"≠"接上了"，规则 30）
  const iDef = capture.indexOf('async function attachAllTabs');
  const iCall = capture.indexOf('await attachAllTabs(');
  check('attachAllTabs 既有定义也被 startShot 调用', iDef > 0 && iCall > 0, `def@${iDef} call@${iCall}`);
  // 停止/收尾时"全浏览器找补挂页签"必须用不加 windowId 的 query
  const removals = [...capture.matchAll(/chrome\.tabs\.query\(\{([^}]*)\}\)/g)].map((m) => m[1].trim());
  check(
    'onRemoved 收尾用的是全浏览器 tabs.query({})',
    removals.some((a) => a === ''),
    `query 形态=${JSON.stringify(removals)}`,
  );
  check(
    '最后一页签关掉才收尾（reason 文案还在）',
    capture.includes('录制的页签都已关闭'),
  );
  // 站点授权 pattern 必须去掉端口：match pattern 不接受端口
  check(
    '站点授权 pattern 用不带端口的 host（match pattern 不接受端口）',
    capture.includes('const pattern = `*://${hostBare}/*`'),
  );
  check('截图失败不再整体抛出（降级为"只记文字"）', /hasImage:\s*false|hasImage: false|image = null/.test(capture) || capture.includes('没有截图权限'));
}

/* ══════════════════════════════════════════════════════════════════════
 * ③ 标注：只画框，不压暗
 * ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== ③ 只框选目标，不铺遮罩 ===');
const annotate = code('shared/shot-annotate.ts');
check('标注逻辑已拆成 shared/shot-annotate.ts（预览与后台共用同一份）', Boolean(annotate && annotate.length > 400));
if (annotate) {
  check('drawFrame 从该文件导出', /export function drawFrame\s*\(/.test(annotate));
  check('标注里没有任何填充（fillRect / fill()）', !/\.fillRect\s*\(|\.fill\s*\(/.test(annotate));
  check('没有遗留的压暗色 rgba(15, 23, 42', !/rgba\(\s*15\s*,\s*23\s*,\s*42/.test(annotate.replace(/\s/g, ' ')));
}
if (capture) {
  check('shot-capture.ts 里也不再有压暗填充', !/\.fillRect\s*\(/.test(capture), '压暗就是这里画出来的');
  check('shot-capture.ts 用的是共享的 drawFrame', /import\s*\{\s*drawFrame\s*\}/.test(capture));
}

/* ══════════════════════════════════════════════════════════════════════
 * ④ 导出：可读 + md 图片内嵌（单文件不再裂图）
 * ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== ④ 导出文档可读且 md 自带图片 ===');
const docx = code('shared/docx.ts');
check('docx.ts 存在且非空', Boolean(docx && docx.length > 4000));
if (docx) {
  check('docx 带默认样式 word/styles.xml', docx.includes("word/styles.xml") && docx.includes('[Content_Types].xml'));
  check('docx 的默认字体含中文 eastAsia', docx.includes('eastAsia'));
  check('docx 有页脚页码（footerReference）', docx.includes('footerReference') && docx.includes('PAGE'));
  check('docx 用真表格（w:tbl）承载信息与附录', docx.includes('<w:tbl>'));
  check('docx 图片同时封宽与封高（细长截图不被裁）',
    docx.includes('MAX_IMAGE_W_EMU') && docx.includes('MAX_IMAGE_H_EMU'));
  check('docx 有"操作概览"章节', docx.includes('操作概览'));
}

const markdown = code('shared/markdown.ts');
check('markdown.ts 存在且非空', Boolean(markdown && markdown.length > 2000));
if (markdown) {
  check('md 默认内嵌图片（embedImages 缺省 true）', /embed\s*=\s*opts\.embedImages\s*\?\?\s*true/.test(markdown));
  check('md 真的写出 data: URI', markdown.includes('data:image/png;base64,'));
  check('md 有操作概览表', markdown.includes('操作概览'));
}

if (shotPage) {
  check('导出 md 时传了 embedImages: true', /embedImages:\s*true/.test(shotPage));
  // 反方向：md 路径上不许再"另下一个 -assets.zip"（那正是裂图的成因）
  // ★ 必须比**调用点**而不是第一次出现：`import { buildImageZip, buildMarkdown }` 里
  //   前者在前，用裸字符串比会**假红**（本轮踩过）。
  const iZip = shotPage.indexOf('buildImageZip(');
  const iMd = shotPage.indexOf('buildMarkdown(');
  check('buildImageZip 只服务「导出图片包」，不在 md 路径上', iZip > 0 && iZip > iMd, `zip@${iZip} md@${iMd}`);
  check('md 下载不再附带 assets 压缩包', !/assets\.zip|'-assets'/.test(shotPage));
}

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 自证
 * ══════════════════════════════════════════════════════════════════════ */
console.log('\n=== ⑤ 自证：读到的都是真文件 ===');
check('8 份被测源码都在盘上且非空',
  [popup, shotPage, shotHtml, capture, annotate, docx, markdown].every((s) => Boolean(s && s.length > 400))
  && Boolean(manifest.permissions?.length));

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => {
    if (!ok) console.log(`  第 ${i + 1} 项失败`);
  });
  process.exit(1);
}
console.log('RESULT: OK');
