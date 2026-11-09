import { SESSION_KEYS } from '../../shared/constants';
import { getLogger } from '../../shared/log';

/** ★ 本文件此前零日志（唯一的 catch 是"清 localStorage 失败"）。 */
const log = getLogger('auto-login-cache');

/**
 * 待自动登录凭证的**临时缓存**（`chrome.storage.session`，按 tabId 存，60 秒过期）。
 *
 * # 为什么单独一个文件
 *
 * 这段逻辑原来长在 `navigation.ts` 里，和**旧 `Session` 模型**（`switchAccount` /
 * 绑定表 / `accountRegistry`）混在一起。v3.18 废除本地数据源时要删掉的正是后者 ——
 * 而这两件事的**生命周期不同**：旧模型整体作废，这份缓存**两边都要用**。
 *
 * ⇒ 把它摘出来，删旧模型时才不会连坐。
 *
 * # 谁在用它
 *
 * | 使用方 | 干什么 |
 * |---|---|
 * | `parallel-session.ts` | 打开账号后用 `set` 写入（它自己走 `SESSION_KEYS.pendingAutoLogins` 同一个键） |
 * | `service-worker.ts` | 内容脚本就绪后经消息索取，用 `get` 读回 |
 *
 * ★ 键的格式（`${SESSION_KEYS.pendingAutoLogins}:${tabId}`）**必须与
 *   `parallel-session.ts` 一致** —— 不一致的话写入方与读取方各看各的键，
 *   表现是"自动填表有时候不填"，而**两端都不报错**。
 *   所以这个函数是**唯一**拼这个键的地方。
 *
 * # 为什么放 `storage.session` 而不是 `storage.local`
 *
 * 它是**凭据**。`session` 作用域随浏览器会话结束清空，且 MV3 的 SW 被回收后仍在
 * （这正是选它而不是内存 Map 的原因）。放 `local` 会让它以明文落在磁盘上。
 */

const AUTO_LOGIN_TTL = 60_000;

/** ★ 唯一拼这个键的地方（见文件头）。 */
export function pendingAutoLoginKey(tabId: number): string {
  return `${SESSION_KEYS.pendingAutoLogins}:${tabId}`;
}

/** 缓存待自动登录凭证（service worker 回收后不丢失）。 */
export async function setPendingAutoLogin(
  tabId: number,
  username: string,
  password: string,
): Promise<void> {
  await chrome.storage.session.set({
    [pendingAutoLoginKey(tabId)]: { username, password, at: Date.now() },
  });
}

/** content 脚本（含各 iframe frame）就绪后主动索取凭证；超时视为失效。 */
export async function getPendingAutoLogin(
  tabId: number,
): Promise<{ username: string; password: string } | null> {
  const key = pendingAutoLoginKey(tabId);
  const stored = await chrome.storage.session.get(key);
  const entry = stored[key] as { username: string; password: string; at: number } | undefined;
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.at > AUTO_LOGIN_TTL) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return { username: entry.username, password: entry.password };
}

/** 标签关闭 / 登出时清掉，避免凭据在 session 里滞留到过期。 */
export async function clearPendingAutoLogin(tabId: number): Promise<void> {
  await chrome.storage.session.remove(pendingAutoLoginKey(tabId));
}

/**
 * 登出：清空扩展打开页签的 localStorage（v3.11.1 根本原则版）。
 *
 * ★ 仅清该页签（扩展打开/复用）的 localStorage —— **不触碰真实 Cookie jar**：
 * `chrome.cookies.remove({domain: host})` 会清掉整个 host 的会话，连带杀死
 * 原始页签的原生登录态，违反「扩展不得影响原有网页」的根本原则。
 */
export async function clearPageLoginState(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.localStorage.clear(),
      world: 'MAIN',
    });
  } catch (e) {
    // 页面尚未加载（新建标签）或不可注入，忽略；登录时会覆盖 localStorage。
    // ★★ 2026-11-09：补留痕。用户点"退出"后若页面里的 localStorage 还在
    //   （下一个账号进同一页签时读到别人的残留状态），这里就是唯一线索 ——
    //   而它原来是完全静默的（规则 29）。
    log.warn(
      '清理页签 localStorage 失败 ⇒ 页面上可能残留上一个账号的状态（登录会覆盖）: %s',
      e instanceof Error ? e.message : String(e),
    );
  }
}
