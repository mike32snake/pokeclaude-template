#!/bin/sh
# OAuth browser launcher, handed to the CLIs as $BROWSER during a sign-in.
#
# Whatever browser you already use: the point is that the sign-in lands in a profile
# that is already logged in. POKECLAUDE_BROWSER overrides it, either as an application
# name on macOS ("Brave Browser", "Firefox") or as a command anywhere else.
set -eu

if [ -n "${POKECLAUDE_BROWSER:-}" ]; then
  if [ "$(uname)" = "Darwin" ] && [ -d "/Applications/${POKECLAUDE_BROWSER}.app" ]; then
    exec /usr/bin/open -a "$POKECLAUDE_BROWSER" "$@"
  fi
  exec "$POKECLAUDE_BROWSER" "$@"
fi

# No preference: the system default browser.
if [ "$(uname)" = "Darwin" ]; then exec /usr/bin/open "$@"; fi
command -v xdg-open >/dev/null 2>&1 && exec xdg-open "$@"
echo "No browser opener found. Set POKECLAUDE_BROWSER." >&2
exit 1
