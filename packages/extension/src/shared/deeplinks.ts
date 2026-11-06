/**
 * 平台管理端深链（v4.2.45，调试跳转）。
 *
 * ★ 四处路径都来自平台前端自己的链接构造器（bundle 里的 `EA` 表），不是猜的：
 *   - 对象详情：`/admin/config/basic-objects/edit/base?id=<objectId>&__edit=2`
 *   - 对象生命周期详情：`/admin/config/lifecycle/<lifeCycleId>?__edit=2`
 *   - 工作流列表：`/admin/config/workflow`
 *   - 对象接口详情：`/admin/config/object-interface/detail?id=<objectId>`
 *
 * ★ 这里只做**纯字符串拼接**，不碰 chrome API：静态判据可以直接 import 测试，
 *   不需要起浏览器。origin 由调用方（background）从目标页签 URL 取，
 *   绝不接受页面自报的 origin —— 否则页面能把这几个按钮指向任意站点。
 */

import type { DebugLifecycleRef, DebugObjectRef, DebugTarget } from './messages';

/** 对象配置页（基础信息）。`__edit=2` 让管理端直接进编辑态。 */
export function objectConfigUrl(origin: string, objectId: string): string {
  return `${origin}/admin/config/basic-objects/edit/base?id=${encodeURIComponent(objectId)}&__edit=2`;
}

/** 对象生命周期详情页（某个 lifecycle 的状态与阶段配置）。 */
export function lifecycleConfigUrl(origin: string, lifecycleId: string): string {
  return `${origin}/admin/config/lifecycle/${encodeURIComponent(lifecycleId)}?__edit=2`;
}

/**
 * 工作流列表页。
 *
 * ★ 刻意不拼 `?objectId=`：列表接口 `GetWorkflowBasicPageViewList` 会忽略筛选条件
 *   （实测传什么 filters 都返回 887 条），带一个假参数只会让人以为已经筛过。
 *   对象归属留给列表页自己的搜索框。
 */
export function workflowListUrl(origin: string): string {
  return `${origin}/admin/config/workflow`;
}

/** 对象接口详情页（该对象的接口清单，调试时用来核对入参/出参）。 */
export function objectInterfaceUrl(origin: string, objectId: string): string {
  return `${origin}/admin/config/object-interface/detail?id=${encodeURIComponent(objectId)}`;
}

/**
 * 把当前对象组装成**候选矩阵**（v4.2.47）。
 *
 * ★ 这是「加一个可跳转页面」的唯一落点：往返回数组里 `push` 一条即可，
 *   浮层按数组渲染、自动换行，判据也不用改（它只断言数组里的 href 与顺序）。
 *   `extra` 是留给调用方/未来的扩展口，测试用它证明「多一条就会多一格」。
 */
export function buildDebugTargets(
  origin: string,
  object: DebugObjectRef,
  lifecycle: DebugLifecycleRef | null,
  extra: readonly DebugTarget[] = [],
): DebugTarget[] {
  const targets: DebugTarget[] = [
    {
      kind: 'object',
      title: '对象配置',
      subtitle: '基础信息 / 字段 / 布局',
      href: objectConfigUrl(origin, object.id),
      accent: '#1e6fff',
    },
    {
      kind: 'lifecycle',
      title: '对象生命周期',
      subtitle: lifecycle ? '状态、阶段与流转配置' : '该对象未启用生命周期',
      href: lifecycle ? lifecycleConfigUrl(origin, lifecycle.id) : null,
      accent: '#16a34a',
      disabledReason: lifecycle ? undefined : '该对象未启用生命周期',
    },
    {
      kind: 'workflow',
      title: '工作流',
      subtitle: '工作流列表页（按对象自己搜）',
      href: workflowListUrl(origin),
      accent: '#7c3aed',
    },
    {
      kind: 'interfaces',
      title: '对象接口',
      subtitle: '接口清单（调试入参/出参）',
      href: objectInterfaceUrl(origin, object.id),
      accent: '#d97706',
    },
  ];
  return [...targets, ...extra];
}
