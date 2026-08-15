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
//! reads as "the user is done" and shuts the harness down — unless the tray is
//! enabled, in which case closing hides the window and the harness keeps
//! running until the tray's Quit (also exit 0).
//!
//! The WebView loads the exact same `127.0.0.1` origin a browser would, so
//! the `/api` bridge, WebSockets, and the whole SPA work unchanged and
//! same-origin — no CORS or IPC shimming needed. The desktop layer (tray,
//! single-instance, geometry persistence, notifications, the GitHub updater)
//! lives in this crate and is driven from the SPA's "dsh-desktop" settings
//! tab through the `desktop_*` commands.

mod commands;
mod log;
mod settings;
mod tray;
mod update;
mod updater;

use std::env;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};
use url::Url;

/// Process-wide desktop state (native only; the SPA reads snapshots of it).
pub struct AppState {
	/// Persisted user preferences (tray, notifications, updater).
	pub settings: Mutex<settings::DesktopSettings>,
	/// The newer release found by the updater, if any.
	pub update: Mutex<Option<settings::UpdateInfo>>,
	/// RFC 3339 of the last completed update check.
	pub last_check: Mutex<Option<String>>,
	/// Last check error message.
	pub check_error: Mutex<Option<String>>,
	/// Set by the tray's Quit so the close handler stops swallowing closes.
	pub quitting: AtomicBool,
	/// App config directory (log file lives here).
	pub config_dir: Mutex<String>,
}

impl Default for AppState {
	fn default() -> Self {
		Self {
			settings: Mutex::new(settings::DesktopSettings::default()),
			update: Mutex::new(None),
			last_check: Mutex::new(None),
			check_error: Mutex::new(None),
			quitting: AtomicBool::new(false),
			config_dir: Mutex::new(String::new()),
		}
	}
}

/// Parse the served URL from argv (`dsh-desktop-shell <url>`) and open the
/// window on it. The process exits with code 0 when the user is done (Quit
/// from the tray, or a close while the tray is disabled).
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
	// The shell only ever renders the harness's loopback surface; anything
	// else is a mistake (defense in depth — the URL is built by the plugin).
	if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
		eprintln!("error: refusing to open non-loopback URL {raw:?}");
		std::process::exit(2);
	}

	let mut builder = tauri::Builder::default();

	// A second `dsh-desktop` focuses the existing window instead of stacking a
	// duplicate harness+window pair. `DSH_DESKTOP_NO_SINGLE_INSTANCE=1` opts
	// out (running two harnesses side by side, e.g. for development).
	if std::env::var_os("DSH_DESKTOP_NO_SINGLE_INSTANCE").is_none() {
		builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
			if let Some(win) = app.get_webview_window("main") {
				let _ = win.show();
				let _ = win.set_focus();
			}
		}));
	}

	let app = builder
		// Remember window geometry across restarts (size, position, maximized;
		// never the hidden/visible flag — a restart must show the window).
		.plugin(
			tauri_plugin_window_state::Builder::default()
				.with_state_flags(
					tauri_plugin_window_state::StateFlags::SIZE
						| tauri_plugin_window_state::StateFlags::POSITION
						| tauri_plugin_window_state::StateFlags::MAXIMIZED,
				)
				.build(),
		)
		// Native OS notifications (update available, tray hints, tests).
		.plugin(tauri_plugin_notification::init())
		// Native file dialogs (workspace folder picker).
		.plugin(tauri_plugin_dialog::init())
		.manage(AppState::default())
		.invoke_handler(tauri::generate_handler![
			commands::desktop_get_state,
			commands::desktop_set_setting,
			commands::desktop_check_updates,
			commands::desktop_open_release,
			commands::desktop_reset_geometry,
			commands::desktop_test_notification,
			commands::desktop_pick_directory,
			commands::desktop_is_directory,
		])
		.setup(|app| {
			// reqwest is built with `rustls-no-provider`; ring is the provider.
			let _ = rustls::crypto::ring::default_provider().install_default();

			// The GTK application name becomes the system tray item's title
			// (libappindicator derives the SNI Title from it), so hovering the
			// tray icon shows "DeepSeek Harness", not the binary's name.
			#[cfg(target_os = "linux")]
			glib::set_application_name("DeepSeek Harness");

			// Load persisted preferences into the managed state.
			let config_dir = app.path().app_config_dir()?;
			let loaded = settings::load(&config_dir);
			{
				let state = app.state::<AppState>();
				*state.settings.lock().unwrap() = loaded;
				*state.config_dir.lock().unwrap() = config_dir.to_string_lossy().into_owned();
			}
			log::info(app.handle(), "desktop shell starting");

			// The tray is the window's second life. A desktop without a tray
			// host (no StatusNotifierWatcher) must not break the app: fall back
			// to the plain close-exits behavior by disabling the tray setting.
			if let Err(error) = tray::setup(app.handle()) {
				log::warn(app.handle(), &format!("tray unavailable, falling back to close-exits: {error}"));
				app.state::<AppState>().settings.lock().unwrap().tray = false;
			}

			// Ask for notification permission once (no-op on Linux, prompt on
			// macOS/Windows) when notifications are enabled.
			{
				use tauri_plugin_notification::NotificationExt;
				let enabled = app.state::<AppState>().settings.lock().unwrap().notifications;
				if enabled {
					let _ = app.notification().request_permission();
				}
			}

			// Periodic GitHub updater (checks, suggests, never forces).
			{
				let handle = app.handle().clone();
				tauri::async_runtime::spawn(async move {
					update::periodic_loop(handle).await;
				});
			}

			// Control channel: the profile's desktop-shell plugin pipes JSON
			// control messages into our stdin (agent lifecycle → notifications,
			// session titles → window title). Read them on a background thread;
			// the client's stdin is otherwise unused.
			{
				let handle = app.handle().clone();
				std::thread::spawn(move || {
					use std::io::BufRead;
					let stdin = std::io::stdin();
					for line in stdin.lock().lines() {
						let Ok(line) = line else { break };
						let line = line.trim();
						if line.is_empty() {
							continue;
						}
						let Ok(message) = serde_json::from_str::<serde_json::Value>(line) else {
							continue;
						};
						match message.get("event").and_then(|v| v.as_str()) {
							Some("notify") => {
								let title = message
									.get("title")
									.and_then(|v| v.as_str())
									.unwrap_or("DeepSeek Harness");
								let body = message.get("body").and_then(|v| v.as_str()).unwrap_or("");
								update::control_notify(&handle, title, body);
							}
							Some("title") => {
								let title = message.get("title").and_then(|v| v.as_str());
								if let Some(win) = handle.get_webview_window("main") {
									let _ = win.set_title(
										title.filter(|t| !t.is_empty()).unwrap_or("DeepSeek Harness"),
									);
								}
							}
							_ => {}
						}
					}
				});
			}

			// Drag & drop is handled client-side: the webview receives the
			// `tauri://drag-drop` event and the settings tab's browser half
			// opens dropped directories as workspaces (files keep flowing to
			// the SPA as attachments).
			Ok(())
		})
		.build(tauri::generate_context!())
		.expect("failed to build the tauri app");

	app.run(move |app_handle, event| match event {
		// The URL is known before the window is created, so navigate on ready:
		// the loading page (`../dist/index.html`) shows only for a moment.
		RunEvent::Ready => {
			if let Some(win) = app_handle.get_webview_window("main") {
				let _ = win.set_title("DeepSeek Harness");
				let _ = win.navigate(url.clone());
				let _ = win.show();
				let _ = win.set_focus();
			}
		}
		// Close-to-tray: hide instead of exiting while the tray is enabled and
		// the user hasn't chosen Quit. A disabled tray keeps the old contract —
		// close → exit 0 → the harness shuts down.
		RunEvent::WindowEvent {
			label,
			event: WindowEvent::CloseRequested { api, .. },
			..
		} => {
			if label == "main" {
				let state = app_handle.state::<AppState>();
				let tray_enabled = state.settings.lock().unwrap().tray;
				if tray_enabled && !update::quitting(app_handle) {
					api.prevent_close();
					if let Some(win) = app_handle.get_webview_window("main") {
						let _ = win.hide();
					}
					// One-time hint so the user knows the app stayed alive.
					if !update::tray_hide_hint_shown(app_handle) {
						let notifications = app_handle.state::<AppState>().settings.lock().unwrap().notifications;
						update::mark_tray_hide_hint(app_handle);
						if notifications {
							update::notify(
								app_handle,
								"DeepSeek Harness",
								"Still running in the tray — click the icon to reopen, or choose Quit to exit.",
							);
						}
					}
					log::info(app_handle, "window hidden to tray (Quit from the tray to exit)");
				}
			}
		}
		_ => {}
	});
}
