import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";

/**
 * @deepseek-ai/dsh-desktop-shell — the desktop profile's native-window plugin.
 *
 * The bundle patch adds one row over the web surface (dsh-base + dsh-web-app):
 * after the web server binds, this plugin spawns the `dsh-desktop-shell`
 * native client on the served loopback URL. The client is a plain render
 * surface — it shows the exact same origin a browser would, so the `/api`
 * bridge, WebSockets, and the whole SPA work unchanged and same-origin — and
 * exits with code 0 when its window is closed, which this plugin treats as a
 * request to shut the harness down (`ctx.appExit`).
 *
 * The client binary is an artifact of this profile, not harness logic: it is
 * resolved as `config.bin` (settable, e.g. `!!js process.env.DSH_DESKTOP_BIN`
 * in the bundle patch), then `DSH_DESKTOP_BIN`, then `dsh-desktop-shell` on
 * PATH, then `$DSH_HOME/desktop/target/{release,debug}` and
 * `~/.local/bin/dsh-desktop-shell`. When no binary exists the web surface
 * still serves — the harness degrades to browser use instead of failing.
 */
const name = "desktop-shell";

/** Services this plugin reads (the server whose port becomes the window URL). */
const inject = ["webServer"];

const Config = z.object({
	/** Explicit path to the native client binary (overrides DSH_DESKTOP_BIN). */
	bin: z.string(),
	/** Window title the client should show (reference; the client may restate it). */
	title: z.string().default("DeepSeek Harness")
});

/** The loopback host every local surface binds to by default. */
const LOOPBACK_HOST = "127.0.0.1";

/** Resolve the Harness home exactly as the launcher does: `DSH_HOME`, else `~/.dsh`. */
function resolveDshHome() {
	const value = process.env.DSH_HOME;
	if (typeof value === "string" && value.trim() !== "") return value;
	return join(homedir(), ".dsh");
}

/**
 * Resolve the native client binary to spawn.
 * @param explicitBin - the `config.bin` value (already interpolated by the loader).
 * @returns the binary path or bare name; `undefined` when nothing resolves.
 * @throws when an explicitly configured path does not exist (a config error, not a fallback case).
 */
function resolveShellBinary(explicitBin) {
	const explicit = [explicitBin, process.env.DSH_DESKTOP_BIN].filter(
		(value) => typeof value === "string" && value.trim() !== ""
	);
	if (explicit.length > 0) {
		const value = explicit[0];
		// A path is checked to exist; a bare name is left for PATH resolution.
		if (value.includes("/") || value.includes("\\")) {
			if (!existsSync(value)) throw new Error(`configured client binary not found: ${value}`);
			return value;
		}
		return value;
	}
	const home = resolveDshHome();
	for (const candidate of [
		join(home, "desktop", "target", "release", "dsh-desktop-shell"),
		join(home, "desktop", "target", "debug", "dsh-desktop-shell"),
		join(home, "desktop", "src-tauri", "target", "release", "dsh-desktop-shell"),
		join(home, "desktop", "src-tauri", "target", "debug", "dsh-desktop-shell"),
		join(homedir(), ".local", "bin", "dsh-desktop-shell")
	]) {
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Mount the native window client once the web surface is bound.
 * @param ctx - plugin context carrying webServer (injected) and appExit (launcher-provided).
 * @param config - validated {@link Config}.
 */
function apply(ctx, config) {
	const settled = ctx.get("loader")?.await();
	const exit = ctx.get("appExit");
	let child;
	ctx.effect(() => () => {
		if (child !== void 0 && child.exitCode === null && !child.killed) child.kill("SIGTERM");
	});
	const open = () => {
		const server = ctx.get("webServer");
		if (server === void 0) return;
		const url = `http://${LOOPBACK_HOST}:${server.port}`;
		let bin;
		try {
			bin = resolveShellBinary(config.bin);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`dsh desktop: ${message}`);
			ctx.logger.error(message);
			return;
		}
		if (bin === void 0) {
			// The cordis logger only buffers by default; the surface announce
			// convention (web-app's `dsh web: <url>`) is plain console output,
			// so the actionable message must be visible on the terminal too.
			console.error(
				"dsh desktop: no native client found; keeping the web surface at " +
					`${url} — build it with 'cd ~/.dsh/desktop/src-tauri && cargo build --release' ` +
					"(or run ~/.dsh/desktop/install.sh), or set DSH_DESKTOP_BIN"
			);
			ctx.logger.warn(`desktop-shell: no native client found; keeping the web surface at ${url}`);
			return;
		}
		console.log(`dsh desktop: ${url} (window: ${bin})`);
		ctx.logger.info(`desktop-shell: opening ${url} with ${bin}`);
		child = spawn(bin, [url], {
			env: { ...process.env, DSH_HOME: resolveDshHome() },
			stdio: "inherit"
		});
		child.on("error", (error) => {
			console.error(`dsh desktop: failed to start ${bin}: ${error.message}; keeping the web surface at ${url}`);
			ctx.logger.error(`desktop-shell: failed to start ${bin}: ${error.message}`);
		});
		child.on("exit", (code, signal) => {
			if (signal !== null || code === null) return; // we killed it, or it died by a signal
			if (code === 0) {
				console.log("dsh desktop: window closed; shutting the harness down");
				ctx.logger.info("desktop-shell: window closed; shutting the harness down");
				if (exit !== void 0) exit(0);
			} else {
				console.error(`dsh desktop: client exited with code ${code}; keeping the web surface at ${url}`);
				ctx.logger.warn(`desktop-shell: client exited with code ${code}`);
			}
		});
	};
	if (settled === void 0) open();
	else settled.then(open, () => {});
}

export { Config, apply, inject, name };
