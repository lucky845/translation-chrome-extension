/**
 * Popup 界面逻辑。
 *
 * 原则：界面上显示的每一个状态都必须来自真实查询，不做乐观假设。
 * 旧实现点击翻译后立刻把按钮切成"已翻译"，翻译失败用户也无从得知——这里不允许。
 */
(function () {
  "use strict";

  // 只存语言码，显示名由 I18N.langName 按界面语言生成。
  const LANGS = [
    "zh-CN",
    "zh-TW",
    "en",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "ru",
    "pt",
    "it",
    "ar",
    "hi",
    "th",
    "vi",
    "id",
    "ms",
    "pl",
    "tr",
    "nl",
    "sv",
    "da",
    "fi",
    "no",
    "hu",
    "cs",
    "ro",
    "uk",
    "el",
  ];

  const I18N = window.__TP_I18N__ || {
    t: key => key,
    raw: () => "",
    langName: code => code,
  };

  document.addEventListener("DOMContentLoaded", init);

  /**
   * 初始化。
   * @return {Promise<void>}
   */
  async function init() {
    try {
      const els = {
        source: document.getElementById("source-language"),
        target: document.getElementById("target-language"),
        auto: document.getElementById("auto-translate"),
        translateBtn: document.getElementById("translate-btn"),
        restoreBtn: document.getElementById("restore-btn"),
        status: document.getElementById("status"),
        engineInfo: document.getElementById("engine-info"),
        optionsBtn: document.getElementById("options-btn"),
      };

      fillSelect(els.source, LANGS, true);
      fillSelect(els.target, LANGS, false);
      applyI18n();

      await loadSettings(els);
      try {
        await refreshPageState(els);
      } catch {
        // 静默：失败不阻断主流程
      }

      if (els.target)
        els.target.addEventListener("change", () => saveSettings({ targetLanguage: els.target.value }).catch(() => {}));
      if (els.source)
        els.source.addEventListener("change", () => saveSettings({ sourceLanguage: els.source.value }).catch(() => {}));
      if (els.auto)
        els.auto.addEventListener("change", () => saveSettings({ autoTranslate: els.auto.checked }).catch(() => {}));

      if (els.translateBtn) els.translateBtn.addEventListener("click", () => runAction(els, "translatePage"));
      if (els.restoreBtn) els.restoreBtn.addEventListener("click", () => runAction(els, "restorePage"));
      if (els.optionsBtn) els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

      try {
        const tab = await activeTab();
        const status = tab && tab.id ? await sendToTab(tab.id, { action: "getStatus" }) : null;
        if (status && status.offline) {
          els.engineInfo.textContent = I18N.t("engineInfoOffline");
          els.engineInfo.className = "engine-info ok";
        } else {
          await checkEngine(els);
        }
      } catch {
        if (els.engineInfo) {
          els.engineInfo.textContent = I18N.t("engineInfoProbeSkipped");
          els.engineInfo.className = "engine-info warn";
        }
      }
    } catch (e) {
      // 最终兜底：避免弹窗空白
      const status = document.getElementById("status");
      if (status) {
        status.textContent = I18N.t("popupInitFailed", (e && e.message) || String(e));
        status.className = "status warn";
      }
    }
  }

  /**
   * 填充语言下拉。
   * @param {HTMLSelectElement} select 下拉
   * @param {Array<Array<string>>} langs 语言表
   * @param {boolean} withAuto 是否加入"自动检测"
   */
  function fillSelect(select, langs, withAuto) {
    if (!select) return;
    const entries = langs.map(code => [code, I18N.langName(code)]);
    if (withAuto) entries.unshift(["auto", I18N.t("sourceAutoDetect")]);
    select.replaceChildren(
      ...entries.map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      })
    );
  }

  /**
   * 读取设置并回填界面。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function loadSettings(els) {
    try {
      const stored = await chrome.storage.sync.get({
        targetLanguage: "zh-CN",
        sourceLanguage: "auto",
        autoTranslate: false,
      });

      if (els.target) els.target.value = stored.targetLanguage;
      if (els.source) els.source.value = stored.sourceLanguage;
      if (els.auto) els.auto.checked = Boolean(stored.autoTranslate);
    } catch {
      // storage 失败也不影响界面显示
    }
  }

  /**
   * 保存设置。
   * @param {Object} patch 变更字段
   * @return {Promise<void>}
   */
  async function saveSettings(patch) {
    try {
      await chrome.storage.sync.set(patch);
    } catch {
      // 静默：失败不阻断主流程
    }
  }

  /**
   * 查询当前标签页的翻译状态并同步按钮。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function refreshPageState(els) {
    const tab = await activeTab();
    if (!tab || !tab.id) {
      setStatus(els, I18N.t("pageUnsupported"), "warn");
      setButtons(els, false);
      return;
    }

    const status = await sendToTab(tab.id, { action: "getStatus" });
    if (!status) {
      setStatus(els, I18N.t("pageUnsupportedDetailed"), "warn");
      setButtons(els, false);
      return;
    }

    setButtons(els, status.state === "translated");
    if (status.degraded && status.error) {
      setStatus(els, status.error, "warn");
    }
  }

  /**
   * 执行翻译/恢复动作。
   * @param {Object} els 元素表
   * @param {string} action 动作
   * @return {Promise<void>}
   */
  async function runAction(els, action) {
    const tab = await activeTab();
    if (!tab || !tab.id) {
      setStatus(els, I18N.t("pageUnsupported"), "warn");
      return;
    }

    setBusy(els, true);
    setStatus(els, action === "translatePage" ? I18N.t("statusTranslating") : I18N.t("statusRestoring"), "info");

    const result = await sendToTab(tab.id, { action: action });
    setBusy(els, false);

    if (!result) {
      setStatus(els, I18N.t("pageUnsupportedDetailed"), "warn");
      return;
    }

    if (action === "translatePage") {
      if (result.success) {
        // 有段落没翻成就必须说出来。旧实现一律显示「已翻译 N 处」，
        // 用户看着半页英文却以为翻完了，只能反复点按钮（真机实测 240 段里 85 段失败）。
        if (result.failed > 0) {
          setStatus(els, result.error || I18N.t("statusPartialFailed", result.failed), "warn");
        } else {
          setStatus(els, I18N.t("statusTranslated", result.count), "ok");
        }
        setButtons(els, true);
      } else {
        setStatus(els, result.error || I18N.t("statusTranslateFailed"), "warn");
        setButtons(els, false);
      }
    } else {
      setStatus(els, I18N.t("statusRestored", result.count || 0), "ok");
      setButtons(els, false);
    }
  }

  /**
   * 展示当前翻译方式：端侧优先，其次显示已配置的在线引擎。
   * 引擎切换已移到设置页，这里只做只读提示。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function checkEngine(els) {
    if (!els || !els.engineInfo) return;
    try {
      // 先问页面：浏览器支持端侧翻译吗
      const tab = await activeTab();
      if (tab && tab.id) {
        const status = await sendToTab(tab.id, { action: "getStatus" });
        if (status && status.offline) {
          els.engineInfo.textContent = I18N.t("engineInfoPageOffline");
          els.engineInfo.className = "engine-info ok";
          return;
        }
      }

      // 端侧不可用：显示设置里选中的在线引擎
      const stored = await chrome.storage.sync.get({ engine: "google" });
      const labels = {
        google: "Google",
        mymemory: "MyMemory",
        lingva: "Lingva",
        bing: "Azure Translator",
        custom: I18N.t("engineNameCustom"),
      };
      const label = labels[stored.engine] || I18N.t("engineNameOnline");
      els.engineInfo.textContent = I18N.t("engineInfoOnline", label);
      els.engineInfo.className = "engine-info warn";
    } catch {
      els.engineInfo.textContent = I18N.t("engineInfoUnknown");
      els.engineInfo.className = "engine-info warn";
    }
  }

  /**
   * 应用 chrome.i18n 文案（popup 是传统脚本，无法用 ESM 共享，就地实现）。
   */
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(element => {
      const key = element.getAttribute("data-i18n");
      const text = key && chrome.i18n.getMessage(key);
      if (text) element.textContent = text;
    });
  }

  /**
   * 获取当前活动标签页。
   * @return {Promise<?Object>} 标签页
   */
  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs[0];
  }

  /**
   * 向标签页发消息，失败时返回 null。
   * @param {number} tabId 标签页 id
   * @param {Object} message 消息
   * @return {Promise<?Object>} 响应
   */
  function sendToTab(tabId, message) {
    return new Promise(resolve => {
      try {
        chrome.tabs.sendMessage(tabId, message, response => {
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /**
   * 设置按钮状态。
   * @param {Object} els 元素表
   * @param {boolean} translated 是否已翻译
   */
  function setButtons(els, translated) {
    if (els.translateBtn) els.translateBtn.disabled = translated;
    if (els.restoreBtn) els.restoreBtn.disabled = !translated;
  }

  /**
   * 忙碌态。
   * @param {Object} els 元素表
   * @param {boolean} busy 是否忙碌
   */
  function setBusy(els, busy) {
    if (els.translateBtn) els.translateBtn.disabled = busy;
    if (els.restoreBtn) els.restoreBtn.disabled = busy;
  }

  /**
   * 状态提示。
   * @param {Object} els 元素表
   * @param {string} text 文本
   * @param {string} kind 类型 ok/warn/info
   */
  function setStatus(els, text, kind) {
    if (els.status) {
      els.status.textContent = text;
      els.status.className = "status " + kind;
    }
  }
})();
