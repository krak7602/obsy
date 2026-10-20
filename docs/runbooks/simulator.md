---
title: Simulator
aliases: [deterministic simulation, sim, seeds, 1M seeds, invariants check, simulate, cli.mjs]
updated: 2026-10-20
---

# Simulator

## Current

This page owns how to run the deterministic simulator of the sync engine and how to replay a failing seed. The invariants it checks are on [Correctness and testing](../concepts/correctness-and-testing.md). Results are on [Simulator, phase 1](../learning/simulator-phase1.md).

Status: existing behavior. Package `@obsy/simulator` (test only, Node).

### What one seed does

A seed drives everything: the order of every bucket request and local file call, user actions, faults, and IDs. The same seed always gives the same run.

- **Actors:** two devices (`mac`, `phone`) with their own files and saved state, and an agent that appends lines to the daily note. All share one in-memory bucket.
- **Users** create, edit, rename, and remove files from a small set of paths that includes case twins (`a.md`, `A.md`), normalisation twins (`café.md` in NFC and NFD), folders, and a non-text file type (`img.png`). Every line a user types is a unique token.
- **Steps** (600 by default): run one waiting request or file call, a user action, start a sync, start an agent write, crash a device mid-sync, take a device offline or online, land a delayed write, or advance the clock.
- **Faults** (default): 3% of requests fail before they reach the bucket; 3% of writes apply and lose their response; 2% of writes fail now and land later. A device that crashes with a write in flight lands it half of the time.
- **Quiet phase:** faults off, delayed writes land, devices online, then syncs until nothing changes. Then the invariants are checked.

### Invariants checked

1. The log has no gap, every commit keeps the [commit rules](../subsystems/protocol.md#commit-rules), and every blob exists and matches its hash.
2. Every `opId` appears once (replaying a journal never commits twice).
3. Every agent commit keeps the head content and only appends (no agent commit without a matching base).
4. Devices converge: each device holds exactly the head files, path for path and byte for byte.
5. No silent loss: every token that no user removed is in a live file at the end, at its path or in a conflict copy.
6. Every sync in the quiet phase settles.

### Run

From the repository root:

| Command | Does |
| --- | --- |
| `pnpm test` | 200 seeds without faults and 200 with faults (`packages/simulator/src/sim.test.ts`) |
| `OBSY_SIM_SEEDS=5000 pnpm exec vp test packages/simulator` | More seeds in the test run |
| `OBSY_SIM_SEED=1234 pnpm exec vp test packages/simulator --silent=false` | Replay one seed and print its trace on failure |
| `pnpm --filter @obsy/simulator run build` | Bundle the runner to `packages/simulator/dist/cli.mjs` |
| `node packages/simulator/dist/cli.mjs --seeds 1000000` | Run seeds 1 to 1,000,000 on all CPU cores |
| `node packages/simulator/dist/cli.mjs --seed 1234 --trace` | Run one seed and print its trace |

Options: `--start <n>` (first seed, default 1), `--workers <n>` (default: CPU count), `--steps <n>` (default 600). The runner prints progress every 10 s, then totals and the first 20 failing seeds, and exits with code 1 if any seed failed. Rebuild after changing `@obsy/core`, `@obsy/protocol`, `@obsy/merge`, or the simulator.

### Check that the checker works

After a change to the simulator, plant a bug and confirm that seeds fail. Examples that must fail: skip writing the conflict copy in `#mergeContent`; let a remote delete remove a locally edited file; treat a lost claim as won in `RemoteVault.claim`; write the head content instead of the merge result.

## History

- 2026-10-20: Created with the phase 1 simulator.
