// Smoke test for the dsh-desktop browser plugin (bundle/lib/client.js).
//
// Loads the REAL client.js module against real react + real
// @deepseek-ai/dsh-client-ui-primitives, runs its apply() with a mock plugin
// context, then server-renders the explorer panel and the settings section.
// Any render error (wrong icon import, bad hook usage, undefined component)
// fails this test. The title bar needs a DOM, so it is skipped here; the
// panel and settings are the React-rendered half.
//
// Run: node test/client-smoke.mjs  (set DSH_NM to the dsh install with
// react/react-dom when dsh lives elsewhere than the default below)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const DSH_NM = process.env.DSH_NM || "/home/seyf/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules";
const react = require(DSH_NM + "/react");
const { renderToString } = require(DSH_NM + "/react-dom/server");
const h = react.createElement;

// ── shims ────────────────────────────────────────────────────────────────
const localStorageShim = (() => {
	let store = new Map([["dshd.explorer.open", "1"], ["dshd.explorer.tab", "files"]]);
	return {
		getItem: (k) => store.get(k) ?? null,
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k)
	};
})();

// Stub of @deepseek-ai/dsh-client-ui-primitives. It must export exactly the
// names client.js imports — a missing/renamed import becomes `undefined`
// here and fails the render below, which is precisely what we want to catch.
const Primitive = ({ icon, children, ...rest }) => h("button", rest, icon, children);
const primitivesStub = {};
for (const name of [
	"IconDownloadOutline16", "IconRefreshOutline14", "IconGlobeOutline14",
	"IconSettingsOutline16", "IconFolderOpenOutline16", "IconFolderOpen16",
	"IconChevronLeftOutline14", "IconChevronRightOutline14", "IconCloseOutline16",
	"IconCodeOutline16", "IconDataOutline16", "IconSearchOutline16", "IconPanelLeftOutline16"
]) {
	primitivesStub[name] = () => h("svg", { "data-icon": name });
}
primitivesStub.Button = Primitive;

globalThis.localStorage = localStorageShim;
globalThis.window = {
	__TAURI__: {
		core: {
			invoke: async () => {
				throw new Error("no native client in this test");
			}
		},
		event: {
			listen: async () => () => {}
		},
		window: {
			getCurrentWindow: () => ({
				minimize: async () => {},
				toggleMaximize: async () => {},
				close: async () => {},
				isMaximized: async () => false,
				startResizeDragging: async () => {}
			})
		}
	},
	__ModuleLoader__: {
		load: (definition) => {
			const fakeRequire = (spec) => {
				if (spec === "react") return react;
				if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
				throw new Error("unexpected require: " + spec);
			};
			// The factory returns its own module.exports.
			window.__MODULE_EXPORTS__ = definition.factory(fakeRequire);
		}
	}
};

// Load the real client.js text and evaluate it in this realm.
const clientSource = readFileSync(new URL("../bundle/lib/client.js", import.meta.url), "utf8");
const evalClient = new Function(clientSource);
evalClient();

const plugin = window.__MODULE_EXPORTS__;
if (!plugin || typeof plugin.apply !== "function" || !Array.isArray(plugin.inject)) {
	throw new Error("client.js did not export apply/inject");
}
console.log("client.js loaded; inject =", JSON.stringify(plugin.inject));

// ── mock plugin context ──────────────────────────────────────────────────
const registrations = [];
const mockCtx = {
	slots: {
		inject: (name, factory) => {
			// factory() calls ctx.slots.register({...}, Component)
			const registration = factory();
			// register is shimmed below to capture the component
			void registration;
		},
		register: (...args) => {
			registrations.push({ slot: args[0].name, component: args[1] });
			return {};
		}
	},
	workspaces: {
		list: {
			getSnapshot: () => ({ items: [] })
		}
	}
};
plugin.apply(mockCtx);

const settingsReg = registrations.find((r) => r.slot === "settings.section");
const explorerReg = registrations.find((r) => r.slot === "shell.overlay");
if (!settingsReg) throw new Error("settings.section slot was not registered");
if (!explorerReg) throw new Error("shell.overlay slot was not registered");
console.log("registered slots:", registrations.map((r) => r.slot).join(", "));

// ── render the explorer panel (Files/Preview tabs) ───────────────────────
const SettingsComponent = settingsReg.component;
const ExplorerComponent = explorerReg.component;

const explorerHtml = renderToString(h(ExplorerComponent, { workspaces: mockCtx.workspaces }));
const expects = ["Files", "Preview"];
for (const token of expects) {
	if (!explorerHtml.includes(token)) throw new Error(`explorer panel missing "${token}"`);
}
console.log("explorer panel rendered OK (Files/Preview tabs present)");

// ── render the settings section (tauri stub present → initial "Loading…") ──
const settingsHtml = renderToString(h(SettingsComponent, { openWorkspace: async () => {} }));
if (settingsHtml.length === 0) {
	throw new Error("settings section rendered empty");
}
console.log("settings section rendered OK (" + settingsHtml.length + " chars)");

console.log("\nclient.js smoke test PASSED");
