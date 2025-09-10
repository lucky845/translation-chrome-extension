document.addEventListener("DOMContentLoaded", () => {
  // 获取DOM元素
  const defaultLanguageSelect = document.getElementById("default-language");
  const translationServiceSelect = document.getElementById("translation-service");
  const apiKeyInput = document.getElementById("api-key");
  const saveBtn = document.getElementById("save-btn");
  const statusDiv = document.getElementById("status");
  const bingSettings = document.getElementById("bing-settings");

  // 加载国际化翻译
  function loadTranslations() {
    // 处理普通文本内容的国际化
    document.querySelectorAll("[data-i18n]").forEach(element => {
      const key = element.getAttribute("data-i18n");
      const translation = chrome.i18n.getMessage(key);
      if (translation) {
        element.textContent = translation;
      }
    });

    // 处理placeholder属性的国际化
    document.querySelectorAll("[data-i18n-placeholder]").forEach(element => {
      const key = element.getAttribute("data-i18n-placeholder");
      const translation = chrome.i18n.getMessage(key);
      if (translation) {
        element.placeholder = translation;
      }
    });
  }
  // 翻译服务切换事件
  translationServiceSelect.addEventListener("change", event => {
    if (event.target.value === "bing") {
      bingSettings.classList.add("active");
    } else {
      bingSettings.classList.remove("active");
    }
  });

  // 加载保存的设置
  chrome.storage.sync.get(["targetLanguage", "translationService", "apiKey"], result => {
    if (result.targetLanguage) {
      defaultLanguageSelect.value = result.targetLanguage;
    }

    if (result.translationService) {
      translationServiceSelect.value = result.translationService;
      if (result.translationService === "bing") {
        bingSettings.classList.add("active");
      }
    }

    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }
  });

  // 保存设置
  saveBtn.addEventListener("click", () => {
    const targetLanguage = defaultLanguageSelect.value;
    const translationService = translationServiceSelect.value;
    const apiKey = apiKeyInput.value;

    const settings = {
      targetLanguage: targetLanguage,
      translationService: translationService,
    };

    // 只有在使用Bing服务且API密钥不为空时才保存API密钥
    // Bing翻译器可以使用免费API，不需要API密钥
    if (translationService === "bing" && apiKey.trim() !== "") {
      settings.apiKey = apiKey;
    }

    chrome.storage.sync.set(settings, () => {
      // 显示保存成功的消息
      statusDiv.textContent = chrome.i18n.getMessage("settingsSaved") || "Settings saved successfully!";

      // 加载国际化翻译，确保状态消息也是翻译的
      loadTranslations();
      statusDiv.className = "status success";
      statusDiv.style.display = "block";

      // 3秒后隐藏消息
      setTimeout(() => {
        statusDiv.style.display = "none";
      }, 3000);
    });
  });

  // 页面加载完成后加载翻译
  loadTranslations();
});
