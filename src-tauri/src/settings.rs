//! dsh-desktop settings + state: what the desktop shell persists and reports.
//!
//! Everything here is native-client state. The web surface's "dsh-desktop"
//! settings tab reads and writes it through the `desktop_*` commands; the tray
//! reads it to render its menu. Settings are persisted as JSON in the app
//! config directory (`dsh-desktop.json`); the update hint is kept alongside
//! so the tray can restate it after a restart.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

/// User-facing desktop preferences.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct DesktopSettings {
	/// Close-to-tray: closing the window hides it instead of exiting.
	pub tray: bool,
	/// Native OS notifications (update available, first hide hint, tests).
	pub notifications: bool,
	/// Periodically check GitHub releases for a newer version.
	pub auto_update_check: bool,
	/// How often to re-check, in hours (only when auto_update_check is on).
	pub update_interval_hours: u64,
	/// Whether the "still running in the tray" hint was already shown once.
	pub tray_hide_hint_shown: bool,
}

impl Default for DesktopSettings {
	fn default() -> Self {
		Self {
			tray: true,
			notifications: true,
			auto_update_check: true,
			update_interval_hours: 6,
			tray_hide_hint_shown: false,
		}
	}
}

/// A newer release found on GitHub. Stored as plain data so the tray menu and
/// the settings tab can both restate it.
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct UpdateInfo {
	/// The release tag, e.g. `v0.2.0`.
	pub version: String,
	/// The release page URL (the "suggest update" target).
	pub url: String,
	/// Optional publish timestamp (RFC 3339).
	pub published_at: Option<String>,
}

/// Full snapshot the settings tab renders.
#[derive(Serialize, Clone, Debug)]
pub struct DesktopState {
	/// The running client version (crate version).
	pub version: String,
	pub settings: DesktopSettings,
	/// `Some` when a newer release is available.
	pub update: Option<UpdateInfo>,
	/// RFC 3339 of the last completed check (or None before the first one).
	pub last_update_check: Option<String>,
	/// Last check error message (None when the last check succeeded).
	pub update_check_error: Option<String>,
	/// Always true here — this state only exists inside the native client.
	pub client: bool,
}

/// Load persisted settings from `<config>/dsh-desktop.json` (defaults on any
/// read/parse failure — settings are disposable).
pub fn load(config_dir: &PathBuf) -> DesktopSettings {
	let path = config_dir.join("dsh-desktop.json");
	match fs::read_to_string(&path) {
		Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
		Err(_) => DesktopSettings::default(),
	}
}

/// Persist settings, creating the config directory when needed. Failures are
/// logged and swallowed — settings are best-effort state.
pub fn save(config_dir: &PathBuf, settings: &DesktopSettings) {
	let path = config_dir.join("dsh-desktop.json");
	if let Err(error) = fs::create_dir_all(config_dir) {
		eprintln!("dsh-desktop: cannot create config dir: {error}");
		return;
	}
	match serde_json::to_string_pretty(settings) {
		Ok(raw) => {
			if let Err(error) = fs::write(&path, raw) {
				eprintln!("dsh-desktop: cannot persist settings: {error}");
			}
		}
		Err(error) => eprintln!("dsh-desktop: cannot serialize settings: {error}"),
	}
}

/// Current time as RFC 3339 (UTC) for `last_update_check`, without pulling a
/// date crate in: civil-from-days, then h:m:s from the day fraction.
pub fn now_rfc3339() -> String {
	let secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_secs())
		.unwrap_or(0);
	let days = secs / 86_400;
	let day_secs = secs % 86_400;
	// Howard Hinnant's civil_from_days.
	let z = days as i64 + 719_468;
	let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
	let doe = z - era * 146_097;
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if m <= 2 { y + 1 } else { y };
	let (h, mi, s) = (day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60);
	format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}
