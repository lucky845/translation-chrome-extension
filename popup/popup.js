document.addEventListener('DOMContentLoaded', function() {
  console.log("Popup loaded");
  // 获取DOM元素
  const translateBtn = document.getElementById('translate-btn');
  const restoreBtn = document.getElementById('restore-btn');
  const optionsBtn = document.getElementById('options-btn');
  const languageSelect = document.getElementById('language-select');
  const serviceInfo = document.getElementById('service-info');
  
  // 加载保存的设置
  chrome.storage.sync.get(['targetLanguage', 'translationService'], (result) => {
    console.log("Loaded settings:", result);
    if (result.targetLanguage) {
      languageSelect.value = result.targetLanguage;
    }
    
    // 更新服务信息显示
    if (result.translationService === 'bing') {
      serviceInfo.textContent = 'Using Bing Translator (Free)';
    } else {
      serviceInfo.textContent = 'Using Google Translate (Free)';
    }
  });
  
  // 翻译按钮事件
  translateBtn.addEventListener('click', () => {
    console.log("Translate button clicked");
    const targetLanguage = languageSelect.value;
    
    // 保存设置
    chrome.storage.sync.set({ 
      targetLanguage: targetLanguage
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
          }
        });
      });
      
      window.close();
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
        }
      });
    });
    
    window.close();
  });
  
  // 选项按钮事件
  optionsBtn.addEventListener('click', () => {
    console.log("Options button clicked");
    chrome.runtime.openOptionsPage();
  });
  
  
});