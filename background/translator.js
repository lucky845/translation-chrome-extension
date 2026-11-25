/**
 * 翻译编排：缓存、去重、引擎选择与降级。
 *
 * 设计要点：
 *   1. 页面里重复文本极多（"Read more"、"Click here"），按 key 去重能把请求量砍掉一大截。
 *   2. 引擎不可用时降级并在结果里明确报告，不静默返回原文冒充译文。
 *   3. 缓存跨页面共享，LRU 上限 5000 条防止 service worker 内存无限增长。
 */

import "../shared/i18n.js";
import { createEngine, FatalTranslationError } from "./engine.js";
import { getSettings } from "./settings.js";

/** i18n 助手（shared/i18n.js 挂在全局，module 里只能这么取）。 */
const I18N = globalThis.__TP_I18N__ || { t: key => key, raw: () => "", langName: code => code };

/** 引擎名 → 词条名后缀（对应 _locales 里的 engineOption*）。 */
const ENGINE_LABEL_KEYS = {
  google: "engineOptionGoogle",
  mymemory: "engineOptionMyMemory",
  lingva: "engineOptionLingva",
  bing: "engineOptionBing",
  custom: "engineOptionCustom",
};

/**
 * 引擎显示名。
 * @param {string} name 引擎名
 * @return {string} 显示名
 */
function engineLabel(name) {
  const key = ENGINE_LABEL_KEYS[name];
  return key ? I18N.t(key) : name;
}

const CACHE_LIMIT = 5000;

/**
 * translateHtml 的占位符：`<a i=0>…</a>`（成对）与 `<a i=0/>`（自闭合）。
 * 与 content/dom-core.js 的 PLACEHOLDER_STRIP_RE 保持一致。
 */
const PLACEHOLDER_RE = /<a i=\d+\/>|<\/a>|<a i=\d+>/g;

/**
 * 取一段文本的「内容指纹」：剥掉占位符，删去全部空白。
 *
 * 用于判断原文与引擎返回是否实质相同。两处归一都不能省：
 *
 *   剥占位符——`<a i=3>DeepSeek Harness</a>.` 与 `<a i=3>DeepSeek Harness</a> .`
 *   剥掉标签后都是 `DeepSeek Harness.` / `DeepSeek Harness .`，才可比。
 *
 *   删全部空白——只做「连续空白归一成单个空格」还不够。原文
 *   `pick <a i=4>内阁模式</a> when` 剥标签后是 `pick 内阁模式 when`，
 *   引擎返回 `pick<a i=4>内阁模式</a>when` 剥标签后是 `pick内阁模式when`：
 *   中英文之间的空格被吃掉后，两边字面不同，但读者看到的内容一模一样。
 *   删掉空白后两者都是 `pick内阁模式when`，这才反映真实语义。
 *
 * 这个判据只回答「是不是同一段文字」，不回答「这段文字该不该翻译」，
 * 所以对任何语言都成立，不需要做语言推断。
 *
 * @param {string} text 文本
 * @return {string} 内容指纹
 */
function contentKey(text) {
  return text.replace(PLACEHOLDER_RE, "").replace(/\s+/g, "");
}

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
 * 判断引擎是否「原样退回」了原文。
 *
 * 为什么需要这个判断：Google 在 sl=auto 时会把「英文为主、夹少量中文专名」
 * 的段落检测成中文，直接返回原文。这不是错误码，HTTP 200、条数也对，
 * 单看返回结构完全正常——但内容是错的。
 *
 * 更糟的是旧实现把这种返回当成功写进缓存，于是这段文字在整个 service worker
 * 生命周期内都判定为「已翻译」，用户刷新多少次都翻不出来（HAR 实证过一次
 * 翻译都没重发）。所以这里必须把它识别出来：不进缓存，并让上层回落原文。
 *
 * 判据：剥掉占位符、删去全部空白后，两段文字完全相同。
 *
 * 为什么不能用简单的 trim() 比较：Google 在退回原文时会顺手调整占位符周围的
 * 空格。HAR 实证（426 字符 → 425 字符，21 个汉字、52 个英文词一个没变）：
 *
 *   `Harness</a>.`  →  `Harness</a> .`     句号前多一个空格
 *   `pick <a i=4>内阁模式</a> when`
 *                 →  `pick<a i=4>内阁模式</a>when`   两侧空格被吃掉
 *
 * trim() 只去首尾，对中间的空格变化视而不见，于是这种伪译文被当成真译文放行，
 * 写进缓存 + 标记已翻译，那段文字就永远不再重试——这正是用户反复看到
 * 「这一段没翻译」的直接原因。
 *
 * 仍然刻意不做语言推断（不按字符比例猜源/目标语言）：上一轮试过，
 * 把本来就是中文的句子按英文重翻（HAR 里能直接看到），比不翻更糟。
 *
 * @param {string} source 原文
 * @param {string} output 引擎返回
 * @return {boolean} 是否为原样退回
 */
function isEcho(source, output) {
  if (typeof source !== "string" || typeof output !== "string") return false;
  if (!source || !output) return false;
  return contentKey(source) === contentKey(output);
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
  //
  // echo 结果（引擎原样退回）必须挡在这里，不能写缓存：
  // 一旦写进去，这段文字在 SW 生命周期内永远命中缓存，用户怎么刷新都翻不出来。
  // 不写缓存的代价只是下次再发一次请求，代价远小于「永久翻不出来」。
  /** @type {Set<number>} */
  const echoed = new Set();
  if (translated) {
    translated.forEach((item, missIndex) => {
      // echo：不是译文，不写缓存、也不填充 results
      if (isEcho(misses[missIndex], item.text)) return;
      const key = missKeys[missIndex];
      const value = { text: item.text, detected: item.detected };
      cachePut(key, value);
      const slots = positions.get(key);
      if (slots) {
        for (const slot of slots) results[slot] = value;
      }
    });
  }

  // 4. 兜底：未填充的位置用原文占位。
  // 这些位置分两种，对上层意义完全不同，必须分开数：
  //  - echo（引擎回了但内容就是原文）→ 确定性结果，重发无意义；
  //  - 失败（请求没成功）→ 值得重试。
  // 混成「没翻成」上报会让上层对 echo 白重发一轮，还会把提示误报成限流/网络波动。
  let filled = 0;
  for (let index = 0; index < results.length; index++) {
    if (results[index]) {
      filled++;
      continue;
    }
    results[index] = { text: texts[index], detected: null };
  }

  // echo 的回填必须按「位置」补，不能按「去重后的文本种数」补。
  // 这里踩过一个坑：曾经写成 `if (slots.length > 0) filled++`，对每种文本只加 1，
  // 而 texts.length 数的是位置总数。批内一旦有重复文本（"Readme" 出现 4 次
  // 这种在真实页面上极常见），filled 就永远够不到 texts.length，ok 被判成
  // false → 整批塞进失败队列重试 → 连续 3 批失败 → 触发「暂停翻译」。
  // 用户看到的就是「提示限流，只翻了三分之一」，而 HAR 里实际全部 200 成功。
  /** @type {Set<number>} */
  const echoUnitSeen = new Set();
  if (translated) {
    translated.forEach((item, missIndex) => {
      if (!isEcho(misses[missIndex], item.text)) return;
      echoed.add(missIndex);
      const slots = positions.get(missKeys[missIndex]) || [];
      for (const slot of slots) {
        echoUnitSeen.add(slot);
        // 该位置已经用原文占位过，但它是「有效回应」，计入已解决
        filled++;
      }
    });
  }

  // ok 的语义是「这批文本有没有拿到回应」，不是「有没有拿到译文」：
  // echo 也是回应（引擎明确表示「这就是目标语言」），算进来才不会让上层
  // 把它当失败重发。真正没拿到回应的位置仍然算失败，仍会进重试队列。
  const ok = filled === texts.length;

  return {
    ok,
    results,
    engine: usedEngine,
    degraded,
    echoed: echoUnitSeen.size,
    error: ok ? errorMessage : errorMessage || I18N.t("batchPartialResult", filled, texts.length),
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
 * 引擎名 → 上一次成功的时间戳。
 * 免费端点轮流限流，与其死守首选引擎、每批先撞一次 429，
 * 不如让最近成功过的引擎先上。
 * @type {Map<string, number>}
 */
const lastSuccess = new Map();

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
  // 用户改设置后重置健康状态，连带清掉「最近成功过」的历史，
  // 否则刚清完冷却期，排序仍带着上一轮的偏好。
  lastSuccess.clear();
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

  // 首选引擎永远排第一：用户显式选了 Google 就先用 Google，
  // 不能被「MyMemory 最近成功过」顶替——那是替用户改主意。
  ready.sort((a, b) => {
    if (a === engineName) return -1;
    if (b === engineName) return 1;
    // 其余引擎按「最近成功过」排序：免费端点轮着限流，
    // 谁上一次成功过这一次先试谁，少撞一次 429。
    // 用 ?? -Infinity 而不是直接相减：未成功过的引擎是 undefined，
    // undefined - number = NaN，而 sort 把 NaN 当 0 保持原序——
    // 那是碰巧对，换个实现就崩。
    return (lastSuccess.get(b) ?? -Infinity) - (lastSuccess.get(a) ?? -Infinity);
  });

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
          failures.push(I18N.t("engineNotConfigured", engineLabel(name)));
          continue;
        }
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        continue;
      }

      try {
        const results = await engine.translate(texts, from, to);
        clearCooldown(name);
        lastSuccess.set(name, Date.now());
        const degraded = name !== engineName;
        return {
          results,
          engine: name,
          degraded,
          error: degraded ? I18N.t("engineDegraded", engineLabel(engineName), engineLabel(name)) : null,
        };
      } catch (error) {
        coolDown(name, error.message);
        failures.push(`${name}: ${error.message}`);
      }
    }
  }

  throw new FatalTranslationError(I18N.t("allEnginesFailed", failures.join("; ")));
}

/**
 * 清空缓存，供设置变更时调用。
 */
export function clearCache() {
  cache.clear();
}
