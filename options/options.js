/**
 * 设置页逻辑。
 *
 * 与旧实现的差异：
 *   - 删除了从不生效的 apiKey 假配置：只有选择 Azure 引擎且填入密钥时才保存。
 *   - 引擎可用性来自真实探测，不是写死的文案。
 *   - 新增「自定义接口」：预设 + 地址 + 模板 + 响应路径，支持任意自建/中转服务。
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

  const ENGINE_LABELS = {
    google: "Google",
    mymemory: "MyMemory",
    lingva: "Lingva",
    bing: "Azure Translator",
    custom: "自定义接口",
  };

  /** 预设定义（来自后台，避免前端重复维护一份）。 */
  let presets = [];

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
      blacklist: document.getElementById("blacklist"),
      useOffline: document.getElementById("use-offline"),
      translatedStyle: document.getElementById("translated-style"),
      azureSection: document.getElementById("azure-settings"),
      apiKey: document.getElementById("api-key"),
      customSection: document.getElementById("custom-settings"),
      preset: document.getElementById("custom-preset"),
      url: document.getElementById("custom-url"),
      method: document.getElementById("custom-method"),
      headers: document.getElementById("custom-headers"),
      body: document.getElementById("custom-body"),
      responsePath: document.getElementById("custom-response-path"),
      token: document.getElementById("custom-token"),
      model: document.getElementById("custom-model"),
      testBtn: document.getElementById("custom-test"),
      result: document.getElementById("custom-result"),
      save: document.getElementById("save-btn"),
      status: document.getElementById("status"),
      engineStatus: document.getElementById("engine-status"),
      offlineStatus: document.getElementById("offline-status"),
    };

    fillSelect(els.target, LANGS);
    applyI18n();
    await loadPresets(els);

    const stored = await chrome.storage.sync.get({
      targetLanguage: "zh-CN",
      engine: "google",
      autoTranslate: false,
      apiKey: "",
      blacklist: "",
      useOffline: "auto",
      translatedStyle: "none",
      customPreset: "deeplx",
      customUrl: "",
      customMethod: "",
      customHeaders: "",
      customBody: "",
      customResponsePath: "",
      customToken: "",
      customModel: "",
    });

    els.target.value = stored.targetLanguage;
    els.engine.value = stored.engine;
    els.auto.checked = Boolean(stored.autoTranslate);
    if (els.blacklist) els.blacklist.value = stored.blacklist || "";
    els.apiKey.value = stored.apiKey || "";
    els.preset.value = stored.customPreset || "deeplx";
    els.url.value = stored.customUrl || "";
    els.headers.value = stored.customHeaders || "";
    els.body.value = stored.customBody || "";
    els.responsePath.value = stored.customResponsePath || "";
    els.token.value = stored.customToken || "";
    els.model.value = stored.customModel || "";

    // 空方法的存量数据：用预设的默认方法补齐
    applyStoredMethod(els, stored.customMethod);
    toggleSections(els);

    els.engine.addEventListener("change", () => {
      // 首次切到自定义接口时，把当前预设的默认值填进来，避免用户面对一片空白
      if (els.engine.value === "custom" && !els.url.value.trim()) {
        applyPreset(els, els.preset.value);
      }
      toggleSections(els);
      checkEngine(els);
    });

    els.preset.addEventListener("change", () => applyPreset(els, els.preset.value));

    els.save.addEventListener("click", () => save(els));
    els.testBtn.addEventListener("click", () => testCustom(els));

    await checkOffline(els);
    await checkEngine(els);
  }

  /**
   * 检测浏览器端侧翻译能力并展示。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function checkOffline(els) {
    if (!els.offlineStatus) return;
    els.offlineStatus.textContent = "检测中…";
    els.offlineStatus.className = "state";
    try {
      const tab = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabId = tab && tab[0] && tab[0].id;
      const status = tabId ? await chrome.tabs.sendMessage(tabId, { action: "getStatus" }).catch(() => null) : null;
      if (status && status.offline) {
        els.offlineStatus.textContent = "✓ 可用（浏览器内置模型，本地推理）";
        els.offlineStatus.className = "state ok";
      } else {
        els.offlineStatus.textContent =
          "当前浏览器或页面不支持端侧翻译，将使用下面的在线引擎（Chrome 138+ / Edge 148+）";
        els.offlineStatus.className = "state warn";
      }
    } catch {
      els.offlineStatus.textContent = "无法检测（打开任意网页后再查看）";
      els.offlineStatus.className = "state warn";
    }
  }

  /**
   * 从后台读取预设定义并填充下拉。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function loadPresets(els) {
    try {
      const response = await chrome.runtime.sendMessage({ action: "getCustomPresets" });
      presets = (response && response.presets) || [];
    } catch {
      presets = [];
    }
    els.preset.replaceChildren(
      ...presets.map(preset => {
        const option = document.createElement("option");
        option.value = preset.name;
        option.textContent = preset.label;
        return option;
      })
    );
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
   * 按所选引擎显示/隐藏配置区。
   * @param {Object} els 元素表
   */
  function toggleSections(els) {
    els.azureSection.classList.toggle("active", els.engine.value === "bing");
    els.customSection.classList.toggle("active", els.engine.value === "custom");
  }

  /**
   * 存量数据没有存请求方式时，用预设默认值补。
   * @param {Object} els 元素表
   * @param {string} storedMethod 已存的方法
   */
  function applyStoredMethod(els, storedMethod) {
    const preset = findPreset(els.preset.value);
    els.method.value = String(storedMethod || (preset && preset.method) || "POST").toUpperCase();
  }

  /**
   * 查找预设。
   * @param {string} name 名称
   * @return {?Object} 预设
   */
  function findPreset(name) {
    return presets.find(preset => preset.name === name) || null;
  }

  /**
   * 切预设时把该预设的默认值填进表单（令牌保留用户已填的）。
   * @param {Object} els 元素表
   * @param {string} name 预设名
   */
  function applyPreset(els, name) {
    const preset = findPreset(name);
    if (!preset) return;
    els.url.value = preset.url || "";
    els.method.value = String(preset.method || "POST").toUpperCase();
    els.headers.value = preset.headers || "";
    els.body.value = preset.body || "";
    els.responsePath.value = preset.responsePath || "";
    els.model.value = preset.model || "";
  }

  /**
   * 把表单收集成设置补丁。
   * @param {Object} els 元素表
   * @return {Object} 补丁
   */
  function currentPatch(els) {
    return {
      targetLanguage: els.target.value,
      engine: els.engine.value,
      autoTranslate: els.auto.checked,
      blacklist: els.blacklist ? els.blacklist.value.trim() : "",
      useOffline: els.useOffline && !els.useOffline.checked ? "off" : "auto",
      translatedStyle: els.translatedStyle ? els.translatedStyle.value : "none",
      apiKey: els.engine.value === "bing" ? els.apiKey.value.trim() : "",
      customPreset: els.preset.value,
      customUrl: els.url.value.trim(),
      customMethod: els.method.value,
      customHeaders: els.headers.value.trim(),
      customBody: els.body.value.trim(),
      customResponsePath: els.responsePath.value.trim(),
      customToken: els.token.value.trim(),
      customModel: els.model.value.trim(),
    };
  }

  /**
   * 保存设置（自定义接口会先申请域名权限）。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function save(els) {
    const patch = currentPatch(els);

    if (patch.engine === "custom" && patch.customUrl) {
      const permission = await ensurePermission(patch.customUrl);
      if (!permission.ok) {
        showStatus(els, permission.error, "warn");
        return;
      }
    }

    await chrome.storage.sync.set(patch);
    showStatus(els, chrome.i18n.getMessage("settingsSaved") || "设置已保存", "ok");
    await checkEngine(els);
  }

  /**
   * 测试自定义接口：先用当前表单保存，再走真实翻译链路打一次。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function testCustom(els) {
    const url = els.url.value.trim();
    setResult(els, "测试中…", "");

    if (!url) {
      setResult(els, "请先填写接口地址", "warn");
      return;
    }

    const permission = await ensurePermission(url);
    if (!permission.ok) {
      setResult(els, permission.error, "warn");
      return;
    }

    const patch = currentPatch(els);
    patch.engine = "custom";
    els.engine.value = "custom";
    toggleSections(els);
    await chrome.storage.sync.set(patch);

    try {
      const response = await chrome.runtime.sendMessage({
        action: "translateText",
        text: "Hello, world!",
        sourceLanguage: "en",
        targetLanguage: els.target.value,
        engine: "custom",
      });
      if (response && response.ok) {
        setResult(els, `连接成功：「Hello, world!」→「${response.translatedText}」`, "ok");
      } else {
        setResult(els, `失败：${(response && response.error) || "未知错误"}`, "warn");
      }
    } catch (error) {
      setResult(els, `失败：${error.message || error}`, "warn");
    }
  }

  /**
   * 自定义接口所在域名的权限模式。
   * @param {string} url 地址
   * @return {?string} 权限模式
   */
  function originPattern(url) {
    try {
      const parsed = new globalThis.URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return `${parsed.origin}/*`;
    } catch {
      return null;
    }
  }

  /**
   * 确认/申请访问自定义接口域名的权限。
   * @param {string} url 地址
   * @return {Promise<{ok: boolean, error?: string}>} 结果
   */
  async function ensurePermission(url) {
    const pattern = originPattern(url);
    if (!pattern) return { ok: false, error: "接口地址不是合法的 http(s) URL" };

    try {
      const has = await chrome.permissions.contains({ origins: [pattern] });
      if (has) return { ok: true };
      const granted = await chrome.permissions.request({ origins: [pattern] });
      return granted ? { ok: true } : { ok: false, error: "未授予该域名访问权限，翻译请求会被浏览器拦截" };
    } catch (error) {
      return { ok: false, error: `权限申请失败：${error.message || error}` };
    }
  }

  /**
   * 显示保存状态。
   * @param {Object} els 元素表
   * @param {string} text 文本
   * @param {string} kind 类型
   */
  function showStatus(els, text, kind) {
    els.status.textContent = text;
    els.status.className = "saved show" + (kind === "warn" ? " warn" : "");
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => {
      els.status.className = "saved";
    }, 3200);
  }

  /**
   * 显示测试结果。
   * @param {Object} els 元素表
   * @param {string} text 文本
   * @param {string} kind ok/warn
   */
  function setResult(els, text, kind) {
    els.result.textContent = text;
    els.result.className = "result " + (kind || "");
  }

  /**
   * 探测引擎真实可用性。
   * @param {Object} els 元素表
   * @return {Promise<void>}
   */
  async function checkEngine(els) {
    els.engineStatus.textContent = "检测引擎状态…";
    els.engineStatus.className = "state";
    try {
      const response = await chrome.runtime.sendMessage({ action: "getEngineStatus" });
      const engines = (response && response.engines) || {};
      const info = engines[els.engine.value];
      const label = ENGINE_LABELS[els.engine.value] || els.engine.value;

      if (info && info.available && !info.reason) {
        els.engineStatus.textContent = `✓ ${label} 可用`;
        els.engineStatus.className = "state ok";
      } else if (info && info.available && info.reason) {
        els.engineStatus.textContent = `${label}：${info.reason}`;
        els.engineStatus.className = "state warn";
      } else {
        els.engineStatus.textContent = `${label}：${(info && info.reason) || "当前不可用"}`;
        els.engineStatus.className = "state warn";
      }
    } catch (error) {
      els.engineStatus.textContent = "引擎状态检测失败：" + (error.message || error);
      els.engineStatus.className = "state warn";
    }
  }
})();
