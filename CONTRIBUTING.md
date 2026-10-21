# Contributing

Thank you for helping with obsy. It syncs people's notes, so correctness comes before features.

## Before you start

- Read [README.md](README.md), then the page for the area you change; [AGENTS.md](AGENTS.md) lists the reading routes.
- Open an issue first for a large change, a protocol change, or a new dependency.
- Report security problems privately, as [SECURITY.md](SECURITY.md) says.

## Rules

- **Never risk a real vault.** Test with scratch vaults or a copy, and never with a vault that another sync service also syncs.
- **No private data.** No credentials, bucket names, endpoints, account IDs, pairing codes, or note content in code, fixtures, logs, screenshots, issues, or documentation. Use generic examples.
- **Clean-room licensing.** Do not copy GPL or PolyForm code, and do not read Remotely Save's PolyForm `pro/` folder. Record reused permissive code in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). See [Clean-room licensing](docs/concepts/clean-room-licensing.md).
- **Evidence for correctness.** A change to the protocol, the merge, or the commit path needs simulator or property-test evidence, not only example tests. See [Correctness and testing](docs/concepts/correctness-and-testing.md) and the [simulator runbook](docs/runbooks/simulator.md).
- `@obsy/protocol`, `@obsy/merge`, `@obsy/core`, and `@obsy/agent` stay free of Node and DOM APIs.

## Making a change

1. Set up as in the [development runbook](docs/runbooks/development.md): `mise install`, then `pnpm install`.
2. Make the change, with tests, and update the documentation it affects ([documentation taxonomy](docs/TAXONOMY.md)).
3. Run `pnpm run check`, `pnpm test`, and `pnpm run build`. All three must pass. For plugin changes, also run the [desktop plugin test](docs/runbooks/desktop-plugin-test.md) if you can.
4. In the pull request, say what you changed, why, and which checks you ran.

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
