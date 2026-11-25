/**
 * shared/i18n.js 单元测试。
 *
 * 这里不测 Chrome，只测「取不到词条时会不会把界面弄成空白」这类退化路径：
 * content script 跑在没有 chrome 的 Node 环境里、极旧内核、词条拼错，都必须有可读输出。
 *
 * 运行：node test/i18n.test.mjs
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createI18n, enMessages, zhMessages } from "./i18n-mock.mjs";

const results = [];

/**
 * 记录一个测试用例结果。
 * @param {string} name 名称
 * @param {Function} fn 用例
 * @return {Promise<void>} 完成
 */
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`  ❌ ${name}`);
    console.log(`     ${error.message}`);
  }
}

/**
 * 在干净环境里加载 i18n 助手。
 * @param {?Object} i18n chrome.i18n 替身，null 表示环境没有 chrome
 * @return {Object} 加载后的 window
 */
function load(i18n) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com/" });
  const { window } = dom;
  if (i18n) window.chrome = { i18n };
  const source = readFileSync(new URL("../shared/i18n.js", import.meta.url), "utf8");
  const scope = { globalThis: window, window, document: window.document };
  new Function(...Object.keys(scope), source)(...Object.values(scope));
  return window;
}

console.log("[1] 退化路径：绝不能返回 undefined");

await test("没有 chrome.i18n 时 t() 退回 key 本身", () => {
  const window = load(null);
  const I18N = window.__TP_I18N__;
  assert.equal(I18N.t("extensionName"), "extensionName");
});

await test("getMessage 返回空串时 t() 也退回 key（不返回空文本）", () => {
  const window = load({ getMessage: () => "" });
  assert.equal(window.__TP_I18N__.t("settingsSaved"), "settingsSaved");
});

await test("getMessage 抛异常时不把整个界面拖崩", () => {
  const window = load({
    getMessage: () => {
      throw new Error("boom");
    },
  });
  assert.equal(window.__TP_I18N__.t("settingsSaved"), "settingsSaved");
});

await test("raw() 在词条缺失时返回空串，供调用方自己兜底", () => {
  const window = load(createI18n("zh_CN"));
  assert.equal(window.__TP_I18N__.raw("noSuchKey"), "");
  assert.equal(window.__TP_I18N__.raw("settingsSaved"), zhMessages.settingsSaved.message);
});

console.log("\n[2] 占位符替换");

await test("t() 按 Chrome 规则替换 $NAME$ 占位符", () => {
  const window = load(createI18n("zh_CN"));
  const I18N = window.__TP_I18N__;
  assert.equal(I18N.t("statusTranslated", 7), "已翻译 7 处文本");
  assert.equal(I18N.t("indicatorPartialFailed", 118, 120, 2), "已翻译 118/120 段 · 剩余 2 段失败");
});

await test("英文界面的同一批词条能正确替换（切语言不是只换静态 HTML）", () => {
  const window = load(createI18n("en"));
  const I18N = window.__TP_I18N__;
  assert.equal(I18N.t("statusTranslated", 7), "Translated 7 items");
  assert.equal(I18N.t("statusCancelled"), "Translation cancelled");
  // 中英必须真的不同，否则等于没做 i18n
  assert.notEqual(enMessages.statusCancelled.message, zhMessages.statusCancelled.message);
});

console.log("\n[3] 语言名");

await test("29 个语言码都产出非空且不等于语言码的显示名", () => {
  const window = load(createI18n("zh_CN"));
  const I18N = window.__TP_I18N__;
  const codes = [
    "zh-CN",
    "zh-TW",
    "en",
    "ja",
    "ko",
    "fr",
    "de",
    "es",
    "ru",
    "pt",
    "it",
    "ar",
    "hi",
    "th",
    "vi",
    "id",
    "ms",
    "pl",
    "tr",
    "nl",
    "sv",
    "da",
    "fi",
    "no",
    "hu",
    "cs",
    "ro",
    "uk",
    "el",
  ];
  for (const code of codes) {
    const label = I18N.langName(code);
    assert.ok(label, `${code} 没有显示名`);
    assert.notEqual(label, code, `${code} 退回了语言码`);
  }
});

await test("zh-CN / zh-TW 用「简体 / 繁体」而不是 ICU 的「中国 / 台湾」", () => {
  const window = load(createI18n("zh_CN"));
  const I18N = window.__TP_I18N__;
  assert.equal(I18N.langName("zh-CN"), "中文（简体）");
  assert.equal(I18N.langName("zh-TW"), "中文（繁体）");
});

await test("未知语言码不抛错，且仍能看出是哪个语言", () => {
  const window = load(createI18n("zh_CN"));
  const label = window.__TP_I18N__.langName("xx-YY");
  // DisplayNames 对未知语言会给出「xx（YY）」这类降级写法，
  // 只要不是空串、且还认得出语言子标签，下拉框就不会出现空白项。
  assert.ok(label.length > 0, "未知语言码返回了空串");
  assert.ok(label.includes("xx"), `未知语言码丢了语言子标签: ${label}`);
});

const failed = results.filter(result => !result.ok).length;
console.log("\n" + "=".repeat(50));
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
