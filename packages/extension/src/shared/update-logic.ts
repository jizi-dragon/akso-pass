/**
 * 更新提醒的**纯逻辑**（不碰 chrome.*，可被 Node 直接测）。
 *
 * 产品口径（2026-11-09 用户确认）：
 *   · 只提醒、**不自动更新**：发现新版本 → 角标 + 页面横幅 → 打开 GitHub Releases；
 *   · 由用户自己下载安装；
 *   · **用户必须知情**：横幅同时显示"当前版本 / 最新版本 / 不会自动更新"。
 *
 * 设计取舍：
 *   · 用 GitHub Releases API（公开、带 ETag，未认证 60 次/小时/IP）；
 *   · 不做"静默升级"：本模块没有任何下载/安装动作，只有 URL；
 *   · 版本比较只认 `v?数字.数字.数字`，预发布版排在正式版之前。
 */

export const UPDATE_REPO = 'jizi-dragon/akso-pass'
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
export const UPDATE_RELEASES_URL = `https://github.com/${UPDATE_REPO}/releases/latest`

/** 两次自动检查之间的最小间隔（浏览器启动/定时器都会走这里）。 */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdateState {
  /** 本机扩展版本（来自 manifest / EXT_VERSION） */
  currentVersion: string
  /** GitHub 上最新版本的版本号（去掉 v 前缀）；拉取失败时为 null */
  latestVersion: string | null
  /** Releases 页面地址（优先 release.html_url） */
  releaseUrl: string | null
  releaseName: string | null
  publishedAt: string | null
  /** 上次成功检查的时间（毫秒）；失败也更新，用于退避 */
  checkedAt: number | null
  /** 最近一次检查失败的原因（成功时清空） */
  error: string | null
  /** 用户点过"忽略此版本"的版本号：同一版本不再打扰 */
  dismissedVersion: string | null
  /** GitHub 的 ETag：下次带 If-None-Match，省配额 */
  etag: string | null
}

export interface ReleaseInfo {
  version: string
  url: string
  name: string
  publishedAt: string | null
}

export function emptyUpdateState(currentVersion: string): UpdateState {
  return {
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    releaseName: null,
    publishedAt: null,
    checkedAt: null,
    error: null,
    dismissedVersion: null,
    etag: null,
  }
}

/**
 * 把 `storage.local` 里的原始值归一成 `UpdateState`（缺字段/旧形状/坏数据都安全）。
 * `currentVersion` 永远用**当前运行版本**覆盖，避免升级后仍显示旧版本号。
 */
export function applyUpdateDefaults(raw: unknown, currentVersion: string): UpdateState {
  const base = emptyUpdateState(currentVersion)
  if (raw === null || typeof raw !== 'object') return base
  const record = raw as Record<string, unknown>
  const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null)
  const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    currentVersion,
    latestVersion: str(record.latestVersion),
    releaseUrl: str(record.releaseUrl),
    releaseName: str(record.releaseName),
    publishedAt: str(record.publishedAt),
    checkedAt: num(record.checkedAt),
    error: str(record.error),
    dismissedVersion: str(record.dismissedVersion),
    etag: str(record.etag),
  }
}

/** `v4.2.54` → `4.2.54`；去掉构建元数据；保留预发布后缀。 */
export function normalizeVersion(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  return text.replace(/^v/i, '').split('+')[0]
}

function splitVersion(version: string): { parts: number[]; prerelease: string } {
  const [core, ...rest] = version.split('-')
  const parts = core.split('.').map((part) => {
    const value = Number.parseInt(part, 10)
    return Number.isFinite(value) ? value : 0
  })
  while (parts.length < 3) parts.push(0)
  return { parts: parts.slice(0, 3), prerelease: rest.join('-') }
}

/** a > b 返回正数，a < b 返回负数，相等返回 0（预发布版低于同号正式版）。 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(normalizeVersion(a))
  const right = splitVersion(normalizeVersion(b))
  for (let i = 0; i < 3; i += 1) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i]
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease > right.prerelease ? 1 : -1
}

export function isNewerVersion(latest: string | null, current: string): boolean {
  if (latest === null || latest === '') return false
  const normalized = normalizeVersion(latest)
  if (!/^\d+\.\d+\.\d+/.test(normalized)) return false
  return compareVersions(normalized, current) > 0
}

/** 从 GitHub `releases/latest` 响应里取出需要的最小信息；形状不对返回 null。 */
export function parseReleasePayload(payload: unknown): ReleaseInfo | null {
  if (payload === null || typeof payload !== 'object') return null
  const record = payload as Record<string, unknown>
  const tag = typeof record.tag_name === 'string' ? record.tag_name : ''
  const version = normalizeVersion(tag)
  if (!/^\d+\.\d+\.\d+/.test(version)) return null
  const url = typeof record.html_url === 'string' && record.html_url !== '' ? record.html_url : UPDATE_RELEASES_URL
  const name = typeof record.name === 'string' && record.name !== '' ? record.name : tag
  const publishedAt = typeof record.published_at === 'string' ? record.published_at : null
  return { version, url, name, publishedAt }
}

/** 是否应该提醒：有新版本，且用户没有忽略这个版本。 */
export function shouldPrompt(state: UpdateState): boolean {
  return isNewerVersion(state.latestVersion, state.currentVersion)
    && state.dismissedVersion !== state.latestVersion
}

/** 自动检查是否已经够久（`force` 时忽略）。 */
export function shouldAutoCheck(state: UpdateState | null, now: number): boolean {
  if (state === null || state.checkedAt === null) return true
  return now - state.checkedAt >= UPDATE_CHECK_INTERVAL_MS
}
