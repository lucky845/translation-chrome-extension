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
 * 免密钥引擎的降级顺序。Google 被限流/不可达时依次后移。
 *
 * MyMemory 排第二：2026-11 实测（Node 直连 + 真实 Chrome 页面上下文均 200）
 * 且独立于 Google 基础设施，是当前唯一实证可靠的兜底。
 * Lingva 排末位：其公共实例多在 Cloudflare 之后，部分地区网络下整体不可达
 * （实例池轮换最坏 4×8s），放在前面会拖慢真正可用的兜底。
 */
const FALLBACK_CHAIN = ["google", "mymemory", "lingva"];

/**
 * 执行一次批量请求，按降级链逐个尝试可用引擎。
 *
 * @param {string[]} texts 待翻译文本
 * @param {string} from 源语言
 * @param {string} to 目标语言
 * @param {string} engineName 首选引擎
 * @return {Promise<{results: Array<{text: string, detected: ?string}>, engine: string, degraded: boolean, error: ?string}>}
 */
async function runWithFallback(texts, from, to, engineName) {
  const settings = await getSettings();

  // 尝试序列：首选引擎在前，其余按固定链序去重
  const chain = [engineName, ...FALLBACK_CHAIN.filter(name => name !== engineName)];
  /** @type {string[]} */
  const failures = [];

  for (const name of chain) {
    const engine = createEngine(name, settings.apiKey || null);
    if (!(await engine.isAvailable())) {
      failures.push(`${name}: 未配置`);
      continue;
    }
    try {
      const results = await engine.translate(texts, from, to);
      const degraded = name !== engineName;
      return {
        results,
        engine: name,
        degraded,
        error: degraded ? `已从 ${engineName} 降级到 ${name}` : null,
      };
    } catch (error) {
      failures.push(`${name}: ${error.message}`);
    }
  }

  throw new FatalTranslationError(`所有引擎失败 → ${failures.join("; ")}`);
}

/**
 * 清空缓存，供设置变更时调用。
 */
export function clearCache() {
  cache.clear();
}
