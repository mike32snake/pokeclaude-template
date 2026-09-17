# Architecture

Three sources feed one in-memory state, rendered as a GBA town.

    Claude Code hooks ──POST /api/hook──▶
    cmux socket (rpc workspace.list + session JSON, 3s poll) ──▶  state.js ──SSE──▶ canvas client
    ~/.claude/projects/<slug>/*.jsonl  ──on demand (/api/agent, /api/sessions)──▶ dialog / PC

- Identity link: hooks run inside the agent's shell where $CMUX_WORKSPACE_ID is set,
  so session_id <-> workspace UUID is exact. Fallback: newest transcript for the cwd.
- Statuses: cmux claude_code statusEntries are the baseline (Running/Needs input/Idle
  -> WORKING/BLOCKED/ASLEEP); hooks override for 10s after they fire; vanished
  workspaces FAINT and are dropped after 60s.
- Ranch geometry is compiled (tools/build-town.js -> town.json) and painted
  (tools/compose_town.py -> town.png) at build time; the client draws one image
  plus sprites. Pens, work spots, gates, hut doors, sign anchors and the collision
  grid all live in town.json. Shelter art comes from tools/gen_buildings.py, whose
  sizes.json is the single source of truth for footprints.
- The map is built to fit one screen. main.js picks the largest INTEGER zoom that
  fits the viewport and centres the map; the camera never scrolls.
- Agents live inside their repo's plot: working ones wander the back spots, blocked ones
  line the front edge. Nothing leaves its plot, so a plot's population always equals that
  repo's agent count.
- Plots are colour-tinted ground, not fenced enclosures. Hues are evenly spaced by plot
  index (build-town.js hue()) so neighbours never look alike. Only the shed blocks movement.
- The grid is a fixed 4 x 5 (L.cols/L.rows). Unused slots render as faint outlines, so
  adding a repo never re-lays-out the plots that already exist.
- Motion is driven by real events, not decoration: PreToolUse increments toolSeq on the
  server, and the client pops a per-tool glyph above that agent's head when it changes.
- Repo spec: docs/product-specs/ (see reports/pokeclaude-spec.html for the full v2.1 spec).
