/**
 * 凭据隔离的**回归判据**（v4.2.32 安全加固）。
 *
 *     node tools/verify/verify-frameisolation.mjs      # 静态、秒级、不需要浏览器
 *
 * ## 为什么单独一个脚本
 *
 * 本轮修的是一组**"删掉任何一行都仍然 typecheck / build 全绿"**的隔离缺陷：
 * bind 广播到所有 frame、桥消息只认 tabId、导航护栏拿"权限"当"归属"、
 * DNR 不区分发起方、云端授权检查 fail-open、Cookie 袋不校验形状。
 * 这些缺陷的共同点是**没有类型错误、没有编译错误、平时也没有可见症状** ——
 * 只有攻击者触发时才显形。⇒ 必须给它们能红的判据，否则下一次重构会原样带回来。
 *
 * ## 每条判据都必须能回答「拆掉什么它才会红」
 *
 * | 组 | 断言 | 拆掉什么它会红 |
 * |---|---|---|
 * | A | bind 只投顶层 frame | 去掉 `frameId: 0`（回到广播） |
 * | B | 桥上行消息按 sender.url 判归属 | 删掉 `senderMatchesBinding` 调用 |
 * | C | needsReload 在绑定校验之后且限流 | 把它挪回 `bindings.get` 之前 / 删令牌桶 |
 * | D | 导航归属与权限解耦 | 把 `ownedBy` 换回 `isEnforceable` |
 * | E | DNR 只给站点自己发起的请求加 Bearer | 删 `initiatorDomains` |
 * | F | 云端授权检查 fail-closed + 强制 https | catch 改回 `return true` / 删 https 闸门 |
 * | G | Cookie 袋名值在写入与回放两侧校验 | 删 `saneCookiePair` 的任一调用 |
 * | H | 裸 JWT 也会被打码 | 删 `裸 JWT` 规则 |
 *
 * ★ 取代码断言前**剥注释**：本文件的判据说明会逐字引用被删掉的旧写法
 *   （例如 `isEnforceable(host)`），不剥的话判据会被自己的解释性文字弄绿/弄红。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './_lib/strip-comments.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = path.join(ROOT, 'packages', 'extension', 'src');

let bad = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => {
  console.log(`  ✗ ${m}`);
  bad++;
};
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');
const code = (rel) => stripComments(read(rel));

/** 从 `sig` 起截到 `closingLine`（含）—— 本仓顶层函数以第 0 列 `}` 收尾，
 *  对象方法以 `  },` 收尾，用固定收尾行比花括号配平更不容易被字符串里的 `{` 骗。 */
function bodyOf(text, sig, closingLine) {
  const at = text.indexOf(sig);
  if (at < 0) return null;
  const end = text.indexOf(closingLine, at + sig.length);
  if (end < 0) return null;
  return text.slice(at, end + closingLine.length);
}

const ps = code('background/core/parallel-session.ts');
const sw = code('background/service-worker.ts');
const sm = code('content/shield-main.ts');
const tr = code('background/core/tab-rules.ts');
const cs = code('background/core/cloud-store.ts');
const rd = code('shared/redact.ts');
const ty = code('shared/types.ts');

// ---------------------------------------------------------------- A. bind 只投顶层 frame
console.log('\n=== A. bind 只投顶层 frame（广播 = 跨域 iframe 也能拿到 token）===');
{
  const body = bodyOf(ps, 'async function pushDown(', '\n}');
  if (!body) {
    fail('找不到 pushDown() —— 判据锚点失效，先修判据');
  } else {
    if (/chrome\.tabs\.sendMessage\(\s*tabId,/.test(body)) {
      ok('pushDown 用 chrome.tabs.sendMessage(tabId, …)');
    } else {
      fail('pushDown 没有走 chrome.tabs.sendMessage(tabId, …)');
    }
    if (/frameId:\s*0/.test(body)) {
      ok('sendMessage 显式带 `{ frameId: 0 }`（只投顶层）');
    } else {
      fail('sendMessage 没有 frameId: 0 ⇒ 又变成广播到页签内所有 frame，'
        + '跨域 iframe 的 MAIN 壳会收到 bind 并把 token 写进第三方 localStorage');
    }
  }
}

// ---------------------------------------------------------------- B. 桥消息按来源 frame 判归属
console.log('\n=== B. 桥上行消息按 sender.url 判归属 ===');
{
  const body = bodyOf(ps, 'async handleBridge(', '\n  },');
  if (!body) {
    fail('找不到 handleBridge() —— 判据锚点失效，先修判据');
  } else {
    if (/sender:\s*BridgeSender/.test(body)) {
      ok('handleBridge 签名带 `sender: BridgeSender`');
    } else {
      fail('handleBridge 没有接收 sender 元数据 ⇒ 无法区分顶层页面与跨域 iframe');
    }
    const guardCount = (body.match(/senderMatchesBinding\(/g) ?? []).length;
    if (guardCount >= 2) {
      ok(`handleBridge 内 ${guardCount} 处 senderMatchesBinding（hello + 其余 op 各一道）`);
    } else {
      fail(`handleBridge 内只有 ${guardCount} 处 senderMatchesBinding —— `
        + 'hello 或后续 op 至少有一路没判来源');
    }
    if (/url:\s*sender\.url/.test(sw) && /\.handleBridge\(\s*payload as BridgeUpPayload,\s*\{/.test(sw)) {
      ok('service-worker 把 sender 的 tabId/frameId/url/origin 传给了 handleBridge');
    } else {
      fail('service-worker 仍然只传 tabId（sender.url 是唯一可信来源证据）');
    }
  }
}

// ---------------------------------------------------------------- C. needsReload 顺序 + 限流
console.log('\n=== C. needsReload 必须在绑定校验之后，且限流 ===');
{
  const body = bodyOf(ps, 'async handleBridge(', '\n  },');
  if (!body) {
    fail('找不到 handleBridge() —— 判据锚点失效');
  } else {
    const bindingAt = body.indexOf('const binding = bindings.get(tabId)');
    const needsAt = body.indexOf("payload.op === 'needsReload'");
    const guardAt = body.indexOf('senderMatchesBinding(');
    if (bindingAt >= 0 && needsAt > bindingAt) {
      ok('needsReload 分支在 `bindings.get(tabId)` 之后');
    } else {
      fail('needsReload 在绑定表查询之前 ⇒ 未绑定的任意页面也能请求刷新');
    }
    if (needsAt > guardAt && /allowReloadForRecover\(tabId\)/.test(body)) {
      ok('needsReload 过 `allowReloadForRecover` 令牌桶');
    } else {
      fail('needsReload 没有过令牌桶 ⇒ 页面可反复触发 reload（刷新循环 DoS）');
    }
  }
  if (/reloadRequests\.delete\(tabId\)/.test(ps)) {
    ok('页签关闭时清理 reloadRequests（不会随 tabId 复用误放行）');
  } else {
    fail('handleTabRemoved 没有清理 reloadRequests');
  }
}

// ---------------------------------------------------------------- D. 导航归属与权限解耦
console.log('\n=== D. 导航归属只看"是不是自己的域"，不看权限 ===');
{
  // onNavigation 是类方法（缩进两格收尾），不是顶层函数
  const body = bodyOf(ps, 'async onNavigation(', '\n  }');
  if (!body) {
    fail('找不到 onNavigation() —— 判据锚点失效');
  } else {
    if (/ownedBy\(url,\s*binding\.host\)/.test(body)) {
      ok('绑定页签护栏用 `ownedBy(url, binding.host)`');
    } else {
      fail('绑定页签护栏没有用 ownedBy ⇒ 归属判定可能又退回"权限判定"');
    }
    if (/ownedBy\(url,\s*pending\.host\)/.test(body)) {
      ok('收编候选用同一套 `ownedBy(url, pending.host)`');
    } else {
      fail('收编候选没有用 ownedBy ⇒ `evil.co.uk` 可能被当成 `foo.co.uk` 的同站');
    }
    if (/isEnforceable\(\s*host\s*\)/.test(body)) {
      fail('onNavigation 仍用 `isEnforceable(host)` 判断绑定归属 —— '
        + '通配授权下它对任意域恒真，护栏等于没有');
    } else {
      ok('onNavigation 不再用权限判定冒充归属判定');
    }
  }
}

// ---------------------------------------------------------------- E. DNR 限定发起方
console.log('\n=== E. DNR 只给"站点自己发起的请求"加 Bearer ===');
{
  const body = bodyOf(tr, 'function buildAuthRule(', '\n}');
  if (!body) {
    fail('找不到 buildAuthRule() —— 判据锚点失效');
  } else if (/initiatorDomains:\s*\[hostNoPortOf\(host\)\]/.test(body)) {
    ok('Authorization 规则带 `initiatorDomains: [hostNoPortOf(host)]`');
  } else {
    fail('Authorization 规则没有 initiatorDomains ⇒ 同页签的跨域 iframe 也能借到 Bearer');
  }
  if (/MULTI_LABEL_SUFFIXES/.test(tr) && /HOSTING_SUFFIXES/.test(tr)) {
    ok('parentDomainOf 有公共后缀/托管域表（不会把 foo.co.uk 上提到 co.uk）');
  } else {
    fail('parentDomainOf 又退回朴素取末两段');
  }
  // v4.2.33：Bearer 不再附到静态资源（script/image/font/media…）上。
  const authTypes = tr.match(/const AUTH_MATCH_TYPES[^=]*=\s*\[([\s\S]*?)\]/);
  if (!authTypes) {
    fail('找不到 AUTH_MATCH_TYPES —— Authorization 规则可能又回到全资源类型');
  } else {
    const list = authTypes[1];
    const missing = ['main_frame', 'sub_frame', 'xmlhttprequest', 'other']
      .filter((t) => !new RegExp(`'${t}'`).test(list));
    const leaked = ['script', 'stylesheet', 'image', 'font', 'media']
      .filter((t) => new RegExp(`'${t}'`).test(list));
    if (missing.length) {
      fail(`AUTH_MATCH_TYPES 缺 ${missing.join('/')} —— 下载、iframe 文档或 API 会掉鉴权`);
    } else if (leaked.length) {
      fail(`AUTH_MATCH_TYPES 仍含静态资源 ${leaked.join('/')} —— `
        + 'Bearer 会被附到图片/字体请求上，扩大泄露面');
    } else {
      ok('Authorization 只覆盖 main_frame/sub_frame/xmlhttprequest/websocket/other');
    }
    if (/function buildAuthRule[\s\S]*?resourceTypes:\s*AUTH_MATCH_TYPES/.test(tr)) {
      ok('buildAuthRule 使用收窄后的 AUTH_MATCH_TYPES');
    } else {
      fail('buildAuthRule 没有使用 AUTH_MATCH_TYPES');
    }
    if (/kind === 'strip'\s*\n?\s*\? ALL_MATCH_TYPES/.test(tr)
      || /resourceTypes:\s*kind === 'strip'\s*\n?\s*\? ALL_MATCH_TYPES/.test(tr)) {
      ok('Cookie 剥离规则仍覆盖全部资源类型（含受保护图片/字体，静态资源不掉会话）');
    } else {
      fail('Cookie 剥离规则被误收窄 ⇒ 受保护图片/字体等子资源会掉会话或漏真实 jar');
    }
  }
}

// ---------------------------------------------------------------- F. 云端 fail-closed + https
console.log('\n=== F. 云端授权检查 fail-closed，令牌不走明文 ===');
{
  const body = bodyOf(cs, 'async function hasHostAccess(', '\n}');
  if (!body) {
    fail('找不到 hasHostAccess() —— 判据锚点失效');
  } else if (/catch\s*\{\s*return false;/.test(body.replace(/\s+/g, ' '))) {
    ok('hasHostAccess 在 permissions API 异常时返回 false（fail-closed）');
  } else {
    fail('hasHostAccess 的 catch 不是 fail-closed ⇒ 权限 API 异常时仍可能出网');
  }
  // requestJson 是泛型函数：async function requestJson<T>(
  const reqBody = bodyOf(cs, 'async function requestJson<', '\n}');
  if (reqBody && /insecureBaseReason\(/.test(reqBody)) {
    ok('requestJson 在唯一出口调用 insecureBaseReason（非 https 拒绝）');
  } else {
    fail('requestJson 没有 https 闸门 ⇒ cloud token 可能经明文 HTTP 传输');
  }
}

// ---------------------------------------------------------------- G. Cookie 袋校验
console.log('\n=== G. Cookie 袋在写入与回放两侧都校验 ===');
{
  const count = (ps.match(/saneCookiePair\(/g) ?? []).length;
  if (count >= 3) {
    ok(`saneCookiePair 共 ${count} 处（定义 + 写入 + 回放）`);
  } else {
    fail(`saneCookiePair 只有 ${count} 处引用 —— 写入或回放至少有一侧没校验，`
      + '页内脚本可把 `a=b; HttpOnlySession=…` 拼进 Cookie 头');
  }
  if (/MAX_COOKIE_PAIRS/.test(ps) && /MAX_COOKIE_VALUE/.test(ps)) {
    ok('有值长度/条数上限（防超大袋撑爆快照与请求头）');
  } else {
    fail('没有 Cookie 条数/长度上限');
  }
}

// ---------------------------------------------------------------- H. 裸 JWT 打码
console.log('\n=== H. 没有键名的令牌也会被打码 ===');
{
  // ★ 这里刻意用**原文**而不是剥注释后的文本：`redact.ts` 的规则表里含带引号的
  //   正则字面量（如 `"[^"]*"`），而 `strip-comments.mjs` 不解析正则字面量，
  //   会把后面的注释误当字符串内容留下 —— 用剥注释文本会匹配到注释里的说明文字，
  //   判据就验不到"规则还在不在"。锚点取**可执行形态**：`re: /\beyJ…`。
  const rdRaw = read('shared/redact.ts');
  if (/re:\s*\/\\beyJ/.test(rdRaw)) {
    ok('redact.ts 有"裸 JWT"形状规则（re: /\\beyJ…）');
  } else {
    fail('redact.ts 没有裸 JWT 规则 ⇒ cookie 值/裸数组里的令牌会原样落盘');
  }
}

// ---------------------------------------------------------------- I. 类型契约
console.log('\n=== I. 载荷/来源的类型契约 ===');
{
  if (/interface BridgeSender/.test(ty)) {
    ok('types.ts 定义 BridgeSender（来源由 SW 注入）');
  } else {
    fail('types.ts 没有 BridgeSender');
  }
  // bind 变体的字段之间夹着大段注释（说明为什么必须下发 host），窗口要留够
  if (/op:\s*'bind'[\s\S]{0,2000}host\?:\s*string/.test(ty)) {
    ok('bind 下行载荷带 host（壳内二次校验用）');
  } else {
    fail('bind 载荷没有 host ⇒ 壳无法在帧内自校验');
  }
  if (/locationMatchesHost\(siteHost/.test(sm)) {
    ok('shield-main handleBind 用 locationMatchesHost 拒收非绑定站点 frame');
  } else {
    fail('shield-main handleBind 没校验 location.host ⇒ '
      + '一旦 bind 再次被广播，跨域 iframe 会把 token 写进自己的 origin');
  }
}

// ---------------------------------------------------------------- J. 凭据只在本账号 scheme 上生效
console.log('\n=== J. https 账号的 Bearer 不下明文 ===');
{
  const authBody = bodyOf(tr, 'function buildAuthRule(', '\n}');
  if (!authBody) {
    fail('找不到 buildAuthRule() —— 判据锚点失效');
  } else if (/scheme\s*===\s*'https'/.test(authBody)
    && /regexFilter:\s*'\^https:\/\//.test(authBody)) {
    ok('https 账号的 Authorization 规则带 `regexFilter: "^https://"`（http 降级不带 Bearer）');
  } else {
    fail('Authorization 规则不区分 scheme ⇒ https 账号被导到 http://同 host 时 Bearer 明文出网');
  }
  const cookieBody = bodyOf(tr, 'function buildCookieRule(', '\n}');
  if (!cookieBody) {
    fail('找不到 buildCookieRule() —— 判据锚点失效');
  } else if (/regexFilter/.test(cookieBody)) {
    fail('Cookie 规则被加了 scheme 限定 ⇒ http 请求将保留真实 jar 的 Cookie（剥离语义被破坏）');
  } else {
    ok('Cookie 规则不按 scheme 限定（http 上也照旧剥离/回放）');
  }
  if (/scheme\?:\s*'http'\s*\|\s*'https'/.test(tr)
    && /buildAuthRule\(ruleId, host, tabId, token, scheme\)/.test(tr)) {
    ok('scheme 从绑定传到 buildAuthRule（不是死参数）');
  } else {
    fail('applyBinding/scheme 的传递链断了 —— scheme 规则装不上');
  }
  if (/interface ParBinding[\s\S]{0,400}scheme\?:\s*'http'\s*\|\s*'https'/.test(ps)
    && /scheme:\s*account\.scheme\s*\?\?\s*'https'/.test(ps)
    && /scheme:\s*b\.scheme/.test(ps)) {
    ok('绑定表持久化 scheme，restore 时一并传给规则（SW 重启后仍生效）');
  } else {
    fail('绑定没有携带/恢复 scheme ⇒ SW 冷启动后 https 限定消失');
  }
  if (/if \(meta\.scheme !== scheme && meta\.authId !== undefined\)/.test(tr)) {
    ok('scheme 从"未知"变为已知时也重建 AUTH 规则（升级前的持久化快照不带 scheme）');
  } else {
    fail('scheme 变更判据排除了 undefined ⇒ 旧快照恢复的 https 账号会保留一条无正则的 AUTH 规则');
  }
}

// ---------------------------------------------------------------- K. Cookie 回放分层（v4.2.36）
console.log('\n=== K. 跨域 iframe 借不到回放 Cookie ===');
{
  const cookieBody = bodyOf(tr, 'function buildCookieRule(', '\n}');
  if (!cookieBody) {
    fail('找不到 buildCookieRule() —— 判据锚点失效');
  } else if (/kind:\s*'strip'\s*\|\s*'nav'\s*\|\s*'sub'\s*=\s*'strip'/.test(tr)
    && /priority:\s*kind === 'strip' \? 1 : 2/.test(cookieBody)) {
    ok('Cookie 规则按 strip(1)/nav+sub(2) 分层（高优先级规则胜出，跨域 iframe 落到 strip）');
  } else {
    fail('Cookie 规则没有分层 ⇒ 一条无 initiator 的 set 会让跨域 iframe 带上账号 Cookie（CSRF）');
  }
  if (/const COOKIE_NAV_TYPES[\s\S]{0,200}'main_frame'[\s\S]{0,80}'other'/.test(tr)
    && /const COOKIE_SUB_TYPES = ALL_MATCH_TYPES\.filter/.test(tr)) {
    ok('导航条覆盖 main_frame/other，子资源条覆盖其余类型（没有漏网类型）');
  } else {
    fail('导航/子资源类型划分缺失或漏类型');
  }
  const allTypes = bodyOf(tr, 'const ALL_MATCH_TYPES', 'as chrome.declarativeNetRequest.ResourceType[]');
  const missing = ['object', 'ping', 'csp_report'].filter((t) => !allTypes.includes(`'${t}'`));
  if (allTypes && missing.length === 0) {
    ok('COOKIE 兜底覆盖 object/ping/csp_report（显式 resourceTypes 不列 = 不匹配）');
  } else {
    fail(`ALL_MATCH_TYPES 漏了 ${missing.join('/') || '（锚点失效）'} ⇒ 这些类型的请求不会被剥离，真实 jar 的 Cookie 会漏出去`);
  }
  if (/kind === 'sub' \? \{ initiatorDomains: \[hostNoPortOf\(host\)\] \} : \{\}/.test(cookieBody)) {
    ok('只有子资源条带 initiatorDomains（strip/nav 不能带，否则无发起方的导航掉登录）');
  } else {
    fail('initiatorDomains 的适用面不对：要么跨域 iframe 挡住不，要么导航掉登录');
  }
  if (/buildCookieRule\(ruleId, host, tabId, null, 'strip'\)/.test(tr)
    && /meta\.cookieId === undefined/.test(tr)) {
    ok('applyBinding 始终安装 strip 兜底规则（真实 jar 对绑定页签隐身）');
  } else {
    fail('strip 规则不是恒装 ⇒ 回放模式下真实 jar 的 Cookie 会漏出去');
  }
  if (/buildCookieRule\(navId, host, tabId, wanted, 'nav'\)/.test(tr)
    && /buildCookieRule\(subId, host, tabId, wanted, 'sub'\)/.test(tr)) {
    ok('回放同时安装 nav 与 sub 两条规则');
  } else {
    fail('回放只装了单条规则 ⇒ 要么跨域 iframe 能借 Cookie，要么导航/子资源缺回放');
  }
  if (/const cookieApplied = meta\.cookieId !== undefined[\s\S]{0,160}meta\.cookieNavId !== undefined && meta\.cookieSubId !== undefined/.test(tr)) {
    ok('回放就绪要求 strip+nav+sub 三条齐备（半回放会被判成未配置并重建）');
  } else {
    fail('cookieApplied 判据不完整 ⇒ 残缺配置会被当成已就绪');
  }
  if (/if \(meta\.cookieNavId !== undefined\) \{\s*removes\.push\(meta\.cookieNavId\)/.test(tr)
    && /removes\.push\(meta\.cookieSubId\)/.test(tr)) {
    ok('解绑/重建时摘除 nav+sub 两条 set 规则（不留半条旧回放）');
  } else {
    fail('clearTab/重建遗漏 nav/sub ⇒ 旧账号 Cookie 可能继续被回放');
  }
}

console.log(`\n${bad === 0 ? 'RESULT: OK' : `RESULT: ${bad} 处不符`}`);
process.exit(bad === 0 ? 0 : 1);
