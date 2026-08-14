# dsh-desktop

The **desktop profile** for the DeepSeek Harness — a real profile composed
from the standard plugin bundles, exactly like `web` or `headless`, with a
native window.

```
dsh --profile desktop            (or the `dsh-desktop` menu launcher)
  └─ dsh-base + dsh-web-app      the whole web surface: server, /api, SPA
       └─ dsh-desktop-shell      this repo's plugin bundle: after the server
            binds, spawns dsh-desktop-shell <url> and watches it
                 └─ dsh-desktop-shell        (native client, src-tauri/)
                      opens a native WebView on http://127.0.0.1:<port>
                      window closed → exit 0 → plugin shuts the harness down
```

- The **profile** is the entry point: `dsh --profile desktop` (flags like
  `--port 0` work exactly as with `dsh web`, and `dsh plugin --profile
  desktop add <pkg>` manages its plugins).
- The **bundle** (`bundle/`) is a standard dsh plugin package: one cordis row
  (`desktop-shell`) over the web surface that injects the `webServer` service
  and spawns the native client with the served loopback URL. It also ships a
  browser half that adds the **dsh-desktop settings tab** to the web Settings
  surface.
- The **native client** (`src-tauri/`) is the desktop layer: it receives a
  URL, opens a window, and owns the desktop features (tray, single-instance,
  geometry, notifications, updater). It spawns nothing and owns no harness
  logic.

Because the WebView loads the exact same `127.0.0.1` origin the browser does,
the `/api` bridge, WebSockets, and the whole SPA work unchanged and
same-origin — no CORS or IPC shimming needed. The native client additionally
exposes `window.__TAURI__` to that origin (`withGlobalTauri`), so the SPA's
dsh-desktop tab drives it directly through the `desktop_*` commands.

## Desktop features

- **Tray + close-to-tray** — closing the window hides it to the tray and the
  harness keeps running; the tray menu drives show/hide, update checks, and
  Quit (Quit exits 0, which the `desktop-shell` plugin reads as "user is
  done"). Without a tray host (no StatusNotifierWatcher on Linux) the client
  falls back to the plain close-exits behavior.
- **Single instance** — a second `dsh-desktop` focuses the existing window;
  the redundant harness shuts itself down.
- **Window geometry** — size/position/maximized are remembered across
  restarts (`tauri-plugin-window-state`); a "Reset" button in the settings
  tab restores the defaults.
- **Native notifications** — OS notifications for update availability and
  tray hints; a "Send test notification" button checks your environment.
- **Updater (suggest-only)** — periodically checks `s3yf1337/dsh-desktop`
  releases on GitHub, compares semver, and *suggests* the update (tray menu
  entry, settings banner, notification). It never downloads or installs
  anything — "Open release" takes you to the release page.
- **Settings tab** — Settings → **dsh-desktop** in the web UI: toggles for
  tray, notifications, and automatic update checks, the check interval,
  check-now, release page, geometry reset, and version info. In a plain
  browser (no native client) the tab shows a notice instead of dead controls.


## Install (one command)

Requires a working `dsh` CLI (DeepSeek Harness) and, for the first build, a
Rust toolchain (`cargo`) — or grab a release binary and pass `--no-build`.

```sh
git clone https://github.com/s3yf1337/dsh-desktop ~/dsh-desktop
cd ~/dsh-desktop
./install.sh
```

What it does:

1. creates `$DSH_HOME/profiles/desktop` — a real profile whose bundles are
   `@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app` + `dsh-desktop-shell`
   (no pnpm or npm registry needed; the bundle is copied into the profile and
   linked into its `node_modules`);
2. builds the native render client (`cargo build --release`) if missing;
3. installs `dsh-desktop-shell` + the `dsh-desktop` launcher to
   `~/.local/bin` and registers a desktop menu entry.

Then launch from your application menu ("DeepSeek Harness"), run
`dsh-desktop`, or boot the profile directly:

```sh
dsh --profile desktop --port 0
```

Idempotent: re-running refreshes the bundle copy and never touches your
profile's `cordis.patch.yml` user layer.

### Options

```sh
./install.sh            # full bootstrap (builds the client if needed)
./install.sh --no-build # use an existing client binary, never build
./install.sh --rebuild  # force a client rebuild
```

### Manual build

```sh
cd src-tauri
CARGO_HOME="$HOME/.dsh/.cargo-home" cargo build --release
./install.sh --no-build
```

> `CARGO_HOME` is redirected to a writable location because `~/.cargo` may be
> read-only in sandboxed/build environments.

## Client binary resolution (in the bundle plugin)

1. `config.bin` (settable in the profile patch layer) — a path must exist
2. `$DSH_DESKTOP_BIN` — same rule
3. `dsh-desktop-shell` on `PATH`
4. `~/.local/bin/dsh-desktop-shell`

If no binary is found the harness still serves the web UI (degrade to
browser) and logs how to install the client (`./install.sh` in this repo).

## Layout

```
bundle/                  the dsh-desktop-shell plugin package (bundle contract)
  cordis.patch.yml       inserts the desktop-shell row
  lib/index.js           spawn/watcher plugin (webServer, appExit)
  lib/client.js          browser half: the "dsh-desktop" settings tab
dist/index.html          loading page shown while the WebView boots
dsh-desktop              launcher wrapper: exec dsh --profile desktop
install.sh               one-command bootstrap (profile + client + menu entry)
src-tauri/               the native render client (the actual app)
  src/main.rs
  src/lib.rs             parse URL, navigate, show, exit on close; tray,
                         close-to-tray, single-instance wiring
  src/commands.rs        desktop_* commands the settings tab invokes
  src/settings.rs        persisted desktop preferences (dsh-desktop.json)
  src/tray.rs            tray icon + menu (show/hide, updates, quit)
  src/update.rs          update orchestration (check, emit, notify, loop)
  src/updater.rs         GitHub releases API client (suggest-only)
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

## Configuration

The `dsh-desktop` launcher resolves the `dsh` CLI in this order:

1. `$DSH_DESKTOP_DSH` — a custom path to a launcher script/binary
2. `$DSH_BIN` — a custom path commonly used by harness deployments
3. `dsh` on `PATH`

`DSH_HOME` is inherited, and defaults to `$HOME/.dsh` when unset. The client
spawns with the profile's environment (`DSH_HOME` passed through), and the
harness's own logs appear in the terminal you launched from.
