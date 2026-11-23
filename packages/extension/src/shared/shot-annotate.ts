/**
 * 截图标注（纯画布逻辑，不碰 chrome.* 与 IDB）。
 *
 * ★ 单独立一个文件的原因有两个：
 *   ① 可被离线预览脚本单独加载着色 —— 标注观感是本功能的"结果面"，必须能截图自检
 *      （`tools/verify/verify-shot-frame.mjs` 就是这么用的）；
 *   ② 后台 SW 与预览器共用**同一份**绘制代码，避免"预览好看、真截图难看"。
 *
 * ★ 只画框，不压暗、不填充、不改任何像素：手册截图要保留页面上下文，
 *   读者得能看出这一步在哪个界面里。v4.6.0 及以前用四块半透明矩形做聚光灯，
 *   用户反馈"除了框选区域全黑糊糊的"，已删除。
 */
import type { ShotEventPayload } from './types';

const FRAME_COLOR = '#F43F5E';
const HALO_COLOR = 'rgba(255, 255, 255, 0.95)';

function roundRectPath(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 在 `outW × outH` 的截图上，按视口坐标 `p` 画出目标元素的框。
 *
 * 两层描边：白色宽晕（深色/彩色页面上也看得见）+ 玫瑰红主线。
 * 线宽随图宽自适应（`outW / 520`，下限 2px）：1600px 宽的长图与 400px 的缩略图
 * 用同一条线宽，观感会差很多。
 */
export function drawFrame(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  p: Pick<ShotEventPayload, 'x' | 'y' | 'w' | 'h' | 'vw' | 'vh'>,
  outW: number,
  outH: number,
): void {
  const sx = outW / Math.max(1, p.vw);
  const sy = outH / Math.max(1, p.vh);
  const pad = 4;
  const w = Math.max(16, p.w) + pad * 2;
  const h = Math.max(16, p.h) + pad * 2;
  const x = Math.min(Math.max(0, (p.x - pad) * sx), Math.max(0, outW - 8));
  const y = Math.min(Math.max(0, (p.y - pad) * sy), Math.max(0, outH - 8));
  const rw = Math.min(w * sx, Math.max(1, outW - x));
  const rh = Math.min(h * sy, Math.max(1, outH - y));
  if (rw < 4 || rh < 4) return;

  const lw = Math.max(2, Math.round(outW / 520));
  const radius = Math.min(8, rw / 2, rh / 2);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = HALO_COLOR;
  ctx.lineWidth = lw * 2;
  roundRectPath(ctx, x, y, rw, rh, radius);
  ctx.stroke();
  ctx.strokeStyle = FRAME_COLOR;
  ctx.lineWidth = lw;
  roundRectPath(ctx, x, y, rw, rh, radius);
  ctx.stroke();
  ctx.restore();
}
