# Desktop icon sources

`homeplace-mobile-symbol.png` is the shared HomePlace mark from the Mobile application.

The desktop masters keep the mark unchanged while adapting its container to each platform:

- `macos-master.png` uses the macOS safe area, rounded silhouette and additional optical margin.
- `windows-master.png` uses a larger tile and mark so it remains legible in the Windows taskbar and Start menu.

Regenerate the master artwork from the shared symbol:

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/homeplace-swift-cache \
SWIFT_MODULECACHE_PATH=/private/tmp/homeplace-swift-cache \
swift scripts/generate-icons.swift \
  src-tauri/icons/source/homeplace-mobile-symbol.png \
  src-tauri/icons/source
```

Use the Tauri icon command on each master. Keep `icon.icns` from the macOS output and use the Windows output for `icon.ico`, PNG and AppX assets.
