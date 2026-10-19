---
title: Merge corpus run
aliases: [corpus runner, merge-corpus, merge evaluation, real vault edits, oracle run, heavy merge tests]
updated: 2026-10-20
---

# Merge corpus run

## Current

Status: the runner exists. No run on a real corpus is recorded yet. The merge rules are on [Merge and conflicts](../subsystems/merge.md); the meaning of each output category is on the [merge spike](../learning/merge-spike.md#oracle-categories) page.

### Safety rules

- A corpus holds real note content. Keep it outside the repository. Never commit it, copy cases into fixtures, or paste case content into documentation, issues, or chats.
- The runner refuses a corpus directory inside the repository. It writes only to a temporary directory in the system temporary folder, and removes it at the end.
- The default output has only counts and timings. Two options show private data, for local use only:
  - `--list` prints case names for each category that is not an agreement.
  - `--show <case>` prints one case in full: the obsy result, the git result, and the category.
- Record only aggregate numbers in maintained documentation.

### Corpus layout

One folder per case, directly under the corpus directory:

```text
<corpus>/
  <case>/
    base.md     optional: the file at the operation's baseRev
    ours.md     the local version, the change being committed
    theirs.md   the current committed head
```

A case without `base.md` is a no-base case: obsy gets `base: null`, and git gets an empty base file. A case is skipped and counted when `ours.md` or `theirs.md` is missing, or when a file contains a NUL byte (binary files are out of scope).

How to collect real cases is still open. Each case must keep the meaning of the three files above.

### Run the corpus

From the repository root:

1. Run `pnpm install`.
2. Build the package: `pnpm --filter @obsy/merge run build`. The runner loads `packages/merge/dist/index.js`.
3. Run `node packages/merge/test/merge-corpus.ts <corpus-dir>`. Node 24 runs the TypeScript file directly.

| Option | Does |
| --- | --- |
| `--json` | Print the aggregate statistics as JSON |
| `--list` | Also print case names per disagreement category (private) |
| `--show <case>` | Print one case in full instead of the statistics (private) |

The output has these sections:

| Section | Counts |
| --- | --- |
| `skipped` | Cases that were not run, by reason |
| `outcome` | Clean and conflict results, with and without a base |
| `clean results by rule` | The `rules` of clean results; `(plain diff3 or fast path)` when none |
| `conflicts by kind` | Conflict reasons; a case counts once per kind |
| `comparison with git merge-file` | One [oracle category](../learning/merge-spike.md#oracle-categories) per case |
| `obsy ms`, `git ms total` | Merge timings, and the size of the largest case in bytes |

A `git-only:unexplained` or `git-only:different-text` count is a finding. `obsy-only:segment-alignment` is assigned by elimination, so check a sample of those cases too. Look at the cases locally with `--list` and `--show`, and fix or explain them before you record the run.

### Run the heavy synthetic tests

`pnpm test` runs the property and oracle tests with small counts. Set these variables for longer runs:

| Variable | Default | Does |
| --- | --- | --- |
| `OBSY_PROPERTY_RUNS` | 300 | Cases per property in `packages/merge/test/properties.test.ts` |
| `OBSY_PROPERTY_SEED` | random | Replays one fast-check seed |
| `OBSY_ORACLE_RUNS` | 300 | Cases per survey in `packages/merge/test/oracle.test.ts` |
| `OBSY_ORACLE_SEED` | 20261020 | Seed for the oracle surveys |
| `OBSY_ORACLE_EXAMPLES` | unset | When set, prints two example cases per disagreement category |

For example: `OBSY_ORACLE_RUNS=20000 pnpm exec vp test packages/merge/test/oracle.test.ts --silent=false`. The `--silent=false` flag shows the category counts. Each oracle case spawns `git merge-file` once, about 5 ms per case.

### Record results

Record redacted aggregate results as a `docs/learning/` page, and link it from [Merge and conflicts](../subsystems/merge.md). Do not copy the runner output table into this runbook.

## History

- 2026-10-20: Runner and heavy-test variables added in the phase 0 merge spike ([spike](../learning/merge-spike.md)).
