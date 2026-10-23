/**
 * 用户文档判据：**面向用户的功能陈述必须与代码一致**。
 *
 *     node tools/verify/verify-user-docs.mjs
 *
 * ## 为什么需要它（v3.19，2026-10-09）
 *
 * 本仓 `AGENTS.md` 规则 27 早就写着：
 *
 * > ★★ **"用户会读到的每一句关于功能的描述"都要跟代码一起改**
 * >    （商店描述、帮助气泡、提示条）—— 字符串没有任何机制检查它是否还在说真话。
 *
 * 而实测：`AGENTS.md` §6.5 与 `docs/PROJECT-STATUS.md` 都做过一轮文档同步，
 * **唯独漏掉了 `docs/USER-MANUAL.md`** —— 因为前两者是**给开发者看的**，
 * 而它写的是给**用户**看的。结果它同时有**五处**与现状相反的现状陈述：
 *
 * | 位置 | 它说的 | 真相 |
 * |---|---|---|
 * | §4.1 表单说明 | 密码「**AES-GCM 加密保存在本机**，不上传任何服务器」 | 上传云端账号库，本机不留口令 |
 * | §十 数据与安全 | 密码「**AES-GCM 加密存放本机**（IndexedDB），任何服务器都拿不到」 | 同上 |
 * | §十 数据与安全 | 备份文件「**等效密码本（内含解密种子）**」 | v3.18 起备份**不含任何凭据材料** |
 * | §4.3 导出说明 | 导出物含「**全部账号（含加密密码）**」 | 只导元数据（站点/页签名/盒子/账号名） |
 * | §4.3 导入说明 | 「用**文件自带的密钥种子解密**，再用**本机的密钥重新加密**入库」 | 文件里没有种子，也没有密文 |
 * | Q7 | 「账号与加密密码**存在本机浏览器配置**里，换机走导出→导入」 | 存在**云端**；导出**搬不走口令** |
 *
 * ★★ **为什么这比崩溃更坏**：它不是报错，是**对用户撒谎**——
 *    · 用户会以为口令只在自己机器上，于是**低估"云端账号库被拖库"的影响**；
 *    · 用户会以为备份文件是密码本（**过度紧张**），或反过来以为换机靠导出就够了
 *      （**实际恢复不出密码**，这会让他在新机器上以为数据丢了）。
 *
 * ## 判据怎么划（★ 必须能区分「现状陈述」与「历史留痕」）
 *
 * 本仓 `PITFALLS #20` 的教训：**关键词分类器判不出"这句话是否在说谎"**，
 * 因为判据是**语义**的。⇒ 所以这里**不走关键词**，而是：
 *
 * 1. **只查"现状语气"的断言**：模式里带上必须同现的**现状措辞**
 *    （如「加密保存在本机」整体作为一个模式），而不是单独查 `AES-GCM` 这个词；
 * 2. **显式跳过带时间标记的行**（`v3.18` / `已废除` / `已删除` / `再也解不开`…）——
 *    那些是**正确的历史留痕**，改掉它们等于让人以为从来没存在过；
 * 3. ★ **多行断言的局限写在这里**：一句被折成两行、时间标记在**上一行**时，
 *    逐行扫描会把它判成现状陈述（实测误报 2 处）。⇒ 遇到 `FAIL` 先**读那一句**，
 *    确认它是不是真的在说现在；不要为了过判据去删正确的历史标注。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // tools/verify/ → 仓库根（两层）

const results = [];
function check(label, ok, detail = '') {
  results.push(ok);
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
}

const MANUAL = join(ROOT, 'docs', 'USER-MANUAL.md');
const manual = readFileSync(MANUAL, 'utf8');
const lines = manual.split('\n');

/** 带时间标记的行 = 正确的历史留痕，**不要动** */
const HISTORICAL = /v3\.\d|已废除|已删除|已整体废除|再也解不开|已经不存在|原先那套|旧版/;

console.log('=== 1. 前提自证：文档确实被读到了 ===');
check('USER-MANUAL.md 非空且像一份手册', manual.length > 3000 && lines.length > 100,
  `${lines.length} 行 / ${manual.length} 字符`);

/**
 * 「现状语气的假陈述」——每条**整体**作为一个模式，
 * 而不是"查某个词"（那会让正确的历史留痕一起命中）。
 */
const FALSE_CLAIMS = [
  {
    pat: /AES-GCM\s*加密(保存|存放)在?本机|AES-GCM\s*加密存放本机/,
    why: '本机凭据存储 v3.18 已整体废除 —— 口令存云端，本机不留',
  },
  {
    pat: /不上传任何服务器/,
    why: '口令**上传**云端账号库（服务端 Fernet 加密落库）',
  },
  {
    pat: /任何服务器（包括扩展作者）都(拿不到|看不到)/,
    why: '同上：口令在服务端，这条承诺已不成立',
  },
  {
    pat: /备份文件\s*[=＝]\s*密码本|等效密码本|内含解密种子|带着解密所需的密钥种子/,
    why: 'v3.18 起导出物**不含任何凭据材料**（无口令、无种子）',
  },
  {
    pat: /含加密密码|含加密口令/,
    why: '导出物只含元数据（站点/页签名/盒子/账号名）',
  },
  {
    pat: /文件自带的密钥种子解密|用\*\*本机的密钥重新加密\*\*入库/,
    why: '导出物里既没有种子也没有密文',
  },
  {
    pat: /账号与加密密码存在\*\*本机|密码存在\*\*本机/,
    why: '账号与口令存在**云端账号库**，本机只留不含口令的只读副本',
  },
];

console.log('\n=== 2. 面向用户的"数据在哪 / 备份含什么"不得与代码相反 ===');
let falseHits = 0;
for (const { pat, why } of FALSE_CLAIMS) {
  for (let i = 0; i < lines.length; i++) {
    if (!pat.test(lines[i])) continue;
    if (HISTORICAL.test(lines[i])) continue; // 正确的历史留痕
    // ★ 同现否定词的句子是"澄清"而不是"断言"（如「**不含**任何解密种子」）
    if (/不含|不再等同于|没有|不是/.test(lines[i])) continue;
    console.log(`  FAIL L${i + 1}: ${lines[i].trim().slice(0, 96)}`);
    console.log(`        理由：${why}`);
    falseHits++;
  }
}
check('没有"现状语气"的假陈述', falseHits === 0, falseHits ? `${falseHits} 处` : '');

console.log('\n=== 3. 而"真相"必须被明说（防止有人把假陈述删掉却不补真相）===');
check('文档明说口令在**云端账号库**', /云端账号库/.test(manual));
check('文档明说本机**不保存口令**', /不留口令|不保存口令|不含口令/.test(manual));
check('文档明说备份**不含口令/种子**', /不含任何口令|不含口令、也不含任何解密种子/.test(manual));

console.log('\n=== 4. manifest 的商店描述也必须与现状一致 ===');
const manifest = JSON.parse(
  readFileSync(join(ROOT, 'packages', 'extension', 'manifest.json'), 'utf8'),
);
const desc = String(manifest.description ?? '');
check('manifest.description 不再声称本地加密保存', !/AES-?GCM|加密保存|本地保存/.test(desc),
  desc.slice(0, 60));
check('manifest.description 提到账号存云端', /云端/.test(desc), '');

console.log('\n=== 5. 翻译图标的落地开关必须与用户手册/代码一致 ===');
const translateHtml = readFileSync(
  join(ROOT, 'packages', 'extension', 'src', 'ui', 'translate', 'translate.html'),
  'utf8',
);
const translateContent = readFileSync(
  join(ROOT, 'packages', 'extension', 'src', 'content', 'translate.ts'),
  'utf8',
);
const translateUi = readFileSync(
  join(ROOT, 'packages', 'extension', 'src', 'ui', 'translate', 'translate.ts'),
  'utf8',
);
const translateSettings = readFileSync(
  join(ROOT, 'packages', 'extension', 'src', 'shared', 'translate-settings.ts'),
  'utf8',
);

check('翻译面板有「点图标时填充输入框」开关',
  /id="icon_fill_enabled"/.test(translateHtml) && /for="icon_fill_enabled"/.test(translateHtml));
check('开关关闭时标题/说明改为复制',
  /iconPathTitle\.textContent = fill \? '点图标回填原文' : '点图标复制译文'/.test(translateUi)
  && /iconActionDesc\.textContent = fill/.test(translateUi));
check('默认值保持旧行为（填充开启）', /icon_fill_enabled: true/.test(translateSettings));
check('内容脚本按开关分流到填充/剪贴板',
  /settings\.icon_fill_enabled/.test(translateContent)
  && /writeClipboard\(reply\.text/.test(translateContent));
check('用户手册说明该开关', /点图标时填充输入框/.test(manual) && /只复制到剪贴板/.test(manual));

console.log('\n=== 6. 翻译快捷键与译文长度限制 ===');
const translateBg = readFileSync(
  join(ROOT, 'packages', 'extension', 'src', 'background', 'service-worker.ts'),
  'utf8',
);
check('manifest 翻译快捷键是 Ctrl+X',
  manifest.commands?.['translate-input']?.suggested_key?.default === 'Ctrl+X');
check('翻译面板有「译文长度限制」开关',
  /id="length_limit_enabled"/.test(translateHtml)
  && /for="length_limit_enabled"/.test(translateHtml));
check('长度限制默认开启且上限为 50',
  /length_limit_enabled: true/.test(translateSettings)
  && /TRANSLATION_MAX_CHARS = 50/.test(translateSettings));
check('后台按开关截断译文',
  /settings\.length_limit_enabled/.test(translateBg)
  && /slice\(0, TRANSLATION_MAX_CHARS\)/.test(translateBg));
check('用户手册写的是 Ctrl+X 与 50 字符',
  /Ctrl\+X/.test(manual) && /50 个字符/.test(manual));

const passed = results.filter(Boolean).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  results.forEach((ok, i) => { if (!ok) console.log(`  第 ${i + 1} 项失败`); });
  process.exit(1);
}
console.log('RESULT: OK');
