---
title: No sync through symbolic links
aliases: [symlinks, symbolic links, soft links, linked folders, junctions]
updated: 2026-10-21
status: accepted
---

# No sync through symbolic links

## Context

The owner's vault had two symbolic links to folders outside it: the documentation folder of a code repository that coding agents edit, and an application's data folder. Obsidian on desktop follows such links and lists their files as vault files, so the plugin would sync them like any other file. Remote changes would then write through the link, into the repository and the application's folder, and a remote delete would trash files there. A copy of the vault keeps the links, so it would also point at folders that the old vault's sync service still syncs. obsy has no exclusion that is safe here: the engine reads a synced file that it cannot see as deleted, and writes to a path do not check an exclusion.

## Decision

obsy does not sync through symbolic links. On desktop the plugin looks for links in the vault folder before each sync. If it finds any, it stops before reading or sending anything and names them. `obsy verify` refuses such a folder too. For the move to obsy, the vault was copied without its two links.

## Consequences

- No obsy write ever lands outside the vault folder, and no folder is synced by obsy and another service through a link.
- A vault with links does not sync until they are removed or moved out. The user sees why in the status and in a notice.
- Content behind a link stays where it lives, for example in its repository. Showing it in Obsidian without syncing it needs a real exclusion in the engine (later work; it must define what happens to head files under an excluded path).

## Evidence

- [Obsidian help on symbolic links](https://obsidian.md/help/symlinks) advises against them, warns of data loss with any sync tool, and requires link targets to be disjoint from the vault and from each other.
- Desktop test step "Symbolic link" ([runbook](../runbooks/desktop-plugin-test.md)): the sync stopped and named the link; nothing from the linked folder reached the bucket.
