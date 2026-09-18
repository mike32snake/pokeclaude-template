# PokeClaude

A GBA-style ranch for your live Claude Code agents. Each pen is a repo. Each Pokémon
in a pen is a running agent working in that folder. Walk up, press Space, read what it
needs, answer it, and it goes back to work.

Layout: the left third is a chat panel. By default it lists every repo as a collapsed
row (click the caret to open it, `PC` for its past sessions), so the whole fleet fits
without scrolling. Repos with a blocked agent sort to the top with a red count. Inside,
click any agent (in the list, or its Pokemon on the field) to open its conversation. The
thread renders the way Claude Code prints it in the terminal: your prompts as `>` lines,
replies as plain text, tool calls as `⏺ Bash(...)`. The message box is pinned at the
bottom and `RAW` appends the live terminal dump. You can message any agent, not only blocked ones.
The field sits in the middle and the activity feed is a column on the right. Both side
panes collapse ( `[` and `]`, or their arrow buttons ) to give the field its width back. Everything fits one screen, so every repo and agent stays visible while you reply.

Agents are drawn from the original 151 Pokemon, one species per agent by session hash.
Within a plot: anything not working (waiting on you first, then idle) lines up in the
top-left, working agents roam the lower right, and a service parks at the top-right. Every
position sits a full tile inside the plot outline, so nothing straddles the border.
Each repo owns a coloured patch of ground with its own shed, and its name hangs on a sign
over that shed. No fences: the tint is the
boundary, and the whole plot is walkable. Ash stands in the bottom-right corner, outside
every plot; talk to him to spawn a new agent.

    http://localhost:5180

## Reading the map
| Over a Pokemon | Means |
|---|---|
| nothing | working |
| faint `zzz` | Claude finished its turn and went quiet |
| blue bubble `...` | done: it is waiting on you |
| red `!` | waiting more than 5 minutes |
| red `!!` | waiting more than 30 minutes |
| `...` | thinking: working, but no tool call for 8 seconds |
| exhaust + `:port` chip | a service (dev server, tunnel), not an agent |
| trailing Poke Balls | its running subagents |
| a card popping up (`>_`, `=`, `/`, `?`, `@`) | it just ran a tool: Bash, Read, Edit, Grep, Web |
| `...` | thinking, no tool call open yet |

Working agents also breathe, wander between spots in their plot every few seconds, and
kick up dust when they move. Idle ones breathe slower. A still sprite means something is
wrong, not that nothing is happening.

A red badge on a pen sign counts the blocked agents inside. The timer under a
Pokemon's feet is how long it has waited.

## Why
15 cmux tabs all look the same. 11 of them were blocked and nothing said so.
Here, an agent that finishes its turn shows a blue `...` bubble the moment it is waiting on
you. Past 5 minutes that becomes a red `!`, past 30 minutes a red `!!`, with a timer under
its feet. The plot's sign carries a count so you can see it without reading bubbles.

## What it needs
| | |
|---|---|
| [cmux](https://github.com/manaflow-ai/cmux) | Where the agents actually run. PokeClaude reads its workspace list; it does not replace it. |
| Node 20 or newer | No npm dependencies at all. `npm test` is `node --test`. Developed and verified on 23. |
| Claude Code CLI | `claude` on your PATH. Set `POKECLAUDE_CLAUDE_BIN` if it lives somewhere unusual. |
| Codex CLI | Optional. Without it, Codex pens and Codex sessions simply do not appear. |
| macOS | The folder picker calls AppKit, and the notifier calls `osascript`. Everything else is portable. |

## Run it
    tools/fetch-sprites.sh   # once: Pokemon sprites are not committed
    ./run-server.sh          # inside a cmux workspace (see "The cmux constraint")
    open http://localhost:5180

Your pens live in `config/repos.json`. If a clone does not have one, the server copies
`config/repos.example.json` over on the first read, so it boots into a real town rather
than an ENOENT. Edit that file directly, or add pens from Ash's front desk, which
writes the same file and rebuilds every layout for you. `~` is expanded on read, so the
paths can stay short.

## Make it yours
Four things people usually change, and where each one lives.

**Which folders get a pen.** `config/repos.json`, seeded from
`config/repos.example.json`. `dir` is the folder, `archetype` picks the shed, and `~`
works. Ash's front desk writes the same file and rebuilds the layouts, so you can do it
from the field instead. Nothing else has to change: the server matches a live agent to a
pen by its working directory.

**Which CLI a pen runs.** `src/server/engines.js` is the only file that builds a command
line. `CLAUDE_MODELS` is the Claude Code list; Codex's comes from its own
`~/.codex/models_cache.json` so a model is usable the day it ships. Adding a third
engine means adding a `spawnCommand` and a `resumeCommand` case there, and a way to read
its transcripts alongside `transcripts.js` (Claude Code's JSONL) and `codexlog.js`
(Codex's own log). Everything downstream, the field, the panel, the PC, the archive,
reads the normalised shape those produce.

**The sheds and the ground.** `tools/gen_buildings.py` and `tools/gen_overworld.py` draw
every committed image. Edit the generator, re-run it, reload the page. See ART.md.

**The creature sprites.** `public/js/dex.js` maps an id to a name and `sprites.js` loads
`/art/pokemon/<facing>/<id>.png`. Drop your own set in at those paths and nothing else
changes.

**What is macOS-only.** The folder picker (`src/server/picker.js`, an AppKit dialog),
the notifier's `osascript` fallback, and `app/main.swift`. The server, the client and
the whole test suite are plain Node and run anywhere; CI runs them on Linux.

## Wire up the hook
Without this, PokeClaude still draws the field, but status changes arrive on the 3s
poll instead of instantly, and "waiting on you" lags behind the terminal. Add the hook
to `~/.claude/settings.json`, pointing at your clone:

    {
      "hooks": {
        "SessionStart":     [{ "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }],
        "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }],
        "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }],
        "Notification":     [{ "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }],
        "Stop":             [{ "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }],
        "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }],
        "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "<clone>/hooks/pokeclaude-hook.sh" }] }]
      }
    }

`<clone>` is the absolute path to your checkout. Those seven are exactly the events
`src/server/state.js` reduces: `PreToolUse` drives the tool cards and the subagent
count, `Notification` is what turns a Pokemon blue, and `Stop` is what puts it to
sleep. `PostToolUse` is deliberately not in the list; it doubles the traffic and tells
the field nothing `PreToolUse` did not already say.

The hook runs on every Claude Code event on the machine, including when PokeClaude is
not running. It has a 1s curl timeout, discards its output and always exits 0, so a
dead server costs an agent 1s at worst and never fails a tool call.

## Controls
| Key | Does |
|---|---|
| Arrows / WASD | Move |
| Space / Enter | Talk to an agent, or stand at a hut door for the PC |
| Click a Pokemon | Open its conversation |
| Click a plot / repo header | Open that repo's PC (past sessions) |
| Talk to Ash (bottom-right) | Front desk: new agent, new repo, or ask about the field |
| Click a repo's house | Spawn a new agent in that repo |
| `-` / `+` / `0` | Zoom the field out / in / back to auto-fit |
| 3x3 / 4x4 / 5x5 (top centre) | Grid size. Fewer plots means bigger plots. |
| `[` / `]` | Collapse the chat pane / the activity pane |
| ARCHIVE | Every past session across all repos, read-only, with RESUME |
| FILTER (top-left of the field) | Checkbox per repo; unchecked repos grey out and leave the list |

The zoom control sits top-right of the field: `−  200%  +`. The percentage is the real
pixel scale, in 25% steps. Green means auto-fit; click it to lock the current zoom, click
again to go back to auto-fit. Collapse state and zoom persist in localStorage.
| **Tab** | Warp to the next blocked agent, longest wait first |
| N | New agent: pick a building, an engine and model, type a task |
| 1-9 | Jump to a building |
| Esc | Close |

`Tab` is the core loop. Press it, answer, press it again. The tab title shows the
blocked count (`(11) PokeClaude`) so you can see it from any other browser tab.

## The cmux constraint
cmux's control socket is `cmuxOnly`: it refuses processes outside the cmux session.
pm2 double-forks to PPID 1, so a pm2-supervised server is always denied. Two options:

1. Run under cmux (default): `run-server.sh` restarts on crash.
2. Set a socket control password in cmux Settings, put it in `.env` as
   `CMUX_SOCKET_PASSWORD=...`, then pm2 works normally.

The server detects denial and logs a clear error rather than showing an empty town.

## How it knows things
| What | Where from |
|---|---|
| Who exists, repo, branch | `cmux rpc workspace.list` + the cmux session JSON, polled every 3s |
| Status changes, instantly | Claude Code hooks -> `POST /api/hook` |
| Recent tools, last message | `~/.claude/projects/<slug>/<session>.jsonl` |
| Model, context %, mode | `cmux read-screen` on the selected agent only |
| Past sessions (the PC) | the same transcript directory, by mtime, plus `~/.codex/sessions` for Codex |

Hooks run inside the agent's own shell where `$CMUX_WORKSPACE_ID` lives, so the
session-to-tab link is exact. Before a hook fires, PokeClaude falls back to the
newest transcript for that folder, and if several agents share the folder it says
"not linked yet" instead of showing you the wrong agent's work.

## Archive
Killing an agent removes it from the field, but the transcript outlives the workspace.
`ARCHIVE` (next to NEW AGENT) lists every past session across all repos, newest first.
Every row in the PC and the archive carries a `CLAUDE` or `CODEX` tag, because Codex keeps
its sessions in its own directory and they are listed alongside Claude's. Opening a Codex
row shows its conversation from Codex's own log, and RESUME on it runs `codex resume`.
Open one to read the full thread, or RESUME it into a fresh cmux tab. It reads straight
from `~/.claude/projects`, so nothing extra is stored and nothing is ever lost on kill.

## Reading a thread
Assistant text renders as markdown: tables, headings, lists, links, bold, inline code and
fenced code blocks. The renderer is `public/js/markdown.js`, zero dependencies, and it
escapes before it transforms so nothing in a transcript can inject markup.

`AskUserQuestion` is treated as conversation, not tool noise. Each one renders as the
decision it is: the question, every option with its description, and a badge saying
**WAITING ON YOU**, **ANSWERED** (with the chosen option ticked) or **DECLINED**.

A pending question's options are **clickable**: clicking one drives the picker in the real
terminal. The server reads the screen first and refuses if the question has moved on, so a
stale panel can never pick the wrong thing for you.

Drag the divider between the chat and the field to trade width. Double click it to reset.
Back sits top-left of the chat header, collapse top-right.

The open thread updates **live**: the server watches each agent's transcript file and
pushes over SSE the moment a turn lands, so the chat keeps pace with the terminal instead
of waiting for a poll or for you to reopen the agent.

**Attachments**: drag files onto the chat pane, paste a screenshot straight into the
message box, or use `+` to pick files. They upload to `uploads/` and are sent to the agent as absolute paths, which is what
Claude Code can actually open. Paths go first so the agent sees the file before the
instruction about it.

Two levels, toggled with the `SUMMARY` / `DETAIL` button in the chat header:

- **Summary (default)** — one line per meaningful action, phrased for a human, with runs
  collapsed: `Read 3 files`, `Ran tests`, `Committed changes`, `Handed work to a subagent`.
  This is the orchestration view.
- **Detail** — every raw tool call with its arguments, as Claude Code prints them.

Both are pure local formatting in `public/js/summarize.js`. No model call, no tokens.

## Search
The `ARCHIVE` view has a search box. Type and press Enter to search past sessions; results
show the repo, how many turns matched, and a snippet. `THIS REPO` scopes it to the repo you
last opened, `ALL REPOS` widens it again.

Matching is literal, case-insensitive, AND across terms, over message text (tool noise is
excluded from matching so a hit is always something that was actually said). Cheap
substring reject first, full parse only on candidate files. No embeddings, no tokens.

## Services vs agents
A cmux workspace that is listening on a port and has no Claude session is a **service**
(dev server, tunnel), not an agent. cmux reports the port, so this is a fact, not a guess.
A service keeps its Pokemon, marked by an overlay rather than a different sprite: exhaust
puffs drift up over the creature, and its port floats above it on a dark chip. It sits at
the top-right of its plot beside the shed, never roams, and gets its own panel view: the ports (click to
open in the browser), plus OPEN TAB / RAW / STOP. No conversation, because there isn't one.

## Ash, the front desk
Click Ash in the bottom-right corner for three things:

- **New agent** — pick a repo, an engine, a model, and type a task. The engine is
  Claude Code or Codex; the model list is the five latest for Claude Code and whatever
  the Codex CLI says the account can run today, read from its own cache so a new model
  shows up without an edit here. `Other model…` takes a name that is not in the list
  yet. The choice is remembered between visits.
  A Codex pen's panel reads Codex's own session log, so its conversation, model, mode
  and context percentage show the same way a Claude Code pen's do, and refresh live.
- **New repo** — put a folder on the field. CHOOSE… opens the real Finder dialog, so the
  absolute path is never typed by hand. It is validated, appended to `config/repos.json`,
  and every layout is rebuilt, so the plot appears without a restart.
- **Ask** — a question about the repos currently on screen (the filter applies).

## Ask
The ask box answers questions across the visible repos and their sessions. Before Ash
answers, Pikachu reads the sessions for context (`src/server/recall.js`):

- **Live agents.** Every agent on the field contributes its opening ask, its newest turns,
  and any older turn that mentions the question. A service contributes its ports.
- **Past sessions.** The newest 20 transcripts of every visible repo are searched for the
  words that carry the question (stop words dropped). A session needs only some of the
  words, and is ranked by how many distinct ones it holds. The best 8 contribute up to 3
  matching turns each, with their date.

The answer says which agent or session each fact came from, and the sessions Pikachu read
are listed under it as chips: click one to read the whole transcript. The whole search is
local. Only the answer itself runs through the Claude Code CLI on the Max subscription
(never a raw API key).

**This is the only feature here that spends tokens.** Summarising and searching are local.

## Logins
A thin strip under the field lists every login on this machine and whether it still
works. Six tools, and it only shows the ones you actually have:

| Group | Asks | Signs back in with |
|---|---|---|
| Google | `gws-cli auth status -a <account>`, one chip per account in your own `gws_config.json` | `gws-cli auth -a <account>` |
| GitHub | `gh auth status`, one chip per account | `gh auth login -h github.com` |
| Vercel | `vercel` `whoami` | `vercel login` |
| Slack | `auth.test` with a user token | a token to paste, no CLI |
| Claude | `claude auth status` | `claude auth login` |
| Codex | `codex login status` | `codex login` |

Nothing here is configured with an account name: each probe asks the tool what it is
signed into, so the strip shows your accounts, not anyone else's. A tool that is not
installed is left out rather than shown red. The Slack chip appears only if
`SLACK_USER_TOKEN` (or `SLACK_TOKEN`) is set, or `POKECLAUDE_OAUTH_FILE` points at a
JSON file holding one. A CLI somewhere unusual can be named with
`POKECLAUDE_GWS_CLI_BIN`, `POKECLAUDE_VERCEL_BIN` and so on.

Each chip is green, red or grey (could not tell). The headline says how many need a
sign-in and how old the check is; click it to check again. Hover a chip for the tool's
own message. Click a **red** chip and a cmux tab opens running that tool's sign-in
command, since every one of them needs a browser. The browser is your system default;
`POKECLAUDE_BROWSER` picks another. The check runs every 10 minutes from the server
(`src/server/auth.js`) and never blocks the poll.

## Filter
`FILTER` sits top-left of the field, opposite the zoom control. Tick repos off to grey
their plot, drop their Pokemon from the field, and remove them from the list and the
blocked count. Useful when a couple of noisy repos are drowning out the rest. The choice
persists per browser; `Show all` / `Hide all` are one click. Hiding a repo **reflows** the
rest: the remaining plots pack up and to the left with no gap, and the ground where it used
to be is ordinary grass. Nothing about the field is baked into an image, so there is no
patched-over rectangle to give it away.

## Context, branch and model
Every agent row carries its branch, model and context percentage, and the chat header
shows them as a readout with a context meter. Anything at 80% or more turns red, in the
list and in the status bar, because a near-full context is the failure you cannot see
from the outside: the agent will start compacting or fall over, and nothing else on the
field hints at it.

The footer is sampled round-robin, one agent per poll tick, so the whole fleet stays
fresh without a read-screen storm. Branch comes from `git` directly rather than cmux,
which only knows the branch for repo roots.

## Status bar
A line across the bottom, in the spirit of Claude Code's own footer. It has two modes:

- **Nothing selected** — the fleet: waiting / working / idle counts, the worst context
  percentage and how many agents are over 80%, which models are in play, and what is
  serving on which port.
- **An agent selected** — that agent: repo, species, status, branch, model, context meter
  and permission mode. It keeps ticking while you read, so context updates live.

Either way the right-hand side stays put: the 5h and 7d usage windows, the grid, the
visible repo count and the zoom. Usage is sampled from a live agent's footer once a minute.

The same model / context / mode readout sits at the top of the chat, so you have it both
where you are reading and at a glance along the bottom.

## Configure
`config/repos.json` maps a directory to a shelter archetype and a pen. After editing:
`npm run build:town`. The layout auto-sizes so everything keeps fitting one screen;
`tools/build-town.js` holds the grid constants (`L`).

Shelter art is generated, not copied: `tools/gen_buildings.py` draws each hut
(roof style, wall texture, themed ornament: red cross, clock, satellite dish,
telescope, gear, banner, envelope, globe...). Add a theme there to add a type.

## Tests
    npm test        # 20 tests, all must pass

Covers sign truncation, path case-normalization, the poll/hook state reducer,
transcript parsing, and ranch geometry: the map fits a laptop screen at 2x, pens
never overlap, and every work spot, gate and hut door is reachable from spawn.

## Keep it local
The terrain tiles and trainer sprite derive from Pokémon art, and the Pokémon
overworld sprites come from the veekun pack, fetched onto your machine and never
committed. See ART.md. Fine on localhost. Do not host it anywhere.
