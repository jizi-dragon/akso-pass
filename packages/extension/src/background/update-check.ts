/**
 * 更新提醒（后台半边）—— **只提醒，不自动更新**。
 *
 * 产品口径（2026-11-09 用户确认）：
 *   · 打开浏览器时若发现新版本 → 角标 + 页面横幅提醒；
 *   · 点击跳转 GitHub Releases，由用户**自己下载安装**；
 *   · 无论是否更新，用户必须知情：横幅显示"当前 / 最新 / 不会自动更新"。
 *
 * 触发点：
 *   · `chrome.runtime.onStartup`（浏览器启动）；
 *   · `chrome.runtime.onInstalled`（安装/更新本扩展）；
 *   · `chrome.alarms` 每 6 小时（SW 会被回收，不能靠 setTimeout）；
 *   · 用户点"检查更新"（`update.check`）。
 *
 * 网络：akso-cloud 自托管的 `latest.json`（不再直连 GitHub API，避免匿名配额）。
 * 失败**绝不影响任何业务功能**，只把原因记进 `UpdateState.error`，UI 里可显示"上次检查失败"。
 */
import { EXT_VERSION, LOCAL_KEYS } from '../shared/constants';
import {
  applyUpdateDefaults,
  emptyUpdateState,
  parseReleasePayload,
  shouldAutoCheck,
  shouldPrompt,
  UPDATE_FEED_URL,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_RELEASES_URL,
  type UpdateState,
} from '../shared/update-logic';

const ALARM_NAME = 'akso-pass:update-check';
const ALARM_PERIOD_MINUTES = UPDATE_CHECK_INTERVAL_MS / 60_000;
const FETCH_TIMEOUT_MS = 8_000;

async function readState(): Promise<UpdateState> {
  try {
    const stored = await chrome.storage.local.get(LOCAL_KEYS.updateState);
    return applyUpdateDefaults(stored[LOCAL_KEYS.updateState], EXT_VERSION);
  } catch {
    return emptyUpdateState(EXT_VERSION);
  }
}

async function writeState(state: UpdateState): Promise<void> {
  try {
    await chrome.storage.local.set({ [LOCAL_KEYS.updateState]: state });
  } catch {
    // 存储失败不影响提醒的"本次会话"语义；下次会重新读默认值
  }
}

/** 角标：有新版本才亮；不修改图标。 */
export function applyUpdateBadge(state: UpdateState): void {
  const pending = shouldPrompt(state);
  try {
    void chrome.action.setBadgeText({ text: pending ? '1' : '' });
    if (pending) {
      void chrome.action.setBadgeBackgroundColor({ color: '#B00020' });
      void chrome.action.setTitle({
        title: `发现新版本 v${state.latestVersion}（当前 v${state.currentVersion}）· 点击查看`,
      });
    } else {
      void chrome.action.setTitle({ title: `Akso Pass v${state.currentVersion}` });
    }
  } catch {
    // SW 冷启动瞬间 action 偶发不可用；提醒是"尽力而为"，不能抛
  }
}

export async function getUpdateState(): Promise<UpdateState> {
  const state = await readState();
  if (state.currentVersion !== EXT_VERSION) {
    state.currentVersion = EXT_VERSION;
    await writeState(state);
  }
  applyUpdateBadge(state);
  return state;
}

/**
 * 检查一次。`force=false` 时受 6 小时间隔约束（启动/定时器走这条）；
 * 用户点"检查更新"用 `force=true`。
 */
export async function checkForUpdate(options: { force?: boolean } = {}): Promise<UpdateState> {
  const state = await readState();
  state.currentVersion = EXT_VERSION;
  const now = Date.now();
  if (options.force !== true && !shouldAutoCheck(state, now)) {
    applyUpdateBadge(state);
    return state;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(UPDATE_FEED_URL, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    /*
     * fetch 期间用户/其它页面可能已经改过 state（忽略版本、手动检查、
     * 或测试直接写入）。写入前重新读一次，避免把旧快照覆盖回去。
     */
    const next = await readState();
    next.currentVersion = EXT_VERSION;
    next.checkedAt = now;
    if (!response.ok) {
      next.error = `HTTP ${response.status}`;
      await writeState(next);
      applyUpdateBadge(next);
      return next;
    }
    const release = parseReleasePayload(await response.json());
    if (release === null) {
      next.error = '发布信息格式不正确';
      await writeState(next);
      applyUpdateBadge(next);
      return next;
    }
    next.latestVersion = release.version;
    next.releaseUrl = release.url !== '' ? release.url : UPDATE_RELEASES_URL;
    next.releaseName = release.name;
    next.publishedAt = release.publishedAt;
    next.error = null;
    await writeState(next);
    applyUpdateBadge(next);
    return next;
  } catch (error) {
    const next = await readState();
    next.currentVersion = EXT_VERSION;
    next.checkedAt = now;
    next.error = error instanceof Error ? error.message : String(error);
    await writeState(next);
    applyUpdateBadge(next);
    return next;
  } finally {
    clearTimeout(timer);
  }
}

/** 用户点"忽略此版本"：同一版本不再打扰（换新版本会重新提醒）。 */
export async function dismissUpdate(version?: string): Promise<UpdateState> {
  const state = await readState();
  state.currentVersion = EXT_VERSION;
  const target = typeof version === 'string' && version !== '' ? version : state.latestVersion;
  if (target !== null) state.dismissedVersion = target;
  await writeState(state);
  applyUpdateBadge(state);
  return state;
}

/** 打开 Releases 页面（**不下载**、不安装）。 */
export async function openReleasePage(): Promise<string> {
  const state = await readState();
  const url = state.releaseUrl !== null && state.releaseUrl !== '' ? state.releaseUrl : UPDATE_RELEASES_URL;
  await chrome.tabs.create({ url });
  return url;
}

/** 注册所有触发点；在 SW 顶层调用一次。 */
export function registerUpdateCheck(): void {
  try {
    chrome.runtime.onStartup.addListener(() => {
      void checkForUpdate();
    });
    chrome.runtime.onInstalled.addListener((details) => {
      if (details.reason === 'install' || details.reason === 'update') {
        void checkForUpdate({ force: true });
      }
    });
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm.name === ALARM_NAME) void checkForUpdate();
    });
    void chrome.alarms.get(ALARM_NAME).then((existing) => {
      if (existing === undefined) {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
      }
    }).catch(() => {
      // 拿不到 alarms（权限缺失/旧浏览器）时退化为"仅启动与手动检查"
    });
    // 浏览器启动时 SW 不一定立刻醒：这里再兜一次"首次打开且从未检查过"的场景
    void checkForUpdate();
  } catch {
    // 更新提醒是附加能力，任何一步失败都不能影响 SW 的主体逻辑
  }
}
