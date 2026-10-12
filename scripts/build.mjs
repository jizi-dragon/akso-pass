import { build, context as createContext } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const extDir = path.join(root, 'packages', 'extension');
const watch = process.argv.includes('--watch');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/**
 * ★★ 从 `ui/wheel/grid-style.ts` 生成 `ui/wheel/acct-grid.css`。
 *
 * 为什么要有这一步：网格样式必须给**四个表面**用，而它们的注入方式不同 ——
 * 小窗用 `<link>`（要一个 `.css` 文件），三个页内浮层在 **Shadow DOM** 里
 * **只能内联**（拿不到扩展的 `<link>`）。
 *
 * ⇒ 如果各写一份，就是"同一段 CSS 两份维护"，而**漏一条就少一块样式且不报错**。
 *   所以把 `grid-style.ts` 定为**唯一源**，这里把它写成 `.css` 供 `<link>` 引用；
 *   浮层直接 `import` 同一个字符串 ⇒ **同一份字节，不可能漂移**。
 *
 * ★ 必须在 `copyUiStatics` **之前**跑：否则刚写的 `.css` 不会进 `dist/`。
 * ★ 用 `esbuild` 转译而不是正则抠字符串：后者在源码形状一变就**静默错**
 *   （本仓规则 31「产物对不能推出源对」的镜像）。
 */
async function generateGridCss() {
  const srcFile = path.join(extDir, 'src', 'ui', 'wheel', 'grid-style.ts');
  const outFile = path.join(extDir, 'src', 'ui', 'wheel', 'acct-grid.css');
  const out = await build({
    entryPoints: [srcFile],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false,
    logLevel: 'silent',
  });
  const js = out.outputFiles[0].text;
  // 求值取常量（bundle 后无外部 import，可直接当模块跑）
  const modUrl = `data:text/javascript;base64,${Buffer.from(js, 'utf8').toString('base64')}`;
  const mod = await import(modUrl);
  if (typeof mod.ACCT_GRID_CSS !== 'string' || !mod.ACCT_GRID_CSS.includes('.ag-grid')) {
    throw new Error('grid-style.ts 没有导出可用的 ACCT_GRID_CSS —— 生成中止（不要写出半个样式表）');
  }
  writeFileSync(outFile, mod.ACCT_GRID_CSS, 'utf8');
  return outFile;
}

/** 仅复制 UI 静态文件（html/css），不含源码
 *
 * ★★ v4.2.0 修：**先把目标目录建出来**，不要依赖"第一个条目恰好是目录"。
 *
 *   原实现只在遇到**子目录**时才 `mkdirSync(out)`，根层同名文件直接 `copyFileSync`
 *   ⇒ 它隐含依赖"`readdirSync` 的第一个条目是目录"。这个前提一直成立，
 *   直到 v4.2.0 在 `src/ui/` **根层**新增了 `panel.css`（与 `parallel/` 同级）：
 *   字母序 `panel.css` < `parallel` ⇒ 先拷文件、而 `dist/ui` 还不存在 ⇒
 *   `ENOENT ... copyfile panel.css`，**构建整体失败**。
 *
 *   ⇒ 现在无条件 `mkdirSync(to, { recursive: true })`。这条判据是
 *     "把 `src/ui/` 根层的第一个条目换成一个文件，构建仍必须成功"。
 */
function copyUiStatics(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const out = path.join(to, entry);
    if (statSync(src).isDirectory()) {
      copyUiStatics(src, out);
    } else if (entry.endsWith('.html') || entry.endsWith('.css')) {
      copyFileSync(src, out);
    }
  }
}

/**
 * 复制 `src/content/` 下的 **css**（内容脚本的样式表）。
 *
 * ★★ v4.2.0 补：此前**根本没有这一步** —— `copyExtensionStatics()` 只拷 `assets/`
 *   与 `ui/`，而 `content_scripts[].css` 指向的 `content/translate.css` 因此**从未进包**。
 *   直到 v4.2.0 才由 `content_scripts` 引用 css 条目，这个缺口才第一次暴露。
 *
 *   ⇒ 缺口的表现是 Chrome 装载时报"找不到文件"，属**运行期才发现**的一类
 *     （与规则 35「manifest 合法 ≠ Chrome 装得上」同族）。
 *     判据：`dist/` 里必须存在 `manifest.content_scripts[].css` 的**每一个**文件。
 *
 * ★ 只拷 `.css`：`.ts` 是源文件（由 esbuild 打包成 `content/*.js`），拷进去等于把源码
 *   发给用户（`copyExtensionStatics` 里 `logo-master-422.png` 那条同类处置）。
 */
function copyContentStatics() {
  const from = path.join(extDir, 'src', 'content');
  const to = path.join(dist, 'content');
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    if (entry.endsWith('.css')) {
      copyFileSync(path.join(from, entry), path.join(to, entry));
    }
  }
}

function copyExtensionStatics() {
  // ★★ **不是** `cpSync(assets → dist/assets, recursive)`。
  //
  // 那条 recursive 拷贝会把 `assets/` 下的**一切**带进包里 ——
  // 包括 `logo-master-422.png`（**11.1 KB 的源文件**，图标派生链的起点）。
  // 实测（2026-10-09）：`dist` 共 24 个文件 / 392.8 KB，而它是**唯一一个
  // manifest 没引用的**。⇒ **源文件不该发给用户。**
  //
  // ★ 与 `copyUiStatics` 同一条原则：**只拷运行期真正要用的**。
  //   `assets/` 是"源 + 产物"混放（`logo-master-422.png` 是源、`Icon*.png` 是产物），
  //   所以这里**按文件名白名单**挑，而不是整目录递归。
  mkdirSync(path.join(dist, 'assets'), { recursive: true });
  for (const n of [16, 32, 48, 128]) {
    copyFileSync(path.join(root, 'assets', `Icon${n}.png`),
                 path.join(dist, 'assets', `Icon${n}.png`));
  }
  copyFileSync(path.join(extDir, 'manifest.json'), path.join(dist, 'manifest.json'));
  copyUiStatics(path.join(extDir, 'src', 'ui'), path.join(dist, 'ui'));
  copyContentStatics();
}

const extensionOptions = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  outbase: path.join(extDir, 'src'),
  outdir: dist,
  logLevel: 'info',
  entryPoints: {
    'background': path.join(extDir, 'src', 'background', 'service-worker.ts'),
    'content/shield-bridge': path.join(extDir, 'src', 'content', 'shield-bridge.ts'),
    'content/shield-main': path.join(extDir, 'src', 'content', 'shield-main.ts'),
    'content/title-hook': path.join(extDir, 'src', 'content', 'title-hook.ts'),
    'content/auto-login': path.join(extDir, 'src', 'content', 'auto-login.ts'),
    'content/wheel-overlay': path.join(extDir, 'src', 'content', 'wheel-overlay.ts'),
    'content/status-overlay': path.join(extDir, 'src', 'content', 'status-overlay.ts'),
    'content/favorites-overlay': path.join(extDir, 'src', 'content', 'favorites-overlay.ts'),
    // v4.2.0：翻译（合并 Akso Instant Translate）—— 浮动图标 + Alt+T
    'content/translate': path.join(extDir, 'src', 'content', 'translate.ts'),
    'ui/popup/popup': path.join(extDir, 'src', 'ui', 'popup', 'popup.ts'),
    'ui/parallel/parallel': path.join(extDir, 'src', 'ui', 'parallel', 'parallel.ts'),
    // v4.2.0：翻译面板（侧栏导航的第二个页面）
    'ui/translate/translate': path.join(extDir, 'src', 'ui', 'translate', 'translate.ts'),
    'ui/wheel/wheel': path.join(extDir, 'src', 'ui', 'wheel', 'wheel.ts'),
  },
};

// ★ 顺序要紧：先生成 acct-grid.css，再 copyExtensionStatics() 把 ui/ 下的
//   html/css 拷进 dist/ —— 反过来的话，这次生成的 .css 要等下一次构建才进包。
const generatedCss = await generateGridCss();
copyExtensionStatics();
if (watch) {
  const ctx = await createContext(extensionOptions);
  ctx.watch();
}
await build(extensionOptions);
console.log(`BUILD_OK → dist/（已从 grid-style.ts 生成 ${path.basename(generatedCss)}）`);
