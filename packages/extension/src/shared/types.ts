/** 加密后的账号密码 */
export interface SiteGrant {
  host: string;
  grantedAt: number;
}

/**
 * 浏览器并行账号（纯扩展模式，不依赖本地引擎）。
 * 每个账号可打开多个标签页并行在线；页签名用于标签标题展示，可自定义。
 */
export interface ParallelAccount {
  id: string;
  /** 绑定的站点 host */
  siteHost: string;
  /** 站点协议（v3.10.9）：缺省 = https（兼容存量）；打开 URL 与 Cookie 查询跟随。
   *  来源：添加时解析用户输入/自动探测（https 优先），打开失败时自学习翻转。 */
  scheme?: 'http' | 'https';
  /** 自定义页签名 —— 该账号标签页的标题 */
  tabName: string;
  /** 账号名（登录用户名） */
  username: string;
  /**
   * 服务端是否已存口令（v3.14 云端数据源）。
   * 云端模式下口令不落扩展（服务端 Fernet 密文），`credentials` 恒为空，
   * 只能由服务端如实回报"有没有"——UI 的「已存密码」标记据此显示。
   * 本地账号不写该字段（缺省 undefined = 以 credentials 是否存在为准）。
   */
  hasPassword?: boolean;
  color: string;
  /** 所属盒子（收纳分组）；缺省 = 「默认盒子」 */
  box?: string;
  /**
   * ★★★ v4.2.12：**所属站点的 id**（服务端主键）。
   *
   * 它是「编辑账号 → 改所属站点」那条路径**唯一**能用的键：
   * `PATCH /api/accounts/{id}` 收的是 `siteId`，而扩展平时只认 `siteHost`
   * （那是客户端自己从 `baseUrl` 推出来的，**服务端根本没有这个字段**）。
   * ⇒ 编辑弹窗的站点下拉要靠它预选中。
   *
   * ★ 别把两者当成同一件事：`siteId` 来自记录本身，`siteHost` 由它经 `sites` 表
   *   回落而来（见 `cloud-store.toAccount()` 的那条链）。
   */
  siteId?: string;
  /**
   * ★★★ v4.2.12：**备注**。
   *
   * 云端控制台一直能读能写（编辑弹窗里那一格），而扩展此前**既不读也不传**
   * ⇒ 在网页上写的备注在扩展里完全看不到，而扩展创建账号时也不会带上它。
   * 「两端显示的数据必须一致」这条要求下，它必须补上。
   */
  note?: string;
  createdAt: number;
  /**
   * 最后修改时间（毫秒）：合并冲突的裁决依据 —— 新的赢。
   * ⚠️ 历史记录（云端旧行 / 老版本写入的本地行）可能没有这个字段，**一律按 createdAt 兜底**，
   * 不要假设它一定存在（`Number.isFinite(a.updatedAt) ? a.updatedAt : a.createdAt`）。
   */
  updatedAt: number;
}

/** 并行账号运行时状态（由 background 依据绑定表与 token 快照实时计算） */
export interface ParallelAccountStatus {
  tabIds: number[];
  hasToken: boolean;
  /** 站点授权缺失/被停用：DNR 改头与 Cookie 剥离不生效，功能暂停 */
  enforcementOff?: boolean;
}

/**
 * ★★ 云端权威的盒子（2026-10-13）。
 *
 * 服务端 `GET /api/boxes` 从 2026-10-12/13 起给出这一整套字段。**改前扩展只读 4 个**
 * （`name` / `isDefault` / `disabled` / `count`），而且后三个读了就丢 ——
 * 于是"网页上禁用了一个盒子，扩展轮盘照旧会切到它"这类**两边口径不一致**全都无从发现。
 *
 * ★ 为什么这份形状放在 `shared/`：它是 **SW ⇄ UI 的协议载荷**（`par.boxes`），
 *   而本仓规则是"协议单一定义、调用点不就地写对象字面量"。
 *
 * ★★ 三个 `*able` 由**服务端算好**（默认盒三个都是 `false`）。
 *   UI **不要**自己判 `name === defaultBox` —— 判据只该有一处，
 *   而"同一事实两处判断，迟早不一致"正是本仓反复记过的那一类。
 */
export interface ParBox {
  name: string;
  isDefault: boolean;
  /** 用户手动禁用。★ 云端口径：它**已经含**了 `autoDisabled` 那一半。 */
  disabled: boolean;
  /**
   * 派生态：默认盒且盒内没有账号。
   * ★ 只用来**解释**为什么禁用（文案），**不要**拿它自己算禁用 ——
   *   那会和 `disabled` 叠加成第三套口径。
   */
  autoDisabled: boolean;
  /** 盒内账号数（未归盒的账号计入默认盒）。 */
  count: number;
  renameable: boolean;
  deletable: boolean;
  bindable: boolean;
  /** 关联站点（空串 = 未关联）。默认盒**永远**是空串。 */
  siteId: string;
  /** 站点名（给人看）。站点被删之后，服务端会把它清成空串。 */
  siteName: string;
}

/**
 * ★ 2026-10-19：**云端站点的只读摘要**（`par.sites` 的载荷，也是编辑弹窗的输入）。
 *
 * 此前这个形状在四个地方各写一遍（协议 / cloud-store / parallel-store / UI），
 * 而这一轮要加 `baseUrl` 与 `note` —— 少改一处就会**静默丢字段**：
 * 编辑弹窗的地址栏会是空的，保存时再把站点地址改成空串（服务端 400），
 * 用户看到的是"莫名其妙保存失败"。
 *
 * ★ `host` 是从 `baseUrl` 推导出来的**身份键**（账号绑定用它），
 *   `baseUrl` 是服务端原样存的地址（可能带路径 / 端口 / 协议）。
 *   两者不要混用：改地址走 `baseUrl`，认站点走 `host` 或 `id`。
 */
export interface CloudSiteSummary {
  id: string;
  host: string;
  name: string;
  /** UI 主标题：用户起过名就用名，否则从地址推导（口径见 cloud-store）。 */
  displayName: string;
  baseUrl: string;
  note: string;
  /** 服务端算好的账号数（`/api/sites` 的 `accountCount`），与云端站点卡片同源。 */
  accountCount: number;
}

/**
 * 一次原子读取的 UI 状态（`GET /api/ui/state`）。
 *
 * ★ 2026-10-21：此前扩展分别请求 accounts / sites / boxes；三个响应之间
 *   可以插入写入，页面会拿到"新账号 + 旧站点/盒子"的拼盘。
 *   这个形状把三份数据和同一个 revision 绑在一起，扩展整页替换而不是拼装。
 */
export interface CloudUiState {
  revision: number;
  accounts: ParallelAccount[];
  sites: CloudSiteSummary[];
  boxes: ParBox[];
  defaultBox: string;
}

/**
 * 删除云端站点的结果 —— **四态，不能压成一个布尔**。
 *
 * ★★ v4.2.12 加 `blocked`。它是服务端 `DELETE /api/sites/{id}` 在"站点下还有账号"
 *   时回的 **409**，而那个 409 **带着数据**：`accountCount` 与 `usernames`。
 *
 * ## 为什么必须是四态
 *
 * 改前是 `{kind:'deleted'|'missing'|'offline'}`，而 409 没有对应的那一支 ——
 * 于是它会以"普通 Error"冒到 UI，用户看到的是一句
 * `云端请求失败（HTTP 409）：该站点下还有 3 个账号…`（把服务端的 JSON 摊在脸上），
 * 而**级联删除这个后果根本没有机会被摊开确认**。
 *
 * 现在四件事各自有名字，因为它们对用户的含义完全不同：
 *   · `deleted`  ⇒ 删掉了（`accountsDeleted` 是服务端报的级联账号数，**必须如实转达**）
 *   · `missing`  ⇒ 云端本来就没有（"本机删一个从没同步过的站点"是正常路径，不是失败）
 *   · `offline`  ⇒ 连不上云端（**本机什么都没动**）
 *   · `blocked`  ⇒ **站点还在，什么都没删**：服务端要求先看到名单再显式确认
 *
 * ★★ 这里曾经有一个**静默缺陷**（v4.2.12 修）：`deleted` 那一支的读取方
 *   用的是 `accountsDeleted`，而服务端 `sites.py` 返回的字段名是
 *   **`deletedAccounts`** ⇒ 级联删掉 12 个账号时，界面上写的是"0 个"。
 *   两边都不报错，只是数字一直是 0。
 */
export type CloudDeleteSiteResult =
  | { kind: 'deleted'; accountsDeleted: number }
  | { kind: 'missing' }
  | { kind: 'offline'; reason: string }
  /** 服务端 409：站点下还有账号。`usernames` 用于把"要删哪些"摊开给人看 */
  | { kind: 'blocked'; accountCount: number; usernames: string[] };

/** ISOLATED 桥 → background 的上行载荷 */
export type BridgeUpPayload =
  | { op: 'hello'; url: string }
  | { op: 'storageWrite'; key: string; value: string | null }
  /** ★ 平面补丁的安装结果（2026-10-12 加）。
   *
   *  `patch()` 遇到不可配置的内建属性时**什么都做不了**，而它原本完全静默 ——
   *  于是「隔离开着但那一层没装上」与「一切正常」在诊断上无法区分。
   *  排查 Edge 上"打开账号卡死/闪退"时正是卡在这里（无法判断描述符是否不同）。
   *  ⇒ MAIN 壳激活后上报账本，后台写进 `ql:forensics`（诊断包可见）。
   *  ★ 纯留痕：不改行为、不上行回包。 */
  | {
      op: 'patchReport';
      all: string;
      failed: string;
      failedCount: number;
      ua: string;
    }
  | { op: 'authHeader'; value: string }
  | { op: 'journalRollbackDone' }
  /** 页内 document.cookie 写入的 Cookie 袋全量视图（v3.10.6 袋→快照回流）：
   *  绑定页签的 Cookie 写入被 MAIN 壳虚拟化进袋子，永不落真实 jar——服务端登录后
   *  由页内 JS 写入的票据/凭据若不回流快照，网络平面回放永远缺失 */
  | { op: 'bagChanged'; bag: Record<string, string> }
  /** ★ `nsWipeShared` 的**结果回执**（2026-10-12 补）。刻意用**独立的 op 名**，
   *  而不是给下行的 `nsWipeShared` 加可选字段：同名字面量在判别联合里会**合并**
   *  （谁先匹配上算谁），于是"下行是命令、上行是回执"两种方向相反的东西会共用一个
   *  类型 —— 读的人分不清、`switch` 也分不开。命名沿用既有的 `journalRollbackDone` 惯例。
   *
   *  为什么需要它：清扫此前**完全静默**，而"清扫成功且无事可做"与"清扫逻辑根本没生效"
   *  在取证里长得一模一样 —— 后者曾是真实缺陷（走了补丁版 `databases()`，
   *  前缀已被剥掉 ⇒ `startsWith(ns)` 恒 false ⇒ 一个库都删不掉）。 */
  | { op: 'nsWipeSharedDone'; dbsDropped: number; cachesDropped: number; error?: string };

/** background → ISOLATED 桥的下行载荷 */
export type BridgeDownPayload =
  /** 绑定账号并附带初始快照种子（token 等，用于壳激活瞬间同步灌入命名空间）；
   *  tabId 供壳做页面层缓存分区（_qlck=t<tabId>，DNR urlTransform Chrome 不支持）；
   *  bag = 账号 Cookie 快照的权威视图（非身份键）——绑定时袋整体同步到该视图
   *  （v3.12.1：修复登出/过期后重开时命名空间陈旧袋复活并毒化登录 POST） */
  | { op: 'bind'; accountId: string; tabId?: number; seed?: Record<string, string>; bag?: Record<string, string> }
  | { op: 'unbound' }
  /** v3.13 收编加固：亲子继承候选页签（URL 未确认授权前）收到 hello 的应答——
   *  壳保持等待（不置 settled/unbound），待 URL 确认授权后正式收编并灌种子 */
  | { op: 'hold' }
  /** 身份叛逃处置：回滚本页会话对命名空间的全部写入（含 Cookie 袋），恢复到页签打开前状态 */
  | { op: 'journalRollback' }
  /** 清扫本账号命名空间的 IDB / CacheStorage 共享缓存（叛逃页签写入的他人数据） */
  | { op: 'nsWipeShared' };
