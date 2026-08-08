#!/bin/bash
# Rebuild the Safari app extension from the plain web-extension sources in ./extension
#
#   ./build.sh          build (Release) and report where the app landed
#   ./build.sh run      build, then open the app so Safari registers the extension
set -euo pipefail

cd "$(dirname "$0")"

APP="TronPick Gems Autoplay"
PROJ="xcode/$APP/$APP.xcodeproj"
RESOURCES="xcode/$APP/$APP Extension/Resources"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"

if [ ! -d "$PROJ" ]; then
  echo "Xcode project missing — generating it."
  xcrun safari-web-extension-converter \
    --project-location ./xcode \
    --app-name "$APP" \
    --bundle-identifier com.ata.tronpickgems \
    --macos-only --swift --no-open --no-prompt --copy-resources \
    ./extension
fi

# The converter derives the app's bundle id from the app name, which leaves it
# unrelated to the extension's id and fails embedded-binary validation. Force
# the app id so the extension id (…​.Extension) is a proper child of it.
if grep -q '"com.ata.TronPick-Gems-Autoplay"' "$PROJ/project.pbxproj"; then
  echo "Normalizing bundle identifiers"
  sed -i '' 's/"com\.ata\.TronPick-Gems-Autoplay"/com.ata.tronpickgems/g' "$PROJ/project.pbxproj"
fi

# Push the current web-extension sources into the Xcode target.
echo "Syncing ./extension -> $RESOURCES"
rsync -a --delete extension/ "$RESOURCES/"

DERIVED="$(pwd)/xcode/build"
xcodebuild \
  -project "$PROJ" \
  -scheme "$APP" \
  -configuration Release \
  -derivedDataPath "$DERIVED" \
  CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" PROVISIONING_PROFILE_SPECIFIER="" \
  build | tail -5

BUILT="$DERIVED/Build/Products/Release/$APP.app"

# The build leaves a second, unembedded copy of the extension sitting next to
# the app, carrying the same bundle identifier as the one inside it. Launch
# Services registers both paths, Safari lists the extension twice, and enabling
# both puts two content scripts on the page. Only one of them can own it — the
# other stands down, and its popup then does nothing at all when pressed.
LOOSE="$DERIVED/Build/Products/Release/$APP Extension.appex"
if [ -d "$LOOSE" ]; then
  echo "Removing the unembedded duplicate extension"
  "$LSREGISTER" -u "$LOOSE" >/dev/null 2>&1 || true
  rm -rf "$LOOSE" "$LOOSE.dSYM"
fi

echo
echo "Built: $BUILT"

if [ "${1:-}" = "run" ]; then
  # `open` only re-activates an already-running copy, so a stale instance from a
  # previous build would keep running with the old code. Quit it first.
  if pgrep -f "$APP.app/Contents/MacOS" >/dev/null; then
    echo "Quitting the running copy"
    osascript -e "quit app \"$APP\"" 2>/dev/null || true
    sleep 1
    pkill -f "$APP.app/Contents/MacOS" 2>/dev/null || true
    sleep 1
  fi
  open "$BUILT"
  echo "App launched — it holds the keep-awake assertion while it is open."
fi
