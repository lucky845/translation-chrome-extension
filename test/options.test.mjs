/**
 * 选项页冒烟测试：options.js 在真实 DOM 上加载不报错，面板显隐与预设预填正确。
 * chrome.* API 用最小桩替代——这里验的是页面交互，不是浏览器能力。
 *
 * 运行：node test/options.test.mjs
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const PRESETS = [
  {
    name: "deeplx",
    label: "DeepLX",
    url: "https://api.deeplx.org/translate",
    method: "POST",
    headers: '{"Content-Type": "application/json"}',
    body: '{"text": {{textJson}}, "target_lang": "{{to}}"}',
    responsePath: "data",
    model: "",
  },
  {
    name: "generic",
    label: "通用",
    url: "",
    method: "GET",
    headers: "{}",
    body: "",
    responsePath: "",
    model: "",
  },
];

const results = [];

/**
 * 记录一个测试用例结果。
 * @param {string} name 名称
 * @param {Function} fn 用例（可为 async）
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
 * 在 jsdom 里加载选项页，返回 window 与运行期错误。
 * @param {Object} stored 初始设置
 * @return {Promise<{win: Object, errors: string[], sent: string[]}>} 加载结果
 */
async function loadOptions(stored) {
  const html = readFileSync(new URL("../options/options.html", import.meta.url), "utf8");
  const script = readFileSync(new URL("../options/options.js", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "chrome-extension://test/options/options.html" });
  const { window } = dom;
  const errors = [];
  const sent = [];
  const store = { targetLanguage: "zh-CN", engine: "google", autoTranslate: false, apiKey: "", ...stored };

  window.addEventListener("error", event => errors.push(String(event.message)));
  window.addEventListener("unhandledrejection", event => errors.push(String(event.reason)));

  window.chrome = {
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
    i18n: { getMessage: key => key },
    runtime: {
      sendMessage: message => {
        sent.push(message.action);
        if (message.action === "getCustomPresets") return Promise.resolve({ ok: true, presets: PRESETS });
        return Promise.resolve({ ok: true, engine: "google", available: true, reason: null });
      },
    },
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
    },
  };

  window.eval(script);
  window.document.dispatchEvent(new window.Event("DOMContentLoaded", { bubbles: true }));
  // 等 init() 里的 await 链跑完
  await new Promise(resolve => setTimeout(resolve, 150));
  return { win: window, errors, sent };
}

console.log("[1] 选项页加载");

await test("加载完成且无 JS 异常", async () => {
  const { errors } = await loadOptions({});
  assert.deepEqual(errors, [], `页面报错: ${errors.join(" | ")}`);
});

await test("预设下拉从后台拉取并渲染", async () => {
  const { win, sent } = await loadOptions({});
  assert.ok(sent.includes("getCustomPresets"), "应请求预设列表");
  const options = win.document.querySelector("#custom-preset").options;
  assert.equal(options.length, PRESETS.length);
  assert.equal(options[0].value, "deeplx");
});

await test("语言下拉已填充（不是空 select）", async () => {
  const { win } = await loadOptions({});
  assert.ok(win.document.querySelector("#target-language").options.length > 10);
});

console.log("\n[2] 引擎切换与预设预填");

await test("切到自定义接口：面板显示并预填预设默认值", async () => {
  const { win } = await loadOptions({ customPreset: "deeplx", customUrl: "" });
  const doc = win.document;
  const engine = doc.querySelector("#engine");
  engine.value = "custom";
  engine.dispatchEvent(new win.Event("change"));

  assert.equal(doc.querySelector("#custom-settings").classList.contains("active"), true, "自定义面板应显示");
  assert.equal(doc.querySelector("#custom-url").value, "https://api.deeplx.org/translate", "地址应由预设预填");
  assert.equal(doc.querySelector("#custom-method").value, "POST");
  assert.equal(doc.querySelector("#custom-response-path").value, "data");
  assert.ok(doc.querySelector("#custom-body").value.includes("{{textJson}}"), "请求体模板应带占位符");
});

await test("切到 Azure：自定义面板收起，密钥面板显示", async () => {
  const { win } = await loadOptions({ engine: "custom", customUrl: "http://127.0.0.1:1188/tr" });
  const doc = win.document;
  const engine = doc.querySelector("#engine");
  engine.value = "bing";
  engine.dispatchEvent(new win.Event("change"));

  assert.equal(doc.querySelector("#custom-settings").classList.contains("active"), false);
  assert.equal(doc.querySelector("#azure-settings").classList.contains("active"), true);
});

await test("已保存的自定义接口配置会回填（不覆盖用户地址）", async () => {
  const { win } = await loadOptions({
    customPreset: "deeplx",
    customUrl: "http://127.0.0.1:1188/translate",
    customResponsePath: "translated",
  });
  const doc = win.document;
  assert.equal(doc.querySelector("#custom-url").value, "http://127.0.0.1:1188/translate");
  assert.equal(doc.querySelector("#custom-response-path").value, "translated");
});

console.log("\n[3] 弹窗与设置页职责边界");

await test("弹窗不含引擎选择项（引擎配置属于设置页）", () => {
  const html = readFileSync(new URL("../popup/popup.html", import.meta.url), "utf8");
  assert.equal(/id="engine"/.test(html), false, "弹窗不应再有引擎下拉，配置已移到设置页");
  assert.ok(/id="engine-info"/.test(html), "弹窗保留一行只读的翻译方式提示");
  assert.ok(/id="translate-btn"/.test(html), "翻译按钮必须存在");
  assert.ok(/id="options-btn"/.test(html), "设置入口必须存在");
});

await test("设置页提供引擎选择与端侧状态", () => {
  const html = readFileSync(new URL("../options/options.html", import.meta.url), "utf8");
  assert.ok(/id="engine"/.test(html), "设置页应有引擎下拉");
  assert.ok(/id="offline-status"/.test(html), "设置页应展示端侧可用性");
});

const failed = results.filter(result => !result.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
