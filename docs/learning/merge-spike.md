---
title: Merge spike (phase 0)
aliases: [merge spike, merge3 spike, phase 0 merge, merge oracle results, git merge-file comparison, node-diff3 performance]
updated: 2026-10-20
---

# Merge spike (phase 0)

## Current

Status: observed results from synthetic and generated inputs, 2026-10-20, with `node-diff3`. `node-diff3` was replaced the same day; the new results and a generated corpus on real notes are on [Merge diff replacement](merge-diff.md). The current merge contract is on [Merge and conflicts](../subsystems/merge.md).

### Question

Can a small Markdown layer over `node-diff3` implement the accepted merge rules safely? How does it compare with `git merge-file`, and is it fast enough for long notes?

### Method

- **Implementation.** `packages/merge/src/`: `merge3` in `merge.ts`, the line merge and anchors in `lines.ts`, the frontmatter layer in `frontmatter.ts`, and the text model (BOM, line endings, final line break) in `text.ts`. No new runtime dependency. Frontmatter is split with a small line-based splitter, not a YAML parser.
- **Unit tests.** 74 example tests in `packages/merge/src/` (72 for `merge3`, 2 that characterise `node-diff3`).
- **Property tests.** 13 properties in `packages/merge/test/properties.test.ts`, with fast-check 4.10.2 (MIT). The generators in `test/arbitraries.ts` build a base note from headings, list items, tasks, paragraphs, blank lines, `---` rules, code fences, and optional frontmatter (scalar, flow-list, and block-list keys). Each side applies 0 to 4 edits: insert, delete, or change a line; append at the end or under a heading; append a new section; set, remove, or extend a frontmatter key; toggle the final line break. Both sides can share 0 to 2 edits. Texts are LF, CRLF, or a mix per side.
- **Oracle.** `packages/merge/test/oracle.test.ts` runs `git merge-file -p` (git 2.55.0, user and system configuration ignored) on each generated case. `compare` in `test/oracle.ts` puts every case into one category (below). Plain `node-diff3` on git's line model, with no Markdown layer and no anchors, separates `node-diff3` alignment from obsy's own rules.
- **Speed.** A scratch benchmark (not kept) ran `merge3` from the built package, and plain `node-diff3` `diff3Merge`, on synthetic notes. Each note had edits at the top, in the middle, and at the end. Machine: Apple M4 Pro, Node 24.21.0. No iPhone was measured.
- **Runs.** `pnpm test` runs 300 cases per property and per oracle survey, in about 4 s. The heavy runs below set `OBSY_PROPERTY_RUNS` and `OBSY_ORACLE_RUNS` ([runbook](../runbooks/merge-corpus.md#run-the-heavy-synthetic-tests)).

### API shape

`merge3({ base, ours, theirs })` returns `{ status: 'clean', text, rules }` or `{ status: 'conflict', keep, copy, conflicts }`. The full contract is on [Merge and conflicts](../subsystems/merge.md#api). The reasons for the shape:

- One pure function over strings fits every caller: the plugin, the CLI, and a Worker. The commit path already has the three texts.
- `base: null` is part of the input, so that the no-base rule lives in the merge and not in each caller.
- A conflict result names `keep` (theirs) and `copy` (ours). The rule "the current version stays at the path" then lives in one place. The copy name and the conflict record stay with the caller.
- `conflicts` lists reasons with line ranges, for the conflict record and a diff view.
- `rules` on a clean result shows which rule beyond diff3 was used. The corpus runner counts them, and a later UI can show "merged by union".

### Results

#### Properties

Every property passed with 100,000 generated cases each (300,000 for the two text-model properties), on the final code:

| Property | Result |
| --- | --- |
| `merge(b, x, x)` is clean and equals `x` | Pass |
| `merge(b, b, x)` and `merge(b, x, b)` equal `x` | Pass |
| Same input, same result | Pass |
| Swapping ours and theirs gives the same decision, the same conflict reasons (with ranges swapped), and the same text, except line order under `union-insert` or `frontmatter-keys` | Pass |
| A clean result contains every non-blank line that either side added | Pass |
| A clean result has no conflict markers and no duplicate frontmatter key | Pass |
| A conflict returns `keep` = theirs, `copy` = ours, and at least one reason | Pass |
| CRLF inputs give the CRLF form of the LF result | Pass |
| When all three texts share one line-ending style, the result keeps it | Pass |
| No base: a text and the same text with appended lines merge to the longer one | Pass |
| No base: a clean result equals one side exactly | Pass |
| `decode` then `encode` returns every text unchanged (random strings of letters, `\n`, `\r`, U+FEFF, and other characters) | Pass |
| Random strings never throw and keep the conflict contract | Pass |

#### Oracle

Counts from 20,000 generated cases per survey, two seeds. "With base" uses LF texts. "Per side" picks LF or CRLF for each of the three texts. "No base" gives obsy `base: null` and git an empty base.

| Category | With base, seed 20261020 | With base, seed 7 | Per side, seed 20261020 | Per side, seed 7 | No base, seed 20261020 | No base, seed 7 |
| --- | --- | --- | --- | --- | --- | --- |
| `agree-clean` | 7,297 | 7,264 | 3,317 | 3,266 | 1,603 | 1,582 |
| `agree-conflict` | 5,598 | 5,745 | 5,926 | 6,083 | 13,352 | 13,429 |
| `obsy-only:union-insert` | 3,469 | 3,424 | 1,012 | 1,012 | 0 | 0 |
| `obsy-only:contained-insert` | 1,713 | 1,672 | 459 | 464 | 0 | 0 |
| `obsy-only:frontmatter-split` | 791 | 763 | 221 | 219 | 0 | 0 |
| `obsy-only:frontmatter-keys` | 749 | 798 | 207 | 223 | 0 | 0 |
| `obsy-only:final-newline` | 243 | 199 | 63 | 57 | 0 | 0 |
| `obsy-only:text-format` | 0 | 0 | 8,751 | 8,642 | 0 | 0 |
| `obsy-only:no-base-extends` | 0 | 0 | 0 | 0 | 5,045 | 4,989 |
| `obsy-only:diff3-alignment` | 53 | 54 | 14 | 12 | 0 | 0 |
| `obsy-only:segment-alignment` | 4 | 1 | 2 | 0 | 0 | 0 |
| `git-only:blank-lines` | 40 | 40 | 12 | 14 | 0 | 0 |
| `git-only:diff3-alignment` | 31 | 29 | 13 | 5 | 0 | 0 |
| `git-only:git-duplicates` | 9 | 7 | 0 | 1 | 0 | 0 |
| `git-only:frontmatter` | 3 | 3 | 3 | 1 | 0 | 0 |
| `git-only:frontmatter-split` | 0 | 1 | 0 | 1 | 0 | 0 |

Where git was clean, obsy returned the same text in 98.9% of LF cases with a base (7,297 of 7,380 for the first seed). Every other git-clean case is in a category below. No case was left unexplained. Without a base, obsy was never less clean than git.

#### Oracle categories

`obsy-only` means obsy is clean and git conflicts. These are the intended effect of obsy's rules:

- `union-insert`, `contained-insert`: both sides inserted at one place. git conflicts; obsy keeps both, or keeps the larger insert once.
- `frontmatter-keys`: both sides changed the frontmatter, and the keys merged. git conflicts on adjacent key lines.
- `frontmatter-split`: obsy merges frontmatter and body apart, so a frontmatter change next to a body change does not touch.
- `final-newline`: obsy treats "ends with a line break" as a separate attribute. git sees a changed last line.
- `text-format`: the texts used different line-ending styles. git sees every line as changed.
- `no-base-extends`: no base, and one side strictly extends the other.
- `diff3-alignment`: plain `node-diff3` aligns repeated lines differently from git's Myers diff and is clean where git is not.
- `segment-alignment`: assigned by elimination. obsy's prefix trim and anchors chose another valid alignment than `node-diff3` on the whole text. Two of the 7 cases were checked by hand, and both results are sound. Example: both sides inserted the same line at the top, and theirs deleted two lines further down; obsy keeps the insert once and applies the deletes.

`git-only` means git is clean and obsy conflicts or returns another text:

- `diff3-alignment`: plain `node-diff3` also conflicts, because it aligns repeated (mostly blank) lines differently from git.
- `blank-lines`: both are clean with the same non-blank lines in the same order. Only the count or place of blank lines differs.
- `git-duplicates`: both sides appended the same block, and one side added more. git keeps the shared block twice; obsy keeps it once, as the rule "identical changes merge once" requires.
- `frontmatter`: a key was removed on one side and changed (often also moved) on the other. git sees a delete and an unrelated insert; obsy reports a key conflict.
- `frontmatter-split`: the base began with a `---` thematic break, and one side added frontmatter in front of it. git put the other side's new top line above the frontmatter, so the file lost its frontmatter. obsy kept the frontmatter at the top.

#### Speed

`merge3` and plain `node-diff3`, in milliseconds per merge:

| Note | Lines | `merge3` | Plain `node-diff3` |
| --- | --- | --- | --- |
| Distinct lines, blank every 5th, some repeated tasks | 100 | 0.11 | 0.6 |
| Same | 1,000 | 0.58 | 39.8 |
| Same | 2,000 | 1.23 | 216 |
| Same | 5,000 | 3.14 | 3,375 |
| Same | 20,000 | 12.1 | not run |
| Only repeated lines (5-line block, no unique line) | 100 | 0.23 | 0.2 |
| Same | 1,000 | 172 | 176 |
| Same | 2,000 | 1,645 | 1,590 |
| Same | 5,000 | 26,682 | 27,190 |

Plain `node-diff3` grows roughly with the cube of the line count. Anchors remove this cost for notes with distinct lines. They cannot help a note with no unique non-blank line.

### Defects found during the spike

The property and oracle runs found these defects. All are fixed, and each has a test:

1. **Common-suffix trim moved inserts.** Setting aside lines shared at the end of all three texts moved an ambiguous insert among blank lines to its earliest place. One case moved an inserted line to the end of the note, far from its context. git moves such changes to their latest place. obsy now trims only the shared start.
2. **Blank-line anchors lost a delete.** After the prefix trim, a blank line can be unique, and it became an anchor. A side that moved a line across it then hid the other side's delete of that line. Blank lines are now never anchors.
3. **Asymmetric anchors.** Anchors were filtered by ours' order first, so swapping the sides could change the decision. Both orders are now computed, and the choice does not depend on which side is ours.
4. **Asymmetric conflict order.** Frontmatter key conflicts were listed in an order that depended on the sides. They are now listed in base order, then sorted.

### Interpretations made in the spike

These refine the accepted rules. None contradicts [Merge and conflicts](../subsystems/merge.md), but each is a choice to review:

- A frontmatter key changed on both sides is merged line by line before it is called a conflict. This keeps list items appended on both sides.
- Concurrent inserts keep lines that both share at the start or the end once. When one insert contains the other, the larger insert is kept once (`contained-insert`). Blank lines at the edge stay with each insert.
- Frontmatter and body are merged apart.
- The byte order mark, the line-ending style, and the final line break are merged three-way, apart from the lines. Mixed line endings switch to byte-exact lines.
- The no-base rule allows the shorter text's last line to gain a line break, so a line typed at the end of a template counts as an extension.
- Key order follows theirs, or ours when only ours moved keys.
- The line merge is split at anchors (patience-style), which changes alignment in rare cases (`segment-alignment`).

### Limits

- The inputs are generated. The vocabulary is small, a base note has at most 20 body lines and 5 keys, and each side makes at most 6 edits. Real notes are longer and edited in other ways.
- git is an oracle for clean line merges only. Its alignment is not ground truth either.
- The speed figures come from one desktop machine. The plugin also runs on iPhone, which is slower.
- A blank last line added by one side and a final line break removed by the other cancel out. The no-loss property therefore checks non-blank lines only.
- Union order is commit order. Whether that order reads well is not tested ([risk 3](../roadmap.md#risks)).

### What still needs the real corpus

- How often real concurrent edits are clean, and how many of the clean results use `union-insert` or `contained-insert`.
- Whether the union order and the blank-line handling read well in real daily notes and agent check-ins.
- Frontmatter conflict rates with YAML that Obsidian's properties editor writes.
- Alignment differences on real blank-line patterns (`segment-alignment`, `blank-lines`).
- No-base creation races, for example daily notes made from a template on two devices.
- The size of real notes, and whether any note has long runs of repeated lines.
- How to collect the cases. The [runbook](../runbooks/merge-corpus.md) defines the layout, not the collection.

### Open questions

- **Speed on repeated lines.** A note made only of repeated lines takes 1.6 s at 2,000 lines and 27 s at 5,000 lines on the desktop. Settled on 2026-10-20: a Myers diff replaced `node-diff3`, with a work limit as a backstop ([results](merge-diff.md)).
- **YAML parser.** The line-based splitter treats unusual frontmatter as one unit. A permissively licensed YAML parser could merge more, at the cost of a dependency and of exact formatting.
- **Blank lines in union inserts.** Only real notes can show whether blank lines duplicated at the edge of two inserts look right.

## History

- 2026-10-20: Speed question settled by replacing `node-diff3` ([merge diff](merge-diff.md)).
- 2026-10-20: Spike run on generated inputs. `merge3` implemented, four defects found and fixed, oracle categories defined.
