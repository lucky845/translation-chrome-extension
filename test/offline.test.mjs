/**
 * 端侧翻译模块单元测试：Chrome / Edge 同一套 API，只做能力检测。
 * 用假的 globalThis.Translator 模拟浏览器内置 API，不需要真浏览器。
 *
 * 运行：node test/offline.test.mjs
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { createI18n } from "./i18n-mock.mjs";

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
 * 在干净环境里加载端侧模块。
 * @param {?Object} translatorStub 假的 Translator API，null 表示浏览器不支持
 * @return {Object} 加载后的 window
 */
function load(translatorStub) {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://example.com/" });
  const { window } = dom;
  if (translatorStub) window.Translator = translatorStub;

  // 真实中文词条：离线模块的错误文案要断言具体内容，不能拿 key 糊弄。
  window.chrome = { i18n: createI18n("zh_CN") };

  const scope = { globalThis: window, window, document: window.document, Node: window.Node };
  const loadFile = file => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    new Function(...Object.keys(scope), source)(...Object.values(scope));
  };
  loadFile("../shared/i18n.js");
  loadFile("../content/offline-translator.js");
  return window;
}

/** 模拟 Edge 148 / Chrome 138 的 Translator */
function mockTranslator(overrides = {}) {
  return {
    availability: async () => "available",
    create: async () => ({ translate: async text => `译[${text}]` }),
    ...overrides,
  };
}

console.log("[1] 能力检测（Chrome / Edge 同一套 API）");

await test("语言码收敛：zh-CN/zh-TW → zh，auto → en", () => {
  const { window } = load(null);
  const OT = window.__TP_OFFLINE__;
  assert.equal(OT.normalizeLang("zh-CN"), "zh");
  assert.equal(OT.normalizeLang("zh-TW"), "zh");
  assert.equal(OT.normalizeLang("en-US"), "en");
  assert.equal(OT.normalizeLang("auto"), "en");
});

await test("浏览器无 Translator（旧版/其他内核）→ supported=false，不抛错", async () => {
  const { window } = load(null);
  const OT = window.__TP_OFFLINE__;
  assert.equal(OT.supported, false);
  assert.equal(await OT.availability("en", "zh-CN"), "unsupported");
  await assert.rejects(() => OT.translate(["hi"], "en", "zh-CN"), /不支持端侧翻译/);
});

await test("浏览器有 Translator（Chrome 138+/Edge 148+）→ supported=true", () => {
  const { window } = load(mockTranslator());
  assert.equal(window.__TP_OFFLINE__.supported, true);
});

await test("availability 透传浏览器返回值（available/downloadable/…）", async () => {
  const { window } = load(mockTranslator({ availability: async () => "downloadable" }));
  assert.equal(await window.__TP_OFFLINE__.availability("en", "zh-CN"), "downloadable");
});

console.log("\n[2] 翻译与会话缓存");

await test("批量翻译等长同序，空字符串原样返回", async () => {
  const { window } = load(mockTranslator());
  const out = await window.__TP_OFFLINE__.translate(["one", "", "three"], "en", "zh-CN");
  assert.equal(out.length, 3);
  assert.deepEqual(
    out.map(i => i.text),
    ["译[one]", "", "译[three]"]
  );
});

await test("同一语言对只创建一次会话（模型只加载一遍）", async () => {
  let creates = 0;
  const { window } = load(
    mockTranslator({
      create: async () => {
        creates += 1;
        return { translate: async t => t };
      },
    })
  );
  const OT = window.__TP_OFFLINE__;
  await OT.translate(["a"], "en", "zh-CN");
  await OT.translate(["b"], "en", "zh-CN");
  await OT.translate(["c"], "en", "zh"); // zh-CN 与 zh 必须复用
  assert.equal(creates, 1);
});

await test("创建失败不缓存失败态：下次仍会重试", async () => {
  let creates = 0;
  const { window } = load(
    mockTranslator({
      create: async () => {
        creates += 1;
        if (creates === 1) throw new Error("Requires a user gesture");
        return { translate: async t => `译[${t}]` };
      },
    })
  );
  const OT = window.__TP_OFFLINE__;
  await assert.rejects(() => OT.translate(["a"], "en", "zh-CN"), /端侧翻译失败|user gesture/);
  const out = await OT.translate(["b"], "en", "zh-CN");
  assert.equal(out[0].text, "译[b]");
  assert.equal(creates, 2);
});

await test("同一文档内重复纯文本复用端侧译文，不跨语言对或文档", async () => {
  let calls = 0;
  const stub = {
    availability: async () => "available",
    create: async ({ targetLanguage }) => ({
      translate: async text => `${targetLanguage}:${text}:${++calls}`,
    }),
  };
  const first = load(stub).__TP_OFFLINE__;
  const result = await first.translate(["Open settings", " Open settings "], "en", "zh-CN");
  assert.equal(result[0].text, result[1].text);
  assert.equal(calls, 1);
  assert.equal((await first.translate(["Open settings"], "en", "ja"))[0].text, "ja:Open settings:2");
  assert.equal(
    (await load(stub).__TP_OFFLINE__.translate(["Open settings"], "en", "zh-CN"))[0].text,
    "zh:Open settings:3"
  );
});

await test("同一文档并发请求相同文案时只启动一次端侧推理", async () => {
  let calls = 0;
  let finish;
  const pending = new Promise(resolve => (finish = resolve));
  const { window } = load(
    mockTranslator({
      create: async () => ({
        translate: () => {
          calls++;
          return pending;
        },
      }),
    })
  );
  const api = window.__TP_OFFLINE__;
  const first = api.translate(["Open the guide"], "auto", "zh-CN");
  const second = api.translate([" Open the guide "], "en", "zh");
  finish("打开指南");
  const [one, two] = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.equal(one[0].text, "打开指南");
  assert.equal(two[0].text, "打开指南");
  window.close();
});

await test("并发端侧推理失败后不会阻止下次重试", async () => {
  let calls = 0;
  const { window } = load(
    mockTranslator({
      create: async () => ({
        translate: async () => {
          if (++calls === 1) throw new Error("temporary inference failure");
          return "恢复成功";
        },
      }),
    })
  );
  const api = window.__TP_OFFLINE__;
  const attempt = () => api.translate(["Try again"], "en", "zh");
  const results = await Promise.allSettled([attempt(), attempt()]);
  assert.deepEqual(
    results.map(result => result.status),
    ["rejected", "rejected"]
  );
  assert.equal(calls, 1);
  assert.equal((await attempt())[0].text, "恢复成功");
  assert.equal(calls, 2);
  window.close();
});

await test("端侧原样回传和未经校验的占位符译文不缓存", async () => {
  const calls = [];
  const window = load({
    availability: async () => "available",
    create: async () => ({
      translate: async text => {
        calls.push(text);
        return text === "Unchanged" ? text : `译[${text}]`;
      },
    }),
  });
  const texts = ["Unchanged", "Read <a i=0>guide</a>", "Read {{0}}guide{{/0}}"];
  await window.__TP_OFFLINE__.translate(texts, "en", "zh");
  await window.__TP_OFFLINE__.translate(texts, "en", "zh");
  assert.deepEqual(calls, [...texts, ...texts]);
});

await test("翻译失败时保留原始 error 作为 cause（排查要能拿到真实堆栈）", async () => {
  const boom = new Error("Requires a user gesture");
  const { window } = load(
    mockTranslator({
      create: async () => ({
        translate: async () => {
          throw boom;
        },
      }),
    })
  );
  const OT = window.__TP_OFFLINE__;
  const error = await OT.translate(["a"], "en", "zh-CN").then(
    () => null,
    e => e
  );
  assert.ok(error, "必须抛错");
  assert.match(error.message, /端侧翻译失败/);
  assert.equal(error.cause, boom, "cause 必须是原始 error 对象，不能被丢掉");
});

await test("warmup 成功 → 记录无失败原因；失败 → 记录原因供界面提示", async () => {
  const okWindow = load(mockTranslator());
  assert.equal(await okWindow.__TP_OFFLINE__.warmup("en", "zh-CN"), true);
  assert.equal(okWindow.__TP_OFFLINE__.warmupFailure, null);

  const failWindow = load(
    mockTranslator({
      create: async () => {
        throw new Error("Requires a user gesture");
      },
    })
  );
  assert.equal(await failWindow.__TP_OFFLINE__.warmup("en", "zh-CN"), false);
  assert.match(failWindow.__TP_OFFLINE__.warmupFailure, /user gesture/);
});

await test("warmup 后立刻可翻译（模型已就绪）", async () => {
  const { window } = load(mockTranslator());
  const OT = window.__TP_OFFLINE__;
  assert.equal(await OT.warmup("en", "zh-CN"), true);
  const out = await OT.translate(["hello"], "en", "zh-CN");
  assert.equal(out[0].text, "译[hello]");
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
