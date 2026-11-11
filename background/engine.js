/**
 * Google 免费翻译端点封装。
 *
 * 为什么用 translate_a/t 而不是 translate_a/single：
 *   single 端点一次只能翻一段文本，页面有 300 个块就是 300 次请求。
 *   t 端点可在一次请求里重复携带多个 q，实测 POST 1000 条（82KB）耗时 3.3 秒。
 *   成本从 O(n) 请求降到 O(n/200)。
 *
 * 返回格式（实测）：
 *   [["译文", "检测到的语言"], [["译文", "en"], ...]] 两种形态都可能出现，统一归一化。
 */

import {
  BaseEngine,
  RetryableError,
  FatalTranslationError,
  RateLimitError,
  isNetworkFailure,
  sleep,
} from "./engines/base.js";
import { splitSentences } from "./engines/text.js";
import { CustomEngine } from "./engines/custom.js";

// 对外保持原有导出路径（测试与调用方都从 engine.js 取）：
export { RetryableError, FatalTranslationError, splitSentences };

const ENDPOINT = "https://translate.googleapis.com/translate_a/t";

// 单条兜底端点：返回结构化 JSON（{sentences:[{trans}], src}），
// 比 translate_a/t 的嵌套数组健壮得多；批量响应解析失败时用它逐条补。
// 端点：translate_a/single?dj=1。
const SINGLE_ENDPOINT = "https://translate.googleapis.com/translate_a/single";

// 单次请求上限。实测 400 条普通句子会 400 错误，200 条稳定；URL 控制在 7KB 内。
const MAX_TEXTS_PER_CHUNK = 120;
// GET 请求把 q 全部放在 query string 里，URL 长度是真限制。
// 真机实测（Chrome for Testing 157，扩展 service worker 上下文）：
//   120 条 / URL 7642 字符 → 200，1.03s；80 条 / 5102 字符 → 200，0.71s。
// 留出余量防超长 URL 被网关 414，取 6000 字符。
const MAX_URL_CHARS = 6000;

// 并发上限。实测 20 并发 1.84s 全成功，但页面翻译取保守值避免触发限流。
const MAX_CONCURRENCY = 3;

// 重试：仅对网络错误与 5xx 重试，4xx 直接失败（重试无意义）。
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// 请求超时，防止 fetch 永久挂起。
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Google 免费端点。
 */
export class GoogleEngine extends BaseEngine {
  /**
   * 归一化单条返回，兼容扁平与嵌套两种形态。
   * @param {*} item 单条结果
   * @return {{text: string, detected: ?string}}
   */
  static normalizeItem(item) {
    if (typeof item === "string") return { text: item, detected: null };
    if (Array.isArray(item)) {
      return { text: typeof item[0] === "string" ? item[0] : "", detected: item[1] || null };
    }
    return { text: "", detected: null };
  }

  /**
   * 单次请求，失败按策略重试。
   * @param {string[]} texts 本批次文本
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<{text: string, detected: ?string}>>}
   */
  async requestChunk(texts, fromLang, toLang) {
    const params = new URLSearchParams({ client: "gtx", sl: fromLang, tl: toLang });
    for (const text of texts) params.append("q", text);

    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        // 必须用 GET。真机实测（Chrome for Testing 157，扩展 service worker 上下文）：
        //   同一端点 GET 120 条 → 200，1.03s；
        //   同一端点 POST 1 条（109 字节 body）→ Failed to fetch，网络层就断了。
        // Google 对 translate_a/t 的 POST 预检不返回 CORS 头，浏览器在真正发出请求前
        // 就把 fetch 判死。旧代码把 "Failed to fetch" 当成普通可重试错误，
        // 于是每隔几秒重试一次、再降级、再重试，用户最终看到「所有引擎失败」——
        // 而真正的原因是请求根本没发出去。
        const response = await fetch(`${ENDPOINT}?${params.toString()}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          // 其他 4xx 重试不会有不同结果
          if (response.status !== 429 && response.status >= 400 && response.status < 500) {
            throw new FatalTranslationError(`HTTP ${response.status}`);
          }
          // 429 不是「再试一次就好」的瞬时错误，而是配额用尽。
          // 真机实测：200 段连续 429 时，原逻辑「3 次退避重试 + 逐条兜底」
          // 让一次翻译白等 103 秒，而一条都没成。限流要快速失败，
          // 交给降级链换引擎，而不是在原地把 200 条逐条再打一遍。
          if (response.status === 429) {
            throw new RateLimitError(`HTTP 429（限流）`);
          }
          throw new RetryableError(`HTTP ${response.status}`);
        }

        const data = await response.json();
        if (!Array.isArray(data)) throw new RetryableError("响应不是数组");
        if (data.length !== texts.length) {
          throw new RetryableError(`结果数量不符：期望 ${texts.length}，实际 ${data.length}`);
        }
        return data.map(GoogleEngine.normalizeItem);
      } catch (error) {
        // 限流不重试：退避 3 次（0.5+1+2 秒）只是让用户多等 3 秒，
        // 配额窗口通常以分钟计，这 3 秒等不来配额，只会拖慢降级。
        if (error instanceof RateLimitError) throw error;
        if (error instanceof FatalTranslationError) throw error;
        // 网络层失败（被墙/断网/超时）重试只会再等一个超时周期，直接交给降级链
        if (isNetworkFailure(error)) {
          throw new FatalTranslationError(`网络不可达：${error.message || error.name}`);
        }
        // 限流/响应结构异常才值得重试
        lastError = error;
      }
    }
    // 限流时不逐条补：每条都会同样被拒，白烧时间。
    // 实测 200 条逐条兜底要 100 秒以上，且一条都不成。
    if (lastError instanceof RateLimitError) throw lastError;

    // 批量端点反复失败（结构异常等）：改用结构化单条端点逐条补，
    // 比整批放弃或原样返回更有价值（长页面里丢一两条很常见）。
    try {
      const results = [];
      for (const text of texts) {
        results.push(await this.translateOne(text, fromLang, toLang));
      }
      return results;
    } catch (fallbackError) {
      throw lastError || fallbackError || new Error("翻译请求失败");
    }
  }

  /**
   * 单条翻译，走结构化 JSON 端点。
   *
   * 为什么需要：translate_a/t 的批量响应是位置相关的嵌套数组，
   * 一旦服务端返回结构变化或数量不符，整批都会失败。
   * 结构化端点有明确的 sentences[].trans 与 src，适合作为逐条兜底。
   *
   * @param {string} text 待翻译文本
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<{text: string, detected: ?string}>} 结果
   */
  async translateOne(text, fromLang, toLang) {
    const params = new URLSearchParams({
      client: "gtx",
      sl: fromLang,
      tl: toLang,
      dt: "t",
      dj: "1",
      ie: "UTF-8",
      q: text,
    });

    const response = await fetch(`${SINGLE_ENDPOINT}?${params.toString()}`, {
      method: "GET",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new RetryableError(`单条翻译 HTTP ${response.status}`);

    const data = await response.json();
    const sentences = data && data.sentences;
    if (!Array.isArray(sentences)) throw new RetryableError("单条翻译响应缺少 sentences");

    // 拼接所有分段，保留原文顺序与标点
    const translated = sentences.map(item => (item && item.trans) || "").join("");
    return {
      text: translated,
      detected: typeof data.src === "string" ? data.src : null,
    };
  }

  /**
   * 批量翻译，内部分块 + 并发池控制。
   * @param {string[]} texts 待翻译文本
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<{text: string, detected: ?string}>>}
   */
  async translate(texts, fromLang, toLang) {
    if (texts.length === 0) return [];

    const chunks = splitIntoChunks(texts);
    const results = new Array(chunks.length);

    // 分块并行，但用索引归位，顺序绝不依赖完成时序。
    const queue = chunks.map((chunk, index) => ({ chunk, index }));
    let cursor = 0;

    const worker = async () => {
      while (cursor < queue.length) {
        const job = queue[cursor++];
        results[job.index] = await this.requestChunk(job.chunk, fromLang, toLang);
      }
    };

    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, worker);
    await Promise.all(workers);

    return results.flat();
  }
}

/**
 * Bing 网页版免费端点。
 *
 * 现状（2026-11 实测，见 README）：edge.microsoft.com/translate/auth 返回 404，
 * www.bing.com/ttranslatev3 携带 IG/token/cookie 仍返回 400，端点已不可用。
 * 保留实现是为了用户拥有 Azure 正式密钥时可切换，未配置密钥时 isAvailable() 返回 false，
 * 由上层自动降级到 Google，绝不静默返回原文冒充译文。
 */
export class BingEngine extends BaseEngine {
  /**
   * @param {?string} apiKey Azure Translator 密钥
   */
  constructor(apiKey = null) {
    super();
    this.apiKey = apiKey;
    this.region = null;
  }

  /**
   * 未配置 Azure 密钥即视为不可用。
   * @return {Promise<boolean>}
   */
  async isAvailable() {
    return Boolean(this.apiKey);
  }

  /**
   * 走 Azure 正式端点（需要有效密钥与区域）。
   * @param {string[]} texts 待翻译文本
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<{text: string, detected: ?string}>>}
   */
  async translate(texts, fromLang, toLang) {
    if (!this.apiKey) throw new FatalTranslationError("未配置 Azure 翻译密钥");

    const url =
      `https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(toLang)}` +
      (fromLang !== "auto" ? `&from=${encodeURIComponent(fromLang)}` : "");

    const headers = {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": this.apiKey,
    };
    if (this.region) headers["Ocp-Apim-Subscription-Region"] = this.region;

    const body = JSON.stringify(texts.map(text => ({ Text: text })));
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) throw new FatalTranslationError(`HTTP ${response.status}`);

    const data = await response.json();
    if (!Array.isArray(data) || data.length !== texts.length) {
      throw new Error("Bing 返回结构异常");
    }
    return data.map(item => ({
      text: item && item.translations && item.translations[0] ? item.translations[0].text : "",
      detected: item && item.detectedLanguage ? item.detectedLanguage.language : null,
    }));
  }
}

/**
 * MyMemory 免费翻译引擎（api.mymemory.translated.net）。
 *
 * 实测（2026-11）：免密钥、匿名 GET 即可用，支持源语言 "Autodetect"，
 * 顶层返回 detectedLanguage 与 quotaFinished 字段。
 * 限制：单条 ≤ 500 字节；匿名按 IP 限日配额、高频触发限流。
 * 因此保持小并发（实测 24 条：串行 29.1s、并发 3 为 5.1s、并发 8 为 2.1s，全程 200 无 429），
 * 取 4 作平衡：既把「逐条 1.2s 延迟」压下去，又不至于把匿名配额撞上限。
 * 超长文本按句拆片后并发请求，再按原序拼接。
 */
export class MyMemoryEngine extends BaseEngine {
  static ENDPOINT = "https://api.mymemory.translated.net/get";
  // 单条请求的安全长度（MyMemory 官方上限 500 字节，取余量防 URL 编码膨胀）
  static MAX_SEGMENT_CHARS = 450;
  // 单条请求间隔（每个 worker 自己的节流）：匿名配额宝贵，宁慢勿封
  static THROTTLE_MS = 60;
  // 并发 worker 数：MyMemory 单请求 RTT 约 0.6~1.2s，串行翻一页要几分钟
  static MAX_CONCURRENCY = 4;

  /**
   * 恒可用：免密钥。配额耗尽在请求时以错误形式暴露并走降级链。
   * @return {Promise<boolean>}
   */
  async isAvailable() {
    return true;
  }

  /**
   * 语言码适配：MyMemory 用 "Autodetect" 表示自动检测，其余 ISO 码直传。
   * @param {string} lang 语言码
   * @return {string} MyMemory 语言码
   */
  static mapLang(lang) {
    return lang === "auto" ? "Autodetect" : lang;
  }

  /**
   * 批量翻译：逐条请求 + 节流。
   * @param {string[]} texts 待翻译文本
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<{text: string, detected: ?string}>>} 与输入等长同序
   */
  async translate(texts, fromLang, toLang) {
    const from = MyMemoryEngine.mapLang(fromLang);
    const to = MyMemoryEngine.mapLang(toLang);

    // 先按「文本 → 句片」铺平任务，再并发跑，最后按原序拼回
    const plans = texts.map(text =>
      text && text.trim() ? splitSentences(text, MyMemoryEngine.MAX_SEGMENT_CHARS) : []
    );
    const tasks = [];
    plans.forEach((segments, textIndex) => {
      segments.forEach((segment, segmentIndex) => tasks.push({ textIndex, segmentIndex, segment }));
    });

    const filled = plans.map(segments => new Array(segments.length));
    let cursor = 0;

    const worker = async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        const item = await this.requestSegment(task.segment, from, to);
        filled[task.textIndex][task.segmentIndex] = item;
        if (cursor < tasks.length) await sleep(MyMemoryEngine.THROTTLE_MS);
      }
    };

    const workers = Array.from({ length: Math.min(MyMemoryEngine.MAX_CONCURRENCY, tasks.length) }, worker);
    await Promise.all(workers);

    return texts.map((text, textIndex) => {
      const items = filled[textIndex];
      if (!items || items.length === 0) return { text, detected: null };
      let detected = null;
      for (const item of items) {
        if (item && item.detected) detected = item.detected;
      }
      return { text: items.map(item => (item ? item.text : "")).join(" "), detected };
    });
  }

  /**
   * 翻译单条：超长文本按句拆片，逐片请求后拼接。
   * @param {string} text 原文
   * @param {string} from 源语言
   * @param {string} to 目标语言
   * @return {Promise<{text: string, detected: ?string}>}
   */
  async translateOne(text, from, to) {
    const segments = splitSentences(text, MyMemoryEngine.MAX_SEGMENT_CHARS);
    let detected = null;
    const parts = [];
    for (const segment of segments) {
      const item = await this.requestSegment(segment, from, to);
      parts.push(item.text);
      if (item.detected) detected = item.detected;
    }
    return { text: parts.join(" "), detected };
  }

  /**
   * 请求一片文本，带与 Google 引擎一致的重试策略。
   * @param {string} segment 单片文本
   * @param {string} from 源语言
   * @param {string} to 目标语言
   * @return {Promise<{text: string, detected: ?string}>}
   */
  async requestSegment(segment, from, to) {
    const query = new URLSearchParams({
      q: segment,
      langpair: `${from}|${to}`,
    });
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1));
      try {
        const response = await fetch(`${MyMemoryEngine.ENDPOINT}?${query.toString()}`, {
          method: "GET",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
            Accept: "application/json,text/plain,*/*",
            Referer: "https://mymemory.translated.net/",
            Origin: "https://mymemory.translated.net",
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          // 429/5xx 是瞬时的；401/403/400 重试也不会有不同结果，反而让用户多等几秒
          if (response.status === 429 || response.status >= 500) {
            throw new RetryableError(`MyMemory HTTP ${response.status}`);
          }
          throw new FatalTranslationError(`MyMemory 拒绝请求（HTTP ${response.status}）`);
        }
        const data = await response.json();
        if (!data || !data.responseData || typeof data.responseData.translatedText !== "string") {
          throw new RetryableError("MyMemory 返回结构异常");
        }
        if (data.quotaFinished) {
          throw new FatalTranslationError("MyMemory 匿名配额已耗尽（当日）");
        }
        if (data.responseStatus && data.responseStatus !== 200) {
          if (data.responseStatus === 429 || data.responseStatus === 403) {
            throw new RetryableError(`MyMemory responseStatus ${data.responseStatus}`);
          }
          throw new FatalTranslationError(`MyMemory responseStatus ${data.responseStatus}`);
        }
        return {
          text: data.responseData.translatedText,
          detected:
            typeof data.detectedLanguage === "string" && data.detectedLanguage !== "" ? data.detectedLanguage : null,
        };
      } catch (error) {
        if (error instanceof FatalTranslationError) throw error;
        if (isNetworkFailure(error)) {
          throw new FatalTranslationError(`MyMemory 网络不可达：${error.message || error.name}`);
        }
        lastError = error;
      }
    }
    throw lastError || new RetryableError("MyMemory 请求失败");
  }
}

/**
 * Lingva 免费引擎：Google 翻译的开源前端镜像。
 *
 * 实测（2026-11）：curl 直接访问被 Cloudflare 质询页拦截（"Just a moment..."），
 * 但插件跑在真实 Chrome 里带完整浏览器指纹，可通过 CF。
 * 多实例轮换 + 记住上次成功实例；单实例失败换下一个，绝不静默返回原文。
 */
export class LingvaEngine extends BaseEngine {
  // 实例池：社区镜像随时间涨落，全部失败时抛错走降级链
  static INSTANCES = [
    "https://lingva.ml",
    "https://lingva.garudalinux.org",
    "https://translate.plausibility.cloud",
    "https://lingva.lunar.icu",
  ];
  // 单段安全长度：Lingva 走 URL path，编码后过长会 414
  static MAX_SEGMENT_CHARS = 600;

  /** @type {?string} 最近一次成功的实例，进程内复用 */
  static preferredInstance = null;

  /**
   * 恒可用（免密钥）；实例级失败在请求时暴露。
   * @return {Promise<boolean>}
   */
  async isAvailable() {
    return true;
  }

  /**
   * 批量翻译：逐条请求（实例池轮换），保持等长同序。
   * @param {string[]} texts 待翻译文本
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<{text: string, detected: ?string}>>}
   */
  async translate(texts, fromLang, toLang) {
    const results = [];
    for (let index = 0; index < texts.length; index++) {
      if (index > 0) await sleep(MyMemoryEngine.THROTTLE_MS);
      results.push(await this.translateOne(texts[index], fromLang, toLang));
    }
    return results;
  }

  /**
   * 翻译单条：超长按句拆片后拼接。
   * @param {string} text 原文
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<{text: string, detected: ?string}>}
   */
  async translateOne(text, fromLang, toLang) {
    const segments = splitSentences(text, LingvaEngine.MAX_SEGMENT_CHARS);
    const parts = [];
    let detected = null;
    for (const segment of segments) {
      const item = await this.requestSegment(segment, fromLang, toLang);
      parts.push(item.text);
      if (item.detected) detected = item.detected;
    }
    return { text: parts.join(" "), detected };
  }

  /** 单片请求超时：实例池轮换最坏 4 × 此值，不能占满全局超时预算 */
  static SEGMENT_TIMEOUT_MS = 8000;

  /** Google 语言代码 → Lingva 语言代码（Lingva 用 zh / zh_HANT / pt 这类短码与下划线变体） */
  static LANG_MAP = {
    "zh-CN": "zh",
    "zh-TW": "zh_HANT",
    "zh-HK": "zh_HANT",
    "pt-BR": "pt",
    "pt-PT": "pt",
  };

  /**
   * Google 风格 BCP-47 代码转 Lingva 代码：先查映射表，未命中则取主语言码。
   * @param {string} lang Google 风格语言代码
   * @return {string} Lingva 语言代码
   */
  static toLingvaLang(lang) {
    if (LingvaEngine.LANG_MAP[lang]) return LingvaEngine.LANG_MAP[lang];
    const main = String(lang).split("-")[0];
    return main === "zh" ? "zh" : main;
  }

  /**
   * 请求一片文本，先试偏好实例，失败轮换整个实例池。
   * @param {string} segment 单片文本
   * @param {string} fromLang 源语言（Google 风格，内部转 Lingva 码）
   * @param {string} toLang 目标语言（Google 风格，内部转 Lingva 码）
   * @return {Promise<{text: string, detected: ?string}>} detected 来自 Lingva 的 info.detectedSource
   */
  async requestSegment(segment, fromLang, toLang) {
    const source = LingvaEngine.toLingvaLang(fromLang);
    const target = LingvaEngine.toLingvaLang(toLang);
    const candidates = [];
    if (LingvaEngine.preferredInstance) candidates.push(LingvaEngine.preferredInstance);
    for (const instance of LingvaEngine.INSTANCES) {
      if (!candidates.includes(instance)) candidates.push(instance);
    }

    let lastError = null;
    for (const instance of candidates) {
      const url = `${instance}/api/v1/${encodeURIComponent(source)}/${encodeURIComponent(target)}/${encodeURIComponent(segment)}`;
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(LingvaEngine.SEGMENT_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data || typeof data.translation !== "string") throw new Error("返回结构异常");
        LingvaEngine.preferredInstance = instance;
        const infoSource = data.info && data.info.detectedSource;
        return {
          text: data.translation,
          detected: typeof infoSource === "string" && infoSource !== "" ? infoSource : null,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw new RetryableError(`Lingva 全部实例失败：${lastError ? lastError.message : "未知"}`);
  }
}

/**
 * 按 URL 长度与条数切块。
 *
 * 请求是 GET，所有 q 都进 query string，所以限制的是 URL 长度而不是 body 大小。
 * 用 encodeURIComponent 的真实长度估算：UTF-8 三字节汉字编码成 %E4%BD%A0
 * 是 9 个字符，按字节数估算会严重低估 URL 长度、把 URL 撑爆。
 * @param {string[]} texts 全量文本
 * @return {string[][]} 分块结果
 */
function splitIntoChunks(texts) {
  const chunks = [];
  let current = [];
  let urlChars = 0;

  for (const text of texts) {
    // "q=" 前缀 + 编码后的内容 + "&" 分隔符
    const cost = encodeURIComponent(text).length + 3;

    // 单条自身就超限时独占一块。
    // 历史：旧写法只有 `current.length > 0` 守卫，超长单条会绕过全部长度判断。
    // 但真机实测 URL 12555 字符（1600 个汉字）仍返回 200，说明 MAX_URL_CHARS
    // 只是留余量，不是 Google 的硬限；分块结果两种写法都是对的（旧代码切 3 块、
    // 新代码也 3 块），所以这里只是把意图写明确，不是修 bug。
    // 保留此分支的意义：将来若调小 MAX_URL_CHARS 或换端点，行为仍然正确。
    if (current.length > 0 && (current.length >= MAX_TEXTS_PER_CHUNK || urlChars + cost > MAX_URL_CHARS)) {
      chunks.push(current);
      current = [];
      urlChars = 0;
    }

    if (cost > MAX_URL_CHARS) {
      // 单条超长：交给上层按句切分后重试，这里先独占一块保证不丢内容
      chunks.push([text]);
      continue;
    }

    current.push(text);
    urlChars += cost;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/**
 * 按设置创建引擎实例。
 * @param {string} name 引擎名
 * @param {?string} apiKey Bing 密钥
 * @param {?Object} settings 完整设置（自定义接口需要）
 * @return {BaseEngine} 引擎实例
 */
export function createEngine(name, apiKey = null, settings = null) {
  if (name === "bing") return new BingEngine(apiKey);
  if (name === "mymemory") return new MyMemoryEngine();
  if (name === "lingva") return new LingvaEngine();
  if (name === "custom") return new CustomEngine(settings);
  return new GoogleEngine();
}
