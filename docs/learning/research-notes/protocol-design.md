---
title: Research notes: protocol design
aliases: [versioning, change feed, deletes, renames, E2EE, testing]
updated: 2026-10-19
---

# Protocol design for safe multi-writer file synchronisation (Mac + iPhone + server-side AI agent; central Durable Object + R2), as of late 2026

Scope note: "obsy" topology = one central authority (a Cloudflare Durable Object, single-threaded, strongly consistent storage) plus R2 blob storage; writers = Mac Obsidian, iPhone Obsidian (often offline), and a server-side AI agent. Source age is marked where it matters. Several core sources (Dropbox Nucleus 2020, Figma 2019, git racy-git 2006, Unison manual) are older but remain the primary engineering references; I found no newer primary source that supersedes them.

## 1. Versioning: server-assigned versions vs version vectors vs HLCs

### Takeaway
With a single central authority that serialises all writes, a per-file server-assigned monotonic version (plus a global change sequence) is sufficient and simpler than version vectors; concurrency is detected by "client's base version != server's current version" (compare-and-swap). Version vectors exist for peer-to-peer topologies without such an authority (Syncthing); HLCs add wall-clock-ish ordering but do not by themselves detect concurrency.

### Cited Findings
- Figma (2019 post, older) rejected CRDTs because "CRDTs are designed for decentralized systems where there is no single central authority"; since "our server is the central authority", "the server is the ultimate authority on what the document looks like", and conflicting property writes resolve to "the last value that was sent to the server." — [Figma blog](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Figma applies local edits immediately and discards "incoming changes from the server that conflict with unacknowledged property changes" to avoid flicker; offline edits are reapplied on top of a freshly fetched copy on reconnect; object IDs are generated client-side because "object creation needs to be able to work offline." — [Figma blog](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- Syncthing (peer-to-peer, no central authority) uses version vectors: a `Vector` of `Counter` entries where "The ID is the first 64 bits of the device ID" and "The Value is a simple incrementing counter"; "The combination of Folder, Name and Version uniquely identifies the contents of a file at a given point in time." — [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Syncthing separately keeps a per-device local sequence: "The clock ticks on every local database update, thus forming a sequence number over database updates", used for delta index exchange (see change feed section). — [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Syncthing records `modified_by` (short device ID of last modifier), which is overwritten on each change and "does not hold history." — [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Linear (per a community reverse-engineering study, not official docs) uses a `lastSyncId`: a database-wide integer incremented on the server per transaction, giving a total order; clients compare their value to the server's to detect being behind. — [reverse-linear-sync-engine (GitHub)](https://github.com/Aslam97/reverse-linear-sync-engine); official post with less detail: [Linear blog](https://linear.app/blog/scaling-the-linear-sync-engine)
- General characterisation: sequence numbers suit cases where a single leader assigns monotonically increasing numbers but "establish order but don't reveal concurrency"; version vectors carry one integer per node and detect concurrency, at the cost of metadata growing with replica count, and only detect (not resolve) conflicts. — [DesignGurus (secondary)](https://www.designgurus.io/answers/detail/explain-sequence-numbers-vs-version-vectors)
- HLC (Kulkarni, Demirbas et al., 2014, older) combines logical and physical clocks; it "captures the causality relationship like logical clocks, and enables easy identification of consistent snapshots in distributed systems." — [HLC paper (PDF)](https://www.cse.buffalo.edu//~demirbas/publications/hlc.pdf); note that HLC values are not unique across nodes and monotonicity is only local — [Andy Matuschak notes](https://notes.andymatuschak.org/Hybrid_logical_clock)
- Dropbox Classic lacked stable IDs ("files lacked a stable identifier that would be preserved across moves"); Nucleus gives "globally unique identifiers" to shared folders/files and supports "atomic moves independent of their subtree size." (2020, older) — [Dropbox: Rewriting the heart of our sync engine](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
- Nucleus protocol: "The protocol guarantees the server and client have the same view of the remote filesystem before considering a mutation" and "clients never observe them in transiently duplicated or missing states." — [Dropbox](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
- Durable Objects: "single-threaded and cooperatively multi-tasked"; each has "a globally-unique name" and "durable, transactional, and strongly consistent storage"; the SQLite backend offers SQL and KV APIs. — [Cloudflare DO docs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- DO `transactionSync` wraps a synchronous callback in a transaction that rolls back on exception; output gates mean "the system will pause outgoing network messages from the Durable Object until all previous writes have been confirmed", and on write failure "the system will reset the Object, discard all outgoing messages." — [DO SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

### Inferences
- For obsy, the DO is a natural single serialisation point: assign `rev` (per-file monotonic, or simply the global sequence number at last write) and a vault-wide `seq`. Every write carries `base_rev`; the DO accepts iff `base_rev == current_rev` (CAS) inside `transactionSync`, else returns conflict with the current rev/hash. Output gates mean an ack is never sent before the commit is durable, which removes a class of "acked but lost" bugs.
- Version vectors become unnecessary because all writes are linearised by the DO; the only "concurrency" is a client writing against a stale base, which CAS detects. Keep per-client `device_id` and `modified_by`/provenance fields for attribution and for Figma-style "ignore echo of my own unacked write", not for ordering.
- Wall-clock timestamps (mtime, HLC) should be informational only (display, LWW tiebreaks for binaries), never the conflict detector.
- File identity: decide explicitly between path-as-identity (simpler; renames = delete+create) and stable file IDs (Nucleus-style; enables atomic move and move+edit merge). Dropbox's experience suggests stable IDs avoid "missing file" failures when one half of a delete+add pair is dropped.

### Gaps
- I found no primary Kleppmann/DDIA text explicitly stating "a central sequencer makes version vectors unnecessary"; the inference above is standard but not directly cited.
- Official Linear documentation of `lastSyncId` semantics not verified (only reverse-engineering).
- Obsidian Sync's internal versioning scheme is not publicly documented (see E2EE section: server holds a mapping used to "determine the version history").
- Git (content-addressed DAG, three-way merge against merge-base) not separately sourced in this pass beyond racy-git; rsync-based tools only via rclone bisync (below).

## 2. Change detection on clients; base version/content; local state database

### Takeaway
Use mtime+size (+inode) only as a fast "definitely unchanged" filter, then confirm with a content hash; store, per path, the last-synced server rev, hash, and (for Markdown) the base content so you can three-way merge. Dropbox's three-tree model (Remote / Local / Synced-as-merge-base) is the reference design for the client state DB.

### Cited Findings
- Racy-git: if a file is modified "so fast" that "`st_mtime` timestamp does not change", cached stat info "still exactly match[es]... even though the file `foo` is now different" ("racily clean"). Git mitigates by content-comparing entries whose mtime is the same as or newer than the index file and by truncating cached `st_size` to zero ("smudging") for racily-clean entries before rewriting the index. (Doc dates to 2006, older but still valid.) — [git racy-git](https://git-scm.com/docs/racy-git)
- Syncthing rescans check "modification time, size, and permission bits"; if any changed it rehashes into SHA-256 blocks (128 KiB–16 MiB). Watcher events are batched 10 s; deletions are delayed a further minute; full scans hourly by default, randomised 3/4–5/4 of interval. — [Syncthing: Understanding Synchronization](https://docs.syncthing.net/users/syncing.html)
- Syncthing block size rule: "the smallest block size that results in fewer than 2000 blocks". — [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Unison: update detection "considers only the contents"; changing mtime alone isn't an update. "Unison uses file modtimes for a quick first pass to tell which files have definitely not changed." With fastcheck, an update may go unnoticed if mtime and length are unchanged, but Unison will never "overwrite such an update with a change from the other replica." Fastcheck defaults to on for Unix, off for Windows. — [Unison manual source](https://raw.githubusercontent.com/bcpierce00/unison/master/doc/unison-manual.tex)
- Dropbox Nucleus three trees (2020): "The Remote Tree is the latest state of the user's Dropbox in the cloud"; "The Local Tree is the last observed state of the user's Dropbox on disk"; "The Synced Tree expresses the last known 'fully synced' state", "the key innovation that lets us unambiguously derive the correct sync result"; "you can think of each node in the Synced Tree as a merge base." Without it, a remote edit could not be distinguished from a local deletion. — [Dropbox: Testing our new sync engine](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine)
- Nucleus planner "output[s] a series of operations to incrementally converge the trees." — [Dropbox testing post](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine)
- rclone bisync "retains the listings of the Path1 and Path2 filesystems from the prior run" and compares each run against them to classify new/newer/older/deleted; `--compare` supports `size`, `modtime`, `checksum`. — [rclone bisync](https://rclone.org/bisync/)
- Syncthing writes to a temp file then moves into place, never writing directly to the destination; temp files are named `.syncthing.<name>.tmp` and ignored. — [Syncthing syncing docs](https://docs.syncthing.net/users/syncing.html)

### Inferences
- Client state DB (SQLite on Mac/iOS) per path: `file_id?`, `path`, `server_rev`, `content_hash`, `size`, `mtime_ns`, `inode/fileID`, `base_blob_ref` (for `.md`), `state` (synced / dirty / uploading / conflict), plus a durable outbound op journal with client-generated `op_id`s. This is the "Synced Tree".
- Treat "stat unchanged AND mtime older than last scan start" as clean; anything within the same timestamp granularity as the scan must be hashed (racy-git lesson). On iOS, file-provider/coordination APIs may change mtimes without content change, so hash-confirm before uploading.
- Store base content for Markdown (cheap) so three-way merge is possible offline; for binaries, store only hash.
- Write downloads atomically (temp + rename) and exclude temp names from scanning, as Syncthing does.

### Gaps
- Obsidian's own client-side change detection mechanism (vault events vs scanning) is not documented in sources fetched.
- iOS-specific mtime/background-execution behaviour not researched here.

## 3. Change feed: cursor pull, long-poll vs WebSocket, idempotency, delivery semantics

### Takeaway
Use a monotonic server sequence as a cursor ("give me changes after seq N"), with WebSocket (hibernating) as a doorbell and HTTP pull as the source of truth; make all mutations idempotent via client op IDs and CAS, giving effectively-once application on top of at-least-once delivery.

### Cited Findings
- Syncthing delta indexes: `{index ID, maximum sequence number}` identifies a point in an index; peers send only items with higher sequence; "it is essential that outgoing index information is ordered by increasing sequence number"; a reset index must get a new random 64-bit Index ID. — [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Linear (reverse-engineered): clients compare local `lastSyncId` to server's to detect being behind; local edits are queued in a transaction queue and sent when the network returns. — [reverse-linear-sync-engine](https://github.com/Aslam97/reverse-linear-sync-engine)
- Durable Objects WebSocket Hibernation API lets idle connections avoid billing. — [Cloudflare DO docs](https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/)
- DO output gates hold outgoing messages until writes are confirmed. — [DO SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- MCP filesystem server annotates `edit_file` as non-idempotent ("Re-applying edits can fail or double-apply") while `write_file` is idempotent but destructive. — [MCP filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)

### Inferences
- Feed design: `GET /changes?since=<seq>&epoch=<vault_epoch>` returns ordered entries `{seq, path, file_id, rev, hash, deleted, size, modified_by, ts}`; client advances cursor only after durably applying. Include a vault `epoch` (Syncthing Index ID analogue) so that a server restore/reset forces clients into a full reconcile instead of trusting a stale cursor.
- Push: WebSocket message "seq advanced to N" only; clients then pull. Lost pushes are harmless. Long-poll is a fallback for iOS background constraints.
- Uploads: two-phase — PUT blob to R2 keyed by content hash (idempotent by construction), then `commit {op_id, path, base_rev, new_hash}` to the DO. DO stores `op_id` results so retries return the original outcome (exactly-once effect). Content-addressed blobs also make retries and dedup free.
- Edit-style operations (patches) are non-idempotent; they must be wrapped with `base_rev`/expected-hash so a retry after success fails CAS cleanly rather than double-applying.

### Gaps
- No primary source fetched comparing long-poll vs WebSocket for sync specifically; Dropbox's `list_folder/longpoll` cursor API is a known precedent but was not fetched in this pass.

## 4. Deletes and renames

### Takeaway
Represent deletes as tombstones with a rev (never just absence), keep tombstones at least as long as any client could be offline, and decide explicitly that edit-beats-delete (resurrect as a normal file, as Syncthing does) for data safety. Renames are either delete+create (path identity) or a first-class move op on a stable file ID; case-only renames need special handling on case-insensitive filesystems (macOS/iOS).

### Cited Findings
- Syncthing tombstones: `deleted` flag, block list "SHALL be of length zero", modification time = deletion time. — [Syncthing BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Syncthing modify-vs-delete: if the deletion wins, the modified file is renamed to a conflict copy. — [Syncthing syncing docs](https://docs.syncthing.net/users/syncing.html). Forum statement (not official docs): Syncthing remembers deletions, but if a file changed on an offline device (even a modtime bump) it conflicts with the delete and "for conflicts, deletions always loose" / "Existing files always win the conflict with a delete" — [Syncthing forum](https://forum.syncthing.net/t/what-happens-if-a-syncthing-node-is-down-for-a-longer-period-of-time-deletions-reintroduced-files/14466). (These two sources frame the outcome slightly differently; both preserve the edited content.)
- Resurrection in practice: deleted folders kept reappearing until a stale node still configured with the device, and a node that had been offline, were found. — [Syncthing forum](https://forum.syncthing.net/t/deleted-folders-keep-re-appearing/19290)
- Dropbox Classic represented moves as delete+add, so a dropped request could leave a file missing; Nucleus uses stable IDs and atomic moves; for "two users move folders into each other", Nucleus keeps the original directories, order depending on which move uploads first. (2020) — [Dropbox](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
- Syncthing paths are case-sensitive; on Windows/macOS/(partly) Android a clashing remote case variant can't be synced and is reported as a case conflict; with two differing remote variants, "which one wins is not predictable"; before v1.9.0 the same file could be accessed under two case-differing names. Names are normalised to UTF-8 NFC with "/" separators. — [Syncthing syncing docs](https://docs.syncthing.net/users/syncing.html); [BEP v1](https://docs.syncthing.net/specs/bep-v1.html)
- Syncthing delays deletions from the watcher by a further minute. — [Syncthing syncing docs](https://docs.syncthing.net/users/syncing.html)
- LiveSync: deletions recorded either as a logical deletion in metadata or a PouchDB tombstone; automatic cleanup after N days (0 disables); remote deletion follows Obsidian's trash preference via `FileManager.trashFile`. — [LiveSync settings](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md)
- rclone bisync: without a valid prior listing a delete cannot be propagated; "if you included `--resync` for every bisync run, it would never be possible to delete a file". — [rclone bisync](https://rclone.org/bisync/)
- Obsidian Sync: deleted files are listed under Settings → Sync → Deleted files and restorable from version history to the original location. — [Obsidian Help: Version history](https://obsidian.md/help/sync/version-history)

### Inferences
- Classic cases for obsy (server = DO):
  - Deleted on A, edited on B offline: B's commit has `base_rev` = pre-delete rev; server sees current = tombstone → conflict. Safe policy: restore the file with B's content (edit wins), notify. Never apply a delete whose `base_rev` is not the current rev.
  - Edited on A, deleted on B offline: B's delete has a stale `base_rev` → reject delete; B re-downloads A's version.
  - Move + edit: with path identity this becomes delete(old)+create(new) racing an edit(old) → edit-wins resurrects old path, producing a duplicate. With file IDs, move and content edit commute. Obsidian's link-updating on rename also edits many other files, amplifying races — favours stable file IDs or at least treating rename as an atomic server op.
  - Folder delete: expand to per-file tombstones server-side with CAS per child; any child with a newer rev than the deleter saw survives (Nucleus-style "don't delete what you haven't seen").
  - Case-only rename (`Note.md`→`note.md`) on APFS case-insensitive volumes: implement as a two-step rename via a temp name; server should reject two live paths that differ only by case/Unicode normalisation (compare NFC + casefold key).
- Tombstone GC: keep tombstones for longer than the maximum allowed client offline window; a client whose cursor predates the GC horizon must do a full reconcile (hash compare) and must not upload "new" files that match tombstoned hashes without asking — this is the resurrection guard.

### Gaps
- No primary source found specifying Obsidian Sync's rename semantics or tombstone retention.
- No primary source found with an explicit rename-detection-by-hash algorithm for a file sync tool (git's similarity-based rename detection was not fetched).

## 5. Initial sync and joining a device with diverged files; mass-delete safety rails

### Takeaway
On first join, treat the relationship as "no merge base": never infer deletes, upload/download only unions, and mark same-path/different-content pairs as conflicts (Unison's rule). Add hard rails: abort when a batch would delete more than a threshold (rclone defaults to 50%), and require a sentinel/access check so an unmounted or empty folder is never interpreted as "user deleted everything".

### Cited Findings
- Unison: if archives are missing or unreadable, it "behaves as though the replicas had both been completely empty at the point of the last synchronization", so files present on both sides that differ are "marked as conflicting." — [Unison manual source](https://raw.githubusercontent.com/bcpierce00/unison/master/doc/unison-manual.tex)
- Unison safety claims: "it is safe to interrupt Unison at any time, either manually or accidentally"; separate archive files per pair of roots. — [Unison manual source](https://raw.githubusercontent.com/bcpierce00/unison/master/doc/unison-manual.tex). A 6.033 critique reports Unison's authors argue "the most important goal of any file synchronizer is safety" and notes that if one archive can't be read Unison may delete files in the other (older) — [MIT 6.033 2010](https://web.mit.edu/6.033/2010/wwwdocs/assignments/unison.shtml)
- rclone bisync: `--max-delete` default 50% — aborts if more than that percent of files were deleted; `--check-access` requires matching `RCLONE_TEST` files on both paths as "an additional safety measure against data loss"; most interruptions require `--resync` unless `--resilient`/`--recover`; `--resync` should be used only in rare circumstances. — [rclone bisync](https://rclone.org/bisync/)
- Obsidian Sync: if a local note is created and a remote version downloads within a couple of minutes, "Sync will keep the remote version without merging the two"; local version recoverable via File recovery. — [Obsidian Help: Troubleshoot](https://obsidian.md/help/sync/troubleshoot)
- Syncthing: resetting the database forces full rescan/resync and can produce inconsistent versions if an older tree reappears (forum/third-party). — [Syncthing forum](https://forum.syncthing.net/t/deleted-folders-keep-re-appearing/19290)
- LiveSync README: "Before installing or upgrading this plug-in, please back up your vault"; don't run alongside another sync solution; consult the recovery guide before resetting a remote database. — [LiveSync README](https://github.com/vrtmrz/obsidian-livesync/blob/main/README.md)

### Inferences
- Join protocol for obsy: (1) client enumerates local files and hashes; (2) fetches server manifest; (3) identical hash → adopt server rev as base; local-only → upload; server-only → download; both differ → conflict copy (or three-way merge impossible: no base) — never delete anything during join. (4) Only after join completes does the client record a Synced Tree and begin propagating deletes.
- Rails: per-batch delete threshold (count and %), with user confirmation; refuse to propagate deletes when the vault root is missing/empty or a sentinel (e.g. `.obsy/vault-id`) is missing or mismatched; vault-ID binding prevents syncing vault A into vault B's server state.
- Seeding: first device uploads; server should accept an initial bulk import as a distinct op type for audit/rollback.

### Gaps
- Unison `confirmbigdeletes` text could not be retrieved from the manual excerpt fetched.
- No Obsidian Sync documentation found on mass-delete protection.

## 6. Conflict handling: Markdown merge, conflict copies, binaries

### Takeaway
Three-way merge for Markdown against the stored base, with a conflict-copy fallback; last-writer-wins or conflict copies for binaries. Obsidian Sync's diff-match-patch auto-merge is known to sometimes duplicate text; a true three-way, token-level merge (e.g. reconcile-text) is safer for prose.

### Cited Findings
- Obsidian Sync: Markdown conflicts merged "using Google's diff-match-patch algorithm"; "For all other files, including canvases, Obsidian uses a 'last modified wins' approach"; settings JSON merged by applying local keys on top of remote. Since 1.9.7, choice of "Automatically merge" (default; "may sometimes create duplicate text or formatting problems") or "Create conflict file"; setting is device-specific. — [Obsidian Help: Troubleshoot](https://obsidian.md/help/sync/troubleshoot)
- Obsidian conflict naming: `original-note-name (Conflicted copy device-name YYYYMMDDHHMM).md`, e.g. `Meeting notes (Conflicted copy MyMacBook2 202411281430).md`; "The original file keeps the remote version." — [Obsidian Help: Troubleshoot](https://obsidian.md/help/sync/troubleshoot)
- Syncthing: the file with the older mtime is marked conflicting and renamed; equal mtimes tie-break on device ID; naming `<filename>.sync-conflict-<date>-<time>-<modifiedBy>.<ext>`; conflict files then sync like normal files. — [Syncthing syncing docs](https://docs.syncthing.net/users/syncing.html)
- rclone bisync default keeps both and renames, e.g. `file.txt.conflict1`; `--conflict-loser delete` is "inherently the most destructive option". — [rclone bisync](https://rclone.org/bisync/)
- LiveSync: automatic merge "only when the available revision history supplies a safe shared base"; "Always overwrite with newer file" is "Testing only" and "cannot establish which revision reflects the user's intent"; "Resolve All by newer file" is "a destructive policy choice." — [LiveSync settings](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md)
- reconcile-text (Schmelczer, 2024–2026): sync engines only see snapshots ("text files on disk can be edited in Obsidian, Vim, or VS Code and updated through Syncthing or even OneDrive"); git union driver: "independent word-level edits can duplicate whole lines" and "overlapping deletions can restore or reorder text that one side deleted"; diff-match-patch "applies two-way patches heuristically rather than reasoning over a common ancestor", so "failed patches can lose edits"; word/sentence tokens are never split; merged Markdown may not be syntactically valid; premise: "a slightly imperfect sentence is usually better than conflict markers." — [reconcile-text article](https://schmelczer.dev/articles/reconcile-text-3-way-merge/)
- Choice of token unit matters: word-level turns most prose conflicts into coexisting edits; line-level behaves like `git merge-file`; Markdown-level merges on headings/list items. — [reconcile-text via search summary](https://schmelczer.dev/articles/reconcile-text-3-way-merge/)
- Three-way merge mechanics: sync regions are where both descendants match the base; regions between are one-sided changes or conflicts. — [bzrlib Merge3 docs](https://people.canonical.com/~mwh/bzrlibapi/bzrlib.merge3.Merge3.html). Base choice changes which conflicts appear (2005, older) — [bazaar mailing list](https://lists.snapcraft.io/archives/bazaar/2005q4/004023.html)

### Inferences
- Policy for obsy: Markdown → server or client performs three-way merge (base = client's stored base at `base_rev`, ours = client, theirs = server current). If merge is clean, commit merged result as a new rev and record "auto-merged" provenance; if overlapping edits, keep server version at the path and write the losing side as a conflict copy using an Obsidian-familiar name, and surface it in UI. Never silently pick LWW for Markdown.
- Frontmatter (YAML) deserves key-level merge (like Obsidian's JSON merge) rather than text merge.
- Binaries (images, PDFs, canvases): no merge; conflict copy rather than LWW (LWW is what Obsidian does and silently loses data).
- Do merges in one place (preferably the client, which has the base and user context; or server if it retains bases by rev). Keeping all historical revs in R2 means the server can always reconstruct the base from `base_rev`.

### Gaps
- No published accuracy/failure-rate data for diff-match-patch vs three-way merges on real notes.
- Obsidian `.canvas` JSON merge semantics beyond LWW not documented.

## 7. End-to-end encryption and the server-side agent trade-off

### Takeaway
E2EE and a server-side agent that reads/writes notes are fundamentally in tension: if the server-side agent can decrypt, the server holds a key and the system is no longer E2EE for that content. Options are (a) no E2EE, strong transport/at-rest encryption, (b) E2EE with agent-accessible folders excluded/plaintext, (c) give the agent a scoped key (honest labelling: not E2EE for those notes), or (d) run the agent client-side.

### Cited Findings
- Obsidian Sync: "AES-256 using Galois/Counter Mode (GCM)"; KDF "scrypt with salt"; E2EE is the default for new remote vaults; "Standard encryption uses an encryption key managed by Obsidian"; paths are encrypted but some metadata is "not end-to-end encrypted", including "the mapping between encrypted file paths and encrypted content"; "We're not able to recover your password, or any encrypted data for you"; a guide exists to verify E2EE. — [Obsidian Help: Security](https://obsidian.md/help/sync/security)
- A forum thread notes Obsidian's full E2EE design is not publicly documented in detail. — [Obsidian forum](https://forum.obsidian.md/t/description-of-end-to-end-encryption-scheme/112836)
- LiveSync: E2EE passphrase must be the same on all devices; changing it requires a database rebuild; `v2` algorithm is default; path obfuscation is off by default "to improve the performance". — [LiveSync settings](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md)
- Joplin: random master keys encrypted with the user's password and synced; "Only one master key can be active for encryption purposes"; items encrypted only at sync time (not locally); "JED" header includes master key ID; disabling E2EE must be done on every client because sync is stateless; mixed encrypted/unencrypted states are supported but messy; master keys can't be deleted. Algorithms not named on the spec page. — [Joplin E2EE spec](https://joplinapp.org/help/dev/spec/e2ee/)
- Standard Notes: password → KDF; half kept as master key on device, half sent as server password; random items keys encrypted by master key encrypt notes/tags/prefs; data encrypted with XChaCha20-Poly1305, Argon2 for password stretching. — [Standard Notes encryption whitepaper](https://standardnotes.com/help/security/encryption); [Standard Notes help](https://standardnotes.com/help/3/how-does-standard-notes-secure-my-notes)
- Anytype/any-sync: spaces stored as encrypted DAGs; backup nodes store data they cannot read; keys controlled by users; conflicts resolved on device (CRDT-based). — [any-sync (pkg.go.dev)](https://pkg.go.dev/github.com/anyproto/any-sync@v0.9.8)
- Trade-off statement (vendor blog, one-sided): a cloud model must read notes to summarise them; "if the server holds a key that can turn your ciphertext back into readable notes, then it is not end-to-end encrypted any more"; Proton's Lumo is cited as an example where the model sees decrypted text. — [Calmara blog](https://calmara.app/blog/why-ai-note-apps-arent-end-to-end-encrypted)

### Inferences
- For obsy, honest options: (1) Per-folder policy: an `agent/` (or explicitly shared) subtree stored with server-readable keys, everything else E2EE; the agent can only append/propose into its subtree, and humans move content out. (2) Agent-held vault key in a separate secret store (Workers secret / KMS) — functionally "standard encryption" à la Obsidian, and should be labelled so. (3) Agent proposals encrypted to the client's public key, with the client decrypting/applying — the agent can write but not read (useful for capture/inbox, not for editing existing notes).
- E2EE complicates server-side three-way merge and hash-based dedup (hashes of plaintext leak equality; use keyed hashes/HMAC if E2EE).
- Encrypted filenames + server mapping (Obsidian's approach) still leak structure/size/timing metadata.

### Gaps
- Exact Obsidian Sync E2EE construction (nonce handling, filename encryption method) not public.
- Joplin's current algorithm list and Anytype's key distribution/rotation not found in fetched sources.
- No primary source found describing a production system that grants a server-side agent scoped decryption of selected folders.

## 8. Integrity and recovery

### Takeaway
Content-address every blob by SHA-256, keep immutable revision history in R2, use DO SQLite PITR (30 days) for metadata disasters, and provide a verifier that compares a client vault's hashes against the server manifest. Retention should be at least as long as the tombstone/offline window.

### Cited Findings
- Syncthing verifies received/copied blocks against expected SHA-256 hashes before writing. — [Syncthing syncing docs](https://docs.syncthing.net/users/syncing.html)
- DO SQLite PITR: restore "to any point in time in the past 30 days" via `getBookmarkForTime` and `onNextSessionRestoreBookmark`, then typically `ctx.abort()` to restart. — [DO SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
- Obsidian Sync retention: Plus keeps notes/settings versions 12 months, Standard 1 month; attachments two weeks on both; older versions are permanently deleted; local File recovery plugin keeps per-device snapshots, while Sync's history is the only cross-device record. — [Obsidian Help: Version history](https://obsidian.md/help/sync/version-history)
- Dropbox treats any client/server view discrepancy as a bug. — [Dropbox](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
- Anthropic text editor tool guidance: "Always create backups before allowing edits to important files." — [Anthropic text editor tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)

### Inferences
- R2 layout: `blobs/<sha256>` immutable; DO table `revisions(path/file_id, rev, hash, deleted, actor, op_id, ts)`; never overwrite blobs; GC only unreferenced blobs past retention.
- Point-in-time vault restore = replay manifest at seq N, written as new revisions (forward restore), so clients sync it normally rather than via cursor rewind. DO PITR is the backstop for metadata corruption; after a PITR restore, bump the vault `epoch` so clients full-reconcile.
- "Verify" command: client hashes all files, server returns manifest at current seq, diff reported; also a periodic server self-check that every manifest hash exists in R2.
- Export: periodic plain-tree export (zip of latest revisions) to a second location for vendor-independent backup.

### Gaps
- R2 durability/versioning features and costs not researched in this pass.

## 9. AI agent as a writer: not clobbering human edits

### Takeaway
Treat the agent as just another client that must use CAS with an expected base rev/hash, prefer narrow operations (append to marked blocks, section-scoped replace with unique anchors) over whole-file writes, record provenance on every revision, and make agent changes reviewable and reversible (branch/proposal model per Ink & Switch, checkpoints per Claude Code). Avoid writing files that are currently being edited.

### Cited Findings
- Ink & Switch Patchwork "AI bots in version control" (March 19, 2024): the style bot "makes changes as another collaborator"; edits go on a branch you can "partially or completely merge"; changes are shown as a highlighted diff; "the history timeline also shows which edits came from the bot"; a variant where "the bot leaves comments with edit rationale" helped users decide; AI tools "can also give bad suggestions or make mistakes". — [Ink & Switch notebook 07](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/07/)
- Anthropic text editor tool: `str_replace` must match exactly one location; errors "Found 3 matches for replacement text. Please provide more context to make a unique match." and "No match found for replacement"; implementer guidance: "Validate file paths to prevent directory traversal", "Create backups before making changes", "Make sure replacements match exactly one location to avoid unintended edits." — [Anthropic text editor tool docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)
- Claude Code: edits fail if the file changed since last read (community guide; intentional to avoid overwriting concurrent changes) — [TinyCore Studios guide](https://tinycorestudios.uk/blog/guides/2026-04-12-file-editing-reading-writing-and-navigating-code/); "string not found" often caused by formatters/editors rewriting between read and edit — [Morph LLM](https://www.morphllm.com/common-errors/string-to-replace-not-found-in-file)
- Claude Code checkpointing: automatically tracks file edits, checkpoint per user prompt, rewind; only Write/Edit/NotebookEdit tool changes are tracked (not bash); not a substitute for version control; cleaned up with sessions after 30 days (configurable). — [Claude Code checkpointing docs](https://code.claude.com/docs/en/checkpointing); [Agent SDK file checkpointing](https://code.claude.com/docs/en/agent-sdk/file-checkpointing)
- MCP reference filesystem server: `edit_file` provides "Git-style diff output with context" and `dryRun` ("Always use dryRun first to preview changes"); server "may touch only its allowed directories"; client Roots replace server allow-list and an update with no valid roots "revokes access"; Roots deprecated for 2026-07-28 protocol connections; annotations mark `write_file`/`edit_file`/`move_file` destructive, `edit_file` non-idempotent. — [MCP filesystem server](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem)
- Obsidian MCP servers (self-reported listings, unaudited): cyanheads/obsidian-mcp-server offers overwrite protection, append/patch/search-replace, and human confirmation for deletes where supported — [mcp.so listing](https://mcp.so/servers/obsidian-mcp-server?tab=tools); MCPVault uses AST-aware YAML updates preserving frontmatter formatting and path-traversal protection — [MCPVault docs](https://docsearch.algolia.com/mcp/docs/repo/bitbonsai/mcpvault); "Native MCP" plugin advertises surgical edits and hash-based concurrency safety without whole-file rewrites (not reviewed by Obsidian staff) — [Obsidian community plugin page](https://community.obsidian.md/plugins/native-mcp)
- Heading/frontmatter-targeted edits that leave the rest of the note untouched are contrasted with read-modify-overwrite (vendor article). — [mcpbundles blog](https://docs.mcpbundles.com/blog/obsidian-mcp-vault-ai)
- Research: an ACM paper on multi-user + AI agent document editing built on Yjs (CRDT) and found concerns about interruptions and responsibility. — [arXiv 2509.11826](https://arxiv.org/pdf/2509.11826) / [ACM DL](https://dl.acm.org/doi/10.1145/3772318.3790648)
- Harvey (legal drafting agent): earlier design was fragile because the model acted as "both a legal reasoning engine and a state machine simultaneously"; moved to building the document in memory. — [Harvey blog](https://www.harvey.ai/blog/building-an-agent-for-complex-document-drafting-and-editing)
- MIT 2025 AI Agent Index: developer/CLI agents commonly require explicit confirmation for sensitive operations like file edits. — [2025 AI Agent Index (PDF)](https://aiagentindex.mit.edu/data/2025-AI-Agent-Index.pdf)

### Inferences
- Agent write API on the DO (not raw file PUT): `append_block(file, block_id, text, expected_rev)`, `replace_section(file, heading_path, expected_section_hash, new_text)`, `create_file(path, if_absent)`, `propose_patch(file, base_rev, diff)`; whole-file overwrite disallowed for existing human files. Section ops re-anchor at commit time on the current rev, so they commute with human edits elsewhere in the note (rebase instead of fail when the target section's hash still matches).
- Marked blocks (e.g. `<!-- obsy:agent id=... -->` ... `<!-- /obsy:agent -->` or a callout) give the agent a region it owns; humans editing inside it convert it to human-owned.
- "File is open in an editor" signal: clients report presence/focus (path + last keystroke time) over the WebSocket; the DO defers agent writes to that path (or downgrades them to proposals) while it is hot. This also reduces the iPhone/Mac merge burden.
- Provenance: every revision row records `actor` (device/human vs agent + run/tool-call id); optional frontmatter footprint is less reliable than server metadata. Undo = write a new revision restoring the pre-agent content of exactly the agent's revision(s), via CAS; refuse if humans have since edited (fall back to three-way revert).
- Proposals as a "branch": store agent patches server-side and render them in a review note or plugin UI; apply on accept (Patchwork model).

### Gaps
- No primary 2025–2026 source found that specifies a sync-level protocol for agent writes into a live, multi-device file vault; the patterns above are synthesized from adjacent sources.
- Obsidian MCP server claims are vendor/self-reported.

## 10. Testing strategies for sync correctness

### Takeaway
Deterministic simulation testing with seeded randomness, mocked filesystem/network/time, fault injection, and convergence/no-data-loss invariants is the proven approach (Dropbox Nucleus, FoundationDB, TigerBeetle). Pair with property-based planner tests that minimise failing cases.

### Cited Findings
- Dropbox CanopyCheck (2020): generates one random tree, perturbs it into the other two, asks planner for ops, shuffles them, marks success without I/O, repeats; invariants: termination within 200 iterations, no panics, all three trees converge; QuickCheck-style minimisation: "CanopyCheck searches for the minimal input by iteratively removing nodes." — [Dropbox testing post](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine)
- Dropbox Trinity: in-memory mock FS that injects errors, reorders requests, simulates crashes via snapshot/restore (~10x faster than native); mock server that reorders/delays/fails RPCs; mockable timer; acts as custom executor; re-runs seeds to confirm determinism; "Losing data the user intended to sync to Dropbox must be avoided at all costs"; "All randomized testing frameworks must be fully deterministic and easily reproducible"; "Every night we run tens of millions of randomized test runs"; Heirloom (real server) ~100x slower. — [Dropbox testing post](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine)
- Nucleus architecture choice for testability: single "Control thread", deterministic given fixed inputs/scheduling; invariants encoded in Rust's type system; "run millions of scenarios every day." — [Dropbox](https://dropbox.tech/infrastructure/rewriting-the-heart-of-our-sync-engine)
- TigerBeetle VOPR: all non-deterministic parts (clock, network, disk) stubbed; seed chooses faults (dropped/reordered packets, partitions, corrupted disk I/O); seed + git commit replays a bug; "3.3 seconds of VOPR simulation gives you 39 minutes of real-world testing time"; inspired by Dropbox Nucleus testing and FoundationDB. — [TigerBeetle VOPR docs](https://docs.tigerbeetle.com/about/vopr); 2026 post on protocol-aware DST testing safety/liveness per replica — [TigerBeetle blog, 2026-08-20](https://tigerbeetle.com/blog/2026-08-20-protocol-aware-dst)
- FoundationDB (SIGMOD 2021) includes a deterministic simulation framework for testing against many faults — [CACM](https://cacm.acm.org/?p=227399); practical DST pioneered at FoundationDB and AWS around 2010 — [Antithesis](https://antithesis.com/resources/deterministic_simulation_testing/)

### Inferences
- For obsy: write the sync core (client planner + DO commit logic) as pure functions over (Remote manifest, Local tree, Synced tree, op journal) so it can run in a single-threaded simulator with N simulated clients (Mac, iPhone, agent), simulated offline periods, crashes between "blob uploaded" and "commit", duplicate/reordered messages, and racy mtimes.
- Invariants: (1) convergence when quiescent; (2) no acknowledged human byte is lost — every acknowledged revision's content is reachable at a live path, conflict copy, or history; (3) no delete applies to a rev the deleter didn't observe; (4) agent never commits without matching expected rev; (5) idempotency — replaying any op journal yields the same state.
- Property-based tests for the three-way merge (merge(base, x, base) == x; merge(base, x, y) contains both non-overlapping edits) and for path normalisation/case-folding.
- A small TLA+/model of the CAS commit + cursor protocol is cheap given the single-sequencer design; I found no public TLA+ spec for a file sync tool to reuse.

### Gaps
- No published reusable sync-conformance test suite found (e.g. Syncthing's integration tests or Unison's test harness were not fetched).
- No TLA+ models of file sync protocols located in this pass.
