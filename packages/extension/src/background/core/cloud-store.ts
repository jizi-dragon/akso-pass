import { LOCAL_KEYS, SESSION_COLORS } from '../../shared/constants';
import type { ParallelAccount } from '../../shared/types';
import { OfflineError } from './offline';
// v4.2.1：站点显示名从地址推导（用户要求：未填名称时从地址截取，如 tonbridge-config）
import { deriveSiteNameFromHost } from '../../shared/snake-case';
// ★ 2026-10-09：本模块此前**一行日志都没有**，而它这条链路上全是决定性的状态跃迁
//   （网络不通 / 401 清会话 / 代理劫持 / 服务端 5xx）。
//   ★ 这些是**罕见但关键**的事件，所以走 `diag()`（`storage.local` 环形 60）
//     而不是 `log.debug()` —— 后者默认 `info` 级即静默，而这些必须**事后**能看到
//     （诊断包里）。分工见 AGENTS.md 规则 22。
import { getLogger } from '../../shared/log';

const log = getLogger('cloud-store');
import type { ParallelStore } from './parallel-store';

/**
 * 云端账号库（Akso Vault）数据层 —— 与 `parallel-store` **同样的 10 个方法**，但走 HTTP。
 *
 * 三条不可动摇的口径：
 * 1. ★ **v3.18 起它是唯一的数据源**。本地数据源已整体废除，
 *    IndexedDB 里只剩一份**只读**快照副本（无口令，见 `account-cache.ts`）。
 * 2. **失败必须可读、不许静默回落**：网络/授权失败时一律抛错。
 *    ★ 网络层抛的是 `OfflineError`（可识别），**读路径**据此才敢回落到只读副本；
 *    而 401/403/5xx 一律不回落 —— 那会让用户看着旧数据以为"还能用"。
 * 3. **MV3 的 SW 会被回收**：不假设内存常驻，快照只做**短 TTL 缓存**（`list()` 5 秒），
 *    写操作后立即失效重拉 —— 时间线以服务端为准。
 *
 * 盒子语义对齐服务端：服务端把「未归盒」对外翻译成**默认盒的名字**，
 * 所以下载时 `默认盒名 → 无 box 字段`（`toAccount`），上传时 `无 box/默认盒名 → ''`（`uploadBoxName`）。
 */

/** 云端服务地址（与 popup 的 VAULT_URL 同源；写死是现状，接入后改这里一处） */
export const CLOUD_DEFAULT_BASE_URL = 'https://www.dragonrain.top:8443';

/** 云端会话：授权码换来的令牌 + 账号库口令密钥（fernetKey 当前不参与填表，仅按契约留存） */
export interface CloudAuth {
  baseUrl: string;
  token: string;
  fernetKey?: string;
  email?: string;
  /**
   * 展示名与头像（来自服务端 `/api/auth/profile` 的同一条 `user`）。
   * ★ 它们**只是显示用**，不参与任何鉴权判断 —— 所以丢了也不影响可用性：
   * 界面回落成邮箱、再回落成"已登录云端"。把"显示"与"鉴权"分开，
   * 就不会出现"头像没取到于是登录失败了"这种荒唐事。
   */
  displayName?: string;
  avatar?: string;
}

const ACCOUNTS_TTL_MS = 5000;
/** 站点表 / 盒表的 TTL 长一些：它们变得慢，且每次 list() 都要用 */
const META_TTL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;

/* ==================== 云端会话（chrome.storage.local） ==================== */

/**
 * ★ v3.18：`DataSource` / `getDataSource` / `setDataSource` 已随本地数据源一起**删除**。
 *
 * 保留它们会留下一个"看起来还能切"的开关，而切过去的那个地方**已经不存在了**
 * —— 也就是把"切回本地"变成一条会静默失效的路径。设计上只有一个数据源时，
 * **代码里就不该留下第二个的名字**。
 */

export async function getCloudAuth(): Promise<CloudAuth | null> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.cloudAuth);
  const auth = stored[LOCAL_KEYS.cloudAuth] as CloudAuth | null | undefined;
  if (!auth || typeof auth.token !== 'string' || !auth.token.trim()) {
    return null;
  }
  return {
    ...auth,
    baseUrl: normalizeBaseUrl(auth.baseUrl),
    token: auth.token.trim(),
  };
}

export async function setCloudAuth(auth: CloudAuth | null): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.cloudAuth]: auth });
}

function normalizeBaseUrl(raw: string | undefined): string {
  const t = (raw ?? '').trim() || CLOUD_DEFAULT_BASE_URL;
  return t.replace(/\/+$/, '');
}

/* ==================== 小工具（容错取值：服务端字段名可能演进，读不到就退，不要猜） ==================== */

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 兼容「裸数组」与「{ key: [...] }」两种信封 */
function pickArray(data: unknown, key: string): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }
  const rec = asRecord(data);
  return asArray(rec[key]);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

/** 把 baseUrl（`https://a.com/x`）还原成 host（`a.com`；带端口则含端口，与扩展 siteHost 同口径） */
export function hostOfUrl(raw: unknown): string {
  const t = str(raw).trim();
  if (!t) {
    return '';
  }
  let host = '';
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`);
    host = u.host.toLowerCase();
  } catch {
    host = t.replace(/\/.*$/, '').toLowerCase();
  }
  return HOST_RE.test(host) ? host : '';
}

/** 只接受"看起来就是 host"的字符串（站点名是展示名，不能当 host 用） */
function looksLikeHost(raw: unknown): string {
  const t = str(raw).trim().toLowerCase();
  return HOST_RE.test(t) ? t : '';
}

/** 云端没有配色字段：按账号 id 稳定取色（与列表顺序无关，同账号每次同色） */
function colorOf(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return SESSION_COLORS[hash % SESSION_COLORS.length];
}

function errorDetail(data: unknown, raw: string): string {
  const rec = asRecord(data);
  const detail = str(rec.detail) || str(rec.error) || str(rec.message);
  if (detail) {
    return detail.slice(0, 300);
  }
  return raw.trim().slice(0, 200);
}

/* ==================== HTTP 底座 ==================== */

function originPattern(baseUrl: string): string {
  try {
    return `${new URL(baseUrl).origin}/*`;
  } catch {
    return '*://*/*';
  }
}

/**
 * 跨域访问授权检查。服务端**没有任何 CORS 头**（实测 OPTIONS → 405），
 * 所以没有 host 授权时 fetch 必然失败 —— 与其报"网络请求失败"，不如报真正的原因。
 */
async function hasHostAccess(baseUrl: string): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: [originPattern(baseUrl)] });
  } catch {
    return true; // permissions API 不可用时不拦（让 fetch 自己给出结论）
  }
}

/** 一次性 JSON 请求（不含业务语义）。`token` 缺省 = 匿名请求（只有换授权码那一步用） */
async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl.signal,
    });
  } catch {
    // ★ v3.18：网络层失败改抛 `OfflineError`（带可识别的标记），
    //   而不是一句普通的 `Error`。理由：门面要靠它区分
    //   「网络不通」（读路径可以回落到只读副本）与
    //   「服务端 500 / 令牌过期」（**绝不能**回落 —— 回落会让用户
    //   看着一份旧数据以为还能用，于是不去重新登录）。
    //   在此之前二者都只是一句 `Error`，无法区分。
    //
    // ★ 记一条日志：这是"离线降级"的**触发点**，而它最容易在排障时被误判成
    //   "服务端挂了"或"扩展坏了"。有这一行，诊断包里就能看出是网络层 abort/timeout。
    //   （`fetch` 抛出的具体原因在 MV3 里不可靠，所以记的是"哪条请求 + 超时上限"。）
    log.warn('网络层失败 %s %s → 抛 OfflineError（读路径可回落只读副本）', init.method ?? 'GET', path);
    throw new OfflineError('读取云端');
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => '');
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      // ★ 令牌失效：**清掉 cloudAuth**（下次 cloud.state 就会回报未登录 ⇒ 页面提示"登录已过期，请重新登录"），
      //   但**不动数据源**：数据源保持 'cloud'，绝不静默切回本地（那会让用户以为账号没了）。
      //   匿名请求（设备授权那两步不带令牌）不在此列：那种 401 与本地会话无关。
      if (init.token) {
        // ★ 记一条日志：这一支会**清掉会话**，是"用户突然要求重新登录"的唯一原因。
        //   没有它时，症状（被踢出登录）与原因（某个后台请求吃了 401）之间的链条是断的。
        //   ⚠️ 只记 **HTTP 状态与路径**，绝不记令牌（`log()` 会打码，但我们也不给它机会）。
        log.warn('云端 %s %s → %d：会话已失效，清 cloudAuth（数据源保持 cloud）',
          init.method ?? 'GET', path, res.status);
        await setCloudAuth(null);
        invalidateCloudCache();
      }
      throw new Error(`登录已过期（HTTP ${res.status}）：请在管理页点「重新登录」重新登录云端账号库`);
    }
    const detail = errorDetail(data, text);
    // ★ 5xx / 4xx 都不是"离线"，所以**不会**回落只读副本 —— 记下来才能区分二者。
    //   ★ 只记状态码与路径，**不记 `detail`**：它可能回显服务端的额外信息，
    //     而这条通道（`diag()`）虽然也打码，但没有必要把响应体带进来。
    log.error('云端 %s %s → %d（非离线，读路径不会回落）',
      init.method ?? 'GET', path, res.status);
    throw new Error(`云端请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`);
  }
  if (data === undefined && text.trim()) {
    // 200 但响应体不是 JSON：代理/门户劫持的典型形态，绝不能当成"空数据"吞掉
    log.error('云端 %s %s → 200 但响应不是 JSON（疑似代理/门户劫持）',
      init.method ?? 'GET', path);
    throw new Error('云端响应不是合法 JSON（可能被网络代理拦截），已中止以免误读数据');
  }
  return data as T;
}

/** 带会话令牌的业务请求 */
export async function cloudRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const auth = await getCloudAuth();
  if (!auth) {
    throw new Error('云端未授权：请先在管理页点「重新登录」登录云端账号库');
  }
  if (!(await hasHostAccess(auth.baseUrl))) {
    throw new Error(`云端不可用：扩展尚未获得 ${auth.baseUrl} 的访问授权（请在管理页点「重新登录」重新发起授权）`);
  }
  return requestJson<T>(auth.baseUrl, path, { ...init, token: auth.token });
}

/**
 * **匿名**请求出口：全服务只有设备授权那两步（`device-start` / `device-poll`）用它 ——
 * 它们必须能在"还没有任何凭据"时调用，所以走不了 `cloudRequest`。
 * ★ 只此一处，别在别处再开一个不带令牌的口子（那会让"哪一步不需要登录"说不清）。
 */
export async function anonymousRequest<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  baseUrl: string = CLOUD_DEFAULT_BASE_URL,
): Promise<T> {
  const base = normalizeBaseUrl(baseUrl);
  if (!(await hasHostAccess(base))) {
    throw new Error(`云端不可用：扩展尚未获得 ${base} 的访问授权`);
  }
  return requestJson<T>(base, path, init);
}

/** 已登录账号的邮箱（取不到就返回空串：它只影响界面显示，不影响可用性） */
export async function fetchMeEmail(): Promise<string> {
  try {
    const me = asRecord(await cloudRequest<unknown>('/api/auth/me'));
    return str(asRecord(me.user).email) || str(me.email);
  } catch {
    return '';
  }
}

/* ==================== 快照缓存（MV3：SW 随时会被回收，这里只是短命缓存） ==================== */

interface CloudSite {
  id: string;
  name: string;
  baseUrl: string;
  host: string;
  /**
   * 显示名（站点管理那一行的**主标题**）。
   *
   * ★ v4.2.1：用户要求"名称留空时**从地址里截取**"（`tonbridge-config.aksoegmp.com`
   *   → `tonbridge-config`）。服务端建站时把 `name` 填成了完整 host，所以"name 非空"
   *   并不代表"用户起过名"—— 直接用 name 当显示名就等于永远显示一长串域名。
   * ⇒ 显示名的口径收在这一处：**name 与 host 不同才算用户起过名**，否则用推导名。
   */
  displayName: string;
}

interface CloudBox {
  name: string;
  isDefault: boolean;
  disabled: boolean;
  count: number;
}

let accountCache: { at: number; rows: Record<string, unknown>[] } | null = null;
let siteCache: { at: number; rows: CloudSite[] } | null = null;
let boxCache: { at: number; rows: CloudBox[]; default: string } | null = null;

/** 写操作后调用：下一次读一律重拉（时间线以服务端为准，不做本地推测） */
export function invalidateCloudCache(): void {
  accountCache = null;
  siteCache = null;
  boxCache = null;
}

async function loadRawAccounts(force = false): Promise<Record<string, unknown>[]> {
  if (!force && accountCache && Date.now() - accountCache.at < ACCOUNTS_TTL_MS) {
    return accountCache.rows;
  }
  const data = await cloudRequest<unknown>('/api/accounts');
  const rows = pickArray(data, 'accounts').map(asRecord);
  accountCache = { at: Date.now(), rows };
  return rows;
}

async function loadSites(force = false): Promise<CloudSite[]> {
  if (!force && siteCache && Date.now() - siteCache.at < META_TTL_MS) {
    return siteCache.rows;
  }
  const rows = pickArray(await cloudRequest<unknown>('/api/sites'), 'sites')
    .map((raw) => {
      const rec = asRecord(raw);
      const baseUrl = str(rec.baseUrl);
      const host = hostOfUrl(baseUrl) || hostOfUrl(rec.host);
      const name = str(rec.name);
      return {
        id: str(rec.id),
        name,
        baseUrl,
        host,
        // 显示名口径见接口注释：**name 与 host 不同**才算用户起过名；
        // 否则用从地址推导的短名（服务端建站时把 name 填成了完整 host，
        // 直接用 name 就等于永远显示一长串域名）。
        displayName: name && name !== host ? name : deriveSiteNameFromHost(host),
      };
    })
    .filter((s) => Boolean(s.id));
  siteCache = { at: Date.now(), rows };
  return rows;
}

async function loadBoxes(force = false): Promise<{ rows: CloudBox[]; default: string }> {
  if (!force && boxCache && Date.now() - boxCache.at < META_TTL_MS) {
    return boxCache;
  }
  const data = asRecord(await cloudRequest<unknown>('/api/boxes'));
  const rows = pickArray(data, 'boxes').map((raw) => {
    const rec = asRecord(raw);
    return {
      name: str(rec.name),
      isDefault: rec.isDefault === true,
      disabled: rec.disabled === true,
      count: num(rec.count) ?? 0,
    };
  });
  const def = str(data.default) || rows.find((b) => b.isDefault)?.name || '';
  boxCache = { at: Date.now(), rows, default: def };
  return boxCache;
}

/**
 * ★★ 2026-10-12：**权威盒子名单**（云端那一份）。
 *
 * 用户报"盒子的数据没有做好同步"：实测**扩展 5 个盒子、云端 2 个**，两边都不报错。
 * 扩展侧的根因是 `parallel.ts` 的盒子列表把"**本地记住的**"取了并集，
 * 而那份名单（`ql:boxes`）**只会被加、不会被减** ⇒ 云端删掉/改名的盒子永远留着。
 *
 * ⇒ 这里把"云端那一份"单独导出，让 UI 侧能在**云可用时**对账（剪掉多余的）。
 *   ★ 调用方必须容错：**拿不到就什么也别动**（离线时本地那份是唯一的真相）。
 *   ★ `force` 默认 false：走 `META_TTL_MS` 缓存，别为一次渲染多打一次网络。
 */
export async function fetchCloudBoxNames(force = false): Promise<{ names: string[]; default: string } | null> {
  try {
    const { rows, default: def } = await loadBoxes(force);
    return { names: rows.map((b) => b.name).filter(Boolean), default: def };
  } catch {
    return null;   // ★ 不抛：这是"对账用的参考数据"，取不到不该让任何调用点炸
  }
}

/** 默认盒名（上传时要把等于它的 box 名翻译回空串） */
async function defaultBoxName(): Promise<string> {
  try {
    return (await loadBoxes()).default;
  } catch {
    return ''; // 拿不到默认盒名时不翻译（宁可原样传，也不猜一个名字）
  }
}

/* ==================== 记录 → ParallelAccount ==================== */

function toAccount(rec: Record<string, unknown>, siteById: Map<string, CloudSite>, defaultBox: string): ParallelAccount {
  const id = str(rec.id);
  const username = str(rec.username);
  const siteId = str(rec.siteId) || str(asRecord(rec.site).id);
  const site = siteById.get(siteId);
  const host =
    looksLikeHost(rec.siteHost) ||
    hostOfUrl(rec.baseUrl) ||
    hostOfUrl(asRecord(rec.site).baseUrl) ||
    site?.host ||
    looksLikeHost(rec.siteName) ||
    '';
  const boxName = str(rec.box).trim();
  // 服务端把「未归盒」翻译成默认盒的名字 —— 这里反向还原成「无 box 字段」（= 默认盒）
  const box = boxName && boxName !== defaultBox ? boxName : '';
  const schemeRaw = str(rec.scheme);
  const updatedAt = num(rec.updatedAt) ?? num(rec.createdAt) ?? 0;
  return {
    id,
    siteHost: host,
    ...(schemeRaw === 'http' || schemeRaw === 'https' ? { scheme: schemeRaw } : {}),
    tabName: str(rec.tabName) || username,
    username,
    color: colorOf(id),
    ...(box ? { box } : {}),
    hasPassword: rec.hasPassword === true || Boolean(str(rec.passwordEnc)),
    createdAt: num(rec.createdAt) ?? updatedAt,
    updatedAt,
  };
}

async function listAll(): Promise<ParallelAccount[]> {
  const [rows, sites, boxes] = await Promise.all([loadRawAccounts(), loadSites(), loadBoxes()]);
  const byId = new Map(sites.map((s) => [s.id, s] as const));
  const accounts = rows.map((rec) => toAccount(rec, byId, boxes.default));
  const broken = accounts.filter((a) => !a.id).length;
  if (broken > 0) {
    // 没有 id 的行无法定位也无法操作；静默丢掉它们等于"用户以为账号还在列表里"
    throw new Error(`云端返回的 ${broken} 条账号缺少 id：数据格式不符，已中止（避免误读列表）`);
  }
  return accounts;
}

async function getOne(id: string): Promise<ParallelAccount> {
  const hit = (await listAll()).find((a) => a.id === id);
  if (!hit) {
    throw new Error(`账号不存在: ${id}`);
  }
  return hit;
}

async function patchAccount(id: string, patch: Record<string, unknown>): Promise<void> {
  await cloudRequest(`/api/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
  invalidateCloudCache();
}

/**
 * 站点清单（host ↔ 自定义名称）。
 *
 * ★ 给「站点管理」用：那一栏要显示**用户给站点起的名字**，而不只是域名。
 *   服务端 `site_public()` 早就带 `name`（v4.2.1 核对），缺的只是把它传到 UI ——
 *   此前 `renderSites(hosts: string[])` 只拿得到 host，名字在传输层就被丢了。
 *
 * ★ `name` 为空时由调用方回落到 host 显示（服务端建的站点 `name` 默认就是 host，
 *   但用户清空过名字的情况也要能显示）。
 */
async function loadSiteNames(force = false): Promise<{ host: string; name: string; displayName: string }[]> {
  const sites = await loadSites(force);
  return sites.map((s) => ({ host: s.host, name: s.name, displayName: s.displayName }));
}

/**
 * 给站点改自定义名称。
 *
 * ★ 只 PATCH `name`，**不动 `baseUrl`** —— baseUrl 是 host 的唯一来源
 *   （`host_of(base_url)`），改了它等于把站点的身份键换掉，账号会全部错位。
 *   `SitePatch` 是逐字段显式建模的（服务端注释里写了原因：`BaseModel` 默认忽略多余字段，
 *   漏字段会**静默不生效**），所以传 `{ name }` 是安全的。
 */
async function renameSiteOnCloud(host: string, name: string): Promise<void> {
  const wanted = host.trim().toLowerCase();
  const sites = await loadSites(true);
  const hit = sites.find((s) => s.host === wanted);
  if (!hit) {
    throw new Error(`云端找不到站点 ${wanted}（先在「站点管理」里添加并授权该站点）`);
  }
  const trimmed = name.trim();
  await cloudRequest(`/api/sites/${encodeURIComponent(hit.id)}`, {
    method: 'PATCH',
    // 空名 = 恢复成 host（服务端建的默认名就是 host，口径一致）
    body: { name: trimmed || wanted },
  });
  invalidateCloudCache();
}

/**
 * 添加站点时顺带落名：**站点不存在就建**，存在就改名。
 *
 * ★ 与 `renameSiteOnCloud` 的差别是**语义**：那个假定站点已存在、找不到就报错
 *   （用户不该以为给一个不存在的站点改了名）；这个的用途正是"刚添加的站点"，
 *   所以它必须能创建。合成一条会让"新建"与"改名"共用同一条找不到时的处置，
 *   而它们该有相反的行为。
 *
 * ★ 名字为空时回落到 host —— 与用户要求的口径一致（"未填写名称时自动从地址填充"），
 *   也与服务端建站点时的默认名一致（`ms.name.strip() or host`）。
 */
async function upsertSiteOnCloud(host: string, name: string): Promise<void> {
  const wanted = host.trim().toLowerCase();
  const name2 = name.trim() || wanted;
  const id = await ensureSite(wanted); // 不存在就在这里建
  await cloudRequest(`/api/sites/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { name: name2 },
  });
  invalidateCloudCache();
}

/** 站点按 host 找；找不到就建一个（服务端会对 baseUrl 做域名预处理，所以建完以 id 为准） */
async function ensureSite(host: string, scheme?: 'http' | 'https'): Promise<string> {
  const wanted = host.trim().toLowerCase();
  const sites = await loadSites(true);
  const hit = sites.find((s) => s.host === wanted);
  if (hit) {
    return hit.id;
  }
  const created = asRecord(
    await cloudRequest<unknown>('/api/sites', {
      method: 'POST',
      body: { name: wanted, baseUrl: `${scheme ?? 'https'}://${wanted}`, note: '' },
    }),
  );
  const id = str(asRecord(created.site).id) || str(created.id);
  invalidateCloudCache();
  if (id) {
    return id;
  }
  const again = await loadSites(true);
  const found = again.find((s) => s.host === wanted);
  if (!found) {
    throw new Error(`云端站点创建失败：${wanted}`);
  }
  return found.id;
}

/** 盒子的存在性：扩展可以随手起一个新盒名（本地是纯字段），云端得先在盒表里落地 */
async function ensureBox(name: string): Promise<void> {
  const boxes = await loadBoxes(true);
  if (boxes.rows.some((b) => b.name === name)) {
    return;
  }
  // 已存在时服务端可能报错（并发/已建）：这一步失败不致命，后面的 PATCH 会给出真正的结论
  await cloudRequest('/api/boxes', { method: 'POST', body: { name } }).catch(() => undefined);
  invalidateCloudCache();
}

async function uploadBoxName(box: string | undefined): Promise<string> {
  const name = (box ?? '').trim();
  if (!name) {
    return '';
  }
  const def = await defaultBoxName();
  return name === def ? '' : name;
}

async function clearBoxImpl(name: string): Promise<number> {
  const res = asRecord(
    await cloudRequest<unknown>('/api/boxes/delete', {
      method: 'POST',
      body: { name, deleteAccounts: false },
    }),
  );
  invalidateCloudCache();
  return num(res.movedToDefault) ?? num(res.moved) ?? num(res.count) ?? 0;
}

/* ==================== 对外：与 parallel-store 同形的 10 个方法 ==================== */

export const cloudStore = {
  async list(): Promise<ParallelAccount[]> {
    return listAll();
  },

  async get(id: string): Promise<ParallelAccount> {
    return getOne(id);
  },

  async create(input: {
    siteHost: string;
    tabName: string;
    username: string;
    password: string;
    box?: string;
    scheme?: 'http' | 'https';
  }): Promise<ParallelAccount> {
    const siteHost = input.siteHost.trim();
    const siteId = await ensureSite(siteHost, input.scheme);
    const box = await uploadBoxName(input.box);
    if (box) {
      await ensureBox(box);
    }
    await cloudRequest('/api/accounts', {
      method: 'POST',
      body: {
        siteId,
        username: input.username,
        password: input.password,
        tabName: input.tabName || input.username,
        box,
        ...(input.scheme ? { scheme: input.scheme } : {}),
      },
    });
    invalidateCloudCache();
    const all = await listAll();
    const hit = all.find((a) => a.siteHost === siteHost && a.username === input.username);
    if (!hit) {
      throw new Error('云端已受理新增，但账号列表里还没看到它，请刷新确认');
    }
    return hit;
  },

  async updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount> {
    await patchAccount(id, { scheme });
    return getOne(id);
  },

  async updateTabName(id: string, tabName: string): Promise<ParallelAccount> {
    await patchAccount(id, { tabName });
    return getOne(id);
  },

  async updateBox(id: string, box: string): Promise<ParallelAccount> {
    const name = box.trim();
    const target = name ? await uploadBoxName(name) : '';
    if (target) {
      await ensureBox(target);
    }
    await patchAccount(id, { box: target });
    return getOne(id);
  },

  async renameBox(from: string, to: string): Promise<number> {
    const fromName = from.trim();
    const toName = to.trim();
    if (!fromName) {
      throw new Error('源盒子名为空');
    }
    if (fromName === toName) {
      return 0;
    }
    if (!toName) {
      // 目标为空 = 并入「默认盒子」。服务端 rename 的 target 不接受空串（minLength 1），
      // 只能走「删盒子 + 盒内账号归入默认盒」那一支（deleteAccounts=false 的语义正是如此）。
      return clearBoxImpl(fromName);
    }
    const res = asRecord(
      await cloudRequest<unknown>('/api/boxes/rename', {
        method: 'POST',
        body: { source: fromName, target: toName },
      }),
    );
    invalidateCloudCache();
    return num(res.moved) ?? num(res.count) ?? 0;
  },

  async clearBox(name: string): Promise<number> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('盒子名为空');
    }
    return clearBoxImpl(trimmed);
  },

  /** 站点清单（host ↔ 用户自定义名称），见 `loadSiteNames` 的说明 */
  async listSites(force = false): Promise<{ host: string; name: string; displayName: string }[]> {
    return loadSiteNames(force);
  },

  /** 站点改名，见 `renameSiteOnCloud` 的说明 */
  async renameSite(host: string, name: string): Promise<void> {
    return renameSiteOnCloud(host, name);
  },

  /** 添加站点时落名（站点不存在就建），见 `upsertSiteOnCloud` 的说明 */
  async upsertSite(host: string, name: string): Promise<void> {
    return upsertSiteOnCloud(host, name);
  },

  /**
   * 改口令。
   *
   * ★ v3.18：**收明文的 `password`**，不再收"本地 AES-GCM 密文"。
   *
   *   旧形态是个历史包袱：门面签名当初按本地实现定的（收 `EncryptedCredentials`），
   *   云端实现只好"先在本机解密再 PATCH 明文"，成了**没有意义的中转** ——
   *   密文本来就是本机生成的，解它只是绕一圈。
   *
   *   本地凭据存储废除后，明文直接来自调用点（用户刚输入的那一次），
   *   而**本机不再有任何持久化的口令形态**。签名随之改对。
   */
  async updateCredentials(id: string, password: string): Promise<void> {
    await patchAccount(id, { password });
  },

  async delete(id: string): Promise<void> {
    await cloudRequest(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    invalidateCloudCache();
  },
};

/**
 * 取**明文**口令（自动填表用）：`GET /api/accounts/{id}/password`。
 * ⚠️ 这是全服务最敏感的端点，调用方**不得缓存落盘**——只在打开账号的当下取一次，用完即弃。
 */
export async function fetchPlaintextPassword(id: string): Promise<string> {
  const data = asRecord(await cloudRequest<unknown>(`/api/accounts/${encodeURIComponent(id)}/password`));
  return str(data.password);
}

/**
 * **编译期同形证明**：云端实现必须逐方法匹配 `ParallelStore` 门面契约
 * （少一个方法、返回值或入参漂了，这一行当场红）。`import type` 不产生运行时依赖，
 * 所以这里不会和 parallel-store 形成循环 import。
 */
export const cloudStoreContract: ParallelStore = cloudStore;

/** 云端账号总数（合并核对的第二个证据；`counts.accounts` 读不到时返回 undefined） */
export async function fetchAccountCount(): Promise<number | undefined> {
  const snap = asRecord(await cloudRequest<unknown>('/api/vault/snapshot'));
  return num(asRecord(snap.counts).accounts) ?? num(snap.totalAccounts);
}
