/**
 * 账号选择器（扩展弹窗页版本，v4.1 **网格平铺**；此前是 v3.9 的环形扇区）。
 * 由 background 在收到 quick-wheel 命令时以独立 popup 窗口打开——
 * 在浏览器任何位置（含 chrome:// 页、新标签页）都能唤起。
 * 页面内无窗口控制元素；Esc 关闭；数字键 1-9/0 快选；失焦自动关闭（带启动宽限）。
 * 切盒：滚轮 / 左右箭头 / 点击页码点；**一盒一页，账号不再被截断**（超出滚动）。
 */
import { LOCAL_KEYS } from '../../shared/constants';
import { getForwardingLogger } from '../../shared/log';
import {
  DEFAULT_BOX,
  applyPreferredPage,
  fetchPreferredBox,
  groupPagesByBox,
  type WheelAccount,
} from './wheel-core';
import { buildAccountGrid } from './grid-core';

/* ★ 与 `ui/parallel/parallel.ts` / `ui/translate/translate.ts` 同一形状（转发 logger）：
 * 本页跑在自己的进程里，`getLogger()` 的行**到不了诊断包**。 */
const log = getForwardingLogger('wheel');

const wheelEl = document.getElementById('wheel') as HTMLDivElement;
const PARALLEL_PAGE = chrome.runtime.getURL('ui/parallel/parallel.html');
/**
 * ★ 2026-10-19：background 打开小窗时带过来的**当前页 host**。
 * 小窗自己是活动页，后台再查 `active` 只会查到它自己 ⇒ host 必须在打开前取好。
 */
const bootHost = new URLSearchParams(location.search).get('host') ?? '';

/* 启动宽限后再武装失焦关闭（创建瞬间可能误触发 blur） */
let blurArmed = false;
window.setTimeout(() => {
  blurArmed = true;
}, 400);
window.addEventListener('blur', () => {
  if (blurArmed) {
    window.close();
  }
});
void window.focus();

async function fetchAccounts(): Promise<WheelAccount[]> {
  const res = (await chrome.runtime.sendMessage({ kind: 'par.list' })) as
    | { kind: 'par.list'; result: { ok: boolean; data?: WheelAccount[] } }
    | undefined;
  if (!res?.result?.ok || !Array.isArray(res.result.data)) {
    return [];
  }
  // 保持账号固有顺序：盒子内扇区位置稳定，便于肌肉记忆
  return res.result.data;
}

/**
 * 轮盘分页 = 账号归属的盒子（有账号）+ 管理页记忆的空盒子（`ql:boxes`，补到页尾）。
 * 修复：新建的空盒子此前不会出现在轮盘里，导致「切换不到」。
 */
/* ★★ 2026-10-16：这三个读原来是**裸吞**（`() => []` / `() => ''`），
 * 而它们的后果是"**轮盘按不是存储里那份的盒子集合渲染**"：
 *   · `boxList` 读失败 ⇒ 少几个盒子（用户看到"我的盒子不见了"）；
 *   · `defaultBox` 读失败 ⇒ 默认盒判断错 ⇒ 首页可能是空的；
 *   · `disabledBoxes` 读失败 ⇒ **已停用的盒子重新出现**（用户看到"我停用的盒子又回来了"）。
 *   ⇒ 三种都是"界面与存储不一致"，而**用户看到的是界面在说谎**，不是"读失败了"。
 *
 * ★★ 读放在**函数里**、不用顶层 await：构建目标是 `iife`（AGENTS 规则 8），
 *   而 esbuild 对 iife **不支持顶层 await**（实测报错：
 *   `Top-level await is currently not supported with the "iife" output format`）。
 *   我第一版写在模块顶层 ⇒ `npm run build` 直接失败 —— 而**typecheck 是绿的**
 *   （`tsc` 认为它合法），所以这道门禁只有 build 才拦得住。
 *
 * ★ 合并成**一条** warn（而不是三条）：它们来自同一个 `Promise.allSettled`，
 *   失败原因几乎总是同一个（storage 不可用）⇒ 三条会把环刷满而信息量不增
 *   （PITFALLS 里"噪声挤掉证据"那条）。
 */
async function readBoxConfig(): Promise<{
  boxList: string[]; defaultBox: string; disabledBoxes: string[];
}> {
  const [a, b, c] = await Promise.allSettled([
    chrome.storage.local.get(LOCAL_KEYS.boxList),
    chrome.storage.local.get(LOCAL_KEYS.defaultBox),
    chrome.storage.local.get(LOCAL_KEYS.disabledBoxes),
  ]);
  const failed = [a, b, c].filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    log.warn('读盒子配置失败 %d/3 处 ⇒ 轮盘按默认值渲染（盒子可能少、已停用的可能又出现）：%s',
      failed,
      [a, b, c].map((r) => (r.status === 'rejected' ? String(r.reason) : '')).filter(Boolean).join(' / '));
  }
  const val = <T,>(r: PromiseSettledResult<Record<string, unknown>>, k: string): T | undefined =>
    r.status === 'fulfilled' ? (r.value[k] as T | undefined) : undefined;
  return {
    boxList: val<string[]>(a, LOCAL_KEYS.boxList) ?? [],
    defaultBox: (val<string>(b, LOCAL_KEYS.defaultBox) ?? '').trim(),
    disabledBoxes: val<string[]>(c, LOCAL_KEYS.disabledBoxes) ?? [],
  };
}

async function fetchPages(): Promise<{
  pages: { label: string; accounts: WheelAccount[] }[];
  defaultBox: string;
}> {
  const cfg = await readBoxConfig();
  const [accounts] = await Promise.all([fetchAccounts()]);
  const remembered = cfg.boxList;
  const defaultBoxStore = cfg.defaultBox || DEFAULT_BOX;
  const disabledStore = cfg.disabledBoxes;
  const disabled = new Set(disabledStore);
  // 禁用盒不进轮盘（即使盒内有账号）；空默认盒自动禁用（groupPagesByBox 只为有未归盒账号的默认盒出页）
  const pages = groupPagesByBox(accounts, defaultBoxStore).filter((p) => !disabled.has(p.label));
  const seen = new Set(pages.map((p) => p.label));
  for (const name of remembered) {
    if (!seen.has(name) && name !== defaultBoxStore && !disabled.has(name)) {
      pages.push({ label: name, accounts: [] });
    }
  }
  return { pages, defaultBox: defaultBoxStore };
}

async function pick(accountId: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ kind: 'par.open', id: accountId });
  } finally {
    window.close();
  }
}

let pages: { label: string; accounts: WheelAccount[] }[] = [];
let pageIndex = 0;
function render(): void {
  buildAccountGrid(wheelEl, {
    pages,
    pageIndex,
    onPage: (delta) => {
      if (!pages.length) {
        return;
      }
      pageIndex = (pageIndex + delta + pages.length) % pages.length;
      render();
      requestAnimationFrame(() => requestAnimationFrame(() => wheelEl.classList.add('in')));
    },
    onPick: (id) => void pick(id),
    emptyAction: {
      label: '去并行管理页添加',
      run: async () => {
        await chrome.tabs.create({ url: PARALLEL_PAGE });
        window.close();
      },
    },
  });
  requestAnimationFrame(() => requestAnimationFrame(() => wheelEl.classList.add('in')));
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.close();
    return;
  }
  const page = pages[pageIndex];
  if (!page) {
    return;
  }
  const idx = Number(e.key) === 0 ? 9 : Number(e.key) - 1;
  if (!Number.isNaN(idx) && idx >= 0 && idx < 10 && idx < page.accounts.length) {
    void pick(page.accounts[idx].id);
  }
}

/* 盒子/账号/禁用名单变化联动：3s 轮询，指纹未变不重绘（避免打断节点滑移动画） */
let lastFingerprint = '';
/** ★ 2026-10-19：起始盒子只应用一次（之后用户自己翻页，不能被轮询拽回去） */
let preferredApplied = false;
function fingerprint(grouped: { label: string; accounts: WheelAccount[] }[]): string {
  return JSON.stringify(grouped.map((p) => [p.label, p.accounts.map((a) => a.id)]));
}
async function refresh(): Promise<void> {
  const { pages: grouped, defaultBox: def } = await fetchPages();
  const fp = fingerprint(grouped);
  // ★ 还没应用起始盒时，即使指纹没变也要继续（首轮可能账号/盒子还没加载出来）
  if (fp === lastFingerprint && (preferredApplied || !grouped.length)) {
    return;
  }
  lastFingerprint = fp;
  pages = grouped;
  if (pageIndex >= pages.length) {
    pageIndex = Math.max(0, pages.length - 1);
  }
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => wheelEl.classList.add('in')));

  /* ★ 2026-10-19：起始盒子的解析**不阻塞首帧**（后台要打两次云端）。
   *   先按默认页显示，偏好回来后再翻页；只应用一次，之后用户自己翻。 */
  if (!preferredApplied && pages.length) {
    preferredApplied = true;
    void (async () => {
      try {
        const preferred = (await fetchPreferredBox(bootHost)) || def;
        const idx = applyPreferredPage(pages, preferred, def);
        if (idx > 0) {
          pageIndex = idx;
          render();
          requestAnimationFrame(() => requestAnimationFrame(() => wheelEl.classList.add('in')));
        }
      } catch {
        // 取不到就停在默认页
      }
    })();
  }
}

void refresh().then(() => {
  document.addEventListener('keydown', onKey);
});
window.setInterval(() => void refresh(), 3000);
