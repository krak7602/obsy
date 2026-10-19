---
title: Research notes: Obsidian sync landscape
aliases: [LiveSync, Remotely Save, Relay, prior art, licensing]
updated: 2026-10-19
---

# Obsidian vault sync and collaboration landscape (as of 2026-10-19)

Scope: what a self-built Obsidian sync plugin ("obsy": Mac + iPhone, Cloudflare backend, server-side AI agent that writes notes) can learn from or legally reuse, and the pitfalls other projects hit.

Method note: Repository facts (license, last release, last push, stars) were read directly from the GitHub API on 2026-10-19, so the repository URL is the source. Forum and blog facts come from web pages fetched on the same day. Older information is marked with its date.

## 1. Project-by-project: architecture, change detection, conflicts, renames/deletes, initial sync, attachments, mobile, maintenance, license

### Takeaway
There are two architecture families. The first is file-level or revision-level sync: Obsidian Sync, Self-hosted LiveSync, Remotely Save and its forks, Fast Note Sync, Syncthing, iCloud, and Git. The second is CRDT (Yjs) real-time collaboration: Relay, Peerdraft, and probably Screen Garden. The most active and best-documented open-source engine in late 2026 is Self-hosted LiveSync (MIT; release 1.0.38 on 2026-10-17). Remotely Save is effectively unmaintained: its last release was 2024-10-20, and its sync engine now lives in a PolyForm Strict `pro/` folder. Relay (MIT plugin; MIT server forked from y-sweet; proprietary control plane) is the closest reference for a Yjs server that stores to R2.

### Cited Findings

**Obsidian Sync (official, proprietary)**
- Pricing in 2026: Sync Standard costs $4/user/month billed annually or $5 monthly. It includes 1 vault, 1 GB storage, a 5 MB maximum file size, and 1 month of version history. Sync Plus costs $8/user/month annually or $10 monthly. It includes 10 vaults, 10 GB storage (upgradable to 100 GB), a 200 MB maximum file size, and 12 months of version history — [obsidian.md/sync](https://obsidian.md/sync); plan table confirmed at [Sync plans help](https://obsidian.md/help/sync/plans). The general pricing page shows only "$5/$4 per user" — [obsidian.md/pricing](https://obsidian.md/pricing).
- Storage is one account-wide limit for all vaults, and version history and attachments count toward it. Attachments stay in version history for "up to two weeks" — [Sync plans](https://obsidian.md/help/sync/plans).
- Merge behaviour: "Obsidian Sync merges the changes using Google's diff-match-patch algorithm" for Markdown. "For all other files, including canvases, Obsidian uses a 'last modified wins' approach." For JSON settings, Sync "applies keys from the local JSON on top of the remote JSON" — [Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot).
- Since Obsidian 1.9.7 there is a per-device conflict strategy: "Automatically merge" (the default, which "may sometimes create duplicate text or formatting problems") or "Create conflict file", named `original-note-name (Conflicted copy device-name YYYYMMDDHHMM).md`. In the second mode, the conflict file holds the local device's changes and the original keeps the remote version — [Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot).
- Same note created on two devices within a couple of minutes: "Sync keeps the remote version and does not merge them". The user must recover the local copy from File recovery — [Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot).
- Encryption uses AES-256-GCM with scrypt key derivation (salted). End-to-end is the default for new remote vaults. In "Standard" mode, Obsidian holds the key. Metadata visible to the server even with E2EE: which device uploaded or deleted a file and when, the mapping between encrypted paths and encrypted content, and deterministically encrypted file hashes (which allow deduplication). Hosting is on DigitalOcean in 4 regions — [Sync security](https://obsidian.md/help/sync/security).
- Selective sync covers images, audio, video, and PDFs by default; "other types" is opt-in. Hidden files and folders are always excluded except the config folder. "Adding a file to the Excluded files list does not remove it from the remote vault if it has already been synced." Sync settings are per-device — [Sync settings](https://obsidian.md/help/sync/settings).
- Headless: Obsidian announced headless Sync support on 2026-02-27 — [Obsidian changelog 2026-02-27](https://obsidian.md/changelog/2026-02-27-sync). The `obsidian-headless` npm CLI (`ob`) needs Node 22+. It has a `--continuous` watch mode, sync modes `bidirectional`, `pull-only`, and `mirror-remote`, `--conflict-strategy merge|conflict`, per-category config sync (`app`, `appearance`, `hotkey`, `core-plugin`, `community-plugin`, and their `-data` variants), `--excluded-folders`, and `--device-name` — [obsidianmd/obsidian-headless README](https://github.com/obsidianmd/obsidian-headless). Latest release is 0.0.14 (2026-07-30). The repository has no LICENSE file, and `package.json` says `"license": "UNLICENSED"` with author "Dynalist Inc."; it ships only a bundled `cli.js` — [obsidianmd/obsidian-headless](https://github.com/obsidianmd/obsidian-headless).

**Self-hosted LiveSync (vrtmrz) — MIT**
- MIT. Latest release 1.0.38 on 2026-10-17; last push 2026-10-19; about 12.7k stars — [vrtmrz/obsidian-livesync](https://github.com/vrtmrz/obsidian-livesync).
- Architecture: Obsidian vault events go into a local PouchDB, which replicates to a remote CouchDB. Other devices watch the CouchDB changes feed and write changes back to their vault. A queued DELETE "requests a database change; it is not itself an instruction to delete the physical file". The library revalidates a deletion before it removes a vault file (from Commonlib 0.1.23) — [docs/tech_info.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/tech_info.md).
- Data model: each file is a metadata document with `children` = an ordered list of content-addressed chunk IDs. Chunks are always persisted before the metadata that names them. Logical deletion (`deleted: true`) is separate from a CouchDB tombstone (`_deleted`). Document IDs derive from the path; optional path obfuscation and E2EE change the raw remote IDs — [docs/datastructure.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/datastructure.md).
- Journal sync (object storage, no CouchDB): each client records how far it has sent in its PouchDB journal. It uploads a "pack" of changes since that point, named with a timestamp prefix. It downloads unseen packs in name (date) order and applies them, leaving conflict resolution to PouchDB. Sync always receives first, and a client omits documents it already received, so it does not re-upload them. This needs only upload, download, and list operations, so it works on WebDAV, S3, R2, or MinIO — [design_docs_of_journalsync.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/design_docs_of_journalsync.md); setup guide at [setup_object_storage.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/setup_object_storage.md).
- Conflict rules in 1.0: PouchDB revision trees. Text and structured data use a conservative three-way merge from the nearest shared available ancestor. Missing or compacted history "stops conservative automatic merge instead of guessing a base". "File bytes, rather than path, size, modification time, or revision generation, determine whether content is known." Each device records the exact revision last reflected into each vault file. A cross-path rename "stores the target before logically deleting only the displayed source branch". Two devices that create the same path with different bytes give two versions for manual selection, with no empty-base merge. Binary conflicts still pick the newer mtime as legacy behaviour — [specs_conflict_resolution.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md).
- E2EE V2 with "Property Encryption" also encrypts paths, times, sizes, and chunk references for Hidden File Sync metadata. P2P (WebRTC with signalling and TURN), Hidden File Sync, and Customisation Sync are "supported, opt-in". Ignore files and automatic newer-file resolution are beta — [docs/settings.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md); P2P docs at [p2p_sync_updates_2026.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/p2p_sync_updates_2026.md).

**Remotely Save (remotely-save/fyears) — Apache-2.0 + PolyForm Strict 1.0.0 (split)**
- License split: `src`, `tests`, `docs`, `assets` use Apache-2.0. `pro/` uses "PolyForm Strict License 1.0.0" — [LICENSE](https://github.com/remotely-save/remotely-save/blob/master/LICENSE). The `pro/` folder was added on 2024-05-26 ("pro and smart conflict") — [commit history of pro/LICENSE](https://github.com/remotely-save/remotely-save/commits/master/pro/LICENSE).
- The free build's core sync engine is in `pro/`: `src/main.ts` contains `import { syncer } from "../pro/src/sync";`. `pro/src` also holds `conflictLogic.ts`, `clearDupFiles.ts`, `localdb.ts`, and Google Drive/Box/pCloud/Yandex/Koofr/Azure/OneDrive-full backends — [remotely-save repo](https://github.com/remotely-save/remotely-save/tree/master/pro/src). Free tier conflict options are "keep newer" or "keep larger". The paid "Smart Conflict" merges small Markdown files or duplicates large or non-Markdown files — [pro/README.md](https://github.com/remotely-save/remotely-save/blob/master/pro/README.md).
- Algorithm V3 (design drafted 2024-01-17, in Apache `docs/`) is stateless on the remote ("no remote meta data any more"). It uses 3 inputs: local listing, remote listing, and "local previous succeeded sync history". It has a 4x4 decision table (unchanged/modified/deleted/created on each side) with numbered decision branches, plus push-only and pull-only variants. It credits syncrclone, rsinc, and rclone bisync (all MIT) — [docs/sync_algorithm/v3/design.md](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/design.md). It also has "sync protection: warning based on the threshold" (abort if more than N% of files would change) — [v3 intro](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/intro.md).
- At the parent of the pro commit (0802767, 2024-05-25), `src/sync.ts` with the V3 decision branches existed under a repo-wide Apache-2.0 LICENSE — [src/sync.ts @0802767](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/sync.ts), [LICENSE @0802767](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/LICENSE).
- Maintenance: last release 0.5.25 (2024-10-20); last commit 2024-11-10; 231 open issues (2026-10-19) — [remotely-save repo](https://github.com/remotely-save/remotely-save). On 2026-10-17 a user offered to co-maintain, citing about 17,000 new downloads/week and no release since October 2024 — [issue #1200](https://github.com/remotely-save/remotely-save/issues/1200). On 2026-10-16 a fork maintainer asked permission to publish a derivative and asked how `pro/` code may be distributed. The issue notes that the directory policy rejects forks without written approval or ≥6 months of inactivity with 30-day notice — [issue #1199](https://github.com/remotely-save/remotely-save/issues/1199).

**Remotely Sync (sboesen) — Apache-2.0**
- A fork of Remotely Save made before the `pro/` split. It is Apache-2.0 only (no `pro/` folder). Last release 0.4.49 on 2024-05-04; no pushes since. **Stale (2024 information).** — [sboesen/remotely-sync](https://github.com/sboesen/remotely-sync).
- Its security changes vs upstream: AES-GCM instead of the earlier scheme, 16-byte salt (was 8), and an IV no longer derived from the password. It is not backwards compatible with Remotely Save — [README](https://github.com/sboesen/remotely-sync).

**Relay (System 3 / No Instructions LLC) — plugin MIT; server MIT (y-sweet fork); control plane proprietary**
- Plugin: MIT. Latest release 0.8.12 (2026-09-09); last push 2026-10-19 — [No-Instructions/Relay](https://github.com/No-Instructions/Relay). It uses yjs 13.6.33, y-protocols, lib0, diff-match-patch, and CodeMirror 6 bindings — [package.json](https://github.com/No-Instructions/Relay/blob/main/package.json).
- Storage split: Markdown, canvases, and folders live in "document storage ... backed by our real-time CRDT servers". Bases, images, audio, video, PDFs, and other files are "file blobs" in attachment storage. The plugin is local-first and merges offline edits through Yjs. "Our login, permissions, and billing server code is proprietary" — [Relay README FAQ](https://github.com/No-Instructions/Relay).
- Server: "a fork of jamsocket/y-sweet" built on y-crdt (Rust). It persists to S3-compatible storage (S3, Cloudflare R2, MinIO), with the R2 + Docker setup recommended. It has single-server or session-per-document models, a Python SDK, and webhooks. Auth uses Relay control-plane public keys. "Using a Self-Hosted Relay Server with more than 3 collaborators requires a paid license" — [relay-server README](https://github.com/No-Instructions/relay-server). The LICENSE is MIT (© 2025 No Instructions, LLC) with appended MIT notices for y-sweet (© 2023 Drifting in Space Corp.) and y-crdt; GitHub reports it as "NOASSERTION" for this reason. Latest release 0.12.7 (2026-09-01) — [relay-server LICENSE](https://github.com/No-Instructions/relay-server/blob/main/LICENSE).
- Git bridge: `relay-git-sync` (MIT, created 2025-08-07) syncs Relay server updates to Git — [No-Instructions/relay-git-sync](https://github.com/No-Instructions/relay-git-sync).
- Pricing: Free ($0; 3 users, 2 devices each, .md only in cloud, self-host allowed). Hobby ($5/month total; 6 users, 10 GB). Starter ($6/user/month; 20 GB + 5 GB/user, SSO, RBAC). Premium ($18/user/month; Git sync, Document API). Enterprise is custom — [relay.md/pricing](https://relay.md/pricing).

**Peerdraft — GPL-3.0**
- GPL-3.0. Latest release 2.23.3 (2026-08-25) — [peerdraft/obsidian-plugin](https://github.com/peerdraft/obsidian-plugin).
- Uses Yjs with y-webrtc (peer-to-peer, E2E-encrypted "fleeting sessions" where no content passes through the servers), y-websocket (persistent shares), y-indexeddb (local persistence), and y-codemirror.next. It offers folder sharing and a web editor. Paid accounts start at 30 USD/year — [README and package.json](https://github.com/peerdraft/obsidian-plugin).

**Screen Garden (screengarden, LLC) — closed license**
- Early access launched about February 2025 (inferred from an announcement dated 2025-04-02 saying "Two months ago"). It offered multiplayer with live cursors, web access, and Markdown sync, and synced all file types from 2025-04-02. Price was $4/month for the first three people with 10 GB (2025 figure). Self-hosting requests in Nov 2025 got no visible answer — [forum thread](https://forum.obsidian.md/t/screen-garden-multiplayer-collaboration-web-editing-and-general-sync/99110).
- The plugin is closed-license, and a forum user says it does not sync plugins — [search summary of community listing/forum](https://community.obsidian.md/plugins/screengarden-obsidian). The architecture (CRDT library, protocol) is not published.

**Obsidian Git (Vinzent03) — MIT**
- MIT. Latest release 2.42.0 (2026-10-18). Very active — [Vinzent03/obsidian-git](https://github.com/Vinzent03/obsidian-git).
- On mobile it uses isomorphic-git (pure JS), and the docs call it "**very unstable**". Limits: no SSH, repo size limited by memory, no rebase, no submodules or symlinks. Filenames valid on macOS can fail on Android. The docs recommend GitSync or Working Copy for mobile — [docs (Installation / Tips-and-Tricks)](https://github.com/Vinzent03/obsidian-git/tree/master/docs). Open issues: "Optimize on mobile - replace isomorphic-git with wasm-git" (#572, 44 reactions) and "Obsidian closes during initial clone" (#694) — [issues](https://github.com/Vinzent03/obsidian-git/issues/572).

**Syncthing / Möbius Sync (iOS)**
- Möbius FAQ: "No iOS app can run continuously in the background". iOS schedules background runs adaptively. Sync "may take 24 hours to start" and gives about 1-2 hours of sync activity/day once stable — [Möbius FAQ](https://mobiussync.com/faq/). Users work around this with Shortcuts automations (open Möbius, wait, then open Obsidian) — [forum](https://forum.obsidian.md/t/sync-mac-pc-and-ios-using-syncthing-mobius-sync/72022). The free tier is 20 MB; unlimited is a one-time $4.99. SyncTrain is an open-source alternative (2026 guide) — [stephanmiller.com](https://www.stephanmiller.com/sync-obsidian-iphone-ipad-free/).
- An Obsidian–Syncthing integration plugin (MIT, active, pushed 2026-10-19) exists — [LBF38/obsidian-syncthing-integration](https://github.com/LBF38/obsidian-syncthing-integration).

**iCloud Drive**
- Users report "(1), (2)" duplicate files, files stuck in pending state, and iOS re-downloading the whole vault and getting stuck at startup. These problems are worst with iCloud for Windows. The common advice is not to combine iCloud with another sync method — [iCloud sync issues](https://forum.obsidian.md/t/icloud-sync-issues/28320), [iCloud duplicates](https://forum.obsidian.md/t/icloud-duplicates/27138), [iOS redownloading](https://forum.obsidian.md/t/icloud-drive-files-keep-redownloading-after-a-period-of-time-causing-ios-apps-startup-to-be-stuck/21208). (These threads date from 2021-2023; they are older information.)

**Notable 2025-2026 newcomers (GitHub search, pushed after 2025-06-01)**
- **Fast Note Sync** (haierkeys): the plugin is Apache-2.0 (about 3.1k stars, release 2.4.0 on 2026-07-20); the server is Go and Apache-2.0 (fast-note-sync-service 3.6.1, 2026-08-14). It does real-time sync of create, update, and delete; merges offline edits on reconnect; and offers REST and MCP services. `.obsidian` config sync is "in testing". It has no E2EE (roadmap only) — [plugin](https://github.com/haierkeys/obsidian-fast-note-sync), [service](https://github.com/haierkeys/fast-note-sync-service).
- **Obsidian Decentralized** (morewebs): GPL-3.0, created 2025-07-14. Peer-to-peer over WebRTC (PeerJS) on the local network, with a "Conflict Center" and opt-in attachment and config sync — [repo](https://github.com/morewebs/obsidian-decentralized).
- **BYOC** (winters27): MIT, created 2026-04-17. Calls itself "a community-maintained fork of ... Remotely Save". It ships Google Drive, Box, pCloud, Yandex, Koofr, and Azure backends and a `smart_conflict` option, with `src/` file names that match upstream `pro/src` — [repo](https://github.com/winters27/obsidian-byoc).
- **Quilden-Sync**: MIT, 2026-03. GitHub-backed with E2EE and file history — [repo](https://github.com/AA1labs/Quilden-Sync). **obsidian-diy-sync**: MIT. An Express server and plugin — [repo](https://github.com/CobyPear/obsidian-diy-sync).
- **Name collision**: `less1001/obsync` (MIT, created 2026-06-18) is a "WeChat & Web to Obsidian Sync Engine (Cloudflare Workers + Obsidian Plugin)" — [repo](https://github.com/less1001/obsync). A "dvcrn obsync" skill listing also appears on skill directories — [skillsdirectory](https://www.skillsdirectory.com/skills/dvcrn-obsy).

### Inferences
- LiveSync's journal-sync design (append-only timestamped packs on object storage plus a per-client cursor) maps directly to R2. The CouchDB revision-tree model gives it ancestry for three-way merges. Obsy could take the same ideas: content-addressed chunks, per-device "displayed revision" provenance, and a byte-based "is this known content" check.
- Relay shows that Yjs + y-sweet-style per-document servers + R2 is a working commercial architecture for Obsidian. Its split of "CRDT for Markdown, blobs for attachments" is the established pattern.
- Obsidian Sync's diff-match-patch auto-merge can duplicate text, so even the official product added a "create conflict file" option. A server-side AI writer increases concurrent-edit frequency, so a pure DMP merge alone is risky.
- BYOC appears to have moved PolyForm-Strict `pro/src` code into an MIT `src/`. I did not diff the file contents, so this is unverified. If true, it is a licensing problem, and obsy should not take code from BYOC.

### Gaps
- I did not fetch Obsidian Sync's protocol details; it is closed source. Whether `workspace.json` syncs is not stated on the settings page.
- Screen Garden's architecture and current (2026) pricing are not published in the sources I found.
- I did not check Möbius Sync, iCloud, or Peerdraft server licenses or the current Peerdraft pricing page.
- The headless Sync help page (help.obsidian.md/sync/headless) was not fetched directly.
- The obsidianstats/community directory list was not exhaustively scanned for sync plugins. The newcomer list comes from one GitHub search sorted by stars.

## 2. What can be read, reused, or must not be copied

### Takeaway
MIT and Apache-2.0 code is reusable with notices: LiveSync, Relay plugin and server (plus y-sweet/y-crdt notices), Obsidian Git, Remotely Save `src/` and the pre-2024-05-26 tree, Remotely Sync, Fast Note Sync, BYOC (but see the caveat), and the Syncthing integration. GPL-3.0 (Peerdraft, Obsidian Decentralized) forces obsy's plugin to be GPL if code is copied. Remotely Save's current `pro/` (PolyForm Strict), Obsidian Sync and obsidian-headless (UNLICENSED/proprietary), Relay's control plane, and Screen Garden (closed) must not be copied.

### Cited Findings
- Self-hosted LiveSync: MIT — [repo](https://github.com/vrtmrz/obsidian-livesync). Its core logic lives in `@vrtmrz/livesync-commonlib` — [specs_conflict_resolution.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md). (I did not check commonlib's own license.)
- Relay plugin: MIT; Relay server: MIT, with y-sweet (MIT, © 2023 Drifting in Space Corp.) and y-crdt notices that must be kept. The control plane is proprietary — [Relay README](https://github.com/No-Instructions/Relay), [relay-server LICENSE](https://github.com/No-Instructions/relay-server/blob/main/LICENSE).
- Remotely Save `src/tests/docs/assets`: Apache-2.0. `pro/`: PolyForm Strict 1.0.0 — [LICENSE](https://github.com/remotely-save/remotely-save/blob/master/LICENSE). The V3 algorithm design doc is in `docs/`, so it is Apache-2.0 — [design.md](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/design.md). The V3 `src/sync.ts` at commit 0802767 (2024-05-25) is under Apache-2.0 — [LICENSE @0802767](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/LICENSE).
- PolyForm Strict 1.0.0 requires agreeing to its terms "as both strict obligations and conditions" — [pro/LICENSE](https://github.com/remotely-save/remotely-save/blob/master/pro/LICENSE); [polyformproject.org/licenses/strict/1.0.0](https://polyformproject.org/licenses/strict/1.0.0/).
- Remotely Save's V3 design credits syncrclone, rsinc, and rclone bisync, "All ... released under MIT License" — [design.md](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/design.md).
- Remotely Sync: Apache-2.0 — [repo](https://github.com/sboesen/remotely-sync). Obsidian Git: MIT — [repo](https://github.com/Vinzent03/obsidian-git). Fast Note Sync plugin and service: Apache-2.0 — [plugin](https://github.com/haierkeys/obsidian-fast-note-sync), [service](https://github.com/haierkeys/fast-note-sync-service). Peerdraft: GPL-3.0 — [repo](https://github.com/peerdraft/obsidian-plugin). Obsidian Decentralized: GPL-3.0 — [repo](https://github.com/morewebs/obsidian-decentralized). obsidian-api types: MIT — [obsidianmd/obsidian-api](https://github.com/obsidianmd/obsidian-api).
- obsidian-headless: `"license": "UNLICENSED"`, no LICENSE file, bundled `cli.js` only — [repo](https://github.com/obsidianmd/obsidian-headless).
- Screen Garden: closed license — [community listing via search](https://community.obsidian.md/plugins/screengarden-obsidian).
- Obsidian community directory policy (as quoted in a 2026 issue): forks are not accepted without explicit, verifiable approval from the original author, or ≥6 months of inactivity plus a 30-day public notice — [remotely-save #1199](https://github.com/remotely-save/remotely-save/issues/1199).

### Inferences
- Attribution obligations. MIT: keep the copyright and permission notice in copies or substantial portions. Apache-2.0: keep the LICENSE, any NOTICE file, and copyright headers, and state significant changes in modified files. For a Relay-server-derived Worker, also keep the y-sweet and y-crdt MIT notices. A `THIRD_PARTY_NOTICES` file in obsy would cover this.
- Reading PolyForm Strict or proprietary code for ideas is a legal grey zone. To stay safe, obsy should base its design on the Apache-2.0 `docs/` (V3 design tables) and the pre-split Apache `src/sync.ts`, not on current `pro/src/sync.ts` or `conflictLogic.ts`.
- Copying from Peerdraft or Obsidian Decentralized would make obsy's distributed plugin GPL-3.0. Use them for ideas only, or accept GPL.
- If obsy is published to the community directory, it should be an independent codebase, not a fork, to avoid the fork-approval rule.

### Gaps
- Licenses of `@vrtmrz/livesync-commonlib`, Möbius Sync, the GitSync app, and Screen Garden's exact license text were not verified.
- This is not legal advice. The PolyForm "read for ideas" question needs counsel if it becomes important.

## 3. Common failure modes and data-loss reports

### Takeaway
The recurring failures are wrong deletion propagation (deleted files returning, or files vanishing), duplicate files, conflicts caused by mtime or clock skew, path normalization (Unicode NFC/NFD, case, illegal characters), rename races with Obsidian's "update links" flow, partial uploads (0-byte or missing-chunk files marked "synced"), iOS background limits, and interference when two sync systems run at once.

### Cited Findings
- Obsidian Sync: a folder deleted after a merge reappeared on several devices, and about 40 notes were missing from "Deleted files". Other reports: repeated restoration of deleted files across phone/Windows/iPad/Mac, files deleted on close without trash, and content emptied while titles stayed — [forum: deleted files restoring](https://forum.obsidian.md/t/obsidian-sync-repeatedly-restoring-deleted-files/81711/6), [hundreds of notes disappeared](https://forum.obsidian.md/t/hundreds-of-notes-have-disappeared-after-a-sync/105832), [data-loss tag](https://forum.obsidian.md/tag/data-loss). These are user reports without official root causes.
- Obsidian Sync docs: problems occur "when Obsidian Sync runs alongside another syncing service". Illegal-character filenames can cause files to vanish on secondary devices. Android Photos can delete received attachments (fix: `.nomedia`). Plugin settings need a restart to apply — [Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot).
- LiveSync 2026 issues: "Document IDs fold case but not Unicode normalisation, making NFD-named files invisible on iOS" (#1259) and NFC path identity (#1261). "Prevent stale local files from replacing newer database content" (#1201). "v1.0.30 frequently reports conflicts even though the receiving device has no local changes" (#1207, open). "Sync broken on ios" (#1189, open). Colon-containing paths (#1209). A custom config passphrase silently clears E2EE settings after restart (#1238) — [LiveSync issues](https://github.com/vrtmrz/obsidian-livesync/issues?q=is%3Aissue). LiveSync also documents unreadable revisions from missing chunks and keeps them rather than deleting them — [specs_conflict_resolution.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md).
- Remotely Save: "deleted file on server gets re-created by plugin" (#302), "Deleted files come back" (#985, open, 2025), "Bidirectional synchronization mode does not work correctly" (#991, open), "Changing vault path triggers false 'files >= 50% modified' detection" (#945), and 429 rate limits (#1026) — [remotely-save issues](https://github.com/remotely-save/remotely-save/issues/985).
- Relay 0.8.12 (Sept 2026): adding a shared folder on a second device "left 1 of 23 files empty (0 bytes) on both devices with status 'Synced'" (#137). A rename received from the server opens Obsidian's "Update links" prompt; later renames stall while it is open, and answering it "deletes a note on the member and writes broken links" (#136). Fix PRs: "do not republish files removed remotely while this client was offline" (#125), "retry attachment uploads and heal content missing from storage" (#129/#131), and "gate frontmatter Y.Map value writes on provider sync" (#127) — [Relay issues](https://github.com/No-Instructions/Relay/issues/136).
- Obsidian Git mobile: crashes during initial clone (#694), and repo size is limited by memory — [issue #694](https://github.com/Vinzent03/obsidian-git/issues/694), [docs](https://github.com/Vinzent03/obsidian-git/tree/master/docs).
- iOS background: Möbius can sync only while open or when iOS wakes it briefly (up to 24 h to start) — [Möbius FAQ](https://mobiussync.com/faq/). Obsidian Sync on mobile likewise has a long-running feature request to "work in background" — [forum](https://forum.obsidian.md/t/make-obsidian-sync-work-in-background-on-mobile/25906?page=4).
- iCloud: duplicates "(1), (2)", stuck pending files, and iOS re-downloads blocking startup — [forum](https://forum.obsidian.md/t/icloud-duplicates/27138), [forum](https://forum.obsidian.md/t/icloud-drive-files-keep-redownloading-after-a-period-of-time-causing-ios-apps-startup-to-be-stuck/21208) (older, 2021-2023).

### Inferences
- Most data loss comes from treating "absent locally" as "deleted" without a base or provenance. LiveSync (deletion revalidation) and Relay (#125) both added explicit guards in 2026.
- macOS/iOS filenames are often NFD while other systems use NFC. Obsy must normalize path identity (NFC) and decide its case-sensitivity policy before it computes IDs.

### Gaps
- No quantitative data-loss rates exist for any tool. All evidence is issue or forum reports.

## 4. Handling of `.obsidian`, workspace files, and plugin data

### Takeaway
Every mature tool treats `.obsidian` as opt-in and category-based, not as ordinary vault content. Workspace files are excluded, and plugin settings need a restart.

### Cited Findings
- Obsidian Sync: the config folder is the only hidden folder that syncs. Categories are settings, appearance, themes/snippets, hotkeys, core plugin list and settings, and (opt-in) community plugin list and data. CSS, graph settings, and core-plugin enable states need a reload; community plugins "typically ... require a restart". Profiles can use an alternate config folder such as `.obsidian-mobile` (must start with a period) — [Sync settings](https://obsidian.md/help/sync/settings). JSON config conflicts merge local keys over remote — [troubleshoot](https://obsidian.md/help/sync/troubleshoot). Headless exposes the same categories plus `--config-dir` — [obsidian-headless README](https://github.com/obsidianmd/obsidian-headless).
- LiveSync: Hidden File Sync and Customisation Sync are opt-in. They are initialized separately on each device after note sync works and stored under `i:`/`ix:` namespaces. E2EE V2 Property Encryption can encrypt their metadata — [settings.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md), [datastructure.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/datastructure.md).
- Obsidian Git recommends gitignoring `.obsidian/workspace.json` and `.obsidian/workspace-mobile.json` (or all of `.obsidian`). It warns that iCloud syncing `.git` to mobile slows startup — [Tips-and-Tricks](https://github.com/Vinzent03/obsidian-git/blob/master/docs/Tips-and-Tricks.md).
- Remotely Save: a feature request for pushing and pulling `.obsidian` files (#351) — [issue](https://github.com/remotely-save/remotely-save/issues/351). Fast Note Sync: config sync "in testing, use with caution" — [repo](https://github.com/haierkeys/obsidian-fast-note-sync). Screen Garden reportedly does not sync plugins — [search summary](https://community.obsidian.md/plugins/screengarden-obsidian). Relay syncs only designated shared folders — [Relay README](https://github.com/No-Instructions/Relay).

### Inferences
- Obsy should exclude `workspace*.json` and the sync plugin's own `data.json` (credentials) by default. It should make config sync opt-in per category, and it should never let the AI agent write to the config dir.

### Gaps
- Obsidian Sync's treatment of `workspace.json` is not documented on the pages fetched.

## 5. Lessons that should shape obsy's design

### Takeaway
Use base-aware (three-way) decisions with stored per-device provenance and content hashes, not mtimes. Treat deletes as explicit tombstones with revalidation and mass-change guards. Store Markdown in a mergeable form (CRDT or ancestor-based merge) and attachments as content-addressed blobs. Accept that iOS cannot sync in the background. Make the server-side AI writer a first-class device with its own identity and branch.

### Cited Findings (evidence behind each lesson)
- Decide by content bytes and recorded ancestry, not path/size/mtime/generation — [LiveSync conflict spec](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md). Without a shared base, do not guess: keep both versions — [same](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md).
- Use a three-input state machine (local, remote, last-synced snapshot) with a full decision table and a mass-change abort threshold — [Remotely Save V3 design (Apache-2.0 docs)](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/design.md).
- An append-only journal plus per-client cursor on object storage needs only put/get/list. "Receive first, then send" avoids re-uploading — [LiveSync journal design](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/design_docs_of_journalsync.md).
- A Yjs doc per Markdown file, a y-crdt server persisting to R2, blobs for attachments, and a separate auth control plane — [relay-server](https://github.com/No-Instructions/relay-server), [Relay FAQ](https://github.com/No-Instructions/Relay).
- Offer an explicit "conflict file" option, because DMP auto-merge can duplicate text — [Obsidian Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot).
- Expose device identity in history, plus pull-only and mirror modes for headless or agent clients — [obsidian-headless](https://github.com/obsidianmd/obsidian-headless).
- Renames must not trigger Obsidian's link-update prompt in a way that deletes notes. Do not republish remotely-deleted files after offline periods. Verify attachment upload completion before marking a file synced — [Relay #136/#125/#129/#137](https://github.com/No-Instructions/Relay/issues/136).
- Normalize Unicode (NFC) and handle case-folding and illegal characters across platforms — [LiveSync #1259](https://github.com/vrtmrz/obsidian-livesync/issues/1259), [Obsidian Git docs](https://github.com/Vinzent03/obsidian-git/tree/master/docs), [Obsidian Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot).
- iOS gives no reliable background execution, so sync on foreground/open and on save — [Möbius FAQ](https://mobiussync.com/faq/).
- Don't coexist with iCloud or another sync on the same vault — [Obsidian Sync troubleshoot](https://obsidian.md/help/sync/troubleshoot), [iCloud threads](https://forum.obsidian.md/t/icloud-sync-issues/28320).
- E2EE still leaks metadata (paths→content mapping, device, time, deterministic hashes) unless designed otherwise — [Obsidian Sync security](https://obsidian.md/help/sync/security). Encrypting metadata is possible but opt-in in LiveSync — [settings.md](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/settings.md).
- The obsy name is already used by at least one MIT project with a similar stack (Cloudflare Workers + Obsidian plugin) — [less1001/obsync](https://github.com/less1001/obsync).

### Inferences
- Server-side AI writes conflict with E2EE. If the agent writes on the server, the server must hold plaintext or keys (like Obsidian Sync "Standard" mode). This is a product decision to make explicitly.
- The AI agent should write as a distinct device. Its edits should be on a branch with recorded ancestry (or Yjs ops), never as blind full-file overwrites, and it should be rate-limited so it does not trigger mass-change guards. It should avoid frontmatter races (compare Relay #127).
- Chunked, content-addressed storage (LiveSync) gives dedupe and resumable upload on R2. A Durable Object per vault can serialize the journal and cursor without CouchDB.
- Keep a local and server version history independent of sync state. Every data-loss thread ends with "recover from backup/Git".

### Gaps
- No source compared CRDT vs three-way-merge failure rates for Obsidian specifically.
- I found no published design from any project for an AI agent writing to a synced vault server-side. That pattern appears to be novel.
