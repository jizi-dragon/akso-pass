import { EXT_VERSION } from '../../shared/constants';

/**
 * 弹窗 = 品牌入口 + 云端身份 + 实时统计 + 主操作。
 *
 * # v4.2.1 的三处变化（用户 2026-10-12 要求）
 *
 * | 要求 | 落点 |
 * |---|---|
 * | "打开并行管理页" → **"打开管理页"** | 那一页现在同时承载账号中心与翻译面板，"并行"已不准确 |
 * | 去掉常驻的"登录云端账号库" | 它改成**按登录态显示**：未登录才出现"登录" |
 * | 点已登录账号 → **"同步数据" / "退出账号"** | 新增身份区 + 下拉菜单 |
 *
 * # ★ 登出的语义（请求 5）：清"缓存"，不清云端
 *
 * "退出账号"= ① 清 `ql:cloudAuth`（本机不再持有令牌）② 清**本机缓存的账号数据**
 * （只读快照 + 账号/站点/盒子的短命缓存）。**云端账号库一条都不动** ——
 * 用户是"退出登录"，不是"注销账号"，把这两件事混起来会毁掉别人的数据。
 * 判据：登出后 `account-cache` 为空、`ql:cloudAuth` 为 null，而重新登录后数据原样回来。
 */
document.getElementById('ext-version')!.textContent = `v${EXT_VERSION}`;

function openParallelPage(): void {
  chrome.tabs.create({ url: chrome.runtime.getURL('ui/parallel/parallel.html') });
  window.close();
}

document.getElementById('open-parallel')!.addEventListener('click', openParallelPage);

/* ---- 云端账号库（Akso Vault） ----
 * 登录、注册与账号管理**都在浏览器官网上完成**，扩展只负责把用户送过去。
 * ★ 扩展刻意**不内置登录表单**：口令一旦流经扩展的 DOM，就多了一个必须被信任的界面，
 *   而扩展的职责是"执行面"，不是"凭据收集面"。
 */
const VAULT_URL = 'https://www.dragonrain.top:8443/';

function openVault(): void {
  chrome.tabs.create({ url: VAULT_URL });
  window.close();
}

document.getElementById('open-vault')!.addEventListener('click', openVault);

/* ---- 实时统计：账号 / 在线 / 授权站点 ---- */
function setStat(id: string, value: string | number): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = String(value);
  }
}

/* ---- 身份区 ---- */
const identityEl = document.getElementById('identity') as HTMLElement;
const identityBtn = document.getElementById('identity-btn') as HTMLButtonElement;
const identityMenu = document.getElementById('identity-menu') as HTMLElement;
const identityAvatar = document.getElementById('identity-avatar') as HTMLElement;
const identityName = document.getElementById('identity-name') as HTMLElement;
const identitySub = document.getElementById('identity-sub') as HTMLElement;
const openVaultBtn = document.getElementById('open-vault') as HTMLButtonElement;
const menuSync = document.getElementById('menu-sync') as HTMLButtonElement;
const menuLogout = document.getElementById('menu-logout') as HTMLButtonElement;

function closeMenu(): void {
  identityMenu.classList.add('hidden');
  identityBtn.setAttribute('aria-expanded', 'false');
}

identityBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = identityMenu.classList.toggle('hidden');
  identityBtn.setAttribute('aria-expanded', open ? 'false' : 'true');
});
// 点外部 / Esc 关闭（与 parallel.html 的帮助气泡同一套习惯）
document.addEventListener('click', () => closeMenu());
identityMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMenu();
  }
});

/**
 * 云端登录态 → 界面。
 *
 * ★ 三态要分清，不能只判"有没有 token"：
 *   · 已登录 → 显示头像 + 名字，点开是操作菜单
 *   · **未登录** → 显示"登录"按钮（用户要求 6）
 *   · **状态未知**（拿不到 `cloud.state`，例如 SW 冷启失败）→ **按未登录显示**。
 *     理由：把"不知道"显示成"已登录"会让用户以为自己还登着，而下一步操作必然失败；
 *     显示成未登录最多是让他多点一次登录。**不确定时选那个"失败得更明显"的分支。**
 */
async function renderIdentity(): Promise<void> {
  let authed = false;
  let display = '';
  let avatar = '';
  try {
    const res = (await chrome.runtime.sendMessage({ kind: 'cloud.state' })) as
      | {
          result?: {
            ok?: boolean;
            data?: { authorized?: boolean; email?: string; displayName?: string; avatar?: string };
          };
        }
      | undefined;
    const data = res?.result?.data;
    authed = data?.authorized === true;
    // ★ 服务端有 `displayName` 就用它，回落成邮箱（`CloudAuth` 注释里写明"显示与鉴权分开"）
    display = data?.displayName?.trim() || data?.email?.trim() || '';
    avatar = data?.avatar ?? '';
  } catch {
    authed = false; // 拿不到状态 ⇒ 按未登录显示（见函数头注释）
  }

  identityEl.classList.toggle('hidden', !authed);
  openVaultBtn.classList.toggle('hidden', authed);

  if (!authed) {
    return;
  }
  const label = display || '已登录云端';
  identityName.textContent = label;
  identitySub.textContent = '云端账号库 · 点此管理';
  // 有头像 URL 就用图，否则用名字首字。**不把 URL 直接塞进 img.src** 前先判空，
  // 否则空 src 会让浏览器去请求当前页面 URL（一个经典的静默 bug）。
  if (avatar) {
    identityAvatar.textContent = '';
    identityAvatar.style.backgroundImage = `url("${avatar.replace(/"/g, '%22')}")`;
    identityAvatar.classList.add('has-img');
  } else {
    identityAvatar.style.backgroundImage = '';
    identityAvatar.classList.remove('has-img');
    identityAvatar.textContent = (label.trim()[0] ?? '·').toUpperCase();
  }
}

/* ---- 菜单动作 ---- */
menuSync.addEventListener('click', () => {
  closeMenu();
  void (async () => {
    menuSync.disabled = true;
    const original = menuSync.querySelector('b')?.textContent ?? '同步数据';
    const label = menuSync.querySelector('b');
    if (label) {
      label.textContent = '同步中…';
    }
    try {
      const res = (await chrome.runtime.sendMessage({ kind: 'cloud.sync' })) as
        | { result?: { ok?: boolean; error?: string } }
        | undefined;
      if (res?.result?.ok) {
        if (label) {
          label.textContent = '已同步 ✓';
        }
        await refreshStats();
        setTimeout(() => {
          if (label) {
            label.textContent = original;
          }
        }, 1600);
      } else {
        // ★ 失败要说出来：静默失败会让用户以为"同步过了"，而数据其实没动
        if (label) {
          label.textContent = `同步失败：${(res?.result?.error ?? '未知原因').split('\n')[0].slice(0, 18)}`;
        }
        setTimeout(() => {
          if (label) {
            label.textContent = original;
          }
        }, 3200);
      }
    } finally {
      menuSync.disabled = false;
    }
  })();
});

menuLogout.addEventListener('click', () => {
  closeMenu();
  if (!confirm('退出云端账号？\n\n· 本机将清除登录令牌与缓存的账号数据\n· 云端账号库里的数据不受影响，重新登录即可恢复')) {
    return;
  }
  void (async () => {
    try {
      await chrome.runtime.sendMessage({ kind: 'cloud.logout' });
    } catch {
      // 消息失败也要继续刷新界面 —— 否则用户看到的是"点了没反应"
    }
    await renderIdentity();
    await refreshStats();
  })();
});

/* ---- 统计 ---- */
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

void (async () => {
  await renderIdentity();
  await refreshStats();
})();
