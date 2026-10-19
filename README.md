# obsy

Sync an Obsidian vault through storage you own, and let scripts and AI agents edit the same notes safely.

Status: design accepted. The workspace is scaffolded; no sync code yet.

## What it is

- **Bring your own bucket.** Cloudflare R2 or AWS S3, the providers verified to support the conditional writes obsy relies on. No server is required: the bucket itself orders every change.
- **No silent overwrites.** Every change states the version it was based on. Concurrent edits merge with a Markdown-aware three-way merge, or both versions are kept as a visible conflict copy.
- **Plain, inspectable storage.** File content is stored as-is, addressed by SHA-256, with a commit log and checkpoints next to it. History and restore come built in.
- **Obsidian plugin** for desktop and iPhone. It syncs on launch, on returning to the app, and on save; iOS gives plugins no background time.
- **Agent SDK and CLI.** Programs edit through narrow operations: create if absent, append to a section, replace a block they own, or propose a patch. Edits are attributed and can be undone.
- **Optional Cloudflare relay** for instant push and per-device tokens. It uses the same protocol and is never the source of truth.

## Layers

| Package | Role |
| --- | --- |
| `@obsy/protocol` | Bucket layout and record formats |
| `@obsy/merge` | Markdown-aware three-way merge |
| `@obsy/core` | Sync engine shared by every client |
| `@obsy/storage-s3`, `@obsy/storage-r2` | Storage adapters |
| `@obsy/agent` | Safe edit operations and the `obsy` CLI |
| `obsy` plugin | Obsidian integration |
| `@obsy/relay` | Optional push and device-token relay on Cloudflare |

## Security

Version 1 is not end-to-end encrypted: whoever controls the bucket can read the notes, and a server-side agent needs to read them too. Use a private bucket and credentials scoped to it. Encrypted folders that agents cannot read are planned for later. See [SECURITY.md](SECURITY.md).

## Documents

Start with [Architecture](docs/architecture.md). It links to every layer.

| Read | For |
| --- | --- |
| [Architecture](docs/architecture.md) | Goals, layers, packages, and the trust model |
| [Roadmap](docs/roadmap.md) | Build phases, open questions, and risks |
| [Protocol and core](docs/subsystems/protocol.md) | Bucket layout, commit algorithm, change feed, recovery |
| [Storage adapters](docs/subsystems/storage.md) | The `Storage` interface and provider requirements |
| [Merge and conflicts](docs/subsystems/merge.md) | Three-way merge rules and conflict copies |
| [Obsidian plugin](docs/subsystems/obsidian-plugin.md) | Plugin lifecycle, safe apply, iOS, pairing |
| [Agent SDK and CLI](docs/subsystems/agent-sdk.md) | Safe edit operations and the `obsy` CLI |
| [Relay](docs/subsystems/relay.md) | Optional push and device tokens |
| [Correctness and testing](docs/concepts/correctness-and-testing.md) | Invariants and test strategy |
| [Development](docs/runbooks/development.md) | Setup, commands, repository layout |
| [Decisions](docs/decisions/) | Why each major choice was made |
| [Design research](docs/learning/sync-design-research.md) | The evidence, with sources, and [detailed notes](docs/learning/research-notes/) |
| [Documentation taxonomy](docs/TAXONOMY.md) | How the docs are organised and maintained |

To set up and run the checks, see the [development runbook](docs/runbooks/development.md). Contributors and coding agents: read [AGENTS.md](AGENTS.md).

## Licensing

MIT ([LICENSE](LICENSE)). Ideas come from public documentation and permissively licensed projects only. Remotely Save's current sync engine (PolyForm Strict) and GPL code are not copied. [Clean-room licensing](docs/concepts/clean-room-licensing.md) lists what may be reused and under which notices.
