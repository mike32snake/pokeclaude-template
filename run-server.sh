#!/bin/bash
# PokeClaude server supervisor.
# Runs INSIDE a cmux workspace on purpose: cmux's control socket is "cmuxOnly" and
# denies processes outside the cmux session (pm2 double-forks to PPID 1, so it is
# always denied). Set CMUX_SOCKET_PASSWORD in .env to run under pm2 instead.
cd "$(dirname "$0")"
while true; do
  node src/server/index.js
  code=$?
  echo "[pokeclaude] server exited ($code); restarting in 2s" >&2
  sleep 2
done
