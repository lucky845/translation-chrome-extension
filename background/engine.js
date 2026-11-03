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
export class RetryableError extends Error {
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
 * MyMemory 免费翻译引擎（api.mymemory.translated.net）。
 *
 * 实测（2026-11）：免密钥、匿名 GET 即可用，支持源语言 "Autodetect"，
 * 顶层返回 detectedLanguage 与 quotaFinished 字段。
 * 限制：单条 ≤ 500 字节；匿名按 IP 限日配额、高频触发限流——因此逐条串行、
 * 带节流间隔，超长文本按句拆片请求后拼接。
 */
export class MyMemoryEngine extends BaseEngine {
  static ENDPOINT = "https://api.mymemory.translated.net/get";
  // 单条请求的安全长度（MyMemory 官方上限 500 字节，取余量防 URL 编码膨胀）
  static MAX_SEGMENT_CHARS = 450;
  // 逐条请求节流：匿名配额宝贵，宁慢勿封
  static THROTTLE_MS = 150;

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
    const results = [];
    for (let index = 0; index < texts.length; index++) {
      if (index > 0) await sleep(MyMemoryEngine.THROTTLE_MS);
      results.push(await this.translateOne(texts[index], from, to));
    }
    return results;
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
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          if (response.status !== 429 && response.status >= 400 && response.status < 500) {
            throw new FatalTranslationError(`MyMemory HTTP ${response.status}`);
          }
          throw new RetryableError(`MyMemory HTTP ${response.status}`);
        }
        const data = await response.json();
        if (!data || !data.responseData || typeof data.responseData.translatedText !== "string") {
          throw new RetryableError("MyMemory 返回结构异常");
        }
        if (data.quotaFinished) {
          throw new FatalTranslationError("MyMemory 匿名配额已耗尽（当日）");
        }
        if (data.responseStatus !== 200) {
          throw new FatalTranslationError(`MyMemory responseStatus ${data.responseStatus}`);
        }
        return {
          text: data.responseData.translatedText,
          detected:
            typeof data.detectedLanguage === "string" && data.detectedLanguage !== "" ? data.detectedLanguage : null,
        };
      } catch (error) {
        if (error instanceof FatalTranslationError) throw error;
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
 * 按句边界把长文本拆成不超过 maxChars 的片段（句子尽量完整，超长单句硬切）。
 * 导出供单元测试。
 * @param {string} text 原文
 * @param {number} maxChars 单片字符上限
 * @return {string[]} 片段数组（拼接顺序与原文一致）
 */
export function splitSentences(text, maxChars) {
  if (!text || text.length <= maxChars) return text ? [text] : [];
  // 中英文句末标点后跟空白或直接结束都视为句边界
  const sentences = text.split(/(?<=[.!?。！？；;])\s*/);
  const segments = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      // 单句超限：硬切成固定长度的片
      if (current) {
        segments.push(current);
        current = "";
      }
      for (let offset = 0; offset < sentence.length; offset += maxChars) {
        segments.push(sentence.slice(offset, offset + maxChars));
      }
      continue;
    }
    if (current.length + sentence.length + 1 > maxChars) {
      segments.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) segments.push(current);
  return segments;
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
  if (name === "mymemory") return new MyMemoryEngine();
  if (name === "lingva") return new LingvaEngine();
  return new GoogleEngine();
}
