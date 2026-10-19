/** 扩展版本号（与根 package.json / manifest.json 保持同步；UI 中显性展示以区分构建） */
export const EXT_VERSION = '4.2.13';
export const IDB_NAME = 'sessionbox-reborn';
export const IDB_VERSION = 2;
export const IDB_STORE_SESSIONS = 'sessions';
export const IDB_STORE_ACCOUNTS = 'accounts';

/** 存在 session 级 chrome.storage.session 中的键 */
export const SESSION_KEYS = {
  sessionTabBindings: 'sb:tabBindings',
  pendingAutoLogins: 'sb:pendingAutoLogins',
  /** 并行账号的 tabId ↔ accountId 绑定表 */
  parTabBindings: 'ql:parTabBindings',
  /** 并行账号捕获到的运行时凭证快照（Bearer token 等，随浏览器会话存活） */
  parTokens: 'ql:parTokens',
} as const;

/** 存在 chrome.storage.local 中的站点清单键 */
export const LOCAL_KEYS = {
  siteGrants: 'sb:siteGrants',
  /** 手动停用的站点（Chrome 拒绝回收授权时本地封锁，不再对其安装改头规则） */
  blockedHosts: 'ql:blockedHosts',
  /**
   * 账号中心当前选中的二级面板（v4.2.2 第五轮：`accounts` / `add` / `sites` / `favorites`）。
   *
   * ★ 为什么要记：这一页有 `setInterval(…, 3000)` 的刷新循环，而**刷新不该把用户
   *   从"站点管理"弹回"并行账号"**。不记的话，用户每次被弹回去都会以为"点了没生效"。
   * ★ 只存名字而不是索引：面板顺序将来可能调整，索引会指错。
   */
  parallelTab: 'ql:parallelTab',
  /**
   * ★ v4.2.3：**用户主动从站点列表里隐藏的 host**（与 `blockedHosts` **不同**）。
   *
   * | 名单 | 意思 | 后果 |
   * |---|---|---|
   * | `blockedHosts` | 有浏览器授权，但**在 Akso Pass 里停用** | 改头规则不对它生效（必须的：权限回收不掉） |
   * | `hiddenHosts`  | **本来就没有浏览器授权**，用户不想再看到它 | 只是不显示；没有任何权限/规则动作 |
   *
   * ★ 为什么必须分开：合成一个的后果是"隐藏"一个从未授权的站点会**顺带把它停用** ——
   *   而它从未生效过，停用是无意义的副作用；更糟的是将来它被重新授权时，
   *   用户会因为它莫名其妙处于"已停用"而收到一个**看不懂的提示**。
   *   这正是 `docs/PITFALLS.md` #30「接口摆在那里 ≠ 被接上了」的同族：
   *   **两个不同的意图共用一个存储位，就会互相冒充。**
   */
  hiddenHosts: 'ql:hiddenHosts',
  /** 记忆的盒子清单（空盒子也保留；缺省「默认盒子」不入库） */
  boxList: 'ql:boxes',
  /** 默认盒子的自定义名称（未归盒账号的归宿；缺省「默认盒子」） */
  defaultBox: 'ql:defaultBox',
  /** 被禁用的盒子名单（轮盘跳过切换；空默认盒自动禁用） */
  disabledBoxes: 'ql:disabledBoxes',
  /**
   * ★ 2026-10-19：盒子详情的**离线副本**（`ParBox[]`，不含任何凭据）。
   *
   * 为什么要落盘：盒子台账的"关联站点 / 可改名 / 可删除"全部来自
   * `GET /api/boxes`，而离线时那份数据拿不到。旧实现据此显示一行
   * 「（离线：站点信息未同步）」并把按钮全撤掉 —— 用户看到的是一块**坏掉的界面**。
   * ⇒ 每次成功拉取时把服务端算好的这份详情写进本地，离线时用**上一次同步到的
   *   状态**渲染（与 `ql:disabledBoxes` 同一套"云端权威 + 本地只读副本"口径）。
   * ★ 它只缓存**显示状态**，不参与任何判断 —— 账号归属仍以账号数据为准。
   */
  boxDetails: 'ql:boxDetails',
  /** 站点协议 hint（v3.10.9：授权时从用户输入 URL 解析；账号创建时优先采用） */
  siteSchemes: 'ql:siteSchemes',
  /** 常用页面书签（v3.16：轮盘 Alt+1 展示；[{name,path}]，空 = 用内置默认 7 条） */
  favorites: 'ql:favorites',
  /** 登录失败现场取证环形缓冲（v3.12.2：生命周期 + 自动填表逐事件） */
  forensics: 'ql:forensics',
  /**
   * `shared/log.ts` 的**落盘镜像**（v3.19）。
   *
   * ★★ 为什么必须有它（而不是只靠 SW 的内存环）：
   *   `log.ts` 的环形缓冲在 **service worker 的内存里**，而 **MV3 空闲会回收 SW**
   *   ⇒ 等用户去导出诊断包时，环里往往已经空了 —— 而诊断包恰恰是
   *   **"出事之后"**才去取的东西。**最需要日志的时刻，日志已经没了。**
   *
   * ★ 这条通道由 `setSink()` 接入。★ 而 `log.ts` **早就提供了那个注入点**，
   *   在此之前它**全仓零调用** —— 一个摆在那里、从没接线的接口
   *   （与 v3.19 修掉的 `.side-collapsed` 同型：接口/样式齐备，没人接线）。
   * ★ 与 `ql:diag` / `ql:forensics` 的分工不变：那是**结构化事件**，
   *   这是**带级别的文本轨迹**（"按什么顺序、在哪一层退出的"）。
   */
  logPersist: 'ql:log',
  /** 云端账号库会话：{ baseUrl, token, fernetKey, email } | null */
  cloudAuth: 'ql:cloudAuth',
} as const;

// ★★ 2026-10-09 清理：这里原有两条**已废除功能**的键注释，而它们对应的实现早就删了 ——
//    ① `dataSource: 'local' | 'cloud'`（v3.18 废除，只剩云端）
//    ② 「不再提示：本地 → 云端切换确认」标志（v3.14.1，随数据源切换 UI 一起废除）
//    ⇒ 键本身**当时就已经不在这个对象里**（不是漏删），只有注释留着。
//    而注释比键更容易骗人：读的人会以为"有个切换确认功能，反悔通道在 `?` 气泡里"。
//    ★ 这正是 PITFALLS #19 那条（删功能要四处都删：TS / HTML / CSS / **说明文字**）——
//      这次漏的是**源码注释**里的说明文字，第四处的变体。

/** 常用页面书签的默认列表（v3.16：平台常用管理页；用户可在管理页改写） */
export const DEFAULT_FAVORITES: ReadonlyArray<{ name: string; path: string }> = [
  { name: '用户管理', path: '/admin/user-mgmt/users/list' },
  { name: '角色列表', path: '/admin/user-mgmt/role-mgmt/list' },
  { name: '工作流', path: '/admin/config/workflow' },
  { name: '菜单', path: '/admin/config/menu-mgmt?__edit=2' },
  { name: '视图', path: '/admin/config/view-management' },
  { name: 'TraceLog', path: '/admin/secret-page/trace-log' },
];

/** 常用页面书签上限（轮盘一环的上限；超出提示去管理页精简） */
export const FAVORITES_MAX = 10;

/**
 * 翻译链路的消息协议（v4.2.0 合并 Akso Instant Translate）。
 *
 * ★ 按本仓约定集中在这里定义，**不要在调用点就地写字符串字面量** ——
 *   那样"一边改了另一边没改"会静默失效（翻译会变成永远超时，而不是报错）。
 */
export const TRANSLATE_MESSAGE = {
  /** content → background：翻译一段文本（结果由 background 决定是否转 snake_case） */
  request: 'ql:translateRequest',
  /**
   * background → content：用户按了 `Alt+T`。
   * ★ `chrome.commands` 的 `onCommand` **只在 SW 里触发**（页面拿不到），
   *   所以快捷键链路必须是 SW 转一手 —— 这条消息就是那一手。
   */
  hotkey: 'ql:translateHotkey',
} as const;

/** 翻译命令的 `commands` 名（manifests 里注册，用户可在 chrome://extensions/shortcuts 改键） */
export const TRANSLATE_COMMAND = 'translate-input';

/** 翻译次数统计在 `storage.local` 里的键 */
export const TRANSLATION_STATS_KEY = 'ql:translateStats';

/**
 * 页面内翻译 UI 的元素 id。
 *
 * ★ 全部带 `ql_` 前缀（原扩展是 `akso_`）：合并后与 akso-pass 自己的注入元素
 *   （`akso_translate_*` 是原扩展的，而 akso-pass 用 `__ql_*` 命名空间）保持族内一致，
 *   同时**避免与原扩展的元素 id 撞车**——万一两个扩展同时装着，同 id 会互相覆盖。
 */
export const TRANSLATE_UI_ID = {
  icon: 'ql_translate_icon',
  toast: 'ql_translate_toast',
} as const;


/** background 向内容脚本下发的消息 type */
export const CONTENT_MESSAGE = {
  setTitle: 'sb:setTitle',
  autoLogin: 'sb:autoLogin',
  autoLoginRequest: 'sb:autoLoginRequest',
  /** 自动填表事件上报（v3.12.2 取证：填充/点击/让位/被拒逐事件入 forensics） */
  autoLoginEvent: 'sb:autoLoginEvent',
  /** ISOLATED 桥 → background（双向通路的上行） */
  bridgeUp: 'ql:bridgeUp',
  /** background → ISOLATED 桥（下行） */
  bridgeDown: 'ql:bridgeDown',
} as const;

/** window.postMessage 的 source 标识（桥 ↔ MAIN 壳内部通路） */
export const WINDOW_CHANNEL = {
  pageToBridge: 'QL_PAGE_TO_BRIDGE',
  bridgeToPage: 'QL_BRIDGE_TO_PAGE',
} as const;

/**
 * 需要按账号隔离、并在被写入时上报 background 的共享 localStorage 键。
 * 与目标站约定：__auth_token__ 为 JWT 持久化副本；后两项为身份与设备指纹展示键。
 */
export const SHIELD_WATCH_KEYS = ['__auth_token__', '__auth_user__', '__device_fp__'] as const;

/** 账号命名空间内保存「虚拟 Cookie 袋」（JSON 序列化的 document.cookie 视图）的键 */
export const SHIELD_COOKIE_BAG_KEY = '__ql_cookies__';

/**
 * 账号命名空间前缀。绑定标签页内，localStorage 全部键读写都会重定向到
 * `__ql_ns_<accountId>__<原键>`，实现同 origin 下多账号物理隔离。
 */
export function shieldNsPrefix(accountId: string): string {
  return `__ql_ns_${accountId}__`;
}

/** 新会话默认配色（蓝白主题内的强调色轮换） */
export const SESSION_COLORS = [
  '#1E6FFF',
  '#0FA3B1',
  '#7C5CFF',
  '#FF7A1A',
  '#22C55E',
] as const;
