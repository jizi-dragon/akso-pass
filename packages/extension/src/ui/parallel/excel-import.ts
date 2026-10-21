/**
 * Excel / CSV 账号批量导入：**解析 + 校验**（不碰 DOM、不碰 chrome）。
 *
 * 用户 2026-10-21 的要求：
 *   新建环境时先建站点、再慢慢建账号太麻烦；用一张表填好，扩展直接创建。
 *   有问题的数据行必须标红并写明原因。
 *
 * ## 表头只有五项，而且全部必填
 *
 * | 表头 | 说明 |
 * |---|---|
 * | 站点名称 | 站点不存在时用这个名字创建；**同时作为盒子名** |
 * | 站点地址 | 可带 `http://` / `https://`；新站点按它创建 |
 * | 用户名 | 同站点下唯一 |
 * | 密码 | 必填；留空会被标红 |
 * | 页签名 | 必填 |
 *
 * ## 盒子口径（用户 2026-10-21 第二轮修正）
 *
 * **不提供「盒子」列。** 每个站点自动使用**站点名称**作为盒子名：
 *   1. 站点不存在 ⇒ 建站点；2. 盒子不存在 ⇒ 建同名盒子；
 *   3. 把盒子关联到该站点；4. 该站点下所有账号都放进这个盒子。
 * 盒子名受服务端 60 字符上限约束，所以站点名称也限制 60。
 *
 * ## 为什么解析放在 UI 侧、创建仍走消息层
 *
 * `xlsx` 是纯前端库，放进 UI bundle 即可；而**创建**必须经过 background 的
 * `par.upsertSite` / `par.createBox` / `par.bindBoxSite` / `par.create`
 * （云端会话、缓存失效、盒子对账都在那一层）。
 */
import * as XLSX from 'xlsx';
import type { CloudSiteSummary, ParallelAccount } from '../../shared/types';

export const EXCEL_TEMPLATE_FILENAME = 'Akso-Pass-账号导入模板.xlsx';
export const MAX_EXCEL_BYTES = 8 * 1024 * 1024;
export const MAX_EXCEL_ROWS = 1000;
/** 服务端 `box.name` 与 `site.name` 的实际上限；盒子名 = 站点名，所以两者都卡 60 */
export const MAX_SITE_NAME = 60;

type CanonicalHeader = 'siteName' | 'siteAddress' | 'username' | 'password' | 'tabName';

const HEADER_ALIASES: Record<CanonicalHeader, string[]> = {
  siteName: ['站点名称', '站点名', '站点', 'siteName', 'site_name', 'site'],
  siteAddress: ['站点地址', '站点网址', '站点URL', '地址', 'siteAddress', 'site_url', 'baseUrl', 'url', 'host'],
  username: ['用户名', '账号名', '账号', 'username', 'user', '登录名', 'login'],
  password: ['密码', '口令', 'password', 'pass'],
  tabName: ['页签名', '标签页名称', '页签', 'tabName', 'tab', 'title'],
};

const CANONICAL_ORDER: CanonicalHeader[] = ['siteName', 'siteAddress', 'username', 'password', 'tabName'];

const HEADER_LABEL: Record<CanonicalHeader, string> = {
  siteName: '站点名称',
  siteAddress: '站点地址',
  username: '用户名',
  password: '密码',
  tabName: '页签名',
};

const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i;

export interface RawExcelRow {
  /** Excel 里的 1-based 行号（含表头），用于错误定位 */
  rowNumber: number;
  siteName: string;
  siteAddress: string;
  username: string;
  password: string;
  tabName: string;
}

export interface ParsedExcel {
  rows: RawExcelRow[];
  ignoredHeaders: string[];
}

export class ExcelImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExcelImportError';
  }
}

export interface ValidatedExcelRow extends RawExcelRow {
  /** 规范化后的站点 host（即使校验失败也可能有值） */
  host: string;
  /** 云端已有站点 id；空串 = 需要新建 */
  siteId: string;
  /** 站点是否已在云端 */
  siteKnown: boolean;
  /** 自动同步站点名称的盒子名 */
  boxName: string;
  normalized: {
    siteName: string;
    siteAddress: string;
    username: string;
    password: string;
    tabName: string;
    scheme: 'http' | 'https' | '';
  };
  errors: string[];
}

export interface ValidationContext {
  sites: CloudSiteSummary[];
  accounts: ParallelAccount[];
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/^\uFEFF/, '').trim();
}

function normHeader(value: unknown): string {
  return cellText(value).replace(/[\s_*＊]/g, '').toLowerCase();
}

const HEADER_LOOKUP = new Map<string, CanonicalHeader>();
for (const key of CANONICAL_ORDER) {
  for (const alias of HEADER_ALIASES[key]) {
    HEADER_LOOKUP.set(normHeader(alias), key);
  }
}

function findHeaderMatrix(matrix: unknown[][]): { headerRow: number; headers: Map<number, CanonicalHeader> } {
  for (let r = 0; r < Math.min(matrix.length, 10); r++) {
    const headers = new Map<number, CanonicalHeader>();
    const used = new Set<CanonicalHeader>();
    for (let c = 0; c < matrix[r].length; c++) {
      const key = HEADER_LOOKUP.get(normHeader(matrix[r][c]));
      if (!key) {
        continue;
      }
      if (used.has(key)) {
        throw new ExcelImportError(`表头重复：「${HEADER_LABEL[key]}」出现了不止一次。`);
      }
      used.add(key);
      headers.set(c, key);
    }
    if (CANONICAL_ORDER.every((k) => used.has(k))) {
      return { headerRow: r, headers };
    }
  }
  throw new ExcelImportError(
    '找不到完整表头：必须同时有「站点名称」「站点地址」「用户名」「密码」「页签名」五列。',
  );
}

/** 解析首个工作表（.xlsx / .xls / .csv 都由 SheetJS 处理） */
export async function parseExcelFile(file: File): Promise<ParsedExcel> {
  if (file.size > MAX_EXCEL_BYTES) {
    throw new ExcelImportError(`文件太大（${(file.size / 1024 / 1024).toFixed(1)} MB），上限 8 MB。`);
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  } catch {
    throw new ExcelImportError('无法读取这个文件：请确认它是有效的 Excel/CSV 文件。');
  }
  const sheetName = workbook.SheetNames[0];
  const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
  if (!sheet) {
    throw new ExcelImportError('工作簿里没有工作表。');
  }
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: '',
    raw: false,
    blankrows: false,
  }) as unknown[][];
  if (!matrix.length) {
    throw new ExcelImportError('工作表是空的。');
  }

  const { headerRow, headers } = findHeaderMatrix(matrix);
  const knownCols = new Set(headers.keys());
  const ignoredHeaders: string[] = [];
  for (let c = 0; c < matrix[headerRow].length; c++) {
    const name = cellText(matrix[headerRow][c]);
    if (name && !knownCols.has(c)) {
      ignoredHeaders.push(name);
    }
  }

  const rows: RawExcelRow[] = [];
  for (let r = headerRow + 1; r < matrix.length; r++) {
    const source = matrix[r] ?? [];
    const values: Partial<Record<CanonicalHeader, string>> = {};
    let any = false;
    for (const [c, key] of headers) {
      const value = cellText(source[c]);
      values[key] = value;
      if (value) any = true;
    }
    if (!any) {
      continue;
    }
    if (rows.length >= MAX_EXCEL_ROWS) {
      throw new ExcelImportError(`数据行超过 ${MAX_EXCEL_ROWS} 行，请拆成多个文件。`);
    }
    rows.push({
      rowNumber: r + 1,
      siteName: values.siteName ?? '',
      siteAddress: values.siteAddress ?? '',
      username: values.username ?? '',
      password: values.password ?? '',
      tabName: values.tabName ?? '',
    });
  }
  if (!rows.length) {
    throw new ExcelImportError('表头下面没有数据行。');
  }
  return { rows, ignoredHeaders };
}

function parseAddress(raw: string): { host: string; scheme?: 'http' | 'https' } | null {
  const text = raw.trim();
  const m = text.match(/^(https?):\/\/([^/]+)(\/.*)?$/i);
  if (m) {
    return { host: m[2].toLowerCase(), scheme: m[1].toLowerCase() as 'http' | 'https' };
  }
  const host = text.replace(/\/.*$/, '').toLowerCase();
  return host ? { host } : null;
}

/**
 * 逐行校验；**不修改输入**。
 *
 * 错误 = 这一行不导入。五项全部必填：站点名称 / 站点地址 / 用户名 / 密码 / 页签名。
 * 盒子名由站点名称自动派生（不读 Excel 列）。
 */
export function validateExcelRows(rows: RawExcelRow[], ctx: ValidationContext): ValidatedExcelRow[] {
  const byHost = new Map(ctx.sites.map((s) => [s.host.toLowerCase(), s] as const));
  const existing = new Set(ctx.accounts.map((a) => `${a.siteHost.toLowerCase()}\u0000${a.username.toLowerCase()}`));
  const seen = new Set<string>();

  const out = rows.map((raw) => {
    const errors: string[] = [];

    const siteAddress = raw.siteAddress.trim();
    const parsedAddress = parseAddress(siteAddress);
    if (!siteAddress) {
      errors.push('站点地址不能为空');
    } else if (!parsedAddress) {
      errors.push('站点地址格式不对');
    } else if (parsedAddress.host.length > 300) {
      errors.push('站点地址超过 300 个字符');
    } else if (!HOST_RE.test(parsedAddress.host)) {
      errors.push(`站点地址不是有效的域名：${parsedAddress.host}（不要带路径或中文）`);
    }
    const host = (parsedAddress?.host ?? '').toLowerCase();
    const site = host ? byHost.get(host) : undefined;

    const siteNameRaw = raw.siteName.trim();
    if (!siteNameRaw) {
      errors.push('站点名称不能为空');
    } else if (siteNameRaw.length > MAX_SITE_NAME) {
      errors.push(`站点名称超过 ${MAX_SITE_NAME} 个字符（盒子名也用它，盒子名上限 60）`);
    }
    // 已存在的站点以云端名称为准：Excel 里写错名字不应该把云端站点改名。
    const siteName = (site?.name.trim() || siteNameRaw);
    if (siteName.length > MAX_SITE_NAME) {
      errors.push(`云端站点名称超过 ${MAX_SITE_NAME} 个字符，无法作为盒子名`);
    }
    const boxName = siteName;

    const username = raw.username.trim();
    if (!username) {
      errors.push('用户名不能为空');
    } else if (username.length > 200) {
      errors.push('用户名超过 200 个字符');
    }

    const password = raw.password.trim();
    if (!password) {
      errors.push('密码不能为空');
    } else if (password.length > 500) {
      errors.push('密码超过 500 个字符');
    }

    const tabName = raw.tabName.trim();
    if (!tabName) {
      errors.push('页签名不能为空');
    } else if (tabName.length > 120) {
      errors.push('页签名超过 120 个字符');
    }

    if (host && username) {
      const key = `${host}\u0000${username.toLowerCase()}`;
      if (seen.has(key)) {
        errors.push('文件内重复：同一站点下这个用户名出现了多次');
      } else {
        seen.add(key);
      }
      if (existing.has(key)) {
        errors.push('云端已有同站点、同用户名的账号');
      }
    }

    return {
      ...raw,
      host,
      siteId: site?.id ?? '',
      siteKnown: Boolean(site),
      boxName,
      normalized: {
        siteName: siteName || host,
        siteAddress,
        username,
        password,
        tabName,
        scheme: parsedAddress?.scheme ?? '',
      },
      errors,
    } satisfies ValidatedExcelRow;
  });

  /* 两个不同站点用同一个名称 ⇒ 盒子名相同、无法同时关联两个站点。
   * 这是**行间冲突**，逐行校验时看不到，必须做第二遍。 */
  const boxOwners = new Map<string, Set<string>>();
  for (const row of out) {
    if (!row.boxName || !row.host) continue;
    const set = boxOwners.get(row.boxName) ?? new Set<string>();
    set.add(row.host);
    boxOwners.set(row.boxName, set);
  }
  for (const row of out) {
    if (row.boxName && (boxOwners.get(row.boxName)?.size ?? 0) > 1) {
      row.errors.push('多个不同站点使用了同一个站点名称，自动盒子无法区分');
    }
  }
  return out;
}

/** 生成带五项表头 + 一行示例的模板 */
export function buildExcelTemplate(): Blob {
  const header = CANONICAL_ORDER.map((k) => HEADER_LABEL[k]);
  const sample = ['示例环境', 'https://example.com', 'user01', 'pass01', '示例账号'];
  const sheet = XLSX.utils.aoa_to_sheet([header, sample]);
  sheet['!cols'] = header.map((h) => ({ wch: Math.max(12, h.length * 2 + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, '账号导入');
  const data = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([data], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
