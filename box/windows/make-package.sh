#!/usr/bin/env bash
# Builds ThreeOClock-Setup.exe (and ThreeOClock.zip, the same app for the nightly updater).
# docs/WINDOWS-INSTALL.md.
#
#   bash box/windows/make-package.sh                        build release/ThreeOClock-Setup.exe and
#                                                           release/ThreeOClock.zip, to try or hand over
#   bash box/windows/make-package.sh --publish              and publish them as a signed release in
#                                                           Aryapatel-007/three-o-clock-releases: installed
#                                                           PCs take it in their next night window
#   bash box/windows/make-package.sh --publish --manual "why"   a release the PCs must not install
#                                                           by themselves (run ThreeOClock-Setup.exe instead)
#
# Run in Git Bash on the developer PC, with Inno Setup 6 installed
# (winget install JRSoftware.InnoSetup). Takes the committed code (git archive: never
# .env, never data, never anything uncommitted) and adds the built screens. No secrets
# are inside: the installer makes each restaurant's own on its PC.
set -euo pipefail
PUBLISH=0
MANUAL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) PUBLISH=1; shift ;;
    --manual) MANUAL="${2:?--manual needs a reason}"; shift 2 ;;
    *) echo "Unknown option $1. Use --publish, and --manual \"reason\"."; exit 1 ;;
  esac
done
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$ROOT/release"
STAGE="$OUT/ThreeOClock"
RELEASE_REPO="${THREE O CLOCK_RELEASE_REPO:-Aryapatel-007/three-o-clock-releases}"
cd "$ROOT"

ISCC=""
for candidate in "${LOCALAPPDATA:-}/Programs/Inno Setup 6/ISCC.exe" "/c/Program Files (x86)/Inno Setup 6/ISCC.exe" "/c/Program Files/Inno Setup 6/ISCC.exe"; do
  [[ -f "$candidate" ]] && ISCC="$candidate" && break
done
[[ -n "$ISCC" ]] || { echo "Inno Setup 6 is missing. Install it: winget install JRSoftware.InnoSetup"; exit 1; }

if [[ -n "$(git status --porcelain -- server client box setup package.json package-lock.json)" ]]; then
  echo "Commit your changes first: the package is made from the last commit."; git status --short; exit 1
fi

echo "Building the screens..."
(cd client && npx vite build >/dev/null)

rm -rf "$STAGE" "$OUT/ThreeOClock.zip" "$OUT/ThreeOClock-Setup.exe" "$OUT/manifest.json"
mkdir -p "$STAGE"
git archive --format=tar HEAD | tar -x -C "$STAGE"
# Only what runs on a restaurant's PC: no tests, no developer docs, no CI, no screen
# source (the PC serves the built client/dist), no packaging tools.
rm -rf "$STAGE/e2e" "$STAGE/.github" "$STAGE/server/tests" "$STAGE/docs" "$STAGE/CLAUDE.md" \
  "$STAGE/render.yaml" "$STAGE/vercel.json" "$STAGE/eslint.config.js" \
  "$STAGE/client/src" "$STAGE/client/public" "$STAGE/client/index.html" "$STAGE/client/vite.config.js" \
  "$STAGE/client/fontSubset.js" "$STAGE/client/vercel.json" \
  "$STAGE/box/windows/make-package.sh" "$STAGE/box/windows/threeoclock-setup.iss" "$STAGE/box/windows/protect-server.mjs"
mkdir -p "$STAGE/client/dist"
cp -R client/dist/. "$STAGE/client/dist/"
cp box/windows/LICENSE.txt "$STAGE/LICENSE.txt"
# The server and the installer's sample loader as bundled, obfuscated files: no readable source.
echo "Protecting the server code..."
node box/windows/protect-server.mjs "$STAGE"
cp "box/windows/Install ThreeOClock.bat" "$STAGE/Install ThreeOClock.bat"
cp "box/windows/Load cafe data.bat" "$STAGE/Load cafe data.bat"
cp "box/windows/Connect to the website.bat" "$STAGE/Connect to the website.bat"
cp "box/windows/Start fresh.bat" "$STAGE/Start fresh.bat"
cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
THREE O CLOCK

New PC: double-click ThreeOClock-Setup.exe, click Install, and press Enter at the two
questions in the blue window. Keep the PC on the internet until it says "All done".
Then use the "ThreeOClock" icon on the desktop. Every login is in "ThreeOClock logins" on
the desktop.

Tablets and phones: join the same WiFi as this PC, then open "ThreeOClock - Connect a
device" on the desktop and scan the QR codes.

New versions install by themselves at night. To update by hand, run the newest
ThreeOClock-Setup.exe again: the restaurant's data is kept.
TXT
COMMIT="$(git rev-parse --short HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$COMMIT" > "$STAGE/VERSION.txt"
printf '{ "commit": "%s", "builtAt": "%s" }\n' "$COMMIT" "$BUILT_AT" > "$STAGE/VERSION.json"

echo "Building ThreeOClock-Setup.exe..."
MSYS2_ARG_CONV_EXCL="*" MSYS_NO_PATHCONV=1 "$ISCC" /Q "/DStageDir=$(cygpath -w "$STAGE")" "/DAppVersion=$COMMIT" "/DOutputDir=$(cygpath -w "$OUT")" "$(cygpath -w "$ROOT/box/windows/threeoclock-setup.iss")"
(cd "$OUT" && /c/Windows/System32/tar.exe -a -cf ThreeOClock.zip ThreeOClock)   # Windows' own tar, which update.mjs also unpacks with
rm -rf "$STAGE"
echo "Made $OUT/ThreeOClock-Setup.exe ($(du -h "$OUT/ThreeOClock-Setup.exe" | cut -f1)) and ThreeOClock.zip, version $COMMIT."

[[ "$PUBLISH" == 1 ]] || exit 0

# ---------------------------------------------------------------------------
# Publish: a public GitHub release the installed PCs' updater finds (box/windows/update.mjs).
git fetch --quiet origin main
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "Push this commit to origin main first: a release must point at code GitHub has."; exit 1
fi
if [[ ! -f box/windows/release-public-key.pem ]]; then
  echo "No release key yet. Run: node box/windows/release.mjs keygen, and commit box/windows/release-public-key.pem."; exit 1
fi

# A changed installer means new scheduled tasks or settings the updater cannot make. Each
# release's tag is also pushed to the source repository, so the two can be compared.
PREVIOUS_TAG="$(gh release list -R "$RELEASE_REPO" -L 1 --json tagName -q '.[0].tagName' 2>/dev/null || true)"
if [[ -z "$MANUAL" && -n "$PREVIOUS_TAG" ]]; then
  git fetch --quiet origin "refs/tags/$PREVIOUS_TAG:refs/tags/$PREVIOUS_TAG" 2>/dev/null || true
  if git rev-parse -q --verify "refs/tags/$PREVIOUS_TAG" >/dev/null \
    && ! git diff --quiet "$PREVIOUS_TAG" HEAD -- box/windows/install.ps1; then
    MANUAL="The installer changed since $PREVIOUS_TAG: run the new ThreeOClock-Setup.exe on this PC."
    echo "Note: $MANUAL"
  fi
fi

SIGN_ARGS=("$OUT/ThreeOClock.zip" "$OUT/manifest.json" --commit "$COMMIT" --built-at "$BUILT_AT")
[[ -n "$MANUAL" ]] && SIGN_ARGS+=(--manual "$MANUAL")
node box/windows/release.mjs sign "${SIGN_ARGS[@]}"

TAG="threeoclock-$(date -u +%Y%m%d-%H%M)-$COMMIT"
NOTES="$(git log -1 --format=%s)"
if [[ -n "$PREVIOUS_TAG" ]] && git rev-parse -q --verify "refs/tags/$PREVIOUS_TAG" >/dev/null; then
  NOTES="$(git log --format='- %s' "$PREVIOUS_TAG..HEAD")"
fi
[[ -n "$MANUAL" ]] && NOTES="Not installed by the PCs by themselves: $MANUAL"$'\n\n'"$NOTES"
NOTES="Download **ThreeOClock-Setup.exe** below and double-click it."$'\n\n'"$NOTES"
gh release create "$TAG" "$OUT/ThreeOClock-Setup.exe" "$OUT/ThreeOClock.zip" "$OUT/manifest.json" -R "$RELEASE_REPO" \
  --title "ThreeOClock $COMMIT" --notes "$NOTES"
git tag "$TAG" HEAD && git push --quiet origin "refs/tags/$TAG"
echo "Published $TAG to $RELEASE_REPO."
echo "Download link: https://github.com/$RELEASE_REPO/releases/latest/download/ThreeOClock-Setup.exe"
