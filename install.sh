#!/usr/bin/env bash
# dsh-desktop — one-command bootstrap for the dsh desktop profile.
#
# Installs the desktop experience as a real profile:
#   1. creates $DSH_HOME/profiles/desktop (manifest + user layer + workspace),
#   2. copies this repo's bundle/ into the profile and links it into its
#      node_modules (no pnpm or registry needed),
#   3. builds the native render client (dsh-desktop-shell) when missing,
#   4. installs the client binary + `dsh-desktop` launcher to PATH and
#      registers a desktop (application-menu) entry.
#
# Usage:
#   ./install.sh               full bootstrap (builds the client if needed)
#   ./install.sh --no-build    use an existing client binary, never build
#   ./install.sh --rebuild     force a client rebuild
#
# Idempotent: an existing profile is kept (manifest, user cordis.patch.yml);
# the bundle copy is refreshed from this repo on every run.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/desktop"
BUNDLE_SRC="$SCRIPT_DIR/bundle"

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    --rebuild) REBUILD=1 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# ── 1. the profile directory ────────────────────────────────────────────────
mkdir -p "$PROFILE_DIR"

if [[ ! -f "$PROFILE_DIR/package.json" ]]; then
  cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-desktop-shell": "file:./packages/dsh-desktop-shell"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-desktop-shell"
      ]
    }
  }
}
EOF
fi

if [[ ! -f "$PROFILE_DIR/cordis.patch.yml" ]]; then
  cat > "$PROFILE_DIR/cordis.patch.yml" <<'EOF'
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
EOF
fi

if [[ ! -f "$PROFILE_DIR/pnpm-workspace.yaml" ]]; then
  cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .
  - packages/dsh-desktop-shell

nodeLinker: hoisted
autoInstallPeers: false
EOF
fi

# ── 2. the bundle (refreshed copy + node_modules link) ──────────────────────
rm -rf "$PROFILE_DIR/packages/dsh-desktop-shell"
mkdir -p "$PROFILE_DIR/packages"
cp -R "$BUNDLE_SRC" "$PROFILE_DIR/packages/dsh-desktop-shell"
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn ../packages/dsh-desktop-shell "$PROFILE_DIR/node_modules/dsh-desktop-shell"

echo "desktop profile ready at $PROFILE_DIR"

# ── 3. the native render client ─────────────────────────────────────────────
# Check both the default cargo target dir and the redirected CARGO_TARGET_DIR.
RELEASE_CANDIDATES=(
  "$SCRIPT_DIR/src-tauri/target/release/dsh-desktop-shell"
  "$SCRIPT_DIR/target/release/dsh-desktop-shell"
)
DEV_CANDIDATES=(
  "$SCRIPT_DIR/src-tauri/target/debug/dsh-desktop-shell"
  "$SCRIPT_DIR/target/debug/dsh-desktop-shell"
)

CLIENT=""
for c in "${RELEASE_CANDIDATES[@]}"; do
  if [[ -x "$c" ]]; then CLIENT="$c"; break; fi
done
if [[ -z "$CLIENT" ]]; then
  for c in "${DEV_CANDIDATES[@]}"; do
    if [[ -x "$c" ]]; then CLIENT="$c"; break; fi
  done
fi

if [[ -z "$CLIENT" || "${REBUILD:-0}" == "1" ]]; then
  if [[ "$BUILD" != "1" ]]; then
    echo "error: no built client binary found and --no-build given." >&2
    echo "  build it first: cd \"$SCRIPT_DIR/src-tauri\" && cargo build --release" >&2
    exit 1
  fi
  if ! command -v cargo >/dev/null 2>&1; then
    echo "error: cargo not found on PATH and no prebuilt client binary exists." >&2
    echo "  install Rust (https://rustup.rs) or download a release binary." >&2
    exit 1
  fi
  echo "building native client (cargo build --release) ..."
  (cd "$SCRIPT_DIR/src-tauri" && CARGO_HOME="${CARGO_HOME:-$HOME/.dsh/.cargo-home}" cargo build --release)
  CLIENT="$SCRIPT_DIR/src-tauri/target/release/dsh-desktop-shell"
fi

# ── 4. install: client + launcher + desktop entry ────────────────────────────
if [[ "${DSH_DESKTOP_PREFIX:-}" ]]; then
  BIN_DIR="$DSH_DESKTOP_PREFIX/bin"
  APP_DIR="$DSH_DESKTOP_PREFIX/share/applications"
  ICON_DIR="$DSH_DESKTOP_PREFIX/share/icons/hicolor"
else
  BIN_DIR="${HOME}/.local/bin"
  APP_DIR="${HOME}/.local/share/applications"
  ICON_DIR="${HOME}/.local/share/icons/hicolor"
fi

mkdir -p "$BIN_DIR" "$APP_DIR"

# The native render client. It is spawned by the desktop profile's
# desktop-shell plugin with the served URL (`dsh-desktop-shell <url>`) and is
# never run by hand.
cp -f "$CLIENT" "$BIN_DIR/dsh-desktop-shell"
chmod +x "$BIN_DIR/dsh-desktop-shell"

# The menu/CLI launcher: boots the real profile (`dsh --profile desktop`),
# whose plugin then spawns the client above with the served URL.
cp -f "$SCRIPT_DIR/dsh-desktop" "$BIN_DIR/dsh-desktop"
chmod +x "$BIN_DIR/dsh-desktop"

# Application icon into the hicolor theme so the menu entry shows the real
# icon instead of a generic terminal glyph.
ICON_NAME="deepseek-harness"
for size in 32x32 128x128 256x256 512x512; do
  ICON_SIZE_DIR="$ICON_DIR/$size/apps"
  mkdir -p "$ICON_SIZE_DIR"
  case "$size" in
    32x32)   SRC_ICON="$SCRIPT_DIR/src-tauri/icons/32x32.png" ;;
    128x128) SRC_ICON="$SCRIPT_DIR/src-tauri/icons/128x128.png" ;;
    256x256) SRC_ICON="$SCRIPT_DIR/src-tauri/icons/128x128@2x.png" ;;
    512x512) SRC_ICON="$SCRIPT_DIR/src-tauri/icons/512x512.png" ;;
  esac
  if [[ -f "$SRC_ICON" ]]; then
    cp -f "$SRC_ICON" "$ICON_SIZE_DIR/$ICON_NAME.png"
  fi
done

DESKTOP_FILE="$APP_DIR/dsh-desktop.desktop"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=DeepSeek Harness
GenericName=AI Coding Assistant
Comment=Desktop profile for the DeepSeek Harness (native window over the web surface)
Exec=$BIN_DIR/dsh-desktop
Icon=$ICON_NAME
Terminal=false
Categories=Development;Utility;
StartupWMClass=dsh-desktop
EOF

echo
echo "Installed client:   $BIN_DIR/dsh-desktop-shell"
echo "Installed launcher: $BIN_DIR/dsh-desktop"
echo "Desktop entry:      $DESKTOP_FILE"
echo
echo "Launch it from your application menu, or run: $BIN_DIR/dsh-desktop"
echo "Or boot the profile directly: dsh --profile desktop"
