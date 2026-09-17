#!/bin/bash
# PokeClaude: forward Claude Code hook events to the local game server.
# Must NEVER block or fail the agent: 1s timeout, output discarded, always exit 0.
payload=$(cat)
curl -s -m 1 -X POST http://localhost:${POKECLAUDE_PORT:-5180}/api/hook \
  -H 'Content-Type: application/json' \
  -d "{\"cmuxWorkspaceId\":\"${CMUX_WORKSPACE_ID}\",\"cmuxSurfaceId\":\"${CMUX_SURFACE_ID}\",\"event\":${payload}}" >/dev/null 2>&1 || true
exit 0
