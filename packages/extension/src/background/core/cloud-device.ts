import type { CloudDevicePoll, CloudDeviceStart } from '../../shared/messages';
import {
  CLOUD_DEFAULT_BASE_URL,
  anonymousRequest,
  fetchMeEmail,
  invalidateCloudCache,
  setCloudAuth,
} from './cloud-store';
// ★ 日志（AGENTS.md 规则 22 / 25）。
//   ★★ 本模块的**纪律**（见下面 `deviceCode` 那段）：`deviceCode` 是**一次性凭据**，
//     **绝不进日志**。所以这里所有日志只记"事件 + 不敏感的量"（长度 / 状态名 / 是否有值），
//     一律不记 `deviceCode` / `userCode` / `token` 本身 —— 虽然 `log()` 会打码，
//     但凭据类的东西**连给它打码的机会都不该给**（规则 3 的同一条精神）。
import { getLogger } from '../../shared/log';

const log = getLogger('cloud-device');

/**
 * 云端账号库的设备授权（**RFC 8628 设备流**，v3.14.1 起取代"网页出码、人抄进应用"）。
 *
 * 三步：
 *   1. `POST /api/auth/device-start` → 服务端给 `deviceCode`（**设备自己留着**）+ `userCode`（给人看的）
 *      + `verificationUrl`（服务端拼好的批准页，设备端**直接打开**，不自己拼）。
 *   2. 浏览器里批准（用户在那边登录并点批准）。
 *   3. `POST /api/auth/device-poll` 按 `interval` 秒问一次：approved → 令牌只发一次。
 *
 * ★★ `deviceCode` 的处置纪律（它等价于一次性凭据）：
 *    - **只活在这个模块的内存里**（`session`），不进 `chrome.storage`、不进 DOM、不进日志、不回传页面；
 *    - 流程走到任何终态（approved / denied / expired / consumed / unknown）或用户取消时，
 *      `session` 一律置 null —— 进程重启就等于忘掉它（这也是服务端 `consumed` 状态存在的原因）。
 *
 * ★ 排程不在这里：`pollDeviceFlow()` 只回答"现在怎么样"，**节拍由页面那一个循环按 `interval` 决定**
 *   （这样"取消后真的不再发请求"是页面侧一个布尔量的事，不需要在这里维护定时器 + 中止逻辑）。
 */

/** 设备自报的名字（批准页会显示它，用户据此确认"是我这台浏览器"） */
export const DEVICE_CLIENT_NAME = 'Chrome 扩展 · Akso Pass';
/** 服务端没给 `interval` 时的兜底秒数（观测到服务端会给，这只是"读不到别拿 0 去压测"的兜底） */
const FALLBACK_INTERVAL_S = 3;

interface DeviceSession {
  /** ★ 凭据：换令牌用的长随机串。只在内存里，绝不外传 */
  deviceCode: string;
  baseUrl: string;
  /** 给人看的 8 位码（只用于服务端批准页 / 页面核对用户手输） */
  userCode: string;
  verificationUrl: string;
  /** 当前轮询间隔（秒），服务端每次回包都可以修订它 */
  interval: number;
  /** 本次授权的绝对过期时刻（`expiresIn` 换算而来，页面侧还会自己再兜一层） */
  expiresAt: number;
}

/** 当前这次设备授权；null = 没有进行中的会话（凭据已从内存丢掉） */
let session: DeviceSession | null = null;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 读一个"秒数"字段；读不到/不合理就退到 `fallback`（绝不返回 0：那等于把服务端当压测靶子） */
function seconds(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** 起一次设备授权。**先丢掉上一次会话**：重试就是重新 device-start，绝不复用旧 deviceCode */
export async function startDeviceFlow(clientName: string = DEVICE_CLIENT_NAME): Promise<CloudDeviceStart> {
  // ★ 记"丢弃了上一个会话"：`startDeviceFlow` 会**先丢旧的**，
  //   而这正是"重试"的语义。不记的话，"我点了一次重试，上一次那个码还能用吗"
  //   在日志里无法回答（答案：不能，且服务端那个 `deviceCode` 会走 `consumed`）。
  const replaced = session !== null;
  session = null;
  log.debug('device-start 发起（clientName=%s，丢弃上一个会话=%s）', clientName, replaced);

  const data = asRecord(
    await anonymousRequest<unknown>('/api/auth/device-start', {
      method: 'POST',
      body: { clientName },
    }),
  );

  const deviceCode = str(data.deviceCode) || str(data.device_code);
  const userCode = str(data.userCode) || str(data.user_code);
  const verificationUrl = str(data.verificationUrl) || str(data.verification_uri);
  const expiresIn = seconds(data.expiresIn ?? data.expires_in, 600);
  const interval = seconds(data.interval, FALLBACK_INTERVAL_S);

  if (!deviceCode || !verificationUrl) {
    // 半截响应不能留下来：没有 deviceCode 就换不到令牌，没有 URL 用户就没法批准
    // ★ `warn`：这是**服务端契约被破坏**（或缺字段），而它会直接表现为"登录点了没反应"。
    //   ★ 只记"哪个字段缺"，**不记字段值** —— `deviceCode` 是凭据。
    log.warn('device-start 响应不完整（deviceCode=%s verificationUrl=%s）⇒ 中止',
      deviceCode ? '有' : '缺', verificationUrl ? '有' : '缺');
    throw new Error('云端未返回完整的设备授权信息（deviceCode / verificationUrl 缺失），请重新发起');
  }
  if (!/^https?:\/\//i.test(verificationUrl)) {
    // 地址不由我们拼、也不该盲开：非 http(s) 一律拒（避免把用户送去 file:// 之类的地方）
    // ★ `error`：这一支是**安全拒绝**（防把用户送去 file:// / javascript: 之类的地方），
    //   它不该被当成普通失败略过 —— 走到这里说明服务端给了非 http(s) 的地址。
    //   ★ 记的是**协议**而不是完整 URL（URL 可能带 query 里的敏感参数）。
    log.error('device-start 的批准页地址不是 http(s) ⇒ 已中止（未打开任何页面）');
    throw new Error('云端返回的批准页地址不是 http(s)，已中止（未打开任何页面）');
  }

  session = {
    deviceCode,
    baseUrl: CLOUD_DEFAULT_BASE_URL,
    userCode,
    verificationUrl,
    interval,
    expiresAt: Date.now() + expiresIn * 1000,
  };
  // ★ 记的是**这次会话的形状**（有效期 / 轮询间隔），**不是码本身**。
  //   排障时它回答"轮询间隔是不是被服务端改小了"（那会打爆服务端）与
  //   "这次授权有多久窗口期"。
  log.debug('device-start 成功：expiresIn=%ds interval=%ds（userCode %d 字符，不回显）',
    expiresIn, interval, userCode.length);
  return {
    verificationUrl,
    userCode,
    expiresIn,
    interval,
    clientName: str(data.clientName) || clientName,
  };
}

/**
 * 问一次授权状态（**调用方按 `interval` 秒调**）。
 * 终态一律顺手把 `session` 丢掉；approved 时把令牌落进 `chrome.storage.local`（页面/管理页刷新即可见）。
 */
export async function pollDeviceFlow(): Promise<CloudDevicePoll> {
  const current = session;
  if (!current) {
    // ★ `debug`：这是**预期内**的分支（终态后再问一次、或页面循环没停干净）。
    //   它不是缺陷，但排障时"为什么轮询立刻报错"的答案就在这里。
    log.debug('device-poll：无进行中的会话（已取消 / 已到终态 / 已批准过）');
    throw new Error('设备授权会话已结束（已取消 / 已超时 / 已批准过），请重新发起登录');
  }
  if (Date.now() >= current.expiresAt) {
    session = null;
    // ★ `warn`：**用户在批准页上什么都没做**，授权窗口就过期了。
    //   这与"用户点了拒绝"在界面上都是"登录没成"，而原因完全不同
    //   （一个是他没来得及，一个是他明确拒绝）—— 必须能分开。
    log.warn('device-poll：授权窗口已过期（用户未在批准页操作）⇒ 会话作废');
    return { status: 'expired' };
  }

  const data = asRecord(
    await anonymousRequest<unknown>(
      '/api/auth/device-poll',
      { method: 'POST', body: { deviceCode: current.deviceCode } },
      current.baseUrl,
    ),
  );

  // ★ 请求期间用户可能点了「取消」（或又发起了一次），那时这个会话已经不是"当前"的了：
  //   此时**什么都不能写**（尤其不能把令牌落盘）—— 否则"取消"就成了摆设。
  if (session !== current) {
    // ★★ 这一支是**本轮加日志的重点**，因为它此前**完全静默**：
    //   用户点了「取消」（或又点了一次发起）⇒ 在途的那次 poll 回来后**什么都不做**。
    //
    //   后果：界面上"点了取消，然后就没有然后了" —— 而**服务端其实已经批准了**
    //     （用户可能刚在批准页点了同意，或服务端在请求飞行期间改了状态）。
    //     令牌**被刻意丢掉**（这是对的，否则取消就成了摆设），
    //     但"明明批准了却登不上"这个现象在没有这行日志时**完全无法解释**。
    //
    //   ⇒ 记 `warn` 而不是 `debug`：它描述的是"一次**已成功**的授权被主动丢弃"，
    //     用户会看到"登录没成功"，而原因不在服务端也不在网络。
    log.warn('device-poll：会话已被取消/替换 ⇒ 丢弃本次结果（若服务端已批准，令牌按纪律作废）');
    return { status: 'stopped' };
  }

  const nextInterval = seconds(data.interval, current.interval);
  current.interval = nextInterval;
  const status = str(data.status).toLowerCase();

  if (status === 'approved') {
    const token = str(data.token) || str(asRecord(data.session).token);
    if (!token) {
      session = null;
      // ★ `error`：服务端说批准了却没给令牌 —— 契约被破坏，而用户看到的是"登录失败"。
      log.error('device-poll：服务端已批准但未下发令牌 ⇒ 中止（会话作废）');
      throw new Error('服务端已批准，但没有下发令牌：请重新发起登录');
    }
    const fernetKey = str(data.fernetKey) || str(asRecord(data.user).fernetKey);
    const user = asRecord(data.user);
    let email = str(data.email) || str(user.email);
    // 展示名与头像：**同一条 user 里就有**，顺手存下来 —— 不存的话界面只能显示邮箱
    const displayName = str(user.displayName);
    const avatar = str(user.avatar);
    const baseUrl = current.baseUrl;
    session = null;
    await setCloudAuth({ baseUrl, token, fernetKey, email, displayName, avatar });
    // 换了会话就丢掉上一个会话的快照缓存：新登录的账号**绝不能**读到旧会话的列表
    invalidateCloudCache();
    // ★ 只记"拿到了什么种类的凭据"，**绝不记值**。
    //   `fernetKey` 漏记过就会让"口令解不开"变成一个查不出的问题 ——
    //   所以这里记的是"有没有"，那正是排障需要的粒度。
    log.info('device-poll：approved ⇒ 会话已落盘（token=%s fernetKey=%s email=%s）',
      token ? '有' : '无', fernetKey ? '有' : '无', email ? '有' : '无');
    if (!email) {
      // 邮箱只为界面显示"已登录谁"；取不到不影响可用性，也不该让登录失败
      email = await fetchMeEmail();
      if (email) {
        await setCloudAuth({ baseUrl, token, fernetKey, email, displayName, avatar });
        log.debug('device-poll：补取到邮箱（界面可显示"已登录谁"）');
      } else {
        // ★ 不失败，但**要留痕**：界面会退化成显示空/占位，而那不是缺陷。
        // ★★ 2026-11-09：注释写着"要留痕"，实现却是 `debug` —— 默认 `info` 级下
        //   它既不进内存环、也不进 `ql:log` ⇒ 等于没留。规则 25：失败路径用
        //   debug 记 = 在生产里不存在。改为 `warn`（每条失败只写一次，不是热路径）。
        log.warn('device-poll：补取邮箱失败 ⇒ 界面不显示"已登录谁"（不影响可用性）');
      }
    }
    return { status: 'approved', email };
  }

  if (status === 'pending') {
    // ★ `debug`：**每一轮都会走到**，属热路径（节拍由页面按 `interval` 控制）。
    //   它是"轮询还活着"的证据 —— 生产静默，排障时才需要。
    log.debug('device-poll：pending（用户尚未在批准页操作，interval=%ds）', nextInterval);
    return { status: 'pending', interval: nextInterval };
  }

  // 终态：凭据用完即弃
  session = null;
  if (status === 'denied' || status === 'expired' || status === 'consumed' || status === 'unknown') {
    // ★★ 这四个终态此前**全部静默**，而它们的原因**完全不同**：
    //   · `denied`   —— 用户在批准页**明确拒绝**（他不想登这台浏览器）
    //   · `expired`  —— 服务端侧超时（与上面那个本地 `expiresAt` 是两回事）
    //   · `consumed` —— 这个 deviceCode **已经被用过了**（典型：用户在批准页
    //                   点了两次，或页面循环重复 poll）⇒ 说明**流程有重复提交**
    //   · `unknown`  —— 服务端给了个我们不认识的状态名（契约漂移的早期信号）
    //   ⇒ 用 `warn` 记"哪一个"，让这四种在日志里**分得开**。
    //     不记 `userCode` / `deviceCode`（凭据），只记状态名。
    log.warn('device-poll：终态 %s ⇒ 会话作废（denied=用户拒绝 / expired=服务端超时 / '
      + 'consumed=码已被用过 / unknown=服务端状态名不认识）', status);
    return { status };
  }
  // 不认识的 status 不当成 pending 轮询下去（那会一直问到超时），也不瞎猜语义
  // ★ `error`：走到这里说明服务端给了一个**不在契约里**的状态名（连 `unknown` 都不是）。
  //   记它才能发现"服务端加了新状态而扩展没跟上"。
  log.error('device-poll：未知状态「%s」⇒ 停止轮询（服务端契约漂移？）', status || '(空)');
  throw new Error(`设备授权返回了未知状态「${status || '(空)'}」：已停止轮询，请重新发起登录`);
}

/** 放弃本次授权：`deviceCode` 从内存丢掉。返回是否真的丢掉了一个会话（便于界面/诊断分辨） */
export function cancelDeviceFlow(): boolean {
  const had = session !== null;
  session = null;
  // ★ 记"当时到底有没有会话"：界面拿到 `false` 时会显示"没有进行中的授权"，
  //   而用户可能刚点了取消 —— 这个 `false` 说明**在他点之前会话就已经没了**
  //   （超时 / 已批准 / 已终态）。不记这一行，"我点了取消却提示没有授权"就无从解释。
  log.debug('cancelDeviceFlow：丢掉了会话=%s', had);
  return had;
}
