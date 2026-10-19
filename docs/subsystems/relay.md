---
title: Relay (optional)
aliases: [obsy/relay, Cloudflare relay, Durable Object, push, device tokens, presence, WebSocket]
updated: 2026-10-19
---

# Relay (optional)

## Current

Status: accepted design, optional, not yet implemented. Package: `@obsy/relay`. Planned for phase 6 of the [roadmap](../roadmap.md).

The relay is a Cloudflare Worker with one Durable Object per vault. It speaks the same [bucket protocol](protocol.md); it is never the source of truth.

- **Push:** devices hold a hibernating WebSocket. When a commit passes through the relay (or the relay sees a new log entry), it sends `{ "type": "changed", "seq": N }`. Clients then read the log as usual. A lost push costs nothing.
- **Device tokens:** devices authenticate to the relay with revocable per-device tokens, so they need no bucket credentials. The relay proxies storage operations to its R2 binding.
- **Presence and deferral** become instant instead of heartbeat-based.
- **Agents in the same account** can use a service binding to the relay or the R2 binding directly.

A relay deploy disconnects sockets; clients reconnect and catch up from their cursor. Keep the relay in its own Worker, so deploys of other Workers on the account do not drop device sockets.

The Cloudflare limits, prices, and cost estimate are in the [Cloudflare research notes](../learning/research-notes/cloudflare-building-blocks.md).

## History

- 2026-10-19: The research proposed a Durable Object as the only version authority. The accepted design made it an optional relay ([decision](../decisions/2026-10-19-bucket-as-sequencer.md)).
