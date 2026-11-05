# 安全模型与残余风险

适用版本：**v4.2.39**（2026-11-05 安全加固后）。本文回答三个问题：**保护什么**、
**防谁**、**哪些风险是有意接受而不是漏修**。改动涉及信任边界时，请同步更新本文与
`tools/verify/verify-frameisolation.mjs` 的对应断言。

---

## 一、资产

| 资产 | 位置 | 泄露后果 |
|---|---|---|
| 平台账号口令 | 云端账号库（服务端加密）；扩展按需取明文，仅交给绑定站点的 frame | 直接登录该账号 |
| 每账号 Bearer token | `chrome.storage.session` 的 `parTokens`（SW 重启即失） | 以该账号身份调用平台接口 |
| Cookie 快照（含 HttpOnly） | 同上；按账号注入，不进真实 jar | 会话劫持 / 越权 |
| 云端会话 token、fernetKey | `chrome.storage.local` 的 `cloudAuth`（明文） | 读云端账号库、取账号口令 |
| 页面/剪贴板文本 | 仅用户主动触发翻译时，发往所选第三方引擎 | 业务数据外泄 |
| 设备指纹、账号只读快照 | `chrome.storage.local` / IndexedDB | 关联与画像，风险较低 |

## 二、信任边界

```
扩展 SW / 扩展页面（可信）
   │  chrome.runtime 消息（来源由 SW 注入：tabId/frameId/url/origin）
   ▼
content script（ISOLATED，可信代码、不可信运行环境）
   │  window.postMessage（页面 JS 也能收发，故【不可信】）
   ▼
MAIN world 壳（我们的代码，但与页面 JS 同一 realm）
   │
   ▼
页面 JS / 跨域 iframe / 网络（全部不可信）
```

关键结论：**MAIN world 不是安全边界**。页面 JS 能读 MAIN 壳写在 `localStorage` 里的
任何东西，也能伪造 `postMessage`。因此凭据只能在「后台按 frame 来源校验后」下发给
**确属该账号站点**的 frame，壳内的 host 校验只是纵深防御，不能单独承重。

## 三、攻击者能力假设

- 能在**已绑定站点**上执行 JS（XSS、第三方脚本、恶意业务代码）。
- 能在绑定页签内嵌入**任意跨域 iframe**（广告、在线客服、视频）。
- 能向桥发送任意形状的 `postMessage`。
- 能在同机器上读取扩展的 `chrome.storage.local`（本地磁盘读取，非管理员提权）。
- **不在**范围内：Chrome 自身 0day、其他扩展越权、平台服务端鉴权缺陷、物理接触。

## 四、控制矩阵（v4.2.39 起）

| 威胁 | 控制 | 判据 |
|---|---|---|
| 跨域 iframe 收到 bind 并读走 token | `bind` 只投 `{ frameId: 0 }`；下行载荷带 `host`，壳用 `location.host` 拒收 | `verify-frameisolation` A/I；`verify-bindframe`（浏览器） |
| 任意 frame 发 `hello` 换 token | 所有桥上行 op 按 `sender.url` 的 host+port 校验归属，fail-closed | B |
| 页签漫游到外部站点仍保留凭据 | 导航归属用 `ownedBy`（精确 host/子域+端口），越界即解绑并取证 | D |
| 同页签第三方 iframe 借 DNR 加 Bearer | Authorization 规则加 `initiatorDomains`，且只覆盖 `main_frame`/`sub_frame`/`xmlhttprequest`/`websocket`/`other`（v4.2.33 剔除静态资源） | E |
| 同页签第三方 iframe 借回放 Cookie 发 CSRF | Cookie 规则拆三层：strip(1，全类型 remove) + nav(2，main_frame/other set) + sub(2，其余 set 且 `initiatorDomains`=账号站点) | K；`verify-cookiereplay`（浏览器） |
| https 账号被导航到同 host 的 http，Bearer 明文出网 | 按绑定 scheme 给 Authorization 规则加 `regexFilter: '^https://'`（http 账号不加，内网明文照旧） | J；`verify-dnrscheme`（浏览器） |
| https 账号被导航到同 host 的 http，回放 Cookie 明文出网 | 只给 nav/sub 两条 set 规则加 `regexFilter: '^https://'`；strip 仍覆盖 http（v4.2.38） | K；`verify-dnrscheme` D/E |
| `foo.co.uk` 被当成 `co.uk` 的同站 | 公共后缀 / 托管域表 | E |
| 页面伪造 `bagChanged` 注入 Cookie | 名/值形状校验 + 回放侧二次过滤 + 条数/长度上限 | G |
| 页面反复 `needsReload` 制造刷新循环 | 绑定校验之后 + 60s/3 次令牌桶 | C |
| SW 冷启后旧规则叠加，解绑后旧 token 仍被改写 | `restore()` 先整体摘除本扩展会话规则再按持久化重建（v4.2.39） | `verify-ruleidem`（浏览器） |
| 云端请求走明文 / 权限 API 异常时放行 | https 闸门 + `hasHostAccess` fail-closed | F |
| 兄弟子域跨账号命中页面缓存 | 缓存分区按注册域（`app.example.com` ↔ `api.example.com`） | 人工/load |
| 日志/取证里的令牌 | 通道级 `redact` + 裸 JWT 形状规则 | `verify-log-redaction` 145/145 |
| 恶意 XLSX 原型污染 / ReDoS | `xlsx` 0.20.3（CDN 版），8MB/1000 行上限 | 依赖锁定 |

## 五、残余风险（有意接受，不是漏修）

1. **云端 token 明文存 `chrome.storage.local`**。MV3 没有可用的安全存储：密钥若也放在
   本机，只是把锁和钥匙放在同一个抽屉。现状的补偿控制是「仅扩展上下文可读 + 全链路
   https + 401 立即清除 + 不写日志」。**不要**把它描述成"加密存储"。
2. **`fernetKey` 按契约留存但当前不参与填表**。它是服务端下发的账号库密钥，和 token
   同处 `cloudAuth`。若确认长期不用，应连同服务端契约一起移除，而不是只删客户端字段。
3. **Web Worker 内打开的 IndexedDB 不受补丁**。主世界只能补 `window.indexedDB`；
   Worker 有独立全局。缓解：页面功能不依赖 Worker 里的账号数据；发现站点确实在 Worker
   中开库时，按"该站点不支持并行"处理。
4. **Cookie 回放靠三层优先级而不是单条 `initiatorDomains`**。`main_frame` 导航
   （reload / 地址栏 / SSO 跳转）常无 initiator，单规则加了会整片掉登录，所以保留
   一条无 initiator 的 nav 规则；跨域 iframe 的请求落到 priority 1 的 strip 规则上。
   Chrome 取"同一请求优先级最高的 modifyHeaders 规则"这一行为是本设计的前提，
   `verify-cookiereplay` 的 E 组反证在真浏览器里盯着它。
   ★ Cookie 的**剥离**规则刻意不按 scheme 限定：http 请求也必须被剥掉真实 jar。
   但**回放**（nav/sub 两条 set）从 v4.2.38 起对 https 账号加 `regexFilter: '^https://'`
   —— 否则账号被降级到同 host 的 http 时，会话 Cookie 会被塞进明文请求，与 v4.2.35
   修掉的 Bearer 是同一类问题。取舍是：http 降级时回放不生效（宁可掉登录，不落明文）。
5. **Authorization 规则仍含 `main_frame`**。平台导出接口靠顶层导航下载、缺头即 401，
   这是兼容性取舍；`initiatorDomains` 已把它限制在站点自己发起的导航。
   ★ `initiatorDomains` 的条目**包含子域**（`verify-dnrscheme` F 组实测）：
   账号页面被重定向到 `www.`/`sub.` 时 Bearer 仍在；反过来说，账号 host 的任意子域
   都被视作"站点自己"，这与 `ownedBy` 的归属判定一致。
6. **同源 iframe 的迟到 bind**：壳若在绑定建立前已置 `unbound`，只投顶层的 bind 不会
   再唤醒它；依赖各 frame 自身的 `hello` 重试。属于边缘时序，未观察到功能影响。
7. **页面总能 DoS 自己所在的页签**（死循环、占满 CPU）。`needsReload` 限流只挡"借扩展
   放大刷新"这一种。
8. **翻译文本出站**：请求由浏览器直发腾讯/有道/MyMemory/Lingva，不经本项目服务器；
   设置页已有告知条。含敏感信息的字段不应翻译。
9. **平台服务端鉴权**：客户端只保证呈现层账号分离；若服务端以某凭证返回他人数据，
   属于平台越权缺陷，应向平台方反馈。

## 六、怎么验证

```powershell
npm run typecheck
npm run build
node tools/verify/verify-frameisolation.mjs     # A–K 十一组，秒级
node tools/verify/verify-falsify-frameisolation.mjs  # 上一条的反证（13 条必须变红）
node tools/verify/verify-bindframe.mjs          # 真装 Chromium：广播 bind 也进不了跨域 iframe（8 项）
node tools/verify/verify-dnrscheme.mjs          # 真装 Chromium：https 限定只对 https 生效；父域 initiator 覆盖子域（8 项，含 Cookie 回放）
node tools/verify/verify-cookiereplay.mjs       # 真装 Chromium：跨域 iframe 借不到回放 Cookie（9 项，含 ping）
node tools/verify/verify-ruleidem.mjs           # 真装 Chromium：杀 SW 再拉起，DNR 规则不叠加（5 项）
node tools/verify/run-all.mjs --static          # 28 个静态用例
node tools/verify/verify-load.mjs               # 真装 Chromium，20 项
```

`verify-defect` / `verify-jarhygiene` / `verify-v310` 需要云端会话（账号只存在于云端）；
本机未登录时会 SKIP 或取不到账号，这不是代码回归。

## 七、改动纪律

- 任何"把凭据交给某个 frame"的新路径，必须先回答：**这个 frame 的 `sender.url`
  凭什么算本账号站点**。答不上来就不要下发。
- 任何新的 DNR 规则，必须同时写 `tabIds` 与 `initiatorDomains`（或说明为什么不能）。
- 任何新的日志/取证字段，先过 `redact` / `redactDetail`，并补一条 `verify-log-redaction`。
- 不要用「MAIN world 里已经校验过了」当安全论证——见第二节。
