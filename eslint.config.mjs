import pluginJs from "@eslint/js";
import prettier from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

/**
 * Google 风格指南规则（内联版）。
 *
 * 原先来自 eslint-config-google@0.14.0。该包是 eslintrc 格式，在 ESLint 9+ 的 flat config
 * 下已无法作为配置对象使用；它引用的 valid-jsdoc / require-jsdoc 两条规则也已在 ESLint 9
 * 中移除，ESLint 10 下会直接抛 "Could not find valid-jsdoc" 导致整个 lint 崩溃。
 *
 * 因此把真正生效的 63 条规则原样内联，规则值与原包逐条一致（已用 eslint --print-config
 * 对比过迁移前后的有效规则集）。后续如需调整 Google 风格，直接改这里。
 */
const googleRules = {
  "no-cond-assign": 0,
  "no-irregular-whitespace": 2,
  "no-unexpected-multiline": 2,
  curly: [2, "multi-line"],
  "guard-for-in": 2,
  "no-caller": 2,
  "no-extend-native": 2,
  "no-extra-bind": 2,
  "no-invalid-this": 2,
  "no-multi-spaces": 2,
  "no-multi-str": 2,
  "no-new-wrappers": 2,
  "no-throw-literal": 2,
  "no-with": 2,
  "prefer-promise-reject-errors": 2,
  "no-unused-vars": [2, { args: "none" }],
  "array-bracket-newline": 0,
  "array-bracket-spacing": [2, "never"],
  "array-element-newline": 0,
  "block-spacing": [2, "never"],
  "brace-style": 2,
  camelcase: [2, { properties: "never" }],
  "comma-dangle": [2, "always-multiline"],
  "comma-spacing": 2,
  "comma-style": 2,
  "computed-property-spacing": 2,
  "eol-last": 2,
  "func-call-spacing": 2,
  indent: [
    2,
    2,
    {
      CallExpression: { arguments: 2 },
      FunctionDeclaration: { body: 1, parameters: 2 },
      FunctionExpression: { body: 1, parameters: 2 },
      MemberExpression: 2,
      ObjectExpression: 1,
      SwitchCase: 1,
      ignoredNodes: ["ConditionalExpression"],
    },
  ],
  "key-spacing": 2,
  "keyword-spacing": 2,
  "linebreak-style": 2,
  "max-len": [2, { code: 80, tabWidth: 2, ignoreUrls: true, ignorePattern: "goog.(module|require)" }],
  "new-cap": 2,
  "no-array-constructor": 2,
  "no-mixed-spaces-and-tabs": 2,
  "no-multiple-empty-lines": [2, { max: 2 }],
  "no-new-object": 2,
  "no-tabs": 2,
  "no-trailing-spaces": 2,
  "object-curly-spacing": 2,
  "one-var": [2, { var: "never", let: "never", const: "never" }],
  "operator-linebreak": [2, "after"],
  "padded-blocks": [2, "never"],
  "quote-props": [2, "consistent"],
  quotes: [2, "single", { allowTemplateLiterals: true }],
  semi: 2,
  "semi-spacing": 2,
  "space-before-blocks": 2,
  "space-before-function-paren": [2, { asyncArrow: "always", anonymous: "never", named: "never" }],
  "spaced-comment": [2, "always"],
  "switch-colon-spacing": 2,
  "arrow-parens": [2, "always"],
  "constructor-super": 2,
  "generator-star-spacing": [2, "after"],
  "no-new-symbol": 2,
  "no-this-before-super": 2,
  "no-var": 2,
  "prefer-const": [2, { destructuring: "all" }],
  "prefer-rest-params": 2,
  "prefer-spread": 2,
  "rest-spread-spacing": 2,
  "yield-star-spacing": [2, "after"],
};

export default [
  // 基础配置
  { ignores: ["node_modules/**", "dist/**", "build/**"] },

  // JavaScript标准规则
  pluginJs.configs.recommended,

  // Google 风格指南（内联，见上方说明）
  { rules: googleRules },

  // Prettier配置（用于关闭与Prettier冲突的规则）
  prettierConfig,

  // 自定义规则和环境
  {
    plugins: { prettier },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        // Chrome扩展API全局变量
        chrome: "readonly",
        browser: "readonly",
        // 浏览器全局变量
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        Node: "readonly",
        NodeFilter: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        MutationObserver: "readonly",
      },
    },
    rules: {
      // 启用Prettier插件
      "prettier/prettier": "error",

      // 允许使用console（对于扩展开发很有用）
      "no-console": "off",

      // 启用未声明变量的检查
      "no-undef": "error",

      // 调整缩进为2个空格（适合扩展开发）
      indent: ["error", 2, { SwitchCase: 1 }],

      // 允许单行长度更长一些
      "max-len": ["warn", { code: 150, ignoreComments: true }],

      // 允许使用箭头函数（现代JS特性）
      "prefer-arrow-callback": "error",

      // 允许使用const和let
      "prefer-const": "error",

      // 放宽未使用变量的检查
      "no-unused-vars": "warn",
    },
  },

  {
    files: ["test/**/*.mjs"],
    languageOptions: {
      globals: {
        // Node 测试环境全局
        process: "readonly",
        URL: "readonly",
        console: "readonly",
        // mock fetch 用的 fetch API 全局（Node 18+ 内置）
        Response: "readonly",
      },
    },
  },

  // 针对不同目录的特定配置
  {
    files: ["background/**/*.js"],
    languageOptions: {
      globals: {
        // Service Worker特定全局变量
        self: "readonly",
        // fetch 超时控制（Service Worker 与 Node 20+ 均内置）
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
  },

  {
    files: ["content/**/*.js"],
    languageOptions: {
      globals: {
        // 内容脚本可能需要的全局变量
        location: "readonly",
        history: "readonly",
        window: "readonly",
        IntersectionObserver: "readonly",
        MutationObserver: "readonly",
      },
    },
  },

  {
    files: ["content/blacklist.js"],
    languageOptions: {
      globals: {
        window: "readonly",
        URL: "readonly",
        module: "writable",
      },
    },
  },

  {
    files: ["content/offline-translator.js"],
    languageOptions: {
      globals: {
        // 端侧模块通过 module.exports 暴露给 Node 测试
        module: "writable",
      },
    },
  },

  {
    files: ["content/dom-core.js"],
    languageOptions: {
      globals: {
        // dom-core 通过 module.exports 暴露给 Node 测试环境
        module: "writable",
      },
    },
    rules: {
      // 尾部 IIFE 的 this 传参是刻意的（兼容无 globalThis 的环境）
      "no-invalid-this": "off",
    },
  },

  {
    files: ["shared/i18n.js"],
    languageOptions: {
      globals: {
        // 同 dom-core：浏览器里挂全局，Node 里走 module.exports 供测试
        module: "writable",
      },
    },
    rules: {
      // 尾部 IIFE 的 this 传参是刻意的（兼容无 globalThis 的环境）
      "no-invalid-this": "off",
    },
  },
];
