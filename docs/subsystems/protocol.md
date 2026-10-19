---
title: Protocol and core sync engine
aliases: [bucket protocol, object layout, commit log, commit algorithm, change feed, checkpoints, compaction, gc, records, protocol, core]
updated: 2026-10-19
---

# Protocol and core sync engine

## Current

Status: accepted design, not yet implemented. Packages: `@obsy/protocol` (layout, schemas, validation) and `@obsy/core` (planner, commit loop, journal, change feed reader, agent operations).

The bucket orders every change by itself. Every writer tries to create the next numbered log entry with a conditional create. Exactly one succeeds; the others re-read, rebase, and retry. The provider requirements for this are on [Storage adapters](storage.md). The reasons are in [The bucket is the sequencer](../decisions/2026-10-19-bucket-as-sequencer.md).

### Object layout

All keys live under a configurable vault prefix.

| Key | Mutability | Content |
| --- | --- | --- |
| `vault.json` | `If-Match` only | Vault ID, format version, epoch, created time, settings that every client must agree on |
| `log/<seq>.json` | Create once | One commit: ordered file operations, author, device, operation ID, time |
| `blobs/sha256/<hex>` | Create once | File content, addressed by SHA-256 |
| `checkpoints/<seq>.json.gz` | Create once | Full manifest at `seq`, so new devices need not replay the whole log |
| `proposals/<id>.json` | Create once | Agent edits that could not be applied safely, for the owner to review |
| `presence/<device>.json` | Overwrite | Device heartbeat and the note being edited, for agent deferral |
| `devices/<device>.json` | `If-Match` | Device name, public metadata, last seen cursor |

`<seq>` is a zero-padded 16-digit integer, so lexicographic listing is numeric order.

### Records

A commit (`log/<seq>.json`):

```json
{
  "format": 1, "seq": 1043, "epoch": 1,
  "opId": "dev-mac:7f3c…", "actor": { "kind": "device", "id": "dev-mac" },
  "time": "2026-10-19T17:02:11Z",
  "ops": [
    { "type": "put", "fileId": "f_9a1…", "path": "journals/2026-10-19.md",
      "baseRev": 1031, "hash": "sha256:…", "size": 1820, "merge": { "parents": [1031, 1040] } },
    { "type": "move", "fileId": "f_77b…", "from": "inbox/idea.md", "to": "projects/idea.md", "baseRev": 998 },
    { "type": "delete", "fileId": "f_120…", "path": "old.md", "baseRev": 640 }
  ]
}
```

- **File identity** is a stable `fileId` created by the device that first creates the file. Path is an attribute, so a rename is one atomic `move`, not a delete plus a create.
- **`rev`** of a file is the `seq` of the commit that last changed it. Every operation carries the `baseRev` it was made against.
- **Paths** are stored as written. Matching uses a key of Unicode NFC plus case folding, and two live files may not share a key. This prevents macOS/iOS case and normalisation twins.
- **Actor** is `device`, `agent`, or `system`, with an ID. Agent commits also record the run and tool-call IDs.

A checkpoint maps every `fileId` to `{ path, rev, hash, size, kind, deleted }` at its `seq`.

### Commit algorithm

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

- 2026-10-19: Bucket-sequenced protocol accepted, replacing the Durable Object version authority proposed in the [research](../learning/sync-design-research.md). Content moved from the former `DESIGN.md`.
