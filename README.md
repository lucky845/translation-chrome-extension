<div align="center">

# 🌐 网页翻译

**一键翻译整个网页，保留链接、图片与排版结构**

Manifest V3 · 零构建 · 零运行时依赖

![Version](https://img.shields.io/badge/version-1.1.0-blue)
![Chrome](https://img.shields.io/badge/Chrome-102%2B-green?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-orange)
![Tests](https://img.shields.io/badge/tests-45%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

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

### 使用方式

- **⌨️ 快捷键** `Alt+T` 切换翻译状态
- **🖱️ 右键菜单** 翻译选中文本
- **🤖 自动翻译** 页面语言与目标语言不同时自动翻译
- **🌍 30 种语言**，中英双语界面

## 📥 安装

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
| 切换目标语言 / 引擎 | 工具栏弹窗或扩展「选项」页 |

## ⚙️ 翻译引擎

| 引擎 | 状态 | 说明 |
|------|------|------|
| **Google** | ✅ 免费可用 | 默认引擎，无需配置，批量 200 条/请求 |
| **MyMemory** | ✅ 实测可用 | 免密钥、独立于 Google 基础设施；Node 与真实 Chrome 内均实测 200。逐条串行限速，每日配额用尽时明确报错 |
| **Lingva** | ⚠️ 可选 | Google 翻译开源前端，四实例池轮换。公共实例多在 Cloudflare 之后，**实例可用性因地区/网络而异**（2026-11 实测：部分网络下全部实例不可达），仅在手动选择或前序引擎全失败时使用 |
| **Azure Translator** | 🔑 需密钥 | 在选项页填入订阅密钥 |

**自动降级链**：`Google → MyMemory → Lingva`

当前引擎限流或不可用时自动切换下一个，状态栏标注「已降级」，绝不静默换引擎。

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

## 🗂 项目结构

```text
background/
  service-worker.js   消息路由、快捷键、右键菜单
  settings.js         设置读写与缓存
  engine.js           翻译引擎（Google / MyMemory / Lingva / Azure），重试与超时
  translator.js       编排：缓存、去重、动态引擎降级链
content/
  dom-core.js         DOM 采集、占位符编解码、无损还原（纯逻辑，可单测）
  content.js          状态机、批量调度、MutationObserver、UI
popup/  options/      界面
test/
  dom.test.mjs        DOM 逻辑单测（jsdom）
  manifest.test.mjs   静态完整性校验
  engine.test.mjs     引擎单测（mock）+ 真实请求冒烟
  e2e.mjs             真实 Chrome 端到端
```

## 🛠 开发

```bash
npm install
npm test              # DOM 单测 + 静态完整性
npm run test:engine   # 引擎单测（mock）+ 真实请求（需要网络）
node test/e2e.mjs     # 真实 Chrome E2E（macOS + 本机 Chrome）
npm run lint
```

E2E 相关环境变量：`TP_E2E_PROXY`（指定代理）、`TP_E2E_HEADFUL=1`（有头模式）。

## ⚠️ 已知限制

- 仅注入主框架（`all_frames: false`），iframe 内内容由其自身页面负责
- `pre`、`code`、表单控件、`contenteditable` 区域不翻译（设计如此）
- Google 免费端点无官方 SLA，极端限流时返回明确错误而不是伪造结果

## 📄 License

[MIT](LICENSE)
