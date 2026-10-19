---
title: The bucket is the sequencer
aliases: [no server, conditional creates, replaces Durable Object authority, serverless commit log]
updated: 2026-10-19
status: accepted
---

# The bucket is the sequencer

## Context

The [design research](../learning/sync-design-research.md) recommended one SQLite-backed Cloudflare Durable Object per vault as the only version authority, with blobs in R2. That design requires a running server and ties every user to Cloudflare Workers. A goal of obsy is to work with storage the user owns and to be easy for others to adopt.

Object storage with atomic conditional creates can order writes without a server. Delta Lake and Apache Iceberg commit to object storage this way.

## Decision

Commits are ordered by conditional creates in the bucket itself. Each writer claims `log/<cursor+1>.json` with `If-None-Match: *`. Exactly one writer succeeds; the others catch up, rebase, and retry. No server is required.

The Durable Object from the research becomes an optional [relay](../subsystems/relay.md) for push, device tokens, and presence. It speaks the same protocol and is never the source of truth.

The current contract is on the [protocol page](../subsystems/protocol.md).

## Consequences

- Any provider with atomic conditional creates, strong read-after-write and list-after-write consistency, and `If-Match` can host a vault. A conformance suite must prove this per provider ([Supported storage providers](2026-10-19-supported-storage-providers.md)).
- Change detection is polling by default: one list request per poll. Push needs the optional relay.
- Merges run on clients, not on a server. `@obsy/core` and `@obsy/merge` must run everywhere, with no Node or DOM dependencies.
- Devices need bucket credentials scoped to the bucket, unless they use the relay's device tokens.
- The research's merge, conflict, platform, agent, and security findings still apply.
- The open question about storing small revisions in Durable Object SQLite no longer applies.

## Evidence

- R2 documentation, read on 2026-10-19: with `If-None-Match: *` on an absent key, "at most one request succeeds and every other request fails with a `412 PreconditionFailed`"; S3 API conditional headers are "evaluated atomically" ([R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/); [R2 S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/)). Details are in the [Cloudflare notes](../learning/research-notes/cloudflare-building-blocks.md#3-r2-conditional-writes-consistency-multipart-metadata-versioning-presigned-urls-s3-compatibility-pricing-events).
- AWS S3 added conditional writes in 2024.
- Not yet verified locally: a real conditional-create race test on R2. This is a phase 0 spike on the [roadmap](../roadmap.md).
