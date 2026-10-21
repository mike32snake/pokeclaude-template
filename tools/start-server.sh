#!/bin/bash
# Start the PokeClaude server. PokeClaude.app runs this too, so there is one way to do it.
#
# The native backend (the default) hosts the pens in our own pty relays and needs no
# cmux at all, so the server runs under pm2, which restarts it when it dies. Only
# POKECLAUDE_BACKEND=cmux still needs a cmux workspace: cmux's socket is cmuxOnly and
# denies anything pm2 started.
cd "$(dirname "$0")/.." || exit 1
REPO="$PWD"
NAME=pokeclaude

if [ "$(printf %s "$POKECLAUDE_BACKEND" | tr '[:upper:]' '[:lower:]')" = cmux ]; then
  CMUX="${PC_CMUX_BIN:-/Applications/cmux.app/Contents/Resources/bin/cmux}"
  # Outside cmux its CLI needs the socket password; src/server/cmux.js reads the same one.
  PW=$(sed -n 's/^[[:space:]]*CMUX_SOCKET_PASSWORD[[:space:]]*=[[:space:]]*//p' .env 2>/dev/null | tr -d "\"'" | head -1)
  exec "$CMUX" ${PW:+--password "$PW"} new-workspace --name "pokeclaude server" --cwd "$REPO" \
    --command "POKECLAUDE_BACKEND=cmux ./run-server.sh"
fi

if command -v pm2 >/dev/null; then
  # Known to pm2 already (stopped, or saved from an earlier start): start THAT one.
  # Registering a second copy would crash-loop on EADDRINUSE beside the first.
  if pm2 describe "$NAME" >/dev/null 2>&1; then
    pm2 start "$NAME"
  else
    pm2 start "$REPO/src/server/index.js" --name "$NAME" --cwd "$REPO" --time
  fi
  pm2 save >/dev/null 2>&1
  exit 0
fi

# No pm2: the restart loop, detached from whatever started us.
mkdir -p "$REPO/data"
nohup "$REPO/run-server.sh" >> "$REPO/data/server.log" 2>&1 &
