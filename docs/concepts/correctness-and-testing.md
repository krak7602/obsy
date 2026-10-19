---
title: Correctness and testing
aliases: [invariants, safety invariants, deterministic simulation, simulator, conformance, testing strategy, no silent overwrite]
updated: 2026-10-19
---

# Correctness and testing

## Current

Status: accepted principle. No tests exist yet.

### Principle

obsy refuses to guess. When it cannot prove that a change is safe, it keeps both versions visibly or asks. Every layer must keep the invariants below, and every test strategy below exists to show that they hold.

### Invariants

- Devices converge when quiet.
- No acknowledged human byte becomes unreachable. It is at a live path, in a conflict copy, or in history.
- No delete applies to an unseen revision.
- No agent commit without a matching base.
- Replaying any journal is idempotent.

Related rules that follow from these invariants live with their subjects: "edit beats delete" and "no base, no merge" in [Merge and conflicts](../subsystems/merge.md); mass-delete rails in [Obsidian plugin](../subsystems/obsidian-plugin.md#deletes-and-safety-rails); agent limits in [Agent SDK and CLI](../subsystems/agent-sdk.md#rules).

### Test strategy

- **Conformance suite** for storage adapters: conditional-create races, `If-Match`, list ordering, read-after-write. Run it against every provider before the provider is listed as supported. See [Storage adapters](../subsystems/storage.md).
- **Deterministic simulation** of the core: a Mac, an iPhone, and an agent with offline periods, crashes between blob upload and log commit, duplicate requests, racy mtimes, renames and deletes. Everything is driven from a seed and is replayable. Phase 1 is done when the invariants hold over at least 1M seeds.
- **Merge properties** with `git merge-file` as an oracle, plus a private corpus of real vault edits. Keep the corpus out of this repository.

The prior art for this strategy (Dropbox CanopyCheck and Trinity, TigerBeetle VOPR) is in the [protocol research notes](../learning/research-notes/protocol-design.md#10-testing-strategies-for-sync-correctness).

## History

- 2026-10-19: Invariants and test strategy accepted, from the former `DESIGN.md`.
