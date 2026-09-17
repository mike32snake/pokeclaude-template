#!/bin/bash
# Builds PokeClaude.app and installs it into /Applications.
#
# /Applications is not a preference. macOS refuses to register an app for notifications
# from an arbitrary directory: the same bundle run out of a scratch folder gets
# "Notifications are not allowed for this application" and never appears in System
# Settings, while the identical bundle in /Applications registers and delivers. See
# AGENTS.md. Everything used here ships with the machine: swiftc, codesign, plutil.
set -e
cd "$(dirname "$0")/.."
REPO="$PWD"
APP="/Applications/PokeClaude.app"
ID="com.acme.pokeclaude"

command -v swiftc >/dev/null || { echo "swiftc not found; install the Xcode command line tools" >&2; exit 1; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

swiftc -O app/main.swift -o "$APP/Contents/MacOS/PokeClaude"

# The Pokeball, drawn analytically at every size Apple asks for by a script with no
# image library behind it. The app was the whole reason that icon exists.
node tools/make-ball-icon.mjs "$APP/Contents/Resources/PokeClaude.icns" >/dev/null

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>PokeClaude</string>
  <key>CFBundleIdentifier</key><string>$ID</string>
  <key>CFBundleName</key><string>PokeClaude</string>
  <key>CFBundleDisplayName</key><string>PokeClaude</string>
  <key>CFBundleIconFile</key><string>PokeClaude</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>$(date +%Y%m%d%H%M%S)</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The page is served over plain http from localhost, which ATS blocks by default. -->
  <key>NSAppTransportSecurity</key><dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
  <!-- Where the app looks for run-server.sh and .env, written in at build time. -->
  <key>PCRepoPath</key><string>$REPO</string>
</dict></plist>
PLIST

# Signed with a real identity when one is on the machine, because notifications depend
# on it: an ad-hoc bundle is registered by macOS, accepts the notification, files the
# record, and is then never shown, with requestAuthorization returning "Notifications
# are not allowed for this application" and no prompt for anyone to answer. A Developer
# ID signature is what makes the prompt appear. Ad-hoc still builds a working window.
#
# Sign LAST, whatever the identity. Editing Info.plist after signing breaks the seal,
# and macOS then rejects the bundle with -67030 and drops every alert in silence.
SIGN_ID="${POKECLAUDE_SIGN_ID:-$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | awk '{print $2}')}"
if [ -n "$SIGN_ID" ]; then
  # --options runtime and --timestamp are both required by the notary service. Without
  # either, the submission comes back Invalid instead of Accepted.
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP" >/dev/null
  echo "signed with $SIGN_ID" >&2
else
  codesign --force --sign - "$APP" >/dev/null 2>&1
  echo "no Developer ID found; ad-hoc signed. Notifications will not be granted." >&2
fi

# Notarizing is what buys the notifications. macOS refuses notification authorization to
# an unnotarized bundle however it is signed, so without this step the app is a window
# and nothing more, and the server keeps alerting through osascript. See AGENTS.md.
#
# Skipped when the keychain profile is missing, because the app still builds and runs
# without it. Create it once with:
#   xcrun notarytool store-credentials pokeclaude --apple-id <id> --team-id L347P96J75
#
# The reachability check greps the OUTPUT. `notarytool history` EXITS 0 while printing
# "Error: HTTP status code: 403", so testing its exit code passes when nothing works.
PROFILE="${POKECLAUDE_NOTARY_PROFILE:-pokeclaude}"
notary_ready() {
  local out
  out="$(xcrun notarytool history --keychain-profile "$PROFILE" 2>&1)" || return 1
  case "$out" in *"Error:"*) echo "$out" >&2; return 1 ;; esac
  return 0
}
if [ -n "$SIGN_ID" ] && [ "${POKECLAUDE_NOTARIZE:-1}" = "1" ] && notary_ready; then
  ZIP="$(mktemp -d)/PokeClaude.zip"
  # ditto, not zip: a plain zip loses the symlinks and permissions in a bundle, and the
  # notary service rejects what comes out the other side.
  /usr/bin/ditto -c -k --keepParent "$APP" "$ZIP"
  echo "notarizing (this takes a few minutes)..." >&2
  if xcrun notarytool submit "$ZIP" --keychain-profile "$PROFILE" --wait >&2; then
    # Staple the ticket INTO the bundle so macOS can verify it with no network.
    xcrun stapler staple "$APP" >&2
  else
    echo "notarization failed; the app still runs but cannot post notifications" >&2
  fi
  rm -rf "$(dirname "$ZIP")"
elif [ -n "$SIGN_ID" ]; then
  echo "notary service not usable with profile \"$PROFILE\"; skipping notarization" >&2
fi

# LaunchServices caches bundles by path, so a rebuilt app keeps the old icon and name
# until it is re-registered.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$APP" 2>/dev/null || true

echo "$APP"
