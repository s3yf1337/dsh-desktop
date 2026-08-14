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
			]),
		),
	)
	.expect("failed to run tauri-build");
}
