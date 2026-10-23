import { LOCAL_KEYS, SESSION_COLORS } from '../../shared/constants';
import type { CloudDeleteSiteResult, CloudSiteSummary, CloudUiState, ParallelAccount, ParBox } from '../../shared/types';
import { isOfflineError, OfflineError } from './offline';
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

/** 云端服务地址（与 popup 的 VAULT_URL 同源；写死是现状，接入后改这里一处）
 *
 * ★ 2026-10-21：akso-cloud 已迁到标准 443；这里原先是 `:8443`（迁移期的
 *   iptables 垫片）。垫片还在时能用，但撤掉后新登录/同步会直接失败。
 *   已保存的旧会话由 `normalizeBaseUrl()` 归一，不需要用户重新授权。
 */
export const CLOUD_DEFAULT_BASE_URL = 'https://www.dragonrain.top';

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
  try {
    const u = new URL(t);
    // 旧版默认地址（8443 迁移垫片）→ 443；只对确实的官方 host 做，别动用户自建实例
    if (u.hostname === 'www.dragonrain.top' && u.port === '8443') {
      u.port = '';
      return u.origin;
    }
  } catch {
    // 不是合法 URL 时保持原来的容错：去掉尾斜杠，让后续 request 给出可读错误
  }
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
  const rawDetail = rec.detail ?? rec.error ?? rec.message;
  // ★★ v4.2.12：`detail` 可能是**对象**（服务端的结构化错误，如删除站点时的 409）。
  //   原来只认字符串 ⇒ 那种情况下会回落到 `raw`（整段响应体的前 200 字），
  //   于是用户看到的是一截**被截断的 JSON**，而不是 `detail.message` 那句人话。
  const detail =
    typeof rawDetail === 'string'
      ? rawDetail
      : str(asRecord(rawDetail).message) || str(asRecord(rawDetail).error);
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
        // 云端个人页据此显示“Pass 是否已登录/最近活跃”；只作展示，不参与鉴权。
        'X-Akso-Client': 'akso-pass',
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      // 云端是事实源，读请求不得被浏览器 HTTP 缓存命中（服务端 JSON 未显式带缓存头）
      cache: 'no-store',
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
    /*
     * ★★ v4.2.12：把**服务端的结构化 detail 原样挂在 Error 上**。
     *
     * 缺陷形态（真实存在于删除站点那条路径上）：`DELETE /api/sites/{id}` 在
     * "站点下还有账号"时回 **409**，而 `detail` 是一个**对象**
     * （`{code:'site_has_accounts', accountCount, usernames}`）。
     * 原来它只被 `errorDetail()` 串成一句话塞进 `message` ⇒ 调用方**再也拿不到**
     * `accountCount` / `usernames`，于是"把要删的账号摊开给人看"这件事**做不到**，
     * 只能把服务端的 JSON 原文显示给用户（`akso-cloud/app/web/static/site.js`
     * 那边是能拿到的 —— 两端的体验因此不一致）。
     *
     * ⇒ 现在两个都给：`message` 保持可读（人看），`detail` 带原始对象（代码看）。
     *   ★ 这是 `webRequest` 那个"C 通道"的同族纪律：**别在传输层把信息丢掉**，
     *     丢掉之后下游没有任何办法把它找回来。
     */
    const err = new Error(`云端请求失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`) as Error & {
      status?: number;
      detail?: unknown;
    };
    err.status = res.status;
    err.detail = asRecord(data).detail ?? undefined;
    throw err;
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
  /** 用户备注（云端控制台可编辑；扩展的站点编辑弹窗也带这一格）。 */
  note: string;
  /** 云端算好的账号数（`/api/sites` 的 `accountCount`）；用于和站点卡片同源。 */
  accountCount: number;
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

/*
 * ★ 2026-10-13：这里原先有一个**本地的** `CloudBox` 接口（只有 4 个字段：
 *   `name` / `isDefault` / `disabled` / `count`）。它现在**删掉了** ——
 *   盒子形状只有一个来源：`shared/types.ts` 的 `ParBox`（也就是 `par.boxes` 的协议载荷）。
 *   ★ 两处各写一份形状的后果是"改了一处、另一处不报错"：
 *   服务端 2026-10-13 加了 `deletable` / `renameable` / `bindable` / `siteId` / `siteName`，
 *   而扩展这边**连字段都没有** ⇒ UI 只能自己另造一套口径（本地禁用名单就是这么来的）。
 */

let accountCache: { at: number; rows: Record<string, unknown>[] } | null = null;
let siteCache: { at: number; rows: CloudSite[] } | null = null;
let boxCache: { at: number; rows: ParBox[]; default: string } | null = null;

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

function mapCloudSite(raw: unknown): CloudSite {
  const rec = asRecord(raw);
  const baseUrl = str(rec.baseUrl);
  const host = hostOfUrl(baseUrl) || hostOfUrl(rec.host);
  const name = str(rec.name);
  return {
    id: str(rec.id),
    name,
    baseUrl,
    host,
    note: str(rec.note),
    accountCount: num(rec.accountCount) ?? 0,
    // 显示名口径见接口注释：**name 与 host 不同**才算用户起过名；
    // 否则用从地址推导的短名（服务端建站时把 name 填成了完整 host，
    // 直接用 name 就等于永远显示一长串域名）。
    displayName: name && name !== host ? name : deriveSiteNameFromHost(host),
  };
}

function siteSummary(site: CloudSite): CloudSiteSummary {
  return {
    id: site.id,
    host: site.host,
    name: site.name,
    displayName: site.displayName,
    baseUrl: site.baseUrl,
    note: site.note,
    accountCount: site.accountCount,
  };
}

function mapParBox(raw: unknown): ParBox {
  const rec = asRecord(raw);
  return {
    name: str(rec.name),
    isDefault: rec.isDefault === true,
    disabled: rec.disabled === true,
    autoDisabled: rec.autoDisabled === true,
    count: num(rec.count) ?? 0,
    renameable: rec.renameable !== false,
    deletable: rec.deletable !== false,
    bindable: rec.bindable !== false,
    siteId: str(rec.siteId),
    siteName: str(rec.siteName),
  };
}

async function loadSites(force = false): Promise<CloudSite[]> {
  if (!force && siteCache && Date.now() - siteCache.at < META_TTL_MS) {
    return siteCache.rows;
  }
  const rows = pickArray(await cloudRequest<unknown>('/api/sites'), 'sites')
    .map(mapCloudSite)
    .filter((s) => Boolean(s.id));
  siteCache = { at: Date.now(), rows };
  return rows;
}

async function loadBoxes(force = false): Promise<{ rows: ParBox[]; default: string }> {
  if (!force && boxCache && Date.now() - boxCache.at < META_TTL_MS) {
    return boxCache;
  }
  const data = asRecord(await cloudRequest<unknown>('/api/boxes'));
  /*
   * ★★ 2026-10-13：**服务端算了什么就照抄什么**，一个字段都别再丢。
   *
   * 改前这里只映射 `name` / `isDefault` / `disabled` / `count`，而 `disabled`
   * 与 `count` 在被 `fetchCloudBoxNames()` 拍平成 `names[]` 之后就没人再读了。
   * 三个 `*able` 是服务端的判定（默认盒三个都 false）——
   * UI 拿它决定"给不给入口"，**不要**自己判 `name === defaultBox`：
   * 判据只该有一处，而"能点但一定失败"的按钮比没有按钮更糟。
   */
  const rows = pickArray(data, 'boxes').map(mapParBox).filter((b) => Boolean(b.name));
  const def = str(data.default) || rows.find((b) => b.isDefault)?.name || '';
  boxCache = { at: Date.now(), rows, default: def };
  return boxCache;
}

/**
 * ★★ 2026-10-12 建立、2026-10-13 升级：**权威盒子名单**（云端那一份）。
 *
 * 用户报"盒子的数据没有做好同步"：实测**扩展 5 个盒子、云端 2 个**，两边都不报错。
 * 扩展侧的根因是 `parallel.ts` 的盒子列表把"**本地记住的**"取了并集，
 * 而那份名单（`ql:boxes`）**只会被加、不会被减** ⇒ 云端删掉/改名的盒子永远留着。
 *
 * ★ 2026-10-13：返回值从 `{names: string[]}` 换成 `{boxes: ParBox[]}` ——
 *   只给名字已经装不下禁用态 / 站点关联 / 三个 `*able`，而 UI 要靠它们画灰态、
 *   决定给不给按钮。**剪枝仍然按名字**（对账规则在 `shared/box-reconcile.ts`，没变）。
 *
 * ★ 调用方必须容错：**拿不到就什么也别动**（离线时本地那份是唯一的真相）。
 * ★ `force` 默认 false：走 `META_TTL_MS` 缓存，别为一次渲染多打一次网络。
 */
export async function fetchCloudBoxes(force = false): Promise<{ boxes: ParBox[]; default: string } | null> {
  try {
    const { rows, default: def } = await loadBoxes(force);
    return { boxes: rows.filter((b) => Boolean(b.name)), default: def };
  } catch {
    return null;   // ★ 不抛：这是"对账用的参考数据"，取不到不该让任何调用点炸
  }
}

/* ==================== 盒子的三个写动作（2026-10-13 新增） ==================== */

/**
 * 新建盒子（**打到云端**）。
 *
 * ★★ 这条通路此前根本不存在，而 UI 上的「＋ 新建盒子」是**纯本地**的
 *   （`boxes.push(name)` + 写 `ql:boxes`）。自 2026-10-12 起云端名单是权威，
 *   对账会把"云端没有、账号也没用"的名字**剪掉** ⇒ 用户看到的是
 *   "盒子建好了，过一会儿自己没了"，而两边都不报错。
 *
 * ★ 服务端对重名回 409 —— 这里把它转成**可读的中文**，
 *   因为 prompt 之后弹一句 `HTTP 409` 用户无从处置。
 */
async function createBoxOnCloud(name: string): Promise<{ name: string }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('盒子名不能为空');
  }
  const existing = await loadBoxes(true);
  if (existing.rows.some((b) => b.name === trimmed)) {
    throw new Error(`盒子「${trimmed}」已存在`);
  }
  const res = asRecord(
    await cloudRequest<unknown>('/api/boxes', { method: 'POST', body: { name: trimmed } }),
  );
  invalidateCloudCache();
  return { name: str(res.name) || trimmed };
}

/**
 * 禁用 / 启用盒子（**服务端权威**）。
 *
 * ★★ 改前这个动作是**纯本地**的（只写 `ql:disabledBoxes`）—— 于是同一个事实有两个来源：
 *   在网页上禁用的盒子，扩展的轮盘照旧会切到它；在扩展里禁用的，网页不知道。
 * ★ 服务端对默认盒回 **400**（它只随"是否为空"自动禁用）⇒ 这里先在本地拦，
 *   给一句能读懂的话，而不是把 400 原文抛给用户。
 */
async function toggleBoxOnCloud(name: string): Promise<{ disabled: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('盒子名为空');
  }
  const { rows, default: def } = await loadBoxes(true);
  const box = rows.find((b) => b.name === trimmed);
  if (box?.isDefault || trimmed === def) {
    throw new Error('默认盒子不能手动禁用 —— 它只在自己为空时自动跳过');
  }
  const res = asRecord(
    await cloudRequest<unknown>('/api/boxes/toggle', { method: 'POST', body: { name: trimmed } }),
  );
  invalidateCloudCache();
  return { disabled: res.disabled === true };
}

/**
 * 把盒子关联到站点（`siteId` 传空串 = 解除关联）。服务端 2026-10-13 新增的能力。
 *
 * ★ 传别的用户的 `siteId` 服务端回 **404**（不区分"不存在"与"不是你的"）——
 *   与 `own_site` 同口径，这里原样透出即可（它不是用户能自己修的那种错）。
 */
async function bindBoxSiteOnCloud(name: string, siteId: string): Promise<{ siteId: string; changed: boolean }> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('盒子名为空');
  }
  const res = asRecord(
    await cloudRequest<unknown>('/api/boxes/bind-site', {
      method: 'POST',
      body: { name: trimmed, siteId: (siteId || '').trim() },
    }),
  );
  invalidateCloudCache();
  return { siteId: str(res.siteId), changed: res.changed === true };
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

/**
 * 钉住**站点域名解析不了**的那种账号 —— 一起看 `toAccount` 的那条回落链。
 *
 * ★★ v4.2.12：这条链的最后一级 `looksLikeHost(rec.siteName)` **必须留在最后**。
 *   理由不是"顺序好看"，而是一个实测过的缺陷形态：
 *   `siteName` 是**用户起的显示名**（生产库里就有「通桥」「公司配置环境」），
 *   `looksLikeHost()` 用的是 host 正则 ⇒ 中文名一定被拒、`siteHost` 落空串。
 *   而空串会让 `open()` 拼出 `https:///login`、让预绑定的 host 校验恒不通过
 *   （自动填表永远拿不到凭证）——**三处各自静默失败**。
 *   ⇒ 所以 `open()` 现在对空 `siteHost` 直接抛一句可读的错（见那里的注释），
 *     而不是让它在三个下游各自变成"没反应"。
 */
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
    /* ★★ v4.2.12：`siteId` 与 `note` 必须带出来。
     *
     * 缺陷形态（不是"少个字段"那么轻）：`/api/accounts` **本来就返回**这两个
     * （`account_public` 里有 `siteId` / `note`），而这里映射时丢掉了 ⇒
     *   · 编辑账号时**无法**预选中它当前所属的站点（下拉只能随便选一个）
     *     ⇒ 一保存就把账号挪到别的站点去了，而用户什么都没改；
     *   · 在网页控制台写的备注，在扩展里**永远看不到**。
     * 两处都不报错，只是"那一格是空的 / 选中的是错的"。
     * ★ 这是本仓规则 14 的同族：**同一件事不要两处声明** —— 而这里是反过来的，
     *   声明处（服务端）给了，消费处（这里）吞了。 */
    ...(siteId ? { siteId } : {}),
    ...(str(rec.note) ? { note: str(rec.note) } : {}),
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

async function fetchUiState(): Promise<CloudUiState> {
  const data = asRecord(await cloudRequest<unknown>('/api/ui/state'));
  if (str(data.format) !== 'akso-cloud-ui-state') {
    throw new Error('云端 UI 状态格式不识别（可能是旧服务端）');
  }
  const sites = pickArray(data, 'sites').map(mapCloudSite).filter((s) => Boolean(s.id));
  const boxes = pickArray(data, 'boxes').map(mapParBox).filter((b) => Boolean(b.name));
  const defaultBox = str(data.defaultBox) || boxes.find((b) => b.isDefault)?.name || '';
  const siteById = new Map(sites.map((s) => [s.id, s] as const));
  const accounts = pickArray(data, 'accounts')
    .map(asRecord)
    .map((rec) => toAccount(rec, siteById, defaultBox));
  const broken = accounts.filter((a) => !a.id).length;
  if (broken > 0) {
    throw new Error(`云端 UI 状态有 ${broken} 条账号缺少 id：已中止，避免误读列表`);
  }
  return {
    revision: num(data.revision) ?? 0,
    accounts,
    sites: sites.map(siteSummary),
    boxes,
    defaultBox,
  };
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
 *
 * ★★ 2026-10-13：多带一个 **`id`**。盒子的「关联站点」要拿它当 `siteId` 去
 *   `POST /api/boxes/bind-site` —— 服务端按 **id** 认站点，而 UI 平时只认 host
 *   （`siteId` 是库里的主键，`host` 是从 `base_url` 抽出来的）。加字段是兼容的：
 *   两个既有消费方（站点管理栏、导入）只读 `host`/`name`。
 */
async function loadSiteNames(force = false): Promise<CloudSiteSummary[]> {
  const sites = await loadSites(force);
  return sites.map(siteSummary);
}

/**
 * 添加站点时顺带落名：**站点不存在就建**，存在就更新名称。
 *
 * ★ 2026-10-19：随着站点管理改成「编辑」弹窗（`par.updateSite`），
 *   旧的 `par.renameSite`（只改名）**整体删除** —— 留着它就是一条零发送方的死协议。
 *   这个函数仍然保留：站点表单走的是"新建站点"这条路，它必须能创建。
 *
 * ★ 名字为空时回落到 host —— 与用户要求的口径一致（"未填写名称时自动从地址填充"），
 *   也与服务端建站点时的默认名一致（`ms.name.strip() or host`）。
 *
 * ★★ 2026-10-19：`createBox` 只在**真的新建站点**时才生效（用户要求：新增站点时
 *   由用户选择要不要同步建一个同名盒子，默认建）。站点已存在时它没有意义 ——
 *   这里不读它，免得"改个名"顺手再建一个盒子。
 */
async function upsertSiteOnCloud(
  host: string,
  name: string,
  createBox = true,
  scheme: 'http' | 'https' = 'https',
): Promise<void> {
  const wanted = host.trim().toLowerCase();
  const name2 = name.trim() || wanted;
  const sites = await loadSites(true);
  const hit = sites.find((s) => s.host === wanted);
  if (hit) {
    if (hit.name !== name2) {
      await cloudRequest(`/api/sites/${encodeURIComponent(hit.id)}`, {
        method: 'PATCH',
        body: { name: name2 },
      });
      invalidateCloudCache();
    }
    return;
  }
  /* ★★ 2026-10-19：**建站点时一次把名称带上**（不要"先建成 host 名、再 PATCH"）。
   *   服务端的 `create_site` 会拿 `name` 去建同名盒 —— 分两步的话，盒子会叫 host，
   *   而站点卡片显示的是用户起的名字，两端看起来像两个不同的东西。 */
  await cloudRequest('/api/sites', {
    method: 'POST',
    body: { name: name2, baseUrl: `${scheme}://${wanted}`, note: '', createBox },
  });
  invalidateCloudCache();
}

/**
 * ★★ 2026-10-19：**编辑站点**（用户要求扩展的站点管理要有编辑功能）。
 *
 * 只 PATCH 传进来的字段（`undefined` = 不动）。`baseUrl` 是唯一会**改变 host**
 * 的字段 —— 服务端会重新跑域名预处理并记住协议，账号仍按 `site_id` 关联，
 * 所以这里不替调用方做"要不要改地址"的判断，只如实转发。
 */
async function updateSiteOnCloud(
  siteId: string,
  patch: { name?: string; baseUrl?: string; note?: string },
): Promise<CloudSiteSummary> {
  const id = siteId.trim();
  if (!id) {
    throw new Error('缺少站点 id，无法保存');
  }
  const body: Record<string, string> = {};
  if (patch.name !== undefined) {
    body.name = patch.name;
  }
  if (patch.baseUrl !== undefined) {
    body.baseUrl = patch.baseUrl;
  }
  if (patch.note !== undefined) {
    body.note = patch.note;
  }
  if (!Object.keys(body).length) {
    throw new Error('没有要修改的字段');
  }
  await cloudRequest(`/api/sites/${encodeURIComponent(id)}`, { method: 'PATCH', body });
  invalidateCloudCache();
  const hit = (await loadSites(true)).find((s) => s.id === id);
  if (!hit) {
    throw new Error('站点已保存，但重新读取时找不到它（请刷新确认）');
  }
  return {
    id: hit.id,
    host: hit.host,
    name: hit.name,
    displayName: hit.displayName,
    baseUrl: hit.baseUrl,
    note: hit.note,
    accountCount: hit.accountCount,
  };
}

/**
 * ★★ v4.2.7（用户要求）：「当我在扩展中添加了一个站点时，云端也会同步增加一个站点，
 * 但是当我删除一个站点时，云端不会删除站点。」
 *
 * ⇒ 补上云端删除。**服务端那条 `DELETE /api/sites/{id}` 会级联删掉该站点下的所有账号**
 *   （复合外键 `ON DELETE CASCADE`），所以：
 *   · **调用前必须由调用方确认该站点没有账号** —— 这里只做"如实返回删掉了几个账号"，
 *     不替调用方做决定（服务端也把它当返回值给出来，正是为了不被静默）。
 *   · 云端**没有**这条站点记录时不当失败（`kind: 'missing'`）：本机删掉一个从没同步过的
 *     站点是完全正常的路径，报错会让用户以为删除失败。
 */
/**
 * ★★ v4.2.12：这个类型**搬到了 `shared/types.ts`**，这里只 re-export 一次。
 *
 * 理由不是洁癖：`shared/messages.ts` 的 `par.deleteSite` 响应要写它的类型，
 * 而 `shared/` 里**不应该** import `background/`（那是分层倒置）。放到共享层之后
 * 三处（协议、数据层、UI）指的是**同一个声明**，改字段时不会再出现"一边改了另一边没改"。
 */
export type { CloudDeleteSiteResult } from '../../shared/types';


/* ★★ v4.2.9：**这里不需要"剥端口"那种宽容匹配** —— 我一度加了它，随后自己删掉了。
 *
 * 经过（值得记，因为它是我这一轮的一个误判）：
 *   我怀疑"云端记录的 host 带端口、而 UI 从 Chrome 权限清单拿到的 host 不带端口"
 *   ⇒ 精确匹配失败 ⇒ 不发 DELETE。**实测不成立**：
 *     · `hostOfUrl('https://ported.example:9443')` ⇒ `ported.example:9443`（保留端口）
 *     · 而**站点列表的键也来自同一个 `hostOfUrl`** ⇒ 云端记录与 UI 传下来的 host
 *       **本来就是同一个字符串**（都带端口）⇒ 精确匹配成立。
 *     · `granted.example` 那条同理（两边都不带端口）。
 *
 * ★ 为什么删掉而不是留着"以防万一"：加了它之后**没有任何判据能变红**
 *   （反证过：把回落删掉，H3 照样绿）⇒ 那是一段**永远不被走到**的代码。
 *   本仓对这类东西的态度见 `docs/PITFALLS.md` #30（"接口摆在那里 ≠ 它被接上了"）：
 *   **不做无判据的防御**，否则读代码的人会以为存在一种它其实防不住的形态。
 *
 * ★ 那用户报的"删除站点时云端不删"到底为什么？是**另一件事**（v4.2.7/v4.2.9 各修一半）：
 *   ① `needsGrant` 那一态只 `hideHost` 就 `continue`，**根本走不到删云端的代码**（判据 E3 抓到）；
 *   ② 站点列表把**云端自己**那条记录也算了进来（`isCloudHost` 漏了端口这一维）。
 */
async function deleteSiteOnCloud(host: string, force = false): Promise<CloudDeleteSiteResult> {
  const wanted = host.trim().toLowerCase();
  let id: string | undefined;
  try {
    const sites = await loadSites(true);
    id = sites.find((s) => s.host === wanted)?.id;
  } catch (e) {
    // 拿不到站点清单（离线/未授权）⇒ **如实报 offline**，不伪装成"删掉了"
    return { kind: 'offline', reason: e instanceof Error ? e.message : String(e) };
  }
  if (!id) {
    return { kind: 'missing' };
  }
  try {
    const qs = force ? '?force=true' : '';
    const res = asRecord(
      await cloudRequest<unknown>(`/api/sites/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' }),
    );
    invalidateCloudCache();
    /*
     * ★★ v4.2.12 修一个**静默缺陷**：这里原来读的是 `accountsDeleted` / `accounts_deleted`，
     *   而服务端 `sites.py` 返回的字段名是 **`deletedAccounts`**（它的注释写明
     *   "必须如实告诉调用方删了几个账号"）。
     *   ⇒ 两边都不报错，只是这个数字**恒为 0**：级联删掉 12 个账号时，
     *     界面会说"已删除站点（0 个账号）" —— 而 `service-worker.ts` 的注释还写着
     *     "把服务端回报的 accountsDeleted 原样透传，让 UI 能如实告知"。
     *   ★ 判据：`tools/verify/verify-boxsync.mjs` 的同类断言（读名字必须与服务端一致）。
     */
    const n = Number(res.deletedAccounts ?? res.accountsDeleted ?? res.accounts_deleted ?? 0);
    return { kind: 'deleted', accountsDeleted: Number.isFinite(n) ? n : 0 };
  } catch (e) {
    if (isOfflineError(e)) {
      return { kind: 'offline', reason: e instanceof Error ? e.message : String(e) };
    }
    /*
     * ★★ v4.2.12：**409 是一支正常分支，不是错误**。
     *
     * 服务端在"站点下还有账号且没带 force"时回 409，而那个响应体里带着
     * `accountCount` 与 `usernames` —— 它就是为了让调用方能把话说具体
     * （`sites.py` 的注释：只回一个数字的话，前端只能说"有 12 个账号"；
     * 说得出是哪 12 个，才能让人真的停下来看一眼）。
     *
     * 改前这一支没有对应状态 ⇒ 它以 `Error('云端请求失败（HTTP 409）：{...}')`
     * 冒到 UI，把服务端的 JSON 摊在用户脸上，而**级联删除这个后果从未被摊开确认**。
     */
    const detail = (e as { detail?: unknown })?.detail;
    const structured = asRecord(detail);
    if (structured.code === 'site_has_accounts') {
      return {
        kind: 'blocked',
        accountCount: Number(structured.accountCount ?? 0) || 0,
        usernames: Array.isArray(structured.usernames) ? structured.usernames.map((u) => String(u)) : [],
      };
    }
    throw e;
  }
}

/**
 * 站点按 host 找；找不到就建一个（服务端会对 baseUrl 做域名预处理，所以建完以 id 为准）。
 *
 * ★ 2026-10-19：`createBox` 透传给 `POST /api/sites`。**账号创建路径传 `false`** ——
 *   那是"为账号补建站点"，用户没在这一步被问过"要不要建盒"，
 *   替他建一个同名盒属于**未确认的副作用**（盒子是用户在盒子管理里显式管理的东西）。
 *   站点表单那条路径才传用户勾选的值。
 */
async function ensureSite(host: string, scheme?: 'http' | 'https', createBox = false): Promise<string> {
  const wanted = host.trim().toLowerCase();
  const sites = await loadSites(true);
  const hit = sites.find((s) => s.host === wanted);
  if (hit) {
    return hit.id;
  }
  const created = asRecord(
    await cloudRequest<unknown>('/api/sites', {
      method: 'POST',
      body: { name: wanted, baseUrl: `${scheme ?? 'https'}://${wanted}`, note: '', createBox },
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

  /**
   * ★★★ v4.2.12：**账号编辑**（六样字段，与云端控制台的编辑弹窗一一对应）。
   *
   * 服务端的 `PATCH /api/accounts/{id}`（`AccountPatch`）本来就能改这六样，
   * 缺的只是"扩展这一侧把它们传下去"。三条语义细节见 `par.update` 的注释。
   *
   * ★ 为什么在这里（而不是让 UI 自己拼 PATCH）：本仓的 UI **从不直接 fetch 云端**
   *   （`src/ui/` 下零 `cloudRequest`）。UI 破例直连会绕过授权、令牌与离线回落三样，
   *   而且**失败形态是静默的**（UI 里一个 `catch {}` 就看不出来了）。
   */
  async updateAccount(
    id: string,
    patch: {
      username?: string;
      tabName?: string;
      siteId?: string;
      box?: string;
      password?: string;
      note?: string;
    },
  ): Promise<ParallelAccount> {
    const body: Record<string, unknown> = {};
    if (patch.username !== undefined) {
      const u = patch.username.trim();
      if (!u) {
        throw new Error('账号名不能为空');
      }
      body.username = u;
    }
    if (patch.tabName !== undefined) {
      body.tabName = patch.tabName.trim();
    }
    if (patch.siteId !== undefined && patch.siteId) {
      body.siteId = patch.siteId;
    }
    if (patch.box !== undefined) {
      // 空串与"默认盒名"都翻成服务端的存储形态（空串 = 未归盒）
      body.box = await uploadBoxName(patch.box);
    }
    if (patch.password !== undefined) {
      /* ★ **空串 = 不改**，不是"清空"。
       *   判定放在这里而不是调用点：它是这条通路自己的语义，第二个调用方
       *   （导入、脚本、以后的界面）不该各自决定一次 —— 而"没填就把密码清了"
       *   的表现是**下次打开账号填表静默失效**，没有任何报错。 */
      const pw = patch.password;
      if (pw) {
        body.password = pw;
      }
    }
    if (patch.note !== undefined) {
      body.note = patch.note;
    }
    if (!Object.keys(body).length) {
      return getOne(id); // 什么都没改：**不发请求**（服务端每次 PATCH 都会推 revision）
    }
    await patchAccount(id, body);
    return getOne(id);
  },

  /**
   * ★ v4.2.12：批量删除账号（走服务端那一条 `POST /api/accounts/batch-delete`）。
   * 见 `par.batchDelete` 的注释：不走"循环发 N 个 DELETE"。
   */
  async batchDelete(ids: string[]): Promise<number> {
    const clean = [...new Set(ids.filter(Boolean))];
    if (!clean.length) {
      return 0;
    }
    const res = asRecord(
      await cloudRequest<unknown>('/api/accounts/batch-delete', { method: 'POST', body: { ids: clean } }),
    );
    invalidateCloudCache();
    // 服务端可能回 `deleted` 或 `count`（两处都读一次，别让字段名漂了之后数字恒为 0）
    return num(res.deleted) ?? num(res.count) ?? 0;
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
    /*
     * ★★ 2026-10-13：**默认盒不能改名**，先在本地拦。
     *
     * 服务端从 2026-10-13 起对 `source` 为空/等于默认盒名的请求回 **400**
     * （默认盒的名字是常量「默认盒子」，"改它"这件事在语义上已不存在）。
     * 而扩展的芯片上**仍然给默认盒画了 ✎** ⇒ 用户点下去必然失败。
     * ⇒ 两道：(a) UI 侧按 `renameable` 不给入口（见 parallel.ts）；
     *          (b) 这里再拦一次，保证**任何**调用路径都拿到一句能读懂的话，
     *              而不是 `HTTP 400`×或一次静默的空操作。
     * ★ 为什么不只做 (a)：UI 不是唯一调用方（导入、脚本、以后的新界面）。
     */
    const { rows, default: def } = await loadBoxes(true);
    if (fromName === def || rows.find((b) => b.name === fromName)?.isDefault) {
      throw new Error('默认盒子不能改名 —— 它是固定的默认盒（只能往里面放账号）');
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

  /** 站点清单（host ↔ 用户自定义名称），见 `loadSiteNames` 的说明（★ 2026-10-13 起含 `id`） */
  async listSites(force = false): Promise<CloudSiteSummary[]> {
    return loadSiteNames(force);
  },

  /** 一次原子读取账号/站点/盒子（见 `fetchUiState` 的说明） */
  async uiState(): Promise<CloudUiState> {
    return fetchUiState();
  },

  /** 添加站点时落名（站点不存在就建），见 `upsertSiteOnCloud` 的说明 */
  async upsertSite(host: string, name: string, createBox = true, scheme: 'http' | 'https' = 'https'): Promise<void> {
    return upsertSiteOnCloud(host, name, createBox, scheme);
  },

  /** ★ 2026-10-19：编辑站点（名称 / 地址 / 备注），见 `updateSiteOnCloud` 的说明 */
  async updateSite(
    siteId: string,
    patch: { name?: string; baseUrl?: string; note?: string },
  ): Promise<CloudSiteSummary> {
    return updateSiteOnCloud(siteId, patch);
  },

  /** ★ v4.2.7：删云端站点（**级联删账号**），见 `deleteSiteOnCloud` 的说明
   *  ★ v4.2.12：多一个 `force` —— 见 `CloudDeleteSiteResult` 的四态说明 */
  async deleteSite(host: string, force = false): Promise<CloudDeleteSiteResult> {
    return deleteSiteOnCloud(host, force);
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

  /* ---------------- 盒子的三个写动作（2026-10-13 新增，见各自的函数注释） ---------------- */

  /** 新建盒子（打到云端 —— 纯本地建会被对账剪掉，见 `createBoxOnCloud`） */
  async createBox(name: string): Promise<{ name: string }> {
    return createBoxOnCloud(name);
  },

  /** 禁用/启用（服务端权威；默认盒由服务端 400 拒绝，这里先拦） */
  async toggleBox(name: string): Promise<{ disabled: boolean }> {
    return toggleBoxOnCloud(name);
  },

  /** 关联/解除关联站点（`siteId` 空串 = 解除） */
  async bindBoxSite(name: string, siteId: string): Promise<{ siteId: string; changed: boolean }> {
    return bindBoxSiteOnCloud(name, siteId);
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
