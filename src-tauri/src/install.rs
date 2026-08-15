//! Plugin installer mode: `dsh-desktop-shell install [--prefix DIR]`.
//!
//! The render client doubles as the dsh-desktop *plugin installer*. Running it
//! with the `install` argument (or with no arguments at all, which is how the
//! OS-installed app is launched) bootstraps the desktop profile into the
//! harness and puts the client + launcher on the user's PATH:
//!
//!   1. `$DSH_HOME/profiles/desktop` — manifest, user patch layer, workspace
//!      file, and the plugin bundle (this binary embeds a frozen copy of
//!      `bundle/`, so the installer is self-contained: one artifact installs
//!      everything, exactly like a real plugin installer);
//!   2. `$DSH_HOME/bin/dsh-desktop-shell[.exe]` + `dsh-desktop` launcher —
//!      the binary the profile's desktop-shell plugin resolves;
//!   3. a desktop (application-menu) entry — `.desktop` on Linux, a Start
//!      Menu shortcut on Windows (best-effort), nothing needed on macOS.
//!
//! Everything is idempotent and never touches the user's existing manifest or
//! patch layer. `DSH_DESKTOP_PREFIX` redirects the menu entry + binary copy
//! (used by OS packages); the profile itself always lives under `$DSH_HOME`.
//!
//! The embed also feeds the one-click updater: `update.rs` swaps the running
//! binary and refreshes the profile's bundle copy from the same layout.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// The plugin bundle, embedded at build time. `install` mode writes these out
/// into the profile so the harness serves exactly the code this binary ships
/// with; the updater refreshes the same files in place.
pub const BUNDLE_FILES: &[(&str, &str)] = &[
	("package.json", include_str!("../../bundle/package.json")),
	("cordis.patch.yml", include_str!("../../bundle/cordis.patch.yml")),
	("README.md", include_str!("../../bundle/README.md")),
	("lib/index.js", include_str!("../../bundle/lib/index.js")),
	("lib/client.js", include_str!("../../bundle/lib/client.js")),
	("lib/types/client/index.d.ts", include_str!("../../bundle/lib/types/client/index.d.ts")),
];

/// The menu/CLI launcher script (boots `dsh --profile desktop`).
const LAUNCHER_SH: &str = include_str!("../../dsh-desktop");
/// The Windows equivalent (the launcher script above is POSIX sh).
const LAUNCHER_CMD: &str = r#"@echo off
rem dsh-desktop launcher: boots the real profile (dsh --profile desktop),
rem whose desktop-shell plugin spawns the native render client.
setlocal
if defined DSH_DESKTOP_DSH (set "DSH=%DSH_DESKTOP_DSH%") else if defined DSH_BIN (set "DSH=%DSH_BIN%") else (set "DSH=dsh")
"%DSH%" --profile desktop %*
"#;

/// Icons embedded for the desktop entry (hicolor sizes).
const ICONS: &[(&str, &[u8])] = &[
	("32x32.png", include_bytes!("../icons/32x32.png")),
	("128x128.png", include_bytes!("../icons/128x128.png")),
	("256x256.png", include_bytes!("../icons/128x128@2x.png")),
	("512x512.png", include_bytes!("../icons/512x512.png")),
];

/// Resolve the Harness home exactly as the launcher does: `DSH_HOME`, else
/// `~/.dsh`.
pub fn dsh_home() -> PathBuf {
	match std::env::var_os("DSH_HOME") {
		Some(value) if !value.is_empty() => PathBuf::from(value),
		_ => std::env::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".dsh"),
	}
}

/// The desktop profile directory (`$DSH_HOME/profiles/desktop`).
pub fn profile_dir() -> PathBuf {
	dsh_home().join("profiles").join("desktop")
}

/// The bundle copy inside the profile.
pub fn profile_bundle_dir() -> PathBuf {
	profile_dir().join("packages").join("dsh-desktop-shell")
}

/// The `node_modules` link target of the profile.
pub fn node_modules_link() -> PathBuf {
	profile_dir().join("node_modules").join("dsh-desktop-shell")
}

/// Where the installer puts the client + launcher for the harness to resolve:
/// `$DSH_HOME/bin` (the bundle plugin's resolution chain includes it).
pub fn user_bin_dir() -> PathBuf {
	dsh_home().join("bin")
}

fn client_name() -> &'static str {
	#[cfg(target_os = "windows")]
	{
		"dsh-desktop-shell.exe"
	}
	#[cfg(not(target_os = "windows"))]
	{
		"dsh-desktop-shell"
	}
}

fn launcher_name() -> &'static str {
	#[cfg(target_os = "windows")]
	{
		"dsh-desktop.cmd"
	}
	#[cfg(not(target_os = "windows"))]
	{
		"dsh-desktop"
	}
}

/// Write the profile manifest + user layer (only when missing — the user's
/// own edits are never overwritten).
fn write_profile_manifest(profile: &Path) -> std::io::Result<()> {
	fs::create_dir_all(profile)?;
	if !profile.join("package.json").exists() {
		fs::write(
			profile.join("package.json"),
			r#"{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-desktop-shell": "file:./packages/dsh-desktop-shell"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-desktop-shell"
      ]
    }
  }
}
"#,
		)?;
	}
	if !profile.join("cordis.patch.yml").exists() {
		fs::write(
			profile.join("cordis.patch.yml"),
			"# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n[]\n",
		)?;
	}
	if !profile.join("pnpm-workspace.yaml").exists() {
		fs::write(
			profile.join("pnpm-workspace.yaml"),
			"packages:\n  - .\n  - packages/dsh-desktop-shell\n\nnodeLinker: hoisted\nautoInstallPeers: false\n",
		)?;
	}
	Ok(())
}

/// Refresh the bundle copy inside the profile + the node_modules link (this
/// is what keeps the plugin code in sync with the binary that ships it).
fn install_bundle(profile: &Path) -> std::io::Result<()> {
	install_bundle_from(profile, None)
}

/// Write the plugin bundle into the profile. `source` is an optional
/// directory to copy from (the updater hands over the freshly extracted
/// bundle of the new release); `None` writes the embedded copy.
fn install_bundle_from(profile: &Path, source: Option<&Path>) -> std::io::Result<()> {
	let bundle_dir = profile.join("packages").join("dsh-desktop-shell");
	if bundle_dir.exists() {
		fs::remove_dir_all(&bundle_dir)?;
	}
	match source {
		Some(dir) => copy_dir_all(dir, &bundle_dir)?,
		None => {
			for (relative, contents) in BUNDLE_FILES {
				let target = bundle_dir.join(relative);
				if let Some(parent) = target.parent() {
					fs::create_dir_all(parent)?;
				}
				fs::write(&target, contents)?;
			}
		}
	}
	// node_modules link: junction on Windows (symlinks need privileges), a
	// relative symlink on Unix, plain copy as the last resort.
	let node_modules = profile.join("node_modules");
	fs::create_dir_all(&node_modules)?;
	let link = node_modules.join("dsh-desktop-shell");
	let target = Path::new("..").join("packages").join("dsh-desktop-shell");
	let linked = link_plugin(&link, &target);
	if !linked {
		// Copy fallback: junction/symlink unavailable or refused.
		if link.exists() {
			let _ = fs::remove_dir_all(&link);
		}
		copy_dir_all(&bundle_dir, &link)?;
	}
	Ok(())
}

/// Replace the profile's bundle copy with the given extracted directory.
pub fn refresh_profile_bundle_from(source: &Path) -> Result<(), String> {
	let profile = profile_dir();
	install_bundle_from(&profile, Some(source)).map_err(|error| format!("cannot refresh bundle: {error}"))
}

/// Create the plugin link (`node_modules/dsh-desktop-shell`). Returns false
/// when linking is unavailable and a copy fallback is needed.
fn link_plugin(link: &Path, target: &Path) -> bool {
	#[cfg(target_os = "windows")]
	{
		if link.exists() {
			// Leave an existing junction alone if it already resolves.
			let _ = fs::remove_dir_all(link);
		}
		let status = std::process::Command::new("cmd")
			.args(["/C", "mklink", "/J"])
			.arg(link)
			.arg(target)
			.status();
		return matches!(status, Ok(status) if status.success());
	}
	#[cfg(not(target_os = "windows"))]
	{
		let _ = fs::remove_dir_all(link);
		std::os::unix::fs::symlink(target, link).is_ok()
	}
}

/// Recursive directory copy (used for the junction fallback).
fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
	fs::create_dir_all(dst)?;
	for entry in fs::read_dir(src)? {
		let entry = entry?;
		let target = dst.join(entry.file_name());
		if entry.file_type()?.is_dir() {
			copy_dir_all(&entry.path(), &target)?;
		} else {
			fs::copy(entry.path(), &target)?;
		}
	}
	Ok(())
}

/// Copy this binary to the given directory (self-install).
fn install_client_into(dir: &Path) -> std::io::Result<PathBuf> {
	fs::create_dir_all(dir)?;
	let current = std::env::current_exe()?;
	let target = dir.join(client_name());
	fs::copy(&current, &target)?;
	#[cfg(not(target_os = "windows"))]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
	}
	Ok(target)
}

/// Write the `dsh-desktop` launcher into the given directory.
fn install_launcher_into(dir: &Path) -> std::io::Result<PathBuf> {
	fs::create_dir_all(dir)?;
	let target = dir.join(launcher_name());
	let contents = if cfg!(target_os = "windows") { LAUNCHER_CMD } else { LAUNCHER_SH };
	fs::write(&target, contents)?;
	#[cfg(not(target_os = "windows"))]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
	}
	Ok(target)
}

/// Install the hicolor icons (Linux application menu).
fn install_icons(prefix: &Path) -> std::io::Result<()> {
	let hicolor = prefix.join("share").join("icons").join("hicolor");
	for (name, bytes) in ICONS {
		let size = name.split('x').next().unwrap_or("128");
		let dir = hicolor.join(size).join("x").join(size).join("apps");
		fs::create_dir_all(&dir)?;
		fs::write(dir.join("deepseek-harness.png"), bytes)?;
	}
	Ok(())
}

/// Register a desktop entry pointing at the launcher (Linux only).
fn install_desktop_entry(bin_dir: &Path, prefix: &Path) -> std::io::Result<()> {
	if !cfg!(target_os = "linux") {
		return Ok(());
	}
	let launcher = bin_dir.join("dsh-desktop");
	let applications = prefix.join("share").join("applications");
	fs::create_dir_all(&applications)?;
	let desktop = format!(
		"[Desktop Entry]\n\
		 Type=Application\n\
		 Name=DeepSeek Harness\n\
		 GenericName=AI Coding Assistant\n\
		 Comment=Desktop profile for the DeepSeek Harness (native window over the web surface)\n\
		 Exec={}\n\
		 Icon=deepseek-harness\n\
		 Terminal=false\n\
		 Categories=Development;Utility;\n\
		 StartupWMClass=dsh-desktop\n",
		launcher.display()
	);
	fs::write(applications.join("dsh-desktop.desktop"), desktop)
}

/// Best-effort Start Menu shortcut (Windows). `$APPDATA` is the user profile
/// location; the launcher .cmd is what we pin.
fn install_start_menu_shortcut(launcher: &Path) {
	if !cfg!(target_os = "windows") {
		return;
	}
	let Some(appdata) = std::env::var_os("APPDATA") else { return };
	let menu = PathBuf::from(appdata)
		.join("Microsoft")
		.join("Windows")
		.join("Start Menu")
		.join("Programs");
	let _ = fs::create_dir_all(&menu);
	let lnk = menu.join("DeepSeek Harness.lnk");
	let script = format!(
		r#"
$ws = New-Object -ComObject WScript.Shell
$s = $ws.CreateShortcut('{lnk}')
$s.TargetPath = '{launcher}'
$s.Description = 'DeepSeek Harness desktop profile'
$s.Save()
"#,
		lnk = lnk.display().to_string().replace('\'', "''"),
		launcher = launcher.display().to_string().replace('\'', "''"),
	);
	let _ = std::process::Command::new("powershell")
		.args(["-NoProfile", "-NonInteractive", "-Command", &script])
		.status();
}

/// Bootstrap the desktop profile into the harness + install client/launcher/
/// menu entry. Returns a human-readable summary of what was installed.
pub fn install(prefix: Option<&str>) -> Result<String, String> {
	let profile = profile_dir();
	write_profile_manifest(&profile).map_err(|error| format!("cannot create profile: {error}"))?;
	install_bundle(&profile).map_err(|error| format!("cannot install bundle: {error}"))?;

	let bin_dir = user_bin_dir();
	let client = install_client_into(&bin_dir).map_err(|error| format!("cannot install client: {error}"))?;
	let launcher = install_launcher_into(&bin_dir).map_err(|error| format!("cannot install launcher: {error}"))?;

	// Optional system prefix (OS packages): also place the binaries + menu
	// entry under $DSH_DESKTOP_PREFIX so the package's own paths are used.
	let mut menu_root = bin_dir.clone();
	let mut wrote_menu = false;
	if let Some(prefix) = prefix {
		let system_bin = PathBuf::from(prefix).join("bin");
		install_client_into(&system_bin).ok();
		install_launcher_into(&system_bin).ok();
		menu_root = system_bin;
	}
	if cfg!(target_os = "linux") {
		let prefix_path = match prefix {
			Some(prefix) => PathBuf::from(prefix),
			None => std::env::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".local"),
		};
		if let Err(error) = install_icons(&prefix_path) {
			eprintln!("dsh-desktop: icon install skipped: {error}");
		}
		if install_desktop_entry(&menu_root, &prefix_path).is_ok() {
			wrote_menu = true;
		}
	}
	#[cfg(target_os = "windows")]
	install_start_menu_shortcut(&launcher);

	let mut summary = format!(
		"desktop profile ready at {}\nInstalled client:   {}\nInstalled launcher: {}",
		profile.display(),
		client.display(),
		launcher.display()
	);
	if wrote_menu {
		summary.push_str("\nDesktop entry registered.");
	}
	Ok(summary)
}

/// The `install` subcommand entry point (arg parsing lives in lib.rs).
pub fn run(prefix: Option<&str>) -> i32 {
	match install(prefix) {
		Ok(summary) => {
			println!("{summary}");
			println!("\nLaunch it from your application menu, or run: dsh --profile desktop");
			0
		}
		Err(error) => {
			eprintln!("dsh-desktop: install failed: {error}");
			1
		}
	}
}

/// Clean up a leftover `.old` copy of the binary next to the current
/// executable (the updater renames before replacing; a crash between the two
/// steps leaves it behind). Best-effort, called at startup.
pub fn cleanup_stale_old() {
	let Ok(current) = std::env::current_exe() else { return };
	let old = current.with_extension(
		current
			.extension()
			.map(|ext| format!("{}.old", ext.to_string_lossy()))
			.unwrap_or_else(|| "old".into()),
	);
	let _ = fs::remove_file(old);
}



/// Convenience for writing a small text file (used by the updater).
pub fn write_file(path: &Path, contents: &str) -> std::io::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	let mut file = fs::File::create(path)?;
	file.write_all(contents.as_bytes())?;
	Ok(())
}
