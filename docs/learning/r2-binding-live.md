---
title: R2 binding live run
aliases: [R2 Workers binding, storage-r2 live run, test:r2-live, 10058, TooManyRequests, test Worker]
updated: 2026-10-20
---

# R2 binding live run

## Current

Status: observed results, 2026-10-20. `@obsy/storage-r2` passed the storage conformance suite against a real R2 bucket through a Workers binding. How to run it is in the [conformance runbook](../runbooks/storage-conformance.md#live-r2-binding-run); the adapter is on [Storage adapters](../subsystems/storage.md#obsystorage-r2).

### Question

Phase 1 on the [roadmap](../roadmap.md) needs R2 to pass conformance. The S3 API path passed in phase 0 ([storage spike](storage-spike.md#cloudflare-r2)). Does the Workers binding adapter also pass, in particular `onlyIf: { etagDoesNotMatch: '*' }` as an atomic create and `etagMatches` on a missing key as a failed condition? Miniflare showed both locally; the binding documentation does not describe them.

### Method

- `pnpm run test:r2-live` deploys a temporary test Worker bound to the scratch bucket, runs the suite from Node, and deletes the Worker.
- `R2Storage` runs in the Worker. Each `Storage` call is one HTTPS request from Node to the Worker, so concurrent calls run in separate Worker invocations. The client only carries calls and rebuilds the adapter's errors.
- Machine: Apple M4 Pro, Node 24.21.0, home internet connection; the bucket is in the APAC location. Wrangler 4.151.3, compatibility date 2026-10-01.
- Latency includes the hop from Node to the Worker.

### Results

Five passing runs, 22/22 tests each. Every run deleted all its keys.

| Measure | Defaults (1 run) | Heavy (4 runs) |
| --- | --- | --- |
| Parameters (create writers × rounds; log writers × commits; list limit) | 8 × 20; 4 × 10; 5 | 16 × 50; 8 × 10; 5 |
| Create race: rounds with one winner | 20/20 | 50/50 in each run |
| Create race: `10058` errors | 2 | 0, 15, 0, 8 |
| Create race: `putIfAbsent` p50 / p99 / max | 334 / 530 / 532 ms | 277–285 / 539–813 / 1,145–1,962 ms |
| Log race: entries | 40, no gaps, no duplicates | 80 in each run, no gaps, no duplicates |
| Log race: claim attempts / most claims for one commit | 104 / 26 | 357–438 / 59–68 |
| Log race: `10058` errors on list | 0 | 0, 3, 0, 1 |
| Log race: claim p50 / p99 | 241 / 431 ms | 165–201 / 460–525 ms |
| Log race: list p50 / p99 | 103 / 200 ms | 99–103 / 233–316 ms |

Observations:

- `etagDoesNotMatch: '*'` is an atomic create on real R2, and `etagMatches` on a missing key fails the condition (the `match-missing` test).
- Under contention the binding throws **10058 TooManyRequests**, the code that R2 documents for "multiple concurrent requests to the same object key (limit: 1 write/second per key)" ([R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/)). Through the S3 API, the same contention gave 503 `ServiceUnavailable`.
- A list of the log prefix also threw 10058 four times, while writers were creating keys under it.
- No 10001 (internal error) or 10043 (service unavailable) was seen.

Two earlier runs failed because of the harness, not R2: requests got 404 from the test Worker itself. The first script version set the token secret after the deploy. That change rolls out gradually, and the first version refused every request for some seconds. One run had 8 such failures; another had 1, whose log was not kept. The script now deploys with the secret in the first version and waits for ten answers in a row. All runs after that change passed.

### Lessons

- **Keep R2's error code.** The binding reports only an exception message. `R2Storage` now copies the five-digit code at its end into `code`, so the summary showed 10058 rather than an unnamed transient error. Retry and backoff can treat 10058 as a rate-limit signal.
- **One request per call fits Worker limits.** Running the whole suite inside one Worker invocation would put hundreds of binding calls and minutes of wall time in one request.
- **Deploy secrets with the version.** A secret added after a deploy is a second rollout.

### Limits

- One client host, one network, one bucket location, five passing runs on one day.
- The Node-to-Worker hop adds latency and its own failure modes; the client labels them `worker-`, and none occurred in the passing runs.
- The relay, the only planned user of the binding, does not exist yet.

### Still open

- Whether a write that throws 10058 can have applied. The adapter treats it as `mayHaveApplied`; every round still had one winner.

## History

- 2026-10-20: Created. Five passing live runs after a fix to the run script.
