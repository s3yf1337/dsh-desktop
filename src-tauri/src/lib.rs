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
mod fs;
mod install;
mod log;
mod settings;
mod tray;
mod update;
mod updater;

use std::env;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use tauri::{Emitter, Manager, RunEvent, WindowEvent};
use url::Url;

use crate::tray::{AgentInfo, FinishedInfo};

/// The process exit code the profile plugin reads (0 = done, 11 = restart).
/// Set before `app.exit(code)`; the window-mode run returns it after the
/// event loop ends.
pub static EXIT_CODE: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

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
	/// Live running-agents snapshot, pushed by the harness. The tray renders
	/// each as an entry with a log tail and a Stop action.
	pub agents: Mutex<Vec<AgentInfo>>,
	/// Capped log tail per agent (last 40 lines), fed by `get-log` replies.
	pub agent_logs: Mutex<std::collections::HashMap<String, Vec<String>>>,
	/// Agents that finished, newest-first, capped at 10; drives the tray badge.
	pub finished_agents: Mutex<Vec<FinishedInfo>>,
	/// The pristine tray icon (before any badge), so the badge can be cleared.
	pub tray_icon_original: Mutex<Option<tauri::image::Image<'static>>>,
	/// Serializes the control writes to stdout (the `dshdctl:` protocol).
	pub control_out: Mutex<()>,
	/// Serializes tray-menu rebuilds (key check + build + swap must be
	/// atomic across the stdin thread, async update tasks and menu events).
	pub rebuild_lock: Mutex<()>,
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
			agents: Mutex::new(Vec::new()),
			agent_logs: Mutex::new(std::collections::HashMap::new()),
			finished_agents: Mutex::new(Vec::new()),
			tray_icon_original: Mutex::new(None),
			control_out: Mutex::new(()),
			rebuild_lock: Mutex::new(()),
		}
	}
}

/// Current wall-clock time as Unix epoch milliseconds (for `FinishedInfo`).
fn now_ms() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis() as u64)
		.unwrap_or(0)
}

/// Parse the served URL from argv (`dsh-desktop-shell <url>`) and open the
/// window on it. The process exits with code 0 when the user is done (Quit
/// from the tray, or a close while the tray is disabled).
pub fn run() {
	// The binary doubles as the plugin installer:
	//   dsh-desktop-shell install [--prefix DIR]   bootstrap the desktop profile
	//   dsh-desktop-shell                           same, then boot the profile
	//   dsh-desktop-shell <url>                     render the web surface (window)
	//   dsh-desktop-shell --version | --help
	let args: Vec<String> = env::args().skip(1).collect();
	let exit = match args.first().map(|s| s.as_str()) {
		Some("install") => {
			let mut prefix = None;
			let mut rest = args.iter().skip(1).peekable();
			while let Some(arg) = rest.next() {
				match arg.as_str() {
					"--prefix" => prefix = rest.next().map(|s| s.clone()),
					"--help" | "-h" => {
						println!("usage: dsh-desktop-shell install [--prefix DIR]");
						return;
					}
					other => {
						eprintln!("error: unknown install argument: {other}");
						return std::process::exit(2);
					}
				}
			}
			install::run(prefix.as_deref())
		}
		Some("--version") | Some("-V") => {
			println!("dsh-desktop-shell {}", env!("CARGO_PKG_VERSION"));
			0
		}
		Some("--help") | Some("-h") | Some("help") => {
			println!("usage: dsh-desktop-shell <url> | install [--prefix DIR] | --version");
			0
		}
		Some(raw) if !raw.starts_with('-') => run_window(raw.to_string()),
		_ => run_installed_app(),
	};
	std::process::exit(exit);
}

/// The OS-installed app launched by hand (no URL): run the plugin installer,
/// then boot the profile — the profile's plugin spawns this client with the
/// served URL. This is what the OS installers' shortcuts point at, so
/// double-clicking the installed app installs the plugin into dsh and opens
/// the window in one go.
fn run_installed_app() -> i32 {
	let prefix = env::var("DSH_DESKTOP_PREFIX").ok();
	if let Err(error) = install::install(prefix.as_deref()) {
		eprintln!("dsh-desktop: {error}");
		eprintln!("dsh-desktop: install the dsh CLI first (npm i -g @deepseek-ai/dsh) and try again");
		return 1;
	}
	match spawn_profile() {
		Ok(()) => {
			// The freshly booted harness spawns a new client instance with the
			// served URL; this bootstrap process is done.
			0
		}
		Err(error) => {
			eprintln!("dsh-desktop: cannot boot the desktop profile: {error}");
			eprintln!("dsh-desktop: the profile is installed — run: dsh --profile desktop");
			1
		}
	}
}

/// Resolve the `dsh` CLI like the launcher script does: `DSH_DESKTOP_DSH` →
/// `DSH_BIN` → `dsh` on PATH → known install locations.
fn resolve_dsh() -> Option<String> {
	for key in ["DSH_DESKTOP_DSH", "DSH_BIN"] {
		if let Ok(value) = env::var(key) {
			if !value.trim().is_empty() {
				return Some(value);
			}
		}
	}
	if let Ok(path) = env::var("PATH") {
		for dir in path.split(if cfg!(target_os = "windows") { ';' } else { ':' }) {
			if dir.is_empty() {
				continue;
			}
			let candidate = std::path::Path::new(dir).join(if cfg!(target_os = "windows") { "dsh.cmd" } else { "dsh" });
			if candidate.exists() {
				return Some(candidate.to_string_lossy().into_owned());
			}
		}
	}
	for candidate in ["$HOME/.npm-global/bin/dsh", "$HOME/.local/bin/dsh", "$HOME/bin/dsh"] {
		let expanded = candidate.replace("$HOME", &env::var("HOME").unwrap_or_default());
		if std::path::Path::new(&expanded).exists() {
			return Some(expanded);
		}
	}
	None
}

/// Spawn `dsh --profile desktop` detached (the profile plugin opens the
/// window). Returns once the spawn succeeds; the child owns the app now.
fn spawn_profile() -> Result<(), String> {
	let dsh = resolve_dsh().ok_or_else(|| "dsh CLI not found on PATH (DSH_DESKTOP_DSH, DSH_BIN, or dsh on PATH)".to_string())?;
	let mut command = std::process::Command::new(&dsh);
	command.arg("--profile").arg("desktop");
	#[cfg(not(target_os = "windows"))]
	{
		use std::os::unix::process::CommandExt;
		command.process_group(0);
	}
	command
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.stdin(std::process::Stdio::null())
		.spawn()
		.map(|_| ())
		.map_err(|error| format!("cannot start {dsh}: {error}"))
}

/// Window mode: open the native window on the served loopback URL.
fn run_window(raw: String) -> i32 {
	if raw.trim().is_empty() {
		eprintln!("error: empty URL");
		return 2;
	}
	let url = match Url::parse(raw.trim()) {
		Ok(parsed) => parsed,
		Err(error) => {
			eprintln!("error: invalid URL {raw:?}: {error}");
			return 2;
		}
	};
	// The shell only ever renders the harness's loopback surface; anything
	// else is a mistake (defense in depth — the URL is built by the plugin).
	if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
		eprintln!("error: refusing to open non-loopback URL {raw:?}");
		return 2;
	}

	// Leftover `.old` from a Windows in-place update (rename-before-replace).
	install::cleanup_stale_old();

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
			commands::desktop_is_directory,
			commands::desktop_set_title,
			commands::desktop_update_now,
			commands::desktop_install_info,
			commands::desktop_clipboard_image,
			fs::desktop_list_dir,
			fs::desktop_parent_dir,
			fs::desktop_read_file,
			fs::desktop_stat,
			fs::desktop_hexdump,
			fs::desktop_home_dir,
			fs::desktop_write_file,
			fs::desktop_create_dir,
			fs::desktop_rename,
			fs::desktop_delete,
			fs::desktop_copy,
			fs::desktop_move,
			fs::desktop_open_path,
			fs::desktop_search_names,
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
				*state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = loaded;
				*state.config_dir.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = config_dir.to_string_lossy().into_owned();
			}
			log::info(app.handle(), "desktop shell starting");

			// The tray is the window's second life. A desktop without a tray
			// host (no StatusNotifierWatcher) must not break the app: fall back
			// to the plain close-exits behavior by disabling the tray setting.
			if let Err(error) = tray::setup(app.handle()) {
				log::warn(app.handle(), &format!("tray unavailable, falling back to close-exits: {error}"));
				app.state::<AppState>().settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).tray = false;
			}

			// Ask for notification permission once (no-op on Linux, prompt on
			// macOS/Windows) when notifications are enabled.
			{
				use tauri_plugin_notification::NotificationExt;
				let enabled = app.state::<AppState>().settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).notifications;
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
			// control messages into our stdin (agent lifecycle →
			// notifications; the window title itself is now driven by the
			// webview's active-chat title through the desktop_set_title
			// command, with this channel's "title" message kept as a
			// fallback). Read them on a background thread; the client's
			// stdin is otherwise unused.
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
								let title = title.filter(|t| !t.is_empty()).unwrap_or("DeepSeek Harness");
								if let Some(win) = handle.get_webview_window("main") {
									let _ = win.set_title(title);
								}
								// The custom title bar renders its own caption; mirror
								// the native title into the webview.
								let _ = handle.emit(update::TITLE_EVENT, title);
							}
							Some("agents") => {
								// Replace the whole running list with the pushed
								// snapshot, then let the tray refresh its menu
								// (rebuild skips the work when nothing changed).
								let mut agents = Vec::new();
								if let Some(items) = message.get("agents").and_then(|v| v.as_array()) {
									for item in items {
										let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
										let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
										let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("").to_string();
										agents.push(AgentInfo { id, title, status });
									}
								}
								{
									let state = handle.state::<AppState>();
									let mut agents_guard = state.agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
									*agents_guard = agents;
									// Log tails for agents that dropped out are
									// dead weight — prune them with the snapshot.
									let live: std::collections::HashSet<String> =
										agents_guard.iter().map(|agent| agent.id.clone()).collect();
									let mut logs = state.agent_logs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
									logs.retain(|id, _| live.contains(id));
								}
								crate::tray::rebuild(&handle);
							}
							Some("agent-finished") => {
								// A running agent just went idle: remember it
								// (newest first, capped), badge the icon, rebuild.
								let state = handle.state::<AppState>();
								let id = message.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
								let title = message.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
								let time_ms = now_ms();
								{
									let mut finished = state.finished_agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
									finished.insert(0, FinishedInfo { id: id.clone(), title, time_ms });
									finished.truncate(10);
									// The agent's log tail is not needed once it
									// is done — keep the map from growing forever.
									state.agent_logs.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).remove(&id);
								}
								drop(state);
								crate::log::info(&handle, &format!("tray: badge: agent {id} finished"));
								crate::tray::set_badge(&handle);
								crate::tray::rebuild(&handle);
							}
							Some("agent-log") => {
								// The harness replies to a get-log request with
								// the agent's tail; keep at most 40 lines/entry.
								let state = handle.state::<AppState>();
								let id = message.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
								let lines: Vec<String> = message
									.get("lines")
									.and_then(|v| v.as_array())
									.map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
									.unwrap_or_default();
								{
									let mut logs = state.agent_logs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
									let mut capped = lines;
									capped.truncate(crate::tray::LOG_CAP);
									logs.insert(id, capped);
								}
								drop(state);
								crate::tray::rebuild(&handle);
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
				// window-state restores geometry verbatim, so a position
				// recorded on a monitor that is no longer connected leaves the
				// window off-screen and invisible. If it overlaps no connected
				// monitor, recenter it. Errors (e.g. on Wayland/X11) just skip
				// the clamp — never break startup over geometry.
				let on_screen = win
					.inner_position()
					.or_else(|_| win.outer_position())
					.and_then(|pos| {
						let size = win.inner_size()?;
						Ok((pos, size))
					})
					.map(|(pos, size)| {
						let x0 = pos.x;
						let y0 = pos.y;
						let x1 = pos.x + size.width as i32;
						let y1 = pos.y + size.height as i32;
						app_handle
							.available_monitors()
							.map(|monitors| {
								monitors.iter().any(|m| {
									let p = m.position();
									let s = m.size();
									let mx0 = p.x;
									let my0 = p.y;
									let mx1 = p.x + s.width as i32;
									let my1 = p.y + s.height as i32;
									x0 < mx1 && x1 > mx0 && y0 < my1 && y1 > my0
								})
							})
							.unwrap_or(false)
					})
					.unwrap_or(false);
				if !on_screen {
					let _ = win.center();
				}
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
				let tray_enabled = state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).tray;
				if tray_enabled && !update::quitting(app_handle) {
					api.prevent_close();
					if let Some(win) = app_handle.get_webview_window("main") {
						let _ = win.hide();
					}
					// One-time hint so the user knows the app stayed alive.
					if !update::tray_hide_hint_shown(app_handle) {
						let notifications = app_handle.state::<AppState>().settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).notifications;
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
	EXIT_CODE.load(std::sync::atomic::Ordering::SeqCst)
}
