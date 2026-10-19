---
title: Platform probe
aliases: [obsy-probe, Obsy Probe, iPhone probe, iOS probe, requestUrl probe, SecretStorage probe, IndexedDB probe, phase 0 platform spike]
updated: 2026-10-20
---

# Platform probe

## Current

This page owns how to build, install, and run the Obsy probe, and how to send back its report. The probe answers the phase 0 question on the [roadmap](../roadmap.md): do `requestUrl`, `SubtleCrypto` hashing, IndexedDB, and `SecretStorage` behave on iOS Obsidian as the design assumes? The design that depends on the answers is on [Obsidian plugin](../subsystems/obsidian-plugin.md).

Status: the probe is built and its sections pass Node tests against fakes. **It has not run in Obsidian, on desktop or on an iPhone.** Record the results on a new learning page when they exist.

> [!warning] Scratch vault and scratch bucket only
> Never install the probe in a real vault. Never point it at a bucket that holds a vault. The probe writes and deletes files in the vault and objects in the bucket.

### What the probe is

The probe is a separate Obsidian plugin: ID `obsy-probe`, name "Obsy Probe", `minAppVersion` 1.13.2. It is not the sync plugin, and it does not sync anything. The root `manifest.json` and `versions.json` belong to the sync plugin and do not change.

Layout: a second Rolldown entry in `packages/obsidian-plugin/`. The probe source is `src/probe/`, and its manifest and styles are in `probe/`. The build writes `dist/obsy-probe/main.js`, `manifest.json`, and `styles.css`. A second entry is the simplest layout: the probe reuses the plugin package's `obsidian` typings, ESLint review rules, and the `requestUrl` transport (`src/transport/request-url-fetch.ts`) that the sync plugin will use, without a second package. The review rules check the probe against its own `minAppVersion`.

`minAppVersion` is 1.13.2 because the settings use the declarative settings API (1.13.0) and its secret control (1.13.2).

### Sections

Each section runs from its own command and from **Run all** in the probe view. **Run all** runs every section except the background test, which needs you.

| Section | Measures |
| --- | --- |
| Environment | `Platform` flags, `apiVersion`, user agent, WebView origin, available APIs |
| Storage over requestUrl | Transport checks: 412 and 404 bodies readable, `If-None-Match` and `If-Match` honoured, binary bodies byte-exact (0 B, 256 B, 1 MiB, 8 MiB), response header names and casing, `content-type` stored unchanged when sent as a header or as the `contentType` parameter, client-side timeout and whether the abandoned request settles. The 20 conformance checks without races, and a 4 × 5 conditional-create race; with **Full conformance suite** on, all 22 checks with the default races. Latency percentiles per operation. One request with the global `fetch`, to see whether CORS blocks it. Cleanup of the run prefix |
| SHA-256 throughput | `crypto.subtle.digest` time and MB/s for 1 KiB, 64 KiB, 1 MiB, 4 MiB, 16 MiB, and 50 MiB; memory errors |
| IndexedDB | 2,000 small records in one transaction, `getAll`, 200 one-record transactions, 1, 8, and 32 MiB `Uint8Array` values and an 8 MiB `Blob`; `abort()` and failed-`add()` rollback; whether a transaction is still active after `await crypto.subtle` or a timer; `navigator.storage.estimate()`, `persisted()`, and `persist()` |
| Secret storage | Whether `app.secretStorage` exists; set, get, list, overwrite; what an empty value does (the 1.14.4 typings have no delete); that no value reaches `data.json`; whether the value is plaintext in `localStorage` |
| Vault large files | `writeBinary` and `readBinary` of one file (4, 16, or 50 MiB), and `writeBinary` plus 1 MiB `appendBinary` chunks, verified by SHA-256, in the folder `.obsy-probe/`, which is then deleted |
| Restart markers | Writes one random marker to `data.json`, IndexedDB, vault `localStorage`, and `SecretStorage`. The next plugin load reads all four |
| Background requests | For 60 s (configurable), keeps requests in flight: a 4 MiB `get`, a `list`, and a small `putIfAbsent`, again and again. Records each request against `visibilitychange` events, and a 250 ms heartbeat to show suspension |

The plugin also logs `visibilitychange`, `freeze`, `resume`, `pagehide`, `pageshow`, `focus`, and `blur` with timestamps from load. The last 30 events are kept in vault `localStorage`, so the next load shows the end of the previous session.

### Verified in Node, and what only Obsidian can answer

`pnpm test` runs, against the testkit's fake S3 behind a fake `requestUrl`:

- the full conformance suite through `S3Storage` and the `requestUrl` transport, also with the `contentType` parameter, lower-case response headers, and a `requestUrl` that throws for 400+ despite `throw: false`;
- the transport rules: headers unchanged, `throw: false`, byte-exact bodies, 409, 412, 404, 429, 500, and 503 as responses with bodies and `Retry-After`, client-side timeout, abort, and the count of abandoned requests that settle later;
- every probe section except IndexedDB (Node has none), the restart-marker read, the background test loop, cleanup, and the report redaction.

The fakes cannot show:

- whether `requestUrl` on iOS sends headers unchanged and returns 4xx bodies and headers with `throw: false`. A passing storage section shows it. SigV4 (through aws4fetch) signs `host`, `if-none-match`, `if-match`, and the `x-amz-*` headers, so a changed signed header fails with 403, and a 412 proves that the condition arrived. aws4fetch does not sign `content-type`, so the probe stores an object with a distinct content type and reads the stored type back;
- iOS throughput for hashing, IndexedDB, and vault I/O, and memory limits at 32 to 50 MiB;
- whether IndexedDB, vault `localStorage`, and `SecretStorage` survive an app kill;
- whether requests complete while the app is in the background;
- whether the global `fetch` is blocked by CORS from `capacitor://localhost`;
- whether Obsidian loads a Rolldown-built `main.js` at all.

### Build

From the repository root:

```sh
pnpm install
pnpm run build
```

The probe is in `packages/obsidian-plugin/dist/obsy-probe/`: `main.js`, `manifest.json`, and `styles.css`.

### Make a scratch bucket and a scoped token

Use a bucket that holds nothing else. Follow [Make a scratch R2 bucket and a scoped token](storage-conformance.md#make-a-scratch-r2-bucket-and-a-scoped-token): an R2 API token with **Object Read & Write**, scoped to the scratch bucket only, with a short TTL. Do not configure CORS on the bucket: the probe records whether the global `fetch` fails without it.

### Install on desktop (baseline)

1. In Obsidian, create a new local vault for the probe. Do not use a vault in iCloud Drive or in any other synced folder.
2. Close Obsidian. In the vault folder, create `.obsidian/plugins/obsy-probe/`. (`.obsidian` is the default config folder; it is hidden in Finder. Press Cmd+Shift+. to show it.)
3. Copy the three files from `dist/obsy-probe/` into that folder.
4. Open the vault. In **Settings → Community plugins**, turn on community plugins, then turn on **Obsy Probe**.

### Install on iPhone, without a GitHub release

No method below has been tried with this probe yet.

**Method A: an iCloud scratch vault, filled from a Mac.**

1. On the iPhone, in Obsidian, create a new vault and turn on **Store in iCloud**. Give it a name that marks it as scratch.
2. On the Mac, open the vault folder in Finder: **iCloud Drive → Obsidian → `<vault>`**. Press Cmd+Shift+. to show hidden files.
3. Create `.obsidian/plugins/obsy-probe/` and copy the three files from `dist/obsy-probe/` into it.
4. Wait until iCloud uploads the files on the Mac, then until the iPhone has them. Opening the vault folder in the iPhone Files app can start the download. Then close Obsidian on the iPhone completely and open it again.
5. In **Settings → Community plugins**, turn on community plugins, then turn on **Obsy Probe**.

Do not open this iCloud vault in Obsidian on the Mac. Its `.obsidian/plugins/obsy-probe/data.json` syncs through iCloud, so two devices would share the probe settings and restart markers. Use the separate local vault for the desktop baseline.

What this rests on:

- *Reported by users, not verified here:* the iOS Files app does not show dot folders such as `.obsidian`, and has no setting to show them; iCloud Drive syncs `.obsidian` anyway; the vault must be at `iCloud Drive/Obsidian/<vault>/` for Obsidian iOS to see it; a plugin copied into an iCloud vault can take a long time to appear on iOS because of iCloud sync delay ([Obsidian folder missing/hidden on iOS](https://forum.obsidian.md/t/obsidian-folder-missing-hidden-on-ios/45266); [Syncing plugins / .obsidian folder using iCloud](https://forum.obsidian.md/t/syncing-plugins-obsidian-folder-using-icloud/96841); [Installing custom plugin on iCloud](https://forum.obsidian.md/t/installing-custom-plugin-on-icloud/97463)).
- *Assumed:* on the Mac, the iCloud Drive folder for Obsidian is `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/`.
- iCloud is a sync system. The probe does not sync, so this does not break the rule against two sync systems on one vault. But iCloud uploads what the probe writes: the vault test file (16 MiB by default) and the report notes. Choose 4 MiB for **Vault file size** if that matters.

**Method B: a local vault and a file manager that shows hidden folders.** Users report that Working Copy (a Git client) and Textastic can open hidden folders in an Obsidian vault ([MacStories: install Obsidian plugins on iOS with Working Copy](https://club.macstories.net/posts/manually-install-obsidian-plugins-on-ios-and-ipados-via-working-copy-and-its-new-version-control-for-files); [App to work with hidden folder](https://forum.obsidian.md/t/mobile-ios-app-to-work-with-hidden-folder/25741/10)). Not verified here. Use it if Method A is not possible.

BRAT is not an option until there is a GitHub release, and making one is outside this task.

### Configure

In **Settings → Obsy Probe**:

1. **Endpoint**: the S3 API endpoint without the bucket name. For R2: `https://<account-id>.r2.cloudflarestorage.com`.
2. **Bucket**: the scratch bucket. **Region**: `auto` for R2. **Addressing**: path style.
3. **Prefix**: leave the generated `obsy-probe/<id>/`. The probe refuses any other form.
4. **Access key ID** and **Secret access key**: select or create a secret for each. The secret control stores the value in `SecretStorage` and only the secret's name in `data.json`.

The endpoint, bucket, prefix, and the two secret names are in the probe's `data.json`. The credentials are not. Do not type credentials anywhere else, and do not take screenshots of the settings while a secret is visible.

### Run

Open the probe from the ribbon icon or the command **Obsy Probe: Open**. Then:

1. Tap **Run all**. On a phone this takes a few minutes; keep the app in the foreground. Watch the progress log.
2. Tap **Background requests**. When the notice appears, switch to another app for about 20 s, come back, switch away again for about 60 s, and come back before the test ends. Lock the screen once, too, if you can.
3. Optionally turn on **Full conformance suite** and run **Storage over requestUrl** again. It sends several hundred more requests.
4. Run the restart test below.
5. Copy the report (see below).

Run the same steps on desktop for the baseline. Every storage run writes only under `<prefix>run-<id>/` and deletes it at the end. If a run is interrupted, **Delete probe data** removes everything under the probe prefix.

### Restart test

1. Run **Restart markers** (it is part of **Run all**).
2. On iPhone, close Obsidian completely: swipe it away in the app switcher. On desktop, quit Obsidian.
3. Open Obsidian again and open the probe.
4. The `onLoad` part of the report shows, for `indexedDb`, `localStorage`, and `secretStorage`, whether a marker was `found` and whether it `matches` the one in `data.json`. `previousSessionLifecycle` shows the last events before the kill.

Optional: restart the phone itself and repeat step 3 to 4.

### Send back the report

The report is one JSON object with `schema: "obsy-probe-report"` and `schemaVersion: 1`. It holds all results of this plugin session and the restart check.

- **Copy report** puts it on the clipboard. If the clipboard fails on iOS, the report text is selected so that you can copy it by hand.
- **Save report to vault** writes `Obsy probe report <time>.md` in the vault root. Share that note from Obsidian or the Files app.

Redaction: the probe replaces the endpoint, its host, the R2 account ID, the bucket name, the credentials, the test secret, and the vault folder path with placeholders such as `<endpoint>` and `<bucket>`. It also replaces any URL, 32-digit hex string, AWS access key ID, 12-digit number, and absolute path. Before it shows or copies the report, it checks that none of these values remains, and it withholds the report if one does. The report keeps the provider guess (`r2`, `aws-s3`, or `other`), the region, the user agent, and the WebView origin. Read the report once before you send it.

### Clean up

1. Run **Delete probe data**. It deletes the bucket keys under the probe prefix, the IndexedDB database `obsy-probe`, the vault `localStorage` entries, the vault folder `.obsy-probe/`, and the marker in `data.json`. It sets the two probe secrets to an empty value, because `SecretStorage` has no delete method. **Delete the probe database** deletes only the IndexedDB database.
2. Delete the saved report notes if you do not need them.
3. Turn off and remove the plugin, and delete the scratch vault.
4. Revoke the R2 token.

## History

- 2026-10-20: Created with the platform probe. Built and tested in Node; not yet run in Obsidian.
