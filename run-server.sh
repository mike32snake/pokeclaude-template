#!/bin/bash
# PokeClaude server supervisor: a restart loop, for when pm2 is not installed.
# Start the server with tools/start-server.sh, which uses pm2 when it can. Only
# POKECLAUDE_BACKEND=cmux needs this to run inside a cmux workspace, because cmux's
# control socket is "cmuxOnly" and denies processes outside the cmux session.
cd "$(dirname "$0")"
while true; do
  node src/server/index.js
  code=$?
  echo "[pokeclaude] server exited ($code); restarting in 2s" >&2
  sleep 2
done
