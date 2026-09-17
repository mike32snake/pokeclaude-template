# Agent input and terminal recovery

The chat composer belongs to the selected workspace. Text is saved until a send is
verified; switching agents during a request cannot overwrite another draft. Conversation upload
trays also belong to the workspace and their paths survive reloads in localStorage.
Temporary blob previews are not persisted. A refresh of the thread preserves
input selection and focus. Enter during IME composition does not submit.

Normal sends inspect the live terminal, refuse existing drafts, and recognize
Claude suggestions/queue hints and Codex's `default fast` footer. Draft probes
verify both insertion and removal, including insertion at a cursor in the middle
of a line. A failed probe means input could not be verified, not that the terminal
is conclusively frozen. Failed/partial sends retain the chat draft. Enter is not
retried automatically, since the first Enter might have opened a new question.

Questions and approvals from both engines appear in the chat. Each option click
checks the question and full label, observes every cursor movement, and confirms
only after reaching the selected option. Multi-question forms and custom answers
can also be completed through Terminal controls.

Terminal controls show a live screen and expose arrows, Space, Tab, Shift+Tab,
Escape, Enter, Backspace, and line-editing keys. Type inserts one literal line
without submitting it; Enter is a separate deliberate action. This supports custom
answers, multi-select submission, slash menus, and drafts that the chat adapter
cannot safely interpret. A changed input box or picker refuses the action and refreshes for
review. Progress output above an unchanged, recognized composer does not block a key. The screen opens at the bottom so the current composer is visible.

One terminal action per workspace can run at a time across all clients. A completed
or failed request releases the lock even if the browser disconnected. Terminal
controls and chat share this lock. Concurrent direct typing in cmux can still race
a screen check; no screen-scraping adapter can make those two operations atomic.

Limits: a terminal process that really stopped accepting input still needs cmux
recovery. New CLI UI formats can require parser updates. Unknown or changing picker screens may
need another Refresh before a manual key can be used. The new-agent form keeps its
text and uploads after a failed launch, but does not persist across reloads. No
claim of universal terminal compatibility is made. Never silently clear a user's
draft, confirm an unseen question, or automatically restart a live agent.

Regression tests: interaction.test.js, terminal.test.js, suggestion.test.js,
codexpane.test.js, screen.test.js, plus the existing typing/pending/draft tests.

Keep PokeClaude a thin interface: native CLIs own execution, approvals, queues,
models, and session state. Terminal controls and Open in cmux are supported paths
for uncommon UI; do not rebuild every CLI screen in HTML. Draft recovery acts on
only the reviewed terminal draft, never automatically follows it with the chat
reply. Uploads have unique, exclusively created filenames and bounded reads that
settle on interruption. New-agent launch permits one in-flight request per form
and leaves failed tasks editable.
