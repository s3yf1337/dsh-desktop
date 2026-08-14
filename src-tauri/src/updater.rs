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
}

/// Query GitHub for the latest non-draft, non-prerelease release.
///
/// Returns `Ok(None)` when the repo has no releases yet (404) — that is the
/// normal "up to date" answer, not an error.
pub async fn fetch_latest() -> Result<Option<GitHubRelease>, String> {
	let client = reqwest::Client::builder()
		.user_agent(concat!("dsh-desktop/", env!("CARGO_PKG_VERSION")))
		.timeout(std::time::Duration::from_secs(15))
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

/// Compare a release tag with the running version. Returns `Some(true)` when
/// the tag is a *newer* semver than `current`; `None` when either side is not
/// a parseable semver (unreleased/rolling tags are ignored).
pub fn compare(current: &str, tag: &str) -> Option<bool> {
	let tag_clean = tag.strip_prefix('v').unwrap_or(tag);
	let current = semver::Version::parse(current).ok()?;
	let candidate = semver::Version::parse(tag_clean).ok()?;
	Some(candidate > current)
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
