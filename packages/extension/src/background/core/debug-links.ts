/**
 * 调试跳转（v4.2.45，Alt+2）：业务页 ↔ 对象配置 / 布局 / 生命周期 / 工作流 / 对象接口。
 *
 * ★ 数据链路（全部只读）：
 *   1. 正向：`bid` 就是 objectId；只有 `mid` 时用 `Menu/GetUserMenuPermission` 反查；
 *   2. 反向（v4.2.51）：管理端页面也能解析——对象配置/列表布局/对象接口取 `?id=`，
 *      表单布局取 `?bid=`，工作流编辑页用 config id 调 `GetWorkflowBasic` 拿 objectId，
 *      生命周期页用 `lifecycleId` 扫 `AllEnableObjects` 反查对象；
 *   3. `Layout/GetFormInstance {objectId, instanceId}` 拿 basicObject（含 lifeCycleId）；
 *   4. 业务菜单按 `objectId` 过滤同一份菜单权限表，得到回业务页的入口。
 *
 * ★ 解析函数在页面主世界执行：这样 DNR 能按账号补 Bearer、`_qlck` 缓存分区也生效；
 *   同时读的是**页面自己的** `__auth_token__`，不在扩展侧另存一份令牌。
 */

import { buildDebugTargets } from '../../shared/deeplinks';
import type { DebugLinks, DebugMenuRef, DebugWorkflowRef } from '../../shared/messages';
import { getLogger } from '../../shared/log';

const log = getLogger('debug-links');

interface PageDebugContext {
  object?: { id: string; code?: string; name?: string };
  lifecycle?: { id: string; name?: string } | null;
  menus?: DebugMenuRef[];
  error?: string;
}

/**
 * ★ 本函数会被 `chrome.scripting.executeScript({ world: 'MAIN', func })`
 *   序列化后注入页面，**不能引用模块作用域的任何变量**（类型注解会被擦除，OK）。
 */
async function pageResolveDebugContext(): Promise<PageDebugContext> {
  const read = (key: string): string => {
    const q = new URLSearchParams(location.search);
    const direct = q.get(key);
    if (direct) {
      return direct;
    }
    const hash = location.hash.startsWith('#') ? location.hash.slice(1) : location.hash;
    const i = hash.indexOf('?');
    return i >= 0 ? (new URLSearchParams(hash.slice(i + 1)).get(key) ?? '') : '';
  };
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  let token = '';
  try {
    token = sessionStorage.getItem('__auth_token__') || localStorage.getItem('__auth_token__') || '';
  } catch {
    token = '';
  }
  token = String(token).trim();
  if (token.startsWith('"') && token.endsWith('"')) {
    try {
      token = JSON.parse(token) as string;
    } catch {
      // 保持原值
    }
  }
  if (!token) {
    return { error: '未登录：当前页没有平台令牌' };
  }

  const call = async (path: string, init?: RequestInit): Promise<unknown> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      };
      if (init?.body) {
        headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(path, {
        credentials: 'include',
        ...init,
        headers,
        signal: ctrl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error('登录已失效，请在平台重新登录');
      }
      if (!res.ok) {
        throw new Error(`平台接口返回 ${res.status}`);
      }
      const json = (await res.json()) as { code?: number; message?: string; data?: unknown };
      if (typeof json?.code === 'number' && json.code !== 0) {
        throw new Error(json.message || '平台接口返回失败');
      }
      return json?.data ?? json;
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        throw new Error('平台接口超时');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    const pathname = location.pathname;
    const menuId = read('mid') || read('menuId');
    let objectId = read('bid') || read('objectId');
    let lifecycleId = '';
    let instanceId = read('id') || read('instanceId') || '';

    // 生命周期详情页：/admin/config/lifecycle/<lifecycleId>
    const lifeMatch = pathname.match(/\/admin\/config\/lifecycle\/([A-Za-z0-9_-]{8,64})/);
    if (lifeMatch) {
      lifecycleId = lifeMatch[1];
      instanceId = '';
    }

    // 工作流编辑器：?id= 是 newVersionWorkflowConfigId，不是 objectId
    if (!objectId && /\/admin\/config\/workflow\/edit\b/.test(pathname)) {
      const cfgId = read('id');
      if (cfgId) {
        const wf = (await call(
          `/api/platform/Workflow/GetWorkflowBasic?id=${encodeURIComponent(cfgId)}`,
        )) as Record<string, unknown> | null;
        if (wf) {
          objectId = str(wf.objectId);
          lifecycleId = lifecycleId || str(wf.lifecycleId);
        }
      }
    }

    // 管理端其它配置页：对象配置 / 列表布局 / 对象接口用 ?id=，表单布局用 ?bid=
    if (!objectId && /\/admin\/config\/(basic-objects\/edit\/(base|list-layout)|object-interface\/detail)\b/.test(pathname)) {
      objectId = read('id');
    }
    if (!objectId && /\/admin\/config\/form-layout\/list\b/.test(pathname)) {
      objectId = read('bid') || read('id');
    }

    // 拿一次菜单权限表：既用于 mid 反查，也用于「业务菜单」入口
    let allMenus: Array<Record<string, unknown>> = [];
    try {
      const raw = (await call('/api/platform/Menu/GetUserMenuPermission')) as unknown;
      allMenus = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
    } catch {
      allMenus = [];
    }

    // 生命周期页只有 lifecycleId：扫启用对象表反查（平台没有 lifecycle → object 的直连接口）
    if (!objectId && lifecycleId) {
      const raw = (await call('/api/platform/BasicObject/AllEnableObjects')) as unknown;
      const all = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
      const hit = all.find((o) => str(o.lifeCycleId) === lifecycleId);
      if (hit) objectId = str(hit.id);
    }

    // 业务页：只有 mid 时按菜单反查 objectId
    if (!objectId && menuId) {
      const hit = allMenus.find(
        (m) => str(m.menuId) === menuId || str(m.id) === menuId,
      );
      const found = hit
        ? [str(hit.objectId), str(hit.bid), str(hit.businessObjectId)].find((x) => x.length > 0)
        : undefined;
      if (found) {
        objectId = found;
      }
    }

    if (!objectId) {
      return {
        error: '当前页没有业务对象上下文（URL 里没有 bid / id，菜单里也没找到）',
      };
    }

    const form = (await call('/api/platform/Layout/GetFormInstance', {
      method: 'POST',
      body: JSON.stringify({ objectId, instanceId, isCopy: false }),
    })) as Record<string, unknown> | null;
    if (!form || typeof form !== 'object') {
      return { error: '读取对象信息失败（可能没有该对象的权限）' };
    }
    const basic = (form.basicObject && typeof form.basicObject === 'object'
      ? form.basicObject
      : form) as Record<string, unknown>;
    const lifeRaw = (form.lifecycle && typeof form.lifecycle === 'object'
      ? form.lifecycle
      : null) as Record<string, unknown> | null;

    const id = str(basic.id) || objectId;
    const lifeId = str(basic.lifeCycleId) || str(lifeRaw?.id) || lifecycleId;
    const enabled = basic.enableLifeCycle !== false;

    // 业务菜单：按 objectId 过滤；linkurl 不是站内路径时退回 /web/view?mid=
    const menus: DebugMenuRef[] = [];
    const seen = new Set<string>();
    for (const m of allMenus) {
      if (str(m.objectId).toLowerCase() !== id.toLowerCase()) continue;
      const mid = str(m.menuId) || str(m.id);
      const name = str(m.name);
      const link = str(m.linkurl);
      const path = link.startsWith('/') && !link.startsWith('//') && !link.includes('\\')
        ? link
        : `/web/view?mid=${encodeURIComponent(mid)}`;
      if (!mid || !name || !path || seen.has(path)) continue;
      seen.add(path);
      menus.push({ id: mid, name, code: str(m.code) || undefined, path });
      if (menus.length >= 12) break;
    }

    return {
      object: {
        id,
        code: str(basic.code) || undefined,
        name: str(basic.name) || undefined,
      },
      lifecycle: enabled && lifeId
        ? { id: lifeId, name: str(lifeRaw?.name) || undefined }
        : null,
      menus,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 在页面里列该对象上**启用**的工作流（v4.2.50）。
 *
 * ★ 平台列表页不解析任何 URL 筛选参数（bundle 里没有 searchParams → filters 的代码），
 *   所以「只显示该对象生命周期上的工作流」不能靠深链，只能在页面上下文里自己取数：
 *   由页面自己的 token 带 Bearer 调 `GetObjectWorkflowList`。
 * ★ `status`：10 未启用 / 20 启用 / 30 禁用 / 40 编辑中（平台枚举），只回 20 ——
 *   其余状态都没有可运行的当前版本，列出来只会点进空编辑器。
 */
async function pageLoadObjectWorkflows(objectId: string): Promise<{ workflows?: DebugWorkflowRef[]; error?: string }> {
  const readToken = (): string => {
    const raw = window.sessionStorage.getItem('__auth_token__') ?? window.localStorage.getItem('__auth_token__');
    if (!raw) return '';
    return raw.replace(/^"|"$/g, '');
  };
  const token = readToken();
  if (!token) return { error: '未登录：当前页没有平台令牌' };

  try {
    const r = await fetch('/api/platform/Workflow/GetObjectWorkflowList', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ id: objectId }),
    });
    if (r.status === 401 || r.status === 403) return { error: '登录已失效，请在平台重新登录' };
    const body = (await r.json()) as { code?: number; message?: string; data?: unknown };
    if (body.code !== 0) return { error: body.message || `接口返回 code=${String(body.code)}` };
    const rows = Array.isArray(body.data) ? (body.data as Array<Record<string, unknown>>) : [];
    const workflows: DebugWorkflowRef[] = [];
    for (const row of rows) {
      if (Number(row.status) !== 20) continue;
      const id = typeof row.id === 'string' ? row.id : '';
      const name = typeof row.name === 'string' ? row.name : '';
      if (!id || !name) continue;
      workflows.push({
        id,
        name,
        code: typeof row.code === 'string' ? row.code : undefined,
        configId: typeof row.newVersionWorkflowConfigId === 'string' ? row.newVersionWorkflowConfigId : undefined,
      });
    }
    return { workflows };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 列某个页签当前对象上启用的工作流。
 *
 * ★ tabId 由 background 从 `sender` 取（内容脚本不可自报），objectId 也要先过形状校验：
 *   它会进页面 fetch 的 body，不能让页面借扩展之手打任意 id。
 */
export async function loadObjectWorkflows(
  tabId: number,
  objectId: string,
): Promise<{ ok: true; data: { workflows: DebugWorkflowRef[] } } | { ok: false; error: string }> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(objectId)) {
    return { ok: false, error: '对象 id 形状不合法' };
  }
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: pageLoadObjectWorkflows,
      args: [objectId],
    });
    const out = res?.result as { workflows?: DebugWorkflowRef[]; error?: string } | undefined;
    if (!out) return { ok: false, error: '页面没有返回工作流' };
    if (out.error) return { ok: false, error: out.error };
    return { ok: true, data: { workflows: out.workflows ?? [] } };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('debug.workflows 注入失败：%s', msg);
    return { ok: false, error: `无法访问页面：${msg}` };
  }
}

/**
 * 解析某个页签的调试目标。
 *
 * ★ origin 取自 `chrome.tabs.get(tabId).url`，不是页面回传值：
 *   三个按钮最终都由 background 打开，若用页面自报 origin，恶意页面就能把
 *   「对象配置」按钮指向任意站点。
 */
export async function resolveDebugLinks(
  tabId: number,
): Promise<{ ok: true; data: DebugLinks } | { ok: false; error: string }> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: '页签已关闭' };
  }
  if (!tab.url || !/^https?:/i.test(tab.url)) {
    return { ok: false, error: '当前页不是平台页面' };
  }
  let origin: string;
  try {
    origin = new URL(tab.url).origin;
  } catch {
    return { ok: false, error: '当前页地址无法解析' };
  }

  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: pageResolveDebugContext,
    });
    const ctx = res?.result as PageDebugContext | undefined;
    if (!ctx) {
      return { ok: false, error: '页面没有返回调试信息' };
    }
    if (ctx.error) {
      return { ok: false, error: ctx.error };
    }
    if (!ctx.object?.id) {
      return { ok: false, error: '当前页没有对象上下文' };
    }
    const lifecycle = ctx.lifecycle ?? null;
    const menus = ctx.menus ?? [];
    return {
      ok: true,
      data: {
        object: ctx.object,
        lifecycle,
        targets: buildDebugTargets(origin, ctx.object, lifecycle, [], menus),
        menus,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('debug.resolve 注入失败：%s', msg);
    return { ok: false, error: `无法访问页面：${msg}` };
  }
}
