/**
 * DOM 采集、占位符编解码与无损还原（纯逻辑层，无副作用）。
 *
 * ⚠️ 本文件是 Content Script 依赖的普通脚本，禁止出现 import / export 语句：
 *    Manifest V3 的 content_scripts 以传统脚本方式注入，ESM 语法会直接 SyntaxError。
 *    跨文件共享通过 globalThis.__TP_DOM__ 完成，同时便于在 Node 中做单元测试。
 *
 * 为什么不能逐 TEXT 节点翻译：
 *   `Read the <a>official docs</a> before you <b>start</b>.` 若拆成 5 个独立节点分别翻译，
 *   中文语序必然错乱（"阅读官方文档在开始之前"）。必须把整段作为一个翻译单元，
 *   把内联标签编码成占位符，翻译后再按译文顺序还原成真实标签。
 *
 * 占位符格式：`<N>...</N>`（成对）与 `<N/>`（自闭合）。实测 Google 原样保留并按目标语序重排：
 *   `Read the <0>official docs</0> before you <1>start</1>.`
 *   → `在<1>开始</1>之前阅读<0>官方文档</0>。`
 *
 * 还原策略分两种，互不干扰：
 *   - 深层单元（叶子块）：容器内没有块级子元素，swap 整个 innerHTML 即可无损回滚。
 *   - 浅层单元（容器自带直属文本）：只替换容器自身的「直属文本 + 内联元素」，
 *     块级子元素原地保留——它们本身是其他单元的宿主，绝不能被销毁。
 */
(function (root) {
  "use strict";

  // 视为"内联"的标签：保留在句子内部，参与同一翻译单元。
  const INLINE_TAGS = new Set([
    "a",
    "abbr",
    "b",
    "bdi",
    "bdo",
    "cite",
    "code",
    "data",
    "del",
    "dfn",
    "em",
    "font",
    "i",
    "ins",
    "kbd",
    "label",
    "mark",
    "q",
    "ruby",
    "s",
    "samp",
    "small",
    "span",
    "strong",
    "sub",
    "sup",
    "time",
    "tt",
    "u",
    "var",
    "wbr",
    "br",
    "img",
    "picture",
    "meter",
    "progress",
    "output",
  ]);

  // 整棵子树都不参与翻译：脚本、样式、可编辑区、表单控件。
  const SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "math",
    "iframe",
    "object",
    "embed",
    "textarea",
    "input",
    "select",
    "option",
    "optgroup",
    "button",
    "pre",
  ]);

  /** @type {WeakMap<Element, boolean>} 计算样式判定缓存，避免重复 reflow */
  const inlineCache = new WeakMap();

  // 纯空白 / 纯标点 / 纯数字的文本不值得发请求。
  const TRIVIAL_RE = /^[\s\p{P}\p{S}\p{N}]*$/u;

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  /**
   * 判断元素是否为内联元素。
   * @param {Element} element 元素
   * @return {boolean} true 表示内联
   */
  /**
   * 判断元素是否内联。
   *
   * 判定顺序：
   *   1. 显式 display 属性
   *   2. 内联标签白名单
   *   3. 自定义元素：内部有块级子元素即视为结构容器
   *   4. 兜底用 getComputedStyle（结果缓存），避免纯 div+CSS 的站点全被当块级
   *
   * 第 4 步很重要：现代站点大量用 `<div style="display:inline">` 或 CSS 类
   * 把 span 级的行内片段做成 div，只看标签名会把它们错当成独立段落。
   */
  function isInline(element) {
    if (!element || element.nodeType !== ELEMENT_NODE) return false;
    const tag = element.tagName.toLowerCase();

    // 1. 显式 display 声明优先
    const declared = element.getAttribute && element.getAttribute("display");
    if (declared) {
      if (declared.includes("inline")) return true;
      if (declared.includes("block")) return false;
    }

    // 2. 内联标签白名单
    if (INLINE_TAGS.has(tag)) return true;

    // 3. 自定义元素：无子元素才是行内占位，否则按结构容器处理
    if (tag.indexOf("-") !== -1) {
      return element.childElementCount === 0;
    }

    // 4. 计算样式兜底（带缓存，递归判定会反复问同一个元素）
    if (inlineCache.has(element)) return inlineCache.get(element);
    let result = false;
    try {
      const view = element.ownerDocument && element.ownerDocument.defaultView;
      if (view && typeof view.getComputedStyle === "function") {
        const display = view.getComputedStyle(element).display || "";
        result = display.indexOf("inline") === 0 && display !== "inline-block";
      }
    } catch {
      result = false;
    }
    inlineCache.set(element, result);
    return result;
  }

  /**
   * 判断元素是否应整棵跳过。
   * @param {Element} element 元素
   * @return {boolean} true 表示跳过
   */
  function shouldSkip(element) {
    if (!element || element.nodeType !== ELEMENT_NODE) return false;
    const tag = element.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return true;
    if (element.isContentEditable) return true;
    if (element.getAttribute("contenteditable") === "true") return true;
    if (element.getAttribute("translate") === "no") return true;
    if (element.classList && element.classList.contains("notranslate")) return true;
    // 本扩展写入的译文容器：绝不能被二次采集，否则会原文与译文来回翻。
    if (element.hasAttribute("data-tp-translated")) return true;
    return false;
  }

  /**
   * 校验译文里的占位符与原文内联元素一一对应。
   *
   * 引擎正常时会把所有占位符原样带回（实测 Google 支持成对与自闭合两种）；
   * 一旦丢失，重建后内联标签会消失，文字结构随之崩塌。此时必须放弃本次应用。
   *
   * @param {Array<Object>} pieces 解析后的片段
   * @param {Map<number, {kind: string, element: Element}>} placeholders 原文占位符表
   * @return {boolean} true 表示完整
   */
  function placeholdersIntact(pieces, placeholders) {
    if (placeholders.size === 0) return true;

    /** @type {Map<number, number>} 各 id 出现次数 */
    const counts = new Map();
    for (const piece of pieces) {
      if (piece.type === "text") continue;
      counts.set(piece.id, (counts.get(piece.id) || 0) + 1);
    }

    for (const [id, entry] of placeholders) {
      const seen = counts.get(id) || 0;
      // 成对标签需要 open + close 两次出现；自闭合标签只需一次
      const required = entry.kind === "void" ? 1 : 2;
      if (seen < required) return false;
    }

    // 译文不得引用原文不存在的占位符
    for (const id of counts.keys()) {
      if (!placeholders.has(id)) return false;
    }

    return true;
  }

  /**
   * 解析占位符，返回按序片段。
   * @param {string} text 译文
   * @return {?Array<{type: string, value?: string, id?: number}>} 不平衡时返回 null
   */
  function parsePlaceholders(text) {
    const pieces = [];
    const re = /<(\d+)\/>|<\/?(\d+)>/g;
    let last = 0;
    let match;

    while ((match = re.exec(text)) !== null) {
      if (match.index > last) {
        pieces.push({ type: "text", value: text.slice(last, match.index) });
      }
      if (match[1] !== undefined) {
        pieces.push({ type: "void", id: Number(match[1]) });
      } else if (text.charAt(match.index + 1) === "/") {
        pieces.push({ type: "close", id: Number(match[2]) });
      } else {
        pieces.push({ type: "open", id: Number(match[2]) });
      }
      last = re.lastIndex;
    }

    if (last < text.length) {
      pieces.push({ type: "text", value: text.slice(last) });
    }

    const stack = [];
    for (const piece of pieces) {
      if (piece.type === "open") stack.push(piece.id);
      else if (piece.type === "close") {
        if (stack.pop() !== piece.id) return null;
      }
    }
    return stack.length > 0 ? null : pieces;
  }

  /**
   * 按占位符片段构建 DOM 片段，复用原始内联元素的标签名与属性骨架。
   * @param {Array<Object>} pieces 片段
   * @param {Map<number, {kind: string, element: Element}>} placeholders 占位符表
   * @param {Document} doc 文档对象
   * @return {?DocumentFragment} 构建失败返回 null
   */
  function buildFragment(pieces, placeholders, doc) {
    const fragment = doc.createDocumentFragment();
    /** @type {Element[]} */
    const stack = [];

    /**
     * 当前插入位置。
     * @return {Node} 目标节点
     */
    function target() {
      return stack.length > 0 ? stack[stack.length - 1] : fragment;
    }

    for (const piece of pieces) {
      if (piece.type === "text") {
        if (piece.value) target().appendChild(doc.createTextNode(piece.value));
        continue;
      }

      const entry = placeholders.get(piece.id);
      if (!entry) return null; // 译文引用了不存在的占位符

      if (piece.type === "void") {
        target().appendChild(entry.element.cloneNode(false));
        continue;
      }

      if (piece.type === "open") {
        const skeleton = entry.element.cloneNode(false);
        target().appendChild(skeleton);
        stack.push(skeleton);
        continue;
      }

      if (stack.length === 0) return null; // 多余的闭合标签
      stack.pop();
    }

    return stack.length > 0 ? null : fragment; // 未闭合
  }

  /**
   * 一个翻译单元。
   */
  class TranslationUnit {
    /**
     * @param {Element} element 容器元素
     * @param {{shallow?: boolean, doc?: Document}} options
     */
    constructor(element, options) {
      const opts = options || {};
      this.element = element;
      this.doc = opts.doc || element.ownerDocument;
      this.shallow = opts.shallow === true;
      this.text = "";
      this.placeholders = new Map();
      /** @type {Map<number, Element>} brace {{n}} 模式的原子占位符映射（自定义引擎用） */
      this.braceMap = new Map();
      /** 去掉全部占位符后的纯文本 */
      this.plainText = "";
      /** @type {Array<Text>} 参与翻译的文本节点（文档顺序），降级时就地替换用 */
      this.textNodeRefs = [];
      /** @type {?{class: ?string, style: ?string}} 打标记前的原始属性，恢复时精确写回 */
      this.savedAttrs = null;
      /** @type {Array<{node: Text, value: string}>} 就地替换前的原值，用于无损还原 */
      this.savedTextValues = [];
      this.translated = false;

      // 深层单元还原用
      this.originalHtml = null;

      // 浅层单元还原用
      this.savedOwnNodes = [];
      this.insertedNodes = [];
      this.anchor = null;
    }

    /**
     * 采集可翻译内容。
     * @return {boolean} 是否有值得翻译的文本
     */
    /**
     * 采集并序列化。
     * @param {string} [mode] 占位符风格："tag"（默认，<0>…</0>，Google 用）或 "brace"（{{n}} 原子，自定义引擎用）
     * @return {boolean} 是否采集到可翻译文本
     */
    collect(mode) {
      const self = this;
      self.braceMode = mode === "brace";
      let buffer = "";
      /** @type {Element[]} */
      const placeholderElements = [];

      /**
       * 递归拼接。
       * @param {Node} node 当前节点
       */
      function walk(node) {
        for (const child of node.childNodes) {
          if (child.nodeType === TEXT_NODE) {
            buffer += child.nodeValue;
            self.textNodeRefs.push(child);
            continue;
          }
          if (child.nodeType !== ELEMENT_NODE) continue;

          const element = /** @type {Element} */ (child);
          if (shouldSkip(element)) continue;

          if (!isInline(element)) {
            // 浅层单元不碰块级后代（它们由自己的单元处理）
            if (self.shallow) continue;
            walk(element);
            continue;
          }

          const id = placeholderElements.length;
          placeholderElements.push(element);

          if (self.braceMode) {
            // 成对 brace：open={{2k}} close={{2k+1}}，void={{2k}}。
            // DeepLX/LibreTranslate/OpenAI 等纯文本引擎会把 <0> 当 HTML 剥掉，
            // 但 {{n}} 是普通文本 token，实测 Google/DeepL 类引擎原样保留并随语序重排，
            // 内层文字继续 walk 进入翻译（链接文字也能翻到）。
            self.braceMap.set(id, { element, void: element.childNodes.length === 0 });
            if (element.childNodes.length === 0) {
              buffer += "{{" + 2 * id + "}}";
            } else {
              buffer += "{{" + 2 * id + "}}";
              walk(element);
              buffer += "{{" + (2 * id + 1) + "}}";
            }
          } else if (element.childNodes.length === 0) {
            self.placeholders.set(id, { kind: "void", element });
            buffer += "<" + id + "/>";
          } else {
            self.placeholders.set(id, { kind: "paired", element });
            buffer += "<" + id + ">";
            walk(element);
            buffer += "</" + id + ">";
          }
        }
      }

      walk(this.element);
      // 压缩连续空白：源码里的缩进与换行会被送进引擎，
      // 既浪费字符也让译文掺杂大量空白（AAA 这类页面占位符灾难的主因之一）。
      this.text = buffer.replace(/[ \t]*\n[ \t\n]*/g, " ").replace(/ {2,}/g, " ");
      // plainText 只由「有语义的」文本节点组成：
      // 纯数字与纯符号（GitHub 的计数器 "9"、角标 "(9)"）不参与翻译，
      // 否则整段译文里会带上这些数字，而节点本身又保留数字 → 显示成 "9(9)"。
      const strip = this.braceMode ? /\{\{\/?\d+\}\}/g : /<\d+\/>|<\/\d+>|<\d+>/g;
      this.plainText = this.textNodeRefs
        .map(node => String(node.nodeValue || "").trim())
        .filter(value => value.length > 0 && /\p{L}/u.test(value))
        .join(" ")
        .replace(strip, "")
        .replace(/ {2,}/g, " ")
        .trim();
      return this.hasTranslatableText();
    }

    /**
     * 判断采集结果是否值得翻译。
     * @return {boolean} true 表示可翻译
     */
    hasTranslatableText() {
      const plain = this.text.replace(/<\d+\/>|<\/?\d+>/g, "").trim();
      if (plain.length === 0) return false;
      if (TRIVIAL_RE.test(plain)) return false;
      return /\p{L}/u.test(plain);
    }

    /**
     * 应用译文。
     * @param {string} translated 引擎返回的译文
     * @return {boolean} 是否成功应用
     */
    apply(translated) {
      if (typeof translated !== "string" || translated.trim().length === 0) return false;
      // 幂等：同一单元不允许被应用两次，否则文字会叠加成重复
      if (this.translated) return false;

      const pieces = parsePlaceholders(translated);
      if (pieces === null) return false; // 占位符不平衡，拒绝生成错乱 DOM

      // 原文有内联标签时，译文必须把它们全部带回。少一个就说明引擎吞掉了标签，
      // 此时应用会把 `<a>` 当字面文本渲染，用户会看到源码。宁可保留原文。
      if (!placeholdersIntact(pieces, this.placeholders)) return false;

      const fragment = buildFragment(pieces, this.placeholders, this.doc);
      if (fragment === null) return false;

      if (this.shallow) return this.applyShallow(fragment);

      if (this.originalHtml === null) this.originalHtml = this.element.innerHTML;
      this.element.replaceChildren(fragment);
      this.markTranslated();
      this.translated = true;
      return true;
    }

    /**
     * 浅层应用：只替换容器直属的文本与内联元素，块级子元素原地不动。
     * @param {DocumentFragment} fragment 译文片段
     * @return {boolean} 是否成功
     */
    applyShallow(fragment) {
      /** @type {Node[]} */
      const own = [];
      let anchor = null;
      let seenOwn = false;

      for (const child of Array.from(this.element.childNodes)) {
        const isBlock = child.nodeType === ELEMENT_NODE && !isInline(/** @type {Element} */ (child));
        const isSkipped = child.nodeType === ELEMENT_NODE && shouldSkip(/** @type {Element} */ (child));

        if (isBlock || isSkipped) {
          if (seenOwn && anchor === null) anchor = child;
          continue;
        }
        seenOwn = true;
        own.push(child);
      }

      if (own.length === 0) return false;

      const nodes = Array.from(fragment.childNodes);
      this.savedOwnNodes = own;
      this.anchor = anchor;
      this.insertedNodes = nodes;
      for (const node of own) node.remove();
      this.element.insertBefore(fragment, anchor);
      this.translated = true;
      return true;
    }

    /**
     * brace 模式还原：译文按 {{n}} 拆成 token 流，栈式重建元素内容。
     * 约定：inline 元素 k 序列化为 open={{2k}} / close={{2k+1}}，void 只发 {{2k}}。
     * 实测 Google 对 {{n}} 原样保留并按目标语序重排；DeepL 类纯文本引擎同样通过。
     * 任一 token 丢失/配对失败即返回 false，由调用方回落 applyWholeText。
     * @param {string} translated 含 {{n}} 的译文
     * @return {boolean} 是否成功
     */
    applyBrace(translated) {
      if (this.braceMap.size === 0) return false;
      const raw = String(translated || "");
      if (!raw.trim()) return false;

      const TOKEN = /\{\{(\d+)\}\}/g;
      const tokens = [];
      let match;
      let cursor = 0;
      while ((match = TOKEN.exec(raw)) !== null) {
        if (match.index > cursor) {
          tokens.push({ kind: "text", value: raw.slice(cursor, match.index) });
        }
        tokens.push({ kind: "token", id: Number(match[1]) });
        cursor = match.index + match[0].length;
      }
      if (cursor < raw.length) tokens.push({ kind: "text", value: raw.slice(cursor) });

      // 第一遍：纯校验，不动 DOM。全部通过后才进入第二遍重建，
      // 避免「校验失败但元素已被摘下」的半破坏状态。
      const stack = [];
      for (const token of tokens) {
        if (token.kind === "text") continue;
        const elementId = Math.floor(token.id / 2);
        const isClose = token.id % 2 === 1;
        const entry = this.braceMap.get(elementId);
        if (!entry) return false;
        if (entry.void) {
          if (isClose) return false;
          continue;
        }
        if (!isClose) {
          stack.push(elementId);
        } else {
          if (stack.pop() !== elementId) return false; // 交叉嵌套
        }
      }
      if (stack.length > 0) return false; // 有 open 没有 close

      // 第二遍：重建。open 时清空元素旧内容（原文由译文承接），再作为容器承接后续节点。
      if (this.originalHtml === null) this.originalHtml = this.element.innerHTML;
      const fragment = document.createDocumentFragment();
      const open = [];
      const parent = () => (open.length > 0 ? open[open.length - 1] : fragment);

      for (const token of tokens) {
        if (token.kind === "text") {
          const value = String(token.value || "");
          if (value) parent().appendChild(document.createTextNode(value));
          continue;
        }

        const elementId = Math.floor(token.id / 2);
        const isClose = token.id % 2 === 1;
        const entry = this.braceMap.get(elementId);

        if (entry.void) {
          parent().appendChild(entry.element);
          continue;
        }
        if (!isClose) {
          entry.element.replaceChildren(); // 清掉原英文内文，译文文本节点随后填入
          parent().appendChild(entry.element);
          open.push(entry.element);
        } else {
          open.pop();
        }
      }

      this.element.replaceChildren(fragment);
      this.translated = true;
      return true;
    }

    /**
     * 整段译文只写一次：放进第一个有意义的文本节点，其余清空。
     *
     * 适用场景：译文是「整段」而非逐节点对应（端侧翻译、纯文本降级）。
     * 若把整段重复写进每个文本节点，一个含 3 个节点的段落就会显示 3 遍。
     * 标签与属性完全不动，样式不受影响。
     *
     * @param {string} translated 整段译文
     * @return {boolean} 是否成功
     */
    applyWholeText(translated) {
      const text = String(translated || "").trim();
      if (!text) return false;
      // 幂等：端侧与在线两条路径可能先后命中同一单元，重复写入会造成文字重复
      if (this.translated) return false;

      // 把文本节点分成两类，避免数字重复：
      //   1) 纯数字/纯符号节点（GitHub 的 "9"、"(3)"）——页面真实数据，**原样不动**；
      //   2) 含文字的节点——承载译文，全部清空后只在第一个里写入整段译文。
      // 送翻的 plainText 只由第 2 类拼成，所以译文里不含第 1 类的数字，天然不会重复。
      const contentNodes = this.meaningfulTextNodes();
      if (contentNodes.length === 0) return false;

      // 数字归属唯一化：纯数字/纯符号节点**不参与采集**（见 collect/plainText），
      // 因此送进引擎的文本本来就不含它们，译文也不会带回来 —— 不会重复。
      // 所以这里既不剥数字（会丢掉段落内的 "22"），也不清空数字节点（那是页面真实数据）。
      const target = contentNodes[0];
      this.savedTextValues = contentNodes.map(node => ({ node, value: node.nodeValue }));
      for (const node of contentNodes) {
        node.nodeValue = node === target ? text : "";
      }

      this.markTranslated();
      this.translated = true;
      return true;
    }

    /**
     * 参与翻译的文本节点：跳过纯空白与纯符号。
     * @return {Array<Text>} 文本节点
     */
    meaningfulTextNodes() {
      return this.textNodeRefs.filter(node => {
        const value = String(node.nodeValue || "").trim();
        return value.length > 0 && /\p{L}/u.test(value);
      });
    }

    /**
     * 给容器打上「已翻译」标记，并放开可能截断译文的高度限制。
     *
     * 中文字数通常少于英文，但换算成行高后反而更容易被 -webkit-line-clamp
     * 裁掉尾部；翻译后解除该限制。
     * @return {void}
     */
    markTranslated() {
      if (!this.element || !this.element.setAttribute) return;

      // 记录原始属性，恢复时要逐字节还原（class=""/style="" 这种残留会让还原断言失败）
      this.savedAttrs = {
        class: this.element.getAttribute("class"),
        style: this.element.getAttribute("style"),
      };

      this.element.setAttribute("data-tp-translated", "");
      this.element.classList.add("notranslate");
      try {
        const style = this.element.style;
        if (!style) return;
        style.setProperty("-webkit-line-clamp", "unset");
        style.setProperty("max-height", "none");
        style.setProperty("height", "auto");
      } catch {
        // 某些环境不支持这些属性，忽略即可
      }
    }

    /**
     * 恢复原始状态。
     * @return {boolean} 是否执行了恢复
     */
    restore() {
      if (!this.translated) return false;

      // 清掉标记，否则容器这辈子都不会再被翻译。
      // 属性要按原文精确还原：原本没有 class/style 就必须 removeAttribute，
      // 否则会留下 class=""、style="" 这种空壳，破坏「逐字节还原」。
      if (this.element && this.element.removeAttribute) {
        this.element.removeAttribute("data-tp-translated");
        const saved = this.savedAttrs || {};
        for (const name of ["class", "style"]) {
          const original = saved[name];
          if (original === null || original === undefined) {
            this.element.removeAttribute(name);
          } else {
            this.element.setAttribute(name, original);
          }
        }
        this.savedAttrs = null;
      }

      // 文本节点级替换：把原值写回去即可，标签从未被改动
      if (this.savedTextValues.length > 0) {
        for (const { node, value } of this.savedTextValues) {
          try {
            node.nodeValue = value;
          } catch {
            // 节点已随页面更新被移除，忽略
          }
        }
        this.savedTextValues = [];
        this.translated = false;
        return true;
      }

      if (this.shallow) {
        for (const node of this.insertedNodes) node.remove();
        const fragment = this.doc.createDocumentFragment();
        for (const node of this.savedOwnNodes) fragment.appendChild(node);
        const valid = this.anchor && this.anchor.parentNode === this.element ? this.anchor : null;
        this.element.insertBefore(fragment, valid);
        this.insertedNodes = [];
        this.savedOwnNodes = [];
        this.anchor = null;
        this.translated = false;
        return true;
      }

      if (this.originalHtml === null) return false;
      this.element.innerHTML = this.originalHtml;
      this.originalHtml = null;
      this.translated = false;
      return true;
    }
  }

  /**
   * 参与遍历的子元素：跳过脚本/样式等整棵忽略的节点。
   * @param {Element} element 元素
   * @return {Element[]} 子元素
   */
  function visibleChildren(element) {
    const list = [];
    for (const child of element.children) {
      if (shouldSkip(child)) continue;
      list.push(child);
    }
    return list;
  }

  /**
   * 元素内部是否还有块级子元素。
   * @param {Element} element 元素
   * @return {boolean} true 表示应继续下钻
   */
  function hasBlockChild(element) {
    for (const child of element.children) {
      if (shouldSkip(child)) continue;
      if (!isInline(child)) return true;
    }
    return false;
  }

  /**
   * 元素是否有直属的可翻译文本节点。
   * @param {Element} element 元素
   * @return {boolean} true 表示有
   */
  function hasOwnText(element) {
    for (const node of element.childNodes) {
      if (node.nodeType !== TEXT_NODE) continue;
      const value = node.nodeValue.trim();
      if (value.length > 0 && !TRIVIAL_RE.test(value)) return true;
    }
    return false;
  }

  /**
   * 从页面采集所有翻译单元。
   * @param {Element} root 根节点
   * @return {Array<TranslationUnit>} 单元列表
   */
  /**
   * 采集可翻译单元。
   * @param {Element} root 根元素
   * @param {string} [placeholderMode] "tag"（默认）或 "brace"
   * @return {Array<TranslationUnit>} 单元
   */
  function collectUnits(root, placeholderMode) {
    const base = root || (typeof document !== "undefined" ? document.body : null);
    const units = [];
    if (!base || base.nodeType !== ELEMENT_NODE) return units;

    /**
     * 递归收集。
     * @param {Element} element 元素
     */
    function walk(element) {
      // 单子元素穿透：没有直属文本、且只有一个子元素时，这层只是包装壳
      // （GitHub 的 react-partial / turbo-frame 层层嵌套就是这种结构）。
      // 不穿透的话壳和内层会被当成两个单元，同一段文字翻两遍。
      // 实测（GitHub 仓库页）：311 个单元里有 223 个是这种纯包装层，占 56% 字符。
      let node = element;
      while (!hasOwnText(node) && visibleChildren(node).length === 1) {
        node = visibleChildren(node)[0];
      }

      if (!hasBlockChild(node)) {
        const unit = new TranslationUnit(node);
        if (unit.collect(placeholderMode)) units.push(unit);
        return;
      }

      // 容器自身还有直属文本时单独建浅层单元，否则 `<div>Some text <p>para</p></div>`
      // 里的 "Some text" 会被漏翻。
      if (hasOwnText(node)) {
        const own = new TranslationUnit(node, { shallow: true });
        if (own.collect(placeholderMode)) units.push(own);
      }

      for (const child of visibleChildren(node)) {
        if (isInline(child)) continue;
        walk(child);
      }
    }

    walk(base);
    return units;
  }

  /**
   * 判断页面语言声明是否已等于目标语言。
   * @param {string} targetLanguage 目标语言
   * @return {boolean} true 表示页面可能已是目标语言
   */
  function isPageAlreadyTarget(targetLanguage) {
    const lang = (document.documentElement.lang || "").toLowerCase();
    const target = String(targetLanguage).toLowerCase();
    if (!lang) return false;
    if (lang.indexOf("zh") === 0 && target.indexOf("zh") === 0) return true;
    return lang.split("-")[0] === target.split("-")[0];
  }

  /**
   * 判断样本文本是否含汉字。
   * @param {string} sample 样本
   * @return {boolean} true 表示含汉字
   */
  function containsHanText(sample) {
    return /\p{Script=Han}/u.test(sample);
  }

  /**
   * 统计样本里汉字占非空白字符的比例，用于识别「没有 lang 标记的中文页面」。
   * @param {string} sample 样本
   * @return {number} 0~1
   */
  function hanRatio(sample) {
    const text = String(sample || "").replace(/\s+/g, "");
    if (!text) return 0;
    const han = text.match(/\p{Script=Han}/gu);
    return han ? han.length / text.length : 0;
  }

  const api = {
    INLINE_TAGS,
    SKIP_TAGS,
    TranslationUnit,
    collectUnits,
    parsePlaceholders,
    buildFragment,
    isInline,
    shouldSkip,
    hasBlockChild,
    hasOwnText,
    isPageAlreadyTarget,
    containsHanText,
    hanRatio,
  };

  root.__TP_DOM__ = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
