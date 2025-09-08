document.addEventListener('DOMContentLoaded', function() {
  // 获取DOM元素
  const defaultLanguageSelect = document.getElementById('default-language');
  const translationServiceSelect = document.getElementById('translation-service');
  const apiKeyInput = document.getElementById('api-key');
  const saveBtn = document.getElementById('save-btn');
  const statusDiv = document.getElementById('status');
  const bingSettings = document.getElementById('bing-settings');
  // 翻译服务切换事件
  translationServiceSelect.addEventListener('change', function() {
    if (this.value === 'bing') {
      bingSettings.classList.add('active');
    } else {
      bingSettings.classList.remove('active');
    }
  });
  
  // 加载保存的设置
  chrome.storage.sync.get(['targetLanguage', 'translationService', 'apiKey'], (result) => {
    if (result.targetLanguage) {
      defaultLanguageSelect.value = result.targetLanguage;
    }
    
    if (result.translationService) {
      translationServiceSelect.value = result.translationService;
      if (result.translationService === 'bing') {
        bingSettings.classList.add('active');
      }
    }
    
    if (result.apiKey) {
      apiKeyInput.value = result.apiKey;
    }
  });
  
  // 保存设置
  saveBtn.addEventListener('click', () => {
    const targetLanguage = defaultLanguageSelect.value;
    const translationService = translationServiceSelect.value;
    const apiKey = apiKeyInput.value;
    
    const settings = {
      targetLanguage: targetLanguage,
      translationService: translationService
    };
    
    // 只有在使用Bing服务时才保存API密钥
    if (translationService === 'bing') {
      settings.apiKey = apiKey;
    }
    
    chrome.storage.sync.set(settings, () => {
      // 显示保存成功的消息
      statusDiv.textContent = 'Settings saved successfully!';
      statusDiv.className = 'status success';
      statusDiv.style.display = 'block';
      
      // 3秒后隐藏消息
      setTimeout(() => {
        statusDiv.style.display = 'none';
      }, 3000);
    });
  });
});