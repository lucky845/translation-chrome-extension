/**
 * Content script 调度测试：验证批量翻译落地、动态内容增量翻译、恢复。
 *
 * 用 jsdom + 桩 chrome.runtime，不起浏览器；布局 API 在 jsdom 里返回全零，
 * 因此这里验证的是「调度与状态机」，视觉优先级由真实 Chrome E2E 覆盖。
 *
 * 运行：node test/content.test.mjs
 */
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

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
 * 在 jsdom 中加载 content script，返回消息入口与调用记录。
 * @param {string} html 页面 HTML
 * @return {Promise<Object>} 环境
 */
async function loadContent(html, options = {}) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: "https://example.com/" });
  const { window } = dom;

  // 可选：注入模拟的浏览器内置翻译（Chrome 138+ / Edge 148+）
  if (options.offline) {
    window.Translator = {
      availability: async () => "available",
      create: async () => ({ translate: async text => `本地[${text}]` }),
    };
  }

  /** @type {Array<Object>} */
  const sent = [];
  /** @type {?Function} */
  let listener = null;

  const settings = {
    targetLanguage: "zh-CN",
    sourceLanguage: "auto",
    engine: "google",
    autoTranslate: false,
    useOffline: "auto",
    translatedStyle: "none",
    ...(options.settings || {}),
  };
  const engineName = options.engineMode || settings.engine;

  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        sent.push(message);
        let response = { ok: true };
        if (message.action === "getSettings") {
          response = { ok: true, settings };
        } else if (message.action === "translateBatch") {
          const translate = text => {
            if (engineName !== "custom") return `译[${text}]`;
            // 把 {{n}} token 原样保留，文字段包 译[]
            return text
              .replace(/\{\{\d+\}\}/g, "\u0000$&\u0000")
              .split("\u0000")
              .map(part => (/^\{\{\d+\}\}$/.test(part) ? part : part.trim() ? `译[${part}]` : ""))
              .join("");
          };
          response = {
            ok: true,
            engine: engineName,
            degraded: false,
            results: message.texts.map(text => ({ text: translate(text), detected: "en" })),
          };
        } else if (message.action === "translateText") {
          response = { ok: true, translatedText: "单条译文" };
        }
        if (callback) {
          callback(response);
          return undefined;
        }
        return Promise.resolve(response);
      },
      onMessage: {
        addListener: fn => {
          listener = fn;
        },
      },
    },
  };

  // 传统脚本：用 Function 参数把 jsdom 的 document/window 注入脚本作用域。
  // dom-core.js 以 (function(root){...})(globalThis) 挂载，所以 globalThis 形参必须传 window。
  const load = (file, names) => {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const scope = {
      globalThis: window,
      window,
      document: window.document,
      chrome: window.chrome,
      Node: window.Node,
      MutationObserver: window.MutationObserver,
      IntersectionObserver: window.IntersectionObserver,
    };
    const args = names.map(name => scope[name]);
    return new Function(...names, source)(...args);
  };

  load("../content/dom-core.js", ["globalThis", "document", "Node"]);
  assert.ok(window.__TP_DOM__, "dom-core.js 应挂载 __TP_DOM__");
  load("../content/offline-translator.js", ["globalThis", "window", "document", "Node"]);
  load("../content/content.js", ["window", "document", "chrome", "MutationObserver", "IntersectionObserver"]);

  assert.ok(listener, "content script 应注册消息监听");
  /** @param {Object} message 消息 */
  const dispatch = message =>
    new Promise(resolve => {
      const returned = listener(message, {}, resolve);
      if (returned !== true) resolve(undefined);
    });

  return { window, sent, dispatch };
}

console.log("[1] 整页翻译");

await test("批量翻译后段落被替换为译文", async () => {
  const { window, sent, dispatch } = await loadContent("<p>Hello one.</p><p>Hello two.</p>");
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true, `翻译应成功: ${result.error || ""}`);
  assert.equal(result.count, 2);
  const texts = Array.from(window.document.querySelectorAll("p")).map(p => p.textContent);
  assert.deepEqual(texts, ["译[Hello one.]", "译[Hello two.]"]);

  const batch = sent.find(message => message.action === "translateBatch");
  assert.ok(batch, "应发送批量翻译请求");
  assert.deepEqual(batch.texts, ["Hello one.", "Hello two."], "整段文本作为单元发送，不拆碎");
});

await test("恢复后 DOM 回到原文", async () => {
  const { window, dispatch } = await loadContent("<p>Hello one.</p>");
  await dispatch({ action: "translatePage" });
  await dispatch({ action: "restorePage" });
  assert.equal(window.document.querySelector("p").textContent, "Hello one.");
});

await test("已是中文页面时不重复翻译", async () => {
  const { window, sent, dispatch } = await loadContent("<p>这是一段完整的中文内容，用来判断页面是否已是目标语言。</p>");
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, false);
  assert.ok(/中文/.test(result.error), `应提示无需翻译，实际: ${result.error}`);
  assert.equal(sent.filter(message => message.action === "translateBatch").length, 0, "不应发起翻译请求");
  assert.ok(window.document.body.textContent.includes("中文内容"));
});

await test("翻译 → 恢复 → 再翻译：第二次必须成功且结构仍在", async () => {
  const { window, dispatch } = await loadContent('<p>Hello one.</p><p>Hello <a href="#">two</a>.</p>');

  const first = await dispatch({ action: "translatePage" });
  assert.equal(first.success, true, `首次翻译失败: ${first.error || ""}`);

  const restored = await dispatch({ action: "restorePage" });
  assert.equal(restored.success, true);
  assert.equal(window.document.querySelectorAll("p")[0].textContent, "Hello one.");

  const second = await dispatch({ action: "translatePage" });
  assert.equal(second.success, true, `恢复后再翻译失败: ${second.error || ""}（缓存命中曾误报请求失败）`);
  assert.equal(second.count, 2);

  const p2 = window.document.querySelectorAll("p")[1];
  assert.equal(p2.textContent, "译[Hello two.]");
  assert.ok(p2.querySelector("a"), "第二轮翻译内联标签应仍然保留");
});

console.log("\n[1.2] 中英混排：只翻英文，不把中文再翻一遍");

await test("中文段落被剔除，英文段落照常翻译", async () => {
  const { window, sent, dispatch } = await loadContent(
    "<p>这是一段已经写好的中文说明，不应该被再翻译一次。</p><p>This English paragraph must be translated.</p>"
  );
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true, result.error || "");

  const ps = Array.from(window.document.querySelectorAll("p")).map(p => p.textContent);
  assert.equal(ps[0], "这是一段已经写好的中文说明，不应该被再翻译一次。", "中文段落必须原样保留");
  assert.equal(ps[1], "译[This English paragraph must be translated.]", "英文段落必须翻译");

  const batch = sent.find(m => m.action === "translateBatch");
  assert.ok(batch, "应发出翻译请求");
  assert.equal(batch.texts.length, 1, `只应送翻英文段，实际送了 ${batch.texts.length} 段`);
});

await test("整页都是中文时不发任何翻译请求", async () => {
  const { sent, dispatch } = await loadContent(
    "<p>这是第一段中文内容，足够长以便被识别。</p><p>这是第二段中文内容，同样不需要翻译。</p>"
  );
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, false);
  assert.ok(/目标语言|无需翻译/.test(result.error), `应提示无需翻译，实际: ${result.error}`);
  assert.equal(sent.filter(m => m.action === "translateBatch").length, 0, "不应发出翻译请求");
});

console.log("\n[1.5] 端侧优先（Chrome/Edge 通用）");

await test("端侧可用时走本地，不发任何在线请求", async () => {
  const { window, sent, dispatch } = await loadContent("<p>Hello one.</p><p>Hello two.</p>", { offline: true });
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true, `端侧翻译失败: ${result.error || ""}`);

  const texts = Array.from(window.document.querySelectorAll("p")).map(p => p.textContent);
  assert.deepEqual(texts, ["本地[Hello one.]", "本地[Hello two.]"]);

  const online = sent.filter(m => m.action === "translateBatch" || m.action === "translateText");
  assert.equal(online.length, 0, `端侧成功时不应请求在线引擎，实际 ${online.length} 次`);
});

await test("浏览器不支持端侧时自动回落在线引擎", async () => {
  const { window, sent, dispatch } = await loadContent("<p>Hello one.</p>", { offline: false });
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true);
  assert.equal(window.document.querySelector("p").textContent, "译[Hello one.]");
  assert.ok(
    sent.some(m => m.action === "translateBatch"),
    "应回落到在线引擎"
  );
});

await test("getStatus 报告端侧能力，供弹窗展示", async () => {
  const { dispatch } = await loadContent("<p>Hello one.</p>", { offline: true });
  const status = await dispatch({ action: "getStatus" });
  assert.equal(status.offline, true);
});

console.log("\n[1.8] 端侧开关与 brace 模式");

await test("useOffline=off 时跳过端侧，直接走在线引擎", async () => {
  const { window, sent, dispatch } = await loadContent("<p>Hello one.</p>", {
    offline: true,
    settings: { useOffline: "off" },
  });
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true);
  // 走了在线引擎（translateBatch 被调用），而不是端侧
  assert.ok(
    sent.some(m => m.action === "translateBatch"),
    "off 时应发在线请求"
  );
  assert.equal(window.document.querySelector("p").textContent, "译[Hello one.]");
});

await test("useOffline=auto 时端侧优先，不发在线请求", async () => {
  const { sent, dispatch } = await loadContent("<p>Hello one.</p>", {
    offline: true,
    settings: { useOffline: "auto" },
  });
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true);
  assert.equal(sent.filter(m => m.action === "translateBatch").length, 0, "端侧成功时不应有在线请求");
});

await test("engine=custom 时用 brace 占位符送翻并原子还原", async () => {
  const { window, sent, dispatch } = await loadContent('<p>Read the <a href="/d" class="lnk">docs</a> now.</p>', {
    offline: false,
    settings: { engine: "custom" },
    engineMode: "custom",
  });
  const result = await dispatch({ action: "translatePage" });
  assert.equal(result.success, true, `失败: ${result.error || ""}`);

  const batch = sent.find(m => m.action === "translateBatch");
  assert.ok(batch, "应有批量请求");
  assert.match(batch.texts[0], /\{\{0\}\}/, `应使用 brace 占位符，实际: ${batch.texts[0]}`);
  assert.ok(!/<\d+>/.test(batch.texts[0]), "不应含 <n> 标签");

  const a = window.document.querySelector("p a");
  assert.ok(a, "链接元素必须存在");
  assert.equal(a.getAttribute("href"), "/d", "href 保留");
  assert.equal(a.textContent, "译[docs]", "链接内文字应被翻译（mock 不改词，只包标记）");
});

await test("translatedStyle 注入对应 CSS 规则", async () => {
  const { window, dispatch } = await loadContent("<p>Hello one.</p>", {
    offline: false,
    settings: { translatedStyle: "highlight" },
  });
  await dispatch({ action: "translatePage" });
  const style = window.document.getElementById("tp-translated-style");
  assert.ok(style, "应注入样式元素");
  assert.match(style.textContent, /background/, "高亮应含 background 规则");
});

console.log("\n[2] 动态内容（滚动加载 / SPA 新增）");

await test("翻译完成后新增的段落会被增量翻译", async () => {
  const { window, dispatch } = await loadContent("<p>Hello one.</p>");
  await dispatch({ action: "translatePage" });

  const added = window.document.createElement("p");
  added.textContent = "Dynamically added later.";
  window.document.body.appendChild(added);

  // MutationObserver 防抖 300ms
  await new Promise(resolve => setTimeout(resolve, 700));

  assert.equal(
    added.textContent,
    "译[Dynamically added later.]",
    "新增内容应被翻译（状态守卫不能把 translator 挡在外面）"
  );
});

console.log("\n[P2-6] 长段落分片");
await test("超长单元被切成多片发送，且占位符不被切开", async () => {
  const longText = "First sentence here. ".repeat(150);
  const { sent, dispatch } = await loadContent(`<p id="p">${longText}</p>`);
  await dispatch({ action: "translatePage" });
  const batch = sent.find(m => m.action === "translateBatch");
  assert.ok(batch, "没有发出 translateBatch");
  assert.ok(batch.texts.length >= 2, `超长段落应被切分，实际 ${batch.texts.length} 条`);
  for (const piece of batch.texts) {
    assert.ok(piece.length <= 1200, `单片过长: ${piece.length}`);
  }
});

await test("分片译文按序拼回，整段内容不丢不重", async () => {
  const longText = "First sentence here. ".repeat(150);
  const { window, dispatch } = await loadContent(`<p id="p">${longText}</p>`);
  await dispatch({ action: "translatePage" });
  const text = window.document.getElementById("p").textContent;
  const count = (text.match(/First sentence here\./g) || []).length;
  assert.equal(count, 150, `片段数不对: ${count}`);
});

await test("占位符跨度长的单元切分后仍能正确还原", async () => {
  const html = "Intro sentence. ".repeat(80) + "<a href='/x'>link text here</a>" + "Tail sentence. ".repeat(80);
  const { window, dispatch } = await loadContent(`<p id="p">${html}</p>`);
  await dispatch({ action: "translatePage" });
  const p = window.document.getElementById("p");
  assert.ok(p.querySelector("a"), "<a> 在分片还原后丢失");
  assert.equal(p.querySelector("a").getAttribute("href"), "/x", "href 丢失");
});

console.log("\n[P2-8] SPA 重渲染");
await test("框架覆盖译文后重新翻译，不会把同一段翻两次", async () => {
  const { window, sent, dispatch } = await loadContent('<p id="p">Hello world.</p>');
  await dispatch({ action: "translatePage" });
  const p = window.document.getElementById("p");
  assert.equal(p.textContent, "译[Hello world.]");

  // 模拟 React 重新渲染：写回英文原文
  p.textContent = "Hello again from React.";
  await new Promise(resolve => setTimeout(resolve, 700));

  assert.equal(p.textContent, "译[Hello again from React.]", "新内容应被翻译");
  // 第二次只发一条，且发的是新文本；不应该把旧文本再发一遍
  const batches = sent.filter(m => m.action === "translateBatch");
  const lastBatch = batches[batches.length - 1];
  assert.equal(lastBatch.texts.length, 1, `只应重发 1 条，实际 ${lastBatch.texts.join("|")}`);
  assert.ok(lastBatch.texts[0].includes("React"), "重发的应是新文本");
});

await test("同一批 observer 记录里的重复根节点只采集一次", async () => {
  const { window, dispatch } = await loadContent('<div id="w"><p id="p">Hello.</p></div>');
  await dispatch({ action: "translatePage" });
  const w = window.document.getElementById("w");
  // 一次性插入多个子节点，产生多条记录
  for (let i = 0; i < 3; i++) {
    const el = window.document.createElement("p");
    el.textContent = `New paragraph ${i}.`;
    w.appendChild(el);
  }
  await new Promise(resolve => setTimeout(resolve, 700));
  const texts = Array.from(w.querySelectorAll("p"))
    .map(el => el.textContent)
    .filter(t => t.startsWith("译["));
  assert.equal(texts.length, 4, `应翻 4 段（原 1 + 新增 3），实际 ${texts.length}: ${texts.join("|")}`);
});

await test("被框架覆盖过译文再恢复，不会写回过期原文", async () => {
  const { window, dispatch } = await loadContent('<p id="p">Hello world.</p>');
  await dispatch({ action: "translatePage" });
  const p = window.document.getElementById("p");
  p.textContent = "Hello again from React.";
  await new Promise(resolve => setTimeout(resolve, 700));
  assert.equal(p.textContent, "译[Hello again from React.]");

  await dispatch({ action: "restorePage" });
  // 框架写过的新内容不能被旧单元的过期原文覆盖
  assert.equal(p.textContent, "Hello again from React.", `恢复后残留: ${p.textContent}`);
});

const failed = results.filter(result => !result.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
