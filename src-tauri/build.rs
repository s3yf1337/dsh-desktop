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
}
