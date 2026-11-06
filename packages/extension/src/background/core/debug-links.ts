/**
 * 调试跳转（v4.2.45，Alt+2）：业务页 → 对象配置 / 对象生命周期 / 工作流列表。
 *
 * ★ 数据链路（三段都只读）：
 *   1. `bid` 就是 objectId；只有 `mid` 时用 `Menu/GetUserMenuPermission` 反查；
 *   2. `Layout/GetFormInstance {objectId, instanceId}` 拿 basicObject（含 lifeCycleId）；
 *   3. 工作流只跳**列表页**，不猜某一条（列表接口会忽略筛选条件，实测）。
 *
 * ★ 解析函数在页面主世界执行：这样 DNR 能按账号补 Bearer、`_qlck` 缓存分区也生效；
 *   同时读的是**页面自己的** `__auth_token__`，不在扩展侧另存一份令牌。
 */

import { buildDebugTargets } from '../../shared/deeplinks';
import type { DebugLinks, DebugWorkflowRef } from '../../shared/messages';
import { getLogger } from '../../shared/log';

const log = getLogger('debug-links');

interface PageDebugContext {
  object?: { id: string; code?: string; name?: string };
  lifecycle?: { id: string; name?: string } | null;
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

  const menuId = read('mid') || read('menuId');
  let objectId = read('bid') || read('objectId');
  const instanceId = read('id') || read('instanceId') || '';

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
    const timer = setTimeout(() => ctrl.abort(), 4000);
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
    if (!objectId && menuId) {
      const menus = (await call('/api/platform/Menu/GetUserMenuPermission')) as Array<Record<string, unknown>>;
      const list = Array.isArray(menus) ? menus : [];
      const hit = list.find(
        (m) => String(m.menuId ?? '') === menuId || String(m.id ?? '') === menuId,
      );
      const found = hit
        ? [hit.objectId, hit.bid, hit.businessObjectId].find((x): x is string => typeof x === 'string' && x.length > 0)
        : undefined;
      if (found) {
        objectId = found;
      }
    }
    if (!objectId) {
      return { error: '当前页没有业务对象上下文（URL 里没有 bid，菜单里也没找到）' };
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

    const id = typeof basic.id === 'string' && basic.id ? basic.id : objectId;
    const lifeId = typeof basic.lifeCycleId === 'string' && basic.lifeCycleId
      ? basic.lifeCycleId
      : (typeof lifeRaw?.id === 'string' ? lifeRaw.id : '');
    const enabled = basic.enableLifeCycle !== false;

    return {
      object: {
        id,
        code: typeof basic.code === 'string' ? basic.code : undefined,
        name: typeof basic.name === 'string' ? basic.name : undefined,
      },
      lifecycle: enabled && lifeId
        ? { id: lifeId, name: typeof lifeRaw?.name === 'string' ? lifeRaw.name : undefined }
        : null,
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
    return {
      ok: true,
      data: {
        object: ctx.object,
        lifecycle,
        targets: buildDebugTargets(origin, ctx.object, lifecycle),
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('debug.resolve 注入失败：%s', msg);
    return { ok: false, error: `无法访问页面：${msg}` };
  }
}
