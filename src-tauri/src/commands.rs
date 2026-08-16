//! Tauri commands behind the settings tab. The web surface's "dsh-desktop"
//! section calls these via `window.__TAURI__.core.invoke`; every mutating
//! command emits `desktop://state` so open tabs refresh live.

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::DesktopState;
use crate::AppState;

/// Snapshot the whole desktop state (settings + update status).
pub fn snapshot(app: &AppHandle) -> DesktopState {
	let state = app.state::<AppState>();
	let settings = state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
	let update = state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
	let last_update_check = state.last_check.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
	let update_check_error = state.check_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
	DesktopState {
		version: env!("CARGO_PKG_VERSION").to_string(),
		settings,
		update,
		last_update_check,
		update_check_error,
		client: true,
	}
}

/// Read the full desktop state.
#[tauri::command]
pub fn desktop_get_state(app: AppHandle) -> DesktopState {
	snapshot(&app)
}

/// Update one settings key (`tray`, `notifications`, `auto_update_check`,
/// `update_interval_hours`) and persist it. Returns the new state.
#[tauri::command]
pub fn desktop_set_setting(app: AppHandle, key: String, value: serde_json::Value) -> Result<DesktopState, String> {
	let state = app.state::<AppState>();
	// Mutate and read what we need under the lock, then drop it before the
	// disk write so a slow save never blocks other readers on the main thread.
	let (changed, settings_to_save, notifications_enabled, tray_enabled) = {
		let mut settings = state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let changed = match key.as_str() {
			"tray" => match value.as_bool() {
				Some(b) => {
					let changed = settings.tray != b;
					settings.tray = b;
					changed
				}
				None => return Err("tray expects a boolean".into()),
			},
			"notifications" => match value.as_bool() {
				Some(b) => {
					let changed = settings.notifications != b;
					settings.notifications = b;
					changed
				}
				None => return Err("notifications expects a boolean".into()),
			},
			"auto_update_check" => match value.as_bool() {
				Some(b) => {
					let changed = settings.auto_update_check != b;
					settings.auto_update_check = b;
					changed
				}
				None => return Err("auto_update_check expects a boolean".into()),
			},
			"update_interval_hours" => match value.as_u64() {
				Some(n) => {
					// Clamp to [1, 720] hours (up to 30 days) so `interval * 3600`
					// in the update loop cannot overflow.
					let n = n.clamp(1, 720);
					let changed = settings.update_interval_hours != n;
					settings.update_interval_hours = n;
					changed
				}
				None => return Err("update_interval_hours expects a number".into()),
			},
			_ => return Err(format!("unknown setting: {key}")),
		};
		let settings_to_save = settings.clone();
		(changed, settings_to_save, settings.notifications, settings.tray)
	};
	drop(state);
	let config_dir = app.path().app_config_dir().unwrap_or_default();
	crate::settings::save(&config_dir, &settings_to_save);
	if changed {
		if key == "notifications" && notifications_enabled {
			use tauri_plugin_notification::NotificationExt;
			let _ = app.notification().request_permission();
		}
		if key == "tray" && !tray_enabled {
			// Never strand the user: with the tray off, a hidden window would
			// be unreachable — show it.
			if let Some(win) = app.get_webview_window("main") {
				if win.is_visible().unwrap_or(false) == false {
					let _ = win.show();
					let _ = win.set_focus();
				}
			}
		}
		crate::update::emit_and_rebuild(&app);
	}
	Ok(snapshot(&app))
}

/// Run an update check right now and report the outcome (suggests, never
/// applies anything).
#[tauri::command]
pub async fn desktop_check_updates(app: AppHandle) -> Result<DesktopState, String> {
	crate::update::run_check(&app, true).await;
	Ok(snapshot(&app))
}

/// Open the release page for the available update (or the releases page when
/// nothing newer was found) in the default browser.
#[tauri::command]
pub fn desktop_open_release(app: AppHandle) -> Result<(), String> {
	let state = app.state::<AppState>();
	let url = state
		.update
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
		.as_ref()
		.map(|info| info.url.clone())
		.unwrap_or_else(|| crate::updater::RELEASES_URL.to_string());
	crate::log::info(&app, &format!("opening {url}"));
	open::that(&url).map_err(|error| error.to_string())
}

/// One-click update: download the platform package, apply it in place, and
/// restart the app (exit code 11 → the profile plugin relaunches the
/// harness). Progress is streamed on `desktop://update-progress`.
#[tauri::command]
pub async fn desktop_update_now(app: AppHandle) -> Result<serde_json::Value, String> {
	let version = crate::update::download_and_apply(&app).await?;
	// Let the final progress event flush, then tell the profile plugin to
	// relaunch us (the plugin sees exit code 11 and starts a fresh profile).
	crate::update::emit_progress(&app, "restarting", None, None);
	crate::log::info(&app, "update applied; requesting restart");
	// The process exit code is what the profile plugin sees: 11 = relaunch.
	crate::EXIT_CODE.store(crate::update::RESTART_EXIT_CODE, std::sync::atomic::Ordering::SeqCst);
	tokio::time::sleep(std::time::Duration::from_millis(400)).await;
	app.exit(crate::update::RESTART_EXIT_CODE);
	Ok(serde_json::json!({ "restarting": true, "version": version }))
}

/// Where the plugin is installed (paths for the settings tab's "Installation"
/// card and diagnostics).
#[tauri::command]
pub fn desktop_install_info() -> Result<serde_json::Value, String> {
	Ok(serde_json::json!({
		"dsh_home": crate::install::dsh_home().to_string_lossy(),
		"profile": crate::install::profile_dir().to_string_lossy(),
		"bundle": crate::install::profile_bundle_dir().to_string_lossy(),
		"client": std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
	}))
}

/// Reset the window to the default size/position and forget the saved
/// geometry (the window-state plugin's file is removed).
#[tauri::command]
pub fn desktop_reset_geometry(app: AppHandle) -> Result<(), String> {
	let win = app.get_webview_window("main").ok_or("no main window")?;
	let _ = win.unmaximize();
	win.set_size(tauri::LogicalSize::new(1280.0, 860.0)).map_err(|e| e.to_string())?;
	win.center().map_err(|e| e.to_string())?;
	// The window-state plugin persists to `<config>/.window-state.json`.
	if let Ok(dir) = app.path().app_config_dir() {
		let _ = std::fs::remove_file(dir.join(".window-state.json"));
	}
	crate::update::emit_and_rebuild(&app);
	Ok(())
}

/// Send a test notification (for the settings tab's preview button).
#[tauri::command]
pub fn desktop_test_notification(app: AppHandle) -> Result<(), String> {
	crate::update::notify(&app, "dsh-desktop", "Notifications work!");
	Ok(())
}

/// Whether a dropped path is a directory (drag & drop decides between opening
/// a workspace and letting the webview handle files).
#[tauri::command]
pub fn desktop_is_directory(path: String) -> Result<bool, String> {
	Ok(std::fs::metadata(&path).map(|meta| meta.is_dir()).unwrap_or(false))
}

/// Mirror the active chat's title (sent by the browser half, which reads it
/// from the harness sessions service) into the native window title and the
/// custom title bar, so the window follows the chat open right now instead
/// of the last started agent. An empty title resets to the default.
#[tauri::command]
pub fn desktop_set_title(app: AppHandle, title: String) -> Result<(), String> {
	let title = title.trim();
	let title = if title.is_empty() { "DeepSeek Harness" } else { title };
	if let Some(win) = app.get_webview_window("main") {
		win.set_title(title).map_err(|error| error.to_string())?;
	}
	// The custom title bar renders its own caption; mirror the native title
	// into the webview (the browser half updates its node from this event).
	let _ = app.emit(crate::update::TITLE_EVENT, title);
	Ok(())
}

/// A clipboard image snapshot handed to the webview: PNG bytes as base64.
#[derive(serde::Serialize)]
pub struct ClipboardImage {
	pub mime: String,
	pub content: String,
}

/// Read the current system clipboard as an image, if it holds one.
///
/// The webview cannot attach clipboard images through DOM paste events —
/// WebKitGTK exposes no `clipboardData` file items for them — so the shell
/// reads the clipboard natively and returns a PNG (base64). `Ok(None)` when
/// the clipboard holds text or nothing (the caller then falls back to the
/// browser's own text-paste handling).
#[tauri::command]
pub fn desktop_clipboard_image() -> Result<Option<ClipboardImage>, String> {
	let mut clipboard = arboard::Clipboard::new().map_err(|error| format!("clipboard unavailable: {error}"))?;
	let image = match clipboard.get_image() {
		Ok(image) => image,
		Err(arboard::Error::ContentNotAvailable) => return Ok(None),
		Err(error) => return Err(format!("clipboard read failed: {error}")),
	};
	// The clipboard image is RGBA8; the webview needs a real image format, so
	// encode it as PNG (small, lossless, universal).
	let mut out = Vec::new();
	{
		let mut encoder = png::Encoder::new(&mut out, image.width as u32, image.height as u32);
		encoder.set_color(png::ColorType::Rgba);
		encoder.set_depth(png::BitDepth::Eight);
		let mut writer = encoder
			.write_header()
			.map_err(|error| format!("png header: {error}"))?;
		writer
			.write_image_data(&image.bytes)
			.map_err(|error| format!("png write: {error}"))?;
	}
	use base64::Engine as _;
	Ok(Some(ClipboardImage {
		mime: "image/png".to_string(),
		content: base64::engine::general_purpose::STANDARD.encode(&out),
	}))
}
