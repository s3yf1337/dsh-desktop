// Smoke test for the dsh-desktop browser plugin (bundle/lib/client.js).
//
// Loads the REAL client.js module against real react + react-dom, with
// @deepseek-ai/dsh-client-ui-primitives STUBBED (the primitivesStub below),
// runs its apply() with a mock plugin context, then server-renders the
// explorer panel and the settings section. This checks the import-name
// contract of the primitives (a missing/renamed import becomes undefined and
// fails the render) plus that the panel renders. The title bar needs a DOM,
// so it is skipped here; the panel and settings are the React-rendered half.
//
// Run: node test/client-smoke.mjs  (set DSH_NM to the dsh install with
// react/react-dom when dsh lives elsewhere than the default below)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const DSH_NM = process.env.DSH_NM || "/home/seyf/.local/lib/node_modules/@deepseek-ai/dsh/node_modules";
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
	"IconCodeOutline16", "IconDataOutline16", "IconSearchOutline16", "IconPanelLeftOutline16",
	"IconPlusOutline16", "IconCheckOutline14", "IconCopyOutline16", "IconTrashOutline16",
	"IconEditOutline16", "IconChevronUpOutline14", "IconPaperclipOutline16", "IconRightUpOutline14",
	"IconLinkOutline16", "IconSendOutline14", "IconFolderClose16",
	"IconGlobeOutline16"
]) {
	primitivesStub[name] = () => h("svg", { "data-icon": name });
}
primitivesStub.Button = Primitive;
primitivesStub.Menu = () => null;
primitivesStub.Modal = () => null;
primitivesStub.writeClipboard = async () => true;
// The app's markdown renderer: a stub that just echoes the text, so the
// preview panel renders in the smoke test without the real primitives.
primitivesStub.MarkdownText = ({ text }) => h("div", { "data-markdown": true }, text);
// Stub of the primitives' CodeBlock (syntax-highlighted source preview).
primitivesStub.CodeBlock = ({ code }) => h("pre", { "data-codeblock": true }, code);

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

// ── pure preview helpers ──────────────────────────────────────────────────
const helpers = plugin.previewHelpers;
if (!helpers || typeof helpers.rewriteMarkdownImages !== "function") {
	throw new Error("client.js did not export previewHelpers");
}
globalThis.location = { origin: "http://127.0.0.1:9999" };
{
	const { rewriteMarkdownImages, extractToc, resolveLocalPath, normalizeWebUrl, dshdFileUrl } = helpers;
	const md = "/home/u/docs/readme.md";
	// Relative images resolve against the markdown's directory.
	const rewritten = rewriteMarkdownImages("![a](./img/x.png) ![b](../img/y.png) ![c](https://x.io/i.png) ![d](img.png \"title\")", md);
	if (!rewritten.includes(`![a](${dshdFileUrl("/home/u/docs/img/x.png")})`)) throw new Error("relative image not rewritten: " + rewritten);
	if (!rewritten.includes(`![b](${dshdFileUrl("/home/u/img/y.png")})`)) throw new Error("parent-relative image not rewritten");
	if (!rewritten.includes("![c](https://x.io/i.png)")) throw new Error("remote image must stay untouched");
	if (!rewritten.includes(`![d](${dshdFileUrl("/home/u/docs/img.png")} \"title\")`)) throw new Error("titled relative image must be rewritten and keep its title");
	// Code fences stay literal.
	const fenced = rewriteMarkdownImages("```md\n![x](./a.png)\n```\n\n![y](./b.png)", md);
	if (!fenced.includes("![x](./a.png)")) throw new Error("fenced image was rewritten");
	if (!fenced.includes(dshdFileUrl("/home/u/docs/b.png"))) throw new Error("image after the fence was not rewritten");
	// TOC: level, stripped text, occurrence counting.
	const toc = extractToc("# Title\n\n## A *bold*\n\n## A bold\n\n### Deep `code`\n");
	if (JSON.stringify(toc) !== JSON.stringify([
		{ level: 1, text: "Title", occurrence: 0 },
		{ level: 2, text: "A bold", occurrence: 0 },
		{ level: 2, text: "A bold", occurrence: 1 },
		{ level: 3, text: "Deep code", occurrence: 0 }
	])) throw new Error("toc mismatch: " + JSON.stringify(toc));
	// URL normalization.
	if (normalizeWebUrl("github.com") !== "https://github.com/") throw new Error("bare host should gain https");
	if (normalizeWebUrl("http://a.b") !== "http://a.b/") throw new Error("http kept");
	if (normalizeWebUrl("javascript:alert(1)") !== null) throw new Error("non-http(s) schemes rejected");
	if (normalizeWebUrl("") !== null) throw new Error("empty rejected");
	// Path resolution.
	if (resolveLocalPath("/a/b", "../c/d.txt") !== "/a/c/d.txt") throw new Error("resolveLocalPath mismatch");
	console.log("preview helpers OK (markdown rewrite, TOC, URL normalization, path resolution)");
}

// ── new pure helpers: lang detection, mermaid fences, CSV parsing ─────────
{
	const { langFromPath, splitMermaidFences, parseCsv, csvNumericColumns } = helpers;
	if (langFromPath("x.py") !== "python") throw new Error(`langFromPath("x.py") !== "python": ${langFromPath("x.py")}`);
	if (langFromPath("x.unknownext") !== null) throw new Error(`langFromPath unknown should be null: ${langFromPath("x.unknownext")}`);
	if (langFromPath("x.tsx") !== "tsx") throw new Error(`langFromPath("x.tsx") !== "tsx"`);
	if (langFromPath("X.JS") !== "jsx") throw new Error(`langFromPath must be case-insensitive`);
	if (langFromPath("Dockerfile") !== null) throw new Error("dockerfile must NOT be a language alias");
	const segs = splitMermaidFences("before\n```mermaid\ngraph TD\n  A-->B\n```\nafter");
	if (segs.length !== 3) throw new Error("splitMermaidFences segment count: " + JSON.stringify(segs));
	if (segs[0].kind !== "markdown" || segs[1].kind !== "mermaid" || segs[2].kind !== "markdown") throw new Error("splitMermaidFences kinds: " + JSON.stringify(segs));
	if (segs[1].code !== "graph TD\n  A-->B") throw new Error("splitMermaidFences code: " + JSON.stringify(segs[1].code));
	if (!segs[0].text.includes("before") || !segs[2].text.includes("after")) throw new Error("splitMermaidFences surrounding text lost");
	// Tilde-fenced and attribute-laden mermaid infos are matched too; a fence
	// with no surrounding text yields a single mermaid segment.
	const tilded = splitMermaidFences("~~~mermaid {align=center}\nsequenceDiagram\n~~~");
	if (tilded.length !== 1 || tilded[0].kind !== "mermaid") throw new Error("tilde mermaid fence not split: " + JSON.stringify(tilded));
	if (tilded[0].code !== "sequenceDiagram") throw new Error("tilde mermaid code: " + JSON.stringify(tilded[0].code));
	const csv = parseCsv('"a,b",c');
	if (JSON.stringify(csv.rows) !== JSON.stringify([["a,b", "c"]])) throw new Error("parseCsv quoted comma: " + JSON.stringify(csv.rows));
	if (csv.delimiter !== ",") throw new Error("parseCsv quoted comma should detect comma: " + csv.delimiter);
	const csvTab = parseCsv("a\tb\n1\t2");
	if (JSON.stringify(csvTab.rows) !== JSON.stringify([["a", "b"], ["1", "2"]])) throw new Error("parseCsv tab: " + JSON.stringify(csvTab.rows));
	if (csvTab.delimiter !== "\t") throw new Error("parseCsv tab detect: " + csvTab.delimiter);
	const nums = csvNumericColumns(parseCsv("name,age,score\nAl,30,9.5\nBo,42,8").rows);
	if (JSON.stringify(nums) !== JSON.stringify([1, 2])) throw new Error("csvNumericColumns: " + JSON.stringify(nums));
	const mixed = csvNumericColumns(parseCsv("name,age,score\nAl,30,n\/a\nBo,42,8").rows);
	if (JSON.stringify(mixed) !== JSON.stringify([1])) throw new Error("csvNumericColumns should skip non-numeric columns: " + JSON.stringify(mixed));
	console.log("preview helpers OK (langFromPath, splitMermaidFences, parseCsv, csvNumericColumns)");
}

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

// ── render the pure settings layout with a full state snapshot ──────────
const SettingsView = plugin.desktopSettingsView;
if (typeof SettingsView !== "function") {
	throw new Error("client.js did not export desktopSettingsView");
}
const fakeState = {
	version: "0.2.0",
	settings: {
		tray: true,
		notifications: true,
		auto_update_check: false,
		update_interval_hours: 6,
		tray_hide_hint_shown: false
	},
	update: null,
	last_update_check: "2025-08-15T10:00:00Z",
	update_check_error: null,
	client: true
};
const viewProps = {
	state: fakeState,
	installInfo: { profile: "/home/u/.dsh/profiles/desktop", client: "/home/u/.local/bin/dsh-desktop-shell" },
	notice: null,
	busy: false,
	progress: null,
	workspacePath: "/home/u/work",
	onSet: async () => {},
	onCheckNow: async () => {},
	onUpdateNow: async () => {},
	onOpenRelease: async () => {},
	onTestNotification: async () => {},
	onResetGeometry: async () => {},
	onPickWorkspace: async () => {}
};
const viewHtml = renderToString(h(SettingsView, viewProps));
for (const token of [
	"Window", "Workspace", "Notifications", "Updates", "About",
	"Close window to tray", "Native notifications", "Check for updates automatically",
	"Check interval", "Check for updates now", "Choose folder…", "/home/u/work",
	"Up to date", "Reset", "Send test"
]) {
	if (!viewHtml.includes(token)) throw new Error(`settings view missing "${token}"`);
}
for (const gone of ["Open releases page", "Show explorer", "Hide panel", "File manager & preview", "Send test notification", "Pick folder"]) {
	if (viewHtml.includes(gone)) throw new Error(`settings view still contains removed row "${gone}"`);
}
// The update banner renders with its one-click actions when an update is on offer.
const withUpdate = renderToString(h(SettingsView, { ...viewProps, state: { ...fakeState, update: { version: "0.3.0", url: "https://github.com/s3yf1337/dsh-desktop/releases", published_at: null } } }));
for (const token of ["0.3.0 is available", "Update now", "Open release"]) {
	if (!withUpdate.includes(token)) throw new Error(`update banner missing "${token}"`);
}
// Transient action feedback renders as a notice line.
const withNotice = renderToString(h(SettingsView, { ...viewProps, notice: "Test notification sent." }));
if (!withNotice.includes("Test notification sent.")) throw new Error("action feedback notice missing");
console.log("settings layout rendered OK (Window / Workspace / Notifications / Updates / About, no stray action rows)");

console.log("\nclient.js smoke test PASSED");
