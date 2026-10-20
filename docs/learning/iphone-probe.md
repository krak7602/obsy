---
title: iPhone platform probe (phase 0)
aliases: [iPhone probe results, iOS probe, requestUrl on iOS, iOS background behavior, SecretStorage on iOS, IndexedDB on iOS]
updated: 2026-10-20
---

# iPhone platform probe (phase 0)

## Current

Status: observed results from one iPhone run on 2026-10-20. Every probe section passed. The desktop baseline has not run. The current plugin design is on [Obsidian plugin](../subsystems/obsidian-plugin.md); the probe itself is described in the [platform probe runbook](../runbooks/platform-probe.md).

### Question

Phase 0 on the [roadmap](../roadmap.md) asks whether `requestUrl`, `SubtleCrypto` hashing, IndexedDB, and `SecretStorage` behave on iOS Obsidian as the design assumes, whether their state survives an app kill, and what happens to requests when the app goes to the background. It also asks whether Obsidian loads the Rolldown-built `main.js`.

### Method

- **Device.** iPhone, iOS 18.7, Obsidian 1.14.5 (`apiVersion` 1.14.5), WebView origin `capacitor://localhost`, `hardwareConcurrency` 4.
- **Install.** Method A of the runbook: the three probe files copied from a Mac into `.obsidian/plugins/obsy-probe/` of an iCloud scratch vault.
- **Bucket.** The scratch R2 bucket from the [storage spike](storage-spike.md#cloudflare-r2), APAC location, with a token scoped to it. The credentials were in `SecretStorage`.
- **Runs.** Probe 0.1.0, default sizes (vault I/O 16 MiB, background test 60 s, full conformance suite off). Session 1: **Run all**, then the app was swiped away. Session 2: the restart check on load, **Background requests**, then **Run all** again. Two reports were saved; the first one was saved while **Run all** was still running and holds only the environment section. The numbers below come from the second report.
- **Network.** The phone's own connection to R2; not controlled.

### Results

| Area | Result |
| --- | --- |
| Plugin load | The Rolldown-built CommonJS `main.js` loads and runs. |
| Platform flags | `isIosApp`, `isMobileApp`, `isPhone` true. **`isMacOS` is also true on the iPhone.** |
| APIs present | `requestUrl`, `fetch`, `crypto.subtle.digest`, IndexedDB, `navigator.storage`, `app.secretStorage`, `appendBinary`, `AbortController` |
| `requestUrl` transport | 12/12 transport steps pass: 412 and 404 bodies readable; `If-None-Match` and `If-Match` honoured; binary bodies byte-exact at 0 B, 256 B, 1 MiB, 8 MiB; `content-type` stored unchanged as a header and as the `contentType` parameter |
| Response header names | Mixed case as sent by R2 (`Etag`, `Content-Type`, `x-amz-version-id`), not lower-cased |
| Conformance over `requestUrl` | 20/20 checks without races pass, including unusual keys (22 s) and concurrent `putIfMatch` |
| Conditional-create race | 4 writers × 5 rounds: 5/5 rounds with one winner |
| Global `fetch` | Fails with `TypeError: Load failed` (no CORS on the bucket) |
| Client-side timeout | Fires; the abandoned request settles 202 ms later. `requestUrl` cannot be cancelled. |
| Request latency (309 requests) | p50 244 ms, p90 510 ms, p99 1,815 ms, max 9,107 ms (one `get`) |
| Transfer, 8 MiB | put 9.2 MB/s, get 6.9 MB/s |
| SHA-256 (`crypto.subtle`) | 1 MiB in about 1 ms; 16 MiB median 7 ms (about 2,400 MB/s); 50 MiB median 24 ms; no memory errors |
| IndexedDB | 2,000 records in one transaction 62 ms; `getAll` 7 ms; 200 one-record transactions 30 ms; 32 MiB `Uint8Array` written in 344 ms, read in 25 ms; an 8 MiB `Blob` stored and read back as a `Blob` |
| IndexedDB transactions | `abort()` and a failed `add()` roll back. A transaction is inactive after `await crypto.subtle.digest` and after a timer (`TransactionInactiveError`). |
| Storage quota | `estimate()`: quota about 10.3 GB; usage 78.7 MB. `persisted()` false, and `persist()` returns false. |
| `SecretStorage` | set, get, list, overwrite work; unknown ID returns `null`; the value is not in `data.json` and not readable as plaintext in `localStorage`. Setting an empty value leaves the ID listed and `getSecret` returns `""`. A `deleteSecret` function exists at runtime, although the 1.14.4 typings do not declare it; the probe did not call it. |
| Vault I/O, 16 MiB | `writeBinary` 155 ms (110 MB/s); `readBinary` 35 ms (645 MB/s), hash matches; `writeBinary` plus 16 × 1 MiB `appendBinary` 215 ms, size correct. No ranged read. |
| Restart after an app kill | Markers written 74 s before the kill were found and matched in IndexedDB, vault `localStorage`, `SecretStorage`, and `data.json`. |

#### Background behavior

The **Background requests** test kept a 4 MiB `get`, a `list`, and a small `putIfAbsent` running in a loop, with a 250 ms heartbeat. The owner switched away twice: for 16.5 s and for 105 s.

- After each switch, JavaScript kept running for about 3.5 to 4 s. Requests started in that window completed: 11 after the first switch, 5 after the second.
- Then the app was suspended. The heartbeat stopped: gaps of 11.4 s and 102.2 s.
- The request in flight at suspension failed at resume: once with `NetworkError` (the 4 MiB `get`), once with the client-side `Timeout` after 101.5 s, because the timer could not fire while the app was suspended.
- 68 of 70 requests succeeded. Wall-clock and monotonic elapsed time agreed (145.9 s each).
- Events seen on each switch: `blur`, `visibilitychange` to hidden; on return `focus`, `visibilitychange` to visible, and `resume`. `freeze`, `pagehide`, and `pageshow` never fired.
- In session 1, the app stayed in the background for about 5 minutes and resumed without a reload.

### Lessons

- **`requestUrl` is a sound transport for the protocol on iOS.** Conditional headers arrive, 412 and 404 come back with bodies, binary bodies are exact, and the conformance suite passes over it. The global `fetch` is blocked without bucket CORS, so the plugin must keep using `requestUrl`.
- **There is no background sync on iOS.** The plugin gets about 3.5 to 4 s after the app is hidden. On `visibilitychange` to hidden, stop starting large transfers, and only finish what fits in that window: journal writes and at most a small commit. Every request in flight at suspension must be treated as lost or `mayHaveApplied`, which the protocol already does.
- **Timeouts stretch across suspension.** A 30 s client timeout fired after 101 s. Retry and backoff logic must not assume timers fire on time, and sync must restart from `visibilitychange` to visible.
- **Hash before you open an IndexedDB transaction.** A transaction does not survive `await crypto.subtle.digest`. Hashing is fast enough (about 2 GB/s) that this costs nothing.
- **IndexedDB is not persistent storage.** `persist()` returns false. The design already treats IndexedDB as a rebuildable cache over the bucket and the vault; keep it that way.
- **State survives an app kill.** IndexedDB, vault `localStorage`, `SecretStorage`, and `data.json` all kept their values.
- **Do not use `Platform.isMacOS` to mean desktop macOS.** It is true on the iPhone. Use `isDesktopApp`, `isMobileApp`, and `isIosApp`.
- **Read response headers without regard to case.** R2 over `requestUrl` returns mixed-case names. The transport already does this.

### Limits

- One device, one iOS version, one Obsidian version, one network, one run.
- The full conformance suite (default races) was not run on the phone.
- The vault I/O size was 16 MiB; 50 MiB was not tried.
- The restart test killed the app from the app switcher. A phone reboot and an iOS low-memory kill were not tested.
- Background behavior was measured with the screen on and the app switcher; screen lock was not recorded separately.
- The vault was in iCloud Drive. iCloud may have uploaded the probe's vault files; this did not affect the results.

### Still open

- The desktop baseline run.
- Whether `deleteSecret` works, and whether it will be part of the public API.
- Probe fixes: **Save report** and **Copy report** do not warn while a run is still going; the secret section lists a fixed set of method names; and **Delete probe data** leaves `obsy-probe-test` and `obsy-probe-marker` listed with empty values (observed after cleanup). It should call `deleteSecret` when it exists.

## History

- 2026-10-20: First iPhone run; all sections pass.
