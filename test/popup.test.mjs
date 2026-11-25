/**
 * Popup 界面单元测试。
 *
 * 这里不测 Chrome 弹窗渲染，测的是「界面上的每个字是否真的来自词条」：
 * 语言下拉是否按界面语言生成、状态提示是否走 I18N.t、切到英文后是否整屏英文。
 * 之前这些文案是硬编码中文，切界面语言后一半中文一半英文。
 *
 * 运行：node test/popup.test.mjs
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
 * 加载 popup 页面。
 * @param {Object} options 选项（locale / stored / tabStatus）
 * @return {Promise<Object>} 页面对象
 */
async function loadPopup(options = {}) {
  const locale = options.locale || "zh_CN";
  const html = readFileSync(new URL("../popup/popup.html", import.meta.url), "utf8");
  const i18nScript = readFileSync(new URL("../shared/i18n.js", import.meta.url), "utf8");
  const script = readFileSync(new URL("../popup/popup.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://test/popup/popup.html" });
  const { window } = dom;
  const errors = [];
  const sent = [];
  const store = {
    targetLanguage: "zh-CN",
    sourceLanguage: "auto",
    autoTranslate: false,
    engine: "google",
    ...options.stored,
  };

  window.addEventListener("error", event => errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

  const tabStatus = options.tabStatus === undefined ? { state: "idle" } : options.tabStatus;

  window.chrome = {
    i18n: createI18n(locale),
    storage: {
      sync: {
        get: defaults => Promise.resolve({ ...defaults, ...store }),
        set: patch => {
          Object.assign(store, patch);
          return Promise.resolve();
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: null,
      openOptionsPage: () => {},
    },
    tabs: {
      query: () => Promise.resolve([{ id: 1 }]),
      sendMessage: (tabId, message, callback) => {
        sent.push(message.action);
        if (message.action === "getStatus") {
          callback(tabStatus);
          return;
        }
        if (message.action === "translatePage") {
          callback(options.translateResult || { success: true, count: 12 });
          return;
        }
        if (message.action === "restorePage") {
          callback({ success: true, count: 12 });
          return;
        }
        callback(null);
      },
    },
  };

  window.eval(i18nScript);
  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 120));
  return { win: window, errors, sent, store };
}

/**
 * 取某个元素的文本。
 * @param {Object} win window
 * @param {string} id 元素 id
 * @return {string} 文本
 */
function textOf(win, id) {
  const element = win.document.getElementById(id);
  return element ? element.textContent.trim() : "";
}

console.log("[1] 静态文案");

await test("加载完成且无 JS 异常", async () => {
  const { errors } = await loadPopup({});
  assert.deepEqual(errors, [], `页面报错: ${errors.join(" | ")}`);
});

await test("data-i18n 的元素都换成了真实词条（不是 key）", async () => {
  const { win } = await loadPopup({});
  const title = win.document.querySelector("h1[data-i18n]");
  assert.equal(title.textContent, zhMessages.popupTitle.message);
  assert.notEqual(title.textContent, "popupTitle");
});

console.log("\n[2] 语言下拉");

await test("源语言下拉带「自动检测」，目标语言下拉不带", async () => {
  const { win } = await loadPopup({});
  const source = win.document.getElementById("source-language");
  const target = win.document.getElementById("target-language");
  const sourceLabels = [...source.options].map(option => option.textContent);
  const targetLabels = [...target.options].map(option => option.textContent);
  assert.ok(sourceLabels.includes(zhMessages.sourceAutoDetect.message), "源语言缺少自动检测");
  assert.ok(!targetLabels.includes(zhMessages.sourceAutoDetect.message), "目标语言不该有自动检测");
});

await test("语言名按界面语言生成，不是硬编码中文", async () => {
  const zh = await loadPopup({ locale: "zh_CN" });
  const en = await loadPopup({ locale: "en" });
  const zhLabels = [...zh.win.document.getElementById("target-language").options].map(option => option.textContent);
  const enLabels = [...en.win.document.getElementById("target-language").options].map(option => option.textContent);
  // 简体 / 繁体两条走词条，其余走 Intl.DisplayNames
  assert.ok(zhLabels.includes(zhMessages.langZhHans.message), "中文界面缺少「中文（简体）」");
  assert.ok(enLabels.includes(enMessages.langZhHans.message), "英文界面缺少「Chinese (Simplified)」");
  assert.ok(
    enLabels.every(label => !/[\u4e00-\u9fff]/.test(label)),
    `英文界面仍有中文语言名: ${enLabels.filter(label => /[\u4e00-\u9fff]/.test(label)).join(" | ")}`
  );
});

console.log("\n[3] 状态提示");

await test("当前页面不支持翻译时给出可读提示", async () => {
  const { win } = await loadPopup({ tabStatus: null });
  assert.equal(textOf(win, "status"), zhMessages.pageUnsupportedDetailed.message);
});

await test("翻译成功但仍有失败段落时，如实说明未翻完", async () => {
  const { win } = await loadPopup({
    translateResult: { success: true, count: 100, failed: 85 },
  });
  win.document.getElementById("translate-btn").click();
  await new Promise(resolve => setTimeout(resolve, 60));
  const status = textOf(win, "status");
  // 旧实现会显示「已翻译 100 处文本」，把 85 段失败藏起来
  assert.ok(/85/.test(status), `没有提到失败的 85 段: ${status}`);
  assert.ok(!/^已翻译 100 处文本$/.test(status), `把失败段落藏起来了: ${status}`);
});

await test("全部翻成时才显示「已翻译 N 处」", async () => {
  const { win } = await loadPopup({ translateResult: { success: true, count: 12, failed: 0 } });
  win.document.getElementById("translate-btn").click();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(textOf(win, "status"), zhMessages.statusTranslated.message.replace("$COUNT$", "12"));
});

console.log("\n[4] 引擎提示");

await test("端侧可用时提示本地推理，不暴露在线引擎名", async () => {
  const { win } = await loadPopup({ tabStatus: { state: "idle", offline: true } });
  assert.equal(textOf(win, "engine-info"), zhMessages.engineInfoOffline.message);
});

await test("端侧不可用时显示当前在线引擎名", async () => {
  const { win } = await loadPopup({ stored: { engine: "custom" } });
  const info = textOf(win, "engine-info");
  assert.ok(info.includes(zhMessages.engineNameCustom.message), `没有显示自定义接口: ${info}`);
  assert.ok(info.includes("Google") === false, `错报了 Google: ${info}`);
});

await test("切到英文界面后引擎提示也是英文", async () => {
  const { win } = await loadPopup({ locale: "en", stored: { engine: "custom" } });
  const info = textOf(win, "engine-info");
  assert.ok(!/[\u4e00-\u9fff]/.test(info), `英文界面仍有中文: ${info}`);
  assert.ok(info.includes(enMessages.engineNameCustom.message), `没有用英文词条: ${info}`);
});

const failed = results.filter(result => !result.ok).length;
console.log("\n" + "=".repeat(50));
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
