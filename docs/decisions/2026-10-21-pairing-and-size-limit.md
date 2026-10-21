---
title: Pairing codes and the download size limit
aliases: [pairing code, QR pairing, obsy1 code, maxFileSize, attachment cap, size limit]
updated: 2026-10-21
status: accepted
---

# Pairing codes and the download size limit

## Context

The accepted [plugin design](../subsystems/obsidian-plugin.md) said that devices join "by scanning or typing a short pairing code that carries the bucket endpoint, prefix, and a scoped credential", and that "mobile caps attachments (default 50 MB)". Building phase 3 raised two questions.

1. **How short can a pairing code be?** An S3 credential is two strings of about 32 and 64 characters. A code that carries one cannot be short. A short code needs a server that holds the credential for it, such as the [relay](../subsystems/relay.md), which does not exist. A credential scoped to the vault prefix needs the provider's account API (for R2, the Cloudflare API), which the plugin does not have.
2. **What does a cap mean for files a device already holds, and for its own files?** The first version left out both large head files and large local files. The simulator found a loss (seed 28784, about 1 in 245,000 seeds): a synced file that the phone renamed and enlarged in one step looked like a new large local file. The engine committed the delete of the old file and held back the new one, so the other devices lost the content.

## Decision

1. A pairing code carries the bucket settings, the same credential that the first device uses, and the vault ID, as `obsy1:` plus base64url JSON. The plugin shows it once, as a QR code of an `obsidian://obsy-pair` link and as text. It is not stored or logged. A joining device stores the credential under secret names of its own and joins only the vault that the code names.
2. The size limit applies only to **downloads of files the device does not hold yet** (`SyncEngineOptions.maxFileSize`). Files the device syncs, and its own files, sync at any size. A local file at the path of a left-out head file moves to a conflict copy name and is sent. Default: 50 MB on mobile, none on desktop.

## Consequences

- A pairing code is as sensitive as the credential. Anyone who sees the screen or the clipboard can use it. Every device of a vault has the same credential; revoking one device means a new credential for all of them.
- A per-device, prefix-scoped credential or a short code needs the relay or a provider API. Later work.
- A phone still reads, hashes, and uploads its own large files, and downloads updates to large files it already holds. Memory use for those files is not capped. The engine never deletes a file because of its size.
- `SyncReport.skipped` and **Verify** count the left-out files.

## Evidence

- Credential lengths: R2 access key IDs are 32 hexadecimal characters, and secret access keys are 64.
- [Mobile sync, phase 3](../learning/mobile-sync-phase3.md#findings): the seed 28784 loss, and the simulator and mutation results after the change.
- [iPhone probe](../learning/iphone-probe.md#results): reading and hashing 16 to 50 MiB on an iPhone worked without memory errors, so reading a phone's own large files is not the main memory risk.
