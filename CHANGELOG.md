# Changelog

版本号约定：每次功能性更新同步递增根 `package.json`、`packages/extension/manifest.json` 与 UI 内显性展示的 `EXT_VERSION`（`src/shared/constants.ts`），三处必须一致。

> **更名说明（2026-10-11）**：本项目 2026-10-11 由 `quick-login` 更名为 `akso-pass`，品牌名 `QuickLogin` → **Akso Pass**。
> **历史条目里的旧名保留不动** —— "当时叫 QuickLogin"是事实，改写它等于伪造当时的记录。

## 4.2.1（2026-10-12）

**翻译范围澄清与两处边界修正：翻译**不限于**多开的平台站点 —— 浏览器里能打开的普通网页都可以。**

> 用户要求"翻译功能不必局限于多开的网站，只要是浏览器中打开的页面都可以"。
> ★ **范围本来就没有被限制**：`content_scripts` 一直是 `matches: ["<all_urls>"]`，
>   内容脚本内也没有任何站点/宿主判断（本轮**实测**确认）。所以这条要求不需要"放开"，
>   需要的是把**真实边界**测出来写清楚，并把"看起来没生效"的两处体验问题修掉。

### 实测出来的**能力矩阵**（跑出来的，不是文档承诺）

| 场景 | 结果 |
|---|---|
| `https` / `http` 普通页 | ✅ 可用 |
| 同源 iframe 内的输入框 | ✅ 可用（`all_frames: true`） |
| `<input>` text / search / email / url / tel / 未指定 type | ✅ 可用 |
| `<input type="password">`、`<textarea>` | ✅ 可用 |
| `contenteditable`（含 `role="textbox"`、含 `<p>` 的富文本） | ✅ 可用 |
| **`chrome://` 内部页、Chrome 应用商店** | ❌ **浏览器安全边界**：Chrome 不向这些页面注入**任何**扩展脚本（与本扩展无关） |
| **`file://` 本地文件** | ⚠️ 需在扩展详情里手动开启「允许访问文件网址」 |
| PDF 查看器 | ⚠️ 能注入，但通常没有可聚焦的输入框 ⇒ 提示"请先把光标放进输入框" |
| `<input type="checkbox/radio/number/…">` | 刻意不支持（见下） |

### 修正

| # | 问题 | 修法 |
|---|---|---|
| 1 | **`<input type="number">` 出图标却必然失败**：number 框**不可能含中文**（浏览器拒收非数字字符），却给了图标、白跑一次 API，报的还是"结果仍为中文，引擎未能正确识别源语言"——用户无从理解"为什么数字框翻译失败" | 把 `number` 加进 `EXCLUDED_INPUT_TYPES`（与 checkbox/radio 同类）：**不出图标、不占一次调用** |
| 2 | **`chrome://` / 应用商店上按 `Alt+T` 完全静默** ⇒ 用户只会理解为"功能坏了" | 面板「试一次」对这类页给出可理解说明："当前是浏览器内部页/应用商店 —— 浏览器不允许任何扩展在这里注入，换个普通网页试"；`file://` 与"页面在扩展加载前就打开"也各有专条提示 |
| 3 | 焦点不在输入框时提示过短，读起来像"操作失败" | 改成可执行的下一步："请先把光标放进输入框（网页上的文本框/多行框/富文本都可以），再按 Alt+T" |

### 用户第二轮反馈（同日，v4.2.1 内）

| # | 要求 | 落点 |
|---|---|---|
| 1 | **logo 换成 Akso 的 logo** | 侧栏原来是**我用 CSS 画的锥形渐变环** —— 那是我自己造的形状，不是品牌标识。改为 `<img src="assets/Icon48.png">`（即 `logo-master-422.png` 的派生产物）。★ 用 `Icon48` 而不是 `logo-master`：后者是图标派生链的**源文件**，构建刻意不发进包 |
| 2 | **把已登录账号信息移到右边** | `#cloud-account` 原先夹在"帮助气泡"与"导出数据"之间 —— 它是**身份信息**却和工具按钮混在一排。页头改为两区：`.head-left`（气泡 + 账号）/ `.head-right`（导出/导入/诊断 + 统计，贴右边缘）。判据：`stats` 右边缘距视口 ≤ 80px |
| 3 | **站点管理支持自定义站点名称**（要求 akso-pass 与 akso-cloud 都改） | ★★ **云端无需改动** —— 实测 `site` 表早有 `name` 列（`db.py:134`）、`/api/sites` 早有完整 CRUD（`SitePatch.name` 上限 120）、`site_public()` 与 `vault/snapshot` 都返回它。**缺口在扩展侧的传输层**：`renderSites(hosts: string[])` 只拿得到 host，名字在中途就被丢了。⇒ 补 `par.sites` / `par.renameSite` 两条消息 + `parallelStore.listSites/renameSite`，站点行显示**自定义名为主标题、域名作副标题**（域名是账号绑定的身份键，不能只显示别名），并加就地编辑 |

### 判据

- `npm run typecheck` exit 0；`npm run build` BUILD_OK；`npm run check-deps` DEP_OK
- 静态门禁全绿：`verify-load` **20/20**、`verify-css-vars` **32/32**、`verify-brand` **10/10**、
  `verify-agents-budget` **11/11**、`verify-log-redaction` **121/121**、
  `verify-forensics-redaction` **25/25**、`verify-defectfix` OK、`verify-user-docs` **7/7**
- 行为侧（临时脚本，未入库）：真实 `Alt+T` → 读剪贴板 **5/5**；元素矩阵 **13 行逐条核对**
  （每格**独立开页**并记录**实际获得焦点的元素**）

**第二轮新增的判据**（均可复现，且已验证会红）：

| 判据 | 结果 |
|---|---|
| `tmp/verify-sitename.mjs` — `par.sites` 带 name / 改名发出 `PATCH {name}` / **不含 `baseUrl`** / 空名回落成 host | **7/7** |
| `tmp/verify-sitename-ui.mjs` — 行渲染自定义名 + 域名副标题 / 「改名称」就地编辑 → 云端收到 PATCH → 列表刷新 → 编辑态退出 | **10/10** |
| `tmp/assert-account-head.mjs` — 页头两区分开、统计贴右、logo `<img>` 存在且 ≥20px | 4/4（反证：去掉 logo ⇒ 第 ④ 条变红） |

★ 两处我自己的失误已纠正，都不是功能缺陷：
① 第一版 UI 判据用 `page.$('#site-list .site-row button')` 抓到了**第一行**（mock 云端里没有的 host）⇒ 改名必然失败，而我把这个失败读成了"功能没实现"。判据必须**指名到行**。
② 第一版用 `window.prompt` 做改名输入 —— 它**写不出可靠判据**（只能靠 dialog 事件间接驱动），而"判据不可写"在本仓等于"这条路径不会被验"。改成**就地输入框**（Enter 保存 / Esc 取消 / 失焦保存）。

  （每格**独立开页**并记录**实际获得焦点的元素** —— 第一版把 13 个元素放同一页顺序测，
  `checkbox` 那格的结果**无法归因**，已重做）

★ 顺带纠正我自己的一处误判：第一版矩阵里 `password` 报失败，重做后**实测可用** ——
那是同页顺序测试的串扰，不是缺陷。（"归因不明的失败"不能当结论用。）

### 用户第三轮反馈（同日，v4.2.1 内）

| # | 要求 | 落点 |
|---|---|---|
| 1 | 添加站点时就能填名称；**留空则自动用站点地址填充**；显示时**同时显示名称与地址、突出名称** | 站点表单加 `#s-name`；提交时 `name = 输入值 或 host`（用 `host` 而不是用户原样输入 —— 粘 `https://a.com/x` 时不该把整串当名字）；站点行以**名称为主标题、地址为副标题** |
| 2 | 添加账号时**按站点名称选**（站点多了才认得出来） | `#p-host` 的选项文案从 `host` 改成 `名称（host）`；`value` **仍是 host**（账号绑定的是它，不能换）；`fillSiteOptions` 的缓存 key 加入 `siteNames` —— 否则改名后下拉不更新 |
| 3 | "打开并行管理页" → **"打开管理页"**；去掉常驻的登录按钮；**popup 的 logo 也要换** | 文案改；登录按钮改成**按登录态显示**；popup 的 `.brand-ring` 同样换成 `assets/Icon48.png`（上一轮我只改了侧栏，**漏了 popup**） |
| 4 | 点已登录账号图标 → **"退出账号" / "同步数据"** | 新增身份区 + 覆盖式菜单（走 `cloud.state` / `cloud.sync` / `cloud.logout`） |
| 5 | 退出账号时**自动清除缓存的账号数据** | `cloud.logout` = 清令牌 + `clearSnapshot()`（只读快照）+ `invalidateCloudCache()`。**云端一条记录都不动** —— 用户是"退出登录"，不是"注销账号" |
| 6 | 未登录时出现**"登录"按钮** | 与 3 同一条：`#open-vault` 未登录才显示 |

**新增判据**（均可复现）：

| 判据 | 结果 |
|---|---|
| `tmp/verify-popup.mjs` — 两种登录态的 DOM 断言 + `.hidden` 在 popup 样式链里可用 + 同步真的打了云端接口 + 退出后 `cloudAuth`/`cacheMeta` 双清空 | **15/15** |
| `tmp/verify-sitename.mjs` 扩展 D/E 组 — `upsertSite` 对**不存在**的站点先建再写名；空名回落 host | **11/11** |
| `tmp/verify-sitename-ui.mjs` 扩展 F/G 组 — 下拉显示 `名称（地址）` 且 `value` 仍是 host；站点表单有名称框且提示留空口径 | **15/15** |

★ 本轮又踩到两个**同族**的坑，都不是功能缺陷：
① **`.hidden` 在 `popup.css` 里不存在** —— popup 只引 `theme.css` + `popup.css`，不引 `panel.css`。
   我新增的 `#identity` / `#identity-menu` / `#open-vault` 全靠它做显隐；不定义就会**三个元素同时可见**。
   这是 PITFALLS #41 的同族形态（样式缺失不报错），所以补了一条判据**直接探测 `.hidden` 是否生效**。
② **身份菜单压住了主按钮** —— 弹窗只有 328px 宽、内容排得满，菜单锚在按钮下方就会盖住
   "打开管理页"。改成**覆盖式**（面板右下、`position:absolute`），不改动 `.pop` 的流式布局。
   这条是**看截图**发现的 —— 当时 DOM 断言全绿。

### 用户第四轮反馈（同日，v4.2.1 内）—— ★ 两条是**我上一轮做错了位置/条件**

| # | 用户报的现象 | 真因 | 修法 |
|---|---|---|---|
| 1 | 想在页头那块账号上点出「退出账号/同步数据」 | ★ **我把菜单只做在了扩展弹窗里** —— 用户在账号中心页头点不出来 | `#cloud-account` 从 `<span>` 改成可点 `<button>`，挂同一个菜单（`cloud.state` / `cloud.sync` / `cloud.logout`） |
| 3 | "退出账号功能并未生效" | ★ **和 1 是同一件事**：菜单不在他点的地方。功能本身是对的（popup 里实测 15/15） | 同上；**并补上界面反馈**：退出后清掉页面上的账号列表并重渲染 —— 否则退出后界面仍显示上一个账号的 9 个账号，看起来就像"没生效" |
| 2 | 站点名称**无法更改、出现报错** | ★ **按钮的承诺与它能做到的事不一致**：站点的名字存在云端，而只在浏览器里授权过、云端没有记录的站点（`127.0.0.1` 之类），改名必然以"云端找不到站点"失败 —— 按钮却照样显示 | 云端没有该记录时，按钮改成「**添加到云端**」（走容忍不存在的 `par.upsertSite`）；报错文案补上"下一步该点哪个按钮" |
| 2 | 名称要能从地址**截取** | 服务端建站时把 `name` 填成**完整 host**（`sites.py:150` 的 `body.name.strip() or host`）⇒ "name 非空"≠"用户起过名" | 新增共用的 `deriveSiteNameFromHost`：`tonbridge-config.aksoegmp.com` → `tonbridge-config`；`www.dragonrain.top` → `dragonrain`；IP 字面量整串保留 |
| 2 | 名称上方再显示"通桥医疗"这类名字 | —— | 口径落在**显示名**上：用户把名称设成 `通桥医疗` 就是它，没设就是从地址截取。副标题始终是完整域名（账号绑定的身份键，不能只显示别名） |

**新增/扩展判据**：

| 判据 | 结果 |
|---|---|
| `tmp/verify-sitename-derive.mjs` — 推导规则 8 例（含 `www.`、IP、端口、localhost、空串）+ snake_case/词典识别回归 | **13/13** |
| `tmp/verify-sitename-ui.mjs` 扩展 D/H/I/J 组 — **逐行**核对按钮（云端无记录 ⇒ 必须是「添加到云端」）、页头身份菜单可点且含两项、推导名显示、**在账号中心点退出后 `cloudAuth`/`cacheMeta` 双清空且页头账号块消失** | **32/32** |

★ 修完这一轮顺手**修好了一条被我弄坏的判据**：`verify-falsify-logredaction` 第 ⑫ 条
（孤儿 id 双向一致性反证）的锚点写的是 `#cloud-account` 那一行 HTML，我把 `<span>` 改成
`<button>` 后它**如实报"锚点没找到"**（22/23）。⇒ 锚点已同步更新，并注明
"改 `parallel.html` 这一行必须同步改这里"。**它红了是对的 —— 那正是反证该有的行为。**

## 4.2.0（2026-10-12）

**合并 `Akso Instant Translate`（输入框即时翻译）进 akso-pass，并按用户要求重构为「图标可选 + `Alt+T` 取译文到剪贴板」，设置面板迁入新的多页管理外壳。**

> 用户 2026-10-12 下达的 6 条调整：① 核心仍是翻译；② 浮动图标改为**可选项**；
> ③ 新增快捷键：光标在输入框内时翻译其中文为英文（沿用原扩展的命名规范格式），
> **结果只写剪贴板、不回填原框**；④ 翻译成功的页面内反馈保留；
> ⑤ 合并为一个扩展；⑥ 废弃原 popup 设置面板，管理页改成**侧栏导航的两页**
> （账号中心 / 翻译面板），设置项**全量迁移**。

### 新增

| 文件 | 职责 |
|---|---|
| `shared/engines.ts` | 4 路免费引擎（TranSmart / 有道 / MyMemory / Lingva）+ 自动模式赛马与三级兜底。**放 shared 而不是 content** —— 引擎适配器约 8 KB，只在 background 跑，放 content 等于给每个页面白送 8 KB（规则 10） |
| `shared/snake-case.ts` | 命名规范转换 + 汉字残留校验。**两个消费方共用一份**（background 落地、面板实时预览） |
| `shared/translate-settings.ts` | 翻译设置的类型/默认值/读写/**越界修正**（`normalizeTranslationSettings` 是纯函数，可直接判据） |
| `shared/translate-stats.ts` | 使用统计（`storage.local`；只统计**成功**；保留 90 天 / 12 个月） |
| `content/translate.ts` + `.css` | 页面内浮动图标（可选）+ `Alt+T` + Toast。**幂等守卫、`ql_` 前缀 id、绝不写页面 storage** |
| `ui/translate/*` (html/css/ts) | 翻译面板（15 语言 / 5 引擎卡 / 命名规范实时预览 / 统计 / 合规告知 / 快捷键真实键位） |
| `ui/sidebar.css` | 侧栏导航外壳（两个页面**共用一份**） |
| `ui/panel.css` | 管理页共享外壳样式（**从 `parallel.css` 程序化搬出**，见下） |

### 改动

| # | 改动 | 为什么 |
|---|---|---|
| 1 | `manifest.json`：新增 `translate-input` 命令（`Alt+T`）、第 5 个 content script、版本 4.2.0 | 快捷键必须注册在 `commands` 里，否则 `chrome.commands.onCommand` 永远不触发 |
| 2 | 侧栏导航（`ui/sidebar.css`）同时改 `parallel.html` 与 `translate.html` | 用户要求"不要追加在账号页后面，要单独起页 + 侧栏" |
| 3 | `parallel.html` 移除页头 `.brand` 与 `#ver-chip`（移到侧栏页脚） | 侧栏已有品牌区；两个同 id 元素会让 `getElementById` 只拿到第一个，**第二个永远不更新**（静默） |
| 4 | `parallel.ts` 新增 `nav-online` 赋值 | 侧栏要显示在线数。★ 同一个数字两处显示**必须同一处赋值**，否则两处给出不同的数而"哪个是真的"无人能判 |
| 5 | `service-worker.ts`：翻译消息分支 + `Alt+T` 命令转发 | `chrome.commands.onCommand` **只在 SW 触发**，页面收不到 ⇒ 必须 SW 转一手 |
| 6 | `build.mjs`：`entryPoints` +2；**修 `copyUiStatics` 的隐含前提**；**补 `copyContentStatics`** | 见下「顺带修掉的两个构建缺陷」 |
| 7 | `verify-load.mjs`：自有页面清单加入翻译面板，并**反向核对清单与源码 html 一一对应** | 手写清单漏登记 = 新页面**从不被试装**，而校验**照样全绿** |

### ★★ 顺带修掉的两个构建缺陷（都不是翻译功能引入的，是它**照出来的**）

| # | 缺陷 | 根因 | 判据 |
|---|---|---|---|
| 1 | `copyUiStatics` **依赖"第一个条目是目录"** | 它只在遇到子目录时 `mkdirSync`。v4.2.0 在 `src/ui/` **根层**加了 `panel.css`，字母序 `panel.css` < `parallel` ⇒ 先拷文件而 `dist/ui` 不存在 ⇒ `ENOENT`，**构建整体失败** | 把 `src/ui/` 根层第一个条目换成文件，构建仍须成功 |
| 2 | **`content_scripts[].css` 从未进包** | `copyExtensionStatics()` 只拷 `assets/` 与 `ui/`，没有任何一步拷 `src/content/*.css`。v4.2.0 第一次让 content script 引用 css，缺口才暴露 | `dist/` 里必须存在 `manifest.content_scripts[].css` 的**每一个**文件 |

★ 缺陷 2 的形态与本仓规则 35（「manifest 合法 ≠ Chrome 装得上」）同族：
它只在**装载时**报"找不到文件"，而 `npm run build` 是绿的。

### 判据

- `npm run typecheck` exit 0；`npm run build` BUILD_OK；`npm run check-deps` DEP_OK
- `verify-load` **20/20**（新增"新页面必须登记"1 条 + 翻译面板的开页与无错误 2 条）
- `verify-css-vars` **28/28**、`verify-brand` **10/10**、`verify-agents-budget` **11/11**、
  `verify-deadprotocol` OK、`verify-user-docs` **7/7**
- 产物核对：`manifest` 引用的文件**零缺失**；用户 6 条要求**逐条在 `dist/` 里有落点**（12/12）

### ★★ 用户实测反馈后的三处修复（同日，v4.2.0 内）

用户在真实浏览器里试过之后报了三件事，**两类根因、三处修复**：

| # | 用户原话 | 真实根因 | 修复 |
|---|---|---|---|
| 1 | "翻译功能没有生效" | **不是链路坏**（实测 5/5 全通），而是**产物是垃圾**：自动模式赛马里「网易有道」走的是**网络释义**接口，返回词条 —— `行动措施` → `take action /measures /steps to do sth`。而它通常**更快**，于是 `Promise.any` 把词典结果当赢家，用户拿到一串带 `/` 与 `to do sth` 的文本，界面还提示"✅ 已翻译" | 新增 `looksLikeDictionaryEntry()`；自动模式里拿到词典释义**主动 reject**，判据从"谁先返回"改成"**谁先返回可用结果**"；手选有道时明确报错并指路（PITFALLS #42） |
| 2 | "logo 不对" | 侧栏品牌环被写成了**纯色圆点**（`background: var(--sb-brand)` + 带边框），把原来的**锥形渐变环**降级了 | 改回与 `panel.css` 的 `.brand-ring` **同形态**的 conic-gradient 环，仅按侧栏收窄尺寸 |
| 3 | "页面按钮杂乱无序、毫无逻辑、根本无法配置" | **`translate.html` 漏了一行 `<link href="../panel.css">`**。那一行提供 `.wrap` / `.block` / `.block-head.row` / **`.hidden`** / `.desc` / `.stat` —— 缺了它等于整页**外壳样式一条都没加载**。三处"看起来毫不相干的布局缺陷"（提示条常显 / 开关掉行 / 保存条压住卡片）其实是**同一个缺失的 link**；而 `verify-css-vars` 当时**全绿**，因为它 `if (!existsSync(p)) continue;` 把缺文件静默跳过了（PITFALLS #41） | 补回 link；**顺带重排了面板信息层级**（总开关置顶放大 → 怎么用 → 命名规范 → 高级折叠 → 统计 → 保存条，并新增"试一次"按钮）；`cssChain()` 增加 `missing[]` 并落成判据"每个 `<link>` 都必须指向存在的文件"（反证：探针页面当场变红） |

★ 另修：`translate.html` 里 `#engine-hint` 是**孤儿 id**（HTML 有、TS 零引用），
被 `verify-log-redaction` 的孤儿标记判据抓到（规则 20）—— 去掉 id。
**我自己的契约核对早就列出了它，我却挥手放过了**：判据给了结论，我没读。

### ★ 已知代价（诚实标注）

- **每帧注入体积 38.5 KB → 60.9 KB**（`content/translate.js` 18.2 KB + `translate.css` 4.1 KB）。
  其中 **5.7 KB（31%）是 `getLogger` 打码通道** —— **刻意不省**：本仓规则 3/21 要求
  日志必须走打码通道，而翻译功能手上是**用户任意文本**（可能就是敏感字段）。
  省掉它就把"凭据/内容不入日志"的机制降级成约定。
- **剪贴板是跨账号共享资源**：写入系统剪贴板对 `akso-pass` 的"账号间零共享"是一条
  **显式例外**（剪贴板无法按 tab 隔离）。功能上无害（用户主动发起），但**必须写进文档**，
  否则以后有人会把它当成"第八个平面漏了"。
- **翻译内容出境**：请求直发腾讯 / 有道 / MyMemory / Lingva。已在翻译面板用醒目提示告知
  （用户 2026-10-12 确认"内部工具、可用公网引擎"）。

## 4.1.4（2026-10-12）

**修复：自动登录的「试次」记账口径 —— 中止的轮次白吃机会、且观察窗期间无人重填。**

> ★ 用户报障："模拟输入账密 + 点击登录有时登不上（密码还没填完就点了登录）"。
> 本轮**只修其中可复现的那一半**；"空密码提交"的确切成因**尚未实证**（见文末诚实标注）。

### 根因（PITFALLS #39）

`auto-login.ts::runTopFrameFlow` 里 `attempts++` 与 `lastClickAt = now` 发生在**调度**那次
点击的时刻，而那次点击还能在 500ms 后被齐备/回读中止（`click-aborted`）。两个后果叠加：

| # | 后果 |
|---|---|
| 1 | **被中止的轮次白吃一次试次** ⇒ 4 次中止就停手，而扩展**一次都没点过** |
| 2 | **观察窗被提前打开** ⇒ `attempt()` 在 `Date.now() - lastClickAt < 3500` 分支直接 `return`，而 `fillAll()` 在那个 return **之后**才被调用 ⇒ 这 3.5 秒里**没有任何一次重填**，密码框一直空着 |

### 改动（`src/content/auto-login.ts`，单文件）

| # | 改动 | 为什么 |
|---|---|---|
| 1 | 记账点搬进 500ms 回调，且放在**齐备 + 回读 + 按钮可用**三项都通过之后；`attempts` 改名 `posts`（= 服务端实际收到几次提交）；reason 改名 `max-posts` | 试次必须记在"结果真的发生"上。★ 防无限循环靠 `deadline`（30s 硬界），**不是**这个上限 ⇒ 挪动它不影响兜底 |
| 2 | 点击回调加 `clickPending` 防重入 | MutationObserver 与 800ms 轮询此前没有互斥，两次点击可能同时挂起 |
| 3 | 用户「点按钮」与「改凭据」**分离**：前者**让位不抢**（仍观察服务端反馈），后者才硬停手 | 此前两者都置 `takenOver` ⇒ 用户在填充完成前手点一下，自动流程就**永久退出**，之后密码没填、校验报错、再点也无效 |
| 4 | 按钮消失时把**用户点击**也算"已交付" | 此前只认 `posts > 0` ⇒ "用户自己点成功了"会被当成"还没交付"而空跑到 30s |
| 5 | 点击落地前补查按钮 `disabled` | 与齐备/回读检查同一族：能当场读到的就不要再猜 |

### 判据

- `npm run typecheck` exit 0；`npm run build` BUILD_OK；`npm run check-deps` DEP_OK
- `verify-log-redaction` **121/121**、`verify-forensics-redaction` **25/25**
  （事件载荷新增 `posts` / `userClicked` 字段，必须确认不泄凭据）
- `tmp/verify-authorace.mjs`（本轮新增，**临时脚本，未入库**）：基线产物与修复产物
  各自独有的标记逐条核对 —— **六条按预期区分**（判据不是恒真断言）

### ★★ 诚实标注（本轮最贵的教训在验证侧，不在代码侧）

- **"空密码提交"没有实证。** 当前实现里回读与点击是**同一次同步执行**，中间没有可插入的
  窗口 ⇒ 用 mock 平台构造"读通过、POST 时值已失效"的场景**试了三种构造全部失败**
  （定时器清值 / 整段 `srcdoc` 重挂 / 挂钩 `value` setter 均未命中）。真机上仍需一份
  `ql:forensics` 诊断包才能定位（口径见 `docs/FEASIBILITY-SSO-QUICKLOGIN.md` §7.1）。
- **三次"反证不变红"里，前两次是空转。** `git show HEAD:… > 文件` 的写入没有在构建前生效，
  于是拿去跑的"旧实现"**逐字节等于修复版**；另一次静态判据用正则 `/posts\+\+/` 去证"新增"，
  而它被 `attempts++` **子串满足**。⇒ 已落成两条纪律：**跑反证前先断言基线产物含旧标记、
  不含新标记**；**静态判据的每个词都要带词边界**。详见 `docs/PITFALLS.md` #39 的「推广」。
- **回归门禁 `verify-fillrhythm` / `verify-autologin` 在本机跑不动**（`par.create` 需要
  真实云端账号库，`cloud-store.ts:557`）。用干净档案直接跑会在 `par.create` 处
  `Cannot read properties of undefined` —— 与 4.1.3 记录的同一环境限制。
  ⇒ **这两条门禁本轮未通过，属"未验证"，不是"已通过"。**

### 顺带发现（未修，不在本轮范围）

- `content/auto-login.ts` 末尾的 `sb:autoLogin` 监听器，全仓**没有任何发送方**
  （`CONTENT_MESSAGE.autoLogin` 只有那一处 `===` 比较，无 `sendMessage` 发送它）
  ⇒ 该分支是活的但**不可达**。
  ★ 我一度据此写成"`verify-defectfix` 的 B 组锚点落空、一直在空转" —— **那是错的**：
  我只 grep 了 `content/`，而 `service-worker.ts` 里同样含这两个字符串，B 组实测
  **3/3 通过**。教训同本轮主题：**"我看到的是全部"与"我看到的是我搜过的那部分"不是一回事。**

## 4.1.3（2026-10-12）

**排查 Edge 卡死报告的准备工作：让"平面补丁没装上"这件事可见 + 纠正一处未验证的文档声明。**

> ★ **本次不修任何用户可见的行为**，也不声称解决了 Edge 卡死 ——
> **根因尚未找到**（缺崩溃转储）。本次只做两件"下次能定位"的事，
> 以及一件"别再误导人"的事。

### 背景：Edge 卡死报告（未定位）

用户报告"扩展装到 Edge 上，打开账号时卡死 / 闪退"。实测（Edge 155，干净 profile）：

| 检查 | Edge 155 | Chrome（对照） |
|---|---|---|
| 扩展 SW 启动 | ✅ 7ms | ✅ 25ms |
| 从扩展页面发消息 | ✅ 253ms | ✅ 325ms |
| 打开真实站点 | ✅ 5.2s | 6.3s |
| **渲染进程崩溃** | **无** | 无 |
| 9 个用到的 API | ✅ 全部可用 | — |

⇒ **干净环境下未复现**。所以本次**不给结论**，只装好"下次能取证的装置"。

★ 排查中我自己下过一个**错结论**（"Edge 上扩展收不到消息"）—— 补了对照组后发现
Chrome 同样失败，说明是我的探测方式有问题（SW 给自己发消息不回环）。
已作废并记入 `docs/PITFALLS.md` **#37**。**教训：没有对照组的"没反应"证明不了任何东西。**

### 改动

| # | 改动 | 为什么 |
|---|---|---|
| 1 | `patch()` **记账**：每个 `+key` / `-key` 进 `patchLedger`，激活后经桥上报，落 `ql:forensics` 的 `shieldPatch` | `patch()` 遇到不可配置的内建属性时**完全静默** ⇒ "隔离开着但那一层没生效"与"一切正常"在诊断上无法区分。这是本项目最贵的失效形态（表现为"平台抽风"而非报错） |
| 2 | `docs/USER-MANUAL.md` 的 Edge 说明：从"Edge 同样支持"改成"**未经完整验证 + 已知卡死报告 + 怎么取崩溃证据**" | 代码里**零处 Edge 验证**，而文档在教用户装载 ⇒ 出问题时用户先怀疑自己。**未验证的支持声明本身就是缺陷** |
| 3 | `docs/PITFALLS.md` 新增 **#37**（无对照组的结论不可用）与 **#38**（`patch()` 静默跳过） | 前者是判据纪律（我差点把错结论写进文档），后者是真实缺陷（**未修**，现只做到"可被看见"） |

### 判据

- `npm run typecheck` exit 0；`npm run build` BUILD_OK
- `verify-defectfix` / `verify-acct-grid` / `verify-deadprotocol` / `check-deps` 全绿
- `verify-agents-budget` **11/11**（坑数 36 → 38 已同步到 `AGENTS.md`）
- `run-all.mjs --browser` **18/29**，与改动前**逐条一致** ⇒ 无回归
  （失败的 11 个全部依赖 `par.create` / `par.open`，即需扩展已登录云端的真实环境 —— 见 #37）

### 仍未做（诚实标注）

- **Edge 卡死根因未找到。** 需要：`edge://crashes/` 的 `EXCEPTION_` 码，或
  `eventvwr.msc` 里的 `Application Error` 记录。
- **`patch()` 仍然不重试、不降级、不告警** —— 现在只是"可被看见"，不是"被解决了"。
- **一个待评估的高风险面**：`content_scripts` 是 `document_start` + `all_frames: true`，
  4 个脚本合计 **37.2 KB / 每帧**（其中 `shield-main.js` 19.6 KB 在 MAIN world 打补丁）。
  Edge 为 subframe 起更多进程 ⇒ 帧多的页面上代价更高。**收窄 `all_frames` 会动到
  自动填表主链路（密码框在同源 `srcdoc` iframe 里），必须先读懂再改，故本次不动。**

## 4.1.2（2026-10-12）

**另外两个轮盘也改为定尺网格；并修掉"切到空盒子后滚轮失效"的死角。**

用户在真机上测出两个问题，本次一并处理：

| # | 问题 | 根因 | 处置 |
|---|---|---|---|
| 1 | 生命周期状态（Alt+W）与常用地址（Alt+1）**仍是旧环形** | v4.1 只改了账号轮盘，那两个走的是 `ring-wheel.ts`（另一套渲染器）；`favorites-core` 里**同样有 `n > 10` 的截断** | 两者都改为定尺网格；删除 `ring-wheel.ts` |
| 2 | **切到空盒子后滚轮失效** | 滚轮守卫写成了"**这一页有没有内容**"——而空页"没内容可滚"**不等于**"不许切页"，于是用户**被困在空页里出不来** | 抽出 `wheelIntent()` 纯函数：空页 / 不足一屏 / 已滚到边界 ⇒ **一律切页** |

### 一、统一到一份内核

| 文件 | 角色 |
|---|---|
| `ui/wheel/item-grid.ts` | **唯一的定尺网格内核**（5 列 × 4 行 = 20 格、占位格、滚轮语义、空态、页脚） |
| `ui/wheel/grid-core.ts` | 账号适配层（运行态文字、盒子分页口径） |
| `ui/wheel/status-core.ts` | 状态适配层（当前状态高亮） |
| `ui/wheel/favorites-core.ts` | 书签适配层（标出将打开的域名） |

★ 三个适配层都**只放各自特有**的东西，排版/交互/滚轮**共用一份** ⇒ 改一处三处生效。

### 二、★★ 样式源统一（顺手消灭一处长期重复）

网格要给**四个表面**用，而注入方式天然不同：小窗用 `<link>`（要 `.css` 文件），
三个页内浮层在 **Shadow DOM** 里**只能内联**。此前是各写一份 ⇒ **漏一条就少一块样式且不报错**。

现在：`ui/wheel/grid-style.ts` 是**唯一源**，`scripts/build.mjs` 构建时把它写成
`acct-grid.css` 供 `<link>` 引用，浮层直接 `import` 同一个字符串
⇒ **同一份字节，不可能漂移**。判据逐字节比对两者。

★ 顺带删掉：`wheel-overlay.ts` 里**整段抄了一遍**的外壳样式（120 行）、
`ring-wheel-style.ts` 的环形样式、以及 `wheel-core.ts` 里**已无使用者**的径向原语
（`polar` / `sectorPath` / `radialText` / `el` / `SIZE` / `C` / `R_OUT` / `R_IN`）。
留着它们的代价不是几行，而是**让人以为还有地方在画环**。

### 三、新增/升级判据（`verify-acct-grid.mjs`）

```
① 源码：无 slice(0,N) 截断；buildSectorWheel / buildRingWheel / 径向原语 全部零命中
② 样式：acct-grid.css == grid-style.ts 常量（逐字节）；dist 与源一致；
        三个浮层都引用**共用常量**且无第二份内联样式
③ wheelIntent 纯函数 7 个边界用例：★ 空页双向都必须判 'page'
④ 运行期：18 项 → 18 格；26 项 → 全部进 DOM 且可滚动；行数恒 4；槽位恒 20；
        8 与 18 项首格几何逐项相同；★ **真机滚轮：通桥 → 空盒子 → 内网**（不再被困）
```

★★ **写这条判据时我又错了两次**（都记在注释里）：
① 位置比较最初用 `getBoundingClientRect().top`，而判据在同一个 body 里连续渲染 4 次、
它们**纵向堆叠** ⇒ 视口坐标当然不同 ⇒ 假红；
② 注入滚动意图判定最初**无条件 `preventDefault()` 才判意图** ⇒ 意图为 `'scroll'` 时
原生滚动已被禁掉 ⇒ "让列表自己滚"永远不成立（静默失效）。
⇒ 同一条教训第三次：**判据红了先怀疑量法与顺序，再怀疑结论**。

### 四、用户手册同步

`docs/USER-MANUAL.md` 的第八章整节重写（原文还在讲"一圈最多 10 个 / 中心 Hub /
右侧 120° 弧轨道"，**与现状相反**）；快捷键表补上 Alt+W / Alt+1；
"已知边界"里那条"单盒最多展示 10 个"改成"超过 20 个需滚动"。

### 五、门禁

```
npm run typecheck / build / check-deps   → 全绿（构建会生成 acct-grid.css）
verify-acct-grid                         → OK（四组，含真机滚轮场景）
verify-user-docs                         → 7/7
verify-load                              → 17/17
全量 17/17 判据通过
```

> ⚠️ 仍**未做真机点击验收**（账号/状态/书签数据都依赖云端或真实平台）——
> "点一下真的切过去了"须人工走一遍。这次请顺带验**空盒子滚动**那个场景。

## 4.1.1（2026-10-12）

**单盒按 20 个定尺：5 列 × 4 行，槽位恒定。**

### 一、为什么能定尺

小窗固定 **720×760**（`service-worker.ts` 的 `WHEEL_W/H`，内容区约 704 宽）⇒
**5 列 × 4 行 = 20 格**一屏放得下、**不需要滚动**。而单盒上限按 20 设计 ⇒
网格几何可以写死，不再"按账号数自适应"。

### 二、改了什么

| 项 | 改前（4.1.0） | 改后 |
|---|---|---|
| 槽位数 | 随账号数变化（18 个 = 18 格） | **恒为 20**，不足补**占位格**（虚线、不可点、无角标、不进 tab 序） |
| 行高 | `min-height: 62px`（内容撑） | **`grid-auto-rows: 74px`** 固定 ⇒ 账号名长短不影响格高 |
| 列宽 | `minmax(0,1fr)` | 不变（随容器均分，5 列） |
| 间距 | 7px | 8px（配合固定行高） |
| 标题栏 | `18 个账号 · 第 1/2 盒` | **`18/20 个 · 在线 10 · 盒 1/2`**（容量口径 + 在线数） |
| 滚动 | `max-height: 62vh` | `66vh` —— ★ **保留为安全网**：万一某盒超过 20 个，溢出是**滚动**而不是被裁掉 |

★ **分母取 `max(20, 实际数)`**：某盒真有 26 个时写 `26/26` 而不是 `26/20`
—— 后者会读成"超编了"，而实际是"这盒确实有 26 个，网格滚动显示"。

### 三、这一版真正的收益

**几何稳定。** 8 个账号与 18 个账号的**首格尺寸、位置、行数逐项相同**
（实测 `[139, 73, 2]` 两者一致、行数都是 4）⇒ 切换盒子时**不会整页重排**，
视线不需要重新找位置。这是"定尺"相对"自适应"的全部意义。

### 四、判据（不变量，已进 `verify-acct-grid.mjs`）

```
① 槽位总数恒为 20（cells + slots == 20）
② 行数恒为 4
③ 正好 20 个时不出现占位格
④ ★ 8 个与 18 个的**首格几何逐项相同**
⑤ 26 个时全部进 DOM 且可滚动（绝不截断）
⑥ 标题栏容量口径形如 `N/20 个 · 在线 M`
```

★★ **写 ④ 时判据自己错了一次**：我原本用 `getBoundingClientRect().top` 比位置，
而判据在同一个 body 里连续渲染 4 次（8/18/20/26），它们**纵向堆叠**
⇒ 视口坐标当然不同 ⇒ **假红**（报"几何随账号数变了"）。
改用**相对容器**的 `offsetTop` 后才是真判据。教训同 `PITFALLS #35/#36`：
**判据红了先怀疑输入与量法，再怀疑结论。**

### 五、门禁

```
npm run typecheck / build / check-deps        → 全绿
node tools/verify/verify-acct-grid.mjs        → RESULT: OK（四组）
node tools/verify/verify-load.mjs             → 17/17
全量 17/17 判据通过
```

> ⚠️ 仍**未做真机点击验收**（账号数据走云端，验证档案里为空）——
> "点一个账号真的切过去了"须人工走一遍。

## 4.1.0（2026-10-12）

**账号选择器由「环形轮盘」改为「网格平铺」——直接消掉两条结构性痛点。**

### 一、为什么要换（两条痛点同源）

| 痛点 | 机理 | 性质 |
|---|---|---|
| **只显示 10 个** | `WHEEL_MAX = 10` 是**硬上限**，超出直接 `slice(0, 10)` **丢弃**，只在 Hub 写一行"仅显示前 10 个" | 实现选择（可修） |
| **文字随位置倾斜** | 径向标签必须沿切线 `rotate(mid)`，左半侧再翻 180° ⇒ 用户要先"找到角度"再"辨认文字" | **极坐标的固有属性**（不可修） |

★ 第二条有研究背书：径向菜单的固有劣势就是"能放在圆周上的选项数量有限"
（Založa 等 2024）；其舒适区约在 **8 个以内**。而网格是**水平扫读** ⇒
既不需要旋转视角，也不需要截断。

### 二、改了什么

| 文件 | 变更 |
|---|---|
| `ui/wheel/grid-core.ts` | **新增**：网格渲染器（`buildAccountGrid`）。**全部账号都渲染**，超出改为**滚动**；账号色竖条 + 运行态文字；标题栏（‹ 盒名 · 计数 ›）+ 页码点 + 数字键角标 |
| `ui/wheel/acct-grid.css` | **新增**：网格样式（小窗 `<link>` 引入） |
| `ui/wheel/wheel-core.ts` | **删除** `SectorWheelOpts` / `buildSectorWheel` / `WHEEL_MAX`（约 204 行）。**保留**几何原语（`SIZE`/`C`/`R_OUT`/`R_IN`/`polar`/`sectorPath`/`radialText`/`el`/`truncate`）——**实例状态轮盘仍在用** |
| `ui/wheel/wheel.css` | 删除整套环形样式（`.sector-*` / `.box-track` / `.box-node*` / `.hub-*`，约 175 行）+ 新增网格样式引用 |
| `content/wheel-overlay.ts` | 环形内联样式 → 网格内联样式（Shadow DOM 拿不到 `<link>`，**必须两处都有**）；提示文案同步 |
| `ui/wheel/wheel.ts` | 只改一行：`buildSectorWheel` → `buildAccountGrid` |

★★ **两个调用点（小窗 / 页内浮层）的调用方式没变** —— 盒子即一页、数字键 1-9/0、
滚轮/点击切盒、`emptyAction`、`.in` 入场类名**全部保留**。
**实例状态轮盘（Alt+W）这次没有改**，仍是环形 —— 两个轮盘现在用不同布局。

### 三、行为差异（用户可见）

| 场景 | 改前 | 改后 |
|---|---|---|
| 一个盒子有 14 个账号 | 只看到 **10** 个，其余**静默丢失** | **14 个全部可见** |
| 一个盒子有 30 个账号 | 只看到 10 个 | 30 个全在 DOM，**装不下则滚动**（账号都够得到） |
| 账号名文字 | 沿环倾斜，左右相反、上下近竖排 | **全部水平** |
| 第 11 个及以后 | 无法选中（根本没渲染） | **可点击选中**；数字键只覆盖前 10 个，页脚**明说**这件事 |
| 状态 | 小圆点（在线/离线） | **文字**：在线 ×N / 待登录 / 离线 / 未授权·已暂停 |

★ **为什么数字键只覆盖前 10 个**：键位只有 `1-9` + `0`。这是**刻意的取舍** ——
宁可少一个快捷方式，也**不静默丢账号**；并且把边界写在界面上，不让用户自己猜。

### 四、新增判据

`tools/verify/verify-acct-grid.mjs`（**真起 Chromium**）：
① 源码不得再对账号列表 `slice(0, N)`、`WHEEL_MAX`/`buildSectorWheel` 必须已清除；
② **两份样式类名集合必须一致**（小窗 CSS vs 浮层内联 —— 漏一条就少一块样式）；
③ 运行期：**18 个账号必须渲染 18 格**、第 18 个必须在 DOM 里、数字键角标恰好 10 个、
页脚明说边界、账号名**零旋转**；**30 个时全部进 DOM 且装不下可滚动**。

★★ 这条判据只能靠**计数**：截图里少 8 个账号，人眼不一定数得出来（它们本来被排成环形）。

### 五、门禁实测（本机 Node 24.19.0）

```
npm run typecheck                              → 0 错误
npm run build                                  → BUILD_OK
npm run check-deps                             → 0 幽灵依赖
node tools/verify/verify-acct-grid.mjs         → RESULT: OK（含 18/18 与 30/30 计数）
node tools/verify/verify-load.mjs              → 17/17（真起 Chromium --load-extension）
全量静态判据 + 浏览器判据 17/17 全绿
```

★ 另外做了两次**真机视觉核验**（非自动化）：真起 Chromium 打开
`chrome-extension://<id>/ui/wheel/wheel.html`，确认
① 页面初始化出 `.acct-grid`，标题栏/空态都在，**无未捕获错误**，
② **旧环形的类（`.sector` / `.hub-bg` / `.box-track`）零残留**。

> ⚠️ **未做真机点击验收**：账号数据走云端（v3.18 起 `par.list` 需云端授权），
> 验证档案里必然为空 ⇒ **"点一个账号真的切过去了"这件事仍须人工走一遍**。
> 上面的 18/18 用的是合成数据渲染真实模块，验的是**渲染**，不是数据链。



**清理死协议（8 处），并把"死协议"这件事变成一条**能红的判据**。**

起因是 4.0.1 的审计列出一批"有定义、有处理分支、**没有任何人会走到**"的协议。
它们**不报错、`typecheck` 与 `build` 全绿**，只是永远不被走到 ——
而读代码的人会以为存在一条真实通路。

### 一、删了什么（每项都给了判据）

| 项 | 连带删除 |
|---|---|
| `site.grants.list` / `site.grant.add` / `wheel.toggle` | `messages.ts` 的 3 组 kind/响应类型 + `dispatch` 的 3 个 case |
| `cloud.auth`（标了 `@deprecated` 却零发送方） | `exchangeDeviceCode()`（`cloud-store.ts`）+ SW 的 import 与 case |
| `CloudMergeReport` | 仅类型（产生它的 `cloud.migrate` 早随 v3.18 删除） |
| `registerAuthHandlers()` | **整块闭包**：`MENU_ID` / `hostPattern` / `writeGrants` / `grant()` / `grantCurrentTab()` / `extractHost()` —— 连带那个**从未注册**的右键菜单与 `add_current_site` 快捷键监听 |
| `okOf()` | `send.ts` 里对 `Result` 的 import（`noUnusedLocals` 会抓到） |

★ 删完后 `verify-deadprotocol` 实测：**26 → 25 个 kind，零死协议**。
★ **活的东西一件没动**：`siteAuth.list()`（备份导出在用）、`toggleAccountWheel`（Alt+Q 在用）、
`siteKey` / `readGrants` / `probeScheme` / `parseSiteInput` 全部保留 —— 按**规则 18** 与 HEAD 逐行对照确认。

### 二、新增判据

| 脚本 | 内容 |
|---|---|
| `tools/verify/verify-deadprotocol.mjs` | **双向查**：每个 kind 能否报出**发送方**、每个上行 op 能否报出**处理分支**。只出现在定义文件 ⇒ 类型孤儿；只出现在定义 + 处理文件 ⇒ 零发送方 |
| `tools/verify/_lib/strip-comments.mjs` | ★ **字符串感知**的注释剥离器（公共件，不是判据） |

### 三、★★ 两个"判据自己错了"的坑（都已立档）

清理过程中门禁红了两次，**两次都不是代码错了**：

1. **`PITFALLS #35` —— 注释剥离器吃掉了活代码。**
   非贪婪块注释正则**会跨字符串字面量**匹配：`parallel.ts` 里的模板串含注释起始符，
   让它以为注释从此开始，一路吃掉 **3082 字符**活代码 ⇒ 死协议判据把**有发送方**的
   `data.import` 报成"零发送方"（**假红**）。⇒ 抽出字符串感知的剥离器，两个脚本改接。
   **判据的输入被污染时，它比没有判据更坏** —— 没有判据时你知道自己不知道；
   判据错时你会去改一个没坏的东西。

2. **`PITFALLS #36` —— `git stash` 把 18 个文件的 LF 改成 CRLF。**
   为验证"某个浏览器回归的失败是不是我造成的"，我 `git stash` 一次跑基线再 `pop`。
   本仓 `core.autocrlf=true` 且**没有 `.gitattributes`**，而仓库里两种行尾并存
   ⇒ `pop` 把 18 个 LF 文件全变成 CRLF：`git diff` 从 ~600 行膨胀到"每行都改了"，
   而 `verify-log-redaction` 的抽取正则因为要找 `;` + **LF** 而匹配失败 ⇒ **三条判据假红**。
   ⇒ `tmp/fix-eol.mjs` 按 HEAD 的原始 blob 逐文件对齐；18 个文件全部恢复。

★ 两条的教训相同：**判据红了先怀疑输入，再怀疑结论。**

### 四、那个"不是我造成的"失败（本次顺带证明）

`verify-defect.mjs` 崩在 `par.create` 返回 `undefined`。我用 `git stash` 把代码退回
**未改动的 HEAD** 跑同一条脚本 —— **同样崩在同一行** ⇒ 它是**既有的环境依赖问题**
（v3.18 起 `par.create` 要求云端授权，而验证档案里没有云端账号），
**不是本次改动引入的**。该脚本需要单独修（给它一条不依赖云端的路径），**本次未动**。

### 五、门禁实测（本机 Node 24.19.0）

```
npm run typecheck                              → 0 错误
npm run build                                  → BUILD_OK
npm run check-deps                             → 0 幽灵依赖
node tools/verify/verify-load.mjs              → 17/17（真起 Chromium --load-extension）
静态判据 15/15 全绿（含反证脚本 23/23、3/3、4/4、5/5、6/6）
node tools/verify/verify-deadprotocol.mjs      → RESULT: OK（25 kinds + 11 ops 零死协议）
```

> ⚠️ `verify-defect.mjs` / `verify-jarhygiene.mjs` 等**浏览器回归需要云端授权或真实环境**，
> 本机跑不通 —— 上面那条"17/17"是**装载冒烟**，它**不覆盖**登录/列表/盒子/设备流。
> 删协议这类改动**改变了消息面**，所以仍建议人工走一遍：打开账号 → 自动填表 →
> **备份导出**（它用到 `siteAuth.list()`，是本次唯一受影响的活跃路径）。

## 4.0.1（2026-10-12）

**修六个"修好之后 `typecheck` 与 `build` 照样全绿"的缺陷，并给每条配上**能红的判据**。**

起因是按「功能完整性 / 可维护性」两个维度对全仓做了一次审计：
本次修的全部不是类型错误，而是**两个事实不一致**、**走了补丁版 API**、
**文案指向不存在的控件**、**静默失败**这四类 —— 它们共同的危险是**没有信号**。

### 一、修了什么

| # | 缺陷 | 根因（一句话） | 位置 |
|---|---|---|---|
| 1 | `par.open` 恒返回 `reused: false` | 正确值在函数开头**已算过一次**（给 forensics），`return` 处又写了一遍字面量 ⇒ **同一事实两个来源** | `core/parallel-session.ts` |
| 2 | 叛逃清扫 `nsWipeShared()` **一个库都没删过** | 它读的 `indexedDB.databases()` / `caches.keys()` **已被本扩展打了补丁**（剥掉 ns 前缀）⇒ `startsWith(ns)` 恒 false；而补丁版 `deleteDatabase()` 还会**再加一次**前缀 | `content/shield-main.ts` |
| 3 | 明文账密对绑定页签内**任意 iframe** 可见 60 秒 | `sb:autoLoginRequest` 只校验 `sender.tab.id`、**不校验 frame**，而 `auto-login.js` 是 `all_frames: true` | `background/service-worker.ts` |
| 4 | 四处报错文案指向**已废除的"数据源"控件** | v3.18 删了数据源切换，文案未同步 ⇒ 用户按提示**找不到任何入口** | `cloud-store.ts` ×3、`parallel.ts` ×1 |
| 5 | 管理页**每 3 秒无条件写一次磁盘** | `loadSites()` 由 `setInterval(…, 3000)` 驱动，而它每次都 `storage.local.set({ql:blockedHosts})` | `ui/parallel/parallel.ts` |
| 6 | `send()` 把 `undefined` 交给调用点 ⇒ `refreshAll()` 中途抛错、页面停在半旧状态 | 既不读 `chrome.runtime.lastError`、也不设超时；无接收端时回调收到 `undefined` | `ui/send.ts` |

★ 修 #3 时**刻意没有一刀切 `frameId === 0`**：目标站的**密码框就在同源 `srcdoc` iframe 里**
（`auto-login.ts` 文件头），而 `<all_urls>` 不注入 `about:srcdoc` ⇒ 一刀切会打断自动填表主链路。
⇒ 判据改为**来源域匹配**（frame 的 origin host 必须等于该页签绑定的站点 host），
两侧都过 `hostNoPortOf`（内网站点带端口），取不到 origin 时 **fail-closed**。

### 二、顺带接上两条**断了的上行**

- `journalRollbackDone`：壳**一直在发**，后台**从来没有处理分支** ⇒ 叛逃回滚的"完成"在取证里完全不可见。已补 `forensics` 分支。
- 新增 `nsWipeSharedDone` 回执：清扫此前**完全静默**，而"清掉了 0 个"与"清扫根本没生效"
  在取证里**长得一模一样** —— 这正是缺陷 #2 能藏这么久的原因。

### 三、新增验证资产（这是本次的重点）

| 脚本 | 内容 |
|---|---|
| `tools/verify/verify-defectfix.mjs` | 上述六个缺陷的**回归判据**（静态、秒级）。六组断言，逐条写明"拆掉什么它会红" |
| `tools/verify/verify-falsify-defectfix.mjs` | ↑ 的**反证 6/6**：把仓库复制到 `tmp/`，逐个注入"修复前"的写法，要求**变红且红在对的那一节**；真实工作区**从未被改动** |

★★ **写这两条判据的过程本身就是一次教训**，四处错误**全部表现为"判据绿"或"报出不存在的缺陷"**：

1. **读到自己的注释**：断言扫全文件，而被修复说明里**逐字引用了旧写法**（`reused: false`、
   `indexedDB.databases()`）⇒ 断言被自己的说明文字喂饱。**六组里有两组**栽在这上面。
2. **范围截断**：用 `/\n\}/` 取函数体收尾，而 `loadSites` 里**有缩进为 0 的内部块**
   ⇒ 取到的"函数体"截断在第一个内部块，**守卫在截断点之后** ⇒ 判据报"没有守卫"（假红）。
   后改为**花括号配平**，且**必须在未剥注释的原文上配平**（`stripComments` 会跨字符串字面量误吃真实代码）。
3. **锚点不唯一**：`String.replace` 只改第一处，而我的锚点短语在文件里出现两次
   ⇒ 注入落在不相干的字符串上，判据"没变红"被误读成"判据恒真"。现 `poke()` 会**数出现次数**，不是 1 就明确失败。
4. **范围没划到函数体**：`send()` 的断言扫全文件，而注入的做法是把旧实现**另起一个函数名**放回文件里
   ⇒ 字符串仍在，断言照样绿。现改为**限定在 `send` 的函数体内**。

⇒ 这四条与规则 23 同源：**判据的范围没划对，结论必然是错的 —— 而且错得像是发现了缺陷。**

### 四、文档同步（规则 12 / 27 / 34）

- `docs/PITFALLS.md`：新增 **#32**（同一事实被算两次）、**#33**（补丁后 API 的两副面孔）、
  **#34**（废功能时只删了使用方 ⇒ 死协议）⇒ **31 → 34 条**。
- `docs/RULES.md` 规则 30 追加**对偶方向**（"协议在、没人发"）与实测清单。
- `tools/verify/README.md`：**补收两个在盘上却从未进表**的脚本
  （`verify-agents-budget` / `verify-boxsync`）；修正 `verify-icons` 的 `39/39 → 42/42`；
  脚本数 `24 → 26`；并写明"数量以 `run-all.mjs --list` 为准"。
- `AGENTS.md` / `run-all.mjs`：删掉写死的"跑全部 **12** 个"（实际 26），改为指向 `verify:list`；
  订正"每个脚本都真起 Chromium"这句（**只有浏览器回归真起**，其余是纯静态秒级）。

### 五、门禁实测（本机 Node 24.19.0）

```
npm run typecheck                              → 0 错误
npm run build                                  → BUILD_OK（11 入口）
npm run check-deps                             → 0 幽灵依赖
node tools/verify/verify-defectfix.mjs         → RESULT: OK（六组）
node tools/verify/verify-falsify-defectfix.mjs → 6/6 反证通过（真实源码未被改动）
node tools/verify/verify-boxsync.mjs           → RESULT: OK
node tools/verify/verify-log-redaction.mjs     → 121/121
node tools/verify/verify-falsify-logredaction.mjs → 23/23
node tools/verify/verify-forensics-redaction.mjs  → 25/25
node tools/verify/verify-falsify-forensics.mjs    → 3/3
node tools/verify/verify-icons.mjs             → 42/42
node tools/verify/verify-falsify-icons.mjs     → 4/4
node tools/verify/verify-user-docs.mjs         → 7/7
node tools/verify/verify-falsify-userdocs.mjs  → 5/5
node tools/verify/verify-css-vars.mjs          → 22/22
node tools/verify/verify-brand.mjs             → 10/10
node tools/verify/verify-agents-budget.mjs     → 11/11
```

> ⚠️ **未做真机验收**：本次全部判据都是**静态**的，它们只能证明"写法还在"，
> **不能证明**"凭据真的只交给了本站点的 frame""清扫真的删掉了库"。
> 那两件事需要真起 Chromium + 真实云端/内网环境 ⇒ **仍须人工走一遍**
> （登录 / 自动填表 / 一个账号登出后重开的叛逃处置）。

> **尚未处理（已知的死协议）**：`site.grants.list` / `site.grant.add` / `wheel.toggle`
> 有 handler 却**零发送方**；`CloudMergeReport` 是类型孤儿；`okOf()` 零调用点；
> `registerAuthHandlers()` 全仓无调用点（⇒ 右键菜单「将当前站点添加为会话站点」从未注册）。
> 清单与判据写在 `docs/PITFALLS.md` **#34**。删除时按**规则 18** 与 HEAD 逐行对照。


## 4.0.0（2026-10-11）

**更名：`quick-login` → `akso-pass`；品牌名 `QuickLogin` → Akso Pass。** 主版本号（3.17.1 → 4.0.0）的依据不是改名本身，而是 3.18 已完成、本次才随版本号固化下来的**本地数据源整体废除**（见 §6）：一个被移除的能力 + 一个更名后的对外标识，按语义化版本都属于"不兼容变更"。

### 一、改了什么

| 类别 | 内容 |
|---|---|
| 展示名 | `manifest.json`：`name` → `Akso Pass · 多账号并行`、`short_name` → `Akso Pass`、`action.default_title` → `Akso Pass · 多账号并行`；`ui/popup/popup.html` 与 `ui/parallel/parallel.html` 的 `<h1>` → `Akso Pass` |
| 包标识 | 根 `package.json` 的 `name` → `akso-pass`、`description` → `Akso Pass：…（七平面隔离 + 账号轮盘）`（原文写「六平面」，实测为 **7** 个平面，见 `docs/CODEBASE_OVERVIEW.md` §Architecture）；**`package-lock.json` 顶层两处 `name` 同步**（否则 `npm ci` 报 lock 与 package.json 不一致） |
| 版本号三处 | `package.json` / `packages/extension/manifest.json` / `src/shared/constants.ts` 的 `EXT_VERSION`：`3.17.1` → **`4.0.0`**（本仓规则 7） |
| 产物命名 | `.gitignore`：新增 `akso-pass-*.zip`；**保留** `quicklogin-*.zip`（旧包仍在磁盘上，删规则会让它们变成待入库文件） |
| 用户可见字符串 | 备份文件名 `quicklogin-backup-*.json` → `akso-pass-backup-*.json`、诊断包 `quicklogin-diag-*.json` → `akso-pass-diag-*.json`、设备自报名 `Chrome 扩展 · QuickLogin` → `Chrome 扩展 · Akso Pass`、导入报错与停用提示里的品牌名 |
| 文档 | `README.md`（品牌 + 「六平面」→「七平面」并补上漏掉的 **平面 1.5 广播**）、`docs/*.md`、`AGENTS.md`、源码注释；跨仓引用 `akso-vault` → `akso-cloud`（兄弟仓库同期更名，**仅改仓库标识，不改历史叙事**） |

### 二、刻意**没有**改（契约，动一条就是破坏）

| 契约 | 位置 | 为什么不能动 |
|---|---|---|
| `manifest.json` 的 `"key"` | `packages/extension/manifest.json` | 扩展 ID 由它派生 —— 改了等于换一个扩展，用户已装的实例、已授权的站点全部脱钩 |
| **`'quicklogin-backup'`** | `background/service-worker.ts`（×2）、`shared/messages.ts`、`ui/parallel/parallel.ts` | **备份文件格式标识**。它是**文件格式契约**，不是品牌名：改了之后**用户按旧版本导出的备份就再也导不进来** |
| 消息协议前缀 | `ql:*` / `par.*` / `ql:log` / `ql:diag` / `ql:cloudAuth` 等 `LOCAL_KEYS` | 已落盘的用户数据（会话、诊断环形缓冲、授权痕迹）以这些键寻址 |
| `manifest.json` 的 `commands` 键名 | `quick-wheel` / `quick-status` / `quick-favorites` | 用户可能已在 `chrome://extensions/shortcuts` 为这些**键名**自定义过快捷键 |
| `tools/verify/**` 的断言 | 全部验证脚本 | **只改注释与消息字符串里的品牌名，不动任何断言的期望值与条数** |

### 三、门禁实测（本机 Node 24.19.0 / npm 11.17.0）

```
npm run typecheck                        → 0 错误
npm run build                            → BUILD_OK
npm run check-deps                       → 0 幽灵依赖
node tools/verify/verify-load.mjs        → 17/17（真起 Chromium --load-extension）
node tools/verify/verify-log-redaction.mjs → 121/121
node tools/verify/verify-user-docs.mjs   → 7/7
node tools/verify/verify-css-vars.mjs    → 22/22
node tools/verify/verify-brand.mjs       → 10/10
node tools/verify/verify-icons.mjs       → 42/42
```

★ **更名最危险的正是 `verify-load.mjs`**：`manifest.name` / `short_name` 是 Chrome 装载时真正解析的字段，写错（长度、非法字符、与 `key` 冲突）会让扩展**静默装不上**，而 `manifest.json` 的 JSON 依然合法、`check-dist.mjs` 依然绿。⇒ 改名后必须真起浏览器装载一次。

## 3.17.1（2026-10-08）

**排障：Alt+W 唤不出状态轮盘 —— 修 3 处「让故障无法被看见」的缺陷。**

用户报告 Alt+W 无反应。逐段核对实现链路（manifest 命令 → `onCommand` 分发 → `toggleStatusOverlay`
→ `executeScript` 注入 → 浮层挂载）后确认**链路本身是对的**，但沿路有三处缺陷会把真实原因藏起来：

1. **`flashBadge` 在 SW 里用了 `window.setTimeout`**（既有缺陷，v3.13 时代就在）：
   `ServiceWorkerGlobalScope` 没有 `window` → 抛错且被紧邻的 `catch` 吞掉 →
   **角标文本设上去之后永远清不掉**。这直接毁掉了「按键到底有没有到达后台」这条最关键的现场判据。
   改为裸 `setTimeout`。
2. **活动页签查询口径不一致**：账号轮盘用 `{ active: true, lastFocusedWindow: true }`（可用），
   而 v3.15/v3.16 新增的两块轮盘抄了已删除的 `togglePagesOverlay` 的 `currentWindow: true`。
   MV3 的 SW 不属于任何窗口，`currentWindow` 语义不稳（可能查不到页签 → 静默什么都不做）。
   两块新轮盘统一改为 `lastFocusedWindow`。
3. **注入失败完全静默**：`catch {}` 让「命令没绑 / 站点未授权 / 受限页」三种情况在用户眼里
   都是「按了没反应」。现在角标给信号：`—` = 当前页不是普通网页；`⊘` = 注入被拒（该站点未授权）。

**另新增现场判据**：SW 启动时调用 `chrome.commands.getAll()`，把**本机实际生效的快捷键**
写进 `ql:forensics`（`commands: quick-wheel=Alt+Q | quick-status=(未绑定) | …`）——
诊断包里一眼可见，不必再猜。

> **根因提示（Chrome 平台行为，非代码缺陷）**：`suggested_key` 只在扩展**安装**时登记，
> 改 manifest 后「重新加载扩展」**不会重绑**。本会话已有实证：v3.15.0 把 `quick-pages`
> 从 Alt+W 挪到 Alt+E 后，用户按 Alt+W 唤出的**仍是旧功能**——说明 Chrome 保留了旧绑定、
> 也没给新命令 `quick-status` 登记 Alt+W。
> 处置：在 `chrome://extensions/shortcuts` 手动为该命令指定 Alt+W，或卸载后重新加载扩展。

> **验收**：`npm run typecheck` 0 错误、`npm run build` BUILD_OK；
> 产物 `dist/background.js` 中 `window.setTimeout` 命中数 **0**（修复前为 1）。

## 3.17.0（2026-10-08）

**移除配置页监听与主体名页签标注（`page-monitor` 模块整体删除）。**

用户表示这两项都不需要。它们同属 v3.11.0 引入的「配置页监视」能力，本次连同其整条数据链一并拿掉：

| 删除项 | 说明 |
|---|---|
| `background/core/page-monitor.ts` | 整个文件删除（L1 路由分类器、名称表、`applySubject`、`ingestNames`、`tabs.onUpdated` 监听器） |
| 桥上行 `pageNames` | `content/shield-main.ts` 的**名称型 API 嗅探**（`NAME_API_RE` / `extractNamePairs` / `reportPageNames`）与 `BridgeUpPayload` 的 `pageNames` 分支一并删除 |
| `parellel-session` 的 `pageNames` 分发 | `handleBridge` 里对应分支删除 |
| `ql:pageNames` | 存储键随模块消失，存量数据不再读写 |
| 启动装载 | `service-worker.ts` 不再调用 `registerPageMonitorListeners()` |

### 保留：页签名 = 标签标题（核心能力未受影响）

`page-monitor` 只是**额外覆盖**了标题；账号页签标题原本就由独立链路维护，未动：

- `parallel-session.ts` 自己的 `applyTitle()`（`setTabTitle` MAIN 注入 + `sb:setTitle` 消息）——
  在 `open` / `refreshTitle`（改名）/ 收编 / `restore` 四处调用；
- `content/title-hook.ts` 收到 `sb:setTitle` 后持续维持标题（防 SPA 重写）。

**行为差异**：标题从「`账号别名 · 主体名·类型`」回到「`账号别名`」——
即 `添加并行账号` 表单里写的「页签名」原样作为标签标题。

### 顺带修掉一个既有缺陷：重复出网

`shield-main.ts` 的名称嗅探为了给名称表喂数据，会对命中白名单的 GET **再发一次请求**
（`nativeFetch` 被调用两次，第一次的返回值只用于 `clone()` 读取后丢弃）。
该嗅探随本次移除一并消失，**这条重复请求不复存在**（此前记录在 `docs/CODEBASE_OVERVIEW.md` 风险 C13）。

> **验收**：`npm run typecheck` 0 错误、`npm run build` BUILD_OK；产物中
> `BasicObjectDetail` / `GetUserMenuPermission` / `MenuGroup/QueryList` / `pageNames` / `ql:pageNames`
> 命中数均为 0；构建入口与产物文件列表已无 `pages-overlay`。
> ⚠️ 未在真实浏览器中人工验收。

## 3.16.0（2026-10-08）

**移除「最近配置页」；新增「常用页面」书签轮盘（Alt+1）。**

### 一、移除「最近配置页」（v3.11.0 引入，整体删除）

用户报告「按 Alt+W 弹出的仍是最近配置页」，且明确要求去掉该功能。连同它一起删掉的还有整条链路：

- 命令 `quick-pages`（建议键 Alt+E）从 `manifest.commands` 删除；
- `content/pages-overlay.ts` 文件删除，构建入口一并移除；
- 协议 `pages.recent` / `pages.jump` 与类型 `RecentPageEntry` 删除；
- `page-monitor.ts` 里的 MRU 记录（`recordRecent`）、`recentForTab()`、`jumpCurrentTab()` 删除；
- 存储键 `ql:recentPages` 与常量 `RECENT_PAGES_MAX` 删除（存量键不再读写，留在 storage 里不影响功能）。

> **保留**：`page-monitor.ts` 的 **L1 路由分类器 + 名称表 + 复合页签标题**（`账号别名 · 主体名·类型`）。
> 那是「页签标注」能力，与「最近配置页」是两件事，本次未动。

**若按 Alt+W 仍弹出旧浮层**：说明浏览器还挂着上一版的命令绑定。请在 `chrome://extensions` 对本扩展点「重新加载」；
仍不行就到 `chrome://extensions/shortcuts` 看该扩展的快捷键列表（`quick-pages` 应当已经消失）。
命令的 suggested_key 只在扩展加载时登记，改完 manifest 必须重新加载才生效。

### 二、新增「常用页面」书签轮盘（Alt+1）

来源：同事「阿克索配置助手 v2.1.0」评审的 **D1**（`docs/COLLEAGUE-EXT-REVIEW.md`）。与已移除的 MRU 的分工：
**MRU = 「我刚去过哪」（自动记录），书签 = 「我常去哪」（用户显式维护）**。

- 新命令 `quick-favorites`（建议键 **Alt+1**）→ 页面内浮层，与状态轮盘同款外壳；
- 悬停预演「将打开「名称」」→ 点击在新标签页打开，数字键 1-9/0 快选，Esc / 点遮罩关闭；
- 内置默认 6 条平台常用管理页（用户管理 / 角色列表 / 工作流 / 菜单 / 视图 / TraceLog），开箱即用；
- **可在管理页「常用页面」卡片里编辑**：每行 `名称,路径`（英文逗号 / 中文逗号 / 制表符均可），
  路径支持相对路径（`/admin/…`，拼到当前站点 origin）或完整网址；另有「恢复默认」。
- 编辑器**刻意不进 3 秒轮询**——那是用户正在输入的框，轮询回写会冲掉正在敲的内容。

> 同事默认列表里的第 7 条「文件布局」带了他们环境专属的 `form-layout/edit?id=dea246e4-…`，
> 换环境必然 404，故未收录；需要的话在管理页自己加一行即可。

### 三、配套重构（避免制造重复实现）

- 新增 `ui/wheel/ring-wheel.ts`：状态轮盘与书签轮盘共用的**单环轮盘渲染内核**
  （几何 / 扇区 / 编号 / 径向文字 / 空态 / 单元素退化 / Hub 三行）。`status-core.ts` 与
  `favorites-core.ts` 退化为薄适配层。抽出来的原因很直接：两块轮盘除数据外完全同构，
  复制两份等于把评审里点出的「同一段逻辑多处维护」问题再制造一遍。
- 新增 `ui/wheel/ring-wheel-style.ts`：两块浮层共用的样式表（此前各写一份）。
- 账号轮盘（`wheel-core.ts`）**行为零改动**，只是把几何原语导出（`polar`/`sectorPath`/`el`/
  `radialText`/`truncate` 与 `SIZE`/`C`/`R_OUT`/`R_IN`）供内核复用。

> **验收**：`npm run typecheck` 0 错误、`npm run build` BUILD_OK；产物含 `content/favorites-overlay.js`，
> 不含 `content/pages-overlay.js`；`manifest.commands` 为 3 条（Alt+Q / Alt+W / Alt+1）。
> ⚠️ 状态轮盘与书签轮盘均**未在真实浏览器中人工验收**，视觉与交互待确认。

## 3.15.0（2026-10-08）

**新增：实例状态轮盘（Alt+W）—— 在对象实例页一键查看并切换生命周期状态。**

功能来源：同事的「阿克索配置助手 v2.1.0」评审（见 `docs/COLLEAGUE-EXT-REVIEW.md` 的 B3「状态列表」+ B4「一键改状态」）。
只融合这两项，其余功能点按评审结论搁置。

- **快捷键换位**：`quick-status` 取 **Alt+W**；原「最近配置页轮盘」（v3.11.0 的 `quick-pages`）让位到 **Alt+E**，功能不删。两者都可在 `chrome://extensions/shortcuts` 自改。
- **呼出即用**：在任意**对象实例页**按 Alt+W → 页面内无框浮层（Shadow DOM，与账号轮盘同款视觉：同 viewBox、同扇区/编号/径向文字类名族）；扇区 = 该实例的全部生命周期状态，当前状态以品牌色高亮 + 圆点。
- **点即执行（不弹二次确认）**：悬停扇区时 Hub 预演「将把「当前」改为「X」」，点击即调 `POST /api/openapi/v1.0/Object/status/{instanceId}/{code}`；成功 → toast「已切换为「X」，正在刷新页面…」→ 1.2s 后由后台刷新该页签；失败 → 红色 toast 并**保持浮层打开**，可改选重试。数字键 1-9 快选，Esc / 点遮罩关闭。
- **非实例页给空态**：URL 里没有 `bid`/`id` 时浮层显示「当前页面不是对象实例页」，不再报一堆网络错误。
- **接口链路**（两步，均带 BFS 容错解析，服务端包装层级变了不会立刻失灵）：
  `POST /api/platform/Layout/GetFormInstance` 挖 `lifecycle.id` → `GET /api/config/lifecycle/Status/GetListByBasicId?basicId=` 取状态数组；
  `/web/view?mid=` 页面 objectId 缺失时先用 `GET /api/platform/UserView/GetViewList?menuId=` 反查（评审的 B7，B3 的前置）。
- **平台知识**：URL 的 `bid`=objectId、`id`=instanceId；真实地址可能被百分号编码进 `__iframe=` 参数里，已做解码（评审的 F4）。

### 三处与同事实现**有意不同**的地方（评审 §四 逐条记录的坑，这里都不踩）

1. **请求一律在目标页签的页面主世界发出**（`chrome.scripting.executeScript({world:'MAIN'})`），而不是后台 `fetch`：
   DNR 的 AUTH/COOKIE 规则条件含 `tabIds:[tabId]`，后台请求没有 tabId ⇒ 拿不到本账号 Bearer、也没有 Cookie 回放，会读到共享 jar（跨账号）。走页面世界还顺带吃到 MAIN 壳的 `_qlck` 缓存分区，避开「状态列表命中上一个账号缓存」这条既有泄漏通道。
2. **绝不读 `document.cookie` 取 token**：Cookie 虚拟化补丁打在 MAIN world 的 `document` 上，ISOLATED 世界读到的仍是真实 jar（会话卫生会驱逐身份键 ⇒ 常为空，甚至是他账号残留）。身份交给 DNR 补，本功能不碰任何凭据。
3. **成功判定不猜**：同事实现是「响应体里没有 message 就算成功」，于是 200 + 非 JSON 的网关拦截页会被当成成功并刷掉页面。这里把「非 JSON 响应」单列为失败并如实报出；状态项缺 `code` 时**直接拒绝**，不会像同事实现那样兜底拿 `name` 当 code 发出去。

> **验收**：`npm run typecheck` 0 错误、`npm run build` BUILD_OK（构建产物含 `content/status-overlay.js`）。
> ⚠️ **平台接口与字段名未经真机验证**：`GetFormInstance` 的 `lifecycle.id` 位置、状态项字段名、当前状态字段名均沿用同事实现的形态并做了 BFS 容错；`PUT`/状态码语义以首次实测为准。

## 3.14.1（2026-10-07）

**设备授权改用 RFC 8628 设备流，取代「网页出码、人抄进应用」。**

- 登录云端账号库不再需要用户手抄授权码：`POST /api/auth/device-start` 取回批准页 URL + userCode，扩展直接 `chrome.tabs.create` 打开批准页（**URL 由服务端拼好，扩展不自己拼**），页面侧单循环按服务端下发的 `interval` 轮询 `POST /api/auth/device-poll`，批准后令牌当场落库。**用户一个字都不用抄。**
- `deviceCode` 是换令牌的凭据，**只活在 `cloud-device.ts` 的模块内存**：不进 DOM、不进 storage、不进日志、不回传页面；任何终态或用户取消一律置 null（进程重启即遗忘，这也是服务端 `consumed` 状态存在的原因）。
- 取消 = 世代号 +1 + 唤醒当前一拍，请求返回后再比对一次世代号——**请求期间点取消，令牌绝不会落盘**（否则"取消"就是摆设）。
- 四种终态（denied / expired / consumed / unknown）文案互不相同；**不认识的 status 直接停轮询并报错**，不当作 pending 空转。
- 展示名与头像取自 device-poll 的 `user` 字段，**纯展示、不参与任何鉴权判断**——「头像没取到于是登录失败了」这类荒唐事被结构性排除。
- 「本地 → 云端」切换确认弹窗新增「不再提示」勾选（`ql:skipSwitchConfirm`），并在数据源 `?` 帮助气泡尾部提供**反悔通道**（「已关闭切换确认 · 重新开启」）：没有反悔通道的"不再提示"会把当时并不知情的用户锁死。
- 旧的 `cloud.auth`（手抄授权码 → `/api/auth/device-token`）标记 `@deprecated` 但**予以保留**：端点在服务端还在，删掉这条路径等于替别人做决定。

> **版本号补记**：云端子系统的两次提交（`f62d162` / `d7d66db`）落地时三条版本来源未同步、CHANGELOG 亦未记。3.14.0 / 3.14.1 两条为事后补写，三处版本号（根 `package.json`、`manifest.json`、`src/shared/constants.ts` 的 `EXT_VERSION`）已对齐至 `3.14.1` —— 代码注释中出现的 v3.14 / v3.14.1 即指这两条。

## 3.14.0（2026-10-07）

**数据源切换（本地 ↔ 云端）+ Akso Vault 云端账号库。**

- 管理页新增「本地 / 云端」分段控件；云端账号库走 `https://www.dragonrain.top:8443`（Akso Vault），Bearer 会话，15s 超时。
- **门面模式**：`parallel-store` 保持 **10 个方法签名不变**，按 `ql:dataSource` 分发到 `localStore` / `cloudStore`；两套实现由同一个 `ParallelStore` interface 约束，另有 `cloudStoreContract` 作**编译期同形证明**（少一个方法、签名漂了当场编译不过）。三个调用点一行未改，`localStore` 实现体**逐字节未动**。
- **切换不删数据**：本地 IndexedDB 原样保留，切回本地只改一个布尔标记；云端模式下唯一读本地库的地方是迁移那一次 `db.accounts.list()`。缺省 `local` ⇒ 老用户零迁移、行为与改动前完全一致。
- **失败不静默回落**：`dataSource === 'cloud'` 且网络/授权失败时**一律抛可读错误**，绝不偷偷返回本地旧数据——那会让用户以为在看云端、实际是本地旧数据。401/403 清 `cloudAuth` 但**数据源仍留 'cloud'**，由界面提示「登录已过期，请重新登录」（宁可空窗，也不静默切回本地让人以为账号没了）。
- **合并迁移有两道不可省的核对**（`cloud-migrate.ts`）：① 服务端回报的 `received` 必须等于本地条数；② 云端账号总数必须 ≥ 本地条数。两关都过才写 `dataSource = 'cloud'`——**HTTP 200 不等于数据进去了**（服务端 merge 存在「某条账号因 site_id 不存在被静默跳过」的形态）。核对不过即中止，**本地数据一个字节都没动**。空库也照走核对，不设"跳过"分支。
- 冲突规则：**updatedAt 新的赢**；历史记录缺 `updatedAt` 一律按 `createdAt` 兜底。本地取不到明文口令的账号**计数上报后仍照传**（跳过它会让 `received` 对不上本地条数，核对点就失去意义）。
- 云端缓存：`list()` 5 秒短 TTL、站点/盒表 30 秒——**MV3 的 SW 随时会被回收，不假设内存常驻**；写操作后立即失效重拉，**时间线以服务端为准**，不做本地推测。
- 盒子语义对齐服务端：服务端把「未归盒」对外翻译成默认盒的名字，故下载时 `默认盒名 → 无 box 字段`、上传时 `无 box/默认盒名 → ''`。盒子重命名到空串只能走「删盒 + 盒内账号归默认盒」那一支（服务端 rename 的 target 不接受空串）。
- 配套 UI：数据源 `?` 帮助气泡（讲清本地/云端/切换代价，带 aria 与点外关闭）、云端登录态胶囊（头像 + 展示名）、登录过期提示条、忙碌标记、合并确认弹窗；popup 增加「登录云端账号库」次级入口。

> **验收**：`npm run typecheck` 0 错误、`npm run build` BUILD_OK（版本号对齐至 3.14.1 后复跑确认）。
> ⚠️ **云端子系统尚未在真实浏览器中人工验收**——SW 侧 harness 与页面侧 harness 均未入库，视觉与交互待人工确认。

## 3.13.2（2026-09-10）

**修复：AUTH 改头规则扩展到全资源类型（与 COOKIE 规则同宽）——3.13.1 只补 `main_frame` 仍 401 的教训。** `<a download>` 属性发起的下载请求在 DNR 里经常归型为 **`other`**（因发起方式而异），只补 main_frame 覆盖不全。现 AUTH 与 COOKIE 同用 `ALL_MATCH_TYPES`，下载请求无论归型为 main_frame / other / xmlhttprequest 均携带 Bearer。安全边界不变：`tabIds + requestDomains` 双重锁死。**配套取证**：绑定页签的 401/403（任何类型）与主框架/下载类 4xx-5xx 响应全量写入 `ql:diag`（URL/host/归型/是否覆盖域）——下次诊断包直接可读失败请求，不再依赖症状推断。

## 3.13.1（2026-09-10）

**修复：纯 Bearer 鉴权平台（内网/VPN 站）的文件下载 401。** 用户诊断包实锤（10.100.0.105）：该平台登录不写任何身份 Cookie（jar 共 0，快照仅 12B cookietest），身份完全走 Authorization Bearer——而 AUTH 改头规则的 resourceTypes 不含 `main_frame`，低代码平台的导出接口是**主框架下载导航**（Chrome 下载管理器直启），请求不带 Bearer → 401 → Chrome 显示「请先登录相关网站再尝试下载」。云端平台下载接口认 Cookie 会话（回放覆盖）故无此症。修复：AUTH 规则 resourceTypes 增加 `main_frame`——作用域仍被 `tabIds + requestDomains` 双重锁死（跨域 SSO 跳转不在 requestDomains 内不会被附加头；同域静态资源带 Bearer 无副作用）。顺带加固：`parentDomainOf` 对 IP 字面量（全数字段内网站点）返回原 host，不再拼出 `'0.105'` 这类无意义父域。

## 3.13.0（2026-09-09）

**根本原则加固：亲子继承收编推迟到 URL 确认 + 「最近页面」收敛到绑定页签。**

- **亲子继承收编加固**（v3.9.6 引入的 `adoptFromOpener` 此前在 `onCreated` 立即收编——此时目标 URL 尚未落地）：新页签先登记为**收编候选**（不发种子、不装规则、不写命名空间），首次真实导航落地后按目标 URL 判定——授权域内（host 或 `*.父域`）→ 正式收编（此刻才发种子/装规则/记基线）；**授权域之外或登录页 → 丢弃候选**，页签保持原生（种子/规则/命名空间零接触）。候选 30s 未导航自动放弃并通知壳回直通；hello 对候选返回 `hold`（壳保持等待，不置 settled）。
- **「最近页面」收敛到绑定页签**（修复越权：v3.11 的页面监视挂在所有页签的 `tabs.onUpdated` 上，会记录**未使用扩展打开**的网页）：`page-monitor` 全部入口（导航记录 / 名称嗅探 / MRU 查询 / 跳转）首检**绑定表**，未绑定页签零记录零标注；`pages.recent`/`pages.jump` 对未绑定页签返回空。功能保留待后续按需求重新打磨。
- 配套：`BridgeDownPayload` 新增 `hold` 应答；移除「最近页面」未实现部分的越权面（保持监听器骨架与分类器，供后续修复重启该功能）。

## 3.12.3（2026-09-09）

**修复：快捷登录 → 登录成功 → 退出账号 → 关闭页签 → 再次快捷登录失败（v3.12.2 取证实锤定位，用户诊断包贡献）。**

- **现场证据**（用户导出的 forensics/diag）：三次快捷登录中，失败的那次在点击登录后出现 `captureToken 拦截异账号 token（身份主体变更）`——**页面写入的新登录 token 被身份护栏拒绝记录**，快照卡死旧 token → AUTH 规则强制回放旧 token → API 全 401 → 前端踢回登录页 → 反复点击登不上；再关页重开时命名空间 token 已被上次登录覆盖为新值 → 新登录成「首捕」→ 正常（解释「第二次就好了」）。
- **根因**：平台 token 载荷含**每次签发都重新生成的 `AuthCode`**（GUID），不在身份护栏的时效字段排除集里 → 同账号「登录轮换」的稳定载荷必然不同 → 被误判为异账号。触发链：关页签时命名空间 localStorage 的 `__auth_token__` 未清（快照清了、页面存储没清）→ 重开时平台读到残留 token 自动续用（嗅探捕为「首捕」）→ 用户再次登录的新 token 被护栏拦截。
- **修复一**：`jwtStableIdentity` 时效字段集加入 `authcode/authCode/AuthCode`——同账号轮换放行，异账号（nameidentifier 不同）仍拦截（叛逃防护不变）。
- **修复二**：bind 种子在**无快照 token 时显式清空命名空间残留 `__auth_token__`**（种子空值语义）——登录页从干净状态开始，不再有「残留 token 自动续用 → 轮换被拦」的触发链。

## 3.12.2（2026-08-29）

**登录失败现场取证（诊断基建）：**

- **自动填表逐事件取证**：auto-login 全流程（启动/填充状态变化/每次点击/提交前中止原因/服务端拒绝/让位原因）逐事件上报 `ql:forensics` 环形缓冲（120 条，**密码绝不入日志**）——「点击登录登不上」的每一次尝试都有了黑匣子。
- **生命周期取证**：open（复用/新建/是否清残留）/ 登出 / token 捕获（首次/轮换）/ 登录态终结 / 身份叛逃处置逐事件入缓冲。
- **管理页「导出诊断」按钮**：一键导出诊断包 json（版本 + 账号脱敏清单 + 盒子 + 规则状态 + ql:diag + ql:forensics），自动复制到剪贴板并下载文件——用户无需学任何调试知识即可把完整现场发给开发者。
- **新增 `docs/DIAG-GUIDE.md`**：手把手诊断教学（三条路线：一键导出 / Service Worker 控制台 / Network 面板看登录请求；含复现协议与名词小抄，细致到每一次点击）。

## 3.12.1（2026-08-29）

**修复：快捷登录 → 登录成功 → 退出账号 → 关闭页签 → 再次快捷登录仍失败（v3.12.0 未覆盖到位的毒源）。**

- **根因（链路重放定位）**：登出只清了快照与 token，**命名空间里的 Cookie 袋（`__ql_cookies__`）仍保留上一会话的陈旧 Cookie**。重开登录绑定时 `applySeed` 只把 token 同步进袋、袋中其余陈旧项原样复活：①页内 `document.cookie` 读到陈旧会话；②袋回流（v3.10.6）把陈旧值**回灌进新鲜网络快照** → 登录 POST 带着上一会话的 Cookie → 服务端拒绝 → 反复点击登不上。
- **修复（袋权威同步）**：bind 载荷新增 `bag`（账号 Cookie 快照的非身份键权威视图）；壳在激活/幂等重绑时**把袋整体重置为该视图**（保留种子写入的 token），再灌种子——登出/过期场景袋被清空、免密/复制场景袋 = 当前快照。「页面的 document.cookie 视图」与「网络回放」从此同源，陈旧袋无法复活。

## 3.12.0（2026-08-29）

**架构修正：登录态生命周期跟随页签（用户定夺的范式转变）。**

> 背景诊断：扩展无法感知「用户未登出但凭证已过期/被服务端轮换」——关闭页签后重开时走「免密直达」，把**已死的 token 种子与旧 Cookie 回放**灌进新页签 → 页面失效自检跳登录 → 登录 POST 带着过期会话 Cookie → 反复点击登不上。记住的登录态只在「有活页签」时可靠；无活页签时的记忆 = 丑态之源。

- **免密直达收窄为「复制语义」**：`par.open` 新建页签时，仅当该账号**存在其它活绑定页签**（token 活性由活页签背书）才直达根路径；否则一律进入**登录页 + 自动填表**（账号密码已存，无需手输），并废弃残留快照（token/Cookie/authUser）。
- **最后页签关闭 = 登录态终结**：`unbindTab` 检测到账号无剩余绑定页签时，清空 token/Cookie/authUser 快照，并按写入者归属清扫 jar 中由绑定页签写入的该账号 Cookie（原生页签写入不动，v3.11.1 原则延续）。下次打开 = 干净登录页。
- **身份护栏防误判**：`authUserIdentity` 提取失败（非标准字段/JSON 原文）时返回 null——`__auth_user__` 叛逃判定改为**双侧提取成功才比对**，修复「原文含时间戳差异 → 同账号登录被误判叛逃 → 解绑重载踢回登录页」（点击登录登不上的强候选之一）。
- **保持不变**：存储命名空间隔离、AUTH 实时回放、Cookie 动态快照（活页签期间的下载票据）、亲子继承（复制页签稳定身份）、自动填表（登录页免手输）。
- **语义**：管理页/轮盘的「打开」= 无活页签时走登录页自动填表（短暂）；「新标签页」在有活页签时 = 同账号复制（免密）。账号「在线」= 存在绑定页签。

## 3.11.1（2026-08-29）

**根本原则落地：扩展只能影响扩展打开的网页，不得以规则/能力影响原有网页。** 全量审计后修复三处违规：

- **会话卫生归属化（核心修复）**：v3.10.2 的 Cookie 驱逐/清扫此前**不区分写入者**——同账号「原生登录」（原始页签手输登录）写入真实 jar 的会话 Cookie 与快照对撞即被驱逐/清扫，**扩展破坏了原生登录态**。现引入**写入者归属追踪**：观察型 `webRequest` 记录每条 `Set-Cookie` 所在响应的 tabId 是否绑定（`cookieAttribution`，上限 800 条修剪）；`evictJarCookie` 与 `sweepLoginCookiesFromJar` 仅作用于「绑定页签写入」的 Cookie——原生页签的网络写入归属为 unbound、原生页签的 JS 写入不产生网络事件（无归属），一律保留。
- **遗留免密切换路径不再清空真实 jar**：`clearLoginState` 移除 `chrome.cookies.remove({domain: host})` 全 host 清除（连带杀死原始页签原生登录态）；仅保留扩展打开页签内的 localStorage 清理。
- 保持不变（设计确认）：DNR 规则全部带 `tabIds` 作用域（天然不影响其它页签）；亲子继承（v3.9.6，用户明确要求）保留——继承页签进入登录页自动转原始的护栏（v3.10.4）继续兜底。

> 决策点（保留现状，待定夺）：亲子继承使「平台自己 window.open 的页签」也进入账号隔离作用域。若按最严格解释（只有 par.open 打开的页签才受影响）需移除继承，将回退 v3.9.6 修复的弹窗编辑串号。

## 3.11.0（2026-08-28）

**新增：配置页监听 · 最近 5 个 · 主体名页签标注 · 跳转轮盘**（可行性调研 `docs/FEASIBILITY-RECENT-PAGES.md` 五类页面映射实测闭环后落地）。

- **名称仓库**：MAIN 壳嗅探白名单名称型 API（`BasicObjectDetail`/`GetWorkflowBasic*`/`GetUserMenuPermission`/`MenuGroup/QueryList`/`UserView/GetView`）响应，抽取 `名称↔ID` 对经桥上行；background 合并进 `storage.session` 的 `ql:pageNames`（host → guid→name 扁平表；fetch 走 clone 异步读、XHR 挂 load，只读不阻塞）。
- **页面分类器（L1）**：`tabs.onUpdated` 解析五类路由 → `{页面类型, 后缀, guid}`：`/web?display=`（对象工作区）、`/web/view?mid=&cid=`（业务菜单）、`/admin/config/basic-objects/edit/*?id=`（对象配置）、`/admin/config/lifecycle/<guid>`（生命周期配置）、`/admin/config/workflow/edit?id=`（工作流配置）。
- **主体名解析**：guid 精确命中（含工作流列表 API 全量预缓存）；生命周期页走「加载窗口候选」（详情类 API 最新名称，60s TTL）；未命中先显示 `<类型> · <guid 前 8 位>` 占位，名称到达**原地升级标题**。
- **页签标题**：复合形态 `账号别名 · 主体名·类型`（如 `lyl · 项目号·对象`），经既有 title 管线（executeScript 权威写 + title-hook MutationObserver 维持）。
- **最近 5 MRU**：`storage.local` `ql:recentPages` 按 host 分组、容量 5、同页面去重置顶；条目带来源账号别名（仅展示，不影响账号决策）。
- **跳转轮盘**：新命令 `quick-pages`（建议 `Alt+W`），页面内无框浮层（与账号轮盘同机制：Shadow DOM + 幂等开关），竖排列表（类型徽标配色 + 主体名 + 来源账号 + 相对时间），点击 / 数字键 1-5 = **当前标签页跳转**（tabId 不变 → 账号绑定、六平面隔离规则无缝延续）。

## 3.10.9（2026-09）

**修复：内网 http 站点（VPN/aTrust 环境）打开即失败——scheme 硬编码 + 失败零感知双重缺陷。**

- **根因（真实环境实测实锤：aTrust VPN + `http://10.100.0.105`，实测网络层完全正常、手动登录流畅）**：`open()` 与 `switchAccount()` 硬编码 `https://${siteHost}`——内网 http 站点（443 不开放）打开即落 chrome-error 页 → content script 不可注入 → 自动登录全流程死亡；且扩展无失败感知（无 `webNavigation.onErrorOccurred`），`par.open` 仍返回 ok:true——「系统装死」。**暴露原因**：内部验证套件的模拟平台全部为 https 形态，http 形态从未进过测试矩阵。
- **修复一（scheme 数据化，用户零维护）**：`ParallelAccount`/`Session` 增加 `scheme` 字段（缺省 https 兼容存量）；打开 URL、`cookies.getAll`（preJar 基线/差集清扫/登录快照）全部跟随账号协议。scheme 的确定全自动三层：①添加站点支持**粘贴完整 URL**（解析 scheme 存 hint）；②无 hint 时 **SW 自动探测**（fetch https 3s → http 3s，安全偏好 https）；③**打开失败自学习**——`webNavigation.onErrorOccurred` 捕获 scheme 类错误（SSL_PROTOCOL_ERROR/CONNECTION_REFUSED/RESET/EMPTY_RESPONSE）→ 翻转协议写回账号档案 → 原页签重开（15s 防抖防循环，新增 `webNavigation` 权限，纯观察）。用户全程无感，管理页可查看。
- **修复二（真实环境验证闭环）**：以真实内网环境完成三段式体验——网络侦察（80 通/443 不通）→ 扩展失败复现（chrome-error + diag「完成」）→ patch 验证（自动登录一次成功、token 捕获、快照/回放体系在 http 站点全部正常）。

> 验证：tmp/verify-httpscheme.mjs **10/10**（双服务器模拟：http://127.0.0.1:80 + https://qllocal.test:443@127.0.0.2 构造「纯 http 站点 443 无服务」真实形态——A 探测直选/B 默认 https 失败自学习翻转+写回/C https 不误伤）+ 七套回归全绿（v310/impgrant/jarhygiene/defect/autologin/dynsnap/fillrhythm）。
> 测试基建坑：node https 的 SNI 拒绝未阻断握手（默认证书兜底应答），改用双地址绑定（127.0.0.2:443）才构造出「443 无服务」；模拟 token 必须为 JWT 三段式（captureToken 拒收非 JWT）。

## 3.10.8（2026-08-29）

**实测缺陷修复两则（Cookie 快照的登录前窗口与归属盲区）：**

- **修复：登出→关闭页签→再次快捷登录失败（反复点击登录按钮登不上）**。根因：登出分支清空 Cookie 快照后，`mergeCookieSnapshot` 的「未登录不维护快照」门禁把**登录前窗口**内站点下发的全部凭据材料（WAF 会话票据 `HWWAFSESID`、防机器人 Cookie）一并丢弃 → 登录 POST 以**完全无 Cookie 的裸态**发出 → 被 WAF/服务端拒绝/挑战（无 antd 错误元素时 v3.10.7 的失败感知不触发，表现为「反复点击就是登不上」）。这是 v3.10.6「正常登录环境用的是活的 jar」教训在登录前窗口的翻版。修复：**移除 token 门禁，登录前窗口同样维护快照并热更新回放**（身份键过滤已有、无跨账号风险），登录请求与原生浏览器等价；`mergeBagIntoSnapshot` 的 pre-token 暂存分支并入同一引擎。
- **修复：另一页面的下载被拒（v3.10.6 的残留归属盲区）**：① `webRequest` 响应的 `tabId<=0`（Service Worker 内 fetch / 下载管理器重试 / 预取）此前直接丢弃——**当前恰好只有一个已绑定账号时归属给它**（多账号并存仍无法判定，维持丢弃）；② `Content-Disposition: attachment` 的响应若来自覆盖域（[host, *.父域]）之外，写入诊断埋点（`ql:diag`）标明「下载响应来自未覆盖域」——现场可定位是否需要扩展覆盖策略（不自动向第三方域回放账号 Cookie，避免泄露面扩大）。
- **缓解：袋回流节流 300ms → 120ms**——「页内写票据 → 立刻下载」的竞态窗口压缩 60%。

> 已知边界（不变）：无页签且多账号并存的响应仍无法归属；覆盖域之外的下载不受账号 Cookie 保护（原生 jar 行为）。现场排查：`chrome://extensions` → Akso Pass → Service Worker 控制台查看 `ql:diag`，或用 v3.10.x 的诊断脚本核对回放值。

## 3.10.7（2026-08-29）

**修复：首次登录偶发「密码还没填充完就提交了登录」（报密码错误，且之后点击登录无效）**——用户的猜测正确：账密填充节奏与点击提交的节奏出现了竞争。

- **根因一（v3.10.5 引入的回归，主因）**：自愈式重构把「用户名/密码/按钮三者齐备才点击」的门槛弄丢了——`fillUsername()/fillPasswordInIframes()` 改为返回 boolean 但 attempt 只调不用。密码 iframe 未就绪（`contentDocument` 为空/`srcdoc` 文档未解析完）时照样调度点击 → **空密码/半填充提交** → 服务端报「密码错误」。
- **根因二（放大器）**：800ms 轮询的填充延迟窗口——密码框就绪后最多 800ms 才填，用户在这个窗口手动点击就撞上半填充状态。
- **根因三（二次伤害）**：服务端已拒绝（报错）后自愈逻辑仍盲目重试点击，与用户手动重试竞争，可能触发平台验证码/锁定 → 「账号密码已填充仍不能登录」。
- **修复（节奏五重门控 + 失败让位）**：
  - **齐备门槛**：任一字段填充失败（iframe 未挂载等）→ 本轮绝不进点击流程，等下一轮；
  - **提交前回读**：点击前校验 username/password 的 DOM 值与凭证一致（受控组件状态必须已落地，否则推迟）；
  - **节奏加速**：MutationObserver + iframe `load` 事件即时触发填充（密码框挂载即填，不再等 800ms），压缩「表单可见但未填完」的窗口；
  - **用户点击 = 接管信号**：trusted 点击任何按钮立即让位（含已排程的自动点击；自动点击自身的 click 是合成事件不会误触）；
  - **失败感知让位**：点击后观察期内出现 antd 风格错误提示（message/alert/表单校验错误）→ 容忍一次重填重试（防半状态提交），再错即停止——盲目重试无意义且可能触发锁定。

> 验证：tmp/verify-fillrhythm.mjs 9/9（模拟平台四场景：A 密码 iframe 延迟挂载→首提交晚于挂载且密码完整；B 服务端拒绝+页面中途清值→重填后再提交成功；C 扩展首击被拒后用户点击成功→扩展让位不追加；D 服务端连续拒绝→最多一次重试后停止）+ 六套回归全绿（v310/impgrant/jarhygiene/defect/autologin/dynsnap）。

## 3.10.6（2026-08-29）

**修复：快速登录（虚拟环境）无法下载文件，正常登录可以**——Cookie 回放快照是「登录时点的静态照片」，登录后建立的身份材料全部缺失。

- **根因（用户实测鉴别：同账号双环境对比排除账号权限差异后实锤）**：绑定页签每条出站请求的 `Cookie` 头被 DNR 规则整体替换为**登录那一刻的快照**，而快照在捕获 token 后再无任何更新机制。登录之后建立的三类凭据全部进不了回放：①服务端后续 `Set-Cookie`（会话轮换/下载票据）只落真实 jar；②页内 JS `document.cookie` 写入只进 Cookie 袋（jar 不可见，页面自己读得到——所以前端权限 UI 显示正常、真正下载出站才被拒）；③无页签请求（下载管理器重试/续传）连页签作用域规则都不匹配。正常登录环境用的是活的 jar，所以能下载；「有些人可以全部下载」= 那些账号的下载鉴权只依赖登录时点就有的 Cookie 或走 Bearer 头（token 回放本来就是实时的）。
- **修复（快照动态化）**：
  - **响应捕获**：观察型 `webRequest.onHeadersReceived`（新增 `webRequest` 权限，MV3 允许；仅观察不改写）按 tabId 归属账号，`Set-Cookie` 实时并入快照——新增/值更新/作废指令（`Max-Age=0`/过期 `expires`）三种语义都处理，变化才持久化+热更新回放规则；仅吸收本站响应，第三方 iframe 的 Cookie 不入快照；无页签请求无法归属，文档化为已知边界；
  - **袋回流**：MAIN 壳的 `document.cookie` 写入（袋全量，300ms 尾沿节流）经桥实时上报并入快照——页内 JS 写入的票据/凭据从此进回放；叛逃回滚冻结后不上报（回滚值不得覆盖账号快照）；token 捕获前的页内写入暂存，登录快照时与 jar 全量合并；
  - **加固**：DNR `requestDomains` 剥离端口（DNR 语义不含端口，siteHost 带端口时规则会静默失效）。
- **配套诊断**：多账号并发共享真实 jar 的 Cookie 无法逐账号归属（`cookies.onChanged` 无 tabId），身份类 Cookie 的 jar 驱逐（v3.10.2）不变；非身份 Cookie 落 jar 后在下次写入时按快照对驱逐，短时残留只影响其它页签出站多带一枚陌生票据，服务端按会话签名校验会拒绝，风险可控。

> 验证：tmp/verify-dynsnap.mjs 6/6（本地 443 自签 https 模拟平台：登录时点快照/登录后票据实时进回放/轮换/作废移除/页内写入袋回流）+ 五套回归全绿（v310/impgrant/jarhygiene/defect/autologin）。
> 注意：测试基建发现——`isEnforceable` 用 `*://host/*` 做 contains 查询，manifest 静态 host_permissions 必须用 `*://` scheme（`https://` 不匹配导致规则静默不装，验证假阳性）。

## 3.10.5（2026-08-29）

**修复：快速登录停在登录页、点登录按钮无反应（需刷新重输才能登录）**——自动登录的提交是「一次性点击」，首次点击若落在框架未就绪/表单状态未落地的时刻就会失败，且流程永不重试。

- **根因**：`runTopFrameFlow` 填表后只 `submit.click()` 一次（`submitted` 标志），点击前不校验表单状态、点击后不验证登录是否推进——首次点击被吞（框架未就绪/校验未过/iframe 重渲染清值）则整个流程死掉，用户怎么点都没反应，只能刷新重输；
- **修复（自愈式提交）**：①点击后仍在登录页 → 3.5 秒观察期后**重填再点**（最多 4 次，防御 iframe 重渲染清值——每次点击前先回填）；②表单校验未过（按钮禁用）时等待而非空点；③按钮消失（登录成功跳转）自动收尾；
- **接管让位**：用户一旦手动改写凭据字段（键入 username/password 或清空改写，覆盖 srcdoc iframe 内密码框），自动流程立即停止并让位，绝不覆盖用户输入；
- **接管判定修正**：勾选协议是自动流程自身动作（其 input 事件在扩展上下文 `isTrusted` 可为 true——Chrome 对扩展的 `element.click()` 如此），只有凭据输入框（text/password）的 trusted 输入才视为用户接管。

> 验证：tmp/verify-autologin.mjs 5/5（模拟「handler 迟到 1.5s 绑定」的登录页：首次点击无反应后自愈重试成功/提交时表单值完整/重试≤4 次不连点轰炸/用户键入后自动流程让位）+ 四套回归全绿（v310/impgrant/jarhygiene/defect）。

## 3.10.4（2026-08-29）

**修复：继承页签手输网址登录 B 仍污染 A（用户二轮实测）**——3.10.3 的叛逃护栏在真实平台失效，A 被渐进污染（先名字/详情变 B 权限还是 A，刷新后权限也变 B）。

- **根因**：JWT 身份护栏按**具体 claim 名**（uid/sub/username 等）提取身份——真实平台 token 的身份字段名各异，逐 claim 提取全部落空 → 两侧均为 null → 护栏放行 → `captureToken` 把 A 的快照 token 静默换成 B 的；
- **修复一（claim 名无关比对）**：改用「剥离时效字段（exp/iat/nbf/jti/sid 等）后的**整个 payload** 规范化比对」（键序无关）——同账号 token 轮换稳定载荷相同、异账号必然不同，不再依赖任何字段名；
- **修复二（继承页签进登录页即转原始）**：亲子继承页签（`adopted` 标记）导航到登录页时，**在用户输入账密之前**自动解绑 + 重载转回原始页签——B 的登录从原生状态开始，与 A 完全隔离；配置弹窗场景（非登录 URL）的继承不受影响；账号自己页签的会话过期重登不受影响；
- token 写入叛逃处置（3.10.3）保留作兜底（原始绑定页签内直接异账号登录）。

> 设计语义（与用户期望一致）：快捷登录页签与外部页签**互不干扰**——继承页签一旦被用户带去登录页，即视为独立浏览器；同账号轮换、异账号叛逃、原生登录三条路径都有护栏。
> 验证：8/8（tmp/verify-defect.mjs：弹窗继承保持/登录页自动转换/原生登录隔离/轮换不误判/叛逃兜底/快照护栏/重开即愈）+ 三套既有回归全绿。

## 3.10.3（2026-08-29）

**修复：绑定页签内登录另一账号导致双向身份污染（用户实测复现）**——轮盘登录 A 后，新开页签（平台 window.open 带 opener → v3.9.6 亲子继承绑定为 A）手输网址登录 B：B 的 token/user 写进 **A 的持久化命名空间**、captureToken 把 A 的快照 token 换成 B 的 → A 页显示 B 的名字/A 的权限、B 页显示 A 的详情、关光页签重开也不恢复。

- **身份叛逃检测**：绑定页签写入 `__auth_token__` 且 JWT 身份主体（uid/sub/username 等 claim）与账号现 token 不同、或 `__auth_user__` 用户主体变更 → 判定页签被用户「征用」为原始浏览器；
- **叛逃处置（原始登录与快速登录互不冲突原则）**：①回滚该页签本页会话对命名空间的**全部写入**（MAIN 壳新增写入日志 journal，逐键恢复到页签打开前，含 Cookie 袋）；②清扫该账号命名空间的 IDB/CacheStorage（叛逃会话写入的他人缓存）；③治愈快照（清除被污染的 authUser；token 由 JWT 身份护栏保证未被替换，authHeader 嗅探通道同拦）；④其余绑定页签重灌种子；⑤解绑 + 重载 → 页签转为**真正的原始页签**（B 的会话在真实 jar 原生成立，不顶任何账号）；
- **打开即愈**：免密直达时清零 authUser 并以种子空值清空命名空间残留键，由页面重鉴权后重写——历史污染一次重开即恢复显示；
- **迟到 bind 应答护栏（MAIN 壳）**：passthrough（已判 unbound）状态下收到迟到的旧 bind 应答直接忽略——修复竞态下账号种子被灌进真实裸层（会话泄漏回原始页签，正是顶号死循环的入口）。

> 已污染的存量账号（本版本前产生）请删除后重新添加一次。
> 验证：叛逃全链路 8/8（tmp/verify-defect.mjs：继承复现/叛逃重载/解绑/快照护栏/命名空间回滚/治愈/原生写入隔离/重开即愈）+ v3.10.0/3.10.1/3.10.2 全量回归绿。

## 3.10.2（2026-08-29）

**修复：原始登录与快速登录互相顶号（用户反馈）**——快速登录账号 A 后，用户 Ctrl+T 新开原始页签手动登录新账号 B，A 被站点挤下线。

- **机制**：绑定页签登录时响应 `Set-Cookie` 不经拦截直接落入**真实 Cookie jar**（DNR 只改写出站请求头）；此后原始页签出站时带着的就是 A 的会话 Cookie——站点按会话轮换逻辑「新登录作废旧会话」，A 的服务端会话被作废；
- **对策（会话卫生三层防线）**：真实 jar 从此**永不留存扩展账号的会话 Cookie**——原始页签天然匿名，原始登录=全新会话，互不顶号；扩展页签完全依赖快照回放，行为不变：
  1. **preJar 基线**：`open()`/弹窗继承建页签前记录登录前 jar；
  2. **差集清扫**：快照首捕时移除「本次登录新写入」的 Cookie（保留登录前已存在的原始会话）；
  3. **onChanged 持续驱逐**：凡是 (name,value) 命中任一账号快照对（或 `__auth_token__` 命中任一账号 token）的写 jar 行为立即移除，覆盖后续请求重新 Set-Cookie 的重入；
- 基线缺失（SW 重启）时保守跳过清扫，只靠驱逐兜底，绝不误杀用户的原始会话。

验证：jar 卫生 5/5（tmp/verify-jarhygiene.mjs：清扫/基线保留/重入驱逐/原始新会话存活/快照正常）+ v3.10.0 回归 + v3.10.1 导入回归全绿。

## 3.10.1（2026-08-29）

**修复：导入后账号永远显示「未授权·已暂停」：**

- 根因一：`permissions.request` 排在文件解析/确认/导入消息等多次 `await` **之后**调用，用户手势链已失效 → 请求抛错被 `catch {}` **静默吞掉**——授权从未发生，提示也从不出现；
- 根因二：`statusOf` 同步裸读授权健康缓存，`undefined`（SW 冷启缓存未暖）也误判为未授权；
- 对策：站点授权请求**前置到确认后立即执行**（手势最强处），失败明确弹窗告知「请在添加授权中补授」；`grantChanged` 无论授权成败都发送以对齐缓存；`statusOf` 仅在「明确缓存为 false」时判未授权，未知态不再误报。

验证：授权失败路径 3/3（导入成功 + 明确告警 + 状态如实，tmp/verify-impgrant.mjs）+ v3.10.0 全量回归 10/10。

## 3.10.0（2026-08-29）

**修复：**

- **致命：单页签登出导致全部账号同步退出**——平台经 `BroadcastChannel`（origin 级跨页签共享）广播登出事件，所有账号的页签一并收到。新增**平面 1.5**：`BroadcastChannel` 频道名加账号命名空间前缀，同账号多页签互通、跨账号互不可闻（storage 事件因键名已带前缀天然安全）；
- 空默认盒在轮盘无法到达——升级为正式行为「空默认盒自动禁用」（见下）。

**轮盘：**

- 侧弧**高亮节点旁显示盒子名**（径向外侧白描边标签，随节点滑动整体迁移，viewBox 加宽避让）；
- **盒子支持禁用**：chips 悬停出现 ⏸/▶；禁用盒不进轮盘（即使盒内有账号），管理页照常可用；**空默认盒自动禁用**；禁用名单随盒子重命名/删除联动；
- 轮盘（小窗+浮层）新增 **3s 指纹轮询**：盒子/账号/禁用变化即时联动，未变化不重绘（不打断滑动动画），浮层关闭时清理定时器。

**管理页：**

- **删除盒子两步弹窗**：确认删盒后，盒内有账号时选择「确定=连同账号一并删除（含页签）/取消=账号移入默认盒子」；
- **一键导出/导入**（头部按钮）：导出 JSON 备份（授权站点 + 账号加密凭证 + 加密种子 + 盒子配置）；导入端用文件种子解密、**以本地种子重加密**入库（跨设备可迁移，明文密码不落盘、不进文件），同站同名账号去重跳过，导入后在手势内一次性请求站点授权。批量添加账号功能保留不变。

验证 10/10（tmp/verify-v310.mjs）。

## 3.9.6（2026-08-29）

**修复致命缺陷：站点自开页签的账号身份继承（opener 亲子绑定）：**

- 低代码平台在编辑中点配置按钮弹出**新页签**（`window.open`/`target=_blank`）时，此前该页签无 tabId 绑定——六个隔离平面全部失效（无 Bearer 改写、无 Cookie 回放、MAIN 壳无种子不激活），导致跳登录页/串号/403；
- 现在 `chrome.tabs.onCreated` 检测 `openerTabId` 已绑定的弹窗，**自动继承源账号**：写入绑定表 + 装该账号 AUTH/COOKIE 规则 + 推送种子 + 标题角标随迁；弹窗套弹窗链式继承；
- **授权域护栏**：绑定页签漫游到其它未授权 http(s) 域 → 自动解绑摘规则，防种子/身份头外漏（同时封堵既有「绑定页签手动改址」的泄漏面）；
- 手动 Ctrl+T 新页签（无 openerTabId）不继承，保留有意脱离的口子；`noopener` 弹窗无法识别 opener，退化为旧行为；
- 验证 5/5（tmp/verify-adopt.mjs）：同站弹窗继承、异域护栏解绑、手动页签不继承、原页签保持、弹窗 SPA 读 `__auth_token__` 得到账号身份。

## 3.9.5（2026-08-29）

**轮盘盒子指示重做——右侧 120° 固定轨道 + 节点：**

- 原「整圈进度弧」替换为**轮盘右侧固定 120° 装饰轨道**（半径 254 / 粗 3.5 / 蓝紫绿渐变，全周期恒定不变）；
- 轨道上均匀分布**实心节点，节点数 = 盒子总数**；当前盒子的节点高亮（品牌蓝 + 白描边 + 外发光、放大），其余节点灰色半透明弱化；
- **切换动效**：滚轮/点击切盒时，高亮节点沿轨道从上一节点**平滑滑动**到下一节点（WAAPI 三关键帧：起点→弧上中点→终点，280ms），循环切换与回绕均平滑；
- **单盒场景**：轨道保持完整弧形，仅 1 个高亮节点位于弧正中（3 点钟方向），无滑动；
- 移除旧进度弧的 dasharray 过渡与 CSS 变量管线；小窗页与页面浮层两形态同步。

## 3.9.4（2026-08-29）

**新功能：默认盒子可重命名：**

- 默认盒子 chip 悬停出现「✎」（无「✕」，仍不可删除）：改名后未归盒账号即时显示新名称，**不改任何账号的 box 字段**（保持「未归盒 = 默认盒」不变量）；
- 新账号（表单/批量导入不选盒子）自动落入改名后的默认盒子；**轮盘**（独立小窗与页面浮层）同步显示新名称；
- 与其它盒子重名时拒绝并提示（避免归属歧义）；
- 实现：`ql:defaultBox` 存储键 + `groupPagesByBox(accounts, defaultBoxName?)` 参数化；列表 diff key 纳入 defaultBox、`refreshAll` 先取盒子配置再渲染（修复改名后首绘滞留旧名的时序缺陷）；移入默认盒改为清除 box 字段（历史遗留的字面量「默认盒子」box 字段可在界面中作为普通盒删除）。

## 3.9.3（2026-08-29）

**扩展图标焕新：**

- 全新品牌图标：蓝底渐变圆角方块 + **三段彩环扇区**（白 / 青绿 / 琥珀，取自账号配色系）+ 白色中心 Hub 与品牌蓝圆心——呼应 Alt+Q 账号轮盘的产品签名；16px 下轮廓依然清晰；
- 重制 `assets/Icon16/48/128.png`（Chrome 无头渲染 512px 母版 + 高质量降采样，四角透明圆角、像素级校验）。

## 3.9.2（2026-08-29）

**新功能：盒子管理（重命名 / 删除）：**

- **盒子重命名**：盒子 chips 悬停浮现「✎」——盒内账号随迁到新名；输入已存在的盒子名 = 并入该盒子（二次确认）；当前筛选视图跟随跳转。
- **盒子删除**：盒子 chips 悬停浮现「✕」——空盒直接删；非空盒删除前确认（提示 N 个账号将回到「默认盒子」），账号自动回归默认盒子。
- **默认盒子受保护**：作为未归盒账号的回退锚，不提供重命名/删除入口。
- 新消息 `par.renameBox` / `par.deleteBox`；`parallelStore.renameBox/clearBox`（账号级随迁落库）；盒子 chips 改为 DOM 构建（消除 innerHTML 注名风险）。

**项目收束（不影响扩展产物）：**

- 移除遗留本地引擎时代源码：`packages/engine/`、`packages/shared/nm-protocol.ts`、`src/background/nm-client.ts`（自 v2.4 起无调用方）；`scripts/build.mjs` 不再打包引擎。
- 移除取证/研究工具链：`tools/e2e/`（harness/peek/analyze-events/rule-probe/fix-verify/ui-check）、`research/idb-permissions/`（驱动器 + 5 份报告）；相关结论已沉淀于 `docs/PROJECT-STATUS.md`，完整历史见 git。
- 清理陈旧构建包 `Akso Pass-v3.7.2.zip` 与引擎时代设计文档；依赖瘦身（移除 better-sqlite3 / chrome-remote-interface / playwright 相关 devDeps）。
- 新增用户手册 `docs/USER-MANUAL.md`。

## 3.9.1（2026-08-29）

**实测缺陷修复：**

- **修复「新建的空盒子在轮盘里切换不到」**：轮盘分页此前只包含有账号的盒子；现把管理页记忆的盒子清单（`ql:boxes`）中的空盒子补到页尾，空盒页中心提示「该盒子暂无账号 · 滚轮或点击 Hub 切换盒子」。
- **修复「移入盒子没有关联实际盒子」**：自由文本 prompt 替换为**盒子选择弹窗**——列出实际存在的盒子（带账号计数、单选高亮），也可输入新盒子名自动创建；卡片单个移动与批量移动共用该弹窗。
- **未授权页兜底轮盘放大**：独立小窗 600×632 → 720×760，页面轮盘容器 560px → 660px，扇区更大更易点选。

## 3.9.0（2026-08-29）

**盒子收纳 + 批量管理 + 轮盘 Hub 切盒：**

- **并行账号按盒子收纳**：账号新增 `box` 字段（缺省「默认盒子」）；管理页盒子筛选 chips（全部 / 各盒子 + 计数）、卡片「移入盒子」、表单盒子下拉、`＋新建盒子`（`ql:boxes` 记忆空盒子）；新消息 `par.moveBox`。
- **批量管理**：批量模式下卡片出现勾选框，工具条支持**删除所选**与**批量移入盒子**；账号卡新增「批量导入」：每行 `页签名,账号名,密码`（CSV/TSV）或 JSON 数组，批量导入到所选站点与盒子。
- **轮盘 Hub 切盒**：单环显示「当前盒子」的账号（≤10 个）；**滚轮 / 点击 Hub 循环切换盒子**；外圈细进度弧（品牌渐变）指示当前盒子序位；Hub 显示盒子名与「在线/总数」汇总；数字键作用于当前盒子。
- **轮盘配色**：扇区按账号色低饱和着色（`color-mix`），悬停加深 + 描边/序号随账号色；不再是纯白。
- **修复**：管理页布局改为流体宽度（`max-width` 放宽 + 卡片栅格 auto-fill + 底部双卡 auto-fit），最大化浏览器后不再留失衡空位；**修复 3s 轮询全量重建 DOM 导致的界面闪烁**（列表/站点/chips/下拉全部改为数据 diff 守卫，无变化不重绘）。

## 3.8.0（2026-08-29）

**三处 UI 浅色重构（功能逻辑不变）：**

- **并行管理页 → 浅色工作台**：品牌环形标 + 实时统计（账号/在线数）头部；双栏布局（账号卡片栅格 + 侧栏「添加账号 / 站点管理」）；账号改为彩色头像卡片（在线绿点、状态徽标浅色化、操作按钮组）；空态虚线卡与引导文案。
- **弹窗精简 + 美化**：移除「账号选择轮盘」「授权当前站点」两个按钮（轮盘走 Alt+Q 快捷键、授权在管理页完成）；保留唯一主操作「打开并行管理页」；新增实时统计条（账号/在线/授权站点数）与品牌头。
- **账号轮盘 → 扇形环**（独立小窗与页面浮层同款）：无边框完整圆形，按账号数均分扇区（至多 10 个，超出中心提示），每扇区显示**页签名（径向排布）+ 序号徽章 + 在线状态绿点**；中心 Hub 显示汇总（在线数/总数）或空态提示；交互为**悬停高亮扇区 → 点击切换**（数字键 1-9/0 快选保留）；移除窗口控制按钮与旧「头像辐条」布局；共享渲染核心 `ui/wheel/wheel-core.ts`。
- 其它：独立小窗默认尺寸放大以适配环形（600×632）；`theme.css` 设计令牌扩充（柔和多层阴影、圆角分级、输入聚焦环）。

## 3.7.2（2026-08-28）

**修复真实环境复现的「管理员权限被分发覆盖」：登录快照剔除身份类 Cookie。** 用户实测（本地 Chrome，1 管理员 + 2 普通页签 + 一个**绕过扩展的普通登录页签**同时在线）复现权限串号，而 E2E 隔离环境无法复现。根因：普通/未接管页签没有 Cookie 虚拟化保护，其登录态 `__auth_token__` 直接写入**真实 jar**；3.6 的登录时点快照经 `chrome.cookies` 读取 jar 时会把它一并打包，回放后该账号的请求 = Bearer 是自己、Cookie 里却背着别人的身份 → 平台按 Cookie 认证的端点直接认了 jar 残留身份。修复：快照与回放双侧过滤 `IDENTITY_COOKIE_BLACKLIST`（`__auth_token__`/`__auth_user__`/`__device_fp__`），只回放 WAF 会话对等非身份 Cookie；回放侧过滤使**存量已污染快照无需重新登录即自愈**。另：`isEnableSingleDeviceLogin:False`（平台 JWT 实测值）排除了单设备互踢假说。

## 3.7.1（2026-08-28）

**修复 3.7.0 回归实测缺陷：移除 IDB「历史库清扫」。** 复现症状：关全部 → 先 A 后 U，U 正常，但回到 A 后「管理端点不进、刷新后菜单消失」。根因：passthrough 标签页（bind 未及，ns 为空）的库无前缀，被其它标签页激活时的清扫 `deleteDatabase` 命中；该删除被活动连接阻塞挂起——标签页刷新时连接关闭，删除立即执行，库凭空蒸发。隔离后旧库已是无人读取的孤儿，清扫无害也无益，整体移除。另：E2E 台架新增 **CDP `IndexedDB` 域全量取证**（浏览器真实存储视图，绕过页面补丁，Worker 建库可见），检查点自动 dump 全部库/仓/键/样本。

## 3.7.0（2026-08-28）

**第六隔离平面：IndexedDB 命名空间**（E2E 台架实锤的泄漏根因修复）。取证链：平台前端把 **`isAdmin` 标志位与全量菜单树**缓存在 origin 级共享 IndexedDB 库 `DBFetch`（键 = URL 哈希、无账号维度）；免密恢复登录的标签页直接消费上一账号写入的条目——先管理员后普通用户 → 普通用户读到 `ADMIN=TRUE` + 130KB 管理菜单（象限「U 获得管理员」）；反向则管理员被精简菜单同化。该层完全绕开存储/Bearer/Cookie/HTTP 缓存/SW 五平面。对策：`indexedDB.open/deleteDatabase` 按账号前缀化（`__ql_ns_<accountId>__`，与存储平面同命名空间）、`databases()` 剥前缀回显、激活时清扫历史无前缀共享库（毒源）。已知残余：Web Worker 内开的 IDB 不受主世界补丁（待观测）。台架可复现验证：`npm run e2e`，探针现按「len+SHA1+isAdmin 位」判定级 dump DBFetch。

## 3.6.1（2026-08-28）

**修复（E2E 台架实测发现）：3.6 的 Cookie 登录快照从未执行。** token 首次捕获可能经 authHeader 出站嗅探通道（早于 `__auth_token__` 写入事件），而快照触发只挂在 storageWrite 分支——首捕后同一 token 再写入被去重跳过，快照永远错过登录时点，所有绑定标签始终运行在 `cookie=剥离` 模式。现把快照触发内聚到 `captureToken`（首捕即触发，双通道覆盖）。诊断：`applyBinding` 应出现 `cookie=回放<N>B` 而非 `剥离`。

## 3.6.0（2026-08-28）

**策略级修正（对齐 SessionBox 类产品的稳定核心）：Cookie 从「剥离」升级为「按账号回放」。**

此前 3.0 起的策略是剥离绑定标签页的出站 Cookie（基于「该站为纯 Bearer、服务端不看 Cookie」的结论）。四象限实测证明该前提不成立——平台至少存在一层依赖 Cookie/服务端会话亲和的鉴权，剥离使这类请求降级为匿名，与共享 jar 的先后顺序叠加产生了全部四种症状。SessionBox 类产品从不让标签页「无凭证」出请求：每个会话持有独立 Cookie 罐并持续回放。本版在 MV3 约束下实现等价机制：

- **登录时点全量快照**：账号 token 首次捕获（= 登录刚完成、真实 jar 恰为该账号会话）时，经 `chrome.cookies` 采集**含 HttpOnly 在内**的全量站内 Cookie 存入账号档案（此前 HttpOnly 对页面脚本不可见，Cookie 袋天然缺失）；
- **DNR Cookie 规则 set 回放**：绑定标签页所有出站请求的 Cookie 头由「remove」改为「set 本账号快照」，服务端始终看到一致会话身份；快照为空（未登录过）时保持剥离兜底；页内登出清空快照回到剥离；
- **父域覆盖**：AUTH/COOKIE 规则的 requestDomains 扩展为 [host, 父域]（DNR 语义含全部子域），网关/接口子域请求不再漏网；
- `open()` 绑定时即同步规则与回放值——复开标签页从第一刻起就是完整身份（症状①的冷启动半残窗口消除）。

**已知取舍**：快照仅在登录时点采集一次（此后真实 jar 会被后续登录污染，不可再作数据源）；若服务端在会话中经 Set-Cookie 轮转会话标识，该账号需重新登录刷新快照（JWT 主体不受影响）。

## 3.5.0（2026-08-28）

**重要修正：3.3 的缓存分区在 Chromium 上从未生效。** DNR `redirect.urlTransform` 是 Firefox 专属字段，Chromium 会以 `Unexpected property` 拒绝整个 updateSessionRules 批次（原子失败），3.3 的 CACHE 规则实际一条都没装上。本版重构该平面并新增第五平面：

- **缓存分区移至页面层**：MAIN 壳补丁 fetch/XHR，对同源 GET 幂等追加 `_qlck=t<tabId>`（tabId 由 bind 载荷携带；已含参数则跳过）。POST/PUT 与跨域不受影响；DNR 中已移除 CACHE 规则族。
- **第五平面：Service Worker / Cache Storage 封控**（SW_SHIELD_ENABLED）：拦截 `navigator.serviceWorker.register`（站点 SW 在网络栈内自建缓存、完全无视 DNR 改头与 `_qlck` 分区）；注销既有注册；`CacheStorage.prototype` 的 open/keys/has/delete 按账号命名空间键控、`match` 一律 miss 回落网络。这是「四象限泄漏」候选一（站点级 SW 缓存）的直接防线。
- 新增 `docs/CODEBASE_OVERVIEW.md` 代码库导读；E2E 台架扩容并新增 analyze-events / fix-verify / rule-probe 三个取证工具。
- 修复 shield-main 一个未用变量导致的类型检查失败。

## 3.4.0（2026-08-28）

**针对实测四象限症状的针对性加固 + 诊断工具化：**

- AUTH 改写范围扩展到 **sub_frame**（iframe 内嵌文档）：症状「管理端按钮可见但点不进、重开恢复」的候选解释之一是低代码平台把控制台放在 iframe 里——iframe 文档请求此前既无 Bearer（改写未覆盖）也无 Cookie（3.0 起剥离），服务端按匿名拒入；父层菜单数据走 XHR 所以按钮渲染正常。第二类事实「首次进入半残/刷新即好」同样符合冷启动窗口内的匿名请求。
- 主框架（main_frame）导航仍刻意不改写，避免影响静态资源与 SSO 跳转语义。
- 缓存分区规则保持开启；如仍有残余串号，使用诊断脚本定位下一层（站点 Service Worker / 设备指纹服务端绑定）。

### 诊断脚本（出现坏状态时，在对应标签页 DevTools Console 粘贴）

```js
copy(JSON.stringify({
  tokenPayload: (() => { const t = localStorage.getItem('__auth_token__'); if (!t) return null;
    try { return JSON.parse(atob(t.split('.')[1])); } catch { return t.slice(0, 24) + '…'; } })(),
  deviceFp: localStorage.getItem('__device_fp__'),
  authUser: (() => { try { return JSON.parse(localStorage.getItem('__auth_user__') || 'null'); } catch { return null; } })(),
  cookieView: document.cookie,
}, null, 2))
```

同时看 Network 面板一条权限/菜单类 GET 请求：确认 Query 里是否有 `_qlck=t…`、Size 列是否显示 `(ServiceWorker)` 或 `(disk cache)`。二者对照即可判定泄漏层。

## 3.3.0（2026-08-28）

**核心修复（实测「权限泄露方向跟随第一个登录的账号」）——第四平面：HTTP 缓存分区：**

- 根因定位：浏览器 **HTTP 缓存按 URL 存取且全 profile 共享、不区分凭证**。低代码平台把权限树/菜单等接口做成可缓存 GET，第一个登录账号的响应被缓存后，后续其他账号请求同 URL 直接命中缓存——请求不出浏览器，前三道防线（存储虚拟化/Bearer 改写/Cookie 剥离）全部无效。管理员先登录 → 普通用户看到管理员数据；普通用户先登录 → 管理员菜单被剥离。与实测症状完全一致。
- 修复：每个绑定标签页新增第三条 DNR 规则 —— 该站所有 GET XHR 的查询串自动追加常量参数 `_qlck=t<tabId>`，把共享缓存按标签页硬性分区（同标签内键稳定不影响缓存收益；跨标签必然不同键）。POST/PUT 写操作不受影响。
- 若服务端对未知 query 参数敏感，可在 `tab-rules.ts` 顶部将 `CACHE_PARTITION_ENABLED` 置 false 一键回退。
- 轮盘浮层未出现的说明（非故障）：页面内浮层注入要求扩展对当前站点有授权；未授权页面按设计降级为独立小窗。

### 升级注意

测试前关闭所有旧并行标签并重新打开（旧标签没有新规则）。另注意：本扩展修的是**本地呈现层串号**；若平台服务端存在真实的越权响应（以某凭证返回他人数据），需向平台方反馈——真正的权限边界必须在服务端强制。

## 3.2.0（2026-08-28）

**轮盘去壳 —— 默认无框浮层（按用户要求「只显示轮盘」）：**

- Chrome 扩展 API 无法去掉原生窗口边框，因此更换实现路径：普通网页上快捷键现在直接**在当前页面里铺开轮盘浮层**——毛玻璃暗色遮罩 + 圆角面板，没有任何系统窗口边框；再按一次快捷键 / Esc / 点遮罩关闭，选择后面单自动消失；
- 浮层与 3.1 独立版**同款视觉**：渐变环 Hub、SVG 连线、错峰入场、在线徽点、数字徽章；
- 打开期间锁定页面滚动、屏蔽对页面输入框的按键劫持（仅当焦点在输入控件时放行按键）；
- 降级链调整为：页面浮层 → （chrome:// 等受限页）独立小窗 → 标签页。独立小窗 UI（3.1）保留为兜底形态。

## 3.1.0（2026-08-28）

**轮盘 UI 全面重做（交互逻辑不变）：**

- 椭圆自适应布局：账号数变化时半径自动调整，≥9 个自动进入密集模式（头像/标签缩排），不再挤成一团或溢出窗口；
- 视觉：渐变环中心 Hub（在线时呼吸光环）、SVG 精确连线、错峰弹性入场动画、头像彩色光晕 + 右下角在线状态徽点、深色胶囊标签内嵌数字快捷键徽章；
- 头部实时统计「N 个账号 · M 个在线」；底部快捷键提示条 `<kbd>` 样式化；右上角悬停关闭按钮；
- 新空态卡片：「去并行管理页添加」一键直达。

## 3.0.0（2026-08-28）

**核心修复（实测「新增页签后旧用户权限信息又串了」）——网络平面 v3，第三道防线：**

- **出站 Cookie 头全量剥离**：真实 Cookie jar 是全标签页共享的，最后登录者的 `Set-Cookie` 会污染所有标签；凡靠 Cookie（而非 Bearer 头）鉴权的请求都会被服务端认成「最后登录者」。现对每个绑定标签页安装第二条 DNR 规则：该站**全部资源类型**的出站 `Cookie` 头一律移除 —— jar 对绑定标签完全隐身。目标站为无状态 JWT 设计（服务端不看 Cookie），剥离安全；页面自身取数走 Bearer 改头 + Cookie 袋虚拟化。
- 至此三重防线：① localStorage/cookie 存储虚拟化 ② Authorization 强制改写 ③ 出站 Cookie 剥离。

**轮盘双机制（快捷键顽固失效的最终方案）：**

- 新增**页面内浮层兜底**：弹窗窗口创建失败时，向当前 https 页面注入 Shadow DOM 浮层轮盘（幂等开关、Esc/数字键）；仍失败才降级为普通标签页；
- **角标现场诊断**：按快捷键若工具栏图标闪现 `→`，证明命令已到达当前版本后台（键位无冲突）；扩展重新加载后短显 `v3.0`，无需打开任何界面即可确认新代码已生效。

**授权管理改语义为「停用」（Chrome 拒绝回收授权的功能层解法）：**

- Chrome 的 `permissions.remove` 无法回收 required 权限（实测报错 *You cannot remove required permissions*）。现改为尽力回收 + **本地停用名单兜底**：被停用站点不再安装任何改头/剥离规则，列表红字显示「已停用」，可一键恢复使用；彻底回收仍指引 chrome://extensions 详情页手动收窄。
- 账号徽标新增「未授权 · 已暂停」状态（`enforcementOff`），网络平面健康状态对用户可见。

### 升级注意

1. 移除重装扩展后，确认卡片 **3.0.0** 且图标闪过 `v3.0` 角标；
2. 按你的 Ctrl+Shift+Q：图标闪 `→` = 键位通；未闪 = shortcuts 页键位未绑定到本版本；
3. 重测串号场景（见下）。

## 2.9.0（2026-08-28）

**实测缺陷修复：**

- **修复「站点管理无法移除授权」**：Chrome 的 `permissions.remove` 要求模式串与当初授予的原始字符串完全一致。现改为遍历 `permissions.getAll()` 返回的原始授权串逐个精确删除；删除后校验残留，若被更宽泛的通配授权（如 `*://*/*`）覆盖则弹窗说明并指引到 Chrome 扩展详情页手动收窄。全通配行（`*://*/*`）不再渲染为无意义的站点行。
- **修复快捷键仍打开旧 parallel 页**：取证确认当前后台键盘路径已不含 parallel.html 引用（旧版受限页兜底逻辑的驻留代码所致）。提供三重保险：
  1. 弹窗新增「账号选择轮盘」按钮（消息触发同一窗口逻辑），快捷键失效时始终可用；
  2. 新增 `wheel.toggle` 消息通道；
  3. 见下方「升级注意」的彻底清理步骤。
- 站点下拉为空的禁用项在构造时不再触发告警噪音（保持既有行为不变）。

### 升级注意（本次必须执行）

1. 在 `chrome://extensions` 点击 Akso Pass 的**移除**按钮，然后重新「加载已解压」选择 dist 目录——彻底清掉旧版本驻留的服务工作进程与键位注册；
2. 打开 `chrome://extensions/shortcuts`，找到「Akso Pass · 多账号并行 → 打开账号选择轮盘」，手动设置为 **Alt+Q**（若显示为空或仍是旧组合键）；
3. 重测快捷键与移除授权两个场景。

## 2.8.0（2026-08-28）

- **新增账号的站点改为下拉选择**：选项直接来自「站点管理」的真实授权清单；默认选中上次使用的站点（本地记忆 `ql:lastParHost`），无历史时优先默认站点。下拉为空时提示先去站点管理授权。
- **修复站点行「并行账号」计数脱节**：原实现站点清单与账号清单各自独立渲染、互不等待，计数停留在空快照上永远显示「暂无并行账号」。现统一装载顺序（先账号后站点）、账号数据每次刷新后同步重渲染站点行。
- **轮盘快捷键可靠性加固**：
  - 建议键位从 `Alt+Shift+Q` 改为 **`Alt+Q`**——`Alt+Shift` 是 Windows 输入语言切换的系统级组合，会吞掉/干扰扩展快捷键（此前表现为按键行为异常）；
  - 命令触发加 300ms 去抖，防系统连击导致「开又秒关」；
  - 弹窗创建失败时自动退化为普通标签页打开轮盘（保证任何环境下功能可达）。
  - 注意：键位修改需在 `chrome://extensions/shortcuts` 里确认实际生效值；若已手动自定义过，Chrome 会保留你的设置而不采用新建议键。

## 2.7.0（2026-08-28）

**修复实测串号缺陷（lyl 标签页首页名仍为 lyl、但个人信息与权限变成 T0601 的混合态）：**

- **新增 `document.cookie` 完全虚拟化**（关键修复）：该站登录后服务端经 `Set-Cookie` 把 token 副本写进全标签页共享的真实 Cookie jar，v2.6 未隔离此通道 —— 绑定标签页激活后，cookie 读改写入本账号命名空间的「Cookie 袋」（`__ql_cookies__`），真实 jar 永不再被读取；袋随命名空间内 `__auth_token__` 的增删改实时同步。
- **bind 载荷携带快照种子**：后台在 hello 应答与主动推送中一并下发该账号的 token/身份/指纹快照，MAIN 壳激活瞬间静默直灌命名空间——启动竞态窗口从「等页面回捕」收敛为零依赖。
- 两处泄漏通道（共享 cookie、无规则裸奔请求）至此全部封堵；配合 DNR 按标签改头形成三重防线。

### 升级注意

- 现存真实 Cookie jar 里残留最后一次登录（T0601）的副本：对绑定标签无影响（已虚拟化）；如需绝对干净可在目标站退出一次登录或清除站点 Cookie 后重新按账号打开。

## 2.6.0（2026-08-28）

- **轮盘唤起点解除限制**：快捷键轮盘从「向当前页面注入浮层」改为**独立扩展弹窗窗口**——浏览器任意位置（含 chrome:// 页、新标签页、扩展页）按 `Alt+Shift+Q` 都能唤起；在当前普通窗口内居中弹出，再次按键 = 关闭（幂等开关），失焦自动收起。在线账号优先排列。
- **并行管理页新增「站点管理」区块**：直接读取浏览器的真实站点权限清单（非自记账本），展示每个已授权 host 及其下并行账号数；支持「添加并授权」（输入 host 即弹出 Chrome 授权框）与「移除授权」（撤回后该站点的鉴权头改写立即失效）。

## 2.5.0（2026-08-28）

- **新增「账号选择轮盘」快捷键**：默认 `Alt+Shift+Q`，在当前页面弹出全屏轮盘，账号以彩色头像辐条均布、状态配色环标识在线情况；点击头像 / 数字键 `1-9` 直达对应账号标签页，`Esc` 或点空白关闭；同一页面再次按快捷键 = 关闭轮盘。受限页（chrome:// 等）自动退回并行管理页。
  - Chrome 平台限制：快捷键**无法由扩展程序代码指定**，如需修改请到 `chrome://extensions/shortcuts` 自定义（manifest 中已带建议键位）。
- **并行表单新增「添加」按钮**：位于「添加并打开」左侧，仅保存账号信息（页签名/账号名/密码）不开新标签页；后续从列表或轮盘打开。

## 2.4.0（2026-08-28）

**清理 2.1 时代遗留 UI（实测反馈：弹窗 / 站点管理 / 引擎区块 / 反复报错的事件日志）：**

- **弹窗重做为轻量启动器**：移除旧「免密切换会话」的站点下拉、会话表单与会话列表；仅保留「打开并行管理页」与「授权当前站点」（显示当前站点授权状态），底部版本号保留。
- **移除旧「站点管理」options 页**：manifest 去掉 `options_page`，删除 `src/ui/options/`；站点授权改为弹窗一键或并行页添加账号时内联完成。
- **并行管理页移除全部引擎区块**（新增引擎实例账号 / 引擎实例列表 / 事件日志，及引擎状态徽标）——纯浏览器模式成为唯一模式。
- **后台移除本地引擎依赖**：不再加载 NM host 连接器与重连循环（此前引擎未安装时每 5 秒探测失败、错误日志反复刷新的直接根源）；manifest 移除 `nativeMessaging` 权限。
- **移除旧会话模型入口**：右键菜单「将当前站点添加为会话站点」与 `Ctrl+Shift+E` 快捷键（manifest 去掉 `contextMenus` 权限与 `commands`）；`session.*` 消息接口保留但无 UI 调用（兼容残留数据）。

### 升级注意

- 本次为减法更新，功能无新增；重新加载扩展后请关闭并从弹窗重开并行页。
- 若需要本地引擎多开实例能力，请回退 2.3.0 及以下版本（该能力自此版本起从扩展 UI 中移除）。

## 2.3.0（2026-08-28）

纯浏览器多账号并行（不依赖本地引擎）：

- 新增「双平面隔离」并行模式：
  - 网络平面：DNR session 规则按标签页改写 `Authorization: Bearer <token>`（`background/core/tab-rules.ts`）；
  - 存储平面：MAIN world 壳将绑定标签页 localStorage 重定向到 `__ql_ns_<accountId>__` 命名空间 + ISOLATED 桥中继（`content/shield-main.ts` / `shield-bridge.ts`）；
  - 编排层：tabId↔accountId 绑定表、token 捕获→规则自动同步、标签生命周期清理（`background/core/parallel-session.ts`）。
- 新增 `ParallelAccount` 数据模型（IndexedDB v2 `accounts` store）：**页签名**（自定义标签标题，实时改名）、**账号名**、**密码**（AES-GCM 加密落库）。
- 并行管理页重做：顶部显性版本徽标；「新增并行账号」为主视图（host 预填目标站）；打开/聚焦/新标签页/改页签名/删除；在线状态徽标。
- 引擎多开区块降级为可选：未安装本地引擎时自动隐藏。
- manifest 权限新增 `declarativeNetRequestWithHostAccess`（配合既有站点动态授权，无新增安装警告）；新增两个 document_start 内容脚本（ISOLATED 桥 + MAIN 壳）。

### 升级注意

- 从旧版加载升级后，需在 `chrome://extensions` 点击刷新按钮，并**手动刷新所有已打开的目标站点标签页**，新的内容脚本才会注入。
- IndexedDB 版本 1 → 2 自动迁移，旧「免密切换」会话数据不受影响。

## 2.2.0

Monorepo 化 + 本地引擎（NM host / SQLite / spawn 多开实例）与并行管理页雏形。

## 2.1.0

单账号免密快速切换稳定版：登出→自动填表登录→标签标题改写为账号名。
