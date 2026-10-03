# Source this file, then: build_test_app <dir>  → creates <dir>/Hello.app (universal, with a nested dylib)
# and prints its path. Requires clang (Xcode or Command Line Tools).
build_test_app() {
  local work="$1"
  local app="$work/Hello.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Frameworks" "$app/Contents/Resources"
  cat > "$work/lib.c" <<'C'
int hello_value(void) { return 42; }
C
  cat > "$work/main.c" <<'C'
#include <stdio.h>
int hello_value(void);
int main(void) { printf("hello %d\n", hello_value()); return 0; }
C
  clang -dynamiclib -arch arm64 -arch x86_64 -install_name @rpath/libhello.dylib \
    -o "$app/Contents/Frameworks/libhello.dylib" "$work/lib.c"
  clang -arch arm64 -arch x86_64 -o "$app/Contents/MacOS/Hello" "$work/main.c" \
    -L"$app/Contents/Frameworks" -lhello -Wl,-rpath,@executable_path/../Frameworks
  echo "resource" > "$app/Contents/Resources/data.txt"
  cat > "$app/Contents/Info.plist" <<'PLIST'
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
  echo "$app"
}
