---
title: Myers diff for the line merge
aliases: [replace node-diff3, diff library, jest diff-sequences, merge work limit]
updated: 2026-10-20
status: accepted
---

# Myers diff for the line merge

## Context

The [three-way merge decision](2026-10-19-three-way-merge-not-crdt.md) named `node-diff3` for the line-level merge. The phase 0 [merge spike](../learning/merge-spike.md) found that a note made of repeated lines took 27 s to merge at 5,000 lines. `node-diff3`'s alignment is a classic longest-common-subsequence method that slows down when many lines match each other. Its maintainer keeps the package up to date, but a performance issue opened in August 2024 has no reply.

Options considered:

- Keep `node-diff3` and add a size or time limit that returns a conflict.
- Another three-way merge library. None was found that is maintained, fast on repeated lines, and permissively licensed.
- A Myers O(ND) two-way diff from a library, with obsy's own three-way region step.
- obsy's own Myers or histogram diff.

## Decision

The line merge uses the Myers diff from `@jest/diff-sequences` (MIT, maintained by the Jest project) for each two-way comparison. obsy implements the rest: setting aside lines with no match, sliding changes among equal lines the way git does, the three-way region step (`diff3Regions`), and a work limit that turns an over-long alignment into a `work-limit` conflict. `node-diff3` is removed.

`diffLines` is the only place that calls the diff library, so a histogram diff of obsy's own can replace it later without other changes.

The current behaviour is on [Merge and conflicts](../subsystems/merge.md#line-diff).

## Consequences

- Merging a 5,000-line note takes milliseconds, with or without repeated lines.
- obsy owns about 250 lines of diff code. Property tests check it against a dynamic-programming reference, and the oracle compares the merge with `git merge-file`.
- Alignment among repeated lines now follows git more closely. Some generated cases changed category; none was left unexplained.
- A merge that exceeds the work limit gives a conflict copy instead of blocking the device.

## Evidence

See [Merge diff replacement](../learning/merge-diff.md): benchmarks of `node-diff3` against Myers diffs, the oracle counts before and after, and the generated corpus on real notes.
