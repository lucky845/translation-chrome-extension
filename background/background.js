// 真实的翻译API实现
// 提供对Google Translate和Bing Translator的免费访问

class RealTranslateAPI {
  /**
   * 构造函数
   * @param {string} service - 翻译服务 ('google' 或 'bing')
   * @param {string} apiKey - API密钥 (Bing需要，Google免费)
   */
  constructor(service = 'google', apiKey = null) {
    console.log("Initializing RealTranslateAPI with service:", service);
    this.service = service;
    this.apiKey = apiKey;
    
    // Google Translate URLs
    this.googleUrls = {
      translate: 'https://translate.googleapis.com/translate_a/single',
      detect: 'https://translate.googleapis.com/translate_a/single'
    };
    
    // Bing Translator URLs
    this.bingUrls = {
      token: 'https://edge.microsoft.com/translate/auth',
      translate: 'https://api.cognitive.microsofttranslator.com/translate',
      detect: 'https://api.cognitive.microsofttranslator.com/detect'
    };
    
    this.bingToken = null;
    this.bingTokenExpiry = null;
  }

  /**
   * 翻译文本
   * @param {string} text - 要翻译的文本
   * @param {string} sourceLang - 源语言代码 (例如: 'en', 'es')
   * @param {string} targetLang - 目标语言代码 (例如: 'es', 'fr')
   * @returns {Promise<string>} 翻译后的文本
   */
  async translate(text, sourceLang, targetLang) {
    console.log(`Translating with ${this.service}: ${text} from ${sourceLang} to ${targetLang}`);
    try {
      if (this.service === 'google') {
        return await this.googleTranslate(text, sourceLang, targetLang);
      } else if (this.service === 'bing') {
        return await this.bingTranslate(text, sourceLang, targetLang);
      } else {
        throw new Error(`Unsupported translation service: ${this.service}`);
      }
    } catch (error) {
      console.error('Translation error:', error);
      throw error;
    }
  }

  /**
   * Google免费翻译
   * @param {string} text - 要翻译的文本
   * @param {string} sourceLang - 源语言代码
   * @param {string} targetLang - 目标语言代码
   * @returns {Promise<string>} 翻译后的文本
   */
  async googleTranslate(text, sourceLang, targetLang) {
    console.log("Using Google Translate");
    try {
      const url = `${this.googleUrls.translate}?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
      console.log("Google Translate URL:", url);
      
      const response = await fetch(url);
      console.log("Google Translate response status:", response.status);
      
      if (!response.ok) {
        throw new Error(`Google Translate API error: ${response.status}`);
      }

      const data = await response.json();
      console.log("Google Translate response data:", data);
      
      // 提取翻译结果
      if (data && data[0] && data[0][0] && data[0][0][0]) {
        return data[0][0][0];
      } else {
        throw new Error('Invalid response from Google Translate API');
      }
    } catch (error) {
      console.error('Google translation error:', error);
      throw error;
    }
  }

  /**
   * 获取Bing认证令牌
   * @returns {Promise<string>} 认证令牌
   */
  async getBingToken() {
    console.log("Getting Bing token");
    // 检查令牌是否仍然有效
    if (this.bingToken && this.bingTokenExpiry && Date.now() < this.bingTokenExpiry) {
      console.log("Using cached Bing token");
      return this.bingToken;
    }
    
    try {
      const response = await fetch(this.bingUrls.token);
      console.log("Bing token response status:", response.status);
      
      if (!response.ok) {
        throw new Error(`Bing Token API error: ${response.status}`);
      }
      
      this.bingToken = await response.text();
      console.log("Bing token received");
      // 令牌通常有效期10分钟，我们设置8分钟以确保安全
      this.bingTokenExpiry = Date.now() + (8 * 60 * 1000);
      
      return this.bingToken;
    } catch (error) {
      console.error('Bing token error:', error);
      throw error;
    }
  }

  /**
   * Bing翻译
   * @param {string} text - 要翻译的文本
   * @param {string} sourceLang - 源语言代码
   * @param {string} targetLang - 目标语言代码
   * @returns {Promise<string>} 翻译后的文本
   */
  async bingTranslate(text, sourceLang, targetLang) {
    console.log("Using Bing Translate");
    try {
      const token = await this.getBingToken();
      console.log("Bing token obtained");
      
      const url = `${this.bingUrls.translate}?api-version=3.0${sourceLang !== 'auto' ? `&from=${sourceLang}` : ''}&to=${targetLang}`;
      console.log("Bing Translate URL:", url);
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([{ Text: text }])
      });
      
      console.log("Bing Translate response status:", response.status);

      if (!response.ok) {
        throw new Error(`Bing Translate API error: ${response.status}`);
      }

      const data = await response.json();
      console.log("Bing Translate response data:", data);
      
      if (data && data[0] && data[0].translations && data[0].translations[0]) {
        return data[0].translations[0].text;
      } else {
        throw new Error('Invalid response from Bing Translate API');
      }
    } catch (error) {
      console.error('Bing translation error:', error);
      throw error;
    }
  }

  /**
   * 批量翻译文本
   * @param {string[]} texts - 要翻译的文本数组
   * @param {string} sourceLang - 源语言代码
   * @param {string} targetLang - 目标语言代码
   * @returns {Promise<string[]>} 翻译后的文本数组
   */
  async translateBatch(texts, sourceLang, targetLang) {
    console.log(`Translating batch with ${this.service}: ${texts.length} texts from ${sourceLang} to ${targetLang}`);
    try {
      // 对于Google，我们可以发送多个文本
      if (this.service === 'google') {
        // Google Translate API 免费版不直接支持批量翻译，所以我们逐个翻译
        // 但为了提高性能，我们使用Promise.all并行处理
        const translationPromises = texts.map(text => 
          this.googleTranslate(text, sourceLang, targetLang)
        );
        return await Promise.all(translationPromises);
      } 
      // 对于Bing，我们可以发送数组
      else if (this.service === 'bing') {
        const token = await this.getBingToken();
        
        const url = `${this.bingUrls.translate}?api-version=3.0${sourceLang !== 'auto' ? `&from=${sourceLang}` : ''}&to=${targetLang}`;
        
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(texts.map(text => ({ Text: text })))
        });

        if (!response.ok) {
          throw new Error(`Bing Translate API error: ${response.status}`);
        }

        const data = await response.json();
        
        if (data && Array.isArray(data)) {
          return data.map(item => item.translations[0].text);
        } else {
          throw new Error('Invalid response from Bing Translate API');
        }
      } else {
        throw new Error(`Unsupported translation service: ${this.service}`);
      }
    } catch (error) {
      console.error('Batch translation error:', error);
      throw error;
    }
  }

  /**
   * 检测文本语言
   * @param {string} text - 要检测语言的文本
   * @returns {Promise<string>} 检测到的语言代码
   */
  async detectLanguage(text) {
    try {
      if (this.service === 'google') {
        return await this.googleDetectLanguage(text);
      } else if (this.service === 'bing') {
        return await this.bingDetectLanguage(text);
      } else {
        throw new Error(`Unsupported translation service: ${this.service}`);
      }
    } catch (error) {
      console.error('Language detection error:', error);
      throw error;
    }
  }

  /**
   * Google语言检测
   * @param {string} text - 要检测语言的文本
   * @returns {Promise<string>} 检测到的语言代码
   */
  async googleDetectLanguage(text) {
    try {
      const url = `${this.googleUrls.detect}?client=gtx&dt=ld&q=${encodeURIComponent(text)}`;
      
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Google Detect API error: ${response.status}`);
      }

      const data = await response.json();
      
      // 提取检测结果
      if (data && data[2]) {
        return data[2];
      } else {
        throw new Error('Invalid response from Google Detect API');
      }
    } catch (error) {
      console.error('Google language detection error:', error);
      throw error;
    }
  }

  /**
   * Bing语言检测
   * @param {string} text - 要检测语言的文本
   * @returns {Promise<string>} 检测到的语言代码
   */
  async bingDetectLanguage(text) {
    try {
      const token = await this.getBingToken();
      
      const url = `${this.bingUrls.detect}?api-version=3.0`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify([{ Text: text }])
      });

      if (!response.ok) {
        throw new Error(`Bing Detect API error: ${response.status}`);
      }

      const data = await response.json();
      
      if (data && data[0] && data[0].language) {
        return data[0].language;
      } else {
        throw new Error('Invalid response from Bing Detect API');
      }
    } catch (error) {
      console.error('Bing language detection error:', error);
      throw error;
    }
  }
}

// 创建翻译API实例
let translateAPI = null;

// 初始化翻译API
chrome.storage.sync.get(['translationService', 'apiKey'], (result) => {
  const service = result.translationService || 'google';
  const apiKey = result.apiKey || null;
  
  console.log("Initializing translation API with service:", service);
  translateAPI = new RealTranslateAPI(service, apiKey);
});

// 监听来自内容脚本和弹出窗口的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Background received message:", request);
  if (request.action === "translateText") {
    translateText(request.text, request.sourceLang, request.targetLang)
      .then(translatedText => {
        console.log("Sending translated text response:", translatedText);
        sendResponse({ translatedText: translatedText });
      })
      .catch(error => {
        console.error('Translation error:', error);
        sendResponse({ translatedText: request.text }); // 出错时返回原文
      });
    return true; // 保持消息通道开放以进行异步响应
  } else if (request.action === "translateBatch") {
    console.log("Processing batch translation request");
    translateBatch(request.texts, request.sourceLang, request.targetLang)
      .then(translatedTexts => {
        console.log("Sending batch translation response");
        sendResponse({ translatedTexts: translatedTexts });
      })
      .catch(error => {
        console.error('Batch translation error:', error);
        sendResponse({ translatedTexts: request.texts }); // 出错时返回原文
      });
    return true; // 保持消息通道开放以进行异步响应
  } else if (request.action === "getSettings") {
    chrome.storage.sync.get(['targetLanguage', 'translationService', 'apiKey'], (result) => {
      console.log("Sending settings response:", result);
      sendResponse({ 
        targetLanguage: result.targetLanguage || 'en',
        translationService: result.translationService || 'google',
        apiKey: result.apiKey || null
      });
    });
    return true;
  } else if (request.action === "detectLanguage") {
    detectLanguage(request.text)
      .then(language => {
        sendResponse({ language: language });
      })
      .catch(error => {
        console.error('Language detection error:', error);
        sendResponse({ language: 'und' }); // 无法检测时返回未知语言
      });
    return true;
  }
});

// 翻译单个文本
async function translateText(text, sourceLang, targetLang) {
  console.log(`Translating text: ${text} from ${sourceLang} to ${targetLang}`);
  // 使用真实翻译API
  if (translateAPI) {
    try {
      const result = await translateAPI.translate(text, sourceLang, targetLang);
      console.log("Translation result:", result);
      return result;
    } catch (error) {
      console.error('Real translation failed, falling back to mock translation:', error);
    }
  }
  
  // 否则使用模拟翻译
  const result = mockTranslate(text, targetLang);
  console.log("Mock translation result:", result);
  return result;
}

// 批量翻译文本
async function translateBatch(texts, sourceLang, targetLang) {
  console.log(`Translating batch of ${texts.length} texts from ${sourceLang} to ${targetLang}`);
  // 使用真实翻译API
  if (translateAPI) {
    try {
      const result = await translateAPI.translateBatch(texts, sourceLang, targetLang);
      console.log("Batch translation result:", result);
      return result;
    } catch (error) {
      console.error('Real batch translation failed, falling back to mock translation:', error);
    }
  }
  
  // 否则使用模拟翻译
  const result = texts.map(text => mockTranslate(text, targetLang));
  console.log("Mock batch translation result:", result);
  return result;
}

// 检测文本语言
async function detectLanguage(text) {
  // 使用真实语言检测
  if (translateAPI) {
    try {
      return await translateAPI.detectLanguage(text);
    } catch (error) {
      console.error('Real language detection failed:', error);
    }
  }
  
  // 简单模拟语言检测
  return 'en'; // 默认返回英语
}

// 简单的模拟翻译函数
function mockTranslate(text, targetLang) {
  // 简单的模拟翻译
  const translations = {
    'Hello': { 'en': 'Hello', 'es': 'Hola', 'fr': 'Bonjour', 'de': 'Hallo' },
    'World': { 'en': 'World', 'es': 'Mundo', 'fr': 'Monde', 'de': 'Welt' },
    'Translate': { 'en': 'Translate', 'es': 'Traducir', 'fr': 'Traduire', 'de': 'Übersetzen' },
    'Page': { 'en': 'Page', 'es': 'Página', 'fr': 'Page', 'de': 'Seite' },
    'Web': { 'en': 'Web', 'es': 'Web', 'fr': 'Web', 'de': 'Web' }
  };

  // 在实际实现中，这里会调用真正的翻译API
  return translations[text] && translations[text][targetLang] ? translations[text][targetLang] : text + ' (translated)';
}

// 创建上下文菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translatePage",
    title: chrome.i18n.getMessage("translatePageTitle"),
    contexts: ["page"]
  });
  
  chrome.contextMenus.create({
    id: "translateSelected",
    title: chrome.i18n.getMessage("translateSelectedTextTitle"),
    contexts: ["selection"]
  });
});

// 处理上下文菜单点击事件
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "translatePage") {
    console.log("Translating page from context menu");
    chrome.tabs.sendMessage(tab.id, { action: "translatePage" });
  } else if (info.menuItemId === "translateSelected") {
    console.log("Translating selected text from context menu");
    chrome.tabs.sendMessage(tab.id, { 
      action: "translateSelectedText", 
      selectedText: info.selectionText 
    });
  }
});

// 监听存储变化以更新API设置
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync') {
    let needsUpdate = false;
    let service = null;
    let apiKey = null;
    
    if (changes.translationService) {
      service = changes.translationService.newValue;
      needsUpdate = true;
    }
    
    if (changes.apiKey) {
      apiKey = changes.apiKey.newValue;
      needsUpdate = true;
    }
    
    if (needsUpdate) {
      // 获取当前值
      chrome.storage.sync.get(['translationService', 'apiKey'], (result) => {
        translateAPI = new RealTranslateAPI(
          service || result.translationService || 'google',
          apiKey || result.apiKey || null
        );
      });
    }
  }
});