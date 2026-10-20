---
title: Simulator, phase 1
aliases: [simulator results, 1M seeds, million seeds, phase 1 results, engine bugs found, mutation check]
updated: 2026-10-20
---

# Simulator, phase 1

## Current

Status: observed results, 2026-10-20. The sync engine at commit `039122d` passed one million seeds with every invariant held. How to run the simulator is in the [runbook](../runbooks/simulator.md); the invariants are on [Correctness and testing](../concepts/correctness-and-testing.md); the engine is on [Protocol and core](../subsystems/protocol.md#sync-engine).

### Question

Phase 1 on the [roadmap](../roadmap.md) is done when the simulator's invariants hold over at least one million seeds. Does the engine keep them under concurrency, network faults, and crashes, and does the simulator detect a broken engine?

### Method

- **Simulator:** two devices and an agent sharing one in-memory bucket, 600 steps per seed, default faults (3% failures before the bucket, 3% lost responses, 2% late writes, crashes at any request, offline periods), then a quiet phase and the invariant checks. See the [runbook](../runbooks/simulator.md#what-one-seed-does).
- **Machine:** Apple M4 Pro, 12 worker threads, Node 24.21.0.
- **Mutation check:** plant a known bug in the engine, rebuild, run 400 seeds, count failures.

### Results

#### One million seeds

`node packages/simulator/dist/cli.mjs --seeds 1000000`: seeds 1 to 1,000,000, 0 failures, 1,814 s (about 550 seeds per second).

| Total over all seeds | Count |
| --- | --- |
| User actions | 107,989,192 |
| Syncs started / finished (the rest crashed) | 5,562,895 / 2,919,371 |
| Device crashes | 2,643,524 |
| Device commits during the run / in the quiet phase | 4,326,572 / 449,320 |
| Agent appends | 12,659,939 |
| Conflict copies | 2,479,175 |
| Syncs that ended with an unexpected error | 0 |

#### Bugs the runs found

Each was found by a failing seed, fixed, and its seed added to the regression seeds in `pnpm test`:

| Seed | Invariant broken | Cause | Fix |
| --- | --- | --- | --- |
| 13431, 14816 | Commit rules (a commit put two live files on one path key) | A file deleted on the device but edited remotely was not restored when the device had renamed another file onto its path; the rename was committed onto the occupied path | The renamed file yields to a conflict copy name and the edited file is restored; moves never target a path that a staying head file holds; every commit is checked against a copy of the head before it is sent |
| 95652, 318587 | Engine crash (undefined local file) | A stale synced entry and a newer one shared a path, and both claimed the same local file | Each local file is claimed once: by the entry with the same content, else the newest |
| 510718 | No silent loss (a user line disappeared) | A pass stopped after merging into a local file but before recording the new base. The head content later returned to the older revision, so the next merge saw no remote change and committed the local version over it | Content and path bases are recorded separately and immediately; content-base writes save an intent first and are settled from the file's content after a stop |

The check before sending matters on its own: before it, a writer bug wrote a rule-breaking commit into the bucket, which every reader would then refuse.

#### Mutation check

| Planted bug | Seeds failed (of 400) |
| --- | --- |
| The conflict copy is not written | 298 |
| A remote delete removes a locally edited file | 179 |
| A lost claim counts as won | 400 |
| A clean merge writes the head version instead of the merge result | 374 |
| A pending claim is not re-sent after a crash | 0 of 200 |

The last row is expected: reconcile recognises the device's own landed commit by content, so the pending claim is not needed for safety. A unit test (`settles a local write that stopped before it was recorded`) fails when content intents are removed; the simulator seeds did not reach that crash window with the other fixes in place.

### Lessons

- **Seed volume finds real bugs.** The first 50,000 seeds passed; the bugs above appeared between seed 13,000 and 511,000. Short test runs are not enough for engine changes.
- **Check every commit before sending it.** A reader that stops on a bad commit makes a writer bug fatal for the whole vault.
- **"Redo is harmless" needs proof.** Redoing a merge from a stale base is harmless until content returns to an older revision (ABA). Durable intents settle the question from the file itself.
- **Prefer a conflict copy to a guess.** When the base of a local file cannot be known, keeping the user's version as a copy loses nothing.

### Limits

- Two devices and one agent, ten paths, small files. Real vaults have thousands of files and larger edits.
- The agent only appends. Phase 4 adds the other agent operations.
- Local file operations are atomic and the file system is case-insensitive (as on macOS and iOS); Obsidian's editor buffers, vault events, and trash are not modelled.
- Storage faults are simulated on an in-memory bucket. Real R2 behaviour is covered by the [storage spike](storage-spike.md).
- Checkpoints, GC, epoch bumps, and new devices joining a large vault were not exercised.

### Still open

- A run with more devices and paths, and with checkpoints and GC once GC exists.
- Measuring the cost of saving device state after every base-changing write in a large vault.

## History

- 2026-10-20: Simulator built; five failing seeds found three engine bugs; fixed engine passed one million seeds.
