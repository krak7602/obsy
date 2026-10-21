---
title: Agent SDK, phase 4
aliases: [phase 4 results, agent results, proposals results, presence results, CLI results, seed 4401]
updated: 2026-10-21
---

# Agent SDK, phase 4

## Current

Status: **observed results, 2026-10-21.** The [agent SDK and the `obsy` command](../subsystems/agent-sdk.md) pass property tests, the simulator over one million seeds, mutation checks, a run of the command against a local S3 server, and a new step of the [desktop plugin test](../runbooks/desktop-plugin-test.md). Moving an existing agent's daily-note writes onto the SDK is not done.

### Question

Phase 4 on the [roadmap](../roadmap.md) is done when concurrent human and agent edits on the daily note merge with no silent loss. Do agent writes, proposals, the owner's answers, and undo keep a person's text, and do agents and a person typing in Obsidian get along?

### Method

- **Property tests** (`packages/agent/src/markdown.test.ts`, fast-check): any text survives splitting and joining into lines; for random notes and heading paths, appending keeps every original line in order and puts the new lines together inside the section; an inserted block stays owned through a series of replaces, with LF and CRLF.
- **Unit tests** against an in-memory bucket and a real `SyncEngine` device: every operation and outcome, a claim lost to a device commit, presence modes, limits, history, accept (as is, merged, conflict), reject, and undo of puts, creates, moves, and deletes.
- **Simulator** ([runbook](../runbooks/simulator.md)): as in [phase 3](mobile-sync-phase3.md#simulator), plus two agents (one waits while a device edits, one proposes), the owner accepting, rejecting, and undoing, and presence writes on every user edit. The agent check now replays the log by token: agents remove no user token, and the owner removes only agent tokens or what an accepted proposal removed.
- **Mutation checks:** plant a bug, then count failing tests, and failing seeds out of 2,000.
- **CLI** against versitygw in Docker: every command, with keys from an `--env-file` of mode 600.
- **Desktop test:** a new step in Obsidian 1.14.4 on macOS with the plugin, the SDK in the test process, and the built `obsy` command.

### Results

#### Simulator

`node packages/simulator/dist/cli.mjs --seeds 1000000 --workers 8` on commit `4d3326d` (the final agent and engine code): seeds 1 to 1,000,000, 0 failures, 2,255 s.

| Total over all seeds | Count |
| --- | --- |
| Agent operations that committed / that became proposals | 7,754,730 / 2,279,669 |
| Owner accepts / rejects / undos that committed | 359,826 / 141,202 / 224,861 |
| Device commits during the run / in the quiet phase | 4,363,289 / 678,768 |
| Conflict copies | 3,206,007 |
| Device crashes | 2,467,488 |
| Syncs started / pull-only / stopped at a safe point / finished | 6,654,606 / 1,331,749 / 440,171 / 3,714,163 |
| Syncs that ended with an unexpected error | 0 (all 440,171 errors were stops) |

A second run after `replaceIfUnchanged` was added (whole-note rewrites are 10% of agent operations): seeds 1 to 1,000,000, 0 failures, 2,452 s. Agent operations committed 7,569,383 times and made 2,279,810 proposals; the owner accepted 350,538, rejected 140,528, and undid 226,389.

#### Mutation checks

| Planted bug | Unit tests failed | Seeds failed (of 2,000) |
| --- | --- | --- |
| Every block counts as owned (`isOwned` returns true) | 2 | 21 |
| Undo restores the old content when its three-way revert conflicts | 1 | 32 |
| Accept commits the proposal as is, ignoring later edits | 1 | 362 |
| After a lost claim, the agent reuses the text it read before | — | 304 |
| Presence is ignored | 2 | — (presence is not an invariant) |
| Accept does not sync while automatic sync is paused (plugin) | 1 | — |
| `replaceIfUnchanged` skips the revision check | — | 65 |

The first bug is rare in the simulator because simulated users seldom edit inside a block.

#### Tests

`pnpm test`: 527 tests in 30 files pass, including 6 CLI tests and 2 plugin service tests for presence and proposals.

#### CLI

Against a local S3 server: `init`, `append` with a section, `block --insert`, `cat`, `history` (with run and actor), `propose`, `proposals show` and `accept`, `undo` (refused for the commit that created a later-changed file; done for the block insert, which also removed the heading the agent had added), `export` of the head and of an older `seq`, `verify` (no differences, then one `content` difference after an edit, exit code 1), and `status`.

#### Desktop test

Final code, generated vault: 16 of 16 steps pass, including the new step:

| Check | Result |
| --- | --- |
| Typing without saving in an open note on B | B's presence record named the note within seconds |
| An agent in `propose` mode | Proposed, reason `editing` |
| An agent in `ignore` mode | Committed; after B's sync the open editor held the typing and the agent's line, cursor kept |
| Undo of the agent's commit | The line went; the typing stayed |
| A edits inside the agent's block | The agent's next change was a proposal, reason `block-edited` |
| Review dialog on A, with automatic sync paused | Accept merged the first proposal with the later edits and synced; Reject answered the second; no open proposals left |
| The built `obsy` command | Appended a line, which reached both devices |

### Findings

- **A nested heading counted as a second match.** In `## A` / `### A`, the path `['A']` was ambiguous, and a path whose created headings repeated a title could not be found again. Only outermost matches count now.
- **Lines could land inside an unclosed code fence** at the end of a note, where they would be code. Such an append now becomes a proposal. So does a heading to create whose level cannot nest below its parent.
- **A stale base threw instead of reporting.** `proposePatch` with a `baseRev` of a file deleted, or replaced at that path, meanwhile threw an input error; the simulator found it on its first run. It is now `skipped` with reason `missing`.
- **The first token check was wrong (seed 4401).** An accepted `block-edited` proposal removes the text a person wrote inside the block, as the owner chose. The simulator counted that text as lost. The check now allows exactly the tokens that the proposal removed from its base.
- **Agents left gaps in checkpoints.** Devices write a checkpoint only after their own commit at a multiple of 500. Agents now do the same.
- **Accept skipped its syncs while automatic sync was paused.** The commit was made, but the note changed only at the next sync. Found in review; accepting now always syncs, and the test covers it.
- **Undo refuses next to later insertions.** `merge3` treats adjacent changes as a conflict, so undoing an agent's line refuses when a later line was inserted right after it. This is safe, but more conservative than a person would be.
- **Lines that start with `-` are options to the CLI parser.** They go after `--`.

### Limits

- The simulator's users edit whole lines, so ownership is lost by token edits, not by edits to marker lines or line endings.
- Presence was checked on desktop only; the iPhone writes it through the same code but was not run.
- The rate limit walks the log back one commit per request beyond the reader's cache, so a busy vault makes each CLI write slower.
- One Mac, one Obsidian version, one local S3 server; no live R2 run of the command.

- **The R2 adapter's binding type did not fit a real `R2Bucket`.** `onlyIf` was typed `unknown`, so a Workers `R2Bucket` could not be passed without a cast; obsy's own Miniflare test hid it with one. Found when the first agent was wired to the vault. A type test against `@cloudflare/workers-types` now checks it.

### Still open

- Moving an existing agent's daily-note writes onto the SDK: in progress in that agent's repository, with `replaceIfUnchanged`.

## History

- 2026-10-21: Added `replaceIfUnchanged` results and the R2 binding type finding.
- 2026-10-21: Created with the phase 4 results.
