---
title: Three-way merge, not CRDTs
aliases: [CRDT rejected, Yjs, Loro, Automerge, diff3, merge primitive]
updated: 2026-10-19
status: accepted
---

# Three-way merge, not CRDTs

## Context

obsy must keep offline-edited plain Markdown safe. The workload is snapshot-based: a phone edits a note offline for hours, Obsidian rewrites links on rename, Templater creates files, and an agent writes check-ins into the daily note. The sync engine sees before-and-after files, not keystrokes.

## Decision

Stored truth is plain files with revisions. Concurrent edits are merged with a deterministic line-level three-way merge (`node-diff3`, MIT) with a Markdown layer, against a stored base. When the merge is not clean, obsy writes a visible conflict copy. CRDTs are not used for stored truth.

The current rules are on [Merge and conflicts](../subsystems/merge.md). On 2026-10-20 the diff library changed from `node-diff3` to a Myers diff ([decision](2026-10-20-myers-diff-for-merge.md)); the three-way merge approach is unchanged.

## Consequences

- Clients must store the base text of every Markdown file they last synced.
- Identical concurrent edits merge once instead of duplicating.
- Real-time co-editing of one note is not supported in version 1. A per-note CRDT session, seeded from head and committed back as a normal revision, can be added later.
- No WASM is needed on mobile.

## Evidence

- A CRDT kept in step with plain files must diff every outside change in. In a local test on 2026-10-19, two Yjs replicas that received the same external edit kept the edited line twice. `git merge-file` merged the same case once ([merge notes](../learning/research-notes/merge-algorithms.md#2-applying-a-crdt-to-plain-files-changed-outside-the-crdt-diff-a-new-file-into-the-crdt-and-failure-modes)).
- Obsidian Sync says its diff-match-patch auto-merge "may sometimes create duplicate text" and added a conflict-file mode in 1.9.7. Self-hosted LiveSync auto-merges only when a real shared ancestor exists ([Obsidian Help](https://obsidian.md/help/sync/troubleshoot); [LiveSync conflict spec](https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/specs_conflict_resolution.md)).
- Loro and Automerge each ship about 1.1 MB gzipped of WASM. json-joy is AGPL-3.0-only from v18 ([research report](../learning/sync-design-research.md#three-way-merge-beats-crdts-for-notes-edited-outside-the-editor)).
