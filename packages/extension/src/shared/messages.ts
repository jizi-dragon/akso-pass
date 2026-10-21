import type { LogRecord } from './log';
import type { CloudDeleteSiteResult, CloudSiteSummary, CloudUiState, ParallelAccount, ParallelAccountStatus, ParBox } from './types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** `par.state` 的账号还要带运行态与是否存了密码，与 `par.list` 的账号形状一致。 */
type UiStateAccount = ParallelAccount & ParallelAccountStatus & { password: boolean };
export type UiStatePayload = Omit<CloudUiState, 'accounts'> & { accounts: UiStateAccount[] };

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
  /**
   * 一次原子读取 accounts+sites+boxes（`GET /api/ui/state`）。
   * 页面只需要**一个**响应就能整页替换；旧服务端没有该端点时，UI 会回落到
   * 原来的 par.list / par.sites / par.boxes 三次读取。
   */
  | { kind: 'par.state' }
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
  /* ---- 站点的**自定义名称**（v4.2.1）----
   * "站点管理"此前只显示域名，而服务端 `site_public()` 早就带 `name`
   * （`site` 表有 `name` 列、`/api/sites` 有完整 CRUD）—— 缺口在**传输层**：
   * `renderSites(hosts: string[])` 只拿得到 host，名字在中途就被丢了。
   * ★ 与 `par.boxes` 同一约定：`result.data` 为 `null` 表示"没拿到"（离线），
   *   那时 UI **一个字都不动** —— 不要把"没拿到"显示成"名字是空的"。 */
  | { kind: 'par.sites' }
  /**
   * 添加站点时顺带把名称落库（v4.2.1）。
   *
   * ★ 这个 kind 同时承担"新建站点"与"给已存在的站点改个名"：
   *   站点不存在时先建（`POST /api/sites`），存在时 PATCH 名称。
   *   2026-10-19 起站点编辑走 `par.updateSite`（名称/地址/备注一起改），
   *   这个 kind 只留给站点表单的"新增"。
   * ★ `createBox`（2026-10-19）：新建站点时是否同步建一个同名盒子，缺省 true
   *   （保持旧行为）。站点已存在时这个字段没有意义。
   */
  | { kind: 'par.upsertSite'; host: string; name: string; createBox?: boolean }
  /**
   * ★ 2026-10-19：**编辑站点**（用户要求「站点管理缺少编辑功能」）。
   *
   * 与云端控制台 `PATCH /api/sites/{id}` 同一条端点、同一组字段
   * （名称 / 地址 / 备注）。`siteId` 是服务端主键 —— 扩展平时只认 host，
   * 而改地址会让 host 跟着变，所以必须按 id 定位。
   *
   * ★ 字段缺省 = 不改（与 `AccountPatch` 同一口径）。`baseUrl` 变了等于换 host：
   *   服务端会重新归一化并记住新协议，该站点下的账号仍按 `site_id` 关联。
   */
  | { kind: 'par.updateSite'; siteId: string; name?: string; baseUrl?: string; note?: string }
  /**
   * ★★ 2026-10-19：**账号轮盘的起始页**（用户要求：当前页所属站点有关联盒子时，
   * `Alt+Q` 应优先停到那个盒子）。
   *
   * `host` 由**小窗**传入（它自己的页签没有 sender 上下文）。页内浮层不传，
   * 由 background 从 `sender.tab` 取当前页 host —— 让调用方自报 host 等于把
   * "用户现在在哪个站点"交给页面决定，而浮层与目标页必须是同一个。
   *
   * 返回值：
   *   · `preferredBox` —— 要优先显示的盒子名。命中关联盒子时是它；没有关联盒子时
   *     是**云端默认盒名**（用户要求"则为默认盒子"）；离线拿不到云端数据时是空串，
   *     由轮盘用本机记住的默认盒兜底
   *   · `matched`      —— 是"该站点确实有关联盒子"，还是只是兜底
   *   · `host`         —— 归一后的站点 host（诊断用）
   */
  | { kind: 'par.wheelContext'; host?: string }
  /**
   * ★ v4.2.7：删**云端**站点的记录（用户要求"删除站点时云端也要删"）。
   *
   * ★ 服务端那条 `DELETE /api/sites/{id}` **会级联删掉该站点下的所有账号**，
   *   所以这个 kind 的返回值是**四态**（见 `CloudDeleteSiteResult`），其中
   *   `blocked` 就是服务端的 409：它把"会被一起删掉的账号"带回来，
   *   让调用方能把话说具体，而不是只报一个数字。
   *
   * ★★ v4.2.12：`force` 就是服务端那个查询参数。语义**必须**由调用方显式表达：
   *   · 不传 / `false` ⇒ "我不知道它会连带删账号，先让我看看"
   *   · `true`         ⇒ "我看过名单了，确认连账号一起删"
   *   服务端把"我要连账号一起删"做成一个**必须写出来的动作**（`sites.py` 的注释），
   *   这里照抄那个口径 —— 默认值绝不能让级联删除静默发生。
   */
  | { kind: 'par.deleteSite'; host: string; force?: boolean }
  | { kind: 'par.create'; siteHost: string; tabName: string; username: string; password: string; open: boolean; box?: string; scheme?: 'http' | 'https' }
  | { kind: 'par.probeScheme'; host: string }
  /**
   * ★★★ v4.2.12：**账号编辑**（用户要求"两端管理逻辑一致"，以云端为准）。
   *
   * 云端控制台的编辑弹窗能改六样：账号名 / 页签名 / **所属站点** / 盒子 / 密码 / 备注。
   * 而扩展这边此前**只能改页签名**（`Partial<Pick<ParallelAccount,'tabName'>>`）——
   * 也就是说"选错了站点"在扩展里只能删掉重建，而重建会丢掉密码与备注。
   *
   * ⇒ patch 的类型放宽成**服务端 `AccountPatch` 的那一组字段**（逐字段可选，
   *   `undefined` 一律表示"这一项不动"）。
   *
   * ★★ 三条不能搞错的语义（每一条在云端 `site.js` 的编辑弹窗里也都写着）：
   *   · `password` **缺省 = 不改**，**空串 = 清空**。合成一个会让"没填"变成"清空了密码"，
   *     而用户看不到任何提示、下次打开账号时填表会静默失效。
   *   · `siteId` 只在**真的换了站点**时才带上：无脑带上会让每次保存都去走一遍
   *     "挪站点"的校验（同一站点下不能有同名账号），而同站点下它不该触发任何站点逻辑。
   *   · `box` 传的是**盒名**，等于默认盒名时要翻成空串（服务端的存储形态）。
   */
  | {
      kind: 'par.update';
      id: string;
      patch: {
        username?: string;
        tabName?: string;
        siteId?: string;
        box?: string;
        password?: string;
        note?: string;
      };
    }
  | { kind: 'par.moveBox'; id: string; box: string }
  /**
   * ★★★ v4.2.12：**批量删除账号**（用户要求补齐"两端管理逻辑一致"）。
   *
   * 服务端早就有 `POST /api/accounts/batch-delete`（云端控制台的「删除所选」走的就是它），
   * 而扩展这边只有逐个删除。批量走**服务端那一条**而不是循环发 N 个 DELETE：
   *   · N 次网络往返 vs 1 次；
   *   · 服务端只在真的删掉行时才推 `revision`（循环发会让版本号推 N 次）；
   *   · 部分失败时服务端能给出准确的条数，而循环发只能报"第 3 个失败了"。
   */
  | { kind: 'par.batchDelete'; ids: string[] }
  | { kind: 'par.renameBox'; from: string; to: string }
  | { kind: 'par.deleteBox'; name: string }
  /**
   * ★★★ 2026-10-13：**新建盒子**。
   *
   * 这条 kind 此前**不存在** —— 而 UI 上的「＋ 新建盒子」只往本地 `ql:boxes` 里
   * `push` 一个名字（`ui/parallel/parallel.ts` 的 `createBox()`）。
   * 自 2026-10-12 起**云端名单是权威**（对账会剪掉本地多出来的名字）
   * ⇒ 那个盒子在下一次 `loadBoxes()` 就被剪掉：**建好了，然后自己消失**，
   * 而两边都不报错。判据见 `tools/verify/verify-boxsync.mjs` 的第 ⑤ 组。
   */
  | { kind: 'par.createBox'; name: string }
  /**
   * ★★★ 2026-10-13：**禁用 / 启用盒子**（服务端是权威）。
   *
   * 改前这个动作**纯本地**（只写 `ql:disabledBoxes`），云端 `box.disabled`
   * 从不读也不写 ⇒ 同一个事实两个来源：在网页上禁用的盒子，扩展轮盘照旧会切到它。
   */
  | { kind: 'par.toggleBox'; name: string }
  /**
   * ★★★ 2026-10-13：**盒子关联站点**（服务端 2026-10-13 新增的能力）。
   *
   * `siteId` 传空串 = 解除关联。默认盒不参与绑定（服务端 400）——
   * 调用方应当**先看 `bindable`**，别让用户点到一个一定失败的按钮。
   */
  | { kind: 'par.bindBoxSite'; name: string; siteId: string }
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
  /* ---- v4.2.1：弹窗的身份菜单 ----
   * `cloud.sync`  = 丢弃本机缓存、从云端重新拉一遍（账号/站点/盒子）。
   * `cloud.logout` = 退出登录：清令牌 + 清**本机缓存的账号数据**。
   * ★ 两者都**只动本机** —— 云端账号库一条记录都不改。用户是"退出登录"，
   *   不是"注销账号"，把这两件事混起来会毁掉别人的数据。 */
  | { kind: 'cloud.sync' }
  | { kind: 'cloud.logout' }
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
  /**
   * 在**新页签**打开某个书签（2026-10-20 用户明确要求：不要覆盖原页面）。
   * `baseOrigin` 为空时按当前活动页签的 origin 兜底。
   *
   * ★ 页内浮层正常情况下直接 `window.open`（新页签 + opener 继承账号）；
   *   这个 kind 是**弹窗被拦 / 浮层无法打开**时的兜底。
   */
  | { kind: 'favorites.open'; path: string; baseOrigin?: string }
  /**
   * ★ 2026-10-20：把一个"只有路径"的书签解析成平台菜单里的**完整地址**。
   *
   * 平台的管理页 URL 需要 `?bid=<业务对象 id>`（例如
   * `/admin/user-mgmt/users/list?bid=…`）。书签若只存了路径，直接打开会**没有数据**。
   * background 在来源页签的 MAIN world 用该账号的会话读平台菜单接口，
   * 找到 pathname 相同的菜单项并返回它带 query 的地址。
   *
   * 返回 `url: ''` = 没解析到（调用方用书签原地址兜底）。
   */
  | { kind: 'favorites.resolve'; path: string };

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
  | { kind: 'par.state'; result: Result<UiStatePayload> }
  /* `offline=true` ⇒ 用户此刻看到的列表**就是**只读副本（不是"可能旧"）。
   * `savedAt` / `ageMs` 让界面能说准"这是多久前的副本"，
   * 而不是含糊的"可能是旧的"（`account-cache.ts` 的设计意图）。 */
  | { kind: 'par.offline'; result: Result<{ offline: boolean; savedAt?: number; ageMs?: number; revision?: number }> }
  /**
   * ★★ 2026-10-13：载荷从"只有盒名"升级为**盒子对象数组**。
   *
   * 改前是 `{names: string[], default: string}` —— 只装得下名字，
   * 于是 `disabled` / `count` / `deletable` / `renameable` / `bindable` /
   * `siteId` / `siteName` 这些服务端**已经算好**的字段全在中途被丢掉
   * ⇒ UI 只能自己另造一套口径（本地 `ql:disabledBoxes`），两边迟早不一致。
   */
  | { kind: 'par.boxes'; result: Result<{ boxes: ParBox[]; default: string } | null> }
  /* `null` = 没拿到（离线）⇒ UI 保持原样，不要把"没拿到"渲染成"名字为空"。
   * ★ 2026-10-13 起多带一个 `id`：盒子的"关联站点"要拿它当 `siteId` 去绑定
   *   （服务端按 `siteId` 认站点，而 UI 平时只认 host）。加字段是兼容的。 */
  | { kind: 'par.sites'; result: Result<CloudSiteSummary[] | null> }
  | { kind: 'par.upsertSite'; result: Result<{ host: string; name: string; displayName: string }> }
  /** ★ 2026-10-19：编辑站点（返回更新后的整行，UI 不必自己拼）。 */
  | { kind: 'par.updateSite'; result: Result<CloudSiteSummary> }
  /** ★ 2026-10-19：`Alt+Q` 的起始盒子（见上行请求的说明）。 */
  | { kind: 'par.wheelContext'; result: Result<{ host: string; preferredBox: string; matched: boolean }> }
  /**
   * ★ v4.2.7 起是**多态**返回，v4.2.12 补上 `blocked`：
   *   · `deleted` —— 删掉了；`accountsDeleted` 是**服务端**报的级联账号数
   *   · `missing` —— 云端本来就没有这条站点记录
   *   · `offline` —— 连不上云端（**本机什么都没动**，如实说）
   *   · `blocked` —— 服务端 409：站点下还有账号，`usernames` 是**具体是哪些**
   */
  | { kind: 'par.deleteSite'; result: Result<CloudDeleteSiteResult> }
  | { kind: 'par.create'; result: Result<ParallelAccount> }
  | { kind: 'par.probeScheme'; result: Result<'http' | 'https'> }
  | { kind: 'par.update'; result: Result<ParallelAccount> }
  /** ★ v4.2.12：批量删除的回报是**删掉的条数**（服务端只对真的删掉的行推 revision） */
  | { kind: 'par.batchDelete'; result: Result<{ deleted: number }> }
  | { kind: 'par.moveBox'; result: Result<ParallelAccount> }
  | { kind: 'par.renameBox'; result: Result<{ moved: number }> }
  | { kind: 'par.deleteBox'; result: Result<{ moved: number }> }
  /** ★ 2026-10-13：新建盒子（打到云端，见上行那条 kind 的注释） */
  | { kind: 'par.createBox'; result: Result<{ name: string }> }
  /** ★ 2026-10-13：禁用/启用（服务端权威）。`disabled` 是**切换后**的状态 */
  | { kind: 'par.toggleBox'; result: Result<{ disabled: boolean }> }
  /** ★ 2026-10-13：关联/解除关联站点。`siteId` 是**生效后**的值（可能被服务端归一） */
  | { kind: 'par.bindBoxSite'; result: Result<{ siteId: string; changed: boolean }> }
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
  | { kind: 'cloud.sync'; result: Result<{ accounts: number; sites: number }> }
  | { kind: 'cloud.logout'; result: Result<{ cleared: string[] }> }
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
  | { kind: 'favorites.open'; result: Result<{ url: string }> }
  | { kind: 'favorites.resolve'; result: Result<{ url: string }> };

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
