import { CONTENT_MESSAGE } from '../shared/constants';
import { getLogger } from '../shared/log';

/**
 * Auto-Login：自动填充登录表单并提交。
 * 关键事实：密码框位于同源 `srcdoc` iframe 内（class="ant-input"），而 `<all_urls>` 的
 * content script 不会注入 `about:srcdoc` frame，因此不能用「iframe 各填各」模型——
 * 必须由**顶层 frame 直接访问 iframe.contentDocument 填密码**。
 * 顶层 frame：填用户名 + 访问 srcdoc iframe 填密码 + 勾选协议 + 提交登录。
 * 子 frame（若注入，如跨域外链 iframe）：仅兜底填自身 frame 内的密码。
 * v3.12.2：全流程逐事件上报 background 取证（点击/填充/让位/被拒 → ql:forensics）。
 */
let credentials: { username: string; password: string } | null = null;

/**
 * 本模块的 logger。
 *
 * ★ **不要在这里用裸 `console.*`**：本模块手上就有用户的真实口令
 *   （`credentials`），而 `console.debug('...', obj)` 这种**对象直传**
 *   是最容易顺手泄密的形态。`getLogger` 出来的方法在写出前**强制打码**。
 *   判据：`node tools/verify/log-redaction.mjs` 的第 5 节会扫出所有裸 console。
 */
const log = getLogger('auto-login');

function isTopFrame(): boolean {
  return window === window.top;
}

/** 取证上报：进入 background 的 forensics 环形缓冲（密码/用户名绝不入日志） */
function report(ev: string, extra: Record<string, unknown> = {}): void {
  try {
    void chrome.runtime
      .sendMessage({ type: CONTENT_MESSAGE.autoLoginEvent, event: { ev, top: isTopFrame(), ...extra } })
      .catch(() => undefined);
  } catch {
    // 取证失败不影响业务
  }
}

/** 写入值并触发原生 setter + input/change 事件（兼容 React/Ant Design 受控组件）。
 * 密码框位于 iframe 内，需用该 iframe 自身 realm 的构造器触发，跨 realm 才可靠。 */
function setValue(el: HTMLInputElement, value: string, win: Window): void {
  const realm = win as unknown as {
    HTMLInputElement: typeof HTMLInputElement;
    Event: typeof Event;
  };
  const setter = Object.getOwnPropertyDescriptor(realm.HTMLInputElement.prototype, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new realm.Event('input', { bubbles: true }));
  el.dispatchEvent(new realm.Event('change', { bubbles: true }));
}

function fillUsername(): boolean {
  const field =
    document.querySelector<HTMLInputElement>('input[placeholder="请输入用户名"]') ||
    document.querySelector<HTMLInputElement>('input[type="text"]');
  if (field && credentials && field.value !== credentials.username) {
    setValue(field, credentials.username, window);
    return true;
  }
  return Boolean(field);
}

/** 顶层直接访问 srcdoc/同源 iframe，把密码填进 iframe 内的 password 输入框 */
function fillPasswordInIframes(): boolean {
  const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe');
  for (const iframe of Array.from(iframes)) {
    try {
      const doc = iframe.contentDocument;
      const win = iframe.contentWindow;
      if (!doc || !win) {
        continue;
      }
      const field =
        doc.querySelector<HTMLInputElement>('input[type="password"]') ||
        doc.querySelector<HTMLInputElement>('input[placeholder*="密码"]') ||
        doc.querySelector<HTMLInputElement>('input[placeholder*="password"]');
      if (field && credentials && field.value !== credentials.password) {
        // 值为空/被框架重渲染清掉时才回填（防御 srcdoc 重渲染清值）
        setValue(field, credentials.password, win);
      }
      return Boolean(field);
    } catch {
      // 跨域 iframe 无法从顶层访问；由该 frame 自身注入的 content script 兜底填充
    }
  }
  return false;
}

function checkAgreement(): void {
  const box =
    (document.getElementById('privacyChecked') as HTMLInputElement | null) ||
    Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((el) =>
      /同意|agree/i.test(`${el.name || ''} ${el.ariaLabel || ''} ${el.labels?.[0]?.textContent || ''}`),
    );
  if (box && !box.checked) {
    box.click();
  }
}

function findSubmit(): HTMLButtonElement | null {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  return buttons.find((b) => /登录|登\s*录|login|submit/i.test(b.textContent || '')) || null;
}

/** 顶层：填用户名 + 密码（iframe）+ 勾选协议；自愈式提交（v3.10.7 节奏门控）。
 *  提交五重门控：①字段齐备（任一填充失败绝不点击——密码 iframe 未就绪时空密码提交
 *  即「密码错误」报错的根因）；②提交前回读凭据与 DOM 值一致（受控组件状态落地）；
 *  ③按钮可用；④用户未接管；⑤服务端未连续拒绝（点击后观察期出现 antd 风格错误提示 →
 *  容忍一次重填重试，再错即停止让位——盲目重试会与用户点击竞争并可能触发验证码/锁定）。
 *  节奏：MutationObserver + iframe load 即时触发 attempt（密码框挂载即填，压缩
 *  用户手动点击撞上未填充状态的窗口），800ms 轮询兜底。
 *
 *  ★★ v4.1.4：「试次」的记账口径修正（PITFALLS #39）——**只有点击真正送达才消耗试次**。
 *  此前 `attempts++` 发生在**调度**点击时，而点击还能在那 500ms 后被齐备/回读中止
 *  （`click-aborted`）。于是被中止的轮次**白吃一次试次**，还会因为 `lastClickAt` 也被
 *  提前设置而**白开一个 3.5s 观察窗**：4 次被中止的轮次就直接停手
 *  （当时的 reason 字面量是 max-attempts，已随记账口径改名），
 *  而扩展**一次都没点过**；在那 3.5s 窗口里更没有任何一次重填（`attempt()` 在观察窗
 *  分支直接 return），所以密码框会长时间停在空态。
 *  ⇒ 现在 `posts` 的含义是**已送达的点击**，与「服务端收到了几次」一一对应；
 *    防无限循环由 `deadline`（30s 硬界）与 `errorSeen` 承担，**不依赖这个上限**。
 *
 *  ★ v4.1.4 第二项：用户「点了按钮」与用户「改了凭据」**分开处置**。
 *  此前两者都置 `takenOver` ⇒ 用户在填充完成前手点一下按钮，自动流程就**永久停手**，
 *  于是密码没填、表单校验报错，而用户之后怎么点都没有补充动作。
 *  现在：改凭据 ⇒ 立即停手且**绝不覆盖用户输入**；点按钮 ⇒ 扩展**让位不抢**，
 *  但仍观察服务端反馈并把结果记进取证（不含口令）。
 *
 *  ★ 诚实边界：**"空密码提交"的确切成因尚未实证**。本文件里回读与点击是**同一次
 *  同步执行**（见下方 500ms 回调），两者之间没有可插入的窗口 —— 用 mock 平台构造
 *  "读通过、POST 时值已失效"的场景**试过两种构造都失败**（详见
 *  `tmp/verify-authorace.mjs` 顶部说明）。本轮修的是**可复现的那一半**：中止轮次吃掉
 *  试次、以及观察窗期间无人重填。真机上的空密码提交仍需一份 `ql:forensics` 诊断包
 *  才能定位（见 `docs/FEASIBILITY-SSO-QUICKLOGIN.md` §7.1）。 */
function runTopFrameFlow(): void {
  const deadline = Date.now() + 30_000;
  /** ★ 已**送达**的点击次数（= 服务端实际收到几次提交），不是调度次数 */
  let posts = 0;
  let lastClickAt = 0;
  /** 用户改写了凭据字段（trusted 键入/清空）—— 硬让位 */
  let userTouched = false;
  /** 用户点了按钮 —— 让位但不抢；仍观察服务端反馈 */
  let userClicked = false;
  /** 防重入：点击回调挂起期间（500ms 窗口）不再调度第二次点击 */
  let clickPending = false;
  let absentStreak = 0;
  let errorSeen = 0; // 提交后观察期内的服务端拒绝次数（错误提示出现）
  let errorFlagged = false; // 本次点击观察期是否已标记过错误（防重复计数）
  let errorsAtLastClick = 0;
  let lastFillOk: boolean | null = null;
  let stopped = false;
  let timer: number | undefined;
  const stop = (reason: string): void => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer !== undefined) {
      window.clearInterval(timer);
    }
    report('stand-down', { reason, posts, userClicked, errorSeen });
  };

  /** 硬让位判定（改凭据）：不记 stand-down —— 那是**交付成功**，不是失败。
   *  ★ 判据：报 `stand-down` 的每条路径都必须是「扩展没能完成登录」；
   *    用户自己接管成功时若也报，统计上就无法区分"失败"与"用户接手"。 */
  const takenOver = (): boolean => userTouched;

  /** 用户已改写字段值（trusted 键入或手动清空）= 接管；预期值非空才可比对 */
  const detectUserEdit = (el: HTMLInputElement | null, expected: string): void => {
    if (el && expected && el.value && el.value !== expected) {
      userTouched = true;
    }
  };

  // 用户手动键入凭据字段 = 接管（勾选框/协议等其它 input 不算）
  window.addEventListener(
    'input',
    (e) => {
      const t = e.target as HTMLInputElement | null;
      if (e.isTrusted && t instanceof HTMLInputElement && (t.type === 'text' || t.type === 'password' || t.type === '')) {
        userTouched = true;
        log.debug('user edits credentials field, stand down');
      }
    },
    { capture: true },
  );

  // 用户点击按钮 = **让位但不抢**：自动流程不再追加点击（不覆盖用户的动作），
  // 但仍继续观察服务端反馈，并把「用户是否点过」记进取证（自动点击自身的 click
  // 事件 isTrusted=false 不会触发；勾选协议同理由 checkAgreement 内部处理）。
  // ★ v4.1.4：此前这里直接 `userTouched = true` ⇒ 立即停手。而用户在填充完成前
  //   手点一下（哪怕只是因为"看起来已经填好了"）就会让扩展永久退出，
  //   之后密码没填、校验报错、用户再点也无效 —— 这正是"登不上"的一半成因。
  window.addEventListener(
    'click',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (e.isTrusted && t?.closest?.('button')) {
        userClicked = true;
        log.debug('user clicks a button, extend stands down from clicking');
      }
    },
    { capture: true },
  );

  /** 错误提示元素计数（antd 系登录平台的失败反馈：message/alert/表单校验错误） */
  const countErrors = (): number =>
    document.querySelectorAll(
      '.ant-message-error, .ant-message-notice-error, .ant-alert-error, .ant-form-item-explain-error',
    ).length;

  /** 读回 iframe 内密码框当前值（提交前回读用） */
  const readPasswordValue = (): string | null => {
    for (const iframe of document.querySelectorAll<HTMLIFrameElement>('iframe')) {
      try {
        const p = iframe.contentDocument?.querySelector<HTMLInputElement>('input[type="password"]');
        if (p) {
          return p.value;
        }
      } catch {
        // 跨域 iframe 读不到
      }
    }
    return null;
  };

  /** 填充并校验齐备：用户名或密码任一字段未就绪 → false（本轮不进点击流程） */
  const fillAll = (): boolean => {
    const uOk = fillUsername();
    const pOk = fillPasswordInIframes();
    checkAgreement();
    return uOk && pOk;
  };

  timer = window.setInterval(attempt, 800);

  function attempt(): void {
    if (takenOver()) {
      stop('user-takeover');
      return;
    }
    if (!credentials) {
      stop('no-credentials');
      return;
    }
    if (Date.now() > deadline) {
      stop('deadline');
      return;
    }
    if (posts >= 4) {
      stop('max-posts');
      return;
    }
    if (errorSeen >= 2) {
      stop('server-rejected-twice');
      return;
    }
    // 防重入：上一次点击仍在 500ms 回调里挂起 → 不调度第二次
    if (clickPending) {
      return;
    }
    const submit = findSubmit();
    if (!submit) {
      // 登录成功跳转后按钮消失。★ v4.1.4：**用户点击也算「已交付」**——
      // 此前只认 `posts > 0`，于是"用户自己点成功了"会被当成"还没交付"而空跑到 30s。
      if ((posts > 0 || userClicked) && ++absentStreak >= 2) {
        report('submit-gone', { posts, userClicked });
        stop('submit-gone');
      }
      return;
    }
    absentStreak = 0;
    // 先检测用户是否已改写凭据（覆盖 srcdoc iframe 密码框等无事件通道的场景），再决定是否回填
    detectUserEdit(
      document.querySelector<HTMLInputElement>('input[placeholder="请输入用户名"]') ||
        document.querySelector<HTMLInputElement>('input[type="text"]'),
      credentials.username,
    );
    if (takenOver()) {
      stop('user-takeover');
      return;
    }
    const now = Date.now();
    if (lastClickAt) {
      // 观察期：检测服务端拒绝反馈（错误提示出现）
      if (now - lastClickAt < 3500) {
        if (!errorFlagged && countErrors() > errorsAtLastClick) {
          errorFlagged = true;
          errorSeen++;
          report('rejected', { errorSeen, posts, userClicked });
          log.debug('submit rejected by server', { errorSeen });
          if (errorSeen >= 2) {
            stop('server-rejected-twice');
            return;
          }
        }
        return; // 点击观察期：给登录请求时间，避免连点
      }
      errorFlagged = false; // 观察期结束
    }
    if ((submit as HTMLButtonElement).disabled) {
      return; // 表单校验未过（按钮禁用），等待
    }
    // 齐备门槛：任一字段未就绪（iframe 未挂载等）绝不点击——空密码提交即「密码错误」
    const fillOk = fillAll();
    if (lastFillOk !== fillOk) {
      lastFillOk = fillOk;
      report('fill-state', { ok: fillOk });
    }
    if (!fillOk) {
      return; // ★ 未消耗试次：本轮什么都没交付出去
    }
    clickPending = true;
    window.setTimeout(() => {
      clickPending = false;
      if (takenOver()) {
        return; // 点击落地前用户已接管（改写了凭据）
      }
      // ★★ 点击落地前重新确认「三件事实」同时成立——不靠时序猜，靠当场读 DOM。
      //   读-点之间仍有极小窗口，但它不再是"4 次机会都被白吃"那种放大态。
      if (!fillAll()) {
        report('click-aborted', { posts, reason: 'fields-reset' });
        return; // 字段被重渲染清掉/移除 → 放弃本轮，**不消耗试次**，等下轮重填
      }
      const btn = findSubmit();
      const u =
        document.querySelector<HTMLInputElement>('input[placeholder="请输入用户名"]') ||
        document.querySelector<HTMLInputElement>('input[type="text"]');
      if (!btn || !u || u.value !== credentials!.username || readPasswordValue() !== credentials!.password) {
        report('click-aborted', { posts, reason: 'readback-mismatch' });
        return; // 受控组件的 DOM 值未与凭据一致 → 放弃本轮，**不消耗试次**
      }
      if (userClicked) {
        stop('user-takeover'); // 用户在挂起窗口内点了按钮 → 让位
        return;
      }
      if ((btn as HTMLButtonElement).disabled) {
        report('click-aborted', { posts, reason: 'button-disabled' });
        return; // 按钮此刻不可用（校验未过）→ 放弃本轮，**不消耗试次**
      }
      // ★ 记账点：只有走到这里才是"一次真正送达的提交"
      posts++;
      lastClickAt = Date.now();
      errorFlagged = false;
      errorsAtLastClick = countErrors();
      report('click', { posts, btnText: (btn.textContent || '').trim().slice(0, 12) });
      btn.click();
    }, 500);
  }

  attempt();

  // 节奏加速：密码 iframe 挂载（元素插入 / srcdoc 文档 load 完成）即时触发填充，
  // 不等 800ms 轮询——压缩「表单可见但未填完」的窗口
  let pending = 0;
  const scheduleAttempt = (): void => {
    if (pending) {
      return;
    }
    pending = window.setTimeout(() => {
      pending = 0;
      attempt();
    }, 100);
  };
  const observer = new MutationObserver(scheduleAttempt);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('load', scheduleAttempt, true); // iframe srcdoc 文档加载完成
}

/** 子 frame：仅兜底填自身 frame 内的密码（srcdoc iframe 不注入，此分支主要服务跨域外链 iframe） */
function runIframeFlow(): void {
  if (!credentials) {
    return;
  }
  const field =
    document.querySelector<HTMLInputElement>('input[type="password"]') ||
    document.querySelector<HTMLInputElement>('input[placeholder*="密码"]') ||
    document.querySelector<HTMLInputElement>('input[placeholder*="password"]');
  if (field) {
    setValue(field, credentials.password, window);
  }
}

function start(): void {
  if (!credentials) {
    return;
  }
  if (isTopFrame()) {
    runTopFrameFlow();
  } else {
    runIframeFlow();
  }
}

/** 就绪（document_idle）后主动向 background 索取本次自动登录凭证；失败则轻量重试 */
async function requestCredentials(attempt = 0): Promise<void> {
  if (credentials) {
    return;
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: CONTENT_MESSAGE.autoLoginRequest });
    if (res && typeof res === 'object' && typeof res.username === 'string' && typeof res.password === 'string') {
      credentials = { username: res.username, password: res.password };
      start();
    }
  } catch {
    if (attempt < 3) {
      window.setTimeout(() => void requestCredentials(attempt + 1), 500);
    }
  }
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (
    msg &&
    typeof msg === 'object' &&
    (msg as { type?: string }).type === CONTENT_MESSAGE.autoLogin &&
    typeof (msg as { username?: string }).username === 'string' &&
    typeof (msg as { password?: string }).password === 'string'
  ) {
    credentials = {
      username: (msg as { username: string }).username,
      password: (msg as { password: string }).password,
    };
    start();
  }
});

void requestCredentials();