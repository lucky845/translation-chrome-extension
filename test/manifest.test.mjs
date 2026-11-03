/**
 * 扩展静态完整性校验：manifest 引用、i18n key、JSON 合法性。
 * 这些错误在 Chrome 加载时才暴露，提前在 CI/本地拦截。
 *
 * 运行：node test/manifest.test.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

/**
 * 记录一个用例。
 * @param {string} name 名称
 * @param {Function} fn 用例
 */
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

console.log("\n[1] manifest 引用完整性");
test("content_scripts 文件全部存在", () => {
  for (const script of manifest.content_scripts) {
    for (const file of script.js) {
      assert.ok(existsSync(join(root, file)), `缺失: ${file}`);
    }
  }
});

test("service worker 存在", () => {
  assert.ok(existsSync(join(root, manifest.background.service_worker)));
});

test("popup 与 options 页面存在", () => {
  assert.ok(existsSync(join(root, manifest.action.default_popup)));
  assert.ok(existsSync(join(root, manifest.options_ui.page)));
});

test("图标文件全部存在", () => {
  for (const file of Object.values(manifest.icons)) {
    assert.ok(existsSync(join(root, file)), `缺失: ${file}`);
  }
  for (const file of Object.values(manifest.action.default_icon)) {
    assert.ok(existsSync(join(root, file)), `缺失: ${file}`);
  }
});

console.log("\n[2] 本地化完整性");
const defaultLocale = manifest.default_locale;
const zhMessages = JSON.parse(readFileSync(join(root, "_locales", defaultLocale, "messages.json"), "utf8"));

test("manifest 中 __MSG_xxx__ 的 key 均已定义", () => {
  const raw = readFileSync(join(root, "manifest.json"), "utf8");
  const keys = [...raw.matchAll(/__MSG_([\w]+)__/g)].map(m => m[1]);
  for (const key of keys) {
    assert.ok(zhMessages[key], `default_locale 缺少 key: ${key}`);
  }
});

test("zh_CN 与 en 的 key 集合一致", () => {
  const en = JSON.parse(readFileSync(join(root, "_locales/en/messages.json"), "utf8"));
  const zhKeys = Object.keys(zhMessages).sort();
  const enKeys = Object.keys(en).sort();
  assert.deepEqual(zhKeys, enKeys, "两个 locale 的 key 必须一致");
});

test("HTML 中 data-i18n 的 key 均已定义", () => {
  const pages = ["popup/popup.html", "options/options.html"];
  for (const page of pages) {
    const raw = readFileSync(join(root, page), "utf8");
    const keys = [...raw.matchAll(/data-i18n(?:-placeholder)?="([\w]+)"/g)].map(m => m[1]);
    for (const key of keys) {
      assert.ok(zhMessages[key], `${page} 引用了未定义的 key: ${key}`);
    }
  }
});

test("JS 中 chrome.i18n.getMessage 的 key 均已定义", () => {
  const files = ["popup/popup.js", "options/options.js", "background/service-worker.js", "content/content.js"];
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf8");
    const keys = [...raw.matchAll(/i18n\.getMessage\("([\w]+)"\)/g)].map(m => m[1]);
    for (const key of keys) {
      assert.ok(zhMessages[key], `${file} 引用了未定义的 key: ${key}`);
    }
  }
});

console.log("\n[3] content script 禁用 ESM");
test("content scripts 不含 import/export 语句", () => {
  for (const script of manifest.content_scripts) {
    for (const file of script.js) {
      const raw = readFileSync(join(root, file), "utf8");
      assert.ok(!/^\s*import\s+/m.test(raw), `${file} 含 import 语句，content script 会 SyntaxError`);
      assert.ok(!/^\s*export\s+/m.test(raw), `${file} 含 export 语句，content script 会 SyntaxError`);
    }
  }
});

console.log("\n[4] 权限最小化");
test("未申请未使用的权限", () => {
  const permissions = manifest.permissions || [];
  const hostPermissions = manifest.host_permissions || [];
  assert.ok(!permissions.includes("webRequest"), "webRequest 权限未被代码使用");
  assert.ok(!permissions.includes("tabs"), "tabs 权限未被使用（tabs.sendMessage 无需它）");
  assert.ok(!permissions.includes("<all_urls>"), "<all_urls> 过宽");
  assert.ok(!hostPermissions.includes("<all_urls>"), "host <all_urls> 过宽");
  // 翻译域名必须显式列出
  assert.ok(hostPermissions.includes("https://translate.googleapis.com/*"));
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
