# Working in this repository

obsy syncs an Obsidian vault through storage the user owns, and lets scripts and AI agents edit the same notes safely. Status: design accepted; phase 0 spikes in progress. `@obsy/protocol` (storage contract), `@obsy/storage-s3`, `@obsy/storage-testkit`, and `@obsy/merge` exist; there is no sync code yet.

## Hard rules

- Preserve user work. Inspect relevant files before changing them. Keep unrelated changes out of the task.
- Never risk a real vault. Test against scratch vaults or a copy. Never run obsy and another sync system on the same vault. Never delete history, run `obsy gc`, or apply mass changes to real data without an explicit request.
- Protect credentials. Bucket keys, relay and device tokens, and pairing codes never go into source, logs, fixtures, screenshots, or the plugin's `data.json`. Use Obsidian `SecretStorage` in the plugin and ignored local files elsewhere.
- Treat the source tree as publishable. Keep personal note content, real vault paths, bucket names, endpoints, account IDs, and other private identifiers out of source, examples, fixtures, and documentation. Public authorship in `LICENSE` and `manifest.json` is expected. Use generic examples. The private corpus of real vault edits stays outside this repository.
- Respect the current request's deployment boundary. Do not create buckets, deploy Workers, publish npm packages, release the plugin, or submit to the Obsidian community directory unless the current request asks for it.
- Follow [Clean-room licensing](docs/concepts/clean-room-licensing.md). Do not copy PolyForm or GPL code, and do not read Remotely Save's PolyForm `pro/` folder. Record any reused permissive code in `THIRD_PARTY_NOTICES.md`.
- Distinguish implemented behavior, accepted design, proposals, and observed evidence. Never report a plan or an unrun check as completed behavior.

## Working agreement

- The main assistant owns the user conversation, requirements, decisions, integration, and verified results.
- Delegate substantial independent work with clear ownership, constraints, and acceptance checks. Handle small or tightly coupled changes directly.
- Use clear, direct English inspired by ASD-STE100, with roughly 80% adherence. Prefer short sentences, consistent terms, and explicit actions. Keep exact technical names.
- Reuse existing patterns. Check the affected callers and contracts before changing behavior.
- Keep `@obsy/protocol`, `@obsy/merge`, and `@obsy/core` free of Node and DOM APIs. They must run in Obsidian (desktop and iOS), Node, and Workers.
- Protect the [correctness invariants](docs/concepts/correctness-and-testing.md). A change to the protocol, merge, or commit path needs simulator or property-test evidence, not only example tests.
- Verify the changed behavior with an appropriate real command or scenario. For documentation-only work, check structure, links, and navigation. Report only checks that ran.
- Update affected documentation with the change. Keep temporary probes and work transcripts out of maintained documentation.
- Use the versions in `mise.toml` (Node 24, pnpm 12). Run `mise install` and `pnpm install` to set up.
- After a code change, run `pnpm run check`, `pnpm test`, and `pnpm run build` from the root. All three must pass. `build` is local only; it does not publish or deploy.
- Keep the plugin's `manifest.json` and `versions.json` at the repository root.

## Reading routes

Read [README.md](README.md) for the repository entry point. Then select the relevant route:

| If working on | Read first |
| --- | --- |
| System boundaries, packages, or the trust model | [Architecture](docs/architecture.md) |
| What to build next, phase scope, open questions, or risks | [Roadmap](docs/roadmap.md) |
| Bucket layout, records, commits, the change feed, checkpoints, GC, or recovery | [Protocol and core](docs/subsystems/protocol.md), then [bucket decision](docs/decisions/2026-10-19-bucket-as-sequencer.md) |
| The `Storage` interface, a provider adapter, or the conformance suite | [Storage adapters](docs/subsystems/storage.md), then [conformance runbook](docs/runbooks/storage-conformance.md) and [storage spike](docs/learning/storage-spike.md) |
| Merging, conflict copies, or deletes | [Merge and conflicts](docs/subsystems/merge.md), then [merge spike](docs/learning/merge-spike.md) and [merge decision](docs/decisions/2026-10-19-three-way-merge-not-crdt.md) |
| The Obsidian plugin, iOS behavior, or the Obsidian API | [Obsidian plugin](docs/subsystems/obsidian-plugin.md), then [platform notes](docs/learning/research-notes/obsidian-platform.md) |
| The platform probe or iPhone measurements | [Platform probe](docs/runbooks/platform-probe.md) |
| Agent operations or the `obsy` CLI | [Agent SDK and CLI](docs/subsystems/agent-sdk.md) |
| The optional Cloudflare relay | [Relay](docs/subsystems/relay.md), then [Cloudflare notes](docs/learning/research-notes/cloudflare-building-blocks.md) |
| Tests, the simulator, or invariants | [Correctness and testing](docs/concepts/correctness-and-testing.md), then [merge corpus runbook](docs/runbooks/merge-corpus.md) |
| Encryption or security claims | [Server-trusted v1](docs/decisions/2026-10-19-server-trusted-v1.md) |
| Reading or reusing another project's code | [Clean-room licensing](docs/concepts/clean-room-licensing.md) |
| Why the design is what it is | [Sync design research](docs/learning/sync-design-research.md) and [research notes](docs/learning/research-notes/) |
| Setup, commands, packages, or the toolchain | [Development runbook](docs/runbooks/development.md), then [toolchain decision](docs/decisions/2026-10-20-toolchain.md) |
| Adding, editing, or moving documentation | [Documentation taxonomy](docs/TAXONOMY.md) |

## Documentation maintenance

- Give each subject one authoritative home. Link to it instead of copying its specification.
- Use the taxonomy's page shape. Rewrite `Current` as understanding changes. Keep `History` brief and meaningful.
- Preserve dated decision reasoning and the evidence available at the time. Link to the current subject page for the current contract.
- Do not rewrite the research report or research notes. Add new evidence as new learning pages.
- Remove obsolete duplication and fix inbound links when moving a page. Check that maintained pages remain reachable from the repository entry point.
- Keep this file below 200 lines. It is a guide to work and reading routes, not a subsystem specification, experiment report, or diary.
