#!/usr/bin/env bash
# Runs a local S3-compatible server in Docker for the storage conformance
# suite. This is a local test harness target, not a supported provider.
#
# Usage: s3-local.sh start | stop | status | test
#
#   OBSY_S3_LOCAL_SERVER  versitygw (default), minio, or seaweedfs
#   OBSY_S3_LOCAL_PORT    host port on 127.0.0.1 (default 19000)
#
# The script manages only the container named obsy-s3-test. Credentials are
# random for each start and are kept in packages/storage-s3/.env.s3-local,
# which git ignores. See docs/runbooks/storage-conformance.md.
set -euo pipefail

CONTAINER=obsy-s3-test
SERVER=${OBSY_S3_LOCAL_SERVER:-versitygw}
PORT=${OBSY_S3_LOCAL_PORT:-19000}
BUCKET=obsy-conformance
PACKAGE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$PACKAGE_DIR/.env.s3-local"
ENDPOINT="http://127.0.0.1:$PORT"

image_for() {
  case "$1" in
    versitygw) echo "versity/versitygw:v1.9.0" ;;
    # MinIO stopped publishing community images in 2025. Chainguard builds
    # it from source; its free tier offers only the latest tag.
    minio) echo "cgr.dev/chainguard/minio:latest" ;;
    seaweedfs) echo "chrislusf/seaweedfs:4.48" ;;
    *) echo "Unknown OBSY_S3_LOCAL_SERVER: $1 (use versitygw, minio, or seaweedfs)" >&2; exit 2 ;;
  esac
}

container_exists() {
  [ -n "$(docker ps -aq --filter "name=^${CONTAINER}$")" ]
}

stop() {
  if container_exists; then
    docker rm -f "$CONTAINER" >/dev/null
    echo "Stopped and removed $CONTAINER."
  else
    echo "$CONTAINER is not running."
  fi
  if [ -f "$ENV_FILE" ]; then
    local config_dir
    config_dir=$(sed -n 's/^OBSY_S3_LOCAL_CONFIG_DIR=//p' "$ENV_FILE")
    if [ -n "$config_dir" ]; then rm -rf "$config_dir"; fi
    rm -f "$ENV_FILE"
  fi
}

start() {
  if container_exists; then
    echo "$CONTAINER already exists. Run '$0 stop' first." >&2
    exit 1
  fi
  local image access secret config_dir=""
  image=$(image_for "$SERVER")
  access="obsy$(openssl rand -hex 6)"
  secret=$(openssl rand -hex 20)

  case "$SERVER" in
    versitygw)
      docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:7070" \
        -e ROOT_ACCESS_KEY="$access" -e ROOT_SECRET_KEY="$secret" \
        --entrypoint sh "$image" -c 'mkdir -p /tmp/vgw && exec versitygw posix /tmp/vgw' >/dev/null
      ;;
    minio)
      docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:9000" \
        -e MINIO_ROOT_USER="$access" -e MINIO_ROOT_PASSWORD="$secret" \
        "$image" server /data >/dev/null
      ;;
    seaweedfs)
      config_dir=$(mktemp -d "${TMPDIR:-/tmp}/obsy-s3-test.XXXXXX")
      printf '{"identities":[{"name":"obsy","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}\n' \
        "$access" "$secret" >"$config_dir/s3.json"
      docker run -d --name "$CONTAINER" -p "127.0.0.1:$PORT:8333" \
        -v "$config_dir/s3.json:/etc/obsy-s3.json:ro" \
        "$image" server -s3 -s3.config=/etc/obsy-s3.json >/dev/null
      ;;
  esac

  # Write the settings first, so that stop() can clean up after a failed start.
  (
    umask 077
    cat >"$ENV_FILE" <<EOF
OBSY_S3_LOCAL_CONFIG_DIR=$config_dir
OBSY_S3_LOCAL_SERVER=$SERVER
OBSY_S3_LOCAL_IMAGE=$image
OBSY_S3_LOCAL_ENDPOINT=$ENDPOINT
OBSY_S3_LOCAL_BUCKET=$BUCKET
OBSY_S3_LOCAL_ACCESS_KEY_ID=$access
OBSY_S3_LOCAL_SECRET_ACCESS_KEY=$secret
EOF
  )

  echo "Started $CONTAINER ($image) on $ENDPOINT. Waiting for it to accept requests..."
  local ready=0
  for _ in $(seq 1 60); do
    if curl -s -o /dev/null --max-time 2 "$ENDPOINT/"; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" -ne 1 ]; then
    echo "The server did not start. Last log lines:" >&2
    docker logs --tail 20 "$CONTAINER" >&2 || true
    stop
    exit 1
  fi

  # Create the bucket. Some servers need a few more seconds after the port opens.
  local status=000
  for _ in $(seq 1 30); do
    status=$(curl -s -o /dev/null -w '%{http_code}' --aws-sigv4 "aws:amz:us-east-1:s3" \
      --user "$access:$secret" -X PUT "$ENDPOINT/$BUCKET" || true)
    if [ "$status" = 200 ] || [ "$status" = 409 ]; then break; fi
    sleep 1
  done
  if [ "$status" != 200 ] && [ "$status" != 409 ]; then
    echo "Could not create bucket $BUCKET (HTTP $status)." >&2
    stop
    exit 1
  fi

  echo "Ready. Bucket $BUCKET exists. Settings are in $ENV_FILE."
}

run_tests() {
  start
  trap stop EXIT
  (cd "$PACKAGE_DIR" && pnpm exec vp test --config vite.integration.config.ts test/local.integration.test.ts)
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) docker ps -a --filter "name=^${CONTAINER}$" ;;
  test) run_tests ;;
  *) echo "Usage: $0 start | stop | status | test" >&2; exit 2 ;;
esac
