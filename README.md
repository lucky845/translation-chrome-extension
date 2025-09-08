# 网页翻译器 Chrome 扩展

一款 Chrome 扩展，可让您一键将任何网页翻译成您偏好的语言。

## 功能特性

- 一键翻译整个网页
- 支持多种语言
- 可恢复原始文本
- 集成上下文菜单
- 支持翻译选中文本
- 可配置目标语言
- 支持 Google 翻译 API（需 API 密钥）

## 安装方法

1. 克隆或下载此仓库
2. 打开 Chrome 并进入 `chrome://extensions/`
3. 在右上角启用"开发者模式"
4. 点击"加载已解压的扩展程序"并选择扩展目录

## 使用方法

1. 点击工具栏中的扩展图标打开弹出窗口
2. 选择您的目标语言
3. 点击"翻译页面"翻译当前网页
4. 点击"显示原文"恢复到原始文本
5. 使用上下文菜单选项翻译页面或选中文本

## 配置说明

1. 点击弹出窗口中的"选项"按钮打开设置页面
2. 选择您的默认目标语言
3. （可选）输入您的 Google 翻译 API 密钥以获得更好的翻译效果

## 支持的语言

- 英语
- 西班牙语
- 法语
- 德语
- 中文（简体）
- 日语
- 韩语
- 俄语
- 阿拉伯语

## 技术细节

此扩展使用 Manifest V3 构建，遵循现代 Chrome 扩展实践：

- **manifest.json**：扩展配置
- **background/background.js**：处理翻译的后台服务工作线程
- **contentScript/content.js**：在网页上运行的内容脚本
- **popup/popup.html**：快速翻译操作的弹出 UI
- **options/options.html**：配置选项页面
- **translate-api.js**：翻译服务接口
- **real-translate-api.js**：Google 翻译 API 实现

## 开发说明

要修改扩展：

1. 对相关文件进行更改
2. 进入 `chrome://extensions/`
3. 点击扩展卡片上的刷新图标

## 限制说明

- 没有 API 密钥时，翻译为模拟翻译
- 一些结构复杂的网页可能无法完美翻译
- 页面加载后动态加载的内容可能不会自动翻译

## 未来改进

- 支持更多翻译服务
- 自动检测源语言
- 改进动态内容处理
- 翻译历史记录
- 更好的用户界面和体验

## 致谢

基于 Filipe Pereira 的 [Traduzir-paginas-web](https://github.com/FilipePS/Traduzir-paginas-web) 项目。