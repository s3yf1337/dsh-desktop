//! Update orchestration: run a check, apply its result to the app state,
//! surface it (tray menu, event to the settings tab, optional notification),
//! drive the periodic re-check loop, and — when the user clicks "Update now"
//! — download the platform artifact and apply it in place.
//!
//! The updater never acts on its own: background checks only run while the
//! `auto_update_check` setting is on (default off), and applying an update
//! happens only through the explicit one-click action in the settings tab.

use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::now_rfc3339;
use crate::tray;
use crate::AppState;

/// The event the settings tab listens to; payload is the full `DesktopState`.
pub const STATE_EVENT: &str = "desktop://state";
/// Progress of the one-click update; payload `{ phase, received?, total? }`.
pub const UPDATE_PROGRESS_EVENT: &str = "desktop://update-progress";
/// The window title (session title) for the custom title bar.
pub const TITLE_EVENT: &str = "desktop://title";

/// Delay before the first startup check (let the window open first).
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(8);

/// Emit a progress line for the one-click update (the settings tab renders a
/// progress bar from these).
pub fn emit_progress(app: &AppHandle, phase: &str, received: Option<u64>, total: Option<u64>) {
	let _ = app.emit(
		UPDATE_PROGRESS_EVENT,
		serde_json::json!({ "phase": phase, "received": received, "total": total }),
	);
}

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
					crate::log::info(app, &format!("update available: {}", info.version));
				}
				None => {
					*state.update.lock().unwrap() = None;
					*state.last_check.lock().unwrap() = Some(now_rfc3339());
					*state.check_error.lock().unwrap() = None;
					drop(state);
					emit_and_rebuild(app);
					if with_notification {
						crate::log::info(app, &format!("up to date ({current} vs {})", release.tag_name));
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
				crate::log::info(app, "no releases published yet; up to date");
			}
		}
		Err(error) => {
			*state.check_error.lock().unwrap() = Some(error.clone());
			drop(state);
			emit_and_rebuild(app);
			crate::log::error(app, &format!("update check failed: {error}"));
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
		crate::log::warn(app, &format!("notification failed: {error}"));
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

/// The exit code the shell uses to tell the profile plugin "an update was
/// applied, please relaunch the profile" (the plugin schedules a fresh
/// `dsh --profile desktop` and then shuts the old harness down).
pub const RESTART_EXIT_CODE: i32 = 11;

/// One-click update: download the platform artifact and apply it in place.
///
/// Returns the newly installed version string on success. The caller is
/// responsible for restarting (exit with [`RESTART_EXIT_CODE`]); this only
/// swaps the files.
///
/// `DSH_DESKTOP_UPDATE_TARBALL` (a local `.tar.gz` path) overrides the GitHub
/// download entirely — the testing backdoor for validating apply/restart
/// without publishing a release.
pub async fn download_and_apply(app: &AppHandle) -> Result<String, String> {
	let state = app.state::<AppState>();

	// Testing backdoor: apply a local tarball, skip the GitHub round trip.
	if let Some(local) = std::env::var_os("DSH_DESKTOP_UPDATE_TARBALL") {
		let local = local.to_string_lossy().into_owned();
		emit_progress(app, "downloading", None, None);
		crate::log::info(app, &format!("applying local update tarball {local}"));
		let version = apply_tarball(app, &local).await?;
		return Ok(version);
	}

	emit_progress(app, "checking", None, None);
	let release = crate::updater::fetch_latest()
		.await?
		.ok_or_else(|| "no releases published yet".to_string())?;
	let current = env!("CARGO_PKG_VERSION");
	let _info = crate::updater::update_info_for(current, &release)
		.ok_or_else(|| format!("already up to date (v{current})"))?;
	let asset = crate::updater::find_platform_asset(&release)
		.ok_or_else(|| format!("no update package for this platform (release has: {})", release.assets.iter().map(|a| a.name.as_str()).collect::<Vec<_>>().join(", ")))?;

	let config_dir = app.path().app_config_dir().map_err(|e| format!("config dir: {e}"))?;
	let updates_dir = config_dir.join("updates");
	std::fs::create_dir_all(&updates_dir).map_err(|e| format!("cannot create updates dir: {e}"))?;
	let archive = updates_dir.join(&asset.name);

	// Download with progress events (the settings tab shows the bar).
	emit_progress(app, "downloading", Some(0), Some(asset.size));
	{
		use futures_util::StreamExt as _;
		let client = reqwest::Client::builder()
			.user_agent(concat!("dsh-desktop/", env!("CARGO_PKG_VERSION")))
			.timeout(Duration::from_secs(300))
			.build()
			.map_err(|error| format!("http client: {error}"))?;
		let response = client
			.get(&asset.browser_download_url)
			.send()
			.await
			.map_err(|error| format!("download failed: {error}"))?;
		let status = response.status();
		if !status.is_success() {
			return Err(format!("download failed: {status}"));
		}
		let total = response.content_length().unwrap_or(asset.size);
		let mut stream = response.bytes_stream();
		let mut received: u64 = 0;
		let mut file = tokio::fs::File::create(&archive)
			.await
			.map_err(|error| format!("cannot create {archive:?}: {error}"))?;
		use tokio::io::AsyncWriteExt;
		while let Some(chunk) = stream.next().await {
			let chunk = chunk.map_err(|error| format!("download interrupted: {error}"))?;
			received += chunk.len() as u64;
			file.write_all(&chunk)
				.await
				.map_err(|error| format!("cannot write {archive:?}: {error}"))?;
			emit_progress(app, "downloading", Some(received), Some(total));
		}
		file.flush().await.map_err(|error| format!("cannot flush {archive:?}: {error}"))?;
	}
	drop(state);
	let version = apply_tarball(app, &archive.to_string_lossy()).await?;
	Ok(version)
}

/// Extract a release tarball and swap the running binary + profile bundle.
async fn apply_tarball(app: &AppHandle, archive: &str) -> Result<String, String> {
	emit_progress(app, "applying", None, None);
	let path = std::path::PathBuf::from(archive);

	let config_dir = app.path().app_config_dir().map_err(|e| format!("config dir: {e}"))?;
	let work = config_dir.join("updates").join("extract");
	if work.exists() {
		std::fs::remove_dir_all(&work).map_err(|e| format!("cannot clean extract dir: {e}"))?;
	}
	std::fs::create_dir_all(&work).map_err(|e| format!("cannot create extract dir: {e}"))?;

	// tar.gz → unpack.
	{
		let file = std::fs::File::open(&path).map_err(|e| format!("cannot open {archive}: {e}"))?;
		let decoder = flate2::read::GzDecoder::new(file);
		let mut unpacker = tar::Archive::new(decoder);
		unpacker.set_overwrite(true);
		unpacker.unpack(&work).map_err(|e| format!("cannot unpack {path:?}: {e}"))?;
	}

	// The tarball layout: `dsh-desktop-shell[.exe]` + `bundle/` at the root.
	let binary_name = if cfg!(target_os = "windows") { "dsh-desktop-shell.exe" } else { "dsh-desktop-shell" };
	let new_binary = find_file(&work, binary_name).ok_or_else(|| format!("update package has no {binary_name}"))?;
	let new_bundle = find_dir(&work, "bundle").ok_or_else(|| "update package has no bundle/".to_string())?;

	// Replace the running executable. Unix: rename + write (the running
	// process keeps its inode; the next launch uses the new file). Windows:
	// a running exe cannot be overwritten, so rename it aside first.
	let current = std::env::current_exe().map_err(|e| format!("cannot resolve current exe: {e}"))?;
	let old = current.with_extension(
		current
			.extension()
			.map(|ext| format!("{}.old", ext.to_string_lossy()))
			.unwrap_or_else(|| "old".into()),
	);
	let _ = std::fs::remove_file(&old);
	if cfg!(target_os = "windows") {
		let mut renamed = false;
		for _ in 0..10 {
			match std::fs::rename(&current, &old) {
				Ok(()) => {
					renamed = true;
					break;
				}
				Err(_) => tokio::time::sleep(Duration::from_millis(300)).await,
			}
		}
		if !renamed {
			return Err("cannot replace the running client (Windows locked it)".into());
		}
	} else {
		let _ = std::fs::rename(&current, &old);
	}
	std::fs::copy(&new_binary, &current).map_err(|e| format!("cannot install new client: {e}"))?;
	#[cfg(not(target_os = "windows"))]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = std::fs::set_permissions(&current, std::fs::Permissions::from_mode(0o755));
	}
	// macOS: re-sign the swapped binary so Gatekeeper keeps accepting it.
	#[cfg(target_os = "macos")]
	{
		let _ = std::process::Command::new("codesign").args(["--force", "-s", "-"]).arg(&current).status();
	}
	// The leftover `.old` is cleaned up on the next start.
	std::fs::remove_file(&old).ok();

	// Refresh the plugin bundle inside the profile from the *new* release's
	// bundle/ (the harness serves it after the restart).
	crate::install::refresh_profile_bundle_from(&new_bundle)?;

	// Version sanity: the new binary reports its own version on `--version`.
	let version = std::process::Command::new(&current)
		.arg("--version")
		.output()
		.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
		.unwrap_or_else(|_| "unknown".into());

	let _ = std::fs::remove_file(&path);
	crate::log::info(app, &format!("update applied; new client reports {version}"));
	Ok(version)
}

/// Depth-limited search for a file by name inside `root`.
fn find_file(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
	let mut stack = vec![root.to_path_buf()];
	for _ in 0..6 {
		let Some(dir) = stack.pop() else { break };
		let Ok(entries) = std::fs::read_dir(&dir) else { continue };
		for entry in entries.flatten() {
			let path = entry.path();
			if entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
				if entry.file_name().to_string_lossy() == name {
					return Some(path);
				}
			} else {
				stack.push(path);
			}
		}
	}
	None
}

/// Depth-limited search for a directory by name inside `root`.
fn find_dir(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
	let mut stack = vec![root.to_path_buf()];
	for _ in 0..6 {
		let Some(dir) = stack.pop() else { break };
		let Ok(entries) = std::fs::read_dir(&dir) else { continue };
		for entry in entries.flatten() {
			let path = entry.path();
			if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
				if entry.file_name().to_string_lossy() == name {
					return Some(path);
				}
				stack.push(path);
			}
		}
	}
	None
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
