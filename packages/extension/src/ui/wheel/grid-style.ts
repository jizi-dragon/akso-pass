/**
 * **定尺网格的唯一样式来源**（v4.1.2）。
 *
 * ## 为什么把 CSS 放进 TypeScript 里
 *
 * 网格要被**四处**渲染，而它们的样式注入方式**天然不同**：
 *
 * | 表面 | 注入方式 | 为什么 |
 * |---|---|---|
 * | 小窗（`wheel.html`） | `<link>` 一份 `.css` | 扩展自有页面，直接引文件最省 |
 * | 三个页内浮层（`*-overlay.ts`） | **必须内联进 Shadow DOM** | 浮层在**宿主页**里，拿不到扩展的 `<link>` |
 *
 * ⇒ 如果各写一份，就是"同一段 CSS 两份维护"，而**漏一条就少一块样式**、
 * 且**不报错**（v4.1.1 的判据里那条"两份类名集合必须一致"就是为此而设，
 * 但那只是**事后对账**，不是解决）。
 *
 * ⇒ 现在改成：**本文件是唯一源**，`scripts/build.mjs` 在构建时把它写成
 * `src/ui/wheel/acct-grid.css`（供 `<link>` 引用），浮层直接 `import` 这个字符串。
 * **同一个文件、同一份字节**，不可能漂移；判据 `verify-acct-grid` 再对账一次。
 *
 * ★ 与规则 12（文档只有一个权威源）同一个道理：**同一事实不要写两遍**，
 *   能生成就生成。
 */
export const ACCT_GRID_CSS = `/* ⚠️ 本文件由 scripts/build.mjs 从 ui/wheel/grid-style.ts 生成 —— 不要手改。
   改样式请改 grid-style.ts（那是唯一源），然后 npm run build。 */

.acct-grid { width: 100%; }

/* ---- 入场（调用方给根元素加 .in）---- */
.ag-wrap {
  display: flex; flex-direction: column; gap: var(--sp-2, 8px);
  opacity: 0; transform: translateY(10px) scale(0.985);
  transition: opacity 0.22s ease, transform 0.28s cubic-bezier(0.22, 1.2, 0.36, 1);
}
.acct-grid.in .ag-wrap { opacity: 1; transform: none; }

/* ---- 标题栏 ---- */
.ag-head { display: flex; align-items: center; gap: var(--sp-2, 8px); padding: 0 var(--sp-0, 2px); }
.ag-nav {
  flex: none; width: 30px; height: 30px; border-radius: var(--sb-radius-sm, 8px);
  border: 1px solid #e4eaf6; background: #fff; color: #4a5a7d;
  font-size: var(--fs-18, 18px); line-height: 1; cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease, background 0.15s ease;
}
.ag-nav:hover { border-color: var(--acc, #1e6fff); color: var(--acc, #1e6fff); background: #f5f9ff; }
.ag-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: var(--sp-2, 8px); }
.ag-box {
  font-size: var(--fs-15, 15px); font-weight: 700; color: #1b2a4a; letter-spacing: 0.02em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.ag-meta { flex: none; font-size: var(--fs-12, 12px); color: #66759b; font-variant-numeric: tabular-nums; }

/* ---- 定尺网格：5 列 × 4 行 = 20 格 ----
   列宽随容器均分、**行高固定** ⇒ 名字长短不影响格高。
   overflow-y:auto 是**安全网**（>20 项时滚动，绝不裁掉），不是设计。 */
.ag-grid {
  display: grid;
  grid-template-columns: repeat(var(--ag-cols, 5), minmax(0, 1fr));
  grid-auto-rows: 74px;
  gap: var(--sp-2, 8px);
  max-height: 66vh;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--sp-0, 2px);
}

.ag-cell {
  position: relative; display: flex; flex-direction: column; justify-content: center;
  align-items: flex-start; gap: var(--sp-1, 4px); padding: var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-2, 8px) var(--sp-3, 12px);
  border: 1px solid #e8eef8; border-radius: var(--sb-radius, 12px); background: #fff;
  text-align: left; cursor: pointer; font: inherit; overflow: hidden;
  transition: border-color 0.15s ease, transform 0.15s ease, box-shadow 0.15s ease;
}
.ag-cell::before {
  content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px;
  background: var(--acct, #1e6fff);
}
.ag-cell:hover { border-color: var(--acct, #1e6fff); transform: translateY(-1px); box-shadow: 0 4px 14px rgba(23, 42, 84, 0.1); }
.ag-cell:focus-visible { outline: 2px solid var(--acc, #1e6fff); outline-offset: 1px; }

/* 当前项（状态轮盘用）：品牌色描边 + 轻底色，一眼看出"现在是哪个" */
.ag-cell-current { border-color: var(--acc, #1e6fff); background: #f5f9ff; }
.ag-cell-current::after {
  content: ''; position: absolute; right: 8px; top: 8px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--acc, #1e6fff);
}
/* 不可点（如账号未授权）：降对比、去掉 hover 位移 */
.ag-cell-disabled { opacity: 0.6; cursor: not-allowed; }
.ag-cell-disabled:hover { border-color: #e8eef8; transform: none; box-shadow: none; }

/* ---- 占位格：项数不足 20 时补齐，让几何恒定 ---- */
.ag-slot { border: 1px dashed #e6ecf6; border-radius: var(--sb-radius, 12px); background: #fbfdff; }

.ag-name {
  max-width: 100%; font-size: var(--fs-13, 13px); font-weight: 650; color: #1b2a4a; letter-spacing: 0.01em;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.ag-status { font-size: var(--fs-11, 11px); letter-spacing: 0.02em; white-space: nowrap; }
.ag-status.on { color: #16a34a; }
.ag-status.on::before { content: '●'; margin-right: var(--sp-1, 4px); font-size: var(--fs-11, 11px); vertical-align: 1px; }
.ag-status.wait { color: #b26a00; }
.ag-status.idle { color: #94a3b8; }
.ag-status.off { color: #dc2626; }

.ag-key {
  position: absolute; right: 7px; bottom: 7px; min-width: 15px; padding: 0 var(--sp-1, 4px);
  border-radius: var(--sb-radius-sm, 8px); border: 1px solid #e4eaf6; background: #fafcff; color: #8494b4;
  font-size: var(--fs-11, 11px); font-weight: 700; line-height: 15px; text-align: center;
  font-variant-numeric: tabular-nums; pointer-events: none;
}
.ag-cell:hover .ag-key { border-color: var(--acct, #1e6fff); color: var(--acct, #1e6fff); }
/* 当前项右上角已有圆点 ⇒ 角标让位，避免两个标记打架 */
.ag-cell-current .ag-key { right: 8px; bottom: 8px; }

/* ---- 空态 ---- */
.ag-empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2, 8px); padding: var(--sp-9, 48px) var(--sp-4, 16px) var(--sp-8, 40px); }
.ag-empty-t { font-size: var(--fs-13, 13px); font-weight: 600; color: #4a5a7d; }
.ag-empty-s { font-size: var(--fs-12, 12px); color: #8494b4; }
.ag-empty-btn {
  padding: var(--sp-2, 8px) var(--sp-5, 20px); border: 0; border-radius: var(--sb-radius, 12px); background: var(--acc, #1e6fff);
  color: #fff; font: inherit; font-size: var(--fs-13, 13px); font-weight: 600; cursor: pointer;
}
.ag-empty-btn:hover { filter: brightness(0.94); }

/* ---- 页脚：页码点 + 提示 ---- */
.ag-foot { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2, 8px); min-height: 16px; padding: 0 var(--sp-0, 2px); }
.ag-dots { display: flex; align-items: center; gap: var(--sp-1, 4px); }
.ag-dot {
  width: 7px; height: 7px; padding: 0; border: 0; border-radius: 50%;
  background: #cfd9ea; cursor: pointer;
  transition: background 0.15s ease, transform 0.15s ease;
}
.ag-dot.on { background: var(--acc, #1e6fff); transform: scale(1.35); }
.ag-tip { margin-left: auto; font-size: var(--fs-11, 11px); color: #8494b4; letter-spacing: 0.02em; }
`;

/**
 * 页内浮层的**外壳**样式（`:host` 遮罩 + 提示条 + toast）。
 * ★ 网格样式由 `ACCT_GRID_CSS` 提供，两者一起注入 Shadow DOM。
 */
export const OVERLAY_CHROME_CSS = `
    :host { all: initial; }
    * { margin:0; padding:0; box-sizing:border-box;
        font-family: system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; }
    :host {
      position:fixed; inset:0; z-index:2147483646;
      display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--sp-4, 16px);
      background:rgba(241,245,252,.66);
      backdrop-filter:blur(10px) saturate(1.15);
      opacity:0; transition:opacity .18s ease;
    }
    :host(.show){opacity:1}

    .wheel-root{
      width:min(92vw,700px);
      transform:scale(.9) translateY(10px);
      transition:transform .28s cubic-bezier(.22,1.3,.36,1), opacity .18s ease;
    }
    :host(.show) .wheel-root{transform:none}
    .wheel-root:not(.in){opacity:.35;transform:scale(.985)}

    .hint{
      display:flex; align-items:center; gap:var(--sp-2, 8px);
      font-size: var(--fs-12, 12px); color:#5b6b8f; letter-spacing:.05em;
      background:rgba(255,255,255,.82); border:1px solid rgba(228,234,246,.9);
      padding:var(--sp-2, 8px) var(--sp-3, 12px); border-radius:var(--sb-radius-pill, 999px);
      box-shadow:0 2px 10px rgba(23,42,84,.06);
      opacity:0; transform:translateY(6px);
      transition:opacity .3s ease .25s, transform .3s ease .25s;
    }
    :host(.show) .hint{opacity:1;transform:none}
    .hint i{width:3px;height:3px;border-radius:50%;background:#c3cede}
    .hint b{font-weight:700;color:#1b2a4a}
    .hint kbd{display:inline-block;min-width:15px;padding:var(--sp-hair, 1px) var(--sp-2, 8px);border-radius: var(--sb-radius-sm, 8px);
      border:1px solid #d4ddf0;border-bottom-width:2px;background:#fff;color:#5b6b8f;
      font-family:inherit;font-size: var(--fs-11, 11px);text-align:center}

    .toast{
      position:fixed; left:50%; bottom:26px; transform:translate(-50%,10px);
      max-width:70vw; padding:var(--sp-2, 8px) var(--sp-4, 16px); border-radius: var(--sb-radius, 12px); font-size: var(--fs-13, 13px); font-weight:600;
      background:#1b2a4a; color:#fff; box-shadow:0 8px 26px rgba(23,42,84,.28);
      opacity:0; pointer-events:none; transition:opacity .2s ease, transform .2s ease;
    }
    .toast.show{opacity:1;transform:translate(-50%,0)}
    .toast.ok{background:#137a3b}
    .toast.err{background:#b91c1c}
`;
