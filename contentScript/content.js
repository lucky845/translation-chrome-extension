// 存储原始文本的映射
const originalTextMap = new Map();
// 存储已翻译的节点
const translatedNodes = new Set();
// 滚动翻译相关变量
let isTranslating = false;
let scrollTranslationEnabled = true; // 默认启用滚动翻译
let scrollTimeout = null;
// 页面加载时恢复翻译状态
let pageTranslationState = null;

// 页面加载时尝试恢复翻译状态
try {
  const savedState = sessionStorage.getItem('translationState');
  if (savedState) {
    pageTranslationState = JSON.parse(savedState);
    console.log("Restored translation state:", pageTranslationState);
  }
} catch (e) {
  console.error("Failed to restore translation state:", e);
}

// 监听来自后台脚本的消息
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log("Content script received message:", request);
  if (request.action === "translatePage") {
    translateEntirePage();
  } else if (request.action === "translateSelectedText") {
    translateSelectedText(request.selectedText);
  } else if (request.action === "restorePage") {
    restorePage();
  }
});

// 无需enableScrollTranslation和disableScrollTranslation函数，因为滚动翻译始终启用

// 处理滚动事件
function handleScroll() {
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
  }
  scrollTimeout = setTimeout(translateVisibleArea, 250); // 防抖动
}

// 翻译可见区域
async function translateVisibleArea() {
  if (isTranslating) return;
  
  isTranslating = true;
  try {
    console.log("Translating visible area");
    // 获取设置的目标语言
    const settings = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "getSettings" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
    
    const targetLanguage = settings.targetLanguage;
    
    // 获取可见区域的文本节点
    const visibleTextNodes = getVisibleTextNodes();
    console.log(`Found ${visibleTextNodes.length} visible text nodes`);
    
    // 过滤出未翻译的节点
    const untranslatedNodes = visibleTextNodes.filter(node => !translatedNodes.has(node));
    console.log(`Found ${untranslatedNodes.length} untranslated nodes`);
    
    if (untranslatedNodes.length === 0) {
      isTranslating = false;
      return;
    }
    
    // 提取文本值
    const textValues = untranslatedNodes.map(node => node.nodeValue);
    
    // 批量翻译（分批处理以避免API限制）
    const batchSize = 50; // 每批50个文本
    for (let i = 0; i < textValues.length; i += batchSize) {
      const batchNodes = untranslatedNodes.slice(i, i + batchSize);
      const batchTexts = textValues.slice(i, i + batchSize);
      
      try {
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "translateBatch",
            texts: batchTexts,
            sourceLang: "auto",
            targetLang: targetLanguage
          }, (response) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(response);
            }
          });
        });
        
        // 应用翻译结果
        const translatedTexts = response.translatedTexts;
        for (let j = 0; j < batchNodes.length && j < translatedTexts.length; j++) {
          batchNodes[j].nodeValue = translatedTexts[j];
          // 保存原始文本并标记为已翻译
          originalTextMap.set(batchNodes[j], batchTexts[j]);
          translatedNodes.add(batchNodes[j]);
        }
      } catch (error) {
        console.error("Batch translation failed:", error);
      }
    }
    
    console.log("Finished translating visible area");
    // 保存翻译状态
    saveTranslationState();
  } catch (error) {
    console.error("Visible area translation failed:", error);
  } finally {
    isTranslating = false;
  }
}

// 获取可见区域的文本节点
function getVisibleTextNodes() {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  const textNodes = [];
  let node;
  
  while (node = walker.nextNode()) {
    // 检查节点是否在可见区域内
    if (isElementInViewport(node.parentElement) && 
        node.nodeValue && 
        node.nodeValue.trim() && 
        !isContentEditable(node.parentElement)) {
      textNodes.push(node);
    }
  }
  
  return textNodes;
}

// 检查元素是否在视口中
function isElementInViewport(element) {
  if (!element) return false;
  
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

// 检查元素是否是可编辑的
function isContentEditable(element) {
  if (!element) return false;
  return element.getAttribute && element.getAttribute('contenteditable') === 'true';
}

// 翻译整个页面（优化版本）
async function translateEntirePage() {
  console.log("Starting page translation...");
  try {
    // 获取设置的目标语言
    console.log("Requesting settings from background script");
    const settings = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "getSettings" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
    
    console.log("Received settings:", settings);
    const targetLanguage = settings.targetLanguage;
    
    // 获取页面上所有文本节点
    console.log("Collecting text nodes");
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    const textNodes = [];
    const textValues = [];
    let node;
    
    while (node = walker.nextNode()) {
      // 兼容性处理，避免使用可选链操作符
      let isEditable = false;
      if (node.parentElement && node.parentElement.getAttribute) {
        isEditable = node.parentElement.getAttribute('contenteditable') === 'true';
      }
      
      if (node.nodeValue && node.nodeValue.trim() && !isEditable) {
        textNodes.push(node);
        textValues.push(node.nodeValue);
      }
    }
    
    console.log(`Found ${textNodes.length} text nodes to translate`);
    
    // 如果没有文本节点，直接返回
    if (textNodes.length === 0) {
      console.log("No text nodes found to translate");
      return;
    }
    
    // 恢复已保存的原始文本（如果存在）
    if (pageTranslationState && pageTranslationState.originalTexts) {
      // 从保存的状态中恢复原始文本
      Object.keys(pageTranslationState.originalTexts).forEach(selector => {
        const originalText = pageTranslationState.originalTexts[selector];
        // 尝试找到对应的节点
        const node = findTextNodeBySelector(selector);
        if (node) {
          originalTextMap.set(node, originalText);
        }
      });
    }
    
    // 分批处理以提高性能（每批50个文本）
    const batchSize = 50;
    for (let i = 0; i < textValues.length; i += batchSize) {
      const batchNodes = textNodes.slice(i, i + batchSize);
      const batchTexts = textValues.slice(i, i + batchSize);
      
      console.log(`Sending batch translation request for ${batchTexts.length} texts`);
      try {
        // 发送批量翻译请求
        const response = await new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            action: "translateBatch",
            texts: batchTexts,
            sourceLang: "auto",
            targetLang: targetLanguage
          }, (response) => {
            if (chrome.runtime.lastError) {
              reject(chrome.runtime.lastError);
            } else {
              resolve(response);
            }
          });
        });
        
        console.log("Received translation response");
        
        // 应用翻译结果
        const translatedTexts = response.translatedTexts;
        for (let j = 0; j < batchNodes.length && j < translatedTexts.length; j++) {
          // 只有在没有保存原始文本的情况下才保存
          if (!originalTextMap.has(batchNodes[j])) {
            originalTextMap.set(batchNodes[j], batchTexts[j]);
          }
          batchNodes[j].nodeValue = translatedTexts[j];
          translatedNodes.add(batchNodes[j]);
        }
        
        console.log(`Translated ${Math.min(batchNodes.length, translatedTexts.length)} text nodes in batch`);
      } catch (error) {
        console.error("Batch translation failed:", error);
      }
    }
    
    console.log("Page translation completed");
    // 保存翻译状态
    saveTranslationState();
  } catch (error) {
    console.error("Translation failed:", error);
  }
}

// 根据选择器查找文本节点
function findTextNodeBySelector(selector) {
  try {
    // 简化的选择器实现 - 在实际应用中可能需要更复杂的逻辑
    const parts = selector.split(' > ');
    let element = document.body;
    
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (part.startsWith('#')) {
        element = document.getElementById(part.substring(1));
      } else if (part.startsWith('.')) {
        element = element.querySelector(part);
      } else {
        element = element.querySelector(part);
      }
      if (!element) return null;
    }
    
    // 获取最后一个部分对应的文本节点
    const lastPart = parts[parts.length - 1];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    
    let node;
    while (node = walker.nextNode()) {
      if (node.nodeValue && node.nodeValue.trim()) {
        // 简化匹配逻辑
        if (node.nodeValue.trim() === lastPart) {
          return node;
        }
      }
    }
  } catch (e) {
    console.error("Error finding text node by selector:", e);
  }
  return null;
}

// 生成文本节点的选择器
function generateTextNodeSelector(node) {
  if (!node.parentElement) return '';
  
  // 获取元素路径
  const getPathTo = (element) => {
    if (element.id) {
      return `#${element.id}`;
    }
    
    if (element === document.body) {
      return 'body';
    }
    
    let ix = 0;
    const siblings = element.parentNode.childNodes;
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === element) {
        const tagName = element.tagName.toLowerCase();
        const pathIndex = (ix ? `:nth-child(${ix + 1})` : '');
        return `${getPathTo(element.parentNode)} > ${tagName}${pathIndex}`;
      }
      if (sibling.nodeType === 1 && sibling.tagName === element.tagName) {
        ix++;
      }
    }
  };
  
  const path = getPathTo(node.parentElement);
  return `${path} > ${node.nodeValue.trim()}`;
}

// 保存翻译状态到 sessionStorage
function saveTranslationState() {
  try {
    const state = {
      timestamp: Date.now(),
      originalTexts: {}
    };
    
    // 保存原始文本
    originalTextMap.forEach((originalText, node) => {
      const selector = generateTextNodeSelector(node);
      if (selector) {
        state.originalTexts[selector] = originalText;
      }
    });
    
    sessionStorage.setItem('translationState', JSON.stringify(state));
    console.log("Translation state saved");
  } catch (e) {
    console.error("Failed to save translation state:", e);
  }
}

// 翻译选定的文本
async function translateSelectedText(selectedText) {
  console.log("Translating selected text:", selectedText);
  try {
    const settings = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "getSettings" }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
    
    const targetLanguage = settings.targetLanguage;
    
    const response = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: "translateText",
        text: selectedText,
        sourceLang: "auto",
        targetLang: targetLanguage
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve(response);
        }
      });
    });
    
    // 创建一个弹出窗口显示翻译结果
    showTranslationPopup(selectedText, response.translatedText);
  } catch (error) {
    console.error("Failed to translate selected text:", error);
  }
}

// 恢复页面到原始状态
function restorePage() {
  console.log("Restoring page to original state");
  // 恢复所有保存的原始文本
  originalTextMap.forEach((originalText, textNode) => {
    textNode.nodeValue = originalText;
  });
  
  // 清空映射
  originalTextMap.clear();
  translatedNodes.clear();
  
  // 禁用滚动翻译
  disableScrollTranslation();
  
  // 清除保存的翻译状态
  sessionStorage.removeItem('translationState');
}

// 显示翻译结果弹窗
function showTranslationPopup(originalText, translatedText) {
  console.log("Showing translation popup");
  // 移除已存在的弹窗
  const existingPopup = document.getElementById('translation-popup');
  if (existingPopup) {
    existingPopup.remove();
  }
  
  // 创建弹窗元素
  const popup = document.createElement('div');
  popup.id = 'translation-popup';
  popup.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    width: 300px;
    background: white;
    border: 1px solid #ccc;
    border-radius: 5px;
    padding: 15px;
    box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    z-index: 10000;
    font-family: Arial, sans-serif;
  `;
  
  popup.innerHTML = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
      <h3 style="margin: 0; color: #333;">Translation</h3>
      <button id="close-popup" style="background: none; border: none; font-size: 18px; cursor: pointer;">&times;</button>
    </div>
    <div style="margin-bottom: 10px;">
      <strong>Original:</strong>
      <div style="background: #f5f5f5; padding: 8px; border-radius: 3px; margin-top: 5px; max-height: 100px; overflow-y: auto;">${originalText}</div>
    </div>
    <div>
      <strong>Translated:</strong>
      <div style="background: #e8f4f8; padding: 8px; border-radius: 3px; margin-top: 5px; max-height: 100px; overflow-y: auto;">${translatedText}</div>
    </div>
  `;
  
  document.body.appendChild(popup);
  
  // 添加关闭按钮事件
  document.getElementById('close-popup').addEventListener('click', () => {
    popup.remove();
  });
  
  // 5秒后自动关闭
  setTimeout(() => {
    if (popup.parentNode) {
      popup.remove();
    }
  }, 5000);
}

// 页面加载完成后启用滚动翻译并翻译可见区域
document.addEventListener('DOMContentLoaded', () => {
  // 启用滚动翻译
  document.addEventListener('scroll', handleScroll);
  // 立即翻译可见区域
  translateVisibleArea();
  
  // 如果有保存的翻译状态，则尝试恢复
  if (pageTranslationState) {
    console.log("Page loaded with saved translation state");
    // 这里可以添加自动恢复翻译的逻辑
    // 由于我们默认启用保持翻译状态，我们可以尝试恢复
    restoreTranslationFromState();
  }
});

// 从保存的状态恢复翻译
function restoreTranslationFromState() {
  if (!pageTranslationState || !pageTranslationState.originalTexts) return;
  
  // 遍历保存的原始文本并尝试恢复翻译
  Object.keys(pageTranslationState.originalTexts).forEach(selector => {
    const node = findTextNodeBySelector(selector);
    if (node) {
      // 检查节点当前值是否与原始值不同（意味着已被翻译）
      const originalText = pageTranslationState.originalTexts[selector];
      if (node.nodeValue !== originalText) {
        // 节点已被翻译，将其添加到已翻译集合中
        originalTextMap.set(node, originalText);
        translatedNodes.add(node);
      }
    }
  });
  
  console.log("Restored translation from saved state");
}