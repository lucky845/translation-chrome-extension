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

console.log("\n[2.4] 包装层穿透（避免同一段文字被翻两遍）");

test("无直属文本且只有单个子元素的包装层被穿透", () => {
  const { api, win } = load(
    `<html lang="en"><body>
      <div class="a"><div class="b"><div class="c"><p>Real paragraph text.</p></div></div></div>
    </body></html>`
  );
  const units = api.collectUnits(win.document.body);
  assert.equal(units.length, 1, `包装层不应各自成单元，实际 ${units.length} 个`);
  assert.equal(units[0].text.trim(), "Real paragraph text.");
  assert.equal(units[0].element.tagName.toLowerCase(), "p", "单元应落在真正的文本宿主上");
});

test("包装层合并后同一段文字只送翻一次", () => {
  const { api, win } = load(
    `<html lang="en"><body><div><div><section><p>Translate me once.</p></section></div></div></body></html>`
  );
  const units = api.collectUnits(win.document.body);
  const texts = units.map(u => u.text.trim());
  assert.deepEqual(texts, ["Translate me once."], `同一段文字不应重复送翻，实际: ${JSON.stringify(texts)}`);
});

test("有直属文本的容器不被穿透（否则会丢文本）", () => {
  const { api, win } = load(`<html lang="en"><body><div>Intro text.<div><p>Nested para.</p></div></div></body></html>`);
  const units = api.collectUnits(win.document.body);
  const all = units.map(u => u.text).join(" | ");
  assert.ok(all.includes("Intro text"), "容器直属文本必须保留");
  assert.ok(all.includes("Nested para"), "子段落必须保留");
});

test("多个子元素时不穿透（不是纯包装壳）", () => {
  const { api, win } = load(`<html lang="en"><body><div><p>First para.</p><p>Second para.</p></div></body></html>`);
  const units = api.collectUnits(win.document.body);
  assert.equal(units.length, 2, "两个子段落应各自成单元");
});

console.log("\n[2.5] Web Component 包裹的正文必须下钻");

test("带短横线的自定义标签若有子元素，按块级继续下钻（GitHub react-partial）", () => {
  const { api, win } = load(
    `<html lang="en"><body>
      <react-partial><div><p>Content inside a web component must be found.</p></div></react-partial>
    </body></html>`
  );
  const units = api.collectUnits(win.document.body);
  const texts = units.map(u => u.text).join(" | ");
  assert.ok(texts.includes("Content inside a web component"), `自定义元素内的正文被漏掉了，实际采集: ${texts}`);
});

test("无子元素的自定义标签仍按内联处理（自闭合占位）", () => {
  const { api, win } = load(`<html lang="en"><body><p>Before <x-icon></x-icon> after.</p></body></html>`);
  const units = api.collectUnits(win.document.body);
  assert.equal(units.length, 1);
  assert.match(units[0].text, /<0\/>/, "空自定义标签应变成自闭合占位符");
});

test("turbo-frame / 嵌套自定义元素都能被穿透", () => {
  const { api, win } = load(
    `<html lang="en"><body>
      <turbo-frame id="f"><react-partial><div>Nested web component text.</div></react-partial></turbo-frame>
    </body></html>`
  );
  const units = api.collectUnits(win.document.body);
  assert.ok(
    units.some(u => u.text.includes("Nested web component text")),
    "嵌套自定义元素内的文本应被采集"
  );
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

console.log("\n[3.5] 占位符被破坏时的降级路径");

test("占位符丢失：降级为文本节点级翻译，标签与属性全部保留", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/d" class="lnk">docs</a> before <b>start</b>.</p></body></html>`
  );
  const unit = api.collectUnits(win.document.body)[0];

  // 引擎吞掉占位符
  const broken = "阅读文档在开始之前。";
  assert.equal(unit.apply(broken), false, "占位符缺失时严格还原必须拒绝");

  // Read the / docs / before / start —— 4 个有意义的文本节点
  const nodes = unit.meaningfulTextNodes();
  assert.equal(nodes.length, 4, `应有 4 个文本节点，实际 ${nodes.length}`);
  assert.equal(unit.applyWholeText("阅读文档在开始"), true, "整段降级应成功");

  const p = win.document.getElementById("p");
  assert.equal(p.textContent.replace(/\s+/g, " ").trim(), "阅读文档在开始.", "文字应被替换（末尾句号来自原文本节点）");

  // 关键：结构必须完好
  const a = p.querySelector("a");
  assert.ok(a, "<a> 必须保留（之前用 textContent 会把它抹掉）");
  assert.equal(a.getAttribute("href"), "/d", "href 必须保留");
  assert.equal(a.getAttribute("class"), "lnk", "class 必须保留，否则样式崩");
  assert.ok(p.querySelector("b"), "<b> 必须保留");
});

test("整段译文只写一次：多文本节点段落不重复", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/d">docs</a> before <b>start</b>.</p></body></html>`
  );
  const unit = api.collectUnits(win.document.body)[0];
  const nodes = unit.meaningfulTextNodes();
  assert.ok(nodes.length >= 3, `本用例需要多个文本节点，实际 ${nodes.length}`);

  const translated = "阅读文档后再开始。";
  assert.equal(unit.applyWholeText(translated), true);

  const p = win.document.getElementById("p");
  const text = p.textContent.replace(/\s+/g, "");
  const occurrences = text.split("阅读").length - 1;
  assert.equal(occurrences, 1, `整段译文只能出现一次，实际出现 ${occurrences} 次（重复写入了每个文本节点）`);
  assert.ok(p.querySelector("a"), "链接必须保留");
  assert.equal(p.querySelector("a").getAttribute("href"), "/d");
  assert.ok(p.querySelector("b"), "加粗必须保留");
});

test("计数器数字不重复：纯数字节点保留、译文不含该数字", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="d"><span>Security and quality</span><span class="counter">9</span></div></body></html>`
  );
  const unit = api.collectUnits(win.document.body)[0];

  // 送翻的文本不含独立计数器数字（数字由节点自己保留）
  assert.equal(unit.plainText, "Security and quality", `送翻文本不应含 9，实际: ${unit.plainText}`);

  // 引擎只翻送进去的内容，自然不带 9
  assert.equal(unit.applyWholeText("安全与质量"), true);

  const text = win.document.getElementById("d").textContent.replace(/\s+/g, "").trim();
  assert.equal(text, "安全与质量9", `9 应只出现一次，实际: ${text}`);
  assert.equal((text.match(/9/g) || []).length, 1, "9 不能重复（截图里的 9(9) 就是这里出的问题）");
  assert.ok(win.document.querySelector("#d .counter"), "计数器节点必须保留");
});

test("段落内数字保留：22 Branches 的 22 不能丢", () => {
  const { api, win } = load(`<html lang="en"><body><div id="d">22 Branches <span>3</span> Tags</div></body></html>`);
  const unit = api.collectUnits(win.document.body)[0];

  // 段落文本里的 22 属于文字内容，应参与翻译
  assert.equal(unit.plainText, "22 Branches Tags", `实际: ${unit.plainText}`);

  assert.equal(unit.applyWholeText("22 个分支  个标签"), true);
  const text = win.document.getElementById("d").textContent.replace(/\s+/g, "").trim();
  assert.equal((text.match(/22/g) || []).length, 1, `22 应且只应出现一次，实际: ${text}`);
  assert.equal((text.match(/3/g) || []).length, 1, `3 应且只应出现一次，实际: ${text}`);
});

test("文本节点级降级后仍可无损恢复", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Read the <a href="/d">docs</a> now.</p></body></html>`);
  const original = win.document.body.innerHTML;
  const unit = api.collectUnits(win.document.body)[0];

  unit.applyWholeText("阅读文档现在");
  assert.ok(win.document.querySelector("a"), "降级后仍有链接");
  assert.equal(unit.restore(), true);
  assert.equal(win.document.body.innerHTML, original, "结构必须逐字节还原");
});

test("空白压缩：缩进换行不进入待翻译串", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="d">\n    Hello   world  \n   <span>again</span>\n</div></body></html>`
  );
  const unit = api.collectUnits(win.document.body)[0];
  assert.ok(!/\n/.test(unit.text), `不应含换行: ${JSON.stringify(unit.text)}`);
  assert.ok(!/ {2,}/.test(unit.text), `不应含连续空格: ${JSON.stringify(unit.text)}`);
  assert.match(unit.text, /Hello world/);
});

test("plainText 剥离全部占位符", () => {
  const { api, win } = load(
    `<html lang="en"><body><p>Go <a href="#">here</a> and <img src="x.png"> then <b>run</b>.</p></body></html>`
  );
  const unit = api.collectUnits(win.document.body)[0];
  assert.ok(unit.plainText.includes("Go here and"), `实际: ${unit.plainText}`);
  assert.ok(!/\d+/.test(unit.plainText) || !/<\d/.test(unit.plainText), "plainText 不应残留占位符标记");
  assert.ok(!/<\d+\/>|<\/?\d+>/.test(unit.plainText), `实际: ${unit.plainText}`);
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

console.log("\n[4.5] brace {{n}} 双占位符模式（自定义引擎用）");

test("brace 采集：inline 元素序列化为 {{2k}}/{{2k+1}}，内层文字参与翻译", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/d">docs</a> before <b>start</b>.</p></body></html>`
  );
  const unit = api.collectUnits(win.document.body, "brace")[0];
  assert.ok(unit.braceMap && unit.braceMap.size === 2, "应有 2 个 brace 占位符");
  assert.match(unit.text, /Read the \{\{0\}\}docs\{\{1\}\} before \{\{2\}\}start\{\{3\}\}\./, `实际: ${unit.text}`);
  assert.ok(!/<\d+>/.test(unit.text), "brace 模式不应产出 <n> 标签");
});

test("brace 还原：语序重排后原元素按新位置插回，结构完好", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Read the <a href="/d" class="lnk">docs</a> before <b>start</b>.</p></body></html>`
  );
  const unit = api.collectUnits(win.document.body, "brace")[0];

  // 模拟引擎：{{n}} 原样保留、内层文字已翻（Google 实测行为）
  const simple = "阅读{{0}}文档{{1}}在{{2}}开始{{3}}之前。";
  assert.equal(unit.applyBrace(simple), true, "applyBrace 应成功");

  const p = win.document.getElementById("p");
  assert.equal(p.textContent, "阅读文档在开始之前。", `实际: ${p.textContent}`);
  const a = p.querySelector("a");
  assert.ok(a, "链接元素被移动而非克隆，必须存在");
  assert.equal(a.getAttribute("href"), "/d", "href 保留");
  assert.equal(a.getAttribute("class"), "lnk", "class 保留");
});

test("brace 校验：token 丢失或错配时拒绝应用（回落整段降级）", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Read the <a href="/d">docs</a> now.</p></body></html>`);
  const unit = api.collectUnits(win.document.body, "brace")[0];

  // open 没了 close：应拒绝
  assert.equal(unit.applyBrace("阅读{{0}}文档。"), false, "缺 close token 必须拒绝");
  // 未知编号：应拒绝
  assert.equal(unit.applyBrace("阅读{{0}}文档{{1}}{{9}}。"), false, "未知 token 必须拒绝");
  // 应用失败后 DOM 未被破坏
  assert.ok(win.document.querySelector("#p a"), "拒绝时不应改动 DOM");
});

test("brace void：自闭合元素只发 open token", () => {
  const { api, win } = load(
    `<html lang="en"><body><p id="p">Score <img src="x.png" alt="star"> of ten.</p></body></html>`
  );
  const unit = api.collectUnits(win.document.body, "brace")[0];
  assert.match(unit.text, /Score \{\{0\}\} of ten\./, `实际: ${unit.text}`);
  assert.equal(unit.applyBrace("十分制得分{{0}}。"), true);
  const img = win.document.querySelector("#p img");
  assert.ok(img, "img 元素必须被插回");
  assert.equal(img.getAttribute("src"), "x.png");
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

console.log("\n[6] 代码审查回归（P0/P1 修复锁死）");
test("P0-1 容器有直属文本+块级子元素时建浅层单元，内层译文不被抹掉", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="outer">Intro text.<div id="inner">Inner block.</div></div></body></html>`
  );
  const units = api.collectUnits(win.document.getElementById("outer"));
  assert.equal(units.length, 2, `应有两个单元，实际 ${units.length}`);
  assert.equal(units[0].shallow, true, "外层必须是 shallow");
  units[0].applyWholeText("引言文字。");
  units[1].applyWholeText("内部块。");
  const html = win.document.getElementById("outer").innerHTML;
  assert.ok(html.includes("引言文字"), `外层译文丢失: ${html}`);
  assert.ok(html.includes("内部块"), `内层译文被外层 replaceChildren 抹掉: ${html}`);
});

test("P0-2 整段降级不把译文塞进 <a>，链接文字不被清空后还原", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Read the <a href="/d">docs</a> here.</p></body></html>`);
  const original = win.document.body.innerHTML;
  const unit = api.collectUnits(win.document.getElementById("p"))[0];
  assert.equal(unit.applyWholeText("阅读文档"), true);
  const link = win.document.querySelector("a");
  assert.equal(link.textContent.trim(), "", "链接内不应残留旧文字");
  assert.ok(!link.textContent.includes("阅读文档"), "译文不能钻进链接内部");
  unit.restore();
  assert.equal(win.document.body.innerHTML, original, "还原后链接文字必须回来");
});

test("P0-4 原文尖括号转义，往返不丢内容", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Use <code>Array&lt;T&gt;</code> tags.</p></body></html>`);
  const unit = api.collectUnits(win.document.getElementById("p"))[0];
  assert.ok(unit.text.includes("&lt;T&gt;"), `尖括号必须转义，实际: ${unit.text}`);
  assert.equal(unit.apply(unit.text), true);
  assert.equal(win.document.getElementById("p").innerHTML, `Use <code>Array&lt;T&gt;</code> tags.`, "往返必须无损");
});

test("P0-5 restore 不回滚页面在翻译期间的新内容", () => {
  const { api, win } = load(`<html lang="en"><body><p id="p">Original v1.</p></body></html>`);
  const unit = api.collectUnits(win.document.getElementById("p"))[0];
  unit.apply("原始版本一。");
  // 模拟框架更新
  win.document.getElementById("p").textContent = "Original v2 from framework.";
  unit.restore();
  assert.equal(win.document.getElementById("p").innerHTML, "Original v2 from framework.", "不能回滚成 v1");
});

test("P1-1 display:block 的 strong 是独立块，不与正文合并", () => {
  const { api, win } = load(
    `<html lang="en"><body><p><strong style="display:block">A big claim</strong> and more.</p></body></html>`
  );
  const units = api.collectUnits(win.document.body);
  const texts = units.map(u => u.text).join("|");
  assert.ok(!texts.includes("<0>A big claim</0>"), `块级 strong 不该变占位符，实际: ${texts}`);
  assert.ok(
    units.some(u => u.text === "A big claim"),
    `应有独立单元，实际: ${texts}`
  );
});

test("P1-6 ruby 注音不进正文", () => {
  const { api, win } = load(
    `<html lang="ja"><body><p id="p">漢字<ruby>東京<rt>Tōkyō</rt></ruby>です</p></body></html>`
  );
  const unit = api.collectUnits(win.document.getElementById("p"))[0];
  assert.ok(!unit.text.includes("Tōkyō"), `<rt> 注音必须丢弃，实际: ${unit.text}`);
  assert.ok(unit.text.includes("東京"), "正文保留");
});

console.log("\n[7] 属性文本翻译");
test("采集 title/alt/aria-label/placeholder 四类属性", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="d">` +
      `<a href="/x" title="Open settings panel">link here</a>` +
      `<button aria-label="Close dialog">x</button>` +
      `<input placeholder="Search docs">` +
      `<img alt="Settings gear" src="g.png">` +
      `</div></body></html>`
  );
  const entries = api.collectAttributeTexts(win.document.getElementById("d"), "zh-CN");
  const got = entries.map(e => e.attr).sort();
  assert.deepEqual(got, ["alt", "aria-label", "placeholder", "title"], `实际: ${got}`);
});

test("属性翻译：应用后还原逐字节一致", () => {
  const { api, win } = load(
    `<html lang="en"><body><div id="d">` +
      `<a href="/x" title="Open settings panel">link here</a>` +
      `<img alt="Settings gear" src="g.png">` +
      `</div></body></html>`
  );
  const original = win.document.getElementById("d").innerHTML;
  const entries = api.collectAttributeTexts(win.document.getElementById("d"), "zh-CN");
  const saved = [];
  const map = new Map(entries.map(e => [e.text, "译:" + e.text]));
  assert.equal(api.applyAttributeTexts(entries, map, saved), 2);

  const link = win.document.querySelector("a");
  assert.equal(link.getAttribute("title"), "译:Open settings panel", "title 未更新");
  assert.equal(win.document.querySelector("img").getAttribute("alt"), "译:Settings gear", "alt 未更新");

  api.restoreAttributeTexts(saved);
  assert.equal(win.document.getElementById("d").innerHTML, original, "还原必须逐字节一致");
});

test("属性已是目标语言时不采集（中文 title 不再翻）", () => {
  const { api, win } = load(`<html lang="zh-CN"><body><a href="/x" title="打开设置面板">设置</a></body></html>`);
  const entries = api.collectAttributeTexts(win.document.body, "zh-CN");
  assert.equal(entries.length, 0, `中文属性不该被采集，实际: ${entries.map(e => e.text)}`);
});

test("属性扫描不被 SKIP_TAGS 拦住（placeholder/aria-label 要能翻）", () => {
  const { api, win } = load(
    `<html lang="en"><body><input placeholder="Search docs"><button aria-label="Close dialog">x</button></body></html>`
  );
  const entries = api.collectAttributeTexts(win.document.body, "zh-CN");
  assert.equal(entries.length, 2, `input/button 属性必须能采到，实际: ${entries.length}`);
});

console.log("\n[8] 语言判定（P2-5 日语误判修复）");
test("日语不判为中文：假名直接触发需翻", () => {
  const { api } = load(`<html lang="ja"><body></body></html>`);
  assert.equal(api.isAlreadyTarget("東京で会いましょう", "zh-CN"), false, "日语必须送翻");
  assert.equal(api.isAlreadyTarget("これはテストです", "zh-CN"), false, "纯假名必须送翻");
});

test("韩语不判为中文", () => {
  const { api } = load(`<html><body></body></html>`);
  assert.equal(api.isAlreadyTarget("한국어 문장입니다", "zh-CN"), false);
});

test("中文技术段落（夹英文术语）仍判为中文", () => {
  const { api } = load(`<html><body></body></html>`);
  const text = "这是一个中文段落，里面有 Git 和 GitHub 这样的英文术语，整体仍然是中文表达。";
  assert.equal(api.isAlreadyTarget(text, "zh-CN"), true);
});

test("中英混排短标题送翻", () => {
  const { api } = load(`<html><body></body></html>`);
  assert.equal(api.isAlreadyTarget("功能特性 Hello World", "zh-CN"), false);
  assert.equal(api.isAlreadyTarget("Getting started with the API", "zh-CN"), false);
});

test("非中文目标语言不做字面判定", () => {
  const { api } = load(`<html><body></body></html>`);
  assert.equal(api.isAlreadyTarget("这是一个中文段落", "en"), false, "翻英文时中文内容必须送翻");
});

const failed = results.filter(r => !r.ok).length;
console.log(`\n${"=".repeat(50)}`);
console.log(`总计 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
