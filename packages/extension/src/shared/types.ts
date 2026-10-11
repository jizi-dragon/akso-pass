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

/** ISOLATED 桥 → background 的上行载荷 */
export type BridgeUpPayload =
  | { op: 'hello'; url: string }
  | { op: 'storageWrite'; key: string; value: string | null }
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
