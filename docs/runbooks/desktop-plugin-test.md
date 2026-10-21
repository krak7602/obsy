---
title: Desktop plugin test
aliases: [test:desktop, e2e, end-to-end test, Obsidian desktop test, CDP, remote debugging, vault copy test, phase 2 test]
updated: 2026-10-21
---

# Desktop plugin test

## Current

This page owns how to run the plugin in a real Obsidian desktop app against a local S3 server. The plugin is on [Obsidian plugin](../subsystems/obsidian-plugin.md); results are in [Desktop plugin, phase 2](../learning/desktop-plugin-phase2.md).

> [!warning] Scratch vaults and copies only
> The test never opens a vault in use. It copies a generated vault, or a folder that you name, into a new temporary folder. Make that folder a copy of a vault, never the vault itself.

### Requirements

- macOS with Obsidian installed at `/Applications/Obsidian.app`, or `OBSY_E2E_OBSIDIAN` set to the binary.
- Docker, for the local S3 server ([storage conformance](storage-conformance.md#local-docker-run)).
- Nothing listening on ports 19000 (S3) and 19223 (Obsidian remote debugging).

### Run

```sh
pnpm run test:desktop
```

The script builds the plugin and the `obsy` command, starts `obsy-s3-test` (versitygw) with random credentials, runs the scenario, and removes the container. It also works while your own Obsidian runs: the test instance has its own profile folder.

| Variable | Effect |
| --- | --- |
| `OBSY_E2E_SOURCE` | Copy this folder into the vaults instead of the generated vault. The scenario files go into `obsy-e2e-scenario/` inside the copies. Dot folders such as `.obsidian` are not copied. |
| `OBSY_E2E_REPORT_FILE` | Also write the summary to this file |
| `OBSY_E2E_KEEP` | Keep the temporary folder (vaults, profile, Obsidian log) |
| `OBSY_E2E_OBSIDIAN` | The Obsidian binary |

To test with a copy of a vault, copy it first, outside the repository, for example `rsync -a --exclude='.*' <vault>/ <copy>/`, then run `OBSY_E2E_SOURCE=<copy> pnpm run test:desktop`. Delete the copy afterwards. Do not record note names or content from such a run; record counts and timings.

### What the test does

1. Copies the source into two new folders, A and B, and makes two empty ones, C and D. Installs `dist/main.js`, `dist/styles.css`, and the root `manifest.json` in each, and sets each vault to delete into its `.trash` folder.
2. Starts Obsidian with `--user-data-dir` set to a new profile folder that lists only these vaults, and `--remote-debugging-port=19223`. Drives each window over the Chrome DevTools Protocol (`e2e/cdp.ts`): enables the plugin, stores the S3 credentials in `SecretStorage`, and fills in the settings under a new prefix `obsy-e2e/<run id>/`.
3. Runs the steps in `e2e/desktop.integration.test.ts`. Dialogs are answered by clicking their buttons.

| Step | Checks |
| --- | --- |
| A connects | Creates the vault; the head equals A's files |
| B joins the copy pull-only | Nothing sent; verify shows no differences; B equals A |
| C joins empty pull-only | Every file downloads; verify shows no differences; no temporary file left |
| Edits on different lines | Merged on both, no conflict copy |
| Same line, and a binary, changed on both | Conflict copies named `(conflict desktop-b <time>)` with B's versions, on both devices |
| Remote edit to an open note | Applied in the editor; the cursor stays |
| Unsaved typing in an open note | Kept and merged with a remote edit |
| Rename, delete, file written outside Obsidian | Synced; the delete is in B's `.trash` |
| Automatic sync | An edit is sent without a manual sync and reaches B |
| Mass delete | The sync stops and asks; Cancel sends nothing; confirming deletes on both |
| D pairs with a code, with a 1 MB size limit | The code alone fills in the settings; the credential goes to D's own secret names; the 3 MiB file is left out; verify: no differences, 1 skipped |
| NFD name, case-only rename, case twins | An NFD name written by another program, a case-only rename, and `Twin.md`/`twin.md` made on A and B: one file each, the twin as a conflict copy |
| Offline | The S3 container is stopped; edits on A and B; syncs fail and say so; after a restart of the container, the edits merge |
| Agents and proposals | B types in an open note without saving: B's presence record names the note. An agent in `propose` mode proposes (`editing`); one in `ignore` mode commits, and B's open editor gets the line with the typing and cursor kept. Undo removes the agent's line and keeps the typing. A edits inside the agent's block, so its next change is a proposal (`block-edited`). In A's review dialog, Accept merges the first proposal with later edits and Reject answers the second. The built `obsy` command appends a line |
| Killed mid-transfer | Obsidian is killed (`SIGKILL`) during a 24 MiB upload from A, restarted, then killed during the download on B, and restarted: the file arrives once and intact, with no temporary file and no repeated commit |
| End | Verify shows no differences on A and B; both folders equal the head; no credential value in any `data.json` |

Folder trees are compared with names in NFC: macOS treats the NFC and NFD forms of a name as one, and keeps the form a file was created with. The summary prints file counts and timings, never file names.

### When it fails

- `OBSY_E2E_KEEP=1` keeps the vaults and `obsidian.log`. The temporary folder is under `$TMPDIR` and starts with `obsy-e2e-`.
- A step that waits for a dialog fails after 60 s with the text of any open dialog and the plugin status.
- If a test Obsidian is left running, stop it with `pkill -f -- '--remote-debugging-port=19223'`. Stop the S3 server with `bash packages/storage-s3/scripts/s3-local.sh stop`.

## History

- 2026-10-21: Added the agents and proposals step (phase 4).

- 2026-10-21: Added pairing, the size limit, names, offline, and kill steps (phase 3).
- 2026-10-21: Created with the phase 2 desktop test.
