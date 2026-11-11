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

  /** 动态内容防抖。 */
  const MUTATION_DEBOUNCE_MS = 300;

  /** 自动翻译前的等待，等首屏内容稳定。 */
  const AUTO_TRANSLATE_DELAY_MS = 800;

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
        if (remaining.length > 0) {
          applied += await this.translateUnits(remaining, target);
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
          return { success: false, count: 0, error: this.lastError || "翻译失败" };
        }

        this.state = "translated";
        this.attachObserver();
        const elapsed = Math.max(1, Date.now() - this.startedAt);
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
          if (unit.applyWholeText(result.text)) applied++;
        });
        this.showIndicator("翻译中… " + applied + "/" + units.length, true);
      }
      return applied;
    },

    async translateUnits(units, target) {
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

      try {
        while (pending.length > 0 && this.state !== "idle" && !this.restoring) {
          // 每轮重排：用户滚到哪，哪里的内容就先翻
          pending.sort((a, b) => rank(a) - rank(b) || order.get(a) - order.get(b));
          const batch = pending.splice(0, UNIT_BATCH_SIZE);
          const texts = batch.map(unit => unit.text);

          const response = await sendMessage({
            action: "translateBatch",
            texts: texts,
            targetLanguage: target,
          });

          if (response && response.degraded) {
            this.degraded = true;
            this.lastError = response.error || this.lastError;
          }

          if (!response || !response.ok) {
            if (!this.lastError) this.lastError = (response && response.error) || "翻译请求失败";
            continue;
          }

          const results = response.results || [];
          const fallback = [];
          results.forEach((result, index) => {
            const unit = batch[index];
            if (!unit || !result) return;
            // brace 模式优先原子还原；失败再回落 tag 严格还原
            if (unit.braceMap && unit.braceMap.size > 0 && unit.applyBrace(result.text)) {
              applied++;
              return;
            }
            if (unit.apply(result.text)) {
              applied++;
              return;
            }
            // 占位符被引擎吞掉/破坏：改用「整段纯文本」重发一次，
            // 拿到整段译文后只写进第一个文本节点，其余清空——
            // 这样既保住标签与样式，也不会把同一段话重复贴 N 遍。
            if (unit.plainText) fallback.push({ unit, text: unit.plainText });
          });

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
                  if (item.unit.applyWholeText(result.text)) applied++;
                });
              }
            } catch {
              // 降级也失败就保留原文，绝不破坏页面
            }
          }

          this.showIndicator("翻译中… " + applied + "/" + units.length, true);
        }
      } finally {
        if (observer) observer.disconnect();
        for (const unit of units) {
          if (unit.element) delete unit.element.__tpUnit;
        }
      }

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

      const fresh = [];
      for (const root of roots) {
        if (!root || root.nodeType !== 1) continue;
        // 已翻译容器里新插入的内容不能当独立单元重翻：
        // 否则 `<p data-tp-translated>译文<span>新增</span></p>` 会把
        // 已翻译的父元素和新节点混在一起二次送翻，译文叠成两层。
        // 已翻译容器的内部（不是容器本身）直接跳过
        if (root.parentElement && root.parentElement.closest("[data-tp-translated]")) continue;
        const found = DOM.collectUnits(root, this.placeholderMode);
        for (const unit of found) {
          if (unit.translated) continue;
          // 整段已是目标语言（中文页面里的中文段落）不再送翻
          if (this.filterAlreadyTarget([unit], settings.targetLanguage).length === 0) continue;
          fresh.push(unit);
        }
      }
      if (fresh.length === 0) return;

      this.units.push(...fresh);
      if (OFFLINE && OFFLINE.supported) {
        // 端侧能翻就先翻，剩下的交给在线引擎
        await this.translateOffline(fresh, settings.sourceLanguage || "auto", settings.targetLanguage);
      }
      const remaining = fresh.filter(unit => !unit.translated);
      if (remaining.length > 0) {
        await this.translateUnits(remaining, settings.targetLanguage);
      }
    },

    /**
     * 启动动态内容观察。
     */
    attachObserver() {
      if (this.observer) return;
      const self = this;
      this.observer = new MutationObserver(records => {
        if (self.observerSuppressed) return;
        const roots = [];
        for (const record of records) {
          // 1) 新增节点：按元素收集根
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) roots.push(/** @type {Element} */ (node));
          }
          // 2) 文本节点变化：React/Vue 只改 textContent 时**不会**产生 childList 记录，
          //    只监听 childList 等于「动态页面的文本永远不翻」（实测 GitHub 的
          //    实时刷新、SPA 路由切换后的标题全部漏翻）。取最近的可翻译祖先作为根。
          if (record.type === "characterData" && record.target && record.target.nodeType === 3) {
            const parent = record.target.parentElement;
            // 已翻译容器里的文本变化是引擎自己写入的回声，不能当新内容
            if (parent && !parent.closest("[data-tp-translated]")) roots.push(parent);
          }
        }
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
      return {
        state: this.state,
        count: this.units.length,
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
