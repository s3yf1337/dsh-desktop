window.__ModuleLoader__.load({
	id: "dsh-desktop-shell",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region dsh-desktop settings tab
		/**
		* The "dsh-desktop" section of the Settings surface (browser half).
		*
		* Registers one `settings.section` entry that renders the desktop shell's
		* native preferences: tray (close-to-tray), OS notifications, the GitHub
		* updater (suggest-only), and window geometry. All state lives in the
		* native client (`dsh-desktop-shell`) and is reached through
		* `window.__TAURI__` — the same origin a browser would load, so when the
		* harness is opened in a plain browser this section renders a notice
		* instead of dead controls.
		*/
		const { createElement: h, useState, useEffect, useCallback } = react;
		const { Button, IconDownloadOutline16, IconRefreshOutline14, IconGlobeOutline14, IconSettingsOutline16, IconFolderOpenOutline16 } =
			_deepseek_ai_dsh_client_ui_primitives;

		const NS = "desktopShell";
		const inject = ["slots", "workspaces"];

		const STATE_EVENT = "desktop://state";

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
			const tauri = typeof window !== "undefined" && window.__TAURI__ !== void 0 && window.__TAURI__.core !== void 0;
			const [state, setState] = useState(null);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);

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
						"The dsh-desktop settings (tray, notifications, updates, window geometry) belong to the native " +
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

			return h("div", { style: { width: "100%", maxWidth: 760, color: "var(--dsw-alias-label-primary)", display: "flex", flexDirection: "column" } },
				// Live error line (invoke failures, check errors).
				error || state.update_check_error
					? h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-error-primary)", color: "var(--dsw-alias-state-error-primary)" } },
							error || state.update_check_error)
					: null,

				// Update suggestion banner — the updater only ever suggests.
				update
					? h("div", { style: { ...CARD, borderColor: "var(--dsw-alias-state-business-primary)" } },
							h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
								h("div", { style: { flex: 1, minWidth: 0 } },
									h("div", { style: LABEL }, `dsh-desktop ${update.version} is available`),
									h("div", { style: HINT },
										update.published_at
											? `Published ${new Date(update.published_at).toLocaleDateString()}. ` +
												"Updates are never applied automatically — open the release page and update when ready."
											: "Updates are never applied automatically — open the release page and update when ready."
									)
								),
								h(Button, { variant: "primary", size: "sm", icon: h(IconDownloadOutline16, {}), onClick: () => run("desktop_open_release") }, "Open release")
							)
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
						hint: "Queries GitHub releases periodically. Found updates are suggested, never applied automatically.",
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

		/** Register the section once the settings surface declares its section slot. */
		function apply(ctx) {
			// Native folder integration: dropping a directory onto the window
			// opens it as a workspace. Files are left to the webview, which
			// handles attachments. The tauri core emits this event to the
			// webview on every drop; directory-ness is checked natively.
			if (typeof window !== "undefined" && window.__TAURI__ !== void 0 && window.__TAURI__.core !== void 0) {
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
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
