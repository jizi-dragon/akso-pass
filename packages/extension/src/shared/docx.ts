/**
 * 导出 Word（.docx）—— 不依赖任何 docx 库，直接拼最小 WordprocessingML。
 *
 * ★ 只用最小子集：段落 / 粗体 / 字号 / 图片（inline）/ 分页尺寸。
 *   手册的版式需求就这些；引入模板引擎只会让产物更难验证。
 * ★ 图片按「最大 6.2 英寸宽」等比缩放：A4 页宽 8.27in 减去左右各 1in 页边距 ≈ 6.27in，
 *   留一点余量，保证任何打印机都不会把图切掉。
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

const EMU_PER_PX = 9525;
/** 6.2in ≈ 5,669,280 EMU */
const MAX_IMAGE_EMU = 5_670_000;
/** A4 内容宽度（twips）：11906 - 左 1134 - 右 1134 = 9638 */
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;

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
}

function para(inner: string, opts: ParaOpts = {}): string {
  const pPr = [
    opts.align ? `<w:jc w:val="${opts.align}"/>` : '',
    `<w:spacing w:before="${opts.before ?? 0}" w:after="${opts.after ?? 120}"/>`,
  ].join('');
  return `<w:p><w:pPr>${pPr}</w:pPr>${inner}</w:p>`;
}

function imagePara(rId: string, id: number, cx: number, cy: number, name: string): string {
  return (
    '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="80" w:after="180"/></w:pPr><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${id}" name="Picture ${id}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="${id}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

function timeText(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function buildDocx(opts: { title: string; subtitle?: string; steps: DocxStep[] }): Blob {
  const body: string[] = [];
  const rels: string[] = [];
  const media: ZipEntry[] = [];
  let docPrId = 1;
  let relId = 100;

  body.push(para(run(opts.title, { bold: true, size: 36 }), { after: 80 }));
  if (opts.subtitle) {
    body.push(para(run(opts.subtitle, { size: 20, color: '6B7280' }), { after: 240 }));
  }

  opts.steps.forEach((step, index) => {
    const { meta, image } = step;
    const kindText = meta.kind === 'click' ? '点击' : '输入';
    body.push(para(run(`步骤 ${index + 1} · ${kindText}`, { bold: true, size: 26 }), { before: 200, after: 40 }));
    body.push(para(run(meta.caption, { size: 22 }), { after: 60 }));

    const facts = [`元素：${meta.label}`, `时间：${timeText(meta.at)}`, `页面：${meta.url}`];
    if (meta.value) facts.push(`内容：${meta.value}`);
    if (meta.selector) facts.push(`选择器：${meta.selector}`);
    for (const line of facts) {
      body.push(para(run(line, { size: 17, color: '6B7280' }), { after: 20 }));
    }

    if (image) {
      relId += 1;
      const fileName = `image${index + 1}.${image.ext}`;
      const rId = `rId${relId}`;
      rels.push(
        `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>`,
      );
      media.push({ name: `word/media/${fileName}`, data: image.bytes });

      const ratio = image.width > 0 ? image.height / image.width : 0.56;
      let cx = image.width * EMU_PER_PX;
      let cy = image.height * EMU_PER_PX;
      if (cx > MAX_IMAGE_EMU) {
        cy = Math.round(cy * (MAX_IMAGE_EMU / cx));
        cx = MAX_IMAGE_EMU;
      }
      if (cy === 0) cy = Math.round(cx * ratio);
      body.push(imagePara(rId, docPrId, cx, cy, fileName));
      docPrId += 1;
    } else {
      body.push(para(run('（这一步没有截图：录制时页签不在前台，或该站点未授权）', { size: 18, color: 'B91C1C', italic: true })));
    }
  });

  if (opts.steps.length === 0) body.push(para(run('这次录制没有记录到任何步骤。', { size: 22, color: '6B7280' })));

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/>` +
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
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  const documentRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    rels.join('') +
    '</Relationships>';

  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(rootRels) },
    { name: 'word/document.xml', data: encoder.encode(documentXml) },
    { name: 'word/_rels/document.xml.rels', data: encoder.encode(documentRels) },
    ...media,
  ];

  return new Blob([createZip(entries)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
