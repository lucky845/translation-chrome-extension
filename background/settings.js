/**
 * 全局设置的唯一来源。service worker 侧缓存，storage 变化时失效。
 */

export const DEFAULT_SETTINGS = {
  targetLanguage: "zh-CN",
  sourceLanguage: "auto",
  engine: "google",
  autoTranslate: false,
  apiKey: "",
};

const VALID_ENGINES = ["google", "bing", "lingva", "mymemory"];

let cache = null;

/**
 * 读取设置（带缓存）。
 * @return {Promise<Object>} 合并默认值后的设置对象
 */
export async function getSettings() {
  if (cache) return cache;
  const stored = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  cache = { ...DEFAULT_SETTINGS, ...stored };
  if (!VALID_ENGINES.includes(cache.engine)) cache.engine = "google";
  return cache;
}

/**
 * 局部更新设置，返回更新后的完整设置。
 * @param {Object} patch 要写入的字段
 * @return {Promise<Object>} 更新后的设置
 */
export async function updateSettings(patch) {
  const clean = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (patch && patch[key] !== undefined) clean[key] = patch[key];
  }
  if (Object.keys(clean).length > 0) {
    await chrome.storage.sync.set(clean);
  }
  cache = null;
  return getSettings();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync") cache = null;
});
