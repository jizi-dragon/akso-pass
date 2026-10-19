import type { RuntimeRequest, RuntimeResponse, Result, StatusContext, StatusList } from '../shared/messages';
import type { BridgeUpPayload } from '../shared/types';
import { CONTENT_MESSAGE, EXT_VERSION, LOCAL_KEYS, TRANSLATE_COMMAND, TRANSLATE_MESSAGE } from '../shared/constants';
// ★ 日志的**唯一公开面**（AGENTS.md 规则 3）：取 logger 与读缓冲都从这里。
//   直接 `console.*` 会绕过强制打码；直接读 ring 会绕过 `drain()` 的游标还原。
import { drain, getLogLevel, getLogger, restoreToRing, setSink } from '../shared/log';
import type { LogRecord } from '../shared/log';

/**
 * 本模块的 logger。
 *
 * ★ 这个文件是**入口 + 消息分流**，所以它是"点了没反应"类问题唯一能开始查的地方。
 *   在此之前它一行日志都没有 —— 一条消息进来、走错分支、`sendResponse(undefined)`，
 *   全过程**在日志里完全不存在**。
 */
const log = getLogger('sw');

/* ================================================================ 日志落盘通道
 *
 * ★★ 2026-10-09：补上 `log.ts` 那个**从没被接线的注入点**。
 *
 * ## 问题
 *
 * `shared/log.ts` 的环形缓冲（`RING_SIZE = 200`）在 **service worker 的内存里**。
 * 而 **MV3 空闲会回收 SW** —— 于是：
 *
 *     故障发生 → SW 记进内存环 → 用户过一会儿去"导出诊断"
 *              → `ql.diag` 调 `drain()` 读环 → **环常常已经空了**
 *
 * ⇒ **最需要日志的时刻，日志已经没了。** 而诊断包恰恰是**事后**才去取的东西。
 *
 * ## 为什么之前没发现
 *
 * 判据一直是"`drain()` 有没有调用点"（规则 22 那一条，当时确实是**零调用点**，
 * 已修）。修好之后它**有**调用点了 —— 于是那条判据**变成绿的**，
 * 而"**读得到吗**"这个问题仍然没有被问到。
 * ★ 与"接口摆在那里没人接线"同型（v3.19 的 `.side-collapsed`）：
 *   规则 21 说"安全靠约定时要问『违反了谁会知道』"，
 *   这里是它的镜像 —— **"机制摆在那里时要问『它真的被接上了吗』"**。
 *
 * ## 做法
 *
 * `setSink()` 收到的是**同步**回调，而 `chrome.storage` 是异步的
 * ⇒ 攒一小批再写，避免每条日志一次 IPC。
 * ★ `log()` 已经把 sink 包在 `try` 里（`log.ts` 的"必须自己保证不抛"），
 *   而这里额外用 `.catch()` 兜住 **Promise 拒绝**（`try` 拦不住异步拒绝）。
 *
 * ## ★ sink 里**绝对不能调 `log()`**
 *
 * 那会立刻变成无限递归（`log` → `sink` → `log` → …），而 MV3 里一个未捕获异常
 * 会终止整个 worker。所以这里只用**裸 `chrome.storage.local`**。
 */
const LOG_PERSIST_MAX = 120;
let logQueue: LogRecord[] = [];
let logFlushTimer: ReturnType<typeof setTimeout> | null = null;

async function flushLogPersist(): Promise<void> {
  if (!logQueue.length) return;
  const batch = logQueue;
  logQueue = [];
  try {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.logPersist);
    const prev = stored[LOCAL_KEYS.logPersist];
    const all = (Array.isArray(prev) ? (prev as LogRecord[]) : []).concat(batch);
    await chrome.storage.local.set({
      [LOCAL_KEYS.logPersist]: all.slice(-LOG_PERSIST_MAX),
    });
  } catch {
    /* 落盘失败不能影响业务；内存环仍然有这份日志 */
  }
}

function installLogPersist(): void {
  setSink((r) => {
    logQueue.push({ t: r.t, level: r.level, ns: r.ns, msg: r.msg });
    // 攒够 10 条立刻写；否则 800ms 后写（避免每条一次 IPC）
    if (logQueue.length >= 10) {
      if (logFlushTimer) clearTimeout(logFlushTimer);
      logFlushTimer = null;
      void flushLogPersist().catch(() => undefined);
      return;
    }
    if (!logFlushTimer) {
      logFlushTimer = setTimeout(() => {
        logFlushTimer = null;
        void flushLogPersist().catch(() => undefined);
      }, 800);
    }
  });
}

/**
 * 把上次落盘的记录回灌进内存环（若本次已是全新 SW，环是空的）。
 *
 * ★ 回灌**不经 sink**（见 `restoreToRing` 的注释）——否则每次启动都会重写一遍
 *   storage，而且队列会自己喂自己。
 */
async function replayLogPersist(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.logPersist);
    const prev = stored[LOCAL_KEYS.logPersist];
    if (!Array.isArray(prev) || !prev.length) return;
    const n = restoreToRing(prev as LogRecord[]);
    // ★ 记一条**自己的**动作 —— 否则"回灌了没有"在诊断包里看不出来。
    //   它会被 sink 落盘，所以下一次启动时这条也在历史里（时间线连续）。
    if (n > 0) {
      log.info('日志落盘回灌：上一个 SW 生命周期的 %d 条已并入内存环（诊断包可见）', n);
    }
  } catch {
    /* 读不到就当没有历史 */
  }
}

// ★★ 这两行是**接线本身**。判据必须落在"这一个函数有没有被调用"上，
//    而不是"文件里有没有 setSink(" —— 后者在函数**定义**里就已满足
//    （实测踩过：把这两行注释掉，判据仍然全绿）。
installLogPersist();
void replayLogPersist();

import { getPendingAutoLogin } from './core/auto-login-cache';
import { isOfflineError } from './core/offline';
import { siteAuth, probeScheme } from './core/site-auth';
// v4.2.0 翻译链路（合并 Akso Instant Translate）：引擎适配器、设置、统计、命名规范
import { translate } from '../shared/engines';
import { loadTranslationSettings } from '../shared/translate-settings';
import { incrementStats } from '../shared/translate-stats';
import { toSnakeCase, validateTranslation, looksLikeDictionaryEntry } from '../shared/snake-case';
import {
  forensics,
  handleOpenError,
  invalidateEnforcementCache,
  isSchemeFlipError,
  parallelSession,
  registerParallelHandlers,
  warmEnforcementCache,
} from './core/parallel-session';
import { getOfflineStatus, parallelStore } from './core/parallel-store';
import {
  CLOUD_DEFAULT_BASE_URL,
  fetchCloudBoxes,
  getCloudAuth,
  invalidateCloudCache,
  setCloudAuth,
} from './core/cloud-store';
// v4.2.1：登出要清"本机缓存的账号数据"（只读快照；里面从来没有口令）
import { clearSnapshot } from './core/account-cache';
import { cancelDeviceFlow, pollDeviceFlow, startDeviceFlow } from './core/cloud-device';
import { listFavorites, resolveFavoriteUrl } from './core/favorites';
import {
  changeInstanceStatus,
  isInstanceContext,
  loadInstanceStatuses,
  parseInstanceContext,
} from './core/instance-status';
import { hostNoPortOf, tabRules } from './core/tab-rules';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(error: unknown): Result<never> {
  // ★★ 2026-10-09：这里原来是**完全静默**的 —— 它把错误变成
  //   `{ ok: false, error }` 交给调用方，而**自己不留任何痕迹**。
  //
  //   后果：handler 的失败只有在**UI 记得显示它**时才被人看到。
  //   而诊断包里一条都没有 ⇒ 排障时无法回答"这个请求到底报错了没有"。
  //
  //   ⇒ `fail()` 是**所有 handler 失败的唯一收口**（每个 `tryRun` 都经过它），
  //     所以在这一处记，就等于给全部 25 个消息类型加了错误日志。
  //     ★ 这是"打码/日志落在通道上，而不是靠调用点自觉"的同一招（AGENTS.md 规则 21）。
  //
  //   ★ 用 `error` 级：它是真失败，不是轨迹。`log()` 会打码，
  //     而错误消息里**可能带 URL / 邮箱**（都不该明文），所以必须走它。
  log.error('请求失败：%s', error instanceof Error ? error.message : String(error));
  return { ok: false, error: error instanceof Error ? error.message : String(error) };
}

async function tryRun<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

async function dispatch(req: RuntimeRequest): Promise<RuntimeResponse> {
  // ★ 入口 trace。**`debug` 级**（默认 `info` ⇒ 生产静默、零存储开销），
  //   因为它是**每条消息都走**的热路径 —— 照 AGENTS.md 规则 22：
  //   "判断这条日志会不会挤掉别的：看它所在的控制流多久走一次"。
  //
  //   ★ 它解决的问题是"消息到底有没有到 SW"。
  //     在此之前这个问题**无法回答**：UI 点了、没反应、日志空白，
  //     于是你分不清是"消息没发出去"、"SW 没醒"、还是"分支走错了"。
  //
  //   ★★ 2026-10-16 更正排障指引：~~`Site.setLogLevel('debug')`~~ **那个函数在产物里不存在**。
  //     实测 `dist/background.js` 里 `setLogLevel` 出现 **0 次** —— esbuild 会把
  //     "导出了但没人 import" 的函数摇树删掉，而全仓唯一的"调用者"是**人在控制台手敲**。
  //     ⇒ 正确做法是在**控制台**直接写全局级别（它是 `globalThis` 上的属性，摇不掉）：
  //
  //         globalThis.__qlLogLevel = 'debug'    // SW 的 DevTools 控制台；立刻生效
  //
  //     完整原因与证据见 `shared/log.ts` 里 `setLogLevel()` 的注释（PITFALLS #44）。
  log.debug('dispatch kind=%s', String((req as { kind?: unknown }).kind));
  switch (req.kind) {
    // ★★ 2026-10-12 删：`site.grants.list` / `site.grant.add` 两个 kind 在这里
    //   各有一个**占位实现**（一个恒返回 `[]`、一个恒返回失败），而**全仓零发送方** ⇒
    //   它们不是"兼容旧调用"，只是让人以为存在一条真实通路（`docs/PITFALLS.md` #34）。
    //   删掉后它们会落到 `default` 分支，那里有 `log.error` + 明确的错误响应
    //   ⇒ 万一真有旧代码在发，行为是**可见的失败**而不是**看起来成功的空数组**。
    case 'par.grantChanged': {
      // 授权增撤后由 UI 通知：刷新授权健康缓存（下轮 par.list 生效）
      invalidateEnforcementCache();
      return { kind: 'par.grantChanged', result: ok(true) };
    }
    case 'ql.diag': {
      // SW 上下文原地诊断（台架取证用）：storage.local 读写 / DNR 安装 / 模块内部状态
      const r = await tryRun(async (): Promise<Record<string, unknown>> => {
        const out: Record<string, unknown> = {};
        try {
          await chrome.storage.local.set({ __qt: Date.now() });
          const v = await chrome.storage.local.get('__qt');
          out.storageWrite = 'OK';
          out.storageRead = Boolean(v['__qt']);
        } catch (e) {
          out.storageErr = e instanceof Error ? e.message : String(e);
        }
        try {
          out.manifestVersion = chrome.runtime.getManifest().version;
        } catch (e) {
          out.manifestErr = e instanceof Error ? e.message : String(e);
        }
        try {
          const rules = await chrome.declarativeNetRequest.getSessionRules();
          out.sessionRuleCount = rules.length;
        } catch (e) {
          out.rulesErr = e instanceof Error ? e.message : String(e);
        }
        try {
          await chrome.declarativeNetRequest.updateSessionRules({
            addRules: [
              {
                id: 777001,
                priority: 1,
                action: {
                  type: 'modifyHeaders',
                  requestHeaders: [{ header: 'Cookie', operation: 'remove' }],
                },
                condition: {
                  resourceTypes: ['main_frame'],
                  requestDomains: ['tonbridge-config.aksoegmp.com'],
                  tabIds: [999999],
                },
              } as chrome.declarativeNetRequest.Rule,
            ],
          });
          await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [777001] });
          out.dnrInSw = 'OK';
        } catch (e) {
          out.dnrInSwErr = e instanceof Error ? e.message : String(e);
        }
        out.parallel = parallelSession.debugState();
        out.tabRules = tabRules.debugState();
        // ★ 2026-10-09：把 `shared/log.ts` 的环形缓冲**接进诊断包**。
        //
        // 原先这个 handler 返回了 storage / manifest / DNR / parallel / tabRules，
        // 唯独没有日志 —— 而 `shared/log.ts` 的 `drain()` **零调用点**。
        // 后果是：日志只写到 DevTools 控制台，而**诊断包里一条都没有**。
        // 这很要紧，因为 `forensics` 与 `diag` 是**结构化事件**（"发生了什么"），
        // 而这里是**带级别的文本轨迹**（"按什么顺序、在哪一层退出的"）——
        // 排一个"为什么没生效"的问题时，后者往往才是关键。
        //
        // ★ 用 `drain()` 而不是自己读 ring：`drain()` 是本模块的**唯一公开面**，
        //   而且它做了环形游标的顺序还原（乱序读会让时间线看起来是错的）。
        out.logs = drain();
        out.logLevel = getLogLevel();
        return out;
      });
      return { kind: 'ql.diag', result: r };
    }

    /* ---------------- 前端日志转发（v3.19） ----------------
     *
     * ★★ 为什么需要它：`log()` 的环形缓冲与落盘 sink 都在 **SW 里**，
     *   而 content script 与扩展页面**各有自己的 JS 环境** ⇒ 它们记的日志
     *   写进另一个进程的内存，**永远进不了诊断包**。
     *   实测（v3.19）：`ui/` 下 **9 个文件全部零日志**、`content/` 下 6/7 零日志。
     *   ★ 这不是"忘了加"，是**加了也看不到** ⇒ 于是没人加。
     *     与 `PITFALLS #22`（`setSink()` 从没被调用）是**同一形态的第二处**。
     *
     * ★ 用 `restoreToRing()` 而不是 `log()`：
     *   ① 记录**已经打过码**（发送方 `getForwardingLogger` 保证）⇒ 不要重复加工；
     *   ② `log()` 会**再触发 sink**，而 sink 会把整批重写一遍（无谓 IO）；
     *   ③ `restoreToRing` 明确是"把历史记录放回环"的 API，语义正好。
     *   ⇒ 之后 `ql.diag` 的 `drain()` 与落盘都会**自然带上**这些前端日志。
     *
     * ★ 上限：单条消息最多收 50 条，防止前端异常时一次灌爆环形 200。
     *
     * ★ 另外**每条都落一条 `forensics`**：前端日志受**级别过滤**（默认 `info`
     *   下 `debug` 不转发），所以"前端在什么时候发不出消息"这类**将来要查的事**
     *   可能当时没被记下来。`forensics` 是**结构化、不受级别影响**的，
     *   而且它会进诊断包 ⇒ 把"前端报过日志"这件事本身变成**可查的痕迹**。
     */
    case 'ql.log': {
      const records = Array.isArray(req.records) ? req.records.slice(0, 50) : [];
      const accepted = restoreToRing(records);
      if (accepted > 0) {
        // 只记**来源模块与级别**，不记消息正文 —— 正文已在环里，
        // 而 forensics 的环形更小（120），不该被正文占满。
        const namespaces = [...new Set(records.map((r) => r.ns))].join(',');
        const levels = [...new Set(records.map((r) => r.level))].join(',');
        forensics('ui.log.forward', { accepted, namespaces, levels });
      }
      return { kind: 'ql.log', result: ok({ accepted }) };
    }

    /* ---------------- 浏览器并行账号（纯扩展模式） ---------------- */
    case 'par.list': {
      const r = await tryRun(async () => {
        const list = await parallelStore.list();
        // 预热授权健康缓存（statusOf 同步读取；修复「无绑定账号永远显示离线」）
        await warmEnforcementCache(list.map((a) => a.siteHost));
        return list.map((a) => ({
          ...a,
          ...parallelSession.statusOf(a),
          // 云端账号的口令存在服务端（扩展侧只有 hasPassword），本地仍是 credentials 是否存在
          // ★ v3.18：`credentials` 已删 ⇒ `hasPassword` 是唯一依据
          password: a.hasPassword === true,
        }));
      });
      return { kind: 'par.list', result: r };
    }
    /* 离线只读副本的可见性。
     * ★ 它在 `par.list` **之后**被调用：`par.list` 是"走云端还是走副本"的**发生地**，
     *   所以先问列表、再问状态，读到的才是与那份列表**同一次**的事实。
     *   （反过来问会读到上一次的记账，界面就会晚上一拍或早上一拍。） */
    case 'par.offline': {
      const r = await tryRun(() => getOfflineStatus());
      return { kind: 'par.offline', result: r };
    }
    /* ---- 云端权威的**盒子名单**（2026-10-12）----
     * 用户报"盒子的数据没有做好同步"：实测扩展 5 个盒子、云端 2 个。
     * 扩展侧的根因是 UI 的盒子列表把"本地记住的"取了并集，而那份名单
     * （`ql:boxes`）**只会被加、不会被减** ⇒ 云端删掉/改名的盒子永远留着。
     * ★ 这条消息给 UI 一个**对账依据**；`result.data === null` 表示"没拿到"
     *   （离线），那时 UI 的约定是**一个字都不动**。
     * ★ 走消息而不是让 UI 直接 import `cloud-store`：实测 `src/ui/` 目录下
     *   没有任何直接 import background 的先例，那层分工是清楚的（AGENTS §2）。
     *   ★ 这里刻意不写带通配的目录写法 —— 它含注释开始标记，会让
     *     "块注释配平"判据误判（见 PITFALLS #43）。
     * ★★ 2026-10-13：载荷从"只有盒名"升级为**盒子对象数组**
     *   （`ParBox`：含 `disabled` / `count` / `deletable` / `renameable` /
     *   `bindable` / `siteId` / `siteName`）。只给名字装不下这些，
     *   而 UI 需要它们画灰态、决定给不给按钮 —— 见 `ParBox` 的注释。 */
    case 'par.boxes': {
      const r = await tryRun(() => fetchCloudBoxes(true));
      return { kind: 'par.boxes', result: r };
    }
    /* ---- 站点的**自定义名称**（v4.2.1）----
     * 与 `par.boxes` 同一约定：`data === null` = 没拿到（离线）⇒ UI 一个字都不动。 */
    case 'par.sites': {
      const r = await tryRun(async () => {
        try {
          return await parallelStore.listSites(true);
        } catch (e) {
          if (isOfflineError(e)) {
            // 离线：如实返回 null（不是空数组 —— 空数组会被 UI 读成"没有任何站点"）
            return null;
          }
          throw e;
        }
      });
      return { kind: 'par.sites', result: r };
    }
    /* 添加站点时顺带落名（站点可能还不存在于云端 ⇒ 先建再写）。
     * ★ 2026-10-19：站点改名改走 `par.updateSite`（支持名称/地址/备注一起改），
     *   旧的"只改名"kind 已删除 —— 留一条零发送方的协议只会让人以为它还在用。 */
    case 'par.upsertSite': {
      const r = await tryRun(async () => {
        // ★ 2026-10-19：`createBox` 由站点表单的勾选框决定（缺省 true = 原行为）。
        await parallelStore.upsertSite(req.host, req.name, req.createBox !== false);
        const rows = await parallelStore.listSites(true);
        const hit = rows.find((s) => s.host === req.host.trim().toLowerCase());
        return { host: req.host, name: hit?.name ?? req.name, displayName: hit?.displayName ?? req.name };
      });
      return { kind: 'par.upsertSite', result: r };
    }
    /* ★ 2026-10-19（用户要求）：编辑站点。与云端控制台同一条 PATCH，
     *   只转发调用方**真的**给了的字段（`undefined` = 不动）。 */
    case 'par.updateSite': {
      const r = await tryRun(() =>
        parallelStore.updateSite(req.siteId, {
          ...(req.name !== undefined ? { name: req.name } : {}),
          ...(req.baseUrl !== undefined ? { baseUrl: req.baseUrl } : {}),
          ...(req.note !== undefined ? { note: req.note } : {}),
        }),
      );
      return { kind: 'par.updateSite', result: r };
    }
    /* ★ v4.2.7（用户要求"删除站点时云端也要删"）：删云端站点记录。
     * ★★ v4.2.12：**这里不再替 UI 判断"能不能删"** —— 判断权交给服务端。
     *
     * 改前这里的注释写着"UI 已经先确认过'这个站点没有账号'才发这条；这里不重复判断
     * （同一件事判断放两处迟早不一致）"，而 UI 那边的判断依据是**列表渲染那一刻的**
     * 账号数 ⇒ 页面开着时别处加了账号，它就过期了。这正是 `akso-cloud` 那边
     * `site.js` 的注释里写着的同一条教训（"让服务端回答现在有几个，那个数字不可能过期"）。
     *
     * ⇒ 现在：不传 `force` 时服务端会在"有账号"时回 409，`cloud-store` 把它翻成
     *   `blocked` 四态里的一支（带 `accountCount` 与 `usernames`），UI 摊开给人看，
     *   确认后再带 `force: true` 发一次。级联删除因此**不可能静默发生**。 */
    case 'par.deleteSite': {
      const r = await tryRun(() => parallelStore.deleteSite(req.host, req.force === true));
      return { kind: 'par.deleteSite', result: r };
    }
    case 'par.create': {
      const r = await tryRun(async () => {
        const account = await parallelStore.create({
          siteHost: req.siteHost,
          tabName: req.tabName,
          username: req.username,
          password: req.password,
          box: req.box,
          scheme: req.scheme,
        });
        if (req.open) {
          await parallelSession.open(account.id, false);
        }
        return account;
      });
      return { kind: 'par.create', result: r };
    }
    case 'par.probeScheme': {
      const r = await tryRun(() => probeScheme(req.host));
      return { kind: 'par.probeScheme', result: r };
    }
    case 'par.moveBox': {
      const r = await tryRun(() => parallelStore.updateBox(req.id, req.box));
      return { kind: 'par.moveBox', result: r };
    }
    case 'par.renameBox': {
      const r = await tryRun(async () => ({ moved: await parallelStore.renameBox(req.from, req.to) }));
      return { kind: 'par.renameBox', result: r };
    }
    case 'par.deleteBox': {
      const r = await tryRun(async () => ({ moved: await parallelStore.clearBox(req.name) }));
      return { kind: 'par.deleteBox', result: r };
    }
    /* ---- 盒子的三个写动作（2026-10-13，见 `messages.ts` 里各自的注释）----
     * ★ 三条都是**打到云端**的：盒子名单 / 禁用态 / 站点关联的权威都在服务端，
     *   本地那三个键（`ql:boxes` / `ql:defaultBox` / `ql:disabledBoxes`）
     *   从此只是**离线缓存**（由 UI 在成功拉取后写回）。
     * ★ `tryRun` 会把服务端的 400/409 变成 `result.ok === false` 的可读错误 ——
     *   而"默认盒不能改名/禁用"这类**本地也能判**的，cloud-store 里已经先拦了一次。 */
    case 'par.createBox': {
      const r = await tryRun(() => parallelStore.createBox(req.name));
      return { kind: 'par.createBox', result: r };
    }
    case 'par.toggleBox': {
      const r = await tryRun(() => parallelStore.toggleBox(req.name));
      return { kind: 'par.toggleBox', result: r };
    }
    case 'par.bindBoxSite': {
      const r = await tryRun(() => parallelStore.bindBoxSite(req.name, req.siteId));
      return { kind: 'par.bindBoxSite', result: r };
    }
    /* ★★★ v4.2.12：账号编辑（六样字段，与云端控制台的编辑弹窗一一对应）。
     * ★ 页签名变了要顺手刷新绑定页签的标题 —— 否则用户改完页签名，
     *   已经开着的那个标签页标题还是旧的，看起来像"改了没生效"。 */
    case 'par.update': {
      const r = await tryRun(async () => {
        const account = await parallelStore.updateAccount(req.id, req.patch);
        if (req.patch.tabName !== undefined) {
          await parallelSession.refreshTitle(req.id);
        }
        return account;
      });
      return { kind: 'par.update', result: r };
    }
    /* ★★★ v4.2.12：批量删除账号。
     * ★ 两步的分工**不能合并**（见 `closeAccountTabs` 的注释）：
     *   本机会话清理逐个做，**云端删除只发一次**（`POST /api/accounts/batch-delete`）。 */
    case 'par.batchDelete': {
      const r = await tryRun(async () => {
        const ids = [...new Set(req.ids.filter(Boolean))];
        for (const id of ids) {
          await parallelSession.closeAccountTabs(id).catch(() => undefined);
        }
        const deleted = await parallelStore.batchDelete(ids);
        return { deleted };
      });
      return { kind: 'par.batchDelete', result: r };
    }
    case 'par.delete': {
      const r = await tryRun(() => parallelSession.deleteAccount(req.id));
      return { kind: 'par.delete', result: r };
    }
    case 'par.open': {
      const r = await tryRun(() => parallelSession.open(req.id, req.forceNewTab === true));
      return { kind: 'par.open', result: r };
    }
    case 'data.export': {
      const r = await tryRun(async () => {
        const [accounts, grants, stored] = await Promise.all([
          parallelStore.list(),
          siteAuth.list(),
          chrome.storage.local.get([LOCAL_KEYS.boxList, LOCAL_KEYS.defaultBox, LOCAL_KEYS.disabledBoxes]),
        ]);
        return {
          format: 'quicklogin-backup' as const,
          version: 1 as const,
          exportedAt: new Date().toISOString(),
          sites: grants.map((g) => g.host),
          /* ★★ 2026-10-13 口径变更：这三个键**不再代表"用户的偏好"**，
           *   而是**云端状态的离线缓存**（云端的 `box.disabled` / 默认盒名是权威）。
           *   ⇒ 仍然导出（老备份能原样读回、离线首次启动也有东西可用），
           *     但要清楚：**下一次成功拉到 `/api/boxes` 时它会按云端覆盖**。
           *   ★ 所以"导入备份"不能用来把盒子的禁用态改回去 —— 那只是本机缓存。
           *     判据见 `tools/verify/verify-boxsync.mjs` 的第 ⑥ 组。 */
          boxes: {
            default: (stored[LOCAL_KEYS.defaultBox] as string | undefined)?.trim() || undefined,
            remembered: (stored[LOCAL_KEYS.boxList] as string[] | undefined) ?? [],
            disabled: (stored[LOCAL_KEYS.disabledBoxes] as string[] | undefined) ?? [],
          },
          // ★ v3.18：**不再导出任何凭据材料**。
          //   旧格式带 `cryptoSeed` + 每账号的 AES-GCM `credentials`，而本地数据源
          //   已废除 ⇒ 那份密文再也解不开。留着它只会让人以为"备份里有口令"。
          //   现在导出的是**配置**（站点/标题/盒子/用户名），换机器时省去重配，但不含秘密。
          accounts: accounts.map((a) => ({
            siteHost: a.siteHost,
            tabName: a.tabName,
            box: a.box,
            username: a.username,
          })),
        };
      });
      return { kind: 'data.export', result: r };
    }
    case 'data.import': {
      const r = await tryRun(async () => {
        const data = req.data;
        if (data?.format !== 'quicklogin-backup' || data.version !== 1) {
          throw new Error('不是有效的 Akso Pass 备份文件（format/version 不符）');
        }
        // ★ v3.18：备份**只含元数据，不含任何凭据**。
        //
        //   旧格式带 `cryptoSeed` + 每账号的 AES-GCM `credentials`，导入时现场解密。
        //   本地凭据存储废除后那条路不复存在（`credentials` 模块已删除）——
        //   也就是说**旧备份文件里的口令部分再也解不开**，那正是它被删掉的原因：
        //   密钥种子与密文同处一台机器，它防不住"扩展数据目录被整份拿走"。
        //
        //   ⇒ 现在导入只还原**配置**（站点 / 标题 / 盒子 / 用户名），
        //     口令留给云端（服务端 Fernet 持有）。所以导入出来的账号是"无口令"的，
        //     用户需要用云端账号库里的那份。
        if (!Array.isArray(data.accounts)) {
          throw new Error('备份缺少账号清单');
        }
        let created = 0;
        let skipped = 0;
        for (const item of data.accounts) {
          const username = (item?.username ?? '').trim();
          if (!item?.siteHost || !username) {
            skipped++; // 没有用户名的行无法还原身份，如实跳过
            continue;
          }
          const all = await parallelStore.list();
          if (all.some((x) => x.siteHost === item.siteHost && x.username === username)) {
            skipped++; // 同站同名账号已存在
            continue;
          }
          await parallelStore.create({
            siteHost: item.siteHost,
            tabName: item.tabName || username,
            username,
            // 空口令 = 这个账号在云端也没存口令（不是错误，如实反映）
            password: '',
            box: item.box || undefined,
          });
          created++;
        }
        // 盒子配置：恢复备份语义 = 以文件为准覆盖（记住盒/默认盒名/禁用名单）
        if (data.boxes) {
          const patch: Record<string, unknown> = {};
          if (Array.isArray(data.boxes.remembered)) {
            patch[LOCAL_KEYS.boxList] = data.boxes.remembered;
          }
          if (data.boxes.default?.trim()) {
            patch[LOCAL_KEYS.defaultBox] = data.boxes.default.trim();
          }
          if (Array.isArray(data.boxes.disabled)) {
            patch[LOCAL_KEYS.disabledBoxes] = data.boxes.disabled;
          }
          if (Object.keys(patch).length) {
            await chrome.storage.local.set(patch);
          }
        }
        return { created, skipped, hosts: Array.isArray(data.sites) ? data.sites : [] };
      });
      return { kind: 'data.import', result: r };
    }
    /* ---- 实例状态轮盘（v3.15）：真正处理在 onMessage 前置分流（需要 sender.tab） ---- */
    case 'status.context':
    case 'status.load':
    case 'status.change':
      return { kind: req.kind, result: fail('状态轮盘只在目标页签内可用（缺少页面上下文）') };

    /* ---- 常用页面书签（v3.16，Alt+1） ----
     * ★ 2026-10-19：`favorites.open` 的**打开动作**搬到 `onMessage` 前置分流 ——
     *   它需要 `sender.tab` 来判断"当前页属于哪个账号"（见那里）。
     *   这里只留读取清单。 */
    case 'favorites.list': {
      const r = await tryRun(() => listFavorites());
      return { kind: 'favorites.list', result: r };
    }

    /* ---------------- 数据源：本地 ↔ 云端（v3.14） ---------------- */
    case 'cloud.state': {
      const r = await tryRun(async () => {
        // v3.18：`source` 概念已废除（只剩云端）。保留这个字段会让界面
        // 以为还能切 —— 而现在切回去的地方根本不存在了。
        const auth = await getCloudAuth();
        return {
          authorized: Boolean(auth),
          email: auth?.email ?? '',
          displayName: auth?.displayName ?? '',
          avatar: auth?.avatar ?? '',
          baseUrl: auth?.baseUrl ?? CLOUD_DEFAULT_BASE_URL,
        };
      });
      return { kind: 'cloud.state', result: r };
    }
    /* ---- v4.2.1：弹窗身份菜单的两个动作（都**只动本机**）---- */
    case 'cloud.sync': {
      const r = await tryRun(async () => {
        // ① 丢弃 background 的短命缓存（站点/盒子/账号），保证这次一定走网络
        invalidateCloudCache();
        // ② 重新拉账号（走 `listWithFallback`，失败会如实抛 OfflineError）
        const accounts = await parallelStore.list();
        // ③ 站点条数：拿不到不算失败（名字/清单是附属信息，不该让"同步"整个失败）
        const sites = await parallelStore.listSites(true).catch(() => []);
        log.info('cloud.sync 完成：账号 %d / 站点 %d', accounts.length, sites.length);
        return { accounts: accounts.length, sites: sites.length };
      });
      return { kind: 'cloud.sync', result: r };
    }
    case 'cloud.logout': {
      const r = await tryRun(async () => {
        const cleared: string[] = [];
        // ① 令牌：清了之后 `cloud.state` 立刻回报未登录
        await setCloudAuth(null);
        cleared.push('登录令牌');
        // ② 本机缓存的账号数据（只读快照 + 元数据）。**不含口令**（快照里从来没有）
        await clearSnapshot();
        cleared.push('账号缓存');
        // ③ 短命缓存（站点/盒子）—— 换账号后它们必然过期
        invalidateCloudCache();
        cleared.push('站点与盒子缓存');
        // ④ 绑定的页签**不动**：用户是"退出云端账号库"，不是"关掉正在用的标签页"。
        //    平台登录态在各自页签里，与云端账号库是两件事（见 README 的两种登录方式）。
        log.info('cloud.logout：已清除 %s（云端数据未动）', cleared.join(' / '));
        return { cleared };
      });
      return { kind: 'cloud.logout', result: r };
    }
    case 'cloud.device.start': {
      // 设备流第一拍（无凭据）。deviceCode 只留在 cloud-device 的模块内存里，**不回传页面**
      const r = await tryRun(() => startDeviceFlow(req.clientName));
      return { kind: 'cloud.device.start', result: r };
    }
    case 'cloud.device.poll': {
      // 只回答"现在怎么样"，不排程：节拍由页面那一个循环按 interval 决定
      const r = await tryRun(() => pollDeviceFlow());
      return { kind: 'cloud.device.poll', result: r };
    }
    case 'cloud.device.cancel': {
      const r = await tryRun(async () => ({ cancelled: cancelDeviceFlow() }));
      return { kind: 'cloud.device.cancel', result: r };
    }
    // ★★ 2026-10-09：这里原来**没有 default**。
    //
    //   后果很隐蔽：一个未知（或拼错、或已被删除）的 `kind` 会让 switch 静默落空，
    //   而 `dispatch()` 的返回类型是 `Promise<RuntimeResponse>` —— TypeScript 因为
    //   这个类型断言**认为一定有返回值**，所以 `undefined` 静默流向
    //   `sendResponse(undefined)`。UI 侧拿到 `undefined`，
    //   一句"点了没反应"背后**没有任何线索**。
    //
    //   ⇒ 记一条 `error`：走到这里**一定是缺陷**（要么发错了 kind，
    //     要么某个 kind 被删了而调用点没跟着改）。
    //     ★ 只记 kind，不记整个 req：req 里可能有 `data.import` 的账号数据。
    //
    // ★★ 而"补上 default"这件事本身遇到一个类型墙，值得写下来：
    //   `RuntimeRequest['kind']` 是**封闭联合** ⇒ 穷尽之后 TS 把 `req` 收窄成 `never`，
    //   于是 `(req as { kind?: unknown }).kind` 与返回值都过不了类型检查
    //   （`Type 'string' is not assignable to type '"par.list" | ...'`）。
    //
    //   也就是说：**"语法上不可能有未知 kind" 与 "运行时完全可能有未知 kind"**
    //     是两件事，而类型系统只表达前者。
    //   现实来源：UI 与 SW 的**版本不匹配**（扩展刚更新、某个页面还是旧的）、
    //   手写消息、以及"kind 被删了但调用点漏改"。
    //
    //   ⇒ 用 `@ts-expect-error` 显式标注这次**刻意的**类型逃逸，
    //     而不是放宽 `dispatch` 的签名（那会让 25 个 case 全部失去收窄）。
    default: {
      const kind = String((req as { kind?: unknown }).kind);
      log.error('未知的消息 kind=%s ⇒ 无处理分支（发错、被删、或 UI/SW 版本不匹配）', kind);
      // 判据自证：这行必须真的"有类型错误"，否则说明联合不再是封闭的，
      // 那时该改成正常的返回而不是保留这个逃逸。
      // @ts-expect-error 未知 kind 在类型上不存在，但运行时能到达 —— 见上面的说明
      return { kind, result: fail(`未知的消息类型：${kind}`) };
    }
  }
}

/**
 * 从 `sender.origin` / `sender.url` 取出 **host（含端口语义的裸 host，不含端口）**。
 *
 * ★ 2026-10-12 新增：`sb:autoLoginRequest` 的来源域判定专用（见下面的处理分支）。
 *   比对的是 **host 而不是完整 origin**，因为 `bindings` 里存的 `host` 来自
 *   账号的 `siteHost`（可能带 `:port`，内网站点形态），而 DNR 侧另有
 *   `hostNoPortOf` 做同样的剥离 —— 这里保持与它一致，免得"带端口的站点永远匹配不上"
 *   而表现为**自动填表静默失效**。
 *
 * 取不到（`about:blank` / 无 origin 的 frame / 解析失败）返回 `undefined`，
 * 调用方必须按 **fail-closed** 处理。
 */
function originHostOf(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const host = new URL(raw).hostname;
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * ★★ 2026-10-19（用户要求）：**常用页面跟随当前页的账号**。
 *
 * ## 缺陷形态
 *
 * 用户在一个已登录账号 A 的平台页上按 `Alt+1` 打开书签，旧实现一律
 * `chrome.tabs.create({url})` —— 那是一个**没有被绑定**的普通页签：
 *   · 没有 `bindings` 记录 ⇒ 不装 DNR 的 AUTH / COOKIE 规则
 *   · 不注入壳（`shield`）⇒ 存储命名空间、Cookie 袋、缓存分区全部缺失
 * ⇒ 新页签看到的是浏览器**共享 jar**（会话卫生刻意把它清干净了）⇒ **未登录**。
 * 用户要的是"已经登录了的那个身份"，而不是"再登录一次"。
 *
 * ## 判据（为什么必须看 sender.tab）
 *
 * "我是哪个账号"不能由页面自报 —— 那等于把身份交给被注入的页面决定。
 * 唯一可信的来源是后台的绑定表：`sender.tab.id → bindings[tabId].accountId`。
 *
 * ★ 未绑定的页（用户直接在平台上开的页签）保持原行为：新建普通页签。
 *   那种页没有账号上下文，硬套一个账号只会**串号**。
 */
async function openFavoriteFromTab(
  sender: chrome.runtime.MessageSender,
  req: { path?: unknown; baseOrigin?: unknown },
): Promise<{ url: string }> {
  const url = await resolveFavoriteUrl(
    typeof req.path === 'string' ? req.path : '',
    typeof req.baseOrigin === 'string' ? req.baseOrigin : undefined,
  );
  if (!url) {
    throw new Error('无法确定要打开的地址：相对路径需要一个「基准域名」，请先打开一个平台页面，或在书签里填完整网址');
  }
  const tabId = sender.tab?.id;
  const accountId = tabId !== undefined ? parallelSession.boundAccountOf(tabId) : undefined;
  /* ★ 只对**同一站点**的书签套用账号上下文：书签允许填完整外链网址，
   *   把一个别的域名的页面绑进账号 A 的命名空间/规则里，属于把隔离平面
   *   用在一个它不认识的站点上 —— 那既帮不上登录，也放大了接触面。
   *   ⇒ 跨域书签保持原来的"普通新页签"行为。 */
  let sameHost = false;
  const boundHost = tabId !== undefined ? parallelSession.boundHostOf(tabId) : undefined;
  if (boundHost) {
    try {
      sameHost = hostNoPortOf(new URL(url).host) === hostNoPortOf(boundHost);
    } catch {
      sameHost = false;
    }
  }
  if (accountId && sameHost) {
    // ★ 新页签走与 `par.open` **同一条**绑定/建规则/推送种子的路径，
    //   只是落地页换成书签地址、且**不下发待登录明文凭证**（那不是登录页）。
    await parallelSession.open(accountId, true, { targetUrl: url, stageCredentials: false });
    void forensics('favorite-open', { accountId, tabId, url });
    return { url };
  }
  await chrome.tabs.create({ url, active: true });
  return { url };
}

chrome.runtime.onMessage.addListener((req: unknown, sender, sendResponse) => {
  // 0. shield 桥上行：绑定查询 / token 捕获上报（先于通用分流）
  if (
    req &&
    typeof req === 'object' &&
    (req as { type?: string }).type === CONTENT_MESSAGE.bridgeUp
  ) {
    const payload = (req as { payload?: BridgeUpPayload }).payload;
    void parallelSession
      .handleBridge(payload as BridgeUpPayload, sender.tab?.id)
      .then(sendResponse);
    return true;
  }

  // 1. auto-login 内容脚本就绪后主动索取自动登录凭证
  if (
    req &&
    typeof req === 'object' &&
    (req as { type?: string }).type === CONTENT_MESSAGE.autoLoginRequest
  ) {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse(null);
      return true;
    }
    // ★★ 2026-10-12 修：**只把明文账密交给本账号站点自己的 frame**。
    //
    //   此前这里只校验 `sender.tab.id`、**不校验 frame** —— 而 `auto-login.js`
    //   是 `all_frames: true`（manifest），于是绑定页签里**任意** iframe
    //   （第三方广告/统计/嵌入页）在一次登录的 60 秒 TTL 内都能索取到
    //   该账号的明文用户名与口令。
    //
    //   ★ 为什么不是"只许顶层 frame"（`frameId === 0`）：目标站的**密码框就在
    //     同源 `srcdoc` iframe 里**（见 `auto-login.ts` 文件头），而 `<all_urls>`
    //     不注入 `about:srcdoc` —— 一刀切会打断自动填表这条主链路。
    //   ⇒ 判据改为**来源域匹配**：frame 的 origin host 必须等于该页签绑定的站点 host。
    //     · 顶层 frame：origin 就是站点 ⇒ 通过
    //     · 同源 iframe：同 origin ⇒ 通过（保留既有能力）
    //     · 跨域 iframe：origin 不同 ⇒ **拒绝**（这正是要堵的口子）
    //   ★ 取不到 origin 时**拒绝**（fail-closed）：这是凭据，宁可少填一次。
    //   ★ 两侧都过 `hostNoPortOf`：`bindings` 里的 host 来自账号 `siteHost`，
    //     内网站点形态**带端口**（`10.100.0.105:8080`），而 `sender.origin` 的
    //     `hostname` 不带 ⇒ 不归一化的话带端口站点会**永远匹配不上**，
    //     表现为"自动填表对这类站点静默失效"（正是本仓反复出现的失败形态）。
    const boundHost = parallelSession.boundHostOf(tabId);
    const boundHostBare = boundHost ? hostNoPortOf(boundHost) : undefined;
    const senderHost = originHostOf(sender.origin ?? sender.url);
    if (!boundHostBare || senderHost !== boundHostBare) {
      void forensics('autoLoginRejected', {
        tabId,
        frameId: sender.frameId,
        reason: !boundHostBare ? 'unbound' : 'origin-mismatch',
        boundHost: boundHostBare ?? null,
        senderHost: senderHost ?? null,
      });
      sendResponse(null);
      return true;
    }
    void getPendingAutoLogin(tabId).then((creds) => sendResponse(creds));
    return true;
  }

  // 1.2 自动填表取证事件（v3.12.2）：填充/点击/让位/被拒逐事件入 forensics 环形缓冲
  if (
    req &&
    typeof req === 'object' &&
    (req as { type?: string }).type === CONTENT_MESSAGE.autoLoginEvent
  ) {
    const p = (req as { event?: Record<string, unknown> }).event ?? {};
    void forensics('autoLogin', { tabId: sender.tab?.id, ...p });
    sendResponse({ ok: true });
    return true;
  }

  // 1.9 实例状态轮盘（v3.15，Alt+W）：三个 kind 一律只认 sender.tab ——
  //     平台请求必须在**该页签的页面主世界**发出，才能吃到 DNR 的按账号改头与 `_qlck` 缓存分区；
  //     若改成「页面自报 tabId」或「后台直接 fetch」，就会退化成跨账号读共享 jar（见 core/instance-status.ts）
  if (req && typeof req === 'object' && (req as { kind?: string }).kind === 'status.context') {
    void statusContextFor(sender.tab).then((result) => sendResponse({ kind: 'status.context', result }));
    return true;
  }
  if (req && typeof req === 'object' && (req as { kind?: string }).kind === 'status.load') {
    void statusLoadFor(sender.tab).then((result) => sendResponse({ kind: 'status.load', result }));
    return true;
  }
  if (req && typeof req === 'object' && (req as { kind?: string }).kind === 'status.change') {
    const r = req as { code?: string; name?: string };
    void statusChangeFor(sender.tab, r.code ?? '', r.name ?? '').then((result) =>
      sendResponse({ kind: 'status.change', result }),
    );
    return true;
  }

  // 1.95 常用页面：**跟随来源页签的账号**（2026-10-19，见 `openFavoriteFromTab` 的说明）
  if (req && typeof req === 'object' && (req as { kind?: string }).kind === 'favorites.open') {
    const r = req as { path?: unknown; baseOrigin?: unknown };
    void tryRun(() => openFavoriteFromTab(sender, r)).then((result) =>
      sendResponse({ kind: 'favorites.open', result }),
    );
    return true;
  }

  // 1.96 账号轮盘的起始盒子（2026-10-19）：小窗自己传 host，页内浮层用 sender.tab。
  if (req && typeof req === 'object' && (req as { kind?: string }).kind === 'par.wheelContext') {
    const r = req as { host?: unknown };
    void tryRun(() => wheelContextFor(
      typeof r.host === 'string' ? r.host : '',
      sender.tab,
    )).then((result) => sendResponse({ kind: 'par.wheelContext', result }));
    return true;
  }

  // 1.5 翻译链路（v4.2.0 合并 Akso Instant Translate）
  if (
    req &&
    typeof req === 'object' &&
    (req as { type?: string }).type === TRANSLATE_MESSAGE.request
  ) {
    const text = (req as { text?: unknown }).text;
    void handleTranslateRequest(typeof text === 'string' ? text : '').then(sendResponse);
    return true;
  }

  // 2. （已移除）旧版本地引擎 NM 桥 —— v2.4 起纯浏览器模式，不再转发引擎指令
  // 3. 普通扩展内部请求
  void dispatch(req as RuntimeRequest).then(sendResponse);
  return true;
});

/**
 * 翻译请求的全部服务端逻辑：读设置 → 校验开关 → 调引擎 → 校验结果 →
 * **命名规范转换** → 记统计。
 *
 * ★ 为什么 snake_case 转换放在 background 而不是页面：
 *   两条路径（点图标 / Alt+T）**共用同一份结果**。放在页面里就等于两份调用点，
 *   而"其中一条忘了转"不会报错，只会让两个入口给出的格式不一样。
 *
 * ★ 统计**只在这里 +1**：页面拿到的永远是"已成功"的结果，
 *   所以不会出现"失败也计数"（而在页面里计数就得自己判断 success，那是第二处真相）。
 */
async function handleTranslateRequest(rawText: string): Promise<{
  success: boolean;
  text?: string;
  engine?: string;
  error?: string;
}> {
  const text = rawText.trim();
  if (!text) {
    return { success: false, error: '输入框内容为空' };
  }
  try {
    const settings = await loadTranslationSettings();
    if (!settings.translate_enabled) {
      return { success: false, error: '翻译功能已关闭，请在「翻译面板」中开启' };
    }

    const result = await translate(
      text,
      settings.target_language,
      settings.source_language,
      settings.translation_provider,
    );

    // ★ v1.4.1 的修复必须保留：引擎识别不了源语言时会**原样返回输入**，
    //   而那是"成功"响应 ⇒ 不校验就会把中文当译文回填、并提示"翻译完成"。
    const invalid = validateTranslation(result.text, settings.target_language);
    if (invalid) {
      return { success: false, error: invalid };
    }
    // ★★ v4.2.0：词典释义也不能当译文（实测 `行动措施` → `take action /measures /steps to do sth`）。
    //   自动模式已在引擎层把这类结果拒掉并落到下一个引擎；**用户手选「有道」时**会走到这里
    //   ⇒ 必须给出"为什么不行"和"怎么办"，而不是把那串东西填进输入框。
    if (looksLikeDictionaryEntry(result.text)) {
      return {
        success: false,
        error: '该引擎返回的是词典释义（如「take action /measures /steps」），不是可用译文。请改用「自动模式」或「腾讯交互翻译」。',
      };
    }

    const finalText = settings.naming_convention_mode ? toSnakeCase(result.text) : result.text.trim();

    await incrementStats();
    log.info('翻译成功 engine=%s snake=%s len=%d', result.engine, settings.naming_convention_mode, finalText.length);
    return { success: true, text: finalText, engine: result.engine };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('翻译失败：%s', msg);
    return { success: false, error: msg };
  }
}

/* ---------------- 实例状态轮盘（v3.15）：上下文 / 读取 / 切换 ---------------- */

/** 切换成功后等页面刷新的宽限（浮层在此期间显示 toast） */
const STATUS_RELOAD_GRACE_MS = 1200;

function statusContextFor(tab: chrome.tabs.Tab | undefined): Promise<Result<StatusContext>> {
  if (!tab?.id || !tab.url) {
    return Promise.resolve(fail('拿不到当前页签（请在普通网页上使用）'));
  }
  const ctx = parseInstanceContext(tab.url);
  if (!ctx) {
    return Promise.resolve(fail('当前页签不是普通网页'));
  }
  const operable = isInstanceContext(ctx);
  return Promise.resolve(
    ok({
      href: ctx.href,
      origin: ctx.origin,
      objectId: ctx.objectId,
      instanceId: ctx.instanceId,
      menuId: ctx.menuId,
      operable,
      reason: operable ? '' : '当前页面不是对象实例页（地址里没有 bid / id）',
    }),
  );
}

async function statusLoadFor(tab: chrome.tabs.Tab | undefined): Promise<Result<StatusList>> {
  if (!tab?.id || !tab.url) {
    return fail('拿不到当前页签');
  }
  const ctx = parseInstanceContext(tab.url);
  if (!ctx) {
    return fail('当前页签不是普通网页');
  }
  if (!isInstanceContext(ctx)) {
    return fail('当前页面不是对象实例页');
  }
  try {
    const r = await loadInstanceStatuses(tab.id, ctx);
    return ok({ lifecycleName: r.lifecycleName, currentName: r.currentName, statuses: r.statuses });
  } catch (e) {
    return fail(e);
  }
}

async function statusChangeFor(
  tab: chrome.tabs.Tab | undefined,
  code: string,
  name: string,
): Promise<Result<{ name: string }>> {
  if (!tab?.id || !tab.url) {
    return fail('拿不到当前页签');
  }
  const ctx = parseInstanceContext(tab.url);
  if (!ctx) {
    return fail('当前页签不是普通网页');
  }
  if (!ctx.instanceId) {
    return fail('当前页面地址里没有 instanceId（id），无法修改状态');
  }
  const tabId = tab.id;
  try {
    await changeInstanceStatus(tabId, ctx.instanceId, code);
  } catch (e) {
    void forensics('status-change', { tabId, instanceId: ctx.instanceId, code, name, ok: false });
    return fail(e);
  }
  void forensics('status-change', { tabId, instanceId: ctx.instanceId, code, name, ok: true });
  // 成功：延时刷新该页签 —— 页面必须重载才能反映新状态；宽限期让浮层把 toast 显示完。
  // 注意用裸 setTimeout（ServiceWorkerGlobalScope 没有 window，写 window.setTimeout 会抛且被吞）
  setTimeout(() => {
    void chrome.tabs.reload(tabId).catch(() => undefined);
  }, STATUS_RELOAD_GRACE_MS);
  return ok({ name });
}

/* ---------------- 快捷键：账号选择轮盘（v3.8：扇形环；页面内无框浮层优先） ---------------- */

const WHEEL_PAGE = 'ui/wheel/wheel.html';
const WHEEL_W = 720;
const WHEEL_H = 760;
/** 兜底浮层脚本（ISOLATED world，幂等开关）：普通网页上直接铺开无框轮盘 */
const WHEEL_OVERLAY_FILE = 'content/wheel-overlay.js';

/** 会话内记忆轮盘窗口 id；再次触发快捷键 = 关闭（幂等开关，仅对独立小窗模式有效） */
let wheelWinId: number | null = null;
/** 触发去抖：命令重放/系统连击不会开后又立刻关 */
let lastToggleAt = 0;

/**
 * ★ 2026-10-19：小窗/标签页模式的轮盘 URL —— 把**当前页 host** 带过去。
 *
 * 为什么必须带：轮盘窗口自己是"活动页"，后台再 `tabs.query({active:true})`
 * 查到的是它自己（扩展页，没有站点语义）。⇒ 偏好必须在**打开之前**从用户
 * 真正在看的那个页签上取好，随 URL 一起传。
 */
function wheelPageUrl(host: string): string {
  const url = new URL(chrome.runtime.getURL(WHEEL_PAGE));
  if (host) {
    url.searchParams.set('host', host);
  }
  return url.toString();
}

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === wheelWinId) {
    wheelWinId = null;
  }
});

/* ==================== ★★ 浏览器层授权的变化（v4.2.3 新增）====================
 *
 * ## 为什么需要（2026-10-12 用户实测的真实缺陷）
 *
 * 用户的流程是：**站点没有账号 ⇒ 站点管理里没有它 ⇒ 只能靠"快捷登录"时
 * Chrome 自己弹的那个授权窗**。而那条路径**不经过扩展 UI 的 `permissions.request`**，
 * 所以也不会发 `par.grantChanged` ⇒ `enforcement` 缓存里那个 `false` **永远留着**
 * ⇒ 权限早就有了，卡片却一直显示「未授权 · 已暂停」。
 *
 * 实测证据（用户提供的控制台输出）：`getAll()` 里**确实有**
 * 那个平台的 host 授权（形如"协议 + host + 路径通配"），而卡片仍显示未授权
 * —— 那就是缓存没失效。
 * ★ 这里刻意不把那串 origin 的字面量写出来：它的结尾正是注释结束标记，
 *   会让本段注释提前结束、进而破坏整个文件（我在这上面栽过六次，见 PITFALLS #43）。
 *
 * ★ 清这个缓存原来只有两处：SW 冷启（`restore()` 里的 `enforcement.clear()`）
 *   与 UI 主动发 `par.grantChanged`。**用户/浏览器那一侧的变化没有任何人监听** ——
 *   这一类"只有自己人通知自己人"的失效模式，本仓记过（见 `docs/PITFALLS.md` #30
 *   "接口摆在那里 ≠ 它被接上了"）。
 *
 * ## 为什么还必须 `restore()`
 *
 * 清缓存只让**显示**变对。而收回授权时，**已装上的 DNR 改头规则**仍留在会话里 ——
 * 那意味着"没权限了却还在改写鉴权头"。`restore()` 是唯一会按 `isEnforceable`
 * **重新门控**规则与 token/Cookie 快照的地方，所以这里必须调它。
 *
 * ★ 两个监听都必须有：`onRemoved` 漏了 ⇒ 收回授权后规则残留；
 *   `onAdded` 漏了 ⇒ 就是用户这次报的"卡片说未授权"。
 */
function onBrowserPermissionsChanged(what: string): void {
  log.info('浏览器层授权变化（%s）⇒ 清授权健康缓存并重新门控', what);
  invalidateEnforcementCache();
  // 重新门控 DNR 规则与 bindings 的 token/Cookie 快照（收回授权时这一步是必须的）
  void parallelSession.restore().catch((e: unknown) => {
    // 失败要留痕：否则"授权变了但规则没重装"是静默的
    log.warn('授权变化后 restore() 失败：%s', e instanceof Error ? e.message : String(e));
  });
}

chrome.permissions.onAdded.addListener((perms) => {
  onBrowserPermissionsChanged(`added ${(perms.origins ?? []).join(',') || '(无 origins)'}`);
});
chrome.permissions.onRemoved.addListener((perms) => {
  onBrowserPermissionsChanged(`removed ${(perms.origins ?? []).join(',') || '(无 origins)'}`);
});

/**
 * ★★ 2026-10-19（用户要求 ⑦）：`Alt+Q` 的**起始盒子** = 当前页所属站点关联的盒子。
 *
 * 规则：
 *   1. 从当前页签 URL 取 host（小窗模式由调用方显式传，因为它自己的页签没有上下文）
 *   2. 云端盒子列表里找 `siteId` 指向的站点 host 与当前 host 相同的盒子（跳过默认盒/禁用盒）
 *   3. 若当前页签**已绑定账号**且该账号就在其中一个候选盒里 ⇒ 优先它
 *      （多个盒子可能关联同一个站点，用户当前在哪个盒里就用哪个）
 *   4. 没有候选 ⇒ `preferredBox=''`，轮盘从第一页开始（通常是默认盒）
 *
 * ★ 匹配用 `hostNoPortOf`：云端站点地址可能带端口（内网 `10.100.0.105:8080`），
 *   而 `location.host` / 账号 `siteHost` 的端口形态并不总是一致 ——
 *   不剥端口就会"看起来有关联盒子，却永远匹配不上"（本仓反复记过的坑）。
 * ★ 拿不到云端数据（离线）⇒ 返回空偏好，**不猜**一个盒子。
 */
async function wheelContextFor(
  hostHint: string,
  tab?: chrome.tabs.Tab,
): Promise<{ host: string; preferredBox: string; matched: boolean }> {
  let host = hostHint.trim();
  if (!host && tab?.url) {
    try {
      host = new URL(tab.url).host;
    } catch {
      host = '';
    }
  }
  if (!host) {
    return { host: '', preferredBox: '', matched: false };
  }
  const bare = hostNoPortOf(host);

  const cloud = await fetchCloudBoxes(false);
  if (!cloud) {
    // 离线：没有权威盒子/站点数据，不猜（调用方会用本机记住的默认盒兜底）
    return { host, preferredBox: '', matched: false };
  }
  const siteHosts = new Map<string, string>();
  try {
    for (const s of await parallelStore.listSites(false)) {
      siteHosts.set(s.id, s.host);
    }
  } catch {
    // 站点清单拿不到 ⇒ 无法判断关联关系。用户要求"没有关联盒子时用默认盒"，
    // 这里的默认盒是云端权威值（`cloud.default`）。
    return { host, preferredBox: cloud.default, matched: false };
  }

  const candidates = cloud.boxes.filter((b) => {
    if (!b.bindable || !b.siteId || b.disabled) {
      return false;
    }
    const siteHost = siteHosts.get(b.siteId);
    return Boolean(siteHost) && hostNoPortOf(siteHost!) === bare;
  });
  if (!candidates.length) {
    // ★ 用户要求：**没有关联盒子时用默认盒** —— 不是"停在第一页"（第一页可能是别的盒子）
    return { host, preferredBox: cloud.default, matched: false };
  }

  let preferred = candidates[0].name;
  const tabId = tab?.id;
  const accountId = tabId !== undefined ? parallelSession.boundAccountOf(tabId) : undefined;
  if (accountId) {
    try {
      const account = await parallelStore.get(accountId);
      const box = account.box?.trim() || cloud.default;
      if (candidates.some((b) => b.name === box)) {
        preferred = box;
      }
    } catch {
      // 取不到账号就退回第一个候选（不影响"优先"这个目标）
    }
  }
  return { host, preferredBox: preferred, matched: true };
}

async function toggleAccountWheel(): Promise<void> {
  const now = Date.now();
  if (now - lastToggleAt < 300) {
    return;
  }
  lastToggleAt = now;

  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  // 轮盘小窗/标签页模式的"当前站点"——必须在切走焦点之前取好
  let wheelHost = '';
  try {
    wheelHost = tab?.url ? new URL(tab.url).host : '';
  } catch {
    wheelHost = '';
  }

  // 机制一（主）：普通网页 → 页面内无框浮层（再次触发 = 脚本自关闭）
  try {
    if (tab?.id && tab.url && /^https?:/i.test(tab.url)) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [WHEEL_OVERLAY_FILE],
        world: 'ISOLATED',
      });
      return;
    }
  } catch {
    // 注入失败（受限页/权限收回等）→ 继续降级
  }

  // 机制二：独立弹窗小窗（Chrome 对 chrome:// 等页注入不了时仍可用）
  if (wheelWinId !== null) {
    try {
      await chrome.windows.get(wheelWinId);
    } catch {
      wheelWinId = null;
    }
    if (wheelWinId !== null) {
      await chrome.windows.remove(wheelWinId).catch(() => undefined);
      wheelWinId = null;
      return;
    }
  }

  const current = tab ? await chrome.windows.get(tab.windowId).catch(() => undefined) : undefined;
  const left =
    current && typeof current.left === 'number'
      ? Math.max(0, current.left + Math.max(0, ((current.width ?? 900) - WHEEL_W) >> 1))
      : undefined;
  const top =
    current && typeof current.top === 'number'
      ? Math.max(0, current.top + Math.max(0, ((current.height ?? 700) - WHEEL_H) >> 1))
      : undefined;

  try {
    const win = await chrome.windows.create({
      url: wheelPageUrl(wheelHost),
      type: 'popup',
      width: WHEEL_W,
      height: WHEEL_H,
      left,
      top,
    });
    wheelWinId = win.id ?? null;
    return;
  } catch {
    // 继续走最终兜底
  }

  // 机制三（最终）：普通标签页打开轮盘
  await chrome.tabs.create({ url: wheelPageUrl(wheelHost) });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === 'quick-wheel') {
    // 角标闪标：证明命令确实到达了当前版本的后台（现场诊断手段）
    void flashBadge('→');
    void toggleAccountWheel();
  }
  if (command === 'quick-status') {
    // v3.15：Alt+W 归状态轮盘（原「最近配置页轮盘」已于 v3.16 整体移除）
    void flashBadge('⇄');
    void toggleStatusOverlay();
  }
  if (command === 'quick-favorites') {
    // v3.16：Alt+1 常用页面书签轮盘
    void flashBadge('★');
    void toggleFavoritesOverlay();
  }
  if (command === TRANSLATE_COMMAND) {
    // v4.2.0：Alt+T —— 翻译当前输入框内容并只写剪贴板（不回填）
    void runTranslateHotkey();
  }
});

/**
 * `Alt+T` 的实际落地：把命令转给**当前标签页**的内容脚本。
 *
 * ★ 为什么必须在 SW 里转一手：`chrome.commands` 的 `onCommand` **只发给扩展的
 *   service worker**，页面里的内容脚本收不到。所以"快捷键"这条链是
 *   `SW.onCommand → tabs.sendMessage → content/translate.ts`，中间少一环就是"按了没反应"。
 *
 * ★ 为什么**不报错给用户**：内容脚本没注入的页面（`chrome://`、扩展页、PDF 阅读器）
 *   本来就不该有翻译。这时静默返回是**正确行为**，弹个错误反而像出了故障
 *   （与 akso-pass 既有的 `toggleFavoritesOverlay` 处理 `chrome://` 的做法一致）。
 */
async function runTranslateHotkey(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      return;
    }
    await chrome.tabs.sendMessage(tab.id, { type: TRANSLATE_MESSAGE.hotkey });
  } catch {
    // 内容脚本未就绪（页面刚打开/正在导航）：下一次按就好了，不必打扰用户
  }
}

/** 常用页面书签轮盘（v3.16，Alt+1）——同状态轮盘，只做页面内浮层 */
let lastFavToggleAt = 0;
async function toggleFavoritesOverlay(): Promise<void> {
  const now = Date.now();
  if (now - lastFavToggleAt < 300) {
    return;
  }
  lastFavToggleAt = now;
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      void flashBadge('—');
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/favorites-overlay.js'],
      world: 'ISOLATED',
    });
  } catch {
    // 注入失败：角标给信号，不静默（同状态轮盘）
    void flashBadge('⊘');
  }
}

/**
 * 实例状态轮盘（v3.15，Alt+W）——只做页面内浮层，**不设独立小窗兜底**：
 * 状态是「某个实例」的属性，没有实例页就没有可操作对象，开一个空窗没有意义。
 */
let lastStatusToggleAt = 0;
async function toggleStatusOverlay(): Promise<void> {
  const now = Date.now();
  if (now - lastStatusToggleAt < 300) {
    return; // 命令重放 / 系统连击：不重复注入
  }
  lastStatusToggleAt = now;
  try {
    // 用 lastFocusedWindow（与账号轮盘一致）：MV3 的 SW 不属于任何窗口，
    // currentWindow 在 SW 里语义不稳，可能查不到活动页签
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
      void flashBadge('—'); // 受限页（chrome:// 等）：给个可见反馈，别让用户以为是扩展坏了
      return;
    }
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/status-overlay.js'],
      world: 'ISOLATED',
    });
  } catch {
    // 注入失败（该站点未授权 / 受限页）：**不再静默**——角标给个信号，
    // 否则用户只看到「按了没反应」，无法区分命令没绑 vs 注入被拦
    void flashBadge('⊘');
  }
}

/** 角标临时显示文本后恢复 */
async function flashBadge(text: string): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#1E6FFF' });
    await chrome.action.setBadgeText({ text });
    // ★ 必须用裸 setTimeout：ServiceWorkerGlobalScope 没有 window，
    //   写 window.setTimeout 会抛（且被下面的 catch 吞掉）→ 角标文本永远清不掉。
    //   这个缺陷直接毁掉了「按键没反应时，角标能不能证明命令到了」这条现场诊断线索。
    setTimeout(() => {
      void chrome.action.setBadgeText({ text: '' });
    }, 1200);
  } catch {
    // 角标不可用忽略
  }
}

/**
 * 启动时把「本机**实际**生效的快捷键」写进取证缓冲（v3.17.1）。
 *
 * 为什么需要它：Chrome 只在**安装**时登记 `suggested_key`，改 manifest 之后
 * 「重新加载扩展」**不会重绑**（本会话实测：把 `quick-pages` 从 Alt+W 挪到 Alt+E 后，
 * Alt+W 仍然唤出旧功能）。于是「按了没反应」到底是
 * ①命令没绑上、还是 ②绑上了但注入失败，现场极难分辨。
 * 把 `getAll()` 的真实结果落进 `ql:forensics`（诊断包里可见），一眼可辨。
 */
async function logCommandBindings(): Promise<void> {
  try {
    const cmds = await chrome.commands.getAll();
    const bindings = cmds.map((c) => `${c.name}=${c.shortcut || '(未绑定)'}`);
    void forensics('commands', { bindings: bindings.join(' | ') });
  } catch {
    // 取不到不影响业务
  }
}

registerParallelHandlers();
// 把本机实际生效的快捷键写进诊断包（v3.17.1）：区分「命令没绑」与「注入失败」
void logCommandBindings();

// 打开失败自学习（v3.10.9）：绑定页签加载失败时按错误类型翻转协议并原页签重开。
// 优先并行账号（par.* 主流程），未命中再试旧会话模型（session.* 轮盘路径）。
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  if (details.frameId !== 0 || !isSchemeFlipError(details.error)) {
    return; // 仅主 frame 的 scheme 类导航失败才触发协议翻转
  }
  void (async () => {
    // ★ v3.18：这里原来还有一步 `navigation.handleSessionOpenError`（旧 Session 模型的
    //   scheme 自学习）。旧模型已整体废除 —— 现在并行账号那条路自己处理翻转
    //   （`handleOpenError` → `parallelStore.updateScheme`），而它会更新**云端**那条记录，
    //   比原来只写本地 IndexedDB 更正确。
    await handleOpenError(details.tabId, details.error);
  })();
});

/* 启动即短显版本号：重新加载扩展后，无需打开任何界面即可确认新代码已生效 */
void flashBadge(`v${EXT_VERSION.split('.').slice(0, 2).join('.')}`).finally(() => {
  // flashBadge 自身 1.2s 后清空；这里把启动展示延长为额外一次，共约 2.4s 可见窗口
});
