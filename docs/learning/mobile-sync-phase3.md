---
title: Mobile sync, phase 3
aliases: [phase 3 results, iOS results, pairing results, size limit results, kill test, seed 28784]
updated: 2026-10-21
---

# Mobile sync, phase 3

## Current

Status: **observed results, 2026-10-21.** The phase 3 parts pass the simulator, unit tests, the desktop test, and one run of the [iPhone sync test](../runbooks/iphone-sync-test.md): all 8 steps passed. No BRAT release exists yet. The plugin is on [Obsidian plugin](../subsystems/obsidian-plugin.md).

### Question

Phase 3 on the [roadmap](../roadmap.md) is done when offline phone edits, app kills mid-upload, and NFD and case cases cause no loss and no duplicates. Do the new parts (stops at safe points, the size limit, chunked writes, pairing) keep the invariants, and does the plugin recover from a kill at the worst moment?

### Method

- **Simulator:** as in [phase 2](desktop-plugin-phase2.md#simulator), plus: one sync in ten stops at random safe points; the phone has a 40-byte download size limit; a new check that no device deletes in the bucket a file whose content it keeps at that path ([runbook](../runbooks/simulator.md)).
- **Mutation check:** plant a bug in the size-limit code, run 2,000 seeds, count failures.
- **Unit and random tests** (`pnpm test`): pairing codes, chunked writes and replacements, the service's pairing and stop handling; the random vault tests with half of the seeds writing in 6-byte pieces.
- **Desktop test** ([runbook](../runbooks/desktop-plugin-test.md)): four vault windows in Obsidian 1.14.4 on macOS, against versitygw in Docker. New steps: pairing a fourth, empty vault with a 1 MB size limit; an NFD name, a case-only rename, and case twins; edits while the S3 container is stopped; Obsidian killed (`SIGKILL`) during an upload and during a download, then restarted.

### Results

#### Simulator

`node packages/simulator/dist/cli.mjs --seeds 1000000 --workers 8` on the final engine: seeds 1 to 1,000,000, 0 failures, 2,342 s.

| Total over all seeds | Count |
| --- | --- |
| Syncs started / pull-only / stopped at a safe point / finished | 6,577,361 / 1,315,580 / 464,172 / 3,609,449 |
| Device crashes | 2,475,870 |
| Device commits during the run / in the quiet phase | 3,949,085 / 682,554 |
| Conflict copies | 2,466,044 |
| Head files the phone left out by its size limit (summed over finished syncs) | 262,611 |
| Syncs that ended with an unexpected error | 0 (all 464,172 errors were stops) |

Seeds 110 and 28784 joined the regression seeds in `pnpm test`.

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

#### iPhone run

One run of the [iPhone sync test](../runbooks/iphone-sync-test.md) on 2026-10-21.

- **Devices.** An iPhone on iOS 27.0.1 (Obsidian version not recorded), with a new vault stored on the phone. The Mac side was a separate Obsidian 1.14.4 instance with its own profile and a scratch vault, driven over the remote debugging port.
- **Install.** The release files of 0.1.0 were copied into the phone vault's `.obsidian/plugins/obsy/` over USB (Method C in the runbook).
- **Bucket.** The scratch R2 bucket, a new prefix, and a 30-day token scoped to the bucket.
- **Pairing.** The phone camera opened the `obsidian://obsy-pair` link from the QR code, and the phone joined pull-only; its files matched the Mac's.
- **Checks.** Files, sizes, and SHA-256 on the phone were read over USB; the bucket log was read from the Mac side.

| # | Step | Result |
| --- | --- | --- |
| 1 | Offline edits: first line on the phone in Airplane Mode, last line on the Mac, and a new note on the phone | Merged on both devices; the new note reached the Mac |
| 2 | A 29.9 MB video added on the phone, app swiped away about 3 s later | Arrived once, same SHA-256 on both devices; no temporary file; 5 commits, 5 distinct `opId`s |
| 3 | A 40 MiB file from the Mac, app swiped away about 3 s into the download | Complete on the phone (same SHA-256); no temporary file |
| 4 | A 45 MiB file from the Mac, app switched to the background about 2 s in, back after 30 s | Complete on the phone (same SHA-256); status "Up to date" |
| 5 | `Notes/idea.md` on the phone in Airplane Mode, `Notes/Idea.md` on the Mac | Both devices: `Idea.md` with the Mac text and `idea (conflict iphone-… ).md` with the phone text |
| 6 | `Welcome.md` renamed to `welcome.md` on the phone | Renamed on the Mac; no duplicate |
| 7 | A 60 MiB file from the Mac, over the phone's 50 MB limit | Not downloaded; **Verify**: no differences, 1 skipped |
| 8 | Typing in an open note on the phone while the Mac changed another line | The change appeared in the open note; the typing stayed; the cursor did not move |

### Findings

- **The first size limit could lose content (seed 28784).** It left out large local files too. A synced file that the phone renamed and enlarged in one step looked like a new large file: the engine committed the delete of the old file and held back the new one. The new simulator check found it after 245,000 seeds. The limit now applies only to downloads of files the device does not hold ([decision](../decisions/2026-10-21-pairing-and-size-limit.md)).
- **A first, weaker check missed a planted bug.** Before the delete-but-kept check, hiding a synced file over the limit failed no seed, because the check allowed the phone to keep large local files. With the check, the same bug failed 1,262 of 2,000 seeds.
- **A case twin blocked a rename (seed 110).** With the first limit, a synced file renamed onto the path of a skipped head file in another case was never moved out of the way. Such a file now yields to a conflict copy name, as for a download.
- **Obsidian stores NFD names as NFC.** The desktop test compares names in NFC; macOS keeps the form a file was created with.
- **The phone shows no sync activity.** Obsidian on iOS hides the status bar, and automatic syncs show no notice, so a user cannot see that a sync runs or failed without opening the settings.
- **Most kills land before or after the transfer.** A kill 150 ms into the sync found nothing in the bucket; a kill after 400 ms found the sync done. The test now waits for the blob or the temporary file.

### Limits

- One iPhone run, by hand. The moment of each app kill and background switch was not observable: steps 2 to 4 show the right end state, not that the kill or the pause hit a transfer.
- NFD names were not tested on the iPhone; the iOS keyboard writes NFC.
- One Mac, one Obsidian version, one local S3 server.
- The download kill reached a half-written temporary file once in four runs.

### Still open

- A visible sync status on mobile.
- A BRAT beta release, which needs a GitHub repository ([plugin release](../runbooks/plugin-release.md)).

## History

- 2026-10-21: First iPhone run: all 8 steps passed.
- 2026-10-21: Created with the desktop and simulator results.
