import type { Environment } from '@obsy/core';
import {
  MAX_RATIONALE_LENGTH,
  ProtocolError,
  decodeUtf8Strict,
  encodeUtf8,
  isActorId,
  vaultPathProblem,
  type Actor,
  type ContentHash,
  type FileEntry,
  type ProposalReason,
  type Storage,
} from '@obsy/protocol';

import { claimCommit, newBlob, samePath } from './commit';
import {
  appendAtEnd,
  appendBlockAtEnd,
  appendToSection as appendText,
  contentLines,
  findBlock,
  headingPathProblem,
  insertBlock,
  isBlockId,
  isOwned,
  lineProblem,
  replaceBlockContent,
  splitLines,
} from './markdown';
import { VaultReader, type Revision } from './reader';
import { proposalIds, readPresence, readProposal, writeProposal } from './records';

/** What an agent does when a device is editing the note it wants to change. */
export type PresenceMode =
  /** Wait until the device stops editing, up to `maxWaitMs`, then propose. */
  | 'wait'
  /** Store the change as a proposal at once. */
  | 'propose'
  /** Commit anyway; the device merges the change into the open note. */
  | 'ignore';

export interface PresenceOptions {
  /** Default `wait`. */
  readonly mode?: PresenceMode;
  /** How recent an edit counts as editing now. Default 120,000 ms (two minutes). */
  readonly windowMs?: number;
  /** The longest wait in `wait` mode. Default 300,000 ms. */
  readonly maxWaitMs?: number;
  /** How often to look again while waiting. Default 15,000 ms. */
  readonly pollMs?: number;
}

export interface AgentLimits {
  /** Commits by this agent in the last hour, at most. Default 240. */
  readonly commitsPerHour?: number;
  /** Different files changed by this agent in the last hour, at most. Default 40. */
  readonly filesPerHour?: number;
}

export interface VaultAgentOptions {
  readonly storage: Storage;
  readonly env: Environment;
  /** The agent's actor ID, and the ID of this run. Both are recorded in every commit. */
  readonly actor: { readonly id: string; readonly run?: string };
  readonly presence?: PresenceOptions;
  readonly limits?: AgentLimits;
  /** Lost claims before an operation gives up. Default 20. */
  readonly maxAttempts?: number;
}

export interface WriteOptions {
  /** The tool call that made this change, recorded in the commit or proposal. */
  readonly toolCall?: string;
  /** Why the change is made. Stored with a proposal; at most 4,000 characters. */
  readonly rationale?: string;
}

/** A file's identity and content after an operation. */
interface FileResult {
  readonly fileId: string;
  readonly path: string;
  readonly rev: number;
  readonly hash: ContentHash;
  /** For block operations: the block's hash, to pass as `expectedHash` next time. */
  readonly blockHash?: string;
}

export type WriteResult =
  /** The change is committed at `seq`. */
  | ({ readonly status: 'committed'; readonly seq: number } & FileResult)
  /** The head already had the result. Nothing was written. */
  | ({ readonly status: 'unchanged' } & FileResult)
  /** `createIfAbsent` found a file at the path. Nothing was written. */
  | ({ readonly status: 'exists' } & FileResult)
  /** The change was stored as a proposal for the owner. */
  | {
      readonly status: 'proposed';
      readonly proposalId: string;
      readonly reason: ProposalReason;
    }
  /** Nothing was done: the file is missing, or is not UTF-8 text. */
  | { readonly status: 'skipped'; readonly reason: 'missing' | 'not-text' }
  /**
   * `replaceIfUnchanged` found another revision than `baseRev`: someone
   * changed, created, or deleted the file since the caller read it. Nothing
   * was written. `rev` is the live file's revision now, or null when none.
   */
  | { readonly status: 'changed'; readonly rev: number | null };

/** An operation got input it cannot use. Not retryable. */
export class AgentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentInputError';
  }
}

/** The agent reached its hourly limit. Retry later. */
export class AgentRateLimited extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentRateLimited';
  }
}

/** A live file as an agent reads it. */
export interface AgentFile {
  readonly fileId: string;
  readonly path: string;
  readonly rev: number;
  readonly hash: ContentHash;
  readonly size: number;
  /** The content as text, or null when it is not UTF-8. */
  readonly text: string | null;
}

export interface ListedFile {
  readonly fileId: string;
  readonly path: string;
  readonly rev: number;
  readonly hash: ContentHash;
  readonly size: number;
}

interface Context {
  readonly fileId: string | undefined;
  readonly entry: FileEntry | undefined;
  /** The current content as text; null when the file is missing or not UTF-8. */
  text(): Promise<string | null>;
}

type Plan =
  | { readonly kind: 'put'; readonly bytes: Uint8Array; readonly blockHash?: string }
  | { readonly kind: 'propose'; readonly text: string; readonly reason: ProposalReason }
  | { readonly kind: 'result'; readonly result: WriteResult };

const HOUR_MS = 3_600_000;

/**
 * Narrow, anchored writes for agents and scripts. Each operation reads the
 * head, computes its change from it, and commits with `baseRev` equal to
 * the head revision; a lost claim makes it read the new head and compute
 * the change again, so anchors are checked against the state it commits
 * on. An agent never merges, never deletes, never moves, and never
 * replaces a file's whole content. When an anchor is missing, ambiguous,
 * or edited by a person, the change becomes a proposal.
 *
 * See docs/subsystems/agent-sdk.md.
 */
export class VaultAgent {
  readonly reader: VaultReader;
  readonly #env: Environment;
  readonly #storage: Storage;
  readonly #actor: { readonly id: string; readonly run?: string };
  readonly #presence: Required<PresenceOptions>;
  readonly #limits: Required<AgentLimits>;
  readonly #maxAttempts: number;

  constructor(options: VaultAgentOptions) {
    if (!isActorId(options.actor.id))
      throw new AgentInputError(`Not an actor ID: ${JSON.stringify(options.actor.id)}`);
    this.#env = options.env;
    this.#storage = options.storage;
    this.#actor = options.actor;
    this.reader = new VaultReader(options.storage, options.env);
    this.#presence = {
      mode: options.presence?.mode ?? 'wait',
      windowMs: options.presence?.windowMs ?? 120_000,
      maxWaitMs: options.presence?.maxWaitMs ?? 300_000,
      pollMs: options.presence?.pollMs ?? 15_000,
    };
    this.#limits = {
      commitsPerHour: options.limits?.commitsPerHour ?? 240,
      filesPerHour: options.limits?.filesPerHour ?? 40,
    };
    this.#maxAttempts = options.maxAttempts ?? 20;
  }

  // ---------------------------------------------------------------- reads

  /** The live file at `path` (matched by path key), or null. */
  async read(path: string): Promise<AgentFile | null> {
    const manifest = await this.reader.head();
    const fileId = manifest.liveAt(path);
    if (fileId === undefined) return null;
    const entry = manifest.file(fileId) as FileEntry;
    return {
      fileId,
      path: entry.path,
      rev: entry.rev,
      hash: entry.hash,
      size: entry.size,
      text: await this.reader.text(entry.hash),
    };
  }

  /** Live files whose path starts with `prefix`, by path. */
  async list(prefix = ''): Promise<ListedFile[]> {
    const manifest = await this.reader.head();
    const out: ListedFile[] = [];
    for (const [fileId, entry] of manifest.liveFiles()) {
      if (!entry.path.startsWith(prefix)) continue;
      out.push({ fileId, path: entry.path, rev: entry.rev, hash: entry.hash, size: entry.size });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** The live file's revisions, newest first. One request per revision. */
  async history(path: string, limit = 50): Promise<Revision[]> {
    const manifest = await this.reader.head();
    const fileId = manifest.liveAt(path);
    if (fileId === undefined) return [];
    return this.reader.history(fileId, (manifest.file(fileId) as FileEntry).rev, limit);
  }

  // ---------------------------------------------------------------- writes

  /** Creates a file at `path` unless a live file has its path key. */
  createIfAbsent(
    path: string,
    content: string | Uint8Array,
    options: WriteOptions = {},
  ): Promise<WriteResult> {
    const bytes = typeof content === 'string' ? encodeUtf8(content) : content;
    return this.#edit(path, 'createIfAbsent', options, async (ctx) => {
      if (ctx.entry === undefined) return { kind: 'put', bytes };
      return { kind: 'result', result: { status: 'exists', ...fileResult(ctx) } };
    });
  }

  /**
   * Appends lines at the end of a section. `section` is a heading path,
   * for example `['## Log']` or `['Journal', 'Agent']`; empty means the end
   * of the file. A missing heading is created. A missing file is created
   * with `ifMissing: 'create'` (the default). A heading that appears more
   * than once makes a proposal.
   */
  appendToSection(
    path: string,
    section: readonly string[],
    lines: readonly string[],
    options: WriteOptions & { readonly ifMissing?: 'create' | 'propose' | 'skip' } = {},
  ): Promise<WriteResult> {
    const problem =
      headingPathProblem(section) ??
      (lines.length === 0 ? 'no lines' : null) ??
      lines.map(lineProblem).find((p) => p !== null) ??
      null;
    if (problem !== null) return Promise.reject(new AgentInputError(problem));
    const ifMissing = options.ifMissing ?? 'create';
    return this.#edit(path, 'appendToSection', options, async (ctx) => {
      if (ctx.entry === undefined) {
        if (ifMissing === 'skip')
          return { kind: 'result', result: { status: 'skipped', reason: 'missing' } };
        const created = appendText('', section, lines);
        if (created.status !== 'ok') throw new ProtocolError('append to an empty text failed');
        return ifMissing === 'create'
          ? { kind: 'put', bytes: encodeUtf8(created.text) }
          : { kind: 'propose', text: created.text, reason: 'anchor-missing' };
      }
      const text = await ctx.text();
      if (text === null) return notText();
      const result = appendText(text, section, lines);
      if (result.status === 'ok') return { kind: 'put', bytes: encodeUtf8(result.text) };
      // The heading is there more than once, or the end of the section is
      // in an unclosed code fence: propose the lines at the end.
      return { kind: 'propose', text: appendAtEnd(text, lines), reason: 'anchor-ambiguous' };
    });
  }

  /**
   * Replaces the content of the agent's block `blockId`:
   * `<!-- obsy:agent id=… hash=… -->` … `<!-- /obsy:agent id=… -->`. The
   * start marker holds a hash of the content; when a person edits the
   * block, the hash no longer matches, the block is theirs, and the change
   * becomes a proposal. With `expectedHash`, the block must also hold the
   * content the agent last wrote (the `blockHash` of the last result).
   *
   * A missing block is inserted at the end of `insert.section` (or of the
   * file) when `insert` is set; otherwise it becomes a proposal. A missing
   * file is created only with `insert`.
   */
  replaceBlock(
    path: string,
    blockId: string,
    content: string,
    options: WriteOptions & {
      readonly expectedHash?: string;
      readonly insert?: { readonly section?: readonly string[] };
    } = {},
  ): Promise<WriteResult> {
    if (!isBlockId(blockId))
      return Promise.reject(new AgentInputError(`Not a block ID: ${JSON.stringify(blockId)}`));
    const section = options.insert?.section ?? [];
    const problem =
      headingPathProblem(section) ??
      contentLines(content)
        .map(lineProblem)
        .find((p) => p !== null) ??
      null;
    if (problem !== null) return Promise.reject(new AgentInputError(problem));
    return this.#edit(path, 'replaceBlock', options, async (ctx) => {
      if (ctx.entry === undefined) {
        if (options.insert === undefined)
          return { kind: 'result', result: { status: 'skipped', reason: 'missing' } };
        const created = await insertBlock('', section, blockId, content);
        if (created.status !== 'ok') throw new ProtocolError('insert into an empty text failed');
        return withBlockHash(created.text, blockId);
      }
      const text = await ctx.text();
      if (text === null) return notText();
      const lookup = findBlock(splitLines(text), blockId);
      if (lookup.status === 'found') {
        const next = await replaceBlockContent(text, lookup.block, blockId, content);
        const owned =
          (await isOwned(lookup.block)) &&
          (options.expectedHash === undefined || options.expectedHash === lookup.block.declared);
        if (!owned) return { kind: 'propose', text: next, reason: 'block-edited' };
        return withBlockHash(next, blockId);
      }
      const atEnd = await appendBlockAtEnd(text, blockId, content);
      if (lookup.status === 'ambiguous')
        return { kind: 'propose', text: atEnd, reason: 'anchor-ambiguous' };
      if (options.insert === undefined)
        return { kind: 'propose', text: atEnd, reason: 'anchor-missing' };
      const inserted = await insertBlock(text, section, blockId, content);
      if (inserted.status === 'ok') return withBlockHash(inserted.text, blockId);
      return { kind: 'propose', text: atEnd, reason: 'anchor-ambiguous' };
    });
  }

  /**
   * Replaces the whole file at `path` with `content`, only if the live
   * file is still at revision `baseRev` (from `read`); with `baseRev` null,
   * only if no live file has the path key. This is a compare-and-swap on
   * the bucket's log, across every device and agent: any change since the
   * read gives `changed` and writes nothing. For agents that compute a
   * whole note themselves, from the content they read, and keep the
   * owner's lines by their own rules. A device that has unsynced edits to
   * the file merges the new content with them as with any commit.
   */
  replaceIfUnchanged(
    path: string,
    content: string | Uint8Array,
    options: WriteOptions & { readonly baseRev: number | null },
  ): Promise<WriteResult> {
    const { baseRev } = options;
    if (baseRev !== null && (!Number.isSafeInteger(baseRev) || baseRev < 1))
      return Promise.reject(new AgentInputError(`Not a revision: ${JSON.stringify(baseRev)}`));
    const bytes = typeof content === 'string' ? encodeUtf8(content) : content;
    return this.#edit(path, 'replaceIfUnchanged', options, async (ctx) => {
      const rev = ctx.entry?.rev ?? null;
      if (rev !== baseRev) return { kind: 'result', result: { status: 'changed', rev } };
      return { kind: 'put', bytes };
    });
  }

  /**
   * Stores `content` as a proposal to replace the file at `path`, made
   * against `baseRev` (default: the head revision), or as a proposed new
   * file. Never commits. With a `baseRev` that is not a revision of the
   * live file at `path` (it was deleted, or replaced by another file), it
   * is `skipped` with reason `missing`.
   */
  async proposePatch(
    path: string,
    content: string,
    options: WriteOptions & { readonly baseRev?: number } = {},
  ): Promise<WriteResult> {
    this.#checkWrite(path, options);
    const manifest = await this.reader.head();
    const fileId = manifest.liveAt(path);
    // A base that is gone, or that belongs to another file at this path, means
    // the file the caller read is not there now.
    if (fileId === undefined) {
      if (options.baseRev !== undefined) return { status: 'skipped', reason: 'missing' };
      return this.#propose(path, null, null, content, 'requested', 'proposePatch', options);
    }
    const entry = manifest.file(fileId) as FileEntry;
    let base = { rev: entry.rev, hash: entry.hash, path: entry.path };
    if (options.baseRev !== undefined && options.baseRev !== entry.rev) {
      if (
        options.baseRev > manifest.seq ||
        !(await this.reader.commit(options.baseRev)).ops.some((op) => op.fileId === fileId)
      ) {
        return { status: 'skipped', reason: 'missing' };
      }
      const at = await this.reader.entryAt(fileId, options.baseRev);
      if (at.deleted) return { status: 'skipped', reason: 'missing' };
      base = { rev: options.baseRev, hash: at.hash, path: entry.path };
    }
    return this.#propose(base.path, fileId, base, content, 'requested', 'proposePatch', options);
  }

  // ---------------------------------------------------------------- core

  #checkWrite(path: string, options: WriteOptions): void {
    const problem = vaultPathProblem(path);
    if (problem !== null) throw new AgentInputError(`${path}: ${problem}`);
    if ((options.rationale?.length ?? 0) > MAX_RATIONALE_LENGTH)
      throw new AgentInputError(`The rationale is longer than ${MAX_RATIONALE_LENGTH} characters.`);
    if ((options.toolCall?.length ?? 0) > 200)
      throw new AgentInputError('The tool call ID is longer than 200 characters.');
  }

  #actorFor(options: WriteOptions): Actor {
    return {
      kind: 'agent',
      id: this.#actor.id,
      ...(this.#actor.run === undefined ? {} : { run: this.#actor.run }),
      ...(options.toolCall === undefined ? {} : { toolCall: options.toolCall }),
    };
  }

  async #edit(
    path: string,
    operation: string,
    options: WriteOptions,
    compute: (ctx: Context) => Promise<Plan>,
  ): Promise<WriteResult> {
    this.#checkWrite(path, options);
    let presenceChecked = false;
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const manifest = await this.reader.head();
      const fileId = manifest.liveAt(path);
      const entry = fileId === undefined ? undefined : manifest.file(fileId);
      const ctx: Context = {
        fileId,
        entry,
        text: async () => (entry === undefined ? null : this.reader.text(entry.hash)),
      };
      const plan = await compute(ctx);
      if (plan.kind === 'result') return plan.result;
      const base =
        entry === undefined ? null : { rev: entry.rev, hash: entry.hash, path: entry.path };
      if (plan.kind === 'propose') {
        return this.#propose(
          path,
          fileId ?? null,
          base,
          plan.text,
          plan.reason,
          operation,
          options,
        );
      }
      const blob = await newBlob(plan.bytes);
      if (entry !== undefined && fileId !== undefined && blob.hash === entry.hash) {
        return { status: 'unchanged', ...fileResult(ctx), ...blockHashOf(plan) };
      }
      if (entry !== undefined && !presenceChecked) {
        presenceChecked = true;
        const deferral = await this.#deferral(entry.path);
        if (deferral === 'waited') continue;
        if (deferral === 'propose') {
          const text = decodeUtf8Strict(plan.bytes);
          return this.#propose(path, fileId ?? null, base, text, 'editing', operation, options);
        }
      }
      const targetId = fileId ?? this.#env.newFileId();
      await this.#checkRate(targetId);
      const op =
        entry === undefined
          ? {
              type: 'put' as const,
              fileId: targetId,
              path,
              baseRev: null,
              hash: blob.hash,
              size: blob.bytes.length,
            }
          : {
              type: 'put' as const,
              fileId: targetId,
              path: entry.path,
              baseRev: entry.rev,
              hash: blob.hash,
              size: blob.bytes.length,
            };
      const commit = await claimCommit(
        this.reader,
        this.#env,
        manifest,
        this.#actorFor(options),
        [op],
        [blob],
      );
      if (commit !== null) {
        return {
          status: 'committed',
          seq: commit.seq,
          fileId: targetId,
          path: op.path,
          rev: commit.seq,
          hash: blob.hash,
          ...blockHashOf(plan),
        };
      }
    }
    throw new ProtocolError(`${operation} on ${path} lost ${this.#maxAttempts} races`);
  }

  /**
   * Whether a device edits `path` now. `wait` mode waits for it to stop;
   * after a wait the caller computes again on a fresh head.
   */
  async #deferral(path: string): Promise<'clear' | 'waited' | 'propose'> {
    if (this.#presence.mode === 'ignore') return 'clear';
    const started = this.#env.now().getTime();
    let waited = false;
    for (;;) {
      if (!(await this.#editing(path))) return waited ? 'waited' : 'clear';
      if (this.#presence.mode === 'propose') return 'propose';
      if (this.#env.now().getTime() - started >= this.#presence.maxWaitMs) return 'propose';
      await this.#env.sleep(this.#presence.pollMs);
      waited = true;
    }
  }

  async #editing(path: string): Promise<boolean> {
    const now = this.#env.now().getTime();
    for (const presence of await readPresence(this.#storage, this.#env)) {
      if (presence.path === null || !samePath(presence.path, path)) continue;
      if (now - Date.parse(presence.time) < this.#presence.windowMs) return true;
    }
    return false;
  }

  /** Throws `AgentRateLimited` when one more commit to `fileId` would pass a limit. */
  async #checkRate(fileId: string): Promise<void> {
    const since = new Date(this.#env.now().getTime() - HOUR_MS);
    const limit = this.#limits;
    const recent = await this.reader.recentCommits(since, Math.max(limit.commitsPerHour * 4, 1000));
    const mine = recent.filter((c) => c.actor.kind === 'agent' && c.actor.id === this.#actor.id);
    if (mine.length + 1 > limit.commitsPerHour)
      throw new AgentRateLimited(
        `${this.#actor.id} made ${mine.length} commits in the last hour (limit ${limit.commitsPerHour}).`,
      );
    const files = new Set(mine.flatMap((c) => c.ops.map((op) => op.fileId)));
    files.add(fileId);
    if (files.size > limit.filesPerHour)
      throw new AgentRateLimited(
        `${this.#actor.id} changed ${files.size - 1} files in the last hour (limit ${limit.filesPerHour}).`,
      );
  }

  async #propose(
    path: string,
    fileId: string | null,
    base: { readonly rev: number; readonly hash: ContentHash; readonly path: string } | null,
    text: string,
    reason: ProposalReason,
    operation: string,
    options: WriteOptions,
  ): Promise<WriteResult> {
    const blob = await newBlob(encodeUtf8(text));
    const baseRev = base?.rev ?? null;
    const target = base?.path ?? path;
    // A retried operation finds its own open proposal instead of adding another.
    const { open } = await proposalIds(this.#storage, this.#env);
    for (const id of open) {
      const existing = await readProposal(this.#storage, this.#env, id);
      if (
        existing !== null &&
        existing.actor.id === this.#actor.id &&
        existing.path === target &&
        existing.hash === blob.hash &&
        existing.baseRev === baseRev
      ) {
        return { status: 'proposed', proposalId: id, reason: existing.reason };
      }
    }
    await this.reader.remote.putBlob(blob.bytes, blob.hash);
    const id = `p_${this.#env.newFileId().slice(2)}`;
    await writeProposal(this.#storage, this.#env, {
      format: 1,
      id,
      createdAt: this.#env.now().toISOString(),
      actor: this.#actorFor(options),
      path: target,
      fileId,
      baseRev,
      baseHash: base?.hash ?? null,
      hash: blob.hash,
      size: blob.bytes.length,
      reason,
      operation,
      rationale: options.rationale ?? '',
    });
    return { status: 'proposed', proposalId: id, reason };
  }
}

function fileResult(ctx: Context): FileResult {
  const entry = ctx.entry as FileEntry;
  return { fileId: ctx.fileId as string, path: entry.path, rev: entry.rev, hash: entry.hash };
}

function notText(): Plan {
  return { kind: 'result', result: { status: 'skipped', reason: 'not-text' } };
}

async function withBlockHash(text: string, blockId: string): Promise<Plan> {
  const lookup = findBlock(splitLines(text), blockId);
  if (lookup.status !== 'found')
    throw new ProtocolError(`block ${blockId} not found after a write`);
  return {
    kind: 'put',
    bytes: encodeUtf8(text),
    ...(lookup.block.declared === null ? {} : { blockHash: lookup.block.declared }),
  };
}

function blockHashOf(plan: Plan): { blockHash?: string } {
  return plan.kind === 'put' && plan.blockHash !== undefined ? { blockHash: plan.blockHash } : {};
}
