/**
 * Service worker：消息路由与生命周期管理。
 *
 * 与旧实现的关键差异：
 *   - 不再有顶层异步初始化竞态，设置每次按需读取（settings.js 内有缓存）。
 *   - 删除了 mockTranslate 兜底：翻译失败就如实报告失败，绝不返回伪译文。
 *   - 删除 webRequest / scripting 等未使用权限。
 *   - 接线 chrome.commands 与 contextMenus。
 */

import "../shared/i18n.js";
import { getSettings } from "./settings.js";
import { translateTexts, clearCache, resetEngineHealth } from "./translator.js";
import { CUSTOM_PRESETS, CUSTOM_PRESET_NAMES } from "./engines/custom.js";

/** 单个引擎探测的硬超时：探测只是界面提示，绝不能拖住翻译 */
const PROBE_TIMEOUT_MS = 6000;

/** i18n 助手（shared/i18n.js 挂在全局，service worker 是 module，只能这么取）。 */
const I18N = globalThis.__TP_I18N__ || { t: key => key, raw: () => "", langName: code => code };

// ---- 消息路由 ----

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message && message.action];
  if (!handler) {
    sendResponse({ ok: false, error: I18N.t("unknownAction", (message && message.action) || "") });
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
      echoed: outcome.echoed || 0,
      error: outcome.error,
    };
  },

  /**
   * 读取设置。
   * @return {Promise<Object>} 设置
   */
  async getSettings() {
    // 只读设置，绝不发网络请求。
    // 之前这里顺带跑 engineAvailability()，导致「点翻译」先等三个引擎的网络探测
    // （每个还可能重试 3 次×10s 超时），严重时点一次要卡一分半才开始翻。
    // 探测属于界面展示信息，由 getEngineStatus 按需提供。
    const settings = await getSettings();
    return { ok: true, settings, engines: staticEngineAvailability(settings) };
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
   * 自定义接口预设定义（供设置页渲染，避免前端重复维护一份）。
   * @return {Promise<Object>} 预设列表
   */
  async getCustomPresets() {
    const presets = CUSTOM_PRESET_NAMES.map(name => {
      const preset = CUSTOM_PRESETS[name];
      return {
        name,
        label: preset.label,
        labelKey: preset.labelKey || "",
        url: preset.url || "",
        method: preset.method || "POST",
        headers: preset.headers || "",
        body: preset.body || "",
        responsePath: preset.responsePath || "",
        model: preset.model || "",
      };
    });
    return { ok: true, presets };
  },

  /**
   * 引擎可用性探测（供 popup/options 显示真实状态）。
   * @return {Promise<Object>} 可用性
   */
  async getEngineStatus() {
    try {
      const settings = await getSettings();
      try {
        const engines = await engineAvailability(settings);
        return { ok: true, engines };
      } catch {
        return {
          ok: true,
          engines: {
            google: { available: true, reason: I18N.t("probeFailed") },
            bing: {
              available: Boolean(settings.apiKey),
              reason: settings.apiKey ? null : I18N.t("azureKeyRequiredExpired"),
            },
            mymemory: { available: true, reason: I18N.t("probeFailed") },
            lingva: { available: true, reason: I18N.t("probeFailed") },
            custom: {
              available: Boolean(String(settings.customUrl || "").trim()),
              reason: String(settings.customUrl || "").trim() ? null : I18N.t("customUrlMissing"),
            },
          },
        };
      }
    } catch (error) {
      return { ok: false, engines: {}, error: error && error.message ? error.message : String(error) };
    }
  },
};

/**
 * 仅按配置判断引擎可用性，不发任何网络请求。
 * 用于 getSettings 这种「只要配置」的场景，保证毫秒级返回。
 * @param {Object} settings 设置
 * @return {Object} 各引擎状态
 */
function staticEngineAvailability(settings) {
  const hasCustom = Boolean(String(settings.customUrl || "").trim());
  return {
    google: { available: true, reason: null },
    bing: {
      available: Boolean(settings.apiKey),
      reason: settings.apiKey ? null : I18N.t("azureKeyRequired"),
    },
    mymemory: { available: true, reason: null },
    lingva: { available: true, reason: null },
    custom: {
      available: hasCustom,
      reason: hasCustom ? null : I18N.t("customUrlMissing"),
    },
  };
}

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
  const status = staticEngineAvailability(settings);

  // 三个探测并行跑，各自 6 秒封顶。
  // 之前是串行 + 每个走完整重试链，最坏能阻塞一分半。
  const probe = async (name, apply) => {
    try {
      const result = await Promise.race([
        translateTexts(["hi"], "en", settings.targetLanguage, name),
        new Promise(resolve =>
          setTimeout(() => resolve({ ok: false, error: I18N.t("probeTimeout") }), PROBE_TIMEOUT_MS)
        ),
      ]);
      apply(result);
    } catch (error) {
      apply({ ok: false, error: error.message || String(error) });
    }
  };

  await Promise.all([
    probe("google", result => {
      if (!result.ok) status.google.reason = result.error || I18N.t("probeFailedNamed", I18N.raw("engineOptionGoogle"));
    }),
    probe("mymemory", result => {
      if (!result.ok)
        status.mymemory.reason = result.error || I18N.t("probeFailedNamed", I18N.raw("engineOptionMyMemory"));
    }),
    probe("lingva", result => {
      if (!result.ok) status.lingva.reason = result.error || I18N.t("probeFailedNamed", I18N.raw("engineOptionLingva"));
    }),
  ]);

  return status;
}

// ---- 设置变更同步 ----

// popup / options 直接写 chrome.storage.sync（不走任何消息），
// settings.js 的监听只失效设置缓存；这里负责译文缓存与引擎熔断——
// 否则换引擎/密钥后旧冷却与旧译文会继续生效，用户要等 30 秒或刷新页面。
// 替代已删除的 setSettings handler（消息通道全仓无调用方，纯死代码）。
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    // 引擎相关字段变更才清理：目标语言/黑名单等不涉及译文缓存与熔断
    const engineKeys = [
      "engine",
      "apiKey",
      "customPreset",
      "customUrl",
      "customMethod",
      "customHeaders",
      "customBody",
      "customResponsePath",
      "customToken",
      "customModel",
    ];
    if (!engineKeys.some(key => key in changes)) return;
    clearCache();
    // 刚改过引擎/密钥：清掉熔断，让新配置立刻生效，不用等 30 秒冷却
    resetEngineHealth();
  });
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
      title: I18N.t("translatePageTitle"),
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: "translateSelected",
      title: I18N.t("translateSelectedTextTitle"),
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
