import { LOCAL_KEYS } from '../../shared/constants';
import { getLogger } from '../../shared/log';
import type { SiteGrant } from '../../shared/types';

/** ★ 2026-10-09 补：这个模块此前**没有任何日志**。 */
const log = getLogger('site-auth');

function siteKey(host: string): string {
  return host.toLowerCase();
}

async function readGrants(): Promise<SiteGrant[]> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.siteGrants);
  return (stored[LOCAL_KEYS.siteGrants] as SiteGrant[] | undefined) ?? [];
}

/**
 * 授权痕迹的**读取**入口。
 *
 * ★★ 2026-10-12：这个对象**只剩 `list()` 一个成员** —— `grant()` / `grantCurrentTab()`
 *   已随 `registerAuthHandlers()` 一并删除（它们构成一整块**没有任何调用点**的死代码，
 *   见 `docs/PITFALLS.md` #34）。删除的理由与判据：
 *
 * | 成员 | 判定 |
 * |---|---|
 * | `list()` | **活的** —— `service-worker.ts` 的 `data.export` 用它填备份的 `sites` |
 * | `grant()` | 只被 `grantCurrentTab()` 调用 ⇒ 死 |
 * | `grantCurrentTab()` | 只被 `registerAuthHandlers()` 调用 ⇒ 死 |
 * | `registerAuthHandlers()` | **全仓零调用点** ⇒ 死（连带右键菜单与 `add_current_site` 快捷键监听） |
 *
 * ★ 而**写入** `sb:siteGrants` 的活路径是 `ui/parallel/parallel.ts` 的导入流程
 *   （`chrome.permissions.request` 之后写清单）—— 所以"写方"并不缺，
 *   只是**不在这个模块里**。这正是当初容易误判的地方：
 *   "`registerAuthHandlers` 没被调用"**不等于**"站点授权从来不被记录"。
 */
export const siteAuth = {
  async list(): Promise<SiteGrant[]> {
    return readGrants();
  },
};

/* ---------------- scheme（v3.10.9）：站点协议的探测 / hint / 解析 ---------------- */

export type Scheme = 'http' | 'https';

const SCHEME_HINTS_KEY = LOCAL_KEYS.siteSchemes;

/** 站点 scheme hint（添加站点时从用户输入 URL 解析而来；账号创建时优先采用） */
export async function getSchemeHint(host: string): Promise<Scheme | undefined> {
  const stored = await chrome.storage.local.get(SCHEME_HINTS_KEY);
  const map = (stored[SCHEME_HINTS_KEY] as Record<string, Scheme> | undefined) ?? {};
  return map[siteKey(host)];
}

export async function setSchemeHint(host: string, scheme: Scheme): Promise<void> {
  const stored = await chrome.storage.local.get(SCHEME_HINTS_KEY);
  const map = (stored[SCHEME_HINTS_KEY] as Record<string, Scheme> | undefined) ?? {};
  map[siteKey(host)] = scheme;
  await chrome.storage.local.set({ [SCHEME_HINTS_KEY]: map });
}

/** 从用户输入解析 host 与 scheme：支持粘贴完整 URL（http://host[:port]/path）或纯 host */
export function parseSiteInput(raw: string): { host: string; scheme?: Scheme } {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(https?):\/\/([^/]+)(\/.*)?$/i);
  if (m) {
    return { host: m[2].toLowerCase(), scheme: m[1].toLowerCase() as Scheme };
  }
  return { host: trimmed.replace(/\/.*$/, '').toLowerCase() };
}

const PROBE_TIMEOUT_MS = 3000;

async function probeOnce(url: string): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    // HEAD 优先；部分服务器不支持 HEAD 时退 GET（404/405 也算「可达」——网络层通即可）
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal, credentials: 'omit' }).catch(() =>
      fetch(url, { method: 'GET', signal: ctrl.signal, credentials: 'omit' }),
    ).finally(() => clearTimeout(timer));
    void res;
    return true;
  } catch {
    return false;
  }
}

/**
 * 探测站点可用协议：https 优先（安全偏好）。
 * 注意：SW fetch 无法忽略证书错误——自签 https 会被误判为不可用而落到 http；
 * 该歧义由「打开失败自学习」兜底纠正（handleOpenError）。
 */
export async function probeScheme(host: string): Promise<Scheme> {
  const hint = await getSchemeHint(host);
  if (hint) {
    // ★ `debug`：命中 hint 是**正常路径**（只有第一次探测才会走网络），
    //   记它只是为了回答"这个站点当初是怎么定下 scheme 的"。
    log.debug('probeScheme(%s) → %s（命中已存 hint，未探测）', host, hint);
    return hint;
  }
  if (await probeOnce(`https://${host}/favicon.ico`)) {
    // ★ `debug` —— 每次新站点只发生一次，是中频轨迹不是热路径。
    log.debug('probeScheme(%s) → https（网络探测得出）', host);
    return 'https';
  }
  if (await probeOnce(`http://${host}/favicon.ico`)) {
    log.debug('probeScheme(%s) → http（https 不可达，回落到 http）', host);
    return 'http';
  }
  // ★★ 两个都探测失败 ⇒ 注释里说的"自签 https 会被误判为不可用"就是这里。
  //   最终仍返回 `https`（安全偏好），由「打开失败自学习」兜底纠正。
  //
  //   ★ 为什么必须留痕：`probeOnce` 的 catch 把**一切**异常都变成 `false` ——
  //     包括"网络真的不通"（预期）与"fetch 用法/环境出问题"（缺陷）。
  //     两者在这里**不可区分**，而我们**能**区分的是"两个探测都失败了"这件事。
  //     用户看到的只有"页签打开后是一片错误页"，没有别的信号。
  log.warn('probeScheme(%s) 两个探测都失败（https 与 http 的 favicon 都不通）⇒ '
    + '按安全偏好回落 https，靠「打开失败自学习」纠正', host);
  return 'https';
}
