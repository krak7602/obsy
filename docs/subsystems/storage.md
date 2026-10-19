---
title: Storage adapters
aliases: [Storage interface, storage-s3, storage-r2, storage-testkit, conformance suite, providers, S3, R2, PreconditionFailed, TransientStorageError, race harness]
updated: 2026-10-20
---

# Storage adapters

## Current

Status:

- **Existing behavior** (phase 0 storage spike): the `Storage` interface, its errors, and the key rules in `@obsy/protocol`; the S3 adapter `@obsy/storage-s3`; and `@obsy/storage-testkit` with an in-memory `Storage`, the conformance suite, the race harness, and a fake S3 endpoint.
- **Verified locally only.** The suite passes against the in-memory storage, the fake S3 endpoint, and two local S3-compatible servers in Docker. It has not run against Cloudflare R2 or AWS S3 yet. The results are in [Storage spike](../learning/storage-spike.md).
- **Accepted design, not implemented:** `@obsy/storage-r2` (the Workers binding).

### Interface

Existing behavior. Every layer above storage talks only to this interface (`@obsy/protocol`):

```ts
interface Storage {
  /** Returns null when the key does not exist. */
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  /** Fails with PreconditionFailed when the key already exists. */
  putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<{ etag: string }>;
  /** Fails with PreconditionFailed when the key is missing or its etag differs. */
  putIfMatch(key: string, body: Uint8Array, etag: string, contentType: string): Promise<{ etag: string }>;
  /** At most `limit` keys (default and maximum 1,000) in code point order. */
  list(prefix: string, startAfter?: string, limit?: number): Promise<{ keys: string[]; truncated: boolean }>;
  /** Succeeds when the key does not exist. */
  delete(key: string): Promise<void>;
}
```

The method signatures are as accepted on 2026-10-19. The spike made these parts of the contract explicit:

- **Keys are relative to the adapter's root prefix** (the vault prefix). Every key must pass `checkStorageKey` (see [Key rules](#key-rules)).
- **Etags are opaque and unquoted.** Pass the etag from `get` or a put to `putIfMatch` unchanged. Identical bodies can have identical etags, because S3 and R2 use the MD5 of a single-part body. `putIfMatch` therefore detects a changed body, not every write: a write of A, then B, then A again leaves the first etag valid.
- **`list` order is Unicode code point order**, which equals the UTF-8 byte order that S3 and R2 use. It differs from JavaScript's default string order for characters above U+FFFF. Use `compareKeys` to sort keys the same way.
- **`list` can return a short page.** A page can hold fewer than `limit` keys and still have `truncated: true`. Continue with `startAfter` set to the last key until `truncated` is false. A `limit` that is not a positive integer throws `RangeError`.
- **`putIfMatch` on a missing key fails with `PreconditionFailed`.** AWS S3 returns 404 in that case; the adapter maps it.
- **Adapters do not retry.** They throw typed errors, and the caller (later `@obsy/core`) decides. One retry policy then applies to every provider.

### Errors

Existing behavior. Adapters throw only `StorageError` subclasses. Use `kind`, `retryable`, and `mayHaveApplied`, not provider status codes. `isStorageError` and `isPreconditionFailed` check errors structurally, so they work across duplicate package copies.

| Class (`kind`) | Meaning | What the caller does |
| --- | --- | --- |
| `PreconditionFailed` (`precondition-failed`) | The condition was false. This request wrote nothing. | Re-read (catch up), then decide again. |
| `TransientStorageError` (`transient`) | Rate limit, conflicting concurrent request, 5xx, timeout, or network error. | Retry after a delay. `retryAfterMs` carries `Retry-After`. |
| `InvalidKey` (`invalid-key`) | The key breaks the key rules. | Fix the caller. Do not retry. |
| `StorageError` (`fatal`) | Permission, configuration, missing bucket, or malformed response. | Stop and report. |

`mayHaveApplied` is true when a write failed in a way that does not prove it did not apply: a timeout, a lost connection, or a 5xx other than `SlowDown`. After such a failure, a retried conditional write can fail with `PreconditionFailed` because of the caller's own first attempt. The commit algorithm handles this: it catches up and finds its own `opId` in the log ([protocol](protocol.md#commit-algorithm)).

### Key rules

Existing behavior (`checkStorageKey`, `checkStoragePrefix`). A key must:

- be 1 to 1,024 bytes of UTF-8, including the adapter's root prefix (the S3 and R2 limit);
- be well-formed Unicode, with no control characters (U+0000 to U+001F, U+007F);
- have no empty path segment: no leading or trailing `/`, and no `//`;
- have no `.` or `..` segment, because URL parsers remove them.

S3 and R2 accept empty segments. The rule is stricter so that keys stay portable: the versitygw posix backend rejected a key that ends in `/` ([evidence](../learning/storage-spike.md#provider-findings)). Protocol keys never need empty segments. Spaces, `+`, `%`, `&`, quotes, `<`, `>`, `#`, `?`, `\`, and non-ASCII characters are valid, and the suite tests them.

### Adapters

| Package | Transport | Runs in | Status |
| --- | --- | --- | --- |
| `@obsy/storage-s3` | S3 API with SigV4 signing (`aws4fetch`). `fetch` is injectable, so the Obsidian plugin can pass a `requestUrl`-based transport. | Obsidian, Node, Workers | Existing behavior; not yet run against R2 or AWS S3 |
| `@obsy/storage-r2` | Native R2 binding | Cloudflare Workers | Accepted design, not implemented |

### `@obsy/storage-s3`

Existing behavior. `new S3Storage({ endpoint, bucket, region, accessKeyId, secretAccessKey, sessionToken?, prefix?, addressing?, fetch?, timeoutMs? })`.

- **Endpoints.** Path-style by default: `<endpoint>/<bucket>/<key>`. For R2 the endpoint is `https://<account-id>.r2.cloudflarestorage.com` and the region is `auto`. `addressing: 'virtual'` gives `<bucket>.<host>/<key>`.
- **Root prefix.** `prefix` (empty, or ending in `/`) is added to every key and removed from listed keys. `withPrefix(sub)` returns an adapter rooted one level deeper.
- **Signing.** SigV4 through `AwsV4Signer` from `aws4fetch`. The payload is signed: `x-amz-content-sha256` is the SHA-256 of the body. `If-None-Match` and `If-Match` are signed headers. Keys are encoded per segment with RFC 3986, so the URL path equals the canonical path.
- **Conditional writes.** `putIfAbsent` sends `If-None-Match: *`. `putIfMatch` sends `If-Match: "<etag>"`. Unconditional writes are not offered.
- **Lists.** ListObjectsV2 with `prefix`, `start-after`, `max-keys`, and `encoding-type=url`. Keys are decoded only when the response says `<EncodingType>url</EncodingType>` (`+` means space). Short pages are followed with continuation tokens up to `limit`. The XML parser is plain ECMAScript, because Workers have no `DOMParser`. It rejects a DOCTYPE, unknown entities, and mismatched tags.
- **Timeouts.** Each request, including its body, has a time limit (default 30 s). The adapter uses `AbortController` when the runtime has it, and a timer in every case, so a transport without abort support still times out.
- **Platform boundary.** The source compiles with ES libraries only. It reaches `fetch`, `crypto.subtle`, `TextDecoder`, `AbortController`, and timers through typed `globalThis` access. The type check rejects `DOMParser` and `process`.
- **Credentials** stay in private fields. Errors carry the operation, the key, the status, and the provider code, never headers or signed URLs.

Status mapping:

| Response | Error | `mayHaveApplied` | Source |
| --- | --- | --- | --- |
| 412 | `PreconditionFailed` | no | [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html); [R2 error codes](https://developers.cloudflare.com/r2/api/error-codes/) |
| 404 on `putIfMatch` | `PreconditionFailed` | no | AWS: "the operation fails with a `404 Not Found` error" when no current version exists |
| 404 `NoSuchKey` on `get` | returns `null` | — | |
| 404 `NoSuchBucket` | `StorageError` (fatal) | — | |
| 409 (for example `ConditionalRequestConflict`) | `TransientStorageError` | no | [AWS PutObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html): "On a 409 failure, retry the upload" |
| 429 | `TransientStorageError`, with `retryAfterMs` | no | R2 `TooManyRequests`, "limit: 1 write/second per key" |
| 503 `SlowDown` | `TransientStorageError` | no | |
| other 5xx | `TransientStorageError` | yes, for writes | R2 `InternalError`: "Retry the request" |
| 400 `RequestTimeout` | `TransientStorageError` | no | |
| timeout, network error | `TransientStorageError` (`Timeout`, `NetworkError`) | yes, for writes | |
| other 4xx | `StorageError` (fatal) | — | |

For a 409 on `If-Match`, AWS says to fetch the object's etag again before the retry.

### Provider requirements

Accepted design. The [protocol](protocol.md) uses the bucket as the commit sequencer. The conformance suite checks these requirements before a vault is used:

- `If-None-Match: *` on PUT is atomic: of concurrent creators of one key, at most one succeeds.
- Strong read-after-write and list-after-write consistency.
- `If-Match` on PUT for the few mutable objects.

Cloudflare R2 and AWS S3 document these guarantees ([R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/); [AWS conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)). They are the only supported providers in version 1. See [Supported storage providers](../decisions/2026-10-19-supported-storage-providers.md). A live conformance run on each is still open.

### Conformance suite

Existing behavior. `describeStorageConformance(target)` in `@obsy/storage-testkit` registers Vitest tests against a `Storage` factory. It tests:

- `get` of a missing key; create and read back with the same etag;
- `putIfAbsent` on an existing key; `putIfMatch` with a matching, stale, made-up, or missing etag; concurrent `putIfMatch` with one etag (exactly one winner);
- `delete`, a repeated delete, and create after delete;
- list order (code point order, sibling prefixes such as `log/` and `logs/`), `startAfter`, `limit` and `truncated`, paging through 25 keys, and list-after-write and list-after-delete;
- unusual keys through put, get, and list, including NFC and NFD twins; rejected keys; binary bodies (empty, all 256 byte values, 1 MiB, a subarray); and isolation from the caller's buffer;
- the race harness:
  - **conditional create:** N writers call `putIfAbsent` on one fresh key per round. Exactly one wins each round, and the stored body is the winner's;
  - **commit log:** K writers run the commit algorithm. Each catches up by listing `log/` and reading every new entry, then claims `log/<16-digit seq>.json` with `putIfAbsent`, and catches up again on `PreconditionFailed`. Afterwards the log has no gaps and no duplicates, and every writer's every commit appears exactly once (checked by `opId`).

The harness retries transient errors with jittered backoff. It resolves a `mayHaveApplied` failure by reading back, so a lost response is not counted as a lost race. Tests show that the harness detects a check-then-write storage that is not atomic.

`MemoryStorage` has the semantics the protocol needs: each operation takes effect atomically after an injectable scheduler, conditional writes check and write in one step, reads and lists are strongly consistent, lists use code point order, and etags are content hashes. The phase 1 simulator can reuse it. `createFakeS3` serves the S3 subset that the adapter uses from a `MemoryStorage`, checks SigV4 header shape and the payload hash, and injects faults.

How to run each target is in the [storage conformance runbook](../runbooks/storage-conformance.md). Run the suite against every provider before the provider is listed as supported. See [Correctness and testing](../concepts/correctness-and-testing.md).

| Target | Kind | Result |
| --- | --- | --- |
| `MemoryStorage` (also with random interleaving and 3-key pages) | Unit | Pass |
| `S3Storage` + fake S3 (path-style, virtual-hosted with 2-key pages, and a fake that ignores `encoding-type`) | Unit | Pass |
| versitygw 1.9.0 (posix backend), local Docker | Harness target, not a supported provider | Pass |
| MinIO (Chainguard build), local Docker | Harness target, not a supported provider | Pass |
| SeaweedFS 4.48, local Docker | Harness target, not a supported provider | Fail: list order, `\` in keys, slow conditional writes |
| Cloudflare R2 | Supported provider | Not run yet |
| AWS S3 | Supported provider | Not run yet |

## History

- 2026-10-19: Interface and provider requirements accepted, from the former `DESIGN.md`.
- 2026-10-20: Phase 0 storage spike. Implemented the interface, errors, and key rules (`@obsy/protocol`), the S3 adapter, and the testkit. Made the etag, list, error, and key contracts explicit; keys may not have empty segments. Local results in [Storage spike](../learning/storage-spike.md).
