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
			IconFolderOpenOutline16,
			IconFolderOpen16,
			IconChevronLeftOutline14,
			IconChevronRightOutline14,
			IconCloseOutline16,
			IconCodeOutline16,
			IconDataOutline16,
			IconSearchOutline16,
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
			IconFolderClose16,
			MarkdownText,
			CodeBlock
		} = _deepseek_ai_dsh_client_ui_primitives;
		const IconGlobeOutline16 = _deepseek_ai_dsh_client_ui_primitives.IconGlobeOutline16 || IconGlobeOutline14;

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

		// ── external links → system browser ──────────────────────────────────
		// The native webview has no handler for the SPA's `target="_blank"`
		// links, so they silently do nothing. Route them to the OS browser via
		// the shell's `desktop_open_path` command instead. Installed once.
		function installExternalLinks() {
			if (!hasTauri() || typeof document === "undefined" || document.getElementById("dshd-external-links")) return;
			// Install-once token (idempotent under re-mount).
			const token = document.createElement("span");
			token.id = "dshd-external-links";
			token.style.display = "none";
			document.body.appendChild(token);

			// Sandboxes preview iframes use their own dshd-file bridge — their
			// document is separate, so a global capture listener never sees
			// those clicks. Only top-level http(s)/mailto links drop in; a
			// `target="_blank"` or `rel=external` hint on an anchor with a
			// NON-http scheme (file:, data:, vbscript:, blob:, javascript:)
			// must never reach the OS opener — leave those to the webview
			// default (which is to do nothing).
			// A `target="_blank"` or `rel=external` hint alone no longer widens
			// what can be opened: only the trimmed href that PARSES to an
			// absolute http(s)/mailto URL may reach the OS opener.
			document.addEventListener(
				"click",
				(event) => {
					try {
						// Let the webview default happen for right-clicks and
						// any modifier-key navigation (new tab / new window).
						if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
						const anchor = event.target && typeof event.target.closest === "function" ? event.target.closest("a[href]") : null;
						if (!anchor) return;
						const href = (anchor.getAttribute("href") || "").trim();
						const hinted = anchor.target === "_blank" || (anchor.rel || "").split(/\s+/).includes("external");
						// External only when the trimmed value parses to an
						// absolute http(s)/mailto URL. Anything that fails to
						// parse (relative, bare host) or parses to another
						// scheme (javascript:, data:, file:, …) is left alone —
						// even with a `target="_blank"` hint, and a bare host no
						// longer routes to the browser.
						let parsed = null;
						try {
							parsed = new URL(href);
						} catch {
							parsed = null;
						}
						const extScheme = parsed !== null && (parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:");
						// Keep the hint logic but scope it to the parsed http(s)/
						// mailto value only — it can never broaden past that.
						const external = extScheme || (hinted && extScheme);
						if (!external) return;
						event.preventDefault();
						event.stopPropagation();
						window.__TAURI__.core
							.invoke("desktop_open_path", { path: parsed.href })
							.catch((caught) => console.error(`dsh-desktop: cannot open ${parsed.href}:`, errText(caught)));
					} catch (caught) {
						console.error("dsh-desktop: external-link handler failed:", errText(caught));
					}
				},
				true
			);

			// The SPA may hand the webview an explicit window.open for
			// external addresses (buttons that shell out). Keep those working.
			const originalOpen = window.open && window.open.bind(window);
			window.open = (url, target, features) => {
				const href = String(url || "");
				if (/^(https?:|mailto:)/i.test(href)) {
					window.__TAURI__.core
						.invoke("desktop_open_path", { path: href })
						.catch((caught) => console.error(`dsh-desktop: cannot open ${href}:`, errText(caught)));
					// A permissive dummy Window-ish handle so callers that
					// hold the return value don't crash on a null reference.
					return { closed: false, focus() {}, blur() {}, close() {} };
				}
				return originalOpen ? originalOpen(url, target, features) : null;
			};
		}

		// ── Ctrl/Cmd+F quick search over the visible chat ───────────────────
		// A lightweight plain-DOM overlay (no React): type to highlight every
		// case-insensitive substring of the message text, ↑/↓ or Enter/Shift+
		// Enter to move the "current" highlight, Esc to leave. Live because
		// streaming re-renders the chat — a debounced MutationObserver re-applies
		// the query while the overlay is open. Native only; single install.
		function installChatSearch() {
			if (!hasTauri() || typeof document === "undefined") return;
			// Idempotent: a module-level flag survives re-mounts even after the
			// overlay is removed, so the listener + observer are installed once.
			if (installChatSearch.installed) return;
			installChatSearch.installed = true;

			const overlay = document.createElement("div");
			const input = document.createElement("input");
			const count = document.createElement("span");
			const prevBtn = document.createElement("button");
			const nextBtn = document.createElement("button");
			const closeBtn = document.createElement("button");
			let currentIndex = -1;
			let activeQuery = "";
			let observer = null;

			const containerEl = () => document.querySelector("[data-conversation-scroll]");

			// Overlay chrome — fixed top-center, above everything, in the app's
			// own alias tokens so it looks native (same bar language as the
			// title bar / explorer).
			overlay.id = "dshd-chat-search";
			overlay.style.cssText =
				"position:fixed;top:56px;left:50%;transform:translateX(-50%);z-index:100000;" +
				"display:flex;align-items:center;gap:6px;padding:6px 8px;border-radius:10px;" +
				"background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);" +
				"box-shadow:0 6px 24px rgba(0,0,0,.28);font-size:13px;font-family:var(--dsw-font-family)";
			const styleEl = document.createElement("style");
			styleEl.textContent =
				// Marks are overlays painted OVER the message text: a subtle
				// translucent accent (the app's info blue, not a loud yellow)
				// keeps the highlighted words readable underneath. The current
				// match is slightly stronger and outlined.
				"mark.dshd-chat-mark{background:color-mix(in srgb, var(--dsw-alias-state-info-primary,#4f6ef7) 26%, transparent);" +
				"color:inherit;border-radius:3px;padding:0}" +
				"mark.dshd-chat-mark.dshd-chat-current{background:color-mix(in srgb, var(--dsw-alias-state-info-primary,#4f6ef7) 45%, transparent);" +
				"outline:1.5px solid var(--dsw-alias-state-info-primary,#4f6ef7)}" +
				"#dshd-chat-search input{flex:1;min-width:180px;background:transparent;border:1px solid var(--dsw-alias-border-l2);" +
				"border-radius:6px;color:var(--dsw-alias-label-primary);padding:4px 8px;font:inherit;outline:none}" +
				"#dshd-chat-search input:focus{border-color:var(--dsw-alias-border-l3)}" +
				"#dshd-chat-search button{display:grid;place-items:center;width:26px;height:26px;border:none;border-radius:6px;" +
				"background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit}" +
				"#dshd-chat-search button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
				"#dshd-chat-search .dshd-count{min-width:38px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;white-space:nowrap}";
			document.head.appendChild(styleEl);

			input.type = "text";
			input.placeholder = "Search chat…";
			input.setAttribute("aria-label", "Search chat");
			count.className = "dshd-count";
			count.textContent = "no matches";
			prevBtn.title = "Previous match (Shift+Enter / ↑)";
			prevBtn.innerHTML = "&#8593;";
			nextBtn.title = "Next match (Enter / ↓)";
			nextBtn.innerHTML = "&#8595;";
			closeBtn.title = "Close (Esc)";
			closeBtn.innerHTML = "&#215;";

			overlay.append(input, count, prevBtn, nextBtn, closeBtn);

			// ── match management ──
			// Highlights NEVER touch the chat DOM: wrapping matches in marks
			// inside the SPA's message tree fights React's reconciliation (a
			// re-render deletes the split-off text nodes). Instead each match
			// is a fixed-position overlay mark on document.body, placed via
			// Range.getBoundingClientRect() and re-placed on scroll/resize/
			// re-render. The messages stay byte-identical.
			/** {range, el}[] for the current query (el = overlay mark). */
			let matches = [];

			/** Drop all overlay marks (the chat DOM is untouched by design). */
			function clearMarks() {
				for (const match of matches) {
					try {
						match.el.remove();
					} catch {
						// already detached
					}
				}
				matches = [];
				totalCount = 0;
				currentIndex = -1;
			}

			function scrollCurrentIntoView() {
				const match = matches[currentIndex];
				if (!match) return;
				const node = match.range.startContainer;
				const el = node && node.nodeType === 3 ? node.parentElement : node;
				if (!el) return;
				try {
					el.scrollIntoView({ block: "center" });
				} catch {
					// older webviews may not accept the options object
					el.scrollIntoView();
				}
			}

			/** Re-place every overlay mark over its range's current viewport
			* rect (rAF-throttled by callers; cheap when the layout is idle). */
			function positionMarks() {
				for (const match of matches) {
					const rect = match.range.getBoundingClientRect();
					if (rect.width === 0 || rect.height === 0) {
						// Off-DOM (React replaced the message) or display:none —
						// hide until the next re-measure brings it back.
						match.el.style.display = "none";
						continue;
					}
					match.el.style.display = "block";
					// The highlight hugs the text exactly: the range rect is the
					// text's own advance box, with only a 1px right cushion for
					// glyph ink that slightly overflows (kerning, italics).
					match.el.style.left = `${rect.left}px`;
					match.el.style.top = `${rect.top}px`;
					match.el.style.width = `${Math.max(rect.width + 1, 2)}px`;
					match.el.style.height = `${rect.height}px`;
				}
			}

			/** Update the count label + current-mark outline after navigation. */
			/** Total matches found (may exceed the shown/capped marks). */
			let totalCount = 0;

			/** Update the count label + current-mark outline after navigation. */
			function updateCurrent() {
				for (const match of matches) match.el.classList.remove("dshd-chat-current");
				const match = matches[currentIndex];
				if (match) match.el.classList.add("dshd-chat-current");
				if (matches.length === 0) {
					count.textContent = "no matches";
				} else if (totalCount > matches.length) {
					count.textContent = `${currentIndex + 1}/${matches.length}+`;
				} else {
					count.textContent = `${currentIndex + 1}/${matches.length}`;
				}
			}

			/** Scan the conversation container for case-insensitive matches of
			* `query` (text nodes only, never mutated) and overlay a mark over
			* each. Cap the VISIBLE marks (huge chats stay fast); navigation
			* still counts only the shown set. */
			function measure(query) {
				clearMarks();
				const scope = containerEl();
				if (!scope) {
					count.textContent = "no conversation";
					return;
				}
				const lower = query.toLowerCase();
				if (lower === "") {
					count.textContent = "no matches";
					return;
				}
				const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
				const found = [];
				while (walker.nextNode()) {
					const node = walker.currentNode;
					const full = node.nodeValue || "";
					if (full === "") continue;
					const lfull = full.toLowerCase();
					let idx = lfull.indexOf(lower);
					while (idx !== -1) {
						found.push({ node, idx, len: query.length });
						idx = lfull.indexOf(lower, idx + query.length);
					}
				}
				if (found.length === 0) {
					count.textContent = "no matches";
					return;
				}
				totalCount = found.length;
				const MAX_MARKS = 300;
				const shown = found.length > MAX_MARKS ? found.slice(0, MAX_MARKS) : found;
				for (const item of shown) {
					let range;
					try {
						range = document.createRange();
						range.setStart(item.node, item.idx);
						range.setEnd(item.node, item.idx + item.len);
					} catch {
						continue;
					}
					const el = document.createElement("mark");
					el.className = "dshd-chat-mark";
					el.style.cssText =
						// No background here: the translucent fill comes from the
						// .dshd-chat-mark class rule (an opaque inline fill would
						// bury the text under the overlay).
						"position:fixed;pointer-events:none;z-index:90000;display:none;" +
						"border-radius:2px;margin:0;padding:0";
					document.body.appendChild(el);
					matches.push({ range, el });
				}
				currentIndex = 0;
				positionMarks();
				updateCurrent();
				scrollCurrentIntoView();
			}

			/** Run `query` against the current conversation container. */
			function runSearch(query) {
				activeQuery = query;
				measure(query);
			}

			/** Move the current match by `delta` (wrapping), updating the count
			* and scrolling the newly current match into the viewport. */
			function step(delta) {
				if (matches.length === 0) return;
				currentIndex = (currentIndex + delta + matches.length) % matches.length;
				updateCurrent();
				scrollCurrentIntoView();
			}

			/** Re-measure after the SPA re-rendered (streaming), preserving the
			* current match index as best effort. */
			function refresh() {
				if (!overlay.isConnected || !containerEl()) return;
				const before = currentIndex;
				measure(activeQuery);
				if (matches.length > 0 && before >= 0 && before < matches.length) {
					currentIndex = before;
					updateCurrent();
				}
			}

			// ── live tracking while the overlay is open ──
			const schedule = (() => {
				let timer = null;
				return (fn) => {
					if (timer !== null) clearTimeout(timer);
					timer = setTimeout(() => {
						timer = null;
						fn();
					}, 400);
				};
			})();
			let repaint = null;
			function requestRepaint() {
				if (repaint !== null) return;
				repaint = requestAnimationFrame(() => {
					repaint = null;
					positionMarks();
				});
			}
			function watchScope() {
				if (observer) observer.disconnect();
				const scope = containerEl();
				if (!scope) {
					count.textContent = "no conversation";
					return;
				}
				observer = new MutationObserver(() => {
					if (activeQuery !== "") schedule(refresh);
				});
				observer.observe(scope, { childList: true, subtree: true, characterData: true });
				// Scrolling moves the text under the marks; re-place them.
				window.addEventListener("scroll", requestRepaint, true);
				window.addEventListener("resize", requestRepaint);
			}
			function unwatchScope() {
				if (observer) {
					observer.disconnect();
					observer = null;
				}
				window.removeEventListener("scroll", requestRepaint, true);
				window.removeEventListener("resize", requestRepaint);
			}

			// ── wire up input + buttons ──
			input.addEventListener("input", () => runSearch(input.value));
			prevBtn.addEventListener("click", () => step(-1));
			nextBtn.addEventListener("click", () => step(1));
			closeBtn.addEventListener("click", close);

			// ── open / close —─
			function open() {
				if (overlay.isConnected) {
					input.focus();
					input.select();
					return;
				}
				document.body.appendChild(overlay);
				watchScope();
				input.focus();
			}

			function close() {
				unwatchScope();
				clearMarks();
				activeQuery = "";
				input.value = "";
				if (overlay.isConnected) overlay.parentNode.removeChild(overlay);
			}

			// ── global key handling (capture, so it wins over the app) ──
			const onKeyDown = (event) => {
				const overlayFocused =
					overlay.isConnected &&
					(event.target === overlay || overlay.contains(event.target));
				// Cmd/Ctrl+F → open chat search. The native webview has no
				// find bar, so this hijacks the shortcut even inside inputs:
				// the only place Ctrl+F is let through is our own overlay
				// (where it selects the search box's content).
				//
				// Matched by PHYSICAL key (event.code) ONLY — never by the
				// reported letter. A Cyrillic letter must not trigger anything:
				// on the Russian layout "ф" sits on the PHYSICAL A key, so
				// Ctrl+Ф is Ctrl+A ("select all"), and physical F reports "а".
				// event.code is layout-independent and always unambiguous.
				if ((event.ctrlKey || event.metaKey) && event.code === "KeyF") {
					if (overlayFocused) return;
					event.preventDefault();
					event.stopPropagation();
					open();
					return;
				}
				if (!overlay.isConnected) return;
				// Keys that matter only while the overlay is open.
				if (event.key === "Escape") {
					event.preventDefault();
					event.stopPropagation();
					close();
					return;
				}
				if (event.key === "Enter") {
					event.preventDefault();
					event.stopPropagation();
					step(event.shiftKey ? -1 : 1);
					return;
				}
				if (event.key === "ArrowUp" || event.key === "ArrowDown") {
					// Only when focus is our input; arrows elsewhere belong to
					// the chat scroll.
					if (overlayFocused) {
						event.preventDefault();
						event.stopPropagation();
						step(event.key === "ArrowUp" ? -1 : 1);
					}
				}
			};
			document.addEventListener("keydown", onKeyDown, true);
		}

		/** Keep the native window title in lockstep with the chat open in the
		* UI right now. The sessions service's list snapshot carries the
		* current session — the same fact source the app shell uses for the
		* browser-tab title — so the window/taskbar title (and the custom bar
		* caption) follows the active chat instead of the last started agent.
		* It updates live: switching chats, opening/closing one, and session
		* renames (auto or user) all move `current`/`title`. */
		function watchDocumentTitle(ctx) {
			const sessions = ctx && ctx.sessions;
			if (!sessions || typeof sessions.list?.subscribe !== "function" || typeof sessions.list?.getSnapshot !== "function") return;
			let last = null;
			const push = () => {
				let snapshot;
				try {
					snapshot = sessions.list.getSnapshot();
				} catch {
					return;
				}
				const id = snapshot && snapshot.current;
				const session = id !== void 0 && snapshot.byId ? snapshot.byId[id] : void 0;
				const chatTitle = typeof session?.title === "string" && session.title !== "" ? session.title : null;
				// Same durable-title rule as the app shell's tab title: no
				// active chat with a title → the plain app name.
				const full = chatTitle === null ? "DeepSeek Harness" : `DeepSeek Harness — ${chatTitle}`;
				if (full === last) return;
				last = full;
				// The bar caption updates immediately; the native title
				// follows through the desktop_set_title command (which also
				// echoes TITLE_EVENT back for any other listener).
				const node = document.querySelector("#dshd-titlebar .dshd-title");
				if (node) node.textContent = full;
				window.__TAURI__.core
					.invoke("desktop_set_title", { title: full })
					.catch(() => {});
			};
			// The SPA may already have an active chat by the time this module
			// mounts — sync it before subscribing.
			push();
			sessions.list.subscribe(push);
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

		// ── preview kind dispatch ──
		function isMarkdownName(name) {
			return /\.(md|markdown|mdx)$/i.test(name || "");
		}

		function isHtmlName(name) {
			return /\.(html?|htm)$/i.test(name || "");
		}

		/** The directory of `path`, keeping the platform's separator style. */
		function dirOf(path) {
			const raw = String(path || "");
			const index = Math.max(raw.lastIndexOf("/"), raw.lastIndexOf("\\"));
			if (index === -1) return "";
			if (index === 0) return "/";
			// Windows drive root: "C:\\file" → "C:/"
			if (index === 2 && /^[a-zA-Z]:/.test(raw)) return raw.slice(0, 2) + "/";
			return raw.slice(0, index);
		}

		/** Resolve `rel` (possibly `./`/`../`) against `dir` into an absolute
		* path. Both separators are accepted; the result uses `/`, which is
		* valid on every platform the shell runs on. `..` climbs the base's
		* own segments and clamps at the filesystem root. */
		function resolveLocalPath(dir, rel) {
			const base = String(dir).replace(/[\\/]+$/, "");
			const drive = /^([a-zA-Z]:)[\\/]/.exec(base);
			const isAbsolute = base.startsWith("/") || drive !== null;
			const segs = base.split(/[\\/]/).filter((part) => part !== "");
			if (drive) segs.shift(); // the drive letter is re-attached below
			const parts = [];
			for (const part of String(rel).split(/[\\/]/)) {
				if (part === "" || part === ".") continue;
				if (part === "..") {
					if (parts.length > 0) parts.pop();
					else if (segs.length > 0) segs.pop();
					// above the root: dropped
				} else parts.push(part);
			}
			const joined = [...segs, ...parts].join("/");
			if (drive) return `${drive[1]}/${joined}`;
			return isAbsolute ? `/${joined}` : joined;
		}

		/** Absolute http URL the preview route serves one local file at. The
		* route is registered by the desktop-shell plugin on the harness web
		* server (loopback-only); the browser cannot read the disk itself. */
		function dshdFileUrl(path) {
			return `${location.origin}/dshd-file/${encodeURIComponent(path)}`;
		}

		function isDshdFileUrl(url) {
			return typeof url === "string" && url.startsWith(`${location.origin}/dshd-file/`);
		}

		/** Rewrite relative image destinations in markdown to absolute URLs of
		* the local-file route, so `![](./img.png)` renders for local docs. The
		* app's markdown renderer only allows absolute http(s) images, so the
		* rewrite is what makes local images visible at all. */
		function rewriteMarkdownImages(markdown, mdPath) {
			const dir = dirOf(mdPath);
			const rewrite = (whole, alt, url, rest) => {
				if (/^(https?:|data:|mailto:)/i.test(url) || url.startsWith("#")) return whole;
				// Absolute local paths (and Windows drive paths) pass through;
				// anything else resolves against the markdown's own directory.
				const abs = /^([a-zA-Z]:[\\/]|\/)/.test(url) ? url : resolveLocalPath(dir, url);
				if (abs === "") return whole;
				return `![${alt}](${dshdFileUrl(abs)}${rest ?? ""})`;
			};
			const imageRe = /!\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+[^)]*)?)\)/g;
			// True when the image match spanning [from, to) on `line` sits
			// inside a backtick code span: an odd number of backticks before it
			// (we are inside a span), or a backtick pair that encloses it.
			const inBacktickSpan = (line, from, to) => {
				let before = 0;
				let idx = line.indexOf("`");
				while (idx !== -1 && idx < from) {
					before++;
					idx = line.indexOf("`", idx + 1);
				}
				if (before % 2 === 1) return true;
				return line.lastIndexOf("`", from - 1) !== -1 && line.indexOf("`", to) !== -1;
			};
			let fence = null;
			return String(markdown).split("\n").map((line) => {
				const trimmed = line.trim();
				if (fence !== null) {
					// Inside a fence: a same-char marker run of 3+ closes it.
					if (new RegExp(`^\\${fence}{3,}\\s*$`).test(trimmed)) fence = null;
					return line;
				}
				const open = /^(`{3,}|~{3,})/.exec(trimmed);
				if (open) {
					fence = open[1][0];
					return line;
				}
				// Indented (4+ spaces or a tab) code line: code is shown
				// verbatim, so never rewrite an image link in it.
				if (/^( {4,}|\t)/.test(line)) return line;
				// Fast path: nothing to rewrite.
				if (line.indexOf("!") === -1) return line;
				// Rewrite image links, skipping any that sit inside a backtick
				// code span on this line.
				let output = "";
				let lastIndex = 0;
				let m;
				imageRe.lastIndex = 0;
				while ((m = imageRe.exec(line)) !== null) {
					if (inBacktickSpan(line, m.index, m.index + m[0].length)) {
						output += line.slice(lastIndex, m.index + m[0].length);
					} else {
						output += line.slice(lastIndex, m.index) + rewrite(m[0], m[1], m[2], m[3]);
					}
					lastIndex = m.index + m[0].length;
				}
				return output + line.slice(lastIndex);
			}).join("\n");
		}

		/** Extract a clickable outline from markdown source: heading level and
		* plain text (markdown markup stripped so it matches the rendered
		* textContent of the heading element). */
		function extractToc(markdown) {
			const toc = [];
			const seen = new Map();
			const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
			let match;
			while ((match = re.exec(String(markdown)))) {
				let text = match[2]
					.replace(/!\[[^\]]*\]\([^)]*\)/g, "")
					.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
					.replace(/[*_`~]/g, "")
					.replace(/\s+/g, " ")
					.trim();
				if (text === "") continue;
				const key = `${match[1].length}:${text}`;
				const occurrence = seen.get(key) ?? 0;
				seen.set(key, occurrence + 1);
				toc.push({ level: match[1].length, text, occurrence });
			}
			return toc;
		}

		/** Normalize a user-typed web address into an absolute http(s) URL, or
		* `null` when it cannot be one. */
		function normalizeWebUrl(raw) {
			let value = String(raw || "").trim();
			if (value === "") return null;
			if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) value = "https://" + value;
			try {
				const parsed = new URL(value);
				return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
			} catch {
				return null;
			}
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
			// Wrap the raw path in inline code when it carries markdown metacharacters
			// (spaces, *, _, #, [, ], (), `) so it stays visually literal in the draft.
			const escaped = /[\s*_#\[\]()\\`]/.test(path)
				? "`" + path.replace(/`/g, "``") + "`"
				: path;
			session.actions.setDraft(draft + sep + escaped);
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

		/** Add already-materialized image Files to the active session's draft
		* images. Returns false when no composer accepts them. Shared by the
		* file-panel attach, the drag-drop path and clipboard paste. */
		function attachImageFilesToComposer(sessions, conversation, files) {
			if (!conversation || typeof conversation.createDraftImages !== "function") return false;
			const session = composerSession(sessions);
			if (!session) return false;
			try {
				const ids = conversation.createDraftImages(files).map((attachment) => attachment.id);
				return session.actions.addImages(ids);
			} catch {
				return false;
			}
		}

		/** Read an image natively and add it to the active session's draft
		* images. Returns false when no composer or readable image exists. */
		async function attachImageToComposer(sessions, conversation, path, name) {
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
			return attachImageFilesToComposer(sessions, conversation, [file]);
		}

		/** Clipboard image paste. WebKitGTK exposes NO clipboard image items
		* through DOM paste events, so the SPA's own paste handler never sees
		* them. This listener (capture, installed once, native only) attaches
		* images from two sources: the clipboardData file items when the
		* webview does expose them, and a native clipboard read
		* (`desktop_clipboard_image`) otherwise. Text paste is never touched —
		* the SPA keeps handling it. */
		function installClipboardPaste(ctx) {
			if (!hasTauri() || typeof document === "undefined") return;
			if (installClipboardPaste.installed) return;
			installClipboardPaste.installed = true;

			document.addEventListener(
				"paste",
				(event) => {
					try {
						const data = event.clipboardData;
						if (!data) return;
						const imageFiles = Array.from(data.items || [])
							.filter((item) => item.kind === "file" && /^image\//i.test(item.type || ""))
							.map((item) => {
								try {
									return item.getAsFile();
								} catch {
									return null;
								}
							})
							.filter((file) => file !== null);
						if (imageFiles.length > 0) {
							// The webview exposed the image: attach it first, and
							// only swallow the event if the attachment landed. If
							// no composer is open, attachment fails — do NOT
							// preventDefault, so the SPA's own paste handling
							// still runs and the image is not silently lost.
							if (attachImageFilesToComposer(ctx.sessions, ctx.conversation, imageFiles)) {
								event.preventDefault();
								event.stopPropagation();
							} else {
								console.error("dsh-desktop: cannot attach pasted image (no active composer?)");
							}
							return;
						}
						// Plain-text paste: the clipboard holds text, not an
						// image — skip the native read entirely. The SPA keeps
						// handling text paste, and skipping avoids a pointless
						// IPC round-trip on every text paste (which is also what
						// spams console errors when the shell binary predates
						// this command). A paste whose data carries no text
						// (or an image/* type) still goes through the native
						// read, so image paste keeps working.
						let pastedText = "";
						try {
							pastedText = data.getData ? data.getData("text/plain") || "" : "";
						} catch {
							pastedText = "";
						}
						const hasImageType = Array.from(data.types || []).some((type) => /^image\//i.test(String(type)));
						if (!hasImageType && pastedText !== "") {
							return;
						}
						// No DOM image items — ask the shell to read the system
						// clipboard natively. If the clipboard holds an image it
						// lands in the composer as an attachment.
						window.__TAURI__.core
							.invoke("desktop_clipboard_image")
							.then((snapshot) => {
								if (!snapshot || typeof snapshot.content !== "string" || snapshot.content === "") return;
								const bytes = base64ToBytes(snapshot.content);
								if (bytes === null) return;
								let file;
								try {
									file = new File([bytes], "clipboard.png", { type: snapshot.mime || "image/png" });
								} catch {
									return;
								}
								attachImageFilesToComposer(ctx.sessions, ctx.conversation, [file]);
							})
							.catch((caught) => {
								// Shell builds that predate this command reject it
								// with an ACL/not-found error. That is a missing
								// feature, not a paste failure — text paste must
								// keep working — so report it once, quietly,
								// instead of erroring on every paste.
								const error = errText(caught);
								if (/not allowed by ACL|not found|unknown command/i.test(error)) {
									if (!installClipboardPaste.nativeUnavailable) {
										installClipboardPaste.nativeUnavailable = true;
										console.warn("dsh-desktop: native clipboard image paste unavailable (the shell binary is out of date):", error);
									}
									return;
								}
								console.error("dsh-desktop: clipboard image read failed:", error);
							});
					} catch (caught) {
						console.error("dsh-desktop: paste handler failed:", errText(caught));
					}
				},
				true
			);
		}

		// ── preview enhancements: source highlighting, mermaid, CSV ─────────
		/** Map a source-file extension (or the filename, case-insensitive) to a
		* shiki language alias the primitives' highlighter accepts, else null.
		* `dockerfile` is intentionally absent — it is not a shiki alias. */
		const LANG_ALIASES = {
			js: "jsx", mjs: "jsx", cjs: "jsx", jsx: "jsx",
			ts: "tsx", mts: "tsx", cts: "tsx", tsx: "tsx",
			sh: "bash", bash: "bash", zsh: "bash",
			json: "json", jsonc: "json",
			py: "python", rb: "ruby", go: "go", rs: "rust",
			java: "java", c: "c", h: "c",
			cpp: "cpp", cc: "cpp", hpp: "cpp", hh: "cpp",
			cs: "csharp", kt: "kotlin", kts: "kotlin", swift: "swift",
			php: "php", yaml: "yaml", yml: "yaml", toml: "toml",
			ini: "ini", cfg: "ini", conf: "ini",
			md: "markdown", markdown: "markdown", mdx: "mdx",
			html: "html", htm: "html", css: "css", scss: "scss", less: "less",
			sql: "sql", xml: "xml", plist: "xml", lua: "lua"
		};
		function langFromPath(name) {
			const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
			if (!match) return null;
			return LANG_ALIASES[match[1].toLowerCase()] || null;
		}

		function isMermaidName(name) {
			return /\.(mmd|mermaid)$/i.test(name || "");
		}

		function isCsvName(name) {
			return /\.(csv|tsv)$/i.test(name || "");
		}

		/** Split markdown source into segments, pulling any ```/~~~ fence whose
		* info string starts with the word `mermaid` out into a "mermaid"
		* segment. Everything else stays "markdown". An unclosed mermaid fence
		* at EOF is folded back into markdown so nothing is ever lost. */
		function splitMermaidFences(source) {
			const lines = String(source).split("\n");
			const segments = [];
			let markdown = [];
			let fence = null;
			let code = [];
			const flushMarkdown = () => {
				if (markdown.length > 0) {
					segments.push({ kind: "markdown", text: markdown.join("\n") });
					markdown = [];
				}
			};
			for (const line of lines) {
				const trimmed = line.trim();
				if (fence === null) {
					const open = /^(`{3,}|~{3,})[ \t]*(.*)$/.exec(trimmed);
					if (open) {
						const firstWord = (open[2] || "").trim().split(/\s+/, 1)[0].toLowerCase();
						if (firstWord === "mermaid") {
							flushMarkdown();
							fence = { marker: open[1][0], count: open[1].length };
							code = [];
							continue;
						}
					}
					markdown.push(line);
				} else {
					const close = new RegExp(`^\\${fence.marker}{${fence.count},}[ \\t]*$`).test(trimmed);
					if (close) {
						segments.push({ kind: "mermaid", code: code.join("\n") });
						fence = null;
						code = [];
					} else {
						code.push(line);
					}
				}
			}
			flushMarkdown();
			if (fence !== null) segments.push({ kind: "markdown", text: code.join("\n") });
			return segments;
		}

		/** Minimal RFC-4180-ish CSV/TSV parser: quoted fields may contain the
		* delimiter and newlines; a doubled quote inside quotes is a literal
		* quote. When `delimiter` is not "," or "\t" it is auto-detected from
		* the first line (the most frequent of comma/tab/semicolon wins).
		* Returns {rows, delimiter}. */
		function parseCsv(text, delimiter) {
			const src = String(text).replace(/^\uFEFF/, "");
			let delim = delimiter;
			if (delim !== "," && delim !== "\t" && delim !== ";") {
				const firstLine = src.split(/\r?\n/, 1)[0] || "";
				let commas = 0;
				let tabs = 0;
				let semis = 0;
				let inQuote = false;
				for (let i = 0; i < firstLine.length; i++) {
					const ch = firstLine[i];
					if (ch === '"') inQuote = !inQuote;
					else if (!inQuote) {
						if (ch === ",") commas++;
						else if (ch === "\t") tabs++;
						else if (ch === ";") semis++;
					}
				}
				if (tabs > commas && tabs > semis) delim = "\t";
				else if (semis > commas && semis > tabs) delim = ";";
				else delim = ",";
			}
			const rows = [];
			let row = [];
			let field = "";
			let inQ = false;
			const pushField = () => {
				row.push(field);
				field = "";
			};
			const pushRow = () => {
				pushField();
				rows.push(row);
				row = [];
			};
			for (let i = 0; i < src.length; i++) {
				const ch = src[i];
				if (inQ) {
					if (ch === '"') {
						if (src[i + 1] === '"') {
							field += '"';
							i++;
						} else {
							inQ = false;
						}
					} else {
						field += ch;
					}
				} else if (ch === '"') {
					// RFC-4180: a quote only STARTS a quoted segment at the
					// beginning of a field; a mid-field quote is a literal.
					if (field === "") inQ = true;
					else field += ch;
				} else if (ch === delim) {
					pushField();
				} else if (ch === "\n" || ch === "\r") {
					if (ch === "\r" && src[i + 1] === "\n") i++;
					pushRow();
				} else {
					field += ch;
				}
			}
			if (field !== "" || row.length > 0) pushRow();
			// A trailing newline leaves an empty last row — drop it.
			if (rows.length > 1) {
				const last = rows[rows.length - 1];
				if (last.length === 1 && last[0] === "") rows.pop();
			}
			return { rows, delimiter: delim };
		}

		/** Indices of columns (0-based) whose every non-header cell parses as a
		* finite number (empty cells disqualify the column). */
		function csvNumericColumns(rows) {
			const cols = [];
			if (!rows || rows.length < 2) return cols;
			const width = rows[0].length;
			for (let c = 0; c < width; c++) {
				let numeric = true;
				for (let r = 1; r < rows.length; r++) {
					const value = rows[r][c];
					if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Number(value.trim()))) {
						numeric = false;
						break;
					}
				}
				if (numeric) cols.push(c);
			}
			return cols;
		}

		/** Fast stable string hash (djb2) for diagram source — keeps rendered
		* diagrams keyed by content so a half-streamed fence does not flicker. */
		function hashString(value) {
			let hash = 5381;
			const s = String(value);
			for (let i = 0; i < s.length; i++) {
				hash = ((hash << 5) + hash + s.charCodeAt(i)) | 0;
			}
			return (hash >>> 0).toString(36);
		}

		// ── mermaid runtime (module-level singleton) ────────────────────────
		let mermaidIdCounter = 0;
		let mermaidInitialized = false;
		let mermaidScriptPromise = null;
		const mermaidSvgCache = new Map();
		const MERMAID_CACHE_LIMIT = 50;

		/** Inject the vendored mermaid script once; resolves on load, rejects on
		* failure (offline / missing asset). */
		function loadMermaid() {
			if (mermaidScriptPromise) return mermaidScriptPromise;
			mermaidScriptPromise = new Promise((resolve, reject) => {
				if (typeof document === "undefined") {
					mermaidScriptPromise = null;
					reject(new Error("No DOM to inject mermaid into."));
					return;
				}
				if (document.querySelector('script[data-dshd-mermaid]')) {
					resolve();
					return;
				}
				const script = document.createElement("script");
				script.setAttribute("data-dshd-mermaid", "1");
				script.src = `${location.origin}/dshd-asset/mermaid.min.js`;
				script.onload = () => resolve();
				script.onerror = () => {
					mermaidScriptPromise = null; // allow a later retry
					reject(new Error("Mermaid script failed to load (offline or missing asset)."));
				};
				document.head.appendChild(script);
			});
			return mermaidScriptPromise;
		}

		/** Render `code` to an SVG string via mermaid. Caches by source hash to
		* avoid re-render flicker when the SPA re-inserts a diagram. */
		async function renderMermaid(code) {
			const source = String(code || "").trim();
			if (source === "") throw new Error("Empty diagram.");
			const hash = hashString(source);
			const cached = mermaidSvgCache.get(hash);
			if (cached) return cached;
			await loadMermaid();
			if (typeof window.mermaid === "undefined" || typeof window.mermaid.initialize !== "function") {
				throw new Error("Mermaid failed to load (offline or missing asset).");
			}
			if (!mermaidInitialized) {
				try {
					window.mermaid.initialize({
						startOnLoad: false,
						theme: "dark",
						securityLevel: "strict",
						fontFamily: "var(--dsw-font-family, sans-serif)"
					});
				} catch (caught) {
					throw new Error(`Mermaid initialize failed: ${errText(caught)}`);
				}
				mermaidInitialized = true;
			}
			let svg;
			try {
				const result = await window.mermaid.render(`mermaid-${mermaidIdCounter++}`, source);
				svg = result && result.svg;
			} catch (caught) {
				throw new Error(`Mermaid render failed: ${errText(caught)}`);
			}
			if (typeof svg !== "string" || svg === "") throw new Error("Mermaid returned an empty diagram.");
			mermaidSvgCache.set(hash, svg);
			if (mermaidSvgCache.size > MERMAID_CACHE_LIMIT) {
				const firstKey = mermaidSvgCache.keys().next().value;
				if (firstKey !== void 0) mermaidSvgCache.delete(firstKey);
			}
			return svg;
		}

		/** Small component: renders a mermaid SVG with a loading placeholder, or
		* the raw source with an error caption when rendering fails. */
		function MermaidFence({ code }) {
			const [state, setState] = useState({ status: "loading", svg: null, error: null });
			useEffect(() => {
				let cancelled = false;
				setState({ status: "loading", svg: null, error: null });
				renderMermaid(code)
					.then((svg) => {
						if (!cancelled) setState({ status: "done", svg, error: null });
					})
					.catch((caught) => {
						if (!cancelled) setState({ status: "error", svg: null, error: errText(caught) });
					});
				return () => {
					cancelled = true;
				};
			}, [code]);
			if (state.status === "loading") {
				return h("div", {
					style: {
						display: "grid",
						placeItems: "center",
						minHeight: 80,
						padding: 16,
						margin: "8px 0",
						fontSize: 13,
						color: "var(--dsw-alias-label-tertiary)",
						border: "1px dashed var(--dsw-alias-border-l2)",
						borderRadius: 8,
						background: "var(--dsw-alias-bg-layer-1)"
					}
				}, "Rendering diagram…");
			}
			if (state.status === "error") {
				return h("div", { style: { margin: "8px 0" } },
					h("div", { style: { fontSize: 11, color: "var(--dsw-alias-state-error-primary)", marginBottom: 4 } },
						state.error || "Diagram could not be rendered."),
					h("pre", {
						style: {
							margin: 0,
							overflow: "auto",
							fontFamily: "var(--ds-font-family-code, monospace)",
							fontSize: 11,
							lineHeight: 1.5,
							color: "var(--dsw-alias-label-secondary)",
							whiteSpace: "pre-wrap",
							wordBreak: "break-word",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: 6,
							padding: 8,
							background: "var(--dsw-alias-bg-layer-1)"
						}
					}, code));
			}
			return h("div", { style: { overflowX: "auto", margin: "8px 0" }, dangerouslySetInnerHTML: { __html: state.svg } });
		}

		/** Inline SVG chart of one or more numeric CSV columns: x = row index,
		* y = numeric value. Every numeric column becomes a separate series
		* (distinct stroke colors + legend). */
		const SERIES_COLORS = ["#4f6ef7", "#e8a13a", "#2ecc71", "#e05561"];
		function CsvChart({ rows, numericCols, kind }) {
			const W = 720;
			const H = 260;
			const padL = 8;
			const padR = 88;
			const padT = 30;
			const padB = 12;
			const header = rows[0] || [];
			const cap = 2000;
			const dataRows = rows.slice(1, cap + 1);
			if (dataRows.length === 0 || numericCols.length === 0) {
				return h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "12px 0" } },
					"No numeric columns to chart.");
			}
			if (header.length > 12) {
				return h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "12px 0" } },
					"Too many columns to chart.");
			}
			let minY = Infinity;
			let maxY = -Infinity;
			for (const col of numericCols) {
				for (const row of dataRows) {
					const v = Number(row[col]);
					if (Number.isFinite(v)) {
						if (v < minY) minY = v;
						if (v > maxY) maxY = v;
					}
				}
			}
			if (!Number.isFinite(minY) || !Number.isFinite(maxY)) {
				minY = 0;
				maxY = 1;
			}
			if (minY === maxY) {
				minY -= 1;
				maxY += 1;
			}
			const range = maxY - minY;
			const plotW = W - padL - padR;
			const plotH = H - padT - padB;
			const xAt = (index) => padL + (dataRows.length <= 1 ? 0 : (index / Math.max(dataRows.length - 1, 1)) * plotW);
			const yAt = (value) => padT + (1 - (value - minY) / range) * plotH;

			const gridlines = [];
			for (let g = 0; g <= 3; g++) {
				const value = minY + (range * g) / 3;
				const y = yAt(value);
				gridlines.push(h("line", {
					key: `g${g}`,
					x1: padL,
					x2: W - padR,
					y1: y,
					y2: y,
					stroke: "var(--dsw-alias-border-l1, rgba(128,128,128,.35))",
					strokeWidth: 1
				}));
			}

			const series = numericCols.map((col, si) => {
				const color = SERIES_COLORS[si % SERIES_COLORS.length];
				const title = header[col] || `Col ${col + 1}`;
				const points = [];
				const bars = [];
				for (let i = 0; i < dataRows.length; i++) {
					const v = Number(dataRows[i][col]);
					if (!Number.isFinite(v)) continue;
					const x = xAt(i);
					const y = yAt(v);
					points.push([x, y]);
					if (kind === "bar") {
						const barW = Math.max((plotW / dataRows.length) / Math.max(numericCols.length, 1) - 1, 1);
						bars.push(h("rect", {
							key: `b${si}_${i}`,
							x: x - barW / 2,
							y,
							width: barW,
							height: Math.max(padT + plotH - y, 0),
							fill: color,
							opacity: 0.55
						}));
					}
				}
				const polyline = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
				return { color, title, polyline, bars };
			});

			const shapes = [];
			for (const s of series) {
				if (kind === "bar") shapes.push(s.bars);
				else if (s.polyline !== "") {
					shapes.push(h("polyline", { key: s.title + "-line", points: s.polyline, fill: "none", stroke: s.color, strokeWidth: 1.5, strokeLinejoin: "round", strokeLinecap: "round" }));
				}
			}

			return h("svg", { viewBox: `0 0 ${W} ${H}`, width: "100%", style: { maxHeight: 320, display: "block" } },
				gridlines,
				shapes,
				series.map((s, i) =>
					h("text", { key: s.title + "-lbl", x: W - padR + 6, y: padT + i * 16, fontSize: 11, fill: s.color },
						`■ ${s.title}`)));
		}

		/** CSV/TSV preview: a Table / Line / Bar switcher over the parsed rows. */
		function CsvView({ text }) {
			const [view, setView] = useState("table");
			const parsed = useMemo(() => {
				try {
					return parseCsv(text);
				} catch {
					return { rows: [], delimiter: "," };
				}
			}, [text]);
			const rows = parsed.rows;
			const numericCols = useMemo(() => csvNumericColumns(rows), [rows]);
			if (!rows || rows.length === 0) {
				return h("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-tertiary)", padding: "12px 0" } }, "Empty file.");
			}
			const cap = 2000;
			const dataRows = rows.slice(1, cap + 1);
			const truncated = rows.length - 1 > cap;
			const header = rows[0] || [];
			const btn = (name) => ({
				border: "1px solid var(--dsw-alias-border-l2)",
				background: view === name ? "var(--dsw-alias-interactive-bg-hover)" : "transparent",
				color: view === name ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
				borderRadius: 999,
				padding: "3px 10px",
				fontSize: 11,
				cursor: "pointer",
				fontFamily: "inherit"
			});
			let content;
			if (view === "table") {
				content = h("table", {
					style: {
						borderCollapse: "collapse",
						background: "var(--dsw-alias-bg-layer-1)",
						color: "var(--dsw-alias-label-secondary)"
					}
				},
					h("thead", null, h("tr", null, header.map((cell, i) =>
						h("th", { key: i, style: { padding: "4px 10px", border: "1px solid var(--dsw-alias-border-l2)", fontSize: 12, fontWeight: 600, textAlign: "left", position: "sticky", top: 0, background: "var(--dsw-alias-bg-hover)", color: "var(--dsw-alias-label-primary)", whiteSpace: "nowrap" } }, cell)))),
					h("tbody", null, dataRows.map((row, ri) =>
						h("tr", { key: ri }, header.map((_, ci) =>
							h("td", { key: ci, style: { padding: "4px 10px", border: "1px solid var(--dsw-alias-border-l2)", fontSize: 12, whiteSpace: "nowrap" } }, row[ci] ?? ""))))));
			} else {
				content = h(CsvChart, { rows, numericCols, kind: view });
			}
			return h("div", { style: { display: "flex", flexDirection: "column", gap: 8 } },
				h("div", { style: { display: "flex", gap: 6, flex: "none", paddingTop: 8 } },
					h("button", { type: "button", onClick: () => setView("table"), style: btn("table") }, "Table"),
					h("button", { type: "button", onClick: () => setView("line"), style: btn("line") }, "Line"),
					h("button", { type: "button", onClick: () => setView("bar"), style: btn("bar") }, "Bar")),
				content,
				truncated
					? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)" } }, "Showing first 2000 rows / points.")
					: null);
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
			// Web preview: iframe remount key (reload), history, busy spinner,
			// the page's own title (from the dshd-file bridge), image zoom.
			const [webRev, setWebRev] = useState(0);
			const [webHist, setWebHist] = useState([]);
			const [webIndex, setWebIndex] = useState(-1);
			const [webBusy, setWebBusy] = useState(false);
			const [webTitle, setWebTitle] = useState(null);
			const [urlDraft, setUrlDraft] = useState("");
			const [zoom, setZoom] = useState(false);
			const [imgDims, setImgDims] = useState(null);
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

			// Initial root: the remembered directory, else the current
			// workspace directory, else home. Depends on storeRev: the
			// workspace store starts pending (empty) and fills over RPC, so
			// the first render must not freeze the root on the home fallback.
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
			}, [workspaces, storeRev]);

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
					if (seq !== loadSeqRef.current) return false;
					setError(errText(caught));
					setEntries(null);
					return false;
				} finally {
					// Only the current load clears busy — a stale one must leave
					// it set so the next (fresher) call drops it, and the
					// refresh tick stays suppressed until navigation completes.
					if (seq === loadSeqRef.current) setBusy(false);
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

			// The last stat snapshot of the previewed file; a change (size or
			// mtime) auto-refreshes the preview (markdown re-renders, html
			// iframes reload, images re-read).
			const previewStatRef = useRef(null);
			// Mirrors for effect closures (interval/keydown must not re-arm
			// per keystroke and must see fresh state).
			const previewRef = useRef(null); previewRef.current = preview;
			const zoomRef = useRef(false); zoomRef.current = zoom;
			const webHistRef = useRef([]); webHistRef.current = webHist;
			const webIndexRef = useRef(-1); webIndexRef.current = webIndex;
			const mdRef = useRef(null);

			const openFile = useCallback(async (path, name) => {
				const seq = ++previewSeqRef.current;
				setPreviewError(null);
				setWebTitle(null);
				setImgDims(null);
				setPreview({ kind: "file", path, name, loading: true });
				explorerStore.setTab("preview");
				// Local .html/.htm previews are pages, not text: the iframe
				// loads the file through the local-file route, so relative
				// assets resolve — no content read needed.
				if (isHtmlName(name)) {
					try {
						const stat = await window.__TAURI__.core.invoke("desktop_stat", { path });
						if (seq !== previewSeqRef.current) return;
						previewStatRef.current = { size: stat.size, modified_ms: stat.modified_ms };
					} catch {
						previewStatRef.current = null;
					}
					if (seq !== previewSeqRef.current) return;
					setWebBusy(false);
					setWebRev((rev) => rev + 1);
					setPreview({ kind: "file", path, name, mode: "web", loading: false });
					return;
				}
				try {
					const content = await window.__TAURI__.core.invoke("desktop_read_file", { path });
					// A newer preview has superseded this response — drop it so it
					// cannot overwrite the current file's preview.
					if (seq !== previewSeqRef.current) return;
					previewStatRef.current = { size: content.size, modified_ms: content.modified_ms };
					if (content.encoding === "base64") {
						setPreview({ kind: "file", path, name, mode: "image", loading: false, ...content });
					} else if (content.encoding === "utf8" && isMermaidName(name)) {
						// Mermaid diagram source renders as live SVG.
						setPreview({ kind: "file", path, name, mode: "mermaid", source: content.content, loading: false, ...content });
					} else if (content.encoding === "utf8" && isCsvName(name)) {
						// CSV/TSV renders as a table with optional charts.
						setPreview({ kind: "file", path, name, mode: "csv", source: content.content, loading: false, ...content });
					} else if (content.encoding === "utf8" && isMarkdownName(name)) {
						// Markdown renders with the app's own renderer (the
						// conversation UI's), with relative images rewritten to
						// the local-file route.
						const source = rewriteMarkdownImages(content.content, path);
						setPreview({ kind: "file", path, name, mode: "markdown", source, toc: extractToc(content.content), loading: false, ...content });
					} else if (content.encoding === "utf8") {
						setPreview({ kind: "file", path, name, mode: "text", loading: false, ...content });
					} else {
						// Binary: hex dump of the head instead of "no preview".
						let dump;
						try {
							dump = await window.__TAURI__.core.invoke("desktop_hexdump", { path });
						} catch {
							dump = null;
						}
						if (seq !== previewSeqRef.current) return;
						if (dump) {
							previewStatRef.current = null;
							setPreview({ kind: "file", path, name, mode: "hexdump", loading: false, size: dump.size, text: dump.text, truncated: dump.truncated });
						} else {
							setPreview({ kind: "file", path, name, mode: "binary", loading: false, ...content });
						}
					}
				} catch (caught) {
					if (seq !== previewSeqRef.current) return;
					previewStatRef.current = null;
					setPreview({ kind: "file", path, name, loading: false, failed: true, error: errText(caught) });
				}
			}, []);

			// Open a web address in the preview pane (the URL bar in the
			// preview's empty state and header).
			const openUrl = useCallback((raw) => {
				const url = normalizeWebUrl(raw);
				if (url === null) {
					setPreview((current) => current && current.kind === "url"
						? { ...current, failed: true, error: "Not a valid http(s) address." }
						: { kind: "url", url: "", name: "Web", loading: false, failed: true, error: "Not a valid http(s) address." });
					return;
				}
				setPreviewError(null);
				setWebTitle(null);
				setUrlDraft(url);
				const index = webIndexRef.current;
				const hist = webHistRef.current.slice(0, index + 1);
				hist.push(url);
				const next = hist.slice(-50);
				webHistRef.current = next;
				setWebHist(next);
				setWebIndex(next.length - 1);
				setWebBusy(true);
				setWebRev((rev) => rev + 1);
				let host = url;
				try {
					host = new URL(url).host;
				} catch {
					// keep the raw url as the caption
				}
				setPreview({ kind: "url", url, name: host, loading: false });
				explorerStore.setTab("preview");
			}, []);

			const webBack = useCallback(() => {
				const index = webIndexRef.current;
				if (index <= 0) return;
				const target = webHistRef.current[index - 1];
				webIndexRef.current = index - 1;
				setWebIndex(index - 1);
				setWebTitle(null);
				setUrlDraft(target);
				setWebBusy(true);
				setWebRev((rev) => rev + 1);
				setPreview({ kind: "url", url: target, name: (() => { try { return new URL(target).host; } catch { return target; } })(), loading: false });
			}, []);

			const webForward = useCallback(() => {
				const index = webIndexRef.current;
				if (index >= webHistRef.current.length - 1) return;
				const target = webHistRef.current[index + 1];
				webIndexRef.current = index + 1;
				setWebIndex(index + 1);
				setWebTitle(null);
				setUrlDraft(target);
				setWebBusy(true);
				setWebRev((rev) => rev + 1);
				setPreview({ kind: "url", url: target, name: (() => { try { return new URL(target).host; } catch { return target; } })(), loading: false });
			}, []);

			// Re-read the current preview (Ctrl+R / header reload).
			const reloadPreview = useCallback(() => {
				const current = previewRef.current;
				if (!current) return;
				if (current.kind === "url") {
					setWebBusy(true);
					setWebRev((rev) => rev + 1);
					return;
				}
				openFile(current.path, current.name);
			}, [openFile]);

			// Tauri invoke wrapper for the panel (declared before the bridge
			// effect below, which calls it).
			const run = useCallback(async (command, args) => {
				try {
					await window.__TAURI__.core.invoke(command, args);
				} catch (caught) {
					setError(errText(caught));
				}
			}, []);

			// Bridge messages from local pages previewed in the sandboxed
			// iframe (the dshd-file route injects the bridge script): open
			// external links in the system browser, show the page's title.
			useEffect(() => {
				const onMessage = (event) => {
					const data = event.data;
					if (!data || data.source !== "dshd-file") return;
					// Only trust bridge messages from the local preview route,
					// which is served from this same harness origin. Cross-origin
					// frames (e.g. the arbitrary URL-preview iframe) get an opaque
					// origin here, so a remote page can never drive the OS opener
					// by faking `source: "dshd-file"`.
					if (event.origin !== location.origin) return;
					if (data.type === "open" && typeof data.url === "string") {
						// Re-validate the scheme on the panel side before shelling
						// out: only http/https/mailto reach the system opener.
						const url = data.url.trim();
						if (/^(https?:|mailto:)/i.test(url)) {
							run("desktop_open_path", { path: url });
						}
					} else if (data.type === "title" && typeof data.title === "string") {
						setWebTitle(data.title);
					}
				};
				window.addEventListener("message", onMessage);
				return () => window.removeEventListener("message", onMessage);
			}, [run]);



			// Auto-refresh: while a file preview is open, re-read it when the
			// file changes on disk (mtime/size), so markdown/images/html track
			// the editor instead of going stale.
			useEffect(() => {
				if (!open || picking || tab !== "preview" || !preview || preview.kind !== "file" || preview.loading || preview.mode === "web" || preview.mode === "hexdump" || preview.mode === "binary" || !hasTauri()) return;
				const timer = setInterval(async () => {
					if (typeof document !== "undefined" && document.hidden) return;
					const current = previewRef.current;
					if (!current || current.kind !== "file" || !current.path) return;
					try {
						const stat = await window.__TAURI__.core.invoke("desktop_stat", { path: current.path });
						const prev = previewStatRef.current;
						if (prev && (stat.size !== prev.size || stat.modified_ms !== prev.modified_ms)) {
							previewStatRef.current = { size: stat.size, modified_ms: stat.modified_ms };
							openFile(current.path, current.name);
						}
					} catch {
						// file gone or unreadable — keep the last preview
					}
				}, 2000);
				return () => clearInterval(timer);
			}, [open, picking, tab, preview, openFile]);

			// Same watch for local html previews: the file is not read into
			// JS, so the iframe reloads (rev bump) instead of a re-read.
			useEffect(() => {
				if (!open || picking || tab !== "preview" || !preview || preview.kind !== "file" || preview.mode !== "web" || !hasTauri()) return;
				const timer = setInterval(async () => {
					if (typeof document !== "undefined" && document.hidden) return;
					const current = previewRef.current;
					if (!current || current.kind !== "file" || current.mode !== "web") return;
					try {
						const stat = await window.__TAURI__.core.invoke("desktop_stat", { path: current.path });
						const prev = previewStatRef.current;
						if (prev && (stat.size !== prev.size || stat.modified_ms !== prev.modified_ms)) {
							previewStatRef.current = { size: stat.size, modified_ms: stat.modified_ms };
							setWebRev((rev) => rev + 1);
						}
					} catch {
						// keep the last rendered page
					}
				}, 2000);
				return () => clearInterval(timer);
			}, [open, picking, tab, preview]);

			// Preview hotkeys: Esc leaves the preview back to the file list,
			// Ctrl/Cmd+R reloads the current preview. Typing anywhere (URL
			// bar, filter, rename) is left alone.
			useEffect(() => {
				const onKey = (event) => {
					if (!previewRef.current) return;
					const el = document.activeElement;
					if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable)) return;
					if (event.key === "Escape") {
						if (zoomRef.current) {
							setZoom(false);
						} else {
							explorerStore.setTab("files");
						}
					// Ctrl/Cmd+R reload: physical key only (a Cyrillic letter
					// would alias a DIFFERENT physical key's shortcut).
					} else if ((event.ctrlKey || event.metaKey) && event.code === "KeyR") {
						event.preventDefault();
						reloadPreview();
					}
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [reloadPreview]);

			// The web preview spinner never hangs: hide it on load or after
			// 4 s (a site refusing to be framed never fires load).
			useEffect(() => {
				if (!webBusy) return;
				const timer = setTimeout(() => setWebBusy(false), 4000);
				return () => clearTimeout(timer);
			}, [webBusy, webRev]);

			const goUp = useCallback(async () => {
				if (!cwd) return;
				try {
					const parent = await window.__TAURI__.core.invoke("desktop_parent_dir", { path: cwd });
					if (typeof parent === "string") navigate(parent);
				} catch (caught) {
					setError(errText(caught));
				}
			}, [cwd, navigate]);

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
					// Reload the CURRENT directory, not the one captured when the
					// rename was started — the user may have navigated since.
					loadDir(cwdRef.current);
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
					// Reload the current directory (see commitRenameValue).
					loadDir(cwdRef.current);
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
					// Reload the current directory (see commitRenameValue).
					loadDir(cwdRef.current);
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
				const norm = (p) => p.replace(/\\/g, "/");
				const segs = pathSegments(cwd);
				if (segs.length === 0) return [];
				if (currentWorkspacePath) {
					const rootSegs = pathSegments(currentWorkspacePath);
					if (rootSegs.length > 0 && (norm(cwd) === norm(currentWorkspacePath) || norm(cwd).startsWith(norm(currentWorkspacePath) + "/"))) {
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

			// ── preview body ──
			const urlInputStyle = {
				flex: 1,
				minWidth: 0,
				fontSize: 12,
				padding: "3px 8px",
				borderRadius: 6,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-base)",
				color: "var(--dsw-alias-label-primary)",
				outline: "none"
			};

			/** Scroll the rendered markdown to a TOC heading: the app's renderer
			* emits plain h1–h6, so the heading is found by tag + text. */
			const scrollToc = (item) => {
				const root = mdRef.current;
				if (!root) return;
				const heads = root.querySelectorAll(`h${item.level}`);
				let seen = 0;
				for (const head of heads) {
					if ((head.textContent || "").trim() === item.text) {
						if (seen === item.occurrence) {
							head.scrollIntoView({ behavior: "smooth", block: "start" });
							return;
						}
						seen++;
					}
				}
			};

			const tocItemStyle = (level) => ({
				display: "block",
				width: "100%",
				textAlign: "left",
				border: "none",
				background: "none",
				cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)",
				fontSize: Math.max(10, 13 - level),
				lineHeight: 1.5,
				padding: "1px 0 1px " + ((level - 1) * 10) + "px",
				borderRadius: 4,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			});

			/** The Preview tab's content for one preview state. */
			const previewBody = (current) => {
				if (current.loading) {
					return h("div", { style: { flex: 1, display: "grid", placeItems: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 13 } }, "Loading…");
				}
				if (current.failed) {
					return h("div", { style: { padding: "0 12px", fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } },
						current.error || "Cannot read this file.");
				}
				if (current.kind === "url") {
					return h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
						h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", padding: "0 0 6px", flex: "none", display: "flex", alignItems: "center", gap: 6 } },
							"Some sites refuse to be embedded. ",
							h("button", {
								type: "button",
								style: { border: "none", background: "none", padding: 0, cursor: "pointer", color: "var(--dsw-alias-state-info-primary, #4f6ef7)", fontSize: 11, textDecoration: "underline" },
								onClick: () => run("desktop_open_path", { path: current.url })
							}, "Open in browser")),
						h("div", { style: { flex: 1, minHeight: 0, position: "relative" } },
							// Opaque origin (no allow-same-origin: the remote page
							// gets no cookies/storage and a null origin) and no
							// allow-popups (a hostile page cannot open phishing
							// windows on top of the app). Sites that refuse to
							// embed may use the "Open in browser" button above.
							h("iframe", {
								key: webRev,
								src: current.url,
								sandbox: "allow-scripts allow-forms",
								referrerPolicy: "no-referrer",
								style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", background: "#fff" },
								onLoad: () => setWebBusy(false)
							}),
							webBusy
								? h("div", { style: { position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 12, pointerEvents: "none" } }, "Loading…")
								: null));
				}
				if (current.mode === "web") {
					// Local page: served through the loopback file route so
					// relative assets resolve; sandboxed to an opaque origin so
					// the page's scripts cannot touch the app.
					return h("div", { style: { flex: 1, minHeight: 0, position: "relative", background: "#fff" } },
						h("iframe", {
							key: webRev,
							src: `${dshdFileUrl(current.path)}?rev=${webRev}`,
							sandbox: "allow-scripts allow-forms",
							referrerPolicy: "no-referrer",
							style: { position: "absolute", inset: 0, width: "100%", height: "100%", border: "none" }
						}));
				}
				if (current.mode === "image") {
					return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", display: "flex", flexDirection: "column", padding: 12, gap: 8 } },
						h("div", {
							style: { flex: 1, minHeight: 0, display: "grid", placeItems: "center", cursor: "zoom-in", overflow: "hidden" },
							title: "Click to zoom",
							onClick: () => setZoom(true)
						},
							h("img", {
								src: `data:${current.mime || "image/png"};base64,${current.content}`,
								alt: current.name,
								onLoad: (event) => {
									const width = event.target.naturalWidth;
									const height = event.target.naturalHeight;
									if (width && height) setImgDims({ width, height });
								},
								style: { maxWidth: "100%", maxHeight: "100%", borderRadius: 6, objectFit: "contain" }
							})),
						h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", textAlign: "center", flex: "none" } },
							[formatSize(current.size), imgDims ? ` · ${imgDims.width}×${imgDims.height}` : "", " · click to zoom"].join("")));
				}
				if (current.mode === "markdown") {
					// When the source carries a mermaid fence, render segments in
					// order (markdown blocks via the app renderer, mermaid fences
					// as live SVG). Ordinary markdown with no mermaid fence keeps
					// the exact single-MarkdownText path below.
					const mdBody = /\`\`\`\s*mermaid|~~~\s*mermaid/.test(current.source)
						? splitMermaidFences(current.source).map((segment, index) =>
								segment.kind === "mermaid"
									? h(MermaidFence, { key: index, code: segment.code })
									: h(MarkdownText, { key: index, text: segment.text, codeLabels: { copyLabel: "Copy", copiedLabel: "Copied" } }))
						: h(MarkdownText, { text: current.source, codeLabels: { copyLabel: "Copy", copiedLabel: "Copied" } });
					return h("div", { ref: mdRef, className: "dshd-scroll", style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" } },
						current.toc && current.toc.length > 1
							? h("details", { style: { margin: "4px 0 12px", fontSize: 12, color: "var(--dsw-alias-label-secondary)" } },
									h("summary", { style: { cursor: "pointer", userSelect: "none" } },
										`Table of contents (${current.toc.length})`),
									h("div", { style: { marginTop: 6, display: "flex", flexDirection: "column", gap: 2 } },
										current.toc.map((item, index) =>
											h("button", { key: index, type: "button", title: item.text, onClick: () => scrollToc(item), style: tocItemStyle(item.level) }, item.text))))
							: null,
						mdBody,
						current.truncated
							? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", padding: "4px 0 8px" } },
									`Preview cut at 1 MB — the full file is ${formatSize(current.size)}.`)
							: null);
				}
				if (current.mode === "mermaid") {
					return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 12px 12px" } },
						h(MermaidFence, { code: current.source }));
				}
				if (current.mode === "csv") {
					return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 12px 12px" } },
						h(CsvView, { text: current.source }));
				}
				if (current.mode === "hexdump") {
					return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 12px 12px" } },
						h("pre", {
							style: {
								margin: 0,
								fontFamily: "var(--ds-font-family-code, monospace)",
								fontSize: 11,
								lineHeight: 1.55,
								color: "var(--dsw-alias-label-secondary)",
								whiteSpace: "pre"
							}
						}, current.text || " "),
						h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", padding: "4px 0 8px" } },
							current.truncated
								? `Showing the first 32 KB of ${formatSize(current.size)}.`
								: `${formatSize(current.size)} binary file.`));
				}
				if (current.mode === "binary") {
					return h("div", { style: { padding: 24, fontSize: 13, color: "var(--dsw-alias-label-tertiary)", textAlign: "center" } },
						"This is a binary file (no preview).");
				}
				// Plain text / source. Known source extensions render through the
				// primitives' CodeBlock (syntax highlighting + copy button) inside
				// a scrollable wrapper; everything else keeps the raw pre.
				const sourceLang = langFromPath(current.name);
				const sourceContent = current.content || "";
				return h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 12px 12px" } },
					sourceLang !== null && sourceContent.length <= 512 * 1024
						? h("div", { style: { flex: 1, minHeight: 0, overflow: "auto", minWidth: 0 } },
								h(CodeBlock, { code: sourceContent, lang: sourceLang, copyLabel: "Copy", copiedLabel: "Copied" }))
						: h("pre", {
								style: {
									margin: 0,
									fontFamily: "var(--ds-font-family-code, monospace)",
									fontSize: 12,
									lineHeight: 1.6,
									color: "var(--dsw-alias-label-secondary)",
									whiteSpace: "pre-wrap",
									wordBreak: "break-word"
								}
							}, sourceContent || " "),
					current.truncated
						? h("div", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary)", padding: "4px 0 8px" } },
								`Preview cut at 1 MB — the full file is ${formatSize(current.size)}.`)
						: null);
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
								? h("div", { style: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, padding: 24, textAlign: "center" } },
										h("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: 13 } },
											"Select a file in the Files tab to preview it here."),
										h("div", { style: { display: "flex", gap: 6, width: "100%", maxWidth: 300 } },
											h("input", {
												style: urlInputStyle,
												placeholder: "…or open a web page (https://…)",
												value: urlDraft,
												onChange: (event) => setUrlDraft(event.target.value),
												onKeyDown: (event) => {
													event.stopPropagation();
													if (event.key === "Enter") openUrl(urlDraft);
												}
											}),
											h("button", { type: "button", className: "dshd-round", title: "Open URL", style: roundButton, onClick: () => openUrl(urlDraft) },
												h(IconGlobeOutline16, {}))))
								: h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
										h("div", { style: { display: "flex", alignItems: "center", gap: 4, padding: "0 0 8px", flex: "none" } },
											h("button", {
												type: "button",
												className: "dshd-round",
												title: "Back to files",
												onClick: () => explorerStore.setTab("files"),
												style: roundButton
											}, h(IconChevronLeftOutline14, {})),
											preview.kind === "url"
												? h("input", {
														style: urlInputStyle,
														placeholder: "https://…",
														value: urlDraft,
														onChange: (event) => setUrlDraft(event.target.value),
														onKeyDown: (event) => {
															event.stopPropagation();
															if (event.key === "Enter") openUrl(urlDraft);
														},
														onFocus: (event) => event.target.select()
													})
												: h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13, fontWeight: 500 }, title: preview.path || preview.url || "" },
														webTitle || preview.name || ""),
											preview.kind === "url"
												? h("button", { type: "button", className: "dshd-round", title: "Back", disabled: webIndex <= 0, onClick: webBack, style: { ...roundButton, opacity: webIndex <= 0 ? 0.4 : 1 } },
														h(IconChevronLeftOutline14, {}))
												: null,
											preview.kind === "url"
												? h("button", { type: "button", className: "dshd-round", title: "Forward", disabled: webIndex >= webHist.length - 1, onClick: webForward, style: { ...roundButton, opacity: webIndex >= webHist.length - 1 ? 0.4 : 1 } },
													h(IconChevronRightOutline14, {}))
												: null,
											h("button", { type: "button", className: "dshd-round", title: "Reload (Ctrl+R)", onClick: reloadPreview, style: roundButton },
												h(IconRefreshOutline14, {})),
											h("button", {
												type: "button",
												className: "dshd-round",
												title: preview.kind === "url" ? "Open in browser" : "Open externally",
												onClick: () => run("desktop_open_path", { path: preview.kind === "url" ? preview.url : preview.path }),
												style: roundButton
											}, h(IconRightUpOutline14, {})),
											h("button", {
												type: "button",
												className: "dshd-round",
												title: preview.kind === "url" ? "Copy URL" : "Copy path",
												onClick: () => writeClipboard(preview.kind === "url" ? preview.url : preview.path),
												style: roundButton
											}, h(IconCopyOutline16, {})),
											h("button", {
												type: "button",
												className: "dshd-round",
												title: "Send path to agent",
												disabled: !sessions,
												onClick: () => {
													if (preview.kind !== "file") return;
													if (!insertPathIntoComposer(sessions, relativeTo(currentWorkspacePath, preview.path))) {
														setError("No active conversation to insert the path into.");
													}
												},
												style: { ...roundButton, opacity: !sessions ? 0.4 : 1 }
											}, h(IconSendOutline14, {})),
											preview.kind === "file" && preview.mode === "image"
												? h("button", {
														type: "button",
														className: "dshd-round",
														title: "Attach to message",
														disabled: !sessions,
														onClick: () => {
															attachImageToComposer(sessions, conversation, preview.path, preview.name).then((ok) => {
																if (!ok) setError("Cannot attach the image: no active conversation or unreadable file.");
															});
														},
														style: { ...roundButton, opacity: !sessions ? 0.4 : 1 }
													}, h(IconPaperclipOutline16, {}))
												: null
										),
										previewBody(preview),
										zoom && preview.kind === "file" && preview.mode === "image"
											? h("div", {
													style: { position: "fixed", inset: 0, zIndex: 9999, background: "rgba(0,0,0,0.78)", display: "grid", placeItems: "center", cursor: "zoom-out" },
													title: "Click to close (Esc)",
													onClick: () => setZoom(false)
												},
													h("img", { src: `data:${preview.mime || "image/png"};base64,${preview.content}`, alt: preview.name, style: { maxWidth: "94vw", maxHeight: "94vh", borderRadius: 8, boxShadow: "0 8px 40px rgba(0,0,0,0.5)" } }))
											: null
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

		/** One labelled row: text on the left, arbitrary control on the right.
		* `result` is an optional line under the hint — an action's outcome. */
		function Row({ label, hint, control, result }) {
			return h("div", { style: { display: "flex", alignItems: "center", gap: 12, padding: "5px 0" } },
				h("div", { style: { flex: 1, minWidth: 0 } },
					h("div", { style: LABEL }, label),
					hint ? h("div", { style: HINT }, hint) : null,
					result ? h("div", { style: { ...HINT, marginTop: 4 } }, result) : null
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

		function DesktopSection({ openWorkspace, workspaces }) {
			const tauri = hasTauri();
			const [state, setState] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);
			const [notice, setNotice] = useState(null);
			const [progress, setProgress] = useState(null);
			const [installInfo, setInstallInfo] = useState(null);
			const noticeTimer = useRef(null);

			/** Transient inline feedback for one-shot actions (reset, test). */
			const flash = useCallback((message) => {
				setNotice(message);
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice(null), 4000);
			}, []);

			useEffect(() => () => {
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
			}, []);

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

			// The workspace the harness works in (first attached folder), kept
			// live so the card shows what the agent actually works on.
			const [workspacePath, setWorkspacePath] = useState(null);
			useEffect(() => {
				if (!tauri || !workspaces || typeof workspaces.list?.getSnapshot !== "function") return;
				const read = () => {
					try {
						const snapshot = workspaces.list.getSnapshot();
						for (const item of snapshot.items || []) {
							const view = item && typeof item.getSnapshot === "function" ? item.getSnapshot().view : item && item.view;
							if (view && typeof view.path === "string" && view.path !== "") {
								setWorkspacePath(view.path);
								return;
							}
						}
						setWorkspacePath(null);
					} catch {
						// store not ready yet — next subscription tick will retry
					}
				};
				read();
				if (typeof workspaces.list.subscribe === "function") {
					return workspaces.list.subscribe(read);
				}
			}, [tauri, workspaces]);

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

			const testNotification = useCallback(async () => {
				try {
					setError(null);
					await window.__TAURI__.core.invoke("desktop_test_notification");
					flash("Test notification sent.");
				} catch (caught) {
					setError(errText(caught));
				}
			}, [flash]);

			const resetGeometry = useCallback(async () => {
				try {
					setError(null);
					await window.__TAURI__.core.invoke("desktop_reset_geometry");
					flash("Window size and position reset.");
				} catch (caught) {
					setError(errText(caught));
				}
			}, [flash]);

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

			return h(DesktopSettingsView, {
				state,
				error,
				installInfo,
				notice,
				busy,
				progress,
				workspacePath,
				onSet: setSetting,
				onCheckNow: checkNow,
				onUpdateNow: updateNow,
				onOpenRelease: () => run("desktop_open_release"),
				onTestNotification: testNotification,
				onResetGeometry: resetGeometry,
				onPickWorkspace: pickWorkspace
			});
		}

		/** Pure settings layout: renders the whole page from a state snapshot.
		* Split from DesktopSection so the smoke test can render the real
		* markup without a native client. Handlers are one-way props; the
		* container owns fetching, busy state and feedback. */
		function DesktopSettingsView({ state, error, installInfo, notice, busy, progress, workspacePath, onSet, onCheckNow, onUpdateNow, onOpenRelease, onTestNotification, onResetGeometry, onPickWorkspace }) {
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

			// Outcome of the last "Check now": an update on offer, or up to date.
			const checkOutcome = update
				? h("span", { style: { color: "var(--dsw-alias-state-business-primary)" } }, `v${update.version} available — update from the banner above.`)
				: state.last_update_check
					? h("span", { style: { color: "var(--dsw-alias-state-success-primary)" } }, `Up to date — checked ${lastCheck}.`)
					: null;

			// The select shows the stored interval even when it isn't one of
			// the presets (older versions clamped to arbitrary values).
			const INTERVAL_OPTIONS = [1, 3, 6, 12, 24];
			const intervalOptions = INTERVAL_OPTIONS.includes(settings.update_interval_hours)
				? INTERVAL_OPTIONS
				: [settings.update_interval_hours, ...INTERVAL_OPTIONS];

			return h("div", { style: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column" } },
				// Live error line (invoke failures, check errors, update errors).
				error || state.update_check_error
					? h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" } },
							error || state.update_check_error)
					: null,

				// Transient feedback for one-shot actions ("Test notification sent").
				notice
					? h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-success-primary)", display: "flex", alignItems: "center", gap: 8 } },
							h(IconCheckOutline14, {}), h("span", { style: { color: "var(--dsw-alias-label-primary)" } }, notice))
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
								h(Button, { variant: "primary", size: "sm", icon: h(IconDownloadOutline16, {}), disabled: busy, onClick: () => onUpdateNow() },
									updating ? "Updating…" : "Update now"),
								h(Button, { size: "sm", icon: h(IconGlobeOutline14, {}), disabled: busy, onClick: () => onOpenRelease() }, "Open release")
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

				// Window.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Window"),
					h("div", { style: { ...HINT, margin: "0 0 6px" } }, "How the window behaves in your desktop environment."),
					h(Row, {
						label: "Close window to tray",
						hint: "Closing the window hides it to the tray and keeps the harness running; Quit from the tray exits.",
						control: h(Switch, { checked: settings.tray, onChange: (value) => onSet("tray", value) })
					}),
					h(Row, {
						label: "Window size and position",
						hint: "Remembered across restarts. Reset returns to the default 1280×860, centered.",
						control: h(Button, { size: "sm", onClick: () => onResetGeometry() }, "Reset")
					})
				),

				// Workspace.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Workspace"),
					h("div", { style: { ...HINT, margin: "0 0 6px" } }, "The folder the harness works in. You can also drag a folder into the window."),
					h(Row, {
						label: workspacePath ? baseName(workspacePath) : "No workspace yet",
						hint: workspacePath ? workspacePath : "Choose a folder to give the harness a place to work.",
						control: h(Button, { size: "sm", icon: h(IconFolderOpenOutline16, {}), disabled: busy, onClick: () => onPickWorkspace() }, "Choose folder…")
					})
				),

				// Notifications.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Notifications"),
					h("div", { style: { ...HINT, margin: "0 0 6px" } }, "OS notifications for finished agents, errors and questions — plus update and tray hints."),
					h(Row, {
						label: "Native notifications",
						hint: "Shown by your desktop environment, not inside the window.",
						control: h(Switch, { checked: settings.notifications, onChange: (value) => onSet("notifications", value) })
					}),
					h(Row, {
						label: "Test notifications",
						hint: "Send a sample notification to check that your desktop environment shows them.",
						control: h(Button, { size: "sm", disabled: !settings.notifications, onClick: () => onTestNotification() }, "Send test")
					})
				),

				// Updates.
				h("div", { style: CARD },
					h("div", { style: H3 }, "Updates"),
					h("div", { style: { ...HINT, margin: "0 0 6px" } }, "The desktop client updates from GitHub releases. Nothing is ever applied automatically."),
					h(Row, {
						label: "Check for updates automatically",
						hint: "Queries GitHub releases periodically. Off by default — updates are one click whenever you want them.",
						control: h(Switch, { checked: settings.auto_update_check, onChange: (value) => onSet("auto_update_check", value) })
					}),
					h(Row, {
						label: "Check interval",
						hint: "How often to re-check while automatic checking is enabled.",
						control: h(Select, {
							value: settings.update_interval_hours,
							options: intervalOptions,
							disabled: !settings.auto_update_check,
							onChange: (value) => onSet("update_interval_hours", value)
						})
					}),
					h(Row, {
						label: "Check for updates now",
						hint: "Run an update check right away.",
						result: checkOutcome,
						control: h(Button, { size: "sm", icon: h(IconRefreshOutline14, {}), disabled: busy, onClick: () => onCheckNow() }, busy ? "Checking…" : "Check now")
					})
				),

				// About — diagnostics only, no actions.
				h("div", { style: CARD },
					h("div", { style: H3 }, "About"),
					h("div", { style: { ...HINT, margin: "0 0 6px" } }, "Version and install paths — useful when reporting a problem."),
					h(Row, { label: "Version", control: h("span", { style: VALUE }, `v${state.version}`) }),
					installInfo
						? h(Row, { label: "Profile", control: h("span", { style: { ...VALUE, fontSize: 12, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, installInfo.profile) })
						: null,
					installInfo
						? h(Row, { label: "Client", control: h("span", { style: { ...VALUE, fontSize: 12, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } }, installInfo.client) })
						: null
				)
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

		// ── mermaid + CSV in chat answers ──────────────────────────────────
		// Non-invasive DOM augmentation: a debounced MutationObserver renders a
		// mermaid fence and a CSV fence from live assistant answers into an SVG
		// / table placed as a SIBLING of the `<pre>` (via insertAdjacentElement
		// "beforebegin"), never touching the React-managed nodes themselves.
		// SAFETY: we never remove or restructure React-managed nodes; the only
		// node we ever mutate is the injected `<div data-dshd-diagram>` (ours)
		// and the `style.display` on the `<pre>` (only on success). React
		// reconciliation may drop our injected sibling on a re-render, which the
		// per-node hash check turns into a clean re-insert, never a duplicate.
		let answerDiagramsInstalled = false;
		function installAnswerDiagrams() {
			if (!hasTauri() || typeof document === "undefined") return;
			if (answerDiagramsInstalled) return;
			answerDiagramsInstalled = true;

			const schedule = (() => {
				let timer = null;
				return (fn) => {
					if (timer !== null) clearTimeout(timer);
					timer = setTimeout(() => {
						timer = null;
						fn();
					}, 800);
				};
			})();

			const escapeHtml = (value) =>
				String(value).replace(/[&<>"']/g, (ch) => ({
					"&": "&amp;",
					"<": "&lt;",
					">": "&gt;",
					'"': "&quot;",
					"'": "&#39;"
				}[ch]));

			/** Build the inner HTML for a CSV `<pre>`, token-styled, capped. */
			function csvInnerHtml(text) {
				let rows;
				try {
					rows = parseCsv(text).rows;
				} catch {
					return null;
				}
				if (!rows || rows.length === 0) return "<div></div>";
				const cap = 2000;
				const header = rows[0] || [];
				const data = rows.slice(1, cap + 1);
				const truncated = rows.length - 1 > cap;
				const th = "padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;font-weight:600;text-align:left;background:var(--dsw-alias-bg-hover);color:var(--dsw-alias-label-primary);white-space:nowrap";
				const td = "padding:4px 10px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;white-space:nowrap";
				let html = '<div style="max-height:320px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;margin:4px 0">';
				html += '<table style="border-collapse:collapse;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)">';
				html += "<thead><tr>";
				for (const cell of header) html += `<th style="${th}">${escapeHtml(cell)}</th>`;
				html += "</tr></thead><tbody>";
				for (const row of data) {
					html += "<tr>";
					for (let c = 0; c < header.length; c++) html += `<td style="${td}">${escapeHtml(row[c] ?? "")}</td>`;
					html += "</tr>";
				}
				html += "</tbody></table>";
				if (truncated) html += '<div style="padding:6px 10px;font-size:11px;color:var(--dsw-alias-label-tertiary)">Showing first 2000 rows.</div>';
				html += "</div>";
				return html;
			}

			/** Render one matched `<pre>` up to date with `sourceCode`. */
			function renderOne(pre, sourceCode, kind) {
				const hash = hashString(sourceCode);
				const parent = pre.parentNode;
				if (!parent) return;
				// Find our previous injected sibling (if any) for this pre.
				let diagramEl = null;
				for (let node = pre.previousSibling; node; node = node.previousSibling) {
					if (node.nodeType === Node.ELEMENT_NODE && node.hasAttribute && node.hasAttribute("data-dshd-diagram")) {
						diagramEl = node;
						break;
					}
				}
				if (diagramEl && diagramEl.getAttribute("data-dshd-hash") === hash) return; // up to date
				const pending = kind === "mermaid"
					? renderMermaid(sourceCode)
					: Promise.resolve(csvInnerHtml(sourceCode));
				pending
					.then((html) => {
						if (html === null || html === undefined) return; // leave pre visible
						try {
							if (diagramEl) diagramEl.remove();
							const el = document.createElement("div");
							el.setAttribute("data-dshd-diagram", "1");
							el.setAttribute("data-dshd-hash", hash);
							el.innerHTML = html;
							parent.insertBefore(el, pre);
							pre.style.display = "none";
						} catch {
							// leave the pre visible; never corrupt the tree
						}
					})
					.catch(() => {
						// Render failed: leave the pre visible and drop a stale diagram.
						try {
							if (diagramEl) diagramEl.remove();
						} catch {
							// ignore
						}
					});
			}

			function scanOne(codeEl, kind) {
				const pre = codeEl && codeEl.parentElement;
				if (!pre || pre.tagName !== "PRE") return;
				const sourceCode = String(codeEl.textContent || "").trim();
				if (sourceCode === "") return;
				renderOne(pre, sourceCode, kind);
			}

			/** First non-empty line of `code` (lowercased). */
			const firstLine = (code) => {
				for (const line of String(code).split("\n")) {
					const trimmed = line.trim();
					if (trimmed !== "") return trimmed;
				}
				return "";
			};

			/** Content-based fence kind detection. The SPA's CodeBlock renders
			* UNKNOWN languages (mermaid, csv) through its plain fallback, whose
			* `<code>` carries NO `language-*` class — class selectors can never
			* match them. Detect by content instead: mermaid diagrams open with
			* a distinctive first keyword; CSV/TSV is only considered for the
			* CLASSLESS (plain fallback) blocks, so a real highlighted code
			* block like `print(a, b)` can never be mistaken for a table. */
			function fenceKind(code, codeEl) {
				const first = firstLine(code);
				if (first === "") return null;
				if (
					/^(graph|flowchart)\s+(TB|TD|BT|RL|LR)\b/i.test(first) ||
					/^(sequenceDiagram|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|mindmap|timeline|gitGraph|block-beta|quadrant|C4Context|packet|xychart-beta|sankey|zenuml|architecture-beta)\b/i.test(first)
				) {
					return "mermaid";
				}
				// CSV: only the plain fallback (no language-* class) is
				// eligible, the first line must look like a header (no code
				// punctuation), and every non-empty line must carry the same
				// delimiter count. Conservative — prose with one comma per
				// line stays untouched only if it also passes these gates.
				if (codeEl && typeof codeEl.className === "string" && codeEl.className.includes("language-")) return null;
				if (/[()=;{}[\]<>]/.test(first)) return null;
				const lines = String(code).split("\n").map((line) => line.trim()).filter((line) => line !== "");
				if (lines.length >= 2) {
					const firstCount = countDelims(lines[0]);
					if (firstCount > 0 && lines.every((line) => countDelims(line) === firstCount)) {
						if (!/^(import |from |def |class |const |let |var |function |SELECT |INSERT |UPDATE |#|<!--|\/\/|\/\*|\{|})/i.test(lines[0])) {
							return "csv";
						}
					}
				}
				return null;
			}
			const countDelims = (line) => {
				const commas = (line.match(/,/g) || []).length;
				const tabs = (line.match(/\t/g) || []).length;
				const semis = (line.match(/;/g) || []).length;
				const total = commas + tabs + semis;
				// Mixed delimiters are not tabular.
				if ((commas > 0) + (tabs > 0) + (semis > 0) > 1) return -1;
				return total;
			};

			/** One pass over the conversation container: every code block is
			* classified by content and rendered when it looks like a fence.
			* Also sweeps orphaned diagram siblings: when React removes a `<pre>`
			* (message regeneration), the injected diagram that preceded it has
			* no pre left to anchor to — drop it so no ghost stays on screen. */
			function scan() {
				try {
					const scope = document.querySelector("[data-conversation-scroll]");
					if (!scope) return;
					for (const code of scope.querySelectorAll("pre code")) {
						const kind = fenceKind(String(code.textContent || ""), code);
						if (kind !== null) scanOne(code, kind);
					}
					for (const diagram of scope.querySelectorAll("[data-dshd-diagram]")) {
						let sibling = diagram.nextElementSibling;
						while (sibling && sibling.tagName !== "PRE") sibling = sibling.nextElementSibling;
						if (!sibling) diagram.remove();
					}
				} catch {
					// the observer callback must never throw
				}
			}

			try {
				// Re-entrancy/throttle guard: drop immediately-repeated scans and
				// skip entirely while the document is hidden. The observer still
				// stays connected for the whole session so late-rendered answers
				// are always detected; scan() work is just kept cheap.
				let lastScanAt = 0;
				const onBodyMutation = () => {
					if (typeof document !== "undefined" && document.hidden) return;
					const now = Date.now();
					if (now - lastScanAt < 250) return;
					schedule(() => {
						lastScanAt = Date.now();
						scan();
					});
				};
				const observer = new MutationObserver(onBodyMutation);
				// characterData matters: the final chunk of a streamed fence often
				// lands as an in-place text update, not a childList change — a
				// scan that only fires on childList would leave the last partial
				// render (or none) on screen.
				observer.observe(document.body, { childList: true, subtree: true, characterData: true });
			} catch {
				// observer unavailable (very old webview) — degrade silently
			}
		}

		/** Register the section once the settings surface declares its section slot. */
		function apply(ctx) {
			explorerStore.init();
			// Custom window title bar (native only).
			if (hasTauri() && typeof document !== "undefined") installTitlebar();
			// Window title follows the active chat (native only): the
			// sessions service's current session drives the native title.
			if (hasTauri() && typeof document !== "undefined") watchDocumentTitle(ctx);
			// On-screen error badge (native only): makes webview runtime
			// errors visible instead of silent.
			if (hasTauri() && typeof document !== "undefined") installErrorBadge();
			// Self-heal watchdog (native only): reloads the webview if the
			// panel dies silently while the store says it is open.
			if (hasTauri() && typeof document !== "undefined") installPanelWatchdog();
			// External links open in the system browser instead of a dead
			// `target="_blank"` (native only).
			if (hasTauri() && typeof document !== "undefined") installExternalLinks();
			// Ctrl/Cmd+F quick search over the visible chat (native only).
			if (hasTauri() && typeof document !== "undefined") installChatSearch();
			// Mermaid + CSV rendered inside live chat answers (native only).
			if (hasTauri() && typeof document !== "undefined") installAnswerDiagrams();
			// Clipboard image paste → composer attachment (native only).
			if (hasTauri() && typeof document !== "undefined") installClipboardPaste(ctx);

			// Native file/folder integration: dropping a directory onto the
			// window opens it as a workspace; dropping image files attaches
			// them to the active composer (falling back to an inline path when
			// no composer or faithful read is available); any other file lands
			// as a path in the composer draft. The tauri core emits this event
			// to the webview on every drop; directory-ness is checked natively.
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
									if (isDirectory === true) {
										openWorkspace(ctx, path);
										return;
									}
									const name = baseName(path);
									if (isImageName(name)) {
										attachImageToComposer(ctx.sessions, ctx.conversation, path, name)
											.then((attached) => {
												if (attached !== true) insertPathIntoComposer(ctx.sessions, path);
											})
											.catch((error) => {
												console.error(`dsh-desktop: cannot attach dropped image ${path}:`, error);
												try {
													insertPathIntoComposer(ctx.sessions, path);
												} catch (inner) {
													console.error(`dsh-desktop: cannot insert dropped path ${path}:`, inner);
												}
											});
									} else {
										try {
											insertPathIntoComposer(ctx.sessions, path);
										} catch (error) {
											console.error(`dsh-desktop: cannot insert dropped path ${path}:`, error);
										}
									}
								})
								.catch((error) => {
									console.error(`dsh-desktop: cannot inspect dropped path ${path}:`, error);
								});
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
				inject: () => ({
					openWorkspace: (path) => openWorkspace(ctx, path),
					workspaces: ctx.workspaces
				})
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
		// Test hook: the pure preview helpers and the pure settings layout,
		// exercised by the smoke test without a webview (inert for the shell,
		// which only reads apply/inject).
		exports.previewHelpers = {
			rewriteMarkdownImages,
			extractToc,
			resolveLocalPath,
			normalizeWebUrl,
			dshdFileUrl,
			langFromPath,
			splitMermaidFences,
			parseCsv,
			csvNumericColumns
		};
		exports.desktopSettingsView = DesktopSettingsView;
		return module.exports;
	}
});
