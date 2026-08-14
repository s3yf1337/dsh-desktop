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
 * PATH (the copy the repo's `install.sh` puts in `~/.local/bin`). When no
 * binary exists the web surface still serves — the harness degrades to
 * browser use instead of failing.
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

/** Resolve a bare executable name through PATH, if present. */
function findOnPath(bin) {
	const pathEnv = process.env.PATH ?? "";
	for (const dir of pathEnv.split(process.platform === "win32" ? ";" : ":")) {
		if (dir === "") continue;
		const candidate = join(dir, bin);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
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
	const onPath = findOnPath("dsh-desktop-shell");
	if (onPath !== void 0) return onPath;
	const local = join(homedir(), ".local", "bin", "dsh-desktop-shell");
	if (existsSync(local)) return local;
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

	// Agent-lifecycle state for notification translation: the harness emits
	// app-level events the desktop shell mirrors into OS notifications through
	// the client's stdin control channel.
	const titles = new Map();
	const running = new Map();

	/**
	 * Send one JSON control message to the native client's stdin. The client
	 * reads the pipe on a background thread; a missing or dead client makes
	 * this a no-op (the web surface keeps working regardless).
	 * @param message - control message, e.g. { event: "notify", title, body }.
	 */
	const writeControl = (message) => {
		if (child === void 0 || child.stdin === null || child.stdin.destroyed) return;
		try {
			child.stdin.write(JSON.stringify(message) + "\n");
		} catch {
			// pipe closed; nothing to do
		}
	};

	/** Human-readable error text for a notification body. */
	const errorText = (error, sessionId) => {
		const detail = error instanceof Error ? error.message : String(error ?? "unknown error");
		const trimmed = detail.length > 160 ? detail.slice(0, 157) + "…" : detail;
		return `Session ${sessionId ?? "?"}: ${trimmed}`;
	};

	/** Extract the first question from an ask_user_question tool call. */
	const questionText = (args) => {
		let parsed = args;
		if (typeof parsed === "string") {
			try {
				parsed = JSON.parse(parsed);
			} catch {
				return "The agent is asking you a question.";
			}
		}
		const first = Array.isArray(parsed?.questions) ? parsed.questions[0] : void 0;
		if (first !== void 0 && typeof first.question === "string") {
			const header = typeof first.header === "string" && first.header !== "" ? `${first.header}: ` : "";
			return header + first.question;
		}
		return "The agent is asking you a question.";
	};

	// Mirror agent lifecycle into notifications. All subscriptions are app-level
	// cordis events; listeners are disposed with the plugin.
	const disposeListeners = [];
	if (typeof ctx.on === "function") {
		disposeListeners.push(ctx.on("agent/status", ({ agent, status }) => {
			const id = agent?.id;
			if (id === void 0) return;
			const wasRunning = running.get(id) ?? false;
			const isRunning = status === "running";
			running.set(id, isRunning);
			if (wasRunning && !isRunning) {
				const title = titles.get(id);
				writeControl({
					event: "notify",
					title: "Agent finished",
					body: typeof title === "string" && title !== ""
						? `"${title}" — work complete.`
						: `Session ${id} finished its work.`
				});
			}
		}));
		disposeListeners.push(ctx.on("agent/error", ({ agent, error }) => {
			writeControl({
				event: "notify",
				title: "Agent error",
				body: errorText(error, agent?.id)
			});
		}));
		disposeListeners.push(ctx.on("session/event", (session, event) => {
			if (event?.type === "session/title" && typeof event.data?.title === "string") {
				titles.set(session?.id, event.data.title);
			} else if (event?.type === "tool/call" && event.data?.name === "ask_user_question") {
				writeControl({
					event: "notify",
					title: "Question",
					body: questionText(event.data.arguments)
				});
			}
		}));
	}

	ctx.effect(() => () => {
		for (const dispose of disposeListeners) {
			try {
				dispose();
			} catch {
				// disposal is best-effort
			}
		}
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
					`${url} — install it by running ./install.sh in the dsh-desktop repo ` +
					"(github.com/s3yf1337/dsh-desktop), or set DSH_DESKTOP_BIN"
			);
			ctx.logger.warn(`desktop-shell: no native client found; keeping the web surface at ${url}`);
			return;
		}
		console.log(`dsh desktop: ${url} (window: ${bin})`);
		ctx.logger.info(`desktop-shell: opening ${url} with ${bin}`);
		child = spawn(bin, [url], {
			env: { ...process.env, DSH_HOME: resolveDshHome() },
			// stdin is the control pipe (agent lifecycle notifications); the
			// client's stdout/stderr stay on the harness terminal.
			stdio: ["pipe", "inherit", "inherit"]
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
