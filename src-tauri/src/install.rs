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

/// Return `path` with `suffix` appended to its file name (e.g. `foo` + `.tmp`
/// → `foo.tmp`, `foo/bar` + `.bak` → `foo/bar.bak`).
fn suffix_path(path: &Path, suffix: &str) -> PathBuf {
	let mut os = path.as_os_str().to_os_string();
	os.push(suffix);
	PathBuf::from(os)
}

/// Read the `version` field from a bundle's `package.json`. Returns `None` when
/// the file is missing or unparseable (a version guard must not break installs/
/// updates, so callers fall back to "always replace" in that case).
fn bundle_version(dir: &Path) -> Option<semver::Version> {
	let pkg = dir.join("package.json");
	let text = fs::read_to_string(pkg).ok()?;
	let value: serde_json::Value = serde_json::from_str(&text).ok()?;
	let version = value.get("version")?.as_str()?;
	semver::Version::parse(version).ok()
}

/// Write the plugin bundle into the profile atomically: the new contents are
/// staged in a sibling `*.tmp` directory and swapped in with `rename`, keeping
/// the previous bundle intact until the replacement succeeds. `source` is an
/// optional directory to copy from (the updater hands over the freshly
/// extracted bundle of the new release); `None` writes the embedded copy.
///
/// Since Windows cannot `rename` over an existing directory, the swap routes
/// through `.bak`: `bundle → .bak`, `.tmp → bundle`, then the `.bak` is
/// removed. Any failure rolls back by restoring `.bak` when the primary is
/// missing. So the installer (embedded copy) and the updater
/// (`refresh_profile_bundle_from`) both get the same all-or-nothing behaviour.
fn install_bundle_from(profile: &Path, source: Option<&Path>) -> std::io::Result<()> {
	let bundle_dir = profile.join("packages").join("dsh-desktop-shell");
	let tmp_dir = suffix_path(&bundle_dir, ".tmp");
	let bak_dir = suffix_path(&bundle_dir, ".bak");

	// Version guard: never downgrade an installed bundle. Parse failures mean
	// "replace as usual" — this must never break a legit update.
	if bundle_dir.exists() {
		if let (Some(new_version), Some(installed)) = (version_of(source), bundle_version(&bundle_dir)) {
			if new_version < installed {
				// Skip the rewrite entirely; report success so the caller's
				// upgrade flow keeps working.
				eprintln!(
					"dsh-desktop: bundle {new_version} is older than installed {installed}; keeping installed bundle"
				);
				return Ok(());
			}
		}
	}

	// Stage the new contents into a fresh `.tmp` sibling.
	if tmp_dir.exists() {
		fs::remove_dir_all(&tmp_dir)?;
	}
	fs::create_dir_all(&tmp_dir)?;
	let staged = match source {
		Some(dir) => copy_dir_all(dir, &tmp_dir),
		None => {
			for (relative, contents) in BUNDLE_FILES {
				let target = tmp_dir.join(relative);
				if let Some(parent) = target.parent() {
					fs::create_dir_all(parent)?;
				}
				fs::write(&target, contents)?;
			}
			Ok(())
		}
	};
	if let Err(error) = staged {
		let _ = fs::remove_dir_all(&tmp_dir);
		return Err(error);
	}

	match swap_bundle_dir(&bundle_dir, &tmp_dir, &bak_dir) {
		Ok(()) => (),
		Err(error) => {
			let _ = fs::remove_dir_all(&tmp_dir);
			return Err(error);
		}
	}

	// node_modules link: junction on Windows (symlinks need privileges), a
	// relative symlink on Unix, plain copy as the last resort. Runs after the
	// swap; the link points into the (now-new) bundle dir.
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

/// The new bundle's version for the guard: from the source directory if one is
/// given (the updater's extracted release), else from the embedded copy.
fn version_of(source: Option<&Path>) -> Option<semver::Version> {
	match source {
		Some(dir) => bundle_version(dir),
		None => bundle_version_from_embedded(),
	}
}

/// Parse the `version` field of the embedded `package.json` (`BUNDLE_FILES`).
fn bundle_version_from_embedded() -> Option<semver::Version> {
	let pkg = BUNDLE_FILES
		.iter()
		.find(|(relative, _)| *relative == "package.json")?
		.1;
	let value: serde_json::Value = serde_json::from_str(pkg).ok()?;
	let version = value.get("version")?.as_str()?;
	semver::Version::parse(version).ok()
}

/// Atomically replace `bundle_dir` with the staged `tmp_dir`, routing through
/// `bak_dir` so the operation works on Windows. On any failure the previous
/// bundle is restored (when present) before propagating the error.
fn swap_bundle_dir(bundle_dir: &Path, tmp_dir: &Path, bak_dir: &Path) -> std::io::Result<()> {
	// Push the live bundle aside (if any) to make room for the atomic rename.
	if bundle_dir.exists() {
		if bak_dir.exists() {
			fs::remove_dir_all(bak_dir)?;
		}
		fs::rename(bundle_dir, bak_dir)?;
	}
	match fs::rename(tmp_dir, bundle_dir) {
		Ok(()) => {
			// Best-effort cleanup of the backup.
			if bak_dir.exists() {
				let _ = fs::remove_dir_all(bak_dir);
			}
			Ok(())
		}
		Err(error) => {
			// Roll back: restore the previous bundle if the swap left us without
			// the primary, then clean up the stale temp.
			if !bundle_dir.exists() && bak_dir.exists() {
				let _ = fs::rename(bak_dir, bundle_dir);
			}
			let _ = fs::remove_dir_all(tmp_dir);
			Err(error)
		}
	}
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

/// Copy this binary to the given directory (self-install). If the binary is
/// already at the target path (e.g. the target dir *is* the running binary's
/// directory, or the install prefix coincides with it), the copy is the file
/// copying onto itself and would corrupt the executable — detect that and skip
/// it.
fn install_client_into(dir: &Path) -> std::io::Result<PathBuf> {
	fs::create_dir_all(dir)?;
	let current = std::env::current_exe()?;
	let target = dir.join(client_name());
	if same_file(&current, &target)? {
		// Already installed in place — nothing to copy.
		return Ok(target);
	}
	fs::copy(&current, &target)?;
	#[cfg(not(target_os = "windows"))]
	{
		use std::os::unix::fs::PermissionsExt;
		let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
	}
	Ok(target)
}

/// True when `a` and `b` resolve to the same file. Uses canonicalization (which
/// follows symlinks) and, on Unix, a device+inode comparison so hard links to
/// the same file are recognised too. A non-existent target can never be the
/// same file as the running binary.
fn same_file(a: &Path, b: &Path) -> std::io::Result<bool> {
	// Hard-link identity is unambiguous on Unix.
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		if let (Ok(a_meta), Ok(b_meta)) = (fs::metadata(a), fs::metadata(b)) {
			if a_meta.dev() == b_meta.dev() && a_meta.ino() == b_meta.ino() {
				return Ok(true);
			}
		}
	}
	// Path identity (follows symlinks). Best-effort: a target we cannot
	// canonicalize is treated as "not the same file", which means "copy it".
	let Ok(target) = fs::canonicalize(b) else {
		return Ok(false);
	};
	let source = fs::canonicalize(a)?;
	Ok(source == target)
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

/// Quote a path for the `Exec=` field of a `.desktop` file. Per the desktop
/// entry spec, the value is wrapped in double quotes and any `"`, `` ` ``, `$`
/// and `\` inside is backslash-escaped, so paths containing spaces or shell
/// metacharacters stay a single argument.
fn quote_exec(path: &str) -> String {
	let mut out = String::with_capacity(path.len() + 2);
	out.push('"');
	for ch in path.chars() {
		match ch {
			'"' | '`' | '$' | '\\' => {
				out.push('\\');
				out.push(ch);
			}
			_ => out.push(ch),
		}
	}
	out.push('"');
	out
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
		quote_exec(&launcher.display().to_string())
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
		install_client_into(&system_bin)
			.map_err(|error| format!("cannot install client into {system_bin:?}: {error}"))?;
		install_launcher_into(&system_bin)
			.map_err(|error| format!("cannot install launcher into {system_bin:?}: {error}"))?;
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

#[cfg(test)]
mod tests {
	use super::*;

	fn tmp_base() -> PathBuf {
		std::env::temp_dir().join(format!("dsh-desktop-install-test-{}", std::process::id()))
	}

	#[test]
	fn quote_exec_handles_spaces_and_metachars() {
		assert_eq!(quote_exec("/opt/deepseek harness/bin/dsh-desktop"), "\"/opt/deepseek harness/bin/dsh-desktop\"");
		// `"`, backtick, `$`, and `\` must be backslash-escaped inside the quotes.
		assert_eq!(quote_exec("/tmp/a\"b`c$d\\e"), "\"/tmp/a\\\"b\\`c\\$d\\\\e\"");
	}

	#[test]
	fn same_file_detects_the_same_path() {
		let base = tmp_base().join("same_file");
		let _ = fs::remove_dir_all(&base);
		fs::create_dir_all(&base).unwrap();
		let file = base.join("probe");
		fs::write(&file, b"x").unwrap();
		assert!(same_file(&file, &file).unwrap());
		// A second hard link resolves to the same inode => same file.
		#[cfg(not(target_os = "windows"))]
		{
			let hardlink = base.join("probe-link");
			fs::hard_link(&file, &hardlink).unwrap();
			assert!(same_file(&file, &hardlink).unwrap());
		}
		// Different files are not the same file.
		let other = base.join("other");
		fs::write(&other, b"y").unwrap();
		assert!(!same_file(&file, &other).unwrap());
		// A non-existent target is never the same file.
		assert!(!same_file(&file, &base.join("nope")).unwrap());
		let _ = fs::remove_dir_all(&base);
	}

	#[test]
	fn install_client_into_skips_self_copy() {
		let base = tmp_base().join("selfcopy");
		let _ = fs::remove_dir_all(&base);
		fs::create_dir_all(&base).unwrap();
		// Point the target path at the running binary via a symlink: the
		// installer must recognise it is already installed (canonicalizes to the
		// same file) and skip the copy instead of copying the binary onto itself.
		let current = std::env::current_exe().unwrap();
		let target = base.join(client_name());
		let before = fs::metadata(&current).unwrap().len();
		#[cfg(unix)]
		std::os::unix::fs::symlink(&current, &target).unwrap();
		#[cfg(windows)]
		std::os::windows::fs::symlink_file(&current, &target).unwrap();
		let result = install_client_into(&base).unwrap();
		assert_eq!(result, target);
		// The target is still a symlink to current_exe: a self-copy would have
		// dereferenced/re-written it. Verify current_exe content is untouched.
		assert_eq!(fs::metadata(&current).unwrap().len(), before, "self copy must not overwrite the binary");
		let _ = fs::remove_dir_all(&base);
	}

	#[test]
	fn swap_bundle_atomic_and_rollback() {
		let base = tmp_base().join("swap");
		let _ = fs::remove_dir_all(&base);
		let bundle = base.join("bundle");
		let tmp = base.join("bundle.tmp");
		let bak = base.join("bundle.bak");
		fs::create_dir_all(&bundle).unwrap();
		fs::write(bundle.join("old.txt"), b"old").unwrap();

		// Happy path: new staged contents replace the existing bundle, and the
		// backup + temp are cleaned up afterwards.
		fs::create_dir_all(&tmp).unwrap();
		fs::write(tmp.join("new.txt"), b"new").unwrap();
		swap_bundle_dir(&bundle, &tmp, &bak).unwrap();
		assert!(bundle.join("new.txt").exists());
		assert!(!bundle.join("old.txt").exists());
		assert!(!bak.exists());
		assert!(!tmp.exists());
		let _ = fs::remove_dir_all(&base);
	}

	#[test]
	fn swap_bundle_rollback_restores_previous() {
		// Force the final `tmp → bundle` rename to fail deterministically by
		// staging the temp on a *different* filesystem than the bundle (EXDEV),
		// which no process (even root) can bypass. That exercises the rollback:
		// the previous bundle must be restored into place and the temp cleared.
		let shm = Path::new("/dev/shm");
		let tmp_base = tmp_base().join("swap_rollback");
		let _ = fs::remove_dir_all(&tmp_base);
		let bundle = tmp_base.join("bundle");
		let bak = tmp_base.join("bundle.bak");
		fs::create_dir_all(&bundle).unwrap();
		fs::write(bundle.join("old.txt"), b"old").unwrap();

		// Stage `new` on /dev/shm (separate device) so the cross-device rename
		// back onto the disk bundle fails. Skip the whole test when the device
		// is unavailable.
		let Some(shm_dir) = (shm.exists()).then(|| shm.join(tmp_base.file_name().unwrap())) else {
			eprintln!("dsh-desktop: /dev/shm unavailable; skipping rollback test");
			let _ = fs::remove_dir_all(&tmp_base);
			return;
		};
		let _ = fs::remove_dir_all(&shm_dir);
		fs::create_dir_all(&shm_dir).unwrap();
		let tmp = shm_dir.join("bundle.tmp");
		fs::create_dir_all(&tmp).unwrap();
		fs::write(tmp.join("new.txt"), b"new").unwrap();

		let res = swap_bundle_dir(&bundle, &tmp, &bak);
		// Clean the temp staging even if the test later panics.
		let shm_cleanup = fs::remove_dir_all(&shm_dir);
		assert!(res.is_err(), "cross-device rename must fail the swap");
		assert!(bundle.join("old.txt").exists(), "previous bundle must be rolled back into place");
		assert!(!bundle.join("new.txt").exists(), "failed swap must not leave partial new contents");
		// Both backups/temps are gone after the rollback.
		assert!(!bak.exists());
		if let Err(error) = shm_cleanup {
			eprintln!("dsh-desktop: could not clean /dev/shm staging: {error}");
		}
		let _ = fs::remove_dir_all(&tmp_base);
	}
}
