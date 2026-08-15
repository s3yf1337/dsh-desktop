# dsh-desktop-shell

The plugin bundle of the [dsh desktop profile](../README.md): one cordis row
(`desktop-shell`) over the web surface that spawns the native Tauri render
client on the served loopback URL.

## What it does

The bundle patch (`cordis.patch.yml`) inserts a single row into the composed
tree. The plugin (`lib/index.js`):

- injects the `webServer` service and waits for the loader to settle (the
  port is the real OS-assigned one only after the bind);
- resolves the native client binary: `config.bin` → `DSH_DESKTOP_BIN` →
  `$DSH_HOME/bin/dsh-desktop-shell` → `dsh-desktop-shell` on PATH →
  `~/.local/bin/dsh-desktop-shell`;
- spawns `dsh-desktop-shell <url>` and watches it:
  - exit 0 (window closed) → requests harness shutdown via `ctx.appExit`;
  - exit 11 (one-click update applied) → boots a fresh `dsh --profile
    desktop` (detached), then shuts the old harness down;
  - other non-zero exit or missing binary → the web surface keeps serving
    (degrades to browser use) with a printed hint.

The browser half (`lib/client.js`) draws the desktop experience onto the web
surface: the custom window title bar (the shell window is frameless), the
right-hand explorer panel (Files/Preview tabs over the native fs commands),
and the "dsh-desktop" settings section (tray, notifications, one-click
updates, geometry, installation paths).

## Bundle contract

This is a standard dsh bundle package: the manifest declares
`dsh.bundle.patch`, and the profile composes it as a patch layer over
`dsh-base` + `dsh-web-app` exactly like `@deepseek-ai/dsh-headless`. It needs
no pnpm installation: the profile's `install.sh` copies this directory into
`$DSH_HOME/profiles/desktop/packages/` and links it into the profile's
`node_modules`.
