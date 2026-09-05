fn main() {
	// The desktop commands must be declared so tauri generates the matching
	// ACL permissions (`app:allow-desktop-*`); without them the IPC layer
	// rejects the calls from the remote harness origin.
	tauri_build::try_build(
		tauri_build::Attributes::new().app_manifest(
			tauri_build::AppManifest::new().commands(&[
				"desktop_get_state",
				"desktop_set_setting",
				"desktop_check_updates",
				"desktop_open_release",
				"desktop_reset_geometry",
				"desktop_test_notification",
				"desktop_is_directory",
				"desktop_set_title",
				"desktop_stat",
				"desktop_hexdump",
				"desktop_list_dir",
				"desktop_parent_dir",
				"desktop_read_file",
				"desktop_home_dir",
				"desktop_write_file",
				"desktop_create_dir",
				"desktop_rename",
				"desktop_delete",
				"desktop_copy",
				"desktop_move",
				"desktop_open_path",
				"desktop_search_names",
				"desktop_update_now",
				"desktop_install_info",
				"desktop_clipboard_image",
			]),
		),
	)
	.expect("failed to run tauri-build");

	// tauri.conf.json ships `devtools: false` (release builds must not expose
	// the inspector). Debug builds re-enable it by merging an override through
	// TAURI_CONFIG (emitted for the crate compile, where the codegen runs).
	// A caller-supplied TAURI_CONFIG always wins.
	if std::env::var("PROFILE").as_deref() == Ok("debug") && std::env::var_os("TAURI_CONFIG").is_none() {
		println!(
			"cargo:rustc-env=TAURI_CONFIG={}",
			r#"{"app":{"windows":[{"label":"main","devtools":true}]}}"#
		);
	}

	// Expose the full desktop version, including trailing letter patches
	// (e.g. `0.2.3a`), as `DSH_DESKTOP_VERSION`. Cargo's own
	// `CARGO_PKG_VERSION` must stay strict semver (`0.2.3`) — it cannot encode
	// `0.2.3a` — so the CI build for a `v0.2.3a` tag injects the real version
	// here. Local builds can also `DSH_DESKTOP_VERSION=0.2.3a cargo build`.
	//
	// The updater's `current_version()` prefers this value and falls back to
	// `CARGO_PKG_VERSION` otherwise, so the "already on latest" check works
	// for letter patches.
	println!("cargo:rerun-if-env-changed=DSH_DESKTOP_VERSION");
	println!("cargo:rerun-if-env-changed=GITHUB_REF_NAME");
	println!("cargo:rerun-if-env-changed=GITHUB_REF");
	if let Some(version) = resolve_desktop_version() {
		println!("cargo:rustc-env=DSH_DESKTOP_VERSION={version}");
	}
}

fn resolve_desktop_version() -> Option<String> {
	// Explicit override wins — local testing of a letter patch without tagging.
	if let Ok(explicit) = std::env::var("DSH_DESKTOP_VERSION") {
		let v = explicit.trim().trim_start_matches('v').to_string();
		if !v.is_empty() {
			return Some(v);
		}
	}
	// CI tag build: GITHUB_REF_NAME is `v0.2.3` or `v0.2.3a`.
	for key in ["GITHUB_REF_NAME", "GITHUB_REF"] {
		if let Ok(tag) = std::env::var(key) {
			let tag = tag.trim().to_string();
			let tag = tag.rsplit('/').next().unwrap_or(&tag).trim();
			let without_v = tag.strip_prefix('v').unwrap_or(tag);
			// Only forward tags that look like versions (digits.digits.digits
			// optionally followed by letters) so random branches don't become
			// the version string.
			if is_version_like(without_v) {
				return Some(without_v.to_string());
			}
		}
	}
	None
}

fn is_version_like(input: &str) -> bool {
	// Accept `0.2.3`, `0.2.3a`, `0.2.3-a` (strip hyphen for the letter test)
	// and `0.2.3-alpha`, `0.2.3+…`; anything more exotic is not a release tag.
	let input = input.split('+').next().unwrap_or(input);
	let (core, pre) = match input.split_once('-') {
		Some((c, p)) => (c, Some(p)),
		None => (input, None),
	};
	let mut parts = core.split('.');
	let major = parts.next().and_then(|s| s.parse::<u64>().ok());
	let minor = parts.next().and_then(|s| s.parse::<u64>().ok());
	let tail = parts.next();
	if major.is_none() || minor.is_none() || tail.is_none() || parts.next().is_some() {
		return false;
	}
	let tail = tail.unwrap();
	if tail.is_empty() {
		return false;
	}
	// Tail is either pure digits (`3`) or digits + letters (`3a`, `3ab`).
	let digit_len = tail.bytes().take_while(|b| b.is_ascii_digit()).count();
	if digit_len == 0 {
		return false;
	}
	let rest = &tail[digit_len..];
	// Pure digits with maybe a prerelease/build is fine.
	if rest.is_empty() {
		return true;
	}
	// Letters immediately after digits is the hotfix form.
	if rest.chars().all(|ch| ch.is_ascii_alphabetic()) {
		return true;
	}
	// Otherwise it has a prerelease suffix, which is still version-like.
	if pre.is_some() {
		return true;
	}
	false
}
