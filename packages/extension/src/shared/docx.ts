/**
 * 导出 Word（.docx）—— 不依赖任何 docx 库，直接拼最小 WordprocessingML。
 *
 * ★ 目标是「一份能读懂的操作手册」，不是「把截图堆进文档」：
 *   · 标题下先给一张**信息表**（站点 / 时间 / 步数 / 截图数 / 录制范围）；
 *   · 「操作概览」给出编号清单，让人先知道要做几步；
 *   · 每一步有**蓝色步号 + 粗体动作**、可读的说明、图片、图注，页面变了有分隔提示；
 *   · 选择器、元素、时间这些"查验用"的信息不进正文，全部收进**附录**表格；
 *   · 页脚有页码 —— 手册会被打印、被转发，没有页码就没法指着说"第 3 页那步"。
 *
 * ★ 图片**宽高都封顶**（宽 6.2in / 高 7.5in）：只封宽时，一张细长的全页截图
 *   会被放大到比纸还高，Word 只能裁掉一半 —— 而它不会报错（PITFALLS 的同类静默故障）。
 *
 * ★ 中文字体走 `docDefaults` 的 `eastAsia="Microsoft YaHei"`：
 *   Word 的默认西文字体渲不出中文的等宽感，整篇会"歪"。这段只写一次，段落/文字
 *   都不再各自指定字体（少一处漂移）。
 */
import type { ShotStepMeta } from './types';
import { createZip, type ZipEntry } from './zip';

export interface DocxImage {
  bytes: Uint8Array;
  ext: 'png' | 'jpeg';
  width: number;
  height: number;
}

export interface DocxStep {
  meta: ShotStepMeta;
  image?: DocxImage;
}

export interface DocxMeta {
  site?: string;
  startedAt?: number;
  endedAt?: number;
  stepCount?: number;
  imageCount?: number;
  tabCount?: number;
}

const EMU_PER_PX = 9525;
/** 6.2in ≈ 5,669,280 EMU：A4 内容宽 8.27in − 左右各 1in 页边距，再留一点余量 */
const MAX_IMAGE_W_EMU = 5_670_000;
/** 7.5in ≈ 6,858,000 EMU：A4 内容高 11.69in − 上下页边距 ≈ 9.6in，留出图注与呼吸空间 */
const MAX_IMAGE_H_EMU = 6_850_000;
/** A4（twips）与页边距 */
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;
/** A4 内容宽度（twips）：11906 − 1134 × 2 = 9638 */
const CONTENT_W = PAGE_W - MARGIN * 2;

const BRAND = '1E6FFF';
const INK = '111827';
const MUTED = '6B7280';
const FAINT = '9CA3AF';
const LINE = 'E4E7EC';

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface RunOpts {
  bold?: boolean;
  italic?: boolean;
  size?: number; // half-points
  color?: string;
}

function run(text: string, opts: RunOpts = {}): string {
  const rPr = [
    opts.bold ? '<w:b/>' : '',
    opts.italic ? '<w:i/>' : '',
    opts.color ? `<w:color w:val="${opts.color}"/>` : '',
    opts.size ? `<w:sz w:val="${opts.size}"/><w:szCs w:val="${opts.size}"/>` : '',
  ].join('');
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

interface ParaOpts {
  align?: 'left' | 'center' | 'right';
  before?: number;
  after?: number;
  /** 与下一段同页（标题后必须跟着正文/图片，否则会落单在页底） */
  keepNext?: boolean;
  /** 悬挂缩进（twips）：编号清单用它对齐 */
  hanging?: number;
}

function para(inner: string, opts: ParaOpts = {}): string {
  const pPr = [
    opts.keepNext ? '<w:keepNext/>' : '',
    opts.hanging ? `<w:ind w:left="${opts.hanging}" w:hanging="${opts.hanging}"/>` : '',
    opts.align ? `<w:jc w:val="${opts.align}"/>` : '',
    `<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 120}"/>`,
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${inner}</w:p>`;
}

/** 段落下边框：给章节标题一条细线，结构一眼可见 */
function heading(text: string, opts: { before?: number } = {}): string {
  return (
    `<w:p><w:pPr><w:keepNext/><w:spacing w:before="${opts.before ?? 360}" w:after="140"/>` +
    `<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="3" w:color="${LINE}"/></w:pBdr></w:pPr>` +
    `${run(text, { bold: true, size: 26, color: INK })}</w:p>`
  );
}

function pageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

function imagePara(rId: string, id: number, cx: number, cy: number, name: string): string {
  return (
    '<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/><w:spacing w:before="120" w:after="60"/></w:pPr><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}" descr="${esc(name)}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${esc(name)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    `<a:ln w="9525"><a:solidFill><a:srgbClr val="${LINE}"/></a:solidFill></a:ln>` +
    '</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

/* ------------------------------------------------------------------ 表格 */

interface CellOpts {
  width: number;
  fill?: string;
  bold?: boolean;
  size?: number;
  color?: string;
}

function cell(text: string, opts: CellOpts): string {
  const shade = opts.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${opts.fill}"/>` : '';
  return (
    '<w:tc><w:tcPr>' +
    `<w:tcW w:w="${opts.width}" w:type="dxa"/>${shade}<w:vAlign w:val="center"/>` +
    '</w:tcPr>' +
    para(run(text, { bold: opts.bold, size: opts.size ?? 19, color: opts.color }), { after: 0 }) +
    '</w:tc>'
  );
}

const CELL_MARGIN = '<w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/>' +
  '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>';

function borders(): string {
  const edge = (name: string): string => `<w:${name} w:val="single" w:sz="4" w:space="0" w:color="${LINE}"/>`;
  return `<w:tblBorders>${edge('top')}${edge('left')}${edge('bottom')}${edge('right')}${edge('insideH')}${edge('insideV')}</w:tblBorders>`;
}

function table(widths: number[], rows: string[][]): string {
  const grid = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const body = rows
    .map((cells) => `<w:tr>${cells.map((text, i) => cell(text, { width: widths[i] })).join('')}</w:tr>`)
    .join('');
  return (
    '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>` +
    borders() +
    '<w:tblLayout w:type="fixed"/>' +
    CELL_MARGIN +
    '</w:tblPr>' +
    `<w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`
  );
}

/* ------------------------------------------------------------------ 文本工具 */

function timeText(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function clockText(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function durationText(from: number, to: number): string {
  const total = Math.max(0, Math.round((to - from) / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function actionText(kind: 'click' | 'input'): string {
  return kind === 'click' ? '点击' : '输入';
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

/** 去掉 query/hash 的页面键：用它判断"是不是换页了"（JS 路由改 query 不算换页） */
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

/* ------------------------------------------------------------------ 样式表 */

function stylesXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="Microsoft YaHei" w:cs="Segoe UI"/>' +
    '<w:sz w:val="21"/><w:szCs w:val="21"/><w:color w:val="1F2937"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    '</w:styles>'
  );
}

function footerXml(): string {
  const rpr = `<w:rPr><w:sz w:val="16"/><w:color w:val="${FAINT}"/></w:rPr>`;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr>' +
    `<w:r>${rpr}<w:t xml:space="preserve">第 </w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    `<w:r>${rpr}<w:t>1</w:t></w:r>` +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>' +
    `<w:r>${rpr}<w:t xml:space="preserve"> 页</w:t></w:r>` +
    '</w:p></w:ftr>'
  );
}

/* ------------------------------------------------------------------ 主体 */

export function buildDocx(opts: { title: string; subtitle?: string; meta?: DocxMeta; steps: DocxStep[] }): Blob {
  const body: string[] = [];
  const rels: string[] = [];
  const media: ZipEntry[] = [];
  let docPrId = 1;
  let relId = 100;

  // ① 标题 + 一行元信息
  body.push(para(run(opts.title, { bold: true, size: 44, color: INK }), { after: 60 }));
  if (opts.subtitle) body.push(para(run(opts.subtitle, { size: 18, color: MUTED }), { after: 240 }));

  // ② 信息表：先让人知道"这是什么、什么时候录的、有多少步"
  const meta = opts.meta;
  if (meta) {
    const rows: string[][] = [];
    if (meta.site) rows.push(['录制站点', meta.site]);
    if (meta.startedAt) {
      const ended = meta.endedAt ? `　（用时 ${durationText(meta.startedAt, meta.endedAt)}）` : '';
      rows.push(['录制时间', `${timeText(meta.startedAt)}${ended}`]);
    }
    rows.push(['步骤数', `${meta.stepCount ?? opts.steps.length} 步${meta.imageCount !== undefined ? `（其中 ${meta.imageCount} 步带截图）` : ''}`]);
    rows.push(['录制范围', meta.tabCount !== undefined && meta.tabCount > 1 ? `整个浏览器（${meta.tabCount} 个页签）` : '整个浏览器']);
    if (rows.length > 0) {
      const tableXml = table([1800, CONTENT_W - 1800], rows).replace(
        /<w:tr>/g,
        `<w:tr><w:trPr><w:cantSplit/></w:trPr>`,
      );
      body.push(tableXml);
      body.push(para('', { after: 0 }));
    }
  }

  // ③ 操作概览：编号清单，先给"地图"
  if (opts.steps.length > 0) {
    body.push(heading('操作概览', { before: 280 }));
    opts.steps.forEach((step, index) => {
      const { meta: m } = step;
      const inner =
        run(`${index + 1}.`, { bold: true, color: MUTED, size: 20 }) +
        run(`  ${actionText(m.kind)}「${m.label}」`, { size: 21, color: INK }) +
        run(`　${pageLabel(m)}`, { size: 18, color: FAINT });
      body.push(para(inner, { after: 40, hanging: 440 }));
    });
  } else {
    body.push(para(run('这次录制没有记录到任何步骤。', { size: 21, color: MUTED }), { before: 240 }));
  }

  // ④ 操作步骤
  if (opts.steps.length > 0) {
    body.push(heading('操作步骤'));
    let lastPage = '';
    const selectorRows: string[][] = [['步骤', '元素', '选择器', '记录时间']];

    opts.steps.forEach((step, index) => {
      const { meta: m, image } = step;
      const number = index + 1;

      // 换页提示：录制范围是整个浏览器，读者需要知道"现在跳到哪个页面了"
      const key = pageKey(m.url);
      if (key !== lastPage) {
        lastPage = key;
        body.push(
          para(
            run('▸ ', { color: FAINT, size: 19 }) +
              run(pageLabel(m), { bold: true, size: 19, color: MUTED }) +
              run(`　${shortUrl(m.url)}`, { size: 17, color: FAINT }),
            { before: index === 0 ? 160 : 320, after: 60, keepNext: true },
          ),
        );
      }

      // 步号 + 动作（两段式：蓝号在前，动作加粗）
      body.push(
        para(
          run(`第 ${number} 步`, { bold: true, size: 20, color: BRAND }) +
            run(`　${actionText(m.kind)}「${m.label}」`, { bold: true, size: 26, color: INK }),
          { before: 240, after: 60, keepNext: true, hanging: 0 },
        ),
      );

      const caption = (m.caption || '').trim();
      if (caption) body.push(para(run(caption, { size: 21 }), { after: 60 }));

      if (image) {
        relId += 1;
        const fileName = `image${number}.${image.ext}`;
        const rId = `rId${relId}`;
        rels.push(
          `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`,
        );
        media.push({ name: `word/media/${fileName}`, data: image.bytes });

        const ratio = image.width > 0 ? image.height / image.width : 0.56;
        let cx = Math.max(1, image.width) * EMU_PER_PX;
        let cy = Math.max(1, image.height) * EMU_PER_PX;
        if (cy <= 0) cy = Math.round(cx * ratio);
        const scale = Math.min(1, MAX_IMAGE_W_EMU / cx, MAX_IMAGE_H_EMU / cy);
        cx = Math.round(cx * scale);
        cy = Math.round(cy * scale);
        body.push(imagePara(rId, docPrId, cx, cy, fileName));
        docPrId += 1;
        body.push(
          para(run(`图 ${number}　${pageLabel(m)}`, { size: 17, color: MUTED }), {
            align: 'center',
            before: 0,
            after: 160,
          }),
        );
      } else {
        body.push(
          para(run('（这一步没有截图：录制时该页签不在前台，或还没授予截图权限）', {
            size: 18,
            color: 'B45309',
            italic: true,
          }), { after: 160 }),
        );
      }

      selectorRows.push([String(number), m.label, m.selector || '—', clockText(m.at)]);
    });

    // ⑤ 附录：把查验用的信息挪出正文，正文才读得下去
    if (selectorRows.length > 1) {
      body.push(pageBreak());
      body.push(heading('附录　元素定位与记录时间', { before: 0 }));
      body.push(
        para(
          run('需要重新定位某个按钮、或按时间回查时用这张表。正文里不出现选择器，避免打断阅读。', {
            size: 18,
            color: MUTED,
          }),
          { after: 160 },
        ),
      );
      const widths = [760, 2300, 5000, 1578];
      const tableXml = table(widths, selectorRows).replace(/<w:tr>/g, '<w:tr><w:trPr><w:cantSplit/></w:trPr>');
      body.push(tableXml);
    }
  }

  /* ---- 打包 ---- */

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body.join('')}` +
    '<w:sectPr>' +
    '<w:footerReference w:type="default" r:id="rIdFooter"/>' +
    `<w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>` +
    `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="851" w:footer="992" w:gutter="0"/>` +
    '</w:sectPr></w:body></w:document>';

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' +
    '<Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    rels.join('') +
    '</Relationships>';

  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rootRels) },
    { name: 'word/document.xml', data: encoder.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(documentRels) },
    { name: 'word/styles.xml', data: encoder.encode(stylesXml()) },
    { name: 'word/footer1.xml', data: encoder.encode(footerXml()) },
    ...media,
  ];

  return new Blob([createZip(entries)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
