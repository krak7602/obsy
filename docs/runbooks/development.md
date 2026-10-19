---
title: Development
aliases: [setup, local development, commands, build, test, check, repository layout]
updated: 2026-10-20
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
| `pnpm test` | Run all tests once (`vp test`) |
| `pnpm run build` | Build every package (`vp run` over `packages/*`) |

Run `check`, `test`, and `build` before you report a change as done.

For one package, run its script with a filter, for example `pnpm --filter @obsy/obsidian-plugin run dev` to rebuild the plugin on change with inline sourcemaps.

### Repository layout

| Path | Contents |
| --- | --- |
| `packages/<name>/` | One workspace package. npm name `@obsy/<name>`. |
| `packages/obsidian-plugin/` | Plugin source. Builds `dist/main.js`. |
| `manifest.json`, `versions.json` | The plugin manifest and version map. They must stay at the repository root: the Obsidian community directory reads `manifest.json` from the root of the default branch. |
| `vite.config.ts` | Root lint, format, and test settings for every package |
| `packages/obsidian-plugin/eslint.config.mjs` | Obsidian review rules. ESLint runs from the repository root, because the rules read `manifest.json` from the working directory. |
| `tsconfig.base.json` | Shared compiler options. ES libraries only; no DOM or Node types by default. |
| `pnpm-workspace.yaml` | Workspace packages, the version catalog, and Vite+ overrides |
| `mise.toml` | Node and pnpm versions |

### Add a package

1. Create `packages/<name>/` with `package.json` (`"name": "@obsy/<name>"`, `"type": "module"`, `"private": true` until it is published), `tsconfig.json` extending `../../tsconfig.base.json`, and `src/index.ts`.
2. For a library, add `vite.config.ts` with a `pack` block and a `"build": "vp pack"` script. Copy the shape from `packages/merge/`.
3. Add `vite-plus` as `"catalog:"` in `devDependencies`. Put shared versions in the catalog.
4. Add the package to the `references` in the root `tsconfig.json`.
5. Import test APIs from `vite-plus/test`. Name test files `*.test.ts` under `src/`. A test that needs Node APIs (for example, one that spawns `git`) goes under `packages/<name>/test/`, with its own `tsconfig.json` that adds `"types": ["node"]`. The root test include picks up both folders. `packages/merge/test/` shows the shape.
6. Run `pnpm install`, then the three commands above.

Add `dom` or Node types to a package's `tsconfig.json` only when that package runs there. Never add them to `protocol`, `merge`, or `core`.

### Upgrade Vite+

Update `vite-plus` in the catalog. Then set the `vite` override to the same version and the `vitest` override to the version that `pnpm exec vp toolchain` shows. Keep `rolldown` in the catalog equal to the Rolldown version that Vite+ bundles.

## History

- 2026-10-20: Workspace scaffolded with pnpm and Vite+ ([decision](../decisions/2026-10-20-toolchain.md)).
