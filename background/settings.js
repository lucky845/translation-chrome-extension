/**
 * 全局设置的唯一来源。service worker 侧缓存，storage 变化时失效。
 */

export const DEFAULT_SETTINGS = {
  targetLanguage: "zh-CN",
  sourceLanguage: "auto",
  engine: "google",
  autoTranslate: false,
  apiKey: "",
  // 自定义接口（对接自建 DeepLX / LibreTranslate / 任意 OpenAI 兼容中转）
  // 空字段一律回落到所选预设的默认值，用户只填地址也能跑。
  customPreset: "deeplx",
  customUrl: "",
  customMethod: "",
  customHeaders: "",
  customBody: "",
  customResponsePath: "",
  customToken: "",
  customModel: "",
  // 不翻译的域名，逗号或换行分隔，支持 *.example.com 通配
  blacklist: "",
  // 端侧翻译（Chrome 内置 AI）：auto=支持就优先用；off=始终走在线引擎。
  // Edge 没有 Chrome 的 Translator API，auto 模式下会自动跳过，等价于 off。
  useOffline: "auto",
  // 译文样式：none=无标记；underline=下划线；highlight=高亮底色。
  // 通过给 [data-tp-translated] 注入 CSS 实现，不改 DOM 结构。
  translatedStyle: "none",
};

const VALID_ENGINES = ["google", "bing", "lingva", "mymemory", "custom"];

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

// Node 单测环境没有 chrome API，跳过监听（避免 import 即崩）。
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") cache = null;
  });
}
