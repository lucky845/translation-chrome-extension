/**
 * Service worker：消息路由与生命周期管理。
 *
 * 与旧实现的关键差异：
 *   - 不再有顶层异步初始化竞态，设置每次按需读取（settings.js 内有缓存）。
 *   - 删除了 mockTranslate 兜底：翻译失败就如实报告失败，绝不返回伪译文。
 *   - 删除 webRequest / scripting 等未使用权限。
 *   - 接线 chrome.commands 与 contextMenus。
 */

import { getSettings, updateSettings } from "./settings.js";
import { translateTexts, clearCache } from "./translator.js";

// ---- 消息路由 ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.action];
  if (!handler) {
    sendResponse({ ok: false, error: `未知动作：${message && message.action}` });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message, sender))
    .then(sendResponse)
    .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));

  return true; // 异步响应
});

const handlers = {
  /**
   * 批量翻译。
   * @param {Object} message 消息
   * @return {Promise<Object>} 结果
   */
  async translateBatch(message) {
    const texts = Array.isArray(message.texts) ? message.texts : [];
    if (texts.length === 0) return { ok: true, results: [], degraded: false };

    const settings = await getSettings();
    const outcome = await translateTexts(
      texts,
      message.sourceLanguage || settings.sourceLanguage,
      message.targetLanguage || settings.targetLanguage,
      message.engine
    );

    return {
      ok: outcome.ok,
      results: outcome.results,
      engine: outcome.engine,
      degraded: outcome.degraded,
      error: outcome.error,
    };
  },

  /**
   * 读取设置。
   * @return {Promise<Object>} 设置
   */
  async getSettings() {
    const settings = await getSettings();
    return { ok: true, settings, engines: await engineAvailability(settings) };
  },

  /**
   * 更新设置。
   * @param {Object} message 消息
   * @return {Promise<Object>} 新设置
   */
  async setSettings(message) {
    const settings = await updateSettings(message.settings || {});
    clearCache();
    return { ok: true, settings };
  },

  /**
   * 单条文本翻译（选中文本场景）。
   * @param {Object} message 消息
   * @return {Promise<Object>} 结果
   */
  async translateText(message) {
    const settings = await getSettings();
    const outcome = await translateTexts(
      [message.text || ""],
      message.sourceLanguage || settings.sourceLanguage,
      message.targetLanguage || settings.targetLanguage,
      message.engine
    );

    return {
      ok: outcome.ok,
      translatedText: outcome.results.length > 0 ? outcome.results[0].text : "",
      detected: outcome.results.length > 0 ? outcome.results[0].detected : null,
      engine: outcome.engine,
      degraded: outcome.degraded,
      error: outcome.error,
    };
  },

  /**
   * 引擎可用性探测（供 popup/options 显示真实状态）。
   * @return {Promise<Object>} 可用性
   */
  async getEngineStatus() {
    try {
      const settings = await getSettings();
      return { ok: true, engines: await engineAvailability(settings) };
    } catch (error) {
      return { ok: false, engines: {}, error: error && error.message ? error.message : String(error) };
    }
  },
};

/**
 * 探测各引擎当前是否真实可用。
 *
 * 这里刻意做一次真实请求而不是只看配置：Bing 端点已实测失效，
 * 只看"有没有填 key"会把一个发不出请求的引擎显示成可用。
 *
 * @param {Object} settings 设置
 * @return {Promise<Object>} 各引擎状态
 */
async function engineAvailability(settings) {
  const status = {
    google: { available: true, reason: null },
    bing: {
      available: Boolean(settings.apiKey),
      reason: settings.apiKey ? null : "需要 Azure 翻译密钥（免费端点已于 2026-11 失效）",
    },
    mymemory: { available: true, reason: null },
    lingva: { available: true, reason: null },
  };

  // 轻量探测 Google：单条极短请求，失败也不抛出
  try {
    const probe = await translateTexts(["hi"], "en", settings.targetLanguage, "google");
    status.google.available = probe.ok;
    status.google.reason = probe.ok ? null : probe.error || "请求失败";
  } catch (error) {
    status.google.available = false;
    status.google.reason = error.message || String(error);
  }

  // 探测 MyMemory
  try {
    const probe = await translateTexts(["hi"], "en", settings.targetLanguage, "mymemory");
    status.mymemory.available = probe.ok;
    status.mymemory.reason = probe.ok ? null : probe.error || "请求失败";
  } catch (error) {
    status.mymemory.available = false;
    status.mymemory.reason = error.message || String(error);
  }

  // 探测 Lingva
  try {
    const probe = await translateTexts(["hi"], "en", settings.targetLanguage, "lingva");
    status.lingva.available = probe.ok;
    status.lingva.reason = probe.ok ? null : probe.error || "请求失败";
  } catch (error) {
    status.lingva.available = false;
    status.lingva.reason = error.message || String(error);
  }

  return status;
}

// ---- 快捷键 ----

chrome.commands.onCommand.addListener(async command => {
  if (command !== "toggle-translation") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  await toggleTab(tab.id);
});

/**
 * 切换当前标签页的翻译状态。
 * @param {number} tabId 标签页 id
 */
async function toggleTab(tabId) {
  try {
    const status = await chrome.tabs.sendMessage(tabId, { action: "getStatus" });
    if (status && status.state === "translated") {
      await chrome.tabs.sendMessage(tabId, { action: "restorePage" });
    } else {
      await chrome.tabs.sendMessage(tabId, { action: "translatePage" });
    }
  } catch {
    // 页面没有内容脚本（chrome:// 页面等），静默忽略
  }
}

// ---- 右键菜单 ----

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "translatePage",
      title: chrome.i18n.getMessage("translatePageTitle") || "翻译此页面",
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "translateSelected",
      title: chrome.i18n.getMessage("translateSelectedTextTitle") || "翻译选中文本",
      contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || !tab.id) return;
  if (info.menuItemId === "translatePage") {
    chrome.tabs.sendMessage(tab.id, { action: "translatePage" }).catch(() => {});
  } else if (info.menuItemId === "translateSelected" && info.selectionText) {
    chrome.tabs.sendMessage(tab.id, { action: "translateSelection", text: info.selectionText }).catch(() => {});
  }
});
