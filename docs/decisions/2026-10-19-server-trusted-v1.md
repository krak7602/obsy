---
title: Server-trusted version 1
aliases: [no E2EE, end-to-end encryption, encryption, trust model]
updated: 2026-10-19
status: accepted
---

# Server-trusted version 1

## Context

obsy lets a server-side AI agent read and edit notes. End-to-end encryption and a server-side agent that reads notes cannot both hold for the same content: if the server holds a key that can decrypt notes, the system is not end-to-end encrypted. E2EE would also stop server-side merging and plaintext-hash deduplication.

The options were: no E2EE; an agent-held key labelled as server-trusted; per-folder E2EE that the agent cannot read; or agent-to-client sealed proposals that let the agent write without reading.

## Decision

Version 1 is server-trusted and says so plainly. Content is readable by whoever controls the bucket. Users protect it with a private bucket, credentials scoped to that bucket, and provider-side encryption at rest.

Optional encrypted folders are later work. Content and paths in those folders are encrypted on devices; agents cannot read them and can only submit sealed proposals. Hashes there use a keyed HMAC.

The current trust model is on [Architecture](../architecture.md#security-and-trust).

## Consequences

- Documentation and the plugin must not claim end-to-end encryption.
- The protocol must leave room for encrypted folders: encrypted paths and keyed hashes.
- The plugin sends no telemetry and contacts only the configured bucket or relay.

## Evidence

- "Is not end-to-end encrypted any more" when the server holds a decryption key ([Calmara](https://calmara.app/blog/why-ai-note-apps-arent-end-to-end-encrypted)). Obsidian Sync's "Standard" mode is the same trade-off.
- Full discussion: [research report](../learning/sync-design-research.md#encryption-with-a-server-side-agent) and [protocol notes](../learning/research-notes/protocol-design.md#7-end-to-end-encryption-and-the-server-side-agent-trade-off).
