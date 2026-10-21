---
title: Plugin release
aliases: [release, BRAT, beta release, GitHub release, release.sh, version bump]
updated: 2026-10-21
---

# Plugin release

## Current

This page owns how to make a plugin release and a BRAT beta. The rules for releases are on [Obsidian plugin](../subsystems/obsidian-plugin.md#build-and-distribution).

Status: the release script exists, and the repository is public on GitHub (remote `origin`). No release has been made. A release publishes code: make one only when the owner asks for it.

### What a release is

A GitHub release whose tag equals `version` in the root `manifest.json`, with `main.js`, `manifest.json`, and `styles.css` attached. BRAT installs a plugin from such a release. A beta is marked as a pre-release.

### Prepare

1. Set `version` in `manifest.json`, and add the version to `versions.json`, mapped to `minAppVersion`.
2. Commit.
3. Run `pnpm --filter @obsy/obsidian-plugin run release <version>`. The script checks the version and a clean working tree, runs `check`, `test`, and `build`, and collects the three files in `packages/obsidian-plugin/dist/release/` with their SHA-256. It does not publish.

### Publish

Only when the owner asks, and with a GitHub remote named `origin` and an authenticated `gh`:

```sh
pnpm --filter @obsy/obsidian-plugin run release <version> --publish
```

This tags the commit, pushes the tag, and creates a pre-release with the three files.

### Install with BRAT

On the device: install **BRAT** from the community plugins, then **BRAT → Add beta plugin** with the repository (`<owner>/<repo>`). BRAT downloads the release files into the vault's `.obsidian/plugins/obsy/`. Turn on **Obsy - Sync Vaults** in **Settings → Community plugins**. A private repository needs a GitHub token in BRAT.

## History

- 2026-10-21: The repository is on GitHub; still no release.

- 2026-10-21: Created with the release script; version 0.1.0 prepared, not released.
