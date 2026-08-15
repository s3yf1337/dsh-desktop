# Bundled static assets

Files in this directory are shipped with the plugin bundle (the update
tarball packs the whole `bundle/` tree, `install.sh` copies it) and are served
to the webview by the plugin's loopback-only `/dshd-asset/<name>` route.

| file | source | license |
|---|---|---|
| `mermaid.min.js` | https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js (vendored verbatim) | MIT |

Vendored so the desktop app renders mermaid diagrams fully offline; the
webview never contacts a CDN.
