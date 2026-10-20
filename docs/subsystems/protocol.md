---
title: Protocol and core sync engine
aliases: [bucket protocol, object layout, commit log, commit algorithm, commit rules, change feed, checkpoints, compaction, gc, records, protocol, core, sync engine, reconcile, Manifest, SyncEngine, AgentWriter]
updated: 2026-10-20
---

# Protocol and core sync engine

## Current

Status:

- **Existing behavior** (phase 1): the layout keys, records and their strict parsers, path keys, conflict copy names, and the commit rules in `@obsy/protocol`; the sync engine (`SyncEngine`), bucket access (`RemoteVault`), checkpoints, and a minimal agent writer (`AgentWriter.appendLine`) in `@obsy/core`. The [simulator](../runbooks/simulator.md) checks them.
- **Accepted design, not implemented:** proposals, presence, device records, GC, `verify`, `export`, restore, and the epoch bump tool.

The bucket orders every change by itself. Every writer tries to create the next numbered log entry with a conditional create. Exactly one succeeds; the others re-read, rebase, and retry. The provider requirements for this are on [Storage adapters](storage.md). The reasons are in [The bucket is the sequencer](../decisions/2026-10-19-bucket-as-sequencer.md).

### Object layout

All keys live under a configurable vault prefix.

| Key | Mutability | Content |
| --- | --- | --- |
| `vault.json` | `If-Match` only | Vault ID, format version, epoch, created time, settings that every client must agree on |
| `log/<seq>.json` | Create once | One commit: ordered file operations, author, device, operation ID, time |
| `blobs/sha256/<hex>` | Create once | File content, addressed by SHA-256 |
| `checkpoints/<seq>.json` | Create once | Full manifest at `seq`, so new devices need not replay the whole log. Uncompressed in format 1. |
| `proposals/<id>.json` | Create once | Agent edits that could not be applied safely, for the owner to review |
| `presence/<device>.json` | Overwrite | Device heartbeat and the note being edited, for agent deferral |
| `devices/<device>.json` | `If-Match` | Device name, public metadata, last seen cursor |

`<seq>` is a zero-padded 16-digit integer, so lexicographic listing is numeric order. The largest sequence number is `Number.MAX_SAFE_INTEGER`.

### Records

Existing behavior. Records are UTF-8 JSON. Parsers reject unknown fields, unknown formats, and malformed values; a record that does not parse is corruption, and readers stop.

`vault.json`:

```json
{ "format": 1, "vaultId": "v_<24 base32>", "epoch": 1, "createdAt": "2026-10-20T09:00:00.000Z",
  "settings": { "retentionDays": 180, "blobSoftDeleteDays": 30 } }
```

A commit (`log/<seq>.json`):

```json
{
  "format": 1, "seq": 1043, "epoch": 1,
  "opId": "mac:<20 base32>", "actor": { "kind": "device", "id": "mac" },
  "time": "2026-10-19T17:02:11Z",
  "ops": [
    { "type": "put", "fileId": "f_<24 base32>", "path": "journals/2026-10-19.md",
      "baseRev": 1042, "hash": "sha256:<64 hex>", "size": 1820 },
    { "type": "put", "fileId": "f_…", "path": "a (conflict phone 202610191702).md",
      "baseRev": null, "hash": "sha256:…", "size": 90, "conflictOf": { "fileId": "f_…", "rev": 1040 } },
    { "type": "move", "fileId": "f_…", "from": "inbox/idea.md", "to": "projects/idea.md", "baseRev": 998 },
    { "type": "delete", "fileId": "f_…", "path": "old.md", "baseRev": 640 }
  ]
}
```

- A `put` may carry `merge: { base, theirs }` (revisions) to record a three-way merge. `conflictOf` marks a new file that is a conflict copy.
- One op per file per commit. At most 10,000 ops.
- Actor IDs are 1 to 64 characters of `A–Z a–z 0–9 . _ -`. An agent actor may record `run` and `toolCall`.

- **File identity** is a stable `fileId` created by the device that first creates the file. Path is an attribute, so a rename is one atomic `move`, not a delete plus a create.
- **`rev`** of a file is the `seq` of the commit that last changed it. Every operation carries the `baseRev` it was made against.
- **Paths** are stored as written: relative, `/`-separated, at most 768 bytes of UTF-8, with no empty, `.`, or `..` segment, no backslash, no control character, and no lone surrogate. Matching uses a key of Unicode NFC, then lower case, then NFC again; two live files may not share a key. This prevents macOS/iOS case and normalisation twins. Lower case is a simple stand-in for full case folding.
- **Actor** is `device`, `agent`, or `system`, with an ID. Agent commits also record the run and tool-call IDs.

A checkpoint (`{ format, seq, epoch, files }`) maps every `fileId` to `{ path, rev, hash, size, deleted }` at its `seq`. A deleted file stays as a tombstone with its last content hash.

### Commit rules

Existing behavior (`Manifest.apply`). Every reader applies commits in order and stops at the first that breaks a rule:

- `seq` is the next number; `epoch` is the vault's epoch.
- Every op's `baseRev` equals the file's current revision. Writers rebase on the current state before they claim, so no op in the log is stale. This is what makes "no delete applies to an unseen revision" hold for every reader.
- A `put` with `baseRev: null` creates a file with a new `fileId`. A `put` on an existing file keeps its path; a `put` on a deleted file restores it at its last path.
- A `move` starts at the file's current path; a `delete` names it. Neither applies to a deleted file.
- Each op is checked against the state before the commit. Path keys are checked once, after the whole commit, so that renames in one commit may swap paths.
- A conflict copy names a file and a revision that exist.

### Commit algorithm

The accepted algorithm, as implemented in `SyncEngine` (details in [Sync engine](#sync-engine)):

1. **Upload content first.** Hash the file, then `putIfAbsent("blobs/sha256/<hex>")`. A precondition failure means the blob already exists, which is success. Content is never overwritten.
2. **Catch up.** List `log/` after the local cursor and apply every new commit. Receiving always happens before sending.
3. **Validate.** For each operation, compare `baseRev` with the file's current `rev`:
   - equal: fast-forward;
   - the current content hash equals the new hash: no-op (removes echoes and identical edits);
   - otherwise: three-way merge with base `baseRev`, ours = local, theirs = current. A clean merge produces new content and a new blob; an unclean merge produces a conflict copy (see [Merge and conflicts](merge.md)).
4. **Claim the next sequence number.** `putIfAbsent("log/<cursor+1>.json", commit)`.
5. **On precondition failure**, another writer took that number. Go back to step 2. Steps 2–4 are pure and repeatable, and the `opId` makes duplicates detectable.
6. **Advance the local cursor** only after the commit is durable and applied locally.

Because a writer can create `log/<n>` only after `log/<n-1>` exists and it has read every entry before it, a successful step 4 proves the writer validated against the true current state. The ordering is linearizable without a server. Writers always claim exactly the next number after the last entry they listed, and readers treat a gap in the sequence as corruption and stop rather than skip.

A crash between steps 1 and 4 leaves an unreferenced blob, which garbage collection removes later. A crash after step 4 is safe: the commit exists, and on restart the journal sees its `opId` in the log and does not repeat it.

### Sync engine

Existing behavior. `SyncEngine.sync()` (`packages/core/src/engine.ts`) runs on one device. The host provides `LocalFiles` (the device's files), a `StateStore` (durable state: the head manifest, the synced entry of each file, and a pending claim), and an `Environment` (clock, randomness, IDs).

- **Every local change is conditional.** `LocalFiles.write`, `remove`, and `move` take the content hash the engine expects to find, and change nothing if the user edited the file meanwhile. The engine then restarts its pass. It never overwrites an edit it has not read.
- **Reconcile on the device first, then commit.** Each pass catches up with the log, then brings every synced file up to the head:
  - Local file unchanged: the remote change is written, moved, or removed locally.
  - Changed on both sides: the remote change is merged into the local file with `merge3` (Markdown and `.txt` only). A clean result is written locally. Otherwise, or for other file types, the local version is written as a conflict copy and the head version takes the path.
  - Renamed remotely: the device moves the file; the head's path wins over a local rename. Moves that block each other wait; a cycle goes through a temporary name.
  - Deleted locally but changed remotely: the head version is restored (edit beats delete). Changed locally but deleted remotely: the local file becomes a new file.
  - New on the head: written locally. An untracked local file at the same path key is adopted when equal, merged when one text strictly extends the other, and otherwise moved to a conflict copy name.
  
  A synced entry holds two bases that advance separately, each right after the local change that brings it to the head: the content base (`rev`, `hash`) and the path base (`path`). An interrupted pass therefore never merges content again against an older base, and never mistakes a pending remote rename for a local one.
- **Intents for local writes.** Before a local write that moves a file's content base, the engine saves an intent: the path, the content it requires, the content it will produce, and the new base. If the device stops before the base is recorded, the next sync reads the file: the produced content means the write happened, the required content means it did not. Anything else means the user edited the file since, and its base is unknown; the engine keeps that version as a conflict copy and restores the head version, instead of guessing. (Without this, a file whose content later returns to an older revision could be merged against the wrong base and lose a change.)
- **What is left are the device's own changes against the head**: puts, moves, deletes, and new files, built as ops whose `baseRev` is the head revision. A file whose content and path both changed is moved first and its content committed in the next commit.
- **Claims have a definite outcome.** The engine saves the commit body as a pending claim, then creates `log/<seq>`. A request that may have applied is retried with the identical body at the same `seq`; a precondition failure is resolved by reading the entry and comparing `opId`. A lost claim starts the next pass. After a crash, the pending claim is re-sent the same way. Reconcile also recognises the device's own landed commit by content, so a lost pending claim cannot duplicate work.
- **Retries** of transient storage errors use capped exponential backoff with full jitter (100 ms base, 10 s cap) and honour `Retry-After`.
- **Checkpoints** are written after a commit whose `seq` is a multiple of 500. A device with no state, another vault ID, or another epoch starts from the newest checkpoint and reconciles every file by content.

`AgentWriter.appendLine(path, line)` is the phase 1 agent operation: read the head, append a line, commit with `baseRev` equal to the head revision, and on a lost claim read the new head and compute again. An agent never merges.

### Reading changes

A client remembers its `cursor` (last applied `seq`) and the vault `epoch`. To sync, it lists `log/` with `startAfter = log/<cursor>` and applies commits in order. If `epoch` changed (after a restore), it discards the cursor and reconciles every file by hash. A new device starts from the newest checkpoint and replays only later log entries.

Polling is the default: on launch, on returning to the foreground, after a local save, and every 30 seconds while the app is visible. Each poll is one list request. The optional [relay](relay.md) replaces polling with push.

### Checkpoints and compaction

Any client may write `checkpoints/<seq>.json.gz` after applying `seq`; creation is idempotent. Log entries older than the retention window (a vault setting, default 180 days) and older than a checkpoint may be deleted by an explicit `obsy gc` run, never by the plugin. GC also removes blobs unreferenced by any retained revision, after the soft-delete delay (default 30 days). A device offline longer than the log retention reconciles from the newest checkpoint and treats files whose hashes match tombstones as already deleted rather than new. The defaults and the reasons are in [Retention defaults](../decisions/2026-10-19-retention-defaults.md).

### Integrity and recovery

- Every blob is verified against its SHA-256 when written and read.
- `obsy verify` compares every local file with the head manifest and reports differences.
- History is the log plus immutable blobs. Restoring a file or the whole vault to an earlier `seq` writes new commits; nothing is rewritten.
- `vault.json` `epoch` is bumped after any out-of-band repair, forcing every device to reconcile by hash.
- `obsy export` writes a plain folder copy of any `seq` to another location, so recovery never depends on obsy itself.

## History

- 2026-10-20: Records, commit rules, and the sync engine implemented in phase 1. Checkpoints are uncompressed JSON in format 1. Every op's `baseRev` must equal the current revision; path keys are checked per commit.
- 2026-10-19: Bucket-sequenced protocol accepted, replacing the Durable Object version authority proposed in the [research](../learning/sync-design-research.md). Content moved from the former `DESIGN.md`.
