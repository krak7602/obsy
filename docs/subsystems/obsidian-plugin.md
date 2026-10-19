---
title: Obsidian plugin
aliases: [plugin, obsy plugin, iOS, mobile, desktop, pairing, Obsy - Sync Vaults]
updated: 2026-10-20
---

# Obsidian plugin

## Current

Status: accepted design, not yet implemented. Plugin ID: `obsy`. Display name: "Obsy - Sync Vaults" (see [Naming](../decisions/2026-10-19-naming.md)).

The plugin uses `@obsy/core` and `@obsy/storage-s3`, or the [relay](relay.md)'s device-token proxy. It owns the Obsidian-specific parts: scanning, applying remote changes safely, the mobile lifecycle, settings, and pairing.

### Lifecycle

Sync after `onLayoutReady`, on `visibilitychange` to visible, after saves (debounced 2 s after the last edit), and on a 30 s timer while visible. Pause on hidden. Never rely on `quit`. iOS gives plugins no background time.

### Change detection

Size and mtime only prove a file unchanged; anything else is hashed with `SubtleCrypto`. Vault events are hints; a periodic scan is the truth. `vault.adapter` covers the config folder, which emits no events.

### State

The three trees (remote, local, last synced, including base text for Markdown) and the operation journal live in IndexedDB keyed by vault ID, not in `data.json`.

### Applying remote changes

Open notes are merged against the editor buffer and applied with minimal editor transactions. Closed notes use `vault.process`. `vault.modify` is never used for remote changes. Downloads are written to a temporary path and renamed into place. obsy's own writes are suppressed from echoing back as edits.

### Deletes and safety rails

Deletes go to Obsidian's trash. Hard rails: abort and ask when a sync would delete more than 20% of files or 50 files, and when the vault folder looks empty or its vault-ID marker is missing.

### Config folder

Opt-in by category. `workspace*.json` and obsy's own data are always excluded.

### Large files

Mobile caps attachments (default 50 MB) and writes downloads in chunks.

### Credentials

Stored in Obsidian `SecretStorage` (1.11.4+) under a vault-unique name, never in `data.json`.

### Pairing

The first device creates the vault. Others join by scanning or typing a short pairing code that carries the bucket endpoint, prefix, and a scoped credential (or a relay token).

### Platform

Pure TypeScript, no Node APIs, no WASM, `isDesktopOnly: false`, `minAppVersion` 1.12.3. HTTP goes through `requestUrl` with a client-side timeout.

The platform evidence is in the [Obsidian platform research notes](../learning/research-notes/obsidian-platform.md).

### Build and distribution

Existing behavior: `packages/obsidian-plugin/` builds `dist/main.js` (CommonJS) with Rolldown. The plugin does nothing yet.

The community directory reads `manifest.json` from the root of the default branch, so `manifest.json` and `versions.json` stay at the repository root. A release is a GitHub release whose tag equals the manifest `version`, with `main.js`, `manifest.json`, and `styles.css` attached. Plain `x.y.z` tags therefore belong to the plugin; npm package releases need a different tag form, such as `@obsy/core@x.y.z`. Beta builds go out through BRAT from the same releases.

## History

- 2026-10-20: Plugin shell scaffolded; build and distribution rules recorded.
- 2026-10-19: Plugin design accepted, from the former `DESIGN.md`.
