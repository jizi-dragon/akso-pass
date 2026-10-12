import type { ParallelAccount, ParallelAccountStatus } from '../../shared/types';
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
const batchToggle = document.getElementById('batch-toggle') as HTMLButtonElement;
const batchBar = document.getElementById('batch-bar') as HTMLDivElement;
const selCount = document.getElementById('sel-count') as HTMLElement;
const selClear = document.getElementById('sel-clear') as HTMLButtonElement;
const selMove = document.getElementById('sel-move') as HTMLButtonElement;
const selDelete = document.getElementById('sel-delete') as HTMLButtonElement;

const siteForm = document.getElementById('site-form') as HTMLFormElement;
const sHost = document.getElementById('s-host') as HTMLInputElement;
const sName = document.getElementById('s-name') as HTMLInputElement;
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
const cloudBannerEl = document.getElementById('cloud-banner') as HTMLDivElement;
const parHintEl = document.getElementById('par-hint') as HTMLParagraphElement;

/* ---- 数据源帮助气泡 / 云端登录态 / 登录过期条（v3.14.1） ---- */
const sourceHelpBtn = document.getElementById('cloud-help') as HTMLButtonElement;
const sourceHelpPop = document.getElementById('cloud-help-pop') as HTMLDivElement;
const cloudAccountEl = document.getElementById('cloud-account') as HTMLSpanElement;
const cloudMenuEl = document.getElementById('cloud-account-menu') as HTMLDivElement;
const cloudMenuSync = document.getElementById('cloud-menu-sync') as HTMLButtonElement;
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
let grantedHosts: string[] = [];
let blockedHosts: string[] = [];
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
    return { cls: 'login_failed', text: '未授权 · 已暂停' };
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

    const newTabBtn = document.createElement('button');
    newTabBtn.className = 'btn-ghost';
    newTabBtn.textContent = '新标签页';
    newTabBtn.addEventListener('click', () => void openAccount(a.id, true));

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-ghost';
    renameBtn.textContent = '改页签名';
    renameBtn.addEventListener('click', () => {
      const next = prompt('新的页签名（该账号标签页的标题）', a.tabName || a.username);
      if (next === null) {
        return;
      }
      void (async () => {
        await send({ kind: 'par.update', id: a.id, patch: { tabName: next.trim() || a.username } });
        await refreshAll();
      })();
    });

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

    actions.append(openBtn, newTabBtn, renameBtn, moveBtn, del);
    li.append(head, actions);
    browserListEl.appendChild(li);
  }
}

/* ==================== 盒子 ==================== */

let disabledBoxes: string[] = [];

async function loadBoxes(): Promise<void> {
  const stored = await chrome.storage.local.get([LOCAL_KEYS.boxList, LOCAL_KEYS.defaultBox, LOCAL_KEYS.disabledBoxes]);
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
 * 用**云端的**盒子名单剪掉本地记住的多余项。
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
 */
async function reconcileBoxesWithCloud(): Promise<void> {
  // ★ 类型来自 `shared/messages.ts`（本仓规则：协议单一定义，调用点不就地 cast）。
  const res = await send({ kind: 'par.boxes' }).catch(() => null);
  const truth = res && res.kind === 'par.boxes' && res.result.ok ? res.result.data : null;

  // ★★ 对账的**规则**在 `shared/box-reconcile.ts`（纯函数）—— 这里只负责
  //   "取云端名单 + 写回 storage"。抽出去的理由是那三条约束里有两条是**反方向**的
  //   （离线不许剪、账号在用的不许剪），而它们跑起来要云端授权 ⇒ 不抽出来就
  //   永远验不到（本脚本的第一版正是因此只能 SKIP）。
  //   ★ 云端没答复时 `cloudNames` 传空数组，纯函数会**原样返回**。
  const out = reconcileBoxes({
    remembered: boxes.filter((b) => b !== defaultBox),
    fromAccounts: browserAccounts.map((a) => boxOf(a)),
    cloudNames: truth?.names ?? [],
    defaultBox,
  });
  if (!out.changed) return;

  boxes = out.boxes;
  setStat('stat-boxes', boxes.length);
  // ★ 只把"记住的"那一份写回：默认盒由 `ql:defaultBox` 表达，
  //   账号在用的名字由账号数据自己表达 —— 别让它们互相污染。
  const used = new Set(browserAccounts.map((a) => boxOf(a)));
  await chrome.storage.local.set({
    [LOCAL_KEYS.boxList]: boxes.filter((b) => b !== defaultBox && !used.has(b)),
  });
}

async function saveBoxes(): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.boxList]: boxes.filter((b) => b !== defaultBox) });
}

async function saveDisabled(): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_KEYS.disabledBoxes]: disabledBoxes });
}

/** 盒子禁用态：手动禁用名单命中，或空默认盒自动禁用（轮盘不出现） */
function isBoxDisabled(name: string): boolean {
  return disabledBoxes.includes(name) || (name === defaultBox && !browserAccounts.some((a) => boxOf(a) === name));
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
    const rename = document.createElement('span');
    rename.className = 'chip-act';
    rename.textContent = '✎';
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      void renameBoxFlow(name);
    });
    const toggle = document.createElement('span');
    toggle.className = 'chip-act';
    toggle.textContent = off ? '▶' : '⏸';
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggleBoxFlow(name);
    });
    if (name === defaultBox) {
      rename.title = '修改默认盒子名称（未归盒账号的归宿）';
      chip.title = off
        ? '默认盒子：当前为空，已自动禁用（轮盘不显示）'
        : '默认盒子：未归盒账号的归宿，可重命名，不可删除';
      chip.append(rename, toggle);
      toggle.title = off ? '默认盒为空时自动禁用' : '默认盒为空时自动禁用（当前有账号）';
      if (off) {
        toggle.style.display = 'none';
      }
    } else {
      rename.title = '重命名盒子（盒内账号随迁）';
      toggle.title = off ? '启用盒子（恢复轮盘切换）' : '禁用盒子（轮盘跳过切换）';
      const remove = document.createElement('span');
      remove.className = 'chip-act chip-act-del';
      remove.textContent = '✕';
      remove.title = '删除盒子（可选：盒内账号一并删除或归入默认盒子）';
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        void removeBoxFlow(name);
      });
      chip.append(rename, toggle, remove);
    }
    chip.addEventListener('click', () => {
      currentBox = name;
      lastListKey = '';
      renderBoxChips();
      renderBrowserAccounts();
    });
    boxChipsEl.append(chip);
  }

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'chip chip-add';
  add.textContent = '＋ 新建盒子';
  add.addEventListener('click', () => void createBox());
  boxChipsEl.append(add);
}

async function createBox(): Promise<void> {
  const name = prompt('新盒子名称（账号按盒子收纳，轮盘按盒子翻页）', '');
  const trimmed = name?.trim();
  if (!trimmed) {
    return;
  }
  if (boxes.includes(trimmed)) {
    alert(`盒子「${trimmed}」已存在。`);
    return;
  }
  boxes.push(trimmed);
  await saveBoxes();
  lastChipsKey = '';
  lastBoxOptions = '';
  renderBoxChips();
  fillBoxOptions();
}

/** 盒子重命名：普通盒 = 账号随迁（目标名已存在则并入）；默认盒 = 仅改显示名（未归盒账号语义不变） */
/** 禁用/启用盒子：禁用后轮盘跳过该盒（盒内账号不受影响，管理页照常可用） */
async function toggleBoxFlow(name: string): Promise<void> {
  if (name === defaultBox) {
    return; // 默认盒只随「是否为空」自动禁用
  }
  if (disabledBoxes.includes(name)) {
    disabledBoxes = disabledBoxes.filter((b) => b !== name);
  } else {
    disabledBoxes.push(name);
  }
  await saveDisabled();
  lastChipsKey = '';
  lastListKey = '';
  await refreshAll();
}

async function renameBoxFlow(from: string): Promise<void> {
  const isDefault = from === defaultBox;
  const input = prompt(
    isDefault
      ? `修改默认盒子名称（当前「${from}」）。未归盒账号将显示在新名称下。`
      : `重命名盒子「${from}」（盒内账号随迁）`,
    from,
  );
  const to = input?.trim();
  if (!to || to === from) {
    return;
  }
  if (isDefault) {
    if (boxes.includes(to)) {
      alert(`盒子「${to}」已存在，默认盒子不能与其它盒子重名。`);
      return;
    }
    defaultBox = to;
    await chrome.storage.local.set({ [LOCAL_KEYS.defaultBox]: to });
    boxes = boxes.map((b) => (b === from ? to : b));
    disabledBoxes = disabledBoxes.map((b) => (b === from ? to : b));
    await saveDisabled();
    if (currentBox === from) {
      currentBox = to;
    }
    lastChipsKey = '';
    lastBoxOptions = '';
    lastListKey = '';
    await refreshAll();
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
  boxes = [...new Set(boxes.map((b) => (b === from ? to : b)))];
  disabledBoxes = disabledBoxes.map((b) => (b === from ? to : b));
  await saveBoxes();
  await saveDisabled();
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
        (hosts.length && !granted ? `\n注意：站点授权未完成，账号将显示「未授权·已暂停」——请在「添加授权」中补授站点。` : ''),
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
  if (!confirm(`删除选中的 ${selectedIds.size} 个账号？将同时关闭它们的所有并行标签页。`)) {
    return;
  }
  void (async () => {
    for (const id of selectedIds) {
      await send({ kind: 'par.delete', id });
    }
    selectedIds.clear();
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
      alert('请先在「站点管理」添加并授权站点。');
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

async function ensureHostPermission(host: string): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: [`*://${host}/*`] });
  } catch {
    // 无手势上下文等场景
    return false;
  }
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
  if (!(await ensureHostPermission(account.siteHost))) {
    alert(`需要授权访问 ${account.siteHost} 才能改写其请求头。`);
    return;
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
    alert('请先在「站点管理」添加并授权站点，站点下拉才会有可选项。');
    return;
  }
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
 * ★★ v4.2.4：**这个 host 是不是"云端服务自己"** —— 是的话它不属于"站点管理"。
 *
 * ## 缺陷形态（用户 2026-10-12 实测，原话"我认为这是很滑稽的事"）
 *
 * `grantedHosts` 是直接映射浏览器权限清单来的，而扩展为了**访问云端 API** 申请过
 * 云端服务那条 origin（见 `parallel.ts` 里的 `CLOUD_ORIGIN_PATTERN`，设备流授权那一步）。
 * ★ 这里刻意不把那串 origin 的字面量写出来 —— 它的结尾正是注释结束标记，
 *   会让本段注释提前结束、进而破坏整个文件（我在这上面栽过七次，见 PITFALLS #43）。
 * ⇒ **云端自己的域名进了"站点管理"**，成了一张：
 *   · 没有并行账号（它不是平台，没有账号可加）
 *   · 又删不掉（那是扩展**必须**保留的权限 —— Chrome 拒绝回收、
 *     就算回收了扩展也就登不上云端账号库了）
 * 的卡片。
 * ★ 它还会出现在「添加账号」的站点下拉里 —— 那是更实际的问题：用户可能真的
 *   把某个平台账号**建到云端域名上**，而那永远不会工作。
 *
 * ⇒ 判据：**与云端服务同源**的 host 一律不算"并行账号的站点"。
 *   比对**host**（而不是整串 origin）⇒ 无论云端是 http 还是 https、带不带端口都能对上。
 *
 * ★★ 依赖顺序：它读 `cloudBaseUrl`，而那个值由 `loadCloudState()` 填。
 *   `refreshAll()` 里 `loadCloudState()` **排在 `loadSites()` 之前** ——
 *   这个顺序是**功能前提**，不是风格：调换之后 `cloudBaseUrl` 还是空串，
 *   `isCloudHost` 一律返回 false ⇒ **过滤静默失效**，云端域名又回到列表里。
 *   判据：`tmp/verify-twotier.mjs` 的 A/B 组会断言云端 host 不出现在站点卡片与下拉里。
 */
function isCloudHost(host: string): boolean {
  if (!cloudBaseUrl) {
    return false; // 还没拿到云端地址（未登录/离线）⇒ 什么都不排除
  }
  try {
    return new URL(cloudBaseUrl).host.toLowerCase() === host.trim().toLowerCase();
  } catch {
    return false; // baseUrl 形状异常时**不排除**（宁可多显示一行，也不要漏掉真实站点）
  }
}

/** 统计某 host 下已有的并行账号数（支持 *.example.com 通配模式粗匹配） */
function countAccountsFor(displayHost: string): number {
  const bare = displayHost.replace(/^\*\./, '');
  return browserAccounts.filter((a) => a.siteHost === displayHost || a.siteHost.endsWith(`.${bare}`)).length;
}

async function loadSites(): Promise<void> {
  const all = await chrome.permissions.getAll();
  const blockedStored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  const blocked = new Set<string>((blockedStored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);

  grantedHosts = Array.from(
    new Set(
      (all.origins ?? [])
        .map(originToHost)
        // ★ v4.2.4：**云端服务自己的域名不算并行账号的站点**（见 `isCloudHost`）——
        //   它是扩展为了访问云端 API 才申请的权限，永远删不掉也不该删。
        .filter((h): h is string => h !== null && !isCloudHost(h)),
    ),
  ).sort();

  // 名单自愈：浏览器层已无授权的停用条目直接移除
  //   ★ 比对用**排序后的内容**而不是 `Set.size`：一减一增时 size 不变，
  //     而名单其实已经变了（size 比较会漏掉这种情形，且漏得毫无痕迹）。
  const storedList = Array.from(blocked).sort();
  for (const b of Array.from(blocked)) {
    const still = await chrome.permissions.contains({ origins: [`*://${b}/*`] }).catch(() => false);
    if (!still) {
      blocked.delete(b);
    }
  }
  blockedHosts = Array.from(blocked).sort();
  // ★★ 2026-10-12 修：**只在自愈真的改变了名单时才写盘**。
  //
  //   本函数由 `refreshAll()` 调用，而 `refreshAll` 挂在 `setInterval(…, 3000)` 上
  //   ⇒ 原来这里**每 3 秒无条件写一次 `chrome.storage.local`**，稳态下就是
  //     "一直写同一个值"的磁盘写放大（用户不开任何界面时也在写）。
  //   ★ 判据：稳态（浏览器权限无变化）下 `ql:blockedHosts` 的写入次数应为 **0**。
  //   ★ 为什么可以安全跳过：`blockedHosts` 这个内存副本**总是**被赋成最新值（上一行），
  //     渲染与后续逻辑读的都是它；storage 只是给冷启/别的页面用的持久副本。
  if (JSON.stringify(storedList) !== JSON.stringify(blockedHosts)) {
    await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: blockedHosts });
  }

  // 站点名从云端拉；拿不到（离线）时 `siteNames` 为 null，渲染回落成显示域名
  await refreshSiteNames();

  // ★ v4.2.3：用户主动隐藏的 host（与 blockedHosts 是**两件事**，见 LOCAL_KEYS 注释）
  const hiddenStored = await chrome.storage.local.get(LOCAL_KEYS.hiddenHosts);
  const hiddenHosts = (hiddenStored[LOCAL_KEYS.hiddenHosts] as string[] | undefined) ?? [];

  // ★ v4.2.4：`referenced` 也是渲染输入（云端站点记录 + 账号引用的 host）——
  //   不进 key 的话"账号引用了新站点"不会让站点管理重新渲染（那正是这条路径的入口）。
  const sitesKey = JSON.stringify([
    grantedHosts,
    blockedHosts,
    hiddenHosts,
    browserAccounts.map((a) => [a.id, a.tabName, a.box ?? '']),
    // ★ 名字也要进 key：它是渲染输入的一部分，不进 key 的话"改了名字但 hosts 没变"
    //   就**不会重渲染**（表现是"点了保存没反应"，而数据其实已经改好了）。
    siteNames,
  ]);
  if (sitesKey !== lastSitesKey) {
    lastSitesKey = sitesKey;
    renderSites(grantedHosts, blockedHosts, hiddenHosts);
    /* ★★ v4.2.2 修：**改名后"添加账号"的站点下拉必须跟着更新**。
     *
     * 缺陷形态（实测抓到，30/32）：改完名字后站点卡片更新了，而 `#p-host` 的选项
     * **仍然显示旧名字**。根因是两份缓存的**失效时机不一致**：
     *   · `renderSites` 靠 `lastSitesKey`，上面刚把它算进去了 ⇒ 会重渲染 ✅
     *   · `fillSiteOptions` 靠 `lastHostOptions`，而它的 key 是在**上一次**调用时
     *     用**旧**的 `siteNames` 算出来的 ⇒ 这次比对发现"没变化" ⇒ **不重建** ❌
     *
     * ⇒ 既然 `siteNames` 变了（走到了这一支），就顺手让下拉的缓存失效。
     *   放在这里而不是散在各调用点：**任何**让 `siteNames` 变化的路径都会经过这一支。
     */
    lastHostOptions = '';
  }
}

/** 站点名映射：host → { 用户设的名, **显示名** }。
 *
 * ★ 显示名由 background 算好（`name 与 host 不同才算用户起过名`，否则从地址推导），
 *   UI 不再自己推导 —— 否则"推导规则"会有两份，改一处另一处静默不变。
 */
let siteNames: Record<string, { name: string; displayName: string }> | null = null;

async function refreshSiteNames(): Promise<boolean> {
  try {
    const res = await send({ kind: 'par.sites' });
    if (res.kind === 'par.sites' && res.result.ok) {
      const rows = res.result.data;
      siteNames = rows
        ? Object.fromEntries(
            rows
              // ★ v4.2.4：云端自己那条站点记录也过滤掉 —— 否则"缺授权"判定会
              //   因为云端 host 有权限而算错，且它的名字会泄漏到站点下拉里
              .filter((r) => !isCloudHost(r.host))
              .map((r) => [r.host, { name: r.name, displayName: r.displayName }]),
          )
        : null;
      return siteNames !== null;
    }
  } catch {
    // 消息层失败按"没拿到"处理（与离线同一条路）
  }
  siteNames = null;
  return false;
}

/** 站点在某一行上显示的主标题与副标题 */
function siteTitleOf(host: string): { title: string; sub: string | null } {
  const hit = siteNames?.[host];
  const title = hit?.displayName?.trim() || host;
  // 副标题放**完整地址**：显示名是别名，地址才是账号绑定的身份键，必须能核对
  return { title, sub: title === host ? null : host };
}

function renderSites(hosts: string[], blocked: string[] = [], hidden: string[] = []): void {
  const hiddenSet = new Set(hidden);
  siteListEl.innerHTML = '';

  /* ★★ v4.2.4 修（**这条让"一键授权"从死代码变成可达**）：
   *
   * 原来只遍历 `[...hosts, ...blocked]` —— 而"**缺授权**"的站点
   * **两个都不在**（`hosts` 只收有浏览器授权的、`blocked` 只收被停用的）。
   * ⇒ `needsGrant` 那一态**永远到不了**，上一版加的「授权」按钮是**死代码**。
   *
   * 触发场景正是用户描述的那个：**从云端同步下来的账号引用了某个站点，
   * 而那个站点从没在本机授权过**（用户原话："当从云端同步账号时，站点并不会直接
   * 同步过来，但是账号数据中存储得有站点数据"）。
   * ⇒ 那些站点必须**出现在列表里**并带一个能授权的按钮 —— 否则用户看着
   *   "账号列表里有这个站点的账号，站点管理里却没有它"，无从下手。
   *
   * ⇒ 数据源补齐为三个：有授权的 + 被停用的 + **有云端站点记录或本地账号引用的**。
   */
  const referenced = new Set<string>(
    [
      ...Object.keys(siteNames ?? {}),
      ...browserAccounts.map((a) => a.siteHost).filter(Boolean),
    ].filter((h) => !isCloudHost(h)),
  );
  const allHosts = [...new Set([...hosts, ...blocked, ...referenced])];

  // ★ v4.2.3：隐藏的行要一起算进"有没有东西可显示" —— 否则全部隐藏之后
  //   页面会是一片**空白**（连"尚无授权站点"的提示都没有），用户只会以为界面坏了。
  // ★ v4.2.4：这里必须用**补齐后的** `allHosts`（原来只看 `[...hosts, ...blocked]`，
  //   于是"只有云端记录 / 只有账号引用"的站点会被判成空态，而实际有东西可显示）。
  const visible = allHosts.filter((h) => !hiddenSet.has(h));
  if (!visible.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    const ico = document.createElement('div');
    ico.className = 'empty-ico';
    ico.textContent = '🛡️';
    const tip = document.createElement('div');
    tip.textContent = '尚无授权站点。用上方表单输入站点地址，点「添加并授权」即可。';
    li.append(ico, tip);
    siteListEl.appendChild(li);
    return;
  }

  // ★ 补齐后的数据源已在函数开头算好（`allHosts`）—— 这里只负责遍历与渲染。
  const seen = new Set<string>();
  for (const host of allHosts) {
    if (seen.has(host)) {
      continue;
    }
    seen.add(host);
    // ★ v4.2.3：用户主动隐藏的行直接跳过（它本来就没有授权、也没有规则动作）
    if (hiddenSet.has(host)) {
      continue;
    }
    /* ★★ v4.2.3：把"不生效"的**两种原因分开**（用户 2026-10-12 报"卡片显示未授权
     * 已暂停，但浏览器其实已授权"）。原来是合成一句 `isBlocked`，于是：
     *   · 用户在浏览器里授权了 → 卡片仍可能说"未授权"（进过停用名单，或缓存没失效）
     *   · 用户看不出**该点哪个按钮**才能好
     * ⇒ 现在拆成互斥状态，各自给一个能解决问题的动作：
     *   `paused`     —— 进过停用名单（手动删除过 / Chrome 拒收过）⇒ 动作「恢复使用」
     *   `needsGrant` —— 不在停用名单，但浏览器层就是没授权 ⇒ 动作「授权」
     *   正常         —— 什么都不显示，动作是「更改名称 / 删除」
     */
    const inBlockedList = blocked.includes(host);
    const hasGrant = hosts.includes(host);
    const paused = inBlockedList;
    const needsGrant = !inBlockedList && !hasGrant;
    const isBlocked = paused || needsGrant;
    const n = countAccountsFor(host);
    // ★ 卡片里名称与域名各占一行 ⇒ 这里只要名称（`siteTitleOf` 的 `sub` 已不再需要）
    const { title } = siteTitleOf(host);

    const li = document.createElement('li');
    // ★★ v4.2.1 第五轮（要求 ④）：从"一行"改成**卡片**。
    //   用户原话：「站点数据也以卡片形式展示，让用户能够直观的看到站点名称、站点域名、
    //   站点下拥有的账号数量」。⇒ 三件事各占一个明确的视觉位置：
    //     ① 站点名称（主标题，最大字重）
    //     ② 站点域名（副标题，**始终显示** —— 它是账号绑定的身份键）
    //     ③ **账号数量**（单独一块，不是混在说明句子里）
    li.className = 'site-card';
    if (isBlocked) {
      li.classList.add('is-blocked');
    }

    // ① 名称（+ 状态标记）—— ★ 徽标必须区分原因，否则用户不知道该点哪个按钮
    const head = document.createElement('div');
    head.className = 'site-card-head';
    const alias = document.createElement('div');
    alias.className = 'site-card-name';
    alias.textContent = title;
    alias.title = host; // 悬停能看到真实身份键
    head.appendChild(alias);
    if (isBlocked) {
      const off = document.createElement('span');
      off.className = 'site-card-off';
      off.textContent = paused ? '已停用' : '缺授权';
      off.title = paused
        ? '这个站点在 Akso Pass 里被停用过（改头规则不对它生效）⇒ 点右侧「恢复使用」'
        : '浏览器还没有给这个站点授权 ⇒ 点右侧「授权」，然后在弹出的窗里点允许';
      head.appendChild(off);
    }

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
    // ★ 措辞要指名**原因**：原来一律写"改头已暂停"，而"缺授权"其实是"从未生效"
    unit.textContent = paused ? '个账号 · 已停用' : needsGrant ? '个账号 · 待授权' : '个账号';
    count.append(num, unit);
    if (isBlocked) {
      count.classList.add('muted');
    }

    const actions = document.createElement('div');
    actions.className = 'site-actions';

    /* ★★ v4.2.3：**"缺授权"时给一个真正能授权的按钮**。
     *
     * 用户报的循环依赖：站点没账号 ⇒ 站点管理里看不到能点的授权入口 ⇒
     * 只能等"快捷登录"时 Chrome 自己弹窗。而一旦那次弹窗被忽略/被拒，
     * 就**再也回不到授权**了（卡片只说"未授权"，不给入口）。
     *
     * ★ 这里仍然在**用户手势里最先发起** `permissions.request`（AGENTS §2）——
     *   它排在 `unblockHost` 之前，因为后者是异步的，会把手势耗掉。
     */
    if (needsGrant) {
      const grantBtn = document.createElement('button');
      grantBtn.className = 'btn-primary btn-sm';
      grantBtn.type = 'button';
      grantBtn.textContent = '授权';
      grantBtn.title = `让浏览器把 ${host} 授权给本扩展（改头规则与隔离才会对它生效）`;
      grantBtn.addEventListener('click', () => {
        // ★ 授权请求必须**第一件事**就发（晚一步手势失效）
        void chrome.permissions
          .request({ origins: [patternOfHost(host)] })
          .then(async (okc) => {
            if (!okc) {
              alert(`未完成授权：${host}\n\n（在弹出的窗里点「允许」才会生效）`);
              return;
            }
            await send({ kind: 'par.grantChanged' });
            await refreshAll();
          });
      });
      actions.appendChild(grantBtn);
    }

    if (!isBlocked) {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'btn-ghost btn-sm';
      renameBtn.type = 'button';
      // ★★ v4.2.1 修（用户报"站点的名称无法更改，出现报错"）：
      //   站点的名字存在**云端**。只在浏览器里授权过、而云端没有这条站点记录的
      //   （例如 127.0.0.1、没有并行账号的 www.dragonrain.top），
      //   改名必然以"云端找不到站点"失败 —— 而按钮照样显示 ⇒ 用户看到的就是**报错**。
      //   ⇒ 云端**没有**这条记录时按钮改成「添加到云端」，走的正是 par.upsertSite
      //     （它容忍不存在：先建再写名）。**让按钮的承诺与它能做到的事一致。**
      const inCloud = Boolean(siteNames?.[host]);
      renameBtn.textContent = inCloud ? '更改名称' : '添加到云端';
      renameBtn.title = inCloud
        ? '给这个站点起一个好记的名字（只影响显示，不影响账号绑定的域名）'
        : '云端还没有这个站点。点它把站点与名称存到云端账号库（会先创建）';
      renameBtn.addEventListener('click', () => {
        // 预填**用户设的名**（而不是显示名）—— 显示名可能是从地址推导的，
        // 预填它等于把推导结果写死成"用户起过的名"。
        beginRename(li, actions, host, siteNames?.[host]?.name ?? '', !inCloud);
      });
      actions.appendChild(renameBtn);
    }

    const actionBtn = document.createElement('button');
    /* ★ 三个状态各给一个**说到做到**的按钮（v4.2.3）：
     *   paused     → 「恢复使用」（解除本地停用）
     *   needsGrant → 「不再显示」（★ 不能写"恢复使用" —— 它**没有**被停用，
     *                 点"恢复使用"什么也不会发生，那是我第一版留下的错）
     *   正常       → 「删除」（撤销授权 + 停用）
     */
    if (needsGrant) {
      actionBtn.className = 'btn-ghost btn-sm';
      actionBtn.textContent = '不再显示';
      actionBtn.title = '只是把这一行从列表里去掉（它本来就没有浏览器授权，改头规则从未对它生效）';
      actionBtn.addEventListener('click', () => {
        if (!confirm(`把「${title}」从站点列表里去掉？\n\n`
          + '· 它本来就没有浏览器授权，所以不会有任何权限变化\n'
          + '· 云端账号库里的记录不受影响（重新授权后它会再出现）')) {
          return;
        }
        void hideHost(host);
      });
      actions.appendChild(actionBtn);
      li.append(head, domain, count, actions);
      siteListEl.appendChild(li);
      continue;
    }

    actionBtn.className = isBlocked ? 'btn-ghost' : 'btn-danger';
    /* ★★ v4.2.4：文案从「删除」改回「**取消授权**」—— 用户 2026-10-12 的反馈原话：
     *   "点击删除后，仅仅是显示取消授权。"
     *   那句"仅仅是"点出了真问题：**按钮承诺了"删除"，做到的却是"取消授权"**，
     *   于是用户期待列表里少一行、而实际只是它变成"已停用"—— 承诺与效果不一致。
     *   ★ 这不是改文案就完了：**它是这个动作唯一诚实的名字**。站点记录在云端，
     *     扩展**删不掉**它（删掉就意味着要动云端数据，而那是另一个动作、有另一个后果）；
     *     扩展能做的只有"撤销浏览器授权 + 本地停用改头"。
     *   ⇒ 按钮说实话，确认框再把"云端不受影响"讲清楚。
     *   ★ 而"我就是不想再看到这一行"这个诉求由「不再显示」（`needsGrant` 分支）承接。
     */
    actionBtn.textContent = isBlocked ? '恢复使用' : '取消授权';
    actionBtn.title = isBlocked
      ? '解除本地停用（改头规则对它重新生效）'
      : `撤销浏览器对 ${host} 的授权，并在 Akso Pass 里停用它的鉴权改写（云端记录不受影响）`;
    actionBtn.addEventListener('click', () => {
      if (isBlocked) {
        void unblockHost(host);
        return;
      }
      if (
        !confirm(
          `删除站点「${title}」？\n\n`
            + `· 将撤销浏览器对 ${host} 的授权，该站点的鉴权改写立即失效\n`
            + '· 云端账号库里的站点与账号**不受影响**（重新授权即可恢复）\n'
            + '· 浏览器内已打开页签的登录态不受影响',
        )
      ) {
        return;
      }
      void revokeHost(host);
    });
    actions.appendChild(actionBtn);

    li.append(head, domain, count, actions);
    siteListEl.appendChild(li);
  }
}

/**
 * 就地编辑站点名（**不用 `window.prompt`**）。
 *
 * ★ 为什么不用 prompt：① 它在扩展页里是浏览器模态框，样式不可控、移动端体验差；
 *   ② **无法用自动化验证**（Playwright 只能靠 dialog 事件间接驱动，写不出可靠判据）——
 *   而"判据不可写"在这个仓里等于"这条路径不会被验"。
 * ★ 交互：Enter 保存 / Esc 取消 / 失焦保存（与"改页签名"的习惯一致）。
 *   空串是**合法输入**，语义 = 恢复显示域名（服务端也有同样的回落口径）。
 */
function beginRename(
  row: HTMLLIElement,
  actions: HTMLDivElement,
  host: string,
  currentName: string,
  createIfMissing = false,
): void {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'site-rename-input';
  // 预填用户设的名；**不要**预填推导名（那会把"从地址截出来的"写死成用户输入）
  input.value = currentName === host ? '' : currentName;
  input.placeholder = '例如 通桥医疗（留空 = 用地址推导）';
  input.maxLength = 120; // 与云端 `SitePatch.name` 的上限一致，别让用户打完才被 422 拒

  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn-primary btn-sm';
  saveBtn.type = 'button';
  saveBtn.textContent = '保存';
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn-ghost btn-sm';
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';

  // ★★ v4.2.1 第五轮：卡片化之后名称那一格是 `.site-card-name`（不再是 `.alias`）。
  //   ★ 这里**必须**保留"取不到就 return"的守卫：这一版的第一次改动我漏改了选择器，
  //     于是 `beginRename` **在点按钮后静默返回** —— 编辑器不出现、也没有任何报错，
  //     看起来就像"按钮点不动"。守卫生效时至少是**不做事**，而不是做一半。
  const alias = row.querySelector('.site-card-name');
  if (!(alias instanceof HTMLElement)) {
    log.warn('beginRename：找不到名称节点（选择器与卡片结构不一致）⇒ 放弃进入编辑态');
    return;
  }
  // 编辑态：名字那格换成输入框；按钮组换成 保存/取消
  alias.replaceWith(input);
  actions.replaceChildren(saveBtn, cancelBtn);
  input.focus();
  input.select();

  let settled = false;
  const restore = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    void loadSites(); // 复用既有入口重渲染（名字没变时它也会把编辑态还原）
  };
  const commit = async (): Promise<void> => {
    if (settled) {
      return;
    }
    settled = true;
    await renameSiteRow(host, input.value, saveBtn, cancelBtn, createIfMissing);
  };

  saveBtn.addEventListener('click', () => void commit());
  cancelBtn.addEventListener('click', restore);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      restore();
    }
  });
  // 失焦保存：但点"取消"也会先触发 blur ⇒ 用 `relatedTarget` 排除按钮自身
  input.addEventListener('blur', (e) => {
    const to = e.relatedTarget;
    if (to === saveBtn || to === cancelBtn) {
      return;
    }
    void commit();
  });
}

/**
 * 改名并落到云端。
 *
 * ★ 成功后**重新拉一次**站点清单再渲染 —— 不本地"猜"结果：服务端对空名有回落口径
 *   （空名 = 恢复成 host），本地猜会把一个服务端并不认的名字显示出来。
 * ★ 失败时**明确报错**并保持原样：静默失败会让用户以为改成功了。
 */
async function renameSiteRow(
  host: string,
  name: string,
  saveBtn: HTMLButtonElement,
  cancelBtn: HTMLButtonElement,
  createIfMissing = false,
): Promise<void> {
  saveBtn.disabled = true;
  cancelBtn.disabled = true;
  saveBtn.textContent = '保存中…';
  try {
    // ★ 云端还没有这条记录时走 `upsertSite`（先建再写名）；否则走 `renameSite`
    //   （找不到就报错 —— 那是对的，用户不该以为给一个不存在的站点改了名）。
    const res = createIfMissing
      ? await send({ kind: 'par.upsertSite', host, name })
      : await send({ kind: 'par.renameSite', host, name });
    const failedKind = createIfMissing ? 'par.upsertSite' : 'par.renameSite';
    if (res.kind === failedKind && !res.result.ok) {
      throw new Error(res.result.error);
    }
    await refreshSiteNames();
    lastSitesKey = ''; // 强制重渲染（名字变了，但 hosts 没变 ⇒ 原 key 不变）
    await loadSites();
  } catch (e) {
    // ★ 报错要给出**下一步**，不能只说"失败了" —— 用户看到的原话是"出现报错"，
    //   而"云端找不到站点"本身不是他能理解的措辞。
    const raw = e instanceof Error ? e.message : String(e);
    const hint = /找不到站点/.test(raw)
      ? '\n\n这个站点在云端账号库里还没有记录。请改用「添加到云端」，或先登录云端账号库。'
      : '';
    alert(`保存站点名称失败：${raw}${hint}`);
    lastSitesKey = ''; // 还原成非编辑态（否则输入框会留在页面上）
    await loadSites();
  }
}

/**
 * 移除某 host 的全部授权（尽力而为）+ 本地停用兜底。
 * Chrome 的 permissions.remove 只能回收「可选授权」，且模式串必须与授予时一致；
 * 若浏览器拒绝（required 权限 / 站点访问模式限制），则把该 host 写入本地停用名单，
 * 后台不再对其安装任何改头规则 —— 效果等价于功能层撤销，且不与 Chrome 的内部状态搏斗。
 */
async function revokeHost(displayHost: string): Promise<void> {
  const all = await chrome.permissions.getAll();
  const raws = (all.origins ?? []).filter((o) => originToHost(o) === displayHost);
  const errors: string[] = [];

  for (const raw of raws) {
    try {
      const okc = await chrome.permissions.remove({ origins: [raw] });
      if (!okc) {
        errors.push(`浏览器拒绝移除：${raw}`);
      }
    } catch (e) {
      errors.push(`${raw} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /* ★★ v4.2.3 修（2026-10-12 用户实测"删除站点时弹框"）：**残留判定不能拿
   * 扩展自己声明的通配项来算**。
   *
   * 缺陷形态：原判据是"host 归属相等 **或** origin 里含通配"，
   * 而那个通配**正是 manifest 里可选 host 权限的声明本身** ——
   * 它会**恒定出现**在 `getAll().origins` 里（`originToHost` 对它是 null，
   * 所以前半永远匹配不上，后半却总是为真）。
   * ⇒ `stillCovers` **恒真** ⇒ **删任何站点都判"未能回收"并弹框**。
   *
   * ⇒ 现在只问一件事：**这个 host 是否仍被某个真实授权覆盖**。
   *   独占的通配项与它的大写别名都跳过 —— 它们不是"这个站点的授权"。
   *   ★ 但"被通配覆盖着"这件事本身要**如实告知**（下面单独判），因为它意味着
   *     删了这个站点，鉴权改写对它**仍然生效**（本仓 isEnforceable 有"更宽泛的
   *     通配授权也算可用"的分支，见 `parallel-session.ts`）。那是另一件事，
   *     不能和"回收失败"混成一句话。
   *   ★★ 本段注释里**不能**写出那两个标记的字面量 —— 这是我第六次踩它，
   *     而这次连累 `tsc` 报了 10 个错（判据本身第一版还漏掉了，见 PITFALLS #43）。
   */
  const allOrigins = (await chrome.permissions.getAll()).origins ?? [];
  const hostOrigins = allOrigins.filter((o) => originToHost(o) === displayHost);
  const broadGrant = allOrigins.find((o) => o === '<all_urls>' || o === '*://*/*');
  const stillCovers = hostOrigins.length > 0;

  const blockedStored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  const blocked = new Set<string>((blockedStored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);

  // ★ 只要"这个 host 的授权没能回收"，就必须进停用名单 —— 无论原因是
  //   Chrome 拒绝（`errors` 非空）还是它压根不在自己的授权里（被通配覆盖着）。
  //   停用名单是**唯一**能让"删掉它"在功能上真正生效的机制（`isEnforceable` 先看它）。
  if (stillCovers || broadGrant) {
    blocked.add(displayHost);
    await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: Array.from(blocked).sort() });
    if (stillCovers) {
      alert(
        `「${displayHost}」的浏览器授权**没能回收**，已在 Akso Pass 中停用（改头规则不再对它生效）。\n\n`
          + `浏览器给出的原因：\n${errors.join('\n') || '(无明细)'}\n\n`
          + `要彻底回收权限，只能手动改：chrome://extensions → 本扩展 → 详情 →`
          + `「网站访问权限」→ 改成「点击扩展程序时」。\n`
          + `★ 这一步只有你能做 —— 代码无法回收用户手动授予的权限。`,
      );
    } else {
      alert(
        `「${displayHost}」已在 Akso Pass 中停用（改头规则不再对它生效）。\n\n`
          + `注意：本扩展当前还持有**宽泛授权**（${broadGrant}），`
          + `所以浏览器层的权限没有、也无法针对单个站点回收。\n`
          + `建议在 chrome://extensions → 本扩展 → 详情 →「网站访问权限」里收窄到具体站点。`,
      );
    }
  } else if (blocked.has(displayHost)) {
    blocked.delete(displayHost);
    await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: Array.from(blocked).sort() });
  }

  await send({ kind: 'par.grantChanged' });
  await refreshAll();
}

/** 恢复此前手动停用的站点（仅解除 Akso Pass 内部封锁） */
async function unblockHost(host: string): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.blockedHosts);
  const blocked = new Set<string>((stored[LOCAL_KEYS.blockedHosts] as string[] | undefined) ?? []);
  blocked.delete(host);
  await chrome.storage.local.set({ [LOCAL_KEYS.blockedHosts]: Array.from(blocked).sort() });
  await send({ kind: 'par.grantChanged' });
  await refreshAll();
}

/**
 * ★ v4.2.3：「不再显示」一个**本来就没有浏览器授权**的站点。
 *
 * ★ 与 `unblockHost` 的分工（两者的语义完全不同，存储键也不同）：
 *   · `unblockHost`  —— 解除"停用"（那是有权限但被我们主动停用）
 *   · `hideHost`     —— 只是不显示（它从没有过权限，没有任何规则动作）
 *   ⇒ **只能动 `hiddenHosts`，绝不能顺手写 `blockedHosts`** ——
 *     那会给一个从未生效的站点留下"已停用"的假状态（见 `LOCAL_KEYS.hiddenHosts` 注释）。
 */
async function hideHost(host: string): Promise<void> {
  const stored = await chrome.storage.local.get(LOCAL_KEYS.hiddenHosts);
  const hidden = new Set<string>((stored[LOCAL_KEYS.hiddenHosts] as string[] | undefined) ?? []);
  hidden.add(host);
  await chrome.storage.local.set({ [LOCAL_KEYS.hiddenHosts]: Array.from(hidden).sort() });
  lastSitesKey = ''; // 强制重渲染（hosts 没变，但这一行要消失）
  await loadSites();
}

/* ==================== 下拉填充（防闪烁：选项未变化不重建） ==================== */

async function fillSiteOptions(): Promise<void> {
  // ★ v4.2.1：选项内容里现在带**站点名称**，所以 key 要含 siteNames ——
  //   只按 hosts 判"没变化"的话，改了名字下拉不会更新（表现是"改名没生效"）。
  const key = `${grantedHosts.join('|')}::${JSON.stringify(siteNames ?? null)}`;
  if (key === lastHostOptions && pHostSelect.options.length) {
    return;
  }
  lastHostOptions = key;
  pHostSelect.innerHTML = '';

  if (!grantedHosts.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.disabled = true;
    empty.selected = true;
    empty.textContent = '（暂无已授权站点 —— 请在「站点管理」添加）';
    pHostSelect.append(empty);
    return;
  }

  for (const h of grantedHosts) {
    const opt = document.createElement('option');
    opt.value = h;
    // ★ 用户要求 2：选站点时按**名称**认，而不是认域名。
    //   但域名不能丢 —— 它是账号真正绑定的东西，出问题时要靠它定位。
    //   原生 `<option>` 不能富文本，所以用 `名称（域名）` 这个折中；
    //   名字为空时退化成只显示域名（此时两者相同，不必重复）。
    const { title, sub } = siteTitleOf(h);
    opt.textContent = sub ? `${title}（${sub}）` : title;
    opt.title = h;
    pHostSelect.append(opt);
  }

  const stored = await chrome.storage.local.get(LAST_HOST_KEY);
  const last = stored[LAST_HOST_KEY] as string | undefined;
  const preferred =
    last && grantedHosts.includes(last)
      ? last
      : grantedHosts.includes(PREFERRED_HOST)
        ? PREFERRED_HOST
        : grantedHosts[0];
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

siteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  // v3.10.9：支持粘贴完整 URL——scheme 解析存 hint（账号创建时采用），host 用于授权
  const parsed = parseSiteInput(sHost.value);
  const host = parsed.host;
  if (!host) {
    return;
  }
  // ★ v4.2.1：名称留空 ⇒ **用站点地址填**（用户要求的回落口径）。
  //   注意这里用的是 `host` 而不是用户原样输入 —— 用户可能粘的是
  //   `https://a.com/x`，拿整串当名字会很难看。
  const name = sName.value.trim() || host;
  void (async () => {
    if (parsed.scheme) {
      await writeSchemeHint(host, parsed.scheme);
    }
    // ★ 授权请求必须在**用户手势里最先发起**（AGENTS §2：晚一步手势失效、request 必然失败）。
    //   所以它排在写云端站点名之前 —— 后者是网络调用，放前面会把手势耗掉。
    const ok = await chrome.permissions.request({ origins: [patternOfHost(host)] }).catch(() => false);
    if (!ok) {
      alert(`未完成授权：${host}`);
      return;
    }
    // 授权成功后再把名称落到云端。**失败不阻断**：授权已经生效，
    // 名只是显示信息，为它回滚一次成功的授权是本末倒置。
    try {
      await send({ kind: 'par.upsertSite', host, name });
    } catch (err) {
      // ★ 用 `log`（转发 logger）而不是裸 `console.*`：本仓规则 21 要求一切日志走打码通道，
      //   而裸 console 只证明"没绕过 A 通道"，不证明"没有 B 通道"（verify-log-redaction 会红）。
      log.warn('站点名称未保存到云端（授权已生效，不影响使用）：%s', err instanceof Error ? err.message : String(err));
    }
    sHost.value = '';
    sName.value = '';
    await loadSites(); // 立刻把新站点（含名字）画出来
    await send({ kind: 'par.grantChanged' });
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
const TAB_NAMES = ['accounts', 'add', 'sites', 'favorites'] as const;
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

async function refreshAll(): Promise<void> {
  // 数据源在最前：下面各层的文案/错误提示都要按它分叉
  await loadCloudState();
  renderAuthBar();
  // 先取盒子配置（含默认盒显示名），再渲染账号列表，避免首绘用回退名
  await loadBoxes();
  await loadBrowserAccounts();
  await loadSites();
  renderBoxChips();
  await fillSiteOptions();
  await fillBoxOptions();
  syncBatchBar();
  renderCloudBanner();
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
