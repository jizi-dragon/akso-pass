/**
 * DNR session 规则管理 —— 「多平面隔离」的网络平面 v4.1。
 *
 * 每个绑定标签页维护至多两条 session 规则：
 *  1) AUTH 规则：Authorization → set 'Bearer <token>'（token 可能为 null：未捕获前不装）；
 *  2) COOKIE 规则：Cookie 请求头 → remove（与 token 无关，绑定即装）。
 *
 * CACHE 分区平面（v3.3 引入的 `_qlck=t<tabId>`）自 v4.1 起改由 MAIN 壳页面层实现
 * （shield-main.ts 的 fetch/XHR 包装直接追加查询参数）：Chrome 的 DNR 从未实现
 * `redirect.urlTransform`（MDN 该字段为 Firefox 专属；Chromium 一直以
 * "Unexpected property: 'urlTransform'" 拒绝），且 updateSessionRules 是原子批量——
 * 该无效规则曾导致同批的 COOKIE/AUTH 规则全部被拒（四象限泄漏期间网络平面全死的根因）。
 *
 * 安装策略：逐条安装 + 单条失败降级（不再原子批量连坐）。
 * 页面存储层继续由 MAIN 壳虚拟化；目标站为无状态 JWT 设计（DESIGN.md §3）。
 */

/** AUTH 规则 id 区间 */
// ★ 本文件此前**没有任何 import**（纯常量 + 类型 + DNR 调用）。
//   日志是它的第一个外部依赖 —— 用 `shared/log`（唯一公开面，强制打码）。
//   ★ 它**不碰 `chrome.*`**，所以对 content script 也是安全的（AGENTS.md 规则 10）。
import { getLogger } from '../../shared/log';

const AUTH_BASE = 100_000;
/** COOKIE 规则 id 区间 */
const COOKIE_BASE = 200_000;

interface RuleMeta {
  authId?: number;
  cookieId?: number;
  /** 当前 AUTH 规则的 token；null 表示未装 AUTH 规则 */
  token: string | null;
  /** 当前 COOKIE 规则的回放值；null 表示 remove（剥离）模式 */
  cookieValue: string | null;
}

const installed = new Map<number, RuleMeta>();

/**
 * 本模块的 logger。
 *
 * ★ 与 `diag()` 的分工（AGENTS.md 规则 22）：
 *   · `log.*` → 带级别、进内存环形 200 与 DevTools，**也进诊断包的 `appLogs`**
 *   · `diag()` → `storage.local` 的人读文本（环形 60，**稀缺**）
 * ⇒ 中频轨迹（每条规则装上/摘掉）走 `log.debug`（默认 `info` ⇒ 生产静默）；
 *   真正的失败走 `log.error` + `diag()` 双写。
 */
const log = getLogger('tab-rules');

/** 诊断埋点（与 parallel-session 共用 storage.local['ql:diag'] 环形缓冲） */
async function diag(msg: string): Promise<void> {
  try {
    const key = 'ql:diag';
    const cur = (await chrome.storage.local.get(key))[key] as string[] | undefined;
    const next = [...(cur ?? []).slice(-59), `${new Date().toISOString().slice(11, 23)} ${msg}`];
    await chrome.storage.local.set({ [key]: next });
  } catch {
    // 埋点失败不影响业务
  }
}

let nextAuthId = AUTH_BASE;
let nextCookieId = COOKIE_BASE;

const ALL_MATCH_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  'main_frame',
  'sub_frame',
  'xmlhttprequest',
  'websocket',
  'script',
  'stylesheet',
  'image',
  'font',
  'media',
  'other',
] as chrome.declarativeNetRequest.ResourceType[];

/**
 * Authorization 规则的资源类型（v4.2.33 收窄）。
 *
 * ★ 与 `ALL_MATCH_TYPES` 的差别：**不再**给 script / stylesheet / image / font /
 *   media 附加 Bearer。理由是最小权限：
 *   - 这些子资源本来就由浏览器按正常语义加载，平台不会拿 Authorization 头去
 *     鉴权静态资源；把 token 附在图片/字体请求上只会把它送进 CDN、代理和
 *     访问日志，扩大泄露面；
 *   - `initiatorDomains` 已经挡住跨域 iframe 冒用，但"同站页面里的一张第三方
 *     图片指向本站"仍会命中 requestDomains —— 资源类型再收一刀，双保险。
 * ★ 保留的四类各有明确用途：main_frame（顶层下载/导航）、sub_frame（管理端
 *   iframe 文档）、xmlhttprequest（API）、other（`<a download>` 的下载归型）。
 *   websocket 握手也保留：DNR 对 modifyHeaders + websocket 的支持依赖 Chrome
 *   版本，装不上时 `addOne` 会记诊断并继续安装其余规则。
 */
const AUTH_MATCH_TYPES: chrome.declarativeNetRequest.ResourceType[] = [
  'main_frame',
  'sub_frame',
  'xmlhttprequest',
  'websocket',
  'other',
] as chrome.declarativeNetRequest.ResourceType[];

function asRule(raw: unknown): chrome.declarativeNetRequest.Rule {
  return raw as unknown as chrome.declarativeNetRequest.Rule;
}

/**
 * 常见「二级后缀」（public suffix 的第二层）——只列高频项，不是完整 PSL。
 *
 * ★ v4.2.32 安全修复的背景：旧实现无条件 `parts.slice(-2)`，于是
 *   `foo.co.uk → co.uk`、`x.github.io → github.io`，DNR 的 requestDomains
 *   会把该账号的 Bearer 附加到**整个公共后缀/托管域**下的请求上 ——
 *   绑定页里一个指向 `evil.co.uk` 的 `<img>` 就能把 token 送到攻击者服务器。
 *   有了这张表，`foo.co.uk` 不再被"上提"到 `co.uk`；4 段以上才上提到
 *   `example.co.uk`（注册域），仍是站点自己的域族。
 *   ★ 残留：表外的多级后缀（如 `com.py`）仍会被当成父域；完整修复需引入 PSL
 *   数据（体积/维护成本高），这里按"高频 + 托管域"覆盖，其余在威胁模型里注明。
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'ac.uk', 'gov.uk', 'nhs.uk', 'police.uk', 'sch.uk',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ed.jp',
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'org.mx', 'gob.mx', 'edu.mx',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'gov.za', 'ac.za',
  'com.sg', 'net.sg', 'org.sg', 'gov.sg', 'edu.sg',
  'com.hk', 'net.hk', 'org.hk', 'gov.hk', 'edu.hk',
  'com.tw', 'net.tw', 'org.tw', 'gov.tw', 'edu.tw',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my',
  'co.id', 'or.id', 'go.id', 'ac.id', 'web.id',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.ar', 'net.ar', 'org.ar', 'gov.ar', 'edu.ar',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'org.pe', 'gob.pe', 'edu.pe',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  'co.il', 'org.il', 'gov.il', 'ac.il',
  'com.ua', 'net.ua', 'org.ua', 'gov.ua', 'edu.ua',
  'com.pl', 'net.pl', 'org.pl', 'gov.pl', 'edu.pl',
  'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru',
]);

/**
 * 托管/云平台后缀：整段是别人的"公共租户域"，绝不能作为父域扩展。
 * `x.github.io` 的 `github.io` 属于 GitHub，不属于该租户。
 */
const HOSTING_SUFFIXES = [
  'github.io', 'gitlab.io', 'gitee.io', 'herokuapp.com', 'appspot.com', 'cloudfront.net',
  'azurewebsites.net', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 's3.amazonaws.com', 'r2.dev', 'deno.dev', 'fly.dev', 'onrender.com',
  'glitch.me', 'repl.co', 'surge.sh', 'now.sh',
];

/** 父域（aksoegmp.com）：DNR requestDomains 语义为「该域及其全部子域」，覆盖网关/接口子域。
 *  IP 字面量（全数字段，内网站点）没有父域概念，返回原 host（在 requestDomains 里重复无害），
 *  避免把 10.100.0.105 拼出 '0.105' 这类无意义域。
 *
 *  ★ v4.2.32：感知公共后缀。`foo.co.uk` 返回自身而不是 `co.uk`；
 *    托管域（`x.github.io`）同样返回自身。见 `MULTI_LABEL_SUFFIXES` 的注释。 */
export function parentDomainOf(host: string): string {
  const parts = host.split('.');
  if (parts.length > 2 && parts.every((p) => /^\d+$/.test(p))) {
    return host;
  }
  const lower = host.toLowerCase();
  if (HOSTING_SUFFIXES.some((s) => lower === s || lower.endsWith(`.${s}`))) {
    return host;
  }
  if (parts.length <= 2) {
    return host;
  }
  const last2 = parts.slice(-2).join('.').toLowerCase();
  if (MULTI_LABEL_SUFFIXES.has(last2)) {
    // `foo.co.uk`（3 段）本身就是注册域；`x.foo.co.uk`（4 段）的父域是 `foo.co.uk`
    return parts.length > 3 ? parts.slice(-3).join('.') : host;
  }
  return parts.slice(-2).join('.');
}

/** DNR requestDomains 不含端口；siteHost 带 ":port" 时剥离（v3.10.6 加固） */
export function hostNoPortOf(host: string): string {
  const idx = host.indexOf(':');
  return idx >= 0 ? host.slice(0, idx) : host;
}

function buildAuthRule(ruleId: number, host: string, tabId: number, token: string): chrome.declarativeNetRequest.Rule {
  return asRule({
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [{ header: 'Authorization', operation: 'set', value: `Bearer ${token}` }],
    },
    condition: {
      // 全资源类型（与 COOKIE 规则同宽，v3.13.2）：
      // - xmlhttprequest/websocket：API 与 WS 握手；
      // - sub_frame：iframe 内嵌文档（低代码平台「管理端」控制台常以 iframe 承载，
      //   无 Bearer 的子框架会被服务端当匿名拒入）；
      // - main_frame：顶层下载导航（纯 Bearer 鉴权平台的导出接口，缺头即 401）；
      // - other：`<a download>` 属性发起的下载请求在 DNR 里常归为此型（3.13.1 只补
      //   main_frame 仍 401 的教训——下载归型因发起方式而异，与 COOKIE 规则同宽才算到位）。
      // ★ v4.2.33：静态资源（script/stylesheet/image/font/media）已从本规则剔除，
      //   见 `AUTH_MATCH_TYPES` 的注释——那几类不需要 Authorization，附上只是把
      //   token 多送进几个日志。
      resourceTypes: AUTH_MATCH_TYPES,
      requestDomains: [hostNoPortOf(host), parentDomainOf(hostNoPortOf(host))],
      // ★★ v4.2.32：把 Bearer 限定为**本账号站点自己发起的请求**。
      //
      //   此前只有 tabIds + requestDomains：绑定页签里的**跨域第三方 iframe**
      //   （广告/统计/嵌入页）只要 fetch 到站点域，DNR 就会替它加上该账号的
      //   Bearer —— 等于把账号 API 权限借给第三方页面（它读不到响应，但能发
      //   状态变更请求，且请求在服务端看是"账号本人"）。
      //   `initiatorDomains` 比的是**发起请求的 frame 的 origin**：站点自己的
      //   页面/同源 iframe = 站点 host ⇒ 放行；跨域 iframe = 第三方 host ⇒ 不匹配。
      //   ★ 只写 host（不写父域）：父域未必在 host_permissions 里，写进去可能
      //     让整条规则安装失败（PITFALLS #1：一条装不上会连坐整个网络平面）。
      //   ★ main_frame/other 仍保留：顶层下载导航的 initiator 就是站点页面，
      //     照样匹配；而用户手输 URL（无 initiator）本来也不需要 Bearer。
      initiatorDomains: [hostNoPortOf(host)],
      tabIds: [tabId],
    },
  });
}

/**
 * COOKIE 规则：v3.6 起支持「按账号回放」——cookieHeader 非 null 时 set（服务端始终看到
 * 一致的会话身份，对齐 SessionBox 核心机制）；null 时保持 remove（共享 jar 对绑定标签隐身）。
 */
function buildCookieRule(
  ruleId: number,
  host: string,
  tabId: number,
  cookieHeader: string | null,
): chrome.declarativeNetRequest.Rule {
  return asRule({
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        cookieHeader
          ? { header: 'Cookie', operation: 'set', value: cookieHeader }
          : { header: 'Cookie', operation: 'remove' },
      ],
    },
    condition: {
      // 全类型覆盖：绑定标签页的出站 Cookie 完全由本规则决定，与真实 jar 无关
      resourceTypes: ALL_MATCH_TYPES,
      requestDomains: [hostNoPortOf(host), parentDomainOf(hostNoPortOf(host))],
      tabIds: [tabId],
    },
  });
}

/** 单条规则安装（返回是否成功；失败仅记录诊断，不阻断其余规则） */async function addOne(rule: chrome.declarativeNetRequest.Rule): Promise<boolean> {
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ addRules: [rule] });
    // ★ 成功的安装走 `debug`（中频：由 `syncAccountRules` 在 cookie 变化时驱动）。
    //   排障时它回答"这条规则到底装上了没有、id 是多少" —— 而 id 是 `ql.diag`
    //   里 `sessionRuleCount` 与实际规则对不上的唯一线索。
    log.debug('addRule #%d 装上（%s）', rule.id, rule.condition?.tabIds?.join(',') ?? '-');
    return true;
  } catch (e) {
    // ★ 失败同时走两条：`diag()`（进诊断包的人读文本）
    //   与 `log.error`（带级别、进 `appLogs`、也进诊断包）。
    //   ★ **这是本文件最要紧的一条日志**：历史教训（PITFALLS #1、#8）是
    //     `updateSessionRules` 的失败会让**整个网络平面一起死**，
    //     而当时唯一的信号就是这一行 —— 它必须显眼。
    log.error('addRule #%d **失败**：%s',
      rule.id, e instanceof Error ? e.message : String(e));
    void diag(`addRule #${rule.id} 失败：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export const tabRules = {
  /**
   * 设置/更新某绑定标签页的网络平面规则。
   * - COOKIE 规则绑定即装：cookieHeader 非 null → set（回放），变更时重建；
   *   null → remove（剥离）。
   * - token 非 null 时装/换 AUTH 规则；null 时摘除。
   * 逐条安装：单条失败不连坐其余规则。
   */
  async applyBinding(host: string, tabId: number, token: string | null, cookieHeader?: string | null): Promise<void> {
    const wanted = cookieHeader ?? null;
    const meta: RuleMeta = installed.get(tabId) ?? { token: null, cookieValue: null };

    const removes: number[] = [];

    // COOKIE 规则（首次安装，或回放值发生变化时重建）
    if (meta.cookieId === undefined || meta.cookieValue !== wanted) {
      if (meta.cookieId !== undefined) {
        removes.push(meta.cookieId);
        meta.cookieId = undefined;
      }
      const ruleId = nextCookieId++;
      if (await addOne(buildCookieRule(ruleId, host, tabId, wanted))) {
        meta.cookieId = ruleId;
        meta.cookieValue = wanted;
      }
    }

    // AUTH 规则
    if (token === null) {
      if (meta.authId !== undefined) {
        removes.push(meta.authId);
        meta.authId = undefined;
      }
      meta.token = null;
    } else if (meta.token !== token) {
      if (meta.authId !== undefined) {
        removes.push(meta.authId);
        meta.authId = undefined;
      }
      const ruleId = nextAuthId++;
      if (await addOne(buildAuthRule(ruleId, host, tabId, token))) {
        meta.authId = ruleId;
        meta.token = token;
      }
    }

    if (removes.length) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removes });
      } catch (e) {
        // ★ 移除失败比安装失败**更隐蔽**：安装失败会让功能不生效（用户会发现"串号了"），
        //   而移除失败会让**本该失效的旧规则继续生效** ——
        //   表现是"已经切了账号/已解绑，但请求还带着上一个账号的头"。
        //   两种失败的方向相反，所以必须能分开（照 `cloud-store` 里那条同源推理）。
        log.error('移除规则**失败** ids=%s：%s',
          removes.join(','), e instanceof Error ? e.message : String(e));
        void diag(`updateRules 移除失败 ids=${removes.join(',')}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    installed.set(tabId, meta);
    // ★★ 这里记的**不只是轨迹**。注意上面两条安装都是"失败就不写 meta"：
    //   所以 `meta.cookieId`/`meta.authId` 为 `undefined` 就意味着那次安装失败了。
    //
    //   ⇒ 最危险的形态是**两条都失败**：页签**完全没有网络平面保护**
    //     （既不回放 Cookie，也不改 AUTH 头），而它与"装好了"在界面上**长得一样** ——
    //     平台照样能打开，只是**以错误的身份**在跑。
    //     这正是 PITFALLS #1/#8 描述的那类静默失效，所以这里分成两级记。
    const authApplied = meta.authId !== undefined;
    const cookieApplied = meta.cookieId !== undefined;
    log.debug('applyBinding tab=%d token=%s cookie=%s → cookieId=%s authId=%s',
      tabId,
      token ? '有' : '无',
      wanted ? `回放${wanted.length}B` : '剥离',
      meta.cookieId ?? '-',
      meta.authId ?? '-');
    if (token !== null && !authApplied) {
      // 有 token 却装不上 AUTH 规则 ⇒ 该页签的请求**不会带正确的 Bearer**
      log.error('applyBinding tab=%d 有 token 但 AUTH 规则**未装上** ⇒ 页签将以错误身份请求',
        tabId);
    }
    if (!cookieApplied) {
      // COOKIE 规则没装上 ⇒ 要么没回放快照（掉登录），要么没剥离（串号）
      log.error('applyBinding tab=%d COOKIE 规则**未装上** ⇒ 网络平面不完整（%s）',
        tabId, wanted ? '应回放但未回放' : '应剥离但未剥离');
    }
    void diag(
      `applyBinding tab=${tabId} token=${token ? '有' : '无'} cookie=${wanted ? `回放${wanted.length}B` : '剥离'} cookieId=${meta.cookieId ?? '-'} authId=${meta.authId ?? '-'}`,
    );
  },

  /** 标签关闭 / 解绑：摘除其全部规则 */
  async clearTab(tabId: number): Promise<void> {
    const meta = installed.get(tabId);
    if (!meta) {
      return;
    }
    const removes: number[] = [];
    if (meta.cookieId !== undefined) {
      removes.push(meta.cookieId);
    }
    if (meta.authId !== undefined) {
      removes.push(meta.authId);
    }
    try {
      if (removes.length) {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removes });
      }
    } catch {
      // 忽略
    }
    installed.delete(tabId);
    void diag(`clearTab tab=${tabId} del=${removes.length}`);
  },

  /**
   * SW 冷启动恢复：persisted 提供 tabId → { host, token|null }，
   * 与浏览器内现存 session 规则做差集同步（孤儿清理 + 缺失重建）。
   */
  async restore(persisted: Map<number, { host: string; token: string | null; cookie?: string | null }>): Promise<void> {
    let existing: chrome.declarativeNetRequest.Rule[] = [];
    try {
      existing = await chrome.declarativeNetRequest.getSessionRules();
    } catch (e) {
      /* ★★ 2026-10-16：原来是裸吞（`catch { existing = []; }`），而它有两个**都静默**的后果：
       *
       *  ① **孤儿规则永远不会被清理**：下面的差集算法拿 `existing` 当"浏览器里现在有什么"，
       *     空集 ⇒ 它算出"没有任何规则要删" ⇒ 上一次运行留下的规则**永久留在浏览器里**。
       *  ② **规则 id 会撞车**：`nextAuthId / nextCookieId` 从 `AUTH_BASE / COOKIE_BASE`
       *     重新分配（它不知道那些 id 已被占用）⇒ 加规则时 `updateSessionRules`
       *     （**原子批量**，见规则 1）会因为 id 冲突**整批被拒** —— 于是 AUTH 与 COOKIE
       *     两个平面一起失效，而运维**只看到**下游那句 `addRule #%d 失败`，
       *     真正的原因（读规则失败）从未出现。
       *
       * ★ 用 `error` 而不是 `warn`：这一条会让**另一个平面**静默失效，
       *   而不是"某个功能没生效"。级别与后果相称（规则 17：失败不能用 debug）。
       */
      log.error('getSessionRules 失败 ⇒ 孤儿规则无法清理、且规则 id 将从 %d 重新分配（会撞上旧规则，'
        + '整批 updateSessionRules 可能被拒）：%s', AUTH_BASE, e instanceof Error ? e.message : String(e));
      existing = [];
    }

    // 孤儿清理：本扩展区间内、不属于当前意图集的规则
    const desiredTabs = new Set(persisted.keys());
    const removals: number[] = [];
    for (const rule of existing) {
      const inOurs = rule.id >= AUTH_BASE;
      const orphans = (rule.condition.tabIds ?? []).every((t) => !desiredTabs.has(t));
      if (inOurs && orphans) {
        removals.push(rule.id);
      }
    }
    if (removals.length) {
      try {
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: removals });
      } catch {
        // 忽略
      }
    }

    nextAuthId = Math.max(
      AUTH_BASE,
      ...existing.filter((r) => r.id >= AUTH_BASE && r.id < COOKIE_BASE).map((r) => r.id + 1),
      AUTH_BASE,
    );
    nextCookieId = Math.max(
      COOKIE_BASE,
      ...existing.filter((r) => r.id >= COOKIE_BASE).map((r) => r.id + 1),
      COOKIE_BASE,
    );

    installed.clear();
    for (const [tabId, info] of persisted) {
      await this.applyBinding(info.host, tabId, info.token ?? null, info.cookie ?? null);
    }
    void diag(`tabRules.restore persisted=${persisted.size}`);
  },

  /** 诊断用内部状态快照（经 ql.diag 消息暴露给台架） */
  debugState(): Record<string, unknown> {
    return {
      installed: Array.from(installed.entries()).map(([t, m]) => ({
        t,
        authId: m.authId ?? null,
        cookieId: m.cookieId ?? null,
        token: m.token ? '有' : '无',
        cookie: m.cookieValue ? `回放${m.cookieValue.length}B` : '剥离',
      })),
      nextAuthId,
      nextCookieId,
    };
  },
};
