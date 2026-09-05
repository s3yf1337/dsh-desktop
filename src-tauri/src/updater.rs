//! GitHub release updater for dsh-desktop.
//!
//! The updater is deliberately non-invasive: it checks
//! `s3yf1337/dsh-desktop` releases on GitHub, compares the latest tag with the
//! running version, and *suggests* the update — a tray menu entry, a native
//! notification, and a line in the settings tab — each of which opens the
//! release page in the browser. It never downloads or installs anything.

use crate::settings::UpdateInfo;
use serde::Deserialize;

/// GitHub repo that publishes dsh-desktop releases.
pub const REPO: &str = "s3yf1337/dsh-desktop";
/// The releases page (opened when an update is suggested).
pub const RELEASES_URL: &str = "https://github.com/s3yf1337/dsh-desktop/releases";

/// Shape of `GET /repos/{repo}/releases/latest`.
#[derive(Deserialize, Debug)]
pub struct GitHubRelease {
	#[serde(default)]
	pub tag_name: String,
	#[serde(default)]
	pub html_url: String,
	pub published_at: Option<String>,
	#[serde(default)]
	pub draft: Option<bool>,
	#[serde(default)]
	pub prerelease: Option<bool>,
	#[serde(default)]
	pub assets: Vec<ReleaseAsset>,
}

/// One downloadable asset of a release.
#[derive(Deserialize, Debug, Clone)]
pub struct ReleaseAsset {
	#[serde(default)]
	pub name: String,
	#[serde(default)]
	pub browser_download_url: String,
	#[serde(default)]
	pub size: u64,
}

/// The platform slug used in release artifact names, e.g. `linux-x86_64`
/// (matches the CI-produced `dsh-desktop-<tag>-<slug>.tar.gz` tarballs).
pub fn platform_slug() -> &'static str {
	#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
	{
		"linux-x86_64"
	}
	#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
	{
		"linux-aarch64"
	}
	#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
	{
		"macos-aarch64"
	}
	#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
	{
		"macos-x86_64"
	}
	#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
	{
		"windows-x86_64"
	}
	#[cfg(all(target_os = "windows", target_arch = "aarch64"))]
	{
		"windows-aarch64"
	}
	#[cfg(not(any(
		all(target_os = "linux", target_arch = "x86_64"),
		all(target_os = "linux", target_arch = "aarch64"),
		all(target_os = "macos", target_arch = "aarch64"),
		all(target_os = "macos", target_arch = "x86_64"),
		all(target_os = "windows", target_arch = "x86_64"),
		all(target_os = "windows", target_arch = "aarch64"),
	)))]
	{
		"unknown"
	}
}

/// The tarball asset for this platform: `dsh-desktop-v<tag>-<slug>.tar.gz`.
pub fn find_platform_asset(release: &GitHubRelease) -> Option<&ReleaseAsset> {
	let slug = platform_slug();
	release
		.assets
		.iter()
		.find(|asset| asset.name.starts_with("dsh-desktop-v") && asset.name.contains(slug) && asset.name.ends_with(".tar.gz"))
}

/// The `.sha256` checksum asset accompanying `tarball_name` — exactly named
/// `<tarball_name>.sha256` (produced by the CI pack step).
pub fn find_checksum_asset<'a>(release: &'a GitHubRelease, tarball_name: &str) -> Option<&'a ReleaseAsset> {
	release
		.assets
		.iter()
		.find(|asset| asset.name == format!("{tarball_name}.sha256"))
}

/// The running desktop version, including a trailing letter patch (e.g.
/// `0.2.3a`) when the binary was built from a `v0.2.3a` tag. Cargo itself
/// cannot publish `0.2.3a`, so the CI build injects the full version through
/// `DSH_DESKTOP_VERSION` (see `build.rs`); local `cargo build` falls back to
/// the crate version.
pub fn current_version() -> &'static str {
	option_env!("DSH_DESKTOP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

/// Query GitHub for the latest non-draft, non-prerelease release.
///
/// Returns `Ok(None)` when the repo has no releases yet (404) — that is the
/// normal "up to date" answer, not an error.
pub async fn fetch_latest() -> Result<Option<GitHubRelease>, String> {
	let client = reqwest::Client::builder()
		.user_agent(format!("dsh-desktop/{}", current_version()))
		.timeout(std::time::Duration::from_secs(15))
		.redirect(reqwest::redirect::Policy::custom(|attempt| {
			if attempt.url().scheme() == "https" {
				attempt.follow()
			} else {
				attempt.stop()
			}
		}))
		.build()
		.map_err(|error| format!("http client: {error}"))?;
	let url = format!("https://api.github.com/repos/{REPO}/releases/latest");
	let response = client
		.get(&url)
		.header("Accept", "application/vnd.github+json")
		.header("X-GitHub-Api-Version", "2022-11-28")
		.send()
		.await
		.map_err(|error| format!("github: {error}"))?;
	match response.status().as_u16() {
		404 => Ok(None), // no releases published yet
		200 => {
			let release: GitHubRelease = response
				.json()
				.await
				.map_err(|error| format!("github payload: {error}"))?;
			if release.draft == Some(true) || release.prerelease == Some(true) {
				return Ok(None);
			}
			Ok(Some(release))
		}
		status => Err(format!(
			"github api {status}: {}",
			response.text().await.unwrap_or_default().chars().take(200).collect::<String>()
		)),
	}
}

/// A version that can also carry a *letter patch* — a trailing-letter hotfix
/// suffix that is not valid strict semver (`0.2.3a`). Strict semver parses
/// first and wins when it succeeds; the letter form is only consulted when
/// strict parsing fails, so ordinary tags behave exactly as before.
///
/// Cargo itself cannot publish `0.2.3a` (strict semver required), so CI builds
/// for letter patches publish the binary as `0.2.3+a` (build metadata) and this
/// parser normalises such `+<letters>` builds back to the `Letter` variant, so
/// `0.2.3a` and `0.2.3+a` compare equal and the updater understands it is
/// already on the latest letter patch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ParsedVersion {
	Strict(semver::Version),
	Letter {
		major: u64,
		minor: u64,
		patch: u64,
		/// The trailing letters, lowercased (`"a"`, `"ab"`…).
		suffix: String,
	},
}

impl std::fmt::Display for ParsedVersion {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			ParsedVersion::Strict(v) => write!(f, "{v}"),
			ParsedVersion::Letter { major, minor, patch, suffix } => write!(f, "{major}.{minor}.{patch}{suffix}"),
		}
	}
}

/// Parse `input` as strict semver (optionally with a leading `v`), falling
/// back to the letter-patch form `v?<major>.<minor>.<patch><letters>` when
/// strict parsing fails. Anything else returns `None`.
///
/// A strict version whose *only* non-core data is pure-letter build metadata
/// (`0.2.3+a`, `0.2.3+ab`) is normalised to the `Letter` variant so the Cargo
/// representation `0.2.3+a` of a `v0.2.3a` release compares equal to the tag.
pub(crate) fn parse_loose(input: &str) -> Option<ParsedVersion> {
	let input = input.strip_prefix('v').unwrap_or(input);
	if let Ok(version) = semver::Version::parse(input) {
		// Normalise `0.2.3+<letters>` → Letter, so a binary built as
		// `0.2.3+a` (the only valid semver spelling for a `v0.2.3a` tag) is
		// considered the same version as the tag itself. The build must be
		// pure ascii letters and prerelease must be empty — anything more
		// complex stays Strict and keeps the crate's exact ordering (e.g.
		// `0.2.3-alpha` stays a prerelease, not a letter patch).
		if !version.build.is_empty() && version.pre.is_empty() {
			let build = version.build.as_str();
			if build.chars().all(|ch| ch.is_ascii_alphabetic()) {
				return Some(ParsedVersion::Letter {
					major: version.major,
					minor: version.minor,
					patch: version.patch,
					suffix: build.to_ascii_lowercase(),
				});
			}
		}
		return Some(ParsedVersion::Strict(version));
	}
	// Letter patch: exactly three dot-separated parts, the last one being
	// digits immediately followed by letters (e.g. "0.2.3a", "0.2.3aa").
	let mut parts = input.split('.');
	let major = parts.next()?.parse::<u64>().ok()?;
	let minor = parts.next()?.parse::<u64>().ok()?;
	let tail = parts.next()?;
	if parts.next().is_some() {
		return None; // more than three parts — not a letter patch
	}
	let digit_len = tail.bytes().take_while(|byte| byte.is_ascii_digit()).count();
	if digit_len == 0 || digit_len == tail.len() {
		return None; // no digits, or no letters at all (plain numbers parse above)
	}
	let patch = tail[..digit_len].parse::<u64>().ok()?;
	let suffix = tail[digit_len..].to_ascii_lowercase();
	if !suffix.bytes().all(|byte| byte.is_ascii_lowercase()) {
		return None;
	}
	Some(ParsedVersion::Letter { major, minor, patch, suffix })
}

/// Order two parsed versions. Letter patches rank above any strict version of
/// the same core: a hotfix release beats both the plain release and its
/// prereleases (`0.2.3-pre < 0.2.3 < 0.2.3a < 0.2.3b < 0.2.4`). When both
/// sides are strict semver the crate's exact ordering is used, so prerelease
/// and build-metadata semantics stay untouched.
pub(crate) fn version_cmp(left: &ParsedVersion, right: &ParsedVersion) -> std::cmp::Ordering {
	match (left, right) {
		(ParsedVersion::Strict(left), ParsedVersion::Strict(right)) => left.cmp(right),
		(ParsedVersion::Letter { major, minor, patch, suffix }, ParsedVersion::Letter { major: rm, minor: rmin, patch: rp, suffix: rs }) => {
			(major, minor, patch, suffix).cmp(&(rm, rmin, rp, rs))
		}
		// Mixed: the letter side is a release of its core, so it is newer than
		// any strict version of the SAME core (prereleases included), while a
		// different core orders numerically.
		(ParsedVersion::Letter { major, minor, patch, .. }, ParsedVersion::Strict(right)) => {
			(*major, *minor, *patch).cmp(&(right.major, right.minor, right.patch)).then(std::cmp::Ordering::Greater)
		}
		(ParsedVersion::Strict(left), ParsedVersion::Letter { major, minor, patch, .. }) => {
			(left.major, left.minor, left.patch).cmp(&(*major, *minor, *patch)).then(std::cmp::Ordering::Less)
		}
	}
}

/// Compare a release tag with the running version. Returns `Some(true)` when
/// the tag is a *newer* version than `current`; `None` when either side is
/// not parseable at all (unreleased/rolling tags are ignored).
///
/// Accepts strict semver tags (`v0.2.4`) and letter patches (`v0.2.3a`), which
/// rank between the plain patch and the next one — so a hotfix release after
/// `0.2.3` is correctly suggested to `0.2.3` clients.
pub fn compare(current: &str, tag: &str) -> Option<bool> {
	let current = parse_loose(current)?;
	let candidate = parse_loose(tag)?;
	Some(version_cmp(&candidate, &current) == std::cmp::Ordering::Greater)
}

/// Build the `UpdateInfo` for a newer release, or `None` when the tag is not
/// newer (or not comparable).
pub fn update_info_for(current: &str, release: &GitHubRelease) -> Option<UpdateInfo> {
	if compare(current, &release.tag_name) != Some(true) {
		return None;
	}
	let url = if release.html_url.is_empty() {
		RELEASES_URL.to_string()
	} else {
		release.html_url.clone()
	};
	Some(UpdateInfo {
		version: release.tag_name.clone(),
		url,
		published_at: release.published_at.clone(),
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cargo_build_metadata_letter_is_equal_to_tag_letter() {
		// CI builds a `v0.2.3a` tag as Cargo version `0.2.3+a` (the only valid
		// semver spelling). The updater must understand that the binary built
		// this way is *already* on `v0.2.3a`, not behind it.
		assert_eq!(compare("0.2.3+a", "v0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3a", "0.2.3+a"), Some(false));
		assert_eq!(compare("0.2.3+a", "0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3+b", "0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3+a", "0.2.3b"), Some(true));
		assert_eq!(compare("0.2.3+a", "0.2.3"), Some(false));
		assert_eq!(compare("0.2.3", "0.2.3+a"), Some(true));
		// Upper-case build is normalised the same way.
		assert_eq!(compare("0.2.3+A", "0.2.3a"), Some(false));
	}

	#[test]
	fn already_on_latest_letter_patch_is_not_newer() {
		// The reported bug: the updater must not keep offering the same
		// letter patch once the binary already reports that patch version.
		assert_eq!(compare("0.2.3a", "v0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3+a", "v0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3a", "0.2.3a"), Some(false));
		assert_eq!(compare("v0.2.3a", "0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3b", "0.2.3b"), Some(false));
	}

	#[test]
	fn letter_patch_ranks_between_patch_and_next_minor() {
		// The headline case: a hotfix release after 0.2.3 is newer than 0.2.3
		// itself, so the in-app updater suggests it.
		assert_eq!(compare("0.2.3", "v0.2.3a"), Some(true));
		assert_eq!(compare("0.2.3", "0.2.3a"), Some(true));
		assert_eq!(compare("0.2.3a", "0.2.3"), Some(false));
		assert_eq!(compare("0.2.3", "0.2.4"), Some(true));
		assert_eq!(compare("0.2.3a", "0.2.4"), Some(true));
		// A letter patch of an older core is still older.
		assert_eq!(compare("0.2.3a", "0.2.2z"), Some(false));
		assert_eq!(compare("0.2.2z", "0.2.3a"), Some(true));
	}

	#[test]
	fn letter_patches_order_among_themselves() {
		assert_eq!(compare("0.2.3a", "0.2.3b"), Some(true));
		assert_eq!(compare("0.2.3b", "0.2.3a"), Some(false));
		assert_eq!(compare("0.2.3a", "0.2.3a"), Some(false));
		// Prefix rule: "aa" > "a" (plain lexicographic order).
		assert_eq!(compare("0.2.3a", "0.2.3aa"), Some(true));
		assert_eq!(compare("0.2.3aa", "0.2.3ab"), Some(true));
	}

	#[test]
	fn letter_patches_beat_prereleases_of_the_same_core() {
		// A hotfix release ranks above prereleases of the same core.
		assert_eq!(compare("0.2.3-rc.1", "0.2.3a"), Some(true));
		assert_eq!(compare("0.2.3a", "0.2.3-rc.1"), Some(false));
	}

	#[test]
	fn strict_semver_behavior_is_unchanged() {
		assert_eq!(compare("0.2.3", "0.2.3"), Some(false));
		assert_eq!(compare("0.2.3", "0.2.4-alpha"), Some(true));
		assert_eq!(compare("0.2.3-alpha", "0.2.3"), Some(true));
		assert_eq!(compare("0.2.3-alpha", "0.2.3-beta"), Some(true));
		// The semver crate orders build metadata as a tiebreaker, so a tag
		// with build metadata ranks above the plain version — pre-existing
		// behavior, kept as-is.
		assert_eq!(compare("0.2.3", "0.2.3+a"), Some(true));
	}

	#[test]
	fn unparseable_tags_are_ignored() {
		assert_eq!(compare("0.2.3", "rolling"), None);
		assert_eq!(compare("0.2.3", "latest"), None);
		assert_eq!(compare("0.2.3", "1.2"), None);
		assert_eq!(compare("0.2.3", "0.2.3a.1"), None); // malformed letter patch
		assert_eq!(compare("0.2.3", "0.2.3-"), None);
	}
}
