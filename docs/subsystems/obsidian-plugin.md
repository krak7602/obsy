---
title: Obsidian plugin
aliases: [plugin, obsy plugin, iOS, mobile, desktop, pairing, Obsy - Sync Vaults, VaultLocalFiles, connect, join, pull-only, safety rails, verify]
updated: 2026-10-21
---

# Obsidian plugin

## Current

Status: **existing behavior**. Desktop sync (phase 2) is tested in Obsidian 1.14.4 on macOS ([results](../learning/desktop-plugin-phase2.md)). The mobile parts (phase 3: stopping when hidden, the size limit, chunked writes, pairing) are implemented and tested on desktop and in the simulator, not yet on an iPhone ([results](../learning/mobile-sync-phase3.md)). Version 0.1.0 is not released. Plugin ID: `obsy`. Display name: "Obsy - Sync Vaults" (see [Naming](../decisions/2026-10-19-naming.md)).

The plugin runs `@obsy/core`'s `SyncEngine` over `@obsy/storage-s3`, with the [relay](relay.md) as a later option. It owns the Obsidian-specific parts: reading and writing vault files safely, durable state, the lifecycle, settings, and the questions that the safety rails ask.

### Parts

| Part | File (`packages/obsidian-plugin/src/`) | Does |
| --- | --- | --- |
| Vault adapter | `sync/vault-files.ts` | `VaultLocalFiles`: the engine's `LocalFiles` on the vault, with conditional writes |
| Obsidian port | `sync/obsidian-port.ts` | `VaultPort` on `app.vault`, `app.fileManager`, and open `MarkdownView` editors |
| State | `sync/idb-store.ts` | `IdbStateStore`: device state and file hashes in IndexedDB |
| Service | `sync/service.ts` | Connect, sync runs, verify, and the rail questions; one operation at a time |
| Scheduler | `sync/scheduler.ts` | When syncs run: one at a time, debounced after edits |
| Pairing | `pairing.ts`, `ui/pairing-modals.ts` | Pairing codes, the QR code, and joining with a code |
| Plugin | `main.ts`, `ui/` | Commands, status bar, settings tab, dialogs |

### Connect and join

**Connect** in the settings tab checks the bucket prefix:

- With no `vault.json` there, it asks, creates the vault (`initVault`), and syncs in **full** mode. This device's files become the vault.
- With a vault there, it asks, then joins in **pull-only** mode: remote changes are applied on the device, and nothing is sent. A local file that equals a bucket file is adopted. A local file that differs is renamed to a conflict copy, and the bucket version takes its path. The user runs **Verify**, then **Start full sync**.

Connect clears the device state, so a new connection always reconciles every file by content. **Disconnect** stops syncing and forgets the state; files stay as they are. Pull-only is a `SyncEngine.sync({ pullOnly: true })` run ([protocol](protocol.md#sync-engine)). A device can also join with a [pairing code](#pairing), which fills in the settings.

### Lifecycle

Existing behavior:

- A sync runs after `onLayoutReady`, when the window becomes visible, 2 s after the last vault event that obsy did not cause, and every 30 s.
- On mobile, sync pauses while the app is hidden, and the 30 s timer runs only while it is visible. iOS gives plugins no background time: JavaScript ran for about 3.5 to 4 s after the app was hidden, then stopped ([evidence](../learning/iphone-probe.md#background-behavior)). A sync that is running when the app is hidden stops at its next safe point (before a pass, a download, an upload, or a claim) with its state saved, and goes on when the app is visible again (`SyncRunOptions.shouldStop`, [protocol](protocol.md#sync-engine)). A request already in flight may fail at resume; the engine treats it like any interrupted request.
- On desktop, sync does not pause when the window is hidden. macOS reports a window behind other windows as hidden, and an edit saved just before the user switches apps must still go out ([finding](../learning/desktop-plugin-phase2.md#findings)).
- Syncs never overlap. A request during a sync starts one more sync after it. Every service operation (sync, connect, verify, disconnect) waits for the one before it.
- Before each sync, every open note is saved, so the sync sees what the user typed.

### Change detection

Existing behavior. `VaultLocalFiles.list` reads the vault index (`vault.getFiles()`), which leaves out the config folder and dot paths. A file whose size and mtime match a stored hash is not read again; any other file is read and hashed with `SubtleCrypto`. The hashes are stored in IndexedDB after each sync. Vault events only start a sync; every pass lists the vault again. Files whose path key (NFC, lower case) another file already has are left out and reported as twins.

### State

Existing behavior. The engine's device state (the head manifest, the synced entry of each file, the pending claim, and write intents) and the file hashes are in IndexedDB, database `obsy`, under a `localId`. The `localId` is random, stored per vault and device in the app's local storage, so two vaults in one app, or a copied vault folder, never share state. A save is one transaction (`durability: 'strict'`). Nothing of the sync state is in `data.json`.

### Applying remote changes

Existing behavior. Every change first reads the file and checks its content hash. It also checks that the file's size and mtime did not change while it was read and hashed. Then:

- **Open note** (source or live preview, LF line ends): the note must have no unsaved edits. obsy applies one minimal replacement as an editor transaction, then saves the view, so the cursor and scroll position stay. If the view did not write the file, obsy writes it on disk.
- **Other text** (valid UTF-8, no byte order mark): `vault.process`, which writes only if the text is still the text that was hashed.
- **Other files**: `vault.modifyBinary`.
- **New files**: written to `<path>.obsy-tmp`, then renamed into place. Leftover temporary files are removed at start.
- **Renames**: `vault.rename`, never `fileManager.renameFile`: the device that renamed the file has already updated the links.

A change that fails because the user changed the vault meanwhile (a file removed, a path taken) counts as a failed condition: the engine starts its pass again. obsy's own writes are marked for 5 s, so their vault events do not start another sync.

Known window: a user save that lands while Obsidian itself moves a file to the trash or writes a binary file can be overwritten. With a trash setting, the content is still in the trash.

### Deletes and safety rails

Existing behavior. A delete uses `fileManager.trashFile`, so it follows the user's setting for deleted files (system trash, the vault's `.trash` folder, or a permanent delete). obsy removes only files whose content equals the synced version, which the bucket history keeps. The [desktop decision](../decisions/2026-10-21-desktop-plugin-choices.md) explains why this is not always the vault trash.

The engine's rails (`SafetyRails` in `@obsy/core`) stop a sync before any change when it would:

- delete more than 50 files, or at least 10 files that are more than 20% of the files, on the device or in the bucket;
- send changes while the device has no files at all but synced files that the head still has.

The plugin also stops when the device state names another vault than the folder's marker (`vaultId` in `data.json`): the folder may have been replaced. In each case automatic sync pauses, and a dialog asks. Only an explicit confirmation continues, once. A sync that the bucket rejects for its protocol rules, or for its credentials, also pauses automatic sync.

### Verify

Existing behavior. **Verify** (command and settings) saves open notes, reads the head from the bucket (newest checkpoint, then the log), and compares every local file with it (`verifyLocal` in `@obsy/core`). It reports files missing here, files here and not in the bucket, content differences, and paths that differ in case or Unicode form. It changes nothing.

### Config folder

Accepted design, not implemented: syncing the config folder, opt-in by category, never `workspace*.json` or obsy's own data. Today obsy syncs no file in the config folder.

### Large files

Existing behavior:

- **Size limit.** Each device has a largest file size, **Largest file on this device** (default 50 MB on mobile, no limit on desktop). A head file over the limit that the device does not hold yet is not downloaded; a local file at its path is renamed to a conflict copy and sent. Files the device already syncs, and files made on the device, sync at any size: leaving out a file the device holds could look like a delete ([decision](../decisions/2026-10-21-pairing-and-size-limit.md)). The status and **Verify** count the files left out.
- **Chunked writes.** On mobile, a downloaded file larger than 4 MiB is written in 4 MiB pieces (`createBinary`, then `appendBinary`) to a temporary file and renamed into place. A larger binary file that changes is replaced the same way: the temporary file is written, the old file is checked unchanged and deleted, and the new one is renamed into place. A stop in between leaves the path empty, and the engine's write intent restores the file from the bucket.

The whole file is still in memory once: `requestUrl` returns whole bodies, and Obsidian has no ranged read.

### Credentials

Existing behavior. The access key ID and secret access key are entries in Obsidian `SecretStorage`. `data.json` holds only the names of the two entries, chosen in the settings tab with the secret control, or set by a pairing code to names unique to the vault and device (`obsy-<localId>-access-key-id` and `obsy-<localId>-secret-access-key`): on mobile, same-named secrets may be shared across vaults ([research](../learning/sync-design-research.md)). The desktop test checks that no credential value reaches `data.json`.

### Pairing

Existing behavior. On a connected device, **Pair another device** shows a pairing code once, as a QR code and as text to copy. The code carries the endpoint, bucket, region, addressing, prefix, the credential, and the vault ID: `obsy1:` and base64url JSON (`src/pairing.ts`). It is a secret; obsy never stores or logs it. The QR code holds an `obsidian://obsy-pair?code=…` link, so a phone camera can open it in Obsidian, where the plugin's protocol handler starts the join.

On a device that is not connected, **Join with a pairing code** (or the link) asks, stores the credential under this vault's own secret names, fills in the settings, and joins in pull-only mode. It joins only the vault that the code names: a prefix with another vault, or none, stops the join.

The code carries the same credential that the first device uses. A per-device credential, scoped to the vault prefix, is not implemented ([decision](../decisions/2026-10-21-pairing-and-size-limit.md)).

### Platform

Pure TypeScript, no Node APIs, no WASM, `isDesktopOnly: false`, `minAppVersion` 1.13.2 (the declarative settings API and its secret control). HTTP goes through `requestUrl` with a client-side timeout.

Existing behavior: `createRequestUrlFetch` (`src/transport/request-url-fetch.ts`) is the `fetch` that the plugin passes to `S3Storage`. It sends every header unchanged, sets `throw: false` so that 4xx and 5xx come back as responses with headers and bodies, matches response header names without regard to case, and sends `ArrayBuffer` bodies with exactly the view's bytes. `requestUrl` has no timeout and no abort, so the transport times out on the client (default 30 s) and honours an abort signal; the underlying request keeps running and its result is ignored. If `requestUrl` throws for a status despite `throw: false`, the transport turns the error back into a response.

Observed on an iPhone (iOS 18.7, Obsidian 1.14.5): the transport passes 20 conformance checks and a conditional-create race over R2; the global `fetch` is blocked without bucket CORS; SHA-256 runs at about 2 GB/s; IndexedDB, `localStorage`, and `SecretStorage` survive an app kill; an IndexedDB transaction does not survive `await crypto.subtle`, so hash first; `navigator.storage.persist()` returns false; `Platform.isMacOS` is true on iOS, so use `isDesktopApp` and `isIosApp`. See [iPhone probe](../learning/iphone-probe.md). The platform evidence is in the [Obsidian platform research notes](../learning/research-notes/obsidian-platform.md).

### Tests

`pnpm test` runs the adapter against a fake vault (`src/testing/fake-vault.ts`): conditional writes, editor transactions, unsaved edits, temporary files, chunked writes, and 400 random runs of the engine on two devices with user edits that land during syncs (half of them with chunked writes). It also runs the service on fake IndexedDB: connect, rails, pairing, and stops. `pnpm run test:desktop` runs the scenario in a real Obsidian app ([runbook](../runbooks/desktop-plugin-test.md)).

### Build and distribution

Existing behavior: `packages/obsidian-plugin/` builds `dist/main.js` (CommonJS) with Rolldown. A second entry builds the platform probe, a separate plugin with the ID `obsy-probe`, into `dist/obsy-probe/` ([platform probe](../runbooks/platform-probe.md)). The probe is installed by hand in scratch vaults and is never released.

The community directory reads `manifest.json` from the root of the default branch, so `manifest.json` and `versions.json` stay at the repository root. A release is a GitHub release whose tag equals the manifest `version`, with `main.js`, `manifest.json`, and `styles.css` attached. Plain `x.y.z` tags therefore belong to the plugin; npm package releases need a different tag form, such as `@obsy/core@x.y.z`. Beta builds go out through BRAT from the same releases. `pnpm --filter @obsy/obsidian-plugin run release <version>` prepares the release files and publishes only with `--publish` ([release runbook](../runbooks/plugin-release.md)). No release exists yet, and the repository has no GitHub remote.

## History

- 2026-10-21: Mobile parts implemented (phase 3): stop when hidden, the download size limit, chunked writes, pairing codes; a release script. Not yet run on an iPhone.
- 2026-10-21: Desktop sync implemented (phase 2): vault adapter, IndexedDB state, connect and pull-only join, rails, verify. `minAppVersion` raised to 1.13.2; deletes follow the user's deletion setting; desktop does not pause when hidden ([decision](../decisions/2026-10-21-desktop-plugin-choices.md)).
- 2026-10-20: Plugin shell scaffolded; build and distribution rules recorded.
- 2026-10-20: iPhone probe results added to Lifecycle and Platform.
- 2026-10-20: Added the `requestUrl` transport and the platform probe build.
- 2026-10-19: Plugin design accepted, from the former `DESIGN.md`.
