// 参考Traduzir-paginas-web项目实现的网页翻译功能

// 翻译状态跟踪
let isTranslating = false;
let isTranslated = false;
const originalTextMap = new Map();
const translatedNodes = new Set();
let scrollTimeout = null;
let currentTranslationService = "google";
let targetLanguage = "zh-CN";
let sourceLanguage = "auto"; // 源语言，默认自动检测
const scrollTranslationEnabled = true;
let autoTranslateEnabled = false;
let autoDetectSource = true; // 是否自动检测源语言，默认为true
let errorCount = 0;
const MAX_ERRORS = 3;

// 页面初始化
function init() {
  // 注册事件监听器
  registerEventListeners();

  // 加载用户设置
  loadSettings()
    .then(() => {
      // 在设置加载完成后再处理页面翻译状态
      checkAndHandlePageTranslation();
    })
    .catch(error => {
      console.error("Failed to load settings:", error);
      // 即使设置加载失败，也要尝试检查翻译状态
      checkAndHandlePageTranslation();
    });
}

// 注册事件监听器
function registerEventListeners() {
  // 监听来自后台和弹出页的消息
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    console.log("Content script received message:", request);

    // 获取当前页面的语言
    const pageLang = getPageLanguage();

    switch (request.action) {
      case "translatePage":
        translateEntirePage().then(() => sendResponse({ success: true }));
        return true;

      case "restorePage":
        restorePage();
        sendResponse({ success: true });
        break;

      case "translateSelectedText":
        translateSelectedText(request.selectedText);
        break;

      case "getTranslationState":
        sendResponse({
          isTranslated: isTranslated,
          translationService: currentTranslationService,
        });
        break;

      case "getPageLanguage":
        sendResponse({
          language: pageLang,
        });
        break;

      case "settingsUpdated":
        updateSettings(request.settings);
        sendResponse({ success: true });
        break;
    }

    return true;
  });

  // 监听滚动事件
  document.addEventListener("scroll", handleScroll);

  // 监听页面内容变化
  const observer = new MutationObserver(handlePageChanges);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// 加载用户设置
function loadSettings() {
  return new Promise(resolve => {
    chrome.storage.sync.get(["targetLanguage", "translationService", "autoTranslate", "autoDetectSource"], result => {
      targetLanguage = result.targetLanguage || "zh-CN";
      currentTranslationService = result.translationService || "google";
      autoTranslateEnabled = result.autoTranslate || false;
      if (result.autoDetectSource !== undefined) {
        autoDetectSource = result.autoDetectSource;
      }

      console.log("Loaded settings:", {
        targetLanguage,
        currentTranslationService,
        autoTranslateEnabled,
        autoDetectSource,
      });

      resolve();
    });
  });
}

// 更新设置
function updateSettings(settings) {
  if (settings.targetLanguage) {
    targetLanguage = settings.targetLanguage;
  }

  if (settings.translationService) {
    currentTranslationService = settings.translationService;
  }

  if (typeof settings.autoTranslate === "boolean") {
    autoTranslateEnabled = settings.autoTranslate;
  }

  console.log("Settings updated:", {
    targetLanguage,
    currentTranslationService,
    autoTranslateEnabled,
  });
}

// 检查并处理页面翻译
function checkAndHandlePageTranslation() {
  // 检查是否需要自动翻译
  if (autoTranslateEnabled) {
    console.log("Auto-translate is enabled");

    // 检查页面语言是否为英文
    const pageLang = getPageLanguage();
    if (pageLang && pageLang.startsWith("en")) {
      console.log(`Auto-translating page (detected language: ${pageLang})`);
      setTimeout(() => {
        translateEntirePage();
      }, 800); // 短暂延迟确保页面完全加载
    } else {
      console.log(`Not auto-translating (detected language: ${pageLang || "unknown"})`);
    }
  }
}

// 获取页面语言
function getPageLanguage() {
  // 1. 检查HTML lang属性
  const lang = document.documentElement.lang;
  if (lang) return lang;

  // 2. 检查meta标签
  const metaLang = document.querySelector('meta[http-equiv="content-language"]');
  if (metaLang && metaLang.content) return metaLang.content;

  // 3. 检查Open Graph标签
  const ogLocale = document.querySelector('meta[property="og:locale"]');
  if (ogLocale && ogLocale.content) return ogLocale.content.split("_")[0];

  // 4. 尝试检测内容语言（简单实现）
  return detectContentLanguage();
}

// 异步页面语言检测（结合API检测）
async function detectPageLanguage() {
  // 先尝试通过页面元数据获取语言
  const pageLang = getPageLanguage();

  // 如果启用了API检测，尝试通过翻译API进一步确认
  if (autoDetectSource) {
    try {
      // 获取页面中一段具有代表性的文本进行语言检测
      const sampleText = getPageSampleText();
      if (sampleText) {
        const detectedLang = await new Promise(resolve => {
          chrome.runtime.sendMessage(
            {
              action: "detectLanguage",
              text: sampleText,
              service: currentTranslationService,
            },
            response => {
              if (response && response.language) {
                resolve(response.language);
              } else {
                resolve(pageLang);
              }
            }
          );
        });
        return detectedLang;
      }
    } catch (error) {
      console.error("Language detection via API failed:", error);
      // 检测失败时回退到页面元数据语言
    }
  }
  return pageLang;
}

// 获取页面样本文本用于语言检测
function getPageSampleText() {
  // 尝试从页面中获取一段有代表性的文本
  const paragraphs = document.querySelectorAll("p, h1, h2, h3, h4, h5, h6");
  for (let i = 0; i < paragraphs.length; i++) {
    const text = paragraphs[i].textContent.trim();
    // 确保文本足够长以进行准确检测
    if (text.length > 50) {
      return text.substring(0, 500); // 截取前500个字符用于检测
    }
  }

  // 如果没有找到足够长的段落，尝试获取body文本
  const bodyText = document.body.textContent.trim();
  return bodyText.length > 50 ? bodyText.substring(0, 500) : null;
}

// 检测内容语言
function detectContentLanguage() {
  try {
    const text = document.body.innerText.toLowerCase();

    // 检查文本长度
    if (text.length < 150) return null;

    // 英文特征词
    const englishFeatures = ["the", "and", "to", "of", "a", "in", "that", "is", "i", "it"];

    // 计算英文特征词密度
    let englishCount = 0;
    for (const word of englishFeatures) {
      const regex = new RegExp(`\\b${word}\\b`, "gi");
      const matches = text.match(regex);
      if (matches) englishCount += matches.length;
    }

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const density = wordCount > 0 ? englishCount / wordCount : 0;

    // 如果英文特征词密度超过阈值，认为是英文页面
    return density > 0.03 || englishCount > 20 ? "en" : null;
  } catch (e) {
    console.error("Error detecting content language:", e);
    return null;
  }
}

// 处理滚动事件
function handleScroll() {
  if (!scrollTranslationEnabled || isTranslating) return;

  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
  }

  scrollTimeout = setTimeout(() => {
    if (isTranslated) {
      translateVisibleArea();
    }
  }, 300);
}

// 处理页面内容变化
function handlePageChanges(mutations) {
  if (!isTranslated || isTranslating) return;

  // 检查是否有新的文本内容被添加
  for (const mutation of mutations) {
    if (mutation.addedNodes && mutation.addedNodes.length > 0) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // 立即处理
          translateElement(node);

          // 再设置一个短延迟，确保内容完全加载
          setTimeout(() => {
            translateElement(node);
          }, 200);
        }
      }
    }
    // 也处理修改的节点
    if (mutation.type === "characterData" && mutation.target.nodeType === Node.TEXT_NODE) {
      const textNode = mutation.target;
      if (!translatedNodes.has(textNode) && filterTextNode(textNode) === NodeFilter.FILTER_ACCEPT) {
        setTimeout(() => {
          translateTextNodes([textNode]);
        }, 100);
      }
    }
  }
}

// 翻译整个页面
async function translateEntirePage() {
  if (isTranslating) return;

  isTranslating = true;
  try {
    console.log("Starting full page translation");

    // 重置翻译状态
    if (isTranslated) {
      restorePage();
    }

    // 如果启用了自动检测源语言，先检测页面语言
    if (autoDetectSource) {
      const detectedLang = await detectPageLanguage();
      if (detectedLang && detectedLang !== targetLanguage) {
        sourceLanguage = detectedLang;
      } else {
        sourceLanguage = "auto"; // 如果检测失败或与目标语言相同，使用自动检测
      }
    }

    // 获取所有文本节点
    const textNodes = collectAllTextNodes();
    if (textNodes.length === 0) {
      console.log("No text nodes found to translate");
      return;
    }

    // 分批翻译
    await translateTextNodes(textNodes);

    // 更新翻译状态
    isTranslated = true;
    console.log("Full page translation completed");

    // 通知后台脚本翻译完成
    chrome.runtime.sendMessage({ action: "translationCompleted" });
  } catch (error) {
    console.error("Full page translation failed:", error);
    handleTranslationError();
  } finally {
    isTranslating = false;
  }
}

// 翻译可见区域
async function translateVisibleArea() {
  if (isTranslating) return;

  isTranslating = true;
  try {
    // 获取可见区域的文本节点
    const visibleNodes = getVisibleTextNodes();

    // 过滤未翻译的节点
    const untranslatedNodes = visibleNodes.filter(node => !translatedNodes.has(node));
    if (untranslatedNodes.length === 0) {
      return;
    }

    // 翻译可见节点
    await translateTextNodes(untranslatedNodes);
  } catch (error) {
    console.error("Visible area translation failed:", error);
    handleTranslationError();
  } finally {
    isTranslating = false;
  }
}

// 翻译指定元素
async function translateElement(element) {
  if (isTranslating || !element || element.isContentEditable) return;

  // 获取元素内的文本节点
  const textNodes = collectTextNodesFromElement(element);
  if (textNodes.length === 0) return;

  // 过滤未翻译的节点
  const untranslatedNodes = textNodes.filter(node => !translatedNodes.has(node));
  if (untranslatedNodes.length === 0) return;

  // 翻译节点
  await translateTextNodes(untranslatedNodes);
}

// 翻译文本节点
async function translateTextNodes(nodes) {
  if (nodes.length === 0) return;

  // 提取文本内容
  const texts = nodes.map(node => node.nodeValue);

  // 分批处理
  const batchSize = 150;
  const promises = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchTexts = texts.slice(i, i + batchSize);
    const batchNodes = nodes.slice(i, i + batchSize);

    promises.push(
      translateBatch(batchTexts, batchNodes).catch(error => {
        console.error(`Batch translation failed at index ${i}:`, error);
        // 单个批次失败不应影响其他批次
      })
    );
  }

  // 等待所有批次完成
  await Promise.all(promises);
}

// 翻译一批文本
async function translateBatch(texts, nodes) {
  try {
    // 调用后台翻译API
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        {
          action: "translateBatch",
          texts: texts,
          sourceLang: sourceLanguage, // 使用检测到的源语言或auto
          targetLang: targetLanguage,
          service: currentTranslationService,
        },
        response => {
          if (chrome.runtime.lastError) {
            reject(chrome.runtime.lastError);
          } else {
            resolve(response);
          }
        }
      );
    });

    // 应用翻译结果
    if (response && response.translatedTexts) {
      for (let i = 0; i < nodes.length && i < response.translatedTexts.length; i++) {
        // 保存原始文本
        if (!originalTextMap.has(nodes[i])) {
          originalTextMap.set(nodes[i], texts[i]);
        }

        // 更新节点值
        nodes[i].nodeValue = response.translatedTexts[i];
        translatedNodes.add(nodes[i]);
      }

      // 重置错误计数
      errorCount = 0;
    }
  } catch (error) {
    console.error("Batch translation error:", error);
    throw error;
  }
}

// 处理翻译错误
function handleTranslationError() {
  errorCount++;

  // 如果达到最大错误数，尝试切换翻译服务
  if (errorCount >= MAX_ERRORS) {
    switchTranslationService();
    errorCount = 0;
  }
}

// 切换翻译服务
function switchTranslationService() {
  const services = ["google", "bing"];
  const currentIndex = services.indexOf(currentTranslationService);
  const nextIndex = (currentIndex + 1) % services.length;

  currentTranslationService = services[nextIndex];
  console.log(`Switched translation service to: ${currentTranslationService}`);

  // 通知后台更新设置
  chrome.storage.sync.set({ translationService: currentTranslationService });
}

// 收集所有文本节点
function collectAllTextNodes() {
  const nodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: filterTextNode }, false);

  let node;
  while ((node = walker.nextNode())) {
    nodes.push(node);
  }

  return nodes;
}

// 从指定元素收集文本节点
function collectTextNodesFromElement(element) {
  const nodes = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, { acceptNode: filterTextNode }, false);

  let node;
  while ((node = walker.nextNode())) {
    nodes.push(node);
  }

  return nodes;
}

// 过滤文本节点
function filterTextNode(node) {
  // 跳过空文本
  const text = node.nodeValue.trim();
  if (text.length === 0) return NodeFilter.FILTER_SKIP;

  // 跳过可编辑元素的文本
  const parent = node.parentElement;
  if (!parent) return NodeFilter.FILTER_SKIP;

  // 跳过特定标签内的文本
  const tagName = parent.tagName.toLowerCase();
  if (["script", "style", "noscript", "svg", "canvas"].includes(tagName)) {
    return NodeFilter.FILTER_SKIP;
  }

  // 跳过可编辑元素
  if (parent.isContentEditable || parent.getAttribute("contenteditable") === "true") {
    return NodeFilter.FILTER_SKIP;
  }

  return NodeFilter.FILTER_ACCEPT;
}

// 获取可见区域的文本节点
function getVisibleTextNodes() {
  const nodes = collectAllTextNodes();
  return nodes.filter(node => {
    const parent = node.parentElement;
    return parent && isElementInViewport(parent);
  });
}

// 检查元素是否在视口中
function isElementInViewport(element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= -200 &&
    rect.left >= -200 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) + 200 &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth) + 200
  );
}

// 恢复页面到原始状态
function restorePage() {
  console.log("Restoring page to original state");

  // 恢复所有原始文本
  originalTextMap.forEach((originalText, node) => {
    try {
      node.nodeValue = originalText;
    } catch (e) {
      console.error("Error restoring node:", e);
    }
  });

  // 清空映射和集合
  originalTextMap.clear();
  translatedNodes.clear();

  // 更新翻译状态
  isTranslated = false;

  // 通知后台翻译已恢复
  chrome.runtime.sendMessage({ action: "translationRestored" });
}

// 翻译选定的文本
async function translateSelectedText(selectedText) {
  if (!selectedText || selectedText.trim() === "") return;

  console.log("Translating selected text");
  try {
    // 如果启用了自动检测源语言，先检测选中的文本语言
    let detectSourceLang = "auto";
    if (autoDetectSource) {
      // 直接使用后台的语言检测功能
      detectSourceLang = await new Promise(resolve => {
        chrome.runtime.sendMessage(
          {
            action: "detectLanguage",
            text: selectedText,
            service: currentTranslationService,
          },
          response => {
            if (response && response.language && response.language !== targetLanguage) {
              resolve(response.language);
            } else {
              resolve("auto");
            }
          }
        );
      });
    }

    // 调用后台API翻译选定文本
    chrome.runtime.sendMessage(
      {
        action: "translateText",
        text: selectedText,
        sourceLang: detectSourceLang, // 使用检测到的源语言或auto
        targetLang: targetLanguage,
        service: currentTranslationService,
      },
      response => {
        if (chrome.runtime.lastError || !response || !response.translatedText) {
          console.error("Selected text translation failed", chrome.runtime.lastError);
          showNotification("Translation failed", "Could not translate selected text");
          return;
        }

        // 显示翻译结果
        showTranslationPopup(selectedText, response.translatedText);
      }
    );
  } catch (error) {
    console.error("Selected text translation failed:", error);
    showNotification("Translation failed", "Could not translate selected text");
  }
}

// 显示翻译弹窗
function showTranslationPopup(originalText, translatedText) {
  // 移除已存在的弹窗
  const existingPopup = document.getElementById("translation-popup");
  if (existingPopup) {
    existingPopup.remove();
  }

  // 创建新弹窗
  const popup = document.createElement("div");
  popup.id = "translation-popup";
  popup.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    width: 320px;
    max-height: 80vh;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.15);
    padding: 16px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    overflow-y: auto;
  `;

  popup.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
      <h3 style="margin: 0; color: #333; font-size: 16px;">Translation</h3>
      <button id="close-popup" style="background: none; border: none; font-size: 20px; cursor: pointer; color: #999;">&times;</button>
    </div>
    <div style="margin-bottom: 12px;">
      <strong style="font-size: 12px; color: #666;">Original:</strong>
      <div style="background: #f8f9fa; padding: 10px; border-radius: 4px; margin-top: 4px; font-size: 14px;">${escapeHtml(originalText)}</div>
    </div>
    <div>
      <strong style="font-size: 12px; color: #666;">Translated:</strong>
      <div style="background: #e3f2fd; padding: 10px; border-radius: 4px; margin-top: 4px; font-size: 14px;">${escapeHtml(translatedText)}</div>
    </div>
  `;

  document.body.appendChild(popup);

  // 关闭按钮事件
  document.getElementById("close-popup").addEventListener("click", () => {
    popup.remove();
  });

  // 点击外部关闭
  document.addEventListener("click", function closePopupOnClick(event) {
    if (!popup.contains(event.target)) {
      popup.remove();
      document.removeEventListener("click", closePopupOnClick);
    }
  });

  // 10秒后自动关闭
  setTimeout(() => {
    if (popup.parentNode) {
      popup.remove();
    }
  }, 10000);
}

// 显示通知
function showNotification(title, message) {
  // 创建通知元素
  const notification = document.createElement("div");
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #333;
    color: white;
    padding: 12px 20px;
    border-radius: 4px;
    z-index: 2147483647;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  notification.textContent = title + ": " + message;
  document.body.appendChild(notification);

  // 3秒后自动移除
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

// HTML转义
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// 初始化扩展
init();
