/**
 * 时间戳**唯一实现**：本地时间 + 显式偏移的完整 ISO 8601（v4.6.3）。
 *
 * ## 为什么不是 `new Date().toISOString()`
 *
 * `ql:diag` 原来在两处各写一遍 `${new Date().toISOString().slice(11, 23)}` ——
 * 得到的是 **UTC 的 `HH:mm:ss.SSS`**，两个毛病叠在一起：
 *
 * 1. **没有日期**：诊断包跨过午夜就完全无法排序（字符串排序会把 00:01 排到 23:59 前面）。
 * 2. **UTC**：`ql:forensics` / `appLogs` 里是 epoch 毫秒（时区无关的真值），
 *    而 `ql:diag` 是 UTC 文本 ⇒ 排同一个时间线要**先心算 +8 小时**。
 *    实测（2026-11-25 那份诊断包）：`diagLog` 第一条是 `06:21:36.907`，
 *    对应的动作发生在本地 `14:21:36`；第一眼看过去像是"六个小时前的另一件事"。
 *
 * ## 为什么是"本地 + 偏移"而不是"全 UTC"
 *
 * 诊断包的读者是**用户和值班的人**，看的是自己的钟。纯 UTC 每条都要换算一次，
 * 而换算错了没有任何提示（这次就是这么踩进去的）。带上 `+08:00` 之后：
 * 人不必换算；机器仍能无歧义地解析成同一个瞬时；跨时区合并也不会错。
 *
 * ★ 排序：同一次导出内偏移相同 ⇒ 字典序 = 时间序。真要跨偏移合并，
 *   用 `appLogs/forensics` 的 epoch 字段（那才是排序用的机器真值）。
 *
 * ★ 别改成"裸 `HH:mm:ss`"（也不要再加第二个格式化函数）：这个仓库反复出现的
 *   失败形态就是**同一件事两份实现**（见 `auto-login-cache.pendingAutoLoginKey`
 *   的注释）。所有要给人看的时间都从这里出。
 */
const p2 = (n: number): string => String(n).padStart(2, '0');

export function stampLocal(at: number = Date.now()): string {
  const d = new Date(at);
  // getTimezoneOffset() 是"本地 → UTC"的分钟数（东八区 = -480），取反才是我们要的偏移
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}` +
    `${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`
  );
}
