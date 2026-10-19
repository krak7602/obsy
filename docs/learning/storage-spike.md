---
title: Storage spike (phase 0)
aliases: [conditional-create race test, R2 race test, storage conformance results, local S3 servers, versitygw, MinIO, SeaweedFS]
updated: 2026-10-20
---

# Storage spike (phase 0)

## Current

Status: observed results from local runs on 2026-10-20. **The live run on Cloudflare R2 has not happened yet.** Nothing on this page shows how R2 or AWS S3 behave under a real race; it shows that the adapter, the suite, and the harness work, and how three local servers behave.

### Question

Phase 0 on the [roadmap](../roadmap.md) asks for a conditional-create race test on R2. The [bucket-as-sequencer decision](../decisions/2026-10-19-bucket-as-sequencer.md) depends on two claims: of concurrent `If-None-Match: *` creators of one key, at most one succeeds; and a writer that lists the log and claims the next number never creates a gap or a duplicate. The spike builds the storage layer that the test needs, proves it locally, and leaves a ready live run for the owner's scratch bucket.

### Method

- **Code.** `@obsy/protocol` (interface, errors, key rules), `@obsy/storage-s3` (S3 adapter on `aws4fetch`), and `@obsy/storage-testkit` (in-memory storage, conformance suite, race harness, fake S3). The contract is on [Storage adapters](../subsystems/storage.md). The commands are in the [conformance runbook](../runbooks/storage-conformance.md).
- **Conditional-create race.** In each round, N writers call `putIfAbsent` on one fresh key at the same time. Pass: exactly one winner per round, and the stored body is the winner's.
- **Commit-log race.** K writers run the [commit algorithm](../subsystems/protocol.md#commit-algorithm) without merges: list `log/` after the cursor (following `truncated`), read every new entry, claim `log/<cursor+1>.json` (16 digits) with `putIfAbsent`, and catch up again on `PreconditionFailed`. The writers do not back off after a conflict. Pass: the final log has entries 1 to K × C with no gap, every `opId` appears once, and every writer's every commit is present.
- **Harness check.** A deliberately non-atomic storage (check, yield, then write) makes both races report violations. A storage that injects 429s and lost responses (write applied, then a transient error with `mayHaveApplied`) still passes. Both are unit tests.
- **Environment.** macOS on Apple silicon, Docker Engine 28.3.0 (linux/arm64 containers), Node 24.21.0. Client and server on one host over loopback. All writers run in one Node process and send requests concurrently.
- **Servers.** Selected because their official or maintained images were available on 2026-10-20 and a signed `curl` probe showed conditional writes:

  | Server | Image | Digest |
  | --- | --- | --- |
  | versitygw 1.9.0, posix backend | `versity/versitygw:v1.9.0` | `sha256:eb7f786fcd91e72194e48fcf1ac16302d686bf8e3a71434bdbc067a6efd3fdc7` |
  | MinIO `RELEASE.2026-09-22T19-25-18Z` (Chainguard build) | `cgr.dev/chainguard/minio:latest` | `sha256:2915cb406f38ed6ff9634de0a3e4a9423e2dda06a6f1aca18f8c968aa37a01f6` |
  | SeaweedFS 4.48 | `chrislusf/seaweedfs:4.48` | `sha256:4e61d15fd35994cb1e43e1e553dff106794841fd9a99ade2fc8c8bfce4d7872d` |

  `minio/minio:latest` was not available from Docker Hub (the manifest lookup failed). Garage, RustFS, and LocalStack images were available but not tested.

### Results

`pnpm test`: 157 tests pass, among them the full suite against `MemoryStorage` (also with random interleaving and 3-key pages: 16 writers × 50 rounds, 8 writers × 20 commits) and against `S3Storage` through the fake S3 endpoint in three configurations.

`pnpm run test:s3-local`, 22 tests per server:

| Server | Conformance | Conditional create | Commit log |
| --- | --- | --- | --- |
| versitygw | 22/22 pass | 50/50 and 200/200 rounds with one winner | no violations |
| MinIO | 22/22 pass | 50/50 and 200/200 rounds with one winner | no violations |
| SeaweedFS | 19/22 pass | 5/5 rounds (the 50-round run hit the 300 s test timeout) | no violations |

Larger run (`OBSY_RACE_CREATE_WRITERS=32`, `OBSY_RACE_CREATE_ROUNDS=200`, `OBSY_RACE_LOG_WRITERS=16`, `OBSY_RACE_COMMITS_PER_WRITER=25`, `OBSY_RACE_LIST_LIMIT=10`):

| Measure | versitygw | MinIO |
| --- | --- | --- |
| Create race: winners | 200/200 rounds; 200 successes, 6,200 `PreconditionFailed` | 200/200 rounds; 200 successes, 6,200 `PreconditionFailed` |
| Create race: `putIfAbsent` latency p50 / p90 / p99 / max | 5.2 / 7.8 / 11 / 18.3 ms | 48 / 93.7 / 133.8 / 179.8 ms |
| Create race: duration | 1.7 s | 25.5 s |
| Log race: entries | 400 of 400, no gaps, no duplicates | 400 of 400, no gaps, no duplicates |
| Log race: claim attempts / conflicts | 2,131 / 1,731 | 1,253 / 853 |
| Log race: most claims for one commit | 216 | 108 |
| Log race: claim latency p50 / p99 | 2.8 / 7.6 ms | 1.5 / 49.1 ms |
| Log race: list latency p50 / p99 | 2.9 / 7.4 ms | 1.2 / 6.5 ms |
| Cleanup | 676 keys deleted | 676 keys deleted |

Default local run (16 × 50 create, 8 × 25 log): versitygw 800 requests, p99 6.4 ms, 590 claims for 200 commits, at most 100 claims for one commit; MinIO p99 108.7 ms, 430 claims, at most 47. SeaweedFS (16 × 5 create, 8 × 25 log): `putIfAbsent` p50 6.6 ms but p90 4,022 ms and max 12,028 ms; claim p99 1,003.5 ms.

No server returned a 409, 429, or 5xx in any recorded run. Every race failure was a 412.

### Provider findings

From documentation (read on 2026-10-20):

- **AWS S3.** `If-None-Match: *` on an existing key returns 412; "the first write operation to finish succeeds". A 409 can occur "if a delete request to an object succeeds before a conditional write operation on that object completes", and PutObject "may be retried after receiving a `409 Conflict`". The PutObject reference names it `409 ConditionalRequestConflict`: "On a 409 failure, retry the upload"; for `If-Match`, "fetch the object's ETag and retry". `If-Match` on a missing key returns 404 ([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html); [PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html)). Decision: 409 is a transient error that did not apply; 404 on `putIfMatch` is `PreconditionFailed`.
- **Cloudflare R2.** `PreconditionFailed` is 412, with the advice "Refetch and retry". `TooManyRequests` is 429, "often caused by multiple concurrent requests to the same object key (limit: 1 write/second per key)". `InternalError` 500: "Retry the request". `ServiceUnavailable` 503: "Retry with exponential backoff" ([R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)). ListObjectsV2 supports `encoding-type`, `start-after`, `continuation-token`, and `max-keys`; the S3 region is `auto` ([R2 S3 API](https://developers.cloudflare.com/r2/api/s3/api/)). Expectation for the live run: a race on one key can produce 429s as well as 412s. The harness counts them by code and retries them.
- **MinIO distribution.** Secondary sources report that MinIO stopped publishing community images in October 2025, put the repository in maintenance mode in December 2025, and archived it in February 2026 (for example [this summary](https://blog.vonng.com/en/db/minio-resurrect/index.md)). Not checked against a MinIO announcement. Observed: `minio/minio:latest` was not available.

Observed locally:

- **Sequential conditional writes** (signed `curl` probe): all three servers returned 412 for `If-None-Match: *` on an existing key and for a wrong `If-Match` etag. For `If-Match` on a missing key, versitygw and MinIO returned 404 `NoSuchKey`, like AWS; SeaweedFS returned 412. The adapter maps both to `PreconditionFailed`.
- **versitygw posix backend** rejected a key ending in `/` with 400 `DirectoryObjectContainsData`. It maps keys to files and directories. This led to the stricter key rule: no empty path segments. Not tested: whether a key `x` and a key `x/y` can both exist on it.
- **SeaweedFS 4.48** is not suitable as a harness target:
  - lists were not in byte order: `log/0000000000000001.json` came before `log.json`, but UTF-8 byte order puts `.` (0x2E) before `/` (0x2F). This looks like directory-tree order;
  - a key with `\` was readable by its own name, but the list returned it with `/` in place of `\`;
  - conditional writes under contention took 1 s, 3 s, 4 s, and up to 12 s, which looks like server-side lock waits; the concurrent `putIfMatch` test did not finish within 30 s.
- **Encoding.** versitygw and MinIO passed the unusual-keys test with `encoding-type=url`, including spaces, `+`, `%`, `&`, quotes, emoji, and NFC and NFD twins.

### Lessons

- **The harness has teeth.** It catches a non-atomic create, and it tolerates rate limits and lost responses. That makes a passing live run meaningful.
- **Conflict storms are real.** With 16 writers and no backoff after a conflict, one commit needed up to 216 claims. With few devices this matters less, but `@obsy/core` should add jittered backoff after `PreconditionFailed` on a log claim. On R2 the 1-write-per-second-per-key limit may turn some of these conflicts into 429s.
- **Lost responses are safe by construction (reasoning, not a live test).** A writer that times out on `log/<n>` cannot later produce a duplicate commit. To claim a higher number it must first see `log/<n>`. If its own delayed write created `log/<n>`, catch-up finds its `opId`; otherwise its delayed write fails with 412.
- **Do not trust "S3-compatible".** Two of three local servers passed; the third broke list order and changed key bytes. Keep the provider list closed until a provider passes the suite.

### Limits

- Loopback on one host: no WAN latency, no multi-region effects, no rate limits.
- All writers ran in one Node process. Real devices are separate clients with independent clocks and networks.
- The fake S3 endpoint checks SigV4 header shape and the payload hash, but not signatures. The local servers verify real signatures.
- The MinIO image is `latest`; the digest above identifies the build that ran.
- The suite does not test `limit` above 1,000 against a server, or bodies larger than 1 MiB.

### What still needs the live run

1. Run `pnpm run test:s3-live` against a scratch R2 bucket with the defaults, then with more writers (for example `OBSY_RACE_CREATE_WRITERS=32 OBSY_RACE_LOG_WRITERS=8`).
2. Record the outcomes by code (412 against 429 against 5xx), the latency percentiles, and whether the unusual-keys test passes with R2's `encoding-type=url` handling.
3. Optionally repeat on AWS S3, and look for `409 ConditionalRequestConflict`.
4. Add the results here, update the provider table on [Storage adapters](../subsystems/storage.md#conformance-suite), and settle the roadmap question.

## History

- 2026-10-20: Spike run locally: in-memory, fake S3, versitygw, MinIO, and SeaweedFS. Live R2 run pending.
