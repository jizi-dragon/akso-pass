import { EXT_VERSION } from '../../shared/constants';

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
  } catch {
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
  } catch {
    setStat('stat-sites', '—');
  }
}

void refreshStats();
