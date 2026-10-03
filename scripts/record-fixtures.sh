#!/usr/bin/env bash
# Record REAL macOS tool output into test/fixtures/recorded/ so parsers are tested against
# what this Mac's codesign/spctl/otool/xcodebuild/notarytool actually print.
# Usage: bash scripts/record-fixtures.sh [--with-notary]
#   --with-notary  also record `notarytool history` (needs NOTARY_KEYCHAIN_PROFILE or ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY_PATH)
# Output is redacted (home dir, user name, team names/IDs) — still review it before committing.
set -uo pipefail
cd "$(dirname "$0")/.."

if [[ "$(uname)" != "Darwin" ]]; then
  echo "record-fixtures.sh must run on macOS" >&2
  exit 1
fi

OUT="test/fixtures/recorded"
mkdir -p "$OUT"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
source scripts/lib/build-test-app.sh
APP="$(build_test_app "$WORK")"

redact() {
  sed -E \
    -e "s#$HOME#/Users/tester#g" \
    -e "s#$WORK#/tmp/work#g" \
    -e "s#/Users/$USER#/Users/tester#g" \
    -e 's#\(([A-Z0-9]{10})\)#(TEAMID1234)#g' \
    -e 's#TeamIdentifier=[A-Z0-9]{10}#TeamIdentifier=TEAMID1234#g' \
    -e 's#(Developer ID [A-Za-z]+|Apple Development|Apple Distribution|3rd Party Mac Developer [A-Za-z]+|Mac Installer Distribution): [^(]*\(#\1: Example Developer (#g'
}

# rec <file> <command...> — records redacted stdout+stderr, and the exit code in <file>.exit
rec() {
  local file="$1"; shift
  local tmp; tmp="$(mktemp)"
  "$@" >"$tmp" 2>&1
  local code=$?
  redact <"$tmp" >"$OUT/$file"
  echo "$code" >"$OUT/$file.exit"
  rm -f "$tmp"
  echo "recorded $OUT/$file (exit $code)"
}

rec codesign-linker-signed.txt codesign -dvvv "$APP/Contents/MacOS/Hello"
rec codesign-unsigned-bundle.txt codesign -dvvv "$APP"
codesign --force --sign - --options runtime "$APP/Contents/Frameworks/libhello.dylib"
codesign --force --sign - --options runtime "$APP"
rec codesign-adhoc-runtime.txt codesign -dvvv "$APP"
rec codesign-verify-valid.txt codesign --verify --deep --strict --verbose=4 "$APP"
echo "tampered" >> "$APP/Contents/Resources/data.txt"
rec codesign-verify-tampered.txt codesign --verify --deep --strict --verbose=4 "$APP"
codesign --force --sign - --options runtime "$APP"
rec spctl-adhoc-app.txt spctl --assess --type execute -vvv "$APP"
rec security-find-identity.txt security find-identity -p codesigning
rec otool-libs-recorded.txt otool -L "$APP/Contents/MacOS/Hello"
rec otool-loadcmds-recorded.txt otool -l "$APP/Contents/MacOS/Hello"
rec lipo-archs.txt lipo -archs "$APP/Contents/MacOS/Hello"
rec xcodebuild-version.txt xcodebuild -version
if command -v syspolicy_check >/dev/null; then
  rec syspolicy-check.txt syspolicy_check distribution "$APP"
fi
rec altool-help.txt xcrun altool --help
rec notarytool-help.txt xcrun notarytool --help

# A minimal Xcode project for `xcodebuild -list -json` (Swift package → xcodebuild understands it too)
mkdir -p "$WORK/Pkg/Sources/Pkg"
cat > "$WORK/Pkg/Package.swift" <<'SWIFT'
// swift-tools-version:5.9
import PackageDescription
let package = Package(name: "Pkg", targets: [.executableTarget(name: "Pkg")])
SWIFT
echo 'print("hi")' > "$WORK/Pkg/Sources/Pkg/main.swift"
rec xcodebuild-list.json bash -c 'cd "$1" && xcodebuild -list -json' _ "$WORK/Pkg"

if [[ "${1:-}" == "--with-notary" ]]; then
  if [[ -n "${NOTARY_KEYCHAIN_PROFILE:-}" ]]; then
    rec notarytool-history.json xcrun notarytool history --keychain-profile "$NOTARY_KEYCHAIN_PROFILE" --output-format json
  elif [[ -n "${ASC_KEY_ID:-}" ]]; then
    rec notarytool-history.json xcrun notarytool history --key "$ASC_PRIVATE_KEY_PATH" --key-id "$ASC_KEY_ID" --issuer "$ASC_ISSUER_ID" --output-format json
  else
    echo "--with-notary: set NOTARY_KEYCHAIN_PROFILE or ASC_* env vars" >&2
  fi
fi

echo "Done. Run: npm run test:recorded"
