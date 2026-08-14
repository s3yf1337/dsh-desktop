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
  `dsh-desktop-shell` on PATH (the copy `install.sh` puts in
  `~/.local/bin/dsh-desktop-shell`);
- spawns `dsh-desktop-shell <url>` and watches it:
  - exit 0 (window closed) → requests harness shutdown via `ctx.appExit`;
  - non-zero exit or missing binary → the web surface keeps serving
    (degrades to browser use) with a printed hint.

## Bundle contract

This is a standard dsh bundle package: the manifest declares
`dsh.bundle.patch`, and the profile composes it as a patch layer over
`dsh-base` + `dsh-web-app` exactly like `@deepseek-ai/dsh-headless`. It needs
no pnpm installation: the profile's `install.sh` copies this directory into
`$DSH_HOME/profiles/desktop/packages/` and links it into the profile's
`node_modules`.
