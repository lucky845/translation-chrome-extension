/**
 * 引擎基础设施：统一基类、错误类型、通用工具。
 *
 * 单独成文件的原因：engine.js 需要 import 各引擎子模块，而子模块又要用错误类型。
 * 若错误类型留在 engine.js 里就会形成循环依赖（子模块求值时 engine.js 尚未完成初始化）。
 */

/**
 * 引擎基类：所有引擎必须实现 translate()。
 */
export class BaseEngine {
  /**
   * 该引擎当前是否可用（配置齐全）。
   * @return {Promise<boolean>} 是否可用
   */
  async isAvailable() {
    return true;
  }

  /**
   * 批量翻译。
   * @param {string[]} texts 原文
   * @param {string} fromLang 源语言
   * @param {string} toLang 目标语言
   * @return {Promise<Array<Object>>} 与输入等长同序的 {text, detected}
   */
  // eslint-disable-next-line no-unused-vars
  async translate(texts, fromLang, toLang) {
    throw new FatalTranslationError("BaseEngine.translate 未实现");
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
 * 限流错误（HTTP 429）：明确表示配额用尽，重试与逐条兜底都只会更糟。
 *
 * 与 RetryableError 的区别是策略而不是语义：429 看起来「等等就好」，
 * 但免费端点的限流窗口是分钟级的，退避 3 次 + 逐条补发只会让用户白等
 * （真机实测 200 段白等 103 秒、一条都没成）。这类错误要立刻交给降级链。
 */
export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "RateLimitError";
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
 * 判断是否为网络层失败（断网、被墙、DNS 失败、连接超时）。
 *
 * 这类失败重试没有意义：每次重试都要再等一个完整超时周期，
 * 用户看到的就是「转很久然后失败」。直接判为不可恢复，让降级链立刻换下一个引擎。
 * @param {*} error 错误
 * @return {boolean} 是否网络层失败
 */
export function isNetworkFailure(error) {
  if (!error) return false;
  if (error instanceof TypeError) return true; // fetch 的连接层错误
  const name = error.name || "";
  return name === "TimeoutError" || name === "AbortError" || name === "NetworkError";
}

/**
 * 延迟。
 * @param {number} ms 毫秒
 * @return {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * UTF-8 字节长度，用于控制请求体大小。
 * @param {string} text 文本
 * @return {number} 字节数
 */
export function byteLength(text) {
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
