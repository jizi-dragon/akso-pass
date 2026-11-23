/**
 * 自动截图 · 后台侧（v4.6.1）
 *
 * 链路：内容脚本（`content/shot-recorder.ts`）在**事件发生的那一刻**把
 * 「元素矩形 + 视口尺寸」发给这里 → 这里立刻 `captureVisibleTab` 取当前视口
 * → 用 `OffscreenCanvas` 烘焙「玫红描边框」→ 存进独立 IDB。
 *
 * ★ 录制范围是**整个浏览器**，不是开录的那一个页签（v4.6.1 改）：
 *   平台里点「查看/编辑」经常弹出新页签甚至新窗口，操作发生在那边；
 *   只挂在开录页签上会漏掉后半段。⇒ 录制期间每个 http(s) 页签都会被挂上录制器，
 *   页签/窗口的增减由 `tabs.onCreated` / `onUpdated` / `onActivated` / `onRemoved` 维护。
 *
 * ★ 为什么标注只画框、不压暗四周（v4.6.1）：
 *   早期版本用四块半透明矩形做"聚光灯"，用户反馈"除了框选区域全黑糊糊的"——
 *   手册截图要保留页面上下文，读者才看得懂这一步在哪个界面里。像素一律不动。
 *
 * ★ 为什么标注要烘焙进图片、而不是在 Word 里画个框：
 *   手册会被复制/转存/打印，DOM 上的浮层不会跟着走；烘焙进像素的结果是
 *   「一张图就是一步」，任何阅读器里都不会错位。这也是 `re_igenflow`
 *   逆向时最值得抄的一条（报告 §3.6）。
 *
 * ★ 为什么截图不经过 UI：截图必须在事件瞬间发生（点击会触发页面跳转/弹窗），
 *   绕一圈 UI 的往返会拿到「已经变过的页面」。
 */
import {
  SHOT_ACTIVE_KEY,
  SHOT_MAX_EDGE,
  SHOT_MAX_STEPS,
  SHOT_MESSAGE,
} from '../../shared/constants';
import type {
  ShotEventPayload,
  ShotProgressPayload,
  ShotRunningState,
  ShotSessionMeta,
  ShotStepMeta,
  ShotStepRecord,
} from '../../shared/types';
import { getLogger } from '../../shared/log';
import { drawFrame } from '../../shared/shot-annotate';
import { shotDb } from '../../storage/shot-db';
import { parallelSession } from './parallel-session';
import { parallelStore } from './parallel-store';
import { hostNoPortOf } from './tab-rules';

const log = getLogger('shot');

/** 单次录制的活跃状态：内存缓存 + `chrome.storage.session` 落盘（SW 会被回收） */
let active: ShotRunningState | null = null;
let activeLoaded = false;

/** 截图串行队列：并发截图会乱序落库，Chrome 还有「每秒 2 次」的配额 */
let chain: Promise<unknown> = Promise.resolve();
let lastCaptureAt = 0;

async function loadActive(): Promise<ShotRunningState | null> {
  if (activeLoaded) return active;
  const got = await chrome.storage.session.get(SHOT_ACTIVE_KEY);
  const raw = (got[SHOT_ACTIVE_KEY] as ShotRunningState | undefined) ?? null;
  if (raw) {
    // 兼容 4.6.0 之前的单页签状态：补齐 windowId/tabIds，避免升级后状态不可用。
    const tab = await chrome.tabs.get(raw.tabId).catch(() => null);
    raw.windowId = raw.windowId ?? tab?.windowId ?? -1;
    raw.tabIds = Array.isArray(raw.tabIds) && raw.tabIds.length > 0 ? raw.tabIds : [raw.tabId];
  }
  active = raw;
  activeLoaded = true;
  return active;
}

async function saveActive(next: ShotRunningState | null): Promise<void> {
  active = next;
  activeLoaded = true;
  if (next) await chrome.storage.session.set({ [SHOT_ACTIVE_KEY]: next });
  else await chrome.storage.session.remove(SHOT_ACTIVE_KEY);
}

/** 把任务排进串行队列（读-改-写活跃状态时尤其需要） */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function defaultCaption(p: { kind: 'click' | 'input'; label: string }): string {
  return p.kind === 'click' ? `点击「${p.label}」` : `填写「${p.label}」`;
}

/** blob 不进消息通道，元数据单独剥离出来给 UI */
function toMeta(rec: ShotStepRecord): ShotStepMeta {
  const { image: _image, ...meta } = rec;
  return meta;
}

async function setBadge(tabId: number, count: number): Promise<void> {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#E11D48', tabId });
    // 0 步时显示一个圆点而不是 "0"：它表示"这一页正在录制"，不是"记了 0 步"。
    await chrome.action.setBadgeText({ tabId, text: count <= 0 ? '●' : count > 99 ? '99+' : String(count) });
  } catch {
    // 角标不可用（例如页签已关）忽略
  }
}

async function clearBadge(tabId: number): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    /* ignore */
  }
}

/* ============================== 对外查询 ============================== */

export async function getRunningShot(): Promise<ShotRunningState | null> {
  return await loadActive();
}

export async function listShotSessions(): Promise<ShotSessionMeta[]> {
  return await shotDb.listSessions();
}

export async function listShotSteps(sessionId: string): Promise<ShotStepMeta[]> {
  const rows = await shotDb.listSteps(sessionId);
  return rows.map(toMeta);
}

/* ============================== 开始 / 停止 ============================== */

async function injectRecorder(tabId: number, sessionId: string): Promise<void> {
  // ★ 用 executeScript 按需注入，而不是常驻 `content_scripts`：
  //   录制是低频动作，常驻一份监听会让**每个页面**都多背一个脚本（规则 10 的同类问题）。
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/shot-recorder.js'],
    world: 'ISOLATED',
  });
  const ack = (await chrome.tabs.sendMessage(tabId, { type: SHOT_MESSAGE.start, sessionId }).catch(() => null)) as
    | { ok?: boolean }
    | null;
  if (!ack?.ok) throw new Error('录制脚本没能挂上这个页面（可能刚刷新或属受限页），请刷新页面后重试');
}

/** 值不值得给这个页签挂录制器：普通网页、且不是被"丢弃"（休眠）的页签 */
async function recordableTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) return null;
  // 被丢弃的页签没有渲染进程，`executeScript` 必然失败；等它被激活并重新加载时
  // `tabs.onUpdated → complete` 会补挂。
  if (tab.discarded) return null;
  return tab;
}

/**
 * 把录制器挂到一个页签上（**不区分窗口**——录制范围是整个浏览器）。
 *
 * 用户点开链接/按钮后，操作经常发生在**新页签**、甚至是 `window.open` 出来的
 * **新窗口**里；只认开录时的那个 windowId 会漏掉后者。受限页/失败一律静默跳过，
 * 不能让某个页面把整次录制打断。
 */
async function attachTab(tabId: number, sessionId: string): Promise<boolean> {
  if (!(await recordableTab(tabId))) return false;
  try {
    await injectRecorder(tabId, sessionId);
  } catch (e) {
    log.warn('页签挂录制器失败（跳过）：tab=%d %s', tabId, e instanceof Error ? e.message : String(e));
    return false;
  }
  const running = await loadActive();
  if (running && running.sessionId === sessionId) {
    if (!running.tabIds.includes(tabId)) {
      running.tabIds.push(tabId);
      await saveActive(running);
    }
    const session = await shotDb.getSession(sessionId);
    const known = session?.tabIds ?? (session ? [session.tabId] : []);
    if (session && !known.includes(tabId)) {
      await shotDb.putSession({ ...session, tabIds: [...known, tabId] });
    }
  }
  return true;
}

/**
 * 开录时把录制器铺到**整个浏览器**的普通网页页签（含其它窗口）。
 *
 * ★ 尽力而为，且**不阻塞开录**：用户要的是"从现在开始记"，不是"把所有页签都挂好"。
 *   挂不上的页签（休眠/受限/无授权）以后被激活或重新加载时会由 `onUpdated` 补挂。
 */
async function attachAllTabs(sessionId: string): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const running = await loadActive();
  if (!running || running.sessionId !== sessionId) return;
  const todo = tabs.filter((t) => t.id !== undefined && !running.tabIds.includes(t.id));
  await Promise.all(
    todo.map(async (t) => {
      if (t.id === undefined) return;
      if (await attachTab(t.id, sessionId)) await setBadge(t.id, running.stepCount);
    }),
  );
}

export async function startShot(tabId: number): Promise<ShotRunningState> {
  const running = await loadActive();
  if (running) throw new Error('已经有一次录制在进行中，先停止它再开始新的');

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error('只能录制普通网页页签（chrome:// 等受限页不可录制）');
  }
  const host = new URL(tab.url).host;
  const hostBare = hostNoPortOf(host);

  // 站点授权：录制只覆盖「站点管理」里配置过的站点（用户明确要求的范围）。
  // ★ 它**不是**截图权限 —— `captureVisibleTab` 要的是 `activeTab` 或 `<all_urls>`，
  //   而 `activeTab` 由「用户在目标页签上点扩展图标」那一刻授予（见 ui/popup/popup.ts），
  //   这里查不出来也补不上，只能在开录时机上保证。
  // ★★ 必须用**不带端口**的 host 组 pattern：Chrome 的 match pattern **不接受端口**
  //   （`*://10.0.0.5:8080/*` 是非法值），`permissions.contains` 对它恒返回 false，
  //   而 match pattern 本身忽略端口 ⇒ 去掉端口反而能覆盖同一主机的所有端口。
  //   实测：本地站点 `127.0.0.1:<port>` 曾因此报"缺少站点授权"，用户按提示重授权也没用。
  const pattern = `*://${hostBare}/*`;
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (!granted) throw new Error(`缺少「${hostBare}」的站点授权：请到「账号中心 → 站点管理」重新授权后再录`);

  // 只对「站点管理」里配置过的站点录制（用户明确要求的范围）
  const accountId = parallelSession.boundAccountOf(tabId);
  const sites = await parallelStore.listSites(true).catch(() => []);
  const configured = sites.some((s) => hostNoPortOf(s.host) === hostBare);
  if (!accountId && !configured) {
    throw new Error(`「${hostBare}」不在站点管理里，先到「站点管理」添加它再录制`);
  }

  const startedAt = Date.now();
  const windowId = tab.windowId;
  const session: ShotSessionMeta = {
    id: crypto.randomUUID(),
    name: `${hostBare} · ${stamp(startedAt)}`,
    startedAt,
    tabId,
    windowId,
    tabIds: [tabId],
    host: hostBare,
    accountId,
    stepCount: 0,
  };
  await shotDb.putSession(session);

  const state: ShotRunningState = { sessionId: session.id, tabId, windowId, tabIds: [tabId], host, startedAt, stepCount: 0 };
  await saveActive(state);

  try {
    await injectRecorder(tabId, session.id);
  } catch (e) {
    // 注入失败就把刚建的空会话一起撤掉，别留一条「点进去什么都没有」的记录
    await saveActive(null);
    await shotDb.deleteSession(session.id).catch(() => undefined);
    throw e;
  }

  await setBadge(tabId, 0);
  // ★ 把录制器铺到**整个浏览器**（含其它窗口）。用户点开弹窗/新页签后操作发生在那边，
  //   只挂在开录页签上会漏掉后半段 —— 这正是 v4.6.1 要解决的问题。
  await attachAllTabs(session.id);
  log.info('开始录制 tab=%d host=%s 已挂页签=%d', tabId, hostBare, (await loadActive())?.tabIds.length ?? 1);
  return state;
}

export async function stopShot(sessionId: string): Promise<{ stepCount: number }> {
  const running = await loadActive();
  if (!running || running.sessionId !== sessionId) throw new Error('没有正在进行的录制');

  const tabs = running.tabIds.length > 0 ? running.tabIds : [running.tabId];
  await Promise.all(
    tabs.map(async (tabId) => {
      await chrome.tabs.sendMessage(tabId, { type: SHOT_MESSAGE.stop }).catch(() => undefined);
      await clearBadge(tabId);
    }),
  );
  await saveActive(null);

  const session = await shotDb.getSession(sessionId);
  if (session) {
    await shotDb.putSession({ ...session, endedAt: Date.now(), stepCount: running.stepCount, tabIds: tabs });
  }
  log.info('停止录制 session=%s steps=%d', sessionId, running.stepCount);
  return { stepCount: running.stepCount };
}

/* ============================== 编辑 / 删除 ============================== */

export async function updateShotStep(id: string, patch: { caption?: string; include?: boolean }): Promise<ShotStepMeta> {
  const rec = await shotDb.getStep(id);
  if (!rec) throw new Error('这一帧已经不存在了（可能刚被删除）');
  const next: ShotStepRecord = { ...rec };
  if (typeof patch.caption === 'string') next.caption = patch.caption.slice(0, 200);
  if (typeof patch.include === 'boolean') next.include = patch.include;
  await shotDb.putStep(next);
  return toMeta(next);
}

export async function deleteShotStep(id: string): Promise<void> {
  const rec = await shotDb.getStep(id);
  if (!rec) return;
  await shotDb.deleteStep(id);
  const session = await shotDb.getSession(rec.sessionId);
  if (session) await shotDb.putSession({ ...session, stepCount: Math.max(0, session.stepCount - 1) });
}

export async function deleteShotSession(id: string): Promise<void> {
  const running = await loadActive();
  if (running?.sessionId === id) {
    const tabs = running.tabIds.length > 0 ? running.tabIds : [running.tabId];
    await Promise.all(
      tabs.map(async (tabId) => {
        await chrome.tabs.sendMessage(tabId, { type: SHOT_MESSAGE.stop }).catch(() => undefined);
        await clearBadge(tabId);
      }),
    );
    await saveActive(null);
  }
  await shotDb.deleteSession(id);
}

export async function renameShotSession(id: string, name: string): Promise<ShotSessionMeta> {
  const session = await shotDb.getSession(id);
  if (!session) throw new Error('这次录制已经不存在了');
  const next = { ...session, name: name.trim().slice(0, 80) || session.name };
  await shotDb.putSession(next);
  return next;
}

/* ============================== 截图主流程 ============================== */

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',');
  const head = dataUrl.slice(0, comma);
  const bin = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: head.includes('image/jpeg') ? 'image/jpeg' : 'image/png' });
}

/**
 * 给目标元素画一个**圆角描边框**，四周不压暗、不填充、不改任何像素。
 *
 * 实现放在 `shared/shot-annotate.ts`：离线预览脚本要能单独加载它以自检观感，
 * 后台与预览器共用同一份绘制代码（否则会出现"预览好看、真截图难看"）。
 */


async function captureAndAnnotate(
  tabId: number,
  p: ShotEventPayload,
): Promise<{ blob: Blob; w: number; h: number } | null> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return null;
  if (!tab.active) {
    // 页签在后台：captureVisibleTab 抓的是**前台页签**，硬抓会截错页面。
    // 宁可不给图，也不能给一张错的图（手册里错图比没图更有害）。
    log.info('页签不在前台，跳过截图（事件仍记录）tab=%d', tabId);
    return null;
  }

  // Chrome 对 captureVisibleTab 有「每秒 2 次」的配额；排队 + 节流，超了会直接抛
  const wait = 600 - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);
  lastCaptureAt = Date.now();

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }).catch((e: unknown) => {
    // 最常见的一条：没拿到 `<all_urls>`（站点级授权与全网通配都**不够**）。
    // 那时 Chrome 只抛一句英文 "Either the '<all_urls>' or 'activeTab' permission is required."
    // ⇒ 换成用户能照做的提示，并且**照常记录这一步**（文字仍有用，只是没图）。
    const msg = e instanceof Error ? e.message : String(e);
    if (/all_urls|activeTab/i.test(msg)) {
      log.warn('没有截图权限（这一步只记文字）：去「自动截图」页点「授予截图权限」可补上 tab=%d', tabId);
      return null;
    }
    throw e;
  });
  if (dataUrl === null) return null;
  const bmp = await createImageBitmap(dataUrlToBlob(dataUrl));
  const scale = Math.min(1, SHOT_MAX_EDGE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bmp.close();
    return null;
  }
  ctx.drawImage(bmp, 0, 0, w, h);
  drawFrame(ctx, p, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, w, h };
}

async function captureOne(p: ShotEventPayload, tabId: number): Promise<ShotStepMeta | null> {
  // ★ 队列里重新读一次活跃状态：两次点击可能在同一毫秒排队，
  //   用调用方手里的旧快照会把 seq 写成同一个值。
  const running = await loadActive();
  if (!running || running.sessionId !== p.sessionId) return null;

  const seq = running.stepCount + 1;
  const meta: ShotStepMeta = {
    id: crypto.randomUUID(),
    sessionId: running.sessionId,
    seq,
    kind: p.kind,
    at: p.at,
    url: p.url,
    title: p.title,
    vw: p.vw,
    vh: p.vh,
    dpr: p.dpr,
    x: p.x,
    y: p.y,
    w: p.w,
    h: p.h,
    label: p.label,
    selector: p.selector,
    value: p.value,
    hasImage: false,
    caption: defaultCaption(p),
    include: true,
  };

  try {
    const shot = await captureAndAnnotate(tabId, p);
    if (shot) {
      meta.hasImage = true;
      meta.imageW = shot.w;
      meta.imageH = shot.h;
      const rec: ShotStepRecord = { ...meta, image: shot.blob };
      await shotDb.putStep(rec);
    } else {
      await shotDb.putStep({ ...meta });
    }
  } catch (e) {
    log.warn('截图失败（仍记录这一步）：%s', e instanceof Error ? e.message : String(e));
    await shotDb.putStep({ ...meta });
  }

  const next: ShotRunningState = {
    ...running,
    stepCount: seq,
    tabIds: running.tabIds.includes(tabId) ? running.tabIds : [...running.tabIds, tabId],
  };
  await saveActive(next);
  await setBadge(tabId, seq);

  const session = await shotDb.getSession(running.sessionId);
  if (session) await shotDb.putSession({ ...session, stepCount: seq, tabIds: next.tabIds });

  const payload: ShotProgressPayload = { sessionId: next.sessionId, stepCount: seq, step: meta };
  void chrome.runtime.sendMessage({ type: SHOT_MESSAGE.progress, payload }).catch(() => undefined);
  return meta;
}

/** content → background：一次点击/输入。返回 false 表示这帧被丢掉了（录制已停） */
export async function handleShotEvent(
  p: ShotEventPayload,
  sender: chrome.runtime.MessageSender,
): Promise<{ ok: boolean; error?: string }> {
  if (sender.frameId !== undefined && sender.frameId !== 0) return { ok: false, error: '只接受顶层 frame 的事件' };
  const tabId = sender.tab?.id;
  if (tabId === undefined) return { ok: false, error: '没有 sender.tab' };
  // ② 录制范围是**整个浏览器**（不限窗口）：只认 sessionId。
  //    v4.6.0 这里还有 `running.windowId !== windowId` —— 那会把 popup 型新窗口
  //    里的操作整段丢掉（用户明确说"有时候会弹出新的页面"）。
  const running = await loadActive();
  if (!running || running.sessionId !== p.sessionId) {
    return { ok: false, error: '这次录制已经结束' };
  }
  // ① 兜底：事件来自一个还没挂上录制器的页签（例如开录后才打开的页签、
  //    或录制中途被丢弃又重新加载的页签）—— 现场补挂，别丢这一帧。
  if (!running.tabIds.includes(tabId)) {
    const attached = await attachTab(tabId, running.sessionId);
    if (!attached) return { ok: false, error: '这个页签没有挂上录制器' };
  }
  if (running.stepCount >= SHOT_MAX_STEPS) {
    // 到上限就**收尾并告知 UI**：继续收事件会让"录着但什么都不发生"成为静默故障。
    await stopShot(running.sessionId).catch(() => undefined);
    void chrome.runtime
      .sendMessage({
        type: SHOT_MESSAGE.stopped,
        payload: { sessionId: running.sessionId, stepCount: running.stepCount, reason: `达到 ${SHOT_MAX_STEPS} 步上限` },
      })
      .catch(() => undefined);
    return { ok: false, error: `单次录制最多 ${SHOT_MAX_STEPS} 步，已自动停止` };
  }
  await serialize(() => captureOne(p, tabId));
  return { ok: true };
}

/* ============================== 生命周期兜底 ============================== */

/**
 * 录制期间页面刷新会让内容脚本消失（整页导航 = 新的 document）。
 * ⇒ 页签 `status === 'complete'` 时重新注入一次（SPA 内部跳转不触发，监听仍在）。
 *
 * ★ 录制范围是**整个浏览器**：这里不再按 windowId 过滤，任何页签加载完成都补挂。
 *   元素重复注入由内容脚本自己的 holder（`window.__qlShotRecorder`）挡住。
 */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  void (async () => {
    const running = await loadActive();
    if (!running) return;
    if (await attachTab(tabId, running.sessionId)) await setBadge(tabId, running.stepCount);
  })();
});

/** 切到一个没挂过的旧页签时补挂（它可能在开录前就开着，或曾因休眠被丢弃） */
chrome.tabs.onActivated.addListener((info) => {
  void (async () => {
    const running = await loadActive();
    if (!running || running.tabIds.includes(info.tabId)) return;
    if (await attachTab(info.tabId, running.sessionId)) await setBadge(info.tabId, running.stepCount);
  })();
});

/**
 * 页签被关：只把它从名单里摘掉。
 * ★ 只有**一个能录的页签都不剩**时才收尾 —— 用户常见的动作是"关掉弹窗，
 *   回原页签继续操作"，提前收尾会让后半段整段丢失。
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const running = await loadActive();
    if (!running || !running.tabIds.includes(tabId)) return;
    const remaining = running.tabIds.filter((id) => id !== tabId);
    if (remaining.length > 0) {
      await saveActive({
        ...running,
        tabIds: remaining,
        tabId: running.tabId === tabId ? remaining[0] : running.tabId,
      });
      return;
    }

    // 最后一个挂着录制器的页签没了：整个浏览器里还有普通网页就补挂一个，别提前收尾。
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const candidates = tabs.filter((t) => t.id !== undefined && t.url && /^https?:/i.test(t.url) && !t.discarded);
    const fallback = candidates.find((t) => t.active) ?? candidates[0];
    if (fallback?.id !== undefined) {
      const attached = await attachTab(fallback.id, running.sessionId);
      if (attached) {
        await saveActive({ ...running, tabIds: [fallback.id], tabId: fallback.id });
        await setBadge(fallback.id, running.stepCount);
        return;
      }
    }

    await saveActive(null);
    await clearBadge(tabId);
    const session = await shotDb.getSession(running.sessionId);
    if (session) await shotDb.putSession({ ...session, endedAt: Date.now(), stepCount: running.stepCount });
    // 页签被关时 UI 可能还开着：把「录制中」放掉，否则按钮会一直是「停止」
    void chrome.runtime
      .sendMessage({
        type: SHOT_MESSAGE.stopped,
        payload: { sessionId: running.sessionId, stepCount: running.stepCount, reason: '录制的页签都已关闭' },
      })
      .catch(() => undefined);
  })();
});
