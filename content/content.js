/**
 * Content Script：页面翻译状态机与调度。
 *
 * ⚠️ 本文件是传统脚本（非 ESM），依赖 content/dom-core.js 先执行注入的 globalThis.__TP_DOM__。
 *
 * 状态：idle → translating → translated → restoring → idle
 * 动态内容由 MutationObserver 增量翻译，节流 300ms，且自身改写 DOM 期间抑制回调防自触发。
 */
(function () {
  "use strict";

  // 防止被打断后重复注入（扩展重载、bfcache 恢复等场景）
  if (window.__TP_CONTENT_LOADED__) return;
  window.__TP_CONTENT_LOADED__ = true;

  const DOM = window.__TP_DOM__;
  if (!DOM) {
    console.error("[translate-page] dom-core.js 未加载，content script 退出");
    return;
  }

  // 浏览器内置端侧翻译（Chrome 138+ / Edge 148+，同一套 API）。
  // 支持则本地推理、不联网、无限流；不支持则自动回落到在线引擎。
  const OFFLINE = window.__TP_OFFLINE__ || null;

  // 站点黑名单：命中则整页翻译直接拒绝
  const BLACKLIST = window.__TP_BLACKLIST__ || null;

  // 端侧翻译模块（Chrome 138+ 内置，完全离线）

  /** 后台响应超时，防止消息通道永久挂起。 */
  const MESSAGE_TIMEOUT_MS = 60000;

  /** 单次发给后台的单元数量，与后台分块策略呼应。 */
  const UNIT_BATCH_SIZE = 120;

  /** 视口外扩边距：提前翻译即将滚入视野的内容，滚动时不会出现空白。 */
  const VIEWPORT_MARGIN = "900px 0px";

  /**
   * 滚动翻译：视口外这圈内的单元也要立刻翻（约一屏）。
   * 再往外就停手等滚动——这是「滚动到哪翻到哪」与「一次翻完整页」的分界线。
   */
  const LAZY_MARGIN_PX = 1200;

  /**
   * 空闲多久才继续翻视口外的内容。
   *
   * 用户滚动时视口内容轮不到队首就被抢走，反而更慢；
   * 停下来 1.2 秒说明他在读，这时再补后面的。
   */
  const LAZY_IDLE_MS = 1200;

  /** 滚动后等多久重算可见集合（滚动是高频率事件，不能每帧都算）。 */
  const SCROLL_DEBOUNCE_MS = 120;

  /** 动态内容防抖。 */
  const MUTATION_DEBOUNCE_MS = 300;

  /** 自动翻译前的等待，等首屏内容稳定。 */
  const AUTO_TRANSLATE_DELAY_MS = 800;

  /**
   * 单个单元送翻的字符上限。
   *
   * 超过就按句子切成多片分别翻、按序拼回——Google 批量端点能吞长文本，
   * 但 MyMemory（450）和 Lingva（600）不能，长段落落在降级链上会整段失败。
   * 1200 是权衡：小于大多数引擎的硬上限，又不会把段落切得过碎影响上下文。
   */
  const MAX_UNIT_CHARS = 1200;

  /**
   * 等待一段时间。
   * @param {number} ms 毫秒
   * @return {Promise<void>} 完成
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /** 占位符 token：<0>…</0> 成对，或 <0/> 自闭合。 */
  const PLACEHOLDER_TOKEN = /<(\d+)(\/)?>|<\/(\d+)>/g;

  /**
   * 把各片译文拼回整段。
   *
   * 中文、日文这类不用空格分词的语言直接相连；
   * 拉丁字母语言之间补一个空格，防止 `sentence.Next` 这种粘连。
   * @param {string[]} slices 按序译文片段
   * @return {string} 拼接结果
   */
  function joinSlices(slices) {
    const CJK = /^[\u3000-\u9fff\uf900-\ufaff\uff00-\uffef]/;
    let out = "";
    for (const slice of slices) {
      if (!slice) continue;
      if (!out) out = slice;
      else if (CJK.test(slice) || CJK.test(out.slice(-1))) out += slice;
      else out += " " + slice;
    }
    return out;
  }

  /**
   * 把长文本切成不超过 maxChars 的片，且**绝不切开占位符**。
   *
   * 占位符是给引擎的结构标记，`<0>` 和 `</0>` 分到两片里，
   * 引擎会各自当成残片丢掉，译文回来校验必然失败。
   * 所以切点只在「不在任何 <n>…</n> 内部」的句子边界上。
   * @param {string} text 待切分文本
   * @param {number} maxChars 单片上限
   * @return {string[]} 片段（拼接后与原文等价，只多了连接空格）
   */
  function splitForEngine(text, maxChars) {
    if (!text || text.length <= maxChars) return text ? [text] : [];

    const sentences = text.split(/(?<=[.!?。！？；;])\s*/);
    const parts = [];
    let current = "";
    let depth = 0;

    for (const sentence of sentences) {
      // 只有不在占位符内部时，才允许在这里断开
      const safeToBreak = depth === 0;
      if (safeToBreak && current && current.length + sentence.length + 1 > maxChars) {
        parts.push(current);
        current = sentence;
      } else {
        current = current ? `${current} ${sentence}` : sentence;
      }

      PLACEHOLDER_TOKEN.lastIndex = 0;
      for (const m of sentence.matchAll(PLACEHOLDER_TOKEN)) {
        if (m[3] !== undefined) depth = Math.max(0, depth - 1);
        else if (m[2] === undefined) depth++;
      }
    }
    if (current) parts.push(current);

    // 兜底：某个 <n>…</n> 自身就超过上限，说明里面是一大段无标点长文本。
    // 这时按硬长度切，残片里的占位符会在合并阶段补回，总比整段失败好。
    return parts.flatMap(part => {
      if (part.length <= maxChars) return [part];
      const out = [];
      for (let i = 0; i < part.length; i += maxChars) out.push(part.slice(i, i + maxChars));
      return out;
    });
  }

  const controller = {
    /** @type {'idle'|'translating'|'translated'} */
    state: "idle",
    /** @type {Array<Object>} */
    units: [],
    /** @type {?Object} */
    settings: null,
    /** @type {?string} */
    lastError: null,
    /** @type {boolean} */
    degraded: false,
    /** @type {?number} */
    mutationTimer: null,
    /** @type {boolean} */
    observerSuppressed: false,
    /** @type {Array<{element: Element, attr: string, text: string}>} 待翻译的属性文本 */
    attributeEntries: [],
    /** @type {Array<{element: Element, attr: string, value: string}>} 已改写属性的原值 */
    savedAttrText: [],
    /** @type {boolean} 正在还原：用于让翻译循环立刻停下 */
    restoring: false,
    /** @type {?MutationObserver} */
    observer: null,
    /** @type {?HTMLElement} */
    indicator: null,

    /**
     * 读取设置（带缓存）。
     * @return {Promise<Object>} 设置
     */
    async loadSettings() {
      if (this.settings) return this.settings;
      const response = await sendMessage({ action: "getSettings" });
      this.settings = (response && response.settings) || {
        targetLanguage: "zh-CN",
        sourceLanguage: "auto",
        engine: "google",
        autoTranslate: false,
      };
      return this.settings;
    },

    /**
     * 设置失效（后台设置变更时调用）。
     */
    invalidateSettings() {
      this.settings = null;
    },

    /**
     * 翻译整页。
     * @return {Promise<Object>} 结果
     */
    async translatePage() {
      if (this.state === "translating") return { success: false, count: 0, error: "正在翻译中" };

      const settings = await this.loadSettings();
      const target = settings.targetLanguage;

      // 黑名单站点：不翻译。企业后台/银行/登录页的语义不能被机器翻译破坏。
      if (BLACKLIST && BLACKLIST.isBlocked(location.href, settings.blacklist)) {
        this.lastError = "当前站点在不翻译名单里（设置 → 翻译偏好）";
        return { success: false, count: 0, error: this.lastError };
      }

      // 页面已是目标语言时不必再翻，避免中文页面翻成中文。
      // lang 属性经常缺失（国内站点尤其），所以除 lang 外再看正文的汉字占比。
      const targetIsChinese = target.toLowerCase().indexOf("zh") === 0;
      if (targetIsChinese) {
        const body = document.body;
        const sample = body ? String(body.innerText || body.textContent || "").slice(0, 2000) : "";
        const alreadyChinese = DOM.isPageAlreadyTarget(target) || DOM.hanRatio(sample) >= 0.5;
        if (alreadyChinese && sample && DOM.containsHanText(sample)) {
          this.lastError = "页面已经是中文，无需翻译";
          return { success: false, count: 0, error: this.lastError };
        }
      }

      if (this.state === "translated") this.restorePage();

      this.state = "translating";
      this.lastError = null;
      this.degraded = false;
      this.startedAt = Date.now();
      this.showIndicator("翻译中…");

      try {
        // 自定义引擎（DeepLX/OpenAI 等）是纯文本接口，<0> 会被当 HTML 剥掉；
        // brace {{n}} 是普通文本 token，实测各家引擎都能原样保留并随语序重排。
        const placeholderMode = settings.engine === "custom" ? "brace" : "tag";
        this.placeholderMode = placeholderMode;
        this.applyTranslatedStyle(settings.translatedStyle);
        this.units = DOM.collectUnits(document.body, placeholderMode);
        if (this.units.length === 0) {
          this.state = "idle";
          this.hideIndicator();
          this.lastError = "页面没有可翻译的文本";
          return { success: false, count: 0, error: this.lastError };
        }

        // 按单元剔除已是目标语言的段落。
        // 整页判断不可靠：GitHub 这类页面 lang="en"，但 README 正文是中文，
        // 一刀切会把「中文翻成中文」，产出「功能特性 → 好吃」这种荒谬结果。
        // 属性文本（title / alt / aria-label / placeholder）单独走一遍：
        // 它们不在正文里，单元采集根本碰不到。全页维度，和单元过滤互不影响。
        this.attributeEntries = DOM.collectAttributeTexts(document.body, target);

        const beforeFilter = this.units.length;
        this.units = this.filterAlreadyTarget(this.units, target);
        if (this.units.length === 0) {
          this.state = "idle";
          this.hideIndicator();
          this.lastError = "页面内容已经是目标语言，无需翻译";
          return { success: false, count: 0, error: this.lastError };
        }
        if (this.units.length < beforeFilter) {
          this.skippedCount = beforeFilter - this.units.length;
        }

        // 端侧优先；不支持或模型未就绪时立刻回落在线引擎，绝不干等。
        const from = settings.sourceLanguage || "auto";
        let applied = 0;

        if (settings.useOffline !== "off" && OFFLINE && OFFLINE.supported) {
          // 给端侧 1.2 秒：模型已缓存时几乎立即返回；需要下载时先走在线引擎
          const quick = await Promise.race([
            OFFLINE.warmup(from, target).then(ok => ({ ok })),
            new Promise(resolve => setTimeout(() => resolve({ ok: false, pending: true }), 1200)),
          ]);

          if (quick.ok) {
            applied = await this.translateOffline(this.units, from, target);
          } else if (quick.pending) {
            this.showIndicator("翻译中…（端侧模型准备中，先用在线引擎）");
          }
        }

        const remaining = this.units.filter(unit => !unit.translated);
        let failedCount = 0;
        if (remaining.length > 0) {
          applied += await this.translateUnits(remaining, target, { lazy: settings.lazyTranslate !== "off" });
          // 重试后仍然失败的段数：必须如实上报，不能让「翻了一半」冒充「翻译完成」
          failedCount = this.failedCount || 0;
          this.failedCount = 0;
        }

        // 属性文本：正文翻完再补一轮，复用同一批引擎与缓存。
        // 失败不影整体结果——tooltip 翻不了不该让整页判定为失败。
        if (this.attributeEntries.length > 0) {
          try {
            await this.translateAttributes(from, target);
          } catch {
            // 属性翻译失败静默降级，正文译文保留
          }
        }
        this.hideIndicator();

        if (applied === 0) {
          this.state = "idle";
          this.hideIndicator();
          // 一段都没翻成：要把「失败了多少段」也报出去，
          // 否则用户只看到「翻译失败」，不知道是整页没翻还是翻了一半。
          return {
            success: false,
            count: 0,
            failed: failedCount || this.units.length,
            error: this.lastError || "翻译失败",
          };
        }

        this.state = "translated";
        this.attachObserver();
        const elapsed = Math.max(1, Date.now() - this.startedAt);

        // 有段落没翻成时必须说出来。
        // 旧实现只要 applied > 0 就报 success: true、显示「翻译完成」，
        // 用户看着半页英文找不到原因（真机实测 240 段里只成功 155 段）。
        // 弹窗据此提示「重新翻译」，用户能自己重试补齐。
        if (failedCount > 0) {
          const total = applied + failedCount;
          this.lastError = `有 ${failedCount} 段未翻译（共 ${total} 段），多为引擎限流或网络波动，可点「重新翻译」补齐`;
          this.showIndicator(`已翻译 ${applied}/${total} 段 · 剩余 ${failedCount} 段失败`, true);
          setTimeout(() => this.hideIndicator(), 5000);
          return { success: true, count: applied, elapsed, failed: failedCount, error: this.lastError };
        }

        this.showIndicator(`已翻译 ${applied} 段 · ${(applied / (elapsed / 1000)).toFixed(1)} 段/秒`, true);
        setTimeout(() => this.hideIndicator(), 2500);
        return { success: true, count: applied, elapsed };
      } catch (error) {
        this.state = "idle";
        this.hideIndicator();
        this.lastError = error.message || String(error);
        return { success: false, count: 0, error: this.lastError };
      }
    },

    /**
     * 翻译属性文本（title / alt / aria-label / placeholder）。
     *
     * 属性与正文共用同一批文本管道：去重后一次性送翻，回来后 setAttribute。
     * 原文映射保留在 this.savedAttrText 里，还原时逐条写回。
     * @param {string} from 源语言
     * @param {string} to 目标语言
     * @return {Promise<number>} 应用数量
     */
    async translateAttributes(from, to) {
      const entries = this.attributeEntries || [];
      if (entries.length === 0) return 0;

      const texts = entries.map(entry => entry.text);
      let results;
      try {
        // 注意 action 名必须是 translateBatch（见 service-worker 的 handlers 表），
        // 写错会静默返回 {ok:false, error:"未知动作"}，属性一个都翻不了。
        results = await sendMessage({
          action: "translateBatch",
          texts: texts,
          sourceLanguage: from,
          targetLanguage: to,
        });
      } catch {
        return 0;
      }
      if (!results || !Array.isArray(results.results)) return 0;

      const map = new Map();
      texts.forEach((text, index) => {
        const translated = results.results[index];
        if (typeof translated === "string" && translated.trim() && translated !== text) {
          map.set(text, translated);
        }
      });
      if (map.size === 0) return 0;

      if (!this.savedAttrText) this.savedAttrText = [];
      const applied = DOM.applyAttributeTexts(entries, map, this.savedAttrText);
      this.state = this.state === "translated" ? "translated" : this.state;
      return applied;
    },

    /**
     * 按设置注入译文样式：视觉上区分译文与原文，
     * 直接用 [data-tp-translated] 属性选择器，不改 DOM 结构。
     * @param {string} style "none" | "underline" | "highlight"
     * @return {void}
     */
    applyTranslatedStyle(style) {
      const id = "tp-translated-style";
      const existing = document.getElementById(id);
      if (existing) existing.remove();

      const rules = {
        underline: "text-decoration: underline; text-decoration-color: #9aa4ff; text-underline-offset: 3px;",
        highlight: "background: rgba(122,162,255,.16); border-radius: 3px; padding: 0 2px;",
      };
      const rule = rules[style];
      if (!rule) return; // none：不打任何标记

      const el = document.createElement("style");
      el.id = id;
      el.textContent = `[data-tp-translated]:not([data-tp-translated=""]) { ${rule} }`;
      document.documentElement.appendChild(el);
    },

    /**
     * 批量翻译单元并应用译文。
     * @param {Array<Object>} units 单元
     * @param {string} target 目标语言
     * @return {Promise<number>} 成功应用的数量
     */
    /**
     * 端侧优先翻译：完全离线，不受 429 影响。
     * 全页都成功时直接返回，跳过任何网络请求。
     * @param {Array<Object>} units 单元
     * @param {string} from 源语言
     * @param {string} target 目标语言
     * @return {Promise<number>} 成功应用的数量
     */
    /**
     * 剔除已经是目标语言的单元。
     *
     * 为什么按单元而不是整页：页面常常中英混排（README 中文 + 界面英文）。
     * 整页一刀切要么全不翻、要么把中文再翻一遍。
     * @param {Array<Object>} units 单元
     * @param {string} target 目标语言
     * @return {Array<Object>} 需要翻译的单元
     */
    filterAlreadyTarget(units, target) {
      if (String(target).toLowerCase().indexOf("zh") !== 0) return units;

      return units.filter(unit => {
        const text = String(unit.plainText || unit.text || "").trim();
        if (!text) return false;
        // 汉字占比够高即认定已是中文，不再送去「翻译成中文」
        return DOM.hanRatio(text) < 0.3;
      });
    },

    /**
     * 端侧翻译：只处理模型已就绪的情况。
     * @param {Array<Object>} units 单元
     * @param {string} from 源语言
     * @param {string} target 目标语言
     * @return {Promise<number>} 已应用数量
     */
    async translateOffline(units, from, target) {
      if (!OFFLINE || !OFFLINE.supported) return 0;

      let applied = 0;
      const BATCH = 20;
      for (let offset = 0; offset < units.length; offset += BATCH) {
        const batch = units.slice(offset, offset + BATCH);
        const texts = batch.map(unit => unit.plainText || unit.text);
        let results;
        try {
          results = await OFFLINE.translate(texts, from, target);
        } catch {
          break; // 端侧失败：剩下的交给在线引擎
        }
        results.forEach((result, index) => {
          const unit = batch[index];
          if (!unit || !result) return;
          // 端侧返回整段译文：只写一次，避免多文本节点重复
          if (unit.applyWholeText(result.text)) {
            applied++;
          }
        });
        this.showIndicator("翻译中… " + applied + "/" + units.length, true);
      }
      return applied;
    },

    /**
     * 批量翻译并就地应用译文。
     * @param {Array<Object>} units 待翻单元
     * @param {string} target 目标语言
     * @param {{lazy?: boolean}} [options] lazy=true 时开启滚动翻译（默认开启）
     * @return {Promise<number>} 应用数量
     */
    async translateUnits(units, target, options = {}) {
      const lazy = options.lazy !== false;
      let applied = 0;
      const pending = units.slice();
      const order = new Map(units.map((unit, index) => [unit, index]));

      // 视口优先：先翻当前屏幕内的内容，滚动时新进入视野的单元插到队首。
      // 没有这一步，用户要等整页（几百个单元）翻完才看到第一屏译文。
      const visible = new Set();
      const syncVisible = subset => {
        if (typeof window !== "undefined" && !window.innerHeight) return;
        const height = window.innerHeight || 800;
        for (const unit of subset) {
          const element = unit.element;
          if (!element || typeof element.getBoundingClientRect !== "function") continue;
          const rect = element.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.bottom > -height * 0.5 && rect.top < height * 1.5) visible.add(unit);
        }
      };
      syncVisible(pending);

      let observer = null;
      if (typeof IntersectionObserver === "function") {
        observer = new IntersectionObserver(
          entries => {
            for (const entry of entries) {
              const unit = entry.target.__tpUnit;
              if (!unit) continue;
              if (entry.isIntersecting) visible.add(unit);
              else visible.delete(unit);
            }
          },
          { rootMargin: VIEWPORT_MARGIN }
        );
        for (const unit of units) {
          if (!unit.element) continue;
          unit.element.__tpUnit = unit;
          observer.observe(unit.element);
        }
      }

      const rank = unit => (visible.has(unit) ? 0 : 1);

      // 滚动翻译的分界：LAZY_MARGIN_PX 以内立刻翻，以外挂着等滚动。
      // 旧实现只排序不清空，整页照样一次翻完——用户滚到一半时
      // 后台还在替看不见的段落烧配额，滚到哪里都感觉慢。
      /** 用户停手够久后进入兜底：不再按视口裁剪，把剩下的全部翻完 */
      let draining = false;
      const readyNow = unit => {
        // 关闭滚动翻译 / 已进入兜底：一次翻完整页，不做视口裁剪
        if (!lazy || draining) return true;
        const element = unit && unit.element;
        if (!element || typeof element.getBoundingClientRect !== "function") return true;
        const rect = element.getBoundingClientRect();
        // 无布局信息（离屏采集、jsdom）时一律放行，绝不能把内容卡死在队列里
        if (rect.width === 0 && rect.height === 0) return true;
        const height = (typeof window !== "undefined" && window.innerHeight) || 800;
        const margin = Math.max(LAZY_MARGIN_PX, height);
        return rect.bottom > -margin && rect.top < height + margin;
      };

      // 用户是否正在滚动：滚动中只翻视口附近，停手后才补远端的
      let scrolling = false;
      // 从「现在」起算，不能是 0：0 会让 idleFor() 恒等于当前时间戳（永远 > LAZY_IDLE_MS
      // 只在几十年前成立），远端单元的空闲唤醒条件永远不满足，翻到一半就停死。
      let lastScrollAt = Date.now();
      let scrollTimer = null;
      const onScroll = () => {
        scrolling = true;
        lastScrollAt = Date.now();
        if (scrollTimer !== null) clearTimeout(scrollTimer);
        scrollTimer = setTimeout(() => {
          scrollTimer = null;
          scrolling = false;
        }, SCROLL_DEBOUNCE_MS);
      };
      const canLazy = typeof window !== "undefined" && typeof window.addEventListener === "function";
      if (canLazy) window.addEventListener("scroll", onScroll, { passive: true });

      /** 远端单元（视口外且超出 LAZY_MARGIN_PX），等滚动或等空闲再翻 */
      let deferred = [];
      /** 请求失败的单元：循环结束后重试一轮，不能静默丢弃 */
      const failed = [];
      /** 连续失败批次数：达到上限就收工，不在限流上死磕 */
      let consecutiveFails = 0;
      const idleFor = () => Date.now() - lastScrollAt;

      /**
       * 为「等滚动」设绝对上限。
       *
       * 用户可能一直在滚动（sticky 头、懒加载图片、触摸惯性、视频页面），
       * 光看 scroll 事件就永远等不到空闲。没有这个上限，远端单元会一直挂在
       * deferred 里：页面明明翻完了，弹窗却永远显示「翻译中…172/172」，
       * 「显示原文」也点不动（state 卡在 translating）。
       * 到点就强制 draining，把剩下的翻完——滚动继续也不会再拦。
       */
      // 2 秒而不是更久：用户滚动时视口内容已经翻了，远端他看不到，
      // 早补晚补无所谓——但「翻译中」这个状态不该挂太久，那正是用户
      // 抱怨的「翻完一直显示翻译中」。
      const LAZY_HARD_LIMIT_MS = 2000;
      /** 失败批次重试前的等待：限流通常是几秒的窗口，太短没意义，太长用户等不起 */
      const RETRY_AFTER_FAIL_MS = 3000;
      /** 连续失败多少批就停手：连输 3 次说明是限流/断网，继续打只会更糟 */
      const MAX_CONSECUTIVE_FAILS = 3;
      const lazyStartedAt = Date.now();

      try {
        // 退出条件必须包含「队列真的空了」。
        // 旧实现写的是 while (pending.length > 0)，本身就有这个出口；
        // 改成只判 state 之后，一旦用户持续滚动（sticky 头、懒加载图片、
        // 页面本身在动），idleFor() 永远重置，pending 空、deferred 非空，
        // 循环就永远不退出 —— 表现是页面已经全部翻完，弹窗却一直显示
        // 「翻译中…172/172」，「显示原文」按钮也点不动（state 还是 translating）。
        while ((pending.length > 0 || deferred.length > 0) && this.state !== "idle" && !this.restoring) {
          if (pending.length === 0) {
            // 视口内暂时没有待翻内容：等用户滚动或等空闲，再唤醒远端单元。
            // 注意 pending 已经没有可翻的了，空转只会烧 CPU，
            // 所以这里要么等到有新内容，要么等到 idle 足够久把远端拉回来。
            if (deferred.length === 0) break;
            // 等用户停手：正在滚动，或者刚停不到 LAZY_IDLE_MS。
            // 硬上限是安全阀——用户可能一直在滚（sticky 头、懒加载图片、
            // 触摸惯性），光靠 scroll 事件永远等不到空闲。到点强制 draining，
            // 否则远端单元会永远挂在 deferred 里，弹窗一直显示「翻译中」。
            const hitHardLimit = Date.now() - lazyStartedAt > LAZY_HARD_LIMIT_MS;
            if (!hitHardLimit && (scrolling || idleFor() < LAZY_IDLE_MS)) {
              await delay(SCROLL_DEBOUNCE_MS);
              // 重新结算：可能用户已经滚到远端区域了
              const back = [];
              const stillFar = [];
              for (const unit of deferred) (readyNow(unit) ? back : stillFar).push(unit);
              deferred = stillFar;
              pending.push(...back);
              continue;
            }
            // 用户停下来了：把远端单元一次性拉回来翻完。
            // 必须同时置 draining —— 否则下一轮 readyNow 又按视口把它们判回
            // 「不 ready」，推回 deferred，形成永远补不上的死循环
            // （远端段落本来就在视口外，等到天荒地老也不会变 ready）。
            draining = true;
            pending.push(...deferred);
            deferred = [];
            syncVisible(pending);
          }

          // 每轮按当前视口结算：视口内/附近的进本轮队列，其余留到 deferred
          const ready = [];
          const notReady = [];
          for (const unit of pending) (readyNow(unit) ? ready : notReady).push(unit);
          if (notReady.length > 0) {
            deferred.push(...notReady);
            pending.splice(0, pending.length, ...ready);
          }
          if (pending.length === 0) {
            // 这一轮全是远端。必须让出一次事件循环，否则 while 立刻回到顶部、
            // 再次走到这里，形成不带 await 的忙循环，把主线程烧干。
            await delay(SCROLL_DEBOUNCE_MS);
            continue;
          }

          // 每轮重排：用户滚到哪，哪里的内容就先翻
          pending.sort((a, b) => rank(a) - rank(b) || order.get(a) - order.get(b));
          const batch = pending.splice(0, UNIT_BATCH_SIZE);

          // 长单元切成多片再送：单条 3000 字的长段落直接发给 MyMemory（上限 450）
          // 必然失败，降级链一路走到最后，用户看到「一直失败」。
          // 切分感知占位符，绝不把 <0>…</0> 拆到两片里。
          const requests = [];
          const plan = batch.map(unit => {
            const parts = splitForEngine(unit.text, MAX_UNIT_CHARS);
            const start = requests.length;
            requests.push(...parts);
            return { unit, start, count: parts.length };
          });

          const response = await sendMessage({
            action: "translateBatch",
            texts: requests,
            targetLanguage: target,
          });

          if (response && response.degraded) {
            this.degraded = true;
            this.lastError = response.error || this.lastError;
          }

          if (!response || !response.ok) {
            if (!this.lastError) this.lastError = (response && response.error) || "翻译请求失败";
            // 失败批次不能就这么丢掉：用户看到的会是「翻译完成，但一半还是英文」。
            // 收进 failed，循环结束后统一重试一轮——限流往往是短窗口，
            // 隔一会儿再打一次能捞回不少（真机实测 429 之后 3 秒重试成功率高）。
            failed.push(...batch);
            // 连续失败就早点收工：引擎被限流时死磕下去只会让用户干等
            // （真机实测 200 段连续 429 时白等 103 秒）。剩下的原样报给用户，
            // 他们可以过一会儿点「重新翻译」。
            consecutiveFails++;
            if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
              this.lastError = `引擎连续 ${consecutiveFails} 次拒绝请求（多为限流），已暂停翻译`;
              failed.push(...pending);
              pending.length = 0;
              deferred.length = 0;
              break;
            }
            continue;
          }
          consecutiveFails = 0;

          const results = response.results || [];
          const whole = [];
          const fallback = [];
          plan.forEach(item => {
            const unit = item.unit;
            // 把该单元的各片译文按序拼回一条：分片只是为了绕过单条上限，
            // 还原阶段仍按「一个单元一份译文」处理，占位符校验照旧。
            const slices = [];
            for (let k = 0; k < item.count; k++) {
              const piece = results[item.start + k];
              if (!piece || typeof piece.text !== "string") break;
              slices.push(piece.text);
            }
            if (slices.length !== item.count) return;
            const result = { text: joinSlices(slices) };
            // brace 模式优先原子还原；失败再回落 tag 严格还原
            if (unit.braceMap && unit.braceMap.size > 0 && unit.applyBrace(result.text)) {
              applied++;
              return;
            }
            if (unit.apply(result.text)) {
              applied++;
              return;
            }
            // 分片拼回来校验不过，说明切点落在占位符内部（占位符里塞了超长文本，
            // 数学上无法避免）。这时先重试一次「整段原样送翻」：Google 这类端点
            // 能吞下几千字符，整段送往往一次就过，比降级纯文本保留更多结构。
            if (item.count > 1) {
              whole.push(unit);
              return;
            }
            // 占位符被引擎吞掉/破坏：改用「整段纯文本」重发一次，
            // 拿到整段译文后只写进第一个文本节点，其余清空——
            // 这样既保住标签与样式，也不会把同一段话重复贴 N 遍。
            if (unit.plainText) fallback.push({ unit, text: unit.plainText });
          });

          // 分片失败的长单元：整段原样重发一次
          if (whole.length > 0) {
            try {
              const retry = await sendMessage({
                action: "translateBatch",
                texts: whole.map(unit => unit.text),
                targetLanguage: target,
              });
              if (retry && retry.ok) {
                retry.results.forEach((result, index) => {
                  const unit = whole[index];
                  if (unit && result && unit.apply(result.text)) {
                    applied++;
                  }
                });
              }
            } catch {
              // 整段也不行，交给下面的纯文本降级
            }
            // 整段重发仍没翻译成功的，退回纯文本降级
            for (const unit of whole) {
              if (!unit.translated && unit.plainText) fallback.push({ unit, text: unit.plainText });
            }
          }

          if (fallback.length > 0) {
            try {
              const retry = await sendMessage({
                action: "translateBatch",
                texts: fallback.map(item => item.text),
                targetLanguage: target,
              });
              if (retry && retry.ok) {
                (retry.results || []).forEach((result, index) => {
                  const item = fallback[index];
                  if (!item || !result) return;
                  if (item.unit.applyWholeText(result.text)) {
                    applied++;
                  }
                });
              }
            } catch {
              // 降级也失败就保留原文，绝不破坏页面
            }
          }

          this.showIndicator("翻译中… " + applied + "/" + units.length, true);
        }

        // 失败批次重试一轮。
        // 真机实测：免费引擎一次送 200 条会 429，但那只是短窗口限流——
        // 隔 3 秒再来一次往往就过了。旧实现把失败批次直接丢掉，
        // 用户看到的是「翻译完成，可页面还有一半是英文」。
        if (failed.length > 0 && this.state !== "idle" && !this.restoring) {
          await delay(RETRY_AFTER_FAIL_MS);
          this.showIndicator("重试未完成的段落…", true);
          const retryPool = failed.slice();
          failed.length = 0;
          while (retryPool.length > 0 && this.state !== "idle" && !this.restoring) {
            const batch = retryPool.splice(0, UNIT_BATCH_SIZE);
            const requests = [];
            const plan = batch.map(unit => {
              const parts = splitForEngine(unit.text, MAX_UNIT_CHARS);
              const start = requests.length;
              requests.push(...parts);
              return { unit, start, count: parts.length };
            });
            let response = null;
            try {
              response = await sendMessage({
                action: "translateBatch",
                texts: requests,
                targetLanguage: target,
              });
            } catch {
              response = null;
            }
            if (!response || !response.ok) {
              // 还是不行：剩下的交回 failed，由调用方如实汇报「仅 N/M 段」
              failed.push(...batch, ...retryPool);
              break;
            }
            const results = response.results || [];
            plan.forEach(item => {
              const slices = [];
              for (let k = 0; k < item.count; k++) {
                const piece = results[item.start + k];
                if (!piece || typeof piece.text !== "string") break;
                slices.push(piece.text);
              }
              if (slices.length !== item.count) return;
              const text = joinSlices(slices);
              const unit = item.unit;
              if (unit.braceMap && unit.braceMap.size > 0 && unit.applyBrace(text)) {
                applied++;
                return;
              }
              if (unit.apply(text)) applied++;
              else if (unit.plainText && unit.applyWholeText(text)) applied++;
            });
            this.showIndicator("翻译中… " + applied + "/" + units.length, true);
          }
        }
      } finally {
        if (observer) observer.disconnect();
        if (canLazy) window.removeEventListener("scroll", onScroll);
        if (scrollTimer !== null) clearTimeout(scrollTimer);
        for (const unit of units) {
          if (unit.element) delete unit.element.__tpUnit;
        }
      }

      // 还失败的留给调用方上报：不能把「翻了一半」说成「翻译完成」
      this.failedCount = failed.length;
      return applied;
    },

    /**
     * 恢复原始页面。
     * @return {Object} 恢复结果
     */
    restorePage() {
      this.restoring = true;
      this.suppressMutations(true);
      this.detachObserver();

      let restored = 0;
      // 逆序恢复：浅层单元先于其块级子单元恢复，避免互相覆盖
      for (let index = this.units.length - 1; index >= 0; index--) {
        if (this.units[index].restore()) restored++;
      }

      // 属性文本单独还原：单元里没有它们的位置
      if (this.savedAttrText && this.savedAttrText.length > 0) {
        DOM.restoreAttributeTexts(this.savedAttrText);
        this.savedAttrText = [];
      }
      this.attributeEntries = [];

      this.units = [];
      this.state = "idle";
      this.lastError = null;
      this.degraded = false;
      this.hideIndicator();
      this.suppressMutations(false);
      this.restoring = false;
      return { success: true, count: restored };
    },

    /**
     * 翻译新增的动态内容。
     * @param {Array<Element>} roots 新增根节点
     * @return {Promise<void>}
     */
    async translateNewContent(roots) {
      if (this.state !== "translated") return;

      const settings = await this.loadSettings();
      if (!settings) return;

      // 同一批几百条记录里，同一个根节点会被重复 push，
      // 去重既省采集开销，也避免把同一段文本排进两次队列。
      const uniqueRoots = [];
      const seenRoots = new Set();
      for (const root of roots) {
        if (!root || root.nodeType !== 1 || seenRoots.has(root)) continue;
        seenRoots.add(root);
        uniqueRoots.push(root);
      }

      // 已被我们接管、又被框架改写过原文的元素：旧单元已经失效
      // （它保存的译文和当前 DOM 对不上，restore 时会因为指纹不符自行放弃），
      // 留在 units 里只会让数组无限膨胀。先摘掉，再用新内容重新立单元。
      const takenElements = new Set(this.units.map(unit => unit.element).filter(Boolean));

      // 元素带着 data-tp-translated，但文本已经被框架换掉了（或元素已被路由切走）：
      // 标记过期，旧单元保存的译文与当前 DOM 对不上。
      // 不清掉标记的话，DOM.collectUnits 会把整个元素当「已是译文」跳过，
      // 结果就是 SPA 重渲染后这块内容永远不再翻译。
      this.releaseStaleUnits();

      const fresh = [];
      const freshElements = new Set();
      for (const root of uniqueRoots) {
        // 已翻译容器里新插入的内容不能当独立单元重翻：
        // 否则 `<p data-tp-translated>译文<span>新增</span></p>` 会把
        // 已翻译的父元素和新节点混在一起二次送翻，译文叠成两层。
        // 已翻译容器的内部（不是容器本身）直接跳过
        if (root.parentElement && root.parentElement.closest("[data-tp-translated]")) continue;
        const found = DOM.collectUnits(root, this.placeholderMode);
        for (const unit of found) {
          if (unit.translated) continue;
          // 最近一轮已经给这个元素立过单元：框架反复触发 observer 时
          // 不重复排队，防止同一段文本被翻两遍、译文中途闪回原文。
          if (freshElements.has(unit.element)) continue;
          // 整段已是目标语言（中文页面里的中文段落）不再送翻
          if (this.filterAlreadyTarget([unit], settings.targetLanguage).length === 0) continue;
          freshElements.add(unit.element);
          fresh.push(unit);
        }
      }
      if (fresh.length === 0) return;

      // 失效旧单元下线：元素已被重新立单元，旧对象不再参与 restore
      if (takenElements.size > 0) {
        const revived = new Set(fresh.map(unit => unit.element));
        this.units = this.units.filter(unit => {
          if (!revived.has(unit.element)) return true;
          if (unit.release) unit.release();
          return false;
        });
      }

      this.units.push(...fresh);
      if (OFFLINE && OFFLINE.supported) {
        // 端侧能翻就先翻，剩下的交给在线引擎
        await this.translateOffline(fresh, settings.sourceLanguage || "auto", settings.targetLanguage);
      }
      const remaining = fresh.filter(unit => !unit.translated);
      if (remaining.length > 0) {
        await this.translateUnits(remaining, settings.targetLanguage, { lazy: settings.lazyTranslate !== "off" });
      }
    },

    /**
     * 回收已经失效的单元。
     *
     * 两种失效：框架把译文换回了原文（文本指纹不符），
     * 或者路由切换把元素整个带走了（元素游离）。
     * 都走 release()：摘标记、还原属性、不再参与 restore。
     * @return {number} 回收数量
     */
    releaseStaleUnits() {
      if (this.units.length === 0) return 0;
      let released = 0;
      const kept = [];
      for (const unit of this.units) {
        if (unit.isStale && unit.isStale()) {
          if (unit.release) unit.release();
          released++;
          continue;
        }
        kept.push(unit);
      }
      if (released > 0) this.units = kept;
      return released;
    },

    /**
     * 这个元素最近是不是被我们自己写过。
     *
     * 只看元素自己（不看祖先）：我们写的是单元元素本身的文本，
     * 而框架改写时打的也是同一个元素，必须靠时间区分而不是靠标记。
     * @param {?Element} element 元素
     * @return {boolean} true 表示是自身写入的残影
     */
    writtenRecently(element) {
      if (!element) return false;
      // 我们写的译文原样还在 → 这条记录是「自己写进去」的回声，必须忽略，
      // 否则中文被当成原文再翻一遍，产出「译[译[译[...]]]」套娃。
      // 文本已经变了 → 是框架覆盖的，交给 translateNewContent 处理。
      //
      // 不能用纯时间窗口：MutationObserver 记录在微任务里送达，
      // 时机不受我们控制；也不能只看标记，框架改写时标记还挂着。
      const unit = this.units.find(item => item.element === element);
      if (!unit) return false;
      return !(unit.isStale && unit.isStale());
    },

    /**
     * 启动动态内容观察。
     */
    attachObserver() {
      if (this.observer) return;
      const self = this;
      this.observer = new MutationObserver(records => {
        const roots = [];
        for (const record of records) {
          // 1) 新增节点：按元素收集根
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) {
              roots.push(/** @type {Element} */ (node));
            } else if (node.nodeType === 3 && node.parentElement) {
              // React/Vue 用 textContent 赋值时，节点被整体替换成新的文本节点：
              // 新节点是 Text 不是 Element，只收 Element 会把这次更新整个漏掉。
              //
              // 但要排除自己的回声：我们写入译文同样会替换文本节点，
              // 再采一次会把中文当原文翻译，翻成「译[译[译[...]]]」套娃。
              //
              // 不能用 data-tp-translated 判断：框架改写文本时标记仍然挂着，
              // 那样会把真正的更新一起吞掉。改看「这本元素是不是刚被自己写过」。
              const parent = node.parentElement;
              if (!self.writtenRecently(parent)) roots.push(parent);
            }
          }
          // 2) 文本节点变化：React/Vue 只改 textContent 时**不会**产生 childList 记录，
          //    只监听 childList 等于「动态页面的文本永远不翻」（实测 GitHub 的
          //    实时刷新、SPA 路由切换后的标题全部漏翻）。取最近的可翻译祖先作为根。
          if (record.type === "characterData" && record.target && record.target.nodeType === 3) {
            const parent = record.target.parentElement;
            // 引擎自己写入的回声不算新内容
            if (parent && !self.writtenRecently(parent)) roots.push(parent);
          }
        }
        // 3) 已失效的旧单元先回收，与有没有新内容无关。
        //    SPA 路由切到一个没有文字的页面时 roots 是空的，
        //    但上一页留下的单元全都指向游离节点，必须在这里清掉。
        //    放在 translateNewContent 之外：它开头就 `state !== "translated"` 直接返回。
        if (self.state === "translated") self.releaseStaleUnits();

        if (roots.length === 0) return;

        if (self.mutationTimer !== null) clearTimeout(self.mutationTimer);
        self.mutationTimer = window.setTimeout(() => {
          self.mutationTimer = null;
          self.translateNewContent(roots).catch(() => {});
        }, MUTATION_DEBOUNCE_MS);
      });
      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    },

    /**
     * 停止观察。
     */
    detachObserver() {
      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }
      if (this.mutationTimer !== null) {
        clearTimeout(this.mutationTimer);
        this.mutationTimer = null;
      }
    },

    /**
     * 自身改写 DOM 期间抑制观察回调，防止无限自触发。
     * @param {boolean} enabled 是否抑制
     */
    suppressMutations(enabled) {
      this.observerSuppressed = enabled;
    },

    /**
     * 状态快照。
     * @return {Object} 状态
     */
    getStatus() {
      // 游离单元数：路由切走后没能回收的会一直挂着，是内存泄漏的唯一观测点，
      // 暴露出来既方便弹窗诊断，也让回归测试能直接断言它必须是 0。
      let detached = 0;
      for (const unit of this.units) {
        if (unit.element && unit.element.isConnected === false) detached++;
      }
      return {
        state: this.state,
        count: this.units.length,
        detached,
        degraded: this.degraded,
        offline: Boolean(OFFLINE && OFFLINE.supported),
        error: this.lastError,
      };
    },

    /**
     * 显示右下角状态指示器。
     * @param {string} text 文本
     * @param {boolean} [persist] 是否保留（仅用于最终结果，短暂停留后淡出）
     */
    showIndicator(text, persist) {
      if (!this.indicator || !this.indicator.isConnected) {
        this.indicator = document.createElement("div");
        this.indicator.style.cssText = [
          "position:fixed",
          "right:16px",
          "bottom:16px",
          "z-index:2147483647",
          "background:rgba(17,24,39,.92)",
          "color:#fff",
          "font:12px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
          "padding:8px 14px",
          "border-radius:999px",
          "box-shadow:0 4px 16px rgba(0,0,0,.28)",
          "pointer-events:none",
          "max-width:70vw",
        ].join(";");
        document.documentElement.appendChild(this.indicator);
      }
      this.indicator.textContent = text;
      this.indicator.style.display = "block";
    },

    /**
     * 隐藏指示器。
     */
    hideIndicator() {
      if (this.indicator) this.indicator.style.display = "none";
    },

    /**
     * 显示选中文本译文浮层（全部用 textContent，杜绝 XSS）。
     * @param {string} original 原文
     * @param {string} translated 译文
     */
    showSelectionPopup(original, translated) {
      const existing = document.getElementById("__tp_popup__");
      if (existing) existing.remove();

      const popup = document.createElement("div");
      popup.id = "__tp_popup__";
      popup.style.cssText = [
        "position:fixed",
        "right:20px",
        "top:20px",
        "width:340px",
        "max-height:70vh",
        "overflow:auto",
        "z-index:2147483647",
        "background:#fff",
        "color:#111827",
        "border-radius:12px",
        "box-shadow:0 12px 40px rgba(0,0,0,.22)",
        "padding:16px",
        "font:14px/1.7 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
      ].join(";");

      const head = document.createElement("div");
      head.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px";
      const title = document.createElement("strong");
      title.textContent = "译文";
      title.style.cssText = "font-size:13px;color:#374151";
      const close = document.createElement("button");
      close.textContent = "×";
      close.setAttribute("aria-label", "关闭");
      close.style.cssText = "border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#9ca3af";
      close.addEventListener("click", () => {
        popup.remove();
      });
      head.appendChild(title);
      head.appendChild(close);

      const body = document.createElement("div");
      body.style.cssText =
        "background:#f0f9ff;border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-word";
      body.textContent = translated;

      const foot = document.createElement("div");
      foot.style.cssText = "font-size:12px;color:#9ca3af;margin-top:10px;white-space:pre-wrap;word-break:break-word";
      foot.textContent = original;

      popup.appendChild(head);
      popup.appendChild(body);
      popup.appendChild(foot);
      document.documentElement.appendChild(popup);

      setTimeout(() => {
        popup.remove();
      }, 12000);
    },
  };

  /**
   * 向 service worker 发消息并等待响应（带超时）。
   * @param {Object} message 消息体
   * @return {Promise<Object>} 响应
   */
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("后台响应超时"));
      }, MESSAGE_TIMEOUT_MS);

      try {
        chrome.runtime.sendMessage(message, response => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message || "消息发送失败"));
            return;
          }
          resolve(response || {});
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  /**
   * 翻译选中的文本。
   * @param {string} text 选中文本
   * @return {Promise<void>}
   */
  async function translateSelection(text) {
    if (!text || !text.trim()) return;
    try {
      const response = await sendMessage({ action: "translateText", text: text });
      if (response && response.ok && response.translatedText) {
        controller.showSelectionPopup(text, response.translatedText);
        return;
      }
      controller.showSelectionPopup(text, (response && response.error) || "翻译失败");
    } catch (error) {
      controller.showSelectionPopup(text, "翻译失败：" + (error.message || error));
    }
  }

  // ---- 消息路由 ----

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const action = message && message.action;

    if (action === "translatePage") {
      // 用户手势窗口内先触发端侧模型下载，真正逐段翻译时就不用等
      if (OFFLINE && OFFLINE.supported) {
        OFFLINE.warmup("en", "zh").catch(() => {});
      }
      controller.translatePage().then(sendResponse);
      return true;
    }
    if (action === "restorePage") {
      sendResponse(controller.restorePage());
      return false;
    }
    if (action === "getStatus") {
      sendResponse(controller.getStatus());
      return false;
    }
    if (action === "translateSelection") {
      translateSelection(message.text);
      sendResponse({ success: true });
      return false;
    }
    if (action === "settingsUpdated") {
      controller.invalidateSettings();
      sendResponse({ success: true });
      return false;
    }
    return false;
  });

  // ---- 自动翻译 ----

  /**
   * 页面就绪后按设置决定是否自动翻译。
   * @return {Promise<void>}
   */
  async function maybeAutoTranslate() {
    const settings = await controller.loadSettings();
    if (!settings.autoTranslate) return;
    if (DOM.isPageAlreadyTarget(settings.targetLanguage)) return;

    const lang = (document.documentElement.lang || "").toLowerCase();
    // 仅对声明为非目标语言的页面自动翻译，避免中文页面反复被翻
    if (lang && lang.split("-")[0] === settings.targetLanguage.split("-")[0]) return;

    setTimeout(() => {
      controller.translatePage().catch(() => {});
    }, AUTO_TRANSLATE_DELAY_MS);
  }

  maybeAutoTranslate().catch(error => {
    console.error("[translate-page] 自动翻译初始化失败", error);
  });
})();
