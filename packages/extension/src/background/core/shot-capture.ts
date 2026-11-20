/**
 * 自动截图 · 后台侧（v4.5.1）
 *
 * 链路：内容脚本（`content/shot-recorder.ts`）在**事件发生的那一刻**把
 * 「元素矩形 + 视口尺寸」发给这里 → 这里立刻 `captureVisibleTab` 取当前视口
 * → 用 `OffscreenCanvas` 烘焙「压暗 + 聚光灯 + 玫红描边」→ 存进独立 IDB。
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
  ShotTargetTab,
} from '../../shared/types';
import { getLogger } from '../../shared/log';
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
  active = (got[SHOT_ACTIVE_KEY] as ShotRunningState | undefined) ?? null;
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
    await chrome.action.setBadgeText({ tabId, text: count > 99 ? '99+' : String(count) });
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

/** 可录制的页签：只列**并行账号已打开**的页签（它们一定属于「站点管理」里的站点） */
export async function listShotTargets(): Promise<ShotTargetTab[]> {
  const accounts = await parallelStore.list();
  const out: ShotTargetTab[] = [];
  for (const account of accounts) {
    const { tabIds } = parallelSession.statusOf(account);
    for (const tabId of tabIds) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || !tab.url || !/^https?:/i.test(tab.url)) continue;
      let host = '';
      try {
        host = new URL(tab.url).host;
      } catch {
        continue;
      }
      out.push({
        tabId,
        title: tab.title || account.tabName,
        url: tab.url,
        host,
        accountId: account.id,
        accountName: account.tabName,
      });
    }
  }
  return out.sort((a, b) => (a.accountName ?? '').localeCompare(b.accountName ?? '') || a.tabId - b.tabId);
}

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

export async function startShot(tabId: number): Promise<ShotRunningState> {
  const running = await loadActive();
  if (running) throw new Error('已经有一次录制在进行中，先停止它再开始新的');

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.id || !tab.url || !/^https?:/i.test(tab.url)) {
    throw new Error('只能录制普通网页页签（chrome:// 等受限页不可录制）');
  }
  const host = new URL(tab.url).host;
  const hostBare = hostNoPortOf(host);

  // 授权：调用方应在用户手势里先 request 过；这里再实查一次，避免「看起来在录、其实截不到」
  const pattern = `*://${host}/*`;
  const granted = await chrome.permissions.contains({ origins: [pattern] }).catch(() => false);
  if (!granted) throw new Error(`缺少「${hostBare}」的站点授权：请在本页点「授权并开始」`);

  // 只对「站点管理」里配置过的站点录制（用户明确要求的范围）
  const accountId = parallelSession.boundAccountOf(tabId);
  const sites = await parallelStore.listSites(true).catch(() => []);
  const configured = sites.some((s) => hostNoPortOf(s.host) === hostBare);
  if (!accountId && !configured) {
    throw new Error(`「${hostBare}」不在站点管理里，先到「站点管理」添加它再录制`);
  }

  const startedAt = Date.now();
  const session: ShotSessionMeta = {
    id: crypto.randomUUID(),
    name: `${hostBare} · ${stamp(startedAt)}`,
    startedAt,
    tabId,
    host: hostBare,
    accountId,
    stepCount: 0,
  };
  await shotDb.putSession(session);

  const state: ShotRunningState = { sessionId: session.id, tabId, host, startedAt, stepCount: 0 };
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
  log.info('开始录制 tab=%d host=%s', tabId, hostBare);
  return state;
}

export async function stopShot(sessionId: string): Promise<{ stepCount: number }> {
  const running = await loadActive();
  if (!running || running.sessionId !== sessionId) throw new Error('没有正在进行的录制');

  await chrome.tabs.sendMessage(running.tabId, { type: SHOT_MESSAGE.stop }).catch(() => undefined);
  await clearBadge(running.tabId);
  await saveActive(null);

  const session = await shotDb.getSession(sessionId);
  if (session) {
    await shotDb.putSession({ ...session, endedAt: Date.now(), stepCount: running.stepCount });
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
    await chrome.tabs.sendMessage(running.tabId, { type: SHOT_MESSAGE.stop }).catch(() => undefined);
    await clearBadge(running.tabId);
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
 * 把「压暗 + 聚光灯 + 描边」烘焙进截图。
 *
 * 四个矩形而不是整屏半透明 + 挖洞：`globalCompositeOperation` 的挖洞在某些
 * Chrome 版本的 OffscreenCanvas 上有边缘毛刺，而四块矩形是纯 `fillRect`，像素级稳定。
 */
function drawSpotlight(
  ctx: OffscreenCanvasRenderingContext2D,
  p: ShotEventPayload,
  outW: number,
  outH: number,
): void {
  const sx = outW / Math.max(1, p.vw);
  const sy = outH / Math.max(1, p.vh);
  const pad = 6;
  const w = Math.max(16, p.w) + pad * 2;
  const h = Math.max(16, p.h) + pad * 2;
  const x = Math.min(Math.max(0, (p.x - pad) * sx), Math.max(0, outW - 8));
  const y = Math.min(Math.max(0, (p.y - pad) * sy), Math.max(0, outH - 8));
  const rw = Math.min(w * sx, outW - x);
  const rh = Math.min(h * sy, outH - y);

  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
  ctx.fillRect(0, 0, outW, y);
  ctx.fillRect(0, y, x, rh);
  ctx.fillRect(x + rw, y, outW - (x + rw), rh);
  ctx.fillRect(0, y + rh, outW, outH - (y + rh));

  const lw = Math.max(2, Math.round(outW / 420));
  ctx.strokeStyle = '#F43F5E';
  ctx.lineWidth = lw * 2;
  ctx.strokeRect(x, y, rw, rh);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
  ctx.lineWidth = Math.max(1, lw);
  ctx.strokeRect(x + lw, y + lw, Math.max(1, rw - lw * 2), Math.max(1, rh - lw * 2));
  ctx.restore();
}

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

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
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
  drawSpotlight(ctx, p, w, h);
  bmp.close();
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob, w, h };
}

async function captureOne(p: ShotEventPayload): Promise<ShotStepMeta | null> {
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
    const shot = await captureAndAnnotate(running.tabId, p);
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

  const next: ShotRunningState = { ...running, stepCount: seq };
  await saveActive(next);
  await setBadge(running.tabId, seq);

  const session = await shotDb.getSession(running.sessionId);
  if (session) await shotDb.putSession({ ...session, stepCount: seq });

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
  const running = await loadActive();
  if (!running || running.sessionId !== p.sessionId || running.tabId !== tabId) {
    return { ok: false, error: '这次录制已经结束' };
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
  await serialize(() => captureOne(p));
  return { ok: true };
}

/* ============================== 生命周期兜底 ============================== */

/**
 * 录制期间页面刷新会让内容脚本消失。
 * ⇒ 页签 `status === 'complete'` 时重新注入一次（SPA 内部跳转不会触发，监听仍在）。
 */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  void (async () => {
    const running = await loadActive();
    if (!running || running.tabId !== tabId) return;
    try {
      await injectRecorder(tabId, running.sessionId);
      await setBadge(tabId, running.stepCount);
    } catch (e) {
      log.warn('刷新后重挂录制失败：%s', e instanceof Error ? e.message : String(e));
    }
  })();
});

/** 页签被关掉 = 录制自然结束；不能留一条永远「进行中」的状态 */
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const running = await loadActive();
    if (!running || running.tabId !== tabId) return;
    await saveActive(null);
    await clearBadge(tabId);
    const session = await shotDb.getSession(running.sessionId);
    if (session) await shotDb.putSession({ ...session, endedAt: Date.now(), stepCount: running.stepCount });
    // 页签被关时 UI 可能还开着：把「录制中」放掉，否则按钮会一直是「停止」
    void chrome.runtime
      .sendMessage({
        type: SHOT_MESSAGE.stopped,
        payload: { sessionId: running.sessionId, stepCount: running.stepCount, reason: '录制页签已关闭' },
      })
      .catch(() => undefined);
  })();
});
