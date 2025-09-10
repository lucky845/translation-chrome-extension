# Web Page Translator Chrome Extension

A Chrome extension that allows you to translate any webpage to your preferred language with a single click.

## Features

- Translate entire web pages with one click, preserving original formatting and layout
- Support for over 20 languages
- Option to restore original text at any time
- Context menu integration for quick translation of pages or selected text
- Auto-detection of source language
- Configurable default target language
- Support for multiple translation services: Google Translate and Bing Translator (Microsoft Translator implemented through Bing Translator API)
- Keyboard shortcut (Alt+T) for quick translation toggle
- Support for translating dynamically loaded content
- Support for multi-frame page translation

## Installation

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right corner
4. Click "Load unpacked" and select the extension directory

## Usage

1. Click the extension icon in the toolbar to open the popup
2. Select your target language
3. Click "Translate Page" to translate the current webpage
4. Click "Show Original" to revert to the original text
5. Use the context menu option to translate pages or selected text

## Configuration

1. Click the "Options" button in the popup to open the settings page
2. Select your default target language
3. (Optional) Enter your Google Translate API key for better translations

## Supported Languages

The extension supports translation between 30 languages, including auto-detection functionality. The complete list of languages is as follows:

- Auto-detect (auto)
- Chinese (Simplified) (zh-CN)
- Chinese (Traditional) (zh-TW)
- English (en)
- Japanese (ja)
- Korean (ko)
- French (fr)
- German (de)
- Spanish (es)
- Russian (ru)
- Portuguese (pt)
- Italian (it)
- Arabic (ar)
- Hindi (hi)
- Thai (th)
- Vietnamese (vi)
- Indonesian (id)
- Malay (ms)
- Polish (pl)
- Turkish (tr)
- Dutch (nl)
- Swedish (sv)
- Danish (da)
- Finnish (fi)
- Norwegian (no)
- Hungarian (hu)
- Czech (cs)
- Romanian (ro)
- Ukrainian (uk)
- Greek (el)

## Technical Details

This extension is built using Manifest V3 and follows modern Chrome extension practices:

- **manifest.json**: Extension configuration file defining permissions, icons, popup pages, etc.
- **background/background.js**: Background service worker handling translation logic, API calls, and message passing
- **contentScript/content.js**: Content script running on web pages, responsible for actual page translation and state management
- **popup/popup.html**: Popup UI for quick translation actions, providing translation/restore functions and settings access
- **options/options.html**: Options page allowing users to set default language and translation service
- **_locales/**: Internationalization resource files supporting multi-language interface
- **icons/**: Extension icon files in four different sizes

## Development

To modify the extension:

1. Make your changes to the relevant files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card

## Limitations

- Without an API key, translations are simulated
- Some web pages with complex structures may not translate perfectly
- Dynamic content loaded after page load may not be automatically translated

## Future Improvements

- Support for more translation services
- Auto-detection of source language
- Improved handling of dynamic content
- Translation history
- Better UI/UX

## Credits

Based on the [Traduzir-paginas-web](https://github.com/FilipePS/Traduzir-paginas-web) project by Filipe Pereira.