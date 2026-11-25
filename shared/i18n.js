/**
 * 国际化辅助。
 *
 * 本扩展没有构建步骤，popup / options / content script 都是传统脚本，
 * service worker 是 ES module——两边都无法共享 ESM 导出。这里用和
 * dom-core.js 相同的做法：挂到全局，同时在有 module 的环境里暴露给测试。
 *
 * 取不到 chrome.i18n（Node 单元测试、极旧内核）时返回 key 本身，
 * 调用方拿到的一定是可读字符串，不会出现 "undefined"。
 */
(function (root) {
  "use strict";

  /** 少数语言码的本地名称与系统 ICU 给的措辞不同，单独用词条覆盖。 */
  const LANG_LABEL_KEYS = {
    "zh-CN": "langZhHans",
    "zh-TW": "langZhHant",
  };

  /**
   * 读一条词条，缺失或环境不支持时返回空字符串。
   * @param {string} key 词条名
   * @param {Array<string>} substitutions 占位符值
   * @return {string} 文案
   */
  function message(key, substitutions) {
    try {
      const i18n = root.chrome && root.chrome.i18n;
      if (!i18n || typeof i18n.getMessage !== "function") return "";
      return i18n.getMessage(key, substitutions) || "";
    } catch {
      return "";
    }
  }

  /**
   * 取词条。缺失时退回 key，保证界面永远不会出现空白。
   * @param {string} key 词条名
   * @param {...(string|number)} substitutions 占位符值
   * @return {string} 文案
   */
  function t(key, ...substitutions) {
    return message(key, substitutions) || key;
  }

  /**
   * 界面语言：优先取浏览器 UI 语言。
   * @return {string} 语言码
   */
  function uiLanguage() {
    try {
      const i18n = root.chrome && root.chrome.i18n;
      if (i18n && typeof i18n.getUILanguage === "function") return i18n.getUILanguage() || "en";
    } catch {
      // 忽略，下面用默认值
    }
    return "en";
  }

  /**
   * 语言码的人类可读名称。
   *
   * 29 种语言逐个维护词条会让两个 locale 各多出 29 条重复数据，且新增语言
   * 要改三处；系统自带 Intl.DisplayNames 的 ICU 数据已经是权威结果，
   * 只有中文简繁两条与它措辞不一致，走词条覆盖。
   * @param {string} code 语言码
   * @return {string} 显示名
   */
  function langName(code) {
    if (!code) return "";
    const override = LANG_LABEL_KEYS[code];
    if (override) return t(override);
    try {
      if (root.Intl && typeof root.Intl.DisplayNames === "function") {
        const display = new root.Intl.DisplayNames([uiLanguage()], { type: "language", fallback: "code" });
        const label = display.of(code);
        if (label && label !== code) return label;
      }
    } catch {
      // 旧内核没有 DisplayNames，退回语言码
    }
    return code;
  }

  const api = { t, raw: message, langName };
  root.__TP_I18N__ = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
