#!/bin/sh
set -eu

if [ "$(uname -s)" != "Darwin" ]; then
  exit 0
fi

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$repo_dir/src-tauri/macos"
target_dir="$source_dir/build"
cache_dir="$repo_dir/src-tauri/target/swift-module-cache"
extension_dir="$target_dir/HomePlaceShare.appex"
extension_contents="$extension_dir/Contents"
architecture=$(uname -m)
deployment_target="${architecture}-apple-macosx13.0"

mkdir -p "$target_dir" "$cache_dir" "$extension_contents/MacOS"

CLANG_MODULE_CACHE_PATH="$cache_dir/clang" \
SWIFT_MODULE_CACHE_PATH="$cache_dir/swift" \
xcrun swiftc \
  -swift-version 5 \
  -target "$deployment_target" \
  "$source_dir/HomePlaceNativeBridge.swift" \
  -o "$target_dir/HomePlaceNativeBridge" \
  -framework AppKit \
  -framework CoreGraphics \
  -framework LocalAuthentication

CLANG_MODULE_CACHE_PATH="$cache_dir/clang" \
SWIFT_MODULE_CACHE_PATH="$cache_dir/swift" \
xcrun swiftc \
  -swift-version 5 \
  -parse-as-library \
  -target "$deployment_target" \
  -module-name HomePlaceShare \
  "$source_dir/HomePlaceShareExtension.swift" \
  -o "$extension_contents/MacOS/HomePlaceShare" \
  -emit-executable \
  -Xlinker -e \
  -Xlinker _NSExtensionMain \
  -framework AppKit \
  -framework UniformTypeIdentifiers

cp "$source_dir/HomePlaceShare-Info.plist" "$extension_contents/Info.plist"
codesign --force --sign - \
  --entitlements "$source_dir/HomePlaceShare.entitlements" \
  "$extension_dir"
