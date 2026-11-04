/**
 * 自定义接口引擎。
 *
 * 设计目标：把「接哪个翻译服务」这件事
 * 从代码里搬到设置里。用户填一个地址 + 请求模板 + 响应路径，就能接自建 DeepLX、
 * 自建 LibreTranslate、任意 OpenAI 兼容中转，或者自己的代理服务。
 *
 * 为什么这是国内用户最需要的：公共免费接口（Google/MyMemory/Lingva）在特定网络下
 * 会被限流或直接不可达，而用户自己的中转通常是最稳的那条路。
 *
 * 模板占位符：
 *   {{text}}      原文（JSON 体里自动转义，URL 里自动 encodeURIComponent）
 *   {{textJson}}  原文的 JSON 字面量（含引号，用于 body: "q": {{textJson}}）
 *   {{from}} {{to}}           语言码（按预设做映射）
 *   {{fromName}} {{toName}}   语言英文名
 *   {{token}} {{model}}       令牌与模型名
 */

import { getSettings } from "../settings.js";
import { BaseEngine, RetryableError, FatalTranslationError, sleep } from "./base.js";
import { splitSentences } from "./text.js";

const REQUEST_TIMEOUT_MS = 20000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const THROTTLE_MS = 120;
const MAX_SEGMENT_CHARS = 1000;

/**
 * 语言码 → 英文名（供 AI 类接口拼 prompt）。
 */
const LANG_NAMES = {
  auto: "the detected source language",
  "zh-CN": "Simplified Chinese",
  "zh-TW": "Traditional Chinese",
  en: "English",
  ja: "Japanese",
  ko: "Korean",
  fr: "French",
  de: "German",
  es: "Spanish",
  ru: "Russian",
  pt: "Portuguese",
  it: "Italian",
  ar: "Arabic",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
  id: "Indonesian",
  ms: "Malay",
  pl: "Polish",
  tr: "Turkish",
  nl: "Dutch",
  sv: "Swedish",
  da: "Danish",
  fi: "Finnish",
  no: "Norwegian",
  hu: "Hungarian",
  cs: "Czech",
  ro: "Romanian",
  uk: "Ukrainian",
  el: "Greek",
};

/**
 * 语言码 → 基础码（zh-CN → zh）。
 * @param {string} lang 语言码
 * @return {string} 基础码
 */
function baseLang(lang) {
  return String(lang || "")
    .split("-")[0]
    .toLowerCase();
}

/**
 * 内置预设：用户选一个就能用，也可以逐字段改。
 */
export const CUSTOM_PRESETS = {
  deeplx: {
    label: "DeepLX（自建 / 公共实例）",
    hint: 'DeepLX 的 /translate 接口，返回 { data: "译文" }',
    url: "https://api.deeplx.org/translate",
    concurrency: 4,
    method: "POST",
    headers: '{"Content-Type": "application/json"}',
    body: '{"text": {{textJson}}, "source_lang": "{{from}}", "target_lang": "{{to}}"}',
    responsePath: "data",
    model: "",
    mapLang(lang, kind) {
      if (kind === "from" && (!lang || lang === "auto")) return "auto";
      return baseLang(lang).toUpperCase();
    },
  },
  libretranslate: {
    label: "LibreTranslate（自建）",
    hint: 'LibreTranslate 的 /translate 接口，返回 { translatedText: "译文" }',
    url: "https://libretranslate.com/translate",
    concurrency: 4,
    method: "POST",
    headers: '{"Content-Type": "application/json"}',
    body: '{"q": {{textJson}}, "source": "{{from}}", "target": "{{to}}", "format": "text"}',
    responsePath: "translatedText",
    model: "",
    mapLang(lang, kind) {
      if (kind === "from" && (!lang || lang === "auto")) return "auto";
      return baseLang(lang);
    },
  },
  openai: {
    label: "OpenAI 兼容接口（任意中转）",
    hint: "POST /v1/chat/completions，返回 choices[0].message.content",
    url: "https://api.openai.com/v1/chat/completions",
    concurrency: 2,
    method: "POST",
    headers: '{"Content-Type": "application/json", "Authorization": "Bearer {{token}}"}',
    body:
      '{"model": "{{model}}", "temperature": 0, "messages": [{"role": "user", ' +
      '"content": "Translate the following text into {{toName}}. ' +
      'Output only the translation, without quotes or explanation.\\n\\n{{text}}"}]}',
    responsePath: "choices.0.message.content",
    model: "gpt-4o-mini",
    mapLang(lang) {
      return lang || "auto";
    },
  },
  generic: {
    label: "通用（完全自定义）",
    hint: "自己填地址、请求模板与响应路径；响应是纯文本时把响应路径留空",
    url: "",
    concurrency: 1,
    method: "GET",
    headers: "{}",
    body: "",
    responsePath: "",
    model: "",
    mapLang(lang) {
      return lang || "auto";
    },
  },
};

/**
 * 预设名列表（供设置页按顺序渲染）。
 */
export const CUSTOM_PRESET_NAMES = ["deeplx", "libretranslate", "openai", "generic"];

/**
 * 取预设，非法名回落到 generic。
 * @param {string} name 预设名
 * @return {Object} 预设
 */
export function getPreset(name) {
  return CUSTOM_PRESETS[name] || CUSTOM_PRESETS.generic;
}

/**
 * 把设置里的自定义接口配置解析成一次可用请求所需的形态。
 *
 * 注意：url 不做预设回落——地址为空就视为未配置，引擎不可用。
 * 否则降级链会在用户从未配置的情况下把页面文本发给第三方预设地址（隐私事故）。
 * 其余字段允许回落，它们只在 url 已配置时才生效。
 * @param {Object} settings 设置对象
 * @return {Object} 解析后的配置
 */
export function resolveCustomConfig(settings) {
  const source = settings || {};
  const preset = getPreset(source.customPreset);
  return {
    preset: CUSTOM_PRESETS[source.customPreset] ? source.customPreset : "generic",
    url: String(source.customUrl || "").trim(),
    method: String(source.customMethod || preset.method || "POST").toUpperCase(),
    headers: String(source.customHeaders || preset.headers || "{}"),
    body: String(source.customBody || preset.body || ""),
    responsePath: String(
      source.customResponsePath !== undefined && source.customResponsePath !== null && source.customResponsePath !== ""
        ? source.customResponsePath
        : preset.responsePath || ""
    ).trim(),
    token: String(source.customToken || ""),
    model: String(source.customModel || preset.model || ""),
    concurrency: Math.max(1, Math.min(8, Number(preset.concurrency) || 1)),
    mapLang: preset.mapLang,
  };
}

/**
 * JSON 字符串内容转义（不含外层引号）。
 * @param {string} text 原文
 * @return {string} 转义后
 */
function escapeJsonString(text) {
  return JSON.stringify(String(text)).slice(1, -1);
}

/**
 * 渲染模板。kind=url 时所有变量做 URL 编码；kind=json 时 {{text}} 做 JSON 转义。
 * @param {string} template 模板
 * @param {Object} vars 变量表
 * @param {string} kind url/json
 * @return {string} 渲染结果
 */
export function renderTemplate(template, vars, kind) {
  return String(template || "").replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (!(name in vars)) return match;
    const value = vars[name] === undefined || vars[name] === null ? "" : String(vars[name]);
    if (kind === "url") return encodeURIComponent(value);
    if (kind === "json" && name === "text") return escapeJsonString(value);
    return value;
  });
}

/**
 * 按 "a.b.0.c" 路径从响应对象里取译文。
 * @param {*} data 响应对象
 * @param {string} path 路径
 * @return {*} 取到的值，取不到返回 undefined
 */
export function getByPath(data, path) {
  if (!path) return data;
  let current = data;
  for (const key of String(path).split(".")) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(key)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(key)];
    } else {
      current = current[key];
    }
  }
  return current;
}

/**
 * 构造请求头。
 * @param {string} raw 设置里的 JSON 字符串
 * @return {Object} 请求头
 */
function parseHeaders(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    throw new FatalTranslationError("自定义接口请求头不是合法 JSON，请检查 Headers 配置");
  }
}

/**
 * 自定义接口引擎。
 */
export class CustomEngine extends BaseEngine {
  /**
   * @param {?Object} settings 设置对象（缺省时自行读取）
   */
  constructor(settings = null) {
    super();
    this.settings = settings;
    this.config = settings ? resolveCustomConfig(settings) : null;
  }

  /**
   * 配置了地址才算可用。
   * @return {Promise<boolean>} 是否可用
   */
  async isAvailable() {
    const config = await this.configOrLoad();
    return Boolean(config.url);
  }

  /**
   * 读取/复用配置。
   * @return {Promise<Object>} 配置
   */
  async configOrLoad() {
    if (!this.config) {
      this.settings = await getSettings();
      this.config = resolveCustomConfig(this.settings);
    }
    return this.config;
  }

  /**
   * 批量翻译（自定义接口通常只支持单条，这里串行发）。
   * @param {string[]} texts 原文
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<Object>>} 结果
   */
  async translate(texts, fromLang, toLang) {
    const config = await this.configOrLoad();
    if (!config.url) {
      throw new FatalTranslationError("未配置自定义接口地址（设置 → 引擎 → 自定义接口）");
    }

    // 铺平成「文本 → 句片」任务表后并发执行，最后按原序拼回
    const plans = texts.map(text => (text && text.trim() ? splitSentences(text, MAX_SEGMENT_CHARS) : []));
    const tasks = [];
    plans.forEach((segments, textIndex) => {
      segments.forEach((segment, segmentIndex) => tasks.push({ textIndex, segmentIndex, segment }));
    });

    const filled = plans.map(segments => new Array(segments.length));
    let cursor = 0;

    const worker = async () => {
      while (cursor < tasks.length) {
        const task = tasks[cursor++];
        filled[task.textIndex][task.segmentIndex] = await this.requestWithRetry(task.segment, fromLang, toLang, config);
        if (cursor < tasks.length) await sleep(THROTTLE_MS);
      }
    };

    const workers = Array.from({ length: Math.min(config.concurrency || 1, tasks.length) }, worker);
    await Promise.all(workers);

    return texts.map((text, textIndex) => {
      const items = filled[textIndex];
      const detected = fromLang && fromLang !== "auto" ? fromLang : null;
      if (!items || items.length === 0) return { text: text || "", detected: null };
      return { text: items.join(""), detected };
    });
  }

  /**
   * 单段请求 + 重试。
   * @param {string} text 片段
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @param {Object} config 配置
   * @return {Promise<string>} 译文
   */
  async requestWithRetry(text, fromLang, toLang, config) {
    let lastError = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await this.requestOnce(text, fromLang, toLang, config);
      } catch (error) {
        lastError = error;
        if (!(error instanceof RetryableError) || attempt === MAX_RETRIES) break;
        await sleep(RETRY_BASE_MS * Math.pow(2, attempt));
      }
    }
    throw lastError instanceof FatalTranslationError
      ? lastError
      : new FatalTranslationError(`自定义接口翻译失败：${lastError ? lastError.message : "未知错误"}`);
  }

  /**
   * 发一次请求。
   * @param {string} text 片段
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @param {Object} config 配置
   * @return {Promise<string>} 译文
   */
  async requestOnce(text, fromLang, toLang, config) {
    const mapLang = config.mapLang || (lang => lang);
    const vars = {
      text,
      textJson: JSON.stringify(text),
      from: mapLang(fromLang, "from"),
      to: mapLang(toLang, "to"),
      fromName: LANG_NAMES[fromLang] || fromLang || "auto",
      toName: LANG_NAMES[toLang] || toLang || "English",
      token: config.token,
      model: config.model,
    };

    const url = renderTemplate(config.url, vars, "url");
    // headers 也要渲染模板：预设里的 "Authorization": "Bearer {{token}}" 依赖这一步
    const headers = parseHeaders(renderTemplate(config.headers, vars, "json"));
    const init = { method: config.method, headers, redirect: "follow" };

    if (config.method === "GET") {
      init.headers = headers;
    } else {
      const body = renderTemplate(config.body, vars, "json");
      if (body) {
        init.body = body;
        if (!hasHeader(headers, "content-type")) headers["Content-Type"] = "application/json";
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new RetryableError(`自定义接口请求超时（${REQUEST_TIMEOUT_MS}ms）`);
      }
      throw new RetryableError(`自定义接口连接失败：${error && error.message ? error.message : error}`);
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    if (!response.ok) {
      if (response.status === 429) throw new RetryableError("自定义接口限流（429）");
      if ([408, 425, 500, 502, 503, 504].includes(response.status)) {
        throw new RetryableError(`自定义接口暂时不可用（${response.status}）`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new FatalTranslationError(`自定义接口鉴权失败（${response.status}），请检查 Token 与 Headers`);
      }
      throw new FatalTranslationError(
        `自定义接口返回 ${response.status}：${String(raw || "").slice(0, 200) || "无响应内容"}`
      );
    }

    return extractTranslation(raw, config.responsePath);
  }
}

/**
 * 检查请求头里是否已有某个 key（大小写不敏感）。
 * @param {Object} headers 请求头
 * @param {string} name 名称
 * @return {boolean} 是否存在
 */
function hasHeader(headers, name) {
  return Object.keys(headers).some(key => key.toLowerCase() === name);
}

/**
 * 从响应里提取译文。
 * 响应路径为空时：能解析成 JSON 就用整段文本，解析不了就当纯文本返回。
 * @param {string} raw 原始响应
 * @param {string} path 响应路径
 * @return {string} 译文
 */
export function extractTranslation(raw, path) {
  const body = String(raw || "").trim();
  if (!body) throw new FatalTranslationError("自定义接口返回了空响应");

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    if (!path) return body;
    throw new FatalTranslationError(`自定义接口返回的不是 JSON，无法按路径「${path}」取译文`);
  }

  if (!path) {
    if (typeof data === "string") return data;
    throw new FatalTranslationError("响应是 JSON 对象但未配置响应路径（例如 data 或 translatedText）");
  }

  const value = getByPath(data, path);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number") return String(value);
  throw new FatalTranslationError(`响应中未找到译文（响应路径：${path}）`);
}
