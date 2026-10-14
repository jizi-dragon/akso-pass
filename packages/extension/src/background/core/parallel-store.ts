import { SESSION_COLORS } from '../../shared/constants';
import { cloudStore, fetchPlaintextPassword } from './cloud-store';
import { cacheBelongsTo, loadSnapshot, saveSnapshot } from './account-cache';
import type { ParallelAccount } from '../../shared/types';

/** 新增账号的入参 */
export interface ParallelAccountInput {
  siteHost: string;
  tabName: string;
  username: string;
  password: string;
  box?: string;
  scheme?: 'http' | 'https';
}

/**
 * 数据层门面契约：**这 10 个方法就是全部数据访问面**
 * （调用点只有 `parallel-session` / `service-worker`）。
 *
 * ★ v3.18（2026-10-09）：**本地数据源已整体废除**，这里只剩云端一种实现。
 *   签名一个都没改 —— 调用点一行不用动。
 */
export interface ParallelStore {
  list(): Promise<ParallelAccount[]>;
  get(id: string): Promise<ParallelAccount>;
  create(input: ParallelAccountInput): Promise<ParallelAccount>;
  updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount>;
  updateTabName(id: string, tabName: string): Promise<ParallelAccount>;
  updateBox(id: string, box: string): Promise<ParallelAccount>;
  renameBox(from: string, to: string): Promise<number>;
  clearBox(name: string): Promise<number>;
  delete(id: string): Promise<void>;
  /**
   * 站点清单（host ↔ 用户自定义名称）。v4.2.1 新增，给「站点管理」显示名字用。
   *
   * ★ 为什么它必须经过这一层而不是 UI 直接问云端：本仓的 UI **从不直接
   *   fetch 云端**（`src/ui/` 下零 `cloudRequest`）—— 授权、token、离线回落
   *   全在 background。UI 破例直连会绕过这三样，而且**失败形态是静默的**
   *   （UI 里一个 `catch {}` 就看不出来了）。
   *   ★ 注意这里写的是 `src/ui/` 而不是带通配的写法 —— 后者含注释开始标记，
   *     会让"块注释配平"判据（`verify-css-vars.mjs`）**误判**（见 PITFALLS #43）。
   */
  listSites(force?: boolean): Promise<{ id: string; host: string; name: string; displayName: string }[]>;
  /** 给站点改自定义名称（只改 name，不动 baseUrl —— 后者是 host 的唯一来源） */
  renameSite(host: string, name: string): Promise<void>;
  /** 添加站点时落名：站点不存在就建（与 `renameSite` 的差别是"容忍不存在"） */
  upsertSite(host: string, name: string): Promise<void>;
  /**
   * ★ v4.2.7：删云端站点（**服务端会级联删掉它下面的账号**）。
   *
   * ★ 返回值刻意做成三态而不是 `void`：`missing`（云端本来就没有）与
   *   `deleted` 都算"云端已经干净了"，而 `offline` 意味着**本机删了、云端还在** ——
   *   这三件事对用户的意思完全不同，不能压成一个布尔。
   */
  deleteSite(host: string): Promise<{ kind: 'deleted' | 'missing' | 'offline'; accountsDeleted?: number }>;
  /* ---------------- 盒子的三个写动作（2026-10-13 新增） ----------------
   *
   * ★★ 为什么这三个必须经过这一层，而不是让 UI 自己拼请求：
   *   ① 本仓的 UI **从不直接 fetch 云端**（`src/ui/` 下零 `cloudRequest`）；
   *   ② 服务端对默认盒的改名/禁用是 **400 拒绝**的 —— 拦截与"人话错误"要在一处；
   *   ③ 「新建盒子」此前根本不是"写动作"（只写本地），
   *      而它必须变成写动作：云端名单是权威，纯本地建会被对账剪掉。
   */
  /** 新建盒子（**打到云端**；重名时抛可读错误） */
  createBox(name: string): Promise<{ name: string }>;
  /** 禁用/启用（**服务端权威**；返回切换后的状态） */
  toggleBox(name: string): Promise<{ disabled: boolean }>;
  /** 关联/解除关联站点（`siteId` 空串 = 解除；`changed=false` 表示本来就一样） */
  bindBoxSite(name: string, siteId: string): Promise<{ siteId: string; changed: boolean }>;
}

/**
 * 离线错误与判定 —— **权威源在 `./offline`**，这里只**转发**。
 *
 * ★★ 2026-10-09 去重：本文件原先**自己又定义了一份** `OfflineError` 与
 *    `isOfflineError`（与 `offline.ts` **逐字相同**的第二个副本）。
 *
 *    当时**没有**出问题 —— 因为判定用的是**标记字段**
 *    （`e.isOfflineError === true`）而不是 `instanceof`，
 *    所以两份类定义产生的实例**互相认得**。
 *
 *    但这正是 `offline.ts` 文件头警告过的那个形态：
 *    > 循环依赖在 `iife` 打包下不报错，只会在运行时给出 `undefined` ——
 *    > 那时 `instanceof` 永远为 false，**回落静默失效**。
 *
 *    ⇒ 而"两份定义 + 一个靠标记字段的判定"只要被谁顺手改成 `instanceof`
 *      （那看起来是**更正规**的写法），离线回落就会**静默失效**：
 *      表现是"离线时列表空了"，而不是任何报错。
 *
 *    ⇒ 消除重复：一个类型只有一处声明。转发导出保留了原有的 import 路径，
 *      调用点不用动。
 */
export { OfflineError, isOfflineError } from './offline';
// ★ 上面那行是 **re-export**，它**不会**在本文件的作用域里绑定这两个名字。
//   所以本文件自己要用的 `isOfflineError` 必须**再 import 一次** ——
//   这是个容易漏的地方：只写 re-export 时，`tsc` 会在调用点报
//   `Cannot find name 'isOfflineError'`（而不是在 re-export 那行），
//   看起来像"调用点忘记了"，实际是 re-export 的语义。
import { isOfflineError } from './offline';
// ★ 日志（AGENTS.md 规则 22）：本模块的**离线回落判定**是"用户看到什么"的直接决定者，
//   而它此前没有任何日志 —— 排障时"为什么离线还能看 / 为什么改不了"无从查起。
import { getLogger } from '../../shared/log';

const log = getLogger('parallel-store');

/**
 * ★★ **上一次 `list()` 是不是走的只读副本** —— 这才是"离线"的**可靠信号**。
 *
 * # 为什么不用"快照年龄"来判断
 *
 * `getOfflineStatus()` 原先用的是**启发式**："快照的 `savedAt` 距今超过 10 分钟
 * 就认为离线"。它能猜到大多数情况，但有两个洞：
 *
 *  1. **刚断网时猜不到**：用户在 30 秒前刚成功同步过、然后网断了 ——
 *     副本年龄只有 30 秒 ⇒ 判为"在线"，而**实际显示的正是那份副本**。
 *  2. **反过来也会猜错**：放着一整天没打开扩展、今天打开且**网络正常** ——
 *     旧的 `savedAt` 会让它判为"离线"，而列表其实是刚从云端拿的。
 *
 * ⇒ 而 `listWithFallback()` **确实知道**自己走的是哪一支 ——
 *   它是那个事实的**发生地**。让发生地记下来，界面读它，就不需要猜。
 *
 * ★ 三个状态的语义（`undefined` 不是"在线"，是"这一轮还没问过"）：
 *   · `false` → 上一次 `list()` 真的从云端拿到了
 *   · `true`  → 上一次 `list()` 回落到只读副本（用户看的就是副本）
 *   · `undefined` → 本次 SW 生命周期内还没调过 `list()`
 */
let lastListFellBack: boolean | undefined;

/**
 * 读路径：**先云端，失败才回落到只读缓存**。
 *
 * ★ 回落是有条件的，这个条件很重要：只有**网络/超时类**失败才回落。
 *   如果是 401（令牌过期）或 403，回落会让用户看着一份旧数据、
 *   以为"还能用"，从而不去重新登录 —— 那比直接报错更糟。
 *   ⇒ 所以只有 `OfflineError` 才回落，认证类错误原样抛。
 */
async function listWithFallback(): Promise<ParallelAccount[]> {
  try {
    const rows = await cloudStore.list();
    // 成功即**刷新缓存**。这是缓存唯一的写入点。
    void persistSnapshot(rows).catch(() => undefined);
    // ★ 这一步是"在线"的**定义**：真的从云端拿到了数据。
    lastListFellBack = false;
    return rows;
  } catch (e) {
    if (!isOfflineError(e)) {
      throw e;
    }
    const snap = await loadSnapshot();
    if (!snap) {
      // ★ 这一支的决定是"**离线就是没法用**"，与下面那一支的"给只读副本"**相反**。
      //   两者在界面上长得像（都是"没数据"），而原因完全不同 ——
      //   所以必须能分开。记 `warn` 而不是 `error`：它不是缺陷，
      //   是"第一次离线且从未同步过"的正常分支。
      //
      // ★ 注意**不要**在这里把 `lastListFellBack` 置 true：
      //   这一支**没有**给用户副本（它抛错了），所以"在读副本"是假的。
      //   置 true 会让界面显示"这是离线副本"，而用户其实**什么都看不到** ——
      //   那是比不显示更坏的误导。
      log.warn('list() 离线且**无缓存** ⇒ 如实报错（这一支不给只读副本）');
      throw e; // 没有缓存 ⇒ 离线就是没法用，如实报错
    }
    // ★ 这是"离线只读模式"的**唯一入口**。用户接下来看到的列表、
    //   以及"为什么改不了"，都源于这一行。
    //
    // ★★ 而下面这一行是**本轮的关键**：它是"用户此刻看到的是副本"这个事实的
    //   **发生地**。记下来，界面就不需要靠"快照年龄"去猜。
    lastListFellBack = true;
    log.warn('list() 离线 ⇒ 回落只读副本（%d 个账号）', snap.accounts.length);
    return snap.accounts as ParallelAccount[];
  }
}

async function persistSnapshot(rows: ParallelAccount[]): Promise<void> {
  // 缓存归属校验需要当前登录邮箱；拿不到就按"本机上次登录"处理（见 account-cache 的注释）
  try {
    const { getCloudAuth } = await import('./cloud-store');
    const auth = await getCloudAuth();
    const snap = await loadSnapshot();
    if (snap && !cacheBelongsTo(snap.meta, auth?.email)) {
      // 换了账号 ⇒ 旧缓存必须先丢，不能把上一个人的列表写成本次快照
      await saveSnapshot(rows, { revision: -1, email: auth?.email });
      return;
    }
    await saveSnapshot(rows, { revision: -1, email: auth?.email });
  } catch {
    /* 缓存写失败不影响主流程 */
    // ★ 但**要留痕**：缓存是离线时唯一的可用数据源，而它的写失败是静默的。
    //   没有这一行时，"离线时列表是空的"会被归因到网络，而真因是缓存**从来没写成功过**。
    log.error('persistSnapshot 失败 ⇒ 离线时将没有可回落的数据（写失败不影响主流程）');
  }
}

/**
 * 数据层门面：**只有一个实现（云端）**，外加一条只读离线回落。
 *
 * 写操作（create / update* / renameBox / clearBox / delete / updateCredentials）
 * **一律不回落**：离线时抛出 `OfflineError`，让界面明说"改不了"。
 * 本地假写会让用户以为改成功了，而恢复在线后那份改动**根本不存在** ——
 * 这是被废除的那套方案最坏的一种失败形态。
 */
export const parallelStore: ParallelStore = {
  async list(): Promise<ParallelAccount[]> {
    return listWithFallback();
  },

  async get(id: string): Promise<ParallelAccount> {
    try {
      return await cloudStore.get(id);
    } catch (e) {
      if (!isOfflineError(e)) {
        throw e;
      }
      const snap = await loadSnapshot();
      const hit = snap?.accounts.find((a) => a.id === id);
      if (!hit) {
        // ★ 与 `list()` 的两支同理：离线 + 有副本但**这个 id 不在里面**
        //   （例如副本是换账号之前的、或那个账号是刚在别的设备上建的）。
        //   记下 id 才能区分"缓存里没有"与"缓存整个没有"。
        log.warn('get(%s) 离线且副本里没有这条 ⇒ 如实报错', id);
        throw e;
      }
      log.warn('get(%s) 离线 ⇒ 回落只读副本', id);
      return hit as ParallelAccount;
    }
  },

  create(input: ParallelAccountInput): Promise<ParallelAccount> {
    return cloudStore.create(input);
  },

  updateScheme(id: string, scheme: 'http' | 'https'): Promise<ParallelAccount> {
    return cloudStore.updateScheme(id, scheme);
  },

  updateTabName(id: string, tabName: string): Promise<ParallelAccount> {
    return cloudStore.updateTabName(id, tabName);
  },

  updateBox(id: string, box: string): Promise<ParallelAccount> {
    return cloudStore.updateBox(id, box);
  },

  renameBox(from: string, to: string): Promise<number> {
    return cloudStore.renameBox(from, to);
  },

  clearBox(name: string): Promise<number> {
    return cloudStore.clearBox(name);
  },

  /**
   * 站点清单（host ↔ 自定义名称）。
   *
   * ★ **离线时不回落只读副本**：账号快照（`account-cache`）里没有站点名这一项，
   *   而"站点名"在离线时也不是必需（站点管理本来就不能在离线时编辑）。
   *   ⇒ 直接让 `OfflineError` 抛出去，由 UI 显示"离线"而不是显示一个**半空的名字**。
   *   ★ 这条判断是有意的：宁可不显示，也不要显示"名字为空 = 看起来没设过"。
   */
  listSites(force = false): Promise<{ id: string; host: string; name: string; displayName: string }[]> {
    return cloudStore.listSites(force);
  },

  renameSite(host: string, name: string): Promise<void> {
    return cloudStore.renameSite(host, name);
  },

  upsertSite(host: string, name: string): Promise<void> {
    return cloudStore.upsertSite(host, name);
  },

  deleteSite(host: string): Promise<{ kind: 'deleted' | 'missing' | 'offline'; accountsDeleted?: number }> {
    return cloudStore.deleteSite(host);
  },

  /* ---------------- 盒子的三个写动作（2026-10-13）：纯转发，语义在 cloud-store ---------------- */

  createBox(name: string): Promise<{ name: string }> {
    return cloudStore.createBox(name);
  },

  toggleBox(name: string): Promise<{ disabled: boolean }> {
    return cloudStore.toggleBox(name);
  },

  bindBoxSite(name: string, siteId: string): Promise<{ siteId: string; changed: boolean }> {
    return cloudStore.bindBoxSite(name, siteId);
  },


  delete(id: string): Promise<void> {
    return cloudStore.delete(id);
  },
};

/**
 * 自动填表要的**明文口令**。
 *
 * v3.18 之后只剩一条路：**当场** `GET /api/accounts/{id}/password` 取一次。
 * 旧方案里那条"解密本地 AES-GCM `credentials`"的路已随本地数据源一起废除 ——
 * 也就是说**口令在本机不再有任何持久化形态**。
 *
 * ★ 判别只看账号自身的 `hasPassword`（服务端快照里带回来的字段），
 *   不看任何"数据源标记" —— 依赖标记会在标记过期时静默返回 null，
 *   表现是"自动填表突然不填了"，是最难查的一类。
 *
 * 取不到返回 `null`（调用方按"无凭证"处理，绝不让它中断 open()）。
 */
export async function resolveAccountPlaintext(
  account: ParallelAccount,
): Promise<{ username: string; password: string } | null> {
  if (!account.hasPassword) {
    return null;
  }
  try {
    const password = await fetchPlaintextPassword(account.id);
    return password ? { username: account.username, password } : null;
  } catch {
    // ★ 离线 / 取不到一律返回 null：**填表失效是设计的一部分**，
    //   不是错误路径。绝不能因为取不到口令就让"打开账号"整个失败。
    return null;
  }
}

/** 供界面用：这份列表是不是离线副本，以及它有多旧。 */
export interface OfflineStatus {
  offline: boolean;
  savedAt?: number;
  ageMs?: number;
  revision?: number;
}

/**
 * 界面的"这是副本"提示读它。
 *
 * ★★ 判据改成了**发生地记账**（`lastListFellBack`），不再是"快照年龄"启发式。
 *   原因见 `lastListFellBack` 的注释（年龄有两个洞：刚断网猜不到、
 *   长期没打开又网络正常时会误报）。
 *
 * ★ 三个输入合起来才是完整判断：
 *   · `lastListFellBack === true` ⇒ 「读的是副本」（**主判据**）
 *   · `lastListFellBack === false` ⇒ 「上一轮是云端拿的」⇒ 不提示
 *   · `lastListFellBack === undefined` ⇒ 「本轮还没问过」⇒ **不提示**
 *     （★ 这一支不能当成离线：扩展刚启动、用户还没打开列表页时，
 *       报"离线"是无中生有。宁可不说，也不要错说。）
 *
 * ★ 仍然保留 `ageMs` / `savedAt`：界面要显示"这是多久前的副本"
 *   （`account-cache.ts` 的设计意图就是"给出准确的离线提示"而不是含糊的"可能是旧的"）。
 */
export async function getOfflineStatus(): Promise<OfflineStatus> {
  const snap = await loadSnapshot();
  if (!snap) {
    // 没有副本 ⇒ 无论连线与否，都不存在"正在看副本"这回事
    return { offline: false };
  }
  const ageMs = Date.now() - snap.meta.savedAt;
  const base = { savedAt: snap.meta.savedAt, ageMs, revision: snap.meta.revision };
  // ★ 主判据：发生地记的账
  if (lastListFellBack === true) {
    return { offline: true, ...base };
  }
  // ★ 上一轮明明从云端拿到了 ⇒ 在线，别因为副本"看着旧"而误报
  if (lastListFellBack === false) {
    return { offline: false };
  }
  // ★ 本轮还没问过（`undefined`）⇒ 不报离线。
  //   宁可不说，也不要错说 —— 而这一支正是旧实现会误报的地方。
  return { offline: false };
}

/** 测试与"退出登录"用：把只读副本也清掉（换账号时**必须**清，见 account-cache）。 */
export async function dropCachedSnapshot(): Promise<void> {
  const { clearSnapshot } = await import('./account-cache');
  await clearSnapshot();
  // ★ 副本没了，"读的是副本"这个记账也必须清 ——
  //   否则退出登录后界面还会说"这是离线副本"，而那时**一份副本都没有**。
  lastListFellBack = undefined;
}

export { SESSION_COLORS };
