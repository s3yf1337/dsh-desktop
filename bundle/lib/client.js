window.__ModuleLoader__.load({
	id: "dsh-desktop-shell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region shared
		/**
		* dsh-desktop browser half: the custom window title bar (fully replaces
		* the native one — the shell window is frameless), the right-hand
		* explorer panel (Files / Preview tabs, like Hermes Agent, one at a
		* time, hideable), and the "dsh-desktop" settings section.
		*
		* Everything desktop-specific is driven through `window.__TAURI__`
		* commands; in a plain browser these surfaces degrade to a notice
		* instead of dead controls.
		*/
		const { createElement: h, useState, useEffect, useCallback, useMemo, useRef } = react;
		const {
			Button,
			IconDownloadOutline16,
			IconRefreshOutline14,
			IconGlobeOutline14,
			IconSettingsOutline16,
			IconFolderOpenOutline16,
			IconFolderOpen16,
			IconChevronLeftOutline14,
			IconChevronRightOutline14,
			IconCloseOutline16,
			IconCodeOutline16,
			IconDataOutline16,
			IconSearchOutline16,
			IconPanelLeftOutline16,
			Menu,
			Modal,
			writeClipboard,
			IconPlusOutline16,
			IconCheckOutline14,
			IconCopyOutline16,
			IconTrashOutline16,
			IconEditOutline16,
			IconChevronUpOutline14,
			IconPaperclipOutline16,
			IconRightUpOutline14,
			IconLinkOutline16,
			IconSendOutline14,
			IconFolderClose16
		} = _deepseek_ai_dsh_client_ui_primitives;

		const NS = "desktopShell";
		// Declared services: cordis' tracker proxy throws on any ctx access to
		// an undeclared service, so every service the panel touches at render
		// time (workspaces, sessions, conversation) must be listed here.
		const inject = ["slots", "workspaces", "sessions", "conversation"];

		const STATE_EVENT = "desktop://state";
		const UPDATE_PROGRESS_EVENT = "desktop://update-progress";
		const TITLE_EVENT = "desktop://title";

		/** Height of the custom title bar (kept in sync with the CSS). */
		const TITLEBAR_HEIGHT = 40;

		/** True when running inside the native window (tauri injected). */
		function hasTauri() {
			return typeof window !== "undefined" && window.__TAURI__ !== void 0 && window.__TAURI__.core !== void 0;
		}

		/** True when running on macOS (traffic-light-style controls). */
		function isMac() {
			return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
		}

		/** Explorer panel geometry (min/default/max width, like the app's own
		* sidebar/details columns which clamp into a contract range). */
		const EXPLORER_MIN_WIDTH = 260;
		const EXPLORER_DEFAULT_WIDTH = 340;
		const EXPLORER_MAX_WIDTH = 560;

		/** Shared explorer panel state (the DOM title bar and the React panel
		* communicate through this tiny store). */
		const explorerStore = {
			open: false,
			tab: "files",
			width: EXPLORER_DEFAULT_WIDTH,
			/** Active workspace-pick flow: {onPicked, onCancel, onError} (set by
			* the harness directory-flow occupants or the settings tab). Non-null
			* switches the panel into "choose a folder" mode. */
			pick: null,
			listeners: new Set(),
			init() {
				if (typeof localStorage === "undefined") return;
				this.open = localStorage.getItem("dshd.explorer.open") === "1";
				this.tab = localStorage.getItem("dshd.explorer.tab") === "preview" ? "preview" : "files";
				const saved = Number(localStorage.getItem("dshd.explorer.width") || 0);
				if (saved >= EXPLORER_MIN_WIDTH && saved <= EXPLORER_MAX_WIDTH) this.width = saved;
			},
			setOpen(open) {
				this.open = !!open;
				try {
					if (typeof localStorage !== "undefined") localStorage.setItem("dshd.explorer.open", this.open ? "1" : "0");
				} catch {
					// storage may be unavailable/full — the toggle must still work
				}
				// Closing the panel while a pick flow is active cancels it.
				if (!this.open && this.pick !== null) {
					const owner = this.pick;
					this.pick = null;
					this.notify();
					if (typeof owner.onCancel === "function") owner.onCancel();
					return;
				}
				this.notify();
			},
			/** Enter pick mode (or replace the current flow owner). */
			setPick(owner) {
				this.pick = owner || null;
				this.notify();
			},
			/** Leave pick mode without notifying the flow owner. */
			clearPick() {
				if (this.pick === null) return;
				this.pick = null;
				this.notify();
			},
			toggle() {
				this.setOpen(!this.open);
			},
			setTab(tab) {
				this.tab = tab;
				try {
					if (typeof localStorage !== "undefined") localStorage.setItem("dshd.explorer.tab", tab);
				} catch {
					// best-effort persistence
				}
				this.notify();
			},
			setWidth(width) {
				const clamped = Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, width));
				this.width = clamped;
				try {
					if (typeof localStorage !== "undefined") localStorage.setItem("dshd.explorer.width", String(clamped));
				} catch {
					// best-effort persistence
				}
				this.notify();
			},
			subscribe(fn) {
				this.listeners.add(fn);
				return () => this.listeners.delete(fn);
			},
			notify() {
				for (const fn of [...this.listeners]) {
					try {
						fn();
					} catch (error) {
						console.error("dsh-desktop: explorer store listener failed:", error);
					}
				}
			}
		};

		/** The app's layout frame: the grid element whose columns the sidebar
		* and details panels live in (found via the shell-overlay layer, which
		* is its direct child). */
		function frameElement() {
			if (typeof document === "undefined") return null;
			const overlay = document.querySelector("[data-shell-overlay]");
			return overlay && overlay.parentElement ? overlay.parentElement : null;
		}

		/** Reserve `width` px on the right of the frame for the docked explorer
		* panel (0 closes it). The frame already animates grid-template-columns;
		* padding-right joins that transition, so the main content slides with
		* the same easing as the app's own sidebar/details columns. */
		function syncExplorerLayout(width) {
			const frame = frameElement();
			if (!frame) return;
			frame.style.paddingRight = `${width}px`;
			frame.style.transition =
				"grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out), " +
				"padding-right var(--ds-transition-duration-slow) var(--ds-ease-in-out)";
		}
		//#endregion

		//#region custom title bar (plain DOM, fixed to the viewport top)
		const TITLEBAR_CSS = `
#dshd-titlebar{position:fixed;top:0;left:0;right:0;height:${TITLEBAR_HEIGHT}px;z-index:9999;display:flex;align-items:center;justify-content:space-between;background:var(--dsw-alias-bg-base);border-bottom:1px solid var(--dsw-alias-border-l1);-webkit-app-region:drag;user-select:none;font-family:var(--dsw-font-family)}
#dshd-titlebar .dshd-left{display:flex;align-items:center;gap:8px;padding-left:12px;min-width:0;height:100%}
#dshd-titlebar .dshd-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1}
#dshd-titlebar .dshd-actions{display:flex;align-items:center;height:100%;-webkit-app-region:no-drag}
#dshd-titlebar button{-webkit-app-region:no-drag;border:none;background:transparent;width:44px;height:100%;display:grid;place-items:center;cursor:default;color:var(--dsw-alias-label-secondary);padding:0}
#dshd-titlebar button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
#dshd-titlebar button.dshd-close:hover{background:var(--dsw-static-red-600);color:#fff}
#dshd-titlebar button svg{display:block}
body.dshd-frameless #root{padding-top:${TITLEBAR_HEIGHT}px;box-sizing:border-box}
#dshd-resize-e{position:fixed;top:${TITLEBAR_HEIGHT}px;right:0;bottom:0;width:5px;z-index:9998;cursor:ew-resize}
#dshd-resize-w{position:fixed;top:${TITLEBAR_HEIGHT}px;left:0;bottom:0;width:5px;z-index:9998;cursor:ew-resize}
#dshd-resize-n{position:fixed;top:0;left:0;right:0;height:5px;z-index:9998;cursor:ns-resize}
#dshd-resize-s{position:fixed;left:0;right:0;bottom:0;height:5px;z-index:9998;cursor:ns-resize}
#dshd-resize-ne{position:fixed;top:0;right:0;width:9px;height:9px;z-index:9999;cursor:nesw-resize}
#dshd-resize-nw{position:fixed;top:0;left:0;width:9px;height:9px;z-index:9999;cursor:nwse-resize}
#dshd-resize-se{position:fixed;right:0;bottom:0;width:9px;height:9px;z-index:9999;cursor:nwse-resize}
#dshd-resize-sw{position:fixed;left:0;bottom:0;width:9px;height:9px;z-index:9999;cursor:nesw-resize}
/* Explorer panel resize handle: an 8px strip on the panel's left edge with
   a floating pill on hover, same visual language as the app's own column
   drag handles. */
#dshd-explorer-resize{position:absolute;left:-4px;top:0;bottom:0;width:8px;cursor:col-resize;touch-action:none;z-index:3}
#dshd-explorer-resize:after{content:"";box-sizing:border-box;background:var(--dsw-alias-button-floating-fill);border:1px solid var(--dsw-alias-border-l2-darkmode-thin);opacity:0;width:12px;height:32px;transition:opacity var(--ds-transition-duration-slow) var(--ds-ease-in-out),background var(--ds-transition-duration-slow) var(--ds-ease-in-out);border-radius:10px;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}
#dshd-explorer-resize:hover:after,#dshd-explorer-resize.dragging:after{opacity:1}
#dshd-explorer-resize:hover:after,#dshd-explorer-resize.dragging:after{background:var(--dsw-alias-button-floating-hover);border-color:var(--dsw-alias-border-l3)}
body.dshd-resizing{user-select:none;cursor:col-resize}
/* Explorer panel: the app sidebar's visual language (fill, rows, round icon
   buttons) + its open animations: content fades in (wide-in) while the
   panel width grows with the same transition tokens as the grid columns. */
@keyframes dshd-explorer-in{0%{opacity:0}}
.dshd-explorer-panel{animation:dshd-explorer-in .2s var(--ds-ease-in-out)}
.dshd-explorer-panel .dshd-tab:hover,.dshd-explorer-panel .dshd-round:hover,.dshd-explorer-panel .dshd-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dshd-explorer-panel .dshd-scroll{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.dshd-explorer-panel ::-webkit-scrollbar{width:var(--dsh-scrollbar-width,8px)}
.dshd-explorer-panel ::-webkit-scrollbar-thumb{background:var(--dsh-scrollbar-thumb);border-radius:4px}
.dshd-explorer-panel ::-webkit-scrollbar-thumb:hover{background:var(--dsh-scrollbar-thumb-hover)}
@media (prefers-reduced-motion:reduce){.dshd-explorer-panel{animation:none}}
`;

		function svgIcon(path, size = 12) {
			const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
			el.setAttribute("width", size);
			el.setAttribute("height", size);
			el.setAttribute("viewBox", "0 0 16 16");
			el.setAttribute("fill", "none");
			el.setAttribute("stroke", "currentColor");
			el.setAttribute("stroke-width", "1.2");
			el.setAttribute("stroke-linecap", "round");
			el.innerHTML = path;
			return el;
		}

		/** Self-heal watchdog: when the store says the explorer panel should
		* be open but no panel element exists for a while, the panel's slot
		* entry has crashed (the app's slot boundary removes it silently).
		* The harness runs server-side, so a webview reload restores the
		* whole client surface without losing session state. */
		function installPanelWatchdog() {
			if (typeof document === "undefined" || typeof window === "undefined") return;
			let misses = 0;
			window.setInterval(() => {
				try {
					if (!explorerStore.open) {
						misses = 0;
						return;
					}
					if (document.querySelector("[data-dshd-explorer]")) {
						misses = 0;
						return;
					}
					misses += 1;
					if (misses >= 10) {
						console.error("dsh-desktop: explorer panel vanished while open — reloading the webview to recover");
						window.location.reload();
					}
				} catch {
					// the watchdog itself must never throw
				}
			}, 1000);
		}

		/** Surface webview runtime errors on screen (small fixed badge) so a
		* silent failure is never invisible again. Shows the message of any
		* uncaught error / unhandled rejection; disappears on reload. */
		function installErrorBadge() {
			if (typeof document === "undefined" || document.getElementById("dshd-error-badge")) return;
			const badge = document.createElement("div");
			badge.id = "dshd-error-badge";
			badge.style.cssText =
				"position:fixed;left:8px;bottom:8px;z-index:99999;max-width:70vw;background:#e5484d;color:#fff;" +
				"font:12px/1.5 ui-monospace,monospace;padding:6px 10px;border-radius:8px;white-space:pre-wrap;" +
				"word-break:break-word;display:none;box-shadow:0 4px 16px rgba(0,0,0,.35)";
			document.body.appendChild(badge);
			const show = (text) => {
				badge.textContent = text;
				badge.style.display = "block";
			};
			window.addEventListener("error", (event) => {
				show(`dsh-desktop error: ${event.message || String(event.error)}
@ ${(event.filename || "").split("/").pop()}:${event.lineno}`);
			});
			window.addEventListener("unhandledrejection", (event) => {
				const reason = event.reason;
				show(`dsh-desktop unhandled: ${reason && reason.message ? reason.message : String(reason)}`);
			});
			// Render errors inside the app's slot boundaries never reach
			// window.onerror (React error boundaries swallow them) — they only
			// land in console.error, so mirror that into the badge too.
			const originalError = console.error;
			console.error = (...args) => {
				try {
					originalError.apply(console, args);
				} catch {
					// the console itself failing must not break the app
				}
				try {
					const text = args.map((arg) => (arg instanceof Error ? arg.message : typeof arg === "string" ? arg : arg && arg.message ? arg.message : String(arg))).join(" ");
					if (text) show(`dsh-desktop console.error: ${text.slice(0, 500)}`);
				} catch {
					// badge itself must never throw
				}
			};
		}

		/** Mount the title bar + window controls + resize edges (native only). */
		function installTitlebar() {
			if (!hasTauri() || typeof document === "undefined" || document.getElementById("dshd-titlebar")) return;
			// Icons are created here (they need the DOM; also keeps the module
			// loadable in DOM-less environments).
			const ICON_MIN = svgIcon(`<line x1="3" y1="8" x2="13" y2="8"/>`);
			const ICON_MAX = svgIcon(`<rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.4"/>`);
			const ICON_RESTORE = svgIcon(`<rect x="3.4" y="5.6" width="7" height="7" rx="1.2"/><path d="M6 4.6V3.8c0-.8.6-1.4 1.4-1.4h4.8c.8 0 1.4.6 1.4 1.4v4.8c0 .8-.6 1.4-1.4 1.4h-.8"/>`);
			const ICON_CLOSE = svgIcon(`<path d="M4 4l8 8M12 4l-8 8"/>`);
			const ICON_FOLDER = svgIcon(`<path d="M2.4 4.4c0-.8.6-1.4 1.4-1.4h2.2l1.5 1.6h4.7c.8 0 1.4.6 1.4 1.4v5.6c0 .8-.6 1.4-1.4 1.4H3.8c-.8 0-1.4-.6-1.4-1.4V4.4z"/>`, 13);
			const style = document.createElement("style");
			style.textContent = TITLEBAR_CSS;
			document.head.appendChild(style);
			document.body.classList.add("dshd-frameless");

			const bar = document.createElement("div");
			bar.id = "dshd-titlebar";
			bar.setAttribute("data-tauri-drag-region", "");
			bar.innerHTML = `
				<div class="dshd-left">
					<div class="dshd-title">DeepSeek Harness</div>
				</div>
				<div class="dshd-actions"></div>`;
			document.body.appendChild(bar);

			const actions = bar.querySelector(".dshd-actions");
			const stopDrag = (event) => {
				event.stopPropagation();
			};
			const mkButton = (icon, title, onClick, extraClass) => {
				const button = document.createElement("button");
				button.type = "button";
				button.title = title;
				button.className = extraClass || "";
				button.appendChild(icon.cloneNode(true));
				button.addEventListener("mousedown", stopDrag);
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					onClick();
				});
				return button;
			};

			const win = () => window.__TAURI__.window.getCurrentWindow();

			// Explorer panel toggle (file manager / preview).
			const explorerButton = mkButton(ICON_FOLDER, "File manager & preview", () => explorerStore.toggle());
			explorerButton.style.opacity = explorerStore.open ? "1" : "0.72";
			explorerStore.subscribe(() => {
				explorerButton.style.opacity = explorerStore.open ? "1" : "0.72";
			});

			// macOS: traffic-light-style controls on the left, explorer on the
			// right; Windows/Linux: everything on the right.
			const makeMacButton = (color, icon, title, onClick) => {
				const button = document.createElement("button");
				button.type = "button";
				button.title = title;
				button.style.width = "14px";
				button.style.height = "14px";
				button.style.borderRadius = "50%";
				button.style.margin = "0 4px";
				button.style.background = color;
				button.style.color = "rgba(0,0,0,.55)";
				button.style.fontSize = "9px";
				button.style.lineHeight = "14px";
				button.style.display = "grid";
				button.style.placeItems = "center";
				button.style.opacity = "0.9";
				button.appendChild(icon.cloneNode(true));
				button.addEventListener("mousedown", stopDrag);
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					onClick();
				});
				return button;
			};

			const minButton = mkButton(ICON_MIN, "Minimize", () => win().minimize());
			const maxButton = mkButton(ICON_MAX, "Maximize", () => win().toggleMaximize(), "dshd-max");
			const closeButton = mkButton(ICON_CLOSE, "Close", () => win().close(), "dshd-close");

			const refreshMaxIcon = () => {
				win()
					.isMaximized()
					.then((maximized) => {
						maxButton.replaceChildren(maximized ? ICON_RESTORE.cloneNode(true) : ICON_MAX.cloneNode(true));
						maxButton.title = maximized ? "Restore" : "Maximize";
					})
					.catch(() => {});
			};
			refreshMaxIcon();
			window.__TAURI__.event
				.listen("tauri://resize", refreshMaxIcon)
				.catch(() => {});

			if (isMac()) {
				const left = bar.querySelector(".dshd-left");
				const macButtons = document.createElement("div");
				macButtons.className = "dshd-mac";
				macButtons.style.cssText = "display:flex;align-items:center;gap:0;margin-right:10px;-webkit-app-region:no-drag";
				macButtons.appendChild(makeMacButton("#ff5f57", ICON_CLOSE.cloneNode(true), "Close", () => win().close()));
				macButtons.appendChild(makeMacButton("#febc2e", svgIcon(`<line x1="5" y1="8" x2="11" y2="8"/>`), "Minimize", () => win().minimize()));
				macButtons.appendChild(makeMacButton("#28c840", ICON_MAX.cloneNode(true), "Zoom", () => win().toggleMaximize()));
				left.prepend(macButtons);
				left.appendChild(explorerButton);
				actions.appendChild(maxButton);
			} else {
				actions.appendChild(explorerButton);
				actions.appendChild(minButton);
				actions.appendChild(maxButton);
				actions.appendChild(closeButton);
			}

			// Double-click the empty bar area toggles maximize (native habit).
			bar.addEventListener("dblclick", (event) => {
				if (event.target.closest("button")) return;
				win().toggleMaximize();
			});

			// Session title (mirrored from the native window title).
			window.__TAURI__.event
				.listen(TITLE_EVENT, (event) => {
					const node = bar.querySelector(".dshd-title");
					if (node) node.textContent = typeof event.payload === "string" && event.payload ? event.payload : "DeepSeek Harness";
				})
				.catch(() => {});

			// Resize edges (frameless windows have no native borders).
			const edge = (id, direction) => {
				const el = document.createElement("div");
				el.id = id;
				el.addEventListener("mousedown", (event) => {
					event.preventDefault();
					event.stopPropagation();
					win().startResizeDragging(direction).catch(() => {});
				});
				document.body.appendChild(el);
			};
			edge("dshd-resize-e", "East");
			edge("dshd-resize-w", "West");
			edge("dshd-resize-n", "North");
			edge("dshd-resize-s", "South");
			edge("dshd-resize-ne", "NorthEast");
			edge("dshd-resize-nw", "NorthWest");
			edge("dshd-resize-se", "SouthEast");
			edge("dshd-resize-sw", "SouthWest");
		}
		//#endregion

		//#region explorer panel (Files / Preview tabs, right-hand, hideable)
		function formatSize(bytes) {
			if (bytes === void 0 || bytes === null) return "";
			if (bytes < 1024) return `${bytes} B`;
			if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
			if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
			return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
		}

		function formatTime(ms) {
			if (!ms) return "";
			const date = new Date(ms);
			const now = new Date();
			const sameDay = date.toDateString() === now.toDateString();
			return sameDay
				? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
				: date.toLocaleDateString([], { month: "short", day: "numeric" });
		}

		// ── small path helpers (paths stay opaque native strings; only the
		//    last segment and the separator-joined prefix are ever derived) ──
		function joinPath(dir, name) {
			if (!dir) return name;
			return dir.endsWith("/") || dir.endsWith("\\") ? dir + name : dir + "/" + name;
		}

		function baseName(path) {
			const parts = String(path || "").split(/[\\/]/);
			return parts[parts.length - 1] || "";
		}

		function pathSegments(path) {
			const raw = String(path || "");
			if (raw === "") return [];
			const parts = raw.split(/[\\/]/).filter((part) => part !== "");
			const out = [];
			let acc = raw.startsWith("/") ? "/" : "";
			for (const part of parts) {
				acc = acc === "" ? part : acc === "/" ? "/" + part : acc + "/" + part;
				out.push({ name: part, path: acc });
			}
			return out;
		}

		function isImageName(name) {
			return /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i.test(name || "");
		}

		function errText(caught) {
			return caught && typeof caught === "object" && caught.message ? caught.message : String(caught);
		}

		/** The path of `path` relative to `root`, when it lives inside `root`. */
		function relativeTo(root, path) {
			const r = String(root || "").replace(/[\\/]+$/, "");
			const p = String(path || "");
			if (r !== "" && p.startsWith(r + "/")) return p.slice(r.length + 1);
			if (r !== "" && p.startsWith(r + "\\")) return p.slice(r.length + 1);
			return p;
		}

		// ── composer bridge (А): the panel writes into the active session's
		//    draft through the sessions store's input standard-kit, which
		//    ui-conversation publishes per session as `props.inputActions`
		//    (setDraft/addImages/…) and `hooks.input` (the live input state). ──
		function composerSession(sessions) {
			// The input standard-kit of the current session is published on
			// `sessions.currentProvideInfo` (a snapshot store of
			// {sessionId, hooks: {input}, props: {inputActions}}).
			if (!sessions || typeof sessions.currentProvideInfo?.getSnapshot !== "function") return null;
			let info = null;
			try {
				info = sessions.currentProvideInfo.getSnapshot();
			} catch {
				return null;
			}
			const actions = info?.props?.inputActions;
			const inputState = info?.hooks?.input;
			if (!actions || typeof actions.setDraft !== "function") return null;
			return { sessionId: info?.sessionId, actions, inputState };
		}

		function focusComposer() {
			if (typeof document === "undefined") return;
			const seat = document.querySelector("[data-composer-seat]");
			const editable = seat?.querySelector('[contenteditable="true"], textarea, input:not([type="hidden"])');
			if (editable && typeof editable.focus === "function") editable.focus();
		}

		/** Append `path` to the active session's draft. Returns false when no
		* composer is available. */
		function insertPathIntoComposer(sessions, path) {
			const session = composerSession(sessions);
			if (!session) return false;
			let draft = "";
			try {
				draft = session.inputState?.getSnapshot()?.draft ?? "";
			} catch {
				// no live state — the path alone still lands in the draft
			}
			const sep = draft && !draft.endsWith(" ") && !draft.endsWith("\n") ? " " : "";
			session.actions.setDraft(draft + sep + path);
			focusComposer();
			return true;
		}

		function base64ToBytes(base64) {
			if (typeof atob !== "function") return null;
			const bin = atob(base64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return bytes;
		}

		/** Read an image natively and add it to the active session's draft
		* images. Returns false when no composer or readable image exists. */
		async function attachImageToComposer(sessions, conversation, path, name) {
			if (!conversation || typeof conversation.createDraftImages !== "function") return false;
			const session = composerSession(sessions);
			if (!session) return false;
			let content;
			try {
				content = await window.__TAURI__.core.invoke("desktop_read_file", { path });
			} catch {
				return false;
			}
			if (!content || content.encoding !== "base64") return false;
			const bytes = base64ToBytes(content.content);
			if (bytes === null) return false;
			let file;
			try {
				file = new File([bytes], name, { type: content.mime || "image/png" });
			} catch {
				return false;
			}
			try {
				const ids = conversation.createDraftImages([file]).map((attachment) => attachment.id);
				return session.actions.addImages(ids);
			} catch {
				return false;
			}
		}

		/** The right-hand explorer panel: docked right, Files/Preview tabs, a
		* context-menu-driven file manager over the native fs commands, and a
		* "pick a folder" mode that serves as the harness's workspace picker.
		* The panel is deliberately action-on-the-file: a right-click menu plus
		* keyboard shortcuts, with only three persistent toolbar controls
		* (back, search, new) beyond the path bar. */
		function ExplorerPanel({ workspaces, sessions, conversation, close }) {
			const [open, setOpen] = useState(explorerStore.open);
			const [tab, setTab] = useState(explorerStore.tab);
			const [cwd, setCwd] = useState(null);
			const [entries, setEntries] = useState(null);
			const [error, setError] = useState(null);
			const [preview, setPreview] = useState(null);
			const [previewError, setPreviewError] = useState(null);
			const [busy, setBusy] = useState(false);
			const panelRef = useRef(null);
			// The panel stays mounted for one transition after closing, so the
			// docked space animates shut with the content instead of popping.
			const [rendered, setRendered] = useState(explorerStore.open);
			// ── v2 state ──
			const [picking, setPicking] = useState(explorerStore.pick !== null);
			const [menu, setMenu] = useState(null);            // {x, y, entry|null}
			const [selected, setSelected] = useState(null);    // entry path
			const [renaming, setRenaming] = useState(null);    // {path, name, is_dir}
			const [creating, setCreating] = useState(null);    // {kind, name}
			const [filterOpen, setFilterOpen] = useState(false);
			const [filter, setFilter] = useState("");
			const [search, setSearch] = useState(null);        // {query, items}
			const [confirmDelete, setConfirmDelete] = useState(null);
			const [history, setHistory] = useState([]);
			const [histIndex, setHistIndex] = useState(-1);
			const [prevSnapshot, setPrevSnapshot] = useState(null); // Map path → {m, s}
			const [sort, setSort] = useState(() => {
				try {
					return localStorage.getItem("dshd.explorer.sort") || "name";
				} catch {
					return "name";
				}
			});
			const [showHidden, setShowHidden] = useState(() => {
				try {
					return localStorage.getItem("dshd.explorer.hidden") === "1";
				} catch {
					return false;
				}
			});
			const [clip, setClip] = useState(null);            // {op, paths}
			const [chipOpen, setChipOpen] = useState(false);
			const [chipRect, setChipRect] = useState(null);
			const scrollRef = useRef(null);
			const filterRef = useRef(null);
			const crumbScrollRef = useRef(null);
			// Poll-loop mirrors (the interval must not re-arm per keystroke).
			const busyRef = useRef(false); busyRef.current = busy;
			const cwdRef = useRef(null); cwdRef.current = cwd;
			const menuRef = useRef(null); menuRef.current = menu;
			const renamingRef = useRef(null); renamingRef.current = renaming;
			const creatingRef = useRef(null); creatingRef.current = creating;
			const searchRef = useRef(null); searchRef.current = search;
			const prevRef = useRef(null); prevRef.current = prevSnapshot;
			// Sequence guards against stale async responses overwriting fresher
			// state (live refresh racing navigation, and previews overwriting later previews).
			const loadSeqRef = useRef(0);
			const previewSeqRef = useRef(0);

			useEffect(() => explorerStore.subscribe(() => {
				setOpen(explorerStore.open);
				setTab(explorerStore.tab);
				setPicking(explorerStore.pick !== null);
			}), []);

			// Dock/un-dock: the panel width lives in React state (never in
			// imperative DOM mutations — a ref race between the open effect
			// and the first render of the panel element used to strand the
			// width at 0), and the CSS transition animates the change. The
			// frame's reserved space joins the same transition tokens.
			const [panelWidth, setPanelWidth] = useState(0);
			const [dragging, setDragging] = useState(false);
			useEffect(() => {
				if (open) {
					setRendered(true);
					syncExplorerLayout(explorerStore.width);
					const raf = requestAnimationFrame(() => setPanelWidth(explorerStore.width));
					return () => cancelAnimationFrame(raf);
				}
				setPanelWidth(0);
				syncExplorerLayout(0);
				const timer = setTimeout(() => setRendered(false), 360);
				return () => clearTimeout(timer);
			}, [open]);

			// Resize: drag the handle → live-update the panel width + frame
			// padding during the drag (transition off while dragging), commit
			// to the store on release.
			const startResize = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const handle = event.currentTarget;
				const startX = event.clientX;
				const startWidth = explorerStore.width;
				let lastWidth = startWidth;
				handle.classList.add("dragging");
				document.body.classList.add("dshd-resizing");
				setDragging(true);
				const onMove = (moveEvent) => {
					const next = Math.min(
						EXPLORER_MAX_WIDTH,
						Math.max(EXPLORER_MIN_WIDTH, startWidth + (startX - moveEvent.clientX))
					);
					lastWidth = next;
					setPanelWidth(next);
					syncExplorerLayout(next);
				};
				const onUp = () => {
					handle.classList.remove("dragging");
					document.body.classList.remove("dshd-resizing");
					handle.removeEventListener("pointermove", onMove);
					handle.removeEventListener("pointerup", onUp);
					handle.removeEventListener("pointercancel", onUp);
					setDragging(false);
					explorerStore.setWidth(lastWidth);
				};
				handle.setPointerCapture(event.pointerId);
				handle.addEventListener("pointermove", onMove);
				handle.addEventListener("pointerup", onUp);
				handle.addEventListener("pointercancel", onUp);
			};

			// Initial root: the remembered directory, else the current
			// workspace directory, else home.
			const root = useMemo(() => {
				if (workspaces && typeof workspaces.list === "object" && workspaces.list !== null) {
					try {
						const snapshot = workspaces.list.getSnapshot();
						for (const item of snapshot.items || []) {
							const view = item && typeof item.getSnapshot === "function" ? item.getSnapshot().view : item && item.view;
							if (view && typeof view.path === "string" && view.path !== "") return view.path;
						}
					} catch {
						// fall through to home
					}
				}
				return null;
			}, [workspaces]);

			// The workspace/session snapshots must stay LIVE: the store starts
			// pending (empty) and fills over RPC, so the panel subscribes and
			// re-reads on every change instead of freezing the first read.
			const [storeRev, setStoreRev] = useState(0);
			useEffect(() => {
				if (!workspaces || typeof workspaces.list?.subscribe !== "function") return;
				return workspaces.list.subscribe(() => setStoreRev((rev) => rev + 1));
			}, [workspaces]);
			useEffect(() => {
				if (!sessions || typeof sessions.list?.subscribe !== "function") return;
				return sessions.list.subscribe(() => setStoreRev((rev) => rev + 1));
			}, [sessions]);

			const workspaceSnapshot = useMemo(() => {
				if (!workspaces || typeof workspaces.list?.getSnapshot !== "function") return null;
				try {
					return workspaces.list.getSnapshot();
				} catch {
					return null;
				}
			}, [workspaces, storeRev]);

			const sessionSnapshot = useMemo(() => {
				if (!sessions || typeof sessions.list?.getSnapshot !== "function") return null;
				try {
					return sessions.list.getSnapshot();
				} catch {
					return null;
				}
			}, [sessions, storeRev]);

			const workspaceView = (item) => {
				if (!item) return null;
				try {
					let view = typeof item.getSnapshot === "function" ? item.getSnapshot().view : null;
					if (!view) view = item.view;
					// Browser-view-shaped item: the fields sit on the item itself.
					if (!view && (typeof item.path === "string" || typeof item.workspaceId === "string")) view = item;
					return view && typeof view === "object" ? view : null;
				} catch {
					return null;
				}
			};
			const workspaceTitleOf = (item) => {
				const view = workspaceView(item);
				if (!view) return null;
				if (view.title) return view.title;
				if (item && item.title) return item.title;
				return typeof view.path === "string" && view.path !== "" ? baseName(view.path) : null;
			};
			const workspaceSessionIdsOf = (item) => {
				if (Array.isArray(item?.sessionIds)) return item.sessionIds;
				const view = workspaceView(item);
				return Array.isArray(view?.sessionIds) ? view.sessionIds : [];
			};

			// The workspace the active session belongs to, else the first one.
			const currentWorkspace = useMemo(() => {
				const items = workspaceSnapshot?.items || [];
				if (items.length === 0) return null;
				const current = sessionSnapshot?.current;
				if (current !== void 0) {
					const found = items.find((w) => workspaceSessionIdsOf(w).includes(current));
					if (found) return found;
				}
				return items[0];
			}, [workspaceSnapshot, sessionSnapshot]);

			const currentWorkspacePath = useMemo(() => {
				const view = workspaceView(currentWorkspace);
				return view && typeof view.path === "string" && view.path !== "" ? view.path : null;
			}, [currentWorkspace]);

			const currentWorkspaceTitle = useMemo(() => {
				return workspaceTitleOf(currentWorkspace) || (currentWorkspacePath ? baseName(currentWorkspacePath) : "Workspace");
			}, [currentWorkspace, currentWorkspacePath]);

			const loadDir = useCallback(async (path) => {
				const seq = ++loadSeqRef.current;
				setBusy(true);
				setError(null);
				try {
					const list = await window.__TAURI__.core.invoke("desktop_list_dir", { path });
					// A stale response (a newer loadDir superseded ours) must not
					// overwrite fresher directory state.
					if (seq !== loadSeqRef.current) return false;
					// A fresh directory starts an unmarked baseline; refreshing
					// the same directory marks what changed since last view.
					const prev = path === cwdRef.current ? prevRef.current : null;
					const next = new Map();
					const marked = list.map((entry) => {
						next.set(entry.path, { m: entry.modified_ms, s: entry.size });
						if (!prev) return { ...entry, fresh: false, changed: false };
						const old = prev.get(entry.path);
						if (!old) return { ...entry, fresh: true, changed: false };
						return { ...entry, fresh: false, changed: old.m !== entry.modified_ms || old.s !== entry.size };
					});
					setPrevSnapshot(next);
					setCwd(path);
					setEntries(marked);
					if (path !== cwdRef.current) {
						// Navigating elsewhere: drop the previous search and
						// filter so the newly opened folder is not re-filtered.
						if (searchRef.current) setSearch(null);
						if (filterRef.current) {
							setFilter("");
							setFilterOpen(false);
						}
					}
					try {
						localStorage.setItem("dshd.explorer.root", path);
					} catch {
						// remember-root is best-effort
					}
					return true;
				} catch (caught) {
					setError(errText(caught));
					setEntries(null);
					return false;
				} finally {
					setBusy(false);
				}
			}, []);

			// History-aware navigation (back/forward stack, capped at 100).
			// Right-anchored path: after every directory change (and panel
			// resize) pin the crumb scroll to the right edge, so the current
			// folder stays visible even for long paths; scrolling left
			// reveals the root part.
			useEffect(() => {
				const el = crumbScrollRef.current;
				if (el) el.scrollLeft = el.scrollWidth;
			}, [cwd, panelWidth]);

			const navigate = useCallback((path) => {
				setHistory((hist) => [...hist.slice(0, histIndex + 1), path].slice(-100));
				setHistIndex((index) => Math.min(index + 1, 99));
				loadDir(path);
			}, [histIndex, loadDir]);

			const goBack = useCallback(() => {
				if (histIndex <= 0 || history.length === 0) return;
				const target = history[histIndex - 1];
				setHistIndex(histIndex - 1);
				loadDir(target);
			}, [histIndex, history, loadDir]);

			const goForward = useCallback(() => {
				if (histIndex >= history.length - 1) return;
				const target = history[histIndex + 1];
				setHistIndex(histIndex + 1);
				loadDir(target);
			}, [histIndex, history, loadDir]);

			// (Re)open the panel → load the remembered directory, falling back
			// through the workspace root to home when it is gone.
			useEffect(() => {
				if (!open) return;
				if (cwd !== null) {
					loadDir(cwd);
					return;
				}
				const candidates = [];
				let saved = null;
				try {
					saved = localStorage.getItem("dshd.explorer.root");
				} catch {
					saved = null;
				}
				if (saved !== null && saved !== "") candidates.push(saved);
				if (root !== null) candidates.push(root);
				const tryNext = async (index) => {
					if (index >= candidates.length) {
						setBusy(true);
						try {
							const home = await window.__TAURI__.core.invoke("desktop_home_dir");
							await loadDir(home);
						} catch (caught) {
							setError(errText(caught));
							setBusy(false);
						}
						return;
					}
					const ok = await loadDir(candidates[index]);
					if (!ok) tryNext(index + 1);
				};
				tryNext(0);
			}, [open, root, cwd, loadDir]);

			const openFile = useCallback(async (path, name) => {
				const seq = ++previewSeqRef.current;
				setPreviewError(null);
				setPreview({ path, name, loading: true });
				explorerStore.setTab("preview");
				try {
					const content = await window.__TAURI__.core.invoke("desktop_read_file", { path });
					// A newer preview has superseded this response — drop it so it
					// cannot overwrite the current file's preview.
					if (seq !== previewSeqRef.current) return;
					setPreview({ path, name, loading: false, ...content });
				} catch (caught) {
					if (seq !== previewSeqRef.current) return;
					setPreview({ path, name, loading: false, failed: true, error: errText(caught) });
				}
			}, []);

			const goUp = useCallback(async () => {
				if (!cwd) return;
				try {
					const parent = await window.__TAURI__.core.invoke("desktop_parent_dir", { path: cwd });
					if (typeof parent === "string") navigate(parent);
				} catch (caught) {
					setError(errText(caught));
				}
			}, [cwd, navigate]);

			const run = useCallback(async (command, args) => {
				try {
					await window.__TAURI__.core.invoke(command, args);
				} catch (caught) {
					setError(errText(caught));
				}
			}, []);

			// Live refresh (Г): while the panel shows the file list, quietly
			// re-list the current directory every 2 s and mark what changed.
			useEffect(() => {
				if (!open || picking || tab !== "files") return;
				const timer = setInterval(() => {
					if (typeof document !== "undefined" && document.hidden) return;
					if (busyRef.current || menuRef.current || renamingRef.current || creatingRef.current) return;
					if (cwdRef.current === null) return;
					loadDir(cwdRef.current);
				}, 2000);
				return () => clearInterval(timer);
			}, [open, picking, tab, loadDir]);

			const runSearch = useCallback(async () => {
				const query = filter.trim();
				if (!query || !cwd) return;
				setBusy(true);
				setError(null);
				try {
					const items = await window.__TAURI__.core.invoke("desktop_search_names", { root: cwd, query });
					setSearch({ query, items: Array.isArray(items) ? items : [] });
				} catch (caught) {
					setError(errText(caught));
				} finally {
					setBusy(false);
				}
			}, [filter, cwd]);

			// Focus the filter input when it opens.
			useEffect(() => {
				if (filterOpen) filterRef.current?.focus();
			}, [filterOpen]);

			const commitRenameValue = async (value) => {
				if (!renaming) return;
				const name = value.trim();
				const current = baseName(renaming.path);
				if (!name || name === current) {
					setRenaming(null);
					return;
				}
				try {
					await window.__TAURI__.core.invoke("desktop_rename", { path: renaming.path, newName: name });
					setRenaming(null);
					loadDir(cwd);
				} catch (caught) {
					setError(errText(caught));
				}
			};

			const commitCreateValue = async (value) => {
				if (!creating || !cwd) return;
				const name = value.trim();
				if (!name) {
					setCreating(null);
					return;
				}
				const path = joinPath(cwd, name);
				try {
					if (creating.kind === "dir") {
						await window.__TAURI__.core.invoke("desktop_create_dir", { path });
					} else {
						await window.__TAURI__.core.invoke("desktop_write_file", { path, content: "" });
					}
					setCreating(null);
					loadDir(cwd);
				} catch (caught) {
					setError(errText(caught));
				}
			};

			const commitDelete = async () => {
				if (!confirmDelete) return;
				const entry = confirmDelete;
				setConfirmDelete(null);
				try {
					await window.__TAURI__.core.invoke("desktop_delete", { path: entry.path });
					if (selected === entry.path) setSelected(null);
					loadDir(cwd);
				} catch (caught) {
					setError(errText(caught));
				}
			};

			const pasteInto = useCallback(async (targetDir) => {
				if (!clip || !targetDir) return;
				const op = clip.op;
				setBusy(true);
				setError(null);
				try {
					for (const src of clip.paths) {
						if (op === "cut") {
							await window.__TAURI__.core.invoke("desktop_move", { src, destDir: targetDir });
						} else {
							await window.__TAURI__.core.invoke("desktop_copy", { src, destDir: targetDir });
						}
					}
					if (op === "cut") setClip(null);
					loadDir(targetDir);
				} catch (caught) {
					setError(errText(caught));
				} finally {
					setBusy(false);
				}
			}, [clip, loadDir]);

			// ── pick mode (Е): "Select this folder" completes the flow ──
			const cancelPick = useCallback(() => {
				const owner = explorerStore.pick;
				if (owner && typeof owner.onCancel === "function") owner.onCancel();
				explorerStore.clearPick();
			}, []);

			const selectPick = useCallback(async () => {
				const owner = explorerStore.pick;
				if (!owner || !cwd || busy) return;
				setBusy(true);
				setError(null);
				try {
					await owner.onPicked(cwd);
					explorerStore.clearPick();
					explorerStore.setOpen(false);
				} catch (caught) {
					setError(errText(caught));
				} finally {
					setBusy(false);
				}
			}, [cwd, busy]);

			// ── context menu ──
			const buildMenuItems = (entry) => {
				const items = [];
				if (entry) {
					items.push({ id: "open", label: entry.is_dir ? "Open" : "Preview", icon: h(entry.is_dir ? IconFolderOpen16 : IconCodeOutline16, {}) });
					items.push({ id: "open-ext", label: "Open externally", icon: h(IconRightUpOutline14, {}) });
					items.push({ type: "separator" });
					items.push({ id: "copy-path", label: "Copy path", icon: h(IconLinkOutline16, {}) });
					items.push({ id: "send-path", label: "Send path to agent", icon: h(IconSendOutline14, {}), disabled: !sessions });
					if (!entry.is_dir && isImageName(entry.name)) {
						items.push({ id: "attach-image", label: "Attach to message", icon: h(IconPaperclipOutline16, {}), disabled: !sessions });
					}
					items.push({ type: "separator" });
					items.push({ id: "copy", label: "Copy", icon: h(IconCopyOutline16, {}) });
					items.push({ id: "cut", label: "Cut" });
					if (clip) {
						items.push({ id: "paste", label: "Paste here" });
					}
					items.push({ type: "separator" });
					items.push({ id: "rename", label: "Rename", icon: h(IconEditOutline16, {}) });
					items.push({ id: "delete", label: "Move to trash", icon: h(IconTrashOutline16, {}) });
				} else {
					items.push({ id: "new-file", label: "New file", icon: h(IconPlusOutline16, {}) });
					items.push({ id: "new-folder", label: "New folder", icon: h(IconFolderOpenOutline16, {}) });
					items.push({ type: "separator" });
					items.push({ id: "sort-name", label: "Sort by name" });
					items.push({ id: "sort-size", label: "Sort by size" });
					items.push({ id: "sort-date", label: "Sort by date" });
					items.push({ id: "toggle-hidden", label: "Show hidden files", icon: showHidden ? h(IconCheckOutline14, {}) : void 0 });
					if (clip) {
						items.push({ id: "paste", label: `Paste into ${baseName(cwd)}` });
					}
					items.push({ type: "separator" });
					items.push({ id: "refresh", label: "Refresh", icon: h(IconRefreshOutline14, {}) });
				}
				return items;
			};

			const openMenuAt = (event, entry) => {
				event.preventDefault();
				event.stopPropagation();
				setMenu({ x: event.clientX, y: event.clientY, entry });
			};

			// A real DOMRect-shaped anchor (left/top/right/bottom): the Menu
			// placement reads r.right/r.bottom — a rect without them yields a
			// NaN top and the list falls back to the top of the viewport.
			const menuAnchorRect = useCallback(() => {
				if (menu === null) return null;
				return { left: menu.x, top: menu.y, right: menu.x, bottom: menu.y, width: 0, height: 0 };
			}, [menu]);

			const handleMenu = (id, entry) => {
				switch (id) {
					case "open":
						if (entry.is_dir) navigate(entry.path);
						else openFile(entry.path, entry.name);
						break;
					case "open-ext":
						run("desktop_open_path", { path: entry.path });
						break;
					case "copy-path":
						writeClipboard(entry.path);
						break;
					case "send-path":
						if (!insertPathIntoComposer(sessions, relativeTo(currentWorkspacePath, entry.path))) {
							setError("No active conversation to insert the path into.");
						}
						break;
					case "attach-image":
						attachImageToComposer(sessions, conversation, entry.path, entry.name).then((ok) => {
							if (!ok) setError("Cannot attach the image: no active conversation or unreadable file.");
						});
						break;
					case "copy":
						setClip({ op: "copy", paths: [entry.path] });
						break;
					case "cut":
						setClip({ op: "cut", paths: [entry.path] });
						break;
					case "paste":
						pasteInto(entry && entry.is_dir ? entry.path : cwd);
						break;
					case "rename":
						setRenaming({ path: entry.path, name: entry.name, is_dir: entry.is_dir });
						break;
					case "delete":
						setConfirmDelete(entry);
						break;
					case "new-file":
						setCreating({ kind: "file", name: "" });
						break;
					case "new-folder":
						setCreating({ kind: "dir", name: "" });
						break;
					case "sort-name":
					case "sort-size":
					case "sort-date": {
						const value = id.slice(5);
						setSort(value);
						try {
							localStorage.setItem("dshd.explorer.sort", value);
						} catch {
							// best-effort
						}
						break;
					}
					case "toggle-hidden":
						setShowHidden((value) => {
							const next = !value;
							try {
								localStorage.setItem("dshd.explorer.hidden", next ? "1" : "0");
							} catch {
								// best-effort
							}
							return next;
						});
						break;
					case "refresh":
						if (cwd) loadDir(cwd);
						break;
				}
			};

			// ── workspace chip (Е) ──
			const chipItems = [
				{ type: "label", id: "ws-label", text: "Jump to a workspace folder" },
				...(workspaceSnapshot?.items || []).map((item, index) => {
					const view = workspaceView(item);
					const path = view && typeof view.path === "string" ? view.path : "";
					const title = workspaceTitleOf(item) || (path ? baseName(path) : "Workspace");
					return {
						id: "ws-" + index,
						label: h("span", { style: { display: "flex", alignItems: "baseline", gap: 6, minWidth: 0 } },
							h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, title),
							path !== "" ? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, path) : null),
						icon: h(IconFolderClose16, {})
					};
				})
			];
			const chipSelected = currentWorkspace === null ? void 0 : "ws-" + (workspaceSnapshot?.items?.indexOf(currentWorkspace) ?? -1);

			const openChipMenu = (event) => {
				const rect = event.currentTarget.getBoundingClientRect();
				setChipRect({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height });
				setChipOpen(true);
			};
			const chipAnchorRect = useCallback(() => chipRect, [chipRect]);

			const handleChip = (id) => {
				setChipOpen(false);
				if (id === "pick-folder") {
					explorerStore.setPick({
						onPicked: async (path) => {
							await workspaces.create({ path });
							navigate(path);
						},
						onCancel: () => {},
						onError: (message) => setError(message)
					});
					explorerStore.setTab("files");
					explorerStore.setOpen(true);
					return;
				}
				const index = Number(String(id).slice(3));
				const item = workspaceSnapshot?.items?.[index];
				const view = workspaceView(item);
				if (view && typeof view.path === "string" && view.path !== "") navigate(view.path);
			};

			// ── list derivation: filter → hide-dotfiles → sort (dirs first) ──
			const visible = useMemo(() => {
				if (search || !entries) return null;
				let list = entries;
				if (filter) {
					const needle = filter.toLowerCase();
					list = list.filter((entry) => entry.name.toLowerCase().includes(needle));
				}
				if (!showHidden) list = list.filter((entry) => !entry.name.startsWith("."));
				const dirs = [];
				const files = [];
				for (const entry of list) (entry.is_dir ? dirs : files).push(entry);
				const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());
				const bySize = (a, b) => (b.size || 0) - (a.size || 0) || byName(a, b);
				const byDate = (a, b) => (b.modified_ms || 0) - (a.modified_ms || 0) || byName(a, b);
				const cmp = sort === "size" ? bySize : sort === "date" ? byDate : byName;
				dirs.sort(cmp);
				files.sort(cmp);
				return [...dirs, ...files];
			}, [entries, filter, showHidden, sort, search]);

			const scrollToEntry = (path) => {
				const container = scrollRef.current;
				if (!container) return;
				for (const node of container.querySelectorAll("[data-path]")) {
					if (node.dataset.path === path) {
						node.scrollIntoView({ block: "nearest" });
						return;
					}
				}
			};

			const onKeyDown = (event) => {
				if (menu || creating || renaming) return;
				if (filterOpen && event.key !== "Escape" && event.key !== "Enter") return;
				const list = search ? search.items : visible;
				if (!list || list.length === 0) return;
				const index = list.findIndex((entry) => entry.path === selected);
				switch (event.key) {
					case "ArrowDown":
						event.preventDefault();
						{
							const next = list[Math.min(index + 1, list.length - 1)];
							setSelected(next.path);
							scrollToEntry(next.path);
						}
						break;
					case "ArrowUp":
						event.preventDefault();
						{
							const next = list[Math.max(index - 1, 0)];
							setSelected(next.path);
							scrollToEntry(next.path);
						}
						break;
					case "Enter": {
						event.preventDefault();
						const entry = list.find((e) => e.path === selected);
						if (entry) {
							if (entry.is_dir) navigate(entry.path);
							else openFile(entry.path, entry.name);
						}
						break;
					}
					case "Backspace":
						event.preventDefault();
						goUp();
						break;
					case "F2": {
						event.preventDefault();
						const entry = list.find((e) => e.path === selected);
						if (entry) setRenaming({ path: entry.path, name: entry.name, is_dir: entry.is_dir });
						break;
					}
					case "Delete": {
						event.preventDefault();
						const entry = list.find((e) => e.path === selected);
						if (entry) setConfirmDelete(entry);
						break;
					}
					case "Escape":
						if (picking) cancelPick();
						else if (search) setSearch(null);
						else if (filter) setFilter("");
						else setFilterOpen(false);
						break;
				}
			};

			const crumbs = useMemo(() => {
				const segs = pathSegments(cwd);
				if (segs.length === 0) return [];
				if (currentWorkspacePath) {
					const rootSegs = pathSegments(currentWorkspacePath);
					if (rootSegs.length > 0 && (cwd === currentWorkspacePath || cwd.startsWith(currentWorkspacePath + "/"))) {
						return [
							{ name: currentWorkspaceTitle, path: currentWorkspacePath },
							...segs.slice(rootSegs.length)
						];
					}
				}
				return segs;
			}, [cwd, currentWorkspacePath, currentWorkspaceTitle]);


			if (!rendered) return null;

			// The panel borrows the app sidebar's visual language: same fill
			// (--dsw-specific-sidebar-fill), same border tone, same padding,
			// font size and scrollbars. Its width is animated by the dock
			// effect (0 → target on open, target → 0 on close).
			const style = {
				position: "absolute",
				top: 0,
				right: 0,
				bottom: 0,
				width: panelWidth,
				background: "var(--dsw-specific-sidebar-fill)",
				borderLeft: "1px solid var(--dsw-alias-border-l1)",
				overflow: "hidden",
				display: "flex",
				flexDirection: "column",
				boxSizing: "border-box",
				padding: "6px 12px",
				color: "var(--dsw-alias-label-primary)",
				fontFamily: "var(--dsw-font-family)",
				fontSize: 14,
				transition: dragging
					? "none"
					: "width var(--ds-transition-duration-slow) var(--ds-ease-in-out)",
				willChange: "width",
				"--dsh-scrollbar-thumb": "var(--dsw-alias-scrollbar-bg-l2)",
				"--dsh-scrollbar-thumb-hover": "var(--dsw-alias-scrollbar-hover-l2)"
			};
			// 28px round icon button (the sidebar's iconButton).
			const roundButton = {
				width: 28,
				height: 28,
				border: "none",
				background: "transparent",
				borderRadius: "50%",
				cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)",
				display: "grid",
				placeItems: "center",
				flex: "none",
				padding: 0
			};
			const roundButtonHover = {
				...roundButton,
				background: "var(--dsw-alias-interactive-bg-hover)"
			};
			const headerStyle = {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 8,
				padding: "2px 0 8px",
				flex: "none"
			};
			const tabsStyle = {
				display: "flex",
				gap: 2,
				flex: 1,
				minWidth: 0
			};
			const tabStyle = (active) => ({
				border: "none",
				background: active ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
				color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
				borderRadius: 8,
				padding: "4px 10px",
				height: 30,
				fontSize: 13,
				fontWeight: 500,
				cursor: "pointer",
				fontFamily: "inherit",
				display: "flex",
				alignItems: "center",
				gap: 6,
				flex: 1,
				justifyContent: "center",
				minWidth: 0
			});
			const pathButton = (disabled) => ({
				...roundButton,
				color: disabled ? "var(--dsw-alias-label-tertiary)" : "var(--dsw-alias-label-secondary)",
				opacity: disabled ? 0.5 : 1,
				cursor: disabled ? "default" : "pointer"
			});
			const pathRowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 2,
				padding: "0 0 6px",
				flex: "none",
				minWidth: 0
			};
			const crumbStyle = {
				display: "flex",
				alignItems: "center",
				gap: 1,
				flex: 1,
				minWidth: 0,
				overflowX: "auto",
				scrollbarWidth: "none"
			};
			const crumbButtonStyle = {
				border: "none",
				background: "transparent",
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 12,
				fontFamily: "var(--ds-font-family-code, monospace)",
				padding: "2px 4px",
				borderRadius: 6,
				cursor: "pointer",
				whiteSpace: "nowrap",
				maxWidth: 140,
				overflow: "hidden",
				textOverflow: "ellipsis",
				flex: "none"
			};
			const crumbCurrentStyle = {
				...crumbButtonStyle,
				color: "var(--dsw-alias-label-secondary)",
				cursor: "default",
				fontWeight: 600
			};
			const chipStyle = {
				...roundButton,
				width: "auto",
				height: 26,
				borderRadius: 13,
				padding: "0 10px",
				display: "flex",
				alignItems: "center",
				gap: 5,
				fontSize: 12,
				fontWeight: 500,
				color: "var(--dsw-alias-label-secondary)",
				maxWidth: 260,
				flex: "none"
			};
			const filterRowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 6,
				padding: "0 4px 8px",
				flex: "none"
			};
			const filterInputStyle = {
				flex: 1,
				minWidth: 0,
				height: 26,
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				fontSize: 12,
				padding: "0 8px",
				outline: "none",
				fontFamily: "inherit"
			};
			const rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				minHeight: 30,
				border: "none",
				background: "transparent",
				borderRadius: 8,
				padding: "2px 8px",
				cursor: "pointer",
				font: "inherit",
				color: "var(--dsw-alias-label-primary)",
				boxSizing: "border-box",
				textAlign: "left"
			};
			const pickFooterStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "10px 0 4px",
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				flex: "none"
			};
			const statusBarStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				padding: "6px 0 2px",
				borderTop: "1px solid var(--dsw-alias-border-l1)",
				flex: "none"
			};

			const renderRow = (entry, index) => {
				const isSelected = selected === entry.path;
				const dimmed = clip && clip.op === "cut" && clip.paths.includes(entry.path);
				const isRenaming = renaming !== null && renaming.path === entry.path;
				return h("div", {
					key: entry.path,
					"data-path": entry.path,
					role: "button",
					tabIndex: -1,
					title: entry.path,
					style: {
						...rowStyle,
						opacity: dimmed ? 0.45 : 1,
						background: isSelected ? "var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover))" : "transparent"
					},
					onClick: () => {
						setSelected(entry.path);
						panelRef.current?.focus();
						if (entry.is_dir) navigate(entry.path);
						else openFile(entry.path, entry.name);
					},
					onContextMenu: (event) => openMenuAt(event, entry)
				},
					isRenaming
						? h("input", {
								ref: (node) => {
									// autofocus without stealing the click
									if (node) node.focus();
								},
								style: {
									...filterInputStyle,
									height: 24,
									margin: "2px 0"
								},
								defaultValue: renaming.name,
								onKeyDown: (event) => {
									event.stopPropagation();
									if (event.key === "Enter") {
										commitRenameValue(event.currentTarget.value);
									} else if (event.key === "Escape") {
										setRenaming(null);
									}
								},
								onBlur: () => setRenaming(null),
								onClick: (event) => event.stopPropagation()
							})
						: h(react.Fragment, {},
								(entry.fresh || entry.changed)
									? h("span", {
											title: entry.fresh ? "New since last refresh" : "Changed since last refresh",
											style: {
												width: 6,
												height: 6,
												borderRadius: "50%",
												flex: "none",
												background: entry.fresh
													? "var(--dsw-alias-state-success-primary, #22c55e)"
													: "var(--dsw-alias-state-warning-primary, #f59e0b)"
											}
										})
									: null,
								h("span", {
									style: {
										color: entry.is_dir ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-label-tertiary)",
										display: "grid",
										placeItems: "center",
										flex: "none"
									}
								}, entry.is_dir ? h(IconFolderOpen16, {}) : h(IconDataOutline16, {})),
								h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 } }, entry.name),
								entry.is_dir
									? null
									: h("span", {
											style: {
												flex: "none",
												fontSize: 11,
												color: "var(--dsw-alias-label-tertiary)",
												fontVariantNumeric: "tabular-nums",
												paddingLeft: 8
											}
										}, formatTime(entry.modified_ms), " ", formatSize(entry.size))
							)
				);
			};

			return h("div", { ref: panelRef, className: "dshd-explorer-panel", style: { ...style, outline: "none" }, tabIndex: 0, onKeyDown: onKeyDown, "data-dshd-explorer": true },
				// Resize handle (docked columns have one, like the app's own).
				h("div", { id: "dshd-explorer-resize", onPointerDown: (event) => startResize(event) }),
				h("div", { style: headerStyle },
					picking
						? h("div", { style: { ...tabsStyle, alignItems: "center" } },
								h("span", { style: { fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" } }, "Choose a workspace folder"))
						: h("div", { style: tabsStyle },
								h("button", { type: "button", className: "dshd-tab", style: tabStyle(tab === "files"), onClick: () => explorerStore.setTab("files") },
									h(IconFolderOpenOutline16, {}), "Files"),
								h("button", { type: "button", className: "dshd-tab", style: tabStyle(tab === "preview"), onClick: () => explorerStore.setTab("preview") },
									h(IconCodeOutline16, {}), "Preview")
							),
					h("button", {
						type: "button",
						className: "dshd-round",
						title: "Hide panel",
						style: roundButton,
						onClick: () => explorerStore.setOpen(false)
					}, h(IconCloseOutline16, {}))
				),

				tab === "files" || picking
					? h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
							// Path bar: back/forward, workspace chip, crumbs,
							// search toggle, new… menu.
							h("div", { style: pathRowStyle },
								h("button", { type: "button", className: "dshd-round", title: "Back", disabled: histIndex <= 0, onClick: () => goBack(), style: pathButton(histIndex <= 0) },
									h(IconChevronLeftOutline14, {})),
								h("button", { type: "button", className: "dshd-round", title: "Forward", disabled: histIndex >= history.length - 1, onClick: () => goForward(), style: pathButton(histIndex >= history.length - 1) },
									h(IconChevronRightOutline14, {})),
								h("button", {
									type: "button",
									className: "dshd-round",
									title: "Up",
									disabled: !cwd || pathSegments(cwd).length <= 1,
									onClick: () => goUp(),
									style: pathButton(!cwd || pathSegments(cwd).length <= 1)
								}, h(IconChevronUpOutline14, {})),
								h("div", { ref: crumbScrollRef, style: crumbStyle, className: "dshd-scroll" },
									crumbs.map((crumb, index) =>
										h(react.Fragment, { key: crumb.path },
											index > 0
												? h("span", { style: { color: "var(--dsw-alias-label-tertiary)", flex: "none", display: "grid", placeItems: "center" } },
														h(IconChevronRightOutline14, {}))
												: null,
											h("button", {
												type: "button",
												style: index === crumbs.length - 1 ? crumbCurrentStyle : crumbButtonStyle,
												title: crumb.path,
												disabled: index === crumbs.length - 1,
												onClick: () => navigate(crumb.path)
											}, crumb.name)
										)
									)
								),
								h("button", { type: "button", className: "dshd-round", title: "Search (Ctrl+F)", style: roundButton, onClick: () => setFilterOpen((value) => !value) },
									h(IconSearchOutline16, {})),
								h("button", { type: "button", className: "dshd-round", title: "New file or folder", style: roundButton, onClick: (event) => openMenuAt(event, null) },
									h(IconPlusOutline16, {}))
							),
							// Filter / recursive search row.
							(filterOpen || filter !== "" || search !== null)
								? h("div", { style: filterRowStyle },
										h(IconSearchOutline16, {}),
										h("input", {
											ref: filterRef,
											style: filterInputStyle,
											value: filter,
											placeholder: "Filter this folder — Enter searches recursively",
											onChange: (event) => {
												setFilter(event.target.value);
												if (search) setSearch(null);
											},
											onKeyDown: (event) => {
												event.stopPropagation();
												if (event.key === "Enter") runSearch();
												else if (event.key === "Escape") {
													setFilter("");
													setFilterOpen(false);
													setSearch(null);
												}
											}
										}),
										search
											? h("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", flex: "none" } },
													`${search.items.length} match${search.items.length === 1 ? "" : "es"} in ${baseName(cwd)}`)
											: null,
										h("button", { type: "button", className: "dshd-round", title: "Clear", style: roundButton, onClick: () => { setFilter(""); setSearch(null); setFilterOpen(false); } },
											h(IconCloseOutline16, {}))
									)
								: null,
							error
								? h("div", { style: { padding: "0 4px 8px", fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } }, error)
								: null,
							creating
								? h("div", { style: { ...rowStyle, padding: "2px 0" } },
										h("input", {
											style: { ...filterInputStyle, height: 24 },
											placeholder: creating.kind === "dir" ? "Folder name" : "File name",
											onKeyDown: (event) => {
												event.stopPropagation();
												if (event.key === "Enter") {
													commitCreateValue(event.currentTarget.value);
												} else if (event.key === "Escape") {
													setCreating(null);
												}
											},
											onBlur: () => setCreating(null),
											onClick: (event) => event.stopPropagation(),
											ref: (node) => {
												if (node) node.focus();
											}
										})
									)
								: null,
							search
								? h("div", { className: "dshd-scroll", ref: scrollRef, style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 0 12px", outline: "none" } },
										search.items.length === 0
											? h("div", { style: { padding: "16px 8px", fontSize: 13, color: "var(--dsw-alias-label-tertiary)", textAlign: "center" } },
													`No matches for “${search.query}” in this folder.`)
											: search.items.map((entry, index) => renderRow(entry, index))
									)
								: !entries
									? h("div", { style: { flex: 1, display: "grid", placeItems: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 13, padding: "0 8px", textAlign: "center" } },
											busy ? "Loading…" : (error ? "Nothing to show" : "No workspace yet — pick a folder from the folder chip or in Settings → dsh-desktop."))
									: h("div", { className: "dshd-scroll", ref: scrollRef, onContextMenu: (event) => openMenuAt(event, null), style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 0 12px", outline: "none" } },
											(visible || []).map((entry, index) => renderRow(entry, index))
										),
							// Workspace chip: bottom status bar, out of the path
							// row so the path keeps the full width.
							!picking
								? h("div", { style: statusBarStyle },
										h("button", { type: "button", className: "dshd-round", title: "Jump to a workspace folder", style: chipStyle, onClick: openChipMenu },
											h(IconFolderClose16, {}),
											h("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, currentWorkspaceTitle))
									)
								: null,
							// Pick-mode footer (Е).
							picking
								? h("div", { style: pickFooterStyle },
										h("div", { style: { flex: 1, minWidth: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } },
											"Workspace folder: ", cwd || "…"),
										h(Button, { size: "sm", variant: "outline", onClick: cancelPick }, "Cancel"),
										h(Button, { size: "sm", variant: "primary", disabled: !cwd || busy, onClick: () => selectPick() }, "Select this folder")
									)
								: null
						)
					: h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
							preview === null
								? h("div", { style: { flex: 1, display: "grid", placeItems: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 13, padding: 24, textAlign: "center" } },
										"Select a file in the Files tab to preview it here.")
								: h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
										h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "0 0 8px", flex: "none" } },
											h("button", {
												type: "button",
												className: "dshd-round",
												title: "Back to files",
												onClick: () => explorerStore.setTab("files"),
												style: roundButton
											}, h(IconChevronLeftOutline14, {})),
											h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 500 } }, preview.name || "")
										),
										preview.loading
											? h("div", { style: { flex: 1, display: "grid", placeItems: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 13 } }, "Loading…")
											: preview.failed
												? h("div", { style: { padding: "0 12px", fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } }, preview.error || "Cannot read this file.")
												: preview.encoding === "base64"
													? h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "grid", placeItems: "center", padding: 12 } },
															h("img", { src: `data:${preview.mime || "image/png"};base64,${preview.content}`, alt: preview.name, style: { maxWidth: "100%", maxHeight: "100%", borderRadius: 6 } }))
													: preview.encoding === "binary"
														? h("div", { style: { padding: 24, fontSize: 13, color: "var(--dsw-alias-label-tertiary)", textAlign: "center" } },
																"This is a binary file (no preview).")
														: h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 12px 12px" } },
																h("pre", {
																	style: {
																		margin: 0,
																		fontFamily: "var(--ds-font-family-code, monospace)",
																		fontSize: 12,
																		lineHeight: 1.6,
																		color: "var(--dsw-alias-label-secondary)",
																		whiteSpace: "pre-wrap",
																		wordBreak: "break-word"
																	}
																}, preview.content || " "),
																preview.truncated
																	? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", padding: "4px 0 8px" } },
																			`Preview cut at 1 MB — the full file is ${formatSize(preview.size)}.`)
																	: null)
									)
						),

				// Context menu (the single action surface: rows + empty space).
				h(Menu, {
					open: menu !== null,
					anchor: null,
					portal: true,
					compact: true,
					getAnchorRect: menuAnchorRect,
					items: buildMenuItems(menu ? menu.entry : null),
					selectedId: menu ? (sort === "name" ? "sort-name" : sort === "size" ? "sort-size" : "sort-date") : void 0,
					onSelect: (id) => {
						const target = menu;
						setMenu(null);
						if (target) handleMenu(id, target.entry);
					},
					onClose: () => setMenu(null)
				}),

				// Workspace chip menu (switch / choose folder).
				!picking
					? h(Menu, {
							open: chipOpen,
							anchor: null,
							portal: true,
							compact: true,
							getAnchorRect: chipAnchorRect,
							items: chipItems,
							selectedId: chipSelected,
							footer: [{ id: "pick-folder", label: "Choose folder…", icon: h(IconFolderOpenOutline16, {}) }],
							onSelect: handleChip,
							onClose: () => setChipOpen(false)
						})
					: null,

				// Delete confirmation (move to trash).
				h(Modal, {
					open: confirmDelete !== null,
					onClose: () => setConfirmDelete(null),
					closeLabel: "Cancel",
					title: "Move to trash?",
					footer: [
						h(Button, { key: "cancel", variant: "outline", size: "sm", onClick: () => setConfirmDelete(null) }, "Cancel"),
						h(Button, { key: "delete", size: "sm", icon: h(IconTrashOutline16, {}), onClick: () => commitDelete() }, "Move to trash")
					],
					children: h("div", { style: { fontSize: 13, color: "var(--dsw-alias-label-secondary)", lineHeight: 1.6 } },
						confirmDelete ? `“${confirmDelete.name}” will be moved to the OS trash — it can be restored.` : "")
				})
			);
		}
		//#endregion


		//#region dsh-desktop settings tab
		const CARD = {
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-3)",
			borderRadius: 10,
			padding: "14px 16px",
			marginBottom: 10
		};
		const H3 = {
			fontSize: 13,
			fontWeight: 600,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-primary)",
			margin: "0 0 8px"
		};
		const LABEL = {
			fontSize: 14,
			fontWeight: 600,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-primary)"
		};
		const HINT = {
			fontSize: 12,
			lineHeight: "18px",
			color: "var(--dsw-alias-label-tertiary)",
			marginTop: 2
		};
		const VALUE = {
			fontSize: 14,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)",
			fontVariantNumeric: "tabular-nums"
		};

		/** One labelled row: text on the left, arbitrary control on the right. */
		function Row({ label, hint, control }) {
			return h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "5px 0" } },
				h("div", { style: { flex: 1, minWidth: 0 } },
					h("div", { style: LABEL }, label),
					hint ? h("div", { style: HINT }, hint) : null
				),
				control
			);
		}

		/** Minimal accessible switch. */
		function Switch({ checked, disabled, onChange }) {
			return h("button", {
				type: "button",
				role: "switch",
				"aria-checked": !!checked,
				disabled: !!disabled,
				onClick: () => onChange(!checked),
				style: {
					width: 36,
					height: 20,
					borderRadius: 10,
					border: "none",
					cursor: disabled ? "default" : "pointer",
					flex: "none",
					background: checked ? "var(--dsw-alias-state-success-primary)" : "var(--dsw-alias-border-l2)",
					display: "flex",
					alignItems: "center",
					justifyContent: checked ? "flex-end" : "flex-start",
					padding: 2,
					boxSizing: "border-box",
					opacity: disabled ? 0.5 : 1
				}
			}, h("span", { style: { width: 16, height: 16, borderRadius: 8, background: "#fff", display: "block" } }));
		}

		/** Native `<select>` styled to the app tokens. */
		function Select({ value, options, disabled, onChange }) {
			return h("select", {
				value,
				disabled: !!disabled,
				onChange: (event) => onChange(Number(event.target.value)),
				style: {
					background: "var(--dsw-alias-bg-layer-1)",
					color: "var(--dsw-alias-label-primary)",
					border: "1px solid var(--dsw-alias-border-l2)",
					borderRadius: 8,
					height: 32,
					padding: "0 8px",
					font: "inherit",
					flex: "none"
				}
			}, options.map((option) => h("option", { key: option, value: option }, `${option} h`)));
		}

		function errText(error) {
			return error && typeof error === "object" && error.message ? error.message : String(error);
		}

		function DesktopSection({ openWorkspace }) {
			const tauri = hasTauri();
			const [state, setState] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);
			const [progress, setProgress] = useState(null);
			const [installInfo, setInstallInfo] = useState(null);

			const refresh = useCallback(async () => {
				try {
					setError(null);
					setState(await window.__TAURI__.core.invoke("desktop_get_state"));
				} catch (caught) {
					setError(errText(caught));
				}
			}, []);

			useEffect(() => {
				if (!tauri) return;
				let off;
				let offProgress;
				refresh();
				window.__TAURI__.event
					.listen(STATE_EVENT, (event) => setState(event.payload))
					.then((unlisten) => {
						off = unlisten;
					})
					.catch(() => {});
				window.__TAURI__.event
					.listen(UPDATE_PROGRESS_EVENT, (event) => setProgress(event.payload))
					.then((unlisten) => {
						offProgress = unlisten;
					})
					.catch(() => {});
				window.__TAURI__.core
					.invoke("desktop_install_info")
					.then(setInstallInfo)
					.catch(() => {});
				return () => {
					if (off) off();
					if (offProgress) offProgress();
				};
			}, [tauri, refresh]);

			const setSetting = useCallback(async (key, value) => {
				try {
					setError(null);
					setState(await window.__TAURI__.core.invoke("desktop_set_setting", { key, value }));
				} catch (caught) {
					setError(errText(caught));
				}
			}, []);

			const checkNow = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				try {
					setError(null);
					setState(await window.__TAURI__.core.invoke("desktop_check_updates"));
				} catch (caught) {
					setError(errText(caught));
				} finally {
					setBusy(false);
				}
			}, [busy]);

			const updateNow = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				setError(null);
				setProgress({ phase: "checking" });
				try {
					await window.__TAURI__.core.invoke("desktop_update_now");
					// The app restarts on success — this line only runs on failure.
				} catch (caught) {
					setError(errText(caught));
					setProgress(null);
				} finally {
					setBusy(false);
				}
			}, [busy]);

			const run = useCallback(async (command) => {
				try {
					setError(null);
					await window.__TAURI__.core.invoke(command);
				} catch (caught) {
					setError(errText(caught));
				}
			}, []);

			// Workspace folder → the explorer panel's "choose a folder" mode
			// (no OS dialog: the same file manager the user browses with).
			const pickWorkspace = useCallback(() => {
				if (busy) return;
				explorerStore.setPick({
					onPicked: async (path) => {
						if (typeof openWorkspace === "function") await openWorkspace(path);
					},
					onCancel: () => {},
					onError: (message) => setError(message)
				});
				explorerStore.setTab("files");
				explorerStore.setOpen(true);
			}, [busy]);

			// No native client: this harness runs in a plain browser.
			if (!tauri) {
				return h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-warning-primary)" } },
					h("div", { style: LABEL }, "Desktop client not detected"),
					h("div", { style: { ...HINT, marginTop: 4 } },
						"The dsh-desktop settings (tray, notifications, updates, window geometry, the file manager) belong to the native " +
						"window. They are available when this harness is opened through the dsh-desktop application — " +
						"in a browser there is no native client to configure."
					)
				);
			}

			if (state === null) {
				return h("div", { style: { ...CARD } }, "Loading…");
			}

			const settings = state.settings;
			const update = state.update;
			const lastCheck = state.last_update_check
				? (() => {
						const date = new Date(state.last_update_check);
						return isNaN(date.getTime()) ? state.last_update_check : date.toLocaleString();
					})()
				: "never";

			const progressPercent = progress && progress.total ? Math.min(100, Math.round(((progress.received || 0) / progress.total) * 100)) : null;
			const updating = progress !== null && progress.phase !== "restarting";

			return h("div", { style: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column" } },
				// Live error line (invoke failures, check errors, update errors).
				error || state.update_check_error
					? h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" } },
							error || state.update_check_error)
					: null,

				// Update suggestion banner — one-click update, never automatic.
				update
					? h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-business-primary)" } },
							h("div", { style: { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" } },
								h("div", { style: { flex: 1, minWidth: 0 } },
									h("div", { style: LABEL }, `dsh-desktop ${update.version} is available`),
									h("div", { style: HINT },
										update.published_at
											? `Published ${new Date(update.published_at).toLocaleDateString()}. Updates are never applied automatically — click Update when ready.`
											: "Updates are never applied automatically — click Update when ready."
									)
								),
								h(Button, { variant: "primary", size: "sm", icon: h(IconDownloadOutline16, {}), disabled: busy, onClick: () => updateNow() },
									updating ? "Updating…" : "Update now"),
								h(Button, { size: "sm", icon: h(IconGlobeOutline14, {}), disabled: busy, onClick: () => run("desktop_open_release") }, "Open release")
							),
							// Progress bar while downloading/applying.
							updating && progressPercent !== null
								? h("div", { style: { marginTop: 10 } },
										h("div", { style: { height: 6, borderRadius: 3, background: "var(--dsw-alias-interactive-bg-hover)", overflow: "hidden" } },
											h("div", { style: { height: "100%", width: `${progressPercent}%`, background: "var(--dsw-alias-state-business-primary)", transition: "width .2s" } })
										),
										h("div", { style: { ...HINT, marginTop: 4 } },
											progress.phase === "downloading"
												? `Downloading… ${Math.round((progress.received || 0) / 1048576)} / ${Math.round(progress.total / 1048576)} MB`
												: progress.phase === "applying" ? "Applying…" : "Checking…")
									)
								: progress && progress.phase === "restarting"
									? h("div", { style: { ...HINT, marginTop: 10 } }, "Update applied — restarting…")
									: null
						)
					: null,

				// General.
				h("div", { style: CARD },
					h("div", { style: H3 }, "General"),
					h(Row, { label: "Version", control: h("span", { style: VALUE }, `v${state.version}`) }),
					h(Row, { label: "Last update check", control: h("span", { style: VALUE }, lastCheck) })
				),

				// Window.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Window"),
					h(Row, {
						label: "Close to tray",
						hint: "Closing the window hides it to the tray and keeps the harness running; Quit from the tray exits.",
						control: h(Switch, { checked: settings.tray, onChange: (value) => setSetting("tray", value) })
					}),
					h(Row, {
						label: "Window geometry",
						hint: "Size and position are remembered across restarts. Reset to the default 1280×860 centered.",
						control: h(Button, { size: "sm", icon: h(IconSettingsOutline16, {}), onClick: () => run("desktop_reset_geometry") }, "Reset")
					})
				),

				// Workspace.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Workspace"),
					h(Row, {
						label: "Choose folder…",
						hint: "Pick a directory in the file manager panel and attach it as a workspace. You can also just drag a folder into the window.",
						control: h(Button, {
							size: "sm",
							icon: h(IconFolderOpenOutline16, {}),
							disabled: busy,
							onClick: () => pickWorkspace()
						}, "Pick folder")
					})
				),

				// File manager.
				h("div", { style: CARD },
					h("div", { style: H3 }, "File manager & preview"),
					h(Row, {
						label: "Show explorer",
						hint: "The panel on the right browses your workspace and previews files. Toggle it from the title bar (folder icon) or here.",
						control: h(Button, {
							size: "sm",
							icon: h(IconPanelLeftOutline16, {}),
							onClick: () => explorerStore.toggle()
						}, explorerStore.open ? "Hide panel" : "Show panel")
					})
				),

				// Notifications.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Notifications"),
					h(Row, {
						label: "Native notifications",
						hint: "Update available, tray hints, and background events as OS notifications.",
						control: h(Switch, { checked: settings.notifications, onChange: (value) => setSetting("notifications", value) })
					}),
					h(Row, {
						label: "Test",
						hint: "Send a sample notification to check your desktop environment.",
						control: h(Button, { size: "sm", disabled: !settings.notifications, onClick: () => run("desktop_test_notification") }, "Send test notification")
					})
				),

				// Updates.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Updates"),
					h(Row, {
						label: "Check for updates automatically",
						hint: "Queries GitHub releases periodically. Off by default — updates are one click whenever you want them, never forced.",
						control: h(Switch, { checked: settings.auto_update_check, onChange: (value) => setSetting("auto_update_check", value) })
					}),
					h(Row, {
						label: "Check interval",
						hint: "How often to re-check while automatic checking is enabled.",
						control: h(Select, {
							value: settings.update_interval_hours,
							options: [1, 3, 6, 12, 24],
							disabled: !settings.auto_update_check,
							onChange: (value) => setSetting("update_interval_hours", value)
						})
					}),
					h(Row, {
						label: "Check now",
						hint: "Run an update check immediately.",
						control: h(Button, { size: "sm", icon: h(IconRefreshOutline14, {}), disabled: busy, onClick: () => checkNow() }, busy ? "Checking…" : "Check for updates")
					}),
					h(Row, {
						label: "Releases",
						hint: "Open the GitHub releases page in your browser.",
						control: h(Button, { size: "sm", icon: h(IconGlobeOutline14, {}), onClick: () => run("desktop_open_release") }, "Open releases page")
					})
				),

				// Installation (the plugin installer story).
				installInfo
					? h("div", { style: CARD },
							h("div", { style: H3 }, "Installation"),
							h(Row, { label: "Profile", control: h("span", { style: { ...VALUE, fontSize: 12, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, installInfo.profile) }),
							h(Row, { label: "Client", control: h("span", { style: { ...VALUE, fontSize: 12, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, installInfo.client) })
						)
					: null
			);
		}

		/** Attach a directory as the harness workspace (plugin-ctx bound). */
		function openWorkspace(ctx, path) {
			return ctx.workspaces.create({ path }).then(
				() => console.log(`dsh-desktop: opened workspace ${path}`),
				(error) => console.error(`dsh-desktop: cannot open workspace ${path}:`, error)
			);
		}

		/** The harness directory-flow occupant: when a workspace-pick flow
		* opens (conversation hero "Add workspace" or the sidebar browser),
		* switch the docked explorer panel into "choose a folder" mode and
		* route its outcome back into the flow. Renders nothing itself — the
		* panel is the picker. */
		function DesktopDirectoryFlow(props) {
			const { open, onPicked, onCancel } = props;
			const lastCancel = useRef(onCancel);
			lastCancel.current = onCancel;
			useEffect(() => {
				if (open) {
					explorerStore.setPick({
						onPicked,
						onCancel,
						onError: props.onError
					});
					explorerStore.setTab("files");
					explorerStore.setOpen(true);
				} else if (explorerStore.pick !== null && explorerStore.pick.onCancel === lastCancel.current) {
					explorerStore.clearPick();
				}
			}, [open]);
			return null;
		}

		/** Register the section once the settings surface declares its section slot. */
		function apply(ctx) {
			explorerStore.init();
			// Custom window title bar (native only).
			if (hasTauri() && typeof document !== "undefined") installTitlebar();
			// On-screen error badge (native only): makes webview runtime
			// errors visible instead of silent.
			if (hasTauri() && typeof document !== "undefined") installErrorBadge();
			// Self-heal watchdog (native only): reloads the webview if the
			// panel dies silently while the store says it is open.
			if (hasTauri() && typeof document !== "undefined") installPanelWatchdog();

			// Native folder integration: dropping a directory onto the window
			// opens it as a workspace. Files are left to the webview, which
			// handles attachments. The tauri core emits this event to the
			// webview on every drop; directory-ness is checked natively.
			if (hasTauri()) {
				window.__TAURI__.event
					.listen("tauri://drag-drop", (event) => {
						const payload = event.payload;
						if (payload === null || typeof payload !== "object" || !Array.isArray(payload.paths)) return;
						for (const path of payload.paths) {
							if (typeof path !== "string" || path === "") continue;
							window.__TAURI__.core
								.invoke("desktop_is_directory", { path })
								.then((isDirectory) => {
									if (isDirectory === true) openWorkspace(ctx, path);
								})
								.catch(() => {});
						}
					})
					.catch(() => {});
			}
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "desktop",
				order: 20,
				label: () => "dsh-desktop",
				locale: NS,
				inject: () => ({ openWorkspace: (path) => openWorkspace(ctx, path) })
			}, DesktopSection));
			// The explorer panel: docked right, Files/Preview tabs. Registered
			// into the shell overlay (the app's full-frame overlay layer) once
			// the layout plugin declares it. `sessions`/`conversation` are
			// resolved lazily at render time (they are client services that
			// mount after this bundle).
			if (hasTauri()) {
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "desktop-explorer",
					order: 90,
					locale: NS,
					inject: () => ({
						workspaces: ctx.workspaces,
						sessions: ctx.sessions,
						conversation: ctx.conversation
					})
				}, ExplorerPanel));
				// The workspace picker: replace the OS-folder-dialog flow in
				// both harness holes (conversation hero + sidebar browser) with
				// this panel in "choose a folder" mode. The holes are single-
				// occupant; the native/browse surfaces register at the default
				// priority 0, so priority -1 shadows them (lowest renders).
				ctx.slots.inject("conversation.hero.workspace.directoryFlow", () => ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
					yield ctx.slots.register({
						name: "conversation.hero.workspace.directoryFlow",
						id: "desktop-picker",
						order: 90,
						priority: -1,
						locale: NS
					}, DesktopDirectoryFlow);
					yield ctx.slots.register({
						name: "sidebar.workspaces.directoryFlow",
						id: "desktop-picker",
						order: 90,
						priority: -1,
						locale: NS
					}, DesktopDirectoryFlow);
				}));
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
