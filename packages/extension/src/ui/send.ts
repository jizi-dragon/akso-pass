import { getForwardingLogger } from '../shared/log';
import type { RuntimeRequest, RuntimeResponse } from '../shared/messages';

/**
 * UI → background 的 Promise 包装。
 *
 * ★★ 2026-10-12 修：此前它**零防御** —— 既不查 `chrome.runtime.lastError`、也不设超时，
 *   而 `chrome.runtime.sendMessage` 在**没有接收端**时（扩展刚重载、SW 正在冷启、
 *   页面是重载前留下的旧页面）是**同步回调 `undefined` 且不改 `lastError` 之外任何东西**：
 *
 *   ```ts
 *   return new Promise((resolve) => { chrome.runtime.sendMessage(req, resolve); });
 *   ```
 *
 *   ⇒ `resolve` 收到 `undefined` ⇒ 调用点读 `res.kind` **抛 TypeError**
 *     ⇒ `refreshAll()` 当场中断，页面**停在半旧状态**（一半新、一半旧，且不报错）。
 *   ★ 本仓的 `popup` 与轮盘因为写了 `res?.` 而侥幸安全 —— 也就是说这个缺陷的
 *     "是否爆出来"取决于**调用点有没有顺手加问号**，那不是防御，是巧合。
 *
 * 现在的契约（三条，缺一条就还是原来的缺陷）：
 *   1. **永不抛、永不 resolve `undefined`**：拿不到应答就合成一个 `{ok:false,error}`
 *      的响应，让调用点走它**本来就有**的失败分支（UI 已全部按 `{ok,error}` 渲染）。
 *   2. **`lastError` 必须读**：不读它 Chrome 会往控制台打 "Unchecked runtime.lastError"，
 *      而且我们也就丢失了唯一的原因文本（"Receiving end does not exist" 等）。
 *   3. **留痕**：合成失败是**真实故障**，不是正常路径 —— 静默的话它与
 *      "后台正常回了但数据是空的"在用户那里长得一样（规则 29）。
 */

/** 与 `parallel.ts` 的 3s 轮询同量级：超过它说明后台真的没有应答，而不是"慢" */
const SEND_TIMEOUT_MS = 10_000;

const log = getForwardingLogger('ui.send');

/** 把一个请求合成成"失败响应"，形状与后台 `dispatch` 的失败分支**完全一致**。
 *  ★ 这里**不用** `messages.ts` 的 `Result<T>`：它是那个模块的**私有**类型别名
 *    （未导出），而在本文件里内联写出来反而更直白 —— 它只有两个形状。 */
function synthFailure<K extends RuntimeRequest['kind']>(
  kind: K,
  error: string,
): { kind: K; result: { ok: false; error: string } } {
  return { kind, result: { ok: false, error } };
}

export function send(req: RuntimeRequest): Promise<RuntimeResponse> {
  const kind = req.kind;
  return new Promise<RuntimeResponse>((resolve) => {
    let settled = false;
    const finish = (res: RuntimeResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(res);
    };

    const timer = setTimeout(() => {
      log.warn('send(%s) 超时 %dms 无应答 ⇒ 按失败处理（后台忙/SW 未起/页面是重载前的旧页面）',
        kind, SEND_TIMEOUT_MS);
      finish(synthFailure(kind, `后台无应答（超时 ${SEND_TIMEOUT_MS / 1000}s）：请重新加载扩展或刷新本页`) as RuntimeResponse);
    }, SEND_TIMEOUT_MS);

    try {
      chrome.runtime.sendMessage(req, (res: RuntimeResponse | undefined) => {
        // ★ 必须先读 `lastError`：它既是原因文本，也是"Chrome 认为这次调用失败了"的判据。
        const err = chrome.runtime.lastError;
        if (err) {
          log.warn('send(%s) 失败：%s', kind, err.message ?? String(err));
          finish(synthFailure(kind, `扩展后台不可达：${err.message ?? '未知原因'}`) as RuntimeResponse);
          return;
        }
        if (!res || typeof res !== 'object' || typeof (res as { kind?: unknown }).kind !== 'string') {
          // 旧版在这里把 `undefined` 直接交给了调用点 ⇒ 调用点读 `res.kind` 抛 TypeError。
          log.warn('send(%s) 收到空应答（无接收端或后台未回）⇒ 合成失败响应', kind);
          finish(synthFailure(kind, '扩展后台未返回结果（可能正在启动）：请重试') as RuntimeResponse);
          return;
        }
        finish(res);
      });
    } catch (e) {
      // `sendMessage` 在扩展上下文失效时会**同步抛**（而不是走 lastError）
      const msg = e instanceof Error ? e.message : String(e);
      log.warn('send(%s) 同步抛错：%s', kind, msg);
      finish(synthFailure(kind, `扩展上下文已失效：${msg}`) as RuntimeResponse);
    }
  });
}

