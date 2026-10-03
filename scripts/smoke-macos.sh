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
source scripts/lib/build-test-app.sh
APP="$(build_test_app "$WORK")"

export NOTARIZE_MCP_AUTO_CONFIRM=1
export NOTARIZE_MCP_CONFIG_DIR="$WORK/config"
export NOTARIZE_MCP_LOG_DIR="$WORK/logs"
node scripts/smoke-client.mjs "$APP" "$WORK"
echo "macOS smoke test passed"
