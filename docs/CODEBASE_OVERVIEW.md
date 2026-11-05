# Codebase Overview

> **更名说明（2026-10-11）**：本项目 2026-10-11 由 `quick-login` 更名为 `akso-pass`（品牌名 `QuickLogin` → **Akso Pass**）。
> **历史条目中的旧名保留不动** —— 下文"文档漂移清单"里的旧名是**当时实测的原文**，改写它等于伪造那份审计记录。

_由 learn-codebase 流程生成 · 2026-10-07 · 锚定 commit `1e61985`（v3.13.2 / 2026-09-10）_

> ★★ **时效说明（2026-10-09 补）**：本文件锚定在 `1e61985`，而当前 HEAD 已在其后
> **20 个 commit、4 个中版本**（v3.13.2 → **v4.0.0**）。
>
> ⇒ **架构与设计判断仍然可读，但 `文件:行号` 引用不可当作精确定位**
> —— 全文有 **63 处** `xxx.ts:123` 形式的引用，而任何一次加删行都会让它们漂移。
>
> ★ **看行号之前先确认**：`git log --oneline 1e61985..HEAD` 里有没有动过那个文件。
> 真要精确定位，用**符号名**（函数名 / 类名 / 消息 kind）搜，别信行号。
>
> ★ 这不是"文档没维护" —— 文末的「文档漂移清单」说明它被**主动对账**过。
> 但"锚定式文档"（整篇写一个 commit 的快照）与"活文档"（跟着代码改）是**两种东西**，
> 混在一起读会让人误以为行号是最新的。
> ⇒ 本仓的分工：**`AGENTS.md` 是活文档（规则，改了就得同步）**，
> **`CODEBASE_OVERVIEW.md` 是快照（架构，允许滞后，但必须标注锚点）**。

> **对账说明**：上一版停留在 v3.7.2（commit `57358bf`，2026-08-29），其后已有 **33 个 commit、6 个中版本**。
> 本次按 v3.13.2 的代码实况全面重写：新增第七个隔离机制（平面 1.5 BroadcastChannel）、会话卫生与
> 写入者归属、登录态生命周期、配置页监视、盒子/批量/导入导出、诊断取证基建；
> 并订正上一版中已失效的条目（E2E 台架 `tools/e2e/harness.mjs` 与 `research/idb-permissions/`
> 已于 v3.9.2 随项目收束移除，见文末「文档漂移清单」）。

## Summary

Akso Pass 是一个**纯浏览器 Chrome/Edge MV3 扩展**，解决「在同一浏览器窗口内，
对内部低代码平台（`tonbridge-config.aksoegmp.com`，无状态 JWT Bearer 鉴权）并行在线多个账号」的问题。
每个账号一个独立标签页，通过**多平面隔离**（存储命名空间 / BroadcastChannel / AUTH 改头 /
Cookie 回放 / HTTP 缓存分区 / ServiceWorker·CacheStorage 封控 / IndexedDB 命名空间）切断同 origin
账号间的呈现层与网络层串扰；管理入口为并行管理主页，外加三块快捷轮盘：
账号轮盘（`Alt+Q`）、实例状态轮盘（`Alt+W`）与常用页面书签轮盘（`Alt+1`）。

> ★★ **账号存放（v3.18 起，2026-10-09）**：账号存在**云端账号库**（`akso-cloud`），
> **必须登录云端账号**才能使用；平台口令由**服务端**加密存放，**本机不落明文**。
> **本机只保留一份离线只读副本**（不含口令）—— 断网时可看、可开页签，
> **不可新增/编辑、自动填表失效**。
>
> ★ 这一行原文写的是「账号密码 AES-GCM 加密存于本机 IndexedDB」——
> **那是已废除的本地数据源**。它留在这里是"文档说的与代码做的不一致"最典型的一种：
> 句子本身完全通顺、技术上也说得通，**只是功能已经不在了**。
> 详见 [`AGENTS.md` §6](../AGENTS.md) 与 [`PITFALLS.md` #19](./PITFALLS.md)。
>
> ★ 同理，下文凡是提到 `credentials` / `cryptoSeed` / `cloud-migrate` /
> `navigation.ts` / `session-manager.ts` / `account-registry.ts` 的地方，
> 都已经**逐个标注了"v3.18 已删"** —— 保留它们是因为**已删除的东西也需要留痕**
> （否则下一个人会以为从来不存在）。读的时候以标注为准。

目标平台的登录态是**多份共享资源的叠加**（localStorage、Cookie jar、HTTP 缓存、IndexedDB、
ServiceWorker），同 origin 多账号天然互相污染。本项目逐层把它们改成按账号/按标签页分区。

**项目规模**：33 个源文件 / 8,585 物理行（其中 26 个 TS 文件 / 7,195 行）；最大单文件
`core/parallel-session.ts`（1,396 行）、`ui/parallel/parallel.ts`（1,291 行）、`content/shield-main.ts`（872 行）。

## Tech stack

- **语言**：TypeScript 5.6+（`strict`、`noUnusedLocals/Parameters`、`noFallthroughCasesInSwitch`），
  目标 ES2022；少量 Node ESM 脚本（`scripts/build.mjs`、`tools/e2e/probe-page.mjs`）
- **运行时**：Chrome / Edge MV3 扩展（`minimum_chrome_version: 110`）；
  Node 24 + npm 11（构建与工具链）
- **构建**：npm workspaces（`packages/*`）+ **esbuild 0.24**，`scripts/build.mjs` 单文件流水线，
  产物 `dist/`（`iife`、10 个入口，静态 html/css/图标直接复制）
- **测试 / 校验**：`tsc --noEmit`（类型）+ `npm run build`（打包）+ 浏览器装载实测。
  **无单元测试框架、无 lint、无 CI**（`.github/`、eslint/prettier 配置均不存在）
- **数据存储**：扩展侧 IndexedDB（`sessionbox-reborn` v2）；`chrome.storage.session`（绑定表、
  token 快照、页面名称表——随浏览器会话存活）；`chrome.storage.local`（配置、授权痕迹、
  诊断/取证环形缓冲、加密种子）；目标站点侧 IndexedDB/CacheStorage/localStorage（经壳按账号前缀化）
- **Skills applied**：learn-codebase（本次）；分析过程中另调用 4 个并行子代理分区深读

## Architecture

### 隔离平面总表（权威口径以代码为准）

| # | 平面 | 机制 | 实现位置 |
|---|---|---|---|
| 1 | 存储 | `Storage.prototype` 方法级补丁，localStorage 全部键重定向到 `__ql_ns_<accountId>__<原键>` | `content/shield-main.ts:449` |
| 1′ | Cookie 袋 | **实例级** `Object.defineProperty(document, 'cookie', …)`，虚拟化为命名空间内的 `__ql_cookies__` 字典（`Document.prototype` **未**被覆盖，见风险 A2） | `shield-main.ts:56-153` |
| **1.5** | **广播** | **`BroadcastChannel` 命名空间化（同源所有页签共享频道；`storage` 事件因键名前缀天然安全）** | **`shield-main.ts:640-668`** |
| 2 | AUTH | DNR session 规则按 `tabIds` 强制改写 `Authorization: Bearer <token>` | `background/core/tab-rules.ts:83-105` |
| 3 | COOKIE | 出站 `Cookie` 头按账号**回放**（登录时点快照 + `webRequest` 实时并入 + 页内袋回流）；无快照则 `remove` | `tab-rules.ts:111-135` + `core/parallel-session.ts:588-792` |
| 4 | CACHE | 同源 GET 查询串追加 `_qlck=t<tabId>`，把全 profile 共享的 HTTP 缓存按标签硬分区 | `shield-main.ts:307-330` |
| 5 | SW/Cache | 拦截 `navigator.serviceWorker.register` + 注销既有注册；`CacheStorage` 按账号命名空间键控、`match` 一律 miss | `shield-main.ts:548-636` |
| 6 | IDB | `indexedDB.open/deleteDatabase/databases()` 按账号前缀化（平台把 `isAdmin` + 菜单树缓存在 origin 级共享 IDB，是历史「四象限串号」的直接载体） | `shield-main.ts:637-724` |
| — | 会话卫生 | 真实 jar 不驻留扩展账号会话：登录前基线 `preJar` + 差集清扫 + `onChanged` 持续驱逐，**全部按写入者归属门控**（原生页签写入不动） | `parallel-session.ts:357-577` |

> README 与 PROJECT-STATUS 的「六平面」表未收录平面 1.5 与会话卫生，且 PROJECT-STATUS 小标题写作「四平面」，
> 与表内 6 行自相矛盾——以本节为准。

### 组件图

```
┌─ MV3 扩展 ──────────────────────────────────────────────────────────────────┐
│ background/service-worker.ts（唯一 SW 入口，548 行）                          │
│   onMessage 前置分流（type 型） → dispatch 穷尽 switch（kind 型）              │
│   ├─ core/parallel-session.ts  1,396 行·运行时编排主体                        │
│   │    绑定表 tabId↔accountId · token 双通道捕获 · JWT 身份护栏                │
│   │    Cookie 登录快照/动态并入/写入者归属清扫 · 种子下发 · 授权健康门控        │
│   ├─ core/tab-rules.ts         DNR session 规则（AUTH 100000+ / COOKIE 200000+）│
│   │                            **逐条安装 + 单条失败降级**                     │
│   ├─ core/favorites.ts         常用页面书签（v3.16，Alt+1 轮盘的数据源）        │
│   ├─ core/parallel-store.ts    IDB accounts CRUD                              │
│   ├─ core/account-cache.ts    云端快照的只读缓存（v3.18，**不含口令**）        │
│   ├─ core/auto-login-cache.ts 待登录凭据的临时缓存（storage.session，60s）      │
│   ├─ core/offline.ts          OfflineError：区分『网络不通』与『服务端出错』   │
│   ├─ core/site-auth.ts         授权清单/scheme 探测（**仅 list/probeScheme 活**)│
│   └─ （v3.18 已删：navigation / session-manager / account-registry、       │
│        credentials、cloud-migrate —— 见 AGENTS.md §6「本地数据源已废除」）            │
│              dispatch 分支仍在但**零发送方**）                                  │
│ content/                                                                     │
│   ├─ shield-main.ts  MAIN world 壳（872 行，上表 7 项职责 + 网络嗅探 + 页面命名）│
│   ├─ shield-bridge.ts ISOLATED 桥：window.postMessage ↔ chrome.runtime         │
│   ├─ auto-login.ts   登录表单自动填表（五重门控 + 逐事件取证）                  │
│   ├─ title-hook.ts   MutationObserver 维持标题（配合 executeScript 权威写）     │
│   ├─ wheel-overlay.ts 页面内 Shadow DOM 轮盘（按需 executeScript 注入）        │
│   ├─ status-overlay.ts  实例状态轮盘浮层（v3.15，Alt+W；按需注入）              │
│   └─ favorites-overlay.ts 常用页面书签轮盘浮层（v3.16，Alt+1；按需注入）        │
│ ui/  parallel/（管理主页 1,291 行）· wheel/（独立小窗 + 共用 wheel-core 视觉契约）│
│      · popup/（启动器）                                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Key modules

| Path | Responsibility |
| --- | --- |
| `packages/extension/src/background/service-worker.ts` | 唯一 SW 入口：`onMessage` 分流（`ql:bridgeUp`/`sb:autoLogin*` 前置）→ `dispatch` 穷尽 switch；快捷键轮盘三级降级（页内浮层 → 独立小窗 → 标签页）；角标诊断；`webNavigation.onErrorOccurred` 协议自学习；装载三个注册器 + `void parallelSession.restore()` |
| `.../background/core/parallel-session.ts` | 运行时编排主体（见组件图）。绑定/快照/规则三者的唯一事实源；`restore()` 冷启自举 |
| `.../background/core/tab-rules.ts` | 每个绑定标签页至多 2 条 DNR session 规则；id 分区、逐条安装、差集恢复、孤儿清理 |
| `.../background/core/favorites.ts` | 常用页面书签：读写 `ql:favorites`、缺省回落内置默认、相对路径按基准 origin 解析成 URL |
| `.../background/core/account-cache.ts` | 云端快照的**只读**缓存（IDB `accounts` 仓）。`CachedAccount = Omit<ParallelAccount,'credentials'>` ⇒ **类型层面保证不含口令**。写缓存先写账号再写元数据（元数据的 `count` 是『写完了』的标记） |
| `.../content/shield-main.ts` | MAIN world 壳：上表 1/1′/1.5/4/5/6 平面 + 种子直灌 + 写入上报 + fetch/XHR 嗅探 + 页面命名；激活门控见「数据与控制流」（其中两处实现已失效，见风险 C14/C15） |
| `.../content/shield-bridge.ts` | 49 行双向中继；**SW 不可达时合成 `unbound`**（fail-open，见风险 A6） |
| `.../content/auto-login.ts` | 自动填表：React 受控组件原生 setter + input/change、提交前回读、MutationObserver 即时填充、用户接管让位、失败感知；全流程逐事件入 `ql:forensics`（密码绝不入日志） |
| `.../ui/parallel/parallel.ts` | 管理主页：账号 CRUD、盒子（重命名/启停/删除/移入）、批量模式、文本批量导入、站点授权管理、备份导入导出、诊断包导出、3s 轮询 |
| `.../ui/wheel/wheel-core.ts` | 轮盘视觉契约（SVG 环形几何）被小窗与页内浮层共用 |

## Data & control flow

**1. 打开账号（`par.open`）**
`ui/parallel/parallel.ts:917` → `service-worker.ts:228` → `parallelSession.open()`(819) →
`parallelStore.get()` → `boundTabsOf` + `tabStillAlive` 复用既有绑定页签 →
`capturePreJar()`(393，登录前 jar 基线) → 无活页签则**废弃残留登录态**（v3.12.0 生命周期语义）→
`chrome.tabs.create(scheme://host + '/login' 或 '/')` → 写绑定表并 `persistBindings()` →
解密凭证并 `setPendingAutoLogin`（失败仅记 diag，不阻断网络平面）→ `pushBind()`（种子 =
token/身份/指纹 + tabId + 袋权威视图）→ `applyTitle()` → `syncAccountRules()`。

**2. 登录后捕获链（三通道并行）**
① 主通道：站点写 `localStorage.__auth_token__` → 壳 setItem 补丁上报 → 桥 → `handleBridge`(987) →
`captureToken`(194)：JWT 形态校验 → 去重 → `jwtStableIdentity` 异账号护栏 → 持久化 →
**首捕触发登录时点 Cookie 全量快照**（`chrome.cookies`，过滤 `IDENTITY_COOKIE_BLACKLIST`）并重建 COOKIE 规则。
② 出站 `Authorization` 头嗅探（`authHeader`）。③ 响应 `Set-Cookie`（`webRequest.onHeadersReceived` →
写入者归属追踪 → `mergeCookieSnapshot` 实时并入回放）。页内 `document.cookie` 写入则经「袋回流」并入。
**身份叛逃处置**：绑定页签内登录了别的账号 → `journalRollback` 回滚命名空间写入 → `nsWipeShared` → 解绑 → 转原始页签。
（注意：`nsWipeShared` 当前是**失效实现**，见风险 C14。）

**3. DNR 规则安装与降级**
`syncAccountRules()`(795) → 授权健康门控 `isEnforceable()`（本地停用名单 → `permissions.contains` 实查）→
`cookieHeaderOf()` 组装回放值 → 对每个绑定页签 `tabRules.applyBinding()`：
COOKIE 规则首次或值变时重建；AUTH 规则 token 变化时换新 id（同为 `null` 则摘除）。
**逐条安装**：`addOne()` 失败只写诊断并返回 false，不连坐其余规则——这是 v3.5 从
「原子批量 + 无效 `redirect.urlTransform` 导致网络平面全灭」中得到的教训。

**4. SW 冷启恢复**
模块求值 → 注册三个监听器 → `void parallelSession.restore()`（**未 await**，见风险 R2）→
`readState()` 从 `ql:parTabBindings`/`ql:parTokens` 重建内存表 → 逐绑定过授权门控 →
`tabRules.restore()`：`getSessionRules()` → 孤儿清理（id≥100000 且 `tabIds` 全不在期望集）→
重算两个 id 计数器 → 逐页签重装 → `cleanupStaleBindings()` 清死页签。

**5. 页面侧激活握手**
`shield-main.ts` 于 `document_start` 立即 `postMessage(hello)` 并每 120ms 重试 6 次（共约 840ms）。
收到 `bind` 时：`readyState === 'loading'` → 直接 `activate()`（装全部补丁 + 袋权威同步 + 种子直灌）；
否则经 `sessionStorage.__ql_boot_guard` 守卫 **reload 一次**再激活。
收到 `hold`（亲子继承候选）保持等待、不置 `settled`；收到 `unbound` 则永久直通。

## Entry points

- **扩展清单**：`packages/extension/manifest.json` — MV3；`background.js`；
  `permissions: tabs, scripting, cookies, storage, webRequest, declarativeNetRequestWithHostAccess, webNavigation`；
  `host_permissions: []` + `optional_host_permissions: ["*://*/*"]`（按站点动态授权）；
  4 个静态 content script（`shield-bridge` ISOLATED / `shield-main` MAIN，均 `document_start` `all_frames`；
  `title-hook` / `auto-login` 于 `document_idle`）；**3 个 command**（`quick-wheel`=Alt+Q、`quick-status`=Alt+W、`quick-favorites`=Alt+1）。
- **注意**：`content/wheel-overlay.js`、`content/status-overlay.js` 与 `content/favorites-overlay.js` **不在 manifest 中**，
  由 SW 在快捷键触发时 `chrome.scripting.executeScript` 按需注入（`service-worker.ts:431`、`:504`）。
- **后台入口**：`src/background/service-worker.ts`（`restore()` 冷启自举）。
- **界面入口**：`ui/popup/popup.html`（`action.default_popup`）、`ui/parallel/parallel.html`、
  `ui/wheel/wheel.html`（独立小窗）。
- **构建入口**：`scripts/build.mjs`（10 个 esbuild 入口 → `dist/`）。

## Build, run, and test

```bash
npm install            # 无原生依赖；首次
npm run typecheck      # tsc --noEmit（已实测通过，exit 0）
npm run build          # esbuild → dist/（已实测通过，10 个入口）
npm run watch          # esbuild context watch
node tools/e2e/probe-page.mjs   # 页面结构探针（见下方「工具链缺口」）
```

装载：`chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `dist/`。
**更新代码后必须在扩展卡片点「重新加载」**——Chrome 会缓存扩展 SW 脚本，
顽固时删档案 `Default/Service Worker/` 后重开（CHANGELOG 与用户手册反复强调的现场教训）。

**不存在**：`npm test`、lint、CI。回归完全依赖浏览器人工实测 + 用户在管理页导出的诊断包。

## Conventions

- **版本号三处必须一致**：根 `package.json`、`packages/extension/manifest.json`、
  `src/shared/constants.ts` 的 `EXT_VERSION`（当前均为 `3.13.2`，已核对一致）。
- **消息协议集中定义**：`shared/messages.ts`（`RuntimeRequest`/`RuntimeResponse` 判别联合）、
  `shared/constants.ts`（`CONTENT_MESSAGE`/`WINDOW_CHANNEL`/存储键）。
  响应统一 `{ kind, result: { ok:true, data } | { ok:false, error } }`。
- **存储键前缀**：`sb:` 为 v2.1 遗留（`sb:siteGrants`、`sb:tabBindings`），
  `ql:` 为现行；IDB 名仍是遗留的 `sessionbox-reborn`。
  ★ `sb:encryptionSeed` 与本地凭据加密已在 v3.18 废除（见 AGENTS.md §6），该键**不再被写入**；
  老库里可能仍有残留值，它现在**没有任何读取方**，留着无害但也不再有意义。
- **DNR 规则**：显式写全 `resourceTypes`；session 规则 id 按平面对半分段（AUTH 1xxxxx / COOKIE 2xxxxx）；
  **逐条安装 + 单条失败降级**；`requestDomains` 含父域且剥离端口；`tabIds` 限死作用域。
- **诊断埋点**：SW 侧统一写 `chrome.storage.local['ql:diag']`（人读，环形 60 条）与
  `ql:forensics`（结构化，环形 120 条）；**日志中不出现密码/用户名/token 原值**（只记「有/无」与字节数）。
- **错误处理**：后台统一 `{ok, data|error}`；UI 侧 `send()` 为 Promise 包装；
  后台向内容脚本推送为「尽力而为 + 事件重推」。
- **注释即文档**：本项目把根因分析写进代码注释（如 `tab-rules.ts:8-15` 记录 urlTransform 事故），
  修改前建议先读目标文件头部注释。

## Risks & rough edges

> 标注【验】= 本次静态核对代码/产物确认；【推】= 由代码语义推断，需运行确认。
> 下列条目按「影响面」而非发现顺序排列。

### A. 安全与隔离面

1. **备份文件等价于明文凭证**【验】。`data.export` 把 PBKDF2 主种子
   `cryptoSeed: await credentials.getKeySeed()`（`service-worker.ts:249`）与 AES-GCM 密文写进**同一个 JSON**；
   `data.import` 正是用该种子解密（`:275`）。任何拿到 `quicklogin-backup-*.json` 的人可离线解出全部账号密码。
   UI 文案只称「备份文件」，无「含密钥」提示。建议：导出改为口令派生密钥（用户输入 passphrase），或至少显著告警。
2. **Cookie 袋是实例级覆盖，可被一行代码绕过**【验】。补丁打在 `document` 实例上
   （`shield-main.ts:121`）而非 `Document.prototype`；页内脚本用
   `Object.getOwnPropertyDescriptor(Document.prototype, 'cookie').get.call(document)`
   即可直读**真实 jar**。另一处 fail-open：若原型 descriptor 不可配置，`installCookieVirtualization()` 直接
   `return`（`:118-120`）——整个 Cookie 袋平面静默缺席，无任何诊断埋点。
   （写侧还会丢弃 `path/domain/expires`，见 `:130-131` 注释，属已知取舍。）
3. ~~**静态加密实为混淆级**~~【**v3.18 已消除**】。这条曾指出：密钥种子与密文同存
   `chrome.storage.local`，无硬件绑定、无用户口令，salt 固定 ⇒ 防不住『扩展数据目录被整份
   拿走』。**处理方式不是加强它，而是删掉它** —— 本地凭据存储整体废除，口令只存在于
   云端（服务端 Fernet，密钥不在客户端）。见 AGENTS.md §6。
   它能挡住直接读 IndexedDB 的旁观者，挡不住能读扩展存储的人。
4. **AUTH/COOKIE 规则只覆盖 10/15 种资源类型**【验+推】。`ALL_MATCH_TYPES`（`tab-rules.ts:49-60`）注释自称
   「全资源类型」，实际硬编码 10 项；Chrome DNR 另有 `object`/`ping`/`csp_report`/`webtransport`/`webbundle`。
   未覆盖者既**拿不到 Bearer**（功能缺口），也**不会被 COOKIE 规则改写**——`<object>` 内嵌与
   `navigator.sendBeacon` 会带着真实 jar 的 Cookie 出站，是残留串号通道。
5. **`parentDomainOf` 不是 PSL 感知的**【验】。`parts.slice(-2).join('.')`（`:74`）对 `a.b.co.uk`
   产出 `co.uk`，写进 `requestDomains` 即覆盖整个 `*.co.uk`（虽受 `tabIds` 限制，
   但会把该账号 Cookie 回放到无关站点）。仅对用户配置的站点 host 调用，故实际暴露面有限。
6. **桥的失败即降级为「不隔离」**【验】。`shield-bridge.ts:27-30`：`sendMessage` 抛错（SW 未唤醒、
   扩展刚重载等）时合成 `{op:'unbound'}`，壳随即 `settled = true` 永久直通（`shield-main.ts:846-847`）——
   一个瞬时消息失败会让该页签**整条生命周期**失去全部隔离平面，且无任何 UI 提示。
   同理，迟到的 `bind` 被设计性忽略（`:805-807`，防止把账号身份灌进裸层）——判定错误的代价是双向的。
7. **`about:srcdoc` / `about:blank` 子文档是零补丁盲区**【验+推】。`<all_urls>` 不匹配它们，manifest 也未开
   `match_about_blank`（`manifest.json:43-69`）→ 这些 realm 的 `document.cookie`（**真实 jar**）、localStorage、
   IDB、CacheStorage、fetch/XHR 全部无补丁。而目标站登录页恰恰把**密码框放在同源 srcdoc iframe 内**
   （`auto-login.ts:5-7`），该 iframe 的 DOM 只能靠顶层跨 realm 直填。
8. **明文账密对页签内任意 frame 可见 60 秒**【验】。`sb:autoLoginRequest` 只按 `sender.tab?.id` 处理、
   **不校验 `sender.frameId`**（`service-worker.ts:352-365`），`getPendingAutoLogin` 读后即不删除
   （`navigation.ts:67-79`）→ 绑定页签内每一个注入了内容脚本的 frame（含第三方 iframe）
   在 60s 内都能取到明文账密，`runIframeFlow` 还会把密码填进该 frame 自己的密码框（`auto-login.ts:310-321`）。
9. **MAIN↔桥协议无 nonce/来源校验**【验】。两端只检查 `event.source === window` 与 `src` 字符串
   （`shield-main.ts:827-837`、`shield-bridge.ts:33-42`）→ 同页任意脚本都可伪造
   `storageWrite('__auth_token__', …)` 污染 token 快照，或诱发 `defectTabToRaw`（解绑 + 重载）打乱状态；
   也能监听 `message` 读到 `bind` 载荷里的 seed token（同账号页内本已可见，故非提权，但可被用来干扰）。
10. **诊断/取证包含准敏感信息**【验+推】。账号用户名/密码**不入包**（已脱敏），
    但 `tabName`、`siteHost`、`boxes` 以及 forensics 中的 `url` 会被导出——转发前需留意。
11. `<all_urls>` + `all_frames` + MAIN world 的壳注入到**每一个**页面（`manifest.json:43-69`），
    靠 `unbound` 快速直通；未绑定页面的开销仅为一次消息往返，但攻击面与 CWS 审核问询点值得知悉。

### B. 并发与时序

9. **`applyBinding` 读写竞态 → 规则泄漏且跨 SW 重启存活**【验】。`const meta = installed.get(tabId)`（`:158`）
   在 `await addOne()` **之前**读、`:201` 才写回；`open` 与 `captureToken`/`mergeCookieSnapshot`
   可并发进入同一 tab → 同一 tab 出现两条同 priority 的 Cookie 规则，被覆盖的 ruleId 永不被移除，
   且其 `tabIds` 在期望集内故 `restore()` 的孤儿清理也不会碰它。Chrome 对同级 `modifyHeaders` 的生效顺序未定义。
10. **冷启竞态**【验】。`void parallelSession.restore()`（`service-worker.ts:1293`）未 await，
    而 `readState()` 先 `bindings.clear()`（`parallel-session.ts:132`）。此窗口内到达的 `par.open`
    会复用失败而**新开第二个绑定页签**，`statusOf` 也会误报无 token。
11. **`open()` 恒返回 `reused: false`**【验】。`parallel-session.ts:899` 写死，而 `:833` 已算出正确值。
    当前 UI 不消费该字段，属潜伏缺陷（一旦用上就会误判）。

### C. 稳健性与正确性

12. **SW 里调用 `window.setTimeout`**【验】。`service-worker.ts:519` 位于 `try` 内、`catch` 紧随（`:522`），
    ServiceWorkerGlobalScope 无 `window` → ReferenceError 被静默吞掉 → **角标文本永不自清**。
    已在构建产物 `dist/background.js:2588` 中确认该调用原样保留；
    `tsconfig.json` 引入 `"DOM"` lib 使类型检查放行。（另两处 `window.` 分别位于页面注入函数与注释，无碍。）
13. ~~**名称型 API 每次出网两次**~~【已随 v3.17 移除】。`shield-main.ts` 的名称嗅探曾对命中
    白名单的 GET 两次调用 `nativeFetch`（第一次仅为挂 `clone()` 读取后丢弃）。
    v3.17 移除配置页监听时该嗅探一并删除，**问题不复存在**——此条留档以示来龙去脉。
14. **叛逃清扫是死代码**【验】。`nsWipeShared()`（`shield-main.ts:214-243`）读取的是**已被补丁**的
    `indexedDB.databases()` 与 `caches.keys()`——这两个补丁已经把 ns 前缀**剥掉**（`:707-715`、`:616-620`），
    而清扫逻辑仍以 `name.startsWith(ns)` 过滤 → 恒为 false。即 `journalRollback` + `nsWipeShared` 组合中
    **IDB 与 CacheStorage 从未被真正清理**（调用点 `parallel-session.ts:334-335`），
    叛逃页签写入的共享缓存会残留到下次使用。
15. ~~**XHR 名称嗅探是死路径**~~【已随 v3.17 移除】。该路径随名称嗅探一并删除；此条留档。
16. **`wheel-overlay` 的关闭路径泄漏监听器与定时器**【验】。`closeExisting()`（`:22-31`）写
    `dataset.forceClose` 并派发 `ql-wheel-close` 事件，但**全仓库没有任何监听者**
    （`wheel-core.ts:293` 只守卫 `qlWheelNav`）→ 旧实例的 `document` capture `keydown`（`:276`）与
    3s 轮询（`:182`）永久驻留：「关闭后」按数字键仍会切换账号，第三次按 `Alt+Q` 会叠出第二个浮层。
    （数字键已于 v4.2.43 移除，本条只剩监听器泄漏这一历史结论。）
    （UI 侧同源问题：`wheel-overlay` 的第二个 interval 在 close 时也未清理。）
17. **半激活状态不可恢复**【验】。`activate()` 中 `installStoragePatch()`（`:744`）**没有** try/catch，
    而同函数内的 SW/BC/IDB 三个平面各自都有（`:632`、`:666`、`:720`）→ 一旦原型被冻结等场景抛错，
    `mode` 已是 `'active'`、`settled` 已为 `true`（`:809`），种子未灌、平面缺装且**永不重试**。
    同理 `handleBind` 的 `sessionStorage` 守卫（`:817-822`）在 storage 不可用时会抛出并打断整个监听器。
18. **监听器/观察器不回收**【验】。`auto-login.ts` 的 MutationObserver 与 window `input`/`click` 监听在
    `stop()` 后从不 `disconnect`/`removeEventListener`（`:119-128`、`:304-306`），停止后每次 DOM 变更
    仍会调度一次 100ms `attempt()`（靠早期 return 兜底）；`title-hook.ts:13-17` 对 `documentElement`
    做 subtree+characterData 全量观察且无节流，且因 `all_frames: true`，**每个子 frame 都会写自己的 `<title>`**。
19. **UI 通信层零防御**【验】。`ui/send.ts:3-7` 既不检查 `chrome.runtime.lastError` 也不设超时；
    无接收端时回调收到 `undefined` → `res.kind` 抛 TypeError，`refreshAll` 中断、页面停在半旧状态
    （`parallel.ts:95/918/948` 不安全；popup 与轮盘用 `res?.` 侥幸安全）。
20. **3 秒轮询的写放大**【验】。管理页每轮 `refreshAll` 无条件执行
    `chrome.storage.local.set({ ql:blockedHosts })`（`parallel.ts:1008`）——稳态每 3 秒一次磁盘写；
    外加每个停用 host 一次 `permissions.contains` 往返、全表 IDB 读与 4 次 storage 读。
21. **诊断/取证环形缓冲偏小且实现重复**【验】。`ql:diag` 60 条、`ql:forensics` 120 条，
    而一次登录流程（open + 规则同步 + 捕获 + 快照合并）即可写掉 20–40 条——用户点「导出诊断」时
    往往已经丢失因果链头部。两处 `diag()` 实现完全重复（`parallel-session.ts:51-60` ≡ `tab-rules.ts:35-44`），
    且都是读-改-写，并发会丢更新。
22. **IDB 连接泄漏**【验】。`db.ts:4-32` 每次 `tx()` 都 `openDb()` 且从不 `close()`。
23. **scheme 自学习过激**【验】。`ERR_CONNECTION_REFUSED/RESET/EMPTY_RESPONSE` 一律当作协议错误
    永久写回账号档案（`parallel-session.ts:1350-1355`），瞬时网络抖动即可能翻转内网站点协议；
    15s 冷却只在内存中。
24. **授权缓存 staleness**【验】。`enforcement` 缓存只由 `par.grantChanged` 清空（`:118-120`），
    用户在 `chrome://extensions` 手动改权限后不会失效。
25. **导入丢 `scheme`**【验】。`data.import` 重建账号时不传 `scheme`（`service-worker.ts:301-307`），
    内网 http 站点导入后退化为 https，只能靠打开失败自学习兜底。
26. **`data.export` 的 `sites` 通常为空**【验】。写 `sb:siteGrants` 的唯一生产路径是
    `siteAuth.grant()`，而 `registerAuthHandlers()`（`site-auth.ts:132`）**全仓库无调用点**；
    管理页「添加并授权」只申请浏览器权限、不写该键。故导出→导入不会恢复站点授权。
27. **账号轮盘的空格键误选与浮层监听器泄漏**【验】。`wheel.ts:113` `Number(e.key) === 0 ? 9 : …`
    对空格成立（`Number(' ') === 0`）→ 轮盘窗口里按空格会直接选中第 10 个账号并关窗。
    `wheel-overlay.ts` 关闭时派发 `ql-wheel-close` 但全仓库无监听者 → 旧实例的 keydown 与轮询驻留。
    （**数字键已随 v4.2.43 整体移除**（空格误选随之消失）；旧实例清理仍按 `window.__QL_*_CLEANUP__` 由新实例调用。
    账号轮盘本身的监听器泄漏**尚未修**——属既有代码，未在本次改动范围内。）
28. **UI 无障碍缺口**【验】。盒子 chips 的 ✎/⏸/✕ 为 `<span>` + click，不可聚焦；
    盒子弹窗无 `aria-modal`/焦点管理；`wheel-core.ts:216` 的 `hub-go` 有 `role="button"`+`tabindex` 却只绑 click，
    键盘按 Enter/Space 无效；全页 29 处阻塞式 `prompt/confirm/alert`。
29. **大量空 catch**【验】。`shield-main.ts` 有 13 处、`auto-login.ts` 2 处空 `catch`
    （`shield-main.ts:66/79/181/199/240/302/327/388/398/442/633/667/721`、`auto-login.ts:24-26/178`）
    ——失败无痕，只能事后靠 forensics 取证。

### D. 工程化与技术债

30. **零自动化测试、零 CI、零 lint**【验】。回归完全依赖人工浏览器实测。
31. ~~**v2「会话轮盘」路径仍在且仍被接线**~~【**v3.18 已消除**】。`session.*` 六个 kind 的
    dispatch 分支、`registerNavigationHandlers`、`session-manager.ts`、`db.sessions`、
    `account-registry.ts` **全部删除** —— 实测 `parallel-session.ts` 从不 import 它们，
    旧模型只服务那 6 个 UI 从不发送的消息。见 AGENTS.md §6。
32. **常量双份维护**【验】。`constants.ts` 的 `SHIELD_WATCH_KEYS`/`SHIELD_COOKIE_BAG_KEY`/`shieldNsPrefix`
    **无任何 import**；`shield-main.ts:28-34` 自行硬编码同名字面量，`parallel-session.ts:47` 再写一份，
    靠注释人肉保持一致。
33. **多处重复实现**【验】：`diag()` 两份；轮盘分页装配在 `wheel.ts:41-67` 与 `wheel-overlay.ts:41-67` 逐行重复；
    轮盘 CSS 在 `wheel.css` 与 `wheel-overlay.ts:79-168` 双份；`wheel-core.ts` 被打进两个 bundle；
    host 解析正则重复于 `popup.ts:41` 与 `parallel.ts:973`；标题双写（`tab-title.ts` 的 MAIN 注入 +
    `parallel-session.ts:166-170` 的消息通道）。
34. **死代码**：`send.ts:9-11 okOf()`、`messages.ts` 的 `wheel.toggle`、`site.grants.*` 分支（后台恒 `[]`/恒失败）、
    `service-worker.ts:330-334` 的占位分支、`types.ts:74` 的 `journalRollbackDone`（上行但无处理分支）、
    `updateCredentials`（**v3.18 已删**：实测无调用点，且它的签名原本要求传入本地 AES-GCM 密文、云端实现再解密——本地加密废除后这条中转已无意义）、`shield-main` 发送的 `hello.url`（后台从不读取），
    以及上文 C14/C15 两处失效实现。
35. **硬编码**：`'tonbridge-config.aksoegmp.com'`（`service-worker.ts:150`、`parallel.ts:51`）、
    `'/login'` 路径与 `path.includes('login')` 子串判定、IDB 名 `sessionbox-reborn`、固定 salt。
36. **大文件**：`parallel-session.ts` 1,396 行与 `parallel.ts` 1,291 行各自承担 5–6 个职责域，
    仅靠 `/* ==== */` 注释分区。
37. **工具链缺口**【验】：唯一在库的取证工具 `tools/e2e/probe-page.mjs` `import { chromium } from 'playwright-core'`，
    但根 `package.json` **未声明** playwright-core，`package-lock.json` 中也没有——当前能跑只是因为
    `node_modules` 里残留着 5 个 extraneous 包（`playwright-core`、`devtools-protocol`、
    `@types/better-sqlite3`、`@types/chrome-remote-interface`，以及指向已删引擎包的 `@quicklogin/engine` junction）。
    全新 clone 后该工具必挂。`npm prune` / 重装依赖即可复现此缺口。
    另：三份文档仍在教 `npm run e2e`，而根 `package.json` **没有** `e2e` 脚本（原台架已于 v3.9.2 删除）。
38. **`package-lock.json` 版本字段陈旧**【验】。被追踪的 lock 文件 `version` 仍是 **3.9.2**，
    与 `package.json`（3.13.2）不一致（依赖内容本身仍正确）。
39. **取证证据链已断**【验】。CHANGELOG 多处引用的 `tmp/verify-*.mjs`（v310 / impgrant / jarhygiene / defect /
    autologin / dynsnap / fillrhythm / httpscheme / adopt）**全库搜索为 0** ——「10/10 全绿」的复现脚本已不可得。
40. **敏感残留（本机，均 gitignored）**【验】。`tmp/`（50 MB）里有 **2 份真实诊断包**
    `quicklogin-diag-2026-09-09T*.json`（含真实账号别名、内网 `10.100.0.105`、tabIds）；
    `probe/probe3/4/5/6/7/8.js` **硬编码明文口令**（`lyl/888888`、`T0601/888888`）；
    `packages/engine/dist/engine.cjs` 是已删引擎包的漏网残留。分享/归档工作目录前应清理。
41. **仓库卫生**：`.gitignore` 是**唯一非 UTF-8** 的受版本控制文件（GBK 编码的注释），
    且仍在忽略已删除的 `packages/engine/{dist,data,profiles}`（死规则）；
    其 zip 忽略模式 `quicklogin-chrome-*.zip` 与文档所述产物名 `QuickLogin-v*.zip` 也不一致。
    磁盘上另存 `probe/`（8 个本地探针，整目录未入库）、`tmp/`（E2E 档案）——均为 v3.9.2 收束后的遗物。
42. **无崩溃可观测性**：除 `ql:diag`/`ql:forensics` 环形缓冲外，没有遥测或错误上报；
    用户必须主动导出诊断包，开发者才能看到现场。

## 文档漂移清单

本次分析逐条核对了五份文档与实际代码（**代码为准**）。`CODEBASE_OVERVIEW.md` 已由本文替换；
其余四份的待修条目如下（按价值排序）：

| 文档 | 声称 | 实际（v3.13.2） |
| --- | --- | --- |
| `docs/PROJECT-STATUS.md:32` | 「**`main_frame` 导航刻意不改写**（保护静态资源与 SSO 跳转语义）」 | **已被 v3.13.1/v3.13.2 明确推翻**——AUTH 规则现覆盖含 `main_frame` 在内的 10 种资源类型。这是全文最危险的一条：它把「刻意设计」写在了已废弃的行为上 |
| `docs/PROJECT-STATUS.md:1,14` | 标题「现状快照 2026-08-29 · **v3.9.2**」；§二 小标题写「**四平面**隔离」而表内 6 行 | 当前 v3.13.2；平面实为 7 项 + 会话卫生 |
| `docs/PROJECT-STATUS.md:34-53` | 里程碑止于 **v3.7.2**（+E2E 行） | 缺 v3.8.0–v3.13.2 共 **27 个版本** |
| `docs/PROJECT-STATUS.md:53` | `npm run e2e`、`node tools/e2e/peek.mjs`、CDP IndexedDB 全量取证 | 三重失效：根 `package.json` 无 `e2e` 脚本、`peek.mjs` 已删、台架已删 |
| `docs/PROJECT-STATUS.md:8,96` | 称 `tools/e2e/` 已随 v3.9.2 清理移除 | `tools/e2e/probe-page.mjs` 于 `f36b2b9`（2026-09-08）**重新入库并仍在库** |
| `docs/PROJECT-STATUS.md:57` | 只列 `quick-wheel` 快捷键 | manifest 现有 **3 个** command（`quick-wheel`=Alt+Q、`quick-status`=Alt+W、`quick-favorites`=Alt+1；`quick-pages` 已于 v3.16 移除） |
| `docs/PROJECT-STATUS.md:22,79` | 重复「Cookie 快照仅登录时点采集一次」 | v3.10.6 起快照已动态化（响应捕获 + 袋回流），`USER-MANUAL.md:290` 才是正确表述 |
| `docs/PROJECT-STATUS.md:112,118` | 关键文件索引 | 缺 `tab-title.ts`、状态/书签两块浮层与 `ql:forensics`/导入导出/导出诊断（`:118` 的 3000ms 轮询描述**仍准确**；`pages-overlay.ts` 已于 v3.16、`page-monitor.ts` 已于 v3.17 删除，无需补） |
| `README.md:46` | 「Cookie 快照仅登录时点采集一次…需重新登录刷新快照」 | 同 v3.10.6，已失效 |
| `README.md:12` | AUTH 平面覆盖「xhr / websocket / sub_frame」 | `tab-rules.ts:49-59` 已扩到 `main_frame`/`other` 等 10 种 |
| `README.md:3` | 只提云端 `tonbridge-config.aksoegmp.com` | 漏 v3.10.9 的内网站点与 `scheme` 数据化（http/https 自学习） |
| `README.md:31-40` | 文档索引 | **漏列** `docs/DIAG-GUIDE.md`、`docs/FEASIBILITY-RECENT-PAGES.md`；全文 0 次提及盒子/批量/导入导出/最近页面/Alt+W/导出诊断 |
| `docs/USER-MANUAL.md:3` | 「适用版本：**v3.10.1**」 | 落后 **8 个版本**，内容实际已跟到 v3.12+ |
| `docs/USER-MANUAL.md:128-131` | 「账号未在线 → 打开标签页**免密恢复**登录态」 | v3.12.0 语义已改写为「复制语义」：无活绑定页签时进登录页 + 自动填表，并**废弃残留快照** |
| `docs/USER-MANUAL.md` 全文 | — | 缺 v3.11.0/v3.13.0「最近配置页（Alt+W）」与 v3.12.2「导出诊断」按钮（grep 0 命中） |
| `docs/FEASIBILITY-RECENT-PAGES.md:69` vs `:95` | §四 写存储用 `chrome.storage.session`、键 `ql:recentPages:<host>` | **文档自相矛盾**：§七 与实现（`constants.ts:32` + `page-monitor.ts:161`，`storage.local`、键 `ql:recentPages` 按 host 分组）一致，§四 是废弃的中间方案 |
| `docs/FEASIBILITY-RECENT-PAGES.md` | — | 未反映 v3.13.0「仅绑定页签记录/查询」的收敛（CHANGELOG 注明该功能「保留待后续按需求重新打磨」） |
| `CHANGELOG.md` | 日期与 commit 不符的版本共 **24 个**（v3.7.2–v3.12.2 连续一段）：例如 `3.12.0/3.12.1/3.12.2` 标 `2026-08-29`、`3.10.9` 只写「2026-09」 | 对应 commit 实际日期为 **2026-08-31 → 2026-09-09**（已逐版用 `git log --grep` 核对）。该段日期系事后批量补写，**不可作为时间线依据**；仅 v3.13.0 起准确。CHANGELOG 正文的根因分析本身准确、有价值 |
| `CHANGELOG.md:257` | 称依赖已瘦身，「移除 better-sqlite3 / chrome-remote-interface / playwright 相关 devDeps」 | `package.json` 确已移除，但 `node_modules` 中 5 个 extraneous 包仍在（见风险 D37） |
| `packages/extension/docs/DESIGN.md` | 已加历史横幅，但 §3 仍称「`declarativeNetRequest` 不支持按 tabId 匹配」 | 本项目**正是**靠 DNR `tabIds` 实现核心隔离；横幅已笼统声明结论被推翻，正文未逐条订正 |
| `.gitignore` | 忽略 `quicklogin-chrome-*.zip`；忽略 `packages/engine/{dist,data,profiles}` | zip 实际命名与文档所述 `QuickLogin-v*.zip` 不符；引擎目录已删，三条规则为死规则 |

**结论**：代码与 CHANGELOG 正文质量高（每条修复都带根因与取证），但**面向读者的三份概览文档已累计 20 余个版本、
6 个中版本的漂移**，且其中至少两条（`main_frame` 刻意不改写、免密恢复语义）会把读者引向与现行实现相反的结论。
建议按本文的漂移表做一次集中回填，并让版本号/命令/平面数从代码单一来源生成。

## 术语与阅读顺序

- **隔离平面**：存储 / Cookie 袋 / **平面 1.5 广播** / AUTH / COOKIE / CACHE / SW·CacheStorage / IDB
  ——权威定义见 `content/shield-main.ts` 的分节注释与 `background/core/tab-rules.ts` 文件头。
- **会话卫生与写入者归属**：v3.10.2 起驱逐真实 jar 中的扩展账号会话，v3.11.1 起**只驱逐由绑定页签写入的**
  （`cookieAttribution`），原生页签写入一律保留——这是「扩展只能影响扩展打开的网页」原则的落地。
- **登录态生命周期（v3.12.0）**：免密直达收窄为「复制语义」（仅当存在其它**活**绑定页签才直达根路径）；
  最后一个绑定页签关闭 = 登录态终结。
- **亲子继承**：站点自身 `window.open` 的新页签继承 opener 账号；v3.9.6 引入、v3.13.0 加固为
  「URL 确认授权后才收编」，候选期零种子零规则。CHANGELOG 3.11.1 末尾记录该机制仍是**待定夺的决策点**。
- **四象限泄漏**：v3.5–v3.7.2 定位并收敛的历史重大缺陷（根因链见 `CHANGELOG.md` 3.5–3.7.2；
  原始取证工程已随 v3.9.2 移除，git 历史可考）。

**推荐阅读顺序**：`README.md` → `docs/USER-MANUAL.md`（用户视角与已知边界）→
`CHANGELOG.md` 最近 5 个版本（每条的根因分析是理解设计取舍的最快路径）→ 本文 →
`background/core/tab-rules.ts`（293 行，最短的完整平面）→ `content/shield-main.ts`
（按分节注释读）→ `background/core/parallel-session.ts`（主体，建议配合 `ql.diag` 埋点读）→
`ui/parallel/parallel.ts`。
