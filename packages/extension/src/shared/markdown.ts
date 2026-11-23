/**
 * 导出 Markdown —— 手册的"轻量版"：喂给知识库 / Git 仓库 / 内部维基。
 *
 * ★ 版式与 Word 版**同构**（开头的录制信息 → 操作概览 → 操作步骤 → 附录）：
 *   两种导出读起来是同一份手册，读者不用重新学一遍结构。
 *
 * ★ 默认把截图以 data URI **内嵌**进 .md：用户只下载一个文件也能看图。
 *   早先的版本写 `![](assets/step-01.png)`、图片放在另一个 zip 里 ——
 *   用户只拿到 .md 时全是裂图，这就是"下载文档后图片无法加载"投诉的根因。
 *   需要独立图片文件的场合仍可用「导出图片包」（`buildImageZip`）。
 */
import type { ShotStepMeta } from './types';
import { createZip, type ZipEntry } from './zip';

export interface MarkdownStep {
  meta: ShotStepMeta;
  /** 图片文件名（`assets/step-01.png`），没有截图时省略 */
  imagePath?: string;
  imageBytes?: Uint8Array;
}

export interface MarkdownMeta {
  site?: string;
  startedAt?: number;
  endedAt?: number;
  stepCount?: number;
  imageCount?: number;
  tabCount?: number;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

export function stepFileName(index: number): string {
  return `step-${pad(index + 1)}.png`;
}

function timeText(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clock(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function durationText(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function actionText(meta: ShotStepMeta): string {
  return meta.kind === 'click' ? '点击' : '填写';
}

/** 页面标签：优先页面标题，退化为路径，再退化为主机名 */
function pageLabel(meta: ShotStepMeta): string {
  const title = meta.title?.trim();
  try {
    const u = new URL(meta.url);
    if (title) return title;
    return u.pathname === '/' ? u.host : u.pathname;
  } catch {
    return title || meta.url;
  }
}

/** 去掉 query/hash 的页面键：JS 路由改 query 不算换页 */
function pageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function buildMarkdown(opts: {
  title: string;
  subtitle?: string;
  meta?: MarkdownMeta;
  steps: MarkdownStep[];
  /** 把截图以 data URI 嵌入，下载单个 md 也不会丢图（默认开） */
  embedImages?: boolean;
}): string {
  const embed = opts.embedImages ?? true;
  const lines: string[] = [];
  lines.push(`# ${opts.title}`);
  lines.push('');
  if (opts.subtitle) {
    lines.push(`> ${opts.subtitle}`);
    lines.push('');
  }

  // ① 录制信息：先让人知道这是什么、什么时候录的、有多少步
  const meta = opts.meta;
  if (meta) {
    const rows: Array<[string, string]> = [];
    if (meta.site) rows.push(['录制站点', meta.site]);
    if (meta.startedAt) {
      const ended = meta.endedAt ? `（用时 ${durationText(meta.startedAt, meta.endedAt)}）` : '';
      rows.push(['录制时间', `${timeText(meta.startedAt)}${ended}`]);
    }
    rows.push(['步骤数', `${meta.stepCount ?? opts.steps.length} 步${meta.imageCount !== undefined ? `（其中 ${meta.imageCount} 步带截图）` : ''}`]);
    rows.push(['录制范围', meta.tabCount !== undefined && meta.tabCount > 1 ? `整个浏览器（${meta.tabCount} 个页签）` : '整个浏览器']);
    lines.push('| 项目 | 内容 |');
    lines.push('| --- | --- |');
    for (const [k, v] of rows) lines.push(`| ${cell(k)} | ${cell(v)} |`);
    lines.push('');
  }

  // ② 操作概览：先给地图
  if (opts.steps.length > 0) {
    lines.push('## 操作概览');
    lines.push('');
    lines.push('| # | 动作 | 目标 | 页面 |');
    lines.push('| --- | --- | --- | --- |');
    opts.steps.forEach((step, index) => {
      const { meta: m } = step;
      lines.push(`| ${index + 1} | ${actionText(m)} | ${cell(m.label)} | ${cell(pageLabel(m))} |`);
    });
    lines.push('');
    lines.push('## 操作步骤');
    lines.push('');
  }

  // ③ 操作步骤
  let lastPage = '';
  opts.steps.forEach((step, index) => {
    const { meta: m } = step;
    const number = index + 1;
    const key = pageKey(m.url);
    if (key !== lastPage) {
      lastPage = key;
      lines.push(`▸ **${pageLabel(m)}**　\`${shortUrl(m.url)}\``);
      lines.push('');
    }

    lines.push(`### 第 ${number} 步　${actionText(m)}「${m.label}」`);
    lines.push('');
    const caption = (m.caption || '').trim();
    if (caption) {
      lines.push(caption);
      lines.push('');
    }
    if (m.value) {
      lines.push(`> ${m.kind === 'click' ? '操作' : '填写'}：${m.value}`);
      lines.push('');
    }

    if (step.imageBytes) {
      const src = embed ? `data:image/png;base64,${bytesToBase64(step.imageBytes)}` : step.imagePath;
      if (src) {
        lines.push(`![图 ${number} · ${m.label}](${src})`);
        lines.push('');
      }
    } else {
      lines.push('_（这一步没有截图：录制时该页签不在前台，或还没授予截图权限）_');
      lines.push('');
    }

    lines.push(`<sub>记录时间 ${clock(m.at)}</sub>`);
    lines.push('');
  });

  if (opts.steps.length === 0) {
    lines.push('_这次录制没有记录到任何步骤。_');
    lines.push('');
  }

  // ④ 附录：选择器不进正文，避免打断阅读
  const withSelector = opts.steps.filter((s) => s.meta.selector);
  if (withSelector.length > 0) {
    lines.push('## 附录　元素定位与记录时间');
    lines.push('');
    lines.push('需要重新定位某个按钮、或按时间回查时用这张表。');
    lines.push('');
    lines.push('| # | 元素 | 选择器 | 时间 |');
    lines.push('| --- | --- | --- | --- |');
    opts.steps.forEach((step, index) => {
      const { meta: m } = step;
      lines.push(`| ${index + 1} | ${cell(m.label)} | \`${(m.selector || '—').replace(/`/g, "'")}\` | ${clock(m.at)} |`);
    });
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
