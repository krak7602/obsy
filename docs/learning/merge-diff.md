---
title: Merge diff replacement (phase 0)
aliases: [node-diff3 replacement, Myers diff results, merge speed results, generated corpus, real-note corpus, diff3Regions evidence]
updated: 2026-10-20
---

# Merge diff replacement (phase 0)

## Current

Status: observed results, 2026-10-20. `node-diff3` was replaced by a Myers diff with obsy's own three-way region step ([decision](../decisions/2026-10-20-myers-diff-for-merge.md)). The current contract is on [Merge and conflicts](../subsystems/merge.md#line-diff). The earlier results with `node-diff3` are on the [merge spike](merge-spike.md) page.

### Question

The [merge spike](merge-spike.md#open-questions) left one open question: a note made of repeated lines took 27 s to merge at 5,000 lines. Is there a better diff, and does replacing it keep the merge's behaviour? A second question: how does the merge behave on real notes, without a corpus of real concurrent edits?

### Method

- **Library survey** on npm and GitHub, 2026-10-20. Candidates: `node-diff3` 3.2.1 (MIT), `diff` (jsdiff) 9.0.0 (BSD-3-Clause), `@jest/diff-sequences` 30.5.0 (MIT), `fast-myers-diff` 3.2.0 (MIT), `@sanity/diff-match-patch` 3.2.1 (Apache-2.0), `three-way-merge` 0.1.0 (MIT), and the script `axosoft/diff3` (no licence).
- **Scratch benchmark** (not kept): two-way Myers diffs plus a minimal region step, against `node-diff3`'s `diff3MergeRegions`, on synthetic notes with edits at the top, the middle, and the end. Machine: Apple M4 Pro, Node 24.21.0.
- **Implementation:** `diffLines` (Myers from `@jest/diff-sequences`, unmatched lines set aside, changes slid among equal lines as git does) and `diff3Regions`, with a shared work limit. Tests: property tests against a dynamic-programming longest common subsequence, region-span checks, and speed and work-limit tests.
- **Oracle:** the existing comparison with `git merge-file` (git 2.55.0), 20,000 generated cases per survey, seeds 20261020 and 7, as in the spike. The plain baseline is now `diff3Regions` on git's line model instead of plain `node-diff3`.
- **Generated corpus on real notes:** `corpus-generate.ts` on a read-only copy of the owner's main vault (60 Markdown files, 544 KB; the largest case 351 KB across three files). Ten edit kinds per note where they apply, seeds 1 and 2. Only aggregate counts are recorded here.

### Results

#### Library survey

- No maintained, fast, permissively licensed three-way merge library for JavaScript was found. `node-diff3` is the common one. jsdiff 9 has no merge function. `three-way-merge` is a 0.1 from 2022. `axosoft/diff3` has no licence, so it cannot be used.
- `node-diff3` is maintained (releases in October 2025 and June 2026) but its alignment is a classic longest-common-subsequence method, from the Synchrotron project. [Issue #84 "Poor performance"](https://github.com/bhousel/node-diff3/issues/84), opened in August 2024, reports about cubic growth and has no maintainer reply.
- `@jest/diff-sequences` and `fast-myers-diff` are Myers O(ND) diffs with no dependencies. `@jest/diff-sequences` is maintained by the Jest project (release in August 2026).

#### Benchmark, milliseconds per merge (scratch)

| Note | `node-diff3` | Myers (`@jest/diff-sequences` or `fast-myers-diff`) |
| --- | --- | --- |
| Repeated lines, 1,000 lines | 134 | 0.4 to 0.5 |
| Repeated lines, 2,000 lines | 1,148 | 0.2 |
| Repeated lines, 5,000 lines | 19,091 | 0.2 |
| Repeated lines, 20,000 lines | not run | 0.5 to 0.6 |
| Every line rewritten, 5,000 lines | 8.6 | 226 to 245 |
| Every line rewritten, 5,000 lines, unmatched lines set aside first | — | 1.6 |
| Every line rewritten, 20,000 lines, unmatched lines set aside first | — | 6.2 |

Myers is slow only when the change is large and lines still match, for example a long note with repeated lines that is heavily reordered. That is why the work limit exists.

#### `merge3` speed after the change

Median of 21 runs (5 runs at 5,000 lines and more), milliseconds, same machine and note shapes as the spike:

| Note | Lines | Before (spike) | After |
| --- | --- | --- | --- |
| Distinct lines, blank every 5th, some repeated tasks | 1,000 | 0.58 | 0.66 |
| Same | 5,000 | 3.14 | 3.38 |
| Same | 20,000 | 12.1 | 14.4 |
| Only repeated lines (5-line block, no unique line) | 1,000 | 172 | 0.33 |
| Same | 2,000 | 1,645 | 0.60 |
| Same | 5,000 | 26,682 | 1.51 |
| Same | 20,000 | not run | 6.05 |

The work limit (50 million line comparisons per merge) was reached in about 0.42 s by a 10,000-line note with every line twice, reversed on one side. A 4,000-line version of that note merged without reaching it, in 88 to 228 ms.

#### Oracle

Counts for "with base" (LF), 20,000 cases. "Before" is the spike's `node-diff3` run.

| Category | Seed 20261020 before | after | Seed 7 before | after |
| --- | --- | --- | --- | --- |
| `agree-clean` | 7,297 | 7,368 | 7,264 | 7,331 |
| `agree-conflict` | 5,598 | 5,671 | 5,745 | 5,815 |
| `obsy-only:diff3-alignment` | 53 | 1 | 54 | 3 |
| `obsy-only:segment-alignment` | 4 | 5 | 1 | 1 |
| `git-only:diff3-alignment` | 31 | 0 | 29 | 1 |
| `git-only:blank-lines` | 40 | 3 | 40 | 3 |
| `git-only:git-duplicates` | 9 | 1 | 7 | 2 |
| `git-only:frontmatter` | 3 | 3 | 3 | 3 |
| `git-only:frontmatter-split` | 0 | 5 | 1 | 4 |

The categories for obsy's own rules (`union-insert`, `contained-insert`, `frontmatter-keys`, `frontmatter-split`, `final-newline`) moved by less than 2%. Where git was clean, obsy returned the same text in 99.8% of cases (7,368 of 7,380 for seed 20261020; 98.9% before). The "per side" and "no base" surveys also pass for both seeds; no case is left unexplained.

Category meanings are on the [merge spike](merge-spike.md#oracle-categories), with three changes:

- `diff3-alignment` now compares with obsy's own `diff3Regions` on git's line model, not with plain `node-diff3`.
- `git-only:frontmatter-split` now also covers conflicts: one side added frontmatter and changed the first body lines (see below).
- `git-only:work-limit` is new: obsy hit the work limit where git merged. It did not occur in these runs.

Two findings during the change:

- **Tie-breaking among equal lines.** The first version used the Myers result as it came. At 5,000 cases, one generated case conflicted where git was clean: ours deleted one of three trailing blank lines, and the diff picked the blank line next to theirs' change. git slides such a change next to other changes. obsy now does the same; this is what removed most `git-only:diff3-alignment` and `blank-lines` cases.
- **Frontmatter added on one side.** After that, a few conflicts remained where one side added frontmatter and removed a blank line at the top of the body. git sees one change at the top; obsy merges frontmatter and body apart, so the removed blank line is placed next to the other side's change. Two cases were checked by hand. The result is a conflict copy, so no text is lost. The oracle now classes these as `git-only:frontmatter-split`, a documented category.

#### Generated corpus on real notes

475 cases from 60 notes for seed 1, 477 for seed 2.

| Edit kind | Cases (seed 1) | Result, both seeds |
| --- | --- | --- |
| `append-both` | 60 | all clean |
| `append-same` | 60 | all clean |
| `task-and-append` | 14 | all clean |
| `far-edits` | 44 | all clean |
| `frontmatter-and-body` | 60 | all clean |
| `under-heading-both` | 54 | all clean |
| `two-sections` | 30 (31) | all clean |
| `same-line` | 60 | all conflict |
| `adjacent-lines` | 47 | all conflict |
| `delete-vs-edit` | 46 (48) | all conflict |

- Every kind gave its expected result. No case errored.
- Comparison with git, seed 1: 200 `agree-clean`, 153 `agree-conflict`, 114 `obsy-only:union-insert`, 8 `obsy-only:frontmatter-split`. Seed 2 was similar. No `git-only` case.
- `merge3` time per case: p50 0.03 ms, p95 0.29 ms, max 1.5 ms.

### Lessons

- **Use the Myers diff.** It removes the repeated-line problem completely and keeps distinct-line notes as fast as before.
- **Tie-breaking matters as much as speed.** A minimal diff is not unique among blank lines. Sliding changes the way git does made obsy agree with git far more often than `node-diff3` did.
- **Keep the diff behind one function.** `diffLines` is the only caller of the library. A histogram diff can replace it if real edits show bad alignment.
- **Real note shapes merge as designed** for the edit kinds tested. The union rule fired in every `append-both` and `under-heading-both` case.

### Limits

- The generated edits are simple and one per side. Real concurrent edits can be larger, overlap in other ways, and include renames and moves.
- One vault of 60 notes. Its notes have few open tasks (14 cases for `task-and-append`) and no very long notes.
- The speed figures come from one desktop machine. The iPhone was not measured for merges; it hashed about as fast as the desktop in the [iPhone probe](iphone-probe.md).
- The work limit is a count of comparisons, not a time. Its duration depends on the device.

### Still open

- A corpus of real concurrent edits. It can come from obsy's own history once phase 2 runs on a copy of a vault.
- Whether union order reads well in real daily notes ([risk 3](../roadmap.md#risks)).

## History

- 2026-10-20: `node-diff3` replaced; oracle and generated corpus run on the new diff.
