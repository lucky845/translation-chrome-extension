import pluginJs from "@eslint/js";
import google from "eslint-config-google";
import prettier from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

export default [
  // 基础配置
  { ignores: ["node_modules/**", "dist/**", "build/**"] },

  // JavaScript标准规则
  pluginJs.configs.recommended,

  // Google风格指南
  google,

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

      // 允许使用未声明的变量（如果在其他文件中定义）
      "no-undef": "error",

      // 调整缩进为2个空格（适合扩展开发）
      indent: ["error", 2, { SwitchCase: 1 }],

      // 允许单行长度更长一些
      "max-len": ["warn", { code: 150, ignoreComments: true }],

      // 允许使用箭头函数（现代JS特性）
      "prefer-arrow-callback": "error",

      // 允许使用const和let
      "prefer-const": "error",

      // 关闭一些Google风格指南中可能不适合扩展开发的规则
      "require-jsdoc": "off",
      "valid-jsdoc": "off",
      camelcase: ["error", { properties: "never" }],

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
];
