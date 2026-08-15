//! File manager + preview commands behind the explorer panel.
//!
//! The explorer is deliberately native-backed: the shell lists and reads
//! files on the real filesystem (the harness's web surface is a sandboxed
//! server, and the browser alone cannot browse the user's disk). The browser
//! half (client.js) keeps the current directory as an opaque native path and
//! asks the shell for parent/child navigation, so path separators never leak
//! into JS.

use serde::Serialize;

/// One directory entry, pre-joined to an absolute path by the native side.
#[derive(Serialize, Debug)]
pub struct FileEntry {
	pub name: String,
	pub path: String,
	pub is_dir: bool,
	/// Byte size; `None` for directories.
	pub size: Option<u64>,
	/// Last modification, ms since epoch.
	pub modified_ms: Option<u64>,
}

/// List a directory: directories first, then files, each case-insensitively
/// sorted by name. Unreadable entries are skipped, never fatal.
#[tauri::command]
pub fn desktop_list_dir(path: String) -> Result<Vec<FileEntry>, String> {
	let dir = std::path::PathBuf::from(&path);
	let mut entries = Vec::new();
	let read = std::fs::read_dir(&dir).map_err(|error| format!("cannot list {path}: {error}"))?;
	for entry in read.flatten() {
		let Ok(meta) = entry.metadata() else { continue };
		let name = entry.file_name().to_string_lossy().into_owned();
		let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64);
		entries.push(FileEntry {
			path: entry.path().to_string_lossy().into_owned(),
			is_dir: meta.is_dir(),
			size: if meta.is_dir() { None } else { Some(meta.len()) },
			modified_ms: modified,
			name,
		});
	}
	entries.sort_by(|a, b| {
		b.is_dir
			.cmp(&a.is_dir)
			.then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
	});
	Ok(entries)
}

/// The parent directory of a path, or `None` at the filesystem root.
#[tauri::command]
pub fn desktop_parent_dir(path: String) -> Result<Option<String>, String> {
	let dir = std::path::PathBuf::from(&path);
	let parent = dir.parent().filter(|p| !p.as_os_str().is_empty());
	Ok(parent.map(|p| p.to_string_lossy().into_owned()))
}

/// The user's home directory (the explorer's fallback root when no workspace
/// is attached).
#[tauri::command]
pub fn desktop_home_dir() -> Result<String, String> {
	std::env::home_dir()
		.map(|p| p.to_string_lossy().into_owned())
		.ok_or_else(|| "cannot resolve the home directory".into())
}

/// Preview contents of one file.
#[derive(Serialize, Debug)]
pub struct FileContent {
	pub path: String,
	pub name: String,
	pub size: u64,
	/// `text/plain`-ish MIME for images, else `application/octet-stream`.
	pub mime: String,
	/// `utf8` (text), `base64` (image), or `binary` (everything else).
	pub encoding: String,
	/// The payload: decoded text (utf8) or base64 (image). Empty for binary.
	pub content: String,
	/// Text was cut at the preview cap.
	pub truncated: bool,
}

/// Read cap for text previews (chars) and images (bytes → base64).
const TEXT_CAP: usize = 1 << 20; // 1 MiB of text is plenty for a preview
const IMAGE_CAP: u64 = 8 << 20; // 8 MiB images as base64

fn is_image(name: &str) -> Option<&'static str> {
	let lower = name.to_ascii_lowercase();
	let mime = match lower.rsplit('.').next() {
		Some("png") => "image/png",
		Some("jpg") | Some("jpeg") => "image/jpeg",
		Some("gif") => "image/gif",
		Some("webp") => "image/webp",
		Some("bmp") => "image/bmp",
		Some("svg") => "image/svg+xml",
		Some("ico") => "image/x-icon",
		Some("avif") => "image/avif",
		_ => return None,
	};
	Some(mime)
}

/// Read a file for preview: images come back as base64 (rendered in an
/// `<img>`), text as decoded UTF-8 (cut at the cap), anything else is
/// reported as binary so the UI can say "this file has no preview".
#[tauri::command]
pub fn desktop_read_file(path: String) -> Result<FileContent, String> {
	let file = std::path::PathBuf::from(&path);
	let meta = std::fs::metadata(&file).map_err(|error| format!("cannot stat {path}: {error}"))?;
	let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
	let size = meta.len();
	let data = std::fs::read(&file).map_err(|error| format!("cannot read {path}: {error}"))?;

	if let Some(mime) = is_image(&name) {
		if size > IMAGE_CAP {
			return Ok(FileContent {
				path,
				name,
				size,
				mime: mime.to_string(),
				encoding: "binary".into(),
				content: String::new(),
				truncated: true,
			});
		}
		let content = base64_encode(&data);
		return Ok(FileContent { path, name, size, mime: mime.to_string(), encoding: "base64".into(), content, truncated: false });
	}

	// Binary sniff: NUL in the first 8 KiB means "no text preview".
	if data.iter().take(8192).any(|&b| b == 0) {
		return Ok(FileContent {
			path,
			name,
			size,
			mime: "application/octet-stream".into(),
			encoding: "binary".into(),
			content: String::new(),
			truncated: false,
		});
	}

	let text = String::from_utf8_lossy(&data);
	let truncated = text.len() > TEXT_CAP;
	let content = if truncated { text.chars().take(TEXT_CAP).collect::<String>() } else { text.into_owned() };
	Ok(FileContent {
		path,
		name,
		size,
		mime: "text/plain".into(),
		encoding: "utf8".into(),
		content,
		truncated,
	})
}

// Base64 without pulling the base64 crate: encode in 3-byte blocks. Simple,
// correct, and fast enough for an 8 MiB cap.
fn base64_encode(data: &[u8]) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
	for chunk in data.chunks(3) {
		let b0 = chunk[0] as u32;
		let b1 = *chunk.get(1).unwrap_or(&0) as u32;
		let b2 = *chunk.get(2).unwrap_or(&0) as u32;
		let n = (b0 << 16) | (b1 << 8) | b2;
		out.push(TABLE[(n >> 18) as usize & 63] as char);
		out.push(TABLE[(n >> 12) as usize & 63] as char);
		if chunk.len() > 1 {
			out.push(TABLE[(n >> 6) as usize & 63] as char);
		} else {
			out.push('=');
		}
		if chunk.len() > 2 {
			out.push(TABLE[n as usize & 63] as char);
		} else {
			out.push('=');
		}
	}
	out
}
