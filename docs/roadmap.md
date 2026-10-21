---
title: Roadmap
aliases: [build plan, phases, open questions, risks]
updated: 2026-10-21
---

# Roadmap

## Current

Status: accepted plan. Phases 0 to 2 are done, except a corpus of real concurrent edits, which needs real use. Phase 4 is built: the agent SDK and the `obsy` command pass the simulator over one million seeds and a desktop test next to a person typing; moving an existing agent onto it waits for the cutover ([agent SDK, phase 4](learning/agent-sdk-phase4.md)). Phase 3 is done: its parts pass the simulator, the desktop test, and one iPhone run of all 8 test steps, and beta 0.1.0 is a GitHub pre-release for BRAT ([mobile sync, phase 3](learning/mobile-sync-phase3.md)). Phase 2 is done: the desktop plugin passed its test in Obsidian on macOS with a copy of a real vault, and with generated vaults ([desktop plugin, phase 2](learning/desktop-plugin-phase2.md)). Phase 1 is done: the protocol, the sync engine, and the simulator exist, the engine held every invariant over one million seeds ([simulator results](learning/simulator-phase1.md)), and R2 passed conformance through the S3 API and through the Workers binding ([R2 binding live run](learning/r2-binding-live.md)). Phase 0 results: the [storage spike](learning/storage-spike.md) passed on local servers and on live R2, the [merge spike](learning/merge-spike.md) and the [merge diff replacement](learning/merge-diff.md) ran on generated inputs and on generated edits to real notes, and the [iPhone probe](learning/iphone-probe.md) passed. A corpus of real concurrent edits is deferred to phase 2.

### Build phases

| Phase | Scope | Done when |
| --- | --- | --- |
| 0. Spikes | `@obsy/merge` against a corpus of real edits ([merge spike](learning/merge-spike.md), [merge diff](learning/merge-diff.md): synthetic inputs and generated edits on real notes done; real concurrent edits deferred to phase 2); conditional-create race test on R2 ([storage spike](learning/storage-spike.md): done, passes); `requestUrl`, hashing, and IndexedDB measured on an iPhone ([iPhone probe](learning/iphone-probe.md): done, passes) | Results recorded; open decisions settled |
| 1. Protocol and core | `@obsy/protocol`, `@obsy/core`, `@obsy/storage-s3`, `@obsy/storage-r2`, the simulator, and the conformance suite (done: 1M seeds pass, [results](learning/simulator-phase1.md); R2 passes conformance through the S3 API and through the Workers binding, [results](learning/r2-binding-live.md)) | Simulator invariants hold over at least 1M seeds; R2 passes conformance |
| 2. Desktop plugin | Scanner, three trees, journal, join, editor-safe apply, rails; first run pull-only against a copy of a vault (done: passes in Obsidian 1.14.4 on macOS with a copy of a real vault, [results](learning/desktop-plugin-phase2.md)) | The copy converges and `verify` shows no differences; forced conflicts produce correct copies |
| 3. iOS | Lifecycle, chunked attachments, `SecretStorage`, pairing, BRAT release (done: desktop and iPhone tests pass, [results](learning/mobile-sync-phase3.md); beta 0.1.0 released for BRAT) | Offline phone edits, app kills mid-upload, NFD and case cases: no loss, no duplicates |
| 4. Agent SDK and CLI | Operations, fences, presence deferral, proposals, provenance, undo; an existing agent moves its daily-note writes onto the SDK (built: 1M seeds pass, the desktop test passes next to a person typing, [results](learning/agent-sdk-phase4.md); moving an existing agent not done) | Concurrent human and agent edits on the daily note merge with no silent loss |
| 5. Cutover | Replace the current sync method on the real vault (never run two sync systems at once), GC, scheduled export, conflict UI | Two weeks of real use with no unexplained `verify` differences |
| 6. Optional | Relay; encrypted folders; per-note live co-editing; MCP wrapper; community directory submission | When needed |

Record phase results as `docs/learning/` pages and link them here. Record the decisions they settle under `docs/decisions/`.

### Open questions

The research listed these questions. Some are now settled.

| Question | State |
| --- | --- |
| Default conflict form: copies or in-body diff3 markers | Settled: [conflict copies](decisions/2026-10-19-conflict-copies.md) |
| Retention for history and tombstones, and the maximum offline period | Settled: [retention defaults](decisions/2026-10-19-retention-defaults.md) |
| Store small Markdown revisions in Durable Object SQLite, or everything in R2 | No longer applies: the bucket is the store ([decision](decisions/2026-10-19-bucket-as-sequencer.md)) |
| Whether obsy is published, given the "obsync" name collision and directory review | Settled: renamed to obsy, publishing intended ([naming](decisions/2026-10-19-naming.md)) |
| Which folders, if any, become encrypted and unreadable by agents | Open; later work ([server-trusted v1](decisions/2026-10-19-server-trusted-v1.md)) |
| Which sync method the real vault uses today, and how to cut over from it | Open; phase 5 |
| Which existing agent moves its daily-note writes onto the SDK, and when | Open. It writes to the real vault, which obsy does not sync before the cutover; likely part of phase 5 |
| Whether to adopt Effect | Settled for now: no; reconsider for Node-only or Worker-only code such as the relay ([decision](decisions/2026-10-21-no-effect-for-now.md)) |
| Whether `requestUrl` and `SecretStorage` behave on iOS as documented | Settled for iOS 18.7 and Obsidian 1.14.5: yes, and their state survives an app kill. iOS stops the plugin about 4 s after the app is hidden ([iPhone probe](learning/iphone-probe.md)). |
| Whether R2 conditional creates are atomic under real races | Settled: yes in every live run, up to 32 concurrent writers; R2 answers same-key contention with 503s, so `@obsy/core` needs backoff ([storage spike](learning/storage-spike.md#cloudflare-r2)) |
| How `merge3` handles long notes made mostly of repeated lines (about 27 s at 5,000 such lines) | Settled: a Myers diff replaced `node-diff3` (1.5 ms at 5,000 lines), with a work limit that returns a conflict ([decision](decisions/2026-10-20-myers-diff-for-merge.md)) |
| How to collect the private corpus of real vault edits | Partly settled: generated edits on a copy of the real vault ran clean or conflicted as expected ([merge diff](learning/merge-diff.md#generated-corpus-on-real-notes)). Real concurrent edits will come from obsy's own history once the plugin is in real use ([merge corpus runbook](runbooks/merge-corpus.md)); none exist yet. |
| Whether Obsidian loads the Rolldown-built `main.js` | Settled: Obsidian on iOS loads the probe's `main.js`, built the same way ([iPhone probe](learning/iphone-probe.md)) |
| How to run `eslint-plugin-obsidianmd` review rules, given typescript-eslint does not support TypeScript 7 | Settled: a separate ESLint run on TypeScript 6 in the plugin package ([toolchain](decisions/2026-10-20-toolchain.md)) |
| How short a pairing code can be | Settled for now: it carries the credential, so it is long and shown as a QR code; a short code needs the relay ([decision](decisions/2026-10-21-pairing-and-size-limit.md)) |
| What the mobile attachment cap covers | Settled: only downloads of files the device does not hold; a wider cap lost content in the simulator ([decision](decisions/2026-10-21-pairing-and-size-limit.md)) |
| Which `minAppVersion` the plugin needs | Settled: 1.13.2, for the declarative settings API that the review rules require ([desktop decision](decisions/2026-10-21-desktop-plugin-choices.md)) |
| Whether sync deletes always go to the vault trash | Settled: no. The review rules require `fileManager.trashFile`, which follows the user's setting; the bucket history keeps the content ([desktop decision](decisions/2026-10-21-desktop-plugin-choices.md)) |

### Risks

In order of severity, from the research, restated for the accepted design:

1. **History-destroying GC bugs.** R2 has no versioning. Soft-delete blobs, delay GC, keep GC an explicit `obsy gc` run, and keep independent exports.
2. **Editor clobbering on open notes.** The platform exposes no dirty flag. The plugin compares the editor text with the file and refuses to write a note with unsaved edits; random tests with edits during syncs and the desktop test found no loss ([phase 2](learning/desktop-plugin-phase2.md)). A user save during Obsidian's own trash or binary write remains a narrow window.
3. **Wrong ordering from union auto-merge** of concurrent appends. Acceptable for check-ins, but needs corpus evidence. The [merge spike](learning/merge-spike.md) confirmed the rule on generated inputs only.
4. **iOS suspension mid-write.** Mitigated by the journal-first design and idempotent commits.
5. **Unicode and case collisions** across macOS and iOS. Obsidian itself regressed on NFD in 2026.
6. **Agent runaway edits.** Capped by hourly limits (commits and files), no delete, move, or whole-file rewrite, proposals for unsafe changes, and undo ([agent SDK](subsystems/agent-sdk.md#provenance-and-limits)). The guardrails do not stop a hostile agent that holds the bucket credential.
7. **Shared Cloudflare allowances and deploy coupling.** R2 allowances are account-wide whenever the bucket is R2. Deploy coupling applies only to the optional relay; keep it in its own Worker.
8. **Licence contamination** from reading PolyForm or GPL code. See [Clean-room licensing](concepts/clean-room-licensing.md).

Facts that the research could not verify: Cloudflare's per-object storage figure on Free, whether R2 `put` rejects a mismatched `sha256`, and the WebSocket attachment size (16 KiB versus the older 2 KiB).

## History

- 2026-10-21: Beta 0.1.0 released for BRAT; phase 3 is done.

- 2026-10-21: Phase 4 built: agent SDK, proposals, presence, undo, and the `obsy` command; one million seeds and the desktop test pass. Effect not adopted.

- 2026-10-21: iPhone test passed, all 8 steps; only the BRAT release is left in phase 3.
- 2026-10-21: Phase 3 parts built: stops when hidden, download size limit, chunked writes, pairing; desktop and simulator tests pass; iPhone test pending.
- 2026-10-21: Desktop plugin built and tested in Obsidian; phase 2 is done.
- 2026-10-20: The R2 Workers binding adapter passed live; phase 1 is done.
- 2026-10-20: Phase 1 core built; one million simulator seeds pass.
- 2026-10-20: Merge speed settled (Myers diff); generated corpus on real notes run.
- 2026-10-20: iPhone probe passed; the iOS platform and Rolldown questions are settled.
- 2026-10-20: Live R2 race runs passed; the R2 atomicity question is settled.
- 2026-10-20: Phase 0 storage and merge spikes ran locally, and the platform probe was built; added the merge speed and corpus questions.
- 2026-10-20: Workspace scaffolded; added the plugin build and lint questions.
- 2026-10-19: Build plan accepted, from the former `DESIGN.md`. Open questions and risks carried over from the [research](learning/sync-design-research.md#open-questions-and-risks), with their state under the accepted design.
