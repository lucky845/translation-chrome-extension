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

  // 4. 兜底：未填充的位置用原文占位（不写缓存，避免把「翻译失败」污染成缓存命中）
  let filled = 0;
  for (let index = 0; index < results.length; index++) {
    if (results[index]) {
      filled++;
      continue;
    }
    results[index] = { text: texts[index], detected: null };
  }

  // ok 的语义是「这批文本有没有拿到译文」，不是「有没有真的发出请求」。
  // 纯缓存命中时 translated 为 null 但结果齐全；反之请求成功也可能有段落回落原文。
  // 以「实际填充了多少」为准，才不会把缓存命中误报成请求失败。
  const ok = filled === texts.length;

  return {
    ok,
    results,
    engine: usedEngine,
    degraded,
    error: ok ? errorMessage : errorMessage || `仅 ${filled}/${texts.length} 段获得译文`,
  };
}

/**
 * 免密钥引擎的降级顺序。Google 被限流/不可达时依次后移。
 *
 * custom 排第二：一旦用户配了自建/中转接口，那通常就是他在本网络下唯一稳定的通路，
 * 优先于任何公共免费接口；未配置时 isAvailable() 为 false，会被直接跳过。
 * MyMemory 排第三：2026-11 实测（Node 直连 + 真实 Chrome 页面上下文均 200）
 * 且独立于 Google 基础设施，是当前唯一实证可靠的公共兜底。
 * Lingva 排末位：其公共实例多在 Cloudflare 之后，部分地区网络下整体不可达
 * （实例池轮换最坏 4×8s），放在前面会拖慢真正可用的兜底。
 */
const FALLBACK_CHAIN = ["google", "custom", "mymemory", "lingva"];

/**
 * 引擎熔断冷却时间。
 *
 * 没有熔断时，Google 被墙的代价是**每个批次**都要重付一遍超时（10s）才能降级；
 * 一页 500 个单元 = 5 个批次 = 多等 50 秒，用户体感就是「一直在转、一直失败」。
 * 失败后冷却 30 秒内直接跳过，下一个批次立刻走可用引擎。
 */
const ENGINE_COOLDOWN_MS = 30000;

/** @type {Map<string, {until: number, reason: string}>} 引擎名 → 冷却到期时间与失败原因 */
const cooldowns = new Map();

/**
 * 查询引擎是否处于冷却期。
 * @param {string} name 引擎名
 * @param {number} now 当前时间戳
 * @return {?{until: number, reason: string}} 冷却信息，不在冷却期为 null
 */
function coolingInfo(name, now) {
  const entry = cooldowns.get(name);
  if (!entry) return null;
  if (now >= entry.until) {
    cooldowns.delete(name);
    return null;
  }
  return entry;
}

/**
 * 标记引擎失败，进入冷却。
 * @param {string} name 引擎名
 * @param {string} reason 失败原因
 * @return {void}
 */
function coolDown(name, reason) {
  const now = Date.now();
  const entry = cooldowns.get(name);
  // 冷却期内再次失败**不续期**：全链路不可用时，兜底那一趟每批次都会再打一次
  // 冷却中的引擎，如果每次都把到期时间推到 now+30s，熔断就永远不会到期——
  // 用户侧表现就是「一直在试、一直在等、永远不恢复」。
  // 只保留第一次失败的时间点，到期后重新给一次机会。
  if (entry && now < entry.until) return;
  cooldowns.set(name, { until: now + ENGINE_COOLDOWN_MS, reason: String(reason || "") });
}

/**
 * 引擎成功后清除冷却。
 * @param {string} name 引擎名
 * @return {void}
 */
function clearCooldown(name) {
  cooldowns.delete(name);
}

/**
 * 清空熔断状态。设置变更或用户手动重试时调用，让引擎立刻重新被考虑。
 * @return {void}
 */
export function resetEngineHealth() {
  cooldowns.clear();
}

/**
 * 当前各引擎健康状态（供调试与状态展示）。
 * @return {Object<string, {cooling: boolean, until: ?number, reason: ?string}>} 健康状态
 */
export function getEngineHealth() {
  const now = Date.now();
  const health = {};
  for (const [name, entry] of cooldowns) {
    health[name] = now < entry.until ? { cooling: true, until: entry.until, reason: entry.reason } : null;
  }
  for (const [name, value] of Object.entries(health)) {
    if (!value) delete health[name];
  }
  return health;
}

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
  const chain = [];
  for (const name of [engineName, ...FALLBACK_CHAIN]) {
    if (name && !chain.includes(name)) chain.push(name);
  }

  const now = Date.now();
  /** @type {string[]} 未熔断的引擎，优先尝试 */
  const ready = [];
  /** @type {string[]} 熔断中的引擎，只在全部失败后兜底再试一次 */
  const cooling = [];
  for (const name of chain) {
    if (coolingInfo(name, now)) cooling.push(name);
    else ready.push(name);
  }

  /** @type {string[]} */
  const failures = [];
  /** @type {Array<string[]>} */
  const passes = ready.length > 0 ? [ready, cooling] : [cooling];

  for (const pass of passes) {
    for (const name of pass) {
      let engine;
      try {
        engine = createEngine(name, settings.apiKey || null, settings);
        if (!(await engine.isAvailable())) {
          failures.push(`${name}: 未配置`);
          continue;
        }
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        continue;
      }

      try {
        const results = await engine.translate(texts, from, to);
        clearCooldown(name);
        const degraded = name !== engineName;
        return {
          results,
          engine: name,
          degraded,
          error: degraded ? `已从 ${engineName} 降级到 ${name}` : null,
        };
      } catch (error) {
        coolDown(name, error.message);
        failures.push(`${name}: ${error.message}`);
      }
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
