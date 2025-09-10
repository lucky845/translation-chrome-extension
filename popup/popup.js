document.addEventListener('DOMContentLoaded', function() {
  console.log("Popup loaded");
  // 获取DOM元素
  const translateBtn = document.getElementById('translate-btn');
  const restoreBtn = document.getElementById('restore-btn');
  const optionsBtn = document.getElementById('options-btn');
  const languageSelect = document.getElementById('language-select');
  const serviceSelect = document.getElementById('service-select');
  const serviceInfo = document.getElementById('service-info');
  const autoTranslateCheckbox = document.getElementById('auto-translate-checkbox');
  
  // 加载保存的设置
  chrome.storage.sync.get(['targetLanguage', 'translationService', 'autoTranslate'], (result) => {
    console.log("Loaded settings:", result);
    if (result.targetLanguage) {
      languageSelect.value = result.targetLanguage;
    }
    
    if (result.translationService) {
      serviceSelect.value = result.translationService;
    }
    
    if (typeof result.autoTranslate === 'boolean') {
      autoTranslateCheckbox.checked = result.autoTranslate;
    }
    
    // 更新服务信息显示
    updateServiceInfo();
    
    // 加载国际化文本
    loadTranslations();
  });
  
  // 检查当前页面的翻译状态并更新按钮样式
  checkPageTranslationState();
  
  // 监听服务选择变化
  serviceSelect.addEventListener('change', () => {
    updateServiceInfo();
  });
  
  // 更新服务信息显示的函数
  function updateServiceInfo() {
    if (serviceSelect.value === 'bing') {
      serviceInfo.textContent = chrome.i18n.getMessage('usingBingTranslator') || 'Using Bing Translator (Free)';
    } else {
      serviceInfo.textContent = chrome.i18n.getMessage('usingGoogleTranslator') || 'Using Google Translate (Free)';
    }
  }
  
  // 更新按钮样式
  function updateButtonStyles(isTranslated) {
    if (isTranslated) {
      // 已翻译状态：翻译按钮置灰，查看原文按钮置蓝
      translateBtn.classList.add('restore');
      translateBtn.classList.remove('active');
      restoreBtn.classList.remove('restore');
      restoreBtn.classList.add('active');
    } else {
      // 未翻译状态：翻译按钮置蓝，查看原文按钮置灰
      translateBtn.classList.remove('restore');
      translateBtn.classList.add('active');
      restoreBtn.classList.add('restore');
      restoreBtn.classList.remove('active');
    }
  }
  
  // 加载国际化翻译
  function loadTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
      const key = element.getAttribute('data-i18n');
      const translation = chrome.i18n.getMessage(key);
      if (translation) {
        element.textContent = translation;
      }
    });
  }
  
  // 检查页面翻译状态
  function checkPageTranslationState() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, { action: "getTranslationState" }, (response) => {
          if (chrome.runtime.lastError) {
            console.log("Error checking translation state, assuming not translated");
            updateButtonStyles(false);
            return;
          }
          
          if (response && response.isTranslated) {
            updateButtonStyles(true);
          } else {
            updateButtonStyles(false);
          }
        });
      }
    });
  }
  
  // 自动翻译复选框事件
  autoTranslateCheckbox.addEventListener('change', () => {
    console.log("Auto-translate setting changed:", autoTranslateCheckbox.checked);
    chrome.storage.sync.set({ 
      autoTranslate: autoTranslateCheckbox.checked
    }, () => {
      console.log("Auto-translate setting saved");
    });
  });
  
  // 翻译按钮事件
  translateBtn.addEventListener('click', () => {
    console.log("Translate button clicked");
    const targetLanguage = languageSelect.value;
    const translationService = serviceSelect.value;
    const autoTranslate = autoTranslateCheckbox.checked;
    
    // 保存设置
    chrome.storage.sync.set({ 
      targetLanguage: targetLanguage,
      translationService: translationService,
      autoTranslate: autoTranslate
    }, () => {
      console.log("Settings saved");
      
      // 发送翻译消息到内容脚本
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        console.log("Sending translatePage message to tab:", tabs[0]);
        
        // 发送翻译消息
        chrome.tabs.sendMessage(tabs[0].id, { action: "translatePage" }, (response) => {
          console.log("Translate message sent, response:", response);
          if (chrome.runtime.lastError) {
            console.error("Error sending translate message:", chrome.runtime.lastError);
          } else {
            // 更新按钮样式为已翻译状态
            updateButtonStyles(true);
          }
        });
      });
    });
  });
  
  // 恢复按钮事件
  restoreBtn.addEventListener('click', () => {
    console.log("Restore button clicked");
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "restorePage" }, (response) => {
        console.log("Restore message sent, response:", response);
        if (chrome.runtime.lastError) {
          console.error("Error sending restore message:", chrome.runtime.lastError);
        } else {
          // 更新按钮样式为未翻译状态
          updateButtonStyles(false);
        }
      });
    });
  });
  
  // 选项按钮事件
  optionsBtn.addEventListener('click', () => {
    console.log("Options button clicked");
    chrome.runtime.openOptionsPage();
  });
  
  
});