---
title: CLI
aliases: [obsy command, obsy CLI, obsy.mjs, agent command line, obsy append, obsy proposals, obsy undo, obsy export, obsy verify]
updated: 2026-10-21
---

# CLI

## Current

This page owns how to build and run the `obsy` command. What each operation does is on [Agent SDK and CLI](../subsystems/agent-sdk.md).

Status: existing behavior. Package `@obsy/cli`; not published.

> [!warning] Scratch first
> Try the command on a scratch bucket prefix. The owner commands (`proposals accept`, `undo`) write commits that every device applies.

### Build

From the repository root:

```sh
pnpm --filter @obsy/cli run build    # writes packages/cli/dist/obsy.mjs
node packages/cli/dist/obsy.mjs --help
```

The file is self-contained and runs with Node 24. For a shorter name, add an alias, for example `alias obsy="node $PWD/packages/cli/dist/obsy.mjs"`.

### Configure

The bucket comes from environment variables, or from a file given with `--env-file` (variables already set win):

| Variable | Value |
| --- | --- |
| `OBSY_S3_ENDPOINT` | S3 endpoint without the bucket, as in the plugin |
| `OBSY_S3_REGION` | Signing region; default `auto` (R2) |
| `OBSY_S3_BUCKET` | Bucket name |
| `OBSY_S3_PREFIX` | The vault prefix, empty or ending in `/`, as in the plugin |
| `OBSY_S3_ACCESS_KEY_ID`, `OBSY_S3_SECRET_ACCESS_KEY` | The credential; optional `OBSY_S3_SESSION_TOKEN` |
| `OBSY_AGENT` | The agent's actor ID for agent commands (or `--agent`) |
| `OBSY_RUN`, `OBSY_TOOL_CALL` | Recorded in commits (or `--run`, `--tool-call`) |
| `OBSY_DEVICE` | The actor ID of owner commands (or `--device`); default `cli` |

Keep the file outside the repository or in an ignored file, with mode 600. Keys are never accepted as arguments.

### Commands

```sh
obsy status                                         # head, files, open proposals, recent edits
obsy ls notes/
obsy cat daily/2026-10-21.md
obsy history daily/2026-10-21.md --limit 20

obsy append daily/2026-10-21.md --section '## Log' -- '- 09:30 backup done'
printf -- '- line one\n- line two\n' | obsy append daily/2026-10-21.md --section Log
printf 'Sunny, 14 °C\n' | obsy block daily/2026-10-21.md weather --insert --section '## Weather'
obsy create inbox/idea.md --file idea.md
obsy replace notes/plan.md --base-rev 1234 --file plan.md  # only if still at rev 1234
obsy propose notes/plan.md --file plan.md --rationale 'Reorder the steps'

obsy proposals                                      # open proposals
obsy proposals show p_…                             # reason, rationale, and the diff
obsy proposals accept p_…
obsy proposals reject p_…
obsy undo 1234

obsy verify ~/scratch/copy-of-vault                 # compares; changes nothing
obsy export ~/backups/vault-2026-10-21 [--seq 1234] # into a new, empty folder
obsy init                                           # vault.json in an empty prefix
```

Put lines that start with `-` after `--`. Text content comes from `--file` or standard input.

- Agent writes accept `--presence wait|propose|ignore` (default `wait`) and `--max-wait <seconds>` (default 300).
- `block` returns the block hash; pass it as `--expect <hash>` next time to require that the block still holds the content the agent last wrote.
- `--json` prints the result object, for programs.
- `verify` refuses a folder that has symbolic links, as the plugin does.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Done. This includes `proposed`, `unchanged`, `exists`, and `skipped`; read the output or `--json` to tell them apart |
| 1 | Failed: an error, `verify` found differences, `proposals accept` hit a conflict, `undo` refused, or `replace` found the file `changed` |
| 2 | Bad arguments or configuration |

### Test

`pnpm test` runs the command in-process against an in-memory bucket (`packages/cli/src/cli.test.ts`). The [desktop plugin test](desktop-plugin-test.md) runs the built file against the local S3 server.

## History

- 2026-10-21: Created with the phase 4 command.
