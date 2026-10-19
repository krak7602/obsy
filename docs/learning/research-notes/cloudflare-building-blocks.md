---
title: Research notes: Cloudflare building blocks
aliases: [Durable Objects, R2, Workers limits, cost estimate]
updated: 2026-10-19
---

# Cloudflare building blocks for the obsy server (Workers, Durable Objects, R2), as of October 2026

Research date: 2026-10-19. Unless marked otherwise, sources are the live Cloudflare docs fetched on that date. Page dates appear where the page shows one: Workers limits page "last updated Oct 12, 2026"; Workers pricing page "last updated Oct 2, 2026"; DO limits page "last updated Jun 1, 2026". Other pages showed no date. Where a doc page contradicts itself or an older value, the note says so.

## 1. Durable Objects with SQLite storage: limits, transactions, PITR, alarms, consistency (one DO per vault as the version authority)

### Takeaway
A SQLite-backed DO gives one single-threaded, strongly ordered authority for each vault. It has synchronous SQL transactions, 30-day point-in-time recovery, and alarms. It is a good fit for a per-vault file-version table and a monotonically increasing change-log cursor. The binding limits are 10 GB per object (one FAQ says 1 GB on Free), a 2 MB row/BLOB limit, a 100 KB SQL statement limit, 128 MB isolate memory, and a soft limit of about 1,000 req/s per object. File bytes therefore belong in R2, and the DO keeps only metadata and hashes.

### Cited Findings
**Limits (SQLite-backed DOs)**
- Number of objects: unlimited. Storage per account: unlimited on Workers Paid (5 GB on Free). Storage per class: unlimited — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Storage per object: **10 GB**. The same page's FAQ says 10 GB on Paid and **1 GB on Free**, so the page conflicts with itself. The YAOS project's architecture doc also cites "1 GB per Durable Object and 5 GB per account", apparently using Free-plan figures — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/); [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)
- Key+value combined ≤ 2 MB. Max string, BLOB, or table row size is **2 MB**. SQL statement length is **100 KB**. Max 100 columns per table, 100 bound parameters per query, 32 arguments per SQL function, and a 50-byte LIKE/GLOB pattern — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- CPU: **30 s per request by default, configurable up to 5 minutes**. Each incoming HTTP request or WebSocket message resets the CPU budget to 30 s — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Received WebSocket message size: **32 MiB** — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Throughput: each object has a soft limit of **about 1,000 requests/s**. Excess requests queue, and a queue overflow returns an "overloaded" error — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Storage is measured in decimal GB (1 GB = 10^9 bytes) — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Memory: the SQLite storage API page refers to "the isolate's 128 MB memory limit". Write buffering without `await` can approach that limit — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- The KV-style API inside DO storage handles batch `get`/`delete`/`put` of "up to 128 keys at a time" — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

**Transactions and consistency**
- `ctx.storage.transactionSync(fn)` runs a synchronous callback as one transaction and rolls back if the callback throws. The callback must not be async. `sql.exec()` cannot run `BEGIN TRANSACTION` or `SAVEPOINT`; use `transaction()`/`transactionSync()` instead — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- Implicit transactions: "each method call is implicitly wrapped in a transaction". Writes with no intervening `await` "are automatically combined and submitted atomically". While a storage read is awaited, other events are blocked (input gate) unless `allowConcurrency: true` is set — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- Output gates: outgoing network messages are held until earlier writes are persisted. If a write fails, the object resets and discards the pending outgoing messages. `allowUnconfirmed: true` skips this wait, and `sync()` resolves once writes are on disk — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- `sql.exec()` returns a cursor that is **not a snapshot**. Docs advise consuming it fully before the next `await`. `rowsRead`/`rowsWritten` per query feed billing. `sql.databaseSize` gives the DB size in bytes. Large integers lose precision beyond JS number precision — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- `deleteAll()` on SQLite-backed objects is atomic — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- `blockConcurrencyWhile` times out after **30 s**. A timeout or a throw resets the object — [DO State API](https://developers.cloudflare.com/durable-objects/api/state/)
- `ctx.abort()` resets the object immediately. An interrupted alarm retries unless `{ retryAlarm: false }` is passed — [DO State API](https://developers.cloudflare.com/durable-objects/api/state/)

**Point-in-time recovery (PITR / bookmarks)**
- PITR restores the object's SQLite database (SQL and KV data) "to any point in time in the past **30 days**". It is not supported in local development — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- APIs: `getCurrentBookmark()`, `getBookmarkForTime(ts)` (ts must be within 30 days), and `onNextSessionRestoreBookmark(bookmark)`. The last applies on the next restart, usually followed by `ctx.abort()`. It returns a bookmark for the moment just before the restore, so a restore can be undone. Bookmarks compare lexically in time order — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

**Alarms**
- One alarm per object: `setAlarm(Date|ms)`, `getAlarm()`, `deleteAlarm()`. Granularity is in milliseconds, but an alarm "can be delayed by up to a minute due to maintenance or failures while failover takes place" — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- `deleteAll()` also deletes alarms only with compatibility date ≥ 2026-02-24 — [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- Alarm handlers have a 15-minute wall-clock limit (same as Cron and Queue consumers) — [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Alarm invocations count as DO requests for billing — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- An active alarm prevents hibernation — [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

**Prior art: a DO per vault for Obsidian**
- YAOS ("real-time sync engine for Obsidian, powered by your own Cloudflare Worker") maps **one vault to one DO room and one vault-wide Y.Doc**. It considered and rejected per-document sharding because sharding changes "consistency, bootstrap, persistence, recovery, and migration" — [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)
- YAOS persistence works as follows. A full checkpoint is split into rows below the 2 MB row limit, and a bounded journal holds coalesced Yjs deltas. Compaction runs when the journal exceeds **50 entries or 1 MB**. Payloads carry SHA-256 integrity checks. Corrupt storage makes the server refuse service rather than serve an empty vault. Its stated reasoning is that one row per event would exhaust the write budget, while full rewrites amplify small edits — [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)

### Inferences
- A per-vault DO can own tables such as `files(path, file_id, version, sha256, size, mtime, deleted)` and `changes(seq INTEGER PRIMARY KEY, file_id, version, op, actor, ts)`. Its single-threaded execution makes `seq` a clean, gap-free cursor. A client resumes with `?since=<seq>`. A compare-and-swap ("write only if my base version == current version") is a single `transactionSync`.
- Output gates mean a client will never receive an "ack" for a write that was not durably persisted. This is a useful property for the agent writer and for device uploads.
- For 5,000 files, metadata is a few MB, far below 10 GB (or 1 GB on Free). The 2 MB row limit matters only if Markdown bodies or CRDT state are stored in the DO. Notes over 2 MB need chunking or R2.
- PITR gives free 30-day undo for the metadata and change log. It does not cover R2 blobs, so blob retention must be at least as long as the PITR window that metadata relies on.
- The ~1,000 req/s soft limit is irrelevant for one owner with 2-3 devices.

### Gaps
- The per-object storage figure conflicts (10 GB vs 1 GB on Free) within the official page. Paid appears to be 10 GB.
- No official per-DO memory figure appears on the limits page. 128 MB is inferred from the storage API page wording and the Workers limit.
- I did not find official numbers for alarm retry counts or backoff in this pass.

## 2. WebSocket Hibernation API: mechanics, cost, limits, push notifications, flaky mobile clients

### Takeaway
With `ctx.acceptWebSocket()`, a DO can hold up to 32,768 client sockets while it is evicted from memory, and no duration (GB-s) charges accrue while it hibernates. Incoming messages bill at 20:1, and outgoing messages are free. This makes a cheap, always-on "something changed, your cursor is now N" push channel. Clients must still assume the socket can drop at any time (deploys disconnect all sockets) and catch up by cursor on reconnect.

### Cited Findings
- Use `this.ctx.acceptWebSocket(server)` instead of `ws.accept()` to allow hibernation. When the object hibernates, in-memory state is reset while clients stay connected. On the next event the constructor runs again, and incoming messages wake the object automatically — [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- `acceptWebSocket(ws, tags)` allows up to **10 tags** per socket, each up to **256 chars**. `getWebSockets(tag)` filters by tag. The API "permits a maximum of **32,768** WebSocket connections per Durable Object" — [DO State API](https://developers.cloudflare.com/durable-objects/api/state/)
- `setWebSocketAutoResponse(pair)` answers a request/response pair (each ≤ 2,048 chars) without waking the DO. `getWebSocketAutoResponseTimestamp(ws)` returns the last auto-response time. `setHibernatableWebSocketEventTimeout` allows a maximum of 604,800,000 ms (7 days) — [DO State API](https://developers.cloudflare.com/durable-objects/api/state/)
- `serializeAttachment` / `deserializeAttachment` store per-socket state that survives hibernation. The page states "Maximum serialized size is **16,384 bytes**". (Older docs, from memory, said 2,048 bytes; treat 16 KiB as the current value but verify.) The attachment is lost when either side closes — [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Hibernation is blocked by alarms, in-flight requests, scheduled callbacks, `setTimeout`/`setInterval`, and outbound WebSockets (which block eviction for up to 15 min). Ping/pong control frames do not wake the object and do not reach `webSocketMessage` — [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- "Deploying a new version restarts every Durable Object and disconnects existing WebSockets" — [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Docs suggest batching logical messages every 50-100 ms or 50-100 messages — [DO WebSockets best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- Billing: creating a WebSocket connection is a request. Incoming messages bill at **20:1** (100 messages = 5 requests). Outgoing messages and incoming protocol pings are not charged. Auto-responses incur no wall-clock charge. "Idle objects that qualify for hibernation are not billed for duration, even before the runtime hibernates them." Using `accept()` (non-hibernating) bills duration for the whole connection. Pending I/O can keep an object in memory for up to 15 minutes — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- Cloudflare's own example shows the effect. 100 objects × 100 hibernating connections each come to about **$20.65/month**. 100 objects with constant, non-hibernating activity come to about $419.30/month — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- Max received message size is 32 MiB — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- Prior art on mobile: YAOS docs list "Mobile sync can stop" with the remedy "Reconnect to sync server". YAOS refreshes WS auth tickets proactively because "the current y-partyserver reconnect loop doesn't re-run async connection parameters" — [YAOS README](https://github.com/kavinsood/yaos); [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)

### Inferences
- Use the socket only as a **notification and low-latency channel**, for example `{"type":"changed","seq":1234}`. Keep the cursor-based HTTP pull as the source of truth. Mobile OSes suspend background sockets, and every deploy drops all sockets, so correctness must never depend on the socket.
- A cheap keepalive design is a client-sent text "ping" that matches a `setWebSocketAutoResponse` pair. It costs no duration, keeps NAT/proxies alive, and lets the client detect dead links.
- Put the device ID and last-acked cursor in the socket tags or attachment, so that after a wake the DO knows who is connected without storage reads.
- Because outgoing messages are free and incoming ones bill at 20:1, server-to-device fan-out costs essentially nothing at this scale.

### Gaps
- No official max *outgoing* WebSocket message size was found.
- I found no Cloudflare guidance specific to iOS/Android background behavior. Mobile suspension behavior is OS-level and was not researched here.
- The 16,384-byte attachment limit vs the earlier 2,048 bytes is not confirmed by a changelog entry.

## 3. R2: conditional writes, consistency, multipart, metadata, versioning, presigned URLs, S3 compatibility, pricing, events

### Takeaway
R2 is strongly consistent for read-after-write, list, metadata, and delete. It supports atomic conditional PUTs (`If-Match` / `If-None-Match`, and `onlyIf` in the Workers binding). It has no egress fees. R2 still does **not** implement native S3 object versioning (`Get/PutBucketVersioning` are unimplemented). History should therefore be built as content-addressed, immutable blobs (key = SHA-256), referenced from the DO's version table, with GC/lifecycle rules for retention. At 1-2 GB and a few hundred edits/day, usage fits inside R2's free tier.

### Cited Findings
**Consistency**
- Read-after-write: "Strongly consistent: readers will immediately see the latest object globally". List-after-write is strongly consistent, metadata updates are strongly consistent, and deletes are strongly consistent ("does not exist" immediately) — [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- Concurrent writes: the last writer wins. With conditional `PutObject` `If-None-Match: *` on an absent key, "at most one request succeeds and every other request fails with a `412 PreconditionFailed`" — [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- Caching caveats apply only to custom domains with cache enabled, not to Worker bindings or the S3 API — [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/)
- Concurrent writes to the **same key are limited to 1 per second**. Higher rates return 429 — [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)

**Conditional operations**
- The Workers binding `R2Conditional` has `etagMatches`, `etagDoesNotMatch`, `uploadedBefore`, and `uploadedAfter`. `put()` accepts `onlyIf` (R2Conditional or Headers). If the condition fails, "`put()` returns `null`, and the object will not be stored" — [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- S3 API `PutObject` supports `If-Match`, `If-Modified-Since`, and `If-None-Match`, "evaluated atomically" — [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- `R2PutOptions` accept checksums `md5`/`sha1`/`sha256`/`sha384`/`sha512` (only one at a time), `httpMetadata`, `customMetadata` (Record<string,string>), `storageClass` (`Standard` | `InfrequentAccess`), and `ssecKey` (SSE-C) — [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- Use `httpEtag` (quoted) in response headers, while `etag` is unquoted — [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- `list()`: `limit` defaults to and maxes at 1,000. It is paged with `cursor`. `include` returns metadata, but then the call may return fewer than `limit`, so check `truncated` — [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

**Size limits and multipart**
- Object max is **4.995 TiB**. A single-part upload is max **5 GiB** (a footnote says 4.995 GiB, so the page is internally inconsistent). Max 10,000 parts. Key length 1,024 bytes. **Metadata 8,192 bytes**. 1,000,000 buckets per account — [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- Multipart part size is min **5 MiB** (except the last part) and max **5 GiB**. "All parts except the last must be the same size." Incomplete uploads are auto-aborted after 7 days by default. A multipart ETag is the MD5 of the part MD5s plus `-N` — [R2 multipart](https://developers.cloudflare.com/r2/objects/multipart-objects/)
- Workers binding: `createMultipartUpload` / `resumeMultipartUpload(key, uploadId)`. Resume does no validity check — [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- S3 checksums: SHA-256 is supported only as COMPOSITE (multipart), not FULL_OBJECT. CRC-64/NVME is supported as FULL_OBJECT (added 2025-07-03) — [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/); [R2 release notes](https://developers.cloudflare.com/r2/platform/release-notes/)

**Versioning (status in 2026)**
- The S3 compatibility table lists **"❌ GetBucketVersioning"** and **"❌ PutBucketVersioning"**. Object Lock is also unsupported — [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)
- R2 release notes for 2025-2026 contain no versioning entry. Entries include 2026-04-27 dashboard "empty bucket", 2025-09-23 bucket-lock UI fix, and 2025-07-03 CRC-64/NVME — [R2 release notes](https://developers.cloudflare.com/r2/platform/release-notes/)
- A Cloudflare community thread (~late 2025) had staff saying versioning is "on our roadmap" — [Answer Overflow / CF Developers Discord](https://www.answeroverflow.com/m/1445118038889205820?focus=1445118038889205820)
- **Conflict:** several 2026 third-party comparison blogs claim R2 "supports object versioning". These are not primary sources and are contradicted by the official S3 compatibility table — e.g. [kunalganglani.com](https://www.kunalganglani.com/blog/cloudflare-r2-vs-aws-s3), [khimananda.com](https://khimananda.com/blog/cloudflare-r2-vs-aws-s3-cost-breakdown)
- Bucket locks (retention rules preventing deletion) do exist, as the 2025-09-23 release note mentions locked objects — [R2 release notes](https://developers.cloudflare.com/r2/platform/release-notes/)

**Lifecycle**
- Rules can expire objects after N days or on a date, abort incomplete multipart uploads (`DaysAfterInitiation`), and transition to `STANDARD_IA` (each transition is a Class A op). They can be scoped by prefix. There is a **1,000-rule maximum**. Objects are typically removed within 24 h of expiry. No noncurrent-version rules exist — [R2 lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

**Presigned URLs**
- Supported: GET, HEAD, PUT, and DELETE. "POST (multipart form uploads via HTML forms) is not currently supported." Expiry runs from 1 s to **7 days (604,800 s)**. URLs use AWS SigV4 and are "generated server-side with no communication with R2". They work only on the S3 API domain and "cannot be used with custom domains". Signing `Content-Type` makes a mismatched upload fail with 403. Set CORS for browser use — [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)

**Event notifications**
- `object-create` (PutObject, CopyObject, CompleteMultipartUpload) and `object-delete` (DeleteObject, **LifecycleDeletion**) events are delivered to a **Cloudflare Queue**. The JSON includes `key`, `size`, `eTag`, `action`, and `eventTime`. Max 100 rules per bucket with prefix/suffix filters, and 5,000 msg/s per queue. The page states no delivery guarantee or latency — [R2 event notifications](https://developers.cloudflare.com/r2/buckets/event-notifications/)

**Pricing (no page date shown; fetched 2026-10-19)**
- Standard storage is **$0.015/GB-month**, Class A **$4.50/M**, Class B **$0.36/M**. Infrequent Access is $0.01/GB-month, Class A $9.00/M, Class B $0.90/M, plus $0.01/GB retrieval and a 30-day minimum. **Egress is free** — [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- Free tier (monthly, Standard only): **10 GB-month storage, 1M Class A, 10M Class B** — [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- Class A ops are List*, PutObject, CopyObject, multipart create/complete/UploadPart, and PutBucketLifecycle etc. Class B ops are HeadObject, GetObject, and similar. **Free ops** are DeleteObject, DeleteBucket, and AbortMultipartUpload. Requests rejected with 401 are not charged. Usage rounds up to the next billing unit — [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

**S3 compatibility gaps relevant here**
- Unsupported: versioning, Object Lock, object tagging, bucket policy, ACLs, and standard SSE headers (only SSE-C). Storage classes are limited to STANDARD/STANDARD_IA — [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)

**Prior art**
- YAOS stores non-Markdown attachments in R2, **content-addressed by a whole-file client hash**, with a 10 MB default upload cap. It rejected block-level sync because of chunking, manifests, and GC complexity, and because small blocks multiply operation costs. Snapshots are compressed full-Yjs updates plus an index of referenced blobs in R2 — [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)

### Inferences
- **History pattern:** use `blobs/sha256/<hex>` immutable objects written with `onlyIf`/`If-None-Match: *`. A re-upload of identical content becomes a no-op 412, which also avoids the 1-write/s/key limit. The DO's `versions` table is the version history. Retention means the DO (via an alarm) deletes blob keys no longer referenced by any version newer than the retention horizon. Deletes are free Class-A-exempt ops. Prefix lifecycle rules cannot express "unreferenced", so GC must be application-driven. Lifecycle is useful mainly for `uploads/` staging prefixes and aborting multipart uploads.
- To verify content addressing on upload through the binding, pass `sha256` in `R2PutOptions`. R2 is expected to reject mismatching bodies (behavior not explicitly quoted on the fetched page). With presigned S3 PUTs, full-object SHA-256 checksums are not supported for multipart, so the server should re-hash or trust-but-verify via an async job.
- Strong list consistency means a periodic `list()` reconciliation (DO references vs R2 keys) is reliable for orphan detection.
- Event notifications can tell the DO "blob X landed" after a presigned upload, but they add a Queue dependency. A simpler path is for the client to call a `commit` endpoint after upload, and the Worker does a `head()` (Class B) to confirm.

### Gaps
- No official statement that R2 versioning has shipped as of Oct 2026. The official S3 table says unimplemented. Treat third-party claims as unreliable.
- The presigned URL page does not say whether `If-None-Match` can be signed into a presigned PUT.
- Delivery semantics and pricing for event notifications are not stated on the R2 page. They would come from Queues docs, which were not fetched.
- The exact SigV4 tooling (e.g. `aws4fetch` in Workers) was not verified in this pass.

## 4. Yjs/CRDT patterns on Durable Objects (y-partyserver, y-durableobjects, Agents SDK)

### Takeaway
Three maintained options exist. **y-partyserver** (in `cloudflare/partykit`) supplies a `YServer` with `onLoad`/`onSave` hooks and debounced saving. **y-durableobjects** (Hono-based, with RPC `getYDoc`/`updateYDoc`). The **Agents SDK** offers JSON state sync (not CRDT). The closest prior art for Obsidian (YAOS) uses **one DO + one Y.Doc per vault**, with a checkpoint+journal in DO SQLite and blobs in R2. Per-document DOs were considered and rejected for consistency and bootstrap reasons.

### Cited Findings
- **y-partyserver**: by default the Yjs doc is kept in memory "as long as at least one client is connected". Override `onLoad()` to hydrate `this.document` (keyed by `this.name`, the room) and `onSave()` to persist `Y.encodeStateAsUpdate`. `callbackOptions`: `debounceWait` 2000, `debounceMaxWait` 10000, `timeout` 5000 (ms assumed). The client provider supports `params` (async, e.g. auth token), `resyncInterval` (default -1), `maxBackoffTimeout`, and custom string messages on the same socket — [y-partyserver README](https://github.com/cloudflare/partykit/tree/main/packages/y-partyserver)
- PartyServer enables hibernation via a static options property on the Server class (exact key not confirmed in the fetched pages) — [partyserver npm via socket.dev](https://socket.dev/npm/package/partyserver/overview/0.5.10)
- **y-durableobjects** (napolab): `yRoute()` Hono helper, a `YDurableObjects` class, and JS RPC `getYDoc()` / `updateYDoc(update)`. WebSockets can't go through JS RPC, so upgrades use `fetch`. The README does not document the storage format, compaction, or hibernation. The repo has ~254 stars, 70 commits, and no tagged releases — [y-durableobjects](https://github.com/napolab/y-durableobjects)
- **yjs-cf-ws-provider** (community): uses the Hibernation API, stores "partial updates" in DO storage, and every `YJS_VACUUM_INTERVAL_IN_MS` (default 30 s) writes the full doc to R2 and clears the partials — [yjs-cf-ws-provider README](https://github.com/TimoWilhelm/yjs-cf-ws-provider/blob/main/README.md)
- **Agents SDK state sync**: `setState()` persists JSON to the agent's SQLite, broadcasts to connected WebSocket clients, and then calls `onStateChanged()`. Clients use `useAgent`/`AgentClient` with `onStateUpdate`. State survives hibernation. Docs advise keeping state small (every change is broadcast) and using `this.sql` for large collections. No numeric state limit is given. It is last-writer-wins JSON, not a CRDT — [Agents: store and sync state](https://developers.cloudflare.com/agents/api-reference/store-and-sync-state/)
- **YAOS (Obsidian on CF)** uses a per-vault DO and a vault-wide Y.Doc holding file identity/path metadata, Markdown `Y.Text`, and blob hash references with tombstones. Its stated "memory ceiling" is that each unmergeable Yjs struct costs ~117 bytes and stays resident in the 128 MB isolate. Tombstoned bodies are reaped after a grace period, but tombstone metadata remains. Persistence uses a chunked checkpoint plus a journal, compacted at >50 entries or >1 MB — [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)
- YAOS auth: a bearer token for HTTP, with short-lived vault-scoped HMAC tickets for WebSocket. Plugin/server schema-version mismatch returns `update_required` — [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)

### Inferences
- **Per-vault vs per-doc DO:** per-vault gives one cursor, atomic multi-file operations (renames, agent batch edits), and one hibernating socket per device. Per-doc DOs need N sockets or a multiplexing router, plus cross-DO coordination for renames and a global change feed. At 5,000 files and one owner, per-vault is simpler and cheaper. The risk is the 128 MB memory ceiling if *all* note bodies live in one resident Y.Doc. A hybrid design avoids that: the per-vault DO holds the version/metadata log, Markdown bodies are stored as content-addressed R2 blobs (or per-file CRDT state loaded on demand), and CRDT merge happens only for files with concurrent edits.
- Hibernation and Yjs interact badly when the doc lives only in memory. After each wake, the constructor re-runs and the doc must be reloaded from storage. A vault-wide Y.Doc of tens of MB would be re-hydrated on every wake. This favors storing per-file state rather than one monolithic doc. This is inferred from the hibernation semantics in section 2.
- An Agents-SDK-style JSON state is suitable for small status/presence data, not for file content.

### Gaps
- Exact y-partyserver hibernation option name and whether `YServer` persists to DO SQLite by default were not confirmed. The README shows external storage examples.
- No published cost benchmarks for Yjs on DOs were found.
- PartyKit's acquisition and integration status ("PartyKit now part of Cloudflare") was not re-verified in this pass. The code lives at `github.com/cloudflare/partykit`, which is consistent with Cloudflare ownership.

## 5. Authentication for device clients and the Worker-internal agent writer

### Takeaway
Use per-device bearer tokens: random secrets whose hashes are stored in the vault DO, so they can be revoked one at a time. For WebSockets, mint short-lived signed tickets. The server-side agent writer should not use HTTP auth at all. It should call the vault DO's RPC methods through a DO binding (same Worker) or a service binding (separate Worker). These are not reachable from the public internet and add no request fees.

### Cited Findings
- Service bindings "allow one Worker to call into another, without going through a publicly-accessible URL". A Worker exposes typed methods by extending `WorkerEntrypoint`, and can export several named entrypoints (e.g. an `AdminEntrypoint`) selected by the binding's `entrypoint` field — [Workers RPC](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/)
- "Requests made from your Worker to another worker via a Service Binding do not incur additional request fees". Billing is one request plus the combined CPU time of both Workers — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- DO RPC sessions count as DO requests for billing — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- JS RPC cannot carry WebSocket upgrades, which must go through `fetch` — [y-durableobjects README](https://github.com/napolab/y-durableobjects)
- Prior art: YAOS uses a one-time "claim" flow that generates a setup token, a bearer token for HTTP, and short-lived vault-scoped HMAC tickets for WebSocket, "so the long-lived token stays out of the normal WebSocket URL" — [YAOS architecture.md](https://raw.githubusercontent.com/kavinsood/yaos/main/docs/architecture.md)
- R2 rejects requests with HTTP 401 at no charge, which limits the cost of unauthenticated abuse on the S3 endpoint — [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### Inferences
- **Devices:** issue a token per device on pairing and store `sha256(token)`, `device_id`, `created`, `last_seen`, and `revoked` in the DO. Present it as `Authorization: Bearer`. Browser WebSocket APIs cannot set an Authorization header, so for WS, POST to `/ws-ticket` with the bearer token and receive an HMAC-signed ticket valid for ~60 s, as YAOS does. Record the `actor` (device ID or `agent`) in every change-log row.
- **Agent writer:** define `VaultDO` methods such as `commitFile({path, baseVersion, sha256, actor:"agent"})` and call them via `env.VAULT.get(id).commitFile(...)`. If the agent runs in a separate Worker, give it a service binding to a named `AgentEntrypoint` that exposes only the write methods it needs. No token is needed because the binding is the capability.
- **Presigned URLs** act as scoped, short-lived capabilities, so devices never hold R2 credentials. The Worker holds the R2 S3 API key as a secret and signs per-request URLs with ≤ 15 min expiry and a pinned Content-Type.

### Gaps
- Cloudflare Access / service tokens / mTLS for device auth were not researched in this pass.
- The fetched RPC page does not document RPC payload limits or passable types (streams, RpcTarget).

## 6. Worker/DO request size, CPU, and memory limits; moving large binaries

### Takeaway
On a Free/Pro zone, a Worker request body is capped at **100 MB**, and the isolate has **128 MB** memory. Small and medium attachments (below ~25-50 MB) can stream through the Worker into an R2 binding. Large binaries should go **directly to R2 via presigned PUT/GET** (single PUT up to 5 GiB, multipart beyond that), with the Worker only issuing URLs and committing metadata.

### Cited Findings
- Workers Paid limits (page updated Oct 12, 2026): CPU **30 s default, max 5 min** per HTTP request. Memory **128 MB per isolate**. Request body **Pro 100 MB, Business 200 MB, Enterprise up to 5 GB self-serve**. No enforced response body limit (CDN cache limit 512 MB Business / 5 GB Enterprise). 10,000 subrequests per invocation. No wall-clock limit for HTTP (15 min for Cron/DO alarms/Queues). 6 simultaneous outgoing connections awaiting headers — [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- The page did not list the Free-zone body limit explicitly in the fetched summary. Pro is 100 MB. Cloudflare's long-standing Free-zone figure is also 100 MB, but that is not re-verified here — [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- DO WebSocket received message max is 32 MiB, and the SQLite row/BLOB max is 2 MB — [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
- R2 single PUT max is 5 GiB, multipart parts are 5 MiB-5 GiB with ≤ 10,000 parts, and presigned URLs last up to 7 days without a network call to create — [R2 limits](https://developers.cloudflare.com/r2/platform/limits/); [R2 multipart](https://developers.cloudflare.com/r2/objects/multipart-objects/); [R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- R2 egress is free through the Workers API, S3 API, and r2.dev — [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### Inferences
- Streaming `request.body` straight into `env.BUCKET.put()` does not buffer the body in memory, so 128 MB is not the binding constraint. The body limit (100 MB on Free/Pro) and mobile-network retry cost are. From memory and not re-verified: R2 binding `put` with a stream requires a known length (`Content-Length` or `FixedLengthStream`).
- Recommended split:
  - Markdown and small files (< ~5-10 MB) go through the Worker. This keeps the hash check and commit atomic in one round trip, and the DO commit happens in the same request.
  - Larger attachments use presigned PUT to `uploads/<uuid>`, then a `POST /commit`. The Worker verifies size and hash (head plus optional re-hash for small files) and `copy`/`put` into `blobs/sha256/<hash>`, or uploads straight to the hash key if the client pre-computed it.
  - Downloads use presigned GET or a Worker stream. Both have free egress.
- Presigned URLs only work on the `<account>.r2.cloudflarestorage.com` S3 endpoint, not custom domains. Clients must reach that host, and CORS must be configured for the Obsidian mobile and desktop webviews.

### Gaps
- The Free-zone request body limit was not explicitly confirmed on the fetched page.
- Whether R2 `put()` verifies a provided `sha256` and rejects mismatches is implied but was not quoted.

## 7. Realistic monthly cost estimate (1 owner, 2-3 devices, ~5,000 files, 1-2 GB, a few hundred edits/day, existing Workers Paid plan)

### Takeaway
The **marginal cost is about $0/month** on top of the existing $5 Workers Paid minimum. Every dimension stays far inside the included allowances. Even a DO kept awake 24/7 for a whole month (≈324,000 GB-s) fits inside the 400,000 GB-s included. With 10-20 GB of retained history, storage adds about $0-0.15/month. The included allowances are **account-wide**, so they are shared with other projects on the same account.

### Cited Findings (price inputs)
- Workers Paid: **$5/month minimum** per account, covering Workers and DO usage. Workers include 10M requests (+$0.30/M) and 30M CPU-ms (+$0.02/M CPU-ms) — [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- DO Paid: **1M requests/month included** (+$0.15/M) and **400,000 GB-s/month included** (+$12.50/M GB-s), billed at 128 MB per active object. SQLite **rows read 25B/month included** (+$0.001/M), **rows written 50M/month included** (+$1.00/M), and **storage 5 GB-month included** (+$0.20/GB-month). SQLite storage billing started on or after **2026-01-07** — [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- R2 Standard: $0.015/GB-month, $4.50/M Class A, $0.36/M Class B. Free tier is 10 GB-month, 1M Class A, and 10M Class B. Egress is free. Deletes are free — [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

### Inferences (worked estimate; assumptions explicit)
Assumptions: 300 edits/day (~9,000/month). Each edit creates one new blob plus a metadata commit. 3 devices each download each change. Devices are connected ~4 h/day with ~20 reconnects/day each. The agent writer adds ~100 edits/day. Initial seed: 5,000 files.

| Item | Monthly usage (estimate) | Included | Cost |
|---|---|---|---|
| R2 storage | 2 GB live + history ≈ 3-5 GB | 10 GB-month free | $0.00 |
| R2 Class A (PUT) | ~12,000 edits + 5,000 seed + lists ≈ 20k | 1M free | $0.00 |
| R2 Class B (GET/HEAD) | 3 devices × 12k + heads ≈ 50k (a full re-download of 5,000 files per device adds 15k) | 10M free | $0.00 |
| R2 egress | ~1-5 GB | free | $0.00 |
| DO requests | HTTP commits/pulls ~50k + WS connects ~2k + incoming WS msgs (20:1) ≈ 55k | 1M | $0.00 |
| DO duration | Hibernating most of the time. Worst case awake 24/7: 30 d × 86,400 s × 0.125 GB = 324,000 GB-s | 400,000 GB-s | $0.00 |
| DO SQLite rows written | ~12k edits × ~5 rows (file row, version row, change-log row, index updates) ≈ 60k | 50M | $0.00 |
| DO SQLite rows read | cursor pulls, listings ≈ a few million at most | 25B | $0.00 |
| DO SQLite storage | metadata for 5k files + version history ≈ tens of MB | 5 GB-month | $0.00 |
| Workers requests/CPU | ≈ 100k requests, < 1M CPU-ms | 10M / 30M CPU-ms | $0.00 |
| **Marginal total** | | | **≈ $0.00** (plus the existing $5 minimum) |

- Sensitivity: history growth to 20 GB in R2 costs (20 − 10) × $0.015 = **$0.15/month**. Even 100 GB costs $1.35/month.
- What could make costs non-trivial: (a) a non-hibernating design across many DOs (e.g. one DO per file each holding a socket). Cloudflare's own examples reach $142-$419/month at 100 always-active objects. (b) Writing one SQLite row per keystroke or CRDT update. YAOS cites exhausting the (Free) daily write budget as its reason for journaling. (c) Other projects on the same account consuming the shared DO/Workers allowances.
- This estimate is arithmetic on official prices with assumed usage. It is not measured evidence.

### Gaps
- No measured usage was gathered. Real request counts depend on the protocol design (polling vs push, batch commits).
- R2 free-tier applicability to accounts that also pay for Workers is assumed (the pricing page states the free tier without plan restriction).
- Queues pricing (if R2 event notifications are used) was not researched.
