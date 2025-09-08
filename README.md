# Web Page Translator Chrome Extension

A Chrome extension that allows you to translate any webpage to your preferred language with a single click.

## Features

- Translate entire web pages with one click
- Support for multiple languages
- Option to restore original text
- Context menu integration
- Support for translating selected text
- Configurable target language
- Support for Google Translate API (with API key)

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

- English
- Spanish
- French
- German
- Chinese (Simplified)
- Japanese
- Korean
- Russian
- Arabic

## Technical Details

This extension is built using Manifest V3 and follows modern Chrome extension practices:

- **manifest.json**: Extension configuration
- **background/background.js**: Background service worker handling translations
- **contentScript/content.js**: Content script that runs on web pages
- **popup/popup.html**: Popup UI for quick translation actions
- **options/options.html**: Options page for configuration
- **translate-api.js**: Interface for translation services
- **real-translate-api.js**: Implementation for Google Translate API

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