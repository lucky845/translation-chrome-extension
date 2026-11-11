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

await test("SPA 路由切换后旧单元被回收，不会越积越多", async () => {
  const { window, dispatch } = await loadContent('<div id="app"><p>Home page text.</p></div>');
  await dispatch({ action: "translatePage" });
  const app = window.document.getElementById("app");
  assert.equal(app.textContent, "译[Home page text.]");
  const firstCount = (await dispatch({ action: "getStatus" })).count;

  // React Router / Vue Router：同一容器整体替换内容，旧元素被销毁
  app.innerHTML = "<p>About page text.</p>";
  await new Promise(resolve => setTimeout(resolve, 700));

  const state = await dispatch({ action: "getStatus" });
  assert.equal(state.detached, 0, `回收后不应残留游离单元，实际 ${state.detached}`);
  assert.equal(app.textContent, "译[About page text.]", "新路由内容应被翻译");
  assert.equal(state.count, firstCount, `单元总数应保持（1 段换 1 段），实际 ${state.count}`);
});

await test("路由切到没有文字的页面时，旧单元照样被回收", async () => {
  const { window, dispatch } = await loadContent('<div id="app"><p>Home page text.</p></div>');
  await dispatch({ action: "translatePage" });
  const app = window.document.getElementById("app");

  // 切成纯图片页：没有新文本，roots 为空，但旧单元必须一样被清掉
  app.innerHTML = '<img src="/hero.png" alt="">';
  await new Promise(resolve => setTimeout(resolve, 700));

  const state = await dispatch({ action: "getStatus" });
  assert.equal(state.detached, 0, `无文本页面也应回收游离单元，实际 ${state.detached}`);
  assert.equal(state.count, 0, `旧单元应全部回收，实际剩 ${state.count}`);
});

console.log("\n[滚动翻译] 视口裁剪与开关");

/**
 * 构造一个有布局信息的页面：每段固定 stepPx 高，视口 viewportPx。
 * jsdom 不做布局，必须自己伪造 getBoundingClientRect，否则永远采不到可见性。
 * @param {Object} env loadContent 返回值
 * @param {number} count 段落数
 * @param {number} stepPx 每段高度
 * @param {number} viewportPx 视口高度
 */
function fakeLayout(env, count, stepPx, viewportPx) {
  const { window } = env;
  const paras = Array.from(window.document.querySelectorAll("p"));
  const tops = new Map(paras.map((p, i) => [p, i * stepPx]));
  Object.defineProperty(window, "innerHeight", { value: viewportPx, configurable: true });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = tops.has(this) ? tops.get(this) : 0;
    return { top, bottom: top + stepPx, left: 0, right: 800, width: 800, height: stepPx };
  };
  return paras;
}

await test("滚动翻译开启时，远端段落先不送翻", async () => {
  const paras = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} content.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "on" } });
  fakeLayout(env, 60, 100, 900);

  const promise = env.dispatch({ action: "translatePage" });
  // 首轮请求应当在视口附近就收手，不该一口气把 60 段全发出去
  await new Promise(resolve => setTimeout(resolve, 120));
  const sentTexts = env.sent.filter(message => message.action === "translateBatch").flatMap(message => message.texts);
  assert.ok(sentTexts.length > 0, "首屏内容应先被翻译");
  assert.ok(sentTexts.length < 60, `远端内容不该立刻全发，实际发了 ${sentTexts.length}/60`);

  // 等空闲兜底把剩下的补完，不能卡死
  const result = await promise;
  assert.equal(result.success, true);
  assert.equal(result.count, 60, `停手后应补完整页，实际 ${result.count}`);
});

await test("滚动翻译关闭时，一次性翻完整页", async () => {
  const paras = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} content.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "off" } });
  fakeLayout(env, 60, 100, 900);
  const result = await env.dispatch({ action: "translatePage" });
  assert.equal(result.count, 60);
});

await test("滚动翻译不会卡死：远端段落最终都能翻到", async () => {
  const paras = Array.from({ length: 200 }, (_, i) => `<p>Paragraph ${i} content.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "on" } });
  fakeLayout(env, 200, 100, 900);
  const result = await env.dispatch({ action: "translatePage" });
  assert.equal(result.success, true, `不应失败: ${result.error || ""}`);
  assert.equal(result.count, 200, `200 段应全部翻完，实际 ${result.count}`);
});

await test("用户持续滚动时，翻译状态必须能收尾（不能一直卡在 translating）", async () => {
  // 用户报告的真实现象：GitHub 长页面翻译完，右下角一直显示「翻译中…172/172」，
  // 「显示原文」点不动。根因是持续滚动让 idleFor() 永远被重置，
  // 远端单元挂在 deferred 里，循环永远等不到空闲。
  const paras = Array.from({ length: 172 }, (_, i) => `<p>Paragraph ${i} content.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "on" } });
  fakeLayout(env, 172, 30, 900);

  // 模拟 sticky 头 / 懒加载图片：滚动事件不停
  const scroller = setInterval(() => env.window.dispatchEvent(new env.window.Event("scroll")), 100);
  let result;
  try {
    result = await Promise.race([
      env.dispatch({ action: "translatePage" }),
      new Promise(resolve => setTimeout(() => resolve({ success: false, error: "超时：状态卡在 translating" }), 6000)),
    ]);
  } finally {
    clearInterval(scroller);
  }

  assert.equal(result.success, true, `持续滚动下也必须收尾，实际: ${result.error || ""}`);
  assert.equal(result.count, 172, `应全部翻完，实际 ${result.count}`);
  const status = await env.dispatch({ action: "getStatus" });
  assert.equal(status.state, "translated", `状态必须是 translated，实际 ${status.state}`);
});

await test("滚动到远端后，那里的内容插到队首先翻", async () => {
  const paras = Array.from({ length: 300 }, (_, i) => `<p id="p${i}">Paragraph ${i} content.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "on" } });
  const { window } = env;
  const paras2 = Array.from(window.document.querySelectorAll("p"));
  const tops = new Map(paras2.map((p, i) => [p, i * 100]));
  let scrollY = 0;
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = (tops.has(this) ? tops.get(this) : 0) - scrollY;
    return { top, bottom: top + 100, left: 0, right: 800, width: 800, height: 100 };
  };

  const promise = env.dispatch({ action: "translatePage" });
  await new Promise(resolve => setTimeout(resolve, 150));
  // 用户滚到第 200 段附近
  scrollY = 20000;
  window.dispatchEvent(new window.Event("scroll"));

  const result = await promise;
  assert.equal(result.count, 300, `应翻完 300 段，实际 ${result.count}`);
  const batches = env.sent.filter(message => message.action === "translateBatch");
  const late = batches.slice(1).flatMap(batch => batch.texts);
  const deep = late.filter(text => /Paragraph (1[89]\d|2\d\d) /.test(text));
  assert.ok(deep.length > 0, `滚动到远端后应补翻那里的内容，实际补翻 ${late.length} 条且没有远端段落`);
});

await test("引擎失败时，失败的批次必须重试而不是静默丢弃", async () => {
  const paras = Array.from({ length: 250 }, (_, i) => `<p id="p${i}">Paragraph ${i} text.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "off" } });

  // 前 2 次请求全挂（模拟免费引擎 429），之后恢复
  let calls = 0;
  const original = env.window.chrome.runtime.sendMessage;
  const attempted = [];
  env.window.chrome.runtime.sendMessage = (message, callback) => {
    if (message.action === "translateBatch") {
      calls++;
      attempted.push(message.texts);
      if (calls <= 2) {
        callback({ ok: false, error: "所有引擎失败：HTTP 429" });
        return undefined;
      }
    }
    return original(message, callback);
  };

  const result = await env.dispatch({ action: "translatePage" });
  // 前两批失败，之后重新发出去：失败批次的文字必须重新出现在后来的请求里
  assert.equal(calls, attempted.length, "每次请求都应被记录");
  const failedTexts = attempted[0].concat(attempted[1]);
  const later = new Set(attempted.slice(2).flatMap(texts => texts));
  const resent = failedTexts.filter(text => later.has(text));
  assert.ok(
    resent.length > 0,
    `失败批次的文字应被重发，实际重发 ${resent.length}/${failedTexts.length} 条；共 ${calls} 次请求`
  );
  assert.equal(result.failed || 0, 0, `重试成功后不应报失败，实际 ${result.failed}`);
  assert.equal(result.success, true);
});

await test("重试后仍有失败时，不能冒充「全部翻译完成」", async () => {
  const paras = Array.from({ length: 250 }, (_, i) => `<p id="p${i}">Paragraph ${i} text.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "off" } });

  let calls = 0;
  const original = env.window.chrome.runtime.sendMessage;
  env.window.chrome.runtime.sendMessage = (message, callback) => {
    if (message.action === "translateBatch") {
      calls++;
      if (calls > 1) {
        callback({ ok: false, error: "所有引擎失败：HTTP 429" });
        return undefined;
      }
    }
    return original(message, callback);
  };

  const result = await env.dispatch({ action: "translatePage" });
  assert.equal(result.success, true, "部分成功仍应算成功（有内容被翻译）");
  assert.ok(result.failed > 0, `有段落翻不了必须如实上报，实际 failed=${result.failed}`);
  assert.match(result.error || "", /未翻译/, `应提示有多少段没翻成，实际: ${result.error}`);
});

await test("引擎连续拒绝时立刻收工，不让用户白等", async () => {
  const paras = Array.from({ length: 600 }, (_, i) => `<p id="p${i}">Paragraph ${i} text.</p>`).join("");
  const env = await loadContent(paras, { settings: { lazyTranslate: "off" } });

  // 一直失败：模拟被限流
  env.window.chrome.runtime.sendMessage = (message, callback) => {
    if (message.action === "translateBatch") {
      callback({ ok: false, error: "所有引擎失败：HTTP 429" });
      return undefined;
    }
    if (message.action === "getSettings") {
      callback({
        ok: true,
        settings: { targetLanguage: "zh-CN", engine: "google", useOffline: "off", lazyTranslate: "off" },
      });
      return undefined;
    }
    callback({ ok: true });
    return undefined;
  };

  const started = Date.now();
  const result = await env.dispatch({ action: "translatePage" });
  const elapsed = Date.now() - started;

  // 600 段 / 每批 120 = 5 批；连输 3 批就该停，不该把 5 批全打完再重试
  assert.ok(elapsed < 20000, `连续失败时应尽早收工，实际耗时 ${elapsed}ms`);
  assert.ok(result.failed > 0, `必须如实上报失败段数，实际 ${result.failed}`);
  assert.match(result.error || "", /连续/, `错误信息应说明是连续失败，实际: ${result.error}`);
});

const failed = results.filter(result => !result.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
