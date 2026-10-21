#!/bin/bash
# PokeClaude: forward Claude Code hook events to the local game server.
# Must NEVER block or fail the agent: 1s timeout, output discarded, always exit 0.
#
# Which pen the event came from depends on who started it. cmux exports
# CMUX_WORKSPACE_ID; a natively hosted pen gets POKECLAUDE_AGENT_ID from the pty relay
# (tools/pty-agent.py). Both are sent, and the server takes whichever is there, so this
# one hook serves both backends and does not need changing when the switch happens.
payload=$(cat)
curl -s -m 1 -X POST http://localhost:${POKECLAUDE_PORT:-5180}/api/hook \
  -H 'Content-Type: application/json' \
  -d "{\"cmuxWorkspaceId\":\"${CMUX_WORKSPACE_ID}\",\"cmuxSurfaceId\":\"${CMUX_SURFACE_ID}\",\"agentId\":\"${POKECLAUDE_AGENT_ID}\",\"event\":${payload}}" >/dev/null 2>&1 || true
exit 0
