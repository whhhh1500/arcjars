#!/usr/bin/env bash
# (Re)start the ArcJars keeper in the background, detached from the terminal.
#   scripts/keeper_start.sh            # restart
#   KEEPER_LAUNCHER=/path/launcher.py KEEPER_LOG=/path/keeper.log scripts/keeper_start.sh
# The launcher must put KEEPER_PK into the keeper's *environment* (never argv or a file) and exec
# `node keeper/keeper.mjs` with RPC_URL / FACTORY / FROM_BLOCK set. Nothing secret is written to the log.
set -euo pipefail
cd "$(dirname "$0")/.."
LAUNCHER=${KEEPER_LAUNCHER:-../ship/keeper_launcher.py}
LOG=${KEEPER_LOG:-../keeper.log}
PIDFILE=${KEEPER_PIDFILE:-../keeper.pid}
[[ -f "$LAUNCHER" ]] || { echo "launcher $LAUNCHER not found"; exit 1; }
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "stopping keeper pid $(cat "$PIDFILE")"; kill "$(cat "$PIDFILE")"; sleep 1
fi
setsid nohup python3 "$LAUNCHER" >>"$LOG" 2>&1 < /dev/null &
echo $! > "$PIDFILE"
sleep 3
kill -0 "$(cat "$PIDFILE")" 2>/dev/null || { echo "keeper exited; see $LOG"; tail -5 "$LOG"; exit 1; }
echo "keeper running: pid $(cat "$PIDFILE"), log $(realpath "$LOG")"
