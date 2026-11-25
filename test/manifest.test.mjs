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

test("JS 中引用的 i18n key 均已定义", () => {
  // 两种写法都要查：直接 chrome.i18n.getMessage("k")，和经 shared/i18n.js 的 I18N.t("k")。
  // 只查前一种会漏掉全部运行时文案——那是本扩展用户看到的主要部分。
  const files = [
    "popup/popup.js",
    "options/options.js",
    "background/service-worker.js",
    "background/translator.js",
    "content/content.js",
    "content/offline-translator.js",
  ];
  const patterns = [/i18n\.getMessage\(\s*"([\w]+)"/g, /I18N\.(?:t|raw)\(\s*"([\w]+)"/g];
  for (const file of files) {
    const raw = readFileSync(join(root, file), "utf8");
    for (const pattern of patterns) {
      for (const match of raw.matchAll(pattern)) {
        assert.ok(zhMessages[match[1]], `${file} 引用了未定义的 key: ${match[1]}`);
      }
    }
  }
});

test("HTML 里出现的中文都挂在 data-i18n 上", () => {
  // 词条进来得比脚本早，元素里留中文当作加载前的兜底是可以的；
  // 但如果这个元素没有 data-i18n，切到英文界面后它永远是中文。
  const pages = ["popup/popup.html", "options/options.html"];
  for (const page of pages) {
    const raw = readFileSync(join(root, page), "utf8");
    const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const body = withoutComments.slice(withoutComments.indexOf("<body"));
    const offending = [];
    // 匹配「<tag ...>纯文本</tag>」，看该标签是否带 data-i18n / data-i18n-placeholder
    for (const match of body.matchAll(/<([a-z][\w-]*)([^>]*)>([^<]*[\u4e00-\u9fff][^<]*)</g)) {
      const [, tag, attrs] = match;
      if (/data-i18n(?:-placeholder)?="/.test(attrs)) continue;
      offending.push(`<${tag}> ${match[3].trim()}`);
    }
    assert.deepEqual(offending, [], `${page} 的中文没有挂 data-i18n: ${offending.join(" | ")}`);
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

console.log("\n[3.5] API 版本地板");
test("minimum_chrome_version 覆盖代码用到的全部新 API", () => {
  // AbortSignal.timeout（engine.js 的 fetch 超时）是 Chrome 103 新增；
  // 版本地板低于 103 时，Chrome 102 上每个 fetch 调用点直接 TypeError，翻译全灭。
  const floor = Number(manifest.minimum_chrome_version);
  assert.ok(floor >= 103, `minimum_chrome_version 必须 >= 103（AbortSignal.timeout），实际: ${floor}`);
  const raw = readFileSync(join(root, "background/engine.js"), "utf8");
  if (raw.includes("AbortSignal.timeout")) {
    assert.ok(floor >= 103, "engine.js 使用 AbortSignal.timeout 时地板不得低于 103");
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
