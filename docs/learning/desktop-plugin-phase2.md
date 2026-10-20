---
title: Desktop plugin, phase 2
aliases: [phase 2 results, desktop results, plugin results, vault copy run, adapter mutation check, occluded window]
updated: 2026-10-21
---

# Desktop plugin, phase 2

## Current

Status: observed results, 2026-10-21. The plugin synced generated vaults and a copy of a real vault between Obsidian desktop windows on macOS, and every phase 2 check passed. The plugin is on [Obsidian plugin](../subsystems/obsidian-plugin.md); the test is in the [desktop plugin test runbook](../runbooks/desktop-plugin-test.md).

### Question

Phase 2 on the [roadmap](../roadmap.md) is done when a copy of a vault, joined pull-only, converges and `verify` shows no differences, and when forced conflicts produce correct copies. Does the vault adapter keep the engine's invariants against an editor and a user who saves at any time? Do pull-only runs and the rails keep the simulator's invariants?

### Method

- **Machine:** Apple M4 Pro, macOS, Node 24.21.0, Obsidian 1.14.4 desktop.
- **Adapter tests** (`pnpm test`): `VaultLocalFiles` on a fake vault that models open editors, unsaved edits, and user saves before a read, after a read (while obsy hashes), and before `vault.process`. Random runs: a Mac on the fake vault and a phone in memory; 80 steps of edits, typing into open notes at random lines, renames, deletes, and syncs, then a quiet phase. A run passes when both devices hold the same files and every line that no user removed exists.
- **Mutation check:** plant a bug in the adapter, run 1,000 or 2,000 random seeds, count failures.
- **Simulator:** the phase 1 simulator, with one sync in five pull-only and the rail check on every pass ([runbook](../runbooks/simulator.md)).
- **Desktop test:** three vault windows in one Obsidian with its own profile folder, against versitygw in Docker ([runbook](../runbooks/desktop-plugin-test.md)). Sources: the generated scratch vault (40 files), and a copy of a real vault (410 files, 23 MB, plus the 40 scenario files).

### Results

#### Adapter and service tests

- 20,000 random seeds: no failures. `pnpm test` runs 400 (about 3 s).
- Unit tests pass for conditional writes, editor transactions, unsaved edits, CRLF and byte order mark notes, binary files, temporary files, path twins, the IndexedDB store, the scheduler, and the service (connect, pull-only join, rails, the folder marker, one operation at a time). `pnpm test`: 463 tests in 25 files.

Mutation check, final settings (40% chance of a user action at each adapter read point):

| Planted bug | Seeds failed |
| --- | --- |
| Write into an open note without checking for unsaved edits | 17 of 1,000 |
| No size and mtime check after hashing | 32 of 1,000 |
| `vault.process` writes without comparing the current text | 34 of 1,000 |

With the first settings (8%, 40 steps) the same bugs failed in only 5 to 7 of 2,000 seeds, and before typing went to random lines the first bug failed in none. The settings were raised so that 400 seeds catch each bug with high probability.

#### Simulator

`node packages/simulator/dist/cli.mjs --seeds 1000000 --workers 10`: seeds 1 to 1,000,000, 0 failures, 2,080 s.

| Total over all seeds | Count |
| --- | --- |
| Syncs started / pull-only / finished | 6,188,322 / 1,237,090 / 3,651,216 |
| Device crashes | 2,537,106 |
| Device commits during the run / in the quiet phase | 4,015,483 / 625,346 |
| Conflict copies | 2,514,348 |
| Syncs that ended with an unexpected error | 0 |

#### Desktop test

Final code: four runs, 11 of 11 steps each (three with the generated vault, one with the vault copy). Earlier runs during development are in [Findings](#findings).

| Measure | Generated vault (3 runs) | Vault copy (1 run) |
| --- | --- | --- |
| Files | 40 | 450 |
| Create and upload | 323–347 ms, 1 commit | 1,926 ms, 1 commit |
| Pull-only join of an identical copy | 136 ms; verify: no differences; nothing sent | 247 ms; verify: no differences; nothing sent |
| Pull-only join of an empty vault | 346–738 ms; verify: no differences | 2,669 ms; verify: no differences |
| Forced conflicts (one note line, one binary) | Two conflict copies with the second device's versions, on both devices | Same |
| Automatic sync: edit committed / reached the other device | 2.0–3.1 s / 20–29 s | 2.3 s / 24 s |
| Mass delete | 11 of 42 files: stopped and asked on both devices | 51 of 452 files: same |
| End | Both folders equal the head; verify: no differences | Same |

Every run also checked: edits on different lines merged with no conflict copy; a remote edit to an open note arrived through the editor with the cursor kept; typing not yet saved was kept and merged; rename, delete (into `.trash`), and a file written by another program synced; Cancel at a rail sent nothing; no credential value was in any `data.json`. The arrival time is bounded by the other device's 30 s poll.

### Findings

- **macOS reports a covered window as hidden.** In two of three early runs, an edit was not committed within 20 s: the window was behind another one, `document.visibilityState` was `hidden`, and the plugin paused as designed for iOS. Desktop now does not pause ([decision](../decisions/2026-10-21-desktop-plugin-choices.md)); the step then passed in all 17 later runs.
- **The UTF-8 decoder dropped a byte order mark.** `decodeUtf8Strict` used `TextDecoder` without `ignoreBOM`, so the engine merged notes without their mark and wrote them back without it. `@obsy/protocol` now keeps it; an engine test fails without the fix.
- **A stale path index stalled syncs.** The adapter's path index was rebuilt only on vault events. Without them, a file the user deleted still blocked a create, and the engine retried until it gave up. The index is now rebuilt by every `list`.
- **User changes between check and write threw errors.** A file removed, or a path taken, between the adapter's check and its write raised an error that ended the sync. These now count as failed conditions, and the engine starts its pass again.
- **A save while obsy hashed could be trashed.** A user save that landed after obsy read a file and before it trashed it removed the new content from the vault. The adapter now checks size and mtime after hashing. A save that lands while Obsidian itself trashes or writes a binary file is still possible.
- **Two harness bugs** looked like losses at first: the test closed an editor without saving (Obsidian saves on close), and a dialog appeared after the test's 20 s wait while the simulator used 10 cores. Both were fixed in the test.

### Limits

- One Mac, one Obsidian version, one local S3 server (versitygw), all on one machine. No R2 run: the scratch R2 token was revoked on 2026-10-20.
- One vault copy, about 400 notes and 23 MB. The two other devices started as identical or empty copies; a device whose files differ from the vault was covered only by tests ([service test](../subsystems/obsidian-plugin.md#tests)).
- No real concurrent edits: the corpus that phase 0 deferred needs real use.
- The fake vault models Obsidian's write behavior from its documentation and these runs, not from its source.

### Still open

- Behavior on iPhone, with suspension mid-sync, chunked attachments, and NFD paths (phase 3).
- How Obsidian reconciles a note that changes on disk while open in reading view or in a canvas view; the desktop test covered the source editor only.

## History

- 2026-10-21: Created with the phase 2 results.
