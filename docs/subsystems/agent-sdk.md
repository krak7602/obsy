---
title: Agent SDK and CLI
aliases: [obsy/agent, obsy CLI, agent operations, owned blocks, fences, proposals, presence, deferral, undo, VaultAgent, VaultAdmin, provenance, MCP]
updated: 2026-10-21
---

# Agent SDK and CLI

## Current

Status: **existing behavior** (phase 4): `@obsy/agent` (`VaultAgent`, `VaultAdmin`, presence, proposals) and `@obsy/cli` (the `obsy` command). Both are local packages; nothing is published. **Not implemented:** `gc`, vault-wide `restore`, the epoch bump tool, and an MCP wrapper. The reasons for the choices below are in [Agent SDK choices](../decisions/2026-10-21-agent-sdk-choices.md) and the earlier [Agent write discipline](../decisions/2026-10-19-agent-write-discipline.md). How to run the command is in the [CLI runbook](../runbooks/cli.md). Test results are in [Agent SDK, phase 4](../learning/agent-sdk-phase4.md).

Agents and scripts edit through narrow operations against the bucket. They hold no copy of the vault. Each operation reads the head, computes its change from it, and commits with `baseRev` equal to the head revision, with the normal [commit algorithm](protocol.md#commit-algorithm). A lost claim makes it read the new head and compute the change again, so every anchor is checked against the state it commits on. Devices then merge the commit into their files like any other commit, including into a note open in the editor.

An agent is a writer with fewer rights than the owner's devices. It never merges, never deletes, and never moves. It replaces a file's whole content only with `replaceIfUnchanged`, a compare-and-swap on the revision it read. When it cannot make a change safely, the change becomes a **proposal** for the owner.

### Operations

`VaultAgent` (`packages/agent/src/agent.ts`):

| Operation | Behavior |
| --- | --- |
| `read(path)`, `list(prefix)` | The live file at a path (matched by path key), and live files under a prefix |
| `history(path, limit)` | The file's revisions, newest first, found by following `baseRev` (one request per revision) |
| `createIfAbsent(path, content)` | Creates a file. `exists` when a live file has the same path key |
| `appendToSection(path, section, lines)` | Appends lines at the end of a section. Missing headings are created. A missing file is created, proposed, or skipped (`ifMissing`) |
| `replaceBlock(path, blockId, content)` | Replaces the content of the agent's [block](#owned-blocks). With `insert`, a missing block is inserted at the end of a section; with `expectedHash`, the block must hold what the agent last wrote |
| `replaceIfUnchanged(path, content, { baseRev })` | Replaces the whole file only if the live file is still at `baseRev` (from `read`); with `baseRev: null`, only if no live file has the path key. Otherwise `changed`, and nothing is written |
| `proposePatch(path, content, { baseRev, rationale })` | Stores new content for a file, or a new file, as a proposal. Never commits |

Every write returns one of: `committed` (with `seq`, `rev`, the content hash, and for blocks the `blockHash`), `unchanged` (the head already has the result), `exists`, `proposed` (with the proposal ID and reason), `skipped` (`missing` or `not-text`), or `changed` (from `replaceIfUnchanged`: the file's revision now, or null). Bad input throws `AgentInputError`; a passed limit throws `AgentRateLimited`.

### Anchors

A **section** is named by a heading path, for example `['## Log']` or `['Journal', 'Agent']`. Each step is searched below the previous one, at a deeper level; `#` marks fix the level. Only ATX headings (`#` to `######`) outside YAML frontmatter and fenced code count. A heading nested inside another match is not a second match. Lines go after the last non-blank line of the section, before the blank lines that separate it from the next heading. An empty path is the end of the file. Line endings, a byte order mark, and a missing final newline stay as they were; new lines get the file's line ending.

The change becomes a proposal, with reason `anchor-ambiguous`, when a heading matches more than once, when the place for the lines is inside an unclosed code fence, or when a heading to create cannot nest below its parent.

### Owned blocks

```markdown
<!-- obsy:agent id=weather hash=5e78c25d2344b703 -->
Sunny, 14 °C
<!-- /obsy:agent id=weather -->
```

The start marker carries the first 16 hex digits of the SHA-256 of the block's content, as the agent wrote it. When a person edits inside the block, the hash no longer matches: the block is theirs, and the agent's next change to it becomes a proposal with reason `block-edited`. A block ID is 1 to 64 characters of `A–Z a–z 0–9 . _ -`. Two blocks with one ID, a start without an end, or another block's marker inside a block is `anchor-ambiguous`; a missing block without `insert` is `anchor-missing`. Markers inside fenced code are text. An agent's lines and block content may not contain block markers.

To keep a generated note current, put its content in a block.

### Whole-note replacement

`replaceIfUnchanged` is for an agent that computes a whole note itself from the content it read, and keeps the owner's lines by its own rules, as a daily-note planner does. The check is on the bucket's log: on a lost claim the agent reads the new head, and commits only if the file is still at `baseRev`. So no edit from any device or agent made after the read is lost; such an edit gives `changed`. A device that holds unsynced edits to the note merges the commit three-way with them, as with any commit. The agent's own rules decide what it removes; history and [undo](#undo) cover a mistake. See [Whole-note replacement for agents](../decisions/2026-10-21-replace-if-unchanged.md).

### Proposals

A proposal is `proposals/<id>.json` ([record](protocol.md#records)) plus its content as a blob. It holds the **whole proposed content** and the revision it was computed from, not a diff. Reasons: `requested`, `anchor-missing`, `anchor-ambiguous`, `block-edited`, `editing`, and `not-owned` (reserved). A retried operation finds its own open proposal (same actor, path, content, and base) instead of adding another.

`VaultAdmin` (`packages/agent/src/admin.ts`) answers proposals as the owner's actor:

- **Accept.** When the file has not changed since the proposal's base, the proposed content is committed. When it has, the proposal is merged three-way with `merge3` (base, proposal, head; Markdown and text only). A conflict, a deleted file, or a taken path writes nothing, and the proposal stays open. Then `resolutions/<id>.json` records the answer. Accepting again finds the resolution.
- **Reject.** Stores the resolution only.
- A proposal is open while no resolution exists. The commit comes before the resolution, so a crash between them leaves an open proposal whose content the head already holds; accepting it again writes only the resolution.

The plugin shows open proposals and accepts or rejects them ([plugin](obsidian-plugin.md#agent-proposals-and-presence)). The `obsy proposals` commands do the same from a terminal.

### Presence and deferral

A device in full mode writes `presence/<device>.json` while its user types in a note: the note's path and the time, at most every 30 s per note. Editor changes that obsy applies itself do not count. Before an agent changes an existing file, it reads every presence record. If one names the same path key with a time less than `windowMs` ago (default two minutes), it:

- `wait` (default): looks again every `pollMs` (15 s), up to `maxWaitMs` (5 minutes), then proposes with reason `editing`. After a wait it computes the change again on a fresh head.
- `propose`: proposes at once.
- `ignore`: commits; the device merges the change into the open note.

Presence is advisory. A damaged record is ignored, and a failed write is not reported. Device clocks are not synchronised; a record with a future time counts as recent.

### Provenance and limits

- Every agent commit and proposal records the actor (`kind: agent`, `id`), the `run` given to the constructor, and the `toolCall` given to the operation.
- Before each commit, the agent counts its own commits in the last hour, walking the log back from the head: at most 240 commits and 40 different files by default (`limits`). The file limit stays below the [mass-change rails](obsidian-plugin.md#deletes-and-safety-rails) (50 files).
- Agents write a checkpoint after a commit whose `seq` is a multiple of 500, as devices do.
- These rules guard against mistakes, not against a hostile agent: an agent holds the same bucket credential as the devices and could write any object. A per-agent credential needs the [relay](relay.md).

### Undo

`VaultAdmin.undo(seq)` writes one new commit that reverses commit `seq`:

| Op in `seq` | Reversed by |
| --- | --- |
| `put` that changed a file | The earlier content. If the file changed since, a three-way revert (`merge3` with base = content after `seq`, ours = content before, theirs = head), so later edits stay |
| `put` that created or restored a file | A delete, only if the file has not changed since |
| `move` | A move back, if the file is still at the target and the old path is free |
| `delete` | A restore of the last content, if the path is free |

If any file cannot be reversed without losing a later edit (`changed-since`, `deleted-since`, `moved-since`, `path-taken`, `conflict`, `not-text`), nothing is written and the problems are returned. Undoing a commit twice is `unchanged`.

### CLI

`@obsy/cli` builds `packages/cli/dist/obsy.mjs`, one Node file. Agent commands: `ls`, `cat`, `history`, `create`, `append`, `block`, `replace`, `propose`. Owner commands: `status`, `proposals` (`list`, `show`, `accept`, `reject`), `undo`, `verify <folder>`, `export <folder> [--seq n]`, `init`. Bucket settings and keys come only from `OBSY_S3_*` variables or `--env-file`, never from arguments. `--json` prints the results for programs. Usage and examples are in the [CLI runbook](../runbooks/cli.md).

- `verify` compares a folder with the head (`verifyLocal`) and changes nothing. It skips names that Obsidian does not list (any path segment starting with `.`) and temporary files.
- `export` writes the files of any `seq` into a new or empty folder, from the newest checkpoint at or before it plus the log. It never writes outside that folder.

### Packages and platforms

`@obsy/agent` is free of Node and DOM APIs, like `@obsy/core`; the plugin uses it for presence and proposals. `@obsy/cli` runs on Node 24. An MCP server wrapper is later work.

## History

- 2026-10-21: `replaceIfUnchanged` added, a whole-note compare-and-swap ([decision](../decisions/2026-10-21-replace-if-unchanged.md)).

- 2026-10-21: Implemented in phase 4: operations, owned blocks with a content hash, proposals with whole content and resolution records, presence and deferral, rate limits, undo, and the `obsy` command. `AgentWriter` in `@obsy/core` was replaced. See [Agent SDK choices](../decisions/2026-10-21-agent-sdk-choices.md).
- 2026-10-19: Agent operations and rules accepted, from the former `DESIGN.md`.
