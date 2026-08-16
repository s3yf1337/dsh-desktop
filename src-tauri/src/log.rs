//! Minimal file logger: mirror every line to stderr (the harness terminal) and
//! append a timestamped copy to `<config>/dsh-desktop.log`. The file is capped
//! at a few MB — logging is best-effort and never fails the app.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

use tauri::{AppHandle, Manager};

use crate::AppState;

/// Rotate once the log passes this size (start fresh, keep the tail useful).
const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Append one line to the log file (creating the config dir as needed).
fn append(config_dir: &str, text: &str) {
	let path = Path::new(config_dir).join("dsh-desktop.log");
	if let Some(parent) = path.parent() {
		let _ = std::fs::create_dir_all(parent);
	}
	if std::fs::metadata(&path).map(|meta| meta.len() > MAX_BYTES).unwrap_or(false) {
		let _ = std::fs::remove_file(&path);
	}
	if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(&path) {
		let _ = file.write_all((text.to_owned() + "\n").as_bytes());
	}
}

/// Write a leveled line: stderr for the terminal, appended copy for the file.
fn write(app: &AppHandle, level: &str, message: &str) {
	let stamp = crate::settings::now_rfc3339();
	let text = format!("{stamp} [{level}] {message}");
	eprintln!("dsh-desktop: {text}");
	let config_dir = app.state::<AppState>().config_dir.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
	append(&config_dir, &text);
}

pub fn info(app: &AppHandle, message: &str) {
	write(app, "INFO", message);
}

pub fn warn(app: &AppHandle, message: &str) {
	write(app, "WARN", message);
}

pub fn error(app: &AppHandle, message: &str) {
	write(app, "ERROR", message);
}
