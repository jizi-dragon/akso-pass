import { CONTENT_MESSAGE, LOCAL_KEYS, SESSION_KEYS } from '../../shared/constants';
import type { Scheme } from './site-auth';
import type { BridgeDownPayload, BridgeSender, BridgeUpPayload, ParallelAccount } from '../../shared/types';
import { setTabTitle } from '../tabs/tab-title';
import { parallelStore, resolveAccountPlaintext } from './parallel-store';
import { tabRules, parentDomainOf, hostNoPortOf } from './tab-rules';
// ★ 打码要在**通道**上做，所以要在这里 import 它。
//   用 `shared/redact`（而非 `shared/log`）是为了**不把 logger 拖进来**：
//   本文件不需要 logger，只需要那个纯函数 —— 而 `redact.ts` 是无依赖的。
import { redact, redactDetail } from '../../shared/redact';
// ★ 热路径用的内存日志。与 `diag()`/`forensics()` 的分工见 `isEnforceable` 里的表。
import { getLogger } from '../../shared/log';

/**
 * 本模块的 logger。
 *
 * ★ 用它打**热路径**（每次调用都会走到的地方）—— 它写内存环形 200 + DevTools，
 *   默认 `info` 级 ⇒ 生产静默、零存储开销。
 * ★ `diag()`（下面那个）只留给**罕见但关键**的事件：失败 / 降级 / 状态跃迁。
 *   两处不要混用，否则 `ql:diag` 的环形 60 会被噪声刷满，
 *   而真实失败（如 DNR 规则装不上）就看不见了。
 */
const log = getLogger('parallel-session');

/**
 * 「多平面隔离」运行时编排（纯扩展多账号并行，见 docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md §4）：
 * - 存储平面：MAIN 壳把绑定标签页的 localStorage / document.cookie 重定向到账号命名空间；
 *   桥接脚本上报 `__auth_token__` 等键的写入 → 本模块捕获 token 快照。
 * - 网络平面：每绑定标签两条 DNR 规则——Authorization 改写 + 出站 Cookie 头剥离（v3 新增，
 *   封堵「真实 jar = 最后登录者」的串号通道）。
 * - 授权健康：host 缺少浏览器授权或被手动停用时，网络平面整体关闭并在 UI 显著提示。
 */

interface ParBinding {
  accountId: string;
  host: string;
  /** 亲子继承页签（v3.9.6 window.open/_blank）——进入登录页时自动转原始页签（v3.10.4） */
  adopted?: boolean;
}

interface TokenSnapshot {
  token?: string;
  authUser?: string;
  deviceFp?: string;
  /**
   * 登录时点的站内 Cookie 快照（含 HttpOnly，经 chrome.cookies 读取；身份类黑名单除外，
   * 见 IDENTITY_COOKIE_BLACKLIST）。用于 DNR Cookie 头「按账号回放」（v3.6 对齐 SessionBox
   * 核心机制）：绑定标签页的出站请求不再依赖共享真实 jar，服务端始终看到一致会话身份。
   * 仅在该账号首次捕获 token（即登录刚完成、jar 尚未被后续登录污染）时采集。
   */
  cookies?: { name: string; value: string }[];
}

const bindings = new Map<number, ParBinding>();
/** 亲子继承候选（v3.13 加固）：URL 未确认授权前不发种子/不装规则；
 *  expires 超时未导航（如停留在 about:blank）则自动放弃并通知壳回直通。 */
const pendingAdoptions = new Map<number, { accountId: string; host: string; expires: number }>();
const PENDING_ADOPT_TTL = 30_000;
/**
 * 继承页签落登录页时的「重来额度」（按页签计，绑定生命周期内不重置）。
 *
 * 见 `onNavigation` 里那段长注释：落登录页既可能是"用户要用这个页签登录别的号"，
 * 也可能是"我们自己的种子晚到了一步、平台 SPA 401 后自己跳的"。
 * 后者重灌一次种子就能恢复，不该当终局。额度用完才按 v3.10.4 转原始页签。
 */
const loginGrace = new Map<number, number>();
const LOGIN_GRACE_LIMIT = 2;
/**
 * 「新页签亲缘待判」窗口（v4.2.27 / PITFALLS #51）。
 *
 * ★ `tabs.onCreated` 里的 `openerTabId` 有**两种语义**，长得一模一样：
 *   ① 站点自己开窗（`window.open` / `target=_blank`）—— opener 就是真实来源页签；
 *   ② 用户复制页签（右键「复制」/ `chrome.tabs.duplicate`）—— opener 是**复制那一刻
 *      的前台页签**，不是被复制的页签。实测：前台是 B 页签（账号 B），复制后台的
 *      A 页签（账号 A），新页签的 `openerTabId` 指向 **B**。
 *   旧实现一律按 ① 处理，于是复制出来的页签被收编成**前台那个账号**（串号），
 *   或在前台页签未绑定时连候选都没有 ⇒ 永久直通 ⇒ 平台读不到 token ⇒ 直接跳登录页。
 *
 * ⇒ 判据（都是同步/近同步信号，无需新权限）：
 *   · `onCreated` 时 `pendingUrl` 还没落地（空 / about:blank）= 站点开窗的典型形态
 *     ⇒ 立刻按 `openerTabId` 继承（不等，避免拖慢种子下发）；
 *     ~1ms 后 `webNavigation.onCreatedNavigationTarget` 还会带真实 `sourceTabId`，
 *     若它到了而 opener 指向的是前台页签，以 `sourceTabId` 为准（见 decideAdoption）。
 *   · `onCreated` 时 `pendingUrl` **已经是源 URL** = 复制页签（或提交极快的新窗）
 *     ⇒ 挂进本表等 40ms 看上面那个事件，再决定"按 sourceTabId / 相邻源页签继承"。
 *     判不出来就保持原生 —— 宁可让用户自己点一下，也绝不串号。
 */
const adoptProbe = new Map<number, { openerId: number; at: number }>();
/** 站点开窗的同步证据：新页签 tabId → 真实来源 tabId（`onCreatedNavigationTarget` 写入） */
const pageOpenTargets = new Map<number, number>();
/**
 * ★★ v4.2.28：**正在导航**的判据 —— `tab.pendingUrl` 与 `tab.url` 不一致。
 *
 * 为什么不用 `tabs.onUpdated status='loading'` 记一张表：实测（`tmp/dbg-nav.mjs`）
 * 从 A 页 `tabs.update` 到"响应头被拖住"的 B 页时，**根本没有 'loading' 事件**送来
 * （只来了一次 'complete'）—— 大概率是 SW 睡眠期间的同类事件被合并/丢弃。
 * 拿它当判据会让"导航在途"漏判，而漏判的后果正是这条守护要防的那件事。
 * `tabs.get()` 里的 `pendingUrl` 是**当时的状态**、不依赖事件投递，所以以它为准。
 */
function isNavigating(tab: chrome.tabs.Tab): boolean {
  const pending = (tab.pendingUrl || '').trim();
  const current = (tab.url || '').trim();
  return Boolean(pending) && pending !== current;
}
/** 待判窗口：够 `onCreatedNavigationTarget` 落地（实测 ~1ms），又不明显拖慢站点开窗 */
const ADOPT_PROBE_DELAY = 40;
/** 待判表兜底 TTL：页签被立刻关掉、或事件没来时靠它清 */
const ADOPT_PROBE_TTL = 10_000;
/**
 * 冷启动门（v4.2.27）：`registerParallelHandlers()` 里那次 `restore()` 是 `void` 异步，
 * 而 `tabs.onCreated` / 壳的 `hello` 完全可能赶在它完成之前到达 —— 那段时间 `bindings`
 * 是**空的**，父子继承必然被误判成"没有父绑定"（症状：冷启动后头几个新页签丢账号）。
 * 所有要读 `bindings` 的入口先 await 这道门；`restore()` 记忆化，只跑一次。
 */
let readyPromise: Promise<void> | undefined;
const tokens = new Map<string, TokenSnapshot>();
/** 授权健康缓存：host → 是否可执行（已授权且未被手动停用） */
const enforcement = new Map<string, boolean>();
/** MAIN 壳 Cookie 袋的命名空间键名（与 shield-main.ts 的 COOKIE_BAG_KEY 一致） */
const COOKIE_BAG_KEY = '__ql_cookies__';

/** 诊断埋点：写入 storage.local['ql:diag']（环形 60 条），供 E2E 台架经扩展页读取 */
async function diag(msg: string): Promise<void> {
  try {
    const key = 'ql:diag';
    const cur = (await chrome.storage.local.get(key))[key] as string[] | undefined;
    // ★ 落盘前强制打码（见 `forensics` 的说明）。
    const line = redact(`${new Date().toISOString().slice(11, 23)} ${msg}`);
    const next = [...(cur ?? []).slice(-59), line];
    await chrome.storage.local.set({ [key]: next });
  } catch {
    // 埋点失败不影响业务
  }
}

/**
 * 登录失败现场取证（v3.12.2）：结构化事件写入 `storage.local['ql:forensics']`
 * （环形 120 条）。与 diag（人读文本）并行；管理页「导出诊断包」一键取走。
 *
 * ## ★★ 2026-10-09：这个函数原先**绕过了打码通道**
 *
 * 它是"第三个日志出口"，却既不经过 `shared/log.ts`、也不做任何打码 ——
 * 而它的产物会**进诊断包被一键导出**。原来的安全假设写在
 * `content/auto-login.ts` 的注释里："密码/用户名绝不入日志"。
 *
 * 实测那 7 个调用点**当时确实没有传凭据**（只传 `attempts` / `reason` / `errorSeen`），
 * 所以**没有实际泄露**。但那条保证是**约定，不是机制** ——
 * 它靠的是下一个人记得住，而载荷的来源是
 * `{ tabId: sender.tab?.id, ...p }`，`p` 完全由**内容脚本**决定。
 *
 * ⇒ 现在打码落在**通道上**（与 `shared/log.ts` 同一条纪律）：
 *   键名敏感的直接替换、字符串值再过一遍值形状规则。这样"不小心传了凭据"
 *   不再等于"凭据落盘"。
 *
 * ★ 判据：`tools/verify/verify-log-redaction.mjs` 的 forensics 一节
 *   （构造一个含 `password` 的事件，断言落盘的是 `«已打码»`）。
 */
export async function forensics(ev: string, detail: Record<string, unknown> = {}): Promise<void> {
  try {
    const key = LOCAL_KEYS.forensics;
    const cur = (await chrome.storage.local.get(key))[key] as
      | { t: number; ev: string; [k: string]: unknown }[]
      | undefined;
    const next = [
      ...(cur ?? []).slice(-119),
      { t: Date.now(), ev: redact(ev), ...(redactDetail(detail) as Record<string, unknown>) },
    ];
    await chrome.storage.local.set({ [key]: next });
  } catch {
    // 取证失败不影响业务
  }
}

async function readBlockedHosts(): Promise<Set<string>> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  return new Set((stored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);
}

/** 检查某 host 的网络平面是否可执行（带缓存的授权 + 封锁名单判定） */
async function isEnforceable(host: string): Promise<boolean> {
  const cached = enforcement.get(host);
  if (cached !== undefined) {
    // ★★★ 2026-10-09：这行**从 `diag()` 降级为 `log.debug()`**。
    //
    // 它原先每次缓存命中就写一次——而 `isEnforceable` 在**每一次导航 / 每一次
    // 请求判定**上都会被调用 ⇒ 这是个**热路径**。
    //
    // 代价不是"日志多"，而是**把有用的日志挤掉**：`ql:diag` 是**环形 60**
    // （`background/core/tab-rules.ts` 与 `parallel-session.ts` 共写同一个键），
    // 而写它的有 45 个调用点。也就是说 ——
    // **`addRule #N 失败`（DNR 规则装不上，历史上整个网络平面因此一起死过）
    // 会在几秒内被这一类"缓存命中"刷出缓冲。**
    //
    // ⇒ 分工是有意的，不是顺手：
    //   | 通道 | 存储 | 用途 |
    //   |---|---|---|
    //   | `log.debug()` | 内存（环形 200）+ DevTools | **热路径轨迹**。默认 `info` 级 ⇒ 生产静默、零存储开销 |
    //   | `diag()` | `storage.local`（环形 60） | **罕见但关键的事件**（失败 / 降级 / 状态跃迁） |
    //   | `forensics()` | `storage.local`（环形 120） | **结构化事件**（可按字段过滤、进诊断包） |
    //
    // ★ 判据：`diag()` 里**不该出现"每次调用都会走到"的行**。
    //   已由 `verify-log-redaction.mjs` 第 6 节的闭环检查附近约定（见 AGENTS.md 规则 22）。
    log.debug('isEnforceable(%s) → 缓存 %s', host, cached);
    return cached;
  }
  const blocked = await readBlockedHosts();
  if (blocked.has(host)) {
    enforcement.set(host, false);
    void diag(`isEnforceable(${host}) → false（本地停用名单）`);
    return false;
  }
  let granted = false;
  try {
    granted = await chrome.permissions.contains({ origins: [`*://${host}/*`] });
  } catch {
    granted = false;
  }
  // 更宽泛的通配授权也算可用
  if (!granted) {
    try {
      granted = await chrome.permissions.contains({ origins: ['*://*/*'] });
    } catch {
      granted = false;
    }
  }
  enforcement.set(host, granted);
  void diag(`isEnforceable(${host}) → ${granted}（permissions.contains 实查）`);
  return granted;
}

/** 强制刷新授权缓存（授权增撤后调用） */
export function invalidateEnforcementCache(): void {
  enforcement.clear();
}

/** 预热授权健康缓存（par.list 调用，供 statusOf 同步读取；isEnforceable 有缓存，稳态开销近零） */
export async function warmEnforcementCache(hosts: string[]): Promise<void> {
  await Promise.all([...new Set(hosts)].map((h) => isEnforceable(h).catch(() => undefined)));
}

async function readState(): Promise<void> {
  const [bindStored, tokenStored] = await Promise.all([
    chrome.storage.session.get(SESSION_KEYS.parTabBindings),
    chrome.storage.session.get(SESSION_KEYS.parTokens),
  ]);
  bindings.clear();
  const bindMap = bindStored[SESSION_KEYS.parTabBindings] as Record<string, ParBinding> | undefined;
  if (bindMap) {
    for (const [tabId, b] of Object.entries(bindMap)) {
      bindings.set(Number(tabId), b);
    }
  }
  tokens.clear();
  const tokenMap = tokenStored[SESSION_KEYS.parTokens] as Record<string, TokenSnapshot> | undefined;
  if (tokenMap) {
    for (const [id, t] of Object.entries(tokenMap)) {
      tokens.set(id, t);
    }
  }
}

async function persistBindings(): Promise<void> {
  const map: Record<string, ParBinding> = {};
  for (const [tabId, b] of bindings) {
    map[String(tabId)] = b;
  }
  await chrome.storage.session.set({ [SESSION_KEYS.parTabBindings]: map });
}

async function persistTokens(): Promise<void> {
  const map: Record<string, TokenSnapshot> = {};
  for (const [id, t] of tokens) {
    map[id] = t;
  }
  await chrome.storage.session.set({ [SESSION_KEYS.parTokens]: map });
}

/* ---------------- 标题与待登录凭证（复用既有内容脚本协议） ---------------- */

async function applyTitle(tabId: number, tabName: string): Promise<void> {
  await setTabTitle(tabId, tabName);
  try {
    await chrome.tabs.sendMessage(tabId, { type: CONTENT_MESSAGE.setTitle, alias: tabName });
  } catch {
    // 内容脚本未就绪：标题已权威写入；后续 onUpdated 会再推
  }
}

/** 与 navigation.ts 相同约定的待登录凭证缓存（auto-login 内容脚本按 tabId 拉取） */
async function setPendingAutoLogin(tabId: number, username: string, password: string): Promise<void> {
  await chrome.storage.session.set({
    [`${SESSION_KEYS.pendingAutoLogins}:${tabId}`]: { username, password, at: Date.now() },
  });
}

function boundTabsOf(accountId: string): number[] {
  const out: number[] = [];
  for (const [tabId, b] of bindings) {
    if (b.accountId === accountId) {
      out.push(tabId);
    }
  }
  return out;
}

/* ---------------- token 捕获 → DNR 规则同步（网络平面写入点） ---------------- */

async function captureToken(accountId: string, host: string, rawToken: string): Promise<void> {
  const token = rawToken.startsWith('Bearer ') ? rawToken.slice(7).trim() : rawToken.trim();
  if (!token || !/^[\w-]+\.[\w-]+\.[\w-]*$/.test(token)) {
    return; // 仅接受形如 JWT 的值，避免把页面噪声写进规则
  }
  const snap = tokens.get(accountId) ?? {};
  if (snap.token === token) {
    return; // 去重
  }
  // 异账号护栏（v3.10.3/3.10.4）：绑定页签内登录了另一个账号 → 不更新本账号
  // 快照（authHeader 嗅探通道同样拦截），由 storageWrite 通道的叛逃处置统一接管。
  // v3.10.4：改用「剥离时效字段后的整个 payload」比对——不依赖具体 claim 名
  //（真实平台 token 的身份字段名各异，逐 claim 提取会全部落空导致护栏失效）
  if (snap.token) {
    const oldId = jwtStableIdentity(snap.token);
    const newId = jwtStableIdentity(token);
    if (oldId && newId && oldId !== newId) {
      void diag(`captureToken(${accountId}) 拦截异账号 token（身份主体变更）`);
      return;
    }
  }
  const isFirstCapture = !snap.token; // 首次捕获 = 登录刚完成：此刻真实 jar 即该账号会话
  snap.token = token;
  tokens.set(accountId, snap);
  await persistTokens();
  void forensics('token-captured', {
    accountId,
    first: isFirstCapture,
    tokenLen: token.length,
    cookieCount: snap.cookies?.length ?? 0,
  });
  // 快照触发必须在 captureToken 内部：token 首捕可能来自 authHeader 嗅探（早于
  // storageWrite 事件），两条通道都必须覆盖，否则错过登录时点（v3.6.1 修复）
  if (isFirstCapture) {
    await snapshotLoginCookies(accountId, host);
  }
  await syncAccountRules(accountId, host);
}

/* ---------------- 身份叛逃检测与处置（v3.10.3） ----------------
 * 场景：用户在轮盘登录账号 A（绑定页签），随后新开页签（低代码平台 window.open 或
 * target=_blank 带 opener → 被 v3.9.6 亲子继承绑定为 A）手输网址登录账号 B——
 * B 的登录发生在 A 的绑定/命名空间内：token/user 写进 A 的命名空间（持久化，关页签
 * 不清），captureToken 还会把 A 的快照 token 换成 B 的 → 双向身份污染（A 页显示 B 的
 * 名字/A 的权限等乱象），且关光页签重开也无法恢复。
 * 原则（与 3.10.2 一致）：原始登录与快速登录互不冲突——用户在页签里登录了别的账号，
 * 说明该页签被用户「征用」为原始浏览器：转为原始页签（回滚其命名空间写入 → 解绑 →
 * 重载），B 的会话走真实 jar 天然成立；账号 A 的快照与其它页签零污染。
 */

/** 解码 JWT 载荷并剥离时效性字段（exp/iat/nbf/jti/sid 等），返回稳定载荷的规范化串。
 *  与 jwtIdentity 的逐 claim 提取不同，本函数不依赖任何具体字段名——
 *  同一账号的 token 轮换（仅时效字段变化）稳定载荷相同，异账号必然不同。
 *  v3.12.3：**`authcode` 加入时效集**——实测平台（Akso eGMP）token 载荷含每次签发
 *  都重新生成的 `AuthCode`（GUID），不在排除集时同账号的「登录轮换」会被身份护栏
 *  误判为异账号 token 而拒绝记录 → 快照卡死旧 token → API 全 401 → 反复登录失败
 *  （用户实测「退出→关页→再快捷登录登不上，第二次重开才好」的根因，现场实锤）。 */
function jwtStableIdentity(token: string): string | null {
  try {
    const part = token.split('.')[1];
    if (!part) {
      return null;
    }
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const claims = JSON.parse(json) as Record<string, unknown>;
    if (typeof claims !== 'object' || claims === null) {
      return null;
    }
    const VOLATILE = new Set([
      'exp',
      'iat',
      'nbf',
      'jti',
      'sid',
      'auth_time',
      'loginTime',
      'timestamp',
      'nonce',
      // 每次签发都变化的平台自定义字段（实测 AuthCode = 每次登录/轮换重新生成的 GUID）
      'authcode',
      'authCode',
      'AuthCode',
    ]);
    const stable: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(claims)) {
      if (!VOLATILE.has(k)) {
        stable[k] = v;
      }
    }
    return sortedStringify(stable);
  } catch {
    return null;
  }
}

/** 键序无关的规范化序列化（载荷键序因签发实现而异，需消除其影响） */
function sortedStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => sortedStringify(v)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${sortedStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 提取 __auth_user__ 值中的用户名主体；**不可解析/无标准字段时返回 null**（护栏放行）。
 *  v3.12.0 防误判：旧实现返回 JSON 原文——原文里的时间戳/字段序差异会让同账号的
 *  两次写入被判「主体变更」→ defectTabToRaw 解绑重载 → 登录成功即被踢回登录页。 */
function authUserIdentity(value: string): string | null {
  try {
    const obj = JSON.parse(value) as Record<string, unknown>;
    for (const key of ['username', 'userName', 'loginName', 'account', 'name', 'mobile', 'phone', 'email', 'uid', 'userId', 'id']) {
      const v = obj[key];
      if (typeof v === 'string' && v) {
        return v;
      }
      if (typeof v === 'number') {
        return String(v);
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 身份叛逃处置：把「被用户用于登录另一账号」的绑定页签转回原始页签。
 * 1. 回滚该页签本页会话对命名空间的全部写入（journalRollback，含 Cookie 袋）；
 * 2. 清扫该账号命名空间的 IDB/CacheStorage（叛逃会话写入的他人缓存）；
 * 3. 治愈账号快照（清除可能被叛逃写入的 authUser；token 由护栏保证未被替换）；
 * 4. 给该账号其余绑定页签重灌种子（覆盖种子键，防御性）；
 * 5. 解绑 + 重载 → 页签成为原始页签，B 的会话在真实 jar 中原生成立。
 */
async function defectTabToRaw(tabId: number, accountId: string, host: string, reason: string): Promise<void> {
  void diag(`defect(${tabId}) 账号=${accountId} @${host} 身份叛逃（${reason}）→ 转为原始页签`);
  void forensics('defect', { tabId, accountId, reason });
  await pushDown(tabId, { op: 'journalRollback' });
  await pushDown(tabId, { op: 'nsWipeShared' });
  const snap = tokens.get(accountId);
  if (snap) {
    delete snap.authUser;
    tokens.set(accountId, snap);
    await persistTokens();
  }
  for (const other of boundTabsOf(accountId)) {
    if (other !== tabId) {
      await pushBind(other); // 防御性重灌：种子键恢复为本账号值
    }
  }
  await parallelSession.unbindTab(tabId);
  void chrome.tabs.reload(tabId).catch(() => undefined);
}

/**
 * 身份类 Cookie 黑名单：这些名字由平台 JS 写入真实 jar（普通/未接管页签无虚拟化保护），
 * 值 = 「jar 里最后写它的那个账号」。快照若包含它们，回放就会把别人的身份带给本账号
 * 的请求（3.7.2 修复：真实环境复现「普通用户获得管理员」——普通页签登录态残留 jar，
 * 被下一次任意账号的登录时点快照打包）。回放只需 WAF 会话对等非身份 Cookie。
 */
const IDENTITY_COOKIE_BLACKLIST = new Set(['__auth_token__', '__auth_user__', '__device_fp__']);

/* ---------------- 会话卫生（v3.10.2）：真实 jar 永不留存扩展账号的会话 Cookie ----------------
 * 冲突机制：绑定页签登录时响应 Set-Cookie 不经拦截直接落入真实 jar；此后用户 Ctrl+T 的
 * 原始页签出站时带着的就是扩展账号的会话 Cookie——站点按会话轮换逻辑「新登录作废旧会话」，
 * 快速登录的账号被顶掉（原始登录与快速登录互相冲突）。
 * 对策：扩展账号页签完全依赖快照回放（与真实 jar 无关），因此 jar 中的扩展会话 Cookie 可
 * 安全移除——原始页签从此天然匿名，原始登录 = 全新会话，互不顶号。
 * 三层防线：
 *  1. preJar 基线：open() 建页签前记录 jar；
 *  2. 差集清扫：快照首捕时移除「本次登录新写入」的 Cookie（不动登录前已存在的，如原始会话）；
 *  3. onChanged 持续驱逐：凡是 (name,value) 命中任一账号快照对（或 __auth_token__ 命中任一
 *     账号 token）的写 jar 行为，立即移除——覆盖后续请求重新 Set-Cookie 的重入。
 */

interface JarCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
}

/** 登录前 jar 基线（按账号；SW 重启丢失则跳过清扫，保守不误杀） */
const preJarMap = new Map<string, JarCookie[]>();

/** 账号站点的协议（v3.10.9）：缺省 = https（兼容存量账号）。打开 URL 与 Cookie 查询跟随 */
async function schemeOfAccount(accountId: string): Promise<Scheme> {
  try {
    const account = await parallelStore.get(accountId);
    return account.scheme ?? 'https';
  } catch (e) {
    /* ★★ 2026-10-16：这条 `catch` 原来是**裸吞**的 —— 而它的后果是"用户只看到打不开的页面"。
     *
     * 为什么必须留痕（AGENTS 规则 29 的口径："失败时用户看到什么"）：
     *   · 读存储失败 ⇒ 落回 `'https'`；而**内网平台是纯 http**（`10.100.0.105`，
     *     见 AGENTS §4）⇒ 页签按 `https://` 打开 ⇒ **打不开**，
     *     而用户与排障的人都看不到"题目出在读存储上"。
     *   · 这与**已被判据点名的** `site-auth.ts::probeScheme`（"静默按 https 兜底"）
     *     是**同一个形态** —— 那一条在 `verify-log-redaction.mjs` §13 的白名单里，
     *     而这一条当时**没被点名**。现在补上（并进 §13 的 CASES）。
     * ★ 级别用 `warn` 不是 `debug`：它是"按下去会改变行为"的兜底，
     *   而 `debug` 在产物里默认关闭 ⇒ 等于没留痕（PITFALLS #17 的教训）。
     */
    log.warn('schemeOfAccount(%s) 读账号失败 ⇒ 按 https 兜底（内网 http 站点会打不开）：%s',
      accountId, e instanceof Error ? e.message : String(e));
    return 'https';
  }
}

async function capturePreJar(accountId: string, host: string): Promise<void> {
  try {
    const scheme = await schemeOfAccount(accountId);
    preJarMap.set(accountId, (await chrome.cookies.getAll({ url: `${scheme}://${host}/` })) as JarCookie[]);
  } catch {
    preJarMap.delete(accountId);
  }
}

function cookieUrl(c: { domain: string; path: string; secure: boolean }): string {
  const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  return `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`;
}

/** 从真实 jar 移除一枚 Cookie（幂等；失败静默——可能已被站点的过期指令处理） */
async function removeJarCookie(c: { name: string; domain: string; path: string; secure: boolean }): Promise<void> {
  try {
    await chrome.cookies.remove({ url: cookieUrl(c), name: c.name });
  } catch {
    // 幂等目标，失败忽略
  }
}

/** 快照首捕后按差集清扫：只移除「本次登录新写入」的 Cookie，保留登录前已存在的（如原始会话）。
 *  v3.11.1 归属门控：候选还必须是「绑定页签写入」（webRequest 归属）——同账号原生登录
 *  写入的同值 Cookie 属于原生会话，受根本原则保护，不清扫。 */
async function sweepLoginCookiesFromJar(accountId: string, host: string, captured: Array<{ name: string; value: string }>): Promise<void> {
  const pre = preJarMap.get(accountId);
  if (!pre) {
    void diag(`sweep(${accountId}) 跳过：无登录前基线（SW 重启）——依赖 onChanged 驱逐兜底`);
    return;
  }
  const scheme = await schemeOfAccount(accountId);
  const preKeys = new Set(pre.map((c) => `${c.name}|${c.value}`));
  const jarNow = (await chrome.cookies.getAll({ url: `${scheme}://${host}/` }).catch(() => [])) as JarCookie[];
  let removed = 0;
  let protectedCount = 0;
  for (const c of jarNow) {
    // 差集成员：在 jar 中、被快照捕获、但登录前不存在 → 本会话写入的扩展 Cookie
    if (!preKeys.has(`${c.name}|${c.value}`) && captured.some((k) => k.name === c.name && k.value === c.value)) {
      const attr = cookieAttribution.get(`${c.name}|${c.value}`);
      if (!attr || !attr.bound) {
        protectedCount++;
        continue; // 非绑定页签写入：原生会话，受根本原则保护
      }
      await removeJarCookie(c);
      removed++;
    }
  }
  preJarMap.delete(accountId);
  void diag(`sweep(${accountId}) 差集清扫 ${removed} 枚（jar 现存 ${jarNow.length}，原生保护 ${protectedCount}）`);
}

/* ---------------- 写入者归属（v3.11.1 根本原则）----------------
 * 根本原则：扩展只能影响扩展打开的网页，不得以规则/能力影响原有网页。会话卫生
 * （驱逐/清扫）此前不区分写入者——同账号「原生登录」（原始页签手输登录）写入真实
 * jar 的会话 Cookie 会与快照对撞而被驱逐/清扫 → 扩展破坏原生会话。
 * 对策：观察型 webRequest 记录每条 Set-Cookie 的写入者（所在响应的 tabId 是否绑定）；
 * 驱逐/清扫只作用于「绑定页签写入」的 Cookie。原生页签的网络写入归属为 unbound；
 * 原生页签的 JS document.cookie 写入不产生网络事件（无归属）——同样保留。 */
const cookieAttribution = new Map<string, { bound: boolean; at: number }>();
const ATTRIBUTION_LIMIT = 800;

function trackCookieAttribution(details: { tabId: number; responseHeaders?: { name: string; value?: string }[] }): void {
  const sets = (details.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === 'set-cookie');
  if (!sets.length) {
    return;
  }
  const bound = bindings.has(details.tabId);
  for (const h of sets) {
    const parsed = parseSetCookie(h.value ?? '');
    if (!parsed || parsed.remove) {
      continue; // 作废指令不是「写入」
    }
    cookieAttribution.set(`${parsed.name}|${parsed.value}`, { bound, at: Date.now() });
  }
  while (cookieAttribution.size > ATTRIBUTION_LIMIT) {
    const oldest = cookieAttribution.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cookieAttribution.delete(oldest);
  }
}

/** 登录态终结（v3.12.0）：账号最后一个绑定页签关闭时调用。
 *  快照清空（token/Cookie/authUser）；jar 中由绑定页签写入的该账号 Cookie 按
 *  attribution 门控清扫（原生页签写入的不动）。下次打开 = 干净登录页 + 自动填表。 */
async function terminateLoginState(accountId: string, host: string): Promise<void> {
  const snap = tokens.get(accountId);
  if (!snap || (!snap.token && !snap.cookies?.length && !snap.authUser)) {
    return; // 无登录态可终结
  }
  void forensics('terminate', {
    accountId,
    hadToken: Boolean(snap.token),
    cookieCount: snap.cookies?.length ?? 0,
  });
  void diag(
    `terminateLoginState(${accountId}) 最后页签关闭：终结登录态（token=${snap.token ? '有' : '无'} cookie=${snap.cookies?.length ?? 0}）`,
  );
  try {
    const scheme = await schemeOfAccount(accountId).catch(() => 'https' as const);
    const jarNow = (await chrome.cookies.getAll({ url: `${scheme}://${hostNoPortOf(host)}/` }).catch(() => [])) as JarCookie[];
    for (const c of jarNow) {
      if (IDENTITY_COOKIE_BLACKLIST.has(c.name)) {
        continue;
      }
      const attr = cookieAttribution.get(`${c.name}|${c.value}`);
      if (attr?.bound && (snap.cookies ?? []).some((k) => k.name === c.name && k.value === c.value)) {
        await removeJarCookie(c);
      }
    }
  } catch (e) {
    /* ★★ 2026-10-16：这条 `catch` 原来是 `// 清扫失败不影响快照终结` 后面**什么都不做**。
     *
     * 为什么必须留痕：这一段的职责是"**最后一个页签关闭时把 cookie 从真实 jar 里清掉**"，
     * 而"真实 jar 不驻留扩展账号的会话"是 AGENTS **规则 4 / 隔离平面 4 的核心不变量**。
     * 清扫失败 ⇒ 该账号的 Cookie **继续留在真实 jar 里** ⇒ 下一个用同一浏览器的人
     * 可能拿到它的登录态。而**上面那句注释说得对（不影响快照终结）**，
     * 但那不是"不用记"的理由 —— 它影响的是**别的东西**。
     *
     * ★ 为什么可以是 `warn` 而不是"必须热路径静默"：
     *   它**每个账号只在最后一次关页签时走一次**，不是热路径
     *   ⇒ §13 白名单里那条"热路径怕挤爆环"的理由在这里不成立。
     */
    log.warn('terminateLoginState(%s) jar 清扫失败 ⇒ 该账号的 Cookie 可能仍留在真实 jar 里：%s',
      accountId, e instanceof Error ? e.message : String(e));
    void diag(`terminateLoginState(${accountId}) jar 清扫失败（规则 4 的不变量这次没维持住）`);
  }
  delete snap.token;
  delete snap.cookies;
  delete snap.authUser;
  tokens.set(accountId, snap);
  await persistTokens();
}

/** onChanged 持续驱逐：命中任一账号快照对（或身份 token）的写 jar 行为立即移除 */
async function evictJarCookie(change: chrome.cookies.CookieChangeInfo): Promise<void> {
  const c = change.cookie;
  if (!c.value) {
    return; // 移除事件本身
  }
  const key = `${c.name}|${c.value}`;
  const known = new Set<string>();
  for (const snap of tokens.values()) {
    for (const k of snap.cookies ?? []) {
      known.add(`${k.name}|${k.value}`);
    }
    if (snap.token) {
      known.add(`__auth_token__|${snap.token}`);
    }
  }
  if (!known.has(key)) {
    return;
  }
  // v3.11.1 根本原则归属门控：仅驱逐「绑定页签写入」的 Cookie。写入者归属来自
  // webRequest 响应观察（Set-Cookie 所在响应的 tabId 是否绑定）——同账号原生登录、
  // 原始页签的任何写 jar 行为一律保留（扩展不得影响原有网页）。
  const attr = cookieAttribution.get(key);
  if (!attr || !attr.bound) {
    void diag(`evict 跳过 ${c.name}（写入者非绑定页签——原生会话受保护）`);
    return;
  }
  await removeJarCookie(c);
  void diag(`evict jar cookie ${c.name}（命中账号快照·绑定页签写入）@ ${c.domain}`);
}

/** 登录时点快照该账号的站内 Cookie（含 HttpOnly，剔除身份类黑名单）进账号档案。
 *  v3.10.6：与登录前暂存的页内袋值合并（页内 JS 在 token 捕获前写入的 Cookie 不丢）。 */
async function snapshotLoginCookies(accountId: string, host: string): Promise<void> {
  const snap = tokens.get(accountId);
  if (!snap?.token) {
    return;
  }
  try {
    const scheme = await schemeOfAccount(accountId);
    const list = await chrome.cookies.getAll({ url: `${scheme}://${host}/` });
    const before = list.length;
    const jarCookies = list.filter((c) => !IDENTITY_COOKIE_BLACKLIST.has(c.name));
    if (snap.cookies?.length) {
      // 合并：登录时点 jar 全量为权威，登录前页内写入的暂存袋值保留补充（jar 同名以 jar 为准）
      const merged = new Map(snap.cookies.map((c) => [c.name, c.value]));
      for (const c of jarCookies) {
        merged.set(c.name, c.value);
      }
      snap.cookies = [...merged.entries()].map(([name, value]) => ({ name, value }));
    } else {
      snap.cookies = jarCookies.map((c) => ({ name: c.name, value: c.value }));
    }
    tokens.set(accountId, snap);
    await persistTokens();
    void diag(`snapshotLoginCookies(${accountId}) 快照 ${snap.cookies.length} 条（jar 共 ${before}，剔身份类 ${before - jarCookies.length}）`);
    // 会话卫生：把本次登录写入真实 jar 的差集 Cookie 移除（原始页签从此匿名登录，不顶号）
    await sweepLoginCookiesFromJar(accountId, host, snap.cookies);
  } catch (e) {
    void diag(`snapshotLoginCookies(${accountId}) 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ---------------- 快照动态化（v3.10.6）：登录后 Cookie 实时进回放 ----------------
 * 静态快照的缺陷：登录后服务端 Set-Cookie（会话轮换/下载票据）与页内 JS 写入
 * （袋虚拟化，jar 不可见）都进不了回放——绑定页签下载等「依赖登录后凭据」的请求
 * 被服务端当旧会话拒绝（虚拟环境无法下载、正常环境可以）。两条实时通道：
 *  1. webRequest 响应捕获：按 tabId 归属账号，Set-Cookie 增量并入快照 + 规则热更新；
 *  2. 袋回流：MAIN 壳的 document.cookie 写入（袋全量）经桥上报并入快照。
 * 合并引擎：变化才 persist + syncAccountRules（applyBinding 值不变不重建规则）。 */

/** 快照合并：updates 覆盖/新增，removals 删除（服务端作废指令）。返回是否有变化 */
async function mergeCookieSnapshot(
  accountId: string,
  host: string,
  updates: { name: string; value: string }[],
  removals: Set<string>,
): Promise<boolean> {
  // v3.10.8：移除「未登录不维护快照」的 token 门禁。登出清空快照后进入登录前窗口，
  // 站点下发的 WAF 会话/防机器人 Cookie 若被丢弃，登录 POST 将以「完全无 Cookie」的
  // 裸态发出而被 WAF/服务端拒绝（快捷登录登出后失败的根因）。登录前窗口同样维护
  // 快照（身份键过滤已有，无跨账号风险），使登录请求与原生浏览器等价。
  const snap = tokens.get(accountId) ?? {};
  const next = new Map((snap.cookies ?? []).map((c) => [c.name, c.value]));
  let changed = false;
  for (const name of removals) {
    if (IDENTITY_COOKIE_BLACKLIST.has(name) || !next.has(name)) {
      continue;
    }
    next.delete(name);
    changed = true;
  }
  for (const u of updates) {
    if (IDENTITY_COOKIE_BLACKLIST.has(u.name)) {
      continue;
    }
    if (next.get(u.name) !== u.value) {
      next.set(u.name, u.value);
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  snap.cookies = [...next.entries()].map(([name, value]) => ({ name, value }));
  tokens.set(accountId, snap);
  await persistTokens();
  void diag(`mergeCookieSnapshot(${accountId}) +${updates.length} -${removals.size} → ${snap.cookies.length} 条${snap.token ? '' : '（登录前窗口）'}，热更新回放`);
  await syncAccountRules(accountId, host);
  return true;
}

/** 解析 Set-Cookie 头：取首段 k=v；Max-Age<=0 或 expires 过期 → 服务端作废指令 */
function parseSetCookie(raw: string): { name: string; value: string; remove: boolean } | null {
  const first = raw.split(';')[0] ?? '';
  const eq = first.indexOf('=');
  if (eq <= 0) {
    return null;
  }
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) {
    return null;
  }
  let remove = false;
  for (const attr of raw.split(';').slice(1)) {
    const [k, v] = attr.split('=');
    const key = (k ?? '').trim().toLowerCase();
    if (key === 'max-age' && Number.parseInt(v?.trim() ?? '', 10) <= 0) {
      remove = true;
    } else if (key === 'expires') {
      const t = Date.parse((v ?? '').trim());
      if (!Number.isNaN(t) && t <= Date.now()) {
        remove = true;
      }
    }
  }
  return { name, value, remove };
}

/** v3.13.2 下载/请求失败取证：绑定页签的 401/403/5xx 响应全量留痕（URL/host/归型/覆盖域），
 *  让「下载失败类」问题在下一次诊断包里直接可读，不再依赖症状猜测。 */
async function reportFailureStatus(details: {
  tabId: number;
  url: string;
  statusCode?: number;
  type?: string;
}): Promise<void> {
  const status = details.statusCode ?? 0;
  if (status < 400) {
    return;
  }
  const binding = details.tabId > 0 ? bindings.get(details.tabId) : undefined;
  if (!binding) {
    return; // 未绑定页签的失败与本扩展无关
  }
  let urlHostname = '';
  try {
    urlHostname = new URL(details.url).hostname;
  } catch {
    return;
  }
  const bindHostname = hostNoPortOf(binding.host);
  const parent = parentDomainOf(bindHostname);
  const covered = urlHostname === bindHostname || urlHostname.endsWith(`.${parent}`);
  // 全量记录：401/403 任何类型；其余 4xx/5xx 仅主框架/下载类（避免 favicon 404 噪声）
  if (status === 401 || status === 403 || details.type === 'main_frame' || details.type === 'other') {
    void diag(
      `⚠ 页签请求失败 status=${status} type=${details.type ?? '?'} covered=${covered} host=${urlHostname} url=${details.url.slice(0, 180)}`,
    );
  }
}

/** 绑定页签收到的响应 Set-Cookie → 归属账号并入快照（观察型 webRequest，不改写） */async function captureResponseCookies(
  details: { tabId: number; url: string; responseHeaders?: { name: string; value?: string }[] },
): Promise<void> {
  let accountId: string | undefined;
  let bindHost: string | undefined;
  if (details.tabId > 0) {
    const binding = bindings.get(details.tabId);
    accountId = binding?.accountId;
    bindHost = binding?.host;
  } else if (details.tabId <= 0) {
    // v3.10.8 归属优化：无页签请求（Service Worker 内 fetch / 下载管理器重试 / 预取）
    // 此前直接丢弃——下载票据恰好经此通道获得时即「下载被拒」。仅当当前恰好只有
    // 一个已绑定账号时才可唯一归属；多账号并存仍无法判定，维持丢弃。
    const unique = new Set([...bindings.values()].map((b) => b.accountId));
    if (unique.size === 1) {
      const only = [...bindings.values()][0];
      accountId = only.accountId;
      bindHost = only.host;
      void diag(`captureResponseCookies：无页签响应(${new URL(details.url, 'https://x').host})归属唯一绑定账号 ${accountId}`);
    } else {
      return;
    }
  }
  if (!accountId || !bindHost) {
    return;
  }
  let urlHostname = '';
  try {
    urlHostname = new URL(details.url).hostname;
  } catch {
    return;
  }
  const bindHostname = hostNoPortOf(bindHost);
  const parent = parentDomainOf(bindHostname);
  if (urlHostname !== bindHostname && !urlHostname.endsWith(`.${parent}`)) {
    // 覆盖域之外：Cookie 回放与剥离均不作用。下载类响应在此域被拒时即为根因——
    // 诊断记录（现场可定位）；不自动扩展覆盖域，避免向第三方域回放账号 Cookie。
    const headers = details.responseHeaders ?? [];
    const cd = headers.find((h) => h.name.toLowerCase() === 'content-disposition');
    const ct = headers.find((h) => h.name.toLowerCase() === 'content-type');
    if (cd && /attachment/i.test(cd.value ?? '')) {
      void diag(`⚠ 绑定页签的下载响应来自未覆盖域 ${urlHostname}（attachment）——账号 Cookie 不回放到该域，需平台侧确认或扩展覆盖策略`);
    } else if (ct && /octet-stream|application\/pdf/i.test(ct.value ?? '')) {
      void diag(`ℹ 绑定页签的文件类响应来自未覆盖域 ${urlHostname}（${ct.value?.slice(0, 40)}）`);
    }
    return;
  }
  const sets = (details.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === 'set-cookie');
  if (!sets.length) {
    return;
  }
  const updates: { name: string; value: string }[] = [];
  const removals = new Set<string>();
  for (const h of sets) {
    const parsed = parseSetCookie(h.value ?? '');
    if (!parsed || IDENTITY_COOKIE_BLACKLIST.has(parsed.name)) {
      continue;
    }
    if (parsed.remove) {
      removals.add(parsed.name);
    } else {
      removals.delete(parsed.name);
      updates.push({ name: parsed.name, value: parsed.value });
    }
  }
  if (!updates.length && !removals.size) {
    return;
  }
  try {
    await mergeCookieSnapshot(accountId, bindHost, updates, removals);
  } catch (e) {
    void diag(`captureResponseCookies(tab=${details.tabId}) 异常：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Cookie **名/值** 的形状校验（v4.2.32）。
 *
 * ★ 为什么必须有：`bagChanged` 来自页面（MAIN 壳），而壳只能证明"这条消息来自
 *   本页签"，证明不了"这个 cookie 是浏览器真的收到的"。旧实现把袋里的任意
 *   name/value 直接并入快照，随后 `cookieHeaderOf()` 用 `'; '` 拼接注入
 *   `Cookie:` 头 —— 页内脚本（或 XSS）可以塞 `a=b; HttpOnlySession=...`
 *   这类值，污染下一个请求的 Cookie 结构。
 *   `chrome.cookies.getAll` 得到的快照本身可信，但**回流路径**不可信，
 *   所以校验放在两者汇合后的写入侧 + 回放侧各做一次（纵深）。
 */
// ★ 字符类里**不要写字面量的单引号/反引号**：`tools/verify/_lib/strip-comments.mjs`
//   不解析正则字面量，遇到它们会误判成"进入字符串"并吞掉后续代码（本仓已知取舍）。
//   用 `\x27` / `\x60` 表达，语义相同而源码里不出现这两个字符。
const COOKIE_NAME_RE = /^[!#$%&\x27*+\-.^_\x60|~0-9A-Za-z]+$/;
const MAX_COOKIE_VALUE = 4096;
const MAX_COOKIE_PAIRS = 200;

function saneCookiePair(name: string, value: string): boolean {
  if (!name || name.length > 128 || !COOKIE_NAME_RE.test(name)) return false;
  if (value.length > MAX_COOKIE_VALUE) return false;
  // 控制字符（含 CR/LF）与 `;` 都会破坏 Cookie 头结构 ⇒ 一律拒绝
  return !/[\x00-\x1f\x7f;]/.test(value);
}

/** 处理 MAIN 壳上报的 Cookie 袋全量（页内 document.cookie 写入的虚拟视图） */
async function mergeBagIntoSnapshot(accountId: string, host: string, bag: Record<string, string>): Promise<void> {
  const updates: { name: string; value: string }[] = [];
  let rejected = 0;
  for (const [name, value] of Object.entries(bag)) {
    if (name === COOKIE_BAG_KEY || IDENTITY_COOKIE_BLACKLIST.has(name) || !value) {
      continue;
    }
    if (!saneCookiePair(name, value) || updates.length >= MAX_COOKIE_PAIRS) {
      rejected++;
      continue;
    }
    updates.push({ name, value });
  }
  if (rejected) {
    void diag(`bagChanged 丢弃 ${rejected} 个非法/超限 cookie 项（tab host=${host}）`);
  }
  if (!updates.length) {
    return;
  }
  // v3.10.8：pre-token 分支已并入 mergeCookieSnapshot（登录前窗口同样热更新回放）
  await mergeCookieSnapshot(accountId, host, updates, new Set());
}

function cookieHeaderOf(accountId: string): string | null {
  const cs = tokens.get(accountId)?.cookies;
  if (!cs || !cs.length) {
    return null;
  }
  // 回放侧再过滤一次：3.7.2 之前保存的存量快照可能已含身份类 Cookie（jar 残留），
  // 无需用户重新登录即生效
  const filtered = cs
    .filter((c) => !IDENTITY_COOKIE_BLACKLIST.has(c.name) && saneCookiePair(c.name, c.value))
    .slice(0, MAX_COOKIE_PAIRS);
  if (!filtered.length) {
    return null;
  }
  return filtered.map((c) => `${c.name}=${c.value}`).join('; ');
}

/** 把某账号当前 token 同步到其全部绑定标签页的规则（受授权健康门控） */
async function syncAccountRules(accountId: string, host: string): Promise<void> {
  const bound = boundTabsOf(accountId);
  void diag(`syncAccountRules(${accountId}) 绑定标签=${bound.join(',') || '无'}`);
  if (!(await isEnforceable(host))) {
    void diag(`syncAccountRules(${accountId}) 跳过：授权不可执行`);
    return; // 授权缺失/停用：不装规则，UI 通过 enforcementOff 提示
  }
  const token = tokens.get(accountId)?.token ?? null;
  const cookieHeader = cookieHeaderOf(accountId);
  try {
    await Promise.all(bound.map((tabId) => tabRules.applyBinding(host, tabId, token, cookieHeader)));
    void diag(
      `syncAccountRules(${accountId}) 完成：applyBinding ×${bound.length}（token=${token ? '有' : '无'} cookie=${cookieHeader ? `${cookieHeader.length}B` : '剥离'}）`,
    );
  } catch (e) {
    void diag(`syncAccountRules(${accountId}) 异常：${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

/* ---------------- 绑定生命周期 ---------------- */

/** 冷启动门（见 `readyPromise` 的注释）：首次调用触发一次 `restore()`，之后复用同一个 promise */
function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = parallelSession.restore().catch(() => undefined);
  }
  return readyPromise;
}

export const parallelSession = {
  /**
   * 打开（或新建）账号标签页并完成绑定。
   *
   * ★ 2026-10-19：多两个可选项，给「常用页面跟随当前账号」用：
   *   · `targetUrl` —— 新页签最终导航到的地址（缺省仍是站点登录页/根路径）
   *   · `stageCredentials` —— 是否下发待自动填表凭证。打开收藏页时传 `false`：
   *     那只页不是登录页，下发一份 60 秒 TTL 的明文凭证只是**多一处暴露面**。
   *     绑定、种子与 DNR 规则照旧安装 —— 那些才是"仍然是账号 A"的保证。
   */
  async open(
    accountId: string,
    forceNewTab = false,
    opts: { targetUrl?: string; stageCredentials?: boolean } = {},
  ): Promise<{ tabId: number; reused: boolean }> {
    void diag(`open(${accountId}) 入口`);
    const account = await parallelStore.get(accountId);
    /**
     * ★★ **站点为空就不许继续**（v4.2.12 加）。
     *
     * 缺陷形态：`account.siteHost` 来自 `cloud-store.toAccount()` 的那条五级回落
     * （`rec.siteHost` → `rec.baseUrl` → `rec.site.baseUrl` → `siteById.get(siteId)?.host`
     * → `rec.siteName`）。**最后一级是个陷阱**：云端 `sites/accounts` 的 `siteName` 是
     * **用户起的显示名**（生产库里就有「通桥」「公司配置环境」），`looksLikeHost()` 会拒掉它
     * ⇒ `siteHost` 落成空串。
     *
     * 而空串会让后面每一处都**静默地做错事**，且都不报错：
     *   · URL 拼成 `https:///login` → `new URL` 抛异常 / Chrome 打不开；
     *   · 预绑定写进 `bindings` 的 host 是空串 ⇒ 后台的来源域校验恒不通过
     *     （`hostNoPortOf('')` 是空串）⇒ **自动填表永远拿不到凭证**；
     *   · `ensureHostPermission('')` 会去请求一个**非法的权限模式** ⇒ Chrome 静默返回 false。
     * ⇒ 与其让它在三个地方各自静默失败，不如在这里**一次性、可读地**失败。
     *
     * ★ 本段注释里**不要**写出那个非法模式的样子：它的尾部正是块注释的结束标记，
     *   会让注释提前结束（`docs/PITFALLS.md` #43，由 `verify-css-vars.mjs` 的
     *   "块注释配平"判据当场抓住 —— 我这一轮就在这句上犯了一次）。
     */
    if (!account.siteHost) {
      throw new Error(
        `账号「${account.tabName || account.username}」没有解析出站点域名。`
          + '常见原因是云端这条账号的站点记录缺失（或站点名是中文显示名而地址为空）。'
          + '请在账号中心重新确认它的所属站点，或到云端控制台检查该站点。',
      );
    }
    let tabId: number | null = null;

    if (!forceNewTab) {
      const existing = boundTabsOf(accountId)[0];
      if (existing !== undefined && (await tabStillAlive(existing))) {
        tabId = existing;
      }
    }
    // ★★ 「复用」这个事实**只在这里算一次**（见函数末尾的注释：曾经它被算成两个值）。
    const reused = tabId !== null;
    void forensics('open', {
      accountId,
      forceNewTab,
      reused,
      // 云端账号的凭证在服务端（hasPassword），本地才是 credentials —— 取证字段要如实反映
      // ★ v3.18：`credentials` 字段已删（本地数据源废除）⇒ `hasPassword` 是唯一依据。
      hasCredentials: account.hasPassword === true,
      box: account.box ?? null,
    });

    /** 登录前基线：记录打开时刻的真实 jar，快照首捕时按差集清扫（v3.10.2 会话卫生）。
     *  ★ 必须在 `tabs.create` **之前**调（下面 `newTab` 那一支），否则基线里会混进
     *    新页签自己发的请求所落的 Cookie，"差集清扫"就再也认不出哪些是登录带来的。 */
    const preJarDone = { v: false };
    const capturePreJarOnce = async (): Promise<void> => {
      if (preJarDone.v) {
        return;
      }
      preJarDone.v = true;
      await capturePreJar(account.id, account.siteHost);
    };

    /**
     * ★★ **绑定与待登录凭证必须先于导航落地**（见 `open()` 上方的长注释：
     * 内容脚本在 `document_idle` 就索取凭证，晚一步就是一次不可重试的拒绝）。
     *
     * 提取成一个函数是为了让「新建」与「复用」两条路**都**走同一段代码 ——
     * 两份实现迟早只有一份是对的（本仓反复出现过的形态）。
     */
    const bindAndStage = async (
      targetTabId: number,
      withCredentials = true,
    ): Promise<'ready' | 'no-creds' | 'skipped'> => {
      void diag(`open(${accountId}) 预绑定 tab=${targetTabId} host=${account.siteHost}`);
      bindings.set(targetTabId, { accountId: account.id, host: account.siteHost });
      await persistBindings();
      if (!withCredentials) {
        // ★ 打开收藏页/直达页：绑定与规则要装，待登录明文凭证**不下发**
        //   （见 `open()` 的 opts 说明）
        void diag(`open(${accountId}) 直达页：跳过待登录凭证下发`);
        return 'skipped';
      }
      if (!account.hasPassword) {
        void diag(`open(${accountId}) 无凭证字段`);
        return 'no-creds';
      }
      try {
        const creds = await resolveAccountPlaintext(account);
        if (!creds) {
          void diag(`open(${accountId}) 取不到凭证（云端无口令或口令为空）`);
          return 'no-creds';
        }
        await setPendingAutoLogin(targetTabId, creds.username, creds.password);
        void diag(`open(${accountId}) 凭证就绪并下发待登录（早于导航）`);
        return 'ready';
      } catch (e) {
        // 凭证取不到（密文损坏 / 云端网络失败）不应阻断网络平面安装（原实现会让 open() 在此中断）
        void diag(`open(${accountId}) 凭证解析失败：${e instanceof Error ? e.message : String(e)}`);
        return 'no-creds';
      }
    };

    /** 建页签 —— **顺序是这一版的核心**：
     *      ① 绑账号 → ② 等 URL 确定 → ③ 先写绑定与待登录凭证 → ④ 才摘要真取凭据
     *         → ⑤ 最后才 `tabs.update` 让它导航。
     *  ★★ 旧顺序是「先 `tabs.create` 再绑」，而 `tabs.create` 一返回浏览器就开始装载页面
     *     —— 快站上 `document_idle` 的内容脚本会在 `bindings.set` 之前发出
     *     `sb:autoLoginRequest`，后台按 fail-closed 回 `null`，而**内容脚本当时不重试**
     *     ⇒ 自动填充整条链路**静默失效**（用户报的「快捷登录不能自动填账密」）。
     *     实测证据：`ql:forensics` 里 23 条 `autoLoginRejected { reason: 'unbound' }`。 */
    const newTab = async (url: string): Promise<{ tab: chrome.tabs.Tab; staged: string }> => {
      await capturePreJarOnce();
      const tab = await chrome.tabs.create({ url: 'about:blank' });
      const tid = tab.id;
      if (tid === undefined) {
        throw new Error(`新建标签页失败：${account.siteHost}`);
      }
      let staged = 'skipped';
      try {
        staged = await bindAndStage(tid, opts.stageCredentials !== false);
        await chrome.tabs.update(tid, { url });
      } catch (e) {
        // 绑定/取凭据失败**绝不能把页签留在 about:blank**（那看起来像"扩展坏了"）。
        // 如实导航过去，用户至少能自己输密码；失败原因已在上面留痕。
        await chrome.tabs.update(tid, { url }).catch(() => undefined);
        staged = 'failed';
        void diag(`open(${accountId}) 预绑定失败，已如实放行导航：${e instanceof Error ? e.message : String(e)}`);
      }
      return { tab, staged };
    };

    if (tabId === null) {
      // ★★ 2026-10-19：**先算有没有活着的同账号页签**，再决定要不要废弃登录态。
      //
      // `stale` 那段原本在 `hasLiveSibling` **之前**执行 ⇒ `forceNewTab`（"再开一个
      // 同账号页签"）会把仍在用的 token / Cookie 快照一起清掉，随后 `syncAccountRules`
      // 以 `token=null` 重装规则 ⇒ **两个页签同时失去 AUTH**。注释一直说"复制语义下
      // 由活页签背书"，而代码没有照着做 —— 这是那种"注释对、代码错、界面不报错"的
      // 缺陷（新开页签的入口这次被移除，但收藏页跟随账号同样会走这一支）。
      // ⇒ 只有**真的没有活页签**时才废弃残留登录态。
      const hasLiveSibling = boundTabsOf(accountId).length > 0;
      const stale = tokens.get(accountId);
      const staleCleared =
        !hasLiveSibling && Boolean(stale && (stale.token || stale.cookies?.length || stale.authUser));
      if (!hasLiveSibling && stale && staleCleared) {
        delete stale.token;
        delete stale.cookies;
        delete stale.authUser;
        tokens.set(accountId, stale);
        await persistTokens();
        void diag(`open(${accountId}) 无活页签：废弃残留登录态（v3.12.0 生命周期），走登录页自动填表`);
      }
      const scheme = account.scheme ?? 'https';
      // ★ `targetUrl` = 调用方指定的落地页（收藏页跟随当前账号）；
      //   缺省仍是"有活页签直达根路径，否则走登录页"。
      const url = opts.targetUrl?.trim()
        || `${scheme}://${account.siteHost}${hasLiveSibling ? '/' : '/login'}`;
      const { tab, staged } = await newTab(url);
      tabId = tab.id!;
      void diag(`open(${accountId}) 新建 tab=${tabId} staged=${staged} url=${url}`);
      void forensics('open-tab', {
        accountId,
        tabId,
        url,
        hasLiveSibling,
        staleCleared,
        staged,
        cookieSnapshot: stale?.cookies?.length ?? 0,
        hadToken: Boolean(stale?.token),
      });
    } else {
      // 复用：页签可能正停在该站点的登录页上（用户刚被登出），所以**同样要先把
      // 绑定与凭证补齐再激活**。★ 绑定本来就该在（`boundTabsOf` 查的就是它），
      // 但"凭证还在不在"是另一回事 —— 60 秒 TTL 一过就没了，重新聚焦等于什么都没填。
      const staged = await bindAndStage(tabId);
      await chrome.tabs.update(tabId, { active: true });
      void diag(`open(${accountId}) 复用 tab=${tabId} staged=${staged}`);
    }

    // 推送绑定种子：桥转发给 MAIN 壳（壳在 committed 前后到达均可自举）
    await pushBind(tabId);
    void diag(`open(${accountId}) pushBind 完成`);
    await applyTitle(tabId, account.tabName);
    await syncAccountRules(account.id, account.siteHost);
    void diag(`open(${accountId}) 完成 tabId=${tabId}`);
    // ★★ 曾经这里**硬编码 `reused: false`**，而正确值在函数开头就算出来了
    //    （见上面的 `forensics('open', { reused: tabId !== null })`）。
    //    当时 UI 不消费该字段 ⇒ 无人发现；但协议（`messages.ts` 的 `par.open`）
    //    声明了它、forensics 里记的又是对的 ⇒ **同一个事实有两个值**，
    //    任何一个未来的消费方都会以 50% 的概率读错，且读错了也不会报错。
    //    判据：`par.open` 的返回值必须与 `forensics('open')` 的 `reused` 一致。
    return { tabId, reused: reused };
  },

  /** 解绑单个标签页（不动账号数据）；最后一个绑定页签关闭 = 该账号登录态终结（v3.12.0） */
  async unbindTab(tabId: number): Promise<void> {
    loginGrace.delete(tabId); // 绑定终结：登录页重来额度一并作废
    const binding = bindings.get(tabId);
    if (bindings.delete(tabId)) {
      await persistBindings();
    }
    await tabRules.clearTab(tabId);
    try {
      await pushDown(tabId, { op: 'unbound' });
    } catch {
      // 页面可能已关闭
    }
    if (binding && boundTabsOf(binding.accountId).length === 0) {
      // 登录态生命周期跟随页签：无活页签 = 凭证视为已死，终结快照并清扫 jar 残留
      await terminateLoginState(binding.accountId, binding.host);
    }
  },

  /**
   * 新页签的亲子继承：`window.open` / `target=_blank` 开出来的页签，以及**用户复制页签**。
   *
   * ★ 站点开窗（opener 已绑定账号 A）→ 新页签登记为**收编候选**（v3.13 加固：此时 URL
   *   尚未落地，不立即绑定）。首次导航 URL 由 onNavigation 确认：授权域内 → 正式收编
   *   （种子/规则此时才下发）；授权域之外或登录页 → 丢弃候选，页签保持原生
   *   （根本原则：外部链接零接触）。手动 Ctrl+T（无 openerTabId）连候选都不是。
   * ★ 复制页签（v4.2.27）：`openerTabId` 指向的是**复制那一刻的前台页签**，不是源页签
   *   ⇒ 不能按它继承（否则串号）。走 `decideAdoption` 用 `onCreatedNavigationTarget`
   *   区分两种来源，复制场景改按"紧邻的源页签"继承。详见 `adoptProbe` 的注释。
   */
  async adoptFromOpener(tab: chrome.tabs.Tab): Promise<void> {
    const openerId = tab.openerTabId;
    const tabId = tab.id;
    if (openerId === undefined || tabId === undefined) {
      return;
    }
    // ★ 冷启动门（v4.2.27）：SW 刚被叫醒时 `bindings` 还是空的 ⇒ 这里会直接把
    //   "有父绑定"误判成"没有父绑定"，冷启动后头几个新页签就这么丢了账号。
    await ensureReady();
    if (bindings.has(tabId)) {
      return;
    }
    // ★★ v4.2.27：`openerTabId` **不能直接当亲子依据**，但它也不是没用：
    //   实测（探针 probe-dup4/5/8，headless Chrome 151）这个字段里装的是
    //   「创建那一刻**前台**的页签」：
    //     · 复制页签：前台是别的账号的页签 ⇒ 照它继承就是**串号**；
    //     · 后台页签里 `window.open`：同样是前台页签 ⇒ 同上；
    //     · 前台正好就是来源（用户就在那个页签上操作）：这才是老代码假设的形态。
    //   ⇒ 用**创建那一刻 `pendingUrl` 有没有落地**先把两种形态分开：
    //     · 没落地（'' / about:blank）= 站点开窗的典型形态，渲染进程还没提交导航，
    //       `openerTabId` 就是来源 ⇒ **立刻**按父绑定登记候选（不能等：壳在
    //       document_start 就发 hello，等 40ms 就可能把种子让给 SPA 的首屏读取）；
    //     · 已落地（复制页签在 `onCreated` 时 `pendingUrl` 就已等于源 URL）
    //       ⇒ 挂进 `adoptProbe` 待判，由 `decideAdoption` 找真正的源页签。
    const pendingUrl = ((tab as { pendingUrl?: string }).pendingUrl || '').trim();
    if (!pendingUrl || pendingUrl === 'about:blank') {
      const parent = bindings.get(openerId);
      if (!parent) {
        return;
      }
      // ★ 2026-10-28：**先登记候选，再 await 任何东西**（迟到的 bind 会被直通模式丢掉）。
      // ★ v4.2.27：这里**不再**等云端确认账号存在 —— 离线时 `parallelStore.get()`
      //   要走一次完整网络超时（秒级），而候选登记被卡在它后面，壳就一直 hold、
      //   SPA 早就跳登录页了。身份的权威来源是父页签的现有绑定（本地事实）；
      //   账号真没了由 `onNavigation` 收编后置校验兜底。
      registerAdoptCandidate(tabId, parent.accountId, parent.host, `opener=${openerId}`);
      return;
    }
    if (!adoptProbe.has(tabId)) {
      adoptProbe.set(tabId, { openerId, at: Date.now() });
      void forensics('adopt-probe', { tabId, openerId, pendingUrl: pendingUrl.slice(0, 200) });
      setTimeout(() => {
        void decideAdoption(tabId);
      }, ADOPT_PROBE_DELAY);
    }
  },

  /** 删除账号：关闭其全部绑定标签页、摘除规则、清 token */
  async deleteAccount(accountId: string): Promise<void> {
    await this.closeAccountTabs(accountId);
    await parallelStore.delete(accountId);
  },

  /**
   * ★★★ v4.2.12：**只做本机的会话清理，不碰云端数据**（批量删除用的前半步）。
   *
   * 为什么要把这一步单独摘出来：批量删除走的是服务端那一条
   * `POST /api/accounts/batch-delete`（一次请求、一次推 revision），
   * 所以**不能**循环调用 `deleteAccount()` —— 那会变成 N 次云端 DELETE，
   * 而其中任何一次失败都会留下一半删掉、一半还在的状态。
   *
   * ★ 顺序纪律：**先关页签再删数据**。反过来的话，"数据删掉了而关页签失败"
   *   会留下绑着一个已不存在账号的幽灵页签 —— 而它的 DNR 规则还在改写请求头。
   */
  async closeAccountTabs(accountId: string): Promise<void> {
    const tabs = boundTabsOf(accountId);
    for (const tabId of tabs) {
      await this.unbindTab(tabId);
    }
    if (tabs.length) {
      await chrome.tabs.remove(tabs).catch(() => undefined);
    }
    tokens.delete(accountId);
    await persistTokens();
  },

  /** 桥上行消息入口。`sender` 由 service worker 从 `chrome.runtime.onMessage` 注入，
 *  内容脚本无法伪造 —— 用来判「这个 frame 是否属于绑定站点」（v4.2.32 安全加固）。 */
  async handleBridge(payload: BridgeUpPayload, sender: BridgeSender): Promise<BridgeDownPayload | undefined> {
    const tabId = sender.tabId;
    if (payload.op === 'hello') {
      if (tabId !== undefined) {
        const binding = bindings.get(tabId);
        if (binding) {
          // ★★ v4.2.32：此前这里只认 tabId —— 同页签里的**跨域 iframe**
          //   （广告/统计/嵌入页）发一句 hello 就能换到该账号的 Bearer token
          //   与 Cookie 袋；bridge 还会把载荷 postMessage 给该 frame 的页面 JS。
          //   ⇒ 现在按 sender.url 的 host/port 判归属，不匹配**一律不答 bind**
          //   （fail-closed；答 unbound 让那层壳保持直通，不再反复重试）。
          if (!senderMatchesBinding(sender, binding)) {
            log.debug(
              'handleBridge(hello) 拒绝：tab=%d frame=%d url=%s 不属于绑定站点 %s',
              tabId,
              sender.frameId ?? -1,
              sender.url ?? '(none)',
              binding.host,
            );
            return { op: 'unbound' };
          }
          return buildBindPayload(binding.accountId, tabId, binding.host);
        }
        // ★★ 2026-10-28：**迟到竞争的兜底**。候选登记靠 `tabs.onCreated`，
        //   而壳的 hello 在 document_start 就发 —— 两者谁先到 SW 是掷骰子。
        //   所以在答"未绑定"之前，先补读一次"父页签是谁"：有已绑定的 opener
        //   就当场登记候选并答 hold 让壳等着，而不是把它判成原始页签
        //   （判了之后迟到的 bind 会被壳忽略，页签再也收不回来）。
        await ensureReady(); // ★ v4.2.27：冷启动时 bindings 还没恢复，别急着判"未绑定"
        await ensureAdoptionCandidate(tabId);
        if (pendingAdoptions.has(tabId) || adoptProbe.has(tabId)) {
          // v3.13 收编候选：URL 未确认前不灌种子/不置 settled——壳保持等待（hold），
          // URL 确认授权后再正式收编（防止候选期的种子流入外部域）。
          // ★ v4.2.27：复制页签待判期（adoptProbe）同样答 hold —— 旧实现这里答
          //   `unbound`，壳把它当终局，等 `decideAdoption` 判出"其实该继承 accA"
          //   时已经晚了（直通模式忽略迟到的 bind）⇒ 登录页。
          return { op: 'hold' };
        }
      }
      return { op: 'unbound' };
    }
    if (tabId === undefined) {
      return undefined;
    }
    const binding = bindings.get(tabId);
    if (!binding) {
      return undefined;
    }
    // ★★ v4.2.32：**所有**后续 op（storageWrite / authHeader / bagChanged /
    //   patchReport / 回执……）都必须来自绑定站点自己的 frame。
    //   以前这里只认 tabId：绑定页签里的第三方 iframe 能发 `bagChanged`
    //   把任意 Cookie（含 HttpOnly 名）写进账号快照，或发 `authHeader`
    //   把 token 换成攻击者的值（绕过 `__auth_user__` 的身份护栏）。
    //   ⇒ 与 hello 同一条判据，不匹配静默忽略（fail-closed）。
    if (!senderMatchesBinding(sender, binding)) {
      log.debug(
        'handleBridge(%s) 拒绝：tab=%d frame=%d url=%s 不属于绑定站点 %s',
        payload.op,
        tabId,
        sender.frameId ?? -1,
        sender.url ?? '(none)',
        binding.host,
      );
      return undefined;
    }
    // ★ v4.2.28：壳请求"刷新页面重来"（直通模式收到迟到 bind）。
    //   v4.2.32 起放到 binding + 来源校验之后：刷新是**绑定站点自己的页面**
    //   才能请求的动作，否则任意第三方 iframe 都能让页签反复 reload（刷新循环 DoS）。
    //   再加令牌桶限流：正常迟到 bind 一辈子只刷一次，连刷三次以上必然异常。
    //   不上行回包。
    if (payload.op === 'needsReload') {
      const reason = String((payload as unknown as { reason?: string }).reason ?? '');
      if (!allowReloadForRecover(tabId)) {
        void diag(`needsReload 被限流(tab=${tabId})：60s 内已有多次刷新请求`);
        return undefined;
      }
      await reloadForRecover(tabId, reason);
      return undefined;
    }
    // ★ 平面补丁的安装结果（2026-10-12 加）：`patch()` 跳过时原本**完全静默**，
    //   于是"隔离开着但没生效"与"一切正常"在诊断上无法区分。
    //   接这个上报只为**留痕**（进诊断包），不改任何行为、也不阻断激活。
    //   ★ 不 `return`：这条不上行回包，MAIN 侧不需要应答。
    if (payload.op === 'patchReport') {
      const p = payload as unknown as {
        failedCount?: number; failed?: string; all?: string; ua?: string;
      };
      void forensics('shieldPatch', {
        tabId,
        failedCount: p.failedCount ?? -1,
        failed: (p.failed ?? '').slice(0, 400),
        all: (p.all ?? '').slice(0, 600),
        ua: (p.ua ?? '').slice(0, 160),
      });
      return undefined;
    }
    if (payload.op === 'storageWrite') {
      const snap = tokens.get(binding.accountId) ?? {};
      if (payload.key === '__auth_token__') {
        if (payload.value === null) {
          // 页面内登出：清 token + 摘规则
          delete snap.token;
          delete snap.cookies;
          tokens.set(binding.accountId, snap);
          await persistTokens();
          await syncAccountRules(binding.accountId, binding.host);
          void forensics('logout', { accountId: binding.accountId, tabId });
        } else if (
          snap.token &&
          payload.value !== snap.token &&
          (() => {
            const a = jwtStableIdentity(snap.token!);
            const b = jwtStableIdentity(payload.value!);
            return a !== null && b !== null && a !== b;
          })()
        ) {
          // 身份叛逃：绑定页签被用户用于登录另一个账号（稳定载荷不同）
          await defectTabToRaw(tabId!, binding.accountId, binding.host, 'token 主体变更');
          return undefined;
        } else {
          await captureToken(binding.accountId, binding.host, payload.value);
          // 快照触发已内聚到 captureToken（首捕可能来自 authHeader 嗅探通道）
        }
      } else if (payload.key === '__auth_user__') {
        if (
          payload.value !== null &&
          snap.authUser &&
          (() => {
            const a = authUserIdentity(snap.authUser!);
            const b = authUserIdentity(payload.value!);
            // v3.12.0：两侧都成功提取才可比对——任一侧提取失败（非标准字段/原文）
            // 一律放行（原文比对会因时间戳差异把同账号误判为叛逃）
            return a !== null && b !== null && a !== b;
          })()
        ) {
          // 身份叛逃（用户信息主体变更；user 写入可能先于 token 写入到达）
          await defectTabToRaw(tabId!, binding.accountId, binding.host, '用户主体变更');
          return undefined;
        }
        snap.authUser = payload.value ?? undefined;
        tokens.set(binding.accountId, snap);
        await persistTokens();
      } else if (payload.key === '__device_fp__') {
        snap.deviceFp = payload.value ?? undefined;
        tokens.set(binding.accountId, snap);
        await persistTokens();
      }
      return undefined;
    }
    if (payload.op === 'authHeader') {
      // 二级捕获通道：fetch/XHR 出站 Authorization 头嗅探
      await captureToken(binding.accountId, binding.host, payload.value);
      return undefined;
    }
    if (payload.op === 'bagChanged') {
      // 袋→快照回流（v3.10.6）：页内 document.cookie 写入的实时并入
      try {
        await mergeBagIntoSnapshot(binding.accountId, binding.host, payload.bag ?? {});
      } catch (e) {
        void diag(`bagChanged(tab=${tabId}) 异常：${e instanceof Error ? e.message : String(e)}`);
      }
      return undefined;
    }
    if (payload.op === 'journalRollbackDone') {
      // ★ 2026-10-12 补：壳一直在发这条（`shield-main.ts` 的 journalRollback 之后），
      //   而这里**从来没有处理分支** ⇒ 叛逃处置的"回滚完成"在取证里完全不可见。
      //   它不是噪声：回滚是否真的跑完，决定了后面 nsWipeShared 的清扫有没有意义。
      void forensics('journalRollbackDone', { accountId: binding.accountId, tabId });
      return undefined;
    }
    if (payload.op === 'nsWipeSharedDone') {
      // ★ 2026-10-12 补：清扫结果回执。此前清扫是静默的，而"清掉了 0 个"
      //   与"清扫逻辑根本没生效"在取证里长得一样（后者曾是真实缺陷）。
      //   记 `dbsDropped` / `cachesDropped` 让这两者当场可分。
      void forensics('nsWipeSharedDone', {
        accountId: binding.accountId,
        tabId,
        dbsDropped: payload.dbsDropped,
        cachesDropped: payload.cachesDropped,
        ...(payload.error ? { error: payload.error } : {}),
      });
      if (payload.error) {
        void diag(`nsWipeShared(tab=${tabId}) 清扫出错：${payload.error}`);
      }
      return undefined;
    }
    return undefined;
  },

  /**
   * UI 列表：返回实时状态（绑定标签页 / token / 网络平面健康）。
   * host 取绑定标签页的，无绑定时取账号自身 siteHost；授权健康读取 isEnforceable
   * 的同步缓存（par.list 已预先预热）——修复旧实现「无绑定账号永远显示离线、
   * 未授权状态不可见」的问题。
   */
  statusOf(account: ParallelAccount): { tabIds: number[]; hasToken: boolean; enforcementOff: boolean } {
    const tabs = boundTabsOf(account.id);
    const host = tabs.length ? bindings.get(tabs[0])?.host : account.siteHost;
    // 仅「明确缓存为 false」才判未授权；未知（缓存空/SW 冷启未暖）不得误报——
    // v3.10.1 修复：导入后即使权限已授，缓存未暖也会显示「未授权·已暂停」
    const enforcementOff = host ? enforcement.get(host) === false : true;
    return { tabIds: tabs, hasToken: Boolean(tokens.get(account.id)?.token), enforcementOff };
  },

  /** 账号改名后刷新所有绑定标签页标题 */
  async refreshTitle(accountId: string): Promise<void> {
    const account = await parallelStore.get(accountId);
    await Promise.all(boundTabsOf(accountId).map((t) => applyTitle(t, account.tabName)));
  },

  /**
   * 该标签页绑定的**站点 host**（未绑定返回 `undefined`）。
   *
   * ★ 2026-10-12 新增，用途单一且安全相关：`sb:autoLoginRequest` 必须判断
   *   "**这个 frame 是不是本账号站点的**"才能把明文账密交给它。
   *   此前那个处理分支只认 `sender.tab?.id`、不认 frame —— 而 `auto-login.js`
   *   是 `all_frames: true` ⇒ 绑定页签里**任意** iframe（含第三方广告/统计 iframe）
   *   在一次登录的 60 秒 TTL 内都能索取到该账号的明文口令。
   */
  boundHostOf(tabId: number): string | undefined {
    return bindings.get(tabId)?.host;
  },

  /**
   * 该标签页绑定的**账号 id**（未绑定返回 `undefined`）。
   *
   * ★ 2026-10-19 新增：`favorites.open` 要判断"这个请求来自哪个账号的页签" ——
   *   常用页面必须**在该账号的登录态下打开**，否则新页签拿到的是共享 jar 里的
   *   空白身份，用户还得再登录一遍。判断依据只能是后台的绑定表（`sender.tab`），
   *   不能让页面自报账号 id。
   */
  boundAccountOf(tabId: number): string | undefined {
    return bindings.get(tabId)?.accountId;
  },

  /** 诊断用内部状态快照（经 ql.diag 消息暴露给台架） */
  debugState(): Record<string, unknown> {
    return {
      bindings: Array.from(bindings.entries()).map(([t, b]) => ({ t, accountId: b.accountId, host: b.host })),
      tokenAccounts: Array.from(tokens.keys()),
      tokens: Array.from(tokens.entries()).map(([id, t]) => ({ id, hasToken: Boolean(t.token), authUser: t.authUser ?? null })),
      enforcement: Array.from(enforcement.entries()).map(([h, ok]) => `${h}=${ok}`),
    };
  },

  /* ------- 导航事件钩子（由 registerParallelHandlers 驱动） ------- */

  /** 标签页导航开始：重新推绑定种子与标题（SPA/整页刷新都会重置） */
  async onNavigation(tabId: number): Promise<void> {
    // ★ v4.2.27：冷启动窗口内 bindings 尚空，先等一次 restore 再判（否则复制/开窗的新
    //   页签会被判成"未绑定"）。
    await ensureReady();
    // v3.13 收编加固：候选页签的首个真实导航落地 → 按目标 URL 决定收编或放弃。
    // 授权域内（host 或 *.父域）→ 正式收编（此刻才发种子/装规则）；
    // 授权域之外 / 登录页 → 丢弃候选（页签保持原生，种子/规则零接触）。
    const pending = pendingAdoptions.get(tabId);
    if (pending) {
      if (Date.now() > pending.expires) {
        // 候选超时（30s 内未发生真实导航）：放弃并让壳回直通
        pendingAdoptions.delete(tabId);
        void pushDown(tabId, { op: 'unbound' });
        return;
      }
      let url = '';
      try {
        const tab = await chrome.tabs.get(tabId);
        // ★ v4.2.27：`pendingUrl` 优先 —— `status=loading` 到达时 `url` 偶尔还是旧文档
        //   （尤其复制页签 + 前一个文档被缓存时），拿旧 URL 判授权域会误判成"外部域"。
        url = (tab as { pendingUrl?: string }).pendingUrl || tab.url || '';
      } catch {
        pendingAdoptions.delete(tabId);
        return;
      }
      if (!/^https?:\/\//i.test(url)) {
        void diag(`adopt-candidate tab=${tabId} URL 尚未落地（${url || '空'}）：保留候选继续等`);
        return; // 尚未发生真实导航（about:blank 等），继续等待
      }
      void diag(`adopt-candidate tab=${tabId} 结算 url=${url} 账号=${pending.accountId}`);
      pendingAdoptions.delete(tabId);
      let urlHost = '';
      let path = '';
      try {
        const u = new URL(url);
        urlHost = u.hostname;
        path = u.pathname.toLowerCase();
      } catch {
        void diag(`adopt-candidate tab=${tabId} URL 不可解析：丢弃候选`);
        void pushDown(tabId, { op: 'unbound' });
        return;
      }
      // ★★ v4.2.32：与绑定页签同一套归属判据（精确 host 或子域 + 端口）。
      //   旧实现用 parentDomainOf 取末两段 ⇒ `evil.co.uk` 会被当成
      //   `foo.co.uk` 的同站而收编，随后 pushBind 把 token 灌进外部域。
      const sameSite = ownedBy(url, pending.host);
      if (!sameSite) {
        void diag(`adopt-candidate tab=${tabId} 目标 ${urlHost} 非授权域：丢弃候选（根本原则）`);
        void forensics('adopt-dropped', { tabId, accountId: pending.accountId, host: urlHost, reason: 'external-domain' });
        void pushDown(tabId, { op: 'unbound' });
        return;
      }
      if (path.includes('login') && !tokens.get(pending.accountId)?.token) {
        // v3.10.4 语义：继承页签进登录页 = 用户当独立浏览器用 → 保持原生（丢弃候选）
        void diag(`adopt-candidate tab=${tabId} 进入登录页：丢弃候选（转原始）`);
        void pushDown(tabId, { op: 'unbound' });
        return;
      }
      // ★ 2026-10-28：账号快照里**还有 token** 时，落登录页不等于"用户要手登" ——
      //   平台的 SPA 在种子晚到一步时会自己 401 然后 `location.replace('/login')`。
      //   按"丢弃候选"处理的话，这次收编机会就永久丢了（页签转原生，只能重登）。
      //   ⇒ 照常收编；新文档的 hello 会拿到 bind，壳在 loading 期就地激活。
      if (path.includes('login')) {
        void forensics('adopt-login-landing', { tabId, accountId: pending.accountId, path });
        void diag(`adopt-candidate tab=${tabId} 落登录页但账号仍有 token：照常收编（种子晚到的典型形态）`);
      }
      if (!tokens.get(pending.accountId)?.token) {
        await capturePreJar(pending.accountId, pending.host);
      }
      // ★★ v4.2.27：**先把身份落进绑定表，再去云端补元数据**。
      //   身份（accountId/host）来自父页签/复制源的**现有绑定**，是本地事实；
      //   `parallelStore.get()` 在离线时是秒级网络超时，把它放在前面会让收编
      //   晚到几秒 —— 那时平台的 SPA 早就 401 跳登录页了（"偶尔丢登录"）。
      try {
        bindings.set(tabId, { accountId: pending.accountId, host: pending.host, adopted: true });
        await persistBindings();
        await syncAccountRules(pending.accountId, pending.host);
        await pushBind(tabId);
        void forensics('adopt', { tabId, accountId: pending.accountId, host: pending.host, url });
        void diag(`adopt tab=${tabId} ← 账号=${pending.accountId}（URL 确认后立即收编）`);
      } catch (e) {
        // 收编中途失败必须留痕：否则页签停在"表里有绑定、却没有规则/种子"的半截态，
        // 看起来像"偶发丢账号"，而 diag 里一条记录都没有。
        void diag(`adopt tab=${tabId} 账号=${pending.accountId} 收编失败：${String(e)}`);
        void forensics('adopt-failed', { tabId, accountId: pending.accountId, error: String(e) });
        return;
      }
      // 存在性校验后置：账号真被删了 ⇒ 解绑 + 转原始页签（规则/种子一并摘掉）
      const account = await parallelStore.get(pending.accountId).catch(() => undefined);
      if (!account) {
        void diag(`adopt tab=${tabId} 账号 ${pending.accountId} 已不存在：解绑转原始`);
        void forensics('adopt-dropped', { tabId, accountId: pending.accountId, reason: 'account-missing' });
        await this.unbindTab(tabId);
        void chrome.tabs.reload(tabId).catch(() => undefined);
        return;
      }
      await applyTitle(tabId, account.tabName);
      return;
    }

    const binding = bindings.get(tabId);
    if (!binding) {
      return;
    }
    // 授权域护栏：绑定页签漫游到其它未授权 http(s) 域 → 解绑摘规则，
    // 防止账号种子/身份头流向非授权域（异域弹窗跳转、手动改址）。自身 host 不受影响。
    let url = '';
    try {
      url = (await chrome.tabs.get(tabId)).url ?? '';
    } catch {
      return;
    }
    if (/^https?:\/\//i.test(url)) {
      if (!ownedBy(url, binding.host)) {
        // ★★ v4.2.32：归属判定与**权限**解耦。
        //   旧判据 `host !== binding.host && !isEnforceable(host)` 里，
        //   `isEnforceable` 只回答"浏览器给没给权限"；通配授权（协议与主机
        //   都是星号，`ensureHostPermission` 的正常路径）下它对任意域都是 true ⇒
        //   页签漫游到 evil.com 也不解绑，随后 pushBind 把 token 灌过去。
        //   新判据只看归属：精确 host / 子域 / 端口一致，否则一律解绑。
        let host = url;
        try {
          host = new URL(url).hostname;
        } catch {
          // 保留原 URL 供取证
        }
        void diag(`onNavigation 越界 ${host}（绑定 ${binding.host}）：解除 tab=${tabId} 绑定`);
        void forensics('bind-escape', {
          tabId,
          accountId: binding.accountId,
          host,
          bound: binding.host,
        });
        await this.unbindTab(tabId);
        return;
      }
      // 继承页签进入登录页（v3.10.4）：用户把它当独立浏览器用了——在输入账密之前
      // 转回原始页签（解绑+重载），B 的登录从原生状态开始，与账号 A 互不干扰。
      // 仅限亲子继承页签；账号自己的页签会话过期重登不受影响。
      if (binding.adopted) {
        let path = '';
        try {
          path = new URL(url).pathname.toLowerCase();
        } catch {
          path = '';
        }
        if (path.includes('login')) {
          // ★★ 2026-10-28：**落登录页先别判死**。
          //
          //   v3.10.4 的语义（用户把这个继承页签当独立浏览器用 → 在输入账密之前
          //   转回原始页签）本身没错，但它把**我们自己的一次失败**也算成了"用户手输"：
          //   种子晚于页面 bundle 到达时，平台 SPA 会自己 401 后跳 `/login` ——
          //   那也是"落登录页"。原逻辑这时解绑 + 重载，于是刚收编成功的继承页签
          //   **第一次**跳登录页就被永久降级成原生页签（用户看到的就是"账号丢了"）。
          //
          //   ⇒ 只要账号快照里还有 token，就给**有限次**重灌机会（`pushBind` 让壳
          //     按绑定态重来，新文档 hello 时会就地激活），额度用完才转原始页签。
          //     额度按页签计、绑定生命周期内不重置：不会变成无限重载。
          const snapToken = tokens.get(binding.accountId)?.token;
          const used = loginGrace.get(tabId) ?? 0;
          if (snapToken && used < LOGIN_GRACE_LIMIT) {
            loginGrace.set(tabId, used + 1);
            void diag(`onNavigation 继承页签 tab=${tabId} 落登录页 ${path}（第 ${used + 1} 次）：重灌种子，暂不解绑`);
            void forensics('adopt-login-grace', { tabId, accountId: binding.accountId, attempt: used + 1, path });
            await pushBind(tabId);
            return;
          }
          void diag(`onNavigation 继承页签 tab=${tabId} 进入登录页 ${path}：转原始页签`);
          await this.unbindTab(tabId);
          void chrome.tabs.reload(tabId).catch(() => undefined);
          return;
        }
      }
    }
    const account = await parallelStore.get(binding.accountId).catch(() => undefined);
    if (!account) {
      return;
    }
    await pushBind(tabId);
    await applyTitle(tabId, account.tabName);
  },

  /** SW 冷启动恢复：绑定表 + token/Cookie 快照 → 重建内存态与规则（授权健康门控） */
  async restore(): Promise<void> {
    void diag('parallelSession.restore 开始');
    await readState();
    enforcement.clear();
    const persisted = new Map<number, { host: string; token: string | null; cookie: string | null }>();
    for (const [tabId, b] of bindings) {
      if (await isEnforceable(b.host)) {
        persisted.set(tabId, {
          host: b.host,
          token: tokens.get(b.accountId)?.token ?? null,
          cookie: cookieHeaderOf(b.accountId),
        });
      }
    }
    await tabRules.restore(persisted);
    void diag(`parallelSession.restore 完成 persisted=${persisted.size}`);
  },

  async handleTabRemoved(tabId: number): Promise<void> {
    pendingAdoptions.delete(tabId); // 候选页签关闭：清理（未正式收编无残留）
    adoptProbe.delete(tabId); // v4.2.27：待判页签关闭，别让 150ms 后的定时器白跑
    pageOpenTargets.delete(tabId);
    loginGrace.delete(tabId);
    reloadRequests.delete(tabId); // v4.2.32：needsReload 令牌桶随页签销毁
    if (bindings.has(tabId)) {
      await this.unbindTab(tabId);
    }
  },
};

async function tabStillAlive(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.get(tabId);
    return true;
  } catch {
    return false;
  }
}

/** 构造带种子快照的绑定载荷（hello 应答与主动推送共用）。
 *  authUser 恒输出：有值写值、无值输出 ''（种子空值 = 壳显式清除命名空间残留键） */
function buildBindPayload(accountId: string, tabId: number | undefined, host: string): BridgeDownPayload {
  const snap = tokens.get(accountId);
  const seed: Record<string, string> = {};
  if (snap?.token) {
    seed['__auth_token__'] = snap.token;
  } else {
    // v3.12.3：无快照 token = 登录前窗口——**显式清空命名空间残留的上一会话 token**。
    // 否则平台登录页读到残留 token 自动续用（authHeader 嗅探捕为「首捕」），用户
    // 再次登录签发的新 token（AuthCode 已变）会被身份护栏误判为异账号而拦截，
    // 快照卡死旧 token → API 全 401 → 反复登录失败（用户实测链路实锤）。
    seed['__auth_token__'] = '';
  }
  seed['__auth_user__'] = snap?.authUser ?? '';
  if (snap?.deviceFp) {
    seed['__device_fp__'] = snap.deviceFp;
  }
  // 账号 Cookie 快照的权威视图（非身份键；v3.12.1）：绑定时壳把袋整体同步到该视图。
  // 无 token（登录前窗口）时为空对象 = 清空上一会话残留的陈旧袋值——
  // 否则陈旧 Cookie 会经页内读取/袋回流毒化登录 POST（快捷登录登出后失败的根因）。
  const bag: Record<string, string> = {};
  for (const c of snap?.cookies ?? []) {
    if (!IDENTITY_COOKIE_BLACKLIST.has(c.name)) {
      bag[c.name] = c.value;
    }
  }
  return { op: 'bind', accountId, tabId, host, seed, bag };
}

/**
 * `url` 是否仍属于**该账号站点自己的域**（v4.2.32）。
 *
 * 旧护栏比较的是 `hostname !== binding.host` 再问 `isEnforceable(host)` ——
 * 后者只回答"浏览器给没给权限"，**不是归属**。一旦用户被引导授予
 * 通配式的全域授权（协议与主机都是星号，`ensureHostPermission` 的正常路径），
 * `isEnforceable` 对任意域都为 true ⇒ 页签漫游到 `evil.com` 也不解绑，随后 `pushBind`
 * 把 Bearer token 灌进外部站点。
 * 新判据与权限解耦：精确 host 或它的子域才算自己的域；端口也必须一致
 * （`foo:8080` 与 `foo:443` 是不同 origin）。
 */
function ownedBy(url: string, siteHost: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return false;
  }
  const bare = bareHostOf(siteHost);
  const host = bareHostOf(u.hostname);
  if (host !== bare && !host.endsWith(`.${bare}`)) {
    return false;
  }
  const wantPort = portOfHost(siteHost);
  if (wantPort === null) {
    return true;
  }
  const actual = u.port || (u.protocol === 'https:' ? '443' : '80');
  return actual === wantPort;
}

/** host 的裸主机名（去端口、去 IPv6 方括号、小写），只用于**归属判定**。 */
function bareHostOf(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    return end >= 0 ? h.slice(1, end) : h;
  }
  const idx = h.indexOf(':');
  return idx >= 0 ? h.slice(0, idx) : h;
}

/** host 的显式端口（`foo:8080` / `[::1]:8080`）；无端口返回 null。 */
function portOfHost(host: string): string | null {
  const idx = host.lastIndexOf(':');
  if (idx < 0) {
    return null;
  }
  const tail = host.slice(idx + 1);
  return /^\d+$/.test(tail) ? tail : null;
}

/**
 * 桥消息是否来自**绑定站点自己的 frame**（v4.2.32）。
 *
 * `sender.url` 由 Chrome 在 `chrome.runtime.onMessage` 里填写，内容脚本伪造不了 ——
 * 这是「bind/hello 广播到所有 frame」修复的服务端判据：顶层 frame 与同源 iframe
 * 通过，跨域 iframe 拒绝。取不到 URL 时**拒绝**（fail-closed）。
 */
function senderMatchesBinding(sender: BridgeSender, binding: ParBinding): boolean {
  const raw = sender.url ?? '';
  if (!raw) {
    return false;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return false;
  }
  if (bareHostOf(u.hostname) !== bareHostOf(binding.host)) {
    return false;
  }
  const wantPort = portOfHost(binding.host);
  if (wantPort === null) {
    return true;
  }
  const actual = u.port || (u.protocol === 'https:' ? '443' : '80');
  return actual === wantPort;
}

/* ---------------- needsReload 限流（v4.2.32） ----------------
 * 直通壳收到迟到 bind 时会请求刷新；正常链路一次就够。没有上限时，
 * 任意能发上行消息的页面都能把页签刷成循环（DoS / 拖垮登录流程）。
 * 60s 窗口最多 3 次，且两次间隔 ≥4s。 */
const RELOAD_WINDOW_MS = 60_000;
const RELOAD_MAX_PER_WINDOW = 3;
const RELOAD_MIN_GAP_MS = 4_000;
const reloadRequests = new Map<number, number[]>();

function allowReloadForRecover(tabId: number): boolean {
  const now = Date.now();
  const hits = (reloadRequests.get(tabId) ?? []).filter((t) => now - t < RELOAD_WINDOW_MS);
  const last = hits.length ? hits[hits.length - 1]! : 0;
  if (hits.length >= RELOAD_MAX_PER_WINDOW || (last !== 0 && now - last < RELOAD_MIN_GAP_MS)) {
    reloadRequests.set(tabId, hits);
    return false;
  }
  hits.push(now);
  reloadRequests.set(tabId, hits);
  return true;
}

/* ---------------- 新页签亲缘判定（v4.2.27） ----------------
 * 这段是"复制页签丢账号"的正面修复，读之前先看 `adoptProbe` 的注释：
 * `openerTabId` 在"站点开窗"与"用户复制"两种场景下含义不同，而后者指向的是
 * 复制那一刻的**前台页签** —— 照它继承就是串号，不继承就是登录页。
 */

/** 比对"是不是同一个文档"：忽略 hash（SPA 路由常只改 hash） */
function stripHash(url: string): string {
  const i = url.indexOf('#');
  return (i >= 0 ? url.slice(0, i) : url).trim();
}

/**
 * 登记收编候选（唯一点：身份 + 自我结算）。
 *
 * ★ 为什么登记完要立刻自己结算一次：候选本来由 `onNavigation`（status=loading）消费，
 *   而复制页签/hello 兜底这两条路上，那条 loading **往往已经过去**（那时还没有候选）。
 *   不补这一次判定，壳就一直 hold 在"既未激活、也未直通"的裸态等一条不来的 bind。
 */
function registerAdoptCandidate(tabId: number, accountId: string, host: string, via: string): void {
  if (bindings.has(tabId) || pendingAdoptions.has(tabId)) {
    return;
  }
  pendingAdoptions.set(tabId, { accountId, host, expires: Date.now() + PENDING_ADOPT_TTL });
  void forensics('adopt-candidate', { tabId, accountId, host, via });
  void diag(`adopt-candidate tab=${tabId} ← ${via} 账号=${accountId}（候选，待 URL 确认）`);
  void (async () => {
    try {
      await parallelSession.onNavigation(tabId); // URL 已落地就地收编；没落地会原样保留候选
    } catch {
      // onNavigation 内部自己兜：这里只是不让 promise 悬空
    }
    reapCandidateLater(tabId, 0); // 还没落地 ⇒ 800ms×3 后按直通放行
  })();
}

/**
 * 复制页签的"源页签"：Chrome 把复制出来的页签**插在源页签右边**，
 * 所以源就是 `index-1`（也兜一个 `index+1`，防某些版本上报的是插入前的 index）。
 *
 * ★ 只认"已绑定 + URL 与待导航 URL 相同"的邻居：URL 不同就不是同一次复制，
 *   宁可返回 undefined 让页签保持原生，也绝不猜一个账号塞进去（串号比丢账号更难查）。
 */
async function findDuplicateSource(
  tab: chrome.tabs.Tab,
): Promise<{ tabId: number; binding: ParBinding } | undefined> {
  const tabId = tab.id;
  if (tabId === undefined) {
    return undefined;
  }
  const wanted = stripHash((tab as { pendingUrl?: string }).pendingUrl || tab.url || '');
  if (!wanted) {
    return undefined;
  }
  let siblings: chrome.tabs.Tab[];
  try {
    siblings = await chrome.tabs.query({ windowId: tab.windowId });
  } catch {
    return undefined;
  }
  for (const index of [tab.index - 1, tab.index + 1]) {
    if (index < 0) {
      continue;
    }
    const cand = siblings.find((t) => t.id !== tabId && t.index === index);
    if (!cand || cand.id === undefined) {
      continue;
    }
    const binding = bindings.get(cand.id);
    if (!binding) {
      continue;
    }
    if (stripHash(cand.url || '') !== wanted) {
      continue;
    }
    return { tabId: cand.id, binding };
  }
  return undefined;
}

/**
 * 壳请求"刷新页面重来"（直通模式下收到迟到 bind）时的**唯一执行点**。
 *
 * ★ v4.2.28：不能由壳自己 `location.reload()` —— 那次 reload 作用在**已提交的旧文档**上，
 *   会把正在进行的导航打断（症状：用户刚点的地址被丢掉，页签退回 `/login`）。
 *   `isNavigating(tab)` 为真时直接跳过：在途导航提交的新文档会在 document_start 自己发
 *   `hello`，后台已有绑定 ⇒ 种子照常到达，比"打断它再刷新"更快也更安全。
 */
async function reloadForRecover(tabId: number, reason: string): Promise<void> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (tab && isNavigating(tab)) {
    void forensics('recover-skipped', {
      tabId,
      reason,
      why: 'navigating',
      pending: tab.pendingUrl ?? '',
      current: tab.url ?? '',
    });
    void diag(`recover tab=${tabId} 跳过刷新：页签正在导航（新文档会自己 hello）`);
    return;
  }
  void forensics('recover-reload', { tabId, reason });
  void diag(`recover tab=${tabId} 刷新重来（${reason || 'late-bind'}）`);
  await chrome.tabs.reload(tabId).catch(() => undefined);
}

/**
 * 待判页签的定夺（`ADOPT_PROBE_DELAY` 之后跑一次）。
 *
 * 判据只有一条：**等没等到 `onCreatedNavigationTarget`**。
 *  - 等到了 ⇒ 站点自己开的窗，`sourceTabId` 才是真来源（比 openerTabId 还准）；
 *  - 没等到 ⇒ 用户复制页签，`openerTabId` 是前台页签，改用相邻的源页签继承；
 *  - 都不成立 ⇒ 先 `pushDown(unbound)` 放行（页签保持原生，绝不串号）。
 */
async function decideAdoption(tabId: number): Promise<void> {
  const probe = adoptProbe.get(tabId);
  if (!probe) {
    return;
  }
  if (Date.now() - probe.at > ADOPT_PROBE_TTL) {
    adoptProbe.delete(tabId);
    return;
  }
  await ensureReady();
  if (bindings.has(tabId) || pendingAdoptions.has(tabId)) {
    adoptProbe.delete(tabId);
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    adoptProbe.delete(tabId); // 页签已关
    return;
  }
  const sourceTabId = pageOpenTargets.get(tabId);
  pageOpenTargets.delete(tabId);
  adoptProbe.delete(tabId);
  if (sourceTabId !== undefined) {
    const parent = bindings.get(sourceTabId) ?? bindings.get(probe.openerId);
    if (!parent) {
      void pushDown(tabId, { op: 'unbound' });
      return;
    }
    registerAdoptCandidate(tabId, parent.accountId, parent.host, `page-open←${sourceTabId}`);
    return;
  }
  // 没有 onCreatedNavigationTarget = 用户复制页签：openerTabId 是前台页签，绝不能用
  const source = await findDuplicateSource(tab);
  if (!source) {
    void forensics('adopt-duplicate-unresolved', { tabId, openerId: probe.openerId });
    void diag(`adopt-probe tab=${tabId} 判为复制页签但找不到源页签：保持原生（绝不串号）`);
    void pushDown(tabId, { op: 'unbound' });
    return;
  }
  void forensics('adopt-duplicate', {
    tabId,
    openerId: probe.openerId,
    sourceTabId: source.tabId,
    accountId: source.binding.accountId,
  });
  void diag(`adopt-probe tab=${tabId} 判为复制页签：源=${source.tabId} 账号=${source.binding.accountId}`);
  registerAdoptCandidate(tabId, source.binding.accountId, source.binding.host, `duplicate←${source.tabId}`);
}

/**
 * hello 兜底：用页签自己的 `openerTabId` 把"亲子继承候选"补登记上（见 handleBridge）。
 *
 * ★ 为什么这件事不能只在 `tabs.onCreated` 里做：那个回调里的候选登记排在一个
 *   `await` 之后，而壳的 hello 在 document_start 就发、且**只答一次**算数
 *   （`unbound` 会让壳 `settled`）。两条消息抢同一个 SW 唤醒，谁先到没有保证。
 * ★ 这里只做**纯身份补读**：不读账号库、不发种子、不装规则。授权域与登录页
 *   仍由 `onNavigation` 按落地 URL 判——补登记不会让种子流到外部域。
 */
async function ensureAdoptionCandidate(tabId: number): Promise<void> {
  const existing = pendingAdoptions.get(tabId);
  if (existing) {
    if (Date.now() <= existing.expires) {
      return;
    }
    pendingAdoptions.delete(tabId); // 过期候选不该继续 hold（onNavigation 会同样处理）
  }
  await ensureReady();
  if (bindings.has(tabId)) {
    return;
  }
  // ★ v4.2.27：复制页签待判期**不能**按 openerTabId 补登记 —— 那个 opener 是
  //   复制那一刻的前台页签，照它登记就是串号。交给 `decideAdoption` 定夺，
  //   hello 先答 hold 让壳等着（等它判完必然会有 bind 或 unbound 下来）。
  if (adoptProbe.has(tabId)) {
    return;
  }
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return; // 页签已关
  }
  const openerId = tab.openerTabId;
  if (openerId === undefined) {
    return;
  }
  const parent = bindings.get(openerId);
  if (!parent) {
    return;
  }
  // ★ 只给"可能是本账号站点"的子页签发 hold。
  //   壳收到 hold 会进入等待态（不激活、也不直通），要等到 `onNavigation` 按落地
  //   URL 判完才落定。对**已经明确要去外域**的链接（从绑定页签点出去的普通外链）
  //   多这一段等待没有好处：它们本来就要走直通，晚 100~300ms 才放行只会让首帧
  //   落在"既非绑定也非直通"的中间态。URL 未知（about:blank / 正在导航但还没定）
  //   时仍按候选登记——那正是"站点自己开窗、URL 稍后才定"的情形。
  const pending = (tab as { pendingUrl?: string }).pendingUrl || tab.url || '';
  if (pending && pending !== 'about:blank') {
    let host = '';
    try {
      host = new URL(pending).host;
    } catch {
      host = '';
    }
    if (host && host !== parent.host) {
      return; // 外域子页签：不登记，hello 照旧答 unbound（与没有候选时一致）
    }
  }
  pendingAdoptions.set(tabId, {
    accountId: parent.accountId,
    host: parent.host,
    expires: Date.now() + PENDING_ADOPT_TTL,
  });
  void forensics('adopt-candidate', { tabId, accountId: parent.accountId, host: parent.host, via: 'hello' });
  void diag(`adopt-candidate tab=${tabId} ← opener=${openerId} 账号=${parent.accountId}（hello 兜底登记）`);
  // ★ 必须自己给一个结算点：候选本来由 `onNavigation`（`tabs.onUpdated` status=loading）
  //   消费，而走到这里恰恰是"hello 已经发出去了"——那条 loading 事件通常**早于**
  //   document_start 的 hello 就已触发过（那时还没有候选，`onNavigation` 什么也没做）。
  //   不收尾的话壳会一直 hold 在"既未激活、也未直通"的裸态，等着一条永远不来的 bind。
  reapCandidateLater(tabId, 0);
}

/**
 * hello 兜底候选的收尾：等 URL 落定 → 交给 `onNavigation` 做同一套判定
 * （授权域内收编 / 外域或登录页丢弃），最多重试 3 次、约 2.4s，最后按直通放行。
 *
 * ★ 为什么不直接用候选 TTL（30s）：壳判 `hold` 之后**不再重试 hello**，页面会以裸态
 *   跑满那 30 秒；而导航在几十毫秒内就提交，2.4s 已经足够宽裕。
 * ★ 超时也只答 `unbound`、绝不"猜着收编"：收编要灌种子，宁可退回原生页签。
 */
function reapCandidateLater(tabId: number, attempt: number): void {
  setTimeout(() => {
    const pending = pendingAdoptions.get(tabId);
    if (!pending) {
      return; // 已被 onNavigation 结算，或页签已关/候选已撤
    }
    void (async () => {
      let tab: chrome.tabs.Tab | undefined;
      try {
        tab = await chrome.tabs.get(tabId);
      } catch {
        pendingAdoptions.delete(tabId); // 页签已关
        return;
      }
      const url = (tab as { pendingUrl?: string }).pendingUrl || tab.url || '';
      if (/^https?:\/\//i.test(url)) {
        await parallelSession.onNavigation(tabId); // 复用同一条判定：收编或丢弃都会 pushDown
        return;
      }
      if (attempt < 3) {
        reapCandidateLater(tabId, attempt + 1);
        return;
      }
      pendingAdoptions.delete(tabId);
      void diag(`adopt-candidate tab=${tabId} 等待 URL 超时：按直通放行`);
      void pushDown(tabId, { op: 'unbound' });
    })();
  }, 800);
}

async function pushBind(tabId: number): Promise<void> {
  const binding = bindings.get(tabId);
  if (!binding) {
    return;
  }
  // 携带账号快照作种子：壳激活瞬间即有正确 token/身份，杜绝跨账号读取窗口
  await pushDown(tabId, buildBindPayload(binding.accountId, tabId, binding.host));
}

async function pushDown(tabId: number, payload: BridgeDownPayload): Promise<void> {
  try {
    // ★★ v4.2.32：**只投给顶层 frame**（`frameId: 0`）。
    //
    //   此前不传 options ⇒ Chrome 把消息广播给该页签的**所有 frame**；而
    //   `manifest` 是 `all_frames: true`，于是每个跨域 iframe 的 ISOLATED 桥
    //   都会收到 bind，桥又把它 `postMessage` 给该 frame 的 MAIN/页面 JS ——
    //   `seed.__auth_token__` 与整袋 Cookie 等于直接交给第三方页面。
    //   （即使 MAIN 壳自己校验 host 也来不及：页面 JS 能直接监听 postMessage。）
    //
    //   同源 iframe 的激活改由各 frame 自己的 `hello` 完成：后台用
    //   `sender.url` 校验归属后才回 bind（见 `senderMatchesBinding`）。
    await chrome.tabs.sendMessage(
      tabId,
      { type: CONTENT_MESSAGE.bridgeDown, payload },
      { frameId: 0 },
    );
  } catch {
    // 内容脚本未就绪或页面已关闭：onNavigation/loading 事件会再次推送
  }
}

/** 装载事件监听；由 service-worker 调用一次 */
export function registerParallelHandlers(): void {
  // ★ v4.2.27：走记忆化的 ensureReady()（`restore()` 仍在里面跑），这样所有事件处理器
  //   都能 await 同一个 promise —— 不再有"监听已装、bindings 还是空的"那个窗口。
  void ensureReady();

  chrome.runtime.onStartup?.addListener(() => {
    // 浏览器启动：上一轮的 session 存储可能是脏的，重读一次（重置记忆化 promise）
    readyPromise = undefined;
    void ensureReady();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void parallelSession.handleTabRemoved(tabId);
  });

  // 站点自开的新页签：opener 已绑定 → 亲子继承（低代码平台弹窗编辑保持同一账号身份）
  chrome.tabs.onCreated.addListener((tab) => {
    void parallelSession.adoptFromOpener(tab);
  });

  // ★★ v4.2.27：`window.open` / `target=_blank` 的**同步证据**（复制页签不触发它）。
  //   `tabs.onCreated` 里报的 `openerTabId` 在"复制页签"场景指向的是复制那一刻的
  //   前台页签，靠它继承会串号；真正区分两种来源的就是这条事件的有无。
  chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
    const tabId = details.tabId;
    const sourceTabId = details.sourceTabId;
    if (typeof tabId !== 'number' || typeof sourceTabId !== 'number' || sourceTabId < 0) {
      return;
    }
    pageOpenTargets.set(tabId, sourceTabId);
    if (pageOpenTargets.size > 200) {
      // 正常情况下条目会被 decideAdoption 消费掉；这里只是防泄漏的兜底
      pageOpenTargets.clear();
      pageOpenTargets.set(tabId, sourceTabId);
    }
  });

  // 导航提交近似信号：status=loading 时重推种子/标题（不引入 webNavigation 权限）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
      void parallelSession.onNavigation(tabId);
    }
  });

  // 会话卫生：持续驱逐重入真实 jar 的扩展账号 Cookie（v3.10.2）
  chrome.cookies.onChanged.addListener((change) => {
    void evictJarCookie(change);
  });

  // 快照动态化（v3.10.6）+ 写入者归属（v3.11.1）：绑定页签收到的响应 Set-Cookie
  // 实时并入账号快照，并记录写入者归属（根本原则：原生页签写入不受卫生机制影响）。
  // 观察型 webRequest（MV3 允许；无 host 权限的站点不产生事件——授权门控天然成立）。
  if (chrome.webRequest?.onHeadersReceived) {
    chrome.webRequest.onHeadersReceived.addListener(
      (details: {
        tabId: number;
        url: string;
        statusCode?: number;
        type?: string;
        responseHeaders?: { name: string; value?: string }[];
      }) => {
        trackCookieAttribution(details);
        void captureResponseCookies(details);
        void reportFailureStatus(details);
      },
      { urls: ['*://*/*'] },
      // extraHeaders：Set-Cookie 头需显式请求可见性（Chrome 72+）
      ['responseHeaders', 'extraHeaders'],
    );
  }

  void cleanupStaleBindings();
}

/* ---------------- 打开失败自学习（v3.10.9） ----------------
 * 探测歧义的兜底：内网 https 自签证书会被 SW fetch 误判为「无 https」，或存量账号
 * 默认 https 而站点实为纯 http——打开落 chrome-error 页时，scheme 类网络错误触发
 * 协议翻转写回账号档案并原页签重开（用户无感；15s 防抖避免循环翻转）。 */

const SCHEME_FLIP_ERRORS = new Set([
  'net::ERR_SSL_PROTOCOL_ERROR',
  'net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_EMPTY_RESPONSE',
]);
const schemeFlipAt = new Map<string, number>();

/** scheme 类网络错误判定（ERR_SSL_PROTOCOL_ERROR = 443 无 TLS；REFUSED/RESET/EMPTY_RESPONSE = 端口未服务） */
export function isSchemeFlipError(error: string): boolean {
  return SCHEME_FLIP_ERRORS.has(error);
}

export async function handleOpenError(tabId: number, error: string): Promise<boolean> {
  const binding = bindings.get(tabId);
  if (!binding || !SCHEME_FLIP_ERRORS.has(error)) {
    return false;
  }
  const account = await parallelStore.get(binding.accountId).catch(() => null);
  if (!account) {
    return false;
  }
  const now = Date.now();
  if (now - (schemeFlipAt.get(binding.accountId) ?? 0) < 15_000) {
    return false; // 翻转冷却中：让当前重开结果先落地
  }
  const current = account.scheme ?? 'https';
  const flipped: Scheme = current === 'https' ? 'http' : 'https';
  schemeFlipAt.set(binding.accountId, now);
  await parallelStore.updateScheme(binding.accountId, flipped);
  const hasToken = Boolean(tokens.get(binding.accountId)?.token);
  const url = `${flipped}://${account.siteHost}${hasToken ? '/' : '/login'}`;
  void diag(`handleOpenError(${binding.accountId}) ${error} → scheme 自学习 ${current}→${flipped}，重开 ${url}`);
  await chrome.tabs.update(tabId, { url });
  return true;
}

/** 恢复时清理指向已不存在标签页的陈旧绑定 */
async function cleanupStaleBindings(): Promise<void> {
  for (const tabId of Array.from(bindings.keys())) {
    const alive = await tabStillAlive(tabId);
    if (!alive) {
      await parallelSession.handleTabRemoved(tabId);
    }
  }
}
