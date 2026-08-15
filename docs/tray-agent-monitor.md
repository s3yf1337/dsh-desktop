# Tray agent monitor — control protocol

The tray shows live agents (running list, log tail, stop button) and a badge
when one finishes. Data flows between three processes:

```
harness (bundle/lib/index.js)  ──stdin pipe──▶  native client (src-tauri, tray)
harness (bundle/lib/index.js)  ◀──stdout pipe── native client (src-tauri, tray)
```

The harness plugin spawns the native client with `stdio: ["pipe", "pipe",
"inherit"]` (stdin = control pipe to the client, stdout = control pipe from
the client, stderr = inherited).

## Plugin → client (JSON object per line on stdin)

| event | payload | meaning |
|---|---|---|
| `notify` | `{title, body}` | OS notification (existing, unchanged) |
| `title` | `{title}` | window title fallback (existing, unchanged) |
| `agents` | `{agents: [{id, title, status}]}` | full snapshot of running agents, pushed on every change and once shortly after the client spawns |
| `agent-finished` | `{id, title}` | a running agent just transitioned running→idle |
| `agent-log` | `{id, lines: [string]}` | response to a `get-log` request; `lines` = the tail (last ≤ 40) of the agent's session event log, each line ≤ 140 chars, formatted `[HH:MM:SS] type — summary` |

Agent `title`: the session title from the existing `titles` map
(`session/title` event), falling back to the short session id.

Log line construction (harness side): iterate
`agent.session.events.slice(-40)`. Include only informative types:
`user/message`, `assistant/message`, `tool/call`, `tool/result`, `turn/start`,
`turn/end`, `agent/error`, `session/error` (and anything whose `type` is not
in the noisy skip set below). Skip the noisy set: `assistant/chunk`,
`agent/inbox/*`, `request/*`, `todo/*`, `compaction/*`, `session/title`.
Summary heuristics:
- `user/message` / `assistant/message`: `data.content` (string), truncated to
  110 chars, newlines → `⏎`.
- `tool/call`: `data.name` plus a brief args hint (`data.arguments` first
  60 chars when it is a string, else the first key).
- `tool/result`: `data.status` (e.g. `ok`/`error`) — nothing more.
- `turn/start`: `turn ${data.turn}`.
- `turn/end`: the `data.reason.kind`.
- `agent/error` / `session/error`: `data.message` truncated.
- anything else: first 60 chars of `JSON.stringify(data)`.
Time: `event.time` is Unix epoch milliseconds → format HH:MM:SS local.

## Client → plugin (JSON object per line on stdout, `dshdctl:` prefix)

The client writes `dshdctl:<json>\n` to stdout for each request. The plugin
parses stdout line by line; lines starting with `dshdctl:` are control
messages, every other line is forwarded verbatim to `process.stdout` (the
client's ordinary stdout must keep reaching the harness terminal).

| event | payload | meaning |
|---|---|---|
| `stop-agent` | `{id}` | user clicked Stop in the tray: `ctx.get("agents")?.list().find(a => a.id === id)` → `agent.cancel({kind: "user"})`. Never throw; log failures. |
| `get-log` | `{id}` | user opened the log tail: reply with `agent-log` |

## Rust client behavior (src-tauri)

- Extend the existing stdin reader loop (lib.rs `setup`) with the new events
  (`agents`, `agent-finished`, `agent-log`); keep `notify`/`title` intact.
- New state in `AppState`: `agents: Mutex<Vec<AgentInfo>>` (id/title/status),
  `agent_logs: Mutex<HashMap<String, Vec<String>>>` (cap 40 lines/entry),
  `finished_agents: Mutex<Vec<FinishedInfo>>` (id/title/time, cap 10).
- Tray menu (tray.rs `build_menu`): under the separator after
  "Check for Updates" insert a dynamic section:
  - when agents are running: a disabled header `Agents (N running)`, then per
    agent a submenu (`MenuBuilder` nested) titled by the agent's title,
    containing: disabled log-tail lines (last ≤ 8, each truncated to ~56
    chars for menu width), a `get-log-<id>` item "Refresh log tail", and a
    `stop-<id>` item "Stop agent" (red text not required; keep default).
  - when `finished_agents` is non-empty: disabled lines
    `✓ "title" finished at HH:MM` (last 3) and an enabled `clear-badge` item
    "Clear finished badge".
- Menu event handling: ids `stop-<id>` / `get-log-<id>` / `clear-badge`.
  `stop-*` and `get-log-*` write `dshdctl:{...}` to stdout (use a dedicated
  `Mutex<()>`-serialized writer helper in tray.rs or lib.rs, flush after
  write). `clear-badge` clears `finished_agents`, restores the plain tray
  icon, rebuilds the menu.
- Badge: when an `agent-finished` message arrives, overlay a small filled
  red circle onto the tray icon (copy `default_window_icon().rgba()`, draw a
  circle in the top-right corner, ~22% of icon size, hard edges fine),
  `tray.set_icon(Some(...))`, and rebuild the menu. Clearing the badge
  restores the original icon (keep the original `Image` around in state).
- Tooltip: `DeepSeek Harness` normally; `DeepSeek Harness — N agent(s)
  running` while any agent runs.
- All menu rebuilds go through the existing `rebuild()` path (update state
  still shows).
