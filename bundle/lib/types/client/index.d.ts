/**
 * Browser half of `dsh-desktop-shell`: registers the "dsh-desktop" section in
 * the web Settings surface. Types are minimal — the tab is a self-contained
 * React component talking to the native client through `window.__TAURI__`.
 */

export const NS: "desktopShell";
export const inject: readonly ["slots", "workspaces"];

interface DesktopSettings {
	tray: boolean;
	notifications: boolean;
	auto_update_check: boolean;
	update_interval_hours: number;
	tray_hide_hint_shown: boolean;
}

interface UpdateInfo {
	version: string;
	url: string;
	published_at: string | null;
}

export interface DesktopState {
	version: string;
	settings: DesktopSettings;
	update: UpdateInfo | null;
	last_update_check: string | null;
	update_check_error: string | null;
	client: boolean;
}

export function apply(ctx: unknown): void;
