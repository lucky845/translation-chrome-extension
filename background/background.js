// 翻译服务类型
export const TRANSLATION_SERVICES = {
  BING: "bing",
  GOOGLE: "google",
  MICROSOFT: "microsoft",
  YANDEX: "yandex",
};

// 语言代码映射
export const LANGUAGE_MAP = {
  auto: "自动检测",
  "zh-CN": "中文(简体)",
  "zh-TW": "中文(繁体)",
  en: "英语",
  ja: "日语",
  ko: "韩语",
  fr: "法语",
  de: "德语",
  es: "西班牙语",
  ru: "俄语",
  pt: "葡萄牙语",
  it: "意大利语",
  ar: "阿拉伯语",
  hi: "印地语",
  th: "泰语",
  vi: "越南语",
  id: "印尼语",
  ms: "马来语",
  pl: "波兰语",
  tr: "土耳其语",
  nl: "荷兰语",
  sv: "瑞典语",
  da: "丹麦语",
  fi: "芬兰语",
  no: "挪威语",
  hu: "匈牙利语",
  cs: "捷克语",
  ro: "罗马尼亚语",
  uk: "乌克兰语",
  el: "希腊语",
};

// 基础翻译API类
class BaseTranslationAPI {
  constructor() {
    this.languageMap = LANGUAGE_MAP;
    this.supportedLanguages = Object.keys(this.languageMap);
  }

  async detectLanguage(text) {
    throw new Error("子类必须实现detectLanguage方法");
  }

  async translate(text, fromLang, toLang) {
    throw new Error("子类必须实现translate方法");
  }

  async translateBatch(texts, fromLang, toLang) {
    // 默认实现：逐个翻译
    return Promise.all(
      texts.map(text =>
        this.translate(text, fromLang, toLang).catch(error => {
          console.error("翻译失败，返回原文:", text, error);
          return text;
        })
      )
    );
  }

  getSupportedLanguages() {
    return this.supportedLanguages;
  }

  getLanguageMap() {
    return this.languageMap;
  }
}

// Google翻译API实现
class GoogleTranslationAPI extends BaseTranslationAPI {
  constructor() {
    super();
    this.baseUrl = "https://translate.googleapis.com/translate_a/single";
  }

  async detectLanguage(text) {
    try {
      const params = new URLSearchParams({
        client: "gtx",
        sl: "auto",
        tl: "en",
        dt: "t",
        q: text,
      });

      const url = `${this.baseUrl}?${params.toString()}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP错误! 状态码: ${response.status}`);
      }

      const data = await response.json();
      if (data && data[2]) {
        return data[2];
      } else {
        console.warn("Google语言检测结果格式异常，返回英语");
        return "en";
      }
    } catch (error) {
      console.error("Google语言检测失败:", error);
      return "en";
    }
  }

  async translate(text, fromLang, toLang) {
    try {
      const params = new URLSearchParams({
        client: "gtx",
        sl: fromLang,
        tl: toLang,
        dt: "t",
        q: text,
      });

      const url = `${this.baseUrl}?${params.toString()}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP错误! 状态码: ${response.status}`);
      }

      const data = await response.json();
      if (data && data[0] && data[0][0] && data[0][0][0]) {
        return data[0][0][0];
      } else {
        throw new Error("Google翻译API返回格式异常");
      }
    } catch (error) {
      console.error("Google翻译失败:", error);
      throw error;
    }
  }
}

// Bing翻译API实现
class BingTranslationAPI extends BaseTranslationAPI {
  constructor() {
    super();
    this.tokenUrl = "https://edge.microsoft.com/translate/auth";
    this.translateUrl = "https://api.cognitive.microsofttranslator.com/translate";
    this.detectUrl = "https://api.cognitive.microsofttranslator.com/detect";
    this.token = null;
    this.tokenExpiry = null;
    this.maxConcurrentRequests = 5; // 最大并发请求数
    this.maxBatchSize = 50; // 每批最大文本数量
  }

  async getToken() {
    // 检查令牌是否仍然有效
    if (this.token && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      console.log("使用缓存的Bing令牌");
      return this.token;
    }

    try {
      const response = await fetch(this.tokenUrl);

      if (!response.ok) {
        throw new Error(`Bing令牌API错误: ${response.status}`);
      }

      this.token = await response.text();
      // 令牌通常有效期10分钟，我们设置8分钟以确保安全
      this.tokenExpiry = Date.now() + 8 * 60 * 1000;

      return this.token;
    } catch (error) {
      console.error("获取Bing令牌失败:", error);
      throw error;
    }
  }

  async detectLanguage(text) {
    try {
      const token = await this.getToken();

      const url = `${this.detectUrl}?api-version=3.0`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ Text: text }]),
      });

      if (!response.ok) {
        throw new Error(`Bing语言检测API错误: ${response.status}`);
      }

      const data = await response.json();

      if (data && data[0] && data[0].language) {
        return data[0].language;
      } else {
        console.warn("Bing语言检测结果格式异常，返回英语");
        return "en";
      }
    } catch (error) {
      console.error("Bing语言检测失败:", error);
      return "en";
    }
  }

  async translate(text, fromLang, toLang) {
    try {
      const token = await this.getToken();

      const url = `${this.translateUrl}?api-version=3.0${fromLang !== "auto" ? `&from=${fromLang}` : ""}&to=${toLang}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ Text: text }]),
      });

      if (!response.ok) {
        throw new Error(`Bing翻译API错误: ${response.status}`);
      }

      const data = await response.json();

      if (data && data[0] && data[0].translations && data[0].translations[0]) {
        return data[0].translations[0].text;
      } else {
        throw new Error("Bing翻译API返回格式异常");
      }
    } catch (error) {
      console.error("Bing翻译失败:", error);
      throw error;
    }
  }

  async translateBatch(texts, fromLang, toLang) {
    try {
      // 预处理文本，移除空文本
      const validTexts = texts.map((text, index) => ({ text, index })).filter(item => item.text && item.text.trim());

      if (validTexts.length === 0) {
        return texts; // 全部为空文本，直接返回原文
      }

      // 获取token一次，所有请求共享
      const token = await this.getToken();

      // 创建批次
      const batches = [];
      for (let i = 0; i < validTexts.length; i += this.maxBatchSize) {
        batches.push(validTexts.slice(i, i + this.maxBatchSize));
      }

      // 并行处理批次
      const translatedTexts = new Array(texts.length);

      // 控制并发请求数
      const results = [];
      for (let i = 0; i < batches.length; i += this.maxConcurrentRequests) {
        const batchGroup = batches.slice(i, i + this.maxConcurrentRequests);

        // 创建当前组的所有请求
        const batchPromises = batchGroup.map(async batch => {
          const url = `${this.translateUrl}?api-version=3.0${fromLang !== "auto" ? `&from=${fromLang}` : ""}&to=${toLang}`;
          const response = await fetch(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(batch.map(item => ({ Text: item.text }))),
          });

          if (!response.ok) {
            throw new Error(`Bing批量翻译API错误: ${response.status}`);
          }

          const data = await response.json();

          // 将翻译结果按照原始顺序放回数组
          batch.forEach((item, idx) => {
            if (data[idx] && data[idx].translations && data[idx].translations.length > 0) {
              translatedTexts[item.index] = data[idx].translations[0].text;
            } else {
              translatedTexts[item.index] = item.text; // 翻译失败时返回原文
            }
          });
        });

        // 等待当前组的所有请求完成
        await Promise.all(batchPromises);
      }

      // 处理空文本和未翻译的文本
      for (let i = 0; i < texts.length; i++) {
        if (translatedTexts[i] === undefined) {
          translatedTexts[i] = texts[i];
        }
      }

      return translatedTexts;
    } catch (error) {
      console.error("Bing批量翻译失败:", error);
      // 如果批量翻译失败，则使用父类的逐个翻译实现
      return super.translateBatch(texts, fromLang, toLang);
    }
  }
}

// 翻译API工厂类
export class TranslationAPIFactory {
  static createAPI(serviceType) {
    switch (serviceType) {
      case TRANSLATION_SERVICES.GOOGLE:
        return new GoogleTranslationAPI();
      case TRANSLATION_SERVICES.BING:
      case TRANSLATION_SERVICES.MICROSOFT:
        return new BingTranslationAPI();
      default:
        // 默认使用Google
        return new GoogleTranslationAPI();
    }
  }
}

// 提供向后兼容的RealTranslateAPI类
class RealTranslateAPI {
  constructor(service = "google", apiKey = null) {
    console.log("初始化RealTranslateAPI，服务类型:", service);
    this.service = service;
    this.apiKey = apiKey;
    this.api = TranslationAPIFactory.createAPI(service);
  }

  async translate(text, sourceLang, targetLang) {
    try {
      return await this.api.translate(text, sourceLang, targetLang);
    } catch (error) {
      console.error("翻译错误:", error);
      throw error;
    }
  }

  async translateBatch(texts, sourceLang, targetLang) {
    try {
      return await this.api.translateBatch(texts, sourceLang, targetLang);
    } catch (error) {
      console.error("批量翻译错误:", error);
      throw error;
    }
  }

  async detectLanguage(text) {
    try {
      return await this.api.detectLanguage(text);
    } catch (error) {
      console.error("语言检测错误:", error);
      throw error;
    }
  }
}

// 创建翻译API实例
let translateAPI = null;

// 初始化翻译API
chrome.storage.sync.get(["translationService", "apiKey"], result => {
  const service = result.translationService || "google";
  const apiKey = result.apiKey || null;

  console.log("Initializing translation API with service:", service);
  translateAPI = new RealTranslateAPI(service, apiKey);
});

// 监听来自内容脚本和弹出窗口的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Background received message:", request);
  if (request.action === "translateText") {
    // 支持传入特定的翻译服务
    const service = request.service || null;
    translateText(request.text, request.sourceLang, request.targetLang, service)
      .then(translatedText => {
        console.log("Sending translated text response:", translatedText);
        sendResponse({ translatedText: translatedText });
      })
      .catch(error => {
        console.error("Translation error:", error);
        sendResponse({ translatedText: request.text }); // 出错时返回原文
      });
    return true; // 保持消息通道开放以进行异步响应
  } else if (request.action === "translateBatch") {
    console.log("Processing batch translation request");
    const texts = request.texts || [];
    const sourceLang = request.sourceLang || "auto";
    const targetLang = request.targetLang;
    const service = request.service || null;

    if (!targetLang || texts.length === 0) {
      sendResponse({ translatedTexts: texts });
      return true;
    }

    // 使用Promise包装整个翻译过程
    Promise.resolve().then(async () => {
      try {
        // 优化性能：优先使用Bing翻译API，因为它对批量翻译支持更好
        let api;
        if (texts.length > 50) {
          api = TranslationAPIFactory.createAPI("bing");
        } else {
          const actualService = service || "google";
          api = TranslationAPIFactory.createAPI(actualService);
        }

        // 优化：将大量文本分成更大的批次
        if (texts.length > 500) {
          const batchSize = 200;
          const translatedTexts = [];

          // 创建所有批次的Promise
          const batchPromises = [];
          for (let i = 0; i < texts.length; i += batchSize) {
            const batchTexts = texts.slice(i, i + batchSize);
            batchPromises.push(api.translateBatch(batchTexts, sourceLang, targetLang));
          }

          // 并行处理所有批次
          const batchResults = await Promise.all(batchPromises);

          // 合并所有结果
          for (const results of batchResults) {
            translatedTexts.push(...results);
          }

          // 发送翻译结果
          console.log("Sending batch translation response");
          sendResponse({ translatedTexts: translatedTexts });
        } else {
          // 调用批量翻译方法
          const translatedTexts = await api.translateBatch(texts, sourceLang, targetLang);

          // 发送翻译结果
          console.log("Sending batch translation response");
          sendResponse({ translatedTexts: translatedTexts });
        }
      } catch (error) {
        console.error("Translation error:", error);

        // 如果当前服务失败，尝试切换到另一个服务
        const alternativeService = service === "google" ? "bing" : "google";
        console.log(`Switching to alternative service: ${alternativeService}`);

        try {
          // 创建备用翻译服务实例
          const api = TranslationAPIFactory.createAPI(alternativeService);

          // 调用批量翻译方法
          const translatedTexts = await api.translateBatch(texts, sourceLang, targetLang);

          // 发送翻译结果
          console.log("Sending batch translation response with alternative service");
          sendResponse({ translatedTexts: translatedTexts });
        } catch (alternativeError) {
          console.error("Alternative translation service also failed:", alternativeError);
          sendResponse({ translatedTexts: texts }); // 出错时返回原文
        }
      }
    });

    return true; // 保持消息通道开放以进行异步响应
  } else if (request.action === "getSettings") {
    chrome.storage.sync.get(["targetLanguage", "translationService", "apiKey"], result => {
      console.log("Sending settings response:", result);
      sendResponse({
        targetLanguage: result.targetLanguage || "en",
        translationService: result.translationService || "google",
        apiKey: result.apiKey || null,
      });
    });
    return true;
  } else if (request.action === "detectLanguage") {
    // 支持传入特定的翻译服务
    const service = request.service || null;
    detectLanguage(request.text, service)
      .then(language => {
        sendResponse({ language: language });
      })
      .catch(error => {
        console.error("Language detection error:", error);
        sendResponse({ language: "und" }); // 无法检测时返回未知语言
      });
    return true;
  } else if (request.action === "updateSettings") {
    // 更新设置
    if (request.settings) {
      chrome.storage.sync.set(request.settings, () => {
        console.log("Settings updated:", request.settings);
        // 通知所有标签页设置已更新
        chrome.tabs.query({}, tabs => {
          tabs.forEach(tab => {
            try {
              chrome.tabs.sendMessage(tab.id, {
                action: "settingsUpdated",
                settings: request.settings,
              });
            } catch (e) {
              // 忽略无法发送消息的标签页
              console.debug("Failed to send settings update to tab:", tab.id);
            }
          });
        });
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false, error: "No settings provided" });
    }
    return true;
  } else if (request.action === "retranslatePage") {
    // 重新翻译页面
    if (sender.tab && sender.tab.id) {
      chrome.tabs.sendMessage(sender.tab.id, { action: "translatePage" });
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: "Invalid tab" });
    }
    return true;
  }
});

// 翻译单个文本
async function translateText(text, sourceLang, targetLang, service = null) {
  console.log(`Translating text: ${text} from ${sourceLang} to ${targetLang} using service: ${service || "default"}`);
  // 使用指定的翻译服务
  if (service) {
    try {
      const api = TranslationAPIFactory.createAPI(service);
      const result = await api.translate(text, sourceLang, targetLang);
      console.log("Translation result with specified service:", result);
      return result;
    } catch (error) {
      console.error(`Translation with service ${service} failed:`, error);
      // 如果指定的服务失败，回退到默认服务
    }
  }

  // 使用默认翻译API
  if (translateAPI) {
    try {
      const result = await translateAPI.translate(text, sourceLang, targetLang);
      console.log("Translation result with default service:", result);
      return result;
    } catch (error) {
      console.error("Real translation failed, falling back to mock translation:", error);
    }
  }

  // 否则使用模拟翻译
  const result = mockTranslate(text, targetLang);
  console.log("Mock translation result:", result);
  return result;
}

// 批量翻译文本
async function translateBatch(texts, sourceLang, targetLang, service = null) {
  console.log(
    `Translating batch of ${texts.length} texts from ${sourceLang} to ${targetLang} using service: ${service || "default"}`
  );
  // 使用指定的翻译服务
  if (service) {
    try {
      const api = TranslationAPIFactory.createAPI(service);
      const result = await api.translateBatch(texts, sourceLang, targetLang);
      console.log("Batch translation result with specified service:", result);
      return result;
    } catch (error) {
      console.error(`Batch translation with service ${service} failed:`, error);
      // 如果指定的服务失败，回退到默认服务
    }
  }

  // 使用默认翻译API
  if (translateAPI) {
    try {
      const result = await translateAPI.translateBatch(texts, sourceLang, targetLang);
      console.log("Batch translation result with default service:", result);
      return result;
    } catch (error) {
      console.error("Real batch translation failed, falling back to mock translation:", error);
    }
  }

  // 否则使用模拟翻译
  const result = texts.map(text => mockTranslate(text, targetLang));
  console.log("Mock batch translation result:", result);
  return result;
}

// 检测文本语言
async function detectLanguage(text, service = null) {
  console.log(`Detecting language for text: ${text.substring(0, 20)}... using service: ${service || "default"}`);
  // 使用指定的翻译服务
  if (service) {
    try {
      const api = TranslationAPIFactory.createAPI(service);
      return await api.detectLanguage(text);
    } catch (error) {
      console.error(`Language detection with service ${service} failed:`, error);
      // 如果指定的服务失败，回退到默认服务
    }
  }

  // 使用真实语言检测
  if (translateAPI) {
    try {
      return await translateAPI.detectLanguage(text);
    } catch (error) {
      console.error("Real language detection failed:", error);
    }
  }

  // 简单模拟语言检测
  return "en"; // 默认返回英语
}

// 简单的模拟翻译函数
function mockTranslate(text, targetLang) {
  // 简单的模拟翻译
  const translations = {
    Hello: { en: "Hello", es: "Hola", fr: "Bonjour", de: "Hallo" },
    World: { en: "World", es: "Mundo", fr: "Monde", de: "Welt" },
    Translate: { en: "Translate", es: "Traducir", fr: "Traduire", de: "Übersetzen" },
    Page: { en: "Page", es: "Página", fr: "Page", de: "Seite" },
    Web: { en: "Web", es: "Web", fr: "Web", de: "Web" },
  };

  // 在实际实现中，这里会调用真正的翻译API
  return translations[text] && translations[text][targetLang] ? translations[text][targetLang] : text + " (translated)";
}

// 创建上下文菜单
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "translatePage",
    title: chrome.i18n.getMessage("translatePageTitle"),
    contexts: ["page"],
  });

  chrome.contextMenus.create({
    id: "translateSelected",
    title: chrome.i18n.getMessage("translateSelectedTextTitle"),
    contexts: ["selection"],
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
      selectedText: info.selectionText,
    });
  }
});

// 监听存储变化以更新API设置
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync") {
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
      chrome.storage.sync.get(["translationService", "apiKey"], result => {
        translateAPI = new RealTranslateAPI(
          service || result.translationService || "google",
          apiKey || result.apiKey || null
        );
      });
    }
  }
});
