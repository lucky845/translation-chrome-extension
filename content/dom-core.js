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

  // 纯空白 / 纯标点 / 纯数字的文本不值得发请求。
  const TRIVIAL_RE = /^[\s\p{P}\p{S}\p{N}]*$/u;

  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;

  /**
   * 判断元素是否为内联元素。
   * @param {Element} element 元素
   * @return {boolean} true 表示内联
   */
  function isInline(element) {
    if (!element || element.nodeType !== ELEMENT_NODE) return false;
    const tag = element.tagName.toLowerCase();
    if (INLINE_TAGS.has(tag)) return true;
    // Web Components 自定义元素：布局语义不确定，按内联处理以避免拆碎句子
    return tag.indexOf("-") !== -1;
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
    collect() {
      const self = this;
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

          if (element.childNodes.length === 0) {
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
      this.text = buffer;
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
     * 恢复原始状态。
     * @return {boolean} 是否执行了恢复
     */
    restore() {
      if (!this.translated) return false;

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
  function collectUnits(root) {
    const base = root || (typeof document !== "undefined" ? document.body : null);
    const units = [];
    if (!base || base.nodeType !== ELEMENT_NODE) return units;

    /**
     * 递归收集。
     * @param {Element} element 元素
     */
    function walk(element) {
      if (!hasBlockChild(element)) {
        const unit = new TranslationUnit(element);
        if (unit.collect()) units.push(unit);
        return;
      }

      // 容器自身还有直属文本时单独建浅层单元，否则 `<div>Some text <p>para</p></div>`
      // 里的 "Some text" 会被漏翻。
      if (hasOwnText(element)) {
        const own = new TranslationUnit(element, { shallow: true });
        if (own.collect()) units.push(own);
      }

      for (const child of element.children) {
        if (shouldSkip(child)) continue;
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
  };

  root.__TP_DOM__ = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
