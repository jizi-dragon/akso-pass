/**
 * 翻译长度限制的**行为判据**（不启动浏览器）：esbuild 把纯函数打包后直接断言。
 *
 * 用户要求：不能硬切，至少保留完整单词 / 单词缩写，且结果 ≤ 上限。
 * 运行：node tools/verify/verify-translate-limit.mjs
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const SOURCE = join(ROOT, 'packages', 'extension', 'src', 'shared', 'translate-limit.ts');
const LIMIT = 50;

const built = await build({
  entryPoints: [SOURCE],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
});
const code = built.outputFiles[0].text;
const module = { exports: {} };
new Function('module', 'exports', code)(module, module.exports);
const { limitTranslation } = module.exports;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

function assertLimit(text, limit = LIMIT) {
  const out = limitTranslation(text, limit);
  check(`长度 ≤ ${limit}`, Array.from(out).length <= limit, `actual=${Array.from(out).length}`);
  return out;
}

const sentence = 'This is a complete first sentence. This second sentence is deliberately much longer than fifty characters.';
const s = assertLimit(sentence);
check('优先保留完整句子（以句号结束）', s.endsWith('.'), s);
check('完整句子没有被再切', s === 'This is a complete first sentence.', s);

const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu';
const w = assertLimit(words);
check('英文长句在词边界加省略号', w.endsWith('…'), w);
const lastWord = w.slice(0, -1).trim().split(/\s+/).pop() ?? '';
check('省略号前是完整单词', words.split(/\s+/).includes(lastWord), lastWord);

const chinese = '这是一个很长的中文句子，用来测试长度限制是否会在完整词语边界截断，而不是硬切。';
const c = assertLimit(chinese, 20);
check('中文也在词语边界截断', c.endsWith('…'), c);

const snake = 'very_long_field_name_with_many_segments';
const sn = assertLimit(snake, 20);
check('snake_case 不切在半个片段', sn.endsWith('…') && !sn.slice(0, -1).endsWith('_'), sn);

const exact = '1234567890';
check('未超限原样返回', limitTranslation(exact, 10) === exact, limitTranslation(exact, 10));
check('关闭限制由调用方控制（纯函数不截断短文本）', limitTranslation('short') === 'short');

const passed = results.filter((r) => r.ok).length;
console.log(`\n=== 汇总：${passed}/${results.length} 通过 ===`);
if (passed !== results.length) {
  process.exit(1);
}
console.log('RESULT: OK');
