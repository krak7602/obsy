---
title: Whole-note replacement for agents
aliases: [replaceIfUnchanged, compare-and-swap, CAS, whole-file rewrite, daily-note planner, obsy replace]
updated: 2026-10-21
status: accepted
---

# Whole-note replacement for agents

## Context

[Agent SDK choices](2026-10-21-agent-sdk-choices.md) left out every whole-file rewrite: agents append to sections, replace blocks they own, or propose. The first real agent to move onto obsy is a personal assistant that plans the owner's daily note. It reads the note, computes the whole new note, and writes it back. Its own code decides which lines it may change (its lines carry a marker; owner lines and some sections are never edited). Before obsy it wrote through Obsidian Sync with a local revision check, which its documentation says is not a compare-and-swap across devices. Rewriting it onto sections and blocks would change its note format and much of its code.

## Decision

Add `replaceIfUnchanged(path, content, { baseRev })` to `VaultAgent`, and `obsy replace --base-rev`. It commits the whole content only if the live file is still at `baseRev` in the log (or, with `baseRev: null`, if no live file has the path key). Otherwise it returns `changed` and writes nothing. It goes through the same checks as other agent writes: provenance, limits, and presence.

## Consequences

- A whole-note writer gets a true compare-and-swap across every device and agent: an edit made after its read is never overwritten.
- An agent can now remove text that was in the note when it read it. What it removes is up to its own rules, not obsy's. History keeps every revision, and `obsy undo` reverses one commit.
- A device with unsynced edits to the note merges the agent's commit three-way with them, so the device's edits are kept or become a conflict copy.
- Section appends, owned blocks, and proposals stay the default for new agents.

## Evidence

- Unit tests: a commit at the read revision; `changed` after a device edit; a claim lost to a commit on another file, then committed; a claim lost to a commit on the same file, then `changed`.
- Simulator: an agent rewrites whole notes from what it read, keeping user lines. With the revision check removed, 65 of 2,000 seeds failed: the check that agents never remove user text caught them. Results with the check are in [Agent SDK, phase 4](../learning/agent-sdk-phase4.md#simulator).
