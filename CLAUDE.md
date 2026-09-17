# Working in PokeClaude

A GBA-style ranch for your live Claude Code agents. Each pen is a repo, each Pokemon
in it is a running cmux workspace with Claude in it. Localhost only, zero npm
dependencies, vanilla JS on the client and plain Node ESM on the server.

Read `AGENTS.md` before you change anything. It is the long list of invariants, and
most of them exist because breaking them looked fine and was silently wrong. This file
is the shorter working agreement: how to boot, how to verify, and what not to do.

## Boot

    tools/fetch-sprites.sh          # once per clone: the Pokemon sprites are not in git
    ./run-server.sh                 # inside a cmux workspace, see "The server" below
    open http://localhost:5180
    npm test                        # 113 tests, all must pass
    tools/build-app.sh              # optional: PokeClaude.app into /Applications

`npm run build:town` regenerates `public/art/town-{3,4,5}.json` after you edit
`config/repos.json`.

## The server

It runs under `run-server.sh` in its own cmux workspace, NOT under pm2. cmux's control
socket is `cmuxOnly` and denies pm2, which double-forks to PPID 1. `run-server.sh` is a
restart loop, so `pkill -f "node src/server/index.js"` restarts the server in place and
picks up your changes. Do not start a second instance on port 5180; it will crash-loop
on EADDRINUSE while the real one keeps serving.

The client is static files with no build step. A browser reload is the whole deploy.

## Rules that are not up for debate

- **TDD.** Write the failing test first, then the code. A change is not done until
  `npm test` passes and you have posted the output. Pure logic goes in a module a test
  can import; `public/js/view.js`, `frontdesk.js` and `drafts.js` exist because of this.
- **No npm dependencies.** The zero-dep property is deliberate. Draw it, parse it, or
  write it yourself.
- **Nothing Pokemon-derived goes in git, and this runs on localhost.** Everything
  committed here is drawn: `tools/gen_buildings.py` for the sheds,
  `tools/gen_overworld.py` for the ground tiles and the ranger. The creature sprites
  come from a third-party pack that `tools/fetch-sprites.sh` downloads onto your own
  machine, and `public/art/pokemon/` is gitignored. Do not commit that pack, do not
  host this anywhere, and do not replace drawn art with a crop of someone's tileset.
  See ART.md.
- **The hook must never block.** `hooks/pokeclaude-hook.sh` runs on every Claude Code
  event on this machine: 1s curl timeout, always exit 0.
- **Only one feature spends tokens**: Ash's ask box (`/api/ask`), which runs the Claude
  Code CLI on the Max subscription, never a raw API key. Summarising, searching and
  formatting are local and must stay local.
- **Untrusted text is escaped before it is transformed.** `public/js/markdown.js` does
  this in that order. Transcripts are input, not markup.

## Layering

    server:  signs/paths -> cmux/transcripts/sessions -> state -> index
    client:  net/sprites/view/frontdesk/drafts -> world -> ui -> main

Never import upward. `main.js` is the loop and the input handler, `ui.js` owns the left
panel, `world.js` owns placement, `sprites.js` owns drawing, and `net.js` is the only
thing that talks to the server.

## Verifying UI work

Looking at the code is not verification. Load the page and check it.

- `window.__pc` is the debug handle: `player`, `ranger`, `desk`, `seat`, `town`,
  `world`, `ui`, `state`, plus `setZoom`, `goto`, `door` and `openPC`.
- Drive it with a browser tool, take a screenshot, and read the screenshot. Sprite
  work needs an eye on it, not an assertion.
- Animation can be checked without eyes: hash a region of the canvas over several
  frames and confirm the hashes differ.
- To exercise Ash without spending tokens, stub `window.fetch` for `/api/ask` in the
  page and let the pending promise hold him busy.
- Clean up any screenshots you write into the repo. `.playwright-mcp/` is gitignored;
  the repo root is not.

## Other agents are in this tree

Several Claude agents work in this repo at the same time, often in the same files.

- Run `git status` and `git log --oneline -3` before you commit. Another agent may have
  already committed your work in progress along with theirs.
- Commit only what you understand. Never revert, rewrite or force-push someone else's
  work, and never `git checkout --` a file you did not edit.
- If a test you did not write is red, check whether it is another agent's failing test
  from their red-green cycle before you "fix" it.

## Commits

Match the existing log: a short imperative subject, then prose explaining what was
wrong and why the fix is shaped this way. No bullet dumps of files changed. End with:

    Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>

Every commit on `master` is pushed to GitHub by `.git/hooks/post-commit`, in the
background, with output in `.git/auto-push.log`. Keep origin current at all
times and wants no side branches. So work on `master`, run `npm test` before you
commit, and never commit something red: a commit is a push. If the log shows
`PUSH FAILED`, run `git pull --rebase && git push`. The hook is local and not in git,
so a fresh clone needs it recreated.

## What is not in git

`public/art/pokemon/` (18MB of sprites, restore with `tools/fetch-sprites.sh`),
`art-src/`, `data/` (Ash's log), `uploads/`, `shots/`, `tools/venv/`, `.env`.
Everything else needed to run is committed.

## Documentation status

- `AGENTS.md` is the source of truth for invariants. Add a bullet whenever you learn
  something that would look fine and be wrong.
- `README.md` is the user-facing tour. Accurate on behaviour, stale on counts.
- `ARCHITECTURE.md` and `PROJECT_STATE.md` predate the pannable field and the trimmed
  canvas. Trust `AGENTS.md` and the code where they disagree.
