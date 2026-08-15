//! Update orchestration: run a check, apply its result to the app state,
//! surface it (tray menu, event to the settings tab, optional notification),
//! drive the periodic re-check loop, and — when the user clicks "Update now"
//! — download the platform artifact and apply it in place.
//!
//! The updater never acts on its own: background checks only run while the
//! `auto_update_check` setting is on (default off), and applying an update
//! happens only through the explicit one-click action in the settings tab.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};

use crate::settings::now_rfc3339;
use crate::tray;
use crate::AppState;

/// Set while a one-click `download_and_apply` is in flight. Guards against a
/// second concurrent update: the periodic auto-check must not stomp on an
/// apply that is mid-swap.
static UPDATE_IN_PROGRESS: AtomicBool = AtomicBool::new(false);

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
						let mut slot = state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
						let changed = slot.as_ref().map(|old| old.version != info.version).unwrap_or(true);
						*slot = Some(info.clone());
						changed
					};
					*state.last_check.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(now_rfc3339());
					*state.check_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
					drop(state);
					emit_and_rebuild(app);
					let notifications_enabled = app.state::<AppState>().settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).notifications;
					if with_notification && newly_available && notifications_enabled {
						notify(app, "Update available", &format!("dsh-desktop {} is out — open it from the tray or Settings.", info.version));
					}
					crate::log::info(app, &format!("update available: {}", info.version));
				}
				None => {
					*state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
					*state.last_check.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(now_rfc3339());
					*state.check_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
					drop(state);
					emit_and_rebuild(app);
					if with_notification {
						crate::log::info(app, &format!("up to date ({current} vs {})", release.tag_name));
					}
				}
			}
		}
		Ok(None) => {
			*state.update.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
			*state.last_check.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(now_rfc3339());
			*state.check_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
			drop(state);
			emit_and_rebuild(app);
			if with_notification {
				crate::log::info(app, "no releases published yet; up to date");
			}
		}
		Err(error) => {
			*state.check_error.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(error.clone());
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
			let settings = state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
			(settings.auto_update_check, settings.update_interval_hours.max(1))
		};
		if enabled {
			// Skip this cycle while a one-click update is being applied in
			// place — it would be checked against a half-replaced state.
			if !UPDATE_IN_PROGRESS.load(Ordering::SeqCst) {
				run_check(&app, false).await;
			}
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
	let enabled = app.state::<AppState>().settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).notifications;
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
	// Concurrent-update guard: a second update while one is mid-apply must be
	// refused outright. Reset on every exit path (the body runs in a nested
	// fn so the flag is always cleared, even on error).
	if UPDATE_IN_PROGRESS.swap(true, Ordering::SeqCst) {
		return Err("update already in progress".into());
	}
	let result = download_and_apply_inner(app).await;
	UPDATE_IN_PROGRESS.store(false, Ordering::SeqCst);
	result
}

async fn download_and_apply_inner(app: &AppHandle) -> Result<String, String> {
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
	// Download into a `.part` file and only rename it to the final name once
	// the checksum has been verified — an interrupted/partial download is never
	// mistaken for a complete archive.
	let part = updates_dir.join(format!("{}.part", asset.name));

	// Download with progress events (the settings tab shows the bar).
	emit_progress(app, "downloading", Some(0), Some(asset.size));
	let result = download_to(client_with_policy(app, Duration::from_secs(300)), &asset.browser_download_url, asset.size, &part, app).await;
	if let Err(e) = &result {
		let _ = std::fs::remove_file(&part);
		return Err(e.clone());
	}

	// Checksum verification before we commit to the archive: the package must
	// ship a sibling `<tarball>.sha256` asset, or we refuse to apply.
	let checksum_asset = crate::updater::find_checksum_asset(&release, &asset.name)
		.ok_or_else(|| "update package has no .sha256 checksum — refusing unverified update".to_string())?;
	emit_progress(app, "verifying", None, None);
	let checksum = fetch_checksum(&checksum_asset.browser_download_url, app).await?;
	let archive_bytes = std::fs::read(&part)
		.map_err(|e| format!("cannot read downloaded archive: {e}"))?;
	let digest = ring::digest::digest(&ring::digest::SHA256, &archive_bytes);
	let actual = hex_encode(&digest);
	if !checksum_hex_matches(&checksum, &actual) {
		let _ = std::fs::remove_file(&part);
		return Err(format!(
			"checksum mismatch: expected {checksum:?}, got {actual} — refusing unverified update"
		));
	}
	std::fs::rename(&part, &archive)
		.map_err(|e| format!("cannot finalize download {archive:?}: {e}"))?;

	drop(state);
	let version = apply_tarball(app, &archive.to_string_lossy()).await?;
	Ok(version)
}

/// Extract a release tarball and swap the running binary + profile bundle.
///
/// Ordering matters for atomicity: validate the *new* binary before touching
/// `current`, refresh the profile bundle, and only then perform the final
/// swap. On Windows the previous executable is kept as `.old` until the whole
/// apply has succeeded, and is deleted last; any failure after the swap tries
/// to restore `.old`.
async fn apply_tarball(app: &AppHandle, archive: &str) -> Result<String, String> {
	emit_progress(app, "applying", None, None);
	let path = std::path::PathBuf::from(archive);

	let config_dir = app.path().app_config_dir().map_err(|e| format!("config dir: {e}"))?;
	let work = config_dir.join("updates").join("extract");
	if work.exists() {
		std::fs::remove_dir_all(&work).map_err(|e| format!("cannot clean extract dir: {e}"))?;
	}
	std::fs::create_dir_all(&work).map_err(|e| format!("cannot create extract dir: {e}"))?;

	// tar.gz → unpack. On failure, drop the partial extract so a later retry
	// starts from a clean tree.
	let unpack_result = (|| -> Result<(), String> {
		let file = std::fs::File::open(&path).map_err(|e| format!("cannot open {archive}: {e}"))?;
		let decoder = flate2::read::GzDecoder::new(file);
		let mut unpacker = tar::Archive::new(decoder);
		unpacker.set_overwrite(true);
		unpacker.unpack(&work).map_err(|e| format!("cannot unpack {path:?}: {e}"))
	})();
	if let Err(e) = unpack_result {
		let _ = std::fs::remove_dir_all(&work);
		return Err(e);
	}

	// The tarball layout: `dsh-desktop-shell[.exe]` + `bundle/` at the root.
	let binary_name = if cfg!(target_os = "windows") { "dsh-desktop-shell.exe" } else { "dsh-desktop-shell" };
	let new_binary = find_file(&work, binary_name).ok_or_else(|| format!("update package has no {binary_name}"))?;
	let new_bundle = find_dir(&work, "bundle").ok_or_else(|| "update package has no bundle/".to_string())?;

	let current = std::env::current_exe().map_err(|e| format!("cannot resolve current exe: {e}"))?;

	#[cfg(target_os = "windows")]
	{
		let old = current.with_extension(
			current
				.extension()
				.map(|ext| format!("{}.old", ext.to_string_lossy()))
				.unwrap_or_else(|| "old".into()),
		);
		apply_tarball_windows(app, &current, &old, &new_binary, &new_bundle, &path).await
	}
	#[cfg(not(target_os = "windows"))]
	{
		apply_tarball_unix(app, &current, &new_binary, &new_bundle, &path).await
	}
}

#[cfg(not(target_os = "windows"))]
async fn apply_tarball_unix(
	app: &AppHandle,
	current: &std::path::Path,
	new_binary: &std::path::Path,
	new_bundle: &std::path::Path,
	path: &std::path::Path,
) -> Result<String, String> {
	// Unix: write the new binary to a sibling temp file, validate it, then
	// `rename` it atomically over `current`. The running process keeps its old
	// inode; the next launch uses the new file. The current binary is never
	// truncated (no in-place copy) and needs no `.old` backup.
	use std::os::unix::fs::PermissionsExt;

	// Build `<current>.new` by extending the file-name, not the extension.
	let mut tmp_name = current.file_name().map(|n| n.to_os_string()).unwrap_or_default();
	tmp_name.push(".new");
	let tmp = current.with_file_name(&tmp_name);

	let code = (|| -> Result<(), String> {
		std::fs::copy(new_binary, &tmp).map_err(|e| format!("cannot stage new client: {e}"))?;
		std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
			.map_err(|e| format!("cannot chmod staged client: {e}"))?;
		// Validate the staged binary before swapping it in.
		let status = std::process::Command::new(&tmp).arg("--version").status();
		if !status.map(|s| s.success()).unwrap_or(false) {
			return Err("staged new client failed its --version check".to_string());
		}
		Ok(())
	})();
	if let Err(e) = code {
		let _ = std::fs::remove_file(&tmp);
		return Err(e);
	}

	// macOS: ad-hoc re-sign the *staged* binary so Gatekeeper keeps accepting
	// it after the rename. Like before, a signing failure is non-fatal.
	#[cfg(target_os = "macos")]
	{
		match std::process::Command::new("codesign").args(["--force", "-s", "-"]).arg(&tmp).status() {
			Ok(_) => {}
			Err(e) => crate::log::warn(app, &format!("ad-hoc codesign failed (continuing): {e}")),
		}
	}

	// Refresh the plugin bundle inside the profile *before* the final swap;
	// the bundle refresh is the part with no local backup.
	crate::install::refresh_profile_bundle_from(new_bundle)?;

	// Atomic swap.
	std::fs::rename(&tmp, current).map_err(|e| format!("cannot swap new client into place: {e}"))?;

	let version = std::process::Command::new(current)
		.arg("--version")
		.output()
		.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
		.unwrap_or_else(|_| "unknown".into());

	let _ = std::fs::remove_file(path);
	crate::log::info(app, &format!("update applied; new client reports {version}"));
	Ok(version)
}

#[cfg(target_os = "windows")]
async fn apply_tarball_windows(
	app: &AppHandle,
	current: &std::path::Path,
	old: &std::path::Path,
	new_binary: &std::path::Path,
	new_bundle: &std::path::Path,
	path: &std::path::Path,
) -> Result<String, String> {
	// Windows: a running exe cannot be overwritten, so the current binary is
	// renamed aside to `.old` (with retries for the briefly-locked file), then
	// the new one is copied into place. `.old` is only deleted after the whole
	// apply has succeeded, so a failed bundle refresh can be rolled back.
	// A stale `.old` left by a *previous* interrupted apply is dropped first
	// (best-effort) so it can't block this apply's rename.
	let _ = std::fs::remove_file(old);
	let mut renamed = false;
	for _ in 0..10 {
		match std::fs::rename(current, old) {
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
	if let Err(e) = std::fs::copy(new_binary, current) {
		// Best-effort rollback of the swap before returning.
		let _ = std::fs::rename(old, current);
		return Err(format!("cannot install new client (rolled back): {e}"));
	}
	// Windows executables don't carry the Unix mode bit; nothing to chmod.

	// Refresh the plugin bundle inside the profile from the *new* bundle/.
	if let Err(e) = crate::install::refresh_profile_bundle_from(new_bundle) {
		// Restore the previous .exe so the next launch is the old, known-good
		// client, then clean up the half-installed new one.
		let _ = std::fs::remove_file(current);
		let _ = std::fs::rename(old, current);
		return Err(format!("cannot refresh bundle, rolled back client: {e}"));
	}

	// Version sanity: the new binary reports its own version on `--version`.
	let version = std::process::Command::new(current)
		.arg("--version")
		.output()
		.map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
		.unwrap_or_else(|_| "unknown".into());

	// Everything succeeded: now the `.old` backup can finally go away.
	let _ = std::fs::remove_file(old);
	let _ = std::fs::remove_file(path);
	crate::log::info(app, &format!("update applied; new client reports {version}"));
	Ok(version)
}

/// A reqwest client with the updater's user agent, timeout and an HTTPS-only
/// redirect policy (a redirected download must never downgrade to plain HTTP).
fn client_with_policy(app: &AppHandle, timeout: Duration) -> reqwest::Client {
	reqwest::Client::builder()
		.user_agent(concat!("dsh-desktop/", env!("CARGO_PKG_VERSION")))
		.timeout(timeout)
		.redirect(reqwest::redirect::Policy::custom(|attempt| {
			if attempt.url().scheme() == "https" {
				attempt.follow()
			} else {
				attempt.stop()
			}
		}))
		.build()
		.unwrap_or_else(|error| {
			crate::log::warn(app, &format!("http client fallback: {error}"));
			reqwest::Client::new()
		})
}

/// Stream a download into `dest`, emitting progress events.
async fn download_to(
	client: reqwest::Client,
	url: &str,
	expected_size: u64,
	dest: &std::path::Path,
	app: &AppHandle,
) -> Result<(), String> {
	use futures_util::StreamExt as _;
	use tokio::io::AsyncWriteExt;
	let response = client.get(url).send().await.map_err(|error| format!("download failed: {error}"))?;
	let status = response.status();
	if !status.is_success() {
		return Err(format!("download failed: {status}"));
	}
	let total = response.content_length().unwrap_or(expected_size);
	let mut stream = response.bytes_stream();
	let mut received: u64 = 0;
	let mut file = tokio::fs::File::create(dest).await.map_err(|error| format!("cannot create {dest:?}: {error}"))?;
	while let Some(chunk) = stream.next().await {
		let chunk = chunk.map_err(|error| format!("download interrupted: {error}"))?;
		received += chunk.len() as u64;
		file.write_all(&chunk).await.map_err(|error| format!("cannot write {dest:?}: {error}"))?;
		emit_progress(app, "downloading", Some(received), Some(total));
	}
	file.flush().await.map_err(|error| format!("cannot flush {dest:?}: {error}"))?;
	Ok(())
}

/// Fetch the (small) `.sha256` checksum asset. The first trimmed line carries
/// the hex; a trailing `<file>` name after whitespace is allowed.
async fn fetch_checksum(url: &str, app: &AppHandle) -> Result<String, String> {
	let client = client_with_policy(app, Duration::from_secs(30));
	let response = client.get(url).send().await.map_err(|error| format!("checksum download failed: {error}"))?;
	let status = response.status();
	if !status.is_success() {
		return Err(format!("checksum download failed: {status}"));
	}
	let text = response.text().await.map_err(|error| format!("checksum payload: {error}"))?;
	Ok(text
		.lines()
		.next()
		.map(|line| line.split_whitespace().next().unwrap_or("").trim().to_string())
		.unwrap_or_default())
}

/// Render a SHA-256 digest as lowercase hex.
fn hex_encode(digest: &ring::digest::Digest) -> String {
	let mut s = String::with_capacity(digest.as_ref().len() * 2);
	for byte in digest.as_ref() {
		s.push_str(&format!("{byte:02x}"));
	}
	s
}

/// Case-insensitive comparison of an expected checksum against an actual hex
/// digest. Each side is reduced to its first whitespace-separated token, so
/// both plain `<hex>` and `shasum`-style `<hex>  <file>` lines are accepted.
fn checksum_hex_matches(expected: &str, actual: &str) -> bool {
	match (expected.split_whitespace().next(), actual.split_whitespace().next()) {
		(Some(e), Some(a)) => e.eq_ignore_ascii_case(a),
		_ => false,
	}
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
	let shown = state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).tray_hide_hint_shown;
	shown
}

/// Mark the tray-hide hint as shown and persist.
pub fn mark_tray_hide_hint(app: &AppHandle) {
	let state = app.state::<AppState>();
	let mut settings = state.settings.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
	if !settings.tray_hide_hint_shown {
		settings.tray_hide_hint_shown = true;
		let config = app.path().app_config_dir().unwrap_or_default();
		crate::settings::save(&config, &settings);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::io::Write;

	#[test]
	fn checksum_hex_matches_is_case_insensitive_and_tolerant() {
		// Plain lowercase hex.
		assert!(checksum_hex_matches("abc123", "abc123"));
		// Uppercase expected vs lowercase actual.
		assert!(checksum_hex_matches("ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef0123456789", "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789"));
		// Trailing filename / whitespace is tolerated (caller strips it, but
		// compare defensively anyway).
		assert!(checksum_hex_matches("  ab cd  file  ", "ab cd"));
		// Mismatch is false.
		assert!(!checksum_hex_matches("abc124", "abc123"));
	}

	#[test]
	fn checksum_verifies_a_temp_file_digest_and_rejects_a_tampered_one() {
		// Write a temp file and compute the true digest via ring — the same
		// path production uses.
		let mut path = std::env::temp_dir();
		path.push(format!("dsh-update-test-{}.bin", std::process::id()));
		let content = b"the update tarball bytes";
		{
			let mut f = std::fs::File::create(&path).unwrap();
			f.write_all(content).unwrap();
		}
		let digest = ring::digest::digest(&ring::digest::SHA256, content);
		let true_hex = hex_encode(&digest);
		assert_eq!(true_hex.len(), 64);

		// Expected digest in the `<hex>  <name>` style matches.
		let expected = format!("{true_hex}  dsh-desktop.tar.gz");
		assert!(checksum_hex_matches(&expected, &true_hex));

		// A tampered digest must NOT match: flip several nibbles to a different
		// (still valid) hex digit.
		let mut bad = true_hex.clone();
		let flips = [0usize, bad.len() - 1, bad.len() / 2, 37];
		for idx in flips {
			let digit = bad.as_bytes()[idx] as char;
			let flipped = if digit == 'f' { 'e' } else { 'f' };
			bad.replace_range(idx..idx + 1, &flipped.to_string());
		}
		assert!(!checksum_hex_matches(&bad, &true_hex), "tampered digest must mismatch");

		let _ = std::fs::remove_file(&path);
	}
}
