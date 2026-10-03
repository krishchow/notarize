#!/usr/bin/env bash
# Real end-to-end smoke test on a macOS machine/runner. Needs no Apple credentials:
# builds a tiny app with a nested dylib, then drives the MCP server over stdio.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "smoke-macos.sh must run on macOS" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Hello.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Frameworks"

cat > "$WORK/lib.c" <<'C'
int hello_value(void) { return 42; }
C
cat > "$WORK/main.c" <<'C'
#include <stdio.h>
int hello_value(void);
int main(void) { printf("hello %d\n", hello_value()); return 0; }
C
clang -dynamiclib -arch arm64 -arch x86_64 -install_name @rpath/libhello.dylib -o "$APP/Contents/Frameworks/libhello.dylib" "$WORK/lib.c"
clang -arch arm64 -arch x86_64 -o "$APP/Contents/MacOS/Hello" "$WORK/main.c" -L"$APP/Contents/Frameworks" -lhello -Wl,-rpath,@executable_path/../Frameworks
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>Hello</string>
  <key>CFBundleIdentifier</key><string>com.example.notarize-smoke</string>
  <key>CFBundleName</key><string>Hello</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
</dict></plist>
PLIST

export NOTARIZE_MCP_AUTO_CONFIRM=1
export NOTARIZE_MCP_CONFIG_DIR="$WORK/config"
export NOTARIZE_MCP_LOG_DIR="$WORK/logs"
node scripts/smoke-client.mjs "$APP" "$WORK"
echo "macOS smoke test passed"
