#!/usr/bin/env node
// Drive the TEST harness instance over its loopback /api (typert RPC).
// Usage:
//   node test/drive-test-instance.mjs run --port 3180 --task "..." [--ws /abs/path]
//   node test/drive-test-instance.mjs list --port 3180
//   node test/drive-test-instance.mjs cancel --port 3180 --session <id>
//   node test/drive-test-instance.mjs ws-create --port 3180 --ws /abs/path
// The test instance must be running (test/run-test-instance.sh).
import { randomUUID } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
	const i = argv.indexOf(name);
	return i === -1 ? fallback : argv[i + 1];
};
const port = Number(opt("--port", "3180"));
const base = `http://127.0.0.1:${port}/api`;

async function rpc(method, payload) {
	const body = { type: "client-request", rpcId: randomUUID(), method, payload: payload ?? {} };
	// The browser transport posts to /api/<method> (the method lives in the
	// path, not only the body).
	const res = await fetch(`${base}/${method}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body)
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
	const reply = await res.json();
	if (reply.type !== "server-response" || reply.rpcId !== body.rpcId) {
		throw new Error(`unexpected reply: ${JSON.stringify(reply).slice(0, 300)}`);
	}
	if (reply.result?.ok !== true) {
		const err = reply.result?.error ?? {};
		throw new Error(`rpc ${method} failed: ${err.code ?? "?"}: ${err.message ?? JSON.stringify(err).slice(0, 300)}`);
	}
	return reply.result.value;
}

const cmd = argv[0];
if (cmd === "ws-create") {
	const path = opt("--ws");
	if (!path) throw new Error("--ws required");
	const value = await rpc("workspace.create", { path });
	console.log(JSON.stringify(value, null, 2));
} else if (cmd === "run") {
	const task = opt("--task", "Write the number 42 to a file called answer.txt in your workspace.");
	const path = opt("--ws");
	let ws = null;
	if (path) {
		const value = await rpc("workspace.create", { path });
		ws = value.workspace.id;
		console.log("workspace:", ws);
	}
	const created = await rpc("session.create", ws ? { workspaceId: ws } : {});
	console.log("session:", created.sessionId);
	const accepted = await rpc("session.prompt", {
		sessionId: created.sessionId,
		mode: "queue",
		content: [{ type: "text", text: task }]
	});
	console.log("prompt accepted:", JSON.stringify(accepted));
} else if (cmd === "list") {
	const value = await rpc("session.list", {});
	console.log(JSON.stringify(value, null, 2));
} else if (cmd === "cancel") {
	const id = opt("--session");
	if (!id) throw new Error("--session required");
	console.log(await rpc("session.cancel", { sessionId: id }));
} else {
	console.error("usage: drive-test-instance.mjs <run|list|cancel|ws-create> [--port N] [--ws PATH] [--task TEXT] [--session ID]");
	process.exit(2);
}
