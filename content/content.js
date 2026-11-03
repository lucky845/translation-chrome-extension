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

  /** 后台响应超时，防止消息通道永久挂起。 */
  const MESSAGE_TIMEOUT_MS = 60000;

  /** 单次发给后台的单元数量，与后台分块策略呼应。 */
  const UNIT_BATCH_SIZE = 120;

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

      // 页面已是目标语言时不必再翻，避免中文页面翻成中文
      const targetIsChinese = target.toLowerCase().indexOf("zh") === 0;
      if (targetIsChinese && DOM.isPageAlreadyTarget(target)) {
        const sample = document.body ? document.body.innerText.slice(0, 2000) : "";
        if (sample && DOM.containsHanText(sample)) {
          this.lastError = "页面已经是中文，无需翻译";
          return { success: false, count: 0, error: this.lastError };
        }
      }

      if (this.state === "translated") this.restorePage();

      this.state = "translating";
      this.lastError = null;
      this.degraded = false;
      this.showIndicator("翻译中…");

      try {
        this.units = DOM.collectUnits(document.body);
        if (this.units.length === 0) {
          this.state = "idle";
          this.hideIndicator();
          this.lastError = "页面没有可翻译的文本";
          return { success: false, count: 0, error: this.lastError };
        }

        const applied = await this.translateUnits(this.units, target);
        this.hideIndicator();

        if (applied === 0) {
          this.state = "idle";
          return { success: false, count: 0, error: this.lastError || "翻译失败" };
        }

        this.state = "translated";
        this.attachObserver();
        return { success: true, count: applied };
      } catch (error) {
        this.state = "idle";
        this.hideIndicator();
        this.lastError = error.message || String(error);
        return { success: false, count: 0, error: this.lastError };
      }
    },

    /**
     * 批量翻译单元并应用译文。
     * @param {Array<Object>} units 单元
     * @param {string} target 目标语言
     * @return {Promise<number>} 成功应用的数量
     */
    async translateUnits(units, target) {
      let applied = 0;

      for (let offset = 0; offset < units.length; offset += UNIT_BATCH_SIZE) {
        const batch = units.slice(offset, offset + UNIT_BATCH_SIZE);
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
        results.forEach((result, index) => {
          const unit = batch[index];
          if (!unit || !result) return;
          if (unit.apply(result.text)) applied++;
        });

        this.showIndicator("翻译中… " + Math.min(offset + UNIT_BATCH_SIZE, units.length) + "/" + units.length);
      }

      return applied;
    },

    /**
     * 恢复原始页面。
     * @return {Object} 恢复结果
     */
    restorePage() {
      this.suppressMutations(true);
      this.detachObserver();

      let restored = 0;
      // 逆序恢复：浅层单元先于其块级子单元恢复，避免互相覆盖
      for (let index = this.units.length - 1; index >= 0; index--) {
        if (this.units[index].restore()) restored++;
      }

      this.units = [];
      this.state = "idle";
      this.lastError = null;
      this.degraded = false;
      this.hideIndicator();
      this.suppressMutations(false);
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
        const found = DOM.collectUnits(root);
        for (const unit of found) {
          if (!unit.translated) fresh.push(unit);
        }
      }
      if (fresh.length === 0) return;

      this.units.push(...fresh);
      await this.translateUnits(fresh, settings.targetLanguage);
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
          for (const node of record.addedNodes) {
            if (node.nodeType === 1) roots.push(/** @type {Element} */ (node));
          }
        }
        if (roots.length === 0) return;

        if (self.mutationTimer !== null) clearTimeout(self.mutationTimer);
        self.mutationTimer = window.setTimeout(() => {
          self.mutationTimer = null;
          self.translateNewContent(roots).catch(() => {});
        }, MUTATION_DEBOUNCE_MS);
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
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
        error: this.lastError,
      };
    },

    /**
     * 显示右下角状态指示器。
     * @param {string} text 文本
     */
    showIndicator(text) {
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
