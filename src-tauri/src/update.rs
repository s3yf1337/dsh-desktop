//! Update orchestration: run a check, apply its result to the app state,
//! surface it (tray menu, event to the settings tab, optional notification),
//! and drive the periodic re-check loop.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::now_rfc3339;
use crate::tray;
use crate::AppState;

/// The event the settings tab listens to; payload is the full `DesktopState`.
pub const STATE_EVENT: &str = "desktop://state";

/// Delay before the first startup check (let the window open first).
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(8);

/// Perform one update check and apply its result.
///
/// `with_notification` controls whether finding a *new* update triggers a
/// native notification (startup checks notify only on change; manual checks
/// always report their outcome).
pub async fn run_check(app: &AppHandle, with_notification: bool) {
	let result = crate::updater::fetch_latest().await;
	let state = app.state::<AppState>();
	match result {
		Ok(Some(release)) => {
			let current = env!("CARGO_PKG_VERSION");
			match crate::updater::update_info_for(current, &release) {
				Some(info) => {
					let newly_available = {
						let mut slot = state.update.lock().unwrap();
						let changed = slot.as_ref().map(|old| old.version != info.version).unwrap_or(true);
						*slot = Some(info.clone());
						changed
					};
					*state.last_check.lock().unwrap() = Some(now_rfc3339());
					*state.check_error.lock().unwrap() = None;
					drop(state);
					emit_and_rebuild(app);
					let notifications_enabled = app.state::<AppState>().settings.lock().unwrap().notifications;
					if with_notification && newly_available && notifications_enabled {
						notify(app, "Update available", &format!("dsh-desktop {} is out — open it from the tray or Settings.", info.version));
					}
					eprintln!("dsh-desktop: update available: {}", info.version);
				}
				None => {
					*state.update.lock().unwrap() = None;
					*state.last_check.lock().unwrap() = Some(now_rfc3339());
					*state.check_error.lock().unwrap() = None;
					drop(state);
					emit_and_rebuild(app);
					if with_notification {
						eprintln!("dsh-desktop: up to date ({} vs {})", current, release.tag_name);
					}
				}
			}
		}
		Ok(None) => {
			*state.update.lock().unwrap() = None;
			*state.last_check.lock().unwrap() = Some(now_rfc3339());
			*state.check_error.lock().unwrap() = None;
			drop(state);
			emit_and_rebuild(app);
			if with_notification {
				eprintln!("dsh-desktop: no releases published yet; up to date");
			}
		}
		Err(error) => {
			*state.check_error.lock().unwrap() = Some(error.clone());
			drop(state);
			emit_and_rebuild(app);
			eprintln!("dsh-desktop: update check failed: {error}");
		}
	}
}

/// Periodic loop: waits `interval` hours between checks while auto-check is
/// enabled, re-reading the setting each cycle so changes take effect live.
pub async fn periodic_loop(app: AppHandle) {
	tokio::time::sleep(FIRST_CHECK_DELAY).await;
	loop {
		let (enabled, interval) = {
			let state = app.state::<AppState>();
			let settings = state.settings.lock().unwrap();
			(settings.auto_update_check, settings.update_interval_hours.max(1))
		};
		if enabled {
			run_check(&app, false).await;
		}
		tokio::time::sleep(Duration::from_secs(interval * 3600)).await;
	}
}

/// Emit the full state to the settings tab and refresh the tray menu.
pub fn emit_and_rebuild(app: &AppHandle) {
	let state = crate::commands::snapshot(app);
	let _ = app.emit(STATE_EVENT, state);
	tray::rebuild(app);
}

/// Send a native OS notification. Callers decide whether the `notifications`
/// setting gates this; failures are logged, never fatal.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
	use tauri_plugin_notification::NotificationExt;
	if let Err(error) = app
		.notification()
		.builder()
		.title(title)
		.body(body)
		.show()
	{
		eprintln!("dsh-desktop: notification failed: {error}");
	}
}

/// Gate a control-channel notification (agent lifecycle events from the
/// harness): respect the `notifications` setting and skip when the user is
/// actively looking at the window — a notification for something the user is
/// already watching is just noise.
pub fn control_notify(app: &AppHandle, title: &str, body: &str) {
	let enabled = app.state::<AppState>().settings.lock().unwrap().notifications;
	if !enabled {
		return;
	}
	if let Some(win) = app.get_webview_window("main") {
		if win.is_focused().unwrap_or(false) {
			return;
		}
	}
	notify(app, title, body);
}

/// Whether the app is in the middle of quitting (tray Quit) — the window
/// close handler must not swallow the close in that case.
pub fn quitting(app: &AppHandle) -> bool {
	let state = app.state::<AppState>();
	state.quitting.load(Ordering::SeqCst)
}

/// Whether a "still running in the tray" hint was already shown (mutable).
pub fn tray_hide_hint_shown(app: &AppHandle) -> bool {
	let state = app.state::<AppState>();
	let shown = state.settings.lock().unwrap().tray_hide_hint_shown;
	shown
}

/// Mark the tray-hide hint as shown and persist.
pub fn mark_tray_hide_hint(app: &AppHandle) {
	let state = app.state::<AppState>();
	let mut settings = state.settings.lock().unwrap();
	if !settings.tray_hide_hint_shown {
		settings.tray_hide_hint_shown = true;
		let config = app.path().app_config_dir().unwrap_or_default();
		crate::settings::save(&config, &settings);
	}
}
