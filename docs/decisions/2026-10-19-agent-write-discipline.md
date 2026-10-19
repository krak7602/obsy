---
title: Agent write discipline
aliases: [agent operations, no whole-file overwrite, owned blocks, proposals, provenance]
updated: 2026-10-19
status: accepted
---

# Agent write discipline

## Context

An AI agent writes to the same notes as the owner. The agent is the novel part of obsy. It shifts the design priority from merge cleverness to write discipline: if the agent can only append, replace fenced blocks, or propose patches, most conflicts that would need a clever merge never occur.

## Decision

Treat the agent as a device with fewer rights than the human devices. Agents edit only through narrow operations: create if absent, append to a section, replace a block they own, or propose a patch. Anchors are re-checked at commit time; a failed anchor becomes a proposal, never a conflict in the owner's space. Whole-file overwrite of an existing human file is not offered. Every agent commit records actor, run, and tool-call IDs, and can be undone.

The current operations and rules are on [Agent SDK and CLI](../subsystems/agent-sdk.md).

## Consequences

- Agents cannot delete human files and are rate-limited below the mass-change rails.
- The plugin needs a way to show and accept proposals.
- An LLM-suggested resolution for a real conflict is itself only a proposal.

## Evidence

- Ink & Switch's Patchwork bot "makes changes as another collaborator" on a branch users can merge; users found rationale comments helpful because AI tools "can also give bad suggestions" ([Ink & Switch](https://www.inkandswitch.com/patchwork/notebook/2024-version-control/07/)).
- Anthropic's text editor tool requires `str_replace` to match exactly one location. The MCP filesystem server marks `edit_file` as non-idempotent.
- Full discussion: [research report](../learning/sync-design-research.md#the-agent-writes-through-narrow-anchored-attributable-operations) and [protocol notes](../learning/research-notes/protocol-design.md#9-ai-agent-as-a-writer-not-clobbering-human-edits).
