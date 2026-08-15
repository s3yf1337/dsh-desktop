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
			IconPanelLeftOutline16
		} = _deepseek_ai_dsh_client_ui_primitives;

		const NS = "desktopShell";
		const inject = ["slots", "workspaces"];

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
				if (typeof localStorage !== "undefined") localStorage.setItem("dshd.explorer.open", this.open ? "1" : "0");
				this.notify();
			},
			toggle() {
				this.setOpen(!this.open);
			},
			setTab(tab) {
				this.tab = tab;
				if (typeof localStorage !== "undefined") localStorage.setItem("dshd.explorer.tab", tab);
				this.notify();
			},
			setWidth(width) {
				const clamped = Math.min(EXPLORER_MAX_WIDTH, Math.max(EXPLORER_MIN_WIDTH, width));
				this.width = clamped;
				if (typeof localStorage !== "undefined") localStorage.setItem("dshd.explorer.width", String(clamped));
				this.notify();
			},
			subscribe(fn) {
				this.listeners.add(fn);
				return () => this.listeners.delete(fn);
			},
			notify() {
				for (const fn of this.listeners) fn();
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

		/**
		* The right-hand explorer panel. Rendered into the `shell.overlay` slot
		* (the app's full-frame overlay layer), docked to the right edge below
		* the title bar. Two tabs — Files and Preview — with exactly one active
		* at a time, and a close button that hides the whole panel.
		*/
		function ExplorerPanel({ workspaces, close }) {
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

			useEffect(() => explorerStore.subscribe(() => {
				setOpen(explorerStore.open);
				setTab(explorerStore.tab);
			}), []);

			// Dock/un-dock exactly like the app's own columns: the panel's
			// width and the frame's reserved space both transition with the
			// app's tokens (--ds-transition-duration-slow / --ds-ease-in-out),
			// and the content fades in like the sidebar's wide-in keyframes.
			useEffect(() => {
				const panel = panelRef.current;
				if (open) {
					setRendered(true);
					syncExplorerLayout(explorerStore.width);
					if (panel) panel.style.width = "0px";
					const raf = requestAnimationFrame(() => {
						if (panelRef.current) panelRef.current.style.width = `${explorerStore.width}px`;
					});
					return () => cancelAnimationFrame(raf);
				}
				if (panel) panel.style.width = "0px";
				syncExplorerLayout(0);
				const timer = setTimeout(() => setRendered(false), 360);
				return () => clearTimeout(timer);
			}, [open]);

			// Resize: drag the handle → live-update the panel width + frame
			// padding during the drag, commit to the store on release.
			const startResize = (event) => {
				event.preventDefault();
				event.stopPropagation();
				const handle = event.currentTarget;
				const startX = event.clientX;
				const startWidth = explorerStore.width;
				let lastWidth = startWidth;
				handle.classList.add("dragging");
				document.body.classList.add("dshd-resizing");
				if (panelRef.current) panelRef.current.style.transition = "none";
				const onMove = (moveEvent) => {
					const next = Math.min(
						EXPLORER_MAX_WIDTH,
						Math.max(EXPLORER_MIN_WIDTH, startWidth + (startX - moveEvent.clientX))
					);
					lastWidth = next;
					if (panelRef.current) panelRef.current.style.width = `${next}px`;
					syncExplorerLayout(next);
				};
				const onUp = () => {
					handle.classList.remove("dragging");
					document.body.classList.remove("dshd-resizing");
					handle.removeEventListener("pointermove", onMove);
					handle.removeEventListener("pointerup", onUp);
					handle.removeEventListener("pointercancel", onUp);
					if (panelRef.current) {
						panelRef.current.style.transition =
							"width var(--ds-transition-duration-slow) var(--ds-ease-in-out)";
					}
					explorerStore.setWidth(lastWidth);
				};
				handle.setPointerCapture(event.pointerId);
				handle.addEventListener("pointermove", onMove);
				handle.addEventListener("pointerup", onUp);
				handle.addEventListener("pointercancel", onUp);
			};

			// Initial root: the current workspace directory, else home.
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

			const loadDir = useCallback(async (path) => {
				setBusy(true);
				setError(null);
				try {
					const list = await window.__TAURI__.core.invoke("desktop_list_dir", { path });
					setCwd(path);
					setEntries(list);
				} catch (caught) {
					setError(caught && typeof caught === "object" && caught.message ? caught.message : String(caught));
					setEntries(null);
				} finally {
					setBusy(false);
				}
			}, []);

			// (Re)open the panel → load the current directory.
			useEffect(() => {
				if (!open) return;
				if (cwd !== null) {
					loadDir(cwd);
					return;
				}
				if (root !== null) {
					loadDir(root);
					return;
				}
				setBusy(true);
				window.__TAURI__.core
					.invoke("desktop_home_dir")
					.then((home) => loadDir(home))
					.catch((caught) => {
						setError(caught && typeof caught === "object" && caught.message ? caught.message : String(caught));
						setBusy(false);
					});
			}, [open, root, cwd, loadDir]);

			const openFile = useCallback(async (path, name) => {
				setPreviewError(null);
				setPreview({ path, name, loading: true });
				explorerStore.setTab("preview");
				try {
					const content = await window.__TAURI__.core.invoke("desktop_read_file", { path });
					setPreview({ path, name, loading: false, ...content });
				} catch (caught) {
					setPreview({ path, name, loading: false, failed: true, error: caught && typeof caught === "object" && caught.message ? caught.message : String(caught) });
				}
			}, []);

			const goUp = useCallback(async () => {
				if (!cwd) return;
				try {
					const parent = await window.__TAURI__.core.invoke("desktop_parent_dir", { path: cwd });
					if (typeof parent === "string") loadDir(parent);
				} catch (caught) {
					setError(caught && typeof caught === "object" && caught.message ? caught.message : String(caught));
				}
			}, [cwd, loadDir]);

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
				width: 0,
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
				transition: "width var(--ds-transition-duration-slow) var(--ds-ease-in-out)",
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

			return h("div", { ref: panelRef, className: "dshd-explorer-panel", style, "data-dshd-explorer": true },
				// Resize handle (docked columns have one, like the app's own).
				h("div", { id: "dshd-explorer-resize", onPointerDown: (event) => startResize(event) }),
				h("div", { style: headerStyle },
					h("div", { style: tabsStyle },
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

				tab === "files"
					? h("div", { style: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" } },
							h("div", { style: { display: "flex", alignItems: "center", gap: 2, padding: "0 0 8px", flex: "none" } },
								h("button", {
									type: "button",
									className: "dshd-round",
									title: "Up",
									disabled: !cwd || busy,
									onClick: () => goUp(),
									style: pathButton(!cwd || busy)
								}, h(IconChevronLeftOutline14, {})),
								h("button", {
									type: "button",
									className: "dshd-round",
									title: "Refresh",
									disabled: !cwd || busy,
									onClick: () => cwd && loadDir(cwd),
									style: pathButton(!cwd || busy)
								}, h(IconRefreshOutline14, {})),
								h("div", {
									title: cwd || "",
									style: {
										flex: 1,
										minWidth: 0,
										fontSize: 12,
										color: "var(--dsw-alias-label-tertiary)",
										whiteSpace: "nowrap",
										overflow: "hidden",
										textOverflow: "ellipsis",
										fontFamily: "var(--ds-font-family-code, monospace)",
										padding: "0 4px"
									}
								}, cwd || "…")
							),
							error
								? h("div", { style: { padding: "0 4px 8px", fontSize: 12, color: "var(--dsw-alias-state-error-primary)" } }, error)
								: null,
							!entries
								? h("div", { style: { flex: 1, display: "grid", placeItems: "center", color: "var(--dsw-alias-label-tertiary)", fontSize: 13, padding: "0 8px", textAlign: "center" } },
										busy ? "Loading…" : (error ? "Nothing to show" : "No workspace yet — pick a folder in Settings → dsh-desktop."))
								: h("div", { className: "dshd-scroll", style: { flex: 1, minHeight: 0, overflowY: "auto", padding: "0 0 12px" } },
										entries.map((entry) =>
											h("button", {
												key: entry.path,
												type: "button",
												className: "dshd-row",
												title: entry.path,
												onClick: () => (entry.is_dir ? loadDir(entry.path) : openFile(entry.path, entry.name)),
												style: {
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
													boxSizing: "border-box"
												}
											},
												h("span", { style: { color: entry.is_dir ? "var(--dsw-alias-label-secondary)" : "var(--dsw-alias-label-tertiary)", display: "grid", placeItems: "center", flex: "none" } },
													entry.is_dir ? h(IconFolderOpen16, {}) : h(IconDataOutline16, {})),
												h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 13 } }, entry.name),
												entry.is_dir
													? null
													: h("span", { style: { flex: "none", fontSize: 11, color: "var(--dsw-alias-label-tertiary)", fontVariantNumeric: "tabular-nums", paddingLeft: 8 } },
															formatTime(entry.modified_ms), " ", formatSize(entry.size))
											)
										)
									)
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
						)
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
				refresh();
				window.__TAURI__.event
					.listen(STATE_EVENT, (event) => setState(event.payload))
					.then((unlisten) => {
						off = unlisten;
					})
					.catch(() => {});
				window.__TAURI__.event
					.listen(UPDATE_PROGRESS_EVENT, (event) => setProgress(event.payload))
					.catch(() => {});
				window.__TAURI__.core
					.invoke("desktop_install_info")
					.then(setInstallInfo)
					.catch(() => {});
				return () => {
					if (off) off();
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

			// Native folder picker → attach the chosen directory as a workspace.
			const pickWorkspace = useCallback(async () => {
				if (busy) return;
				setBusy(true);
				try {
					setError(null);
					const path = await window.__TAURI__.core.invoke("desktop_pick_directory");
					if (typeof path === "string" && path !== "" && typeof openWorkspace === "function") {
						await openWorkspace(path);
					}
				} catch (caught) {
					setError(errText(caught));
				} finally {
					setBusy(false);
				}
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
						hint: "Open a native folder picker and attach the chosen directory as a workspace. You can also just drag a folder into the window.",
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

		/** Register the section once the settings surface declares its section slot. */
		function apply(ctx) {
			explorerStore.init();
			// Custom window title bar (native only).
			if (hasTauri() && typeof document !== "undefined") installTitlebar();

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
			// the layout plugin declares it.
			if (hasTauri()) {
				ctx.slots.inject("shell.overlay", () => ctx.slots.register({
					name: "shell.overlay",
					id: "desktop-explorer",
					order: 90,
					locale: NS,
					inject: () => ({ workspaces: ctx.workspaces })
				}, ExplorerPanel));
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
