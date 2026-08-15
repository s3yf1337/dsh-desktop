#!/usr/bin/env bash
# Boot the isolated TEST instance of the desktop profile.
#
# SAFETY: this script ONLY ever kills the process recorded in its own PID
# file (.test-home/test-instance.pid). It never uses pkill -f and never
# touches the live ~/.dsh harness or any other process.
#
# Usage: test/run-test-instance.sh [--kill] [port]
#   (no args)  boot the test instance on port 3180
#   --kill     stop the test instance and exit
#   <port>     boot on the given port
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_HOME="$ROOT/.test-home"
PORT="${2:-3180}"
KILL_ONLY=0
[[ "${1:-}" == "--kill" ]] && KILL_ONLY=1
PID_FILE="$TEST_HOME/test-instance.pid"

# ── stop any previously recorded test instance (only that PID) ──────────────
stop_recorded() {
  if [[ ! -f "$PID_FILE" ]]; then return 0; fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  rm -f "$PID_FILE"
  [[ -n "$pid" && "$pid" =~ ^[0-9]+$ ]] || return 0
  # Double-check the recorded process is really our test harness before
  # signalling: its cmdline must name this profile AND our own port (the live
  # harness runs the same profile without a port arg — it must never match).
  # cwd is checked best-effort (unreadable in some sandboxes).
  local cmdline
  cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
  if [[ "$cmdline" == *"--profile"* && "$cmdline" == *"desktop"* && "$cmdline" == *"--port $PORT"* ]] \
     && [[ "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" == "$TEST_HOME" || "$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)" == "" ]]; then
    echo "stop: test instance pid $pid"
    kill "$pid" 2>/dev/null || true
    # Its spawned shell client + webview die with the harness; wait briefly.
    for _ in 1 2 3 4 5; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  else
    echo "note: recorded pid $pid is not the test harness (cmdline: $cmdline); leaving it alone"
  fi
}

stop_recorded

if [[ "$KILL_ONLY" == "1" ]]; then exit 0; fi

mkdir -p "$TEST_HOME"
if [[ ! -f "$TEST_HOME/settings.yaml" ]]; then
  cp "$HOME/.dsh/settings.yaml" "$TEST_HOME/settings.yaml" 2>/dev/null || true
fi
if [[ ! -f "$TEST_HOME/.credentials.yaml" ]]; then
  cp "$HOME/.dsh/.credentials.yaml" "$TEST_HOME/.credentials.yaml" 2>/dev/null || true
fi

echo "boot: test home $TEST_HOME, port $PORT"
cd "$TEST_HOME"
# Isolate XDG dirs: the native client shares the live app's config/data dirs
# by default (settings, window state, WebKit cache). Two clients on the same
# WebKit data dir corrupt each other's cache and crash — the test client must
# have its own.
mkdir -p "$TEST_HOME/xdg-config" "$TEST_HOME/xdg-data" "$TEST_HOME/xdg-state"
DSH_HOME="$TEST_HOME" \
XDG_CONFIG_HOME="$TEST_HOME/xdg-config" \
XDG_DATA_HOME="$TEST_HOME/xdg-data" \
XDG_STATE_HOME="$TEST_HOME/xdg-state" \
DSH_DESKTOP_NO_SINGLE_INSTANCE=1 \
DSH_DESKTOP_BIN="${DSH_DESKTOP_BIN:-$ROOT/src-tauri/target/release/dsh-desktop-shell}" \
nohup dsh --profile desktop --port "$PORT" > "$TEST_HOME/boot.log" 2>&1 &
echo "$!" > "$PID_FILE"
echo "pid $(cat "$PID_FILE") (recorded in $PID_FILE)"
for i in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
    echo "web surface up at http://127.0.0.1:$PORT after ${i}s"
    exit 0
  fi
  sleep 1
done
echo "web surface did not come up; tail of boot.log:" >&2
tail -30 "$TEST_HOME/boot.log" >&2
exit 1
