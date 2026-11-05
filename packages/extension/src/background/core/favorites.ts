/**
 * 常用页面书签（v3.16，Alt+1 轮盘）—— 需求来自同事「阿克索配置助手 v2.1.0」评审的 D1。
 *
 * 与「最近配置页 MRU」（v3.11–v3.15，已在 v3.16 移除）的分工：
 *   MRU = 「我刚去过哪」；书签 = 「我常去哪」。前者按浏览行为自动记录，后者由用户显式维护。
 *
 * 存储：`chrome.storage.local['ql:favorites']`，形如 `[{name, path}]`。
 * 「键不存在」= 用内置默认（`DEFAULT_FAVORITES`）；「键是空数组」= 用户确实全删了（v4.2.44）。
 * 写入统一走 `saveFavorites`（补前导 `/`、只放行 http(s)、按路径去重、截到上限）。
 *
 * `path` 允许两种形态：
 *   - 完整网址（`https://x/y`）→ 原样打开；
 *   - 相对路径（`/admin/...`）→ 拼到「基准 origin」上。基准优先级：
 *     本次调用传入的 baseOrigin → 当前活动页签的 origin → 放弃并报错（不猜一个域名）。
 */
import { DEFAULT_FAVORITES, FAVORITES_MAX, LOCAL_KEYS } from '../../shared/constants';
import { getLogger } from '../../shared/log';
import type { FavoriteItem, FavoritesSaveResult } from '../../shared/messages';

/** ★ 2026-10-09 补：这个模块此前**没有任何日志**，而它的读失败会让用户的收藏静默消失。 */
const log = getLogger('favorites');

/** 名称与路径的长度上限：与平行管理页输入框的 maxlength 保持一致 */
const MAX_NAME = 60;
const MAX_PATH = 2048;

/**
 * 归一化一条路径（v4.2.44）。
 *
 * - 完整网址：只放行 `http:` / `https:`，其余协议（`javascript:` / `data:` …）一律拒绝；
 * - 相对路径：去掉首尾空白，**补前导 `/`**（用户常写 `admin/...`，旧逻辑拼出来也是
 *   `/admin/...`，但现在把它落成规范形态，存进去就能直接看）；
 * - 拒绝协议相对地址（`//host/x`）与反斜杠 —— 它们会改变解析语义，
 *   而书签的本意是「同一个站点下的某条路径」。
 */
function normalizePath(raw: unknown): string | null {
  const path = String(raw ?? '').trim();
  if (!path || path.length > MAX_PATH) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) {
    try {
      const u = new URL(path);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    } catch {
      return null;
    }
  }
  if (path.startsWith('//') || path.includes('\\')) {
    return null;
  }
  return path.startsWith('/') ? path : `/${path}`;
}

function normalizeOne(raw: unknown): FavoriteItem | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = String(o.name ?? '').trim().slice(0, MAX_NAME);
  const path = normalizePath(o.path);
  if (!name || !path) {
    return null; // 名称与路径缺一不可：没有路径的条目点不动
  }
  return { name, path };
}

/**
 * 读书签；**未配置过**时回落内置默认。
 *
 * ★ v4.2.44：区分「没配过」与「配置为空」——
 *   旧逻辑 `items.length ? items : DEFAULT_FAVORITES` 会把「用户删光了」也当成
 *   「没配过」⇒ 删到最后一条再保存，轮盘里又冒出 6 个默认书签，用户以为删不掉。
 *   现在只有 storage 里**没有这个键**（或键不是数组）才回落默认；空数组就是空。
 */
export async function listFavorites(): Promise<FavoriteItem[]> {
  let stored: unknown;
  try {
    const o = await chrome.storage.local.get(LOCAL_KEYS.favorites);
    stored = o[LOCAL_KEYS.favorites];
  } catch (e) {
    // ★★ 2026-10-09 补：这一支**此前完全静默**，而它的表现是**对用户说谎**。
    //
    //   读失败 ⇒ `stored = undefined` ⇒ 下面回落到 `DEFAULT_FAVORITES`
    //   ⇒ **用户自建的收藏整份不见了，界面上显示的是内置默认书签**。
    //
    //   ★ 用户看到的是"我的书签被换掉了"，而不是"读取失败了" ——
    //     他会以为扩展改了他的数据（而其实一个字节都没动）。
    //     没有这一行时，我们的排查方向会完全错（去查存储写入 / 同步 / 迁移）。
    //
    //   ★ 级别 `warn`：它是降级（数据没坏，只是这次读不出来），不是主流程失败。
    //   ★ 不选 `debug`：默认 `info` 下不输出 ⇒ 等于没加（规则 25）。
    //   ★ 触发频率：`listFavorites` 在轮盘（Alt+1）与管理页被调用，是**用户动作级**
    //     频率，不是热路径 ⇒ 不会挤掉 `ql:diag` 环形 60 里更重要的记录。
    log.warn('listFavorites 读 storage.local 失败 ⇒ 回落到内置默认书签（用户的收藏这次看不到）：%s',
      (e as Error)?.message ?? e);
    stored = undefined;
  }
  const configured = Array.isArray(stored);
  const items = configured
    ? (stored as unknown[]).map(normalizeOne).filter((x): x is FavoriteItem => x !== null)
    : DEFAULT_FAVORITES.map((d) => ({ ...d }));
  // 轮盘一页 20 格、超出滚动；上限只防存储失控。截断时留日志，不静默丢到无感知。
  if (items.length > FAVORITES_MAX) {
    log.warn('书签 %d 条超过上限 %d ⇒ 只取前 %d 条（请在管理页精简）', items.length, FAVORITES_MAX, FAVORITES_MAX);
  }
  return items.slice(0, FAVORITES_MAX);
}

/**
 * 管理页写入（v4.2.44）：**唯一**的归一化入口。
 * 逐条校验 → 按路径去重（保留先出现的）→ 截到上限，并把「少了几条」如实带回。
 */
export async function saveFavorites(items: unknown): Promise<FavoritesSaveResult> {
  const arr = Array.isArray(items) ? items : [];
  const seen = new Set<string>();
  const clean: FavoriteItem[] = [];
  let skipped = 0;
  let duplicates = 0;
  for (const raw of arr) {
    const item = normalizeOne(raw);
    if (!item) {
      skipped++;
      continue;
    }
    if (seen.has(item.path)) {
      duplicates++;
      continue;
    }
    seen.add(item.path);
    clean.push(item);
  }
  const truncated = Math.max(0, clean.length - FAVORITES_MAX);
  const kept = clean.slice(0, FAVORITES_MAX);
  await chrome.storage.local.set({ [LOCAL_KEYS.favorites]: kept });
  log.info('保存书签 %d 条（忽略 %d、合并重复 %d、截断 %d）', kept.length, skipped, duplicates, truncated);
  return { items: kept, skipped, duplicates, truncated };
}

/** 恢复内置默认：删掉用户键，而不是写一份默认副本（默认列表以后变长也能跟上） */
export async function resetFavorites(): Promise<FavoriteItem[]> {
  await chrome.storage.local.remove(LOCAL_KEYS.favorites);
  log.info('书签已恢复内置默认（%d 条）', DEFAULT_FAVORITES.length);
  return DEFAULT_FAVORITES.map((d) => ({ ...d }));
}

/** 当前活动页签的 origin（用于相对路径书签的基准） */
async function activeOrigin(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      return '';
    }
    const u = new URL(tab.url);
    return /^https?:$/.test(u.protocol) ? u.origin : '';
  } catch {
    return '';
  }
}

/**
 * 把书签解析成可打开的 URL。
 * 基准缺失时返回 null —— **不猜域名**（猜错会静默打开别人的站点）。
 */
export async function resolveFavoriteUrl(path: string, baseOrigin?: string): Promise<string | null> {
  // 归一化与保存同源：非 http(s) 的绝对地址在这里也会被挡掉（不会点出 javascript:）
  const raw = normalizePath(path);
  if (!raw) {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return raw;
  }
  let base = String(baseOrigin ?? '').trim();
  if (!base) {
    base = await activeOrigin();
  }
  if (!base) {
    return null;
  }
  try {
    base = new URL(base).origin;
  } catch {
    return null;
  }
  return base + raw;
}
