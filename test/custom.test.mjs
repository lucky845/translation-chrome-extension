/**
 * 自定义接口引擎单元测试：并发、节流、权限链路的契约。
 * 全部桩掉 fetch，不依赖网络。
 *
 * 运行：node test/custom.test.mjs
 */
import assert from "node:assert/strict";
import { CustomEngine, resolveCustomConfig, CUSTOM_PRESETS } from "../background/engines/custom.js";

const results = [];

/**
 * 记录一个用例。
 * @param {string} name 名称
 * @param {Function} fn 用例（可为 async）
 * @return {Promise<void>} 完成
 */
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log("  ✅ " + name);
  } catch (error) {
    results.push({ name, ok: false });
    console.log("  ❌ " + name);
    console.log("     " + error.message);
  }
}

/**
 * 装一个统计并发与耗时的 fetch 桩。
 * @param {number} delayMs 每个请求的模拟耗时
 * @return {Object} 统计对象
 */
function stubFetch(delayMs) {
  const stats = { inFlight: 0, peak: 0, count: 0 };
  globalThis.fetch = async (url, init) => {
    stats.inFlight++;
    stats.peak = Math.max(stats.peak, stats.inFlight);
    stats.count++;
    await new Promise(resolve => setTimeout(resolve, delayMs));
    stats.inFlight--;
    return new Response(JSON.stringify({ translatedText: "T" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return stats;
}

const BASE = {
  customUrl: "https://mock.local/translate",
  customMethod: "POST",
  customHeaders: JSON.stringify({ "Content-Type": "application/json" }),
  customBody: JSON.stringify({ q: "{{textJson}}" }),
  customResponsePath: "translatedText",
};

const TEXTS = Array.from({ length: 40 }, (_, i) => "Sentence number " + i + " for the throughput test.");

console.log("\n[1] 预设并发度");

await test("各预设的并发度符合预期", async () => {
  assert.equal(resolveCustomConfig({ ...BASE, customPreset: "deeplx" }).concurrency, 4);
  assert.equal(resolveCustomConfig({ ...BASE, customPreset: "libretranslate" }).concurrency, 4);
  assert.equal(resolveCustomConfig({ ...BASE, customPreset: "openai" }).concurrency, 2);
  // generic 曾是 1：600 段串行 + 每段 120ms 节流要 74 秒，用户无法调整
  assert.equal(resolveCustomConfig({ ...BASE, customPreset: "generic" }).concurrency, 4);
});

console.log("\n[2] 并发与节流");

await test("并发 > 1 时不额外节流，吞吐不被固定 sleep 拖慢", async () => {
  const stats = stubFetch(2);
  const engine = new CustomEngine({ ...BASE, customPreset: "generic" });
  const started = Date.now();
  await engine.translate(TEXTS, "en", "zh-CN");
  const elapsed = Date.now() - started;
  assert.equal(stats.count, TEXTS.length, "每个片段都要发一次请求");
  assert.ok(stats.peak > 1, "应真正并发，实际峰值并发: " + stats.peak);
  // 40 段 × 120ms 串行节流 = 4800ms；并发后必须显著更快
  assert.ok(elapsed < 1500, "并发路径不应有固定节流拖累，实际耗时: " + elapsed + "ms");
});

await test("并发 = 1 时仍保留节流（保护公共接口）", async () => {
  const stats = stubFetch(2);
  const engine = new CustomEngine({ ...BASE, customPreset: "generic" });
  // 强制串行：模拟对限流敏感的公共实例
  engine.config = { ...resolveCustomConfig({ ...BASE, customPreset: "generic" }), concurrency: 1 };
  const texts = TEXTS.slice(0, 8);
  const started = Date.now();
  await engine.translate(texts, "en", "zh-CN");
  const elapsed = Date.now() - started;
  assert.equal(stats.peak, 1, "串行时不应出现并发请求");
  assert.ok(elapsed >= 8 * 100, "串行必须保留节流间隔，实际耗时: " + elapsed + "ms");
});

console.log("\n[3] 预设定义完整性");

await test("所有预设都有 label / method / mapLang", async () => {
  for (const [name, preset] of Object.entries(CUSTOM_PRESETS)) {
    assert.ok(preset.label, name + " 缺 label");
    assert.ok(preset.method, name + " 缺 method");
    assert.equal(typeof preset.mapLang, "function", name + " 缺 mapLang");
  }
});

const failed = results.filter(r => !r.ok).length;
console.log("\n" + "=".repeat(50));
console.log("总计 " + results.length + " 项，通过 " + (results.length - failed) + " 项，失败 " + failed + " 项");
if (failed > 0) process.exitCode = 1;
