/**
 * 设置页逻辑。
 *
 * 与旧实现的差异：
 *   - 删除了从不生效的 apiKey 假配置：现在只有选择 Azure 引擎且填入密钥时才保存。
 *   - 引擎可用性来自真实探测，不是写死的文案。
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
      target: document.getElementById("target-language"),
      engine: document.getElementById("engine"),
      auto: document.getElementById("auto-translate"),
      azureSection: document.getElementById("azure-settings"),
      apiKey: document.getElementById("api-key"),
      save: document.getElementById("save-btn"),
      status: document.getElementById("status"),
      engineStatus: document.getElementById("engine-status"),
    };

    fillSelect(els.target, LANGS);
    applyI18n();

    const stored = await chrome.storage.sync.get({
      targetLanguage: "zh-CN",
      engine: "google",
      autoTranslate: false,
      apiKey: "",
    });

    els.target.value = stored.targetLanguage;
    els.engine.value = stored.engine;
    els.auto.checked = Boolean(stored.autoTranslate);
    els.apiKey.value = stored.apiKey || "";
    toggleAzure(els);

    els.engine.addEventListener("change", () => toggleAzure(els));

    els.save.addEventListener("click", async () => {
      const patch = {
        targetLanguage: els.target.value,
        engine: els.engine.value,
        autoTranslate: els.auto.checked,
        apiKey: els.engine.value === "bing" ? els.apiKey.value.trim() : "",
      };

      await chrome.storage.sync.set(patch);
      showStatus(els, chrome.i18n.getMessage("settingsSaved") || "设置已保存", "ok");
      await checkEngine(els);
    });

    await checkEngine(els);
  }

  /**
   * 填充语言下拉。
   * @param {HTMLSelectElement} select 下拉
   * @param {Array<Array<string>>} langs 语言表
   */
  function fillSelect(select, langs) {
    select.replaceChildren(
      ...langs.map(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        return option;
      })
    );
  }

  /**
   * 应用 chrome.i18n 文案。
   */
  function applyI18n() {
    document.querySelectorAll("[data-i18n]").forEach(element => {
      const key = element.getAttribute("data-i18n");
      const text = key && chrome.i18n.getMessage(key);
      if (text) element.textContent = text;
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
      const key = element.getAttribute("data-i18n-placeholder");
      const text = key && chrome.i18n.getMessage(key);
      if (text) element.placeholder = text;
    });
  }

  /**
   * 按所选引擎显示/隐藏 Azure 密钥区。
   * @param {Object} els 元素表
   */
  function toggleAzure(els) {
    els.azureSection.classList.toggle("active", els.engine.value === "bing");
  }

  /**
   * 显示保存状态。
   * @param {Object} els 元素表
   * @param {string} text 文本
   * @param {string} kind 类型
   */
  function showStatus(els, text, kind) {
    els.status.textContent = text;
    els.status.className = "status " + kind;
    els.status.style.display = "block";
    setTimeout(() => {
      els.status.style.display = "none";
    }, 3000);
  }

  /**
   * 探测引擎真实可用性。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function checkEngine(els) {
    els.engineStatus.textContent = "检测引擎状态…";
    els.engineStatus.className = "engine-status";
    try {
      const response = await chrome.runtime.sendMessage({ action: "getEngineStatus" });
      const engines = (response && response.engines) || {};
      const info = engines[els.engine.value];
      if (info && info.available) {
        els.engineStatus.textContent = els.engine.value === "google" ? "✓ Google 免费接口可用" : "✓ Azure 翻译可用";
        els.engineStatus.className = "engine-status ok";
      } else {
        els.engineStatus.textContent = (info && info.reason) || "当前引擎不可用";
        els.engineStatus.className = "engine-status warn";
      }
    } catch (error) {
      els.engineStatus.textContent = "引擎状态检测失败：" + (error.message || error);
      els.engineStatus.className = "engine-status warn";
    }
  }
})();
