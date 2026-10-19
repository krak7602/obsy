---
title: Roadmap
aliases: [build plan, phases, open questions, risks]
updated: 2026-10-20
---

# Roadmap

## Current

Status: accepted plan. The workspace is scaffolded ([toolchain](decisions/2026-10-20-toolchain.md)); phase 0 is in progress. Platform probe: built; iPhone run pending ([runbook](runbooks/platform-probe.md)).

### Build phases

| Phase | Scope | Done when |
| --- | --- | --- |
| 0. Spikes | `@obsy/merge` against a corpus of real edits; conditional-create race test on R2; `requestUrl`, hashing, and IndexedDB measured on an iPhone | Results recorded; open decisions settled |
| 1. Protocol and core | `@obsy/protocol`, `@obsy/core`, `@obsy/storage-s3`, `@obsy/storage-r2`, the simulator, and the conformance suite | Simulator invariants hold over at least 1M seeds; R2 passes conformance |
| 2. Desktop plugin | Scanner, three trees, journal, join, editor-safe apply, rails; first run pull-only against a copy of a vault | The copy converges and `verify` shows no differences; forced conflicts produce correct copies |
| 3. iOS | Lifecycle, chunked attachments, `SecretStorage`, pairing, BRAT release | Offline phone edits, app kills mid-upload, NFD and case cases: no loss, no duplicates |
| 4. Agent SDK and CLI | Operations, fences, presence deferral, proposals, provenance, undo; an existing agent moves its daily-note writes onto the SDK | Concurrent human and agent edits on the daily note merge with no silent loss |
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
| Whether `requestUrl` and `SecretStorage` behave on iOS as documented | Open; phase 0 spike. Neither the HTTP stack nor the storage backing is publicly specified. Probe built ([platform probe](runbooks/platform-probe.md)); iPhone run pending. |
| Whether R2 conditional creates are atomic under real races | Open; phase 0 spike and conformance suite |
| Whether Obsidian loads the Rolldown-built `main.js` | Open; phase 2, in a scratch vault. The probe's `main.js` is built the same way, so its first run answers this too. |
| How to run `eslint-plugin-obsidianmd` review rules, given typescript-eslint does not support TypeScript 7 | Settled: a separate ESLint run on TypeScript 6 in the plugin package ([toolchain](decisions/2026-10-20-toolchain.md)) |

### Risks

In order of severity, from the research, restated for the accepted design:

1. **History-destroying GC bugs.** R2 has no versioning. Soft-delete blobs, delay GC, keep GC an explicit `obsy gc` run, and keep independent exports.
2. **Editor clobbering on open notes.** The platform exposes no dirty flag. Test the editor-transaction path hard.
3. **Wrong ordering from union auto-merge** of concurrent appends. Acceptable for check-ins, but needs corpus evidence.
4. **iOS suspension mid-write.** Mitigated by the journal-first design and idempotent commits.
5. **Unicode and case collisions** across macOS and iOS. Obsidian itself regressed on NFD in 2026.
6. **Agent runaway edits.** Capped by rate limits, missing delete rights, and mass-change rails.
7. **Shared Cloudflare allowances and deploy coupling.** R2 allowances are account-wide whenever the bucket is R2. Deploy coupling applies only to the optional relay; keep it in its own Worker.
8. **Licence contamination** from reading PolyForm or GPL code. See [Clean-room licensing](concepts/clean-room-licensing.md).

Facts that the research could not verify: Cloudflare's per-object storage figure on Free, whether R2 `put` rejects a mismatched `sha256`, and the WebSocket attachment size (16 KiB versus the older 2 KiB).

## History

- 2026-10-20: Workspace scaffolded; added the plugin build and lint questions.
- 2026-10-20: Phase 0 platform probe built; iPhone run pending.
- 2026-10-19: Build plan accepted, from the former `DESIGN.md`. Open questions and risks carried over from the [research](learning/sync-design-research.md#open-questions-and-risks), with their state under the accepted design.
