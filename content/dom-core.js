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

  /**
   * 转义送进引擎的原文文本。
   *
   * 只处理 `& < >` 三个字符——占位符 `<0>` 是采集阶段自己拼进去的，
   * 所以必须在拼装前先转义原文，顺序不能反。
   * @param {string} text 原文
   * @return {string} 转义后文本
   */
  function escapeText(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /**
   * 反转义引擎回传的译文片段。
   *
   * 有些引擎会把 `&lt;` 再转义成 `&amp;lt;`，先归一后再整体反转义。
   * @param {string} text 译文片段
   * @return {string} 还原后的纯文本
   */
  function unescapeText(text) {
    return String(text)
      .replace(/&amp;(amp|lt|gt|quot|#39);/g, "&$1;")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
  }

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

    // block / inline 是**布局**属性，只能看计算后的 display，不能按标签名猜：
    // `<strong style="display:block">A big claim</strong>` 是块级标题，
    // 若按标签白名单当内联，就会和正文并成一句翻成「标题：一项重大主张及更多」。
    // （旧实现里 `getAttribute("display")` 读的是一个不存在的 HTML 属性，纯死代码。）
    // 注意：不能直接用裸的 getComputedStyle —— dom-core.js 在 Node 测试里
    // 用 new Function 在 jsdom 上下文中执行，那个作用域里没有这个全局函数，
    // 必须从 ownerDocument.defaultView 取（Chrome 里两者等价）。
    const view = element.ownerDocument && element.ownerDocument.defaultView;
    if (view && typeof view.getComputedStyle === "function") {
      let display = "";
      try {
        display = view.getComputedStyle(element).display || "";
      } catch {
        display = "";
      }
      // `display: contents` 不生成盒子，不该被占位符包住（内容会跟着语序乱掉），
      // 交给上层当容器处理。
      if (display === "contents") return false;
      if (display) {
        const outer = display.split(" ")[0];
        if (outer === "inline" || outer === "ruby" || outer === "ruby-text") return true;
        // inline-block / inline-flex / inline-table 是「行内盒」：
        // 做占位符时算 inline（内容要翻），但它是独立盒子，不参与折行。
        if (outer === "inline-block" || outer === "inline-flex" || outer === "inline-grid" || outer === "inline-table")
          return true;
        return false;
      }
    }

    // 拿不到计算样式（jsdom、离屏文档）时按标签兜底
    if (INLINE_TAGS.has(tag)) return true;

    // 自定义元素：无子元素才是行内占位，否则按结构容器处理
    if (tag.indexOf("-") !== -1) {
      return element.childElementCount === 0;
    }

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
        // 译文片段是 HTML 文本，必须反转义后才能当纯文本节点插入，
        // 否则用户会看到字面的 `&lt;div&gt;`（采集时转义了，这里负责还原）。
        const value = unescapeText(piece.value);
        if (value) target().appendChild(doc.createTextNode(value));
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
      /** @type {string|null} 应用译文后的文本指纹，用于判断页面是否被外部改动 */
      this.appliedText = null;

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
            // 原文里的裸尖括号必须转义：占位符语法 <0>…</0> 与页面文本共用 `<` `>`
            // 命名空间，`Array<T>` 这种东西原样送进去，引擎回传时 HTML 解析器
            // 会把它当未知标签整段吞掉（实测 `Use <code>Array&lt;T&gt;</code> tags.`
            // 翻完变成 `使用 <0>Array<T></0> 或 标签。`，`<T>` 消失）。
            buffer += escapeText(child.nodeValue);
            self.textNodeRefs.push(child);
            continue;
          }
          if (child.nodeType !== ELEMENT_NODE) continue;

          const element = /** @type {Element} */ (child);
          if (shouldSkip(element)) continue;

          // 注音与括号提示不是正文：`漢字<ruby>東京<rt>Tōkyō</rt></ruby>です`
          // 若把 <rt> 当普通内容拼进去，送翻串变成 `漢字東京Tōkyōです`，
          // 译文会变成「汉字东京Tōkyō是」这种注音混进正文的乱码。
          const childTag = element.tagName.toLowerCase();
          if (childTag === "rt" || childTag === "rp") continue;

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
      this.appliedText = this.normalizeText(this.element.textContent);
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

      // 译文只能写进「单元直属的」文本节点。
      // meaningfulTextNodes() 会把内联元素（<a>/<b>）内部的文本节点也算进来，
      // 若第一个恰好是链接内的节点，整段译文就钻进了链接里 —— 链接样式传染全文、
      // 原链接文字还会被清空（实测：`Read the <a>docs</a> here.` 降级后
      // 变成 `阅读文档<a href="/d"></a>`，链接文字彻底丢失）。
      const direct = contentNodes.filter(node => !this.isInsidePlaceholder(node));
      const ordered = direct.length > 0 ? direct : contentNodes;
      const target = ordered[0];
      this.savedTextValues = ordered.map(node => ({ node, value: node.nodeValue }));
      for (const node of ordered) {
        node.nodeValue = node === target ? text : "";
      }
      // 内联元素里的旧文字必须清掉，否则会和新译文叠着显示。
      // 注意：**不能** replaceChildren() 整体清空——承载译文的节点就在里面，
      // 整棵清掉等于把刚写进去的译文一起删了（实测：`<span>Security and quality</span>`
      // 变成 `<span></span>`，页面空白）。只把「没被译文占用」的文本节点置空。
      const owner = new Set(ordered);
      for (const entry of this.placeholders.values()) {
        if (!entry || !entry.element || entry.kind === "void") continue;
        for (const t of Array.from(entry.element.querySelectorAll("*")).flatMap(el => Array.from(el.childNodes))) {
          if (t.nodeType !== TEXT_NODE || owner.has(t)) continue;
          if (!this.savedTextValues.some(saved => saved.node === t)) {
            this.savedTextValues.push({ node: t, value: t.nodeValue });
          }
          t.nodeValue = "";
        }
      }

      this.appliedText = this.normalizeText(this.element.textContent);
      this.markTranslated();
      this.translated = true;
      return true;
    }

    /**
     * 文本节点是否位于某个内联占位符元素内部。
     *
     * applyWholeText 降级路径专用：译文属于「整段」，必须写进单元直属文本节点，
     * 不能钻进 <a>/<b> 里——否则链接样式会传染整句，原链接文字还会被清空。
     * @param {Text} node 文本节点
     * @return {boolean} true 表示在内联元素里
     */
    isInsidePlaceholder(node) {
      if (!node) return false;
      // 只看 void 占位符：它们没有可承载译文的文本内容（<img> 塞子节点会丢）。
      // paired 占位符（<a>/<b>/<span>）内部是**该单元的内容**，恰好是整段译文
      // 该落的位置，排除掉会让 applyWholeText 无处可写（实测导致整段译文丢失）。
      let current = node.parentNode;
      while (current && current !== this.element) {
        for (const entry of this.placeholders.values()) {
          if (entry && entry.element === current && entry.kind === "void") return true;
        }
        current = current.parentNode;
      }
      return false;
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

      // 记录原始属性，恢复时要逐字节还原（class=""/style="" 这种残留会让还原断言失败）。
      // 只记第一次：release 之后重新 apply 时元素已经摘干净了当然该重记，
      // 但 release 前的二次 apply（同一单元多次落译文）必须保留最初那份快照，
      // 否则会把翻译期间我们加上去的 class/style 当成「原文」固化下来。
      if (!this.savedAttrs) {
        this.savedAttrs = {
          class: this.element.getAttribute("class"),
          style: this.element.getAttribute("style"),
        };
      }

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

      // 整棵 innerHTML 回写会**覆盖页面在翻译期间的新内容**：
      // React/Vue 只更新了某个文本节点，回写快照等于把框架的更新抹掉，
      // 之后框架 patch 还会因为找不到节点而报 NotFoundError。
      //
      // 判据：当前文本是否还是我们自己写进去的那份。
      // 是 → 没人动过，按快照逐字节还原（语序重排是占位符机制的预期结果，不算变化）；
      // 否 → 页面已经自行更新，只还原结构骨架、不覆盖新文本。
      const ours = this.appliedText === null || this.normalizeText(this.element.textContent) === this.appliedText;
      if (ours) {
        this.element.innerHTML = this.originalHtml;
      }
      this.originalHtml = null;
      this.translated = false;
      return true;
    }

    /**
     * 译文是否已被页面改写。
     *
     * data-tp-translated 标记的作用是「这里现在放的是我的译文」。
     * React/Vue 重渲染会直接把文本换回原文，标记却留在元素上——
     * 采集时整块被当成译文跳过，这块内容从此永远不再翻译。
     * @return {boolean} true 表示标记已过期
     */
    isStale() {
      if (!this.element || this.appliedText === null || !this.translated) return false;
      return this.normalizeText(this.element.textContent) !== this.appliedText;
    }

    /**
     * 主动放弃这个单元：摘掉标记、忘掉快照，不再参与 restore。
     *
     * 页面已经把这块 DOM 换掉了，我们保存的原文快照已经失真，
     * 留着只会在恢复时把框架的新内容写回旧值。
     */
    release() {
      const el = this.element;
      if (!el || !el.removeAttribute) {
        this.originalHtml = null;
        this.appliedText = null;
        this.translated = false;
        return;
      }
      // markTranslated 打了两样东西：data-tp-translated 与 class="notranslate"。
      // 只摘属性会漏掉 class —— shouldSkip 认 class，采集照样被跳过。
      el.removeAttribute("data-tp-translated");
      if (el.classList) el.classList.remove("notranslate");
      // class/style 按翻译前快照还原，避免留下 -webkit-line-clamp:unset 这类残留。
      // 空字符串等同于「原本没有」：Chrome 里把 style 属性清空后会返回 ""，
      // 再 setAttribute("style", "") 就会在 HTML 里留下一个多余的空壳属性。
      const saved = this.savedAttrs;
      if (saved) {
        for (const name of ["class", "style"]) {
          const value = saved[name];
          if (value === null || value === undefined || value === "") el.removeAttribute(name);
          else el.setAttribute(name, value);
        }
        this.savedAttrs = null;
        // 保险：某些浏览器在 removeAttribute 之后再访问 el.style 会把空 style 建回来
        if (el.getAttribute("style") === "") el.removeAttribute("style");
      }
      this.originalHtml = null;
      this.appliedText = null;
      this.translated = false;
    }

    /**
     * 归一化文本：去空白后用于「是不是我自己写的」判断。
     * @param {string} text 文本
     * @return {string} 归一化结果
     */
    normalizeText(text) {
      return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
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

      const blockChild = hasBlockChild(node);

      if (!blockChild) {
        const unit = new TranslationUnit(node);
        if (unit.collect(placeholderMode)) units.push(unit);
        return;
      }

      // 容器自身还有直属文本时单独建浅层单元，否则 `<div>Some text <p>para</p></div>`
      // 里的 "Some text" 会被漏翻。
      //
      // 这里必须显式传 shallow —— 漏了的话该单元会按「深层」处理：
      // collect 阶段尚看不出问题（walk 时块级子元素仍被跳过），
      // 但 apply 阶段走 `element.replaceChildren(fragment)` 会把**整个容器**重写，
      // 内部子单元刚写好的译文被一并抹掉（实测：`Intro.<div>Inner.</div>` 应用后
      // 只剩 `T(Intro.)`，Inner 的译文消失）。
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
    // 分母只数「能区分语言的字母」：汉字 / 假名 / 谚文 / 拉丁字母。
    // 旧实现把标点、数字、全角符号也算进分母，导致
    // 「東京で会いましょう」的 0.33 被判成中文（日语页面整页不翻，
    // 用户看到的是「点翻译没反应」）；改成字母分母后同一句降到 0.29。
    const letters = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-z]/gu);
    if (!letters || letters.length === 0) return 0;
    const han = letters.filter(ch => /\p{Script=Han}/u.test(ch)).length;
    return han / letters.length;
  }
  /**
   * 判断一段文本是否已经是目标语言。
   *
   * 只处理中文目标：汉字占比够高即认为是中文。
   * 其它目标语言没有可靠的字面判据，一律返回 false（交给引擎自己识别）。
   * @param {string} text 文本
   * @param {string} targetLanguage 目标语言
   * @return {boolean} true 表示已是目标语言
   */
  function isAlreadyTarget(text, targetLanguage) {
    const target = String(targetLanguage || "").toLowerCase();
    if (target.indexOf("zh") !== 0) return false;
    const value = String(text || "");
    // 出现假名/谚文 = 这一定不是中文（日语汉字的写法本来就借自中文）。
    // 没有这条，「東京で会いましょう」会被当成中文而整段跳过。
    if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value)) return false;
    // 短文本（"确定"、"OK"）用比例判断不可靠，放行让引擎处理
    if (value.trim().length < 4) return false;

    // 阈值 0.5 来自实测分布：
    //   中文技术段落（夹 Git/GitHub 等英文词）0.757 → 判中文，正确
    //   纯中文标签 1.000 → 判中文，正确
    //   「功能特性 Hello World」0.286 → 送翻，正确（界面标题是中英混排，翻成英文更合理）
    //   「The API 返回 JSON 数据 for developers」0.148 → 送翻，正确
    //   日语「東京で会いましょう」0.333 → 已被上面的假名否决拦住
    return hanRatio(value) >= 0.5;
  }
  const TRANSLATABLE_ATTRS = ["title", "alt", "aria-label", "placeholder"];

  /**
   * 采集整页的属性文本（title / alt / aria-label / placeholder）。
   *
   * 为什么是独立函数而不是 TranslationUnit 的方法：单元经过「单子元素穿透」后
   * 可能已经指向内层（`<div><a title="…">` 的单元是 `<a>` 本身），
   * 从单元往下查会漏掉单元自己的属性，也漏掉块级兄弟节点上的属性。
   * 属性是**全页**维度，必须在正文采集之外单独扫一遍。
   * @param {Element} root 扫描根
   * @param {string} targetLanguage 目标语言
   * @return {Array<{element: Element, attr: string, text: string}>} 待翻译属性
   */
  function collectAttributeTexts(root, targetLanguage) {
    const found = [];
    const seen = new Set();
    const base = root || (typeof document !== "undefined" ? document.body : null);
    if (!base || !base.querySelectorAll) return found;

    const nodes = [base].concat(Array.from(base.querySelectorAll(TRANSLATABLE_ATTRS.map(a => `[${a}]`).join(","))));
    for (const element of nodes) {
      if (!element || element.nodeType !== ELEMENT_NODE) continue;
      // **不能**用 shouldSkip：它把 button/input/select 整类跳过了（正文不该翻），
      // 但这些控件的 placeholder / aria-label 恰恰是最该翻的。
      // 属性扫描只看「是不是确实不可见」和「是不是脚本/样式」。
      const tag = element.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;
      if (element.matches && element.matches('[translate="no"], .notranslate, [aria-hidden="true"]')) continue;
      if (element.closest && element.closest("svg")) continue;
      for (const attr of TRANSLATABLE_ATTRS) {
        const raw = element.getAttribute && element.getAttribute(attr);
        if (!raw) continue;
        const text = String(raw).trim();
        // 空串、纯符号、单字属性不送翻（按钮上的 "OK" 翻成"好"反而怪）
        if (text.length < 2 || !/\p{L}/u.test(text)) continue;
        if (isAlreadyTarget(text, targetLanguage)) continue;
        const key = attr + "::" + text;
        if (seen.has(key)) continue;
        seen.add(key);
        found.push({ element, attr, text });
      }
    }
    return found;
  }

  /**
   * 应用属性译文。
   * @param {Array<{element: Element, attr: string, text: string}>} entries 采集结果
   * @param {Map<string, string>} translated 原文 → 译文
   * @param {Array<{element: Element, attr: string, value: string}>} saved 原值记录（会被原地追加）
   * @return {number} 应用数量
   */
  function applyAttributeTexts(entries, translated, saved) {
    if (!entries || !translated || translated.size === 0) return 0;
    let applied = 0;
    for (const entry of entries) {
      const next = translated.get(entry.text);
      if (!next || next === entry.text) continue;
      if (saved) {
        saved.push({ element: entry.element, attr: entry.attr, value: entry.element.getAttribute(entry.attr) });
      }
      entry.element.setAttribute(entry.attr, next);
      applied++;
    }
    return applied;
  }

  /**
   * 还原属性文本。
   * @param {Array<{element: Element, attr: string, value: string}>} saved 原值记录
   * @return {void}
   */
  function restoreAttributeTexts(saved) {
    if (!saved) return;
    for (const item of saved) {
      try {
        item.element.setAttribute(item.attr, item.value);
      } catch {
        // 元素已被页面移除，忽略
      }
    }
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
    isAlreadyTarget,
    collectAttributeTexts,
    applyAttributeTexts,
    restoreAttributeTexts,
  };

  root.__TP_DOM__ = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
