/**
 * 测试用的 chrome.i18n 替身。
 *
 * 直接读 _locales/zh_CN/messages.json，按 Chrome 的规则做 $NAME$ 替换。
 * 这样断言里写的中文就是真实词条，而不是「getMessage 返回 key」那种
 * 只能证明「函数被调过」的假验证。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @type {Object} zh_CN 词表 */
export const zhMessages = JSON.parse(readFileSync(join(root, "_locales/zh_CN/messages.json"), "utf8"));

/** @type {Object} en 词表 */
export const enMessages = JSON.parse(readFileSync(join(root, "_locales/en/messages.json"), "utf8"));

/**
 * 按 Chrome 规则格式化一条词条：
 * 先按 placeholders 把 $NAME$ 换成 $N$，再把 $N$ 换成本次参数。
 * @param {Object} entry 词条
 * @param {Array<string>} substitutions 参数
 * @return {string} 文案
 */
export function formatMessage(entry, substitutions) {
  if (!entry) return "";
  const placeholders = entry.placeholders || {};
  let text = entry.message;
  for (const name of Object.keys(placeholders)) {
    const content = placeholders[name].content || "";
    text = text.split("$" + name.toUpperCase() + "$").join(content);
  }
  return text.replace(/\$(\d)/g, (whole, index) => {
    const value = substitutions[Number(index) - 1];
    return value === undefined ? "" : String(value);
  });
}

/**
 * 造一个 chrome.i18n 替身。
 * @param {string} locale zh_CN 或 en
 * @return {Object} i18n 对象
 */
export function createI18n(locale = "zh_CN") {
  const table = locale === "en" ? enMessages : zhMessages;
  return {
    getMessage: (key, substitutions) => formatMessage(table[key], substitutions || []),
    getUILanguage: () => (locale === "en" ? "en" : "zh-CN"),
  };
}
