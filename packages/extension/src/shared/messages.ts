import type { LogRecord } from './log';
import type { ParallelAccount, ParallelAccountStatus } from './types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * UI / content ⇄ background 的请求协议。
 *
 * ★★ 2026-10-12 删：`site.grants.list` / `site.grant.add` / `wheel.toggle` 三个 kind
 *   在 `dispatch` 里有处理分支、在这里有定义，而**全仓零发送方** ⇒ 它们是死协议
 *   （`docs/PITFALLS.md` #34）。删除的判据是**双向查**：① 每个 kind 能报出它的
 *   **发送方**；② 每个上行 op 能报出它的**处理分支**。
 *   ★ 删掉后若有旧代码仍在发，会落到 `dispatch` 的 `default` 分支 ——
 *     那里 `log.error` + 明确的错误响应（**可见的失败**，而不是看起来成功的空数组）。
 *
 * ★ 说明**必须写在联合体外面**：本仓的判据用「从头吃到第一个 `;` + 换行」来抽取这个
 *   联合（`verify-log-redaction.mjs` 第 9 节）。写在里面的注释只要含一个**中文分号
 *   ＋换行**，抽取就会**提前收尾**，于是 kind 集合变空 ⇒ 三条判据同时假红
 *   （实测：那一轮 `118/121`，报"没有契约之外的孤例 case"却列了全部 25 个）。
 */
export type RuntimeRequest =
  | { kind: 'par.list' }
  /* ---- 离线只读副本的可见性（v3.19，2026-10-09）----
   * 决策：本地数据源废除后，离线**只能看副本**（可看、可开页签；
   * 不可新增/编辑、填表失效）。
   * ⇒ 界面**必须明说"这是副本"**，否则用户会把副本当成实时数据，
   *   而"改了没反应"会被理解成扩展坏了。
   * ★ 判据是**发生地记账**（`lastListFellBack`），不是"快照年龄"启发式 ——
   *   见 `background/core/parallel-store.ts` 里那段注释。 */
  | { kind: 'par.offline' }
  /* ---- 云端权威的**盒子名单**（2026-10-12）----
   * 用户报"盒子的数据没有做好同步"：实测**扩展 5 个盒子、云端 2 个**。
   * 扩展侧的根因是 UI 的盒子列表把"本地记住的"取了并集，而那份名单只会被加、
   * 不会被减 ⇒ 云端删掉/改名的盒子永远留着。
   * ★ 这条消息给 UI 一个**对账依据**：`result.data` 为 `null` 表示"没拿到"
   *   （离线），那时 UI 的约定是**一个字都不动**。 */
  | { kind: 'par.boxes' }
  | { kind: 'par.create'; siteHost: string; tabName: string; username: string; password: string; open: boolean; box?: string; scheme?: 'http' | 'https' }
  | { kind: 'par.probeScheme'; host: string }
  | { kind: 'par.update'; id: string; patch: Partial<Pick<ParallelAccount, 'tabName'>> }
  | { kind: 'par.moveBox'; id: string; box: string }
  | { kind: 'par.renameBox'; from: string; to: string }
  | { kind: 'par.deleteBox'; name: string }
  | { kind: 'par.delete'; id: string }
  | { kind: 'par.open'; id: string; forceNewTab?: boolean }
  | { kind: 'par.grantChanged' }
  | { kind: 'ql.diag' }
  /**
   * ★★ 前端把日志转给 SW（v3.19）。
   *
   * `log()` 的环形缓冲与落盘 sink 都在 **SW 里**，而 content script 与扩展页面
   * **各有自己的 JS 环境** ⇒ 它们记的日志永远进不了诊断包（实测 `ui/` 全仓零日志，
   * `content/` 6/7 零日志 —— 不是忘了加，而是**加了也看不到**）。
   *
   * `records` 里的 `msg` **必须是已打码的**（`getForwardingLogger` 保证）。
   */
  | { kind: 'ql.log'; records: LogRecord[] }
  | { kind: 'data.export' }
  | { kind: 'data.import'; data: DataBackup }
  /* ---- 数据源（本地 ↔ 云端，v3.14）---- */
  | { kind: 'cloud.state' }
  /* ---- 云端设备授权（RFC 8628 设备流，v3.14.1）---- */
  /** 起一次设备授权（无凭据）：服务端返回批准页 URL；`deviceCode` 留在 SW 内存里，不回传 */
  | { kind: 'cloud.device.start'; clientName?: string }
  /**
   * 查一次授权状态。**调用方必须按 `interval` 秒调**：这是唯一无需凭据即可调用的端点族，
   * 轮询太密等于给服务端做压测（SW 侧不排程，节拍由页面那一个循环决定）。
   */
  | { kind: 'cloud.device.poll' }
  /** 放弃本次授权：SW 把 `deviceCode` 从内存里丢掉（页面侧同时停掉轮询循环） */
  | { kind: 'cloud.device.cancel' }
  /* ---- 实例状态轮盘（v3.15：Alt+W）---- */
  /**
   * 问「当前页签是不是可操作的对象实例页」。
   * 走 sender.tab（而不是让页面自报）——注入的浮层与目标页签必须是同一个，
   * 由调用方自报 tabId 等于把「操作了哪个页签」交给页面决定。
   */
  | { kind: 'status.context' }
  /** 读状态列表（GetFormInstance → GetListByBasicId 两步链路，在页面主世界执行） */
  | { kind: 'status.load' }
  /** 切状态（点即执行；成功后由 background 延时刷新该页签） */
  | { kind: 'status.change'; code: string; name: string }
  /* ---- 常用页面书签轮盘（v3.16：Alt+1）---- */
  /** 取书签清单（空则回落内置默认；由 background 统一归一化，浮层不自己读 storage） */
  | { kind: 'favorites.list' }
  /** 在新标签页打开某个书签；`baseOrigin` 为空时按当前活动页签的 origin 兜底 */
  | { kind: 'favorites.open'; path: string; baseOrigin?: string };

/**
 * 备份文件结构（v1）。
 *
 * ★ v3.18：**不再包含任何凭据材料**。
 *   旧版带 `cryptoSeed` + 每账号的 AES-GCM `credentials`，而本地凭据存储已废除
 *   （密钥种子与密文同处一台机器，防不住"扩展数据目录被整份拿走"）⇒
 *   那份密文既解不开、也不该再产生。
 *   现在导出的是**配置**（站点 / 标题 / 盒子 / 用户名），换机器时省去重配，但不含秘密。
 */
export interface DataBackup {
  format: 'quicklogin-backup';
  version: 1;
  exportedAt: string;
  /** 授权站点 host 清单 */
  sites: string[];
  boxes: { default?: string; remembered?: string[]; disabled?: string[] };
  accounts: Array<{
    siteHost: string;
    tabName: string;
    box?: string;
    /**
     * ★ v3.18：**只导元数据，不含任何凭据材料**。
     *
     * 旧格式这里是 `credentials: { encryptedUsername, encryptedPassword, iv, ivPassword } | null`
     * 加上顶层的 `cryptoSeed`，导入时现场解密。而本地凭据存储已废除
     * （密钥种子与密文同处一台机器，防不住"扩展数据目录被整份拿走"）⇒
     * 那份密文既解不开、也不该再产生。导出配置，口令留云端。
     */
    username?: string;
  }>;
}

export type RuntimeResponse =
  | { kind: 'par.list'; result: Result<Array<ParallelAccount & ParallelAccountStatus & { password: boolean }>> }
  /* `offline=true` ⇒ 用户此刻看到的列表**就是**只读副本（不是"可能旧"）。
   * `savedAt` / `ageMs` 让界面能说准"这是多久前的副本"，
   * 而不是含糊的"可能是旧的"（`account-cache.ts` 的设计意图）。 */
  | { kind: 'par.offline'; result: Result<{ offline: boolean; savedAt?: number; ageMs?: number; revision?: number }> }
  | { kind: 'par.boxes'; result: Result<{ names: string[]; default: string } | null> }
  | { kind: 'par.create'; result: Result<ParallelAccount> }
  | { kind: 'par.probeScheme'; result: Result<'http' | 'https'> }
  | { kind: 'par.update'; result: Result<ParallelAccount> }
  | { kind: 'par.moveBox'; result: Result<ParallelAccount> }
  | { kind: 'par.renameBox'; result: Result<{ moved: number }> }
  | { kind: 'par.deleteBox'; result: Result<{ moved: number }> }
  | { kind: 'par.delete'; result: Result<void> }
  | { kind: 'par.open'; result: Result<{ tabId: number; reused: boolean }> }
  | { kind: 'par.grantChanged'; result: Result<boolean> }
  | { kind: 'ql.diag'; result: Result<Record<string, unknown>> }
  /** ★ 前端日志转发（v3.19）。SW **不回传内容**（避免日志变成往返流量）。 */
  | { kind: 'ql.log'; result: Result<{ accepted: number }> }
  | { kind: 'data.export'; result: Result<DataBackup> }
  | { kind: 'data.import'; result: Result<{ created: number; skipped: number; hosts: string[] }> }
  /* ---- 数据源（本地 ↔ 云端，v3.14）---- */
  | { kind: 'cloud.state'; result: Result<CloudState> }
  /* ---- 云端设备授权（RFC 8628 设备流，v3.14.1）---- */
  | { kind: 'cloud.device.start'; result: Result<CloudDeviceStart> }
  | { kind: 'cloud.device.poll'; result: Result<CloudDevicePoll> }
  | { kind: 'cloud.device.cancel'; result: Result<{ cancelled: boolean }> }
  /* ---- 实例状态轮盘（v3.15：Alt+W）---- */
  | { kind: 'status.context'; result: Result<StatusContext> }
  | { kind: 'status.load'; result: Result<StatusList> }
  | { kind: 'status.change'; result: Result<{ name: string }> }
  /* ---- 常用页面书签轮盘（v3.16：Alt+1）---- */
  | { kind: 'favorites.list'; result: Result<FavoriteItem[]> }
  | { kind: 'favorites.open'; result: Result<{ url: string }> };

/**
 * 实例状态上下文（v3.15）：从**当前活动页签的 URL** 解析出来的可操作对象。
 * `bid` = objectId、`id` = instanceId、`mid` = 菜单 id（用于 `/web/view` 上反查 objectId）。
 */
export interface StatusContext {
  href: string;
  origin: string;
  objectId: string;
  instanceId: string;
  menuId: string;
  /** 是否可以继续查状态（至少要能确定 objectId，或能用 mid 反查） */
  operable: boolean;
  /** 不可操作时的可读原因（浮层空态直接显示它） */
  reason: string;
}

/** 一个实例的生命周期状态列表 */
export interface StatusList {
  /** 生命周期名（可能为空：服务端没给） */
  lifecycleName: string;
  /** 当前状态名（接口字段优先，退回页面 DOM 文字；都读不到为空串） */
  currentName: string;
  statuses: Array<{ id: string; code: string; name: string }>;
}

/** 数据源现状（管理页选择器据此渲染；不回传 token 本身） */
export interface CloudState {
  /** 是否已持有云端会话（缺省 false = 需要授权码登录） */
  authorized: boolean;
  /** 已登录账号邮箱（未知时为空串） */
  email: string;
  /**
   * 展示名与头像（来自服务端 `/api/auth/profile` 的同一条 `user`）。
   * ★ 纯展示：取不到就回落邮箱前缀、再回落"已登录云端"。
   * 它们**不参与任何鉴权判断** —— 否则会出现"头像没取到于是登录失败了"。
   */
  displayName: string;
  avatar: string;
  /** 云端服务地址（缺省 = 内置地址） */
  baseUrl: string;
}

/**
 * 设备授权第一拍（`POST /api/auth/device-start`）里**可以出网**的那部分。
 * ★ `deviceCode` 不在这里：它是换令牌的凭据，只活在 SW 内存里（不进 DOM / storage / 日志）。
 */
export interface CloudDeviceStart {
  /** 服务端拼好的完整批准页 URL —— 直接 `chrome.tabs.create` 打开它，**不要自己拼** */
  verificationUrl: string;
  /**
   * 8 位数字授权码，只用于服务端的 `/authorize` 批准页。
   * 页面**不渲染它**：仅用来核对用户在"手动输入 8 位码"兜底入口里敲的码是不是本次会话的。
   */
  userCode: string;
  /** 本次授权的总时长（秒）——页面据此自动停止轮询 */
  expiresIn: number;
  /** 轮询间隔（秒）——**必须遵守** */
  interval: number;
  /** 设备自报的名字（批准页会显示） */
  clientName: string;
}

/**
 * 设备授权一拍的结论。前六个是服务端的语义，`stopped` 是本地加的：
 * 本次会话已被取消 / 已被新的一次授权替换（此时不该再有任何请求）。
 */
export type CloudDevicePoll =
  | { status: 'pending'; interval: number }
  | { status: 'approved'; email: string }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'consumed' }
  | { status: 'unknown' }
  | { status: 'stopped' };

/* ★★ 2026-10-12 删：`CloudMergeReport`（原在此处）。
 *   它是"本地 → 云端合并回报"的类型，而**产生它的 `cloud.migrate` 在 v3.18 已随
 *   本地数据源整体废除** ⇒ 它成了**类型孤儿**：有完整定义、有注释、**零引用**。
 *   ★ 判据不是"有没有人 import 它"（type-only 的 import 会被 `noUnusedLocals` 抓到，
 *     但**零 import** 时什么都不会报）——而是**它描述的那个过程还在不在**。
 *     过程没了 ⇒ 类型必须一起走，否则读代码的人会以为存在一条迁移通路。 */

/** 常用页面书签条目（v3.16）；`path` 支持相对路径（`/admin/...`）或完整网址 */
export interface FavoriteItem {
  name: string;
  path: string;
}

export type { Result };
