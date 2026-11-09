import { EXT_VERSION } from '../../shared/constants';
import { isNewerVersion } from '../../shared/update-logic';
import { getForwardingLogger } from '../../shared/log';
import { installLogForwarding } from '../../shared/forward-log';

/**
 * 弹窗的 logger。
 *
 * ★★ 2026-11-09：本文件此前**一个 logger 都没有**（4 处静默 catch）。
 *   而弹窗正是用户"第一眼看到系统状态"的地方 —— 统计显示 `—`、
 *   更新提醒不出现，都由这里决定，且都属于规则 29 的形态：
 *   **失败与"正常但没有数据"在界面上长得一样**。
 *   ⇒ 装上转发 logger，把这几处补上 `warn`（弹窗生命周期短，
 *     SW 已回收时转发失败是正常的，`shared/forward-log.ts` 已吞掉）。
 */
const log = getForwardingLogger('popup');
installLogForwarding();

/**
 * 弹窗 = 品牌 + 实时统计 + 唯一主操作（v3.8 起；v4.2.1 第五轮进一步收窄）。
 *
 * # ★ 弹窗刻意**不承载账号库管理**（用户 2026-10-12 第五轮要求 ①②）
 *
 * 删掉的三块与理由：
 *
 * | 删掉的 | 为什么 |
 * |---|---|
 * | `#open-vault`（登录云端账号库） | 用户明确"不需要在此处显示登录" |
 * | `#identity`（身份区 + 同步/退出菜单） | 那是"管理"，且**与账号中心页头重复** —— 同一个动作两处入口，迟早不一致 |
 * | 文案里的"并行管理页" | 那一页现在是多页外壳（账号中心 + 翻译面板） |
 *
 * ⇒ 登录与身份操作**只有一处**：账号中心的**一级导航栏右侧**。
 *   弹窗只剩：这是什么（品牌）· 现在什么状况（统计）· 去哪儿（打开管理页）。
 *
 * ★ 轮盘统一走快捷键（`Alt+Q`）；站点授权在管理页完成。
 */

document.getElementById('ext-version')!.textContent = `v${EXT_VERSION}`;

function openParallelPage(): void {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/parallel/parallel.html') });
  window.close();
}

document.getElementById('open-parallel')!.addEventListener('click', openParallelPage);

/* ---- 实时统计：账号 / 在线 / 授权站点 ---- */
function setStat(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = String(value);
  }
}

async function refreshStats(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ kind: 'par.list' })) as
      | { kind: 'par.list'; result: { ok: boolean; data?: Array<{ tabIds?: number[] }> } }
      | undefined;
    const accounts = res?.result?.ok && Array.isArray(res.result.data) ? res.result.data : [];
    setStat('stat-accounts', accounts.length);
    setStat('stat-online', accounts.filter((a) => (a.tabIds?.length ?? 0) > 0).length);
  } catch (e) {
    // ★ 账号/在线两个数字显示 `—`。用户看不出"后台没应答"与"确实一个账号都没有"
    //   的区别 ⇒ 必须留痕（规则 25/29）。
    log.warn('读账号统计失败 ⇒ 弹窗显示 —（与"没有账号"不可分）: %s', e instanceof Error ? e.message : String(e));
    setStat('stat-accounts', '—');
    setStat('stat-online', '—');
  }
  try {
    const all = await chrome.permissions.getAll();
    const hosts = new Set<string>();
    for (const o of all.origins ?? []) {
      const m = /^(?:\*|https?):\/\/([^/]+)(?:\/.*)?$/.exec(o);
      if (m && m[1] !== '*') {
        hosts.add(m[1]);
      }
    }
    setStat('stat-sites', hosts.size);
  } catch (e) {
    log.warn('读授权站点数失败 ⇒ 弹窗显示 —: %s', e instanceof Error ? e.message : String(e));
    setStat('stat-sites', '—');
  }
}

void refreshStats();

/* ---- 更新提醒（v4.2.55）：只给"去下载"，不做任何自动更新 ---- */
async function refreshUpdateHint(): Promise<void> {
  const el = document.getElementById('update-hint') as HTMLAnchorElement | null;
  if (el === null) return;
  try {
    const res = (await chrome.runtime.sendMessage({ kind: 'update.state' })) as
      | { kind: 'update.state'; result: { ok: boolean; data?: { currentVersion: string; latestVersion: string | null; releaseUrl: string | null; dismissedVersion: string | null } } }
      | undefined;
    const data = res?.result?.ok ? res.result.data : undefined;
    if (data === undefined || data.latestVersion === null) return;
    if (!isNewerVersion(data.latestVersion, data.currentVersion)) return;
    if (data.dismissedVersion === data.latestVersion) return;
    el.textContent = `发现新版本 v${data.latestVersion} · 去 GitHub 下载`;
    if (data.releaseUrl !== null) el.href = data.releaseUrl;
    el.classList.remove('hidden');
  } catch (e) {
    // ★ 更新提醒不出现 = 用户以为"已是最新"。这正是规则 29 里
    //   "只有'和成功一样'的才进白名单"的反例 —— 它连白名单都不该进，必须留痕。
    log.warn('更新提醒查询失败 ⇒ 弹窗不显示新版本（看着像"已是最新"）: %s', e instanceof Error ? e.message : String(e));
  }
}

void refreshUpdateHint();

/* ---- 手动检查（v4.2.56）：点一下就去问 GitHub，不受 6 小时自动检查节流限制 ---- */
const popupCheck = document.getElementById('popup-check') as HTMLButtonElement | null;
const updateStatus = document.getElementById('update-status') as HTMLSpanElement | null;
const updateHintEl = document.getElementById('update-hint') as HTMLAnchorElement | null;

popupCheck?.addEventListener('click', async () => {
  const idleText = popupCheck.textContent ?? '检查更新';
  popupCheck.disabled = true;
  popupCheck.textContent = '检查中…';
  if (updateStatus !== null) updateStatus.textContent = '';
  try {
    const res = (await chrome.runtime.sendMessage({ kind: 'update.check' })) as
      | { kind: 'update.check'; result: { ok: boolean; data?: { currentVersion: string; latestVersion: string | null; releaseUrl: string | null; error: string | null }; error?: string } }
      | undefined;
    if (res === undefined || res.kind !== 'update.check') {
      if (updateStatus !== null) updateStatus.textContent = '检查失败：后台没有响应';
      return;
    }
    if (!res.result.ok) {
      if (updateStatus !== null) updateStatus.textContent = `检查失败：${res.result.error ?? '未知原因'}`;
      return;
    }
    const data = res.result.data;
    if (data === undefined) {
      if (updateStatus !== null) updateStatus.textContent = '检查失败：后台没有返回结果';
      return;
    }
    if (data.error !== null) {
      if (updateStatus !== null) updateStatus.textContent = `检查失败：${data.error}`;
      return;
    }
    if (data.latestVersion !== null && isNewerVersion(data.latestVersion, data.currentVersion)) {
      if (updateStatus !== null) updateStatus.textContent = `发现 v${data.latestVersion}`;
      if (updateHintEl !== null) {
        updateHintEl.textContent = `发现新版本 v${data.latestVersion} · 去 GitHub 下载`;
        if (data.releaseUrl !== null) updateHintEl.href = data.releaseUrl;
        updateHintEl.classList.remove('hidden');
      }
    } else {
      if (updateStatus !== null) updateStatus.textContent = `已是最新（v${data.currentVersion}）`;
    }
  } catch (e) {
    log.warn('手动检查更新失败（弹出层显示「检查失败」）: %s', e instanceof Error ? e.message : String(e));
    if (updateStatus !== null) updateStatus.textContent = '检查失败';
  } finally {
    popupCheck.disabled = false;
    popupCheck.textContent = idleText;
  }
});