import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
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
 *
 * Tray agent monitor: the client's window also hosts a tray whose agents
 * section (running list, log tail, stop) is driven by a small JSON control
 * protocol between this plugin and the client. The plugin pipes control
 * messages into the client's stdin and reads `dshdctl:`-prefixed replies off
 * its stdout; the full contract lives in docs/tray-agent-monitor.md, which
 * is authoritative over this file.
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

// ── local-file serving for the preview panel ──────────────────────────────
//
// The explorer's Preview tab renders markdown with the app's own renderer and
// shows local .html pages in a sandboxed iframe. Both need the browser to
// load LOCAL files over HTTP: the app origin's browser cannot read the disk,
// and data: URIs cannot carry relative assets. This plugin registers a
// loopback-only route on the harness web server that serves one file per
// request, addressed by its absolute path:
//
//   http://127.0.0.1:<port>/dshd-file/<encodeURIComponent(absPath)>
//
// The route is the preview's only bridge to the filesystem, so it is fenced
// hard: loopback clients only (the WebView always connects from loopback, so
// a harness bound to a LAN interface never exposes local files to the LAN),
// GET/HEAD only, size caps, and no directory listings. text/html responses
// get a tiny bridge script so pages previewed in the sandboxed iframe can
// ask the panel to open external links in the system browser (a sandboxed
// iframe cannot reach its parent any other way).

/** URL prefix of the local-file preview route. */
const DSHD_FILE_PREFIX = "/dshd-file";

/** One file per request, capped so a mistaken preview cannot OOM the server. */
const DSHD_FILE_CAP = 32 << 20;

// ── bundled static assets for the tray / web surface ──────────────────────
//
// A second prefix route, `/dshd-asset/<name>`, serves files from the plugin's
// own `assets` directory (bundle/lib/assets, resolved from import.meta.url).
// Unlike the preview route it takes a bare name, not an absolute path — it is
// the harness's own static payload (e.g. the client's bundled `mermaid.min.js`),
// so it is fenced the same way (loopback only, GET/HEAD, no traversal, size
// cap) but resolves strictly inside the plugin directory.

/** URL prefix of the bundled static-assets route. */
const DSHD_ASSET_PREFIX = "/dshd-asset";

/** Assets share the local-file route's cap (32 MiB is plenty for static payloads). */
const DSHD_ASSET_CAP = 32 << 20;

/** Root of the bundled static assets, derived from the plugin file's own location. */
const DSHD_ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "assets");

/** MIME by extension; anything unknown is served as an opaque download. */
const DSHD_FILE_MIME = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".md": "text/plain; charset=utf-8",
	".markdown": "text/plain; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
	".xml": "application/xml; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".bmp": "image/bmp",
	".ico": "image/x-icon",
	".avif": "image/avif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".eot": "application/vnd.ms-fontobject",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".pdf": "application/pdf"
};

/**
 * Bridge injected into every text/html response. The preview iframe is
 * sandboxed (opaque origin), so the page cannot touch its parent: the bridge
 * is the page's only voice. It reports the title (the panel shows it instead
 * of the file name) and forwards external-link clicks (http/https/mailto or
 * target=_blank) to the parent, which opens them in the system browser.
 * Relative links are left alone — they navigate the iframe itself, which is
 * exactly the browser behavior a local page expects.
 */
const DSHD_FILE_BRIDGE = `<script>(()=>{const post=(m)=>{try{parent.postMessage({source:"dshd-file",...m},"*")}catch{}};
try{post({type:"title",title:document.title})}catch{}
document.addEventListener("click",(e)=>{const a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;
const href=a.getAttribute("href")||"";const external=/^(https?:|mailto:)/i.test(href)||a.target==="_blank";
if(external){e.preventDefault();e.stopPropagation();post({type:"open",url:a.href})}},true)})();<\/script>`;

/** Loopback client addresses (IPv4, IPv6, and the v4-mapped form). */
function isLoopback(address) {
	return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** MIME of `path`, falling back to the opaque binary type. */
function mimeOf(path) {
	const dot = path.lastIndexOf(".");
	if (dot === -1) return "application/octet-stream";
	return DSHD_FILE_MIME[path.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Serve one local file per request at `/dshd-file/<encoded absolute path>`.
 * @param req - the node http request (the webServer service's handler contract).
 * @param res - the node http response.
 */
async function serveDshdFile(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	// Loopback fence: the WebView's requests always come from loopback; LAN
	// clients of a harness bound to 0.0.0.0 must never reach local files.
	if (!isLoopback(req.socket.remoteAddress)) {
		res.writeHead(403);
		res.end();
		return;
	}
	let decoded;
	try {
		decoded = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
	} catch {
		res.writeHead(400);
		res.end();
		return;
	}
	if (!decoded.startsWith(`${DSHD_FILE_PREFIX}/`)) {
		res.writeHead(404);
		res.end();
		return;
	}
	const path = decoded.slice(DSHD_FILE_PREFIX.length + 1);
	if (path === "" || path.includes("\0")) {
		res.writeHead(400);
		res.end();
		return;
	}
	let meta;
	try {
		meta = await stat(path);
	} catch {
		res.writeHead(404);
		res.end();
		return;
	}
	if (!meta.isFile() || meta.size > DSHD_FILE_CAP) {
		res.writeHead(404);
		res.end();
		return;
	}
	let body;
	try {
		body = await readFile(path);
	} catch {
		res.writeHead(404);
		res.end();
		return;
	}
	let mime = mimeOf(path);
	if (mime === "text/html; charset=utf-8") {
		const bridge = Buffer.from(DSHD_FILE_BRIDGE, "utf8");
		const index = body.indexOf(Buffer.from("</head>", "utf8"));
		body = index === -1 ? Buffer.concat([bridge, body]) : Buffer.concat([body.subarray(0, index), bridge, body.subarray(index)]);
	}
	res.writeHead(200, {
		"content-type": mime,
		"content-length": body.length,
		// The preview reloads with a rev query; a page edited on disk must
		// not be shadowed by a cache.
		"cache-control": "no-cache"
	});
	if (req.method === "HEAD") {
		res.end();
	} else {
		res.end(body);
	}
}

/**
 * Serve one bundled static asset per request at `/dshd-asset/<name>`.
 * The name is resolved strictly inside the plugin's `assets` directory; path
 * traversal and unknown files answer 404. The directory may not exist yet —
 * that is just another 404.
 * @param req - the node http request (the webServer service's handler contract).
 * @param res - the node http response.
 */
async function serveDshdAsset(req, res) {
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405);
		res.end();
		return;
	}
	// Same loopback fence as the preview route: bundled assets must never be
	// reachable from a LAN client of a harness bound to 0.0.0.0.
	if (!isLoopback(req.socket.remoteAddress)) {
		res.writeHead(403);
		res.end();
		return;
	}
	let decoded;
	try {
		decoded = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
	} catch {
		res.writeHead(400);
		res.end();
		return;
	}
	if (!decoded.startsWith(`${DSHD_ASSET_PREFIX}/`)) {
		res.writeHead(404);
		res.end();
		return;
	}
	const name = decoded.slice(DSHD_ASSET_PREFIX.length + 1);
	if (name === "" || name.includes("\0")) {
		res.writeHead(400);
		res.end();
		return;
	}
	// Resolve against the assets root and confirm the result stays inside it,
	// so `..` segments cannot escape into the harness's own files.
	const path = normalize(join(DSHD_ASSET_DIR, name));
	if (!path.startsWith(DSHD_ASSET_DIR + "/")) {
		res.writeHead(404);
		res.end();
		return;
	}
	let meta;
	try {
		meta = await stat(path);
	} catch {
		res.writeHead(404);
		res.end();
		return;
	}
	if (!meta.isFile() || meta.size > DSHD_ASSET_CAP) {
		res.writeHead(404);
		res.end();
		return;
	}
	let body;
	try {
		body = await readFile(path);
	} catch {
		res.writeHead(404);
		res.end();
		return;
	}
	res.writeHead(200, {
		"content-type": mimeOf(path),
		"content-length": body.length,
		// Static assets are content-addressed/versioned by the client, so a
		// short cache is fine and avoids re-fetching on every reload.
		"cache-control": "public, max-age=300"
	});
	if (req.method === "HEAD") {
		res.end();
	} else {
		res.end(body);
	}
}

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
		for (const candidate of [join(dir, bin), join(dir, bin + ".exe")]) {
			if (existsSync(candidate)) return candidate;
		}
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
	// The installers put the client in `$DSH_HOME/bin` (the same place the
	// binary's own installer mode writes it), so that resolves first.
	const homeBin = join(resolveDshHome(), "bin", process.platform === "win32" ? "dsh-desktop-shell.exe" : "dsh-desktop-shell");
	if (existsSync(homeBin)) return homeBin;
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

	// The preview panel's local-file route: markdown images and local .html
	// pages are served through the harness web server (loopback-only). The
	// effect owns the route's lifetime — it dies with this plugin's fiber.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: DSHD_FILE_PREFIX,
		handler: serveDshdFile
	}), "desktop-shell: local-file preview route");

	// The tray / web surface's own bundled assets (e.g. mermaid.min.js) ride
	// the same loopback-only prefix router.
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: DSHD_ASSET_PREFIX,
		handler: serveDshdAsset
	}), "desktop-shell: bundled static assets route");

	// Agent-lifecycle state for notification translation: the harness emits
	// app-level events the desktop shell mirrors into OS notifications through
	// the client's stdin control channel. The window title is NOT driven from
	// here — it follows the chat open in the web UI (the SPA's
	// `document.title` is mirrored into the native window by the client).
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

	// Mirror agent lifecycle into notifications. All subscriptions are
	// app-level cordis events; listeners are disposed with the plugin.
	const disposeListeners = [];

	/** Human-readable title for an agent: the session title, else the short id. */
	const agentTitle = (id) => {
		const title = titles.get(id);
		if (typeof title === "string" && title !== "") return title;
		return `session ${id}`;
	};

	/**
	 * Push the full snapshot of currently-running agents to the client. The
	 * tray derives its live list from this; sent after every status change
	 * and once shortly after the client spawns.
	 */
	const pushAgentsSnapshot = () => {
		const agents = [];
		for (const [id, isRunning] of running) {
			if (isRunning) agents.push({ id, title: agentTitle(id), status: "running" });
		}
		writeControl({ event: "agents", agents });
	};

	if (typeof ctx.on === "function") {
		disposeListeners.push(ctx.on("agent/status", ({ agent, status }) => {
			const id = agent?.id;
			if (id === void 0) return;
			const wasRunning = running.get(id) ?? false;
			const isRunning = status === "running";
			running.set(id, isRunning);
			// Let the client's tray mirror move: running→idle announces a
			// finished agent (the notify still fires too, both are wanted).
			if (wasRunning && !isRunning) {
				const title = agentTitle(id);
				writeControl({ event: "agent-finished", id, title });
				writeControl({
					event: "notify",
					title: "Agent finished",
					body: title !== `session ${id}`
						? `"${title}" — work complete.`
						: `Session ${id} finished its work.`
				});
			}
			pushAgentsSnapshot();
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
			// stdin is the control pipe into the client (notifications, agent
			// snapshot, log tail); stdout is the control pipe back (the
			// client's `dshdctl:`-prefixed requests), so BOTH are piped. Only
			// stderr is inherited — our reader forwards the client's ordinary
			// stdout to the harness terminal.
			stdio: ["pipe", "pipe", "inherit"]
		});
		// Reader for the client's control-output pipe: `dshdctl:` lines are
		// control requests (JSON after the prefix), everything else is the
		// client's ordinary stdout and is forwarded verbatim, line by line.
		const stdoutReader = child.stdout === null
			? void 0
			: createInterface({ input: child.stdout, crlfDelay: Infinity });

		// Build one formatted log line for the tail, per the protocol spec.
		const formatLogLine = (event) => {
			const type = typeof event?.type === "string" ? event.type : "";
			const data = event?.data;
			const noisy = /^(assistant\/chunk|agent\/inbox\/|request\/|todo\/|compaction\/|session\/title)/.test(type);
			if (noisy) return void 0;
			let text = "";
			if (type === "user/message" || type === "assistant/message") {
				const content = typeof data?.content === "string" ? data.content : "";
				text = content.replace(/\n/g, "⏎").slice(0, 110);
			} else if (type === "tool/call") {
				const args = data?.arguments;
				let hint;
				if (typeof args === "string") hint = args.slice(0, 60);
				else if (args && typeof args === "object") hint = Object.keys(args)[0] ?? "";
				else hint = "";
				text = `${typeof data?.name === "string" ? data.name : ""}${hint === "" ? "" : ` — ${hint}`}`;
			} else if (type === "tool/result") {
				text = typeof data?.status === "string" ? data.status : "done";
			} else if (type === "turn/start") {
				text = `turn ${data?.turn ?? "?"}`;
			} else if (type === "turn/end") {
				text = typeof data?.reason?.kind === "string" ? data.reason.kind : "done";
			} else if (type === "agent/error" || type === "session/error") {
				text = typeof data?.message === "string" ? data.message : (data ? JSON.stringify(data) : "");
			} else {
				text = data === void 0 ? "" : JSON.stringify(data).slice(0, 60);
			}
			if (text === "") return void 0;
			const time = typeof event.time === "number" && Number.isFinite(event.time)
				? new Date(event.time) : new Date();
			const hh = String(time.getHours()).padStart(2, "0");
			const mm = String(time.getMinutes()).padStart(2, "0");
			const ss = String(time.getSeconds()).padStart(2, "0");
			const line = `[${hh}:${mm}:${ss}] ${type} — ${text}`;
			return line.length > 140 ? line.slice(0, 140) : line;
		};

		// Look up the live agent for a control request.
		const liveAgent = (id) => {
			const agents = ctx.get("agents");
			const list = agents?.list ? agents.list() : void 0;
			if (!Array.isArray(list)) return void 0;
			return list.find((agent) => agent?.id === id);
		};

		// Handle one `dshdctl:` request from the client.
		const onControl = (payload) => {
			const event = payload?.event;
			if (event === "stop-agent") {
				const id = payload?.id;
				if (typeof id !== "string") return;
				const agent = liveAgent(id);
				if (agent === void 0) {
					ctx.logger.info(`desktop-shell: stop requested for ${id}, but the agent is not running`);
					return;
				}
				try {
					agent.cancel({ kind: "user" });
					ctx.logger.info(`desktop-shell: stop requested for ${id}`);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error ?? "unknown error");
					ctx.logger.warn(`desktop-shell: failed to stop ${id}: ${message}`);
				}
			} else if (event === "get-log") {
				const id = payload?.id;
				if (typeof id !== "string") return;
				const agent = liveAgent(id);
				if (agent === void 0) {
					writeControl({ event: "agent-log", id, lines: ["agent is not running"] });
					return;
				}
				const events = agent.session?.events;
				if (!Array.isArray(events)) {
					writeControl({ event: "agent-log", id, lines: [] });
					return;
				}
				const lines = events.slice(-40).map(formatLogLine).filter((line) => line !== void 0);
				writeControl({ event: "agent-log", id, lines });
			}
		};

		if (stdoutReader !== void 0) {
			stdoutReader.on("line", (line) => {
				if (line.startsWith("dshdctl:")) {
					try {
						onControl(JSON.parse(line.slice("dshdctl:".length)));
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.logger.warn(`desktop-shell: bad control line from client: ${message}`);
					}
				} else {
					process.stdout.write(line + "\n");
				}
			});
			// A dead client's reader never closes cleanly by itself; let the
			// child's own exit event own the teardown, and just silence errors.
			stdoutReader.on("error", (error) => {
				ctx.logger.warn(`desktop-shell: client stdout reader: ${error.message}`);
			});
		}

		// Once, shortly after the client spawns, seed it with the agents that
		// are already running (independently of any later status event).
		setTimeout(() => {
			if (child === void 0 || child.exitCode !== null) return;
			pushAgentsSnapshot();
		}, 600);
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
			} else if (code === 11) {
				// The client applied a one-click update and asks for a
				// restart: boot a fresh profile (it spawns the updated
				// client), then shut the old harness down.
				console.log("dsh desktop: update applied; restarting the profile");
				ctx.logger.info("desktop-shell: update applied; restarting");
				setTimeout(() => {
					try {
						relaunchProfile();
					} catch (error) {
						console.error(`dsh desktop: cannot restart the profile: ${error.message}`);
						ctx.logger.error(`desktop-shell: cannot restart the profile: ${error.message}`);
					}
					if (exit !== void 0) exit(0);
				}, 1500);
			} else {
				console.error(`dsh desktop: client exited with code ${code}; keeping the web surface at ${url}`);
				ctx.logger.warn(`desktop-shell: client exited with code ${code}`);
			}
		});
	};
	// One-click update restart: resolve the `dsh` CLI exactly like the
	// launcher script does (DSH_DESKTOP_DSH → DSH_BIN → PATH → known paths)
	// and boot the profile detached; the fresh harness spawns the new client.
	const relaunchProfile = () => {
		const candidates = [
			process.env.DSH_DESKTOP_DSH,
			process.env.DSH_BIN,
			"dsh"
		].filter((value) => typeof value === "string" && value.trim() !== "");
		if (candidates.length === 0) throw new Error("no dsh CLI found");
		const profile = spawn(candidates[0], ["--profile", "desktop"], {
			env: { ...process.env, DSH_HOME: resolveDshHome() },
			stdio: "ignore",
			detached: true
		});
		profile.unref();
	};
	if (settled === void 0) open();
	else settled.then(open, () => {});
}

export { Config, apply, inject, name };
