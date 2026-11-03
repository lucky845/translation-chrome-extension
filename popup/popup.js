/**
 * Popup 界面逻辑。
 *
 * 原则：界面上显示的每一个状态都必须来自真实查询，不做乐观假设。
 * 旧实现点击翻译后立刻把按钮切成"已翻译"，翻译失败用户也无从得知——这里不允许。
 */
(function () {
  "use strict";

  const LANGS = [
    ["zh-CN", "中文（简体）"],
    ["zh-TW", "中文（繁体）"],
    ["en", "英语"],
    ["ja", "日语"],
    ["ko", "韩语"],
    ["fr", "法语"],
    ["de", "德语"],
    ["es", "西班牙语"],
    ["ru", "俄语"],
    ["pt", "葡萄牙语"],
    ["it", "意大利语"],
    ["ar", "阿拉伯语"],
    ["hi", "印地语"],
    ["th", "泰语"],
    ["vi", "越南语"],
    ["id", "印尼语"],
    ["ms", "马来语"],
    ["pl", "波兰语"],
    ["tr", "土耳其语"],
    ["nl", "荷兰语"],
    ["sv", "瑞典语"],
    ["da", "丹麦语"],
    ["fi", "芬兰语"],
    ["no", "挪威语"],
    ["hu", "匈牙利语"],
    ["cs", "捷克语"],
    ["ro", "罗马尼亚语"],
    ["uk", "乌克兰语"],
    ["el", "希腊语"],
  ];

  document.addEventListener("DOMContentLoaded", init);

  /**
   * 初始化。
   * @return {Promise<void>}
   */
  async function init() {
    const els = {
      source: document.getElementById("source-language"),
      target: document.getElementById("target-language"),
      engine: document.getElementById("engine"),
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
    await refreshPageState(els);

    els.engine.addEventListener("change", async () => {
      await saveSettings({ engine: els.engine.value });
      await checkEngine(els);
    });

    els.target.addEventListener("change", () => saveSettings({ targetLanguage: els.target.value }));
    els.source.addEventListener("change", () => saveSettings({ sourceLanguage: els.source.value }));
    els.auto.addEventListener("change", () => saveSettings({ autoTranslate: els.auto.checked }));

    els.translateBtn.addEventListener("click", () => runAction(els, "translatePage"));
    els.restoreBtn.addEventListener("click", () => runAction(els, "restorePage"));
    els.optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

    await checkEngine(els);
  }

  /**
   * 填充语言下拉。
   * @param {HTMLSelectElement} select 下拉
   * @param {Array<Array<string>>} langs 语言表
   * @param {boolean} withAuto 是否加入"自动检测"
   */
  function fillSelect(select, langs, withAuto) {
    const options = withAuto ? [["auto", "自动检测"]].concat(langs) : langs;
    select.replaceChildren(
      ...options.map(([value, label]) => {
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
    const stored = await chrome.storage.sync.get({
      targetLanguage: "zh-CN",
      sourceLanguage: "auto",
      engine: "google",
      autoTranslate: false,
    });

    els.target.value = stored.targetLanguage;
    els.source.value = stored.sourceLanguage;
    els.engine.value = stored.engine;
    els.auto.checked = Boolean(stored.autoTranslate);
  }

  /**
   * 保存设置。
   * @param {Object} patch 变更字段
   * @return {Promise<void>}
   */
  async function saveSettings(patch) {
    await chrome.storage.sync.set(patch);
  }

  /**
   * 查询当前标签页的翻译状态并同步按钮。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function refreshPageState(els) {
    const tab = await activeTab();
    if (!tab || !tab.id) {
      setStatus(els, "当前页面不支持翻译", "warn");
      setButtons(els, false);
      return;
    }

    const status = await sendToTab(tab.id, { action: "getStatus" });
    if (!status) {
      setStatus(els, "当前页面不支持翻译（请在普通网页上使用）", "warn");
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
      setStatus(els, "当前页面不支持翻译", "warn");
      return;
    }

    setBusy(els, true);
    setStatus(els, action === "translatePage" ? "正在翻译…" : "正在恢复…", "info");

    const result = await sendToTab(tab.id, { action: action });
    setBusy(els, false);

    if (!result) {
      setStatus(els, "当前页面不支持翻译（请在普通网页上使用）", "warn");
      return;
    }

    if (action === "translatePage") {
      if (result.success) {
        setStatus(els, `已翻译 ${result.count} 处文本`, "ok");
        setButtons(els, true);
      } else {
        setStatus(els, result.error || "翻译失败", "warn");
        setButtons(els, false);
      }
    } else {
      setStatus(els, `已恢复 ${result.count || 0} 处原文`, "ok");
      setButtons(els, false);
    }
  }

  /**
   * 探测引擎真实可用性并显示。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function checkEngine(els) {
    els.engineInfo.textContent = "检测引擎状态…";
    try {
      const response = await chrome.runtime.sendMessage({ action: "getEngineStatus" });
      const engines = (response && response.engines) || {};
      const current = els.engine.value;
      const info = engines[current];
      if (info && info.available) {
        if (current === "google") {
          els.engineInfo.textContent = "Google 免费接口 · 可用";
        } else if (current === "mymemory") {
          els.engineInfo.textContent = "MyMemory 免费接口 · 可用";
        } else if (current === "lingva") {
          els.engineInfo.textContent = "Lingva 免费接口 · 可用";
        } else if (current === "bing") {
          els.engineInfo.textContent = "Azure 翻译 · 可用";
        } else {
          els.engineInfo.textContent = "引擎可用";
        }
        els.engineInfo.className = "engine-info ok";
      } else {
        els.engineInfo.textContent = (info && info.reason) || "当前引擎不可用";
        els.engineInfo.className = "engine-info warn";
      }
    } catch (error) {
      els.engineInfo.textContent = "引擎状态检测失败：" + (error.message || error);
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
    els.translateBtn.disabled = translated;
    els.restoreBtn.disabled = !translated;
  }

  /**
   * 忙碌态。
   * @param {Object} els 元素表
   * @param {boolean} busy 是否忙碌
   */
  function setBusy(els, busy) {
    els.translateBtn.disabled = busy;
    els.restoreBtn.disabled = busy;
  }

  /**
   * 状态提示。
   * @param {Object} els 元素表
   * @param {string} text 文本
   * @param {string} kind 类型 ok/warn/info
   */
  function setStatus(els, text, kind) {
    els.status.textContent = text;
    els.status.className = "status " + kind;
  }
})();
