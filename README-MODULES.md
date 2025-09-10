# Module Documentation

This document provides detailed information about the various modules in the Web Page Translator Chrome Extension.

## Modules Overview

The extension is organized into several key modules:

1. **Background Module** - Central hub handling communication, translation APIs, and settings
2. **Content Script Module** - Runs on web pages and performs the actual translation
3. **Popup Module** - Provides the user interface for quick translation actions
4. **Options Module** - Allows users to configure extension settings
5. **Internationalization Module** - Supports multi-language interface
6. **Icons Module** - Provides extension icons in different sizes

## Background Module

The background module is implemented in `background/background.js` and serves as the central hub for the extension. It handles:

- Message passing between content scripts and popup
- Storage of user preferences
- Context menu creation
- API implementation for multiple translation services
- Language detection and mapping
- Batch translation requests
- Error handling and fallback mechanisms

This module implements translation service classes extending a base API class, currently supporting Google Translate and Bing Translator. Microsoft Translator is implemented through the Bing Translator API. Yandex Translate support is not currently implemented.

## Content Script Module

The content script module is implemented in `contentScript/content.js` and runs on every web page. It is responsible for:

- Translating text nodes on the page while preserving formatting
- Restoring original text
- Handling scroll events for dynamic content
- Managing translation state
- Listening for page mutations to handle dynamically loaded content
- Communicating with the background module
- Processing translation requests from the popup or context menu

## Popup Module

The popup module is implemented in `popup/popup.html` and `popup/popup.js` and provides a simple interface for users to:

- Select target language
- Translate the current page
- Restore original text
- Access options

## Options Module

The options module is implemented in `options/options.html` and `options/options.js` and allows users to:

- Set default target language
- Choose translation service (Google or Bing)
- Enter API key for Bing Translator
- Save and load settings

## Internationalization Module

The internationalization module is implemented in the `_locales/` directory and provides support for multi-language interface. It includes:

- English (en) language resources
- Simplified Chinese (zh_CN) language resources

This module allows the extension's user interface to adapt to the user's browser language preferences.

## Icons Module

The icons module is implemented in the `icons/` directory and provides visual representation for the extension. It includes:

- Four different sizes of icons (16x16, 32x32, 48x48, and 128x128 pixels)
- Logo design script for generating consistent icons