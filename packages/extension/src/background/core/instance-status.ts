/**
 * 实例状态（B3 读 / B4 写）—— 平台对象实例的「生命周期状态」查询与切换。
 *
 * ## 架构约束（决定了本模块为什么长这样）
 *
 * 1. **请求必须在目标页签的页面世界发起**。Akso Pass 的 AUTH / COOKIE 改头是 DNR session 规则，
 *    条件含 `tabIds:[tabId]`（见 `tab-rules.ts`）—— 后台自己 `fetch` 没有 tabId，
 *    既拿不到本账号的 Bearer，也拿不到 Cookie 回放，会读到共享 jar（跨账号）。
 *    所以本模块一律 `chrome.scripting.executeScript({ world: 'MAIN' })`。
 * 2. **顺带拿到缓存分区**。MAIN world 的 `fetch` 被 shield-main 包装，同源 GET 会追加
 *    `_qlck=t<tabId>`；ISOLATED world 的 fetch 不经包装，会落在**全 profile 未分区缓存**上
 *    ——那正是「状态列表命中上一个账号的缓存」这条既有泄漏通道（shield-main.ts 头部注释）。
 * 3. **绝不读 `document.cookie` 取 token**。Cookie 虚拟化补丁打在 MAIN world 的 `document` 上，
 *    ISOLATED 世界读到的是**真实 jar**；而会话卫生会把身份键从真实 jar 驱逐
 *    （`IDENTITY_COOKIE_BLACKLIST` + 差集清扫）⇒ 常为空，甚至是他账号残留。
 *    身份交给 DNR 补，本模块不碰任何凭据。
 *
 * ## 平台接口（形状来自同事扩展 akso-config-assistant v2.1.0 的实现，该实现全程 BFS 容错，
 *    说明服务端响应形状并不稳定 —— 这里同样做容错，且把「猜」的地方显式标出来）
 *
 *   POST /api/platform/Layout/GetFormInstance                 {objectId,instanceId,isCopy:false} → lifecycle{id,name}
 *   GET  /api/config/lifecycle/Status/GetListByBasicId        ?basicId={lifecycleId}            → 状态数组
 *   GET  /api/platform/UserView/GetViewList                   ?menuId={mid}                     → 反查 objectId
 *   POST /api/openapi/v1.0/Object/status/{instanceId}/{code}                                    → 改状态
 */

/* ==================== URL 解析（与平台约定：bid=objectId / id=instanceId / mid=菜单） ==================== */

export interface InstanceContext {
  href: string;
  origin: string;
  /** URL 的 `bid` */
  objectId: string;
  /** URL 的 `id` */
  instanceId: string;
  /** `/web/view?mid=` 的菜单 id（objectId 缺失时用它反查） */
  menuId: string;
}

function safeDecode(v: string): string {
  try {
    return decodeURIComponent(v);
  } catch {
    // 编码不完整（页面自己拼坏过）时退化成手工替换几个常见转义，别整段丢掉
    return v.replace(/%2F/gi, '/').replace(/%3F/gi, '?').replace(/%3D/gi, '=').replace(/%26/gi, '&');
  }
}

/**
 * 取查询参数。参数名必须紧跟 `? & # /` 或位于串首 ——
 * 否则 `bid=` 会匹配到 `objectid=` 这类同尾参数（同事实现踩过并写了注释）。
 */
function pickParam(text: string, name: string): string {
  if (!text) {
    return '';
  }
  const m = new RegExp(`[?&#/]${name}=([^&#]*)`).exec(text);
  if (m) {
    return safeDecode(m[1]);
  }
  const m2 = new RegExp(`^${name}=([^&#]*)`).exec(text);
  return m2 ? safeDecode(m2[1]) : '';
}

/** 平台会把真实地址编码进 `__iframe=` 参数（管理端常以 iframe 承载） */
export function extractIframeInner(rawUrl: string): string {
  const i = rawUrl.indexOf('__iframe=');
  if (i === -1) {
    return '';
  }
  const start = i + '__iframe='.length;
  let end = rawUrl.indexOf('&', start);
  if (end === -1) {
    end = rawUrl.length;
  }
  return safeDecode(rawUrl.slice(start, end));
}

/** 解析当前页签 URL 的实例上下文；非 http(s) 或无法解析时返回 null */
export function parseInstanceContext(rawUrl: string): InstanceContext | null {
  let origin = '';
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) {
      return null;
    }
    origin = u.origin;
  } catch {
    return null;
  }

  let objectId = pickParam(rawUrl, 'bid');
  let instanceId = pickParam(rawUrl, 'id');
  const menuId = pickParam(rawUrl, 'mid');

  if (!objectId || !instanceId) {
    const inner = extractIframeInner(rawUrl);
    if (inner) {
      if (!objectId) {
        objectId = pickParam(inner, 'bid');
      }
      if (!instanceId) {
        instanceId = pickParam(inner, 'id');
      }
    }
  }

  return { href: rawUrl, origin, objectId, instanceId, menuId };
}

/**
 * 能否据此定位一个**具体实例**（B3 的最低前提）。
 *
 * ★ v4.2.46：此前只要求 `objectId || menuId`，于是一张**列表页**（只有 `bid`/`mid`，
 *   没有 `id`）也会点亮 Alt+W —— 但列表页没有"当前这条数据"，轮盘既读不到状态，
 *   选中后也没有可切换的实例。用户反馈这是错的，现在收紧为：
 *   - 必须有 `instanceId`（URL 的 `id`）；
 *   - 管理端 `/admin/...` 的 `id` 是**配置对象 id**（对象/生命周期/工作流），不是实例 id，
 *     这类页面同样不算实例页。
 */
export function isInstanceContext(ctx: InstanceContext | null): boolean {
  if (!ctx || !ctx.instanceId) {
    return false;
  }
  try {
    if (new URL(ctx.href).pathname.startsWith('/admin/')) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

/* ==================== 注入到页面主世界执行的函数 ====================
 * ⚠️ 下面这些函数会被 `executeScript` 序列化后在页面里跑，**必须自包含**：
 *    不能引用模块作用域的任何变量/常量/类型（类型在编译后消失，无妨）。
 *    返回值必须可结构化克隆。
 */

interface PageStatusItem {
  id: string;
  code: string;
  name: string;
}

interface PageStatusResult {
  ok: boolean;
  error?: string;
  /** 服务端返回的非 JSON / 非 2xx 时的可读摘要 */
  lifecycleName: string;
  statuses: PageStatusItem[];
  /** 被过滤掉的停用/已删除状态数（只用于 UI 说明，不参与切换） */
  hiddenCount: number;
  /** 实例当前状态正好落在被过滤掉的停用项上 */
  currentDisabled: boolean;
  /** 从实例响应里读到的当前状态名（读不到为空串） */
  currentFromApi: string;
  /** 从页面 DOM 读到的当前状态文字（读不到为空串） */
  currentFromDom: string;
  /** objectId 是反查得来的 */
  resolvedObjectId: boolean;
}

/** 页面主世界：拉状态列表（GetFormInstance → GetListByBasicId，必要时先反查 objectId）
 *  `export` 只为静态判据能在 Node 里直接调它；注入时 `executeScript` 仍按函数源序列化。 */
export function pageLoadStatuses(arg: {
  objectId: string;
  instanceId: string;
  menuId: string;
}): Promise<PageStatusResult> {
  const fail = (error: string): PageStatusResult => ({
    ok: false,
    error,
    lifecycleName: '',
    statuses: [],
    hiddenCount: 0,
    currentDisabled: false,
    currentFromApi: '',
    currentFromDom: '',
    resolvedObjectId: false,
  });

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown; text: string }> {
    const res = await fetch(location.origin + path, {
      method,
      // 同源请求天然带会话；Bearer 由 DNR 规则按 tabId 补，这里不自己塞头
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data, text };
  }

  /** 服务端信封 `{code:0,data,message}`；`message` 非空即业务失败 */
  function unwrap(r: { status: number; data: unknown; text: string }): { ok: boolean; data: unknown; msg: string } {
    if (r.status < 200 || r.status >= 300) {
      return { ok: false, data: null, msg: `HTTP ${r.status}` };
    }
    const rec = r.data && typeof r.data === 'object' ? (r.data as Record<string, unknown>) : null;
    if (!rec) {
      return { ok: false, data: null, msg: '响应不是 JSON' };
    }
    const msg = typeof rec.message === 'string' ? rec.message.trim() : '';
    const code = typeof rec.code === 'number' ? rec.code : 0;
    if (msg && code !== 0) {
      return { ok: false, data: null, msg };
    }
    return { ok: true, data: 'data' in rec ? rec.data : rec, msg };
  }

  /** BFS 找一个满足谓词的值（服务端偶尔改包装层级，不做路径硬编码） */
  function bfs(root: unknown, maxDepth: number, hit: (v: unknown) => boolean): unknown {
    const queue: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
    while (queue.length) {
      const { v, d } = queue.shift()!;
      if (hit(v)) {
        return v;
      }
      if (d >= maxDepth || !v || typeof v !== 'object') {
        continue;
      }
      if (Array.isArray(v)) {
        for (const item of v) {
          queue.push({ v: item, d: d + 1 });
        }
      } else {
        for (const item of Object.values(v as Record<string, unknown>)) {
          queue.push({ v: item, d: d + 1 });
        }
      }
    }
    return null;
  }

  function asStr(v: unknown): string {
    return typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  }

  return (async (): Promise<PageStatusResult> => {
    let objectId = arg.objectId;
    let resolvedObjectId = false;

    // 第 0 步：objectId 缺失且在 /web/view 上 → 用 mid 反查（同事实现的 B7）
    if (!objectId && arg.menuId) {
      const r = await request('GET', `/api/platform/UserView/GetViewList?menuId=${encodeURIComponent(arg.menuId)}`);
      const u = unwrap(r);
      if (u.ok) {
        const found = bfs(u.data, 4, (v) => {
          const o = v as Record<string, unknown> | null;
          if (!o || typeof o !== 'object' || Array.isArray(o)) {
            return false;
          }
          const bid = asStr(o.objectId) || asStr(o.basicObjectId) || asStr(o.bid);
          return Boolean(bid);
        }) as Record<string, unknown> | null;
        if (found) {
          objectId = asStr(found.objectId) || asStr(found.basicObjectId) || asStr(found.bid);
          resolvedObjectId = Boolean(objectId);
        }
      }
      if (!objectId) {
        return fail('无法从当前页面确定对象（objectId 缺失，且视图反查未命中）');
      }
    }
    if (!objectId) {
      return fail('当前页面地址里没有 objectId（bid），无法查询状态列表');
    }

    // 第 1 步：GetFormInstance → 挖 lifecycle{id,name}
    const form = await request('POST', '/api/platform/Layout/GetFormInstance', {
      objectId,
      instanceId: arg.instanceId,
      isCopy: false,
    });
    const fu = unwrap(form);
    if (!fu.ok) {
      return fail(`获取实例信息失败：${fu.msg}`);
    }

    const lifecycle = bfs(fu.data, 4, (v) => {
      const o = v as Record<string, unknown> | null;
      return Boolean(o && typeof o === 'object' && !Array.isArray(o) && typeof o.id === 'string' && 'name' in o && 'code' in o);
    }) as Record<string, unknown> | null;
    // 有些版本把 lifecycle 放在具名键下；上面若没命中，再按名字找一次
    const named = bfs(fu.data, 3, (v) => {
      const o = v as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || Array.isArray(o)) {
        return false;
      }
      const lc = (o as Record<string, unknown>).lifecycle;
      return Boolean(lc && typeof lc === 'object' && !Array.isArray(lc));
    }) as Record<string, unknown> | null;
    const lcObj = ((named?.lifecycle as Record<string, unknown> | undefined) ?? lifecycle ?? null) as
      | Record<string, unknown>
      | null;

    const lifecycleId = lcObj ? asStr(lcObj.id) : '';
    const lifecycleName = lcObj ? asStr(lcObj.name) : '';
    if (!lifecycleId) {
      return fail('实例响应里没有找到生命周期（lifecycle.id）');
    }

    // 当前状态：先试实例响应里的常见字段（字段名未在真机验证，全部按「读不到就退」处理）
    let currentFromApi = '';
    const inst = bfs(fu.data, 2, (v) => {
      const o = v as Record<string, unknown> | null;
      return Boolean(
        o &&
          typeof o === 'object' &&
          !Array.isArray(o) &&
          (asStr(o.statusName) || asStr(o.stateName) || asStr(o.statusText)),
      );
    }) as Record<string, unknown> | null;
    if (inst) {
      currentFromApi = asStr(inst.statusName) || asStr(inst.stateName) || asStr(inst.statusText);
    }

    // 第 2 步：读状态列表
    const listRes = await request(
      'GET',
      `/api/config/lifecycle/Status/GetListByBasicId?basicId=${encodeURIComponent(lifecycleId)}`,
    );
    const lu = unwrap(listRes);
    if (!lu.ok) {
      return fail(`获取状态列表失败：${lu.msg}`);
    }
    const arr = bfs(lu.data, 3, (v) => {
      if (!Array.isArray(v) || v.length === 0) {
        return false;
      }
      return v.every((it) => {
        const o = it as Record<string, unknown> | null;
        return Boolean(o && typeof o === 'object' && (asStr(o.code) || asStr(o.name)));
      });
    }) as unknown[] | null;
    if (!arr) {
      return fail('状态列表响应里没有找到状态数组');
    }
    // 启用/停用：状态对象的字段与 `Status/Create`、`Status/Update` 入参同名（isEnabled / isDeleted）。
    // 服务端若不给这些字段（旧版本/精简响应），一律按「启用」保留 —— 宁可多显示，
    // 也不能因为认不出字段就把整张列表过滤成空，更不能把"未知"当成"停用"。
    const off = (v: unknown): boolean => v === false || v === 0 || v === 'false' || v === '0';
    const on = (v: unknown): boolean => v === true || v === 1 || v === 'true' || v === '1';
    const enabledOf = (o: Record<string, unknown>): boolean => {
      if (off(o.isEnabled) || off(o.enabled) || off(o.enable)) {
        return false;
      }
      if (on(o.isDeleted) || on(o.isDisabled) || on(o.disabled)) {
        return false;
      }
      return true;
    };
    const all = arr.map((it) => {
      const o = it as Record<string, unknown>;
      const code = asStr(o.code);
      return {
        item: { id: asStr(o.id) || code, code, name: asStr(o.name) || code } as PageStatusItem,
        enabled: enabledOf(o),
      };
    });
    const statuses: PageStatusItem[] = all.filter((x) => x.enabled).map((x) => x.item);
    const hiddenCount = all.length - statuses.length;

    // 当前状态兜底：读页面上的状态文字（同事实现用的两个选择器：精确类名 + 通用兜底）
    let currentFromDom = '';
    const sels = ['.status-text_4fqtL', '[class*="status-text_"]'];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        if (!el) {
          continue;
        }
        const t = (el.getAttribute('title') || el.textContent || '').trim();
        if (t) {
          currentFromDom = t;
          break;
        }
      } catch {
        // 选择器语法问题不致命，继续
      }
    }

    // 当前状态若落在被隐藏的停用项上，显式告诉 UI「已停用」而不是「未知」
    const currentName = currentFromApi || currentFromDom;
    const currentDisabled = Boolean(
      currentName && all.some((x) => !x.enabled && x.item.name === currentName),
    );

    return {
      ok: true,
      lifecycleName,
      statuses,
      hiddenCount,
      currentDisabled,
      currentFromApi,
      currentFromDom,
      resolvedObjectId,
    };
  })();
}

/** 页面主世界：改状态。成功判定不采用「响应体没有 message 就算成功」那种猜法 */
function pageChangeStatus(arg: {
  instanceId: string;
  code: string;
}): Promise<{ ok: boolean; error?: string; unknown?: boolean }> {
  return (async () => {
    if (!arg.instanceId) {
      return { ok: false, error: '缺少 instanceId，无法修改状态' };
    }
    if (!arg.code) {
      // 同事实现会在缺 code 时兜底用 name 当 code 发出去 —— 那会 POST 出错误的状态码，这里直接拒绝
      return { ok: false, error: '该状态缺少 code，已中止（不会用名称顶替）' };
    }

    let res: Response;
    try {
      res = await fetch(
        `${location.origin}/api/openapi/v1.0/Object/status/${encodeURIComponent(arg.instanceId)}/${encodeURIComponent(arg.code)}`,
        { method: 'POST', credentials: 'same-origin' },
      );
    } catch (e) {
      return { ok: false, error: `请求失败：${e instanceof Error ? e.message : String(e)}` };
    }

    const text = await res.text().catch(() => '');
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `服务端返回 HTTP ${res.status}${text ? `：${text.slice(0, 160)}` : ''}` };
    }

    let data: unknown = null;
    let parsed = true;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      parsed = false;
    }
    if (!parsed) {
      // ★ 与同事实现的差异点：200 但响应体不是 JSON 时**不当作成功**，
      //   否则被网关/门户拦截的错误页会被当成「切换成功」并刷掉页面。
      return { ok: false, error: `响应不是合法 JSON（可能被网关拦截），未确认是否成功：${text.slice(0, 160)}` };
    }

    const rec = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    const msg = rec && typeof rec.message === 'string' ? rec.message.trim() : '';
    const code = rec && typeof rec.code === 'number' ? rec.code : 0;
    if (msg && code !== 0) {
      return { ok: false, error: msg };
    }
    // 空响应体（无 message、无 code）时服务端没给反证，按成功处理 —— 与同事实现一致，
    // 但上面已把「非 JSON」这条错误路径摘出来了。
    return { ok: true };
  })();
}

/* ==================== 对外：注入执行 ==================== */

/**
 * 在页面主世界执行一个自包含函数并取回结果。
 * 这里的 `any[]` 是刻意的：`chrome.scripting` 的 `ScriptInjection<Args, Result>` 要靠 func 的形参
 * 反推 Args，而我们的注入函数各带不同入参 —— 用 any[] 才能让同一个助手承接它们。
 */
async function runInPage<T>(tabId: number, func: (...args: never[]) => unknown, args: unknown[]): Promise<T> {
  const injection: chrome.scripting.ScriptInjection<any[], unknown> = {
    target: { tabId },
    world: 'MAIN',
    func: func as (...a: any[]) => unknown,
    args,
  };
  const results = await chrome.scripting.executeScript(injection);
  const first = results?.[0];
  if (!first) {
    throw new Error('页面脚本没有返回结果（可能被 CSP 或权限拦截）');
  }
  return first.result as T;
}

export interface LoadedStatuses {
  lifecycleName: string;
  statuses: { id: string; code: string; name: string }[];
  currentName: string;
  /** 被过滤掉的停用/已删除状态数 */
  hiddenCount: number;
  /** 当前状态本身已被停用（被过滤掉） */
  currentDisabled: boolean;
}

/** B3：读实例状态列表（含当前状态推断） */
export async function loadInstanceStatuses(tabId: number, ctx: InstanceContext): Promise<LoadedStatuses> {
  const r = await runInPage<PageStatusResult>(tabId, pageLoadStatuses, [
    { objectId: ctx.objectId, instanceId: ctx.instanceId, menuId: ctx.menuId },
  ]);
  if (!r.ok) {
    throw new Error(r.error || '读取状态列表失败');
  }
  return {
    lifecycleName: r.lifecycleName,
    statuses: r.statuses,
    currentName: r.currentFromApi || r.currentFromDom,
    hiddenCount: r.hiddenCount,
    currentDisabled: r.currentDisabled,
  };
}

/** B4：切状态 */
export async function changeInstanceStatus(
  tabId: number,
  instanceId: string,
  code: string,
): Promise<void> {
  const r = await runInPage<{ ok: boolean; error?: string }>(tabId, pageChangeStatus, [{ instanceId, code }]);
  if (!r.ok) {
    throw new Error(r.error || '修改状态失败');
  }
}
