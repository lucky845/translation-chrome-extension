/**
 * 翻译编排：缓存、去重、引擎选择与降级。
 *
 * 设计要点：
 *   1. 页面里重复文本极多（"Read more"、"Click here"），按 key 去重能把请求量砍掉一大截。
 *   2. 引擎不可用时降级并在结果里明确报告，不静默返回原文冒充译文。
 *   3. 缓存跨页面共享，LRU 上限 5000 条防止 service worker 内存无限增长。
 */

import { createEngine, FatalTranslationError } from "./engine.js";
import { getSettings } from "./settings.js";

const CACHE_LIMIT = 5000;

/** @type {Map<string, {text: string, detected: ?string}>} */
const cache = new Map();

/**
 * 缓存键。
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {string} text 文本
 * @return {string} 键
 */
function cacheKey(from, to, text) {
  return `${from}|${to}|${text}`;
}

/**
 * 写入缓存，超限时淘汰最旧条目（Map 保证插入顺序）。
 * @param {string} key 键
 * @param {{text: string, detected: ?string}} value 值
 */
function cachePut(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * 翻译一批文本，返回与输入等长同序的结果。
 *
 * @param {string[]} texts 待翻译文本
 * @param {?string} fromLang 源语言覆盖，缺省用设置值
 * @param {?string} toLang 目标语言覆盖，缺省用设置值
 * @param {?string} engineName 引擎覆盖，缺省用设置值
 * @return {Promise<{ok: boolean, results: Array<{text: string, detected: ?string}>, engine: string, degraded: boolean, error: ?string}>}
 */
export async function translateTexts(texts, fromLang, toLang, engineName) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: true, results: [], engine: engineName || "google", degraded: false, error: null };
  }

  const settings = await getSettings();
  const from = fromLang || settings.sourceLanguage || "auto";
  const to = toLang || settings.targetLanguage;
  const requestedEngine = engineName || settings.engine;

  const results = new Array(texts.length);

  // 1. 查缓存并按 key 去重。positions 记录每种文本出现的全部位置，便于一次回填。
  /** @type {Map<string, number[]>} */
  const positions = new Map();
  /** @type {string[]} */
  const misses = [];
  /** @type {string[]} */
  const missKeys = [];

  texts.forEach((text, index) => {
    const key = cacheKey(from, to, text);
    const hit = cache.get(key);
    const slots = positions.get(key);
    if (hit) {
      results[index] = hit;
      if (slots) slots.push(index);
      else positions.set(key, [index]);
      return;
    }
    if (slots) {
      slots.push(index); // 批内重复，等首次请求的结果统一下发
      return;
    }
    positions.set(key, [index]);
    misses.push(text);
    missKeys.push(key);
  });

  let usedEngine = requestedEngine;
  let degraded = false;
  let errorMessage = null;
  let translated = null;

  // 2. 对未命中执行请求
  if (misses.length > 0) {
    try {
      const attempt = await runWithFallback(misses, from, to, requestedEngine);
      usedEngine = attempt.engine;
      degraded = attempt.degraded;
      errorMessage = attempt.error;
      translated = attempt.results;
    } catch (error) {
      errorMessage = error.message || String(error);
    }
  }

  // 3. 回填：同一文本的所有出现位置共享同一个结果对象，单次遍历完成
  if (translated) {
    translated.forEach((item, missIndex) => {
      const key = missKeys[missIndex];
      const value = { text: item.text, detected: item.detected };
      cachePut(key, value);
      const slots = positions.get(key);
      if (slots) {
        for (const slot of slots) results[slot] = value;
      }
    });
  }

  // 4. 兜底：未填充的位置用原文，由上层凭 degraded 决定是否提示用户
  for (let index = 0; index < results.length; index++) {
    if (!results[index]) results[index] = { text: texts[index], detected: null };
  }

  return {
    ok: translated !== null,
    results,
    engine: usedEngine,
    degraded,
    error: errorMessage,
  };
}

/**
 * 执行一次批量请求，引擎不可用或失败时降级到 Google。
 *
 * @param {string[]} texts 待翻译文本
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {string} engineName 首选引擎
 * @return {Promise<{results: Array<{text: string, detected: ?string}>, engine: string, degraded: boolean, error: ?string}>}
 */
async function runWithFallback(texts, from, to, engineName) {
  const settings = await getSettings();

  // Bing 未配置密钥时 isAvailable 为 false，直接降级，不做无意义的失败请求。
  if (engineName !== "google") {
    const primary = createEngine(engineName, settings.apiKey || null);
    if (!(await primary.isAvailable())) {
      const results = await createEngine("google").translate(texts, from, to);
      return { results, engine: "google", degraded: true, error: `${engineName} 未配置密钥，已使用 Google` };
    }
    try {
      const results = await primary.translate(texts, from, to);
      return { results, engine: engineName, degraded: false, error: null };
    } catch (error) {
      if (error instanceof FatalTranslationError) throw error;
      const results = await createEngine("google").translate(texts, from, to);
      return { results, engine: "google", degraded: true, error: `${engineName} 失败，已降级到 Google` };
    }
  }

  const results = await createEngine("google").translate(texts, from, to);
  return { results, engine: "google", degraded: false, error: null };
}

/**
 * 清空缓存，供设置变更时调用。
 */
export function clearCache() {
  cache.clear();
}
