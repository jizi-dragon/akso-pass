# AGENTS.md —— 给在这个仓库里干活的 AI 协作者

> **这份文件是写给 AI 编码助手的，不是写给人看的。**
>
> 人能容忍模糊的说明——他会问、会试、会从上下文推断。AI 不会：它会把"没写下来的约定"
> 当成"不存在这个约定"，然后用**看起来完全正常**的代码违反它。
>
> 所以下面每一条都是**规则形状的**（祈使句 + 判据），且尽量注明它来自哪次真实事故。
> 没有事故背书的偏好不写在这里——`README.md` 与 `docs/USER-MANUAL.md` 才是人的入口。
>
> **本文件只放「祈使句 + 判据 + 出处指针」，不复述事故经过。** 叙事抄一遍，
> 两处迟早不一致，而读的人**不知道哪份是真的**（参见本文件规则 12）。
>
> | 想了解 | 去哪 |
> |---|---|
> | ★ **规则的正文（判据 + 出处叙事）** | [docs/RULES.md](docs/RULES.md) |
> | **隔离平面总表（权威口径）** | [docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md) §Architecture |
> | **踩过的坑（38 条，只增不改，含判据）** | [docs/PITFALLS.md](docs/PITFALLS.md) |
> | 功能清单与使用说明（给人看的） | [docs/USER-MANUAL.md](docs/USER-MANUAL.md) |
> | 现状快照与安全边界 | [docs/PROJECT-STATUS.md](docs/PROJECT-STATUS.md) |
> | 现场排障与诊断埋点怎么读 | [docs/DIAG-GUIDE.md](docs/DIAG-GUIDE.md) |
> | 纯扩展方案的论证与先例（历史调研） | [docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md](docs/BROWSER-ONLY-MULTILOGIN-RESEARCH.md) |
> | 验证脚本怎么跑、每个脚本覆盖什么 | [tools/verify/README.md](tools/verify/README.md) |
> | 版本里程碑与每次缺陷的根因 | [CHANGELOG.md](CHANGELOG.md) |

---

## 0. 这个扩展是什么（一句话建立正确的心智模型）

**在一个浏览器窗口里，对同一个内部低代码平台并行在线多个账号。**
每个账号一个独立标签页，账号间的**呈现层与网络层全链路隔离**。

**它解决的不是"多开标签页"，而是"同一 origin 的多份共享资源会互相污染"**：

| 共享资源 | 不处理的后果 |
|---|---|
| `localStorage` | 后登录的账号把身份写进同一个键，前一个账号"变成"后一个 |
| Cookie jar | 同 origin 只有一份 jar，登录 B 会顶掉 A |
| HTTP 缓存 | 同 URL 的响应被全 profile 共享 |
| `IndexedDB` | **平台把 `isAdmin` 与菜单树缓存在 origin 级共享 IDB 里**——这是历史"四象限串号"的直接载体 |
| `ServiceWorker` / `CacheStorage` | 站点自建缓存在网络栈内，无视 DNR 规则 |

⇒ 所以本项目的核心是**七个隔离平面**（存储 / 广播 / AUTH / COOKIE / CACHE / SW·Cache / IDB），
每个平面都对应上表里的一个共享资源。**新增功能前先问：它会不会引入第八个共享资源？**

---

## 1. 铁律

> 违反这些**不会抛异常**，只会让某个账号静默串号——而串号看起来像"平台抽风"。

### 规则索引（**祈使句摘要**；判据与出处见 [`docs/RULES.md`](docs/RULES.md)）

> ★ **19–40 号的性质不同于 1–18**：1–18 是『做什么 / 不做什么』，
> **19–40 全是「判据本身的纪律」** —— 它们规定『怎么算验过了』，
> 而每一条都来自一次**真实的假绿/假红**。
> ⇒ 每条都必须能回答：**「拆掉什么它才会红？」**

| # | 规则（摘要） |
|---|---|
| 1 | 七个平面缺一不可，且每个平面都要问"这条路径绕过了谁" |
| 2 | MAIN 世界与 ISOLATED 世界的分工不能混 |
| 3 | 平台口令加密存放，且永不入日志、永不出现在诊断埋点里 |
| 4 | 真实 cookie jar 不得驻留扩展账号的会话（会话卫生三层防线 |
| 5 | DNR 规则按 `tabIds` 限定，不要写全局规则 |
| 6 | `main_frame` 导航刻意不改写（保护静态资源与 SSO 跳转语义） |
| 7 | 版本号三处必须同步 |
| 8 | 构建目标锁死 `chrome110` + `format: 'iife'`（`scripts/build.mjs`） |
| 9 | `manifest.json` 的 CSP 是 `script-src 'self'` ⇒ 扩展页面不能引外链脚本，也不能用 … |
| 10 | `content_scripts` 的注入体积是敏感资源 |
| 11 | `dist/` 是构建产物，不入库、不手工编辑 |
| 12 | 文档只有一个权威源，其余地方写指针 |
| 13 | 验证脚本必须放在被 git 跟踪的 `tools/` 下，不许放 `tmp/` |
| 14 | 脚本的依赖必须写进 `package.json` |
| 15 | 脚本换目录后必须重验它的"仓库根"算法 |
| 16 | 跑验证前必须先 `npm run build` |
| 17 | 门禁必须先反证再相信 |
| 18 | 删代码后必须与 HEAD 逐行对照（不是"看 typecheck 绿不绿"） |
| 19 | 跨多行正则删代码时，锚点必须唯一且紧贴目标 |
| 20 | 删 DOM 标记后必须核对 `HTML id ↔ TS getElementById` 一致性 |
| 21 | "零裸 `console.*`"只证明了"没有绕过 A 通道"，证明不了"没有 B 通道" |
| 22 | "加日志"是三件事，缺一件就等于没加 |
| 23 | 写"零命中"或"某函数里没有 X"这类判据时，先剥注释与字符串字面量，并且把范围按代码的真实控制流划 |
| 24 | `stripLiterals` 只能用于"怕被自己的解释性文字弄红"的断言 |
| 25 | 加日志前先问"这条路径失败时，用户会看到什么？" |
| 26 | 白名单式判据（"这段里含安全痕迹就放过"）必须先问 |
| 27 | 删除一个 UI 功能的完成判据是「四处都没有它」 |
| 28 | 文档审计的判据是「逐条分类」，不是「命中数」——"X 没同步"这句话本身需要判据 |
| 29 | 日志覆盖面的判据是「静默失败」的条数，不是「有 logger 的文件数」——而"哪个 catch 必须留痕"要逐条白名单，不能… |
| 30 | "接口/机制摆在那里"≠"它被接上了" |
| 31 | "产物对"不能推出"源对" |
| 32 | "工具不可用"会伪装成"没人用" |
| 33 | 文档审计要按「读者是谁」分层，不能只按「文件里有没有提这个概念」 |
| 34 | "产物对"要问两件事，本仓此前只问了一件 |
| 35 | "manifest 合法" ≠ "Chrome 装得上" |
| 36 | CSS 变量是"隐式契约"，必须按「页面的依赖链」验 |
| 37 | "定义 vs 使用"要两个方向都查 |
| 38 | 抽"公共文件"之前先看那个文件里有什么 |
| 39 | "同一事实的声明"会跨语言 |
| 40 | 凡是「必须被人或 agent 读到」的文件，**体积本身要有一条判据** —— 因为「文档太长」会静默地变成「规则不存在」 |

★★ **本表是索引，不是规则本身。** 判据、反证结果、出处叙事在
[`docs/RULES.md`](docs/RULES.md)；每条坑的五段在 [`docs/PITFALLS.md`](docs/PITFALLS.md)。
**加规则时三个地方一起改**（本表摘要 + `RULES.md` 正文 + `PITFALLS.md` 那条坑）。

---

## 2. 命名与分层约定

- **`src/` 五层**：`background/`（SW 与核心逻辑）、`content/`（注入脚本）、`ui/`（popup / parallel / wheel）、
  `shared/`（类型 / 常量 / 消息协议）、`storage/`（IndexedDB 封装）。**新增文件按职责归层，不要放根。**
- **消息协议单一定义**：所有 `chrome.runtime` 消息的请求/响应类型在 `src/shared/messages.ts`。
  **不要在调用点就地写对象字面量**——那会让"某个字段改了但另一边没改"静默失效。
- **localStorage 的键集中在 `src/shared/constants.ts` 的 `LOCAL_KEYS`**（如 `ql:cloudAuth` / `ql:siteSchemes`）。
  **不要在业务代码里写裸键名字符串。**
- **`manifest.json` 的 `permissions` 只加真正需要的**。`optional_host_permissions` 走
  `permissions.request` 时**必须在用户手势里最先发起**——晚一步手势失效、`fetch` 必然失败
  （`ui/parallel/parallel.ts` 的 `ensureCloudOriginPermission` 就是为此而写，别把它挪到 `await` 之后）。

---

## 3. 改哪跑哪（门禁矩阵）

### 基线（动手前 + 改完后各跑一次）

```powershell
npm ci                    # 依赖现在已显式声明（含 playwright-core）
npm run typecheck         # tsc --noEmit，strict
npm run build             # esbuild → dist/
npm run check-deps        # 幽灵依赖门禁（三方裸模块必须已声明）

# 打码通道 + 闭环：**四个**脚本，秒级，都**不需要浏览器**
node tools/verify/verify-log-redaction.mjs           # 日志通道（**121 条**）
node tools/verify/verify-falsify-logredaction.mjs    # ↑ 的反证（**23/23**）
node tools/verify/verify-forensics-redaction.mjs     # 取证/诊断通道（25 条）
node tools/verify/verify-falsify-forensics.mjs       # ↑ 的反证（3/3）

# 图标源 + 用户文档：**四个**脚本（+ CSS 变量卫生一个，见下），同样秒级、不需要浏览器
node tools/verify/verify-icons.mjs                   # 图标源与派生产物（**42 条**）
node tools/verify/verify-falsify-icons.mjs           # ↑ 的反证（**4/4**）
node tools/verify/verify-user-docs.mjs               # 用户可见的功能描述（**7 条**）
node tools/verify/verify-falsify-userdocs.mjs        # ↑ 的反证（**5/5**）

# 装载冒烟：真起 Chromium + --load-extension（**17 条**，约 15 秒）
#   ★ 它验「manifest 合法 ≠ Chrome 装得上」那一步；**不验**登录/列表/开页签/盒子/
#     设备流/离线降级 —— 那些要真实云端账号 + 真实内网平台，**必须人工走**（B7 的剩余部分）。
node tools/verify/verify-load.mjs

# CSS 变量卫生：静态、秒级、**不需要浏览器**
#   ★ 防的是"**引用了却解析不到**"：`var(--x)` 无 fallback 又无人定义 ⇒ **整条声明被丢弃**；
#     `--x: var(--x)` 自引用 ⇒ 等于未定义。浏览器**都不报错**。
node tools/verify/verify-css-vars.mjs                # **22 条**

# 品牌色一致性 + 不新增硬编码（静态、秒级）
#   ★ 三处独立定义必须逐字等价；TS/JS 里品牌色硬编码**只减不增**（冻结基线 15）。
node tools/verify/verify-brand.mjs                   # **10 条**

# 规则入口的体积与一致性（静态、秒级）
#   ★ AGENTS.md < 48 KB；规则索引与 RULES.md 正文的编号集合**双向相等**且连续。
node tools/verify/verify-agents-budget.mjs           # **11 条**

# ★★ 缺陷回归（静态、秒级）：六个"修好后 typecheck/build 照样全绿"的缺陷
#   诚实提醒：这批缺陷**静态判据只能验"写法还在不在"**，
#   真机行为（凭据到底交给了谁、清扫到底删没删）仍须浏览器实测。
node tools/verify/verify-defectfix.mjs              # 六组断言
node tools/verify/verify-falsify-defectfix.mjs      # ↑ 的反证（**6/6**，副本在 tmp/，真实源码不动）
node tools/verify/verify-boxsync.mjs                # 盒子与云端对账（三条约束，含两条反方向）
node tools/verify/verify-deadprotocol.mjs           # ★ 死协议：每个 kind / 桥 op 必须能报出**对端**
node tools/verify/verify-acct-grid.mjs              # ★ 账号选择器（网格）：18 个账号必须渲染 18 格

# ★★ 源码预处理的**公共件**（不是判据，是被判据依赖的）
#   任何"先剥注释再断言"的脚本都必须用它，**不要自己写剥离正则**：
#   非贪婪块注释正则**会跨字符串字面量**匹配，把活代码整段吃掉（PITFALLS #35）。
tools/verify/_lib/strip-comments.mjs

npm run verify:list       # 列出回归脚本（不跑）
```

### 改了什么 → 必须额外跑什么

| 你改了什么 | 必须额外验证 |
|---|---|
| `src/ui/wheel/**` 或 `src/content/wheel-overlay.ts`（**账号选择器**） | `node tools/verify/verify-acct-grid.mjs`（真起 Chromium）。★ 两个表面共用一套类名契约：小窗走 `acct-grid.css`、页内浮层走 Shadow DOM **内联**样式 —— **改样式必须两处都改**，判据会比对类名集合 |
| `src/background/core/tab-rules.ts`（DNR 规则） | `npm run verify -- --only v310` + **手工确认规则是逐条安装的**（`updateSessionRules` 是原子批量，一批被拒会连坐） |
| `src/content/shield-main.ts`（平面补丁） | 至少跑 `--only defect` 与 `--only jarhygiene`（这两个覆盖串号与会话卫生） |
| `src/content/auto-login.ts`（填表节奏） | `--only fillrhythm`（9/9）与 `--only autologin`（5/5） |
| 云端数据源相关（`cloud-device` / `cloud-store` / `cloud-migrate`） | `--only dynsnap` + **手工走一遍设备流**（它依赖真实服务端与 host 授权手势，脚本覆盖有限） |
| `src/ui/**`（popup / parallel / wheel） | 无自动化覆盖 ⇒ **必须浏览器装载实测**。★ 改完要在 `chrome://extensions` **点「重新加载」**——Chrome 会缓存扩展 SW 脚本，直接重启浏览器也可能复用旧脚本 |
| `manifest.json` | ① 版本号与另两处一致（规则 7）；② 新增权限是否真的必要；③ `content_scripts` 的 `world` / `run_at` 未被动过 |
| `scripts/build.mjs` | ① `format: 'iife'` 与 `target: chrome110` 未变；② `entryPoints` 与 `manifest.json` 引用的产物**一一对应**（漏一个 = 装载时报"找不到文件"，而那是运行期才发现的） |
| `tools/**` | `node tools/check_deps.mjs` 必须仍绿 |

### 跑验证脚本

```powershell
npm run verify:list                 # ★ 先看有几个、都是谁（数量以它为准，别在文档里写死）
npm run verify                      # 跑全部（几分钟：编排器统一要求 --browser）
npm run verify -- --only v310       # 只跑名字含 v310 的
npm run verify -- --only jarhygiene
```

★ **本行曾写"跑全部 12 个"，而实际早已是 27 个**（脚本是 `readdirSync` 自动发现的）。
⇒ 数字一律用 `npm run verify:list` 取，不要在文档里抄第二份（规则 12 的同类风险）。
★★ 而且**绝大多数脚本并不需要浏览器**（打码、图标、CSS 变量、文档文本、本次新增的
缺陷回归都是静态的、秒级）—— `--browser` 只是编排器的**统一确认开关**，
不是"每个脚本都真起 Chromium"（README 里那句描述已过时，见 `tools/verify/README.md`）。

★ **`npm run verify` 故意要求显式 `--browser`**（`run-all.mjs` 内部检查）：
不加这个开关会**拒绝运行并列出待跑清单**——因为"默认跑完全部"会让人不敢按，
于是"批量验证"这件事会重新退化（规则 13 的同类风险）。
★ 但要说准它拦的是什么：**它拦的是"批量"这个动作，不是"每个脚本都要浏览器"**。
只有 `verify-load.mjs` 与那几个浏览器回归（`v310` / `jarhygiene` / `defect` / `autologin` /
`dynsnap` / `fillrhythm` / `httpscheme` / `adopt` / `boxmgmt` / `defbox` / `track`）真起 Chromium；
打码、图标、CSS 变量、品牌色、文档、盒子对账、本轮新增的缺陷回归**都是纯静态、秒级**的
⇒ 它们**可以直接单独跑**，不必为了改一行等几分钟。
（原文写"每个脚本都真起一个带扩展的 Chromium（数十秒）并往 `tmp/` 写档案"，
在脚本数量涨到 27 个之后已经不成立。）

### 提交与文档

- **提交信息用 Conventional Commits**（`feat:` / `fix:` / `chore:` / `docs:` / `tools:`），
  与服务器端统一。
- **每修一个"看起来正常但其实是坏的"缺陷，就把它的判据写进脚本注释或
  [`docs/PITFALLS.md`](docs/PITFALLS.md)。**
  ★ 本仓 **2026-10-09 起有 `docs/PITFALLS.md` 了**（当前 **38 条**）——在此之前这类教训
  只散在 `CHANGELOG.md` 里，而两者的分工不同：
  `CHANGELOG.md` 记"每次发布改了什么"（历史），
  `PITFALLS.md` 记"**哪些错会静默发生、怎么一眼认出来**"（可复用的判据）。
  **不要在两处都写全量**（规则 12）——叙事抄一遍，两处迟早不一致。
  格式照服务器端 `akso-cloud/docs/PITFALLS.md`：五段（症状/根因/判据/处置/推广）、
  编号是稳定 ID 永不重编、**每条必须有可执行判据**，已修的改状态标注而不是删除。

---

## 4. 本机环境速查

| 项 | 实际情况 |
|---|---|
| Node | **最低 20**（`.nvmrc` = 20，`engines` = `>=20` 无上界）。实测本机日常为 Node 24 |
| 包管理器 | **npm**（workspaces：`packages/*`）。构建与工具链都用它 |
| 构建 | `scripts/build.mjs`（esbuild）。产物 `dist/`，**iife + 11 个入口**（实测：`background` 1 + `content` 6 + `ui` 4） |
| 类型检查 | `tsc --noEmit`，`strict` + `noUnusedLocals/Parameters` + `noFallthroughCasesInSwitch` |
| **没有的东西** | **无单元测试框架、无 lint、无 CI**（`.github/` 不存在）。这不是遗漏，是现状——所以**规则 13–17 的验证资产就是全部保障** |
| 浏览器 | Chrome / Edge，**`minimum_chrome_version: 110`**。装载：`chrome://extensions` → 开发者模式 → 加载已解压的 `dist/` |
| 云端服务 | `https://www.dragonrain.top:8443`（`akso-cloud`）。设备流（RFC 8628）授权，`CLOUD_ORIGIN_PATTERN` 在 `parallel.ts` 里 |
| 目标平台 | `tonbridge-config.aksoegmp.com`（无状态 JWT Bearer）。内网形态为 **纯 http**（`10.100.0.105`）⇒ scheme 必须数据化（v3.10.9 的教训） |
| **测试档案** | 脚本在 `tmp/` 下建 Chrome 档案（`tmp/ui-*`）。**`tmp/` 是 gitignored**——脚本入库、运行产物不入库。这些档案会占数百 MB，可随时删 |
| **Node 的坑** | `npm install --no-save` 装的包**不会进 `package.json`**，但会留在 `node_modules` ⇒ 这正是 3 个幽灵依赖的成因（规则 14）。**加依赖一律走 `npm install --save-dev`** |

---

## 5. 不要做的事

| 不要 | 为什么 |
|---|---|
| 在 `content_scripts` 里引入前端框架 | 它注入用户的**每一个页面**（规则 10）。UI 框架只允许用在 `ui/`（popup / parallel / wheel 是扩展自己的页面） |
| 用 DNR 的 `urlTransform` | Chrome 从未支持（Firefox 专属），且 `updateSessionRules` 是原子批量 ⇒ 一批被拒会连坐 AUTH/COOKIE 规则（规则 1） |
| 把 `format` 改成 `esm` | MV3 的 SW 与 content script 都不是 ES module 环境（规则 8） |
| 放宽 `manifest.json` 的 CSP 来引外链脚本 | CSP 是 `script-src 'self'` 是刻意的安全带（规则 9） |
| 手改 `dist/` | 构建产物，下次 `npm run build` 会被覆盖。改 `src/`（规则 11） |
| 把验证脚本写进 `tmp/` | 那是 gitignored ⇒ 等于没写（规则 13，已退化过两次） |
| 为省事把 `permissions.request` 放到 `await` 之后 | 用户手势会失效，`fetch` 必然失败，而报错不指向根因 |
| 假设 `npm install` 之后 `node_modules` 里有什么就能用什么 | 那可能是残留（规则 14）。**能跑 ≠ 可复现** |
| 同时改 README / PROJECT-STATUS / CODEBASE_OVERVIEW 三处的架构描述 | 权威源只有一个（规则 12）。改三处 = 制造三个会各自漂移的副本 |

---

## 6. 本地数据源已废除（v3.18，2026-10-09 完成）

**用户决定：彻底废除扩展端的本地账号保存，强制登录云端账号。**
本节保留**侦察结论与踩过的坑** —— 下次改这块周边时仍会需要它们。

### 6.1 结果

| 维度 | 结果 |
|---|---|
| 数据源 | **只剩云端**。`dataSource` / `getDataSource` / `setDataSource` / `DataSource` **全仓零残留** |
| 删除的文件 | `core/credentials.ts`（本地 AES-GCM 凭据）、`core/cloud-migrate.ts`（本地→云端合并）、`core/navigation.ts` + `core/session-manager.ts` + `core/account-registry.ts`（**旧 Session 模型三者**） |
| 新增的文件 | `core/account-cache.ts`（只读快照缓存）、`core/offline.ts`（`OfflineError`）、`core/auto-login-cache.ts`（待登录凭据的临时缓存，从 `navigation.ts` 摘出） |
| 消息 | 删 `session.*`（5 个）、`cloud.migrate`、`cloud.source.set`；`CloudState` 去掉 `source` |
| 类型 | 删 `Session`、`EncryptedCredentials`、`ParallelAccount.credentials`、`updateCredentials`（**实测无调用点**） |
| 规模 | 12 个文件，**−796 / +164 行** |

**保留**：云端会话、设备流（RFC 8628）、以及**离线时的只读列表缓存**
（不含口令；可看、可开页签；**不可新增/编辑，填表失效**）。

### 6.2 ★ `session.*` 曾经"看起来是死代码" —— 这个排查值得复述

第一眼它像遗留物：5 个消息 + `sessionManager` + `db.sessions`，
而 **UI 一处都不发**（实测 UI 只发 `par.*`）。
但 `navigation.switchAccount(session, …)` 收的是 `Session`，`accountRegistry`
用 `sessionManager.get(sessionId)` 取**标签页标题** ⇒ 两个模型**交叉**。

**实测结论（与第一眼相反）**：`parallel-session.ts` **完全不 import**
`navigation` / `session-manager` / `accountRegistry` —— 它有自己的一套
（`applyTitle` / `SESSION_KEYS.parTabBindings` / `resolveAccountPlaintext`）。
⇒ 旧模型只服务那 5 个死消息，**可以整体删除**。

★ 教训：**"看起来像死代码"与"是死代码"必须分开验证。**
判据是"**谁真的 import 它**"，不是"谁看起来用得上它"。

### 6.3 ★★ 本轮最贵的一次教训：一条正则吞掉了相邻的功能块（→ 规则 18）

删"数据源按钮的 UI 状态块"时，我用了一条跨多行正则，它**吞掉了紧邻的设备流代码**
（`deviceCancelBtn` / `deviceRetryBtn` / `deviceUserCodeOpen` 的监听，
以及 `openApprovalTab` 函数与 `deviceApprovalUrl` 变量）。

**为什么危险**：

- 合成出的文件**语法完全合法**，`tsc` 与 `npm run build` **都通过**；
- 唯一的信号是 **"`deviceUserCodeOpen` 声明但未使用"** ——
  那读起来像"清理未用变量"，实际是**功能被删掉了**。

**判据（已写进规则 18）**：删代码后必须**与 HEAD 逐行对照**，列出
"HEAD 有、现在没有"的行，并**逐条确认它们在删除清单里**。
**typecheck 绿不是判据** —— 它只说明"剩下的代码自洽"。

### 6.4 导出/导入已降级为"只含元数据"

旧备份带 `cryptoSeed` + 每账号 AES-GCM `credentials`，导入时现场解密。
本地凭据存储废除后**那份密文再也解不开**（我们刻意让它如此）。
⇒ 新格式只带**配置**（站点 / 标题 / 盒子 / 用户名），导入时口令为空。
**旧备份文件的口令部分不可恢复** —— 这是设计取舍，已写在类型注释里。

### 6.5 已知未做（下一步）

- **文档同步**：★ **v3.19（2026-10-09）已做** ——
  按关键词量化出**一批**命中，但**绝大多数本来就是正确的**（都带"v3.18 已删"标注）；
  真正**与现状相反**的逐条列在下面那张表里（**以那张表为准，不要引用"命中 N 处"**）。

  | # | 文档 | 问题 | 处置 |
  |---|---|---|---|
  | ① | `docs/CODEBASE_OVERVIEW.md:18` | Summary 里写「账号密码 **AES-GCM 加密存于本机 IndexedDB**」——**该功能已废除** | 改成"账号存云端、本机只留不含口令的只读副本"，并加一段说明 |
  | ② | `AGENTS.md` 本节（原第 262-264 行） | 声称上述三份文档"仍在描述 `credentials.ts` 与数据源切换" | 就是你现在读到的这段 |
  | ③ | `docs/PROJECT-STATUS.md:14` | 小标题「**四平面**隔离」而**表内自己就有 6 行**（实际七个，缺平面 1.5） | 改成指向权威源 + 说明这是历史对照 |
  | ④ | `docs/PROJECT-STATUS.md` 文件表 | 仍把 `credentials.ts` 列为**当前**文件 | 加删除线 + "v3.18 已删除" |
  | ⑤ | `docs/PROJECT-STATUS.md:1` | 标题「**现状快照**（v3.9.2）」——落后 8 个中版本 | 加时效警告；**保留旧版本号不改**（改成当前会让它"看起来新、实际只有一半新"） |
  | ⑥ | `packages/extension/docs/DESIGN.md` §2 | 决策表**三条已被推翻**（账号能力 / 持久化 / 凭证安全）却无标记 | 加「当时 → 现在」逐行对照 |
  | ⑦ | `packages/extension/docs/DESIGN.md` 横幅 | 「六平面（v3.7.2）」 | 改成**七个**（新增平面 1.5） |

  ★★ **修正我这句原话（两次）**：

  1. 我写的"**仍在描述** `credentials.ts` 与数据源切换"是**没核实的概括**。
     实际核对下来，`CODEBASE_OVERVIEW.md` 有 **63 处** `文件:行号` 引用，
     而它的 `credentials` 命中里**大部分都带"v3.18 已删"标注** —— 它维护得不错。
  2. ★ 我随后又在本文里写了"实测命中共 **15** 处……真正与现状相反的只有 **3** 处" ——
     **那个数字也不可复现**：它是**编辑前**的测量（改完文件数字自然失效），
     而且我为了"分类"写了个关键词分类器，**实测它在 25 处上把 19 处判成了"现状陈述"
     —— 其中绝大多数是误报**（比如"这段讲的是**旧格式**"、以及"这些**全部删除**"那种句子）。
     ⇒ **关键词分类器判不出"这句话是否在说谎"**，因为判据是**语义**的，不是词面的。
     ⇒ 已改成**逐条列出那 7 条**（可核对、可复现），**删掉所有"N 处"的计数**。

  ⇒ **"文档没同步"这句话本身也要有判据**（逐条看那句话是"现状陈述"还是"历史留痕"），
  否则会变成一次没有依据的指责，而**改掉对的注释**比不改更坏（规则 12）。

  ★ 另外加了一条**时效说明**在 `CODEBASE_OVERVIEW.md` 顶部：
  它锚定 `1e61985`，而当前 HEAD 已在其后 **20 个 commit / 4 个中版本**
  （v3.13.2 → **v3.17.1**），**全文 63 处行号不可当作精确定位**。
  ⇒ 本仓的分工：**`AGENTS.md` 是活文档**（规则，改了就得同步），
  **`CODEBASE_OVERVIEW.md` 是锚定式快照**（架构，允许滞后，但必须标锚点）。

- **UI 实机验证**：`src/ui/**` 无自动化覆盖 ⇒ 必须在 `chrome://extensions`
  **重新加载**后手工点一遍（登录 / 列表 / 开页签 / 盒子 / 设备流 / 离线降级）。
- **离线只读缓存的界面层**：★ **v3.19（2026-10-09）已完成** ——
  新增 `par.offline` 消息，`#cloud-banner` 的 `warn` 分支会明说
  "这是 **N 分钟前同步的只读副本**，可以看、可以打开页签，
  但不能新增/编辑，自动填表也不生效"。
  ★ 判据从"快照年龄"启发式改成了**发生地记账**（`lastListFellBack`）——
  年龄猜不准（刚断网时猜不到；长期没打开而网络正常时会误报），
  而 `listWithFallback()` **确实知道**自己走了哪一支。
  ★ 同时清掉了这块周边**已废除功能的三处残留**（见 `docs/PITFALLS.md` #19）：
  空的 `#source-switch` 容器、整套死 CSS、以及**一段讲"本地→云端合并上传"的说明文字**
  （那段字已经与行为相反 —— 它对用户说谎）。

---

_本文件遵循 [AGENTS.md](https://agents.md) 约定：仓库根目录的 `AGENTS.md` 就是 AI 协作者的规则入口
——短、规则形状、可执行。如果你发现自己需要在这里加"背景介绍"，那说明它该去
`README.md` 或 `docs/USER-MANUAL.md`。_
