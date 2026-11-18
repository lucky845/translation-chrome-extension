<div align="center">

# 🌐 网页翻译

**一键翻译整个网页，保留链接、图片与排版结构**

Manifest V3 · 零构建 · 零运行时依赖

![Version](https://img.shields.io/badge/version-1.1.5-blue)
![Chrome](https://img.shields.io/badge/Chrome-102%2B-green?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange)
![Tests](https://img.shields.io/badge/tests-152%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)
[![Edge Add-ons](https://img.shields.io/badge/Get_it_from-Microsoft-0d6cb6?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/henmhjmgjajggnhhopblkgclfoalblan)

</div>

<!-- TODO: 补一张翻译前后对比截图，放 docs/screenshot.png
![截图](docs/screenshot.png) -->

## ✨ 功能特性

### 翻译能力

- **🖥️ 整页翻译** — 按块级元素组织翻译单元，句子语序由引擎整体处理，中文输出不再是破碎词序
- **🧬 结构保留** — `<a>`、`<b>`、`<img>` 等内联元素在译文中按目标语序重排，`href`/`class` 等属性完整保留
- **🔄 无损恢复** — 一键还原原始页面，逐字节一致
- **⚡ 动态内容** — MutationObserver 增量翻译新增内容（防抖 300ms，自触发抑制），SPA 路由切换也能跟上
- **📦 批量请求** — 单次请求最多携带 200 条文本，实测约 1.4 秒
- **🎯 视口优先** — 先翻你正在看的一屏，滚动时新进入视野的内容插队优先，不用等整页翻完
- **⚡ 引擎熔断** — 某个引擎失败后 30 秒内直接跳过，不会每个批次都重付一遍超时
- **🔧 自带接口** — Google / MyMemory / Lingva 都不通时，可接入自己的翻译服务（DeepLX、自建 LibreTranslate、任意 OpenAI 兼容中转）
- **🚫 站点黑名单** — 银行、后台、代码托管这类页面可以设为永不翻译，避免机器翻译破坏表单语义
- **📐 译文防裁切** — 翻译后自动解除 `-webkit-line-clamp` 高度限制，中文变长不会被截断
- **🎨 译文样式** — 可选下划线 / 高亮底色标记译文，与原文对照阅读；纯 CSS 实现，不改页面 DOM
- **开关自由** — 不想用端侧翻译？设置页一键关闭，始终走在线引擎

### 使用方式

- **⌨️ 快捷键** `Alt+T` 切换翻译状态
- **🖱️ 右键菜单** 翻译选中文本
- **🤖 自动翻译** 页面语言与目标语言不同时自动翻译
- **🌍 30 种语言**，中英双语界面

## 📥 安装

### Microsoft Edge（推荐）

直接从 [Edge 加载项商店](https://microsoftedge.microsoft.com/addons/detail/henmhjmgjajggnhhopblkgclfoalblan) 一键安装：

👉 [https://microsoftedge.microsoft.com/addons/detail/henmhjmgjajggnhhopblkgclfoalblan](https://microsoftedge.microsoft.com/addons/detail/henmhjmgjajggnhhopblkgclfoalblan)

### Chrome / 其他 Chromium 浏览器

> 本扩展尚未发布到 Chrome Web Store，请以开发者模式加载。

1. 克隆或下载本仓库
2. 打开 `chrome://extensions/`
3. 右上角开启「**开发者模式**」
4. 点击「**加载已解压的扩展程序**」，选择本目录

## 🎯 使用

| 操作 | 方式 |
|------|------|
| 翻译 / 恢复整页 | 点击工具栏图标，或按 <kbd>Alt</kbd>+<kbd>T</kbd> |
| 翻译选中文本 | 选中文字 → 右键 → 翻译 |
| 换目标语言 | 工具栏弹窗 |
| 配置翻译引擎 | 扩展「设置」页（弹窗只保留一行只读提示） |

> 弹窗只负责「翻 / 还原」两件事；引擎属于一次性配置，统一放在设置页，避免误触。

## ⚙️ 翻译引擎

| 引擎 | 状态 | 说明 |
|------|------|------|
| **Google** | ✅ 免费可用 | 默认引擎，无需配置，批量 200 条/请求；批量解析异常时自动逐条兜底（dj=1 结构化接口） |
| **MyMemory** | ✅ 实测可用 | 免密钥、独立于 Google 基础设施；Node 与真实 Chrome 内均实测 200。逐条串行限速，每日配额用尽时明确报错 |
| **Lingva** | ⚠️ 可选 | Google 翻译开源前端，四实例池轮换。公共实例多在 Cloudflare 之后，**实例可用性因地区/网络而异**（2026-11 实测：部分网络下全部实例不可达），仅在手动选择或前序引擎全失败时使用 |
| **自定义接口** | 🔧 自行配置 | 填地址 + 请求模板即可接入任意服务（DeepLX / LibreTranslate / OpenAI 兼容中转 / 自建），见下节 |
| **Azure Translator** | 🔑 需密钥 | 在选项页填入订阅密钥 |

### 浏览器内置端侧翻译（优先）

Chrome 138+ 与 Edge 148+ 都内置了同一套 **Translator API**，由设备端本地模型驱动：

| 浏览器 | 起始版本 | 语言覆盖 | 联网 | 配额 |
|--------|---------|---------|------|------|
| Chrome | 138+ | — | 仅首次下载模型 | 无 |
| Edge | 148+ | 145+ 种 | 仅首次下载模型 | 无 |

扩展**不区分浏览器**，只做能力检测：`typeof Translator !== "undefined"`

- 支持 → 端侧优先，本地推理，不受网络与 429 影响
- 不支持 → 自动回落到下面的在线降级链，行为不变

首次使用需下载该语言对的模型（几秒），之后完全离线。模型下载必须在用户手势内触发，所以点「翻译页面」时就会开始预热。

> 模型未就绪时不会干等：扩展先让在线引擎把首屏翻出来，模型下载完成后剩余段落自动改用端侧。
>
> 不想用端侧？设置页取消勾选「**优先使用端侧翻译**」即可，始终走在线引擎。

**在线自动降级链**：`Google → 自定义接口 → MyMemory → Lingva`

当前引擎限流或不可用时自动切换下一个，状态栏标注「已降级」，绝不静默换引擎。

### 自定义接口

设置页 → 翻译引擎 → **自定义接口**。选一个预设再改地址即可，也可以从零填模板。

| 预设 | 默认接口 | 响应路径 |
|------|---------|---------|
| DeepLX | `POST /translate` | `data` |
| LibreTranslate（自建） | `POST /translate` | `translatedText` |
| OpenAI 兼容 | `POST /v1/chat/completions` | `choices.0.message.content` |
| 通用 | 全空，自己填 | 纯文本响应时留空 |

**可用占位符**（地址、请求头、请求体里都能用）：

```text
{{text}}      原文（请求体里自动做 JSON 转义，地址里自动 URL 编码）
{{textJson}}  原文（带外层引号的 JSON 字符串）
{{from}} {{to}}           源/目标语言码（按预设转换，如 zh-CN → ZH）
{{fromName}} {{toName}}   语言英文名，供 LLM 提示词使用
{{token}} {{model}}       设置页填的 Token 与模型名
```

- 地址为**必填项**：没填地址时该引擎视为不可用，降级链直接跳过，**不会**把页面文本发往预设的默认地址。
- 自定义地址的域名权限按需申请（`chrome.permissions.request`），没有全站访问授权。
- 有「测试连接」按钮：保存前先发一条 `Hello, world!` 验证地址、鉴权与响应路径。

> [!WARNING]
> 旧版本的「Bing 免费端点」（`edge.microsoft.com/translate/auth`）已于 2026-11 实测失效（返回 404/503）。
> 本扩展不再将其作为可用引擎展示；已迁移为 Azure Translator 正式接口，需要用户自己的密钥。
> 界面显示的引擎状态来自真实探测，不是写死文案。

## 🧠 工作原理：块级翻译单元

逐 TEXT 节点翻译是错误的做法——`Read the <a>docs</a> before you <b>start</b>.`
拆成 5 段分别翻译，中文语序必然错乱。

本扩展将每个叶子块编码为**一个翻译单元**：内联标签变成 `<0>…</0>` 占位符，
整句交给引擎，返回后按占位符重建 DOM。实测 Google 会保留占位符并按目标语序重排：

```text
输入:  Read the <0>official docs</0> before you <1>start</1>.
输出:  在<1>开始</1>之前阅读<0>官方文档</0>。
```

占位符完整性有校验：引擎若丢失任何占位符，该单元放弃应用、保留原文——
**宁可少翻一段，绝不生成错乱 DOM 或把 `<a>` 渲染成字面文本。**

**双套占位符**：Google 系引擎用 `<0>…</0>` 标签占位符；DeepLX / LibreTranslate /
OpenAI 兼容等纯文本接口会把 `<0>` 当 HTML 剥掉，所以自定义引擎改用 `{{n}}` 花括号
成对占位符（`{{0}}docs{{1}}`）——它是普通文本 token，实测 Google 与 DeepL 类引擎
都能原样保留并随语序重排，还原逻辑与标签占位符同一套校验。

## 🗂 项目结构

```text
background/
  service-worker.js   消息路由、快捷键、右键菜单
  settings.js         设置读写与缓存
  engine.js           翻译引擎入口（Google / MyMemory / Lingva / Azure），分块重试与超时
  engines/
    base.js           引擎基类与错误类型、重试工具
    text.js           分句切片（超长文本）
    custom.js         自定义接口：预设、模板渲染、响应路径解析
  translator.js       编排：缓存、去重、动态引擎降级链
content/
  dom-core.js         DOM 采集、占位符编解码、无损还原（纯逻辑，可单测）
  blacklist.js        站点黑名单匹配（域名/通配/路径前缀）
  offline-translator.js 浏览器内置端侧翻译（Chrome/Edge 同一套 API，能力检测）
  content.js          状态机、端侧优先调度、批量、MutationObserver、UI
popup/  options/      界面
test/
  dom.test.mjs        DOM 逻辑单测（jsdom）
  blacklist.test.mjs  黑名单匹配规则
  options.test.mjs    选项页冒烟（加载、面板切换、预设预填）
  content.test.mjs    调度测试（批量落地、动态内容增量、恢复、语言判断）
  manifest.test.mjs   静态完整性校验
  engine.test.mjs     引擎单测（mock）+ 真实请求冒烟
  e2e.mjs             真实 Chrome 端到端
```

## 🛠 开发

```bash
npm install
npm test              # DOM 单测 + 选项页冒烟 + 静态完整性
npm run test:engine   # 引擎单测（mock）+ 真实请求（需要网络）
node test/e2e.mjs     # 真实 Chrome E2E（macOS + 本机 Chrome）
npm run lint
```

Lint 用 ESLint 10 的 flat config（`eslint.config.mjs`）。原先依赖的 `eslint-config-google`
在 ESLint 9+ 下会直接崩溃（它包含已移除的 `valid-jsdoc` 规则，且是 eslintrc 格式，
在 flat config 下本就只生效一半），因此已把它的 63 条有效规则内联进配置文件，
并移除冗余的 `@eslint/eslintrc`。迁移后有效规则集与迁移前逐条比对完全一致。

若在受限环境（沙箱、只读 HOME）里 `npm` 报缓存不可写，用独立缓存目录：
`npm install --cache "$PWD/.npm-cache"`。

E2E 相关环境变量：`TP_E2E_PROXY`（指定代理）、`TP_E2E_HEADFUL=1`（有头模式）、
`TP_E2E_NO_SANDBOX=1`（容器 / CI / 受限用户会话里 Chrome 自身沙箱无法初始化时开启）。

## ⚠️ 已知限制

- 仅注入主框架（`all_frames: false`），iframe 内内容由其自身页面负责
- `pre`、`code`、表单控件、`contenteditable` 区域不翻译（设计如此）
- `display:none` 与 `aria-hidden="true"` 的内容不翻译：翻了看不见，还会把装饰性字面量翻乱；弹层打开时会作为新节点重新进入增量队列
- Google 免费端点无官方 SLA，极端限流时返回明确错误而不是伪造结果
- 自定义接口默认**按预设并发**发送（通用 / DeepLX / LibreTranslate 为 4，OpenAI 为 2；不同服务的批量格式差异太大，
  不做请求合并）。对限流敏感的公共免费实例，请换用对应预设或把 `concurrency` 调回 1（此时会保留 120ms 节流间隔）

## 📝 更新日志

### 工具链 — 依赖漏洞清零

`npm audit` 从 16 个漏洞（11 high / 5 moderate）降到 **0**。

- 全部漏洞来自 ESLint 8 的传递依赖（`flatted`、`js-yaml`、`minimatch`、`glob`、
  `rimraf`、`flat-cache`、`file-entry-cache`、`@humanwhocodes/config-array`），
  其中两个上游标为「No fix available」。ESLint 9 仍带 `@eslint/eslintrc`，
  漏洞清不干净；升到 ESLint 10 才整条链路断开
- 顺带清掉一个从未被 import 的冗余依赖 `@eslint/eslintrc`
- ESLint 10 新增的三条规则真实抓到了 3 处问题：`no-useless-assignment`（死赋值）、
  `preserve-caught-error`（重抛时丢掉原始 error，现在保留 `cause` 供排查）、
  多处未使用的 catch 绑定
- 迁移后有效规则集与迁移前**逐条比对完全一致**（83 条），不掺任何无关改动

### v1.1.5 — 自定义接口可用性

v1.1.4 之后真机验证追加的两项修复。**如果你用自定义接口，这一版必须更新。**

**性能**

- 自定义接口整页翻译慢 80 倍：worker 在每个任务后固定 `sleep(120ms)`，且通用预设
  `concurrency: 1`（纯串行），实测 600 段要 74 秒。现在节流只在串行路径生效，
  并发预设不再被固定 sleep 拖累；通用预设并发 1 → 4（与 DeepLX / LibreTranslate 对齐）。
  **实测 60 段从约 7.4 秒降到 91ms。** 串行路径仍保留节流，公共免费接口保护不受影响

**修复**

- 「测试连接」按钮永久卡在「测试中…」：`ensurePermission` 先 `await chrome.permissions.contains()`
  再 `chrome.permissions.request()`，而 request 必须在用户手势的同步调用栈里发出——
  先 await 就把手势消耗掉了。这是每个用户第一次配置自定义接口的必经路径，等于功能被完全阻断。
  现在直接 request（已授权时立即 resolve 且不弹窗），并加 15 秒超时兜底：
  弹窗被关掉或无弹窗环境给出明确错误，不再无声悬挂

### v1.1.4 — 最后一公里修复

**兼容性**

- `minimum_chrome_version` 102 → **103**：`AbortSignal.timeout`（fetch 超时）是 Chrome 103 新增 API，
  Chrome 102 上每个翻译请求直接 `TypeError`，翻译全灭

**修复**

- `title` / `alt` / `aria-label` / `placeholder` 属性文本翻译此前从未生效：批量翻译返回的是
  `{text, detected}` 对象数组，旧实现按字符串判断导致全部落空，现在正确读取字段
- 「译文样式」（下划线 / 高亮）此前从未生效：注入的 CSS 选择器带 `:not([data-tp-translated=""])`，
  而标记写入的恰好是空值属性，每个已标记元素都被排除；选择器已对齐
- 改动设置（引擎 / 密钥 / 样式 / 目标语言）现在**实时生效**：popup/options 直写 `chrome.storage.sync`，
  但 `runtime.sendMessage` 不会投递给 content script——已改用 `storage.onChanged` 双端接线
  （content 失效设置缓存并重注入样式；service worker 清译文缓存与引擎熔断），无需刷新页面
- 端侧翻译预热语言对跟随用户设置，不再硬编码 `en→zh`（目标语言为其他语言时预热会打错模型）

**真机验证追加修复（E2E 抓到的，jsdom 覆盖不到）**

- 内联 `<img alt>` 的属性译文此前会丢：正文翻译用 `cloneNode` 重建内联元素，
  属性若在之后写入就打在已脱离文档的原节点上，屏幕上仍是旧 `alt`；属性翻译已提前到正文翻译之前
- 「显示原文」后 `alt` 还原不回去：单元恢复会重建节点，属性记录里的元素引用失效；
  现在额外记录「标签名 + 文档序号」，还原时按此重新定位当前元素

**清理**

- 删除全仓无调用方的 `setSettings` 消息 handler 与 `settingsUpdated` 死分支
- 移除 MyMemory 请求里的 `User-Agent` / `Referer` / `Origin` —— 这些是 fetch 禁改头，浏览器静默丢弃，写了也不生效

**性能**

- 自定义接口整页翻译慢 80 倍的问题：worker 在每个任务后固定 `sleep(120ms)`，且通用预设
  `concurrency: 1`（纯串行）。实测 600 段要 74 秒。现在节流只在串行路径生效，
  并发预设不再被固定 sleep 拖累；通用预设并发 1 → 4（与 DeepLX / LibreTranslate 对齐，
  自建服务通常能承受，目标服务有限流可换预设）。
  **实测：60 段从 ~7.4s → 91ms。** 串行路径仍保留节流，公共免费接口不受影响

**修复（真机实测发现）**

- 「测试连接」按钮永久卡在「测试中…」：`ensurePermission` 先 `await chrome.permissions.contains()`
  再 `chrome.permissions.request()`，而 request 必须在用户手势的同步调用栈里发出——
  先 await 就把手势消耗掉了。这是每个用户第一次配置自定义接口的必经路径，等于功能被完全阻断。
  现在直接 request（已授权时立即 resolve 且不弹窗），并加 15 秒超时兜底：
  弹窗被关掉或无头环境不弹窗时给出明确错误，不再无声悬挂

### v1.1.3 — 翻译真正跑起来了

**关键修复：Google 端点改走 GET**

真机实测（Chrome for Testing，扩展 service worker 上下文）：Google 的
`translate_a/t` 对 POST 的预检不返回 CORS 头，浏览器在请求真正发出前就判
`Failed to fetch`；同一端点改 GET 一次 60 条正常返回。旧代码把 `Failed to fetch`
当成可重试的网络错误，于是一路重试 → 降级 → 再重试，最后报「所有引擎失败」，
而请求其实一次都没发出去。

**翻译体验**

- 新增滚动翻译（滚到哪翻到哪），设置页可关闭
- 失败的翻译批次不再被静默丢弃：隔 3 秒统一重试一轮，仍失败则如实提示「有 N 段未翻译」
- 连续 3 批被拒即停止，不再在限流上白等（真机实测一次翻译从 103 秒降到 42 秒）
- 429 限流跳过退避重试与逐条兜底，直接交给降级链
- 持续滚动时状态不会再卡在「翻译中」

**引擎**

- 降级链的「最近成功优先」排序此前从未生效（`undefined - number` 得 `NaN`，
  `sort` 把 `NaN` 当 0），现在会真正把刚成功过的引擎提前
- 用户首选的引擎始终排第一，不会被最近成功过的引擎顶替

### v1.1.2 — 文字提取与引擎稳定性

**翻译准确性**

- 修复 `<a>` 等内联元素里的文字在降级路径下丢失
- 修复 `Array<T>` 这类带尖括号的代码片段被 HTML 解析吞掉
- 修复 ruby 注音（`<ruby>` 的 `<rt>`）被拼进正文
- 修复 `display:block` 的 `<strong>` 被误当内联、与正文并成一句
- 修复 `display:inline-block` 容器被整块当成行内占位符，里面的段落永远翻不到
- 修复日语页面因汉字比例误判而被当成「已是中文」整页不翻
- 补齐 `title` / `alt` / `aria-label` / `placeholder` 四类属性文本的翻译

**稳定性**

- 恢复原文时不再回滚页面在翻译期间的新内容（框架更新不再被覆盖）
- 长段落按句切分送翻，MyMemory（450 字符）与 Lingva（600 字符）不再因超长整段失败
- 框架重渲染后不再出现「译[译[译[…]]]」套娃翻译
- SPA 路由切换后失效单元会被回收，长会话不再持续吃内存
- 修复引擎熔断在冷却期内被反复失败续期、导致永远不恢复的问题

**性能**

- 设置读取不再同步探测三个引擎（曾阻塞首屏 48 秒）
- 动态内容只翻译真正变化的部分

### v1.1.1

- 移除流水线里的 Edge 商店自动提交，改为手动在 Partner Center 提交

### v1.1.0

- `{{n}}` 双占位符模式（自定义引擎）
- 端侧翻译开关、译文样式（下划线 / 高亮）
- Google 批量失败时的单条兜底端点

## 📄 License

[MIT](LICENSE)
