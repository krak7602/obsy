---
title: Retention defaults
aliases: [retention, retentionDays, tombstones, gc, soft-delete delay, maximum offline period]
updated: 2026-10-19
status: accepted
---

# Retention defaults

## Context

History, tombstones, and the maximum offline period must be consistent with each other. Every device and every GC run must agree on them. R2 has no object versioning, so a GC bug can destroy history.

## Decision

Retention is a vault setting in `vault.json`. Defaults: log and tombstones 180 days; blob soft-delete delay 30 days. Change it with `obsy config set retentionDays <n>`. Only an explicit `obsy gc` run deletes history, never the plugin.

Reducing retention is safe: the next `obsy gc` removes older history, and a device offline longer than the window reconciles from the newest checkpoint by hash.

The current behaviour is on the [protocol page](../subsystems/protocol.md#checkpoints-and-compaction).

## Consequences

- A device offline longer than the retention window treats files whose hashes match tombstones as already deleted rather than new.
- GC must respect the soft-delete delay, and independent exports remain the last line of defence.

## Evidence

- GC that destroys history is the top risk in the [research](../learning/sync-design-research.md#open-questions-and-risks).
