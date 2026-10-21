---
title: Agent SDK choices
aliases: [block hash, owned block marker, proposal content, resolution records, presence record, undo rules, writeOwnFile, CLI credentials]
updated: 2026-10-21
status: accepted
---

# Agent SDK choices

## Context

The [agent write discipline](2026-10-19-agent-write-discipline.md) and the accepted [agent SDK design](../subsystems/agent-sdk.md) left several choices open when phase 4 started:

1. How an agent knows that a person edited its block. The design said "a human edit inside a fence transfers ownership to the human", and `replaceBlock` took an `expectedHash`.
2. What a proposal stores. The design said `proposePatch(path, baseRev, diff, rationale)`.
3. How a proposal is answered. `proposals/<id>.json` is create-once.
4. What presence holds, and what an agent does by default when a device edits the note.
5. When undo writes, and what happens when later edits overlap.
6. Whether agents may rewrite files they created ("no whole-file overwrite of an existing file not created by the agent").
7. How the CLI gets bucket keys.

## Decision

1. **The start marker carries a hash of the block's content**: `<!-- obsy:agent id=… hash=<16 hex> -->` … `<!-- /obsy:agent id=… -->`. A mismatch means someone else edited it, so the block is theirs. The end marker repeats the ID. `expectedHash` stays as an optional extra check.
2. **A proposal stores the whole proposed content as a blob**, plus the base revision and its content hash. Accepting is a three-way merge of base, proposal, and head with `merge3`.
3. **Answers are separate create-once records**, `resolutions/<id>.json`, with the outcome, the actor, and the commit. An accept commits first and writes the resolution second.
4. **Presence is one overwritable record per device** (`presence/<device>.json`: path and time), written by that device only, with `putIfMatch` on the etag of its last write. The plugin writes it while the user types, at most every 30 s per note. The default deferral is `wait`: up to 5 minutes, then a proposal.
5. **Undo is one commit, all or nothing.** A changed file is reverted three-way. When any file would lose a later edit, nothing is written.
6. **No whole-file rewrite at all in this phase.** A generated note keeps its content in an owned block.
7. **The CLI reads keys only from `OBSY_S3_*` variables or `--env-file`**, never from arguments, which appear in shell history and process lists.

## Consequences

- Ownership needs no history lookup and survives across agent runs and machines. A person who edits the marker line, or an editor that changes the line endings inside a block, also takes the block: the agent proposes instead of writing.
- Whole-content proposals cost one blob each, but they need no diff format and accept with the merge that devices already use. GC (phase 5) must keep blobs that open proposals reference.
- A rejection that races an acceptance can lose: the acceptance may commit before it finds the stored rejection. The CLI reports this case.
- `wait` keeps the default polite but can hold a CLI call for up to five minutes. Scripts that must not wait use `--presence propose` or `--presence ignore`.
- Undo refuses more often than a line-by-line partial undo would. For example, it refuses when a later insertion is next to the reverted line (`merge3` treats adjacent changes as a conflict).
- Ownership by whole file was dropped because it needs the file's whole history at each write: a file an agent rewrites hourly has thousands of revisions within months.
- The agent's guardrails are not a security boundary: every writer has the same bucket credential ([server-trusted v1](2026-10-19-server-trusted-v1.md)).

## Evidence

- [Agent SDK, phase 4](../learning/agent-sdk-phase4.md): property tests of the Markdown edits, the simulator with two agents and an owner, the mutation checks, the CLI against a local S3 server, and the desktop test in Obsidian.
- [Mobile sync, phase 3](../learning/mobile-sync-phase3.md#results): the plugin already merges remote commits into an open editor, so `ignore` mode and accepted proposals reach open notes safely.
