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

const ENDPOINT = "https://translate.googleapis.com/translate_a/t";

// 单次请求上限。实测 400 条普通句子会 400 错误，200 条稳定；body 控制在 48KB 内。
const MAX_TEXTS_PER_CHUNK = 200;
const MAX_BODY_BYTES = 48 * 1024;

// 并发上限。实测 20 并发 1.84s 全成功，但页面翻译取保守值避免触发限流。
const MAX_CONCURRENCY = 3;

// 重试：仅对网络错误与 5xx 重试，4xx 直接失败（重试无意义）。
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// 请求超时，防止 fetch 永久挂起。
const REQUEST_TIMEOUT_MS = 15000;

/**
 * 引擎基类。新增引擎只需实现 translate 与 isAvailable。
 */
class BaseEngine {
  /**
   * 是否可用于实际翻译。
   * @return {Promise<boolean>}
   */
  async isAvailable() {
    return true;
  }

  /**
   * 批量翻译。
   * @param {string[]} texts 待翻译文本
   * @param {string} fromLang 源语言，'auto' 表示自动检测
   * @param {string} toLang 目标语言
   * @return {Promise<Array<{text: string, detected: ?string}>>} 与输入等长、同序
   */
  async translate() {
    throw new Error("translate 未实现");
  }
}

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
        const response = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: params.toString(),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          // 429 是限流，退避重试是正确策略；其他 4xx 重试不会有不同结果
          if (response.status !== 429 && response.status >= 400 && response.status < 500) {
            throw new FatalTranslationError(`HTTP ${response.status}`);
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
        if (error instanceof FatalTranslationError) throw error;
        // 超时/网络中断/限流/结构异常都重试
        lastError = error;
      }
    }
    throw lastError || new Error("翻译请求失败");
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
 * 可重试错误：限流、超时、网络中断、响应结构异常。
 */
class RetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableError";
  }
}

/**
 * 不可恢复的错误（如 4xx），不应重试也不应触发降级循环。
 */
export class FatalTranslationError extends Error {
  constructor(message) {
    super(message);
    this.name = "FatalTranslationError";
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
 * 按请求体大小与条数切块。
 * @param {string[]} texts 全量文本
 * @return {string[][]} 分块结果
 */
function splitIntoChunks(texts) {
  const chunks = [];
  let current = [];
  let bytes = 0;

  for (const text of texts) {
    // "q=" + 内容 + "&" 的近似开销
    const cost = byteLength(text) + 3;
    if (current.length > 0 && (current.length >= MAX_TEXTS_PER_CHUNK || bytes + cost > MAX_BODY_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(text);
    bytes += cost;
  }
  if (current.length > 0) chunks.push(current);

  return chunks;
}

/**
 * UTF-8 字节长度，用于控制请求体大小。
 * @param {string} text 文本
 * @return {number} 字节数
 */
function byteLength(text) {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

/**
 * 延迟。
 * @param {number} ms 毫秒
 * @return {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 按设置创建引擎实例。
 * @param {string} name 引擎名
 * @param {?string} apiKey Bing 密钥
 * @return {BaseEngine} 引擎实例
 */
export function createEngine(name, apiKey = null) {
  if (name === "bing") return new BingEngine(apiKey);
  return new GoogleEngine();
}
