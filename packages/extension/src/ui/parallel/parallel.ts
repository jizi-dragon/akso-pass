import type { CloudSiteSummary, ParallelAccount, ParallelAccountStatus, ParBox } from '../../shared/types';
import type {
  CloudDevicePoll,
  DataBackup,
  RuntimeRequest,
  RuntimeResponse,
} from '../../shared/messages';
import { DEFAULT_FAVORITES, EXT_VERSION, LOCAL_KEYS } from '../../shared/constants';
import { getForwardingLogger, setForwarder } from '../../shared/log';
import { send } from '../send';
import { reconcileBoxes } from '../../shared/box-reconcile';

/* ==================== 日志通道（v3.19） ====================
 *
 * ★★ 本文件此前**零日志**（1964 行、14 处静默 catch）—— 而这不是"忘了加"：
 *   `log()` 的环形缓冲与落盘 sink 都在 **SW 里**，而扩展页面**有自己的 JS 环境**
 *   ⇒ 在这里 `getLogger()` 记的日志写进另一个进程的内存，**永远进不了诊断包**。
 *   （与 `PITFALLS #22` 的 `setSink()` 是同一形态的第二处：机制只接到了 SW。）
 *
 * ★ 所以先**装转发器**：把每条日志交给 SW（`ql.log` ⇒ `restoreToRing`）。
 *   ★ 用 `getForwardingLogger` 而不是 `getLogger`：前者额外转发，**本环境的
 *     console 行为不变** ⇒ 即使 SW 不可达，DevTools 里照样看得到。
 *   ★ 发送函数用**回调形态**并忽略 `chrome.runtime.lastError` ——
 *     转发日志**绝不能**因为"没有接收端"而抛错或产生未捕获的 Promise 拒绝。
 */
const log = getForwardingLogger('parallel');
setForwarder((rec) => {
  try {
    chrome.runtime.sendMessage({ kind: 'ql.log', records: [rec] }, () => {
      // 读一下 lastError 把它吞掉：SW 冷启/重载期间发消息会报"无接收端"，
      // 而那是**正常**的（日志丢一条，业务不受影响）。
      void chrome.runtime.lastError;
    });
  } catch {
    /* 连 sendMessage 都不可用时静默 —— 本环境的 console 已经有这条了 */
  }
});

type BrowserAccount = ParallelAccount & ParallelAccountStatus & { password: boolean };

/* ==================== 元素引用 ==================== */

const verChip = document.getElementById('ver-chip') as HTMLSpanElement;
verChip.textContent = `v${EXT_VERSION}`;

const browserListEl = document.getElementById('browser-list') as HTMLUListElement;
const parForm = document.getElementById('par-form') as HTMLFormElement;
const pHostSelect = document.getElementById('p-host') as HTMLSelectElement;
const pBoxSelect = document.getElementById('p-box') as HTMLSelectElement;
const pTabName = document.getElementById('p-tabname') as HTMLInputElement;
const pUsername = document.getElementById('p-username') as HTMLInputElement;
const pPassword = document.getElementById('p-password') as HTMLInputElement;

const boxChipsEl = document.getElementById('box-chips') as HTMLDivElement;
/* ★ 2026-10-13：「盒子管理」面板（与网页控制台同一套职能）。四个引用都在这里取，
 *   取不到就是 null（`verify-log-redaction` 有一条"HTML 有 id、TS 零引用"的判据，
 *   所以新加的 id **必须**在 TS 里有字面引用 —— 这也是它存在的意义）。 */
const boxForm = document.getElementById('box-form') as HTMLFormElement;
const bNameInput = document.getElementById('b-name') as HTMLInputElement;
const bSiteSelect = document.getElementById('b-site') as HTMLSelectElement;
const boxListEl = document.getElementById('box-list') as HTMLUListElement;
const batchToggle = document.getElementById('batch-toggle') as HTMLButtonElement;
const batchBar = document.getElementById('batch-bar') as HTMLDivElement;
const selCount = document.getElementById('sel-count') as HTMLElement;
const selClear = document.getElementById('sel-clear') as HTMLButtonElement;
const selMove = document.getElementById('sel-move') as HTMLButtonElement;
const selDelete = document.getElementById('sel-delete') as HTMLButtonElement;

const siteForm = document.getElementById('site-form') as HTMLFormElement;
const sHost = document.getElementById('s-host') as HTMLInputElement;
const sName = document.getElementById('s-name') as HTMLInputElement;
/** ★ 2026-10-19：建站时是否同步建一个同名盒子（用户要求：默认「是」）。 */
const sCreateBox = document.getElementById('s-create-box') as HTMLInputElement;
const siteListEl = document.getElementById('site-list') as HTMLUListElement;

const importToggle = document.getElementById('import-toggle') as HTMLButtonElement;
const importPanel = document.getElementById('import-panel') as HTMLDivElement;
const importText = document.getElementById('import-text') as HTMLTextAreaElement;
const importRun = document.getElementById('import-run') as HTMLButtonElement;
const importCancel = document.getElementById('import-cancel') as HTMLButtonElement;

const dataExportBtn = document.getElementById('data-export') as HTMLButtonElement;
const dataImportBtn = document.getElementById('data-import') as HTMLButtonElement;
const dataImportFile = document.getElementById('data-import-file') as HTMLInputElement;
const exportDiagBtn = document.getElementById('export-diag') as HTMLButtonElement;
const favText = document.getElementById('fav-text') as HTMLTextAreaElement;
const favSave = document.getElementById('fav-save') as HTMLButtonElement;
const favReset = document.getElementById('fav-reset') as HTMLButtonElement;
const favTip = document.getElementById('fav-tip') as HTMLSpanElement;

const boxModal = document.getElementById('box-modal') as HTMLDivElement;
const boxModalList = document.getElementById('box-modal-list') as HTMLDivElement;
const boxModalNew = document.getElementById('box-modal-new') as HTMLInputElement;
const boxModalOk = document.getElementById('box-modal-ok') as HTMLButtonElement;
const boxModalCancel = document.getElementById('box-modal-cancel') as HTMLButtonElement;

const siteModal = document.getElementById('site-modal') as HTMLDivElement;
const siteModalTitle = document.getElementById('site-modal-title') as HTMLHeadingElement;
const siteModalDesc = document.getElementById('site-modal-desc') as HTMLParagraphElement;
const siteModalList = document.getElementById('site-modal-list') as HTMLDivElement;
const siteModalCancel = document.getElementById('site-modal-cancel') as HTMLButtonElement;

/**
 * ★★★ v4.2.12：**动态弹窗的挂载点**（`body`）。
 *
 * 编辑账号那个弹窗是**按需建出来的**（字段随站点/盒子清单变化，写死在 HTML 里
 * 就要在每次渲染时同步一堆 `<option>`）。挂在 `body` 而不是某个卡片里：
 * `.modal` 是 `position: fixed; inset: 0`，放在卡片里会被祖先的
 * `overflow: hidden` / `transform` 裁掉 —— 而那种裁切**不报错**，
 * 表现是"弹窗根本没出来"。
 */
const accountModalRoot = document.body;
const cloudBannerEl = document.getElementById('cloud-banner') as HTMLDivElement;
const parHintEl = document.getElementById('par-hint') as HTMLParagraphElement;

/* ---- 数据源帮助气泡 / 云端登录态 / 登录过期条（v3.14.1） ---- */
const sourceHelpBtn = document.getElementById('cloud-help') as HTMLButtonElement;
const sourceHelpPop = document.getElementById('cloud-help-pop') as HTMLDivElement;
const cloudAccountEl = document.getElementById('cloud-account') as HTMLSpanElement;
const cloudMenuEl = document.getElementById('cloud-account-menu') as HTMLDivElement;
const cloudMenuSync = document.getElementById('cloud-menu-sync') as HTMLButtonElement;
const cloudMenuOpen = document.getElementById('cloud-menu-open') as HTMLButtonElement;
const cloudMenuLogout = document.getElementById('cloud-menu-logout') as HTMLButtonElement;
const authBarEl = document.getElementById('auth-bar') as HTMLDivElement;
const authReloginBtn = document.getElementById('auth-relogin') as HTMLButtonElement;
/* ---- 两级导航（v4.2.1 第五轮）----
   一级导航栏右侧的「登录」（未登录时显示）与遮罩上的「登录」是**同一个动作**
   （走设备流授权）；`.tabbed` 是"二级导航及以下"的容器，未登录时整体加 `.is-locked`。 */
const cloudLoginBtn = document.getElementById('cloud-login') as HTMLButtonElement;
const loginMaskEl = document.getElementById('login-mask') as HTMLDivElement;
const loginMaskBtn = document.getElementById('login-mask-btn') as HTMLButtonElement;
const tabbedEl = document.getElementById('tabbed') as HTMLDivElement;

/* ---- 设备授权等待面板（RFC 8628） ---- */
const deviceModal = document.getElementById('device-modal') as HTMLDivElement;
const deviceSpinner = document.getElementById('device-spinner') as HTMLSpanElement;
const deviceStatusEl = document.getElementById('device-status') as HTMLParagraphElement;
const deviceUrlEl = document.getElementById('device-url') as HTMLAnchorElement;
const deviceManual = document.getElementById('device-manual') as HTMLDetailsElement;
const deviceUserCodeInput = document.getElementById('device-user-code-input') as HTMLInputElement;
const deviceUserCodeOpen = document.getElementById('device-user-code-open') as HTMLButtonElement;
const deviceManualMsg = document.getElementById('device-manual-msg') as HTMLParagraphElement;
const deviceCancelBtn = document.getElementById('device-cancel') as HTMLButtonElement;
const deviceRetryBtn = document.getElementById('device-retry') as HTMLButtonElement;


/** 有历史记录或站点清单有它时优先预选的默认站点 */
const PREFERRED_HOST = 'tonbridge-config.aksoegmp.com';
const LAST_HOST_KEY = 'ql:lastParHost';
const LAST_BOX_KEY = 'ql:lastParBox';
/** 默认盒子回退名（存储中可自定义，见 loadBoxes） */
const DEFAULT_BOX_FALLBACK = '默认盒子';
/** 默认盒子当前显示名（未归盒账号的归宿；可被用户重命名） */
let defaultBox = DEFAULT_BOX_FALLBACK;

/* ==================== 状态 ==================== */

let browserAccounts: BrowserAccount[] = [];
/**
 * 站点管理的数据源。
 *
 * ★★ v4.2.12：这里原来有两个本地名单 —— 浏览器授权清单（`grantedHosts`）与
 *   "有授权但在扩展里被停用"的 host（`blockedHosts`）。它们一起让「站点管理」显示的
 *   **不是云端那个站点列表**：云端删掉的站点只要授权还在就还在，云端有的站点只要没授权
 *   就被标成"缺授权"。用户实测到的"两端站点管理对不上"就是这个。
 *
 * ⇒ 现在**云端是唯一权威**（`cloudSites`，由 `refreshSiteNames()` 从 `par.sites` 填），
 *   每一行由 `buildSiteRows()` **一处**构造出来。授权状态一个字都不再影响渲染。
 *
 * ★ 为什么不干脆把 `ql:blockedHosts` / `ql:hiddenHosts` 两个 storage 键也删掉：
 *   旧版本往它们里写过东西，而"盘上还有旧数据"与"代码还在读写它"是两件事。
 *   这一版删掉的是**读取方**，旧数据由 `purgeLegacyHostLists()` 一次性清掉。
 */
/** 盒子清单（默认盒子恒在 + storage 记忆 + 账号实际归属） */
let boxes: string[] = [DEFAULT_BOX_FALLBACK];
/** 当前盒子筛选：'全部' 或盒子名 */
let currentBox: string = '全部';
/** 批量模式与选中集 */
let batchMode = false;
const selectedIds = new Set<string>();

/* ---- 数据源（本地 ↔ 云端，v3.14） ---- */
/** 是否已持有云端会话（没令牌时点「云端」先走授权码） */
let cloudAuthorized = false;
let cloudEmail = '';
/** 展示名与头像（有就用，没有回落邮箱前缀）—— 只影响显示，不参与任何判断 */
let cloudDisplayName = '';
let cloudAvatar = '';
let cloudBaseUrl = '';
/** 合并/切换进行中：禁用分段控件 + 显示忙碌态 + 暂停轮询刷新 */
/** 最近一次 par.list 的失败原因（云端模式下 → 顶部提示条） */
let cloudListError = '';
/**
 * ★★ v3.19：**刚刚那份列表是不是只读副本**（离线降级）。
 *
 * 与 `cloudListError` 是**两件不同的事**，文案也完全不同：
 *   · `cloudListError` 非空 ⇒ **什么都没有**（连副本都没有）⇒ "读不到"
 *   · `offlineStatus.offline` ⇒ **有，但是副本** ⇒ "你现在看的是副本，改不了"
 * ⇒ 合成一句话会让用户分不清"数据没了"与"数据是旧的"。
 */
let offlineStatus: { offline: boolean; savedAt?: number; ageMs?: number; revision?: number } =
  { offline: false };
/** 一次性提示（合并结果等），到点自动消失 */
let bannerFlash: { text: string; kind: 'ok' | 'err' | 'warn'; until: number } | null = null;
const BANNER_FLASH_MS = 15_000;

/* 防闪烁：数据未变化的轮询不做 DOM 重建 */
let lastListKey = '';
let lastSitesKey = '';
let lastChipsKey = '';
let lastHostOptions = '';
let lastBoxOptions = '';
/* ★ 2026-10-13：盒子管理台账与它的站点下拉（同一套"没变就别重建"的路子） */
let lastLedgerKey = '';
let lastBoxSiteKey = '';
/** ★ 2026-10-19：盒子详情缓存的指纹（避免 3 秒轮询每次都写同一个 `ql:boxDetails`） */
let lastBoxDetailsJson = '';

function setStat(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = String(value);
  }
}

function boxOf(a: ParallelAccount): string {
  return a.box?.trim() || defaultBox;
}

/* ==================== 加载与渲染（diff 防闪烁） ==================== */

async function loadBrowserAccounts(): Promise<void> {
  const res = await send({ kind: 'par.list' });
  const failed = res.kind === 'par.list' && !res.result.ok ? res.result.error : '';
  browserAccounts =
    res.kind === 'par.list' && res.result.ok
      ? (res.result.data as BrowserAccount[])
      : [];
  // 云端模式下读不到就是读不到：列表留空 + 顶部醒目提示（绝不回落到本地旧数据）
  cloudListError = failed;

  // ★★ v3.19：问一次"我刚刚看到的是不是只读副本"。
  //   ★ **必须在 `par.list` 之后问** —— `par.list` 是"走云端还是走副本"的**发生地**，
  //     先问列表再问状态，读到的才是与那份列表**同一次**的事实。
  //     （反过来会读到上一次的记账，界面就会错一拍。）
  //   ★ 它**不是**"读不到"的补充说明：`failed` 非空是"什么都没有"，
  //     而这里是"有，但是副本"—— 两种情况的界面文案完全不同。
  //   ★ 失败时**不报离线**：状态问不到就说不知道，绝不用猜测去顶替事实。
  try {
    const off = await send({ kind: 'par.offline' });
    offlineStatus =
      off.kind === 'par.offline' && off.result.ok ? off.result.data : { offline: false };
  } catch (e) {
    // ★★ 2026-10-09 补：这一支**此前完全静默**，而它的后果是**界面说谎**。
    //
    //   问不到状态 ⇒ 判 `offline: false` ⇒ 界面**不显示"只读副本"提示**。
    //   如果此刻用户手里的列表**其实**是离线副本，他会以为那是实时数据，
    //   于是"改了没反应"被理解成"扩展坏了"。
    //
    //   ★ 级别 `warn`：它是**降级**（少了一条重要提示），不是主流程失败。
    //   ★ 不选 `debug`：默认 `info` 级下不输出 ⇒ 等于没加（规则 25）。
    //   ★ 频率：`loadBrowserAccounts()` 每次刷新调一次 ⇒ 低频，不会挤爆环形。
    log.warn('par.offline 取不到 ⇒ 按"在线"处理、**不显示只读副本提示**（'
      + '若列表其实是副本，界面会误导）：%s', e instanceof Error ? e.message : String(e));
    offlineStatus = { offline: false };
  }

  // 清掉已删除账号的选中态
  for (const id of Array.from(selectedIds)) {
    if (!browserAccounts.some((a) => a.id === id)) {
      selectedIds.delete(id);
    }
  }

  const key = JSON.stringify([defaultBox, browserAccounts.map((a) => [
      a.id,
      a.tabName,
      a.username,
      a.siteHost,
      a.color,
      a.password,
      a.tabIds,
      a.hasToken,
      a.enforcementOff ?? false,
      a.box ?? '',
    ])]);
  if (key !== lastListKey) {
    lastListKey = key;
    renderBrowserAccounts();
  } else if (batchMode) {
    syncBatchBar();
  }
  setStat('stat-accounts', browserAccounts.length);
  const onlineCount = browserAccounts.filter((a) => a.tabIds.length > 0).length;
  setStat('stat-online', onlineCount);
  // ★ v4.2.0：侧边导航上的在线数角标（同一事实的第二处显示）。
  //   同一个数字两处显示是刻意的（导航栏在翻译面板上也能看到账号状态），
  //   但**必须由同一处赋值**（都在这里），否则两处会给出不同的数 ——
  //   而"哪个是真的"没有人能判断（本仓历史上 `reused` 就是这么错过的）。
  setStat('nav-online', onlineCount);
}

function badgeOf(a: BrowserAccount): { cls: string; text: string } {
  if (a.enforcementOff) {
    /* ★★ v4.2.12（用户要求 ④「撤销关于授权的提示」）：文案从「未授权 · 已暂停」改成
     * 「需要重新打开」。
     *
     * 为什么不是"把这一态藏起来"：它**是真实状态** —— `enforcementOff` 表示
     * 「本页签没有可执行的宿主权限」，此时 DNR 改不了鉴权头、存储隔离也不生效。
     * 用户看到的后果是"两个账号串号了"，所以**必须可见**。
     * ⇒ 改的是**措辞**：从"授权"（一个用户无从处置的内部概念）改成
     *   "**重新打开**"（一个他能做的动作，而重开时 `ensureHostPermission`
     *   会静默把授权补上 —— 见那里的注释）。
     * ★ 本仓对"删功能要四处都删"有纪律（规则 27），所以这一组文案在
     *   `badgeOf` / `grid-core.ts` / `parallel.html` 三处一起改；
     *   而 `/api/...` 的 `云端未授权` 是**另一件事**（云端会话过期），不在本次范围内。 */
    return { cls: 'login_failed', text: '需要重新打开' };
  }
  if (a.hasToken && a.tabIds.length > 0) {
    return { cls: 'online', text: `在线 ×${a.tabIds.length}` };
  }
  if (a.tabIds.length > 0) {
    return { cls: 'starting', text: '待登录' };
  }
  return { cls: 'offline', text: '离线' };
}

function renderBrowserAccounts(): void {
  browserListEl.innerHTML = '';
  browserListEl.classList.toggle('batch-on', batchMode);

  const filtered =
    currentBox === '全部' ? browserAccounts : browserAccounts.filter((a) => boxOf(a) === currentBox);

  if (!filtered.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    const ico = document.createElement('div');
    ico.className = 'empty-ico';
    ico.textContent = '🗂️';
    const tip = document.createElement('div');
    tip.textContent = browserAccounts.length
      ? `盒子「${currentBox}」暂无账号。把其它盒子的账号移入，或在右侧表单直接添加到该盒子。`
      : cloudAuthorized
        ? '云端账号库还是空的。在下方表单填写并「添加并打开」，账号会直接存到云端。'
        : '云端登录已失效：请点上方「重新登录」恢复后再添加账号。';
    li.append(ico, tip);
    browserListEl.appendChild(li);
    return;
  }

  for (const a of filtered) {
    const li = document.createElement('li');
    li.className = 'account-card' + (selectedIds.has(a.id) ? ' selected' : '');
    li.style.setProperty('--accent', a.color);
    li.dataset.id = a.id;

    if (batchMode) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'ac-check';
      check.checked = selectedIds.has(a.id);
      check.title = '选择该账号';
      check.addEventListener('change', () => {
        if (check.checked) {
          selectedIds.add(a.id);
        } else {
          selectedIds.delete(a.id);
        }
        li.classList.toggle('selected', check.checked);
        syncBatchBar();
      });
      li.append(check);
    }

    const head = document.createElement('div');
    head.className = 'ac-head';

    const avatar = document.createElement('span');
    avatar.className = 'ac-avatar';
    avatar.style.setProperty('--ring', a.color);
    avatar.textContent = (a.tabName || a.username).trim().charAt(0).toUpperCase() || '?';
    const online = a.tabIds.length > 0;
    const dot = document.createElement('i');
    dot.className = online ? 'dot on' : 'dot';
    avatar.append(dot);

    const meta = document.createElement('div');
    meta.className = 'meta';
    const alias = document.createElement('div');
    alias.className = 'alias';
    alias.textContent = a.tabName || a.username;
    const sub = document.createElement('div');
    sub.className = 'sub';
    const boxTag = document.createElement('span');
    boxTag.className = 'box-tag';
    boxTag.textContent = boxOf(a);
    sub.append(boxTag, `${a.username} · ${a.siteHost}${a.password ? ' · 已存密码' : ''}`);
    meta.append(alias, sub);

    const badge = document.createElement('span');
    const b = badgeOf(a);
    badge.className = `badge ${b.cls}`;
    badge.textContent = b.text;

    head.append(avatar, meta, badge);

    const actions = document.createElement('div');
    actions.className = 'ac-actions';

    const openBtn = document.createElement('button');
    openBtn.className = 'btn-ghost';
    openBtn.textContent = a.tabIds.length ? '聚焦标签页' : '打开';
    openBtn.addEventListener('click', () => void openAccount(a.id, false));

    /* ★★★ 2026-10-19（用户要求 ③）：**撤掉「新标签页」按钮**。
     *
     * 用户原话：「在 akso-pass 的账号中心中，隐藏按钮『打开新标签页』。」
     * 同账号多页并行的能力仍在（Alt+Q 轮盘、页面内 `window.open` 的亲子继承都走
     * 别的入口），这里撤掉的只是账号卡上那个**会让人以为"又要登录一次"**的按钮。 */

    const editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost';
    editBtn.textContent = '编辑';
    /* ★★★ v4.2.12（用户要求"两端管理逻辑一致"，口径以云端为准）：
     * 这一格从 `prompt('新的页签名…')` 换成**完整的编辑弹窗** ——
     * 与 `akso-cloud` 控制台那个弹窗同一组字段：账号名 / 页签名 / 所属站点 /
     * 盒子 / 密码 / 备注。
     *
     * ★ 为什么不能继续用 `prompt`：① 它只能收一个值，而"选错了站点"是**用户真会
     *   遇到的事**（云端那边为此专门加过 `siteId`，见 `test_account_edit.py`）；
     *   ② prompt 在扩展页里样式不可控；③ **无法写自动化判据**
     *   （Playwright 只能靠 dialog 事件间接驱动）—— 而"判据不可写"在本仓等于
     *   "这条路径不会被验"（这正是 `beginRename` 早就改成就地编辑的原因）。
     */
    editBtn.addEventListener('click', () => openAccountEditor(a));

    const moveBtn = document.createElement('button');
    moveBtn.className = 'btn-ghost';
    moveBtn.textContent = '移入盒子';
    moveBtn.addEventListener('click', () => openBoxChooser([a.id]));

    const del = document.createElement('button');
    del.className = 'btn-danger';
    del.textContent = '删除';
    del.addEventListener('click', () => {
      if (confirm(`删除账号「${a.tabName || a.username}」？将同时关闭其所有并行标签页。`)) {
        void (async () => {
          await send({ kind: 'par.delete', id: a.id });
          await refreshAll();
        })();
      }
    });

    actions.append(openBtn, editBtn, moveBtn, del);
    li.append(head, actions);
    browserListEl.appendChild(li);
  }
}

/**
 * ★★★ v4.2.12：**账号编辑弹窗**（与 `akso-cloud` 控制台的编辑弹窗同字段、同语义）。
 *
 * | 字段 | 语义 | 与云端的对应 |
 * |---|---|---|
 * | 账号名 `username` | 登录用户名 | `AccountPatch.username` |
 * | 页签名 `tabName` | 该账号所有标签页的标题 | `AccountPatch.tabName` |
 * | 所属站点 `siteId` | **换站点**（同站点下不许同名） | `AccountPatch.siteId` |
 * | 盒子 `box` | 收纳分组（默认盒翻成空串） | `AccountPatch.box` |
 * | 密码 `password` | **留空 = 不改**（不是清空） | `AccountPatch.password` |
 * | 备注 `note` | 自由文本（此前扩展完全看不到） | `AccountPatch.note` |
 *
 * ★★ 三条**必须照抄云端**的取舍（每一条在 `site.js` 的 `openEdit` 里也都写着）：
 *   1. **只在真的换了站点时才带 `siteId`** —— 无脑带上会让每次保存都去走一遍
 *      "挪站点"的校验路径，而同站点下它不该触发任何站点相关的逻辑。
 *   2. **密码留空 = 不动**，`if (pw) body.password = pw`。合成"空串=清空"会让
 *      用户什么都没填就把密码清了 —— 表现是**下次打开账号填表静默失效**。
 *   3. **什么都没改就不发请求** —— 服务端每次 PATCH 都会推 `revision`
 *      （见 `accounts.py` 的 `:379`），空保存会让别的客户端白拉一次全量快照。
 *
 * ★ 站点下拉的数据源是 `cloudSites`（站点管理那一份）—— 与云端控制台的
 *   `sites` 数组同源。**不要**另取一份：那会让"站点管理里有的、下拉里没有"重现。
 */
function openAccountEditor(a: BrowserAccount): void {
  const card = document.createElement('div');
  card.className = 'modal-card';
  const h = document.createElement('h3');
  h.textContent = '编辑账号';

  const form = document.createElement('form');
  form.className = 'form';

  /** 一个「标签 + 控件 + 可选说明」的行（与站点表单同一形状，避免第二套表单观感） */
  const field = (label: string, control: HTMLElement, hint?: string): HTMLLabelElement => {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      wrap.append(small);
    }
    return wrap;
  };

  const uInput = document.createElement('input');
  uInput.type = 'text';
  uInput.value = a.username;
  uInput.maxLength = 200;
  uInput.required = true;

  const tInput = document.createElement('input');
  tInput.type = 'text';
  tInput.value = a.tabName;
  tInput.maxLength = 120;
  tInput.placeholder = '空则用账号名';

  // 所属站点：当前值按 `siteId` 预选中（★ 不是按 host —— 服务端认 id）
  const sSelect = document.createElement('select');
  for (const s of cloudSites) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.displayName === s.host ? s.host : `${s.displayName}（${s.host}）`;
    if (a.siteId && s.id === a.siteId) {
      opt.selected = true;
    }
    sSelect.append(opt);
  }
  // ★ 当前站点不在下拉里（离线/云端记录缺失）时**补一个占位项**并选中它。
  //   不补的话 `select.value` 会落到第一项 ⇒ 用户一保存就把账号挪到别的站点，
  //   而他什么都没改 —— 一个静默的数据迁移。
  if (a.siteId && !cloudSites.some((s) => s.id === a.siteId)) {
    const opt = document.createElement('option');
    opt.value = a.siteId;
    opt.textContent = `${a.siteHost || '未知站点'}（当前）`;
    opt.selected = true;
    sSelect.prepend(opt);
  }

  const bSelect = document.createElement('select');
  for (const name of boxes) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === boxOf(a)) {
      opt.selected = true;
    }
    bSelect.append(opt);
  }

  const pInput = document.createElement('input');
  pInput.type = 'password';
  pInput.maxLength = 500;
  pInput.placeholder = '留空 = 不修改';
  pInput.autocomplete = 'new-password';

  const nInput = document.createElement('input');
  nInput.type = 'text';
  nInput.value = a.note ?? '';
  nInput.maxLength = 1000;

  form.append(
    field('账号名', uInput),
    field('页签名', tInput, '该账号所有标签页的标题'),
    field('所属站点', sSelect, '换站点后，同一站点下不能有同名账号'),
    field('盒子', bSelect),
    field('密码', pInput, '留空表示不改密码（不是清空）'),
    field('备注', nInput),
  );

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost';
  cancel.type = 'button';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.className = 'btn-primary';
  save.type = 'submit';
  save.textContent = '保存';
  actions.append(cancel, save);
  form.append(actions);

  card.append(h, form);
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.append(card);
  accountModalRoot.append(overlay);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
    }
  });
  cancel.addEventListener('click', close);
  uInput.focus();
  uInput.select();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const patch: {
        username?: string;
        tabName?: string;
        siteId?: string;
        box?: string;
        password?: string;
        note?: string;
      } = {};
      const nextUser = uInput.value.trim();
      const nextTab = tInput.value.trim();
      const nextNote = nInput.value;
      if (nextUser !== a.username) {
        patch.username = nextUser;
      }
      if (nextTab !== a.tabName) {
        patch.tabName = nextTab;
      }
      // ★ 取舍 1：只在**真的换了站点**时才带（见函数头注释）
      if (sSelect.value && sSelect.value !== a.siteId) {
        patch.siteId = sSelect.value;
      }
      if (bSelect.value !== boxOf(a)) {
        patch.box = bSelect.value;
      }
      // ★ 取舍 2：留空 = 不改
      if (pInput.value) {
        patch.password = pInput.value;
      }
      if (nextNote !== (a.note ?? '')) {
        patch.note = nextNote;
      }
      // ★ 取舍 3：什么都没改就不发请求
      if (!Object.keys(patch).length) {
        close();
        return;
      }
      save.disabled = true;
      cancel.disabled = true;
      save.textContent = '保存中…';
      const res = await send({ kind: 'par.update', id: a.id, patch });
      if (!res.result.ok) {
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = '保存';
        alert(`保存失败：${res.result.error}`);
        return;
      }
      close();
      lastListKey = ''; // 强制重渲染（页签名/站点/盒子都可能变了）
      await refreshAll();
    })();
  });
}

/* ==================== 盒子 ==================== */

/**
 * 本地缓存的**禁用名单**（`ql:disabledBoxes`）。
 *
 * ★★ 2026-10-13 口径变更：它**不再是"用户的本地偏好"**，而是
 *   **云端 `box.disabled` 的离线副本** —— 每次成功拉到 `/api/boxes` 时被覆盖
 *   （见 `reconcileBoxesWithCloud`）。
 *   ★ 为什么要写回 storage 而不是只留在内存：轮盘那两处
 *     （`ui/wheel/wheel.ts` 与 `content/wheel-overlay.ts`）**各自直读 storage**，
 *     它们不经过 background。把云端状态写进这三个键 = 那两处**一行都不用改**
 *     就跟着变成云端口径（它们本来就是"离线也要能用"的实现）。
 */
let disabledBoxes: string[] = [];

/**
 * 云端的**盒子详情**（名字 → `ParBox`），只作渲染依据。
 *
 * ★ 2026-10-19：云端拿不到时**不再显示「离线：站点信息未同步」** ——
 *   见 `loadBoxes` 与 `renderBoxLedger` 里的说明。这里先用
 *   `ql:boxDetails` 的**上一次成功快照**填充（离线可读），拿不到才真的为空。
 */
let boxDetail = new Map<string, ParBox>();

/** 把 storage 里那份只读副本还原成 `boxDetail`（形状不对就整份丢弃，宁可空也不半空） */
function restoreBoxDetailCache(raw: unknown): void {
  if (boxDetail.size || !Array.isArray(raw)) {
    return;
  }
  const rows = raw
    .filter((r): r is ParBox => {
      const o = (r ?? {}) as Record<string, unknown>;
      return typeof o.name === 'string' && o.name.length > 0;
    })
    .map((r) => ({
      name: r.name,
      isDefault: r.isDefault === true,
      disabled: r.disabled === true,
      autoDisabled: r.autoDisabled === true,
      count: Number.isFinite(r.count) ? r.count : 0,
      renameable: r.renameable !== false,
      deletable: r.deletable !== false,
      bindable: r.bindable !== false,
      siteId: typeof r.siteId === 'string' ? r.siteId : '',
      siteName: typeof r.siteName === 'string' ? r.siteName : '',
    }));
  if (rows.length) {
    boxDetail = new Map(rows.map((b) => [b.name, b]));
    lastBoxDetailsJson = JSON.stringify(rows);
  }
}

async function loadBoxes(): Promise<void> {
  const stored = await chrome.storage.local.get([
    LOCAL_KEYS.boxList,
    LOCAL_KEYS.defaultBox,
    LOCAL_KEYS.disabledBoxes,
    LOCAL_KEYS.boxDetails,
  ]);
  restoreBoxDetailCache(stored[LOCAL_KEYS.boxDetails]);
  const remembered = (stored[LOCAL_KEYS.boxList] as string[] | undefined) ?? [];
  defaultBox = ((stored[LOCAL_KEYS.defaultBox] as string | undefined) ?? '').trim() || DEFAULT_BOX_FALLBACK;
  disabledBoxes = (stored[LOCAL_KEYS.disabledBoxes] as string[] | undefined) ?? [];
  const fromAccounts = browserAccounts.map((a) => boxOf(a));
  boxes = [...new Set([defaultBox, ...remembered.filter((b) => b !== defaultBox), ...fromAccounts])];
  setStat('stat-boxes', boxes.length);
  // ★★ 2026-10-12（用户报"盒子的数据没有做好同步"）：**云端那份是权威**。
  //   上面那个并集里带着"本地记住的"，而 `ql:boxes` **只会被加、不会被减** ⇒
  //   云端删掉/改名的盒子会永远留在界面上（实测：扩展 5 个、云端 2 个）。
  //   ⇒ 拿到云端答复后对账；**拿不到就一个字都不动**（离线时本地那份是唯一真相）。
  await reconcileBoxesWithCloud();
}

/**
 * 用**云端的**盒子名单剪掉本地记住的多余项，并把云端的权威状态写回缓存。
 *
 * ## 三条不能省的约束（每一条都对应一种"看起来正常但是坏的"）
 *
 * 1. **拿不到就不动**：`par.boxes` 在离线时会失败（`tryRun` 的结果带 error）。
 *    那时若把本地那份当成"多余的"清掉，用户会看到**自己的盒子全没了** ——
 *    而离线是扩展的**主要使用场景之一**（`par.offline` 那套本地只读副本就是为此存在的）。
 * 2. **只剪"记住的"，不剪"账号里出现的"**：某个盒名可能因为"账号还没同步过来"
 *    暂时不在云端名单里。剪掉它，用户会看到**自己的账号挂在一个不存在的盒子上**。
 * 3. **只在真的变了时才写盘**：否则每次 `loadBoxes()` 都写一次 `chrome.storage.local`，
 *    而它在每次渲染里都会跑。
 *
 * ## ★★ 2026-10-13：这里同时是"**云端为权威**"的落地点
 *
 * 云端答复里除了名字还有 `disabled` / `autoDisabled` / 默认盒名 / 站点关联。
 * 本函数把它们**写回那三个本地键**（`ql:defaultBox` / `ql:disabledBoxes` / `ql:boxes`），
 * 于是：
 *   · 面板里的灰态、轮盘跳过的页、`boxOf()` 的回落 —— 全部跟着云端走；
 *   · 轮盘那两处**直读 storage 的独立实现**（小窗 + 页内浮层）一行都不用改；
 *   · 用户**不能再**在本地"改默认盒名"或"改禁用态"——那两个动作现在都打到云端。
 * ★ `boxDetail` 在内存里，同时落一份 `ql:boxDetails` 只读副本（2026-10-19）：
 *   离线时用**上一次成功同步**的详情渲染，而不是把取不到的字段显示成 0 / 空串
 *   （那会被读成"这个盒子真的没有账号"），也不再显示「离线未同步」的提示。
 */
async function reconcileBoxesWithCloud(): Promise<void> {
  // ★ 类型来自 `shared/messages.ts`（本仓规则：协议单一定义，调用点不就地 cast）。
  const res = await send({ kind: 'par.boxes' }).catch(() => null);
  const truth = res && res.kind === 'par.boxes' && res.result.ok ? res.result.data : null;

  /* ★★★ 2026-10-14：**版本错配的防线**（这次"数据不同步"的直接触发点）。
   *
   * 面板页面与 Service Worker 是**两份独立产物**。改了 `par.boxes` 的载荷形状之后，
   * 如果只刷新了页面、没在 `chrome://extensions` 点「重新加载」，就会跑出
   * "**新页面 + 旧 SW**"：旧 SW 回的是 `{names: [...]}`，而下面读的是 `truth.boxes`
   * ⇒ **第一句 `.map` 就抛**。
   * ★ 而那一抛的代价远不止盒子：它会把 `refreshAll()` 里排在**后面**的
   *   `loadBrowserAccounts()` 一并带走 ⇒ **账号列表再也不刷新**（用户报的症状）。
   * ⇒ 认不出形状就按"**没拿到**"处理（与离线同一条路，一个字都不动），
   *   并且**大声说出来** —— 这是唯一能让"两个版本在跑"这件事变得可见的地方。
   */
  const cloudBoxes = Array.isArray(truth?.boxes) ? truth.boxes : null;
  if (truth && !cloudBoxes) {
    log.warn('par.boxes 的载荷里没有 boxes 数组 —— 多半是「页面已更新、扩展没重新加载」'
      + '造成的版本错配。本轮按"没拿到"处理（盒子保持本地那份）；'
      + '请在 chrome://extensions 点「重新加载」把两半对齐。');
  }

  // ★★ 对账的**规则**在 `shared/box-reconcile.ts`（纯函数）—— 这里只负责
  //   "取云端名单 + 写回 storage"。抽出去的理由是那三条约束里有两条是**反方向**的
  //   （离线不许剪、账号在用的不许剪），而它们跑起来要云端授权 ⇒ 不抽出来就
  //   永远验不到（本脚本的第一版正是因此只能 SKIP）。
  //   ★ 云端没答复时 `cloudNames` 传空数组，纯函数会**原样返回**。
  const cloudNames = cloudBoxes?.map((b) => b.name) ?? [];
  const out = reconcileBoxes({
    remembered: boxes.filter((b) => b !== defaultBox),
    fromAccounts: browserAccounts.map((a) => boxOf(a)),
    cloudNames,
    defaultBox,
  });

  const patch: Record<string, unknown> = {};

  if (cloudBoxes) {
    boxDetail = new Map(cloudBoxes.map((b) => [b.name, b]));
    /* ★ 2026-10-19：把服务端算好的详情落一份只读副本（`ql:boxDetails`）。
     * 离线时盒子台账用**上一次同步到的状态**渲染，而不是显示「离线：站点信息未同步」
     * （用户明确要求不要那个提示）。★ 只在内容真的变了时写盘 —— 这个函数挂在
     * 3 秒轮询上，稳态必须零写。 */
    const detailJson = JSON.stringify(cloudBoxes);
    if (detailJson !== lastBoxDetailsJson) {
      lastBoxDetailsJson = detailJson;
      patch[LOCAL_KEYS.boxDetails] = cloudBoxes;
    }

    // ① 默认盒名 = **云端权威**（用户不能再改它：服务端把默认盒名做成了常量）
    //    ★ 本地那个键从此只是缓存 —— 用户以前在本地改过的名字会在这时被纠回来，
    //      而那个旧名字会作为"云端没有、账号也没用"的记住项被下面的对账剪掉。
    //    ★ `String(... ?? '')`：载荷形状再怎么漂，这里也不许抛（抛了就拖死账号刷新）。
    const cloudDefault = String(truth?.default ?? '').trim();
    if (cloudDefault && cloudDefault !== defaultBox) {
      defaultBox = cloudDefault;
      patch[LOCAL_KEYS.defaultBox] = cloudDefault;
    }

    // ② 禁用态 = **云端权威**。★ 服务端的 `disabled` **已经含**了
    //    "默认盒且为空"的派生态（`autoDisabled`）⇒ 不要再叠加本地派生，
    //    否则会出现"服务端说启用、扩展判禁用"这第三套口径。
    const cloudDisabled = cloudBoxes.filter((b) => b.disabled).map((b) => b.name).sort();
    const localDisabled = [...disabledBoxes].sort();
    if (cloudDisabled.join('\u0000') !== localDisabled.join('\u0000')) {
      disabledBoxes = cloudDisabled;
      patch[LOCAL_KEYS.disabledBoxes] = cloudDisabled;
    }
  }

  if (out.changed) {
    boxes = out.boxes;
    setStat('stat-boxes', boxes.length);
    // ★ 只把"记住的"那一份写回：默认盒由 `ql:defaultBox` 表达，
    //   账号在用的名字由账号数据自己表达 —— 别让它们互相污染。
    const used = new Set(browserAccounts.map((a) => boxOf(a)));
    patch[LOCAL_KEYS.boxList] = boxes.filter((b) => b !== defaultBox && !used.has(b));
  }

  if (Object.keys(patch).length) {
    await chrome.storage.local.set(patch);
  }
}

async function saveBoxes(): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.boxList]: boxes.filter((b) => b !== defaultBox) });
}

async function saveDisabled(): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.disabledBoxes]: disabledBoxes });
}

/**
 * 盒子禁用态 = **云端那份名单**（`ql:disabledBoxes` 只是它的离线副本）。
 *
 * ★★ 2026-10-13 改口径：改前这里是 `本地名单 ∪ "默认盒且为空"` 的**本地派生**，
 *   于是同一个事实有三个来源（云端 `disabled` / 本地名单 / 本地派生），
 *   结果就是"在网页上禁用的盒子，扩展轮盘照旧会切到它"。
 *   ⇒ 现在只读**一个**来源。**服务端的 `disabled` 已经把"默认盒且为空"折进去了**
 *     （`box_public()` 的 `auto_off`），所以那条派生在这里是多余的 ——
 *     留着它反而会出现"服务端说启用、扩展判禁用"的第三套口径。
 *   ★ 离线时读到的是**上一次成功同步的云端状态**（那三个键由
 *     `reconcileBoxesWithCloud` 写回）—— 这也正是轮盘那两处直读 storage 的实现
 *     不用改一个字就能跟着变的原因。
 */
function isBoxDisabled(name: string): boolean {
  return disabledBoxes.includes(name);
}

function renderBoxChips(): void {
  const key = JSON.stringify([boxes, currentBox, browserAccounts.map((a) => boxOf(a)), batchMode]);
  if (key === lastChipsKey) {
    return;
  }
  lastChipsKey = key;
  boxChipsEl.innerHTML = '';

  const countOf = (name: string) => browserAccounts.filter((a) => boxOf(a) === name).length;

  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chip' + (currentBox === '全部' ? ' active' : '');
  const allLabel = document.createElement('span');
  allLabel.textContent = '全部';
  const allN = document.createElement('span');
  allN.className = 'chip-n';
  allN.textContent = String(browserAccounts.length);
  all.append(allLabel, allN);
  all.addEventListener('click', () => {
    currentBox = '全部';
    lastListKey = '';
    renderBoxChips();
    renderBrowserAccounts();
  });
  boxChipsEl.append(all);

  for (const name of boxes) {
    const off = isBoxDisabled(name);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (currentBox === name ? ' active' : '') + (off ? ' chip-off' : '');
    const label = document.createElement('span');
    label.textContent = name;
    const n = document.createElement('span');
    n.className = 'chip-n';
    n.textContent = String(countOf(name));
    chip.append(label, n);
    /* ★★★ 2026-10-13（用户要求，与网页控制台同步）：
     *   这一排芯片**只做筛选**（点一下 = 只看这个盒子）。
     *   改名 / 禁用 / 删除 三个行内操作与「＋ 新建盒子」**全部撤掉**，
     *   它们搬进了「盒子管理」面板（`renderBoxLedger`）。
     *
     * ★ 为什么"禁用/启用"必须搬而不是删：它当时**只有芯片这一个入口**，
     *   直接删等于让 `box.disabled` 在界面上再也碰不到 ——
     *   而它还在影响轮盘翻页与网页控制台的显示。
     *   判据见 `tools/verify/verify-boxmgmt.mjs` 的 R1/R2/R4。 */
    const d = boxDetail.get(name);
    chip.title = d
      ? [name, d.isDefault ? '默认盒子' : '', off ? '已禁用（轮盘跳过）' : '', d.siteName ? `关联站点：${d.siteName}` : '']
        .filter(Boolean).join(' · ')
      : name;
    chip.addEventListener('click', () => {
      currentBox = name;
      lastListKey = '';
      renderBoxChips();
      renderBrowserAccounts();
    });
    boxChipsEl.append(chip);
  }
}

/* ==================== 盒子管理台账（2026-10-13） ==================== */

/**
 * ★★★ 新建盒子：**打到云端**，可顺带关联一个站点。
 *
 * ## 为什么这是一个真修复（而不是"把按钮挪个地方"）
 *
 * 改前 UI 上的「＋ 新建盒子」是**纯本地**的：`boxes.push(name)` + 写 `ql:boxes`。
 * 而自 2026-10-12 起**云端名单是权威**（`reconcileBoxesWithCloud` 会剪掉
 * "云端没有、账号也没用"的记住项）⇒ 那个盒子在下一次 `loadBoxes()` 就被剪掉：
 * **建好了，然后自己消失**，而两边都不报错。
 *
 * ⇒ 现在走 `par.createBox`（→ `POST /api/boxes`），并且**先建盒、再关联站点**：
 *   两步分开是因为它们的失败语义不同 —— 盒子建成了而关联失败时，
 *   必须**如实说出来**（用户会以为盒子没建成、再点一次 ⇒ 建出两个）。
 */
async function createBoxFromForm(): Promise<void> {
  const name = bNameInput.value.trim();
  if (!name) {
    alert('请填盒子名称。');
    bNameInput.focus();
    return;
  }
  const res = await send({ kind: 'par.createBox', name });
  if (!(res.kind === 'par.createBox' && res.result.ok)) {
    alert(`新建失败：${res.kind === 'par.createBox' && !res.result.ok ? res.result.error : '无响应'}`);
    return;
  }
  const created = res.result.data.name;
  bNameInput.value = '';
  const siteId = bSiteSelect.value;
  if (siteId) {
    const bind = await send({ kind: 'par.bindBoxSite', name: created, siteId });
    if (!(bind.kind === 'par.bindBoxSite' && bind.result.ok)) {
      const why = bind.kind === 'par.bindBoxSite' && !bind.result.ok ? bind.result.error : '无响应';
      alert(`盒子「${created}」已创建，但关联站点失败：${why}`);
    }
  }
  lastChipsKey = '';
  lastBoxOptions = '';
  await refreshAll();
}

/**
 * 渲染「盒子管理」台账：一行一个盒子。
 *
 * ★ 三件事都在**服务端算好**的字段上分叉，前端**不自己判** `name === defaultBox`
 *   （判据只该有一处；两处迟早不一致 —— 这是 2026-10-13 那批改动的原话）：
 *   · `deletable` / `renameable` / `bindable` —— 决定给不给入口
 *     （默认盒三个都是 false ⇒ 只显示一个「固定」标记）；
 *   · `disabled` —— 按钮文案是「禁用」还是「启用」；
 *   · `siteId` / `siteName` —— 关联站点那一格。
 *
 * ★ 2026-10-19（用户要求）：不再区分"离线 / 在线"两种画法 ——
 *   云端详情每次成功拉取都会落一份只读副本（`ql:boxDetails`），离线时用
 *   **上一次同步到的状态**渲染（站点关联、按钮都照常）。只有在**从未**拿到过
 *   任何一份快照时，才只画名字 + 账号数、不给操作按钮（那些操作必然失败）。
 *   ★ 关键差别是**文案**：那一格留空，而不是写「离线：站点信息未同步」——
 *     后者会让用户以为盒子坏了，而他对此什么都做不了。
 */
function renderBoxLedger(): void {
  const key = JSON.stringify([
    boxes,
    [...boxDetail.entries()].map(([k, v]) => [k, v.disabled, v.siteId, v.siteName, v.count, v.isDefault]),
    disabledBoxes,
  ]);
  if (key === lastLedgerKey) {
    return;
  }
  lastLedgerKey = key;
  boxListEl.innerHTML = '';

  if (!boxes.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '还没有盒子。';
    boxListEl.append(li);
    return;
  }

  for (const name of boxes) {
    const d = boxDetail.get(name);
    const off = isBoxDisabled(name);
    const li = document.createElement('li');
    li.className = 'site-card';
    li.dataset.box = name;

    const head = document.createElement('div');
    head.className = 'site-card-head';
    const alias = document.createElement('div');
    alias.className = 'site-card-name';
    alias.textContent = name;
    head.append(alias);
    if (d?.isDefault) {
      const tag = document.createElement('span');
      tag.className = 'site-card-off';
      tag.textContent = '默认';
      tag.title = '默认盒子：未归盒账号的归宿。它不能改名、不能删除、不能禁用，也不参与站点关联。';
      head.append(tag);
    }
    if (off) {
      const tag = document.createElement('span');
      tag.className = 'site-card-off';
      tag.textContent = d?.autoDisabled ? '自动禁用' : '已禁用';
      tag.title = d?.autoDisabled
        ? '默认盒为空时自动跳过（轮盘不显示这一页）'
        : '轮盘跳过这个盒子（盒内账号不受影响）';
      head.append(tag);
    }

    // 关联站点那一格：三种形态，判据只来自服务端的 `bindable` / `siteId`
    const domain = document.createElement('div');
    domain.className = 'site-card-domain';
    if (d) {
      domain.textContent = d.siteId
        ? `关联站点：${d.siteName || d.siteId}`
        : (d.bindable ? '未关联站点' : '不参与站点关联');
    } else {
      /* ★ 2026-10-19（用户要求）：**不显示「离线：站点信息未同步」**。
       * 盒子详情是自动同步的（见 `reconcileBoxesWithCloud`），拿不到时说明
       * 还没拉到第一份快照 —— 那是"暂时没有信息"，不是"你的盒子坏了"。
       * 与其说一句用户无法处置的离线提示，不如这一格留空。 */
      domain.hidden = true;
    }

    const count = document.createElement('div');
    count.className = 'site-card-count';
    const n = document.createElement('b');
    n.textContent = String(d ? d.count : browserAccounts.filter((a) => boxOf(a) === name).length);
    const unit = document.createElement('span');
    unit.textContent = '个账号';
    count.append(n, unit);

    const actions = document.createElement('div');
    actions.className = 'site-actions';
    if (!d) {
      /* 还没有任何一份云端快照（首次启动即离线）：**不给操作按钮**。
       * 操作都要打到云端，离线时点了必然失败；而"失败"不是用户的错。
       * ★ 这里**不再**画一个「离线」标签 —— 理由同上。 */
    } else if (d.isDefault) {
      const fixed = document.createElement('span');
      fixed.className = 'muted';
      fixed.textContent = '固定';
      fixed.title = '默认盒不能改名 / 删除 / 禁用，也不参与站点关联';
      actions.append(fixed);
    } else {
      if (d.renameable) {
        const btn = document.createElement('button');
        btn.className = 'btn-ghost btn-sm';
        btn.type = 'button';
        btn.textContent = '改名';
        btn.addEventListener('click', () => void renameBoxFlow(name));
        actions.append(btn);
      }
      {
        const btn = document.createElement('button');
        btn.className = 'btn-ghost btn-sm';
        btn.type = 'button';
        btn.textContent = off ? '启用' : '禁用';
        btn.title = off ? '恢复轮盘切换' : '轮盘跳过这个盒子';
        btn.addEventListener('click', () => void toggleBoxFlow(name));
        actions.append(btn);
      }
      if (d.bindable) {
        const btn = document.createElement('button');
        btn.className = 'btn-ghost btn-sm';
        btn.type = 'button';
        btn.textContent = d.siteId ? '改绑' : '关联站点';
        btn.title = '把这个盒子关联到一个站点（一个盒子只绑一个）';
        btn.addEventListener('click', () => void bindSitePicker(name));
        actions.append(btn);
        if (d.siteId) {
          const un = document.createElement('button');
          un.className = 'btn-ghost btn-sm';
          un.type = 'button';
          un.textContent = '解除关联';
          un.addEventListener('click', () => void bindBoxSiteFlow(name, ''));
          actions.append(un);
        }
      }
      if (d.deletable) {
        const btn = document.createElement('button');
        btn.className = 'btn-danger btn-sm';
        btn.type = 'button';
        btn.textContent = '删除';
        btn.addEventListener('click', () => void removeBoxFlow(name));
        actions.append(btn);
      }
    }

    li.append(head, domain, count, actions);
    boxListEl.append(li);
  }
}

/** 「关联站点」：弹出站点选择列表（与「移入盒子」同一套弹层，不让用户记序号/手输）。 */
function bindSitePicker(name: string): void {
  const usable = cloudSites;
  if (!usable.length) {
    alert('还没有可关联的站点 —— 先在「站点管理」里添加一个站点。');
    return;
  }
  const cur = boxDetail.get(name)?.siteId ?? '';
  siteModalTitle.textContent = `关联站点 · ${name}`;
  siteModalDesc.textContent = cur
    ? `当前关联：${boxDetail.get(name)?.siteName || cur}。选择另一个站点即可改绑。`
    : '选择一个站点。一个盒子只能关联一个站点。';
  siteModalList.innerHTML = '';
  for (const site of usable) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'box-option' + (site.id === cur ? ' active' : '');
    row.dataset.siteId = site.id;
    const label = document.createElement('span');
    label.textContent = `${site.displayName}（${site.host}）`;
    row.append(label);
    row.addEventListener('click', () => {
      hideSiteModal();
      void bindBoxSiteFlow(name, site.id);
    });
    siteModalList.append(row);
  }
  siteModal.classList.remove('hidden');
}

function hideSiteModal(): void {
  siteModal.classList.add('hidden');
}

siteModalCancel.addEventListener('click', hideSiteModal);
siteModal.addEventListener('click', (e) => {
  if (e.target === siteModal) {
    hideSiteModal();
  }
});

/**
 * 新建盒子表单里那个站点下拉（"不关联" + 每个可关联的站点）。
 *
 * ★ 站点来源是**云端站点表**（`cloudSites`，含 `id`）而不是浏览器授权清单 ——
 *   服务端按 **id** 认站点（`POST /api/boxes/bind-site` 收 `siteId`）。
 */
function fillBoxSiteOptions(): void {
  const usable = cloudSites;
  const key = usable.map((s) => `${s.id}:${s.displayName}`).join('|');
  if (key === lastBoxSiteKey) {
    return;
  }
  lastBoxSiteKey = key;
  const keep = bSiteSelect.value;
  bSiteSelect.innerHTML = '';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '不关联站点';
  bSiteSelect.append(none);
  for (const s of usable) {
    const op = document.createElement('option');
    op.value = s.id;
    op.textContent = s.displayName;
    bSiteSelect.append(op);
  }
  if (keep && usable.some((s) => s.id === keep)) {
    bSiteSelect.value = keep;
  }
}

/**
 * 禁用 / 启用盒子：**打到云端**（服务端是权威），然后从云端重拉一遍。
 *
 * ★★ 2026-10-13 改口径：改前这个函数**纯本地**（只翻转 `ql:disabledBoxes`），
 *   而云端 `box.disabled` 从不读也不写 ⇒ 同一个事实两个来源：
 *   在网页上禁用的盒子，扩展轮盘照旧会切到它；反之亦然。
 *   ⇒ 现在它调 `POST /api/boxes/toggle`，**离线时会失败并报出来** ——
 *     这是刻意的：一个"离线也能改"的开关会让用户以为改成功了，
 *     而云端并不知道（下次同步就被覆盖回去，看起来像"改了没生效"）。
 * ★ 默认盒不给切换（服务端 400，`cloud-store` 里也先拦了一次）——
 *   它只随"是否为空"自动禁用。
 * ★ 不再自己改内存里的 `disabledBoxes`：`refreshAll()` → `reconcileBoxesWithCloud()`
 *   会按云端结果重建它。少一处写、就少一处会漂的真相。
 */
async function toggleBoxFlow(name: string): Promise<void> {
  const res = await send({ kind: 'par.toggleBox', name });
  if (!(res.kind === 'par.toggleBox' && res.result.ok)) {
    alert(`切换失败：${res.kind === 'par.toggleBox' && !res.result.ok ? res.result.error : '无响应'}`);
    return;
  }
  lastChipsKey = '';
  lastBoxOptions = '';
  lastListKey = '';
  await refreshAll();
}

/**
 * 关联 / 解除关联站点（服务端 2026-10-13 新增的能力）。
 *
 * `siteId` 传空串 = 解除关联。默认盒不参与（`bindable === false`，UI 不给入口）。
 */
async function bindBoxSiteFlow(name: string, siteId: string): Promise<void> {
  const res = await send({ kind: 'par.bindBoxSite', name, siteId });
  if (!(res.kind === 'par.bindBoxSite' && res.result.ok)) {
    alert(`关联失败：${res.kind === 'par.bindBoxSite' && !res.result.ok ? res.result.error : '无响应'}`);
    return;
  }
  await refreshAll();
}

async function renameBoxFlow(from: string): Promise<void> {
  /* ★★ 2026-10-13：**默认盒不能改名**（服务端从今天起对它回 400）。
   *
   * 改前这里有一条 `isDefault` 分支：**纯本地**把 `ql:defaultBox` 改掉。
   * 那条路的坏处比"失败"更隐蔽 —— 它**看起来成功了**（界面上的名字变了），
   * 而服务端的默认盒名仍是常量「默认盒子」⇒ 上传/下载两个方向的翻译口径
   * （`uploadBoxName` / `toAccount`：名字等于默认盒名 ⇒ 翻译成空串）
   * 从此对不上，账号会被归到一个**字面量同名的新盒**里。
   *
   * ⇒ 入口在台账里按 `renameable` 关掉（默认盒不给 ✎），这里再拦一层，
   *   保证任何调用路径都拿到一句能读懂的话。
   */
  if (from === defaultBox || boxDetail.get(from)?.isDefault) {
    alert('默认盒子不能改名 —— 它是固定的默认盒（只能往里面放账号）。');
    return;
  }
  const input = prompt(`重命名盒子「${from}」（盒内账号随迁）`, from);
  const to = input?.trim();
  if (!to || to === from) {
    return;
  }
  if (boxes.includes(to) && !confirm(`盒子「${to}」已存在，将把「${from}」中的账号并入其中。继续？`)) {
    return;
  }
  const res = await send({ kind: 'par.renameBox', from, to });
  if (!(res.kind === 'par.renameBox' && res.result.ok)) {
    alert(`重命名失败：${res.kind === 'par.renameBox' && !res.result.ok ? res.result.error : '无响应'}`);
    return;
  }
  /* ★★ 2026-10-13：这里**不再自己改 `boxes` / `disabledBoxes` / 写 storage**。
   *   理由与 `toggleBoxFlow` 同：改名是**云端**的动作，而本地那几份只是缓存 ——
   *   自己再改一遍等于把"同一事实两处声明"重新引进来（而且改名可能**触发合并**，
   *   本地那份算出来的结果与服务端不一定一样）。
   *   ⇒ 交给 `refreshAll()` → `reconcileBoxesWithCloud()` 按云端结果重建。 */
  if (currentBox === from) {
    currentBox = to;
  }
  lastChipsKey = '';
  lastBoxOptions = '';
  lastListKey = '';
  await refreshAll();
}

/**
 * 删除盒子：两步确认——
 * 1) 确认删除盒子本身；
 * 2) 盒内有账号时选择处置：[确定]=连同账号一并删除（含关闭页签），[取消]=账号归入默认盒子。
 */
async function removeBoxFlow(name: string): Promise<void> {
  if (name === defaultBox) {
    return;
  }
  if (!confirm(`删除盒子「${name}」？`)) {
    return;
  }
  const victims = browserAccounts.filter((a) => boxOf(a) === name);
  let deleteAccounts = false;
  if (victims.length) {
    deleteAccounts = confirm(
      `盒子「${name}」中有 ${victims.length} 个账号。\n\n「确定」= 连同账号一并删除（关闭其页签）\n「取消」= 保留账号，移入「${defaultBox}」`,
    );
  }
  if (deleteAccounts) {
    let failed = 0;
    for (const a of victims) {
      const res = await send({ kind: 'par.delete', id: a.id });
      if (!(res.kind === 'par.delete' && res.result.ok)) {
        failed++;
      }
    }
    if (failed) {
      alert(`有 ${failed} 个账号删除失败，盒子已保留，请重试。`);
      return;
    }
  } else {
    const res = await send({ kind: 'par.deleteBox', name });
    if (!(res.kind === 'par.deleteBox' && res.result.ok)) {
      alert(`删除失败：${res.kind === 'par.deleteBox' && !res.result.ok ? res.result.error : '无响应'}`);
      return;
    }
  }
  boxes = boxes.filter((b) => b !== name);
  disabledBoxes = disabledBoxes.filter((b) => b !== name);
  await saveBoxes();
  await saveDisabled();
  if (currentBox === name) {
    currentBox = '全部';
  }
  lastChipsKey = '';
  lastBoxOptions = '';
  lastListKey = '';
  await refreshAll();
}

/* ==================== 数据导出 / 导入（备份文件 v1） ==================== */

dataExportBtn.addEventListener('click', () => {
  void (async () => {
    // 云端模式下导出的备份**不含口令**（口令在服务端加密存储，扩展侧拿不到密文）——
    // 这种备份导入后会整条跳过，必须先把话说清楚，不能让用户以为"备份齐了"。
    const res = await send({ kind: 'data.export' });
    if (!(res.kind === 'data.export' && res.result.ok)) {
      alert(`导出失败：${res.kind === 'data.export' && !res.result.ok ? res.result.error : '无响应'}`);
      return;
    }
    const blob = new Blob([JSON.stringify(res.result.data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `akso-pass-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5000);
  })();
});

dataImportBtn.addEventListener('click', () => dataImportFile.click());

dataImportFile.addEventListener('change', () => {
  void (async () => {
    const file = dataImportFile.files?.[0];
    dataImportFile.value = ''; // 允许重复选择同一文件
    if (!file) {
      return;
    }
    let backup: DataBackup;
    try {
      backup = JSON.parse(await file.text()) as DataBackup;
    } catch {
      alert('文件不是有效的 JSON。');
      return;
    }
    if (backup?.format !== 'quicklogin-backup' || backup.version !== 1) {
      alert('不是 Akso Pass 备份文件（格式版本不符）。');
      return;
    }
    const total = backup.accounts?.length ?? 0;
    if (!confirm(`导入备份：${total} 个账号、${backup.sites?.length ?? 0} 个授权站点。\n同站同名的账号将跳过，盒子配置以备份为准。继续？`)) {
      return;
    }
    // 站点授权必须趁用户手势仍有效时最先请求（手势会随后续 await 失效，
    // v3.10.1 修复：原顺序导致 request 静默失败 → 永远显示「未授权·已暂停」）
    const hosts = (backup.sites ?? []).map((h) => String(h).trim().toLowerCase()).filter(Boolean);
    let granted = hosts.length === 0;
    if (hosts.length) {
      try {
        granted = await chrome.permissions.request({ origins: hosts.map((h) => `*://${h}/*`) });
      } catch {
        granted = false;
      }
      if (granted) {
        try {
          const stored = await chrome.storage.local.get(LOCAL_KEYS.siteGrants);
          const grants = (stored[LOCAL_KEYS.siteGrants] as Array<{ host: string; grantedAt: number }> | undefined) ?? [];
          const known = new Set(grants.map((g) => g.host.toLowerCase()));
          const now = Date.now();
          for (const h of hosts) {
            if (!known.has(h)) {
              grants.push({ host: h, grantedAt: now });
            }
          }
          await chrome.storage.local.set({ [LOCAL_KEYS.siteGrants]: grants });
        } catch {
          // 清单写入失败不影响已获得的浏览器权限
        }
      }
    }
    const res = await send({ kind: 'data.import', data: backup });
    if (!(res.kind === 'data.import' && res.result.ok)) {
      alert(`导入失败：${res.kind === 'data.import' && !res.result.ok ? res.result.error : '无响应'}`);
      return;
    }
    // 通知后台刷新授权健康缓存（无论授权成败——缓存需与实际权限对齐）
    await send({ kind: 'par.grantChanged' });
    const { created, skipped } = res.result.data;
    alert(
      `导入完成：新建 ${created} 个账号，跳过 ${skipped} 个。` +
        (hosts.length && !granted
          ? '\n注意：有站点的浏览器权限还没就位，那些账号会显示「需要重新打开」——'
            + '打开一次账号即可（届时会自动补齐）。'
          : ''),
    );
    lastChipsKey = '';
    lastBoxOptions = '';
    lastListKey = '';
    await refreshAll();
  })();
});

/* ==================== 批量管理 ==================== */

function syncBatchBar(): void {
  selCount.textContent = String(selectedIds.size);
  batchBar.classList.toggle('hidden', !batchMode);
}

batchToggle.addEventListener('click', () => {
  batchMode = !batchMode;
  batchToggle.textContent = batchMode ? '退出批量' : '批量管理';
  if (!batchMode) {
    selectedIds.clear();
  }
  // 强制重绘：卡片上的勾选框随批量模式增删（进入/退出都要）
  lastListKey = '';
  renderBrowserAccounts();
  syncBatchBar();
  lastChipsKey = '';
  renderBoxChips();
});

selClear.addEventListener('click', () => {
  selectedIds.clear();
  lastListKey = '';
  renderBrowserAccounts();
  syncBatchBar();
});

selMove.addEventListener('click', () => {
  if (!selectedIds.size) {
    return;
  }
  openBoxChooser([...selectedIds]);
});

selDelete.addEventListener('click', () => {
  if (!selectedIds.size) {
    return;
  }
  const names = browserAccounts
    .filter((a) => selectedIds.has(a.id))
    .map((a) => a.tabName || a.username);
  const shown = names.slice(0, 8).join('、') + (names.length > 8 ? ` …等共 ${names.length} 个` : '');
  // ★ 把**具体是哪些**摊开（与站点级联删除同一纪律）：只报一个数字的话，
  //   用户没有机会在按下之前发现自己多勾了一个。
  if (!confirm(`删除选中的 ${selectedIds.size} 个账号？\n\n${shown}\n\n`
    + '将同时关闭它们的所有并行标签页，且**无法恢复**。')) {
    return;
  }
  void (async () => {
    /* ★★ v4.2.12：改走**服务端的批量删除**（`POST /api/accounts/batch-delete`），
     * 而不是在这里循环发 N 个 `par.delete`。
     *   ① N 次网络往返 vs 1 次；
     *   ② 服务端只在真的删掉行时才推 `revision`（循环发会让版本号推 N 次，
     *      别的客户端因此白拉 N 次全量快照）；
     *   ③ 部分失败时服务端能给出准确条数，而循环发只能报"第 3 个失败了"。
     * ★ 本机侧（关页签、摘规则、清 token）由 SW 的 `closeAccountTabs` 逐个做 ——
     *   那部分**不能**合并成一次，因为它本来就是每个账号各自的事。 */
    const res = await send({ kind: 'par.batchDelete', ids: [...selectedIds] });
    /* ★ `send()` 的返回是**全协议联合**（`RuntimeResponse`），所以这里必须
     *   先用 `kind` 收窄再读 `data` —— 直接读会得到一个跨 30 多个成员的联合类型
     *   （`tsc` 报的正是 "Property 'deleted' does not exist on type …"）。
     *   这是本仓"协议单一定义"的代价，也是它的价值：**漏判 kind 会当场被类型系统抓住**。 */
    if (res.kind !== 'par.batchDelete' || !res.result.ok || !res.result.data) {
      const err = res.kind === 'par.batchDelete' && !res.result.ok ? res.result.error : '后台未返回结果';
      alert(`批量删除失败：${err}`);
      return;
    }
    if (res.result.data.deleted !== selectedIds.size) {
      // 数量对不上就**如实报**（静默的话用户会以为全删干净了）
      log.warn('批量删除：请求 %d 个，服务端回报删掉 %d 个', selectedIds.size, res.result.data.deleted);
    }
    selectedIds.clear();
    batchMode = false;
    batchToggle.textContent = '批量管理';
    lastListKey = '';
    await refreshAll();
  })();
});

/* ==================== 移入盒子：选择弹窗（列出实际存在的盒子 + 可输新名） ==================== */

let pendingMoveIds: string[] = [];
let modalPick = DEFAULT_BOX_FALLBACK;

function openBoxChooser(ids: string[]): void {
  if (!ids.length) {
    return;
  }
  pendingMoveIds = ids;
  const first = browserAccounts.find((a) => a.id === ids[0]);
  modalPick = currentBox !== '全部' ? currentBox : first ? boxOf(first) : DEFAULT_BOX_FALLBACK;
  boxModalNew.value = '';
  renderBoxModalList();
  boxModal.classList.remove('hidden');
}

function renderBoxModalList(): void {
  boxModalList.innerHTML = '';
  const typing = boxModalNew.value.trim();
  for (const name of boxes) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'box-option' + (!typing && modalPick === name ? ' active' : '');
    const label = document.createElement('span');
    label.textContent = name;
    const count = document.createElement('span');
    count.className = 'chip-n';
    count.textContent = String(browserAccounts.filter((a) => boxOf(a) === name).length);
    row.append(label, count);
    row.addEventListener('click', () => {
      modalPick = name;
      boxModalNew.value = '';
      renderBoxModalList();
    });
    boxModalList.append(row);
  }
}

boxModalNew.addEventListener('input', () => {
  const typed = boxModalNew.value.trim();
  if (typed) {
    modalPick = typed; // 输入新盒子名 = 以新名参与选择（确定时自动创建）
    renderBoxModalList();
  } else {
    const first = browserAccounts.find((a) => a.id === pendingMoveIds[0]);
    modalPick = currentBox !== '全部' ? currentBox : first ? boxOf(first) : DEFAULT_BOX_FALLBACK;
    renderBoxModalList();
  }
});

function hideBoxModal(): void {
  boxModal.classList.add('hidden');
  pendingMoveIds = [];
}

boxModalOk.addEventListener('click', () => {
  void (async () => {
    const target = (boxModalNew.value.trim() || modalPick).trim() || defaultBox;
    const ids = [...pendingMoveIds];
    hideBoxModal();
    if (!ids.length) {
      return;
    }
    for (const id of ids) {
      // 移入默认盒 = 清除 box 字段（保持「未归盒 = 默认盒」不变量）
      await send({ kind: 'par.moveBox', id, box: target === defaultBox ? '' : target });
    }
    if (target !== defaultBox && !boxes.includes(target)) {
      boxes.push(target);
      await saveBoxes();
      lastBoxOptions = '';
    }
    if (currentBox !== '全部' && currentBox !== target) {
      currentBox = target;
    }
    selectedIds.clear();
    lastChipsKey = '';
    lastListKey = '';
    await refreshAll();
  })();
});

boxModalCancel.addEventListener('click', hideBoxModal);
boxModal.addEventListener('click', (e) => {
  if (e.target === boxModal) {
    hideBoxModal();
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') {
    return;
  }
  if (!siteModal.classList.contains('hidden')) {
    hideSiteModal();
    return;
  }
  if (!boxModal.classList.contains('hidden')) {
    hideBoxModal();
    return;
  }
  if (!sourceHelpPop.classList.contains('hidden')) {
    setHelpOpen(false);
  }
  // 设备等待面板**刻意不响应 Esc**：用户可能正在另一个标签页上批准，
  // 键一按就把登录掐掉太贵了（要取消请点面板上的「取消」；切确认弹窗有自己的 Esc）。
});

/* ==================== 批量导入 ==================== */

importToggle.addEventListener('click', () => {
  importPanel.classList.toggle('hidden');
});

importCancel.addEventListener('click', () => {
  importPanel.classList.add('hidden');
});

interface ImportRow {
  tabName: string;
  username: string;
  password: string;
}

function parseImportText(text: string): ImportRow[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  // 先尝试 JSON 数组：[{"tabName":"…","username":"…","password":"…"}, …]
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => {
          const r = row as Record<string, unknown>;
          return {
            tabName: String(r.tabName ?? r['页签名'] ?? '').trim(),
            username: String(r.username ?? r['账号名'] ?? '').trim(),
            password: String(r.password ?? r['密码'] ?? '').trim(),
          };
        })
        .filter((r) => r.username && r.password);
    }
  } catch {
    // 非 JSON：按 CSV/TSV 行解析
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/[,，\t]/).map((s) => s.trim());
      return { tabName: parts[0] ?? '', username: parts[1] ?? '', password: parts[2] ?? '' };
    })
    .filter((r) => r.username && r.password);
}

importRun.addEventListener('click', () => {
  void (async () => {
    const siteHost = pHostSelect.value;
    if (!siteHost) {
      alert('请先在「站点管理」添加站点。');
      return;
    }
    const box = pBoxSelect.value;
    const rows = parseImportText(importText.value);
    if (!rows.length) {
      alert('没有可导入的行。请检查格式：每行「页签名,账号名,密码」，或 JSON 数组。');
      return;
    }
    let okCount = 0;
    let failCount = 0;
    const scheme = await resolveSchemeForHost(siteHost);
    for (const row of rows) {
      try {
        const res = await send({
          kind: 'par.create',
          siteHost,
          tabName: row.tabName,
          username: row.username,
          password: row.password,
          open: false,
          box,
          scheme,
        });
        if (res.result.ok) {
          okCount += 1;
        } else {
          failCount += 1;
        }
      } catch {
        failCount += 1;
      }
    }
    if (okCount) {
      await chrome.storage.local.set({ [LAST_HOST_KEY]: siteHost });
    }
    importText.value = '';
    importPanel.classList.add('hidden');
    await refreshAll();
    alert(`批量导入完成：成功 ${okCount} 个${failCount ? `，失败 ${failCount} 条（缺账号名或密码）` : ''}。账号已保存到盒子「${box}」，可从列表逐个打开。`);
  })();
});

/* ==================== 添加账号（单个） ==================== */

/**
 * ★★★ v4.2.12：**授权的唯一处置点** —— 而且它现在对用户是隐形的。
 *
 * ## 为什么授权这件事删不掉
 *
 * 用户的要求是「站点管理只做增删改，无需关注浏览器是否授权」。但 Chrome 的约束是硬的：
 * `manifest.json` 里 `host_permissions: []` + `optional_host_permissions` 是通配 ——
 * **任何一个站点在用之前都要有一条宿主权限**，否则：
 *   · 内容脚本（`shield-*` / `auto-login` / `title-hook`）**根本不注入**该页面；
 *   · `declarativeNetRequestWithHostAccess` 的改头规则**不生效**；
 *   · 于是"多账号并行"这件事整个不成立（连自动填表都拿不到凭证）。
 * ⇒ 可以消掉的是**界面上的授权概念**，不是授权本身。
 *
 * ## 做法：一次要通配，之后永不再问
 *
 * 用户在**登录云端账号库**那一次点击里已经表达了"我要用这个扩展"，
 * 就在那个手势里顺手把通配授权要下来（见 `authReloginBtn` 那个捕获阶段监听器）。
 * 拿到之后 `chrome.permissions.contains()` 对**任何一个**站点都为真，
 * 于是这里**一个字节都不写、一个窗都不弹** —— 用户从此不必知道有这回事。
 *
 * ★★ **本段注释里绝对不要写出带通配的权限模式字面量。** 它们的结尾正好是块注释的
 *   结束标记，会让注释**提前结束**、后面整段代码变成语法垃圾
 *   （`docs/PITFALLS.md` #43 —— 我在这一轮里已经犯过一次，由 `tsc` 当场抓住：
 *   一次报出 200 多条 "Invalid character"）。要指代它就写"通配模式"。
 *
 * ★★ 顺序纪律（本仓栽过两次，见 v4.2.7 / v4.2.9 的提交说明）：
 *   `permissions.request` 必须在**用户手势里最先发起** —— 前面只要有一次 `await`，
 *   手势就失效，Chrome **不弹窗、不报错、直接返回 false**，表现为"点了没反应"。
 *   ⇒ 所以这个函数被设计成**可以在手势里同步调用**：它内部第一件事就是发请求。
 *
 * ★ 没拿到通配时（用户点了拒绝，或 Chrome 不给这个窗）**不阻断任何操作**：
 *   退回到"按站点请求"。那条路 Chrome 会弹一个**针对具体站点**的窗，
 *   而那个窗是用户能理解的（"是否允许访问 xxx"）。两者都不出现在我们的界面里。
 *
 * @param interactive 是否允许弹窗（true 只能在用户手势里传）
 */
async function ensureHostPermission(host: string, interactive = true): Promise<boolean> {
  if (!host) {
    return false;
  }
  const pat = patternOfHost(host);
  // ① 已经被更宽的授权覆盖 ⇒ 什么都不做（Chrome 对"已覆盖"的请求既不弹窗也不报错，
  //    只在 `getAll().origins` 里看不到具体 origin —— 那些都不影响可用性）
  const covered = await chrome.permissions
    .contains({ origins: [pat, '*://*/*'] })
    .then((r) => r)
    .catch(() => false);
  if (covered) {
    return true;
  }
  if (!interactive) {
    return false;
  }
  // ② 未覆盖：先请求通配（一次解决以后所有站点），失败再退到本站点
  const wide = await chrome.permissions
    .request({ origins: ['*://*/*'] })
    .catch(() => false);
  if (wide) {
    log.info('已获得全网通配授权（站点 %s 一并覆盖）', host);
    return true;
  }
  const one = await chrome.permissions.request({ origins: [pat] }).catch(() => false);
  return one;
}

/**
 * 在**已知处于用户手势中**时尽早把通配授权要下来（不 await 任何前置动作）。
 *
 * ★ 返回值只用于留痕，不用于判断 —— 调用方**不能**因为它是 false 就回滚别的事：
 *   授权可以稍后补（`ensureHostPermission` 会在用的时候再试一次），
 *   而"登录云端"这件事与授权成败无关。
 */
function requestWideHostPermission(): Promise<boolean> {
  // ★ 这一句必须**同步**发起（不放在 await 之后），否则手势已经没了。
  return chrome.permissions
    .request({ origins: ['*://*/*'] })
    .catch(() => false);
}

/* ==================== scheme（v3.10.9）：协议 hint 与解析 ==================== */

type Scheme = 'http' | 'https';

/** 从用户输入解析 host 与 scheme：支持粘贴完整 URL 或纯 host */
function parseSiteInput(raw: string): { host: string; scheme?: Scheme } {
  const trimmed = raw.trim();
  const m = trimmed.match(/^(https?):\/\/([^/]+)(\/.*)?$/i);
  if (m) {
    return { host: m[2].toLowerCase(), scheme: m[1].toLowerCase() as Scheme };
  }
  return { host: trimmed.replace(/\/.*$/, '').toLowerCase() };
}

async function readSchemeHint(host: string): Promise<Scheme | undefined> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.siteSchemes);
  const map = (stored[LOCAL_KEYS.siteSchemes] as Record<string, Scheme> | undefined) ?? {};
  return map[host.toLowerCase()];
}

async function writeSchemeHint(host: string, scheme: Scheme): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.siteSchemes);
  const map = (stored[LOCAL_KEYS.siteSchemes] as Record<string, Scheme> | undefined) ?? {};
  map[host.toLowerCase()] = scheme;
  await chrome.storage.local.set({ [LOCAL_KEYS.siteSchemes]: map });
}

/** 账号创建时确定站点协议：授权时用户输入的 hint 优先，否则 SW 自动探测（https 优先） */
async function resolveSchemeForHost(host: string): Promise<Scheme | undefined> {
  const hint = await readSchemeHint(host);
  if (hint) {
    return hint;
  }
  const res = await send({ kind: 'par.probeScheme', host }).catch(() => null);
  if (res && res.result.ok && (res.result.data === 'http' || res.result.data === 'https')) {
    return res.result.data;
  }
  return undefined;
}

async function openAccount(id: string, forceNewTab: boolean): Promise<void> {
  const account = browserAccounts.find((x) => x.id === id);
  if (!account) {
    return;
  }
  /* ★★ v4.2.12：授权在这里**静默补齐**，不再是一道会拦人的门。
   *
   * 改前这里是 `if (!(await ensureHostPermission(...))) { alert('需要授权访问 …'); return; }`
   * —— 即"没授权就别想打开"，而用户看到的是一个**他刚刚在站点管理里被要求不要再关心**
   * 的概念。现在的口径是：
   *   · 已在通配授权下（登录云端时要过的那一次）⇒ 这一路什么都不做、什么都不弹；
   *   · 万一没有 ⇒ 在这次**点击手势**里补一次（Chrome 可能弹一个具体站点的窗），
   *     能补上就继续；
   *   · 补不上（用户明确拒绝）⇒ 如实说清后果，**仍然打开**它 —— 让用户自己判断，
   *     而不是让一个他看不懂的错误把这行按钮变成死的。
   */
  const granted = await ensureHostPermission(account.siteHost);
  if (!granted) {
    log.warn('站点 %s 未取得宿主权限：该页签的隔离与自动填表都不会生效', account.siteHost);
    if (
      !confirm(
        `浏览器没有允许 Akso Pass 访问 ${account.siteHost}。\n\n`
          + '这种情况下**仍然可以打开**这个账号，但：\n'
          + '· 不会隔离它的登录态（可能与其它账号串号）\n'
          + '· 不会自动填充账密\n\n'
          + '要现在打开吗？（也可以在 chrome://extensions 的「网站访问权限」里改成「在所有网站上」）',
      )
    ) {
      return;
    }
  }
  const res = await send({ kind: 'par.open', id, forceNewTab });
  if (!res.result.ok) {
    alert(`打开失败：${res.result.error}`);
    return;
  }
  await refreshAll();
}

async function createAccount(open: boolean): Promise<void> {
  const siteHost = pHostSelect.value;
  if (!siteHost) {
    alert('请先在「站点管理」添加站点，站点下拉才会有可选项。');
    return;
  }
  // 添加账号**也是用户手势**：顺手把授权补齐（静默；补不上也不拦 —— 账号照样存云端）
  void ensureHostPermission(siteHost);
  const tabName = pTabName.value.trim();
  const username = pUsername.value.trim();
  const password = pPassword.value;
  if (!username || !password) {
    return;
  }
  const scheme = await resolveSchemeForHost(siteHost);
  const res = await send({
    kind: 'par.create',
    siteHost,
    tabName,
    username,
    password,
    open,
    box: pBoxSelect.value,
    scheme,
  });
  if (!res.result.ok) {
    alert(`添加失败：${res.result.error}`);
    return;
  }
  // 记住本次选择的站点与盒子，下次打开默认选中
  await chrome.storage.local.set({ [LAST_HOST_KEY]: siteHost, [LAST_BOX_KEY]: pBoxSelect.value });
  pTabName.value = '';
  pUsername.value = '';
  pPassword.value = '';
  await refreshAll();
}

parForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void createAccount(true);
});

document.getElementById('add-only')!.addEventListener('click', () => {
  void createAccount(false);
});

/* ==================== 站点管理（读取真实权限清单） ==================== */

function originToHost(origin: string): string | null {
  // 形如 "*://tonbridge-config.aksoegmp.com/*" 或 "https://*.example.com/*"
  const m = /^(?:\*|https?):\/\/([^/]+)(?:\/.*)?$/.exec(origin);
  if (!m) {
    return null;
  }
  // 跳过全通配行（*://*/* 等）：无法归属到具体站点，单独展示无意义
  return m[1] === '*' ? null : m[1];
}

function patternOfHost(host: string): string {
  return `*://${host}/*`;
}

/**
 * 剥掉 host 里的端口（`a.com:8443` → `a.com`）。
 *
 * ★ 为什么不 import `background/core/tab-rules.ts` 里那个 `hostNoPortOf`：
 *   本仓的分层是 **`ui/` 下不 import background**（AGENTS §2、`parallel-store.ts` 的注释），
 *   而那是**有意的** —— 破了它，UI 就会绕过消息层直接摸到后台实现。
 *   ⇒ 四行的纯函数在这里重写一份，比破分层划算。
 *   ★ 这里刻意不写带通配的目录字面量 —— 它含注释开始标记（PITFALLS #43）。
 * ★ 判据：`verify-twotier.mjs` 的 B7b 组（云端 host 不得出现在站点卡片 / 站点下拉里），
 *   它用的正是"云端带端口、授权不带端口"这个真实形态。
 */
function hostNoPort(host: string): string {
  const i = host.indexOf(':');
  return (i >= 0 ? host.slice(0, i) : host).trim().toLowerCase();
}

/**
 * ★★ v4.2.9 修（用户实测"站点管理中仍然在显示云端域名"）：**比较必须剥掉端口**。
 *
 * 缺陷形态：云端地址带端口（`https://<host>:8443`），而 Chrome 给这个站点的授权模式
 * **不带端口**（Chrome 的 host 权限模式里没有端口）：
 *   · `new URL(cloudBaseUrl).host` ⇒ `<host>:8443`    ← 带端口
 *   · `originToHost(<那条授权模式>)` ⇒ `<host>`        ← 不带
 * ⇒ 两边**永不相等** ⇒ 这个函数**永远返回 false** ⇒ 云端域名照旧出现在站点管理里。
 *
 * ★ 这就是本仓那个"`originToHost` 会保留端口、而 DNR 的 `requestDomains` 不含端口"的
 *   同一个坑（`tab-rules.ts` 的 `hostNoPortOf` 注释写着它）——
 *   我上一版写这个函数时只想着"比对 host 而不是整串 origin"，**漏了端口这一维**。
 *
 * ★★ 本段注释里**不要**写出那两种带通配的字面量：它们的结尾正好是注释结束标记，
 *   会让整个注释提前结束（PITFALLS #43 —— 我在这一轮里又犯了三次，都由判据当场抓住）。
 */
function isCloudHost(host: string): boolean {
  if (!cloudBaseUrl) {
    return false; // 还没拿到云端地址（未登录/离线）⇒ 什么都不排除
  }
  try {
    return hostNoPort(new URL(cloudBaseUrl).host) === hostNoPort(host);
  } catch {
    return false; // baseUrl 形状异常时**不排除**（宁可多显示一行，也不要漏掉真实站点）
  }
}

/** 统计某 host 下已有的并行账号数（支持 *.example.com 通配模式粗匹配） */
function countAccountsFor(displayHost: string): number {
  const bare = displayHost.replace(/^\*\./, '');
  return browserAccounts.filter((a) => a.siteHost === displayHost || a.siteHost.endsWith(`.${bare}`)).length;
}

/**
 * 站点管理的加载与渲染：**拉云端 → 建行 → 变了才重画**（v4.2.12 重写）。
 *
 * ★★ 改前这里做的是另一件事：拿 `chrome.permissions.getAll()` 当站点列表，
 *   再叠加两个本地名单。那让"站点"有了两个互相不可见的来源（见状态声明处那段注释）。
 *
 * ★ 顺序依赖：`refreshSiteNames()` 必须在 `buildSiteRows()` **之前** ——
 *   行里的 `title` 与 `siteId` 都来自它（`cloudSites` / `siteNames`）。
 */
async function loadSites(): Promise<void> {
  // 站点名从云端拉；拿不到（离线）时**保持上一次的列表**（见 refreshSiteNames 的说明）
  const fresh = await refreshSiteNames();

  /* ★★ 2026-10-19（用户要求：同步应当自动执行，不再有「同步到云端」按钮）：
   *
   * 账号引用了、但云端站点表里没有的 host，在这里**自动补建**成站点记录。
   * 旧逻辑把这件事留给用户点「同步到云端」，于是：
   *   · 列表上一直挂着一个"未同步"的标记（其实只是个本地引用）
   *   · 用户不理解"同步"是什么、也不知道该不该点
   * ⇒ 现在由界面自己完成，且**只在刚刚成功拉到云端列表时**做 ——
   *   拿不到列表就补建会把所有账号站点当成缺失，在网络抖动时造出重复站点。
   */
  if (fresh && (await ensureMissingSites())) {
    // 补建成功后重拉一次，让新记录（含 id/baseUrl）进入本轮的渲染
    await refreshSiteNames();
  }

  const rows = buildSiteRows();
  // ★ 渲染输入要**全进 key**：少了哪一项，"它变了但界面不动"就会静默发生
  //   （v4.2.2 实测到的"改名后下拉不更新"就是这个形态）。
  const sitesKey = JSON.stringify([
    rows.map((r) => [r.host, r.siteId, r.title, r.count, r.baseUrl, r.note]),
    browserAccounts.map((a) => [a.id, a.tabName, a.box ?? '', a.siteHost]),
  ]);
  if (sitesKey !== lastSitesKey) {
    lastSitesKey = sitesKey;
    renderSites(rows);
    lastHostOptions = ''; // 同一批数据喂着"添加账号"的站点下拉，一起失效
  }

  await purgeLegacyHostLists();
}

/**
 * ★★ 2026-10-19：把"账号引用了、云端却没有"的站点**自动补建**。
 *
 * 用户要求：「同步数据应该是自动执行的，不用手动执行。」
 * ⇒ 这是旧「同步到云端」按钮做的事，只是挪到了**每一次成功拉取站点列表之后**。
 *
 * 三条约束（缺一条就会造出新问题）：
 *   1. **只在云端列表刚刚成功拉到之后调用**（调用点在 `loadSites` 里）——
 *      拿不到列表时，所有账号站点都会被误判成"缺失"，抖动一次就建一堆重复站点。
 *   2. **建盒参数传 `false`**：用户没有在这个动作里被问过"要不要建盒"，
 *      替他把盒子建出来属于未确认的副作用（建站表单的勾选框才是那个入口）。
 *   3. **失败后 60 秒内不重试**：`loadSites` 挂在 3 秒轮询上，不节流会离线时
 *      每 3 秒打一次云端，把失败日志刷满而信息量不增。
 *
 * 返回 `true` = 至少补建成功一条（调用方据此重拉列表）。
 */
const siteAutoSyncAt = new Map<string, number>();
const SITE_AUTOSYNC_RETRY_MS = 60_000;

async function ensureMissingSites(): Promise<boolean> {
  const known = new Set(cloudSites.map((s) => s.host));
  const missing: string[] = [];
  for (const a of browserAccounts) {
    const host = a.siteHost?.trim();
    if (!host || host.includes('*') || isCloudHost(host) || known.has(host) || missing.includes(host)) {
      continue;
    }
    missing.push(host);
  }
  if (!missing.length) {
    return false;
  }
  let created = false;
  for (const host of missing) {
    const last = siteAutoSyncAt.get(host) ?? 0;
    if (Date.now() - last < SITE_AUTOSYNC_RETRY_MS) {
      continue;
    }
    siteAutoSyncAt.set(host, Date.now());
    const res = await send({
      kind: 'par.upsertSite',
      host,
      name: siteTitleOf(host).title,
      createBox: false,
    }).catch(() => null);
    if (res && res.kind === 'par.upsertSite' && res.result.ok) {
      created = true;
      log.info('站点 %s 不在云端账号库里，已自动补建', host);
    } else {
      const why = res && res.kind === 'par.upsertSite' && !res.result.ok ? res.result.error : '无响应';
      log.warn('站点 %s 自动补建失败（60 秒内不再重试）：%s', host, why);
    }
  }
  return created;
}

/**
 * ★★ 一次性清理：旧版本那两个本地名单（`ql:blockedHosts` / `ql:hiddenHosts`）
 * **已经没有读取方了**，但盘上还留着。
 *
 * 不清理的后果不是"占几字节"，而是**下一个读代码的人会以为它们还在生效** ——
 * 本仓对"摆在那里没人用"的东西有明确态度（`docs/PITFALLS.md` #30：
 * "接口摆在那里 ≠ 它被接上了"）。删掉读取方却不清理数据，等于把这个坑留给下一个人。
 *
 * ★ 幂等且**稳态零写**：`loadSites()` 挂在 `refreshAll()` 的 3 秒轮询上，
 *   键已经是空的 / 不存在时一个字节都不写。
 */
async function purgeLegacyHostLists(): Promise<void> {
  const keys = [LOCAL_KEYS.blockedHosts, LOCAL_KEYS.hiddenHosts];
  const stored = await chrome.storage.local.get(keys);
  const stale = keys.filter((k) => {
    const v = stored[k];
    return Array.isArray(v) ? v.length > 0 : v !== undefined;
  });
  if (!stale.length) {
    return;
  }
  await chrome.storage.local.remove(stale);
  log.info('已清理旧版本的本地站点名单（授权不再参与站点管理）：%s', stale.join(', '));
}


/** 站点名映射：host → { 用户设的名, **显示名** }。
 *
 * ★ 显示名由 background 算好（`name 与 host 不同才算用户起过名`，否则从地址推导），
 *   UI 不再自己推导 —— 否则"推导规则"会有两份，改一处另一处静默不变。
 */
let siteNames: Record<string, { name: string; displayName: string }> | null = null;

/**
 * 云端站点**全量**（含 `id`）—— 专门给盒子的「关联站点」用。
 * ★ 为什么不复用 `siteNames`：那份按 **host** 索引、而且**丢掉了 id**，
 *   而服务端认站点用的是 `siteId`（`POST /api/boxes/bind-site` 收 `siteId`）。
 *   往 `siteNames` 里塞 id 会让"站点管理"那一栏的每一行都多带一个它不用的字段，
 *   而多带的字段迟早会被顺手用上（那处就成了新的耦合点）。
 */
let cloudSites: CloudSiteSummary[] = [];

async function refreshSiteNames(): Promise<boolean> {
  try {
    const res = await send({ kind: 'par.sites' });
    if (res.kind === 'par.sites' && res.result.ok) {
      const rows = res.result.data;
      /* ★★ `ok:true` + `data:null` 是**离线**的约定形态（见 `par.sites` 的协议注释），
       *   不是"拿到了一个空列表"。旧实现把它当空列表处理，于是每次离线都会
       *   抹掉上一份站点、并把所有账号站点误判成"缺失"。⇒ 先认这一支。 */
      if (rows === null) {
        return false;
      }
      /* ★★ 2026-10-19：**`null` = 没拿到，不是一个字都没动** —— 这条修正的正是用户
       *   报的「站点明明同步了，界面却写未同步」。
       *
       * 改前这里在失败分支里把 `cloudSites = []` / `siteNames = null` 一起清掉：
       *   · 一次**瞬时**网络抖动（3 秒轮询里很常见）就会让站点列表退回"只有账号
       *     引用、云端查不到"的兜底行 ⇒ 每行都拿到 `siteId = ''` ⇒ 渲染成「未同步」
       *   · 而站点其实在云端好好的，下一次成功的轮询又会把标记去掉 ——
       *     用户看到的是"它一会儿同步一会儿不同步"。
       * ⇒ 与 `par.boxes` 同一约定（协议注释里也一直这么写着）：**拿不到就保持原样**。
       *   只有真的拿到了空列表，才该显示"还没有站点"。
       */
      const usable = (rows ?? []).filter((r) => !isCloudHost(r.host));
      cloudSites = usable;
      siteNames = Object.fromEntries(
        usable.map((r) => [r.host, { name: r.name, displayName: r.displayName }]),
      );
      return true;
    }
  } catch (e) {
    log.warn('拉取站点清单失败（保持上一次的列表，不显示“未同步”）：%s',
      e instanceof Error ? e.message : String(e));
  }
  // ★ 不清空 —— 见上面的说明。`false` 表示"这一轮没拿到新数据"。
  return false;
}

/**
 * 站点管理里"这一行"的数据。
 *
 * ★★ v4.2.12：**站点管理的数据源收成一处** —— 云端的站点表。
 *
 * ## 改前的形态（以及它为什么让两端永远对不上）
 *
 * 原来的列表是**四个来源取并集**：
 *   ① `chrome.permissions.getAll()` 的浏览器授权清单
 *   ② 本地停用名单 `ql:blockedHosts`（有授权但在扩展里停用）
 *   ③ 本地隐藏名单 `ql:hiddenHosts`（没有授权、用户不想看见）
 *   ④ 云端站点记录 + 本地账号引用的 host
 *
 * 于是「站点管理」显示的根本**不是云端那个站点列表**：云端删掉的站点只要浏览器
 * 授权还在就还在，而云端**有**的站点只要没授权就标成"缺授权"。用户实测到的正是这个：
 * 两端站点管理对不上，且删了账号之后站点仍留在授权列表里。
 *
 * ## 改后的口径（用户 2026-10-13 的决定）
 *
 * > 「仅对站点进行增删改，无需关注浏览器是否对其进行授权。」
 *
 * ⇒ **云端是唯一的权威**：`GET /api/sites` 回来什么就显示什么，一一对应。
 *   浏览器授权退化成**实现细节** —— 它仍然必须存在（Chrome 拿不到宿主权限就
 *   不注入内容脚本、DNR 也改不了头），但界面上一处都不体现，也不再由它决定"有没有这一行"。
 *   `ql:blockedHosts` / `ql:hiddenHosts` 两个本地名单随之**不再参与渲染**。
 *
 * ★ 唯一的并集是**兜底**：`browserAccounts` 里引用的、而云端站点表里没有的 host
 *   仍然列出来（否则出现"账号看得见、站点看不见"的悬空引用）。
 *   ★ 2026-10-19：这种行会被 `ensureMissingSites()` 在后台**自动补建**，
 *   界面上不标任何"未同步" —— 用户没有可执行的动作，标了只会制造焦虑。
 */
interface SiteRow {
  host: string;
  /** 云端站点 id；空串 = 云端没有这条记录（兜底那一支） */
  siteId: string;
  /** 显示名（主标题）：用户设过名就用名，否则从地址推导 */
  title: string;
  /** 账号数量 */
  count: number;
  /** 服务端原样存的地址（编辑弹窗用；兜底行由 host + 协议拼出来） */
  baseUrl: string;
  /** 用户备注 */
  note: string;
}

/** 站点管理的行（**唯一**构造点，见 `SiteRow` 的说明） */
function buildSiteRows(): SiteRow[] {
  const rows: SiteRow[] = [];
  const seen = new Set<string>();
  for (const s of cloudSites) {
    if (!s.host || seen.has(s.host)) {
      continue;
    }
    seen.add(s.host);
    const title = s.displayName?.trim() || s.host;
    rows.push({
      host: s.host,
      siteId: s.id,
      title,
      count: countAccountsFor(s.host),
      baseUrl: s.baseUrl || `https://${s.host}`,
      note: s.note ?? '',
    });
  }
  // 兜底：账号引用了、而云端站点表里没有的 host（悬空引用）。
  // ★ 2026-10-19：**不再标「未同步」** —— 自动同步会在本轮把它补进云端
  //   （见 `ensureMissingSites`），补不上（离线）时也没有"说它没同步"的意义：
  //   用户既不能手动同步、也不该为一次轮询抖动担责。
  for (const a of browserAccounts) {
    const host = a.siteHost;
    if (!host || seen.has(host)) {
      continue;
    }
    seen.add(host);
    rows.push({
      host,
      siteId: '',
      title: siteTitleOf(host).title,
      count: countAccountsFor(host),
      baseUrl: `${a.scheme ?? 'https'}://${host}`,
      note: '',
    });
  }
  return rows.sort((x, y) => x.title.localeCompare(y.title, 'zh-Hans-CN'));
}

/** 站点在某一行上显示的主标题与副标题 */
function siteTitleOf(host: string): { title: string; sub: string | null } {
  const hit = siteNames?.[host];
  const title = hit?.displayName?.trim() || host;
  // 副标题放**完整地址**：显示名是别名，地址才是账号绑定的身份键，必须能核对
  return { title, sub: title === host ? null : host };
}

/**
 * 渲染站点管理。
 *
 * ★★ v4.2.12：**签名从三个列表收成一个**。改前是
 * `renderSites(hosts, blocked, hidden)` —— 三个来源各自带着一套"这个站点能不能用"
 * 的判断，而它们彼此不一致（见 `SiteRow` 的长注释）。现在唯一的输入是
 * `buildSiteRows()` 的结果，**授权状态一个字都不再出现在这一栏里**。
 */
function renderSites(rows: SiteRow[]): void {
  siteListEl.innerHTML = '';

  if (!rows.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    const ico = document.createElement('div');
    ico.className = 'empty-ico';
    ico.textContent = '🌐';
    const tip = document.createElement('div');
    tip.textContent = '还没有站点。在上面的输入框里填名称、粘贴站点地址即可。';
    li.append(ico, tip);
    siteListEl.appendChild(li);
    return;
  }

  for (const row of rows) {
    const { host, title, count: n } = row;

    const li = document.createElement('li');
    /* ★★ v4.2.1 第五轮（要求 ④）：从"一行"改成**卡片**。
     *   用户原话：「站点数据也以卡片形式展示，让用户能够直观的看到站点名称、站点域名、
     *   站点下拥有的账号数量」。⇒ 三件事各占一个明确的视觉位置：
     *     ① 站点名称（主标题，最大字重）
     *     ② 站点域名（副标题，**始终显示** —— 它是账号绑定的身份键）
     *     ③ **账号数量**（单独一块，不是混在说明句子里） */
    li.className = 'site-card';
    li.dataset.host = host;

    /* ① 名称。
     * ★ 2026-10-19：这里**不再有「未同步」标记**。同步是自动的
     *   （见 `ensureMissingSites`），而那个标记真正反映的是"上一轮拉取失败了"——
     *   把一次网络抖动说成"你的站点没同步"，用户既无从处置、也无从分辨。 */
    const head = document.createElement('div');
    head.className = 'site-card-head';
    const alias = document.createElement('div');
    alias.className = 'site-card-name';
    alias.textContent = title;
    alias.title = host; // 悬停能看到真实身份键
    head.appendChild(alias);

    // ② 域名
    const domain = document.createElement('div');
    domain.className = 'site-card-domain';
    domain.textContent = host;

    // ③ 账号数量
    const count = document.createElement('div');
    count.className = 'site-card-count';
    const num = document.createElement('b');
    num.textContent = String(n);
    const unit = document.createElement('span');
    unit.textContent = '个账号';
    count.append(num, unit);

    const actions = document.createElement('div');
    actions.className = 'site-actions';

    /* ★★★ 2026-10-19（用户要求）：「站点管理缺少对站点的编辑功能」。
     *
     * 改前这里只有一个「更改名称」（内联输入框）—— 地址填错了、备注想补，
     * 都只能删站重建，而删站会**连带删掉它下面的账号**。
     * ⇒ 改成与云端控制台同一个「编辑」入口（名称 / 地址 / 备注）。
     * ★ 「同步到云端」按钮**整体撤掉**：云端没有这条记录时由 `loadSites`
     *   自动补建（用户要求：同步应当自动执行）。
     */
    const editBtn = document.createElement('button');
    editBtn.className = 'btn-ghost btn-sm';
    editBtn.type = 'button';
    editBtn.textContent = '编辑';
    editBtn.title = '修改站点名称、地址与备注（不影响账号绑定的站点记录）';
    editBtn.addEventListener('click', () => openSiteEditor(row));
    actions.appendChild(editBtn);

    /* ★★★ v4.2.12：删除 = **云端那一行的删除**，不再有"撤销浏览器授权"这一层。
     *
     * 用户原话：「仅对站点进行增删改，无需关注浏览器是否对其进行授权。」
     *
     * 语义与云端控制台**逐条一致**（用户选定："级联删除，但删之前把账号名单摊开"）：
     *   · 零账号        ⇒ 直接删（没有任何连带后果，不为它加摩擦）
     *   · 有账号        ⇒ 服务端回 409，把**具体是哪些账号**带回来 ⇒ 摊开给人看，
     *                     确认后带 `?force=true` 再删一次
     *   · 云端没有这条  ⇒ 只把这一行从界面去掉（本地本来就没有它的记录）
     *
     * ★★ 服务端才是拦截点，**不是**这里的 `n > 0` 判断：`n` 是本机列表渲染那一刻的
     *    数字，页面开着时别处（网页控制台 / 另一台机器）加了账号它就是旧的 ——
     *    于是弹窗会说"0 个账号，直接删吧"，而服务端**真的**删掉了 12 个。
     *    让**服务端**回答"现在有几个"，那个数字不可能过期。
     *    （同一条纪律在 `akso-cloud/app/web/static/site.js` 的删除分支里也写着。）
     */
    const del = document.createElement('button');
    del.className = 'btn-danger btn-sm';
    del.type = 'button';
    del.textContent = '删除';
    del.title = '从站点管理与云端账号库里删掉这个站点（账号绑定在站点上，删站点会一并删掉它的账号）';
    del.addEventListener('click', () => void deleteSiteRow(row));
    actions.appendChild(del);

    li.append(head, domain, count, actions);
    siteListEl.appendChild(li);
  }
}

/**
 * 删除站点：**与云端控制台同一条两段式路径**（先请求 → 409 带名单 → 摊开确认 → force）。
 *
 * ★ 为什么"先请求再弹窗"而不是按本地的账号数判断：见调用点那段注释。
 */
async function deleteSiteRow(row: SiteRow): Promise<void> {
  const { host, siteId, title } = row;
  if (!siteId) {
    // 云端本来就没有这条记录（兜底列出来的悬空引用）：没有东西可删，如实说清
    alert(
      `「${title}」在云端账号库里没有站点记录，所以没有可删除的云端数据。\n\n`
        + '它出现在这里是因为有账号在引用它。删掉那些账号之后这一行会自动消失。',
    );
    return;
  }
  const res = await send({ kind: 'par.deleteSite', host }).catch(() => null);
  const r = res && res.kind === 'par.deleteSite' && res.result.ok ? res.result.data : null;
  if (!r) {
    const err = res && res.kind === 'par.deleteSite' && !res.result.ok ? res.result.error : '未知错误';
    alert(`删除站点失败：${err}`);
    return;
  }
  if (r.kind === 'offline') {
    alert(`「${title}」没能删掉：当前连不上云端。\n\n联网后再删一次即可（这次没有任何改动）。`);
    return;
  }
  if (r.kind === 'missing') {
    await refreshAll();
    return;
  }
  if (r.kind === 'blocked') {
    // 服务端说"这个站点下面还有账号"，并把**具体是哪些**带了回来 ⇒ 把话说具体
    const names = r.usernames ?? [];
    const shown = names.slice(0, 12).join('、') + (names.length > 12 ? ` …等共 ${names.length} 个` : '');
    if (
      !confirm(
        `删除站点「${title}」？\n\n`
          + `该站点下的 ${r.accountCount} 个账号会被一并删除，且无法恢复：\n`
          + `${shown}\n\n`
          + '确定要连这些账号一起删除吗？（浏览器里已打开页签的登录态不受影响）',
      )
    ) {
      return;
    }
    const res2 = await send({ kind: 'par.deleteSite', host, force: true }).catch(() => null);
    const r2 = res2 && res2.kind === 'par.deleteSite' && res2.result.ok ? res2.result.data : null;
    if (!r2 || r2.kind === 'offline') {
      alert('删除失败：云端没有答复。请稍后重试。');
      return;
    }
    if (r2.kind === 'deleted' && (r2.accountsDeleted ?? 0) > 0) {
      flashBanner(`已删除站点「${title}」与其中 ${r2.accountsDeleted} 个账号。`, 'ok');
    } else {
      flashBanner(`已删除站点「${title}」。`, 'ok');
    }
  } else if (r.kind === 'deleted') {
    if ((r.accountsDeleted ?? 0) > 0) {
      flashBanner(`已删除站点「${title}」与其中 ${r.accountsDeleted} 个账号。`, 'ok');
    } else {
      flashBanner(`已删除站点「${title}」。`, 'ok');
    }
  }
  lastSitesKey = '';
  /* 顺手回收这个 host 的宿主权限（**尽力而为，不承诺**）。
   * ★ 为什么值得做：授权不会随云端记录消失，而"删掉一个和我无关的站点之后，
   *   浏览器还在往它的页面里注入内容脚本"是用户无从发现的事。
   * ★ 为什么**不能**承诺：在"全网通配"这种宽授权下，Chrome 会拒收针对具体 origin 的
   *   回收请求 —— 那是正常的，不是失败。所以这里既不弹窗也不改文案。 */
  void revokeHostPermissions(host);
  await refreshAll();
}

/**
 * ★★★ 2026-10-19（用户要求）：「站点管理缺少对站点的编辑功能」。
 *
 * 与云端控制台的「编辑站点」弹窗**同一条端点、同一组字段**：
 * 站点名称 / 地址 / 备注（`PATCH /api/sites/{id}`，`SitePatch` 三个字段都可选）。
 *
 * ★ 为什么不用 `prompt`（旧「更改名称」的路子）：
 *   ① 它只能收一个值，而"地址填错了"是用户真会遇到的事 —— 改地址只能删站重建，
 *      而删站会**连带删掉账号**；
 *   ② 它在扩展页里是浏览器模态框，样式不可控；
 *   ③ **无法写自动化判据**（Playwright 只能靠 dialog 事件间接驱动）。
 *
 * ★ 改地址要**二次确认**：账号绑定的是 `site_id`，站点地址一变，那些账号下一次
 *   打开时就会去新域名 —— 而已经开着的页签还停在旧域名上。这不是阻止用户改，
 *   而是让他知道"这个动作会波及 N 个账号"。
 */
function openSiteEditor(row: SiteRow): void {
  const card = document.createElement('div');
  card.className = 'modal-card';
  const h = document.createElement('h3');
  h.textContent = '编辑站点';

  const form = document.createElement('form');
  form.className = 'form';

  /** 一个「标签 + 控件 + 可选说明」的行（与账号编辑弹窗同一形状） */
  const field = (label: string, control: HTMLElement, hint?: string): HTMLLabelElement => {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const span = document.createElement('span');
    span.textContent = label;
    wrap.append(span, control);
    if (hint) {
      const small = document.createElement('small');
      small.textContent = hint;
      wrap.append(small);
    }
    return wrap;
  };

  // 预填**用户设的名**（不是显示名）—— 显示名可能是从地址推导的，
  // 预填它等于把推导结果写死成"用户起过的名"。
  const originalName = siteNames?.[row.host]?.name ?? row.title;
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = originalName;
  nameInput.maxLength = 120; // 与云端 `SitePatch.name` 的上限一致
  nameInput.placeholder = '例如 通桥医疗（留空 = 用地址推导）';

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.value = row.baseUrl;
  urlInput.maxLength = 300;
  urlInput.placeholder = 'https://example.com 或 10.100.0.105:8080';

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.value = row.note;
  noteInput.maxLength = 500;

  form.append(
    field('站点名称', nameInput, '只影响显示；留空则用地址推导'),
    field('站点地址', urlInput, `账号绑定的是站点记录，改地址会影响该站点下的 ${row.count} 个账号`),
    field('备注', noteInput),
  );

  const actions = document.createElement('div');
  actions.className = 'modal-actions';
  const cancel = document.createElement('button');
  cancel.className = 'btn-ghost';
  cancel.type = 'button';
  cancel.textContent = '取消';
  const save = document.createElement('button');
  save.className = 'btn-primary';
  save.type = 'submit';
  save.textContent = '保存';
  actions.append(cancel, save);
  form.append(actions);

  card.append(h, form);
  const overlay = document.createElement('div');
  overlay.className = 'modal';
  overlay.append(card);
  accountModalRoot.append(overlay);

  const close = (): void => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      close();
    }
  };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      close();
    }
  });
  cancel.addEventListener('click', close);
  nameInput.focus();
  nameInput.select();

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void (async () => {
      const name = nameInput.value.trim();
      const baseUrl = urlInput.value.trim();
      const note = noteInput.value;
      if (!baseUrl) {
        alert('站点地址不能为空。');
        urlInput.focus();
        return;
      }
      const parsedUrl = parseSiteInput(baseUrl);
      if (!parsedUrl.host) {
        alert('站点地址解析不出来。请填成 example.com 或 https://example.com 这样的形式。');
        urlInput.focus();
        return;
      }
      if (parsedUrl.host !== row.host) {
        if (!confirm(
          `把站点地址从 ${row.host} 改成 ${parsedUrl.host}？\n\n`
            + `该站点下的 ${row.count} 个账号仍属于这条站点记录，但它们下一次打开时会去新地址。\n`
            + '已经打开的页签不受影响。',
        )) {
          return;
        }
      }

      // ★ 与账号编辑弹窗同一条口径：**什么都没改就不发请求**
      //   （服务端每次 PATCH 都会推 revision，空保存会让别的客户端白拉一次全量快照）。
      if (
        row.siteId
        && name === originalName
        && baseUrl === row.baseUrl
        && note === row.note
      ) {
        close();
        return;
      }

      /* ★ 只提交**真的改了**的字段（与账号编辑弹窗同一条口径）。
       * 无脑全量提交会让一次"只改名"也重新归一化地址、并多推一次 revision。 */
      const sitePatch: { name?: string; baseUrl?: string; note?: string } = {};
      if (name !== originalName) {
        sitePatch.name = name;
      }
      if (baseUrl !== row.baseUrl) {
        sitePatch.baseUrl = baseUrl;
      }
      if (note !== row.note) {
        sitePatch.note = note;
      }

      save.disabled = true;
      cancel.disabled = true;
      save.textContent = '保存中…';

      const res = row.siteId
        ? await send({ kind: 'par.updateSite', siteId: row.siteId, ...sitePatch })
        : await send({
            kind: 'par.upsertSite',
            host: parsedUrl.host,
            name: name || parsedUrl.host,
            createBox: false,
          });
      if (!res.result.ok) {
        save.disabled = false;
        cancel.disabled = false;
        save.textContent = '保存';
        alert(`保存失败：${res.result.error}`);
        return;
      }
      close();
      lastSitesKey = '';
      // 地址可能变了 ⇒ 站点下拉也要重建
      lastHostOptions = '';
      await refreshAll();
    })();
  });
}

/**
 * 撤销某 host 的浏览器授权（**尽力而为**）。
 *
 * ★★ v4.2.12：这个函数从"删除站点时顺带做的一堆事"降级成**一个纯粹的清理动作**。
 *
 * ## 为什么它还被保留
 *
 * 用户的要求是「站点管理只做增删改，无需关注浏览器是否授权」，所以**界面上**
 * 一处都不再体现授权状态。但 Chrome 的约束没变：`optional_host_permissions` 是
 * 用户一条条授出去的，**授权不会随云端记录消失**。删掉站点却留着授权，后果不是
 * "看着不干净"，而是：
 *   · Chrome 会继续把内容脚本注入那个域（用户以为这个站已经和我无关了）；
 *   · 站点访问范围在 `chrome://extensions` 里越积越多，而那里是用户唯一能自查授权的地方。
 * ⇒ 所以删除时**顺手回收**，但不向用户承诺任何事、失败也不打断（回收不掉就记一条痕迹）。
 *
 * ## 为什么不再需要 `blockedHosts` 兜底
 *
 * 旧实现里"Chrome 拒绝回收"要落一个本地停用名单，否则改头规则会继续生效。
 * 现在 `isEnforceable()` 走的是 `chrome.permissions.contains()` **实查**
 * （见 `background/core/parallel-session.ts`），权限真被回收了它自己就知道了 ——
 * 那个本地名单是**同一事实的第二处声明**，而它已经造成了用户实测到的
 * "卡片说未授权、浏览器其实已授权"。⇒ 名单连同它的界面一起删除。
 */
async function revokeHostPermissions(host: string): Promise<void> {
  try {
    const all = await chrome.permissions.getAll();
    const raws = (all.origins ?? []).filter((o) => originToHost(o) === host);
    for (const raw of raws) {
      const okc = await chrome.permissions.remove({ origins: [raw] }).catch(() => false);
      if (!okc) {
        // ★ 不打断用户、不弹窗。Chrome 对 `*://*/*` 这种宽授权会拒收具体 origin 的
        //   回收请求 —— 那是正常的（宽授权本来就不该被逐条回收），不是缺陷。
        log.info('浏览器未回收 %s 的授权（多半已被更宽的授权覆盖）：授权仍然可用', raw);
      }
    }
    await send({ kind: 'par.grantChanged' });
  } catch (e) {
    log.warn('回收 %s 的浏览器授权失败（不影响删除结果）：%s', host, e instanceof Error ? e.message : String(e));
  }
}


/* ==================== 下拉填充（防闪烁：选项未变化不重建） ==================== */

async function fillSiteOptions(): Promise<void> {
  // ★ 选项内容带**站点名称**，所以 key 要含名字 —— 只按 host 判"没变化"的话，
  //   改了名字下拉不会更新（表现是"改名没生效"，v4.2.2 实测抓到过）。
  // ★★ v4.2.12：数据源从"浏览器授权清单"换成"站点管理的行" —— 两处必须是**同一份**
  //   数据，否则会出现"站点管理里有、下拉里没有"（或反过来）这种无从解释的差异。
  const rows = buildSiteRows();
  const key = JSON.stringify(rows.map((r) => [r.host, r.title]));
  if (key === lastHostOptions && pHostSelect.options.length) {
    return;
  }
  lastHostOptions = key;
  pHostSelect.innerHTML = '';

  if (!rows.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.disabled = true;
    empty.selected = true;
    empty.textContent = '（还没有站点 —— 请在「站点管理」添加）';
    pHostSelect.append(empty);
    return;
  }

  for (const r of rows) {
    const opt = document.createElement('option');
    opt.value = r.host;
    // ★ 选站点时按**名称**认，而不是认域名。但域名不能丢 —— 它是账号真正绑定的东西，
    //   出问题时要靠它定位。原生 option 不能富文本，所以用 `名称（域名）` 这个折中；
    //   名字为空时退化成只显示域名（此时两者相同，不必重复）。
    opt.textContent = r.title === r.host ? r.host : `${r.title}（${r.host}）`;
    opt.title = r.host;
    pHostSelect.append(opt);
  }

  const stored = await chrome.storage.local.get(LAST_HOST_KEY);
  const last = stored[LAST_HOST_KEY] as string | undefined;
  const hosts = rows.map((r) => r.host);
  const preferred =
    last && hosts.includes(last)
      ? last
      : hosts.includes(PREFERRED_HOST)
        ? PREFERRED_HOST
        : hosts[0];
  pHostSelect.value = preferred;
}


async function fillBoxOptions(): Promise<void> {
  const key = boxes.join('|');
  if (key === lastBoxOptions && pBoxSelect.options.length) {
    return;
  }
  lastBoxOptions = key;
  pBoxSelect.innerHTML = '';
  for (const name of boxes) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    pBoxSelect.append(opt);
  }
  const stored = await chrome.storage.local.get(LAST_BOX_KEY);
  const last = stored[LAST_BOX_KEY] as string | undefined;
  pBoxSelect.value = currentBox !== '全部' && boxes.includes(currentBox) ? currentBox : last && boxes.includes(last) ? last : defaultBox;
}

/* ==================== 站点授权表单 ==================== */

/* ★★ 2026-10-13（用户要求）：盒子管理面板的新建表单。
 *   与站点表单同一形状（`submit` + `preventDefault`），但有一条实质差别：
 *   **它打到云端**（`par.createBox`）—— 纯本地建盒会被对账剪掉，
 *   表现是"建好了，然后自己消失"（见 `createBoxFromForm` 的注释）。 */
boxForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void createBoxFromForm();
});

/* ★★★ v4.2.12（用户 2026-10-13 的决定）：**添加站点就是一次普通的新增**。
 *
 * ## 改前它是什么
 *
 * 这个处理器有 70 行，其中 60 行在处理"浏览器授权要不到怎么办"：
 * 先 `contains()` 探一次 → 未覆盖则 `request()` → 要不到就**弹一个确认框教用户去
 * `chrome://extensions` 手动添加网页**（还把模式串复制到剪贴板）。
 *
 * 用户原话：「仅对站点进行增删改，无需关注浏览器是否对其进行授权。」
 * ⇒ 上面那一整套都不该出现在用户的视野里。授权改由 `ensureHostPermission()` 在
 * **用户看不见的地方**处置（登录云端时一次要通配，之后永不再问）。
 *
 * ## 改后它是什么
 *
 * ① 解析地址（解析失败就报错 —— 那是**输入**问题，用户必须知道）
 * ② 把名称落到云端（**这一步才是"新增"的实质**：站点记录的权威在云端）
 * ③ 顺手补授权（同步发起，保住手势；成败都不拦）
 * ④ 刷新
 *
 * ★ 顺序：`ensureHostPermission` 必须在**任何 `await` 之前**发起 ——
 *   这是本仓栽过两次的坑（v4.2.7 / v4.2.9：晚一步手势失效，Chrome
 *   **不弹窗、不报错、返回 false**，表现为"点了没反应"）。
 */
siteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const parsed = parseSiteInput(sHost.value);
  const host = parsed.host;
  if (!host) {
    alert('站点地址解析不出来。请填成 example.com 或 https://example.com 这样的形式。');
    return;
  }
  // ★ 名称留空 ⇒ **用站点地址填**（用户要求的回落口径）。这里用的是归一化后的 `host`
  //   而不是用户原样输入 —— 用户可能粘的是 `https://a.com/x`，拿整串当名字会很难看。
  const name = sName.value.trim() || host;

  // ① 先发授权请求（**手势里最先**，见上面那段说明）；不 await，成败都不拦。
  void ensureHostPermission(host);

  void (async () => {
    // ★ 2026-10-19：`createBox` 跟着勾选框走（默认勾选 = 原行为）。
    // ★ 同时修掉一个静默缺陷：`send()` 的契约是**永不抛**、失败也以
    //   `{ok:false,error}` 返回 —— 所以旧代码外面那个 `try/catch` **永远进不去**，
    //   云端拒绝时界面照样清空输入框、假装保存成功。现在显式读 `result.ok`。
    const res = await send({
      kind: 'par.upsertSite',
      host,
      name,
      // ★ `?.` 是给"页面是旧版 HTML、JS 已是新版"的错配兜底：缺元素时按默认「建盒」。
      createBox: sCreateBox?.checked !== false,
    });
    if (res.kind === 'par.upsertSite' && !res.result.ok) {
      log.warn('站点未保存到云端：%s', res.result.error);
      alert(`站点「${name}」没能保存到云端：${res.result.error}`);
      return;
    }
    if (parsed.scheme) {
      await writeSchemeHint(host, parsed.scheme);
    }
    sHost.value = '';
    sName.value = '';
    lastSitesKey = '';
    await refreshAll();
  })();
});


/* ==================== 二级导航栏（切换功能块，v4.2.1 第五轮）====================
 *
 * 用户要求：「将原本揉在一个页面中的『并行账号』『添加并行账号』『站点管理』
 * 『常用页面』拆分出去，由二级导航栏控制功能块显示」。
 *
 * ★ 切面板**只改 DOM 类名，不重新渲染数据** —— 数据由 `refreshAll()` 那条循环统一维护，
 *   与"看哪一块"无关。若在切换时顺手重渲染，就会多出第二条渲染路径，
 *   而两条路径迟早不一致（这是本仓反复出现的形态）。
 * ★ `hidden` 属性与 `.is-active` **同时**维护：前者给无障碍（读屏会跳过隐藏面板），
 *   后者给样式。只留一个的话，另一个迟早被误当成"没用"而删掉。
 */
const TAB_NAMES = ['accounts', 'add', 'sites', 'boxes', 'favorites'] as const;
type TabName = (typeof TAB_NAMES)[number];

/** 面板元素：**逐个 `getElementById` 取**，而不是 `querySelector('.pane')` 扫一遍。
 *
 * ★ 这样写有两条实际好处（不是为了好看）：
 *   ① 每个 `pane-*` 的 id 在 TS 里**有字面引用** ⇒ `verify-log-redaction` 的
 *      "HTML 有 id、TS 零引用"那条判据不会把它们当成孤儿 id
 *      （用模板串拼 id 的话判据看不见 —— 那会逼我去扩白名单，
 *       而白名单一扩就变成"新增孤儿 id 的合法通道"，规则 26）。
 *   ② 少了"页面上有几个 `.pane`"与"我知道有几个面板"这两份事实的漂移：
 *      现在面板清单只有 `TAB_NAMES` 一处，取不到就是 `null`（能被看见）。
 */
const PANE_ELS: Record<TabName, HTMLElement | null> = {
  accounts: document.getElementById('pane-accounts'),
  add: document.getElementById('pane-add'),
  sites: document.getElementById('pane-sites'),
  boxes: document.getElementById('pane-boxes'),
  favorites: document.getElementById('pane-favorites'),
};

function showTab(name: string, persist = true): void {
  const target: TabName = (TAB_NAMES as readonly string[]).includes(name)
    ? (name as TabName)
    : 'accounts';
  for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>('.tabs .tab'))) {
    const on = t.dataset.tab === target;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  for (const n of TAB_NAMES) {
    const pane = PANE_ELS[n];
    const on = n === target;
    pane?.classList.toggle('is-active', on);
    if (pane) {
      pane.hidden = !on;
    }
  }
  if (persist) {
    void chrome.storage.local.set({ [LOCAL_KEYS.parallelTab]: target });
  }
}

/**
 * 恢复上次选中的面板。
 *
 * ★ 必须**在首屏渲染前**调用一次：这一页每 3 秒 `refreshAll()` 一次，
 *   若每次都从 `accounts` 开始，用户在"站点管理"里填到一半会被弹回第一块。
 *   （`showTab` 默认 `persist=false` 的那个入口就是给"恢复"用的。）
 */
async function restoreTab(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.parallelTab);
    const name = stored[LOCAL_KEYS.parallelTab] as string | undefined;
    if (name && (TAB_NAMES as readonly string[]).includes(name)) {
      showTab(name, false);
    }
  } catch {
    // 读不到就用 HTML 里的默认（第一块）—— 不值得为它报错
  }
}

for (const t of Array.from(document.querySelectorAll<HTMLButtonElement>('.tabs .tab'))) {
  t.addEventListener('click', () => showTab(t.dataset.tab ?? 'accounts'));
}

void restoreTab();

/* 一级导航栏右侧的「登录」与遮罩上的「登录」：同一个动作（设备流授权）。
   ★ 用 `click()` 转发现有按钮，避免把设备流启动逻辑复制成第二份 ——
     `#auth-relogin` 已经接了 `startDeviceLogin`，这里只是替用户点它。 */
for (const btn of [cloudLoginBtn, loginMaskBtn]) {
  btn.addEventListener('click', () => authReloginBtn.click());
}

/* ==================== 云端身份菜单（v4.2.1）====================
 *
 * 用户要求：点页头那块已登录账号 → 弹「同步数据 / 退出账号」，
 * **不是**只在扩展弹窗里给（那是我上一版的错位：功能做在了 popup，用户在账号中心点不出来）。
 *
 * ★ 两个动作都**只动本机**：退出 = 清令牌 + 清本机缓存的账号数据；
 *   云端账号库一条记录都不动（"退出登录" ≠ "注销账号"）。
 */

function closeCloudMenu(): void {
  cloudMenuEl.classList.add('hidden');
  cloudAccountEl.setAttribute('aria-expanded', 'false');
}

cloudAccountEl.addEventListener('click', (e) => {
  e.stopPropagation();
  const nowHidden = cloudMenuEl.classList.toggle('hidden');
  cloudAccountEl.setAttribute('aria-expanded', nowHidden ? 'false' : 'true');
});
// 点外部 / Esc 关闭（与帮助气泡同一套习惯）
document.addEventListener('click', () => closeCloudMenu());
cloudMenuEl.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeCloudMenu();
  }
});

/* ★★★ 2026-10-19（用户要求 ⑧）：身份菜单里加「打开 Akso Cloud」。
 *
 * 用户原话：「在图示位置增加一个按钮，『打开akso-cloud』，便于用户直接打开管理网站。」
 * ⇒ 在同一个菜单里（用户截图那个位置）多一项，直接打开当前登录的云端地址。
 * ★ 地址用 `cloudBaseUrl`（云端会话回报的**实际** baseUrl），不写死常量 ——
 *   这个服务从 8443 迁到 443 过一次，写死就会在迁移后打开一个错端口。
 */
cloudMenuOpen.addEventListener('click', () => {
  closeCloudMenu();
  if (!cloudBaseUrl) {
    alert('还没拿到云端地址：请先登录云端账号库，或稍等片刻再试。');
    return;
  }
  void chrome.tabs.create({ url: cloudBaseUrl });
});

cloudMenuSync.addEventListener('click', () => {
  closeCloudMenu();
  void (async () => {
    const label = cloudMenuSync.querySelector('b');
    const original = label?.textContent ?? '同步数据';
    cloudMenuSync.disabled = true;
    if (label) {
      label.textContent = '同步中…';
    }
    try {
      const res = await send({ kind: 'cloud.sync' });
      if (res.kind === 'cloud.sync' && res.result.ok) {
        if (label) {
          label.textContent = `已同步（${res.result.data.accounts} 个账号）`;
        }
        // 站点名与账号列表都可能变了 ⇒ 整页刷新（复用既有入口，不另造渲染路径）
        lastSitesKey = '';
        await loadSites();
        await refreshAll();
      } else {
        // ★ 失败必须说出来：静默失败会让用户以为"同步过了"，而数据其实没动
        const msg = res.kind === 'cloud.sync' && !res.result.ok ? res.result.error : '未知原因';
        if (label) {
          label.textContent = `同步失败：${String(msg).split('\n')[0].slice(0, 14)}`;
        }
      }
    } finally {
      cloudMenuSync.disabled = false;
      window.setTimeout(() => {
        if (label) {
          label.textContent = original;
        }
      }, 2600);
    }
  })();
});

cloudMenuLogout.addEventListener('click', () => {
  closeCloudMenu();
  if (
    !confirm(
      '退出云端账号？\n\n'
        + '· 本机将清除登录令牌与缓存的账号数据\n'
        + '· 云端账号库里的数据不受影响，重新登录即可恢复\n'
        + '· 已打开的平台页签不受影响（平台登录态与云端账号库是两件事）',
    )
  ) {
    return;
  }
  void (async () => {
    try {
      const res = await send({ kind: 'cloud.logout' });
      if (res.kind === 'cloud.logout' && !res.result.ok) {
        alert(`退出失败：${res.result.error}`);
        return;
      }
    } catch (e) {
      alert(`退出失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // ★ 退出后**主动清掉页面上还留着的账号列表**：不清的话界面仍显示上一个账号的
    //   9 个账号，而它们已经不可用了 —— 用户会因此认为"退出没生效"
    //   （这正是用户报的第 3 条：功能其实生效了，但界面没跟着变）。
    browserAccounts = [];
    lastSitesKey = '';
    siteNames = null;
    await refreshAll();
  })();
});

/* ==================== 数据源（本地 ↔ 云端，v3.14；设备授权 v3.14.1） ==================== */

/**
 * 云端服务 origin 的 host 授权模式。
 * ★ 服务端**不带任何 CORS 头**（实测 OPTIONS → 405），所以没有这条 host 授权，
 *   扩展里对云端的 fetch 必然失败 —— 请求必须趁用户手势仍有效时最先发起。
 */
const CLOUD_ORIGIN_PATTERN = 'https://www.dragonrain.top/*';
/** 设备自报的名字（批准页会显示它，用户据此确认"是我这台浏览器"） */
const DEVICE_CLIENT_NAME = 'Chrome 扩展 · Akso Pass';
/** 服务端没给 interval 时的兜底秒数（实测服务端会给；这里只是"读不到就别拿 0 去问"） */
const DEVICE_POLL_FALLBACK_S = 3;

/** 云端 host 授权：必须在用户手势里最先发起（晚一步手势就失效，fetch 必然失败） */
async function ensureCloudOriginPermission(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [CLOUD_ORIGIN_PATTERN] });
  } catch {
    return false;
  }
}


function setDeviceBusy(busy: boolean): void {
  deviceBusy = busy;
  renderAuthBar();
}

/**
 * ★ v3.18：认证条与「已登录谁」的**唯一渲染点**。
 *
 * 它合并了原来两处渲染：
 *   ① `#auth-bar`（登录过期提示）—— 原来在 `renderSourceSwitch` 里跟着数据源一起渲染；
 *   ② 「已登录谁」（头像 + 名字）—— 同上。
 *
 * ⇒ 数据源概念废除后，`renderSourceSwitch` 整块删掉了，而**这两个渲染跟着一起消失**，
 *   表现是"登录状态不再显示" —— 那不是"清理未使用变量"能发现的问题
 *   （编译期只报"某某声明未使用"）。
 *   把它们收进一个函数，是因为它们本来就是同一件事：**告诉用户"现在是谁、能不能用"**。
 */
function renderAuthBar(): void {
  // ① 未登录 / 登录过期：显示提示条与「重新登录」
  authBarEl.classList.toggle('hidden', cloudAuthorized);
  authReloginBtn.disabled = deviceBusy;

  // ② 已登录：显示"是谁"（头像或首字母色块 + 名字）
  cloudAccountEl.classList.toggle('hidden', !cloudAuthorized);
  cloudAccountEl.textContent = '';
  // 云端地址放进 tooltip：它原来是数据源按钮的 title，按钮删了 ⇒ 这个信息不该默默丢
  cloudAccountEl.title = cloudBaseUrl ? `云端账号库：${cloudBaseUrl}（点此管理）` : '云端账号库（点此管理）';
  if (cloudAuthorized) {
    const label = cloudDisplayName || cloudEmail || '已登录云端';
    const av = document.createElement('span');
    av.className = 'cloud-av';
    if (cloudAvatar) {
      const img = document.createElement('img');
      img.src = cloudAvatar;
      img.alt = '';
      av.append(img);
    } else {
      // 没设头像就是首字母色块 —— 空着一个灰圆看起来像"加载失败"
      av.textContent = label.slice(0, 1).toUpperCase();
    }
    const name = document.createElement('span');
    name.textContent = label;
    // ★ v4.2.1：点这块弹「同步数据 / 退出账号」（用户要求 1+3）。
    //   加个 ▾ 让"可点"这件事**看得见** —— 光有 hover 效果，用户不会知道这里能点。
    const caret = document.createElement('span');
    caret.className = 'cloud-caret';
    caret.textContent = '▾';
    cloudAccountEl.append(av, name, caret);
  }

  // ③ 未登录：一级导航栏右侧显示「登录」，并把**二级导航及以下**整体锁住
  cloudLoginBtn.classList.toggle('hidden', cloudAuthorized);
  tabbedEl.classList.toggle('is-locked', !cloudAuthorized);
  loginMaskEl.classList.toggle('hidden', cloudAuthorized);

  // ④ 说明文案：**只有云端一种形态**，不再分叉
  //    （旧文案里"密码 AES-GCM 加密存放在本机"已随本地数据源废除 —— 留着就是说谎）
  parHintEl.textContent =
    '页签名即该账号所有标签页的标题；密码存放在云端账号库（服务端加密），本机不落明文。';
}

/**
 * 提示条的唯一渲染点：**按"严重度 + 信息种类"排序**，都没有就收起。
 *
 * 顺序是有意的（越靠前越"用户必须知道"）：
 *   ① 登录已过期 → 不在这里（那是 `#auth-bar` 的活，两条同时出现会让用户以为是两个毛病）
 *   ② 云端不可用（**什么都没有**）→ `err`
 *   ③ **这是离线副本**（有数据，但是旧的、且改不了）→ `warn`
 *   ④ 一次性提示（合并结果等）
 *
 * ★ ② 与 ③ 的文案必须不同：一个是"数据没读到"，一个是"数据是旧的"。
 *   合成一句会让用户分不清该等网络还是该去重登。
 */
function renderCloudBanner(): void {
  // 未登录（令牌过期/被清）时**不**把"云端未授权"当网络故障播报：那是 #auth-bar 的活，
  // 两条同时出现会让用户以为是两个毛病。
  if (cloudListError && cloudAuthorized) {
    cloudBannerEl.textContent =
      `云端不可用（${cloudListError}），当前无法读取账号。数据仍在云端，网络恢复后自动可用。`;
    cloudBannerEl.className = 'notice err';
    return;
  }
  // ★★ 离线只读副本（B7 的显式要求："明确显示这是副本"）。
  //   用户在这里必须同时知道**三件事**，少一件都会让他误判：
  //     ① 这是副本（不是实时数据）
  //     ② 它有多旧（"多久前"比"可能是旧的"有用得多）
  //     ③ **改不了**（否则"我点了保存怎么没反应"会被理解成扩展坏了）
  if (offlineStatus.offline) {
    cloudBannerEl.textContent =
      `离线：当前显示的是${describeSnapshotAge(offlineStatus.ageMs)}的只读副本。`
      + '可以查看、可以打开页签；但**不能新增/编辑，自动填表也不生效**。'
      + '网络恢复后会自动切回实时数据（云端数据没有丢）。';
    cloudBannerEl.className = 'notice warn';
    return;
  }
  if (bannerFlash && bannerFlash.until > Date.now()) {
    cloudBannerEl.textContent = bannerFlash.text;
    cloudBannerEl.className = `notice ${bannerFlash.kind}`;
    return;
  }
  bannerFlash = null;
  /* ★★★ 2026-10-14：把"这一轮有哪些步骤没刷新成功"说出来。
   *
   * 优先级**最低**（放在最后）：上面三条更具体的原因（未登录 / 离线副本 / 闪报）都优先。
   * 为什么非说不可：一次版本错配曾让"账号刷新"这一步**静默地永不执行**，
   * 而界面看起来完全正常 —— 那种形态用户无从归因，只能报"数据不同步"。
   * ★ 文案里给出**可执行的下一步**（重新加载扩展），而不是只说"出错了"。 */
  if (lastRefreshFailures.length) {
    cloudBannerEl.textContent =
      `有 ${lastRefreshFailures.length} 项没能刷新（${lastRefreshFailures.join('、')}），其余部分照常。`
      + '若反复出现，请在 chrome://extensions 重新加载扩展（改了扩展代码后必须重载，'
      + '否则页面与后台可能跑着两个版本）。';
    cloudBannerEl.className = 'notice warn';
    return;
  }
  cloudBannerEl.textContent = '';
  cloudBannerEl.className = 'notice hidden';
}

/**
 * 把副本年龄说成人话。
 *
 * ★ 为什么要专门写一个：`ageMs` 直接丢给用户（"300000 毫秒前"）没人能读；
 *   而含糊成"可能是旧的"又丢掉了本仓刻意保留 `savedAt` 的**全部价值** ——
 *   `account-cache.ts` 的设计意图原文就是
 *   "界面上就能给出**准确的离线提示**（『这是 3 天前的副本』而不是含糊的『可能是旧的』）"。
 *
 * ★ 阈值按"用户会怎么用这份数据"划，不按技术刻度：
 *   分钟级 → 他大概记得刚才在干什么；小时级 → 要提醒他可能变了；
 *   天级 → 必须警告他大概率已经过期。
 */
function describeSnapshotAge(ageMs?: number): string {
  if (ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) {
    // 拿不到年龄时**不编**：宁可少说，也不要说错（与"离线状态问不到就不报离线"同一条原则）
    return '上次同步';
  }
  const min = Math.floor(ageMs / 60_000);
  if (min < 1) return '刚才同步';
  if (min < 60) return `${min} 分钟前同步`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前同步`;
  return `${Math.floor(hr / 24)} 天前同步`;
}

function flashBanner(text: string, kind: 'ok' | 'err' | 'warn' = 'ok'): void {
  bannerFlash = { text, kind, until: Date.now() + BANNER_FLASH_MS };
  renderCloudBanner();
}

/** 从 background 取云端会话现状（每轮刷新都取：登录/过期只发生在那里） */
async function loadCloudState(): Promise<void> {
  try {
    const res = await send({ kind: 'cloud.state' });
    if (!res || res.kind !== 'cloud.state' || !res.result.ok) {
      return; // 取不到就维持现状：会话标记只影响文案，不该拖垮整页刷新
    }
    cloudAuthorized = res.result.data.authorized;
    cloudEmail = res.result.data.email;
    cloudDisplayName = res.result.data.displayName ?? '';
    cloudAvatar = res.result.data.avatar ?? '';
    cloudBaseUrl = res.result.data.baseUrl;
  } catch {
    // 同上：维持现状
  }
}

/* ---------------- 云端设备授权（RFC 8628，v3.14.1 取代"手抄授权码"） ----------------
 * 形状：device-start → `chrome.tabs.create(verificationUrl)` → 按 interval 轮询 device-poll → 落令牌。
 * ★ `deviceCode` 全程不进这个页面（它只活在 SW 内存里）；这里出现的只有给人看的批准页 URL。
 * ★ 轮询是**页面驱动的单循环**（不是 SW 里的定时器）：取消 = 停掉这一个循环 + 让 SW 丢掉凭据。
 */

/** 等待的世代号：取消 / 重试都 +1；在跑的那一圈回来后一律作废（不再发下一个请求） */
let deviceFlowGen = 0;
/** 取消/重试时立刻叫醒正在等待的那一拍（否则要傻等到下一个 interval） */
let deviceWake: (() => void) | null = null;
/** 设备授权进行中（禁掉数据源按钮，杜绝两圈轮询同时跑） */
let deviceBusy = false;
/** 本次会话的 8 位码：**只用来核对用户手输**，不渲染进 DOM（不让人抄） */
let deviceUserCode = '';
/** 服务端给的批准页 URL：原样打开，不自己拼 */
let deviceApprovalUrl = '';

async function openApprovalTab(): Promise<void> {
  if (!deviceApprovalUrl) {
    setDeviceManualMsg('还没拿到批准页地址：请稍等片刻，或取消后重新发起登录。', true);
    return;
  }
  try {
    await chrome.tabs.create({ url: deviceApprovalUrl });
    setDeviceManualMsg('已打开批准页，请在那边完成批准。', false);
  } catch {
    setDeviceManualMsg('浏览器拒绝打开新标签页：请手动复制上面的批准页链接访问。', true);
  }
}

deviceCancelBtn.addEventListener('click', () => {
  deviceFlowGen += 1; // 在跑的那一圈作废（醒来后也不会再发请求）
  deviceWake?.(); // 立刻叫醒它，不必等满 interval
  void sendSafe({ kind: 'cloud.device.cancel' }); // 让 SW 把 deviceCode 从内存里丢掉
  closeDevicePanel();
});

deviceRetryBtn.addEventListener('click', () => void retryDeviceLogin());

deviceUserCodeOpen.addEventListener('click', () => {
  // ★ 兜底入口：8 位码只在服务端的批准页使用。这里只做两件事 —— 与本次会话核对、打开批准页；
  //   **不拿它去调任何换令牌的接口**（device-token 那条老路已废弃）。
  const typed = deviceUserCodeInput.value.replace(/\D/g, '');
  if (typed.length !== 8) {
    setDeviceManualMsg('请输入完整的 8 位数字授权码。', true);
    return;
  }
  if (typed !== deviceUserCode) {
    setDeviceManualMsg(
      '这 8 位码与本次授权会话不一致（可能是上一次尝试留下的码）。请点上面的批准页链接，或取消后重新发起登录。',
      true,
    );
    return;
  }
  setDeviceManualMsg('码与本次会话一致，正在打开批准页…', false);
  void openApprovalTab();
});

authReloginBtn.addEventListener('click', () => void retryDeviceLogin());

/* ★★★ v4.2.12：**把"站点授权"这件事在这里一次解决掉**。
 *
 * 用户在点「登录 / 重新登录」时已经明确表达了"我要用这个扩展"，所以这是要通配授权的
 * 最自然、也是**最后一次**会弹窗的时机 —— 之后 `ensureHostPermission()` 探到已被覆盖，
 * 一个窗都不会再弹。用户从此不必知道"授权"这个概念存在（这正是他的要求：
 * 「仅对站点进行增删改，无需关注浏览器是否对其进行授权」）。
 *
 * ★ 为什么单独一个监听器、而不是写进 `retryDeviceLogin()` 里：
 *   那个函数内部第一句就是 `await ensureCloudOriginPermission()` ——
 *   **一次 await 之后用户手势就没了**，Chrome 对 `permissions.request` 会
 *   **不弹窗、不报错、直接 resolve(false)**（本仓 v4.2.7 / v4.2.9 连着栽过两次）。
 *   在这个监听器里**同步**发起，是唯一能保住手势的位置。
 *
 * ★ 与设备流那一路的关系：`requestWideHostPermission()` 里已经含了云端域
 *   （通配覆盖它），所以两件事不冲突、顺序也不重要。捕获阶段先跑，只是为了"最先"。
 *
 * ★ 结果是 false 时**什么都不做**：那是用户点了拒绝（或 Chrome 不给这个窗）。
 *   站点仍然能用，只是每换一个站点会多一次具体站点的弹窗，而那个窗用户看得懂。
 */
authReloginBtn.addEventListener(
  'click',
  () => {
    void requestWideHostPermission().then((ok) => {
      if (ok) {
        log.info('已获得全网通配授权：后续站点不再需要单独授权');
        // 授权变了 ⇒ 后台的 enforcement 缓存必须失效，否则卡片状态会慢一拍
        void send({ kind: 'par.grantChanged' }).catch(() => undefined);
      } else {
        log.info('用户未授予全网通配授权：退回按站点请求（每个新站点会弹一次）');
      }
    });
  },
  { capture: true },
);

// 页面被关掉/刷新：把设备授权会话也收掉（deviceCode 不该在后台多留一分钟）
window.addEventListener('pagehide', () => {
  void sendSafe({ kind: 'cloud.device.cancel' });
});

/** 本次授权的绝对过期时刻（服务端 expiresIn 换算；每次 sleep 都被夹到"剩余时间"） */
let deviceExpiresAt = 0;

/** sendMessage 的"后台重启 / 无接收端"会以 undefined 回调 —— 统一折成 null，别让轮询循环炸掉 */
async function sendSafe(req: RuntimeRequest): Promise<RuntimeResponse | null> {
  try {
    return ((await send(req)) as RuntimeResponse | undefined) ?? null;
  } catch (e) {
    // ★★ 2026-10-09 补：这是**所有**后台通信的收口，而它此前**完全静默**。
    //
    //   "后台重启 / 无接收端"折成 null 是对的（轮询循环不该炸），
    //   但**静默**是错的：三种后果全都是"看起来正常"——
    //     ① 设备流轮询**无声停住**（用户以为还在等批准）
    //     ② `cloud.device.poll` 拿不到 ⇒ 用户等一个**永远不会来的**结果
    //     ③ 后台真的挂了 ⇒ 界面上一切照旧，只是**什么都没发生**
    //
    //   ★ 级别 `debug`：它是**正常路径之一**（SW 冷启期间必然发生几次），
    //     记 `warn` 会把环形 60 里的真失败挤掉（规则 22）。
    //     ⇒ 默认 `info` 级下它**不输出** ⇒ 只在排障时开 `debug` 才看得到。
    //   ★ 而"排障时才发现"是不够的 ⇒ SW 侧对 `ql.log` **额外落一条 forensics**
    //     （结构化、带来源），这样"前端在什么时候发不出消息"在诊断包里**一直有**，
    //     不取决于当时的日志级别。见 `service-worker.ts` 的 `ql.log` handler。
    log.debug('sendSafe(%s) 失败 ⇒ 折成 null（后台重启/无接收端？）：%s',
      req.kind, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** 服务端下发的 interval（秒）：必须 ≥1；读不到就退到 3 —— **绝不返回 0**（那等于压测服务端） */
function normalizeInterval(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : DEVICE_POLL_FALLBACK_S;
}

/** 可被打断的一拍：取消/重试调 `deviceWake()` 让它立刻返回（不必等满 interval） */
function deviceSleep(ms: number): Promise<'slept' | 'woken'> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      deviceWake = null;
      resolve('slept');
    }, ms);
    deviceWake = () => {
      window.clearTimeout(timer);
      deviceWake = null;
      resolve('woken');
    };
  });
}

function openDevicePanel(): void {
  deviceModal.classList.remove('hidden');
  deviceRetryBtn.classList.add('hidden');
  deviceManual.open = false;
  deviceUserCodeInput.value = '';
  setDeviceManualMsg('', false);
  deviceUrlEl.textContent = '（等待服务端返回）';
  deviceUrlEl.removeAttribute('href');
  setDeviceWaiting('正在向云端申请授权…');
}

function closeDevicePanel(): void {
  deviceModal.classList.add('hidden');
  deviceUserCode = '';
  deviceApprovalUrl = '';
  deviceExpiresAt = 0;
}

/** 面板上的批准页链接：文本就是 URL 本身（要能手动复制），不含任何凭据 */
function setDeviceLink(url: string): void {
  deviceApprovalUrl = url;
  deviceUrlEl.textContent = url;
  deviceUrlEl.href = url;
}

function setDeviceWaiting(text = '已打开浏览器，请在那边登录，完成后这里会自动继续。'): void {
  deviceSpinner.classList.remove('hidden');
  deviceStatusEl.className = 'device-status-text';
  deviceStatusEl.textContent = text;
  deviceRetryBtn.classList.add('hidden');
}

function showDeviceError(text: string): void {
  deviceSpinner.classList.add('hidden');
  deviceStatusEl.className = 'device-status-text err';
  deviceStatusEl.textContent = text;
  deviceRetryBtn.classList.remove('hidden');
}

function setDeviceManualMsg(text: string, err: boolean): void {
  deviceManualMsg.textContent = text;
  deviceManualMsg.className = err ? 'device-manual-msg err' : 'device-manual-msg';
}

/** 终态各自的说法：**不许一律"失败"** —— 这四种原因用户能做的事完全不同 */
function deviceTerminalText(status: 'denied' | 'expired' | 'consumed' | 'unknown'): string {
  switch (status) {
    case 'denied':
      return '授权被拒绝：这次登录没有完成。云端账号与本地数据都没有改动，可以稍后重试。';
    case 'expired':
      return '授权码已过期，请重试。';
    case 'consumed':
      return '这次授权已经被取走过（例如扩展后台重启后重复查询），请重新发起登录。';
    case 'unknown':
      return '服务端不认识这次授权会话（可能已过期或被清理），请重新发起登录。';
  }
}

type DeviceAttempt = 'approved' | 'cancelled' | 'terminal' | 'error';

/**
 * ★★ 轮询循环（唯一排程点就是下面的 `deviceSleep`）：
 *    - **每一拍之间至少等 `interval` 秒**（`interval` 取自 device-start，服务端每次回包还能修订它；
 *      读不到就退到 3）——这是全服务唯一无需凭据的端点族，轮密了等于给服务端做压测；
 *    - 取消 / 重试 = `deviceFlowGen++` + `deviceWake()`：循环在**当前这一拍**立刻退出；
 *      醒来后和请求回来后各比一次世代号，所以即便请求在飞，回来也不会再发下一个 device-poll；
 *    - 总超时以服务端 `expiresIn` 为准：每次 sleep 都夹到剩余时间，到点报"授权码已过期，请重试"。
 */
async function pollDeviceUntilDone(gen: number, intervalS: number): Promise<DeviceAttempt> {
  let delayS = normalizeInterval(intervalS);
  while (gen === deviceFlowGen) {
    const remainMs = deviceExpiresAt - Date.now();
    if (remainMs <= 0) {
      await sendSafe({ kind: 'cloud.device.cancel' }); // 超时也把 SW 里的 deviceCode 丢掉
      closeDevicePanel();
      flashBanner('授权码已过期，请重试。', 'err');
      return 'terminal';
    }

    const slept = await deviceSleep(Math.min(delayS * 1000, remainMs));
    if (slept !== 'slept' || gen !== deviceFlowGen) {
      return 'cancelled';
    }

    const res = await sendSafe({ kind: 'cloud.device.poll' });
    if (gen !== deviceFlowGen) {
      return 'cancelled'; // 请求在飞的时候被取消：回来什么都不做（更不落令牌）
    }
    if (!res || res.kind !== 'cloud.device.poll' || !res.result.ok) {
      const err = res && res.kind === 'cloud.device.poll' && !res.result.ok ? res.result.error : '后台无响应';
      showDeviceError(`查询授权状态失败：${err}`);
      return 'error';
    }

    const st: CloudDevicePoll = res.result.data;
    if (st.status === 'pending') {
      delayS = normalizeInterval(st.interval);
      setDeviceWaiting();
      continue;
    }
    if (st.status === 'approved') {
      return 'approved';
    }
    if (st.status === 'stopped') {
      return 'cancelled'; // 本地已取消/已被新会话替换：不是错误，不用提示
    }
    closeDevicePanel();
    flashBanner(deviceTerminalText(st.status), 'err');
    return 'terminal';
  }
  return 'cancelled';
}

/** 一次完整尝试：device-start → 打开批准页 → 轮询到终态。网络类失败保留面板（里面有「重试」） */
async function runDeviceAttempt(): Promise<DeviceAttempt> {
  const gen = ++deviceFlowGen;
  openDevicePanel();

  const started = await sendSafe({ kind: 'cloud.device.start', clientName: DEVICE_CLIENT_NAME });
  if (gen !== deviceFlowGen) {
    return 'cancelled';
  }
  if (!started || started.kind !== 'cloud.device.start' || !started.result.ok) {
    const err =
      started && started.kind === 'cloud.device.start' && !started.result.ok ? started.result.error : '后台无响应';
    showDeviceError(`发起授权失败：${err}`);
    return 'error';
  }

  const info = started.result.data;
  deviceUserCode = info.userCode; // 只在内存里，用来核对用户手输的码
  setDeviceLink(info.verificationUrl); // ★ 直接用服务端拼好的 URL
  deviceExpiresAt = Date.now() + normalizeInterval(info.expiresIn) * 1000;

  // 打开批准页：失败不致命（面板里有链接 + 手动入口），但必须让用户看见
  let opened = true;
  try {
    await chrome.tabs.create({ url: info.verificationUrl });
  } catch {
    opened = false;
  }
  if (gen !== deviceFlowGen) {
    return 'cancelled';
  }
  if (opened) {
    setDeviceWaiting();
  } else {
    deviceManual.open = true; // 自动打开失败 ⇒ 兜底入口直接摊开，别让用户去找
    setDeviceWaiting('自动打开浏览器失败：请手动打开下面的批准页链接（或在下面手动输入 8 位码）。');
  }

  return pollDeviceUntilDone(gen, info.interval);
}

/**
 * 云端登录（设备流）。true = 已拿到令牌并落进 `chrome.storage.local`。
 * `approved` 之后的落盘在 SW 侧完成，这里只负责把面板收掉 + 立刻刷新登录态。
 */
async function loginCloud(): Promise<boolean> {
  if (deviceBusy) {
    return false;
  }
  setDeviceBusy(true);
  try {
    const outcome = await runDeviceAttempt();
    if (outcome === 'approved') {
      closeDevicePanel();
      await loadCloudState(); // 立刻把「☁ 邮箱」画出来，不等下一轮 3 秒刷新
      return true;
    }
    if (outcome === 'cancelled') {
      closeDevicePanel();
      return false;
    }
    if (outcome === 'terminal') {
      return false; // 各自的终态提示已经给过
    }
    return false; // 'error'：面板留着，里面有「重试」
  } finally {
    setDeviceBusy(false);
  }
}

/** 「重试」= **重新 device-start**（绝不复用旧 deviceCode）；成功后顺带刷新整页 */
async function retryDeviceLogin(): Promise<void> {
  if (!(await ensureCloudOriginPermission())) {
    // ★ 2026-10-12 修：原文是「请关掉本面板，**在数据源处**重新点击「云端」」——
    //   而"数据源切换控件"已在 v3.18 随本地数据源整体废除（`#source-switch` 是空容器，
    //   渲染函数也删了）⇒ 这句话指向一个**界面上不存在的入口**，用户按它找不到任何东西。
    //   指向真实存在的控件：管理页 `#auth-bar` 里的「重新登录」按钮（`#auth-relogin`）。
    showDeviceError('未获得云端服务的访问授权：请关掉本面板，在管理页顶部点「重新登录」以重新发起授权。');
    return;
  }
  if (!(await loginCloud())) {
    return;
  }
  flashBanner('云端账号库已登录。', 'ok');
  await refreshAll();
}



/* ==================== 合并确认弹窗 + 「不再提示」的反悔通道（v3.14.1） ==================== */




/* ==================== 数据源 ? 帮助气泡（点外部 / Esc 关闭） ==================== */

function setHelpOpen(open: boolean): void {
  sourceHelpPop.classList.toggle('hidden', !open);
  sourceHelpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

sourceHelpBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // 别让"点外部关闭"当场把它关掉
  const willOpen = sourceHelpPop.classList.contains('hidden');
  setHelpOpen(willOpen);
  if (willOpen) {
  }
});

document.addEventListener('click', (e) => {
  if (sourceHelpPop.classList.contains('hidden')) {
    return;
  }
  const target = e.target as Node | null;
  if (target && (sourceHelpPop.contains(target) || sourceHelpBtn.contains(target))) {
    return;
  }
  setHelpOpen(false);
});

/* ==================== 统一刷新（轮询与操作后共用；各渲染层自带 diff 防闪烁） ==================== */

/**
 * 上一轮里**没刷新成功**的步骤名（供 `renderCloudBanner` 说出去）。
 * ★ 它是"静默少刷新一块"的唯一出口 —— 没有它，这类故障在界面上完全看不出来。
 */
let lastRefreshFailures: string[] = [];

/**
 * ★★★ 2026-10-14：**每一步都必须被隔离** —— 这是"两端数据不同步"那次事故的结构性修复。
 *
 * ## 缺陷形态（实测，不是推测）
 *
 * 改前这里是一条**裸串行链**：`await loadCloudState()` → `loadBoxes()` →
 * `loadBrowserAccounts()` → `loadSites()` → …，任何一步抛异常，`refreshAll()`
 * 整体 reject，**排在它后面的步骤一次都不会跑**。
 *
 * 实测代价：`par.boxes` 的载荷形状改动之后，"**新页面 + 旧 Service Worker**"
 * 这种版本错配（只刷新了页面、没在 `chrome://extensions` 点「重新加载」）
 * 让 `loadBoxes()` 抛了一次 ⇒ **`loadBrowserAccounts()` 从此永不执行** ⇒
 * 界面永远停在账号的旧副本上（用户报的正是"账号/盒子/站点数据不同步"），
 * 而**没有任何一处报错**：轮询照跑、盒子照拉、界面照渲染。
 *
 * ## 口径
 *
 * **一个子系统的故障不许饿死其它子系统。** 每一步独立 `try/catch` + 留痕，
 * 失败清单交给 `renderCloudBanner()` 说出来 —— 这类"少刷新了一块"是用户最难归因的形态。
 *
 * ★ 顺序仍然刻意固定：`cloud.state` 在最前（下面各层的文案按它分叉）、
 *   盒子在账号之前（账号卡片要显示盒名，先拿到默认盒名才不会首绘成回退名）。
 */
async function refreshAll(): Promise<void> {
  const failures: string[] = [];
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      failures.push(name);
      log.warn('refreshAll：%s 这一步失败，其余步骤继续 → %s', name, (e as Error)?.message ?? String(e));
    }
  };

  // 数据源在最前：下面各层的文案/错误提示都要按它分叉
  await step('cloud.state', loadCloudState);
  await step('authBar', renderAuthBar);
  // 先取盒子配置（含默认盒显示名），再渲染账号列表，避免首绘用回退名
  await step('盒子', loadBoxes);
  await step('账号', loadBrowserAccounts);   // ★ 这一步必须**无论如何**都跑到
  await step('站点', loadSites);
  await step('盒子芯片', renderBoxChips);
  await step('盒子台账', renderBoxLedger);
  await step('盒子站点下拉', fillBoxSiteOptions);
  await step('站点下拉', fillSiteOptions);
  await step('盒子下拉', fillBoxOptions);
  await step('批量条', syncBatchBar);
  lastRefreshFailures = failures;
  await step('横幅', renderCloudBanner);
}

/* ==================== 诊断包导出（v3.12.2：一键取证） ==================== */

exportDiagBtn.addEventListener('click', () => {
  void (async () => {
    const [diagRes, forensicsData] = await Promise.all([
      chrome.runtime.sendMessage({ kind: 'ql.diag' }).catch(() => null),
      chrome.storage.local.get(LOCAL_KEYS.forensics).then((s) => s[LOCAL_KEYS.forensics] ?? []).catch(() => []),
    ]);
    const bundle = {
      exportedAt: new Date().toISOString(),
      version: EXT_VERSION,
      // 账号信息脱敏：不含密码/用户名原文，只含结构与状态
      accounts: browserAccounts.map((a) => ({
        id: a.id,
        tabName: a.tabName,
        siteHost: a.siteHost,
        box: boxOf(a),
        hasPassword: a.password,
        tabIds: a.tabIds,
        hasToken: a.hasToken,
        enforcementOff: a.enforcementOff ?? false,
      })),
      boxes,
      rulesState: (diagRes as { result?: { data?: { tabRules?: unknown; parallel?: unknown } } } | null)?.result?.data ?? null,
      // ★ `diagLog` 是 `parallel-session.ts` 的**人读文本**埋点（`ql:diag`，环形 60）。
      diagLog: (await chrome.storage.local.get('ql:diag').then((s) => s['ql:diag'] ?? []).catch(() => [])) as string[],
      forensics: forensicsData,
      // ★ 2026-10-09 补：`shared/log.ts` 的**带级别文本轨迹**（`ql.diag` handler 用
      //   `drain()` 取出来带回来的）。
      //
      //   三者的分工是**刻意**的，不要合并：
      //     | 字段 | 是什么 | 回答的问题 |
      //     |---|---|---|
      //     | `appLogs` | 带级别的文本轨迹（`ql:xxx` 命名空间 + 已打码） | "按什么顺序、在哪一层退出的" |
      //     | `diagLog` | 人读的一行行文本埋点 | "这一步走到了吗" |
      //     | `forensics` | **结构化事件**（可按字段过滤） | "发生了什么、带什么参数" |
      //
      //   ⚠️ `appLogs` 是 SW **内存**里的东西（`log.ts` 的约束 2：不落盘）。
      //      SW 被终止后它就没了吗 —— MV3 的 SW 约 30 秒空闲即回收，
      //      所以**导出前请先复现一次问题**，否则拿到的是空数组。
      //      这也是它必须进诊断包的原因：晚一步就永远看不到了。
      appLogs: (diagRes as { result?: { data?: { logs?: unknown[]; logLevel?: string } } } | null)
        ?.result?.data?.logs ?? [],
      logLevel: (diagRes as { result?: { data?: { logLevel?: string } } } | null)?.result?.data?.logLevel ?? null,
    };
    const text = JSON.stringify(bundle, null, 2);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 剪贴板不可用（无焦点等）：仍会下载文件
    }
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `akso-pass-diag-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    exportDiagBtn.textContent = '已导出 ✓';
    setTimeout(() => {
      exportDiagBtn.textContent = '导出诊断';
    }, 2000);
  })();
});

/* ==================== 常用页面书签（v3.16：Alt+1 轮盘的数据源） ====================
 * ★ 刻意**不进 3 秒轮询**：这是用户正在编辑的输入框，轮询回写会把正在敲的内容冲掉。
 *   只在启动时装载一次 + 保存后回填。
 */

function parseFavoriteLines(text: string): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    // 分隔符：英文逗号 / 中文逗号 / 制表符（与批量导入的口径一致）
    const m = /^(.+?)\s*[,，\t]\s*(.+)$/.exec(line);
    if (!m) {
      continue; // 没有分隔符的行直接跳过（不猜「整行是名称还是路径」）
    }
    const name = m[1].trim();
    const path = m[2].trim();
    if (name && path) {
      out.push({ name, path });
    }
  }
  return out;
}

function renderFavoriteLines(items: Array<{ name: string; path: string }>): void {
  favText.value = items.map((f) => `${f.name}, ${f.path}`).join('\n');
}

async function loadFavoritesEditor(): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.favorites).catch(() => ({}) as Record<string, unknown>);
  const raw = stored[LOCAL_KEYS.favorites];
  const items = Array.isArray(raw)
    ? (raw as Array<{ name?: unknown; path?: unknown }>)
        .map((x) => ({ name: String(x?.name ?? '').trim(), path: String(x?.path ?? '').trim() }))
        .filter((x) => x.name && x.path)
    : [];
  renderFavoriteLines(items.length ? items : DEFAULT_FAVORITES.map((d) => ({ ...d })));
}

function flashFavTip(text: string): void {
  favTip.textContent = text;
  setTimeout(() => {
    favTip.textContent = '';
  }, 1800);
}

favSave.addEventListener('click', () => {
  void (async () => {
    const items = parseFavoriteLines(favText.value);
    if (!items.length) {
      alert('没有解析出任何条目。每行格式：名称,路径');
      return;
    }
    await chrome.storage.local.set({ [LOCAL_KEYS.favorites]: items });
    renderFavoriteLines(items);
    flashFavTip(`已保存 ${items.length} 条 ✓`);
  })();
});

favReset.addEventListener('click', () => {
  void (async () => {
    await chrome.storage.local.remove(LOCAL_KEYS.favorites);
    await loadFavoritesEditor();
    flashFavTip('已恢复默认 ✓');
  })();
});

/* ==================== 启动装载 ==================== */

// 顺序：账号（含统计/卡片）→ 站点 → 盒子 → 下拉填充
void refreshAll();
// 帮助气泡里的「反悔通道」按标志决定是否出现（勾过「不再提示」才有那一行）
// 常用页面书签编辑器：只装载一次（编辑器不能进轮询，否则会冲掉正在输入的内容）
void loadFavoritesEditor();

// 轻量轮询：绑定/在线状态/计数可能被后台事件改变（标签关闭、token 捕获）；
// 各渲染函数自带 diff 守卫，数据未变化时不重建 DOM（消除 3s 轮询闪烁）
setInterval(() => void refreshAll(), 3000);

/* ★★★ 2026-10-14：**回到前台立刻同步一次**。
 *
 * ## 为什么必需（用户报的"登录后两端不能及时同步"的主要来源）
 *
 * 上面那个 3 秒轮询在**后台标签页**里会被 Chrome **节流到约一分钟一次** ——
 * 实测证据：服务端访问日志里，扩展的 `GET /api/boxes` 正是**每 60 秒一条**
 * （而它号称是 3 秒轮询）。⇒ 用户从别的标签切回来时，看到的可能是
 * **最长一分钟前**的数据；若此前网络抖过，还会继续显示只读副本。
 *
 * ## 为什么连 diff 缓存一起清
 *
 * 各渲染层按 `lastListKey` / `lastSitesKey` / `lastChipsKey` / `lastLedgerKey`
 * 判断"数据没变就不重建 DOM"。切回前台时这几个 key 可能仍是上一轮的值，
 * 于是**即使数据已经变了也不会重画** ⇒ 清了它们，下一轮必定真重画一次。
 */
function refreshOnForeground(): void {
  if (document.visibilityState !== 'visible') {
    return;
  }
  lastListKey = '';
  lastSitesKey = '';
  lastChipsKey = '';
  lastBoxOptions = '';
  lastLedgerKey = '';
  void refreshAll();
}
document.addEventListener('visibilitychange', refreshOnForeground);
window.addEventListener('focus', refreshOnForeground);
