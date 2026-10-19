---
title: Merge and conflicts
aliases: [obsy/merge, three-way merge, diff3, node-diff3, conflict copies, conflict handling]
updated: 2026-10-19
---

# Merge and conflicts

## Current

Status: accepted design, not yet implemented. Package: `@obsy/merge`.

The [commit algorithm](protocol.md#commit-algorithm) calls the merge when an operation's `baseRev` is not the file's current `rev` and the content differs.

### Merge rules

`@obsy/merge` wraps `node-diff3` (MIT) with a Markdown layer:

- **Line-level three-way merge** against the stored base. Identical changes on both sides merge once.
- **Frontmatter** is parsed and merged key by key. Conflict markers never go inside YAML.
- **Concurrent inserts at the same anchor** with no deletions are both kept, in commit order. This is the common case of an agent appending while the owner also appends.
- **Anything else that overlaps** is a conflict. The current version stays at the path, and the other side is written as `Name (conflict <device> <YYYYMMDDHHmm>).md`, close to Obsidian's own conflict-copy form, with a conflict record the plugin can show as a diff.
- **No base, no merge.** Two devices creating the same path independently produce a conflict copy unless one version strictly extends the other.
- **Binary files** never merge. Concurrent changes produce a conflict copy; last-writer-wins is never silent.
- **Deletes:** a delete whose `baseRev` is not current is rejected, and an edit against a deleted file restores it. Edit beats delete.

The note at the path is never left with conflict markers. See [Conflict copies by default](../decisions/2026-10-19-conflict-copies.md).

### Why not a CRDT

CRDTs are not used for stored truth. A CRDT kept in step with plain files must diff every outside change in, and identical outside edits then duplicate text; three-way merge handles that case correctly. See [Three-way merge, not CRDTs](../decisions/2026-10-19-three-way-merge-not-crdt.md) and the [merge research notes](../learning/research-notes/merge-algorithms.md).

### Testing

Merge properties are tested with `git merge-file` as an oracle, plus a private corpus of real vault edits. See [Correctness and testing](../concepts/correctness-and-testing.md).

## History

- 2026-10-19: Merge rules accepted, from the former `DESIGN.md`.
