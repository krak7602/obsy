---
title: Toolchain
aliases: [pnpm, Vite+, vite-plus, vp, Rolldown, tsdown, Oxlint, Oxfmt, Vitest, mise, TypeScript 7, build tools]
updated: 2026-10-20
status: accepted
---

# Toolchain

## Context

obsy is a monorepo. Its code runs in three runtimes: the Obsidian plugin (desktop and iOS), Node (the agent SDK and CLI), and Cloudflare Workers (the optional relay). Some packages are published to npm on their own. `@obsy/protocol`, `@obsy/merge`, and `@obsy/core` must not use Node or DOM APIs.

Options considered:

- **Package manager:** npm workspaces, pnpm, Bun, vlt, Deno, Yarn.
- **Plugin bundle:** esbuild (used by the official Obsidian sample plugin), Vite, Rolldown.
- **Lint and format:** ESLint with Prettier, or Oxlint with Oxfmt.

## Decision

| Job | Tool |
| --- | --- |
| Node version | mise (`mise.toml`), Node 24 LTS |
| Packages and workspaces | pnpm 12, pinned in `packageManager` and `mise.toml`. Shared versions use the pnpm catalog. |
| Format, lint, type check | Vite+ `vp check` (Oxfmt, Oxlint, and type checks through tsgolint) |
| Tests | Vite+ `vp test` (Vitest 5). Tests import from `vite-plus/test`. |
| Library packages | Vite+ `vp pack` (tsdown) |
| Plugin bundle | Rolldown, writing one CommonJS `dist/main.js` with `obsidian`, `electron`, `@codemirror/*`, and `@lezer/*` external |
| Monorepo tasks | Vite+ `vp run` |
| Language | TypeScript 7 |

Do not use `vp env`; mise owns the runtime. Bun is not used. Vite's dev server is not used: Obsidian loads `main.js` itself.

The commands are in the [development runbook](../runbooks/development.md).

## Consequences

- pnpm's strict `node_modules` means a package sees only the dependencies it declares. This helps keep the core packages free of platform dependencies.
- The base `tsconfig` has only ES libraries and no `@types/*`. A package must opt in to `dom` or Node types. The type check rejected `process` in the plugin package on the first run, which shows the boundary works.
- One root `vite.config.ts` holds the lint, format, and test settings. Per-package `vite.config.ts` files hold only `pack` settings.
- `eslint-plugin-obsidianmd` cannot run yet. It depends on typescript-eslint, which does not support TypeScript 7. This is open until phase 2 (see the [roadmap](../roadmap.md#open-questions)).
- Vite+ aliases `vite` to `@voidzero-dev/vite-plus-core`. Keep the `vite` and `vitest` overrides in `pnpm-workspace.yaml` equal to the installed Vite+ versions.

## Evidence

Read on 2026-10-19 and 2026-10-20 from the npm registry: pnpm 12.14.0, Bun 1.4.3, vlt 1.4.0, Deno 2.9.6, vite-plus 1.3.0 (MIT; bundles Vite 8.3.4, Rolldown 1.2.14, tsdown 0.23.1, Vitest 5.0.5, Oxlint 1.88.0, Oxfmt 0.73.0, tsgolint 7.0.2004), esbuild 0.28.2, TypeScript 7.0.2. Node 24.22.0 was the newest LTS on nodejs.org; Node 26 was not yet LTS.

- The Vite+ README says it wraps pnpm, npm, Yarn, or Bun. It documents the workspace overrides for pnpm.
- The official [obsidian-sample-plugin](https://github.com/obsidianmd/obsidian-sample-plugin) builds with esbuild to a CommonJS `main.js`.
- Observed locally on 2026-10-20: `vp check`, `vp test`, `vp pack`, and the Rolldown plugin build all passed on the scaffold. Loading `eslint-plugin-obsidianmd` 0.4.2 failed with "typescript-eslint does not support TS 7.0."
- Not yet verified: that Obsidian loads the Rolldown-built `main.js`. Verify this in phase 2 with a scratch vault.
