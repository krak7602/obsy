---
title: Development
aliases: [setup, local development, commands, build, test, check, repository layout]
updated: 2026-10-21
---

# Development

## Current

The tools and the reasons for them are in the [toolchain decision](../decisions/2026-10-20-toolchain.md).

### Set up

1. Install [mise](https://mise.jdx.dev/).
2. In the repository root, run `mise install`. This installs the Node and pnpm versions in `mise.toml`.
3. Run `pnpm install`.

### Commands

Run these from the repository root.

| Command | Does |
| --- | --- |
| `pnpm run check` | Format check, lint, and type check (`vp check`), then the Obsidian review rules |
| `pnpm run lint:obsidian` | Only the Obsidian review rules (ESLint on TypeScript 6, plugin package and root `manifest.json`). Warnings fail the run. |
| `pnpm run fix` | Apply format and lint fixes (`vp check --fix`) |
| `pnpm test` | Run all tests once (`vp test`). Hermetic: no Docker, no network. |
| `pnpm run test:s3-local` | Storage conformance against a local S3 server in Docker ([storage conformance](storage-conformance.md)) |
| `pnpm run test:s3-live` | Storage conformance against a scratch R2 or S3 bucket ([storage conformance](storage-conformance.md)) |
| `pnpm run test:r2-live` | Storage conformance of the R2 binding adapter through a temporary test Worker ([storage conformance](storage-conformance.md#live-r2-binding-run)) |
| `pnpm run test:desktop` | The plugin in a real Obsidian desktop app against a local S3 server in Docker ([desktop plugin test](desktop-plugin-test.md)) |
| `pnpm run build` | Build every package (`vp run` over `packages/*`) |
| `pnpm --filter @obsy/obsidian-plugin run release <version>` | Prepare plugin release files; publishes only with `--publish` ([plugin release](plugin-release.md)) |

Run `check`, `test`, and `build` before you report a change as done.

For one package, run its script with a filter, for example `pnpm --filter @obsy/obsidian-plugin run dev` to rebuild the plugin on change with inline sourcemaps.

### Repository layout

| Path | Contents |
| --- | --- |
| `packages/<name>/` | One workspace package. npm name `@obsy/<name>`. |
| `packages/obsidian-plugin/` | Plugin source. Builds `dist/main.js`, and the [platform probe](platform-probe.md) in `dist/obsy-probe/`. `e2e/` holds the [desktop plugin test](desktop-plugin-test.md). |
| `manifest.json`, `versions.json` | The plugin manifest and version map. They must stay at the repository root: the Obsidian community directory reads `manifest.json` from the root of the default branch. |
| `vite.config.ts` | Root lint, format, and test settings for every package |
| `packages/obsidian-plugin/eslint.config.mjs` | Obsidian review rules. ESLint runs from the repository root, because the rules read `manifest.json` from the working directory. |
| `tsconfig.base.json` | Shared compiler options. ES libraries only; no DOM or Node types by default. |
| `pnpm-workspace.yaml` | Workspace packages, the version catalog, and Vite+ overrides |
| `mise.toml` | Node and pnpm versions |

### Add a package

1. Create `packages/<name>/` with `package.json` (`"name": "@obsy/<name>"`, `"type": "module"`, `"private": true` until it is published), `tsconfig.json` extending `../../tsconfig.base.json`, and `src/index.ts`.
2. For a library, add `vite.config.ts` with a `pack` block and a `"build": "vp pack"` script. Copy the shape from `packages/merge/`. If other workspace packages import it, use `exports: { devExports: true }` in the `pack` block, point `exports` in `package.json` at `./src/index.ts`, and put the `dist` exports in `publishConfig`, as `packages/protocol/` does. Then tests and type checks use the source without a build first.
3. Add `vite-plus` as `"catalog:"` in `devDependencies`. Put shared versions in the catalog.
4. Add the package to the `references` in the root `tsconfig.json`.
5. Import test APIs from `vite-plus/test`. Name test files `*.test.ts` under `src/`. A test that needs Node APIs (for example, one that spawns `git`) goes under `packages/<name>/test/`, with its own `tsconfig.json` that adds `"types": ["node"]`; the root test include picks it up, as in `packages/merge/test/`. A test that needs Docker, the network, or a live bucket is named `*.integration.test.ts` and has its own Vitest config; the root test include excludes it, so that `pnpm test` stays hermetic. See `packages/storage-s3/test/`.
6. Run `pnpm install`, then the three commands above.

Add `dom` or Node types to a package's `tsconfig.json` only when that package runs there. Never add them to `protocol`, `merge`, or `core`.

### Upgrade Vite+

Update `vite-plus` in the catalog. Then set the `vite` override to the same version and the `vitest` override to the version that `pnpm exec vp toolchain` shows. Keep `rolldown` in the catalog equal to the Rolldown version that Vite+ bundles.

## History

- 2026-10-20: Workspace scaffolded with pnpm and Vite+ ([decision](../decisions/2026-10-20-toolchain.md)).
- 2026-10-20: Added the storage conformance commands, source exports for workspace libraries, and the `test/` pattern for integration tests.
- 2026-10-21: Added the R2 binding and desktop plugin test commands, and the release command.
