//! `dsh-desktop-shell` — the native render client of the dsh desktop profile.
//!
//! This binary is intentionally thin and owns NO harness logic. The desktop
//! profile (`dsh --profile desktop`) boots the full harness — the same web
//! surface the browser talks to — and then spawns this shell with the served
//! loopback URL:
//!
//! ```text
//! dsh-desktop-shell http://127.0.0.1:<port>
//! ```
//!
//! The shell opens a native WebView window on that URL. Closing the window
//! exits the process with code 0, which the profile's `desktop-shell` plugin
//! reads as "the user is done" and shuts the harness down. The WebView loads
//! the exact same `127.0.0.1` origin a browser would, so the `/api` bridge,
//! WebSockets, and the whole SPA work unchanged and same-origin — no CORS or
//! IPC shimming needed.

use std::env;
use tauri::Manager;
use url::Url;

/// Parse the served URL from argv (`dsh-desktop-shell <url>`) and open the
/// window on it. The process exits with code 0 when the window closes.
pub fn run() {
    let mut args = env::args().skip(1);
    let Some(raw) = args.next() else {
        eprintln!("usage: dsh-desktop-shell <url>");
        eprintln!("the desktop profile spawns this client with the served web URL");
        std::process::exit(2);
    };
    if raw.trim().is_empty() {
        eprintln!("error: empty URL");
        std::process::exit(2);
    }
    let url = match Url::parse(raw.trim()) {
        Ok(parsed) => parsed,
        Err(error) => {
            eprintln!("error: invalid URL {raw:?}: {error}");
            std::process::exit(2);
        }
    };

    let app = tauri::Builder::default()
        .build(tauri::generate_context!())
        .expect("failed to build the tauri app");

    app.run(move |app_handle, event| match event {
        // The URL is known before the window is created, so navigate on ready:
        // the loading page (`../dist/index.html`) shows only for a moment.
        tauri::RunEvent::Ready => {
            if let Some(win) = app_handle.get_webview_window("main") {
                let _ = win.set_title("DeepSeek Harness");
                let _ = win.navigate(url.clone());
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
        _ => {}
    });
}
