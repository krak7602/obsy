#!/usr/bin/env bash
# Runs the desktop plugin test: builds the plugin, starts the local S3
# server in Docker, and runs the scenario in Obsidian desktop with its own
# profile folder and two scratch vaults. See docs/runbooks/desktop-plugin-test.md.
#
#   OBSY_E2E_SOURCE       a folder to copy as the vault (default: a generated vault).
#                         Use a copy of a vault, never a vault in use.
#   OBSY_E2E_OBSIDIAN     the Obsidian binary (default: the macOS app)
#   OBSY_E2E_REPORT_FILE  also write the summary here
#   OBSY_E2E_KEEP         keep the temporary folder for inspection
set -euo pipefail

PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
S3_SCRIPT="$PACKAGE_DIR/../storage-s3/scripts/s3-local.sh"

if pgrep -f -- '--remote-debugging-port=19223' >/dev/null; then
  echo "An Obsidian test instance is already running on port 19223. Stop it first." >&2
  exit 1
fi

(cd "$PACKAGE_DIR" && pnpm run build)
bash "$S3_SCRIPT" start
trap 'bash "$S3_SCRIPT" stop' EXIT
(cd "$PACKAGE_DIR" && pnpm exec vp test --config vite.e2e.config.ts)
