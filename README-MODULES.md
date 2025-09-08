# Module Documentation

This document provides detailed information about the various modules in the Web Page Translator Chrome Extension.

## Modules Overview

The extension is organized into several key modules:

1. **Background Module** - Handles communication between different parts of the extension
2. **Content Script Module** - Runs on web pages and performs the actual translation
3. **Popup Module** - Provides the user interface for quick translation actions
4. **Options Module** - Allows users to configure extension settings
5. **Translation API Module** - Implements the translation functionality
6. **Real Translate API Module** - Provides access to Google Translate and Bing Translator APIs

## Background Module

The background module is implemented in `background/background.js` and serves as the central hub for the extension. It handles:

- Message passing between content scripts and popup
- Storage of user preferences
- Context menu creation
- API initialization and management

## Content Script Module

The content script module is implemented in `contentScript/content.js` and runs on every web page. It is responsible for:

- Translating text nodes on the page
- Restoring original text
- Handling scroll events for dynamic content
- Managing translation state across page reloads

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

## Translation API Module

The translation API module is implemented in `translate-api.js` and provides a unified interface for translation services. It supports:

- Multiple translation services
- API key authentication
- Error handling
- Mock translations for development

## Real Translate API Module

The real translate API module is implemented in `real-translate-api.js` and provides direct access to:

- Google Translate API (free)
- Bing Translator API (requires API key)

It handles:
- Authentication and token management
- Batch translation requests
- Language detection
- Error handling and fallback mechanisms