import { parseArgs, parseEnv } from 'node:util';

import {
  VaultAdmin,
  VaultAgent,
  lineDiff,
  type PresenceMode,
  type Revision,
  type WriteResult,
} from '@obsy/agent';
import { RemoteVault, initVault, verifyLocal, webEnvironment, type Environment } from '@obsy/core';
import { decodeUtf8Strict, isActorId, type Commit, type Storage } from '@obsy/protocol';
import { S3Storage } from '@obsy/storage-s3';

import { FolderFiles, prepareEmptyFolder, writeUnder } from './files';

/** What the CLI reads and writes. `bin.ts` connects it to the process; tests replace it. */
export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  stdout(text: string): void;
  stderr(text: string): void;
  /** Raw bytes to standard output, for `cat`. */
  stdoutBytes(bytes: Uint8Array): void;
  /** Standard input, read to the end. */
  stdin(): Promise<Uint8Array>;
  readFile(path: string): Promise<Uint8Array>;
  /** The bucket client. Default: S3 from the configuration. */
  storage?(config: BucketConfig): Storage;
  readonly environment?: Environment;
}

export interface BucketConfig {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly prefix: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
}

export const USAGE = `Usage: obsy <command> [options]

Agent commands (they need an agent ID: --agent or OBSY_AGENT):
  ls [prefix]                          List live files
  cat <path>                           Print a file
  history <path> [--limit n]           Revisions of a file, newest first
  create <path> [--file f]             Create a file unless the path is taken (content from stdin)
  append <path> [-- line...]           Append lines (or stdin) at the end of a section
      [--section heading]...           Heading path, for example --section "## Log"
      [--if-missing create|propose|skip]
  block <path> <id> [--file f]         Replace the agent's block (content from stdin)
      [--insert] [--section heading]... Insert the block if it is missing
      [--expect hash]                  Require the content the agent last wrote
  propose <path> [--file f]            Propose new content for a file (from stdin)
      [--base-rev n] [--rationale text]

Owner commands (actor: --device or OBSY_DEVICE, default "cli"):
  status                               The vault, the head, open proposals, presence
  proposals [list]                     Open proposals
  proposals show <id>                  A proposal and its changes
  proposals accept <id>                Apply it, merged with later edits
  proposals reject <id>
  undo <seq>                           Reverse a commit with a new commit
  verify <folder> [--max-file-size MB] Compare a folder with the head; changes nothing
  export <folder> [--seq n]            Write the files at a seq into a new, empty folder
  init                                 Create vault.json in an empty prefix

Options for agent writes:
  --presence wait|propose|ignore       When a device edits the note (default wait)
  --max-wait seconds                   Longest wait in wait mode (default 300)
  --run id, --tool-call id             Recorded in the commit
  --rationale text                     Stored with a proposal
Common options:
  --json                               Print results as JSON
  --                                   Ends the options: put lines that start with - after it
  --env-file path                      Read OBSY_* variables from a file
  -h, --help

The bucket comes from OBSY_S3_ENDPOINT, OBSY_S3_REGION (default auto),
OBSY_S3_BUCKET, OBSY_S3_PREFIX, OBSY_S3_ACCESS_KEY_ID, and
OBSY_S3_SECRET_ACCESS_KEY (optional OBSY_S3_SESSION_TOKEN). Keys are read only
from the environment or --env-file, never from arguments.
`;

/** Bad arguments or configuration. Exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

const OPTIONS = {
  agent: { type: 'string' },
  device: { type: 'string' },
  run: { type: 'string' },
  'tool-call': { type: 'string' },
  rationale: { type: 'string' },
  presence: { type: 'string' },
  'max-wait': { type: 'string' },
  section: { type: 'string', multiple: true },
  'if-missing': { type: 'string' },
  insert: { type: 'boolean' },
  expect: { type: 'string' },
  file: { type: 'string' },
  'base-rev': { type: 'string' },
  limit: { type: 'string' },
  'max-file-size': { type: 'string' },
  seq: { type: 'string' },
  json: { type: 'boolean' },
  'env-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values'];

/** Runs one command. Returns the exit code: 0 done, 1 failed, 2 bad usage. */
export async function main(argv: readonly string[], io: CliIo): Promise<number> {
  let values: Values;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
    }));
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const [command, ...args] = positionals;
  if (values.help === true || command === undefined || command === 'help') {
    io.stdout(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }
  try {
    const env = await loadEnv(io, values['env-file']);
    const ctx = new Context(io, env, values);
    return await run(ctx, command, args);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`obsy: ${error.message}\n`);
      return 2;
    }
    io.stderr(
      `obsy: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`,
    );
    return 1;
  }
}

async function loadEnv(
  io: CliIo,
  file: string | undefined,
): Promise<Readonly<Record<string, string | undefined>>> {
  if (file === undefined) return io.env;
  const parsed = parseEnv(decodeUtf8Strict(await io.readFile(file)));
  // Variables already set win over the file.
  return {
    ...parsed,
    ...Object.fromEntries(Object.entries(io.env).filter(([, v]) => v !== undefined)),
  };
}

class Context {
  #storage: Storage | null = null;

  constructor(
    readonly io: CliIo,
    readonly env: Readonly<Record<string, string | undefined>>,
    readonly values: Values,
  ) {}

  get json(): boolean {
    return this.values.json === true;
  }

  get environment(): Environment {
    return this.io.environment ?? webEnvironment();
  }

  storage(): Storage {
    if (this.#storage !== null) return this.#storage;
    const config = bucketConfig(this.env);
    this.#storage = this.io.storage?.(config) ?? new S3Storage(config);
    return this.#storage;
  }

  agent(): VaultAgent {
    const id = this.values.agent ?? this.env['OBSY_AGENT'];
    if (id === undefined) throw new UsageError('Set the agent ID with --agent or OBSY_AGENT.');
    if (!isActorId(id)) throw new UsageError(`Not an actor ID: ${JSON.stringify(id)}`);
    const run = this.values.run ?? this.env['OBSY_RUN'];
    const mode = this.values.presence ?? 'wait';
    if (mode !== 'wait' && mode !== 'propose' && mode !== 'ignore')
      throw new UsageError('--presence must be wait, propose, or ignore.');
    const maxWait = this.number('max-wait', 300);
    return new VaultAgent({
      storage: this.storage(),
      env: this.environment,
      actor: run === undefined ? { id } : { id, run },
      presence: { mode: mode as PresenceMode, maxWaitMs: maxWait * 1000 },
    });
  }

  /** Read commands work with any agent ID; without one they read as `cli`. */
  agentOrReader(): VaultAgent {
    const id = this.values.agent ?? this.env['OBSY_AGENT'] ?? 'cli';
    if (!isActorId(id)) throw new UsageError(`Not an actor ID: ${JSON.stringify(id)}`);
    return new VaultAgent({ storage: this.storage(), env: this.environment, actor: { id } });
  }

  admin(): VaultAdmin {
    const id = this.values.device ?? this.env['OBSY_DEVICE'] ?? 'cli';
    if (!isActorId(id)) throw new UsageError(`Not an actor ID: ${JSON.stringify(id)}`);
    return new VaultAdmin({
      storage: this.storage(),
      env: this.environment,
      actor: { kind: 'device', id },
    });
  }

  writeOptions(): { toolCall?: string; rationale?: string } {
    const toolCall = this.values['tool-call'] ?? this.env['OBSY_TOOL_CALL'];
    const rationale = this.values.rationale;
    return {
      ...(toolCall === undefined ? {} : { toolCall }),
      ...(rationale === undefined ? {} : { rationale }),
    };
  }

  number(
    name: 'max-wait' | 'base-rev' | 'limit' | 'max-file-size' | 'seq',
    fallback: number,
  ): number;
  number(name: 'max-wait' | 'base-rev' | 'limit' | 'max-file-size' | 'seq'): number | undefined;
  number(
    name: 'max-wait' | 'base-rev' | 'limit' | 'max-file-size' | 'seq',
    fallback?: number,
  ): number | undefined {
    const raw = this.values[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${name} must be a number.`);
    return value;
  }

  /** Content from --file, or standard input. */
  async content(): Promise<Uint8Array> {
    const file = this.values.file;
    return file === undefined ? this.io.stdin() : this.io.readFile(file);
  }

  async text(): Promise<string> {
    try {
      return decodeUtf8Strict(await this.content());
    } catch {
      throw new UsageError('The content is not UTF-8 text.');
    }
  }

  print(json: unknown, text: string): void {
    this.io.stdout(this.json ? `${JSON.stringify(json, null, 2)}\n` : text);
  }
}

export function bucketConfig(env: Readonly<Record<string, string | undefined>>): BucketConfig {
  const names = [
    'OBSY_S3_ENDPOINT',
    'OBSY_S3_BUCKET',
    'OBSY_S3_ACCESS_KEY_ID',
    'OBSY_S3_SECRET_ACCESS_KEY',
  ] as const;
  const missing = names.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) throw new UsageError(`Set ${missing.join(', ')}.`);
  const prefix = env['OBSY_S3_PREFIX'] ?? '';
  if (prefix !== '' && !prefix.endsWith('/'))
    throw new UsageError('OBSY_S3_PREFIX must be empty or end with "/".');
  const sessionToken = env['OBSY_S3_SESSION_TOKEN'];
  return {
    endpoint: env['OBSY_S3_ENDPOINT'] as string,
    region: env['OBSY_S3_REGION'] ?? 'auto',
    bucket: env['OBSY_S3_BUCKET'] as string,
    prefix,
    accessKeyId: env['OBSY_S3_ACCESS_KEY_ID'] as string,
    secretAccessKey: env['OBSY_S3_SECRET_ACCESS_KEY'] as string,
    ...(sessionToken === undefined || sessionToken === '' ? {} : { sessionToken }),
  };
}

function need(args: readonly string[], count: number, usage: string): string[] {
  if (args.length < count) throw new UsageError(`Usage: obsy ${usage}`);
  return args.slice(0, count);
}

async function run(ctx: Context, command: string, args: readonly string[]): Promise<number> {
  switch (command) {
    case 'ls': {
      const files = await ctx.agentOrReader().list(args[0] ?? '');
      ctx.print(files, files.map((f) => `${f.path}\t${f.size}\trev ${f.rev}\n`).join(''));
      return 0;
    }
    case 'cat': {
      const [path] = need(args, 1, 'cat <path>');
      const file = await ctx.agentOrReader().read(path as string);
      if (file === null) {
        ctx.io.stderr(`obsy: no file at ${path as string}\n`);
        return 1;
      }
      if (ctx.json) ctx.print(file, '');
      else ctx.io.stdoutBytes(await ctx.agentOrReader().reader.bytes(file.hash));
      return 0;
    }
    case 'history': {
      const [path] = need(args, 1, 'history <path> [--limit n]');
      const revisions = await ctx.agentOrReader().history(path as string, ctx.number('limit', 50));
      ctx.print(revisions, revisions.map(formatRevision).join(''));
      return 0;
    }
    case 'create': {
      const [path] = need(args, 1, 'create <path> [--file f]');
      const result = await ctx
        .agent()
        .createIfAbsent(path as string, await ctx.content(), ctx.writeOptions());
      return report(ctx, result);
    }
    case 'append': {
      const [path, ...lines] = need(args, 1, 'append <path> [line...]').concat(args.slice(1));
      const added = lines.length > 0 ? lines : splitInput(await ctx.text());
      const ifMissing = ctx.values['if-missing'] ?? 'create';
      if (ifMissing !== 'create' && ifMissing !== 'propose' && ifMissing !== 'skip')
        throw new UsageError('--if-missing must be create, propose, or skip.');
      const result = await ctx
        .agent()
        .appendToSection(path as string, ctx.values.section ?? [], added, {
          ...ctx.writeOptions(),
          ifMissing,
        });
      return report(ctx, result);
    }
    case 'block': {
      const [path, id] = need(args, 2, 'block <path> <id> [--file f]');
      const expectedHash = ctx.values.expect;
      const section = ctx.values.section;
      if (section !== undefined && ctx.values.insert !== true)
        throw new UsageError('--section needs --insert.');
      const result = await ctx
        .agent()
        .replaceBlock(path as string, id as string, await ctx.text(), {
          ...ctx.writeOptions(),
          ...(expectedHash === undefined ? {} : { expectedHash }),
          ...(ctx.values.insert === true
            ? { insert: section === undefined ? {} : { section } }
            : {}),
        });
      return report(ctx, result);
    }
    case 'propose': {
      const [path] = need(args, 1, 'propose <path> [--file f]');
      const baseRev = ctx.number('base-rev');
      const result = await ctx.agent().proposePatch(path as string, await ctx.text(), {
        ...ctx.writeOptions(),
        ...(baseRev === undefined ? {} : { baseRev }),
      });
      return report(ctx, result);
    }
    case 'status':
      return status(ctx);
    case 'proposals':
      return proposals(ctx, args);
    case 'undo': {
      const [raw] = need(args, 1, 'undo <seq>');
      const seq = Number(raw);
      if (!Number.isSafeInteger(seq) || seq < 1) throw new UsageError('undo needs a commit seq.');
      const result = await ctx.admin().undo(seq);
      const text =
        result.status === 'committed'
          ? `undone: commit ${seq} reversed by commit ${result.seq} (${result.files} files)\n`
          : result.status === 'unchanged'
            ? `unchanged: commit ${seq} is already undone\n`
            : `refused: nothing written\n${result.problems.map((p) => `  ${p.path}: ${p.reason}\n`).join('')}`;
      ctx.print(result, text);
      return result.status === 'refused' ? 1 : 0;
    }
    case 'verify': {
      const [folder] = need(args, 1, 'verify <folder>');
      const mb = ctx.number('max-file-size');
      const report = await verifyLocal(
        ctx.storage(),
        ctx.environment,
        new FolderFiles(folder as string),
        mb === undefined ? {} : { maxFileSize: mb * 1_000_000 },
      );
      ctx.print(
        report,
        `head seq ${report.seq}: ${report.headFiles} files; folder: ${report.localFiles} files` +
          (report.skipped > 0 ? `; ${report.skipped} over the size limit` : '') +
          `\n${report.problems.length === 0 ? 'no differences\n' : report.problems.map((p) => `  ${p.problem}\t${p.path}\n`).join('')}`,
      );
      return report.problems.length === 0 ? 0 : 1;
    }
    case 'export':
      return exportFolder(ctx, args);
    case 'init': {
      const storage = ctx.storage();
      const existing = await new RemoteVault(storage, ctx.environment).getVault();
      const vault = existing ?? (await initVault(storage, ctx.environment));
      ctx.print(
        vault,
        existing === null
          ? `created vault ${vault.vaultId}\n`
          : `the prefix already has vault ${vault.vaultId}\n`,
      );
      return 0;
    }
    default:
      throw new UsageError(`Unknown command ${JSON.stringify(command)}. Run obsy --help.`);
  }
}

function splitInput(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new UsageError('No lines to append.');
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

function report(ctx: Context, result: WriteResult): number {
  let text: string;
  switch (result.status) {
    case 'committed':
      text = `committed: ${result.path} at seq ${result.seq}${result.blockHash === undefined ? '' : ` (block hash ${result.blockHash})`}\n`;
      break;
    case 'unchanged':
      text = `unchanged: ${result.path}${result.blockHash === undefined ? '' : ` (block hash ${result.blockHash})`}\n`;
      break;
    case 'exists':
      text = `exists: ${result.path} (rev ${result.rev})\n`;
      break;
    case 'proposed':
      text = `proposed: ${result.proposalId} (${result.reason})\n`;
      break;
    case 'skipped':
      text = `skipped: ${result.reason}\n`;
      break;
  }
  ctx.print(result, text);
  return 0;
}

function formatRevision(r: Revision): string {
  const who = `${r.actor.kind} ${r.actor.id}${r.actor.kind === 'agent' && r.actor.run !== undefined ? ` run ${r.actor.run}` : ''}`;
  return `${r.rev}\t${r.time}\t${who}\t${r.type}\t${r.path}${r.deleted ? '' : `\t${r.size} bytes`}\n`;
}

function formatCommit(c: Commit): string {
  const ops = c.ops.map(
    (op) => `${op.type} ${op.type === 'move' ? `${op.from} -> ${op.to}` : op.path}`,
  );
  const shown = ops.slice(0, 3).join(', ') + (ops.length > 3 ? `, and ${ops.length - 3} more` : '');
  return `  ${c.seq}\t${c.time}\t${c.actor.kind} ${c.actor.id}\t${shown}\n`;
}

async function status(ctx: Context): Promise<number> {
  const s = await ctx.admin().status();
  const now = ctx.environment.now().getTime();
  const presence = s.presence
    .filter((p) => p.path !== null)
    .map(
      (p) =>
        `  ${p.device} on ${p.path as string}, ${Math.round((now - Date.parse(p.time)) / 1000)} s ago\n`,
    )
    .join('');
  ctx.print(
    s,
    `vault ${s.vault.vaultId}, epoch ${s.vault.epoch}\n` +
      `head seq ${s.seq}: ${s.files} files, ${s.bytes} bytes\n` +
      `open proposals: ${s.openProposals}\n` +
      (presence === '' ? '' : `last edits:\n${presence}`) +
      (s.recent.length === 0 ? '' : `recent commits:\n${s.recent.map(formatCommit).join('')}`),
  );
  return 0;
}

async function proposals(ctx: Context, args: readonly string[]): Promise<number> {
  const [sub = 'list', id] = args;
  const admin = ctx.admin();
  switch (sub) {
    case 'list': {
      const open = await admin.openProposals();
      ctx.print(
        open,
        open.length === 0
          ? 'no open proposals\n'
          : open
              .map(
                (p) =>
                  `${p.id}\t${p.createdAt}\t${p.actor.id}\t${p.operation}\t${p.reason}\t${p.path}${p.rationale === '' ? '' : `\n    ${p.rationale}`}\n`,
              )
              .join(''),
      );
      return 0;
    }
    case 'show': {
      if (id === undefined) throw new UsageError('Usage: obsy proposals show <id>');
      const detail = await admin.proposal(id);
      if (detail === null) {
        ctx.io.stderr(`obsy: no proposal ${id}\n`);
        return 1;
      }
      const p = detail.proposal;
      const header =
        `${p.id}: ${p.operation} on ${p.path}, by ${p.actor.id}, ${p.createdAt}\n` +
        `reason: ${p.reason}${p.rationale === '' ? '' : `\nrationale: ${p.rationale}`}\n` +
        (detail.resolution === null
          ? 'open\n'
          : `${detail.resolution.outcome} by ${detail.resolution.actor.id}\n`) +
        (p.baseRev !== null && detail.head !== null && detail.head.rev !== p.baseRev
          ? `the file changed since rev ${p.baseRev}; accepting merges the changes\n`
          : '');
      const diff =
        detail.proposedText === null
          ? '(binary content)\n'
          : lineDiff(detail.baseText ?? '', detail.proposedText)
              .map((l) => `${l.kind === '=' ? ' ' : l.kind} ${l.text}\n`)
              .join('');
      ctx.print(detail, `${header}\n${diff}`);
      return 0;
    }
    case 'accept': {
      if (id === undefined) throw new UsageError('Usage: obsy proposals accept <id>');
      const result = await admin.accept(id);
      const text =
        result.status === 'accepted'
          ? result.resolution.outcome === 'rejected'
            ? `accepted at seq ${String(result.seq)}, but a rejection was stored first\n`
            : result.seq === null
              ? 'accepted: the file already had this content\n'
              : `accepted at seq ${result.seq}${result.merged ? ', merged with later edits' : ''}\n`
          : result.status === 'conflict'
            ? `not applied (${result.reason}): it stays open\n`
            : `already ${result.resolution.outcome}\n`;
      ctx.print(result, text);
      return result.status === 'conflict' ? 1 : 0;
    }
    case 'reject': {
      if (id === undefined) throw new UsageError('Usage: obsy proposals reject <id>');
      const resolution = await admin.reject(id);
      ctx.print(resolution, `${resolution.outcome}\n`);
      return 0;
    }
    default:
      throw new UsageError(`Unknown proposals command ${JSON.stringify(sub)}.`);
  }
}

async function exportFolder(ctx: Context, args: readonly string[]): Promise<number> {
  const [folder] = need(args, 1, 'export <folder> [--seq n]');
  const reader = ctx.admin().reader;
  const head = await reader.head();
  const seq = ctx.number('seq', head.seq);
  const manifest = await reader.manifestAt(seq);
  const root = await prepareEmptyFolder(folder as string);
  let files = 0;
  let bytes = 0;
  for (const [, entry] of manifest.liveFiles()) {
    const body = await reader.bytes(entry.hash);
    await writeUnder(root, entry.path, body);
    files++;
    bytes += body.length;
  }
  ctx.print({ seq, files, bytes }, `exported seq ${seq}: ${files} files, ${bytes} bytes\n`);
  return 0;
}
