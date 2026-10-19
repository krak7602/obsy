---
title: Supported storage providers
aliases: [providers, R2, S3, S3-compatible]
updated: 2026-10-19
status: accepted
---

# Supported storage providers

## Context

The [bucket-sequenced protocol](2026-10-19-bucket-as-sequencer.md) is only safe if the provider's conditional creates are atomic and its reads and lists are strongly consistent. Other S3-compatible services have not been checked for these guarantees.

## Decision

Version 1 supports Cloudflare R2 (S3 API and Workers binding) and AWS S3 only. Other S3-compatible services are not offered until they pass the conformance suite.

The requirements and the suite are on [Storage adapters](../subsystems/storage.md).

## Consequences

- Adding a provider needs an adapter, if the S3 adapter does not fit, and a passing conformance run recorded as evidence.

## Evidence

- [R2 consistency](https://developers.cloudflare.com/r2/reference/consistency/); AWS added conditional writes in 2024. See the [Cloudflare notes](../learning/research-notes/cloudflare-building-blocks.md#3-r2-conditional-writes-consistency-multipart-metadata-versioning-presigned-urls-s3-compatibility-pricing-events).
