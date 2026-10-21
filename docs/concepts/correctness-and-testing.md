---
title: Correctness and testing
aliases: [invariants, safety invariants, deterministic simulation, simulator, conformance, testing strategy, no silent overwrite]
updated: 2026-10-21
---

# Correctness and testing

## Current

Status: accepted principle. The storage conformance suite and race harness exist ([storage spike](../learning/storage-spike.md)). Merge unit, property, and oracle tests exist ([merge spike](../learning/merge-spike.md)). The deterministic simulator exists and checks every invariant below ([runbook](../runbooks/simulator.md), [results](../learning/simulator-phase1.md)).

### Principle

obsy refuses to guess. When it cannot prove that a change is safe, it keeps both versions visibly or asks. Every layer must keep the invariants below, and every test strategy below exists to show that they hold.

### Invariants

- Devices converge when quiet.
- No acknowledged human byte becomes unreachable. It is at a live path, in a conflict copy, or in history.
- No delete applies to an unseen revision.
- No agent commit without a matching base.
- An agent never removes a person's text. Only the owner, by accepting a proposal, removes text that the proposal removed.
- Replaying any journal is idempotent.

Related rules that follow from these invariants live with their subjects: "edit beats delete" and "no base, no merge" in [Merge and conflicts](../subsystems/merge.md); mass-delete rails in [Obsidian plugin](../subsystems/obsidian-plugin.md#deletes-and-safety-rails); agent limits in [Agent SDK and CLI](../subsystems/agent-sdk.md#provenance-and-limits).

### Test strategy

- **Conformance suite** for storage adapters: conditional-create races, a commit-log race, `If-Match`, list ordering, read-after-write. Existing behavior; passes locally and on live R2, not yet run on AWS S3. Run it against every provider before the provider is listed as supported. See [Storage adapters](../subsystems/storage.md#conformance-suite) and the [runbook](../runbooks/storage-conformance.md).
- **Deterministic simulation** of the core: a Mac, an iPhone, two agents, and the owner answering proposals and undoing agent commits, with offline periods, crashes at any request, lost responses, writes that land late, renames, deletes, and case and normalisation twins. Everything is driven from a seed and is replayable. Existing behavior; each invariant has a concrete check in the [simulator runbook](../runbooks/simulator.md#invariants-checked). Phase 1 is done when the invariants hold over at least 1M seeds.
- **Vault adapter tests** for the plugin: the engine on a fake Obsidian vault that models open editors, unsaved edits, and user saves that land while obsy reads and hashes a file. Random runs check convergence and no lost lines. Existing behavior; 400 seeds in `pnpm test`, more on request ([plugin tests](../subsystems/obsidian-plugin.md#tests)).
- **Desktop test** in a real Obsidian app with scratch vaults or a copy of a vault, against a local S3 server. Existing behavior ([runbook](../runbooks/desktop-plugin-test.md)).
- **Agent edit properties**: random notes and heading paths keep every original line and put appended lines inside the section; owned blocks stay owned through replaces, also with CRLF. Existing behavior (`packages/agent/src/markdown.test.ts`).
- **Merge properties** with `git merge-file` as an oracle, plus a private corpus of real vault edits. Keep the corpus out of this repository; run it with the [merge corpus runbook](../runbooks/merge-corpus.md).

The prior art for this strategy (Dropbox CanopyCheck and Trinity, TigerBeetle VOPR) is in the [protocol research notes](../learning/research-notes/protocol-design.md#10-testing-strategies-for-sync-correctness).

## History

- 2026-10-21: Agents and the owner added to the simulator, with the check that agents never remove a person's text (phase 4).

- 2026-10-19: Invariants and test strategy accepted, from the former `DESIGN.md`.
- 2026-10-20: Deterministic simulator implemented ([results](../learning/simulator-phase1.md)).
- 2026-10-21: Simulator check that no device deletes in the bucket a file it keeps (phase 3).
- 2026-10-21: Vault adapter tests and the desktop test added for the plugin ([phase 2](../learning/desktop-plugin-phase2.md)).
- 2026-10-20: Storage conformance suite and race harness implemented ([storage spike](../learning/storage-spike.md)). First merge unit, property, and oracle tests added in the phase 0 merge spike ([merge spike](../learning/merge-spike.md)).
