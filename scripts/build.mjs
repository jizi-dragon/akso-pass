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

/** 仅复制 UI 静态文件（html/css），不含源码 */
function copyUiStatics(from, to) {
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const out = path.join(to, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(out, { recursive: true });
      copyUiStatics(src, out);
    } else if (entry.endsWith('.html') || entry.endsWith('.css')) {
      copyFileSync(src, out);
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
    'ui/popup/popup': path.join(extDir, 'src', 'ui', 'popup', 'popup.ts'),
    'ui/parallel/parallel': path.join(extDir, 'src', 'ui', 'parallel', 'parallel.ts'),
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
