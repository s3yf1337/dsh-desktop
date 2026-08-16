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
if [[ "${REBUILD:-0}" == "1" && "$BUILD" == "0" ]]; then
  echo "error: --rebuild and --no-build are mutually exclusive" >&2
  exit 2
fi

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
# Copy into a staging dir, then swap it into place with a single rename so an
# interrupt at any point leaves the old bundle intact — never a half-copied
# package with a dangling node_modules symlink.
BUNDLE_TMP="$PROFILE_DIR/packages/.dsh-desktop-shell.tmp"
mkdir -p "$PROFILE_DIR/packages"
rm -rf "$BUNDLE_TMP"
cp -R "$BUNDLE_SRC" "$BUNDLE_TMP"
rm -rf "$PROFILE_DIR/packages/dsh-desktop-shell"
mv "$BUNDLE_TMP" "$PROFILE_DIR/packages/dsh-desktop-shell"
mkdir -p "$PROFILE_DIR/node_modules"
ln -sfn ../packages/dsh-desktop-shell "$PROFILE_DIR/node_modules/dsh-desktop-shell"

echo "desktop profile ready at $PROFILE_DIR"

# ── 3. the native render client ─────────────────────────────────────────────
# Resolve CARGO_TARGET_DIR the way cargo does: cargo resolves a relative value
# against the current dir of the build ($SCRIPT_DIR/src-tauri); an absolute
# value is used as-is. Defaults to the crate-local target when unset.
if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
  case "$CARGO_TARGET_DIR" in
    /*) CARGO_TARGET_RESOLVED="$CARGO_TARGET_DIR" ;;
    *)  CARGO_TARGET_RESOLVED="$SCRIPT_DIR/src-tauri/$CARGO_TARGET_DIR" ;;
  esac
else
  CARGO_TARGET_RESOLVED="$SCRIPT_DIR/src-tauri/target"
fi

# Check the default/re-directed cargo target dirs for a prebuilt binary.
RELEASE_CANDIDATES=(
  "$CARGO_TARGET_RESOLVED/release/dsh-desktop-shell"
  "$SCRIPT_DIR/src-tauri/target/release/dsh-desktop-shell"
  "$SCRIPT_DIR/target/release/dsh-desktop-shell"
)
DEV_CANDIDATES=(
  "$CARGO_TARGET_RESOLVED/debug/dsh-desktop-shell"
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

# A prebuilt client that predates the source is stale and must be rebuilt:
# a stale binary ships an old command/ACL surface while the bundle copied
# above already expects the new one — the classic symptom is a webview
# "Command desktop_* not allowed by ACL" error on every paste. Compare
# against every source file that shapes the binary (src/, build.rs,
# manifests, capabilities).
CLIENT_STALE=0
if [[ -n "$CLIENT" ]]; then
  if [[ -n "$(find \
    "$SCRIPT_DIR/src-tauri/src" \
    "$SCRIPT_DIR/src-tauri/build.rs" \
    "$SCRIPT_DIR/src-tauri/Cargo.toml" \
    "$SCRIPT_DIR/src-tauri/Cargo.lock" \
    "$SCRIPT_DIR/src-tauri/tauri.conf.json" \
    "$SCRIPT_DIR/src-tauri/capabilities" \
    -newer "$CLIENT" -print -quit 2>/dev/null)" ]]; then
    CLIENT_STALE=1
  fi
fi

if [[ -z "$CLIENT" || "${REBUILD:-0}" == "1" || "$CLIENT_STALE" == "1" ]]; then
  if [[ "$BUILD" != "1" ]]; then
    if [[ "$CLIENT_STALE" == "1" ]]; then
      echo "warning: $CLIENT is older than the source (stale build); keeping it because --no-build was given." >&2
      echo "  the stale binary may reject commands the bundle needs (\"not allowed by ACL\" errors)." >&2
      echo "  rebuild it: cd \"$SCRIPT_DIR/src-tauri\" && cargo build --release" >&2
    else
      echo "error: no built client binary found and --no-build given." >&2
      echo "  build it first: cd \"$SCRIPT_DIR/src-tauri\" && cargo build --release" >&2
      exit 1
    fi
  else
    if ! command -v cargo >/dev/null 2>&1; then
      echo "error: cargo not found on PATH and no prebuilt client binary exists." >&2
      echo "  install Rust (https://rustup.rs) or download a release binary." >&2
      exit 1
    fi
    echo "building native client (cargo build --release) ..."
    (cd "$SCRIPT_DIR/src-tauri" && CARGO_HOME="${CARGO_HOME:-$HOME/.dsh/.cargo-home}" cargo build --release)
    CLIENT="$CARGO_TARGET_RESOLVED/release/dsh-desktop-shell"
  fi
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
# never run by hand. Resolution order in the plugin is config.bin →
# DSH_DESKTOP_BIN → $DSH_HOME/bin/dsh-desktop-shell → PATH →
# ~/.local/bin/dsh-desktop-shell, so without an explicit prefix the primary
# copy must go to $DSH_HOME/bin (or an older binary there would silently win);
# ~/.local/bin then just symlinks to it so both paths see the same file.
if [[ "${DSH_DESKTOP_PREFIX:-}" ]]; then
  CLIENT_BIN_DIR="$BIN_DIR"
else
  CLIENT_BIN_DIR="$DSH_HOME/bin"
  mkdir -p "$CLIENT_BIN_DIR"
fi
cp -f "$CLIENT" "$CLIENT_BIN_DIR/dsh-desktop-shell"
chmod +x "$CLIENT_BIN_DIR/dsh-desktop-shell"
if [[ -z "${DSH_DESKTOP_PREFIX:-}" ]]; then
  rm -f "$BIN_DIR/dsh-desktop-shell"
  ln -sfn "$CLIENT_BIN_DIR/dsh-desktop-shell" "$BIN_DIR/dsh-desktop-shell"
fi

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
# Quote + escape the launcher path per the desktop entry spec: wrap it in
# double quotes and backslash-escape `"`, backtick, `$` and `\` so a prefix
# with spaces or shell metacharacters stays a single Exec argument.
# (The BIN_DIR is substituted by bash first; the escaped form must survive the
# heredoc, so escape backslashes and quotes for it too.)
ESCAPED_BIN_DIR="${BIN_DIR//\\/\\\\}"
ESCAPED_BIN_DIR="${ESCAPED_BIN_DIR//\"/\\\"}"
ESCAPED_BIN_DIR="${ESCAPED_BIN_DIR//\`/\\\`}"
ESCAPED_BIN_DIR="${ESCAPED_BIN_DIR//\$/\\\$}"
cat > "$DESKTOP_FILE" <<EOF
[Desktop Entry]
Type=Application
Name=DeepSeek Harness
GenericName=AI Coding Assistant
Comment=Desktop profile for the DeepSeek Harness (native window over the web surface)
Exec="$ESCAPED_BIN_DIR/dsh-desktop"
Icon=$ICON_NAME
Terminal=false
Categories=Development;Utility;
StartupWMClass=dsh-desktop
EOF

echo
if [[ "${DSH_DESKTOP_PREFIX:-}" ]]; then
  echo "Installed client:   $CLIENT_BIN_DIR/dsh-desktop-shell"
else
  echo "Installed client:   $CLIENT_BIN_DIR/dsh-desktop-shell (symlinked from $BIN_DIR/dsh-desktop-shell)"
fi
echo "Installed launcher: $BIN_DIR/dsh-desktop"
echo "Desktop entry:      $DESKTOP_FILE"
echo
echo "Launch it from your application menu, or run: $BIN_DIR/dsh-desktop"
echo "Or boot the profile directly: dsh --profile desktop"
