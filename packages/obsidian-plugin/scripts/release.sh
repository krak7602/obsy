#!/usr/bin/env bash
# Prepares a plugin release: checks the version, builds, and collects the
# release files in packages/obsidian-plugin/dist/release/. Publishing is a
# separate, explicit step. See docs/runbooks/plugin-release.md.
#
#   release.sh <version>             prepare only
#   release.sh <version> --publish   also create the GitHub release (pre-release, for BRAT)
set -euo pipefail

VERSION=${1:?Usage: release.sh <version> [--publish]}
PUBLISH=${2:-}
PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT=$(cd "$PACKAGE_DIR/../.." && pwd)
OUT="$PACKAGE_DIR/dist/release"

manifest_version=$(node -p "require('$ROOT/manifest.json').version")
min_app=$(node -p "require('$ROOT/manifest.json').minAppVersion")
mapped=$(node -p "require('$ROOT/versions.json')['$VERSION'] ?? ''")
if [ "$manifest_version" != "$VERSION" ]; then
  echo "manifest.json has version $manifest_version, not $VERSION." >&2; exit 1
fi
if [ "$mapped" != "$min_app" ]; then
  echo "versions.json must map $VERSION to $min_app (minAppVersion)." >&2; exit 1
fi
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "The working tree has changes. Commit them first." >&2; exit 1
fi

(cd "$ROOT" && pnpm run check && pnpm test && pnpm run build)
rm -rf "$OUT"
mkdir -p "$OUT"
cp "$PACKAGE_DIR/dist/main.js" "$PACKAGE_DIR/dist/styles.css" "$ROOT/manifest.json" "$OUT/"
(cd "$OUT" && shasum -a 256 main.js manifest.json styles.css)
echo "Release files for $VERSION are in $OUT."

if [ "$PUBLISH" != "--publish" ]; then
  echo "Not published. To publish: $0 $VERSION --publish"
  exit 0
fi
# Resolve the repository before tagging, so that a failure leaves no tag behind.
REPO=$(cd "$ROOT" && gh repo view --json nameWithOwner --jq .nameWithOwner)
NOTES="Beta for BRAT: install with BRAT -> Add beta plugin -> $REPO.

obsy is early software. Try it on a copy of a vault, with a bucket that holds nothing else, and never on a vault that another sync service also syncs. See README.md and docs/runbooks/plugin-release.md."
git -C "$ROOT" tag "$VERSION"
git -C "$ROOT" push origin "$VERSION"
gh release create "$VERSION" --repo "$REPO" --prerelease \
  --title "$VERSION" --notes "$NOTES" \
  "$OUT/main.js" "$OUT/manifest.json" "$OUT/styles.css"
