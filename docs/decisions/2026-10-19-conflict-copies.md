---
title: Conflict copies by default
aliases: [conflict form, conflict markers, diff3 markers]
updated: 2026-10-19
status: accepted
---

# Conflict copies by default

## Context

When a merge is not clean, obsy can keep the conflict in the note with diff3 markers, or keep the current version at the path and write the other side as a separate file. The research left this open.

## Decision

Conflict copies are the default. The note at the path is never left with markers. The other side is written as `Name (conflict <device> <YYYYMMDDHHmm>).md`, with a conflict record the plugin can show as a diff. In-file markers may become an opt-in setting later.

The current rules are on [Merge and conflicts](../subsystems/merge.md).

## Consequences

- Notes stay valid Markdown and valid YAML at all times.
- The plugin needs a conflict UI to show and resolve copies (phase 5 on the [roadmap](../roadmap.md)).

## Evidence

- Obsidian 1.9.7 added a "Create conflict file" option; Syncthing uses sibling conflict copies ([merge notes](../learning/research-notes/merge-algorithms.md#5-hybrid-designs-and-who-uses-what)).
