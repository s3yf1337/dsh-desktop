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
/// has not changed can be skipped (avoids pointless menu churn).
static LAST_MENU_KEY: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// A deterministic fingerprint of everything `build_menu` renders; callers
/// rebuild only when it changes.
fn menu_key(state: &AppState) -> String {
	let agents_key = {
		let agents = state.agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let mut key = String::new();
		for agent in agents.iter() {
			key.push_str(&format!("{}|{}|{};", agent.id, agent.title, agent.status));
		}
		key
	};
	let finished_key = {
		let finished = state.finished_agents.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		let mut key = String::new();
		for entry in finished.iter() {
			key.push_str(&format!("{}|{}|{};", entry.id, entry.title, entry.time_ms));
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
			key.push_str(&format!("{id}={}:{};", lines.len(), lines.join("\u{1f}")));
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

		for agent in agents.iter() {
			let title = if agent.title.is_empty() { agent.id.clone() } else { agent.title.clone() };
			let mut sub = SubmenuBuilder::new(app, &title);

			match logs.get(&agent.id) {
				Some(lines) if !lines.is_empty() => {
					// The log is stored oldest-first; show the tail (last ≤ 8)
					// in chronological order.
					for line in lines.iter().skip(lines.len().saturating_sub(8)) {
						let text = truncate_line(line, 56);
						let item = MenuItem::with_id(app, format!("log-line-{}-{}", agent.id, text), text, false, None::<&str>)?;
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
		for entry in finished.iter().take(FINISHED_MENU_SHOWN) {
			let time = short_time(entry.time_ms);
			let text = format!("✓ \"{}\" finished at {time}", entry.title);
			let item = MenuItem::with_id(app, format!("finished-{}", entry.id), text, false, None::<&str>)?;
			builder = builder.item(&item);
		}
		let clear = MenuItem::with_id(app, ID_CLEAR_BADGE, "Clear finished badge", true, None::<&str>)?;
		builder = builder.item(&clear);
	}

	Ok(builder)
}

/// Format a Unix-epoch millisecond timestamp as local HH:MM.
fn short_time(time_ms: u64) -> String {
	let secs = time_ms.div_euclid(1000);
	let seconds_in_day = secs % 86_400;
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
		.menu_on_left_click(true)
		.on_menu_event(|app, event| {
			let id = event.id.as_ref();
			if let Some(agent_id) = id.strip_prefix("stop-") {
				crate::log::info(app, &format!("tray: stop requested for {agent_id}"));
				let payload = format!(r#"{{"event":"stop-agent","id":{agent_id:?}}}"#);
				send_control(app, &payload);
			} else if let Some(agent_id) = id.strip_prefix("get-log-") {
				let payload = format!(r#"{{"event":"get-log","id":{agent_id:?}}}"#);
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
	Ok(())
}

/// Rebuild the tray menu (call after the update state changes), skipping the
/// work when nothing the menu renders has actually changed.
pub fn rebuild(app: &AppHandle) {
	if let Some(tray) = app.tray_by_id("main") {
		let state = app.state::<AppState>();
		let key = menu_key(&state);
		{
			let mut last = LAST_MENU_KEY.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
			if last.as_deref() == Some(key.as_str()) {
				return;
			}
			*last = Some(key);
		}
		let update = state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
		match build_menu(app, update.as_ref()) {
			Ok(menu) => {
				let _ = tray.set_menu(Some(menu));
				set_tooltip(app);
			}
			Err(error) => crate::log::warn(app, &format!("cannot rebuild tray menu: {error}")),
		}
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

/// Show the window if hidden, hide it if visible.
pub fn toggle_window(app: &AppHandle) {
	if let Some(win) = app.get_webview_window("main") {
		match win.is_visible() {
			Ok(true) => {
				let _ = win.hide();
			}
			_ => {
				let _ = win.show();
				let _ = win.set_focus();
			}
		}
	}
}

/// True when the window is currently visible (for close-to-tray decisions).
pub fn window_visible(app: &AppHandle) -> bool {
	app.get_webview_window("main")
		.and_then(|win| win.is_visible().ok())
		.unwrap_or(true)
}
