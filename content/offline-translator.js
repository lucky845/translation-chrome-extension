/**
 * 浏览器内置端侧翻译（Chrome / Edge 通用）。
 *
 * 同一套 API，两个浏览器都提供（据微软官方文档）：
 *   - Chrome 138+：`Translator.create()` / `Translator.availability()`
 *   - Edge   148+：完全相同的 API 与参数（设备端模型，覆盖 145+ 语言）
 * 两者都由设备端本地模型驱动：不联网、不计费、不受 429 影响。
 *
 * 因此本模块不区分浏览器，只做「能力检测」：
 *   支持 → 端侧优先；不支持 → 调用方自动回落到在线引擎。
 *
 * 关键限制：首次创建会话必须在用户手势里触发，否则报
 *   "Requires a user gesture when availability is downloading or downloadable"。
 * 所以 warmup() 由「点击翻译按钮」这条真实手势链路调用。
 */

/**
 * 语言码收敛为端侧可识别的形式。
 * @param {string} lang 语言码
 * @return {string} 端侧语言码
 */
function normalizeLang(lang) {
  const code = String(lang || "").toLowerCase();
  if (!code || code === "auto") return "en";
  return code.split("-")[0];
}

/** @type {?string} 预热失败原因，供界面展示 */
let warmupFailure = null;

/** @type {Map<string, Promise<Object>>} 语言对 → 会话（同一语言对只创建一次） */
const sessionCache = new Map();

/**
 * 当前浏览器是否提供内置端侧翻译。
 * @return {boolean} 是否支持
 */
function isSupported() {
  return typeof globalThis.Translator !== "undefined" && typeof globalThis.Translator.create === "function";
}

/**
 * 查询某语言对的模型可用性。
 * @param {string} fromLang 源语言
 * @param {string} toLang 目标语言
 * @return {Promise<string>} available | downloadable | downloading | unavailable | unsupported
 */
async function availability(fromLang, toLang) {
  if (!isSupported()) return "unsupported";
  try {
    return await globalThis.Translator.availability({
      sourceLanguage: normalizeLang(fromLang),
      targetLanguage: normalizeLang(toLang),
    });
  } catch {
    return "unsupported";
  }
}

/**
 * 取得（必要时创建）翻译会话。
 * 调用方必须处于用户手势上下文，否则首次创建会因模型下载被拒。
 * @param {string} fromLang 源语言
 * @param {string} toLang 目标语言
 * @return {Promise<Object>} 会话对象
 */
function getSession(fromLang, toLang) {
  const from = normalizeLang(fromLang);
  const to = normalizeLang(toLang);
  const key = from + "->" + to;

  if (sessionCache.has(key)) return sessionCache.get(key);

  const promise = globalThis.Translator.create({
    sourceLanguage: from,
    targetLanguage: to,
  }).catch(error => {
    // 创建失败必须清缓存，否则后续一直拿到 rejected promise，端侧永远不可用
    sessionCache.delete(key);
    throw error;
  });

  sessionCache.set(key, promise);
  return promise;
}

/**
 * 预热：在用户手势里尽早触发模型下载，真正翻译时就不用等。
 * @param {string} fromLang 源语言
 * @param {string} toLang 目标语言
 * @return {Promise<boolean>} 是否就绪
 */
async function warmup(fromLang, toLang) {
  if (!isSupported()) {
    warmupFailure = "当前浏览器不支持端侧翻译";
    return false;
  }
  try {
    await getSession(fromLang, toLang);
    warmupFailure = null;
    return true;
  } catch (error) {
    warmupFailure = String((error && error.message) || error);
    return false;
  }
}

/**
 * 批量翻译（端侧）。
 * @param {string[]} texts 待翻译文本
 * @param {string} fromLang 源语言
 * @param {string} toLang 目标语言
 * @return {Promise<Array<{text: string, detected: ?string}>>} 与输入等长同序
 */
async function translate(texts, fromLang, toLang) {
  if (!isSupported()) {
    throw new Error("当前浏览器不支持端侧翻译（Chrome 138+ / Edge 148+）");
  }

  const session = await getSession(fromLang, toLang);
  const results = [];

  for (const text of texts) {
    const trimmed = String(text || "").trim();
    if (!trimmed) {
      results.push({ text: text || "", detected: null });
      continue;
    }
    try {
      const out = await session.translate(trimmed);
      results.push({ text: out, detected: fromLang === "auto" ? null : fromLang });
    } catch (error) {
      throw new Error("端侧翻译失败：" + String((error && error.message) || error));
    }
  }

  return results;
}

// ---- 挂载 ----
// content script 是传统脚本（禁止 ESM），通过 window.__TP_OFFLINE__ 暴露给 content.js；
// 同时兼容 Node 单测的 module.exports。
window.__TP_OFFLINE__ = {
  supported: isSupported(),
  availability,
  warmup,
  translate,
  normalizeLang,
  get warmupFailure() {
    return warmupFailure;
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isSupported, availability, warmup, translate, getSession, normalizeLang };
}
