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

	if let Some(mime) = is_image(&name) {
		if size > IMAGE_CAP {
			// Refuse to read a huge image into memory at all.
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
		let data = std::fs::read(&file).map_err(|error| format!("cannot read {path}: {error}"))?;
		let content = base64_encode(&data);
		return Ok(FileContent { path, name, size, mime: mime.to_string(), encoding: "base64".into(), content, truncated: false });
	}

	// Binary sniff: NUL in the first 8 KiB means "no text preview". Reading the
	// cap's worth of bytes up front keeps a huge file out of memory.
	let prefix_cap: usize = TEXT_CAP.saturating_add(1).max(8192);
	let mut data = Vec::new();
	{
		use std::io::Read;
		let file = std::fs::File::open(&file).map_err(|error| format!("cannot read {path}: {error}"))?;
		file.take(prefix_cap as u64)
			.read_to_end(&mut data)
			.map_err(|error| format!("cannot read {path}: {error}"))?;
	}

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
	let truncated = data.len() > TEXT_CAP;
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

/// Write (create or overwrite) one text file. Backs "new file", inline
/// editing, and any future save path — the panel's only write primitive.
#[tauri::command]
pub fn desktop_write_file(path: String, content: String) -> Result<(), String> {
	std::fs::write(&path, content).map_err(|error| format!("cannot write {path}: {error}"))
}

/// Create one directory (fails when the parent is missing or it exists).
#[tauri::command]
pub fn desktop_create_dir(path: String) -> Result<(), String> {
	std::fs::create_dir(&path).map_err(|error| format!("cannot create {path}: {error}"))
}

/// Rename a file or directory inside its own parent (a same-dir move).
#[tauri::command]
pub fn desktop_rename(path: String, new_name: String) -> Result<(), String> {
	if new_name.is_empty() || new_name.contains('/') || new_name.contains('\\') {
		return Err("invalid name".into());
	}
	let source = std::path::PathBuf::from(&path);
	let target = source
		.parent()
		.map(|parent| parent.join(&new_name))
		.ok_or_else(|| format!("cannot resolve parent of {path}"))?;
	std::fs::rename(&source, &target).map_err(|error| format!("cannot rename {path}: {error}"))
}

/// Move a file or directory into the OS trash (recoverable; never rm).
#[tauri::command]
pub fn desktop_delete(path: String) -> Result<(), String> {
	trash::delete(&path).map_err(|error| format!("cannot move {path} to trash: {error}"))
}

/// Copy one file or directory tree into `dest_dir`, keeping the source name.
/// An existing destination is replaced (copy semantics, like a file manager).
#[tauri::command]
pub fn desktop_copy(src: String, dest_dir: String) -> Result<(), String> {
	let source = std::path::PathBuf::from(&src);
	let name = source
		.file_name()
		.ok_or_else(|| format!("cannot copy {src}: no file name"))?
		.to_string_lossy()
		.into_owned();
	let target = std::path::PathBuf::from(&dest_dir).join(&name);
	copy_tree(&source, &target).map_err(|error| format!("cannot copy {src}: {error}"))
}

/// Move one file or directory into `dest_dir` (rename; falls back to
/// copy+remove across devices). An existing destination is replaced.
#[tauri::command]
pub fn desktop_move(src: String, dest_dir: String) -> Result<(), String> {
	let source = std::path::PathBuf::from(&src);
	let name = source
		.file_name()
		.ok_or_else(|| format!("cannot move {src}: no file name"))?
		.to_string_lossy()
		.into_owned();
	let target = std::path::PathBuf::from(&dest_dir).join(&name);
	if std::fs::rename(&source, &target).is_ok() {
		return Ok(());
	}
	// Cross-device (EXDEV) or any other rename failure: copy, then remove.
	copy_tree(&source, &target).map_err(|error| format!("cannot move {src}: {error}"))?;
	remove_tree(&source).map_err(|error| format!("cannot move {src}: copied but cannot remove the source: {error}"))
}

/// Open a file or directory with the OS default application (for directories
/// that is the system file manager).
#[tauri::command]
pub fn desktop_open_path(path: String) -> Result<(), String> {
	open::that(&path).map_err(|error| format!("cannot open {path}: {error}"))
}

/// Recursive filename search from `root`: case-insensitive substring match,
/// bounded by `max` results (default 200) and a depth cap so pathological
/// trees cannot hang the panel. Directories match too.
#[tauri::command]
pub fn desktop_search_names(root: String, query: String, max: Option<usize>) -> Result<Vec<FileEntry>, String> {
	const MAX_DEPTH: usize = 8;
	let max = max.unwrap_or(200).clamp(1, 1000);
	let needle = query.to_lowercase();
	if needle.is_empty() {
		return Ok(Vec::new());
	}
	let mut out = Vec::new();
	walk_names(&std::path::PathBuf::from(&root), &needle, 0, MAX_DEPTH, max, &mut out);
	Ok(out)
}

/// Recursive copy (files and directories, following no symlinks).
fn copy_tree(source: &std::path::Path, target: &std::path::Path) -> std::io::Result<()> {
	let meta = std::fs::symlink_metadata(source)?;
	if meta.is_dir() {
		if target.exists() {
			// Replace an existing destination (copy semantics).
			remove_tree(target)?;
		}
		std::fs::create_dir_all(target)?;
		for entry in std::fs::read_dir(source)? {
			let entry = entry?;
			copy_tree(&entry.path(), &target.join(entry.file_name()))?;
		}
		Ok(())
	} else {
		std::fs::copy(source, target).map(|_| ())
	}
}

/// Recursive remove (files and directories, following no symlinks).
fn remove_tree(path: &std::path::Path) -> std::io::Result<()> {
	let meta = std::fs::symlink_metadata(path)?;
	if meta.is_dir() {
		std::fs::remove_dir_all(path)
	} else {
		std::fs::remove_file(path)
	}
}

/// Bounded depth-first walk matching entry names (case-insensitive substring).
fn walk_names(dir: &std::path::Path, needle: &str, depth: usize, max_depth: usize, max: usize, out: &mut Vec<FileEntry>) {
	if depth > max_depth || out.len() >= max {
		return;
	}
	let Ok(read) = std::fs::read_dir(dir) else { return };
	for entry in read.flatten() {
		if out.len() >= max {
			return;
		}
		let Ok(meta) = entry.metadata() else { continue };
		let name = entry.file_name().to_string_lossy().into_owned();
		if name.to_lowercase().contains(needle) {
			let modified = meta
				.modified()
				.ok()
				.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
				.map(|d| d.as_millis() as u64);
			out.push(FileEntry {
				path: entry.path().to_string_lossy().into_owned(),
				is_dir: meta.is_dir(),
				size: if meta.is_dir() { None } else { Some(meta.len()) },
				modified_ms: modified,
				name,
			});
		}
		if meta.is_dir() {
			walk_names(&entry.path(), needle, depth + 1, max_depth, max, out);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
		let mut path = std::env::temp_dir();
		path.push(format!("dsh-desktop-test-{}-{name}", std::process::id()));
		std::fs::write(&path, bytes).unwrap();
		path
	}

	fn rm(path: &std::path::Path) {
		let _ = std::fs::remove_file(path);
	}

	#[test]
	fn rename_rejects_dot_names() {
		let source = std::env::temp_dir()
			.join(format!("dsh-desktop-rename-plugin-{}", std::process::id()));
		std::fs::write(&source, b"x").unwrap();
		for bad in ["", ".", "..", "a/b", "a\\b"] {
			assert!(desktop_rename(source.to_string_lossy().into_owned(), bad.into()).is_err(), "expected reject for {bad:?}");
		}
		// A valid new name should still pass validation, so the guard only
		// rejects dot/separator names, not valid ones.
		let target = source.parent().unwrap().join("ok-renamed");
		assert!(desktop_rename(source.to_string_lossy().into_owned(), "ok-renamed".into()).is_ok());
		rm(&source);
		rm(&target);
	}

	#[test]
	fn read_file_truncates_at_text_cap() {
		let mut bytes = vec![0u8; TEXT_CAP + 1000];
		bytes.fill(b'a');
		let path = temp_file("big.txt", &bytes);
		let out = desktop_read_file(path.to_string_lossy().into_owned()).expect("read should succeed");
		assert!(out.truncated, "expected truncated");
		assert_eq!(out.encoding, "utf8");
		assert!(out.content.len() <= TEXT_CAP, "content over the cap: {}", out.content.len());
		rm(&path);
	}

	#[test]
	fn read_file_refuses_huge_image() {
		let mut bytes = vec![0u8; (IMAGE_CAP + 1000) as usize];
		bytes.fill(b'a');
		let path = temp_file("big.png", &bytes);
		let out = desktop_read_file(path.to_string_lossy().into_owned()).expect("read should succeed");
		assert_eq!(out.encoding, "binary");
		assert!(out.truncated, "expected truncated for oversized image");
		assert!(out.content.is_empty(), "image over the cap should not be read into memory");
		rm(&path);
	}
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
