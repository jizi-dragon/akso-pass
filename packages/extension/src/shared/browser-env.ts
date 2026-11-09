/**
 * 浏览器家族识别 —— **纯 UA，不碰 `chrome.*`**。
 *
 * ## 为什么要有这一层
 *
 * 本扩展在 Chrome 与 Edge 上都要能装，而两者有**三处只在产品名上不同**的地方：
 *
 * | 用途 | Chrome / Chromium | Edge |
 * |---|---|---|
 * | 扩展管理页（点「重新加载」的地方） | `chrome://extensions` | `edge://extensions` |
 * | 改快捷键页 | `chrome://extensions/shortcuts` | `edge://extensions/shortcuts` |
 * | 诊断里怎么称呼它 | `chrome/151.0.7922.34` | `edge/157.0.0.0` |
 *
 * ## 三条实测事实（2026-11-09，Edge 157.0.4341.42 vs Chromium 151.0.7922.34）
 *
 * 1. **Edge 会把 `chrome://` 自动改写成 `edge://`**：`tabs.create({url:'chrome://extensions'})`
 *    在 Edge 上落到 `edge://extensions/`，`…/shortcuts` 同理。
 *    ⇒ 硬编码 `chrome://` 在 Edge 上**不是坏的**，别把它当兼容性缺陷去"修"。
 * 2. **反向不成立**：Chrome 打开 `edge://extensions` 只会得到一个地址为空的死页签。
 *    ⇒ 所以正确做法不是二选一，而是**按家族选** —— 本模块就是那一处选择。
 * 3. 界面**文案**同样是兼容性的一部分：在 Edge 里让用户去"chrome://extensions"，
 *    他会怀疑自己是不是装错了东西（2026-10-12 用户报"Edge 不好用"时的一半心情）。
 *
 * ★★ **Edge 的 UA 版本令牌是缩减版**：那台机器的 Edge 实际是 **157.0.4341.42**，
 *   而 `navigator.userAgent` 里写的是 `Edg/157.0.0.0`（只剩主版本，其余补零）。
 *   ⇒ 本模块给出的版本号是**主版本级**的（`edge/157.0.0.0`）—— 够区分大版本，
 *     想拿精确 build 号只能问 `navigator.userAgentData.getHighEntropyValues()`，
 *     而那在 **http 页面里不存在**（见下一条），MAIN world 用不了。
 *   ⇒ **别把 `Edg/` 后面那串当真实 build 号写进文档**（我第一次就写错了）。
 *
 * ## 为什么不用 `navigator.userAgentData`
 *
 * `userAgentData.brands` 只在安全上下文里有值，而本模块的调用方之一
 * （`content/shield-main.ts`，MAIN world）要能跑在**目标站是纯 http** 的部署形态上
 * （见 `AGENTS.md` §4「内网形态为纯 http」）。UA 串在 http 页面里照样有。
 */

/** 浏览器家族。`chromium` 只在 UA 里明确写着 Chromium（而不是 Chrome）时出现。 */
export type BrowserFamily = 'edge' | 'chrome' | 'chromium' | 'other';

/** Edge 的 UA 令牌：桌面 `Edg/`、Android `EdgA/`、iOS `EdgiOS/`（注意**不是** `Edge/`）。 */
const EDGE_TOKEN = /Edg(?:A|iOS)?\/([\d.]+)/;
/** Chrome / Chromium 的 UA 令牌。 */
const CHROME_TOKEN = /Chrome\/([\d.]+)/;
const CHROMIUM_TOKEN = /Chromium\/([\d.]+)/;

/** 识别家族。★ Edge 的 UA 里**也**含 `Chrome/<ver>`，所以必须先判 Edge。 */
export function browserFamily(ua: string = navigator.userAgent): BrowserFamily {
  if (EDGE_TOKEN.test(ua)) {
    return 'edge';
  }
  if (CHROME_TOKEN.test(ua) || /HeadlessChrome\//.test(ua)) {
    return 'chrome';
  }
  if (CHROMIUM_TOKEN.test(ua)) {
    return 'chromium';
  }
  return 'other';
}

/**
 * 浏览器版本号（`157.0.0.0` 这种；Edge 的 UA 令牌只剩主版本，见文件头）。
 *
 * ★ 取的是**家族自己那个令牌**：Edge 的 UA 同时含 `Chrome/157.0.0.0` 与
 *   `Edg/157.0.0.0`，随手一 match 会拿到 Chromium 的 `Chrome/157.0.0.0` ——
 *   那个号在 Edge 的更新页/崩溃页上对不上，排查时会平白多一轮怀疑。
 */
export function browserVersion(ua: string = navigator.userAgent): string {
  const family = browserFamily(ua);
  const token =
    family === 'edge' ? EDGE_TOKEN : family === 'chromium' ? CHROMIUM_TOKEN : CHROME_TOKEN;
  return ua.match(token)?.[1] ?? '';
}

/** 给人看的家族名（出现在提示文案与诊断包里）。 */
export function browserLabel(ua: string = navigator.userAgent): string {
  const family = browserFamily(ua);
  if (family === 'edge') {
    return 'Edge';
  }
  if (family === 'chrome') {
    return 'Chrome';
  }
  if (family === 'chromium') {
    return 'Chromium';
  }
  return '浏览器';
}

/** 诊断用的紧凑标签，形如 `edge/157.0.0.0`（家族认不出时是 `other`）。 */
export function browserTag(ua: string = navigator.userAgent): string {
  const version = browserVersion(ua);
  return version ? `${browserFamily(ua)}/${version}` : browserFamily(ua);
}

/* ────────────────────────── 扩展管理页地址 ──────────────────────────
 *
 * ★ 只给**家族自己的**协议：Edge 用 `edge://`、其余用 `chrome://`。
 *   给 Chrome 发 `edge://` 会得到死页签（上面第 2 条），所以不能"两个都试"。
 */

/** 文案里写的扩展管理页，如 `chrome://extensions` / `edge://extensions`。 */
export function extensionsPageText(ua: string = navigator.userAgent): string {
  return browserFamily(ua) === 'edge' ? 'edge://extensions' : 'chrome://extensions';
}

/** 改快捷键页的地址（`tabs.create` 用；`chrome://` 不能直接 href 跳转）。 */
export function shortcutsPageUrl(ua: string = navigator.userAgent): string {
  return browserFamily(ua) === 'edge'
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
}

/** 改快捷键页的文案形态（页面里显示给用户的那一行）。 */
export function shortcutsPageText(ua: string = navigator.userAgent): string {
  return browserFamily(ua) === 'edge'
    ? 'edge://extensions/shortcuts'
    : 'chrome://extensions/shortcuts';
}
