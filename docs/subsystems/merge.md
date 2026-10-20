---
title: Merge and conflicts
aliases: [obsy/merge, merge3, three-way merge, diff3, diff3Regions, diffLines, Myers diff, work limit, conflict copies, conflict handling, union merge, frontmatter merge]
updated: 2026-10-20
---

# Merge and conflicts

## Current

Status: `@obsy/merge` exists. It implements the text merge below as existing behavior (phase 0 spike, [results](../learning/merge-spike.md)). Conflict copies, conflict records, binary files, and deletes are accepted design for the commit path; they are not implemented yet.

The [commit algorithm](protocol.md#commit-algorithm) calls the merge when an operation's `baseRev` is not the file's current `rev` and the content differs.

### API

Existing behavior. The package has one function. It is pure and deterministic, and it uses no Node or DOM API.

```ts
merge3({ base, ours, theirs }): MergeResult
```

| Input | Meaning |
| --- | --- |
| `base` | The file at the operation's `baseRev`, or `null` when there is no common ancestor |
| `ours` | The local version: the change that is being committed |
| `theirs` | The current committed head. It was committed first. |

The result is one of two shapes:

- `{ status: 'clean', text, rules }`. Commit `text` as the new revision. `rules` lists the rules used beyond a plain line-level diff3: `union-insert`, `contained-insert`, `frontmatter-keys`, `text-format`, `no-base-extends`.
- `{ status: 'conflict', keep, copy, conflicts }`. `keep` is `theirs`: it stays at the path. `copy` is `ours`: the caller writes it as the conflict copy. `conflicts` has at least one reason, for the conflict record:
  - `{ kind: 'lines', base, ours, theirs }`: both sides changed overlapping or adjacent lines. Each range is a 0-based line index and a line count in that text.
  - `{ kind: 'frontmatter-key', key }`: both sides changed one frontmatter key in ways that do not merge.
  - `{ kind: 'frontmatter', reason }`: the frontmatter block conflicts as a whole. `reason` is `unparsed`, `presence`, `order`, `preamble`, or `invalid-result`.
  - `{ kind: 'line-endings' }`: both sides changed the line-ending style in different ways.
  - `{ kind: 'no-base' }`: there is no base, and neither side strictly extends the other.
  - `{ kind: 'work-limit' }`: aligning the body needed more work than the merge allows (see [Line diff](#line-diff)).

The package also exports `diff3Regions(a, o, b)`, the plain three-way line comparison without the Markdown rules. Tests use it as a baseline.

The merge never returns conflict markers.

### Merge rules

Existing behavior, except where a rule is marked as accepted design.

- **Fast paths.** If `ours` equals `theirs`, the result is `ours`. If one side equals `base`, the result is the other side, byte for byte.
- **Line-level three-way merge** against the base (see [Line diff](#line-diff)). A change on one side only is applied. The same change on both sides is applied once. Changes from both sides that overlap or touch (adjacent lines) are a conflict, as in `git merge-file`.
- **Anchors.** Before the diff, lines that all three texts share at the start are set aside. The rest is split at anchor lines: non-blank lines that occur exactly once in each text, in the same order in all three (the patience-diff idea). Each segment is then merged with `diff3Regions`. Changes on two sides of an anchor never touch.
- **Concurrent inserts at the same anchor**, where neither side deleted a base line there, are both kept: theirs first, then ours (commit order). Lines that both inserts share at the start or the end are kept once. When one insert then contains the other, the result is the larger insert (`contained-insert`); otherwise both are kept (`union-insert`). Blank lines at the edge of a shared start or end stay with each insert, so that two new paragraphs stay separate.
- **Frontmatter** is a leading block between two lines that are exactly `---`, after an optional byte order mark. When only one side changed the block, that side's block is used unchanged. When both changed it, it is merged key by key (`frontmatter-keys`):
  - A top-level key starts at a line `key:` or `"quoted key":` at column 0. Its entry includes the following indented lines, `- ` items, blank lines, and comments. Untouched entries keep their exact text.
  - A key changed on one side takes that change. A key changed on both sides is merged line by line with the rules above, so list items appended on both sides are kept. If that fails, the key conflicts.
  - A key added on both sides with different values conflicts. A key removed on one side and changed on the other conflicts.
  - Key order follows theirs, or ours when only ours moved keys. Keys that only the other side added go after the key they follow there. When both sides moved keys into different orders, the block conflicts.
  - A block that is not a plain top-level mapping (for example a top-level list, a duplicate key, or a line this splitter does not understand) is merged as one unit: one side's change is taken, and changes on both sides conflict.
  - The merged block is split again as a check. If it does not give the same keys, the block conflicts.
  - Frontmatter and body are merged apart, so a frontmatter change next to a body change does not conflict.
- **Anything else that overlaps** is a conflict. The current version stays at the path, and the other side is written as `Name (conflict <device> <YYYYMMDDHHmm>).md`, close to Obsidian's own conflict-copy form, with a conflict record the plugin can show as a diff. The copy and the record are accepted design for the commit path, not implemented.
- **No base, no merge.** With `base` null, the result is clean only when one version strictly extends the other (`no-base-extends`), and it is then that version unchanged. `X` strictly extends `Y` when they differ and `Y` is `X` with whole lines removed: each line of `Y` matches a line of `X`, in order. A line break in `Y` must also be in `X`; only the last line of `Y` may lack a line break that its match in `X` has. Both texts must use the same byte order mark and the same line-ending style (a text without a line break has no style).
- **Text format** (`text-format`):
  - A byte order mark is removed before the merge and added back when the three-way result keeps it.
  - When no text mixes `\n` and `\r\n`, lines are compared without their line breaks. The output style is resolved three-way: a side that changed the style wins; if both sides changed it in different ways, the result is a `line-endings` conflict.
  - When any text mixes `\n` and `\r\n`, every line keeps its own line break, and a changed line break is a changed line. No line ending is converted.
  - Whether the text ends with a line break is resolved three-way in the same way.
  - Empty texts, missing final line breaks, lone `\r` characters, and very long lines are handled. The merge has no size limit.
- **Binary files** are out of scope for `@obsy/merge`. The caller must never send them. Accepted design, not implemented: binary files never merge, and concurrent changes produce a conflict copy; last-writer-wins is never silent.
- **Deletes** are accepted design for the commit path, not implemented: a delete whose `baseRev` is not current is rejected, and an edit against a deleted file restores it. Edit beats delete.

The note at the path is never left with conflict markers. See [Conflict copies by default](../decisions/2026-10-19-conflict-copies.md).

### Line diff

Existing behavior. `diffLines` in `packages/merge/src/diff.ts` is the only place that chooses a diff algorithm:

- **Myers O(ND) diff** from `@jest/diff-sequences` (MIT, maintained by the Jest project). Its cost grows with the size of the change, not with how often lines repeat.
- **Unmatched lines set aside first.** Lines that do not occur in the other list can never match. Removing them before the diff keeps a full rewrite cheap and does not change the result's size.
- **Changes slid among equal lines.** When a change could sit at several places among equal lines (for example which of three blank lines was deleted), it is slid up and down, joined with neighbouring changes, and placed where it lines up with a change in the other text, else at the lowest place. This follows git's documented behaviour, so obsy and `git merge-file` decide alike next to blank lines.
- **Three-way regions.** `diff3Regions` diffs the base against each side, sorts the changes by base position, and joins changes that overlap or touch. A region changed on one side takes that side's lines; a region changed on both sides goes to the rules above.
- **Work limit.** All diffs of one merge share a budget of 50 million line comparisons. When it runs out, the merge returns a `work-limit` conflict, which the caller handles like any conflict (a conflict copy). Only heavy reordering of a long note with repeated lines reaches it; it takes about 0.4 s on an Apple M4 Pro.

`node-diff3` was used until 2026-10-20 and was removed: its alignment grows roughly with the cube of the line count on repeated lines ([evidence](../learning/merge-diff.md)).

### Known limits

Observed in the [phase 0 spike](../learning/merge-spike.md):

- **Speed.** A 5,000-line note merges in about 1.5 to 3.5 ms on an Apple M4 Pro, with or without repeated lines ([evidence](../learning/merge-diff.md)). Heavy reordering of a long note can reach the work limit.
- **Alignment among repeated lines** can still differ from git in rare cases, mostly when one side added frontmatter: obsy merges frontmatter and body apart, git sees one change at the top. The choice decides whether some edits next to blank lines are clean or a conflict.
- **A blank last line and a removed final line break cancel out.** If ours adds a blank last line and theirs removes the final line break, the result has one final line break and no blank line.
- **Frontmatter conflicts are per key.** A key removed on one side and changed on the other conflicts, even where a line merge would be clean.
- **Union order is commit order**, not meaning. Risk 3 on the [roadmap](../roadmap.md#risks) needs the real corpus.

### Why not a CRDT

CRDTs are not used for stored truth. A CRDT kept in step with plain files must diff every outside change in, and identical outside edits then duplicate text; three-way merge handles that case correctly. See [Three-way merge, not CRDTs](../decisions/2026-10-19-three-way-merge-not-crdt.md) and the [merge research notes](../learning/research-notes/merge-algorithms.md).

### Testing

Existing behavior: unit tests for each rule, property tests with `fast-check`, and an oracle comparison with `git merge-file` run in `pnpm test`. The [spike results](../learning/merge-spike.md) list the properties, the oracle categories, and their counts. The private corpus of real vault edits stays outside this repository; run it with the [merge corpus runbook](../runbooks/merge-corpus.md). See [Correctness and testing](../concepts/correctness-and-testing.md).

## History

- 2026-10-19: Merge rules accepted, from the former `DESIGN.md`.
- 2026-10-20: `node-diff3` replaced by a Myers diff with change sliding and a work limit; `work-limit` conflict kind added ([evidence](../learning/merge-diff.md)).
- 2026-10-20: `merge3` implemented in the phase 0 spike, with the API, the anchor, union, frontmatter, no-base, and text-format details above ([spike](../learning/merge-spike.md)).
