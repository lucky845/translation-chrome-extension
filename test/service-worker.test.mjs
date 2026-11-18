/**
 * Service worker 单元测试：模块导入合法性、消息路由契约、设置变更清理。
 * SW 依赖完整的 chrome.* 运行时，无法直接 import，因此这里验证：
 *   1) 它依赖的模块在无 chrome 环境下仍可导入（构建即崩的防线）
 *   2) 各端发出的 action 都能在 SW 路由表里找到处理函数（静默失效的防线）
 *   3) 设置变更清理逻辑确实接在 storage.onChanged 上
 *
 * 运行：node test/service-worker.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
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

console.log("\n[1] 模块导入与静态完整性");

await test("settings.js 可在无 chrome 环境导入且导出齐全", async () => {
  const settings = await import("../background/settings.js");
  assert.ok(settings.DEFAULT_SETTINGS, "应导出 DEFAULT_SETTINGS");
  assert.equal(typeof settings.getSettings, "function");
  assert.equal(typeof settings.updateSettings, "function");
  assert.equal(typeof settings.DEFAULT_SETTINGS.blacklist, "string", "blacklist 应为字符串");
});

await test("engine.js 导出引擎类与工厂（无 chrome 依赖）", async () => {
  const engine = await import("../background/engine.js");
  const names = [
    "GoogleEngine",
    "BingEngine",
    "MyMemoryEngine",
    "LingvaEngine",
    "createEngine",
    "FatalTranslationError",
  ];
  for (const name of names) assert.ok(engine[name], "应导出 " + name);
});

await test("translator.js 导出编排接口（无 chrome 依赖）", async () => {
  const translator = await import("../background/translator.js");
  for (const name of ["translateTexts", "clearCache", "resetEngineHealth", "getEngineHealth"]) {
    assert.equal(typeof translator[name], "function", "应导出函数 " + name);
  }
});

console.log("\n[2] 消息路由契约");

await test("各端发出的 action 都能在 SW 路由表中找到处理函数", async () => {
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  const handlersAt = sw.indexOf("const handlers = {");
  assert.ok(handlersAt > -1, "SW 应定义 handlers 路由表");
  const handlerBlock = sw.slice(handlersAt);
  // 路由表里的 handler 名 = 可接受的 action 名
  const swActions = new Set([...handlerBlock.matchAll(/^ {2}async (\w+)\(/gm)].map(m => m[1]));
  assert.ok(swActions.has("translateBatch"), "translateBatch 必须有 handler");
  assert.ok(swActions.has("translateText"), "translateText 必须有 handler");
  assert.ok(swActions.has("getSettings"), "getSettings 必须有 handler");

  // 只发给标签页（content script）的 action，不需要 SW handler
  const tabOnly = new Set(["translatePage", "restorePage", "getStatus", "translateSelection"]);
  const missing = [];
  for (const file of ["content/content.js", "popup/popup.js", "options/options.js"]) {
    const raw = readFileSync(join(root, file), "utf8");
    const actions = [...raw.matchAll(/action:\s*"(\w+)"/g)].map(m => m[1]);
    for (const action of new Set(actions)) {
      if (!tabOnly.has(action) && !swActions.has(action)) missing.push(file + " → " + action);
    }
  }
  assert.deepEqual(missing, [], "存在发往 SW 但 SW 无 handler 的 action: " + missing.join(", "));
});

await test("已删除的死代码不会回流", async () => {
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  const handlersAt = sw.indexOf("const handlers = {");
  const swActions = new Set([...sw.slice(handlersAt).matchAll(/^ {2}async (\w+)\(/gm)].map(m => m[1]));
  assert.ok(!swActions.has("setSettings"), "setSettings 全仓无调用方，不该回流");
  const content = readFileSync(join(root, "content/content.js"), "utf8");
  assert.ok(!content.includes('"settingsUpdated"'), "settingsUpdated 死分支不该回流");
});

console.log("\n[3] 设置变更清理（storage.onChanged）");

await test("SW 在 storage.onChanged 上清理译文缓存与引擎熔断", async () => {
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  assert.ok(sw.includes("storage.onChanged"), "SW 应监听 storage.onChanged");
  assert.ok(sw.includes("clearCache()"), "变更应清译文缓存");
  assert.ok(sw.includes("resetEngineHealth()"), "变更应清引擎熔断");
});

await test("content script 在 storage.onChanged 上失效设置缓存", async () => {
  const content = readFileSync(join(root, "content/content.js"), "utf8");
  assert.ok(content.includes("storage.onChanged"), "content 应监听 storage.onChanged");
  assert.ok(content.includes("invalidateSettings"), "变更应失效设置缓存");
});

const failed = results.filter(r => !r.ok).length;
console.log("\n" + "=".repeat(50));
console.log("总计 " + results.length + " 项，通过 " + (results.length - failed) + " 项，失败 " + failed + " 项");
if (failed > 0) process.exitCode = 1;
