# dsh-desktop

DeepSeek Harness running in a native desktop window (Tauri), with a tray icon,
native notifications, and close-to-tray behavior.

[![build](https://github.com/s3yf1337/dsh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/s3yf1337/dsh-desktop/actions/workflows/build.yml)
[![release](https://img.shields.io/github/v/release/s3yf1337/dsh-desktop?sort=semver&label=release)](https://github.com/s3yf1337/dsh-desktop/releases)
[![license](https://img.shields.io/github/license/s3yf1337/dsh-desktop)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Linux%20%E2%80%A2%20macOS%20%E2%80%A2%20Windows-2ea44f)](#)

## Features

- Runs the harness in its own native window with an app icon in the dock/taskbar.
- Closing the window hides it to the tray; running agents keep working.
- Native notifications on agent finish, error, and question events.
- Update checks that only suggest a new version; updates are never forced.
- Workspace selection via the OS folder dialog, or drag-and-drop a folder into
  the window.
- A **dsh-desktop** tab inside the harness Settings for desktop preferences.

## Install

Requires the `dsh` CLI (and Rust, only for the first build):

```sh
git clone https://github.com/s3yf1337/dsh-desktop && cd dsh-desktop
./install.sh
dsh-desktop
```

Runs on Linux, macOS, and Windows.

---

<details>
<summary>Technical details (for contributors)</summary>

### How it works

```
dsh --profile desktop            (or the `dsh-desktop` menu launcher)
  └─ dsh-base + dsh-web-app      the whole web surface: server, /api, SPA
       └─ dsh-desktop-shell      this repo's plugin bundle: after the server
            binds, spawns dsh-desktop-shell <url> and watches it
                 └─ dsh-desktop-shell        (native client, src-tauri/)
                      opens a native WebView on http://127.0.0.1:<port>
                      window closed → exit 0 → plugin shuts the harness down
```

`dsh-desktop` is a **profile** for the DeepSeek Harness, composed from the
standard bundles (`dsh-base` + `dsh-web-app`) plus this repo's
`dsh-desktop-shell` plugin. The plugin spawns the native Tauri client on the
served loopback URL; the WebView loads the exact same `127.0.0.1` origin a
browser would, so the whole SPA works unchanged and same-origin. The client
exposes `window.__TAURI__` to that origin (`withGlobalTauri`), and the plugin
pipes agent-lifecycle events to the client over a stdin control channel
(`{"event":"notify"|"title", ...}` JSON lines).

#### Install options

```sh
./install.sh            # full bootstrap (builds the client if needed)
./install.sh --no-build # use an existing client binary, never build
./install.sh --rebuild  # force a client rebuild
```

`install.sh` creates `$DSH_HOME/profiles/desktop` (bundle copied and linked,
no pnpm/registry needed), builds the client if missing, installs
`dsh-desktop-shell` + the `dsh-desktop` launcher to `~/.local/bin`, installs
the icon into the hicolor theme, and registers a desktop menu entry.
Idempotent: re-running refreshes the bundle copy and never touches your
profile's `cordis.patch.yml` user layer.

#### Release artifacts (CI-built)

Every `v*` tag builds the client binary on all three platforms via GitHub
Actions and publishes them as a release — plus a tarball of the plugin
bundle:

- `dsh-desktop-shell-linux-x86_64`, `dsh-desktop-shell-macos-aarch64`,
  `dsh-desktop-shell-windows-x86_64.exe` — the native render client
- `dsh-desktop-shell-bundle-<tag>.tgz` — the `bundle/` plugin package

Drop the right binary in place (or let `install.sh` copy it with
`--no-build`) and run the profile as usual.

#### Configuration

The `dsh-desktop` launcher resolves the `dsh` CLI: `$DSH_DESKTOP_DSH` →
`$DSH_BIN` → `dsh` on `PATH`. `DSH_HOME` is inherited (defaults to
`$HOME/.dsh`).

The native client honors:

- `DSH_DESKTOP_NO_SINGLE_INSTANCE=1` — skip the single-instance guard so a
  second harness can run side by side (development/debugging)
- `DSH_DESKTOP_BIN` — an explicit client binary path

Client binary resolution in the bundle plugin: `config.bin` → `DSH_DESKTOP_BIN`
→ `dsh-desktop-shell` on `PATH` → `~/.local/bin/dsh-desktop-shell`. With no
binary found the harness still serves the web UI (degrades to browser use).

#### Layout

```
bundle/                  the dsh-desktop-shell plugin package (bundle contract)
  cordis.patch.yml       inserts the desktop-shell row
  lib/index.js           spawn/watcher plugin (webServer, appExit, stdin control)
  lib/client.js          browser half: the "dsh-desktop" settings tab + drag&drop
dist/index.html          loading page shown while the WebView boots
dsh-desktop              launcher wrapper: exec dsh --profile desktop
install.sh               one-command bootstrap (profile + client + icons + menu entry)
src-tauri/               the native render client (the actual app)
  src/main.rs
  src/lib.rs             URL parsing, navigate, show, exit on close; tray,
                         close-to-tray, single-instance, stdin control channel
  src/commands.rs        desktop_* commands the settings tab invokes
  src/settings.rs        persisted desktop preferences (dsh-desktop.json)
  src/tray.rs            tray icon + menu (show/hide, updates, quit)
  src/update.rs          update orchestration (check, emit, notify, loop)
  src/updater.rs         GitHub releases API client (suggest-only)
  src/log.rs             file + stderr logging (dsh-desktop.log)
  Cargo.toml
  tauri.conf.json
  capabilities/default.json
```

The installed profile lives at `$DSH_HOME/profiles/desktop/`:

```
profiles/desktop/
  package.json           dsh.profile.bundles: base + web-app + dsh-desktop-shell
  cordis.patch.yml       your patch layer
  packages/dsh-desktop-shell/   a copy of bundle/ (refreshed by install.sh)
```

</details>

## License

[MIT](LICENSE)
