/**
 * 自动截图 · 控制台。
 *
 * 职责边界（★ 很重要）：
 *   · 后台负责「发生即截」——事件监听在内容脚本、截图与标注在 SW；
 *   · 这一页只负责「人看的部分」：停录制、审时间线、导出（**开录在弹窗里** ——
 *     截图要 `activeTab`，只有点扩展图标那一刻才拿得到，详见 `ui/popup/popup.ts` 的注释）。
 *   · 图片字节**不经过消息**：后台写进 `akso-pass-shots` IDB，这一页直接读同源库。
 *     否则每步几十 KB 的 base64 会把 runtime 通道与 UI 一起拖慢。
 */
import { EXT_VERSION, SHOT_MESSAGE } from '../../shared/constants';
import { buildDocx, type DocxImage, type DocxStep } from '../../shared/docx';
import { buildImageZip, buildMarkdown, stepFileName, type MarkdownStep } from '../../shared/markdown';
import type {
  ShotProgressPayload,
  ShotRunningState,
  ShotSessionMeta,
  ShotStepMeta,
} from '../../shared/types';
import { shotDb } from '../../storage/shot-db';
import { send } from '../send';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少元素 #${id}`);
  return node as T;
}

const stopEl = el<HTMLButtonElement>('stop');
const recChipEl = el('rec-chip');
const recStatEl = el('rec-stat');
const recNoticeEl = el<HTMLParagraphElement>('rec-notice');
const permBarEl = el('perm-bar');
const permTextEl = el('perm-text');
const grantEl = el<HTMLButtonElement>('grant');
const sessionsEl = el<HTMLUListElement>('sessions');
const detailEl = el('detail');
const detailEmptyEl = el('detail-empty');
const sessionNameEl = el<HTMLInputElement>('session-name');
const sessionMetaEl = el('session-meta');
const stepsEl = el<HTMLOListElement>('steps');
const exportNoticeEl = el<HTMLParagraphElement>('export-notice');

let running: ShotRunningState | null = null;
let sessions: ShotSessionMeta[] = [];
let current: ShotSessionMeta | null = null;
let currentSteps: ShotStepMeta[] = [];
const imageUrls = new Map<string, string>();

function showNotice(node: HTMLElement, text: string): void {
  node.textContent = text;
  node.classList.remove('hidden');
}

function hideNotice(node: HTMLElement): void {
  node.textContent = '';
  node.classList.add('hidden');
}

/* --------------------------------------------------------------- 截图权限 */

/**
 * 「在所有网站上读取数据」是 `captureVisibleTab` **唯一**认的授权
 * （站点级 host 授权、全网通配都不行 —— 实测见 `ui/popup/popup.ts` 的注释）。
 * 没有它时录制照常进行，但每一步只有文字。这里把这件事显式说出来，
 * 并给一个当场补授权的入口 —— 否则"导出文档里一张图都没有"就是静默降级。
 */
async function refreshPermission(): Promise<void> {
  const has = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
  permBarEl.classList.toggle('hidden', has);
}

function askPermission(): void {
  // ★ 必须在这一下手势里**最先**发起：前面只要有一次 await，Chrome 就不弹窗、
  //   也不报错，直接返回 false（AGENTS.md §2 的同名纪律）。
  const asked = chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
  void (async () => {
    const ok = await asked;
    if (ok) {
      permTextEl.textContent = '已授予截图权限：之后每一步都会带图。';
      permBarEl.classList.remove('hidden');
      window.setTimeout(() => void refreshPermission(), 2500);
      return;
    }
    permTextEl.textContent =
      '没拿到授权（弹窗被关掉，或被浏览器的站点权限策略拦下）。可以再点一次；仍不行就到 chrome://extensions 的「详细信息」里手动打开「在所有网站上读取数据」。';
    permBarEl.classList.remove('hidden');
  })();
}

function clock(at: number): string {  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned || '自动截图';
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function clearImages(): void {
  for (const url of imageUrls.values()) URL.revokeObjectURL(url);
  imageUrls.clear();
}

/* ------------------------------------------------------------------ 录制状态 */

function renderRecording(): void {
  const active = running !== null;
  recChipEl.classList.toggle('hidden', !active);
  stopEl.classList.toggle('hidden', !active);
  recStatEl.textContent = active && running ? `已记录 ${running.stepCount} 步 · ${running.host}` : '';
}

async function refreshRunning(): Promise<void> {
  const res = await send({ kind: 'shot.running' });
  running = res.kind === 'shot.running' && res.result.ok ? res.result.data : null;
  renderRecording();
}

async function stopRecording(): Promise<void> {
  if (!running) return;
  const sessionId = running.sessionId;
  const res = await send({ kind: 'shot.stop', sessionId });
  if (res.kind !== 'shot.stop' || !res.result.ok) {
    showNotice(recNoticeEl, res.kind === 'shot.stop' && !res.result.ok ? res.result.error : '后台无响应');
    return;
  }
  running = null;
  renderRecording();
  await refreshSessions(false);
  const finished = sessions.find((s) => s.id === sessionId);
  if (finished) await selectSession(finished);
}

/* ------------------------------------------------------------------ 录制记录 */

function renderSessions(): void {
  sessionsEl.replaceChildren();
  if (sessions.length === 0) {
    const li = document.createElement('li');
    li.className = 'desc';
    li.textContent = '还没有录制记录。';
    sessionsEl.appendChild(li);
    return;
  }
  for (const session of sessions) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shot-session';
    if (current?.id === session.id) button.classList.add('is-active');

    const name = document.createElement('span');
    name.className = 'shot-session-name';
    name.textContent = session.name;
    const meta = document.createElement('span');
    meta.className = 'shot-session-meta';
    meta.textContent = `${clock(session.startedAt)} · ${session.stepCount} 步 · ${session.host}`;

    button.append(name, meta);
    button.addEventListener('click', () => {
      void selectSession(session);
    });
    li.appendChild(button);
    sessionsEl.appendChild(li);
  }
}

async function refreshSessions(selectNewest: boolean): Promise<void> {
  const res = await send({ kind: 'shot.sessions' });
  if (res.kind !== 'shot.sessions' || !res.result.ok) return;
  sessions = res.result.data;
  if (current) {
    const fresh = sessions.find((s) => s.id === current?.id);
    if (fresh) current = fresh;
  }
  renderSessions();
  if (selectNewest && sessions.length > 0) await selectSession(sessions[0]);
}

async function selectSession(session: ShotSessionMeta): Promise<void> {
  current = session;
  renderSessions();
  detailEl.classList.remove('hidden');
  detailEmptyEl.classList.add('hidden');
  sessionNameEl.value = session.name;
  sessionMetaEl.textContent = `${clock(session.startedAt)} 开始 · ${session.host}${session.endedAt ? '' : ' · 录制中'}`;
  hideNotice(exportNoticeEl);

  clearImages();
  const res = await send({ kind: 'shot.steps', sessionId: session.id });
  currentSteps = res.kind === 'shot.steps' && res.result.ok ? res.result.data : [];
  await renderSteps();
}

function stepRow(meta: ShotStepMeta, index: number): HTMLLIElement {
  const li = document.createElement('li');
  li.className = 'shot-step';

  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'shot-thumb';
  thumb.title = '点击查看原图';
  const cached = imageUrls.get(meta.id);
  if (cached) {
    const img = document.createElement('img');
    img.src = cached;
    img.alt = `步骤 ${index + 1} 截图`;
    img.dataset.stepId = meta.id;
    thumb.appendChild(img);
    thumb.addEventListener('click', () => window.open(cached, '_blank'));
  } else {
    const empty = document.createElement('span');
    empty.className = 'shot-thumb-empty';
    empty.textContent = meta.hasImage ? '加载中' : '无截图';
    thumb.appendChild(empty);
    thumb.disabled = !meta.hasImage;
  }

  const body = document.createElement('div');
  body.className = 'shot-step-body';

  const title = document.createElement('p');
  title.className = 'shot-step-title';
  title.textContent = `${index + 1}. ${meta.kind === 'click' ? '点击' : '输入'} · ${meta.label}`;

  const facts = document.createElement('p');
  facts.className = 'shot-step-meta';
  const bits = [clock(meta.at), meta.url];
  if (meta.value) bits.push(`内容：${meta.value}`);
  facts.textContent = bits.join(' · ');

  const caption = document.createElement('input');
  caption.className = 'shot-caption';
  caption.value = meta.caption;
  caption.setAttribute('aria-label', `步骤 ${index + 1} 的说明`);
  caption.addEventListener('change', () => {
    void patchStep(meta.id, { caption: caption.value });
  });

  body.append(title, facts, caption);

  const side = document.createElement('div');
  side.className = 'shot-step-side';

  const label = document.createElement('label');
  const include = document.createElement('input');
  include.type = 'checkbox';
  include.checked = meta.include;
  include.addEventListener('change', () => {
    void patchStep(meta.id, { include: include.checked });
  });
  label.append(include, document.createTextNode(' 导出'));

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'btn-ghost btn-sm shot-danger';
  remove.textContent = '删除';
  remove.addEventListener('click', () => {
    void deleteStep(meta.id);
  });

  side.append(label, remove);
  li.append(thumb, body, side);
  return li;
}

async function renderSteps(): Promise<void> {
  stepsEl.replaceChildren();
  currentSteps.forEach((meta, index) => {
    stepsEl.appendChild(stepRow(meta, index));
  });

  // 图片后置加载：先把时间线画出来，再逐张把 blob URL 填进去
  for (const meta of currentSteps) {
    if (!meta.hasImage || imageUrls.has(meta.id)) continue;
    const record = await shotDb.getStep(meta.id);
    if (!record?.image) continue;
    const url = URL.createObjectURL(record.image);
    imageUrls.set(meta.id, url);
    const index = currentSteps.findIndex((s) => s.id === meta.id);
    if (index < 0) continue;
    stepsEl.replaceChild(stepRow(meta, index), stepsEl.children[index]);
  }
}

async function patchStep(id: string, patch: { caption?: string; include?: boolean }): Promise<void> {
  const res = await send({ kind: 'shot.updateStep', id, ...patch });
  if (res.kind !== 'shot.updateStep' || !res.result.ok) {
    showNotice(exportNoticeEl, res.kind === 'shot.updateStep' && !res.result.ok ? res.result.error : '后台无响应');
    return;
  }
  const index = currentSteps.findIndex((s) => s.id === id);
  if (index >= 0) currentSteps[index] = res.result.data;
  if (current) {
    current.stepCount = currentSteps.filter((s) => s.include).length;
  }
}

async function deleteStep(id: string): Promise<void> {
  if (!window.confirm('从这次录制里删掉这一步（含截图）？')) return;
  const res = await send({ kind: 'shot.deleteStep', id });
  if (res.kind !== 'shot.deleteStep' || !res.result.ok) {
    showNotice(exportNoticeEl, res.kind === 'shot.deleteStep' && !res.result.ok ? res.result.error : '后台无响应');
    return;
  }
  const url = imageUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    imageUrls.delete(id);
  }
  currentSteps = currentSteps.filter((s) => s.id !== id);
  if (current) current.stepCount = currentSteps.length;
  renderSessions();
  await renderSteps();
}

/* ------------------------------------------------------------------ 导出 */

async function exportedSteps(): Promise<ShotStepMeta[]> {
  return currentSteps.filter((s) => s.include);
}

async function imageFor(meta: ShotStepMeta): Promise<Blob | undefined> {
  if (!meta.hasImage) return undefined;
  const record = await shotDb.getStep(meta.id);
  return record?.image;
}

async function exportWord(): Promise<void> {
  if (!current) return;
  hideNotice(exportNoticeEl);
  const steps = await exportedSteps();
  if (steps.length === 0) {
    showNotice(exportNoticeEl, '这次录制没有勾选任何步骤。');
    return;
  }
  const docSteps: DocxStep[] = [];
  for (const meta of steps) {
    const blob = await imageFor(meta);
    let image: DocxImage | undefined;
    if (blob) {
      image = {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        ext: 'png',
        width: meta.imageW ?? 1280,
        height: meta.imageH ?? 720,
      };
    }
    docSteps.push({ meta, image });
  }
  const blob = buildDocx({
    title: current.name,
    subtitle: `Akso Pass · 自动截图 · 生成于 ${new Date().toLocaleString('zh-CN')}`,
    meta: {
      site: current.host,
      startedAt: current.startedAt,
      endedAt: current.endedAt,
      stepCount: docSteps.length,
      imageCount: docSteps.filter((s) => s.image !== undefined).length,
      tabCount: current.tabIds?.length ?? 1,
    },
    steps: docSteps,
  });
  download(blob, `${safeName(current.name)}.docx`);
}

async function exportMarkdown(): Promise<void> {
  if (!current) return;
  hideNotice(exportNoticeEl);
  const steps = await exportedSteps();
  if (steps.length === 0) {
    showNotice(exportNoticeEl, '这次录制没有勾选任何步骤。');
    return;
  }
  const mdSteps: MarkdownStep[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const meta = steps[i];
    const blob = await imageFor(meta);
    mdSteps.push(
      blob
        ? { meta, imagePath: `assets/${stepFileName(i)}`, imageBytes: new Uint8Array(await blob.arrayBuffer()) }
        : { meta },
    );
  }
  const markdown = buildMarkdown({
    title: current.name,
    subtitle: `Akso Pass · 自动截图 · 生成于 ${new Date().toLocaleString('zh-CN')}`,
    meta: {
      site: current.host,
      startedAt: current.startedAt,
      endedAt: current.endedAt,
      stepCount: mdSteps.length,
      imageCount: mdSteps.filter((s) => s.imageBytes !== undefined).length,
      tabCount: current.tabIds?.length ?? 1,
    },
    steps: mdSteps,
    embedImages: true,
  });
  download(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${safeName(current.name)}.md`);
}

async function exportImages(): Promise<void> {
  if (!current) return;
  hideNotice(exportNoticeEl);
  const steps = await exportedSteps();
  const mdSteps: MarkdownStep[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const blob = await imageFor(steps[i]);
    if (blob) mdSteps.push({ meta: steps[i], imageBytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  const zip = buildImageZip(mdSteps);
  if (!zip) {
    showNotice(exportNoticeEl, '勾选的步骤里没有截图可导出。');
    return;
  }
  download(zip, `${safeName(current.name)}-images.zip`);
}

/* ------------------------------------------------------------------ 事件绑定 */

el('sessions-refresh').addEventListener('click', () => {
  void refreshSessions(false);
});
grantEl.addEventListener('click', askPermission);
stopEl.addEventListener('click', () => {
  void stopRecording();
});
el('export-docx').addEventListener('click', () => {
  void exportWord();
});
el('export-md').addEventListener('click', () => {
  void exportMarkdown();
});
el('export-images').addEventListener('click', () => {
  void exportImages();
});
el('delete-session').addEventListener('click', () => {
  void (async () => {
    if (!current) return;
    if (!window.confirm(`删除「${current.name}」及它的全部截图？`)) return;
    const res = await send({ kind: 'shot.deleteSession', id: current.id });
    if (res.kind !== 'shot.deleteSession' || !res.result.ok) {
      showNotice(exportNoticeEl, res.kind === 'shot.deleteSession' && !res.result.ok ? res.result.error : '后台无响应');
      return;
    }
    current = null;
    currentSteps = [];
    clearImages();
    detailEl.classList.add('hidden');
    detailEmptyEl.classList.remove('hidden');
    await refreshSessions(false);
  })();
});
sessionNameEl.addEventListener('change', () => {
  void (async () => {
    if (!current) return;
    const name = sessionNameEl.value.trim();
    if (!name || name === current.name) return;
    const res = await send({ kind: 'shot.rename', id: current.id, name });
    if (res.kind !== 'shot.rename' || !res.result.ok) {
      showNotice(exportNoticeEl, res.kind === 'shot.rename' && !res.result.ok ? res.result.error : '后台无响应');
      sessionNameEl.value = current.name;
      return;
    }
    current = res.result.data;
    await refreshSessions(false);
  })();
});

// 后台单方面收尾：步数上限 / 页签被关。没有这一条，按钮会一直停在「停止录制」。
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  if ((message as { type?: string }).type !== SHOT_MESSAGE.stopped) return;
  const payload = (message as { payload?: { sessionId?: string; reason?: string } }).payload;
  if (!running || !payload || payload.sessionId !== running.sessionId) return;
  running = null;
  renderRecording();
  showNotice(recNoticeEl, `录制已结束：${payload.reason ?? '录制页签已关闭'}`);
  void refreshSessions(false);
});

// 录制中的实时推送：只更新计数与当前时间线，不打断正在编辑的说明
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== 'object') return;
  if ((message as { type?: string }).type !== SHOT_MESSAGE.progress) return;
  const payload = (message as { payload?: ShotProgressPayload }).payload;
  if (!payload) return;
  if (!running || payload.sessionId !== running.sessionId) return;
  running = { ...running, stepCount: payload.stepCount };
  renderRecording();
  if (current?.id === payload.sessionId && !currentSteps.some((s) => s.id === payload.step.id)) {
    currentSteps.push(payload.step);
    current.stepCount = currentSteps.length;
    void renderSteps();
  }
});

/* ------------------------------------------------------------------ 启动 */

el('ver-chip').textContent = `v${EXT_VERSION}`;
void (async () => {
  await refreshPermission();
  await refreshSessions(false);
  await refreshRunning();
  if (running) await refreshSessions(false);
})();
