# PokeClaude

A GBA-style ranch for your live Claude Code agents. Each PEN = a repo, each Pokemon
in it = a running cmux workspace with Claude in it. The whole map fits one screen at an
integer zoom; the camera never scrolls. Localhost only.

## Build & Test
- `npm run dev` — start the server on http://localhost:5180, in the foreground, inside a
  cmux workspace. To relaunch it without opening a terminal tab by hand, give cmux its
  own workspace and let it run the supervisor:

      /Applications/cmux.app/Contents/Resources/bin/cmux new-workspace \
        --name "pokeclaude server" --cwd <repo> --command "./run-server.sh"

  Never start it with `nohup ... &` or pm2. Both reparent the process to PPID 1, and
  cmux's socket is cmuxOnly: the server then serves the page but every cmux call is
  denied, so titles, branches, models and service pens all quietly go missing. The
  symptom is "cmux socket denied" in the log and `socketOk:false` on /api/state.
  `socketOk` is null until a denial happens, so null is the healthy value, not an error.
- `npm test` — node --test; all tests must pass before any change is "done" (TDD)
- `tools/build-app.sh` — build PokeClaude.app and install it into /Applications. It
  MUST land in /Applications: the identical bundle run from anywhere else is refused
  notification registration by macOS. The app is optional; the server does not need it.
- `npm run build:town` — regenerate town.json + town.png after editing config/repos.json
  (also run tools/gen_buildings.py first if you changed a shelter theme)
- Art regeneration: `python3 tools/gen_buildings.py` (sheds) and
  `python3 tools/gen_overworld.py` (ground tiles, ranger). Both draw; neither reads a
  source image. See ART.md.

## Architecture
- `app/main.swift` — PokeClaude.app: a WKWebView on localhost:5180 plus a notification
  poster. Optional, and deliberately dumb: the server still decides what is worth an
  interruption, and hands the app the finished alert over `/api/notify-stream`. Close
  the app and notifications keep coming through osascript.
- `src/server/` — zero-dependency Node ESM. index.js (http+SSE+routes), cmux.js
  (CLI wrapper over the cmux Unix socket), state.js (poll+hook reducer),
  transcripts.js (~/.claude/projects JSONL parsing), signs.js, paths.js.
- `public/js/` — vanilla JS client. Layout is a fixed left panel (33%) plus a canvas
  stage (67%). main.js (loop, camera-less render, input), world.js (placement),
  sprites.js (drawing), ui.js (panel: queue/agent/PC/spawn), net.js (SSE), dex.js.
- Repo groups in the list are COLLAPSED by default; open state lives in ui.js `expanded`
  and must be part of the render key, or toggling silently does nothing.
- The panel is a CHAT: default view is every agent grouped by repo, selecting one shows
  its transcript from parseConversation(), and #composer stays pinned at the bottom.
- The panel is ALWAYS open; it is not a modal. Movement is suppressed only while an
  input has focus (ui.typing()), never by a "modal open" flag.
- `hooks/pokeclaude-hook.sh` — registered in ~/.claude/settings.json; posts every
  Claude Code hook event to /api/hook. MUST always exit 0 in <1s. The seven events
  state.js reduces are SessionStart, UserPromptSubmit, PreToolUse, Notification, Stop,
  SubagentStop, SessionEnd. PostToolUse is NOT one of them: registering it doubles the
  hook traffic and changes nothing on the field.
- `src/server/config.js` — the only reader of config/repos.json. Never
  `fs.readFileSync` that file directly: the loader seeds it from
  config/repos.example.json when a clone has none, and expands `~`. Any caller that
  WRITES the config back must read it with `{ expand: false }`, or the round trip bakes
  one machine's HOME into a file meant to stay portable.
- `claudeBin()` in config.js resolves the Claude Code CLI. Never hardcode an install
  path: execFile takes no shell, so it cannot see a `claude` shell function either.
- `src/shared/grid.js` — field arithmetic for all three grid sizes. The button picks
  COLUMNS; rows grow to hold every repo, and the plot height shrinks to keep the whole
  field inside MAX_W_PX x MAX_H_PX. Growing rows without shrinking plots is what ran
  the 3-wide view to 928px tall and pushed its bottom row off the stage.
- Data flow: cmux poll (3s) + hook pushes -> state -> SSE -> canvas.

## Dependency layers
signs/paths -> cmux/transcripts -> state -> index. Client: net/sprites -> world -> ui -> main.
Never import upward.

## Boundaries
- Localhost only. The server binds 127.0.0.1 and the API drives terminals; there is no
  auth because there is no remote. Do not put it behind a tunnel or a reverse proxy.
- Every committed image is DRAWN, by tools/gen_buildings.py and tools/gen_overworld.py.
  Never commit a crop of a third-party tileset or sprite sheet, and never point a
  generator at one as a source. public/art/pokemon/ is fetched per machine and ignored.
- The hook script must never block: 1s curl timeout, always exit 0.
- All paths from cmux must go through normalizeDir before comparison (case bug).
- Canvas hit-testing MUST convert coordinates with canvas.getBoundingClientRect().
  Raw e.clientX is wrong by the width of the left panel and silently kills every click.
  There is no camera any more; `cam` stays 0,0.
- The stage repeats /art/tiles/grass.png behind the canvas so the field has no edge.
  alignGrass() must run after any resize or scroll, or the seam becomes visible.
- New actors are created with `fresh: true` and snap straight to their first target.
  Without that they appear on the plot edge and visibly walk in.
- The drag handle writes INLINE widths on #panel, which beat the .collapsed rule. setPane
  must clear them on collapse and put the remembered width back on expand.
- Back lives in the panel header (top-left) and is context-aware via setBack(); collapse
  lives top-right. Do not reintroduce per-view back buttons in the body.
- SSE messages are TYPED: {type:'state'} snapshots and {type:'thread', ws} pushes from the
  transcript watcher. Anything added to the stream must carry a type.
- fs.watch on transcripts is what makes the chat live. Watchers are re-synced every poll;
  do not let that drift or the chat silently goes back to only updating on open.
- Uploads land in uploads/ (gitignored) and are sent to agents as ABSOLUTE PATHS. Three
  ways in: drag-drop on #panel, paste, or the + picker. They work in a conversation and
  in the NEW AGENT form; anywhere else the drop is ignored, and drops outside #panel are
  cancelled so the browser never navigates away from the app.
- parseFooter SPLITS THE FOOTER ON PIPES and keys off the FIRST segment being a model
  name. Do not pattern-match the whole line: model names contain parentheses ("Opus 5
  (1M context)") and naive regexes drop them silently. Do not require the context
  percentage either: the footer's other segments change (it is gh account and email
  now, it was the percentage before), and a narrow pane truncates the line with an
  ellipsis. Demanding a percentage is what blanked the model AND the mode for months.
- Never store footer facts all-or-nothing. Keep every field that parsed; a null from
  one source must not erase what another source knows. agentFacts() does that merge,
  and /api/agent must use it rather than spreading the footer over the transcript.
- The context percentage is MEASURED from the transcript, not scraped: assistant turns
  record input + cache_creation + cache_read tokens, and the newest turn is the current
  context. The screen cannot be trusted for it at any pane width. The only guess is the
  denominator: a "(1M context)" model label means 1M, everything else means 200k.
- permissionMode is written into the transcript on every prompt. Prefer that over the
  footer line, which is only there when the pane is wide enough to print it.
- The footer must be read at ~40 lines. At 10 it scrolls off whenever a picker is open.
- Footer and git are sampled round-robin, one agent per poll tick, never all at once.
- The status bar is selection-aware: renderStatus() takes `selected` and swaps its left
  half to that agent. Identity comes from the sprite, live numbers are looked up from
  state by workspaceId so they keep updating while the panel is open.
- #statusbar is a fixed 26px strip; #app is height calc(100% - 26px). Anything that
  changes that height must change both.
- /api/repo writes config/repos.json and shells out to build-town for all three sizes.
  It validates the folder exists and refuses duplicates by normalised path.
- NOTHING in the page may depend on window.confirm/alert/prompt. Inside PokeClaude.app
  a WKWebView answers every JS dialog as if Cancel was clicked, so a confirm-gated
  button does nothing at all and says nothing: that is how KILL, STOP and cron delete
  were dead in the app while they worked in Brave. Destructive buttons ask with
  armButton (public/js/arm.js): click to arm, click again to act, cold after 6s. The app
  now implements WKUIDelegate too, but the page must not need it.
- Links in PokeClaude.app open in Brave through `openOutside()` in `app/main.swift`. A
  WKWebView silently drops every target="_blank" link and window.open() unless the UI
  delegate implements createWebViewWith, so chat links did nothing in the app while they
  worked in Brave. A plain link off localhost:5180 goes out too, or it would replace the
  field with no way back. Only http, https and mailto leave the app. After editing the
  Swift, run tools/build-app.sh and relaunch the app.
- /api/pick opens the macOS folder dialog through osascript (src/server/picker.js) and
  answers with the absolute path. The page cannot do this itself: <input webkitdirectory>
  gives relative names and showDirectoryPicker gives a handle, and repos.json needs the
  absolute path. The request stays open as long as the dialog is, and a cancel comes back
  as {cancelled:true}, not an error, so the panel must not paint it red.
- Layout is three columns: #panel | #stage | #feed-wrap. Both side panes collapse via a
  `collapsed` class; every toggle MUST call resize() so the canvas re-fits.
- /api/transcript only serves paths under ~/.claude/projects (isTranscriptPath). Never
  relax that guard: the path comes from the client.
- Killed agents FAINT, fade out client-side over 6s, then are dropped from state.
- NOTHING about the field is baked into an image. town-<size>.json carries SLOT geometry
  and REPO identity separately; public/js/field.js assigns visible repos to the first N
  slots and draws grass, tints and sheds per frame. That is what makes hide-and-reflow work.
- Any subprocess that runs `claude` MUST have CMUX_* stripped from its env, or its hooks
  report the server's workspace and attach a phantom session to it.
- Service classification is sticky: once a workspace binds a port it stays a service.
- Services keep their Pokemon. serviceMark() is an OVERLAY drawn after drawPoke (exhaust
  over the body, port chip above), then `continue` so no !/thinking bubbles are added.
- parseConversation reads the transcript through WINDOWS, never whole: one pasted image
  can be megabytes. The OPENING ASK - the first user turn with words in it - is pinned
  out of a head window and shown above the recent turns, with a `role:'gap'` marker
  between them. Both trims used to drop it (the byte tail and the turn limit), which
  left the panel showing a conversation that starts in the middle with no sign that
  anything came before. `limit` counts the gap marker as one of its rows.
- public/js/markdown.js escapes BEFORE it transforms. Never reorder that: transcript text
  is untrusted input.
- cmux `send-key` accepts ONLY named keys (enter, up, escape...). Digits and text must go
  through `send`, or the keystroke is silently lost with "Unknown key". Use cmux.press().
- NEVER hand cmux text with a newline in it. `send` (and the surface.send_text RPC) turns
  every newline into a carriage return, and to Claude Code a carriage return is Enter: a
  three-line message was three submits, the first line went as its own prompt, and the
  rest sat in the input box until the next send pressed Enter on top of it. That was the
  "my message vanished, then a later message sent it" report. cmux.send() now types one
  line at a time and sends each newline as `alt+enter` (ESC CR in one write, which Claude
  Code takes as a newline). The other carriers were all tried on a live pane and all typed
  junk: bracketed paste, Ctrl+J, both Shift+Enter sequences, and backslash-Enter, which
  works only until the pane is busy for a moment and reads the CR glued to the text.
- Between writes, cmux.send() waits for EVIDENCE on screen, not a sleep: the line's own
  tail at the end of the composer, or a new "[Pasted text]" marker for a line too long
  to type. Claude Code reads its pty one chunk at a time and past ~200 characters in one
  read it treats the chunk as a paste; the pty merges writes that land before it reads,
  and a pane that has just finished a turn can sit on its input for a second. If the
  evidence never comes the send FAILS rather than typing on, and the failure says which
  line. The CLI `send` subcommand also rewrites a two-character "\n" into Enter with no
  way to escape it; surface.send_text leaves backslashes alone.
- The socket is the fast path: cmux.rpcSocket() speaks newline-delimited JSON-RPC to
  `~/Library/Application Support/cmux/cmux.sock` in ~1ms against ~200ms per CLI exec.
  The CLI stays for the password case (the socket auth for it is unknown) and as the
  fallback when the socket is unreachable.
- Text already in a pane's input box is a REFUSAL, quoted in the reason, not something
  to type after. Sending onto it submits both as one message nobody wrote. A fresh
  Claude Code prints a `Try "..."` hint in the empty box; draftOnScreen() knows it is
  not a draft. After Enter the server looks again and reports "ok" only once the box is
  empty; a swallowed Enter is pressed once more, then reported as a failure.
- A message typed at a BUSY pane is queued by Claude Code, which then prints "Press up to
  edit queued messages" in the empty box until the turn ends. That is a hint, not a
  draft: reading it as one made every send to a working agent come back 502 "still
  sitting in that tab" after it had queued fine, and refused the next one for "unsent
  text". Pressing Up there moves the queued message INTO the box and Claude Code never
  sends it after that; that is how the stuck drafts got stuck. draftOnScreen() ignores
  the hint, queuedOnScreen() reports it, and /api/act send answers `queued: true` so the
  panel says "queued", not "sent". Queued messages land in the transcript as
  `attachment.queued_command` rows, never as user turns; parseTurns() shows them as the
  user turn they are. A stuck draft comes back in the 409 as `stuck`, and the panel
  offers `flush` (Enter) or `discard` (one backspace per character over the socket;
  Esc and Ctrl+U do nothing to a Claude Code composer, tested live).
- After a turn Claude Code paints a dimmed SUGGESTION for the next prompt in the empty
  box, and Tab takes it. read-screen has no styles, so on paper it is a draft: every
  send to that pane came back 409 "unsent text", and "discard" pressed backspace fifty
  times over nothing and then said the text was still there. Only behaviour tells the
  two apart (tested live): backspace does nothing to a suggestion, typing replaces it,
  and emptying the box brings it back. cmux.probeDraft() types one letter and looks: a
  box showing only the letter held nothing (`ghost: true`); a real draft shows the
  letter on its end and the backspace after takes it off again. The send gate and
  flush/discard both ask it before refusing. A ghost is typed over; discard on a ghost
  answers `nothing: true`. Tests: tests/suggestion.test.js.
- A tab cmux restored on relaunch has NO terminal in it until it is clicked, and
  workspace.list shows it like any other tab. It was drawn as an agent, its conversation
  was guessed from the newest transcript in the repo (another agent's, so two Pokemon
  showed one thread), and a message to it came back "Claude is not running in that tab".
  Only read-screen tells: it fails with "Terminal surface not found". state.isHollow()
  reads that, markHollow() records it, and snapshot() leaves hollow tabs out. The poll
  asks once when a tab is first seen and sampleFooters() keeps asking, so a tab opened
  later joins the ranch on its own.
- Spawning an agent types the task in and then presses Enter, but ONLY once the task
  is visibly in the box. It used to look for the first 18 characters of the prompt.
  Claude Code folds a paste past a few lines into "[Pasted text #N]" and hides the
  words, so on a large prompt the check never matched, Enter never came, and the task
  sat unsent while the spawn logged "claude never became ready". cmux.send() already
  verifies each line landed and returns ok, so the spawn trusts that; promptLanded()
  confirms the box holds a draft and accepts the paste marker. A task stuck this way is
  recovered with the flush action (POST /api/act {action:"flush"}), which presses Enter.
- Codex also replaces an image path with `[Image #N]` in the composer. `promptLanded()`
  must accept that marker: attachment-first startup tasks otherwise type correctly but
  never get Enter because their original path is no longer visible. `startup.js` keeps
  readiness, typing and submission in separate phases, never retypes after a partial
  write, and verifies an empty composer after one Enter. `/api/spawn` waits for that
  result; failures keep the task and attachments in the form and name the problem.
- A pane's terminal can WEDGE: cmux still lists the surface and read-screen still
  returns a frame, but the frame is stale and no keystroke reaches Claude. It happens
  when raw output corrupts the TUI, e.g. a command that broke on the space in a
  directory whose name has a space in it printed a path error into the composer. read-screen
  then shows an old "❯ draft ..." line above the real, empty box, so the send gate reads
  a phantom draft and every send is refused; backspace and Enter do nothing, so flush
  and discard cannot clear it. probeDraft() types one letter and watches: on a wedged
  pane the box never changes and it returns ok:false. boxAction() turns that into
  frozen:true, and the gate, discard and flush all answer "reopen the tab in cmux"
  instead of looping. The only real fix is to reopen or restart Claude in that tab; the
  session resumes from its transcript.
- Deciding whether a pane will accept a message is src/server/screen.js, never an inline
  regex. Read `READ_LINES` (40), not a handful: a Claude Code pane spends seven lines on
  the composer border and the footer, so at 8 lines ONE unsent line of draft pushes the
  "❯" off the window and every send is refused while the input box is plainly on screen.
  The footer counts as evidence too - it only prints while Claude Code is drawing - and
  a refusal names its own reason, because "no input box visible" was wrong every time it
  was shown. A screen cmux could not read is not evidence of anything: let it through.
- Spawning must clear Claude Code's "do you trust this folder?" gate first, and must wait
  for an EMPTY composer plus the footer. The footer alone appears while Claude is still
  painting and anything typed then is swallowed. Verify the text is on screen before Enter.
- Always drive the workspace ref that new-workspace RETURNS. Several workspaces share the
  title "new agent"; looking it up by title drives the wrong terminal.
- Toasts sit ABOVE the status bar. The bar is 26px tall, fixed to the bottom, z-index 40;
  a toast at bottom:12px/z-20 is posted into the one strip that is always covered.
- The clipboard button copies public/js/report.js, plain text with no fences, and it is
  the thing to reach for when handing a session to another agent: workspace ref, folder,
  transcript path, model, context, the last turns and the live terminal in one paste.
- Attachments are staged in TWO trays: the composer and the NEW AGENT form. Both build
  their message through public/js/attach.js, paths first and one per line, because the
  agent must see the file before the instruction about it. Never rebuild that string in
  a view. A tray only holds uploads the server accepted; a chip without a real path is a
  path the agent cannot open.
- Whether a file can be dropped is a question about the VIEW, not about the composer.
  The composer is disabled while the NEW AGENT form is open, so a drop test of
  `!input.disabled` silently refuses every file dropped onto that form.
- Every slot carries `inner` (the plot inset by one tile). ALL placement must use it: a
  sprite is wider than its tile, so anything on the edge row hangs over the outline.
- Placement rules: not-working agents (waiting on you, then idle) queue top-left, working
  agents roam the lower/right of `inner`, services park at inner top-right.
- No two agents may share a tile: world.sync claims tiles per plot and wandering only
  targets tiles nobody else is heading for.
- The `choose` action drives a LIVE interactive picker. It must keep reading the screen
  and refusing on mismatch; never fire keystrokes blind.
- public/js/dex.js is the original 151. The sprite PNGs are NOT in git (Pokemon-derived
  art, localhost only). Restore them with tools/fetch-sprites.sh.
- AskUserQuestion is parsed out of tool_use into message.asks, with its tool_result matched
  by tool_use_id to give answered / rejected / pending. It must never be summarised away.
- public/js/summarize.js maps tool calls to human labels. It is pure local formatting:
  never call a model to summarise activity.
- public/js/filter.js owns the hidden-repo set. Anything that draws or lists agents must
  honour isHidden(), including hit-testing and the blocked count, or a hidden repo can
  still be clicked or still inflate the badge.
- The filter menu also owns the ORDER of the repos: what it lists top to bottom is the
  order visiblePlots() hands out slots. Both live in localStorage (pc.hidden, pc.order)
  and neither ever reorders town.repos, so a grid switch (which replaces that array)
  keeps the order. A repo the saved order has never seen sorts to the end, never away.
- The menu rows drag with POINTER events, not HTML5 drag-and-drop, and are divs, not
  labels. A draggable label never started a drag reliably; the attempt fell through to
  the label and hid the repo instead of moving it. A row that moved suppresses the
  click that follows it, or the drop toggles the repo it just moved.
- Zoom: `userZoom` null means auto-fit. fitScale() prefers the largest INTEGER scale so
  pixels stay square, and only drops to quarter steps below 1x.
- Keep the map fitting the stage: town.test.js asserts w*16*2 <= 1440 and h*16*2 <= 860.
  fitScale() fits WIDTH first so all 4 columns always show; rows scroll if they overflow.
- Unmapped agents get no pen. They are listed in the panel as a config gap, never
  silently dumped into a catch-all pen.
- Agents must never render outside their own pen; a pen's headcount is the repo's count.
- Scheduled jobs (`src/server/crons.js`) are read live from `~/Library/LaunchAgents`
  and `crontab -l`; nothing is stored. Three facts drive the whole view: the plist
  gives the schedule, the log file's mtime IS the last run time, and `launchctl list`
  gives the exit status. "Unloaded" is NOT "failed" - a job can be switched off on
  purpose, so it is counted and coloured separately or the panel nags forever.
- A plot id must be a NUMBER. The agent list keys expand/collapse by
  `Number(plot.plot)`, so a string id makes the group silently refuse to open. The
  crons pen uses -1; the town builder numbers real repos from 0.
- The town builder reserves ONE slot beyond the repo count for the crons pen. Without
  it a full grid pushes the pen off the field with nothing to show crons exist.
- Actors of a fixed kind (service, cron) must snap to their target at the TOP of
  `World.step()`, next to the service branch. Skipping the movement code further down
  looks equivalent and is not: it strands them in the previous grid's coordinates
  after a grid change.
- Cron sprites sit 3 tiles apart in BOTH directions, not the 2 an idle agent uses.
  Each one carries a chip saying when it next runs: at 2 columns the chips collide,
  at 2 rows a chip lands on the sprite above. The grid also stops short of the shed
  (`plot.shed.x`) so no chip covers the tower. `cronGrid()` is the single source of
  that geometry - placement in world.js and capacity in main.js both read it.
- `#panel-body` is a flex column, so a tall block inside it (the cron log `<pre>`)
  needs `flex:none` or it is squashed to one line while its scrollHeight looks fine.
- Crons can be CREATED, RUN NOW and DELETED from the panel (`POST /api/cron`). A new
  job is a launchd agent: `cronToLaunchd()` turns crontab syntax into
  StartCalendarInterval (or StartInterval for a pure `*/N` minute step), `plistXml()`
  writes it, and launchctl bootstraps it. Refuse a schedule that expands past 60
  entries; `* * * * *` is not a schedule. The command runs under `/bin/zsh -lc`, or
  launchd hands the job a bare PATH and nothing you installed by hand is on it.
- Run now is `launchctl kickstart -k`, not `start`: kickstart also restarts a job that
  is already running. A crontab line has no "run now", so it is spawned as a shell.
- Delete UNLOADS first (`launchctl bootout`), then removes the plist. The other order
  leaves a ghost in `launchctl list` that nothing can start or stop. A job whose plist
  is not in ~/Library/LaunchAgents is unloaded and reported, never hunted for.
- A cron's NAME says when it runs, never what it does: two jobs can both be
  called `weekly-traffic-report`. `describeJob()` reads a one-sentence description out
  of a real file the job itself names - the prompt fed to `claude -p` (`$(cat x.md)` ->
  its heading), the header comment or docstring of the script it runs, or, failing
  both, what runs and in which folder (flagged `undocumented`). No model is ever called
  to write one. A `-p` prompt in a plain ProgramArguments argv must be lifted OUT before
  the argv is joined, or a page of prompt text names files the job never runs.
- Cron rows are addressed by INDEX in the rendered list, never by label: a crontab
  job's label is its shell command and is free to contain the quote that would end
  the HTML attribute.
- The composer is one box but the text in it belongs to whoever you typed it at.
  public/js/drafts.js keys unsent text by workspaceId ('ash' for the front desk) and
  writes through to localStorage. Every view that owns the box passes its key as the
  third argument to setComposer(); passing none parks the old draft and clears the
  box. Never clear input.value directly, or clicking another Pokemon throws away a
  half-written message.
- The canvas is TRIMMED to the field in use: `fieldExtent()` (public/js/frontdesk.js)
  sizes it from the pens of the visible repos plus a margin row, not from the whole
  town. An unfilled grid otherwise draws rows of empty grass, which pushes the front
  desk away from everything and makes auto-fit shrink the map to fit ground nobody
  looks at (a 5-wide town with 13 repos went 37 rows -> 24). `walkable()` is bounded
  by the extent too, or Pikachu walks off the canvas into the trimmed rows.
- Ash stands on ONE fixed tile: the bottom-right corner of the DRAWN field, off any
  pen's `inner`. He was briefly pinned to the corner of the SCREEN and recomputed
  every frame so he could not scroll away; that made him jump across the map on every
  zoom, pane toggle and grid change and dragged Pikachu with him. The field can be
  dragged now, so a fixed desk is both reachable and still. Only a change to what is
  visible (filter, grid size) moves him. He stays a world sprite, so clicking,
  y-sorting and interact() need no special case.
- The front desk is a scene, not just Ash: desk, Pikachu, a gap, then Ash, all on one
  row (`deskSpot()`). `deskBusy()` decides what Pikachu is doing: while any agent is
  WORKING or THINKING, or Ash is writing an answer, it sits at the keyboard and types
  and the screen is lit; only a quiet field lets it roam. Roaming while the fleet
  works read as an idle pet. A service does NOT count as work, or a field of services
  would keep it typing forever.
- The desk screen is drawn in three-quarter view FACING THE SEAT (`deskPC(..., dir)`),
  so it is obvious whose screen it is. The Pokemon sheets have no typing pose, so the
  motion has to be around it: walk frames cycled in place, `typeBob()`'s 1px bounce,
  `keystrokes()` off the keyboard and the scrolling screen. A still sprite at a lit
  screen looks like nothing is happening; do not remove one of those tells.
- The field is PANNED by dragging its empty ground: the stage is a scroll box and the
  drag moves scrollLeft/scrollTop, so there is still no camera in the render code. A
  drag of more than 4px sets `panned`, which the canvas click handler consumes: a pan
  that also opened a repo would make the field unusable when zoomed in.
- Any resize of the canvas (zoom, pane toggle, filter) runs `keepCenter()`
  (public/js/view.js) so the map point in the middle of the view stays put. Without it
  the view jumps and finding what you were looking at again is a hunt. `#stage` must
  keep `align-items: safe center` — plain centring in a flex scroll box makes the
  overflow above and to the left unreachable.
- Pikachu patrols around ASH, and its wander box is biased up and left of him: Ash sits
  in the corner, so a symmetric box walks Pikachu off the bottom-right edge of the view.
  On a viewport jump (zoom or grid change) it snaps beside Ash rather than walking back,
  because the walk is exactly when its bubble is off screen and useless.
- Pikachu's bubble is the FLEET headline, not its own state: the worst thing anywhere,
  in the same vocabulary the agent sprites use. It reads `cronState()` for the cron half
  so the two can never disagree.
- Ash's grounding is gathered by `src/server/recall.js`, locally, before the one
  `claude -p` call: each live agent's opening ask and newest turns from its transcript
  (via `transcriptFor`), plus the past sessions that mention the question. The search
  needs only SOME of the question's words, after stop words are dropped. Requiring
  every word (the old `searchSessions` rule, still right for the archive box) meant
  "what is X working on" matched nothing, since "what" and "on" had to appear too.
  Sessions are deduped by path and credited to the deepest repo, because a repo that
  contains another (scratch holds pokeclaude) lists the inner repo's transcripts as
  its own. A user turn that starts with `<` is the harness talking (task notification,
  system reminder), never quoted as the user. The sessions read travel back in
  `grounding.sessions` and the panel offers them as chips that open the transcript.
- Ash's answers have no transcript of their own - they come from a one-shot `claude -p`.
  `src/server/ashlog.js` appends every exchange to `data/ash-log.jsonl` BEFORE replying.
  Without that the answer was lost the moment the panel re-rendered, which is a real
  bug users hit. Leaving the panel mid-answer must still store it and toast.
- A workspace is tied to its Claude conversation through the PROCESS, not the hooks:
  cmux records a `ttyName` per panel in its session JSON, and the claude process on
  that tty carries `--session-id` (or `--resume`) on its own command line. From that
  plus the workspace directory the transcript path follows exactly. See
  `src/server/sessions.js`. Hook links are in-memory only, so they are wiped by every
  server restart and a blocked agent never fires another hook to restore them - which
  is why clicking a Pokemon used to show nothing. Never make transcript resolution
  depend on a hook having fired.
- Resolution order in `transcriptFor()` is process, then hook, then newest-in-repo.
  Only the last one can be wrong, so it is the only case reported as `ambiguous`.
- `ps` costs ~400ms, so the process table is cached for 5s. `/api/agent` forces one
  fresh read before giving up on an agent, because a just-started session will not be
  in a stale table.
- Matching cmux's session JSON rows to workspaces: an exact (dir, title) match WINS.
  Position in the list is only a tiebreaker for rows that are otherwise identical -
  several tabs in one repo are all called "new agent". Using position first attaches
  the wrong terminal to the wrong Pokemon; `tests/state.test.js` guards this.
- Desktop notifications are fired by the SERVER (`src/server/notify.js`, osascript), so
  they work with no browser open. They ride along with `broadcast()`, which is the one
  place every state change passes through. Two rules keep them trustworthy: the first
  `check()` after a restart announces NOTHING, and a workspace seen for the first time
  is learned quietly. Without either, restarting the server alerts you about the whole
  field at once. `POKECLAUDE_NOTIFY=0` turns them off.
- An upload filename travels in the `x-filename` HEADER, percent-encoded. A header can
  only carry ISO-8859-1, and macOS names every screenshot with a NARROW NO-BREAK SPACE
  (U+202F) before AM/PM: `fetch` threw before sending, so every screenshot failed to
  attach while ASCII names worked and the failure looked random. `uploadHeaderName()`
  encodes, `uploadName()` in paths.js decodes and flattens it to a safe basename.
- Notifications go through `osascript`, and they must. macOS credits an alert to the
  process that asked for it, so they all arrive as "Script Editor" with a script icon.
  We tried to fix that with our own applet (`.notifier/PokeClaude.app`, built by
  `tools/build-notifier-app.sh`) and it delivered NOTHING for a day, failing two
  different ways at once. macOS hands an applet launched by path NO argv, so
  `item 1 of argv` threw and it put up a modal alert, "Can't get item 1. (-1728)", with
  our Pokeball on it, once per notification, waiting for a click. That modal is why it
  HUNG on every run after the first, and `execFile`'s 4s timeout was the only thing
  keeping a dead notifier from stalling the broadcast. Passing the arguments some other
  way would not have saved it: an applet that asks for nothing at all is still denied,
  because `usernoted` refuses the legacy connection an AppleScript applet opens
  ("Denying message 3 from connection <LegacyConnection ...>") and drops the alert in
  silence, signed or not, in /Applications or not. Do not reintroduce it. A branded
  notifier needs a real signed binary on UNUserNotificationCenter, not a script.
- The desktop app may hold `/api/notify-stream` ONLY while macOS will actually show
  what it posts. An unauthorized app still gets `add` back with no error and still
  files a record in the notification database, and the alert is never seen. An app that
  subscribed regardless would swallow every notification the moment it opened and the
  osascript fallback would never fire. `syncNotifyPermission()` in `app/main.swift`
  connects on `.authorized` and disconnects on anything else, and asks again every time
  the app comes forward, because the switch can be flipped in System Settings while it
  runs.
- The app MUST be notarized or macOS will not let it post anything. This is settled and
  expensive to relearn, so do not unpick it. An unnotarized bundle is refused however it
  is signed: `requestAuthorization` returns "Notifications are not allowed for this
  application", no prompt appears for anyone to answer, and `authorizationStatus` stays
  denied. Ruled out by experiment, each on a fresh bundle id so nothing was a cached
  denial: ad-hoc, Developer ID and no signature at all; with and without the hardened
  runtime; /Applications and elsewhere; `open`, LaunchServices and Finder; the legacy
  `NSUserNotificationAlertStyle` key; and a hand-written grant in com.apple.ncprefs
  carrying a `csreq` blob built to match Slack's, which survives in the preferences and
  changes nothing because usernoted decides at request time. Of the 24 apps on this
  machine holding a notification grant, every one is notarized.
- `tools/build-app.sh` notarizes and staples on every build, through the keychain
  profile `pokeclaude`. Recreate it with
  `xcrun notarytool store-credentials pokeclaude --apple-id <id> --team-id L347P96J75`.
  Signing needs `--options runtime --timestamp`; without either the submission comes
  back Invalid. Zip with `ditto -c -k --keepParent`, never `zip`, which loses the
  symlinks and permissions in a bundle.
- `notarytool` EXITS 0 while printing "Error: HTTP status code: 403". Testing its exit
  code passes when nothing works, which is how a build reported success and shipped an
  unnotarized app. `notary_ready()` greps the output instead. Never trust its status.
- After stapling a ticket to a bundle macOS was already refusing, restart the
  notification services before believing the result: `killall usernoted NotificationCenter`.
  Until they restart, a correctly notarized app still reports denied, and it looks
  exactly like the notarization not having worked.
- Never let notification delivery depend on something that fails silently. The applet
  above passed every test, exited 0, and delivered nothing. What proves delivery is the
  macOS notification database, not an exit code:
  `sqlite3 "$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db" "select a.identifier, datetime(r.delivered_date + 978307200,'unixepoch','localtime') from record r join app a on a.app_id=r.app_id order by r.delivered_date desc limit 5;"`
- The species in a notification comes from the same hash the field draws with
  (`workspaceId + 'v2'`). `tests/notify.test.js` imports the client's `hash` and checks
  they agree: the Pokemon in the alert must be the Pokemon on the pen.
- `cronTrouble()` in the server duplicates two rules from `cronState()` in
  `public/js/crons.js`, because the server does not import client modules.
  `tests/notify.test.js` runs both over the same jobs, so the copies cannot drift.
- SSE transcript events are coalesced with a TRAILING call (`src/server/coalesce.js`).
  A leading-edge throttle drops the second write of a turn, and that write is where
  AskUserQuestion lands: the panel then shows a reply with no question under it until
  something else touches the file.
- A macOS drag that did not start in Finder (screenshot thumbnail, an image dragged out
  of another app) hands over a PROMISE: `dataTransfer.types` says Files, the drop zone
  lights up, and `dataTransfer.files` is empty. Read `items` too - `filesFromDrop()` in
  `public/js/attach.js`. A drop that stages nothing must say so, or it reads as success.
- A handler on an element with no size is a feature that does not exist. `#drag`, the
  panel divider, had `initDrag()` wired to it in main.js and no CSS rule at all, so it
  was a zero-width invisible div: every listener attached correctly to something nobody
  could ever grab, and no test could see it. Give an interactive element a size and a
  cursor in the same change as its behaviour.
- `#panel` animates its width. Measuring it straight after a change reads the value it
  is animating AWAY from, which reads exactly like the change not having worked. Wait
  out the .12s transition before believing a width, and turn it off during a drag
  (`body.resizing #panel{transition:none}`) or the divider lags the pointer.
- The panel width is clamped by `panelWidth()` in `public/js/view.js`, not in the drag
  handler, because the cases that matter cannot be produced with a mouse: a width
  restored from yesterday's wider screen, a window too narrow for both halves, and a
  corrupt stored value. The window `resize` listener re-applies it, or a panel sized on
  a big screen squeezes the field out of existence on a small one.
- The auth strip (`src/server/auth.js`, `public/js/authbar.js`) asks each tool's OWN
  status command and shows what it said: `gws-cli auth status -a`, `gh auth status`,
  `vercel` `whoami`, Slack `auth.test`, `claude auth status`, `codex login status`.
  Listing alone proves nothing, so each account is probed rather than counted. `gh`
  prints to stderr and exits 1 when any account is bad, so both streams are parsed.
  Vercel puts its version banner on stderr and the username on stdout, and
  `codex login status` answers in a sentence rather than JSON.
- AUTH_GROUPS in auth.js is the single list of what is probed, and GROUPS in authbar.js
  the list of what is drawn. They are pinned together by a test: a group in one and not
  the other is either probed and never shown, or labelled and never filled.
- No probe is configured with an account name. Each asks the tool what IT is signed
  into, so the strip works on anyone's machine and names nobody's accounts. A CLI is
  found through `bin()`: POKECLAUDE_<TOOL>_BIN, then ~/.local/bin, then PATH. Never
  hardcode an install path here; it was ~/.local/bin/gws-cli once, and that is exactly
  the kind of thing that only works on the machine it was written on. The sample is every 10 minutes, off the poll's await chain, and a probe
  that hangs reports `ok: null`, never blocks. A red chip's fix runs in a NEW cmux
  tab, because every sign-in opens a browser and needs a person; `fixFor()` is the one
  list of those commands. The strip is a flex sibling under `#stage` inside
  `#stage-col`, not an absolute child of it: an absolute child of a scroll box scrolls
  away with the field once zoomed in.
- A pen can run CLAUDE CODE or CODEX, chosen with the model in the NEW AGENT form.
  `src/server/engines.js` is the only place that builds the command line, and both of
  its rules exist because the model arrives from a browser: what is run must LOOK like
  a model name (`MODEL_SLUG`) and it must be QUOTED. `claude-opus-5[1m]` is a glob to
  zsh - unquoted, the pen dies with "no matches found" before Claude starts and it
  looks exactly like cmux failing. The shape test rather than catalog membership,
  because the catalog is always behind: Codex's own picker says "Access legacy models
  by running codex -m <model_name>", so the form has an OTHER box for a name that is
  not in the list yet, and `resolvePick` (public/js/engines.js) remembers that it was
  typed - otherwise the "drop a stale model" rule throws it away on every reopen.
- The Codex model list is READ FROM `~/.codex/models_cache.json` on every request,
  never hard-coded: it is the account's own list, `visibility: "list"` in the CLI's
  own priority order, and a model OpenAI ships appears in the picker with no edit
  here. `visibility: "hide"` marks models the account cannot actually run. The Claude
  list is five names in engines.js because Claude Code publishes no such file.
- Codex draws the same pane shape as Claude Code and none of the same details, so
  every reader in screen.js is written for both. Its composer prompt is "›" (and so
  are its past turns, which is safe only because the box is found by scanning UP); its
  empty box holds "Ask Codex to do anything" where Claude Code holds a `Try "..."`
  hint; and it draws NO RULE under the box, so the reader that stopped at "────" ran
  past the composer and pulled the model and the working directory into the draft.
  `BOX_END` is the rule OR the Codex footer. cmux.js no longer keeps its own copy of
  that scan - `composerRegion()` is the one definition.
- Spawning asks `agentReady()` and `trustGate()`, never an inline regex. Both engines
  gate on trust and take DIFFERENT answers: Claude Code's list is unselected so it
  wants the digit then Enter, Codex opens with "1. Yes, continue" already chosen and
  wants Enter alone. Codex's option list is drawn with the same "›" as its composer,
  so a ready check that only looks for a composer types the task into the dialog.
- cmux writes a `claude_code` status entry for a Claude tab and NOTHING for a Codex
  one, so `applyCmux` read "no row, therefore Idle" and a working Codex agent went
  back to sleep on the field every three seconds. A Codex pen's status comes from its
  own pane instead ("esc to interrupt"), sampled EVERY tick by `sampleCodex()` rather
  than once per round-robin - on a field of sixteen agents the round-robin is a
  minute, which is longer than most turns, so the pen went idle to idle having
  visibly done the work in between. `state.js` leaves the status of any agent whose
  engine is not `claude` alone.
- A Codex pen's conversation comes from CODEX'S OWN LOG, read by `src/server/codexlog.js`.
  `sessions.js` finds a Claude session by the `--session-id` on its process; a Codex
  process carries nothing on its command line, but from the moment the pane opens (and
  before it has written a turn) the native binary holds
  `~/.codex/thread-writer-locks/<session id>.lock`. `lsof -c codex` plus `ps` joins that
  lock to a tty, and the tty to the workspace, so the link is exact: two Codex pens in
  one repo never show each other's chat. The log is
  `~/.codex/sessions/YYYY/MM/DD/rollout-*-<session id>.jsonl`, found by name. It records
  the conversation twice: the raw `response_item` rows are the wire format and a
  `role: "user"` row there is a page of `<recommended_plugins>` the harness injected;
  only the `event_msg` / `item_completed` rows (UserMessage, AgentMessage,
  CommandExecution, FileChange) are the finished conversation. Codex wraps every command
  in `/bin/zsh -lc`, which is stripped or the panel labels each one "Ran a script:
  /bin/zsh". The rollout file is watched with the same `fs.watch` as a Claude transcript
  (`transcriptFor` returns it), so an open panel refreshes live. Codex records its own
  context window, so the context percentage is measured, not guessed from the model name.
  A codex process with no tty is the ChatGPT app's own copy, not a pen.
- PAST SESSIONS are both engines. `listSessions` (transcripts.js) merges Claude's
  `~/.claude/projects` rows with `listCodexSessions` (codexlog.js), which reads the
  `cwd` off the first line of every rollout under `~/.codex/sessions` - the file name
  carries the id and the date, not the directory - and skips subagent threads. Every
  row carries `engine`, and the panel tags it CLAUDE or CODEX. A session row is READ
  by `readConversation`, which picks the parser from the path (a Codex rollout lives
  under `~/.codex/sessions`); the archive, search, recall and `/api/transcript` all go
  through it, or a Codex session opens as an empty thread. `isTranscriptPath` accepts
  both roots and nothing else. RESUME goes through `resumeCommand` (engines.js): the
  id is checked as a UUID before it is spliced in, and a Codex row runs `codex resume`.
- The Codex model list is the ACCOUNT'S, and the account is whatever the login token
  says. Astra (`gpt-6-astra`) was refused with "not supported when using Codex with a
  ChatGPT account" for a day after the plan was upgraded, because `~/.codex/auth.json`
  still carried a token minted under the old plan and valid for ten days; Codex never
  refreshes a token that has not expired. `codex logout` then `codex login` (opens a
  browser, needs a person) is the fix, and `models_cache.json` refetches on the next
  run. Decode the token's `chatgpt_plan_type` claim before blaming the CLI.
- Every Codex command line carries `-c check_for_update_on_startup=false` (engines.js,
  spawn AND resume). When a Codex release ships, each new session opens on an "Update
  available!" menu with "Update now" preselected and no composer, so the spawn waited
  90s and failed with "did not become ready", and an Enter there runs npm install.
  Never answer that menu from `startAgent`; keep it off at the command line.
- A pen's tty comes from the LIVE `cmux tree --all --json` (`cmux.listWorkspaces`
  attaches it), and only falls back to the session file. cmux saves that file now and
  then: a tab opened after the last save has no row, and a closed tab's row keeps its
  old tty. A Codex pen spawned ten minutes after a save had no tty, never linked, and
  every reply was refused with "Still identifying this conversation".
- A cmux crash kills every agent AND the server (it runs in a cmux tab), and the tabs
  come back hollow. `src/server/roster.js` keeps `data/roster.json`: every session the
  poll saw on a live PROCESS (`procSessionId`/`codexSessionId`, never a hook id, which
  outlives its process). WHEN a session stopped decides what it means. Gone while the
  server watched a healthy cmux: closed on purpose, forgotten. Gone across a gap (the
  first poll after startup, or after a poll cmux refused or answered with no
  workspaces): died with cmux, so it is offered back as the CMUX RESTARTED checklist
  (`public/js/restore.js`, `POST /api/restore`). An empty workspace list is never
  trusted to retire anything, since cmux always lists the server's own tab. `take()`
  hands a session out once, so a double click cannot start two processes on one
  conversation. Test by planting a `running` entry and restarting the server, never by
  crashing cmux under your agents.
- No npm dependencies without a strong reason; the zero-dep property is deliberate.

## Security
- Server binds localhost only by default; it can send keystrokes to terminals — do not expose the port.
- Keep the explicit loopback bind AND local-http.js's Host/Origin checks: binding
  alone still lets another website POST commands to localhost through a browser.
  Origin-less native hooks remain allowed; foreign and null browser origins do not.
- Markdown link destinations are escaped attribute values and never pass through
  emphasis/code HTML restoration. Only their labels receive inline formatting.
- Cron fields must be integer ranges within their field bounds BEFORE expansion.
  Deleting a crontab job matches one whole command AND schedule, never a substring.
- No secrets in this repo. Hook payloads stay on localhost.

- Replies are saved in `data/reply-outbox.json` before the composer clears. The outbox
  delivers in order per workspace and waits on unavailable composers. A partial or
  uncertain submission becomes `review` and is never automatically repeated. Replies
  are tied to the original session. Terminal controls open only when requested.
- Always specify a terminal `surface_id` for cmux reads and writes. A workspace may
  contain a browser pane; workspace-only calls follow focus and fail with "Surface
  is not a terminal". Refuse ambiguous multiple-terminal workspaces.
