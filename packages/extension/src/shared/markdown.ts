/**
 * 导出 Markdown —— 手册的"轻量版"：喂给知识库 / Git 仓库 / 内部维基。
 *
 * ★ 图片不进 .md 本体（Markdown 没有内嵌二进制），而是并排打一个 assets.zip，
 *   文内用相对路径引用 `assets/step-01.png`。用户解压后 md 与 assets 同目录即可看。
 */
import type { ShotStepMeta } from './types';
import { createZip, type ZipEntry } from './zip';

export interface MarkdownStep {
  meta: ShotStepMeta;
  /** 图片文件名（`assets/step-01.png`），没有截图时省略 */
  imagePath?: string;
  imageBytes?: Uint8Array;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function stepFileName(index: number): string {
  return `step-${pad(index + 1)}.png`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function buildMarkdown(opts: { title: string; subtitle?: string; steps: MarkdownStep[] }): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title}`);
  lines.push('');
  if (opts.subtitle) {
    lines.push(`> ${opts.subtitle}`);
    lines.push('');
  }

  opts.steps.forEach((step, index) => {
    const { meta } = step;
    lines.push(`## ${index + 1}. ${meta.kind === 'click' ? '点击' : '输入'} · ${meta.label}`);
    lines.push('');
    lines.push(meta.caption);
    lines.push('');
    lines.push(`- 时间：${clock(meta.at)}`);
    lines.push(`- 页面：${meta.url}`);
    if (meta.value) lines.push(`- 内容：${meta.value}`);
    if (meta.selector) lines.push(`- 选择器：\`${meta.selector}\``);
    lines.push('');
    if (step.imagePath) {
      lines.push(`![步骤 ${index + 1}](${step.imagePath})`);
      lines.push('');
    }
  });

  if (opts.steps.length === 0) {
    lines.push('_这次录制没有记录到任何步骤。_');
    lines.push('');
  }

  return lines.join('\n');
}

/** 把各步图片打成一个 `assets.zip`（内含 `assets/step-01.png` 这样的路径）。 */
export function buildImageZip(steps: MarkdownStep[]): Blob | null {
  const entries: ZipEntry[] = [];
  steps.forEach((step, index) => {
    if (!step.imageBytes) return;
    entries.push({ name: `assets/${stepFileName(index)}`, data: step.imageBytes });
  });
  if (entries.length === 0) return null;
  return createZip(entries);
}
