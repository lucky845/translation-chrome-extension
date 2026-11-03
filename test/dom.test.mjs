/**
 * DOM 逻辑单元测试：验证占位符编解码、结构还原、无损回滚。
 * 用 jsdom 提供真实 DOM 语义，不 mock。
 *
 * 运行：node test/dom.test.mjs
 */
import { JSDOM } from "jsdom";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);

/**
 * 在给定的 jsdom 实例中加载 dom-core，返回其导出的 API。
 * dom-core 是传统脚本，通过 globalThis 挂载。
 * @param {string} html 初始 HTML
 * @return {{api: Object, dom: JSDOM, win: Object}} 加载结果
 */
function load(html) {
  const dom = new JSDOM(html, { url: "https://example.com" });
  const win = dom.window;
  const global = { document: win.document, Node: win.Node };
  const script = require("fs").readFileSync(new URL("../content/dom-core.js", import.meta.url), "utf8");
  // 用 Function 构造在 jsdom 上下文中执行，使 document 解析到该 window
  const factory = new Function("globalThis", "document", "Node", "module", script);
  factory(global, win.document, win.Node, { exports: undefined });
  return { api: global.__TP_DOM__, dom, win };
}

const results = [];
/**
 * 记录一个测试用例结果。
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

console.log("\n[1] 占位符解析");
test("解析成对占位符", () => {
  const { api } = load("<div></div>");
  const pieces = api.parsePlaceholders("在<1>开始</1>之前阅读<0>官方文档</0>。");
  assert.equal(pieces.filter(p => p.type === "open").length, 2);
  assert.equal(pieces.filter(p => p.type === "close").length, 2);
});

test("解析自闭合占位符", () => {
  const { api } = load("<div></div>");
  const pieces = api.parsePlaceholders("请参阅下图表<0/>了解数据。");
  assert.equal(pieces.filter(p => p.type === "void").length, 1);
});

test("占位符不平衡时返回 null（拒绝生成错乱 DOM）", () => {
  const { api } = load("<div></div>");
  assert.equal(api.parsePlaceholders("在<1>开始之前"), null, "缺闭合应返回 null");
  assert.equal(api.parsePlaceholders("多余的</2>闭合"), null, "多余闭合应返回 null");
  assert.equal(api.parsePlaceholders("交叉嵌套<0><1></0></1>"), null, "交叉嵌套应返回 null");
});

console.log("\n[2] 翻译单元采集");
test("整段含内联标签编码为单一单元（不拆碎句子）", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/docs">official docs</a> before you <b>start</b>.</p></body></html>`
  );
  const units = api.collectUnits(win.document.body);
  assert.equal(units.length, 1, `应只有 1 个单元，实际 ${units.length}`);
  assert.match(units[0].text, /<0>official docs<\/0>/);
  assert.match(units[0].text, /<1>start<\/1>/);
});

test("无文本内联元素编码为自闭合占位符", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Click <img src="a.png"> to continue.</p></body></html>`);
  const units = api.collectUnits(win.document.body);
  assert.equal(units.length, 1);
  assert.match(units[0].text, /<0\/>/);
});

test("脚本/样式/表单控件被跳过", () => {
  const { api, win } = load(
    `<html lang="en"><body>
      <script>var x = "do not translate";</script>
      <style>.a{}</style>
      <textarea>do not translate</textarea>
      <p>Translate this sentence.</p>
    </body></html>`
  );
  const units = api.collectUnits(win.document.body);
  const texts = units.map(u => u.text).join(" ");
  assert.ok(!texts.includes("do not translate"), `不应包含跳过区文本: ${texts}`);
  assert.ok(texts.includes("Translate this sentence"));
});

test("容器直属文本与块级子元素分别成单元", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="d">Intro text here<p>Nested paragraph text.</p></div></body></html>`
  );
  const units = api.collectUnits(win.document.body);
  assert.equal(units.length, 2, `应有 2 个单元，实际 ${units.length}: ${units.map(u => u.text).join(" | ")}`);
  const shallow = units.find(u => u.shallow);
  assert.ok(shallow, "应存在浅层单元");
  assert.match(shallow.text, /Intro text here/);
  assert.ok(!shallow.text.includes("Nested paragraph"), "浅层单元不该吞掉块级后代文本");
});

console.log("\n[3] 译文应用与结构保留");
test("内联标签在译文语序中被保留", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/docs" class="link">official docs</a> before you <b>start</b>.</p></body></html>`
  );
  const units = api.collectUnits(win.document.body);
  const ok = units[0].apply("在<1>开始</1>之前阅读<0>官方文档</0>。");
  assert.equal(ok, true, "apply 应成功");
  const p = win.document.getElementById("p");
  assert.equal(p.textContent, "在开始之前阅读官方文档。");
  const a = p.querySelector("a");
  assert.ok(a, "<a> 应被保留");
  assert.equal(a.getAttribute("href"), "/docs", "属性必须保留");
  assert.equal(a.getAttribute("class"), "link", "class 必须保留");
  assert.equal(a.textContent, "官方文档", "文本应位于 a 内");
  const b = p.querySelector("b");
  assert.ok(b, "<b> 应被保留");
  assert.equal(b.textContent, "开始");
});

test("自闭合占位符保留 void 元素", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Click <img src="a.png" alt="icon"> to continue.</p></body></html>`
  );
  const units = api.collectUnits(win.document.body);
  assert.equal(units[0].apply("单击<0/>继续。"), true);
  const img = win.document.getElementById("p").querySelector("img");
  assert.ok(img, "img 应被保留");
  assert.equal(img.getAttribute("src"), "a.png");
});

test("译文占位符被破坏时拒绝应用（保留原文）", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Read the <a>docs</a> now.</p></body></html>`);
  const units = api.collectUnits(win.document.body);
  const before = win.document.getElementById("p").innerHTML;
  assert.equal(units[0].apply("阅读<a>文档</a>现在。"), false, "真实标签形式应被拒绝，避免注入");
  assert.equal(win.document.getElementById("p").innerHTML, before, "DOM 不应被改动");
});

console.log("\n[4] 无损恢复");
test("深层单元恢复为原始 HTML", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/docs">official docs</a> before you <b>start</b>.</p></body></html>`
  );
  const original = win.document.body.innerHTML;
  const units = api.collectUnits(win.document.body);
  units[0].apply("在<1>开始</1>之前阅读<0>官方文档</0>。");
  const restored = units[0].restore();
  assert.equal(restored, true);
  assert.equal(win.document.body.innerHTML, original, "必须逐字节还原");
});

test("浅层单元恢复不销毁块级子元素", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="d">Intro text here<p>Nested paragraph text.</p></div></body></html>`
  );
  const original = win.document.body.innerHTML;
  const units = api.collectUnits(win.document.body);
  const shallow = units.find(u => u.shallow);
  const nested = units.find(u => !u.shallow);
  shallow.apply("这里是介绍文字。");
  nested.apply("嵌套段落文本。");
  // 逆序恢复（先子后父）
  nested.restore();
  shallow.restore();
  assert.equal(win.document.body.innerHTML, original, "浅层+深层混合恢复必须无损");
});

test("重复 apply 不叠加翻译", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Hello world.</p></body></html>`);
  const units = api.collectUnits(win.document.body);
  units[0].apply("你好世界。");
  const afterFirst = win.document.getElementById("p").textContent;
  units[0].apply("你好世界。");
  assert.equal(win.document.getElementById("p").textContent, afterFirst, "重复 apply 不应产生重复文本");
});

console.log("\n[5] 语言判断");
test("已中文页面不再翻成中文", () => {
  const { api } = load(`<html lang="zh-CN"><body><p>这是中文页面</p></body></html>`);
  assert.equal(api.isPageAlreadyTarget("zh-CN"), true);
  assert.equal(api.containsHanText("这是中文"), true);
});

test("英文页面判断为目标语言不成立", () => {
  const { api } = load(`<html lang="en"><body></body></html>`);
  assert.equal(api.isPageAlreadyTarget("zh-CN"), false);
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
