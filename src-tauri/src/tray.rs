//! System tray: the window's second life. When the tray is enabled the window
//! closes to the tray (the harness keeps running), and the tray menu drives
//! show/hide, update checks, and a clean quit (exit 0, which the harness's
//! `desktop-shell` plugin reads as "the user is done").

use tauri::menu::{Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::settings::UpdateInfo;
use crate::AppState;

/// Menu item ids this module owns (matched in `on_menu_event`).
const ID_SHOW_HIDE: &str = "show-hide";
const ID_CHECK_UPDATES: &str = "check-updates";
const ID_OPEN_UPDATE: &str = "open-update";
const ID_QUIT: &str = "quit";

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
		.tooltip("DeepSeek Harness")
		.menu(&menu)
		.menu_on_left_click(true)
		.on_menu_event(|app, event| match event.id.as_ref() {
			ID_SHOW_HIDE => toggle_window(app),
			ID_CHECK_UPDATES => {
				let handle = app.clone();
				tauri::async_runtime::spawn(async move {
					crate::update::run_check(&handle, true).await;
				});
			}
			ID_OPEN_UPDATE => {
				let state = app.state::<AppState>();
				let info = state.update.lock().unwrap().clone();
				if let Some(info) = info {
					crate::log::info(app, &format!("opening release page {}", info.url));
					let _ = open::that(info.url);
				}
			}
			ID_QUIT => {
				let state = app.state::<AppState>();
				state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
				app.exit(0);
			}
			_ => {}
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

/// Rebuild the tray menu (call after the update state changes).
pub fn rebuild(app: &AppHandle) {
	if let Some(tray) = app.tray_by_id("main") {
		let state = app.state::<AppState>();
		let update = state.update.lock().unwrap().clone();
		match build_menu(app, update.as_ref()) {
			Ok(menu) => {
				let _ = tray.set_menu(Some(menu));
			}
			Err(error) => crate::log::warn(app, &format!("cannot rebuild tray menu: {error}")),
		}
	}
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
