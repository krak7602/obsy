---
title: Documentation taxonomy
aliases: [documentation policy, knowledge map, repository working agreement]
updated: 2026-10-21
---

# Documentation taxonomy

## Current

### Purpose

Documentation is a maintained knowledge and retrieval system. It is not a transcript of work. Give each subject one authoritative home. Other pages link to that home instead of copying its specification.

Use clear, direct English inspired by ASD-STE100. Aim for roughly 80% adherence, not formal compliance. Use short sentences, consistent terms, and explicit actions. Keep exact technical names.

### Homes

| Question | Home |
| --- | --- |
| What are the system boundaries, layers, and trust model? | [architecture.md](architecture.md) |
| What do we build next, and what is still open or risky? | [roadmap.md](roadmap.md) |
| How does a subsystem work, or what is its explicitly labelled design? | `subsystems/` |
| What reusable principle guides the choices? | `concepts/` |
| Why was a choice made? | `decisions/` |
| How is a repeatable operation performed? | `runbooks/` |
| How can a reader understand and reconstruct an idea or its evidence? | `learning/` |
| How is documentation maintained? | This page |

Create only categories with real content. `diagrams/` does not exist yet; create it when the first real page needs it. Keep an inline diagram with its authoritative subject when a separate file adds no value.

[README.md](../README.md) is the human entry point and navigation map. [AGENTS.md](../AGENTS.md) contains hard rules, working agreements, conditional reading routes, and documentation maintenance rules. These entry points are not extra homes for subsystem specifications.

### Current map

| Page | Owns |
| --- | --- |
| [Architecture](architecture.md) | Goals, non-goals, layers, package map, trust model |
| [Roadmap](roadmap.md) | Build phases, open questions, risks |
| [Protocol and core](subsystems/protocol.md) | Bucket layout, records, commit algorithm, change feed, checkpoints, GC, integrity |
| [Storage adapters](subsystems/storage.md) | `Storage` interface, provider requirements, conformance suite |
| [Merge and conflicts](subsystems/merge.md) | Three-way merge rules, conflict copies, deletes |
| [Obsidian plugin](subsystems/obsidian-plugin.md) | Lifecycle, change detection, apply, rails, credentials, pairing |
| [Agent SDK and CLI](subsystems/agent-sdk.md) | Agent operations, owned blocks, provenance, CLI commands |
| [Relay](subsystems/relay.md) | Optional push, device tokens, presence |
| [Development](runbooks/development.md) | Setup, commands, repository layout, adding packages |
| [Storage conformance](runbooks/storage-conformance.md) | Running the conformance suite locally in Docker and against a live bucket |
| [Merge corpus](runbooks/merge-corpus.md) | Running the merge against a private corpus, and the heavy synthetic tests |
| [Simulator](runbooks/simulator.md) | Running the deterministic simulator, the million-seed run, and replaying a seed |
| [Platform probe](runbooks/platform-probe.md) | Building, installing, and running the iPhone platform probe; sending its report |
| [iPhone sync test](runbooks/iphone-sync-test.md) | The manual phase 3 test on a Mac and an iPhone |
| [Plugin release](runbooks/plugin-release.md) | Preparing and publishing a plugin release and a BRAT beta |
| [Desktop plugin test](runbooks/desktop-plugin-test.md) | Running the plugin in a real Obsidian desktop app against a local S3 server, with scratch vaults or a copy |
| [Correctness and testing](concepts/correctness-and-testing.md) | Invariants and test strategy |
| [Clean-room licensing](concepts/clean-room-licensing.md) | What code may and may not be read or reused |
| [Sync design research](learning/sync-design-research.md) | The original research report (evidence, frozen) |
| [Research notes](learning/research-notes/) | Detailed, sourced notes behind the report (evidence, frozen) |
| [Storage spike](learning/storage-spike.md) | Phase 0 storage and conditional-create race results (evidence) |
| [Merge spike](learning/merge-spike.md) | Phase 0 merge, oracle, and speed results (evidence) |
| [Merge diff replacement](learning/merge-diff.md) | Phase 0 diff survey, Myers diff results, and the generated corpus on real notes (evidence) |
| [Simulator, phase 1](learning/simulator-phase1.md) | One million seeds, bugs found, mutation check (evidence) |
| [R2 binding live run](learning/r2-binding-live.md) | `@obsy/storage-r2` conformance on real R2 through a test Worker (evidence) |
| [iPhone probe](learning/iphone-probe.md) | Phase 0 iOS results: `requestUrl`, hashing, IndexedDB, `SecretStorage`, restarts, background (evidence) |
| [Mobile sync, phase 3](learning/mobile-sync-phase3.md) | Phase 3 results so far: simulator, mutation check, desktop runs; iPhone run pending (evidence) |
| [Desktop plugin, phase 2](learning/desktop-plugin-phase2.md) | Phase 2 results: adapter tests, simulator, desktop runs on generated vaults and a vault copy, findings (evidence) |

Decision records are in [decisions/](decisions/).

### Durable subject pages

Use this shape for architecture, roadmap, subsystem, concept, runbook, and learning pages:

```markdown
---
title: Human-readable title
aliases: [alternate terms, old names, abbreviations]
updated: YYYY-MM-DD
---

# Human-readable title

## Current
A coherent explanation of the latest understanding.

## History
- YYYY-MM-DD: A meaningful change and its reason; link to a decision when relevant.
```

Use lower-level headings inside `Current`. State whether a description is existing behavior, accepted but unimplemented design, a proposal, an observed result, or an unresolved question. `Current` means current knowledge; it does not turn a proposed system into an implemented one.

Rewrite `Current` when understanding changes. Keep `History` brief. Do not log every task, edit, failed command, or mechanical file move.

### Learning and evidence pages

A learning page may preserve a coherent research record or experiment as evidence. Keep its method, findings, sources, limits, and lessons together. Do not preserve the work transcript.

The research report and research notes are frozen evidence from 2026-10-19. Do not rewrite them to match later design changes. Their status banner points to the current design. Put new findings in new learning pages, and update the subject pages they affect. A runbook owns the repeatable operation, not another copy of the result table.

### Dated decisions

Use `YYYY-MM-DD-short-subject.md` under `decisions/`. Include `title`, `aliases`, `updated`, and `status` in YAML frontmatter. Use these sections in order:

1. `Context`
2. `Decision`
3. `Consequences`
4. `Evidence`

Record why the choice made sense and what evidence was available. Distinguish an accepted policy from an undecided implementation choice. Link to the current subject page for its operating contract. Do not keep a second mutable specification in the decision record.

If a later decision replaces an earlier one, add a dated record and link the two. Preserve the earlier reasoning. Do not silently rewrite history to imply that later evidence was known earlier.

### Maintenance with changes

- Find the authoritative page before creating another one. Check titles, aliases, and the current map above.
- Update affected pages in the same change as the code or decision. Update the `updated` date when the page's knowledge changes. Update the current map when you add, move, or remove a page.
- Keep evidence and uncertainty explicit. Preserve source links and distinguish published claims from locally observed behavior.
- Remove stale duplication. After moving a page, update inbound links and remove the obsolete copy; do not leave forwarding stubs by default.
- Check relative links, heading fragments, and reachability from `README.md`. Keep `AGENTS.md` below 200 lines.
- Keep credentials, real vault content, private corpora, scratch notes, transcripts, and throwaway scripts out of maintained documentation. Record redacted outcomes instead.
- Do not invent build, test, or deployment commands for tools that are not present. Document usable commands when the implementation exists.

## History

- 2026-10-19: Adopted the repository working agreement. Split the former `DESIGN.md` into architecture, roadmap, subsystem, concept, and decision pages. Moved the research report and notes into `learning/` as frozen evidence.
- 2026-10-20: Added `runbooks/` with the development runbook.
