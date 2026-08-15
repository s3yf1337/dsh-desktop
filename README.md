# dsh-desktop

**DeepSeek Harness in a native desktop window — built the way the harness
itself is built: as a plugin, not a fork.**

[![build](https://github.com/s3yf1337/dsh-desktop/actions/workflows/build.yml/badge.svg)](https://github.com/s3yf1337/dsh-desktop/actions/workflows/build.yml)
[![release](https://img.shields.io/github/v/release/s3yf1337/dsh-desktop?sort=semver&label=release)](https://github.com/s3yf1337/dsh-desktop/releases)
[![license](https://img.shields.io/github/license/s3yf1337/dsh-desktop)](LICENSE)
[![platform](https://img.shields.io/badge/platform-Linux%20%E2%80%A2%20macOS%20%E2%80%A2%20Windows-2ea44f)](#)
[![dsh](https://img.shields.io/badge/dsh-plugin-4F46E5)](#)

`dsh-desktop` is a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
profile that composes the standard bundles (`dsh-base` + `dsh-web-app`) with a
small plugin — this repo's `dsh-desktop-shell` — which opens the harness web
surface in a native Tauri window: custom title bar, tray icon, native
notifications, a real file-manager panel, and one-click updates.

## The idea: desktop as a plugin

DeepSeek Harness is built on the principle that *everything is a plugin*:
models, tools, sandboxes, session storage, the UI — even the agent loop
itself. The desktop experience should follow the same rule.

This project adds a native window **without forking or repackaging the
harness**. The profile is plain composition:

```
dsh --profile desktop      →   dsh-base + dsh-web-app + dsh-desktop-shell
```

That one decision buys a lot:

- **Always in sync.** The harness keeps updating; so do you. There is no fork
  to rebase and no bundled copy to refresh — upstream releases land in your
  profile exactly the way they always do.
- **Composable.** The shell is one row in your profile's bundle list. Keep
  your other bundles, swap the web app, add plugins — the desktop layer stays
  a layer, not a replacement.
- **Small.** The native client is a Tauri binary, not a bundled browser plus a
  full runtime. Your dsh stays your dsh.
- **Honest trade-off.** The plugin approach assumes you already run `dsh`. If
  you want a single installer with zero prerequisites, a standalone app that
  bundles its own runtime is the better fit. If you want the desktop to be
  *part of* your harness — same config, same workspaces, same plugins — this
  is the one that fits.

## Features

- **Native window** with an app icon in the dock/taskbar and a custom title
  bar (drag region, minimize/maximize/close) drawn by the web surface,
  matching the app theme on every platform. The window title follows the
  chat open in the UI right now (`DeepSeek Harness — <chat title>`), not
  the last started agent.
- **Explorer panel — a real file manager.** Browse any folder (not just the
  workspace) with breadcrumbs, back/forward, name filter and recursive
  search, sort by name/size/date. Right-click or keyboard (F2 rename, Del to
  trash, arrows) to create, rename, copy, cut, paste, delete, open
  externally. Files changed or created since your last look are marked live
  (auto-refresh). A **Preview** tab renders markdown with the app's own
  renderer (headings, tables, task lists, syntax-highlighted code with a
  copy button, math — and relative images resolved from the local disk),
  renders **mermaid diagrams** (bundled with the app, works offline) and
  **CSV/TSV tables with line/bar charts**, opens local `.html` pages in a
  sandboxed frame, shows images (click to zoom, dimensions),
  syntax-highlights source code files (shiki, the app's own highlighter),
  and falls back to a hex dump for binary files. A URL bar in the preview
  opens any web page (external links land in the system browser). Previews
  re-render automatically when the file changes on disk (text 1 MiB /
  images 8 MiB caps).
- **Wired into the harness.** Right-click a file → *Send path to agent*
  inserts its workspace-relative path into the composer; images can be
  attached to a message — or just **drag an image file into the window**:
  it lands in the composer as a real attachment (any other file inserts its
  path). The workspace picker (hero + sidebar + settings) is the panel in
  "choose a folder" mode instead of an OS dialog.
- **Links that work.** Every `http(s)`/`mailto` link in the chat and in
  markdown previews opens in your system browser — no more dead
  `target="_blank"` clicks inside the webview.
- **Chat search (Ctrl/Cmd+F).** A quick-search bar over the conversation:
  live case-insensitive highlighting, Enter/↑/↓ to jump between matches,
  Esc to leave. Highlights are painted over the text without touching the
  message DOM, so streaming re-renders never corrupt the chat.
- **Tray + close-to-tray.** Closing the window hides it; running agents keep
  working. The tray menu carries a **live agent monitor**: every running
  agent with a refreshable log tail and a **Stop agent** action, plus a
  badge on the tray icon when an agent finishes (cleared from the menu).
- **Native notifications** on agent finish, error, and question events.
- **One-click updates.** Download, apply, restart. Nothing is applied
  automatically; background checks are opt-in (off by default).
- **Workspace selection** via the OS folder dialog, or drag-and-drop a folder
  into the window.
- **A `dsh-desktop` tab** inside the harness Settings for desktop
  preferences.

## Screenshot

![dsh-desktop](image.png)

*DeepSeek Harness in a native window: the harness web surface with the
custom title bar and the explorer panel.*

## Install

**Requires** the `dsh` CLI. Rust is needed only for the first build from
source — prebuilt client binaries skip it.

Pre-built installers per platform — `.deb` (Linux), `.dmg` (macOS), NSIS
`.exe` (Windows) — are published on the
[releases](https://github.com/s3yf1337/dsh-desktop/releases) page. One
installer places the client binary and registers an app-menu entry; the
first launch bootstraps the desktop profile into dsh and opens the window.

From source (Linux/macOS dev path):

```sh
git clone https://github.com/s3yf1337/dsh-desktop && cd dsh-desktop
./install.sh              # full bootstrap (builds the client if needed)
./install.sh --no-build   # use an existing client binary, never build
./install.sh --rebuild    # force a client rebuild
dsh-desktop
```

The client binary itself is also a plugin installer:

```sh
dsh-desktop-shell install              # bootstrap the profile + install client/launcher
dsh-desktop-shell install --prefix /usr  # OS-package layout (menus under /usr/share)
dsh-desktop-shell                      # install, then boot the profile
dsh-desktop-shell --version
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
pipes agent-lifecycle notifications to the client over a stdin control
channel (`{"event":"notify", ...}` JSON lines). The window title follows the
chat open in the UI right now: the browser half reads the active session
from the harness's sessions service and mirrors it into the native window
and the custom title bar.

#### Install options

**One installer per platform** (from the [releases](https://github.com/s3yf1337/dsh-desktop/releases)
page): `.deb` on Linux, `.dmg` on macOS, `.exe` (NSIS) on Windows. The
installer places the client binary and registers an app-menu entry; the first
launch of the installed app bootstraps the plugin profile into dsh and opens
the window. The client binary is also a plugin installer:

```sh
dsh-desktop-shell install            # bootstrap the profile + install client/launcher
dsh-desktop-shell install --prefix /usr  # OS-package layout (menus under /usr/share)
dsh-desktop-shell                    # same as install, then boot the profile
dsh-desktop-shell --version
```

From source (Linux/macOS dev path), `install.sh` works as before:

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
profile's `cordis.patch.yml` user layer. The binary's own `install` mode is
the cross-platform equivalent (it embeds the bundle, so one artifact installs
everything).

#### Release artifacts (CI-built)

Every `v*` tag builds, bundles, and publishes per platform:

- **Installers** — `DeepSeek Harness_<tag>_amd64.deb` (Linux),
  `.dmg` + `.app` (macOS), NSIS `.exe` (Windows)
- **Update tarballs** — `dsh-desktop-<tag>-linux-x86_64.tar.gz`,
  `-macos-aarch64.tar.gz`, `-windows-x86_64.tar.gz` (client binary + `bundle/`)

The in-app **one-click update** downloads its platform tarball, swaps the
client binary, refreshes the plugin bundle, and restarts. Nothing is ever
applied automatically; background checks are opt-in (off by default).

#### Configuration

The `dsh-desktop` launcher resolves the `dsh` CLI: `$DSH_DESKTOP_DSH` →
`$DSH_BIN` → `dsh` on `PATH`. `DSH_HOME` is inherited (defaults to
`$HOME/.dsh`).

The native client honors:

- `DSH_DESKTOP_NO_SINGLE_INSTANCE=1` — skip the single-instance guard so a
  second harness can run side by side (development/debugging)
- `DSH_DESKTOP_BIN` — an explicit client binary path

Client binary resolution in the bundle plugin: `config.bin` → `DSH_DESKTOP_BIN`
→ `$DSH_HOME/bin/dsh-desktop-shell` → `dsh-desktop-shell` on `PATH` →
`~/.local/bin/dsh-desktop-shell`. With no binary found the harness still
serves the web UI (degrades to browser use).

The window is frameless; the web surface draws the title bar (drag region,
minimize/maximize/close, resize edges) and the right-hand explorer panel
(Files/Preview tabs). The shell exits with code 0 when the user is done and
code 11 after a one-click update (the plugin relaunches the profile).

#### Layout

```
bundle/                  the dsh-desktop-shell plugin package (bundle contract)
  cordis.patch.yml       inserts the desktop-shell row
  lib/index.js           spawn/watcher plugin (webServer, appExit, stdin control,
                         loopback-only /dshd-file route: local files for the
                         preview panel — markdown images, .html pages, assets)
  lib/client.js          browser half: title bar, explorer panel (markdown /
                         web / image / hexdump previews), settings tab
dist/index.html          loading page shown while the WebView boots
dsh-desktop              launcher wrapper: exec dsh --profile desktop
install.sh               one-command bootstrap (profile + client + icons + menu entry)
src-tauri/               the native render client (the actual app)
  src/main.rs
  src/lib.rs             arg dispatch (url | install | no-arg), frameless window,
                         tray, close-to-tray, single-instance, stdin control
  src/install.rs         plugin installer mode (embedded bundle, cross-platform)
  src/fs.rs              explorer commands (list dir, read file, stat, hexdump,
                         home, parent)
  src/commands.rs        desktop_* commands the settings tab invokes
  src/settings.rs        persisted desktop preferences (dsh-desktop.json)
  src/tray.rs            tray icon + menu (show/hide, updates, quit)
  src/update.rs          update orchestration (check, emit, notify, apply, restart)
  src/updater.rs         GitHub releases API client (assets, suggest + one-click)
  src/log.rs             file + stderr logging (dsh-desktop.log)
  Cargo.toml
  tauri.conf.json
  capabilities/default.json
test/client-smoke.mjs    renders client.js (title bar module + explorer + settings)
                         and exercises the preview helpers (markdown image
                         rewrite, TOC, URL normalization, path resolution)
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
