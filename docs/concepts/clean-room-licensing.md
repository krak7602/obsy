---
title: Clean-room licensing
aliases: [licence, license, code reuse, third-party code, PolyForm, GPL, prior art]
updated: 2026-10-19
---

# Clean-room licensing

## Current

Status: accepted principle. This is engineering guidance, not legal advice.

obsy is MIT ([LICENSE](../../LICENSE)). Ideas come from public documentation and permissively licensed projects only. Before you read or reuse code from another project, check its licence against this page.

### May be reused, with notices kept

MIT and Apache-2.0 code may be reused with its notices:

- Self-hosted LiveSync.
- The Relay plugin and server. Keep the y-sweet and y-crdt MIT notices. Relay's self-hosted server README says use with more than three collaborators "requires a paid license"; that does not affect a single owner.
- Obsidian Git, Fast Note Sync, Remotely Sync.
- Remotely Save's Apache-licensed `src/`, `docs/`, and pre-split tree: the [V3 design document](https://github.com/remotely-save/remotely-save/blob/master/docs/sync_algorithm/v3/design.md) and [`src/sync.ts` at commit `0802767`](https://github.com/remotely-save/remotely-save/blob/08027677267934d3a1ca6f6e3cf06ee1be53ee52/src/sync.ts) (2024-05-25).

When code is reused, record it and its notice in a `THIRD_PARTY_NOTICES.md` file in the same change.

### Do not copy (and do not read Remotely Save `pro/`)

- **Remotely Save `pro/`** (PolyForm Strict 1.0.0). Its sync engine lives there. Do not read current `pro/src/sync.ts` or `conflictLogic.ts`.
- **BYOC** (obsidian-byoc). Its MIT `src/` file names mirror upstream `pro/src`. This was observed but not diffed, so treat it as a possible licensing problem.
- **Peerdraft and Obsidian Decentralized** (GPL-3.0). Copying from them would make obsy GPL-3.0.

### Unchecked

- The licence of `@vrtmrz/livesync-commonlib`, where LiveSync's core logic lives, was not checked. Check it before reading that code.

The full evidence and sources are in the [research report](../learning/sync-design-research.md#what-obsy-may-legally-reuse) and the [landscape notes](../learning/research-notes/obsidian-sync-landscape.md#2-what-can-be-read-reused-or-must-not-be-copied).

## History

- 2026-10-19: Adopted from the design research, with the MIT licence decision ([decision](../decisions/2026-10-19-licence.md)).
