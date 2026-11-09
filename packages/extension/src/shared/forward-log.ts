/**
 * 跨环境日志转发的**适配器** —— 把 `shared/log.ts` 的 `setForwarder` 接到
 * `ql.log` 消息上。
 *
 * ## 为什么单独一个文件
 *
 * `shared/log.ts` 刻意**不认识**消息契约（它只暴露 `setForwarder((rec) => void)`，
 * 见那里的注释："日志是最底层的工具，不该知道业务消息契约"）。
 * 于是"把记录发给 SW"这件事只能由**认识两边**的地方来做 —— 就是这里。
 *
 * ## 为什么要有这个 helper（2026-11-09 修的真实缺口）
 *
 * `getForwardingLogger()` 只在**装过** forwarder 时才真的转发：
 *
 * ```ts
 * if (forwarder && shouldLog(level)) { forwarder({...}) }
 * ```
 *
 * 而没有 forwarder 时它**与 `getLogger` 完全一样** —— 不报错、不告警，
 * 日志只留在**当前页面的 DevTools** 里（SW 被回收后就连不上）。
 *
 * 实测：`setForwarder` 原先只在 `ui/parallel/parallel.ts` 里装过一次，
 * 但 `ui/translate/translate.ts`、`ui/wheel/wheel.ts`、`ui/send.ts` 都在用
 * `getForwardingLogger` ⇒ 那三个页面的日志**永远进不了诊断包**，
 * 而代码看上去是"接了转发的"。这正是规则 30/32 说的
 * "机制摆在那里 ≠ 被接上"、"工具不可用会伪装成没人用"。
 *
 * ⇒ 以后新页面要用转发日志，**一行 `installLogForwarding()`** 就够了，
 *   不必再各写一遍 `chrome.runtime.sendMessage` 的样板（也就不会再漏装）。
 *
 * ## 环境
 *
 * 只碰 `chrome.runtime`，所以 UI 页面与 content script 都能用；
 * SW 自己**不要**装（它就是接收端，装了等于自说自话 —— PITFALLS #37 同型陷阱）。
 */

import { setForwarder } from './log';

/** 幂等标记：同一页面里重复调用只装一次 */
let installed = false;

/**
 * 装上跨环境转发器（幂等）。
 *
 * 转发失败一律吞掉：日志通道的故障不能影响业务，也不能再记一条日志
 * （否则失败 → 记日志 → 再失败 → 无限放大，与 `setForwarder` 的约定一致）。
 */
export function installLogForwarding(): void {
  if (installed) {
    return;
  }
  installed = true;
  setForwarder((rec) => {
    try {
      // ★ 传 `records` 数组而不是单条：SW 侧处理逻辑不变（它本来就收数组，
      //   单条消息上限 50 条），前端也就此保留"攒批"的余地。
      chrome.runtime.sendMessage({ kind: 'ql.log', records: [rec] }, () => {
        // 读掉 lastError，避免控制台出现 "Unchecked runtime.lastError"。
        // （SW 已回收 / 页面正在关闭时必然走到这里，属正常。）
        void chrome.runtime.lastError;
      });
    } catch {
      /* 扩展上下文已失效（如页面在卸载）：本页 console 仍有记录，忽略 */
    }
  });
}
