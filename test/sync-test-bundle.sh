#!/usr/bin/env bash
# Refresh the test profile's bundle copy from repo/bundle (run before
# restarting the test instance after editing bundle/ files).
set -euo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$ROOT/.test-home"
DEST="$TEST_HOME/profiles/desktop/packages/dsh-desktop-shell"
rm -rf "$DEST"
mkdir -p "$TEST_HOME/profiles/desktop/packages"
cp -R "$ROOT/bundle" "$DEST"
ln -sfn ../packages/dsh-desktop-shell "$TEST_HOME/profiles/desktop/node_modules/dsh-desktop-shell"
echo "bundle synced to $DEST"
