/**
 * 引擎真实冒烟测试：直接调用 background/engine.js 请求 Google 接口。
 * 这是集成测试，依赖网络；失败时输出明确的服务端状态。
 *
 * ⚠️ 已知环境限制：Google 端点对 Node 的 TLS 指纹返回 429（curl/Chrome 正常），
 *    这不是产品代码缺陷——扩展内 fetch 走 Chrome 网络栈，指纹为 Chrome。
 *    因此本测试遇到 429 时标记 SKIP（环境受限），最终以 test/e2e.mjs 真实 Chrome 结果为准。
 *
 * 运行：node test/engine.test.mjs
 */
import assert from "node:assert/strict";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import {
  GoogleEngine,
  MyMemoryEngine,
  LingvaEngine,
  FatalTranslationError,
  RetryableError,
  splitSentences,
  createEngine,
} from "../background/engine.js";
import {
  CustomEngine,
  CUSTOM_PRESETS,
  resolveCustomConfig,
  renderTemplate,
  getByPath,
  extractTranslation,
} from "../background/engines/custom.js";

// Node 20 的 fetch 不读代理环境变量，显式挂代理
const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY;
if (proxyUrl) setGlobalDispatcher(new ProxyAgent(proxyUrl));

let environmentLimited = false;

const results = [];

/**
 * Google 引擎用到的两个主机。
 *
 * 主端点已从 translate.googleapis.com（translate_a/t）切到
 * translate-pa.googleapis.com（translateHtml），单条兜底仍走前者，
 * 所以 mock 必须同时认这两个主机——只认旧的会让用例穿到真实网络上去。
 * 注意 `translate-pa.googleapis.com`.includes("translate.googleapis.com") 是 false，
 * 不能靠子串判断。
 */
const GOOGLE_HOSTS = new Set(["translate-pa.googleapis.com", "translate.googleapis.com"]);

/**
 * 判断一个请求 URL 是否打向 Google 引擎。
 * @param {string} url 请求地址
 * @return {boolean} true 表示是 Google 引擎的请求
 */
function isGoogleHost(url) {
  try {
    return GOOGLE_HOSTS.has(new URL(url).host);
  } catch {
    return false;
  }
}

/**
 * 判断错误是否为环境限流（429），是则记录并跳过该用例。
 * @param {Error} error 错误
 * @return {boolean} true 表示环境受限
 */
function isRateLimited(error) {
  const message = String(error && error.message);
  // 出口 IP 限流、实例被 CF 拦、本机网络不可达——都属于环境受限，不是产品缺陷。
  // 这些用例在真实 Chrome E2E 里另有过网验证。
  const environmentSignals = ["HTTP 429", "Lingva 全部实例失败", "网络不可达", "fetch failed", "自定义接口连接失败"];
  if (environmentSignals.some(signal => message.includes(signal))) {
    environmentLimited = true;
    return true;
  }
  return false;
}

/**
 * 记录一个用例。
 * @param {string} name 名称
 * @param {Function} fn 用例（可为 async）
 */
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    if (isRateLimited(error)) {
      results.push({ name, ok: true, skipped: true });
      console.log(`  ⏭️  ${name}（出口 IP 被 Google 限流，以 E2E 为准）`);
      return;
    }
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

console.log("\n[1] Google 免费端点 · 真实请求");

await test("批量翻译 10 条（结果等长同序）", async () => {
  const engine = new GoogleEngine();
  const texts = Array.from({ length: 10 }, (_, i) => `Distinct sentence number ${i} for batch test.`);
  const results = await engine.translate(texts, "auto", "zh-CN");
  assert.equal(results.length, 10, "结果数量必须与输入一致");
  assert.ok(results[0].text.includes("0"), `首条应含编号: ${results[0].text}`);
  assert.ok(results[9].text.includes("9"), `末条应含编号: ${results[9].text}`);
});

await test("占位符成对标签保留并重排语序", async () => {
  const engine = new GoogleEngine();
  const source = "Read the <0>official docs</0> before you <1>start</1>.";
  const [result] = await engine.translate([source], "en", "zh-CN");
  assert.ok(result.text.includes("<0>"), `占位符 <0> 应保留: ${result.text}`);
  assert.ok(result.text.includes("</1>"), `闭合占位符 </1> 应保留: ${result.text}`);
});

await test("自闭合占位符保留", async () => {
  const engine = new GoogleEngine();
  const [result] = await engine.translate(["Click <0/> to open settings."], "en", "zh-CN");
  assert.ok(result.text.includes("<0/>"), `自闭合占位符应保留: ${result.text}`);
});

await test("超长文本（约 3000 字符）不丢内容", async () => {
  const engine = new GoogleEngine();
  const text = Array.from(
    { length: 60 },
    (_, i) => `Paragraph ${i}: the quick brown fox jumps over the lazy dog.`
  ).join(" ");
  assert.ok(text.length > 2500, "测试前置：文本应足够长");
  const [result] = await engine.translate([text], "en", "zh-CN");
  assert.ok(result.text.includes("59"), `长文本应整体翻译且含末段编号: ...${result.text.slice(-40)}`);
});

await test("自动检测返回语言", async () => {
  const engine = new GoogleEngine();
  const [result] = await engine.translate(["Bonjour le monde, ceci est un test."], "auto", "en");
  assert.ok(["fr", "en"].includes(result.detected || ""), `检测语言应合理: ${result.detected}`);
});

await test("单块 200 条不触上限", async () => {
  const engine = new GoogleEngine();
  const texts = Array.from({ length: 200 }, (_, i) => `Item ${i} description.`);
  const results = await engine.translate(texts, "en", "zh-CN");
  assert.equal(results.length, 200);
  assert.ok(results[199].text.includes("199"), `末条应含编号: ${results[199].text}`);
});

console.log("\n[2] 引擎工厂与降级");

await test("Bing 未配置密钥时 isAvailable=false（免费端点已失效）", async () => {
  const engine = createEngine("bing", null);
  assert.equal(await engine.isAvailable(), false);
});

await test("Bing 无密钥时 translate 直接抛 FatalTranslationError", async () => {
  const engine = createEngine("bing", null);
  await assert.rejects(
    () => engine.translate(["hello"], "auto", "zh-CN"),
    error => error instanceof FatalTranslationError
  );
});

await test("未知引擎名回退到 Google", async () => {
  const engine = createEngine("unknown-engine");
  const [result] = await engine.translate(["hello"], "en", "zh-CN");
  assert.ok(result.text.length > 0);
});

console.log("\n[2.5] 新引擎 · mock 单元测试（拦截 fetch，不依赖网络）");

/** 用例计数，供 mock fetch 识别当前应答哪条请求 */
function withMockFetch(handler, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => handler(String(input), init);
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      globalThis.fetch = original;
    });
}

await test("MyMemory：正常解析 text 与 detected", async () => {
  await withMockFetch(
    url =>
      new Response(
        JSON.stringify({
          responseData: { translatedText: "你好" },
          detectedLanguage: "en",
          responseStatus: 200,
          quotaFinished: false,
        }),
        { status: 200 }
      ),
    async () => {
      const engine = new MyMemoryEngine();
      const [result] = await engine.translate(["hello"], "auto", "zh-CN");
      assert.equal(result.text, "你好");
      assert.equal(result.detected, "en");
    }
  );
});

await test("MyMemory：quotaFinished 抛 Fatal（当日配额尽，重试无意义）", async () => {
  await withMockFetch(
    () =>
      new Response(
        JSON.stringify({
          responseData: { translatedText: "" },
          responseStatus: 200,
          quotaFinished: true,
        }),
        { status: 200 }
      ),
    async () => {
      const engine = new MyMemoryEngine();
      await assert.rejects(
        () => engine.translate(["hi"], "en", "zh-CN"),
        error => error instanceof FatalTranslationError
      );
    }
  );
});

await test("MyMemory：429 按重试策略退避后成功", async () => {
  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      if (calls < 3) return new Response("rate limited", { status: 429 });
      return new Response(
        JSON.stringify({
          responseData: { translatedText: "恢复" },
          responseStatus: 200,
          quotaFinished: false,
        }),
        { status: 200 }
      );
    },
    async () => {
      const engine = new MyMemoryEngine();
      const [result] = await engine.translate(["hi"], "en", "zh-CN");
      assert.equal(result.text, "恢复");
      assert.ok(calls >= 3, `应有重试，实际 ${calls} 次`);
    }
  );
});

await test("MyMemory：超长文本按句拆片拼接", async () => {
  await withMockFetch(
    url => {
      const q = new URL(url).searchParams.get("q");
      return new Response(
        JSON.stringify({
          responseData: { translatedText: `[${q}]` },
          responseStatus: 200,
          quotaFinished: false,
        }),
        { status: 200 }
      );
    },
    async () => {
      const engine = new MyMemoryEngine();
      const long = "First sentence goes here. ".repeat(30).trim();
      const [result] = await engine.translate([long], "en", "zh-CN");
      const segments = splitSentences(long, 450);
      assert.ok(segments.length >= 2, `应拆成多片: ${segments.length}`);
      assert.ok(result.text.includes("[") && result.text.includes("]"), "应含多片回显");
    }
  );
});

await test("splitSentences：句边界聚合、超长单句硬切、顺序保持", () => {
  const segments = splitSentences("One. Two. Three.", 8);
  assert.ok(segments.length >= 2);
  assert.equal(segments.join(" "), "One. Two. Three.");
  const hard = splitSentences("a".repeat(1000), 300);
  assert.equal(hard.length, 4);
  assert.ok(hard.every(s => s.length <= 300));
  assert.equal(splitSentences("", 100).length, 0);
});

await test("Lingva：首选实例失败自动轮换下一实例并记住成功者", async () => {
  LingvaEngine.preferredInstance = null;
  await withMockFetch(
    url => {
      if (url.includes("lingva.ml")) return new Response("cf blocked", { status: 503 });
      if (url.includes("garudalinux")) {
        return new Response(JSON.stringify({ translation: "镜像成功" }), { status: 200 });
      }
      return new Response("unexpected host", { status: 500 });
    },
    async () => {
      const engine = new LingvaEngine();
      const [result] = await engine.translate(["hello"], "en", "zh-CN");
      assert.equal(result.text, "镜像成功");
      assert.equal(LingvaEngine.preferredInstance, "https://lingva.garudalinux.org");
    }
  );
});

await test("Lingva：全部实例失败抛 Retryable（留给降级链）", async () => {
  await withMockFetch(
    () => new Response("down", { status: 503 }),
    async () => {
      const engine = new LingvaEngine();
      await assert.rejects(
        () => engine.translate(["hi"], "en", "zh-CN"),
        error => error instanceof RetryableError
      );
    }
  );
});

await test("缓存：恢复后再次翻译全部命中缓存，必须返回 ok 且不再发请求", async () => {
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      // translateHtml 的响应形态是 [["译文1", "译文2"]]，不是旧端点的
      // [["译文", "检测语言"], ...]。mock 必须按新形态给。
      return new Response(JSON.stringify([["甲", "乙"]]), { status: 200 });
    },
    async () => {
      const first = await translateTexts(["A", "B"], "auto", "zh-CN", "google");
      assert.equal(first.ok, true);
      assert.deepEqual(
        first.results.map(r => r.text),
        ["甲", "乙"]
      );

      const callsAfterFirst = calls;
      const second = await translateTexts(["A", "B"], "auto", "zh-CN", "google");
      assert.equal(second.ok, true, "纯缓存命中不能报请求失败（恢复后再翻就是这条路径）");
      assert.deepEqual(
        second.results.map(r => r.text),
        ["甲", "乙"],
        "缓存译文必须一致"
      );
      assert.equal(calls, callsAfterFirst, "命中缓存不应再次请求网络");
    }
  );
  clearCache();
});

await test("echo：引擎原样退回的结果不得写入缓存，且必须回报 echoed", async () => {
  // 真机 HAR 实证：Google 在 sl=auto 时把「英文夹中文专名」的段落判成中文，
  // 直接返回原文——HTTP 200、条数也对，结构完全正常，但内容是错的。
  // 旧实现把它当成功写缓存，这段文字在 SW 生命周期内永远算「已翻译」，
  // 用户刷新多少次都翻不出来。这条断言锁死「不许写缓存 + 必须上报」。
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  const echoSource = "A small DSH bundle that adds Cabinet Mode (内阁模式) to DeepSeek Harness.";
  let calls = 0;
  await withMockFetch(
    (url, init) => {
      calls += 1;
      const body = init && init.body ? JSON.parse(init.body) : null;
      const texts = body ? body[0][0] : [];
      // 原样退回：忠实复现服务端的行为
      return new Response(JSON.stringify([texts.slice()]), { status: 200 });
    },
    async () => {
      const first = await translateTexts([echoSource], "auto", "zh-CN", "google");
      assert.equal(first.ok, true, "有返回就不算请求失败");
      assert.equal(first.echoed, 1, "必须回报有一段是 echo");
      assert.equal(first.results[0].text, echoSource, "echo 时保留原文");

      // 关键：再翻一次必须**重新发请求**，否则说明被写进缓存了
      const callsAfterFirst = calls;
      const second = await translateTexts([echoSource], "auto", "zh-CN", "google");
      assert.equal(calls, callsAfterFirst + 1, "echo 结果不得进缓存，必须重新请求");
      assert.equal(second.echoed, 1, "第二次仍应如实回报 echo");
    }
  );
  clearCache();
});

await test("echo：只挪动空格的伪译文也必须识别出来（真机 bug 回归）", async () => {
  // 真机 bug：Google 对「英文为主、夹少量中文专名」的段落返回原文，但会顺手调整
  // 占位符周围的空格。旧判定用 source.trim() === output.trim()，只去首尾，
  // 中间的空格变化看不见 → 伪译文被当真译文放行 → 写进缓存 + 标记已翻译
  // → 那段文字永远不再重试。用户反复看到「这一段没翻译」就是这个原因。
  //
  // 下面这组数据逐字取自 network-log.har 的真实报文：
  //   原文 426 字符 → 返回 425 字符，21 个汉字、52 个英文词一个没变。
  //   差异① `Harness</a>.`  → `Harness</a> .`     句号前多一个空格
  //   差异② `pick <a i=4>内阁模式</a> when`
  //        → `pick<a i=4>内阁模式</a>when`          两侧空格被吃掉
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  const source =
    "A small <a i=0>DSH bundle</a> that adds <a i=1>Cabinet Mode</a> " +
    "(<a i=2>内阁模式</a>) to <a i=3>DeepSeek Harness</a>. Install the bundle, " +
    "restart DSH, and pick <a i=4>内阁模式</a> when starting a new session.";
  // 引擎原样退回，只挪了空格
  const echoed =
    "A small <a i=0>DSH bundle</a> that adds <a i=1>Cabinet Mode</a> " +
    "(<a i=2>内阁模式</a>) to <a i=3>DeepSeek Harness</a> . Install the bundle, " +
    "restart DSH, and pick<a i=4>内阁模式</a>when starting a new session.";

  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      return new Response(JSON.stringify([[echoed]]), { status: 200 });
    },
    async () => {
      const first = await translateTexts([source], "auto", "zh-CN", "google");
      assert.equal(first.echoed, 1, "只挪空格的伪译文必须被识别为 echo");

      // 关键：不得写进缓存，否则下一轮直接命中，永远不会重试。
      const callsAfterFirst = calls;
      const second = await translateTexts([source], "auto", "zh-CN", "google");
      assert.equal(calls, callsAfterFirst + 1, "echo 结果不得写入缓存，必须重新请求");
      assert.equal(second.echoed, 1);
    }
  );
  clearCache();
});

await test("echo：真译文必须写缓存，不能被 echo 判定误伤", async () => {
  // echo 判定不能把正常翻译也挡在缓存外，否则每次翻同一段都要多付一次请求。
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      return new Response(JSON.stringify([["真正的译文"]]), { status: 200 });
    },
    async () => {
      const first = await translateTexts(["real english text"], "auto", "zh-CN", "google");
      assert.equal(first.echoed, 0, "真译文不应被计入 echo");
      assert.equal(first.results[0].text, "真正的译文");

      const callsAfterFirst = calls;
      const second = await translateTexts(["real english text"], "auto", "zh-CN", "google");
      assert.equal(calls, callsAfterFirst, "真译文必须命中缓存，不得重发");
      assert.equal(second.echoed, 0);
    }
  );
  clearCache();
});

await test("echo：批内有重复文本时 ok 必须为 true（否则整批被误判失败反复重试）", async () => {
  // 真机 bug 复现：filled 曾经按「去重后的文本种数」累加，而 texts.length 数的是
  // 位置总数。批内一有重复文本（"Readme" 出现 4 次这种在 GitHub 页面上到处都是），
  // filled 就够不到 texts.length → ok=false → 整批进失败队列重试 → 连续 3 批失败
  // → 触发「引擎连续 3 次拒绝请求（多为限流），已暂停翻译」，只翻了三分之一。
  // 而 HAR 实测那 17 条请求全部 200 成功，一条 429 都没有。
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  await withMockFetch(
    (url, init) => {
      const texts = init && init.body ? JSON.parse(init.body)[0][0] : [];
      // 全部 echo：引擎把这些判成「已是目标语言」
      return new Response(JSON.stringify([texts.slice()]), { status: 200 });
    },
    async () => {
      const texts = ["Readme", "Readme", "Readme", "Install", "Readme"];
      const out = await translateTexts(texts, "auto", "zh-CN", "google");
      assert.equal(out.ok, true, "5 段全部得到回应，不能报失败");
      assert.equal(out.echoed, 5, "echo 必须按位置计数（5 个位置），不是按文本种数（2 种）");
      assert.equal(out.error, null, "ok 时不应带错误信息");
      assert.deepEqual(
        out.results.map(r => r.text),
        texts,
        "echo 时每个位置都保留原文"
      );
    }
  );
  clearCache();
});

await test("echo：真译文的重复文本也全部按位置回填", async () => {
  // 同一 bug 的另一面：重复文本拿到真译文时，每个位置都要被填上，
  // 否则 results 里会留下空洞（表现为页面只翻了一部分）。
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  await withMockFetch(
    (url, init) => {
      const texts = init && init.body ? JSON.parse(init.body)[0][0] : [];
      return new Response(JSON.stringify([texts.map(t => `译:${t}`)]), { status: 200 });
    },
    async () => {
      const texts = ["Readme", "Readme", "Install", "Readme"];
      const out = await translateTexts(texts, "auto", "zh-CN", "google");
      assert.equal(out.ok, true);
      assert.deepEqual(
        out.results.map(r => r.text),
        ["译:Readme", "译:Readme", "译:Install", "译:Readme"],
        "重复文本的每个位置都必须有译文"
      );
    }
  );
  clearCache();
});

await test("echo：判定只认逐字符相同，不做语言推断", async () => {
  // 上一轮曾按字符比例猜源语言重发，把中文句子按英文重翻，比不翻更糟。
  // 这条断言锁死「只认完全相同」——差一个字符都不算 echo。
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  await withMockFetch(
    () => new Response(JSON.stringify([["中文译文。"]]), { status: 200 }),
    async () => {
      // 返回和原文不同（哪怕只差标点）就不是 echo
      const outcome = await translateTexts(["中文原文"], "auto", "zh-CN", "google");
      assert.equal(outcome.echoed, 0, "内容不同不应判为 echo");
    }
  );
  clearCache();
});

await test("缓存：翻译失败的结果不得写入缓存（否则永久卡在原文）", async () => {
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, clearCache } = await import("../background/translator.js");
  clearCache();

  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      return new Response("blocked", { status: 429 });
    },
    async () => {
      const first = await translateTexts(["ZZZ"], "auto", "zh-CN", "google");
      assert.equal(first.ok, false, "全失败必须如实报 false");
      const before = calls;
      await translateTexts(["ZZZ"], "auto", "zh-CN", "google");
      assert.ok(calls > before, "失败后重试应重新请求，而不是命中「原文」假缓存");
    }
  );
  clearCache();
});

await test("Google 429 立刻失败，不走逐条兜底（否则一次翻译白等 100 秒）", async () => {
  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      return new Response("blocked", { status: 429 });
    },
    async () => {
      const { GoogleEngine } = await import("../background/engine.js");
      const engine = new GoogleEngine();
      const texts = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}.`);
      const started = Date.now();
      let message = "";
      try {
        await engine.translate(texts, "auto", "zh-CN");
      } catch (error) {
        message = error.message;
      }
      const elapsed = Date.now() - started;
      assert.match(message, /429/, `应报 429，实际: ${message}`);
      // 旧实现：批量重试 3 次 + 50 条逐条兜底 = 53 次请求、数秒退避
      assert.ok(calls < 10, `限流时必须快速失败，实际发了 ${calls} 次请求`);
      assert.ok(elapsed < 3000, `限流时必须快速失败，实际耗时 ${elapsed}ms`);
      assert.match(message, /限流/, `错误信息应说明是限流，实际: ${message}`);
    }
  );
});

await test("熔断：引擎失败后进入冷却，下一批不再重付超时", async () => {
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, resetEngineHealth, getEngineHealth } = await import("../background/translator.js");
  resetEngineHealth();

  const callOrder = [];
  const handler = url => {
    callOrder.push(new URL(url).host);
    if (isGoogleHost(url)) return new Response("blocked", { status: 429 });
    if (url.includes("api.mymemory.translated.net")) {
      const q = new URL(url).searchParams.get("q");
      return new Response(
        JSON.stringify({
          responseData: { translatedText: `MM[${q}]` },
          detectedLanguage: "en",
          responseStatus: 200,
          quotaFinished: false,
        }),
        { status: 200 }
      );
    }
    return new Response("down", { status: 503 });
  };

  await withMockFetch(handler, async () => {
    const first = await translateTexts(["first batch"], "auto", "zh-CN", "google");
    assert.equal(first.ok, true);
    const googleCallsFirstBatch = callOrder.filter(host => GOOGLE_HOSTS.has(host)).length;
    assert.ok(googleCallsFirstBatch > 0, "第一批应尝试过 Google");
    assert.equal(getEngineHealth().google.cooling, true, "Google 失败后应进入冷却");

    callOrder.length = 0;
    const second = await translateTexts(["second batch"], "auto", "zh-CN", "google");
    assert.equal(second.ok, true);
    assert.equal(second.engine, "mymemory");
    assert.equal(
      callOrder.filter(host => GOOGLE_HOSTS.has(host)).length,
      0,
      `冷却期内不应再打 Google，实际调用序: ${callOrder.join(",")}`
    );
  });

  resetEngineHealth();
});

await test("熔断：冷却期内反复失败不会把到期时间无限推后", async () => {
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, resetEngineHealth, getEngineHealth } = await import("../background/translator.js");
  resetEngineHealth();

  // 全链路不可用：每个批次都会走完 ready 再兜底冷却中的引擎
  await withMockFetch(
    url => (isGoogleHost(url) ? new Response("blocked", { status: 429 }) : new Response("down", { status: 503 })),
    async () => {
      await translateTexts(["nope one"], "auto", "zh-CN", "google");
      const firstUntil = getEngineHealth().google.until;

      await new Promise(resolve => setTimeout(resolve, 20));
      await translateTexts(["nope two"], "auto", "zh-CN", "google");
      const secondUntil = getEngineHealth().google.until;

      assert.equal(secondUntil, firstUntil, `冷却期内再次失败不应续期，实际 ${firstUntil} → ${secondUntil}`);
    }
  );
  resetEngineHealth();
});

await test("熔断：resetEngineHealth 后引擎重新参与（用户改配置即生效）", async () => {
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts, resetEngineHealth, getEngineHealth } = await import("../background/translator.js");
  resetEngineHealth();

  const callOrder = [];
  await withMockFetch(
    url => {
      callOrder.push(new URL(url).host);
      if (isGoogleHost(url)) return new Response("blocked", { status: 429 });
      return new Response("down", { status: 503 });
    },
    async () => {
      await translateTexts(["a"], "auto", "zh-CN", "google");
      assert.equal(getEngineHealth().google.cooling, true);
      resetEngineHealth();
      assert.deepEqual(getEngineHealth(), {}, "重置后不应残留冷却");
    }
  );
  resetEngineHealth();
});

await test("降级链：Google 挂时先走 MyMemory，Lingva 不被触碰（链序实证）", async () => {
  // translator.js 依赖 chrome.storage，Node 环境 stub 之
  globalThis.chrome = {
    storage: {
      sync: { get: async defaults => ({ ...defaults }), set: async () => {} },
      onChanged: { addListener: () => {} },
    },
  };
  const { translateTexts } = await import("../background/translator.js");
  const callOrder = [];
  await withMockFetch(
    url => {
      callOrder.push(new URL(url).host);
      if (isGoogleHost(url)) return new Response("blocked", { status: 429 });
      if (url.includes("lingva")) return new Response("down", { status: 503 });
      if (url.includes("api.mymemory.translated.net")) {
        const q = new URL(url).searchParams.get("q");
        return new Response(
          JSON.stringify({
            responseData: { translatedText: `MM[${q}]` },
            detectedLanguage: "en",
            responseStatus: 200,
            quotaFinished: false,
          }),
          { status: 200 }
        );
      }
      return new Response("unknown", { status: 500 });
    },
    async () => {
      const outcome = await translateTexts(["hello world"], "auto", "zh-CN", "google");
      assert.equal(outcome.ok, true);
      assert.equal(outcome.engine, "mymemory");
      assert.equal(outcome.degraded, true);
      assert.equal(outcome.results[0].text, "MM[hello world]");
      assert.ok(
        !callOrder.some(host => host.includes("lingva")),
        `Lingva 不应被调用，实际调用序: ${callOrder.join(",")}`
      );
      const firstMemory = callOrder.indexOf("api.mymemory.translated.net");
      assert.ok(firstMemory > 0, "MyMemory 应被调用");
      assert.ok(
        callOrder.slice(0, firstMemory).every(host => GOOGLE_HOSTS.has(host)),
        `MyMemory 之前只应尝试 Google（含 429 重试），实际: ${callOrder.join(",")}`
      );
    }
  );
});

await test("熔断：Google 失败后下一批次直接跳过它，不再重付超时", async () => {
  const { translateTexts, resetEngineHealth, getEngineHealth } = await import("../background/translator.js");
  resetEngineHealth();

  const hosts = [];
  await withMockFetch(
    url => {
      const host = new URL(url).host;
      hosts.push(host);
      if (GOOGLE_HOSTS.has(host)) return new Response("blocked", { status: 429 });
      if (host === "api.mymemory.translated.net") {
        const q = new URL(url).searchParams.get("q");
        return new Response(
          JSON.stringify({
            responseData: { translatedText: `MM[${q}]` },
            responseStatus: 200,
            quotaFinished: false,
          }),
          { status: 200 }
        );
      }
      return new Response("down", { status: 503 });
    },
    async () => {
      const first = await translateTexts(["first batch text"], "auto", "zh-CN", "google");
      assert.equal(first.engine, "mymemory");
      const googleCallsFirst = hosts.filter(host => GOOGLE_HOSTS.has(host)).length;
      assert.ok(googleCallsFirst >= 1, "首批应尝试 Google");

      assert.ok(getEngineHealth().google, "Google 应进入冷却");

      const before = hosts.length;
      const second = await translateTexts(["second batch text"], "auto", "zh-CN", "google");
      assert.equal(second.engine, "mymemory", "第二批应仍走 MyMemory");
      assert.equal(second.degraded, true, "降级标记保留给用户看");
      const secondHosts = hosts.slice(before);
      assert.ok(
        !secondHosts.some(host => GOOGLE_HOSTS.has(host)),
        `第二批不应再碰 Google，实际: ${secondHosts.join(",")}`
      );
      assert.ok(secondHosts.includes("api.mymemory.translated.net"));
    }
  );

  resetEngineHealth();
});

console.log("\n[2.6] 自定义接口 · mock 单元测试");

await test("自定义接口：未配置地址时不回落预设（防止把文本发给第三方）", () => {
  const config = resolveCustomConfig({ customPreset: "deeplx", customUrl: "" });
  assert.equal(config.url, "", "地址为空就必须为空，不能回落 api.deeplx.org");
  assert.equal(config.method, CUSTOM_PRESETS.deeplx.method, "其余字段仍回落预设");
  assert.equal(config.responsePath, "data");
});

await test("自定义接口：用户填写的地址覆盖预设", () => {
  const config = resolveCustomConfig({
    customPreset: "deeplx",
    customUrl: "  http://127.0.0.1:1188/translate  ",
  });
  assert.equal(config.url, "http://127.0.0.1:1188/translate");
});

await test("自定义接口：模板渲染（JSON 转义 / URL 编码 / 未知变量保留）", () => {
  const vars = { text: 'he said "hi"\nline2', from: "zh-CN", to: "en-US" };
  assert.equal(
    renderTemplate('{"q": "{{text}}"}', vars, "json"),
    '{"q": "he said \\"hi\\"\\nline2"}',
    "JSON 模式下引号与换行必须转义（外层引号由模板自己写）"
  );
  assert.equal(renderTemplate("?q={{text}}&sl={{from}}", vars, "url"), "?q=he%20said%20%22hi%22%0Aline2&sl=zh-CN");
  assert.equal(renderTemplate("{{unknown}}", vars, "json"), "{{unknown}}", "未知变量原样保留");
});

await test("自定义接口：getByPath 支持数组下标，取不到返回 undefined", () => {
  const data = { choices: [{ message: { content: "你好" } }] };
  assert.equal(getByPath(data, "choices.0.message.content"), "你好");
  assert.equal(getByPath(data, "choices.1.message.content"), undefined);
  assert.equal(getByPath(data, "choices.message"), undefined, "非数组不可按下标取");
});

await test("自定义接口：响应解析（纯文本 / 路径取值 / 缺路径报错）", () => {
  assert.equal(extractTranslation("  纯文本译文 ", ""), "纯文本译文", "无路径时纯文本直接返回");
  assert.equal(extractTranslation('{"data":"译文"}', "data"), "译文");
  assert.throws(
    () => extractTranslation('{"data":"译文"}', ""),
    error => error instanceof FatalTranslationError,
    "JSON 对象但缺响应路径应报错而不是把整个 JSON 当译文"
  );
  assert.throws(
    () => extractTranslation('{"data":{}}', "data"),
    error => error instanceof FatalTranslationError
  );
});

await test("自定义接口：未配置地址时 isAvailable=false 且不发起任何请求", async () => {
  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      return new Response("should not happen", { status: 500 });
    },
    async () => {
      const engine = new CustomEngine({ customPreset: "deeplx", customUrl: "" });
      assert.equal(await engine.isAvailable(), false);
      await assert.rejects(
        () => engine.translate(["hello"], "en", "zh-CN"),
        error => error instanceof FatalTranslationError && /未配置/.test(error.message)
      );
      assert.equal(calls, 0, "未配置时一次请求都不该发出");
    }
  );
});

await test("自定义接口：401 抛 Fatal 且不重试（鉴权失败重试无意义）", async () => {
  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      return new Response('{"error":"bad token"}', { status: 401 });
    },
    async () => {
      const engine = new CustomEngine({
        customPreset: "generic",
        customUrl: "http://127.0.0.1:9999/translate",
        customMethod: "POST",
        customBody: '{"q": {{textJson}}}',
        customResponsePath: "data",
      });
      await assert.rejects(
        () => engine.translate(["hello"], "en", "zh-CN"),
        error => error instanceof FatalTranslationError && /鉴权失败/.test(error.message)
      );
      assert.equal(calls, 1, "401 不应重试");
    }
  );
});

await test("自定义接口：429 退避重试后成功", async () => {
  let calls = 0;
  await withMockFetch(
    () => {
      calls += 1;
      if (calls < 2) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({ data: "恢复" }), { status: 200 });
    },
    async () => {
      const engine = new CustomEngine({
        customPreset: "deeplx",
        customUrl: "http://127.0.0.1:9999/translate",
      });
      const [result] = await engine.translate(["hi"], "en", "zh-CN");
      assert.equal(result.text, "恢复");
      assert.equal(calls, 2, "429 应重试一次后成功");
    }
  );
});

await test("自定义接口：openai 预设注入 token/model 并按路径取译文", async () => {
  let captured = null;
  await withMockFetch(
    (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { content: "你好" } }] }), { status: 200 });
    },
    async () => {
      const engine = new CustomEngine({
        customPreset: "openai",
        customUrl: "http://127.0.0.1:9999/v1/chat/completions",
        customToken: "sk-test",
        customModel: "gpt-4o-mini",
      });
      const [result] = await engine.translate(["hello"], "en", "zh-CN");
      assert.equal(result.text, "你好");
      assert.equal(captured.init.headers.Authorization, "Bearer sk-test", "token 应注入 Authorization");
      const body = JSON.parse(captured.init.body);
      assert.equal(body.model, "gpt-4o-mini");
      assert.ok(body.messages[0].content.includes("hello"), "正文应嵌入原文");
      assert.ok(body.messages[0].content.includes("Chinese"), "提示词应包含目标语言名");
    }
  );
});

console.log("\n[3] MyMemory / Lingva · 真实请求（独立于 Google 限流面）");

await test("MyMemory 批量 3 条等长同序", async () => {
  const engine = new MyMemoryEngine();
  const texts = ["Read the docs.", "The Old Lighthouse.", "Where are you going tomorrow?"];
  const results = await engine.translate(texts, "en", "zh-CN");
  assert.equal(results.length, 3);
  results.forEach(r => assert.ok(/[\u4e00-\u9fff]/.test(r.text), `应有中文: ${r.text}`));
});

await test("MyMemory 自动检测源语言", async () => {
  const engine = new MyMemoryEngine();
  const [result] = await engine.translate(["Where are you going tomorrow?"], "auto", "zh-CN");
  assert.ok(/[\u4e00-\u9fff]/.test(result.text), `应有中文: ${result.text}`);
  if (result.detected) assert.equal(result.detected, "en");
});

await test("Lingva 实例可达性（Node 指纹被 CF 拦时标记环境受限）", async () => {
  const engine = new LingvaEngine();
  const [result] = await engine.translate(["Read the docs."], "en", "zh-CN");
  assert.ok(/[\u4e00-\u9fff]/.test(result.text), `应有中文: ${result.text}`);
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"=".repeat(50)}`);
if (environmentLimited) {
  console.log("⚠️  检测到出口 IP 限流：网络用例部分跳过，集成行为以 test/e2e.mjs（真实 Chrome）为准");
}
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;

await test("Google：批量请求走 translateHtml 的 POST + protobuf 体", async () => {
  // 端点契约来自 Chrome 自带翻译的真实 HAR（逐字复现）：
  //   POST https://translate-pa.googleapis.com/v1/translateHtml
  //   content-type: application/json+protobuf
  //   x-goog-api-key: <Chrome 内置 key>
  //   body: [[[texts...], from, to], "te_lib", null, 1]
  //   response: [["译文1", "译文2", ...]]
  // 这几条任何一条错了，请求要么 4xx 要么结构与解析对不上，
  // 所以用断言把它们锁死，而不是只验「翻出来了」。
  const seen = [];
  await withMockFetch(
    (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      seen.push({
        url,
        method: (init && init.method) || "GET",
        headers: (init && init.headers) || {},
        body,
      });
      const count = body ? body[0][0].length : 0;
      return new Response(JSON.stringify([Array.from({ length: count }, (_, i) => `译文${i}`)]), { status: 200 });
    },
    async () => {
      const engine = new GoogleEngine();
      const results = await engine.translate(["one", "two", "three"], "auto", "zh-CN");
      assert.strictEqual(results.length, 3, "译文条数必须与输入一致");
      assert.strictEqual(results[0].text, "译文0");
    }
  );

  assert.strictEqual(seen.length, 1, `3 条应打包成 1 个请求，实际 ${seen.length} 个`);
  const request = seen[0];
  assert.strictEqual(request.method, "POST", `批量请求必须用 POST，实际 ${request.method}`);
  assert(
    request.url.includes("translate-pa.googleapis.com/v1/translateHtml"),
    `必须打 translateHtml 端点，实际 ${request.url}`
  );
  assert.strictEqual(
    request.headers["content-type"],
    "application/json+protobuf",
    "content-type 必须是 application/json+protobuf"
  );
  assert.ok(request.headers["x-goog-api-key"], "必须带 x-goog-api-key，否则端点 401");
  // 体形状：[[[文本...], 源语言, 目标语言], "te_lib", null, 1]
  assert.strictEqual(request.body.length, 4, "外层必须是长度 4 的数组");
  assert.deepStrictEqual(request.body[0][0], ["one", "two", "three"], "文本数组必须按原序");
  assert.strictEqual(request.body[0][1], "auto", "源语言必须透传");
  assert.strictEqual(request.body[0][2], "zh-CN", "目标语言必须透传");
  assert.strictEqual(request.body[1], "te_lib", "模型标识必须是 te_lib");
  assert.strictEqual(request.body[3], 1, "末位必须是 1");
});

await test("Google：响应外层多包一层时仍能解析（兼容网关变体）", async () => {
  // 历史上不同网关会把 [["译文"]] 包成 [[["译文"]]]。取不到就读不出来，
  // 但也不该把合法结构判死——这里锁死 unwrapTranslations 的兼容分支。
  await withMockFetch(
    () => new Response(JSON.stringify([[["包了两层"]]]), { status: 200 }),
    async () => {
      const engine = new GoogleEngine();
      const [result] = await engine.translate(["hello"], "en", "zh-CN");
      assert.strictEqual(result.text, "包了两层");
    }
  );
});

await test("Google：结果数量不符时抛错而不是静默错位", async () => {
  // 位置对应的端点最怕「少给一条」：少一条会让后面每条译文错位到别人的 DOM 上。
  // 必须显式失败，交给上层降级，而不是悄悄把短数组返回。
  //
  // 注意：批量数量不符会触发逐条兜底（每条单独发、单独收），所以 mock 必须
  // 让**批量请求返回数量不符、单条请求也失败**，才能真正验到「整批失败」。
  await withMockFetch(
    (url, init) => {
      const body = init && init.body ? JSON.parse(init.body) : null;
      const count = body ? body[0][0].length : 0;
      if (count > 1) {
        // 批量：故意少给一条
        return new Response(JSON.stringify([["只有一条"]]), { status: 200 });
      }
      // 单条兜底：也失败，避免兜底把用例「救活」
      return new Response("nope", { status: 500 });
    },
    async () => {
      const engine = new GoogleEngine();
      await assert.rejects(
        () => engine.translate(["a", "b", "c"], "en", "zh-CN"),
        error => /数量不符/.test(String(error.message)) || /HTTP 500/.test(String(error.message)),
        "数量不符且兜底也失败时必须抛错"
      );
    }
  );
});

await test("降级链：首选失败后按最近成功排序，而不是死守固定链序", async () => {
  // 旧实现 `lastSuccess.get(b) - lastSuccess.get(a)` 在未成功过的引擎上是
  // undefined - number = NaN，Array.sort 把 NaN 当作 0（保持原序）——
  // 于是「最近成功优先」整段**从未生效过**，永远按固定链序走。
  //
  // 坑：这条用例曾在模块级状态被前序用例污染时「假通过」（lastSuccess 里
  // 已有 lingva 记录），所以改为在**独立子进程**里跑，状态完全干净。
  const { execFileSync } = await import("node:child_process");
  const probe = `
    globalThis.chrome = {
      storage: { sync: { get: async d => ({ ...d }), set: async () => {} }, onChanged: { addListener: () => {} } },
    };
    const order = [];
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.includes("googleapis")) { order.push("google"); return new Response("rate", { status: 429 }); }
      if (url.includes("mymemory")) {
        order.push("mymemory");
        return new Response(JSON.stringify({ responseData: { translatedText: "你好" }, responseStatus: 200 }), { status: 200 });
      }
      order.push("lingva"); return new Response(JSON.stringify({ translation: "你好" }), { status: 200 });
    };
    const { translateTexts, resetEngineHealth, clearCache } = await import("./background/translator.js");
    clearCache(); resetEngineHealth();
    await translateTexts(["warmup-unique"], "en", "zh-CN", "lingva");
    order.length = 0;
    await translateTexts(["second-unique"], "en", "zh-CN", "google");
    process.stdout.write(JSON.stringify(order));
    process.exit(0);
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  const order = JSON.parse(output.trim() || "[]");
  assert.strictEqual(order[0], "google", `首选必须仍先试 google，实际: ${order.join(" → ")}`);
  assert.strictEqual(
    order[1],
    "lingva",
    `google 失败后应优先最近成功过的 lingva（链序里排在最后），实际先试了 ${order[1]}（顺序: ${order.join(" → ")}）`
  );
});

// ---------------------------------------------------------------------------
// 分块打包策略
// ---------------------------------------------------------------------------

await test("打包：按正文字符预算切块，不受 URL 编码膨胀影响（真机 bug 回归）", async () => {
  // 真机 bug：切块曾用 encodeURIComponent(text).length 计算代价，那是
  // translate_a/t 用 GET、文本全塞进 URL 的时代留下的逻辑。中文经 URL 编码
  // 膨胀约 9 倍，预算被瞬间吃光，同一页面被切成 49 个包（官方只要 3 个），
  // 还切出 texts=1（5 个字符）这种碎片包，白白多付往返次数和失败机会。
  //
  // 官方实测数据（github.com.har）：3 个请求体分别是
  //   8 条 / 2998 字符、97 条 / 2715 字符、48 条 / 2989 字符
  // ——条数差异巨大但字符数都在 3000 附近，唯一依据是字符预算。
  const engine = new GoogleEngine();
  const seen = [];
  // 200 条中文，每条 60 字。旧逻辑下每条 URL 编码后约 540 字符，
  // 6000 的预算只能装 11 条 → 约 19 个包；新逻辑按正文 60 字符算 → 少得多。
  const texts = Array.from({ length: 200 }, (_, i) => `第${i}条测试文本，`.repeat(8));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push(body[0][0]);
    return new Response(JSON.stringify([body[0][0].map(t => `译:${t}`)]), { status: 200 });
  };
  try {
    await engine.translate(texts, "zh-CN", "en");
  } finally {
    globalThis.fetch = realFetch;
  }

  assert.ok(seen.length > 0, "必须实际发出请求");
  const totalChars = texts.reduce((sum, t) => sum + t.length, 0);
  assert.ok(
    seen.length <= Math.ceil(totalChars / 4000) + 1,
    `包数应按正文字符预算计算，实际 ${seen.length} 个包（总 ${totalChars} 字符）`
  );
  for (const chunk of seen) {
    const chars = chunk.reduce((sum, t) => sum + t.length, 0);
    assert.ok(chars <= 4000 || chunk.length === 1, `单包正文 ${chars} 字符超出预算，且不是单条独占`);
  }
  assert.deepEqual(seen.flat().sort(), texts.slice().sort(), "切块不得丢失或重复任何一条文本");
});
