---
title: Mobile sync, phase 3
aliases: [phase 3 results, iOS results, pairing results, size limit results, kill test, seed 28784]
updated: 2026-10-21
---

# Mobile sync, phase 3

## Current

Status: **partial results, 2026-10-21.** The phase 3 parts are built and pass the simulator, unit tests, and the desktop test. They have **not** run on an iPhone; that test is in the [iPhone sync test runbook](../runbooks/iphone-sync-test.md). The plugin is on [Obsidian plugin](../subsystems/obsidian-plugin.md).

### Question

Phase 3 on the [roadmap](../roadmap.md) is done when offline phone edits, app kills mid-upload, and NFD and case cases cause no loss and no duplicates. Do the new parts (stops at safe points, the size limit, chunked writes, pairing) keep the invariants, and does the plugin recover from a kill at the worst moment?

### Method

- **Simulator:** as in [phase 2](desktop-plugin-phase2.md#simulator), plus: one sync in ten stops at random safe points; the phone has a 40-byte download size limit; a new check that no device deletes in the bucket a file whose content it keeps at that path ([runbook](../runbooks/simulator.md)).
- **Mutation check:** plant a bug in the size-limit code, run 2,000 seeds, count failures.
- **Unit and random tests** (`pnpm test`): pairing codes, chunked writes and replacements, the service's pairing and stop handling; the random vault tests with half of the seeds writing in 6-byte pieces.
- **Desktop test** ([runbook](../runbooks/desktop-plugin-test.md)): four vault windows in Obsidian 1.14.4 on macOS, against versitygw in Docker. New steps: pairing a fourth, empty vault with a 1 MB size limit; an NFD name, a case-only rename, and case twins; edits while the S3 container is stopped; Obsidian killed (`SIGKILL`) during an upload and during a download, then restarted.

### Results

#### Simulator

To be filled in from the million-seed run.

#### Mutation check

| Planted bug | Seeds failed (of 2,000) |
| --- | --- |
| An untracked local file at the path of a skipped head file does not yield | 228 |
| A synced file at the path of a skipped head file does not yield | 4 |

#### Unit and random tests

- `pnpm test`: 475 tests in 26 files pass.
- Random vault tests, half with chunked writes: 10,000 seeds, no failures.

#### Desktop test

Final code: three runs with the generated vault and one with a copy of a real vault (451 files), 15 of 15 steps each.

| Step | Result |
| --- | --- |
| Pairing | A new empty vault joined with the code alone. The credential went to `obsy-<localId>-…` secret names; no credential value in any `data.json` |
| Size limit (1 MB) | The files over 1 MB were not downloaded; verify: no differences, those counted as skipped |
| NFD name | A file created with an NFD name by another program: Obsidian indexed it in NFC, and the bucket stored NFC. On disk, the first vault kept NFD and the second wrote NFC. One file on each device |
| Case | A case-only rename synced as a rename. `Twin.md` and `twin.md` made on two devices: one file and one conflict copy on both |
| Offline | With the S3 container stopped, syncs failed with a visible error; after a restart, edits from both devices merged and a new note arrived |
| Kill during upload | Obsidian killed as soon as the 24 MiB blob was in the bucket. In the three generated-vault runs, the commit was not yet made; in the vault-copy run, it was. After a restart: the file once, intact, no repeated `opId` |
| Kill during download | Killed as soon as the temporary file appeared: in one run the temporary file was seen mid-write; in the others the download finished between checks. After a restart: the file once, intact, no temporary file left |

### Findings

- **The first size limit could lose content (seed 28784).** It left out large local files too. A synced file that the phone renamed and enlarged in one step looked like a new large file: the engine committed the delete of the old file and held back the new one. The new simulator check found it after 245,000 seeds. The limit now applies only to downloads of files the device does not hold ([decision](../decisions/2026-10-21-pairing-and-size-limit.md)).
- **A first, weaker check missed a planted bug.** Before the delete-but-kept check, hiding a synced file over the limit failed no seed, because the check allowed the phone to keep large local files. With the check, the same bug failed 1,262 of 2,000 seeds.
- **A case twin blocked a rename (seed 110).** With the first limit, a synced file renamed onto the path of a skipped head file in another case was never moved out of the way. Such a file now yields to a conflict copy name, as for a download.
- **Obsidian stores NFD names as NFC.** The desktop test compares names in NFC; macOS keeps the form a file was created with.
- **Most kills land before or after the transfer.** A kill 150 ms into the sync found nothing in the bucket; a kill after 400 ms found the sync done. The test now waits for the blob or the temporary file.

### Limits

- No iPhone run: suspension, iOS kills, the phone's file system, the camera link, and mobile memory are untested.
- One Mac, one Obsidian version, one local S3 server.
- The download kill reached a half-written temporary file once in four runs.

### Still open

- The [iPhone sync test](../runbooks/iphone-sync-test.md), which needs a scratch bucket that the phone can reach and a way to install the plugin on the phone (a BRAT beta or Method B).
- A BRAT beta release, which needs a GitHub repository ([plugin release](../runbooks/plugin-release.md)).

## History

- 2026-10-21: Created with the desktop and simulator results; the iPhone run is to come.
