#!/usr/bin/env bash
# Builds CafePOS.zip for a Windows cafe PC. P62, docs/WINDOWS-INSTALL.md.
#
#   bash box/windows/make-package.sh                        the zip, to hand over
#   bash box/windows/make-package.sh --publish              and a signed GitHub release,
#                                                           which cafe PCs install at night
#   bash box/windows/make-package.sh --publish --manual "why"   a release the PCs must
#                                                           not install by themselves
#
# Run on a developer machine. Takes the committed code (git archive: never .env,
# never box-data, never anything uncommitted), adds the built screens, and puts
# "Install Cafe POS.bat" at the top so the person at the cafe sees it first.
# The result is release/CafePOS.zip. No secrets are inside it: the installer
# makes the cafe's own on the cafe PC.
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
STAGE="$OUT/CafePOS"
cd "$ROOT"

if [[ -n "$(git status --porcelain -- server client box setup package.json package-lock.json)" ]]; then
  echo "Commit your changes first: the package is made from the last commit."; git status --short; exit 1
fi

echo "Building the screens..."
(cd client && npx vite build >/dev/null)

rm -rf "$STAGE" "$OUT/CafePOS.zip"
mkdir -p "$STAGE"
git archive --format=tar HEAD | tar -x -C "$STAGE"
rm -rf "$STAGE/e2e" "$STAGE/docs/archive" "$STAGE/setup/archive" "$STAGE/.github"
mkdir -p "$STAGE/client/dist"
cp -R client/dist/. "$STAGE/client/dist/"
cp "box/windows/Install Cafe POS.bat" "$STAGE/Install Cafe POS.bat"
cp "box/windows/Load cafe data.bat" "$STAGE/Load cafe data.bat"
cat > "$STAGE/READ ME FIRST.txt" <<'TXT'
CAFE POS - SETUP ON THIS PC (once)

1. This folder should be C:\CafePOS  (move it there if it is somewhere else).
2. The PC must be on the internet for the first setup only.
3. Double-click "Install Cafe POS" and click Yes when Windows asks.
4. Answer the questions: cafe name, owner name, owner mobile, owner password.
5. When it says "All done", use the "Cafe POS" icon on the desktop.

Tablets and phones: join the same WiFi as this PC, then open the address the
installer showed, or open "Cafe POS - Connect a device" and scan the QR codes.

Full guide: docs\WINDOWS-INSTALL.md and docs\STAFF-SETUP.md
TXT
COMMIT="$(git rev-parse --short HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s\n' "$COMMIT" > "$STAGE/VERSION.txt"
printf '{ "commit": "%s", "builtAt": "%s" }\n' "$COMMIT" "$BUILT_AT" > "$STAGE/VERSION.json"
(cd "$OUT" && zip -qr CafePOS.zip CafePOS)
rm -rf "$STAGE"
echo "Made $OUT/CafePOS.zip ($(du -h "$OUT/CafePOS.zip" | cut -f1)), version $(git rev-parse --short HEAD)."

[[ "$PUBLISH" == 1 ]] || exit 0

# ---------------------------------------------------------------------------
# Publish: a GitHub release the cafe PCs' updater finds (box/windows/update.mjs).
REPO="${CAFEPOS_RELEASE_REPO:-$(git remote get-url origin | sed -E 's#(git@github.com:|https://github.com/)##; s#\.git$##')}"
git fetch --quiet origin main
if ! git merge-base --is-ancestor HEAD origin/main; then
  echo "Push this commit to origin main first: a release must point at code GitHub has."; exit 1
fi
if [[ ! -f box/windows/release-public-key.pem ]]; then
  echo "No release key yet. Run: node box/windows/release.mjs keygen, and commit box/windows/release-public-key.pem."; exit 1
fi

# A changed installer means new scheduled tasks or settings the updater cannot make.
PREVIOUS_TAG="$(gh release list -R "$REPO" -L 1 --json tagName -q '.[0].tagName' 2>/dev/null || true)"
if [[ -z "$MANUAL" && -n "$PREVIOUS_TAG" ]]; then
  git fetch --quiet origin "refs/tags/$PREVIOUS_TAG:refs/tags/$PREVIOUS_TAG" 2>/dev/null || true
  if ! git diff --quiet "$PREVIOUS_TAG" HEAD -- box/windows/install.ps1 2>/dev/null; then
    MANUAL="The installer changed since $PREVIOUS_TAG: copy the new CafePOS.zip over C:\\CafePOS and run Install Cafe POS by hand."
    echo "Note: $MANUAL"
  fi
fi

SIGN_ARGS=("$OUT/CafePOS.zip" "$OUT/manifest.json" --commit "$COMMIT" --built-at "$BUILT_AT")
[[ -n "$MANUAL" ]] && SIGN_ARGS+=(--manual "$MANUAL")
node box/windows/release.mjs sign "${SIGN_ARGS[@]}"

TAG="cafepos-$(date -u +%Y%m%d-%H%M)-$COMMIT"
NOTES="$(git log -1 --format=%s)"
[[ -n "$PREVIOUS_TAG" ]] && NOTES="$(git log --format='- %s' "$PREVIOUS_TAG..HEAD" 2>/dev/null || echo "$NOTES")"
[[ -n "$MANUAL" ]] && NOTES="Not installed by the cafe PCs by themselves: $MANUAL"$'\n\n'"$NOTES"
gh release create "$TAG" "$OUT/CafePOS.zip" "$OUT/manifest.json" -R "$REPO" \
  --target "$(git rev-parse HEAD)" --title "Cafe POS $COMMIT" --notes "$NOTES"
echo "Published $TAG to $REPO. Cafe PCs with UPDATE_AUTO=on install it in their next update window."
