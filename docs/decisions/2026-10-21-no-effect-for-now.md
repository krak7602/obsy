---
title: No Effect for now
aliases: [Effect, Effect-TS, Effect 4, typed effects, effect adoption]
updated: 2026-10-21
status: accepted
---

# No Effect for now

## Context

The owner adopted Effect 4 across another repository and asked whether obsy should adopt it too, and where. At that time obsy had phases 0 to 3 built: `@obsy/protocol`, `@obsy/merge`, `@obsy/core` (verified by one million simulator seeds), the storage adapters, the simulator, and the Obsidian plugin.

## Decision

Do not adopt Effect now. Reconsider it for new code that runs only on Node or Workers: the [relay](../subsystems/relay.md), and possibly a future command-line or server component. Any adoption there keeps a plain promise API at its boundary with `@obsy/core`, and with the public agent SDK.

## Consequences

- `@obsy/protocol`, `@obsy/merge`, `@obsy/core`, `@obsy/agent`, the plugin, and the simulator stay plain TypeScript with promises.
- Cheap parts of Effect's benefit can come without it. The sync engine already takes its clock, randomness, timers, storage, and files as injected interfaces (`Environment`, `Storage`, `LocalFiles`, `StateStore`), and its errors are named classes.
- If the relay uses Effect, the repository has two styles, separated at package boundaries.

## Evidence

- **Verified engine.** A rewrite of `@obsy/core` would need new million-seed simulator runs. AGENTS.md requires simulator evidence for changes to the commit path.
- **Stops at safe points.** The engine may stop only at chosen points (`shouldStop`). Effect's interruption can stop work at any step unless code is marked uninterruptible.
- **Determinism.** The simulator orders every bucket and file call by resolving promises one at a time, and waits with `setImmediate`. Effect's fiber scheduler yields on its own, so the simulator would need a custom scheduler.
- **Bundle size**, measured on 2026-10-21 with esbuild (minified, `effect@4.0.5`). Effect with services, typed errors, retry, and timeout: 92 KB (32 KB gzip). With `Schema` as well: 309 KB (97 KB gzip). The plugin was 114 KB minified (38 KB gzip). Obsidian loads `main.js` uncompressed, on iPhones too.
- The plugin has no React, so Effect Atom brings nothing there.
