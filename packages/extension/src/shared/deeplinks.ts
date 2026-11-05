/**
 * 平台管理端深链（v4.2.45，调试跳转）。
 *
 * ★ 三处路径都来自平台前端自己的链接构造器，不是猜的：
 *   - 对象详情：`/admin/config/basic-objects/edit/base?id=<objectId>&__edit=2`
 *   - 对象生命周期详情：`/admin/config/lifecycle/<lifeCycleId>?__edit=2`
 *   - 工作流列表：`/admin/config/workflow`
 *
 * ★ 这里只做**纯字符串拼接**，不碰 chrome API：静态判据可以直接 import 测试，
 *   不需要起浏览器。origin 由调用方（background）从目标页签 URL 取，
 *   绝不接受页面自报的 origin —— 否则页面能把这几个按钮指向任意站点。
 */

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
