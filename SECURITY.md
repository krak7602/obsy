# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting for security issues when it is available for this repository. Do not place credentials, bucket names, endpoints, device or relay tokens, pairing codes, note content, or exploit details in a public issue.

If private reporting is unavailable, open a public issue with only a redacted description and ask the maintainers for a private channel. Do not include a working exploit or sensitive value.

## Supported code

Security fixes target the current `main` branch. obsy has no released versions yet.

## Trust model

Version 1 is not end-to-end encrypted. Whoever controls the bucket can read the notes. Use a private bucket, credentials scoped to that bucket, and provider-side encryption at rest. See [Server-trusted version 1](docs/decisions/2026-10-19-server-trusted-v1.md).
