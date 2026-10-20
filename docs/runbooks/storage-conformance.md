---
title: Storage conformance runs
aliases: [conformance suite, race test, test:s3-local, test:s3-live, R2 race test, scratch bucket, local S3 server, versitygw, MinIO]
updated: 2026-10-20
---

# Storage conformance runs

## Current

This page owns how to run the storage conformance suite and the race harness. What the suite tests is on [Storage adapters](../subsystems/storage.md#conformance-suite). Recorded results are in [Storage spike](../learning/storage-spike.md).

### Targets

Run the commands from the repository root.

| Command | Target | Needs | In `pnpm test` |
| --- | --- | --- | --- |
| `pnpm test` | `MemoryStorage`, and `S3Storage` through the fake S3 endpoint | Nothing | Yes |
| Obsy probe, **Storage over requestUrl** | `S3Storage` over `requestUrl`, inside Obsidian, against a scratch bucket | Obsidian, a scratch vault, and a scratch bucket ([platform probe](platform-probe.md)) | No |
| `pnpm run test:s3-local` | `S3Storage` against a local S3-compatible server in Docker | Docker, `curl`, `openssl` | No |
| `pnpm run test:s3-live` | `S3Storage` against a real R2 or AWS S3 bucket | A scratch bucket and a token scoped to it | No |

The local servers are **harness targets, not supported providers**. They exercise the adapter against real HTTP, real SigV4 verification, and real concurrency. They do not show that R2 or AWS S3 behave the same way.

### Race parameters

Both integration runs read these variables. Unset variables use the defaults.

| Variable | Meaning | Live default | Local default |
| --- | --- | --- | --- |
| `OBSY_RACE_CREATE_WRITERS` | Concurrent writers per conditional-create round | 8 | 16 |
| `OBSY_RACE_CREATE_ROUNDS` | Conditional-create rounds | 20 | 50 |
| `OBSY_RACE_LOG_WRITERS` | Concurrent writers in the commit-log race | 4 | 8 |
| `OBSY_RACE_COMMITS_PER_WRITER` | Commits each log writer makes | 10 | 25 |
| `OBSY_RACE_LIST_LIMIT` | `limit` for catch-up lists, to exercise pagination | 5 | 10 |
| `OBSY_S3_REPORT_FILE` | Also write the Markdown summary to this file | unset | unset |

Each run prints a Markdown summary: rounds, winners, request outcomes by error kind and code, and latency percentiles (p50, p90, p99, max). Paste it into a learning page. The summary never contains the endpoint, the bucket, the prefix, or credentials.

### Local Docker run

1. Start Docker.
2. Run `pnpm run test:s3-local`.

The script `packages/storage-s3/scripts/s3-local.sh`:

1. Starts one container named `obsy-s3-test` on `127.0.0.1:19000`, with random credentials. It never touches other containers.
2. Creates the bucket `obsy-conformance` with a signed `curl` request.
3. Writes the settings to `packages/storage-s3/.env.s3-local` (ignored by git, mode 600).
4. Runs `packages/storage-s3/test/local.integration.test.ts`.
5. Always stops and removes the container and deletes the settings file, also when the tests fail.

Select the server with `OBSY_S3_LOCAL_SERVER`, and the port with `OBSY_S3_LOCAL_PORT`:

| `OBSY_S3_LOCAL_SERVER` | Image | Notes |
| --- | --- | --- |
| `versitygw` (default) | `versity/versitygw:v1.9.0` | Apache-2.0. Posix backend in the container's `/tmp`. |
| `minio` | `cgr.dev/chainguard/minio:latest` | MinIO stopped publishing community images in 2025; Chainguard builds it from source and offers only `latest` for free. |
| `seaweedfs` | `chrislusf/seaweedfs:4.48` | Fails parts of the suite; see the spike. |

For manual work, use the subcommands:

```sh
bash packages/storage-s3/scripts/s3-local.sh start
pnpm --filter @obsy/storage-s3 exec vp test --config vite.integration.config.ts test/local.integration.test.ts
bash packages/storage-s3/scripts/s3-local.sh stop
bash packages/storage-s3/scripts/s3-local.sh status
```

### Live R2 or AWS S3 run

Use a scratch bucket that holds nothing else. Never use a bucket that holds a vault.

#### Make a scratch R2 bucket and a scoped token

In the Cloudflare dashboard:

1. Open **R2 Object Storage** and create a bucket with a name that marks it as scratch. Keep the default location and the Standard storage class.
2. Open **Manage API tokens** (R2 API tokens) and create an API token.
3. Set the permission to **Object Read & Write**.
4. Scope the token to **specific buckets only**, and select only the scratch bucket.
5. Set a short TTL, for example one day.
6. Create the token. Copy the **Access Key ID** and the **Secret Access Key**. The dashboard shows the secret only once.
7. Copy the S3 API endpoint, `https://<account-id>.r2.cloudflarestorage.com`.

Step 1 also works from the command line: `npx wrangler r2 bucket create <scratch-bucket>`. Create the token (steps 2 to 7) in the dashboard.

For AWS S3, create a scratch bucket and an IAM user or role whose policy allows only `s3:GetObject`, `s3:PutObject`, and `s3:DeleteObject` on `arn:aws:s3:::<bucket>/*` and `s3:ListBucket` on `arn:aws:s3:::<bucket>`. Use temporary credentials if you can.

#### Configure

Create `.env.local` in the repository root. Git ignores it (`.env.*`). Do not commit it, paste it, or put it in a screenshot.

```sh
OBSY_S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
OBSY_S3_REGION=auto
OBSY_S3_BUCKET=<scratch-bucket>
OBSY_S3_ACCESS_KEY_ID=<access-key-id>
OBSY_S3_SECRET_ACCESS_KEY=<secret-access-key>
# Optional
OBSY_S3_PREFIX=
OBSY_S3_ADDRESSING=path
OBSY_S3_SESSION_TOKEN=
OBSY_S3_TIMEOUT_MS=30000
```

For AWS S3, use `OBSY_S3_ENDPOINT=https://s3.<region>.amazonaws.com` and `OBSY_S3_REGION=<region>`. Variables already set in the shell take precedence over the file.

#### Run

```sh
pnpm run test:s3-live
```

Without the four required variables, the run reports one skipped test and touches nothing. To keep a copy of the summary, add `OBSY_S3_REPORT_FILE=/tmp/obsy-live-report.md` in front of the command.

With the defaults, one run sent about 630 requests to the fake endpoint (361 PUT, 154 GET, 112 LIST, 5 DELETE), plus the cleanup deletes. A live run sends more if the provider rate-limits and the harness retries. This is well inside the R2 free tier.

#### Cleanup

- Each run writes only under `<OBSY_S3_PREFIX>obsy-conformance/<run id>/`. The run id is the start time plus 8 random hex characters.
- After the tests, the run lists that sub-prefix and deletes each key in it. It never deletes anything outside it. The summary reports the number of deleted keys.
- If a run is interrupted, keys can remain under `obsy-conformance/`. Delete that prefix in the dashboard, or delete the scratch bucket.
- When you are done, revoke the token and delete `.env.local`.

## History

- 2026-10-20: Created with the phase 0 storage spike.
