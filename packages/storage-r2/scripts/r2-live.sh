#!/usr/bin/env bash
# Runs the storage conformance suite against a real R2 binding. It deploys a
# temporary test Worker (live/worker.ts) bound to a scratch bucket, runs
# test/live.integration.test.ts against it, and always deletes the Worker.
#
# Usage: r2-live.sh test | delete
#
#   OBSY_R2_BUCKET  scratch bucket name (default: OBSY_S3_BUCKET from the
#                   environment or the ignored .env.local at the repository root)
#
# The bucket name, the Worker URL, and the bearer token stay out of the
# repository: the Wrangler config is written to a temporary directory and the
# token is random for each run. Needs `wrangler login` (or CLOUDFLARE_API_TOKEN).
# See docs/runbooks/storage-conformance.md#live-r2-binding-run.
set -euo pipefail

WORKER=obsy-r2-conformance
WRANGLER_VERSION=4.151.3
PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ROOT_DIR=$(cd "$PACKAGE_DIR/../.." && pwd)
ENV_LOCAL="$ROOT_DIR/.env.local"
# Global, so that the EXIT trap can still read it after run_tests returns.
WORK=""

wrangler() {
  npx --yes "wrangler@$WRANGLER_VERSION" "$@"
}

setting() {
  local value="${!1:-}"
  if [ -z "$value" ] && [ -f "$ENV_LOCAL" ]; then
    value=$(sed -n "s/^$1=//p" "$ENV_LOCAL" | tail -n 1)
  fi
  printf '%s' "$value"
}

delete_worker() {
  if wrangler delete --name "$WORKER" --force >/dev/null 2>&1; then
    echo "Deleted the test Worker $WORKER."
  else
    echo "Could not delete the test Worker $WORKER. Delete it in the Cloudflare dashboard." >&2
  fi
}

run_tests() {
  local bucket token url
  bucket=$(setting OBSY_R2_BUCKET)
  if [ -z "$bucket" ]; then bucket=$(setting OBSY_S3_BUCKET); fi
  if [ -z "$bucket" ]; then
    echo "Set OBSY_R2_BUCKET (or OBSY_S3_BUCKET in .env.local) to a scratch bucket." >&2
    exit 2
  fi
  WORK=$(mktemp -d "${TMPDIR:-/tmp}/obsy-r2-live.XXXXXX")
  trap 'delete_worker; rm -rf "$WORK"' EXIT

  cat >"$WORK/wrangler.json" <<JSON
{
  "name": "$WORKER",
  "main": "$PACKAGE_DIR/live/worker.ts",
  "compatibility_date": "2026-10-01",
  "workers_dev": true,
  "preview_urls": false,
  "observability": { "enabled": false },
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "$bucket" }]
}
JSON

  # Deploy with the token secret in the first version: a secret set after the
  # deploy rolls out gradually, and the old version refuses every request.
  token=$(openssl rand -hex 32)
  (umask 077 && printf 'OBSY_TOKEN=%s\n' "$token" >"$WORK/secrets.env")
  echo "Deploying the test Worker $WORKER..."
  # Right after a delete, the Cloudflare API can briefly report that the new
  # Worker does not exist (code 10007), so try a few times.
  local attempt
  for attempt in 1 2 3; do
    if wrangler deploy --config "$WORK/wrangler.json" --secrets-file "$WORK/secrets.env" >"$WORK/deploy.log" 2>&1; then break; fi
    if [ "$attempt" -eq 3 ]; then
      cat "$WORK/deploy.log" >&2
      exit 1
    fi
    echo "Deploy failed; trying again in 15 s..."
    sleep 15
  done
  url=$(grep -Eo 'https://[^ ]+\.workers\.dev' "$WORK/deploy.log" | head -n 1 || true)
  if [ -z "$url" ]; then
    echo "Deploy did not report a workers.dev URL:" >&2
    cat "$WORK/deploy.log" >&2
    exit 1
  fi

  # A new Worker can take some seconds to answer on every request; wait for
  # ten answers in a row.
  echo "Waiting for the Worker to answer..."
  local answered=0
  for _ in $(seq 1 120); do
    if curl -s --max-time 5 -X POST -H "authorization: Bearer $token" \
      -H 'content-type: application/json' -d '{"op":"ping"}' "$url" | grep -q '"ok":true'; then
      answered=$((answered + 1))
      if [ "$answered" -ge 10 ]; then break; fi
    else
      answered=0
    fi
    sleep 1
  done
  if [ "$answered" -lt 10 ]; then
    echo "The Worker did not answer within two minutes." >&2
    exit 1
  fi

  (cd "$PACKAGE_DIR" && OBSY_R2_WORKER_URL="$url" OBSY_R2_WORKER_TOKEN="$token" \
    pnpm exec vp test --config vite.integration.config.ts test/live.integration.test.ts)
}

case "${1:-}" in
  test) run_tests ;;
  delete) delete_worker ;;
  *) echo "Usage: $0 test | delete" >&2; exit 2 ;;
esac
