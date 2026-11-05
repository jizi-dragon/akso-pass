/**
 * v4.2.45 调试跳转热键：Alt+2。
 *
 * 为什么不用 `chrome.commands` 直接声明第二个默认键：Chrome 只允许 **4 个**
 * 命令带 `suggested_key`。本扩展已有 Alt+Q / Alt+W / Alt+1 / Ctrl+X 四个，
 * 再加一个会让**整个扩展装载失败**（实测 `ERR_BLOCKED_BY_CLIENT`，且 Chrome
 * 的 stderr 里不一定有显式报错，很难查）。所以这里在页面侧听键，再转给
 * background；`quick-debug` 命令仍保留，用户可在 chrome://extensions/shortcuts
 * 手动另绑一个键。
 *
 * 只认「Alt+2」：Alt 与数字的组合在 Chrome 里没有默认行为（Ctrl+数字 才是切页签），
 * 不会抢浏览器快捷键。事件在捕获阶段拦，避免站点先处理；`isTrusted` 过滤掉
 * 页面脚本合成的假按键。
 */
import { DEBUG_HOTKEY_MESSAGE } from '../shared/constants';

const WIN = window as unknown as { __QL_DEBUG_HOTKEY__?: boolean };

if (!WIN.__QL_DEBUG_HOTKEY__) {
  WIN.__QL_DEBUG_HOTKEY__ = true;

  window.addEventListener(
    'keydown',
    (e) => {
      if (!e.isTrusted || e.repeat) {
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
        return;
      }
      if (e.key !== '2' && e.code !== 'Digit2') {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: DEBUG_HOTKEY_MESSAGE });
      } catch {
        // 扩展重载后旧内容脚本会失去 context；下一次页面加载即恢复，不打扰用户
      }
    },
    true,
  );
}
