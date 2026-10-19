---
title: Agent SDK and CLI
aliases: [obsy/agent, obsy CLI, agent operations, owned blocks, fences, proposals, undo, MCP]
updated: 2026-10-19
---

# Agent SDK and CLI

## Current

Status: accepted design, not yet implemented. Package: `@obsy/agent`.

Agents and scripts edit through narrow operations. Each operation reads the current head, computes the change, and commits with the normal [commit algorithm](protocol.md#commit-algorithm). Concurrent human edits are therefore merged or preserved, never overwritten. The reasons are in [Agent write discipline](../decisions/2026-10-19-agent-write-discipline.md).

### Operations

| Operation | Behaviour |
| --- | --- |
| `createIfAbsent(path, content)` | Creates a new file; fails if the path exists |
| `appendToSection(path, headingPath, lines)` | Appends under a heading, creating it if missing; commutes with edits elsewhere |
| `replaceBlock(path, blockId, expectedHash, content)` | Replaces a fenced block the agent owns, only if unchanged |
| `proposePatch(path, baseRev, diff, rationale)` | Stores a proposal for the owner to accept or reject |
| `read(path)`, `list(prefix)`, `history(path)` | Read-only access to heads and revisions |

### Rules

- **No whole-file overwrite** of an existing file not created by the agent.
- **Owned blocks** are fenced: `<!-- obsy:agent id=… -->` … `<!-- /obsy:agent -->`. A human edit inside a fence transfers ownership to the human.
- **Anchors are re-checked at commit time.** If the heading or block is missing, ambiguous, or changed, the edit becomes a proposal instead of a conflict in the owner's space.
- **Deferral:** if `presence/` shows a device edited the note in the last two minutes, the agent waits or proposes.
- **Provenance:** agent commits record actor, run, and tool-call IDs. `obsy undo <seq>` writes a new commit restoring the previous content, with a three-way revert if humans edited since.
- **Limits:** agents cannot delete human files and are rate-limited below the mass-change rails.

### CLI

The CLI exposes the same operations plus `init`, `status`, `verify`, `restore`, `gc`, and `export`. The integrity commands are described on the [protocol page](protocol.md#integrity-and-recovery). An MCP server wrapper is a later convenience.

## History

- 2026-10-19: Agent operations and rules accepted, from the former `DESIGN.md`.
