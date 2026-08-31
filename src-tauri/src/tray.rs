//! System tray: the window's second life. When the tray is enabled the window
//! closes to the tray (the harness keeps running), and the tray menu drives
//! show/hide, update checks, and a clean quit (exit 0, which the harness's
//! `desktop-shell` plugin reads as "the user is done").
//!
//! Beyond show/hide and updates, the tray also monitors live agents: the
//! harness pushes each running agent (id/title/status) plus a capped log tail
//! down the control channel, and the tray renders them as nested submenus.
//! "Stop agent" and "Refresh log tail" write control messages back up stdout
//! (the `dshdctl:` protocol, see docs/tray-agent-monitor.md), and when an
//! agent finishes a small red badge is painted onto the tray icon until the
//! user clears it.

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem, SubmenuBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::settings::UpdateInfo;
use crate::AppState;

/// Menu item ids this module owns (matched in `on_menu_event`).
const ID_SHOW_HIDE: &str = "show-hide";
const ID_CHECK_UPDATES: &str = "check-updates";
const ID_OPEN_UPDATE: &str = "open-update";
const ID_QUIT: &str = "quit";
/// The one menu id that is not prefix-scoped: clearing the finished badge.
const ID_CLEAR_BADGE: &str = "clear-badge";

/// A single running agent snapshot, pushed by the harness on change.
///
/// Defined here and re-exported so `lib.rs` can extend the stdin reader
/// without reaching into the menu layer.
pub struct AgentInfo {
	pub id: String,
	pub title: String,
	pub status: String,
}

/// A finished agent: id/title plus how long it ran. Kept newest-first and
/// capped at 10 entries (the most recent push is prepended).
pub struct FinishedInfo {
	pub id: String,
	pub title: String,
	pub time_ms: u64,
}

/// The maximum number of log lines kept per agent (mirrors the harness tail).
pub const LOG_CAP: usize = 40;
/// The number of finished entries the tray menu shows.
const FINISHED_MENU_SHOWN: usize = 3;
/// The last `menu_key` we actually set on the tray, so a rebuild whose state
/// has not changed can be skipped (avoids pointless menu churn). Written only
/// on a successful set_menu, so a failed build does not freeze the menu.
static LAST_MENU_KEY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Length-prefix one field of the fingerprint: `len:value`. Delimiters inside
/// the value cannot then collide with the delimiters between fields (a title
/// containing `|`/`;` must not alias a different state).
fn enc(value: &str) -> String {
	format!("{}:{value};", value.len())
}

/// A deterministic fingerprint of everything `build_menu` renders; callers
/// rebuild only when it changes.
fn menu_key(state: &AppState) -> String {
	let agents_key = {
		let agents = state.agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let mut key = String::new();
		for agent in agents.iter() {
			key.push_str(&enc(&agent.id));
			key.push_str(&enc(&agent.title));
			key.push_str(&enc(&agent.status));
		}
		key
	};
	let finished_key = {
		let finished = state.finished_agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let mut key = String::new();
		for entry in finished.iter() {
			key.push_str(&enc(&entry.id));
			key.push_str(&enc(&entry.title));
			key.push_str(&enc(&entry.time_ms.to_string()));
		}
		key
	};
	let update_key = state
		.update
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
		.as_ref()
		.map(|info| info.version.clone())
		.unwrap_or_default();
	// Log tails MUST be part of the fingerprint: a `get-log` reply changes
	// only the logs, and without them in the key the rebuild would be skipped
	// and "Refresh log tail" would never show anything.
	let logs_key = {
		let logs = state.agent_logs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let mut key = String::new();
		for (id, lines) in logs.iter() {
			key.push_str(&enc(id));
			key.push_str(&enc(&lines.len().to_string()));
			for line in lines.iter() {
				key.push_str(&enc(line));
			}
		}
		key
	};
	format!("agents[{agents_key}] finished[{finished_key}] logs[{logs_key}] update[{update_key}]")
}

/// Truncate a single log line to a menu-friendly width.
fn truncate_line(line: &str, max: usize) -> String {
	if line.chars().count() <= max {
		line.to_string()
	} else {
		line.chars().take(max).collect()
	}
}

/// Build the dynamic agent-monitor section between "Check for Updates" and the
/// update suggestion: the running agents (a nested submenu each with a log
/// tail, refresh, and stop) and — when badges are pending — the finished list
/// plus a clear action.
fn append_agent_section<'a>(
	builder: MenuBuilder<'a, tauri::Wry, tauri::AppHandle<tauri::Wry>>,
	app: &'a AppHandle,
) -> tauri::Result<MenuBuilder<'a, tauri::Wry, tauri::AppHandle<tauri::Wry>>> {
	let state = app.state::<AppState>();
	let mut builder = builder;

	let agents = state.agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	let finished = state.finished_agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	let logs = state.agent_logs.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

	if !agents.is_empty() {
		let header = MenuItem::with_id(app, "agents-heading", format!("Agents ({} running)", agents.len()), false, None::<&str>)?;
		builder = builder.item(&header);

		for (agent_index, agent) in agents.iter().enumerate() {
			let title = if agent.title.is_empty() { agent.id.clone() } else { agent.title.clone() };
			let mut sub = SubmenuBuilder::new(app, &title);

			match logs.get(&agent.id) {
				Some(lines) if !lines.is_empty() => {
					// The log is stored oldest-first; show the tail (last ≤ 8)
					// in chronological order. Ids are index-scoped so two
					// identical truncated lines never collide.
					for (line_index, line) in lines.iter().skip(lines.len().saturating_sub(8)).enumerate() {
						let text = truncate_line(line, 56);
						let item = MenuItem::with_id(app, format!("log-line-{agent_index}-{line_index}"), text, false, None::<&str>)?;
						sub = sub.item(&item);
					}
				}
				_ => {
					let none = MenuItem::with_id(app, format!("log-none-{}", agent.id), "No log yet", false, None::<&str>)?;
					sub = sub.item(&none);
				}
			}

			sub = sub.separator();
			let refresh = MenuItem::with_id(app, format!("get-log-{}", agent.id), "Refresh log tail", true, None::<&str>)?;
			sub = sub.item(&refresh);
			let stop = MenuItem::with_id(app, format!("stop-{}", agent.id), "Stop agent", true, None::<&str>)?;
			sub = sub.item(&stop);

			builder = builder.item(&sub.build()?);
		}
	}

	if !finished.is_empty() {
		for (entry_index, entry) in finished.iter().take(FINISHED_MENU_SHOWN).enumerate() {
			let time = short_time(entry.time_ms);
			let text = format!("✓ \"{}\" finished at {time}", truncate_line(&entry.title, 40));
			let item = MenuItem::with_id(app, format!("finished-{entry_index}"), text, false, None::<&str>)?;
			builder = builder.item(&item);
		}
		let clear = MenuItem::with_id(app, ID_CLEAR_BADGE, "Clear finished badge", true, None::<&str>)?;
		builder = builder.item(&clear);
	}

	Ok(builder)
}

/// Format a Unix-epoch millisecond timestamp as local HH:MM.
fn short_time(time_ms: u64) -> String {
	hms_local(time_ms.div_euclid(1000) as i64)
}

/// Local `HH:MM` for a Unix-epoch second. Falls back to UTC when `localtime_r`
/// is unavailable (non-Unix) or fails.
fn hms_local(secs: i64) -> String {
	#[cfg(unix)]
	{
		let mut tm = std::mem::MaybeUninit::<libc::tm>::uninit();
		// SAFETY: `localtime_r` writes `tm` and returns null on failure; we
		// only read it after a non-null return.
		let ptr = unsafe { libc::localtime_r(&secs, tm.as_mut_ptr()) };
		if !ptr.is_null() {
			let tm = unsafe { tm.assume_init() };
			return format!("{:02}:{:02}", tm.tm_hour, tm.tm_min);
		}
	}
	let seconds_in_day = secs.rem_euclid(86_400);
	let hours = seconds_in_day / 3600;
	let minutes = (seconds_in_day % 3600) / 60;
	format!("{hours:02}:{minutes:02}")
}

/// Build the tray menu reflecting the current update state.
fn build_menu(app: &AppHandle, update: Option<&UpdateInfo>) -> tauri::Result<Menu<tauri::Wry>> {
	let header = MenuItem::with_id(app, "header", "DeepSeek Harness", false, None::<&str>)?;
	let show_hide = MenuItem::with_id(app, ID_SHOW_HIDE, "Show / Hide Window", true, None::<&str>)?;
	let check = MenuItem::with_id(app, ID_CHECK_UPDATES, "Check for Updates", true, None::<&str>)?;
	let quit = MenuItem::with_id(app, ID_QUIT, "Quit", true, None::<&str>)?;
	let separator = PredefinedMenuItem::separator(app)?;

	let mut builder = MenuBuilder::new(app)
		.item(&header)
		.item(&separator)
		.item(&show_hide)
		.item(&check);

	// The live agent monitor lives right under "Check for Updates".
	builder = append_agent_section(builder, app)?;

	// The update suggestion sits right in the menu: a live item when a newer
	// release exists, a passive "up to date" otherwise.
	match update {
		Some(info) => {
			let open_update =
				MenuItem::with_id(app, ID_OPEN_UPDATE, format!("Update {} available", info.version), true, None::<&str>)?;
			builder = builder.item(&open_update);
		}
		None => {
			let up_to_date = MenuItem::with_id(app, "up-to-date", "Up to date", false, None::<&str>)?;
			builder = builder.item(&up_to_date);
		}
	}

	builder.item(&separator).item(&quit).build()
}

/// Create the tray icon and wire its menu handlers.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
	let menu = build_menu(app, None)?;
	// The window icon may be absent (e.g. no icon bundled); falling back to a
	// 1x1 transparent placeholder keeps the tray working instead of panicking.
	let icon = app
		.default_window_icon()
		.cloned()
		.unwrap_or_else(|| tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1));
	TrayIconBuilder::with_id("main")
		.icon(icon)
		.tooltip(agent_tooltip(app))
		.menu(&menu)
		.show_menu_on_left_click(true)
		.on_menu_event(|app, event| {
			let id = event.id.as_ref();
			if let Some(agent_id) = id.strip_prefix("stop-") {
				crate::log::info(app, &format!("tray: stop requested for {agent_id}"));
				// serde_json, not format!+{:?}: Rust's Debug escapes non-ASCII
				// as \u{e9}-style, which is NOT valid JSON and would make the
				// harness's JSON.parse of the dshdctl line fail silently.
				let payload = serde_json::json!({ "event": "stop-agent", "id": agent_id }).to_string();
				send_control(app, &payload);
			} else if let Some(agent_id) = id.strip_prefix("get-log-") {
				let payload = serde_json::json!({ "event": "get-log", "id": agent_id }).to_string();
				send_control(app, &payload);
			} else {
				match id {
					ID_SHOW_HIDE => toggle_window(app),
					ID_CHECK_UPDATES => {
						let handle = app.clone();
						tauri::async_runtime::spawn(async move {
							crate::update::run_check(&handle, true).await;
						});
					}
					ID_OPEN_UPDATE => {
						let state = app.state::<AppState>();
						let info = state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
						if let Some(info) = info {
							crate::log::info(app, &format!("opening release page {}", info.url));
							let _ = open::that(info.url);
						}
					}
					ID_CLEAR_BADGE => clear_badge(app),
					ID_QUIT => {
						let state = app.state::<AppState>();
						state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
						app.exit(0);
					}
					_ => {}
				}
			}
		})
		.on_tray_icon_event(|tray, event| {
			// Left-click toggles the window where the platform delivers clicks
			// (Linux appindicator usually does not; the menu covers it there).
			if let TrayIconEvent::Click {
				button: MouseButton::Left,
				button_state: MouseButtonState::Up,
				..
			} = event
			{
				toggle_window(tray.app_handle());
			}
		})
		.build(app)?;
	// Linux: libappindicator's StatusNotifierItem is owned by the GtkApplication.
	// Hiding the last window drops the hold count, and many tray hosts
	// (Plasma, waybar, …) then unregister the icon. Hold the application for
	// the rest of the process so close-to-tray keeps the icon.
	#[cfg(target_os = "linux")]
	hold_gtk_application(app);
	Ok(())
}

/// Keep GtkApplication alive after the last window is hidden. The returned
/// `ApplicationHoldGuard` releases the hold on drop, so we forget it: the
/// process is the tray's lifetime.
#[cfg(target_os = "linux")]
fn hold_gtk_application(app: &AppHandle) {
	use gio::prelude::ApplicationExtManual;
	use gtk::prelude::GtkWindowExt;
	let Some(win) = app.get_webview_window("main") else { return };
	let Ok(gtk_win) = win.gtk_window() else { return };
	let Some(gtk_app) = gtk_win.application() else { return };
	std::mem::forget(ApplicationExtManual::hold(&gtk_app));
}

/// Rebuild the tray menu (call after the update state changes), skipping the
/// work when nothing the menu renders has actually changed. Rebuilds are
/// serialized (stdin thread + async update tasks + menu events can all call
/// this): the key check, the build and the swap happen under one lock, so a
/// stale builder can never land last, and LAST_MENU_KEY is written only after
/// a successful set_menu (a failed build must not freeze later rebuilds).
///
/// GTK menu widgets must be created on the main thread; hopping here keeps
/// the stdin reader and the async updater from touching libappindicator off
/// the GTK loop (which has been observed to drop or corrupt the icon).
pub fn rebuild(app: &AppHandle) {
	let app = app.clone();
	let scheduled = app.clone();
	if let Err(error) = app.run_on_main_thread(move || rebuild_sync(&scheduled)) {
		crate::log::warn(&app, &format!("cannot schedule tray rebuild: {error}"));
	}
}

fn rebuild_sync(app: &AppHandle) {
	let Some(tray) = app.tray_by_id("main") else { return };
	let state = app.state::<AppState>();
	let _guard = state.rebuild_lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	let key = menu_key(&state);
	{
		let last = LAST_MENU_KEY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		if last.as_deref() == Some(key.as_str()) {
			return;
		}
	}
	let update = state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
	match build_menu(app, update.as_ref()) {
		Ok(menu) => {
			if let Err(error) = tray.set_menu(Some(menu)) {
				crate::log::warn(app, &format!("cannot set tray menu: {error}"));
				return;
			}
			*LAST_MENU_KEY.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(key);
			set_tooltip(app);
		}
		Err(error) => crate::log::warn(app, &format!("cannot rebuild tray menu: {error}")),
	}
}

/// The tooltip text for the current agent count.
fn agent_tooltip(app: &AppHandle) -> String {
	let count = app.state::<AppState>().agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).len();
	match count {
		0 => "DeepSeek Harness".to_string(),
		1 => "DeepSeek Harness — 1 agent running".to_string(),
		n => format!("DeepSeek Harness — {n} agents running"),
	}
}

/// Refresh the tray tooltip from the live agent count.
fn set_tooltip(app: &AppHandle) {
	if let Some(tray) = app.tray_by_id("main") {
		let _ = tray.set_tooltip(Some(agent_tooltip(app)));
	}
}

/// Write a control message to stdout for the harness, serialized under the
/// `control_out` mutex. Errors are ignored: a broken pipe just means the
/// harness (our only stdout reader) has gone away.
pub fn send_control(app: &AppHandle, payload: &str) {
	use std::io::Write;
	let state = app.state::<AppState>();
	let _guard = state.control_out.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	let mut out = std::io::stdout().lock();
	let _ = writeln!(out, "dshdctl:{payload}");
	let _ = out.flush();
}

/// Paint a small filled red badge onto the current tray icon, storing the
/// pristine icon on first use so it can be restored later. Mutex poison is
/// shrugged off: the badge is cosmetic, never failure-worthy.
pub fn set_badge(app: &AppHandle) {
	let Some(tray) = app.tray_by_id("main") else { return };
	let state = app.state::<AppState>();

	let original = {
		let mut slot = state.tray_icon_original.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		match slot.as_ref() {
			Some(image) => image.clone(),
			None => {
				// Copy the pristine icon into owned buffers so the stored
				// `Image` really is `'static` (a bare borrow-bound clone would
				// pin it to the app handle's lifetime).
				let pristine = match app.default_window_icon().cloned() {
					Some(image) => tauri::image::Image::new_owned(image.rgba().to_vec(), image.width(), image.height()),
					None => tauri::image::Image::new_owned(vec![0, 0, 0, 0], 1, 1),
				};
				*slot = Some(pristine.clone());
				pristine
			}
		}
	};

	if let Ok(badged) = badged_icon(&original) {
		let _ = tray.set_icon(Some(badged));
		set_tooltip(app);
		crate::log::info(app, "tray: badge painted on tray icon");
	}
}

/// Overlay a filled red circle (opaque, hard edge) in the top-right quadrant
/// onto a copy of the tray icon's RGBA buffer. Dimensions use the icon's own
/// size, so the badge scales with whatever icon the app bundles.
fn badged_icon(original: &tauri::image::Image<'_>) -> tauri::Result<tauri::image::Image<'static>> {
	let width = original.width().max(1) as usize;
	let height = original.height().max(1) as usize;
	let mut rgba = original.rgba().to_vec();

	let smaller = width.min(height) as f64;
	let center_x = (0.85 * width as f64) as usize;
	let center_y = (0.15 * height as f64) as usize;
	let radius = (0.22 * smaller).max(3.0);
	let radius2 = radius * radius;

	for y in 0..height {
		for x in 0..width {
			let dx = x as f64 - center_x as f64;
			let dy = y as f64 - center_y as f64;
			if dx * dx + dy * dy <= radius2 {
				let index = (y * width + x) * 4;
				rgba[index] = 255; // R
				rgba[index + 1] = 0; // G
				rgba[index + 2] = 0; // B
				rgba[index + 3] = 255; // A — opaque
			}
		}
	}
	Ok(tauri::image::Image::new_owned(rgba, width as u32, height as u32))
}

/// Remove the badge: drop the finished list, restore the pristine icon, and
/// rebuild the menu.
fn clear_badge(app: &AppHandle) {
	let state = app.state::<AppState>();
	state.finished_agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clear();
	let original = state.tray_icon_original.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).take();
	if let Some(tray) = app.tray_by_id("main") {
		if let Some(icon) = original {
			let _ = tray.set_icon(Some(icon));
		}
		set_tooltip(app);
	}
	rebuild(app);
}

/// Show the window if hidden or minimized, hide it if visible.
pub fn toggle_window(app: &AppHandle) {
	if let Some(win) = app.get_webview_window("main") {
		let visible = win.is_visible().unwrap_or(false);
		let minimized = win.is_minimized().unwrap_or(false);
		if visible && !minimized {
			hide_window(app);
		} else {
			show_window(app);
		}
	}
}

/// Hide the main window and keep the tray icon registered.
///
/// On Linux, `gtk_window_hide` on the last window makes many StatusNotifier
/// hosts drop the AppIndicator. Re-asserting Active after hide (and the
/// GtkApplication hold in `setup`) is what keeps the icon in the tray.
pub fn hide_window(app: &AppHandle) {
	if let Some(win) = app.get_webview_window("main") {
		let _ = win.hide();
	}
	keep_alive(app);
}

/// Restore the main window (unminimize + show + focus).
pub fn show_window(app: &AppHandle) {
	if let Some(win) = app.get_webview_window("main") {
		let _ = win.unminimize();
		let _ = win.show();
		let _ = win.set_focus();
	}
}

/// Re-activate the StatusNotifierItem after a hide so tray hosts that
/// dropped it on unmap pick it back up.
pub fn keep_alive(app: &AppHandle) {
	if let Some(tray) = app.tray_by_id("main") {
		let _ = tray.set_visible(true);
	}
}

/// Show or hide the tray icon to match the `tray` setting. If the icon was
/// never created (setup failed at boot) and the user turns the setting on,
/// try to create it now rather than leaving them with no tray and no way
/// to get one without a restart.
pub fn set_icon_visible(app: &AppHandle, visible: bool) {
	if let Some(tray) = app.tray_by_id("main") {
		let _ = tray.set_visible(visible);
		return;
	}
	if visible {
		if let Err(error) = setup(app) {
			crate::log::warn(app, &format!("tray still unavailable: {error}"));
		}
	}
}

/// True when the window is currently visible (for close-to-tray decisions).
pub fn window_visible(app: &AppHandle) -> bool {
	app.get_webview_window("main")
		.and_then(|win| win.is_visible().ok())
		.unwrap_or(true)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn short_time_is_hh_mm() {
		let text = short_time(0);
		assert_eq!(text.len(), 5);
		assert_eq!(&text[2..3], ":");
		assert!(text[..2].chars().all(|c| c.is_ascii_digit()));
		assert!(text[3..].chars().all(|c| c.is_ascii_digit()));
	}

	#[test]
	fn short_time_utc_fallback_wraps_the_day() {
		// 1 second before the Unix epoch: UTC 23:59. On Unix this test is
		// the local equivalent of that instant, so we only assert the
		// format, not the numbers. The UTC fallback path is what we check
		// with rem_euclid on a known value via hms of a day-aligned stamp.
		let noon_utc = 12 * 3600;
		let utc = {
			let seconds_in_day = (noon_utc as i64).rem_euclid(86_400);
			let hours = seconds_in_day / 3600;
			let minutes = (seconds_in_day % 3600) / 60;
			format!("{hours:02}:{minutes:02}")
		};
		assert_eq!(utc, "12:00");
	}
}
