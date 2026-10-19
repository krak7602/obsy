---
title: Storage adapters
aliases: [Storage interface, storage-s3, storage-r2, conformance suite, providers, S3, R2]
updated: 2026-10-19
---

# Storage adapters

## Current

Status: accepted design, not yet implemented.

### Interface

Every layer above storage talks only to this interface:

```ts
interface Storage {
  get(key: string): Promise<{ body: Uint8Array; etag: string } | null>;
  /** Fails with PreconditionFailed when the key already exists. */
  putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<{ etag: string }>;
  /** Fails with PreconditionFailed unless the current etag matches. */
  putIfMatch(key: string, body: Uint8Array, etag: string, contentType: string): Promise<{ etag: string }>;
  list(prefix: string, startAfter?: string, limit?: number): Promise<{ keys: string[]; truncated: boolean }>;
  delete(key: string): Promise<void>;
}
```

### Adapters

| Package | Transport | Runs in |
| --- | --- | --- |
| `@obsy/storage-s3` | S3 API with SigV4 signing (`aws4fetch`). `fetch` is injectable, so the Obsidian plugin can pass a `requestUrl`-based transport. | Obsidian, Node, Workers |
| `@obsy/storage-r2` | Native R2 binding | Cloudflare Workers |

### Provider requirements

The [protocol](protocol.md) uses the bucket as the commit sequencer. The conformance suite checks these requirements before a vault is used:

- `If-None-Match: *` on PUT is atomic: of concurrent creators of one key, at most one succeeds.
- Strong read-after-write and list-after-write consistency.
- `If-Match` on PUT for the few mutable objects.

Cloudflare R2 and AWS S3 meet these ([R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/); AWS added conditional writes in 2024). They are the only supported providers in version 1. See [Supported storage providers](../decisions/2026-10-19-supported-storage-providers.md).

### Conformance suite

The suite tests conditional-create races, `If-Match`, list ordering, and read-after-write. Run it against every provider before the provider is listed as supported. See [Correctness and testing](../concepts/correctness-and-testing.md).

## History

- 2026-10-19: Interface and provider requirements accepted, from the former `DESIGN.md`.
