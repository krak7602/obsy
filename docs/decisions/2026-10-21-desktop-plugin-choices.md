---
title: Desktop plugin choices
aliases: [minAppVersion 1.13.2, trashFile, deletion preference, pause when hidden, rail minimum, declarative settings]
updated: 2026-10-21
status: accepted
---

# Desktop plugin choices

## Context

Building the desktop plugin in phase 2 met four points where the accepted [plugin design](../subsystems/obsidian-plugin.md) and the platform did not fit:

1. The design set `minAppVersion` 1.12.3. The Obsidian review rules (`eslint-plugin-obsidianmd` 0.4.2) warn about every settings tab without `getSettingDefinitions()`, and mark `display()` as deprecated since 1.13.0. Warnings fail `pnpm run check`.
2. The design said that deletes go to Obsidian's trash (`vault.trash(file, false)`, the vault's `.trash` folder). The review rules require `fileManager.trashFile`, which follows the user's setting for deleted files, and forbid turning the rule off.
3. The design said to pause sync when the app is hidden. In the desktop test, a sync after an edit sometimes did not run for 20 s: macOS reports an Obsidian window that other windows cover as hidden.
4. The design said to stop and ask when a sync would delete more than 20% of the files or more than 50 files. Taken alone, the 20% rule stops a vault of five notes when the user deletes two.

## Decision

1. `minAppVersion` is **1.13.2**, and the settings tab uses the declarative settings API with its secret control, as the platform probe already does.
2. Deletes use **`fileManager.trashFile`**. The engine removes a local file only when its content equals the synced version, so the bucket history holds that content whatever the user's setting is.
3. Sync pauses while hidden **only on mobile**. Desktop keeps its triggers and its 30 s timer when the window is hidden.
4. The 20% rule applies **from 10 deletes**; the 50-file rule applies always. The thresholds are `RAILS` in `packages/obsidian-plugin/src/sync/service.ts`.

## Consequences

- Obsidian versions 1.12.3 to 1.13.1 cannot install the plugin. On 2026-10-21 the current version is 1.14.x, and the iPhone probe ran on 1.14.5.
- A user whose setting is "permanently delete" gets permanent deletes from sync too. Recovery then goes through bucket history; a restore tool is accepted design, not implemented yet. A user save that lands while Obsidian deletes the file is lost from the device in that case; with a trash setting it stays in the trash.
- A desktop Obsidian in the background keeps polling the bucket every 30 s, one list request each time.
- Deleting up to nine files never stops a sync, even when they are most of a small vault.

## Evidence

- Review rule output of 2026-10-21: `prefer-setting-definitions`, `no-deprecated` for `display`, `prefer-file-manager-trash-file`, and `no-restricted-disable` for a disable comment on it.
- [Desktop plugin, phase 2](../learning/desktop-plugin-phase2.md#findings): the automatic-sync step failed in two of three runs before the change, and passed in all 17 runs after it.
- [iPhone probe](../learning/iphone-probe.md#background-behavior): iOS stops plugins about 4 s after the app is hidden, which is why mobile still pauses.
