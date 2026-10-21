import type { Environment } from '@obsy/core';
import { merge3 } from '@obsy/merge';
import {
  ProtocolError,
  encodeUtf8,
  isActorId,
  type Actor,
  type Commit,
  type ContentHash,
  type FileEntry,
  type Manifest,
  type Op,
  type Presence,
  type Proposal,
  type PutOp,
  type Resolution,
  type Storage,
  type VaultRecord,
} from '@obsy/protocol';

import { claimCommit, isMergeable, newBlob, type NewBlob } from './commit';
import { VaultReader } from './reader';
import {
  proposalIds,
  readPresence,
  readProposal,
  readResolution,
  writeResolution,
} from './records';

export interface VaultAdminOptions {
  readonly storage: Storage;
  readonly env: Environment;
  /** Who acts: the owner's device or a maintenance actor. Recorded in commits and resolutions. */
  readonly actor: { readonly kind: 'device' | 'system'; readonly id: string };
  /** Lost claims before an operation gives up. Default 20. */
  readonly maxAttempts?: number;
}

/** A file that undo could not restore. */
export interface UndoProblem {
  readonly fileId: string;
  readonly path: string;
  readonly reason:
    | 'changed-since'
    | 'deleted-since'
    | 'moved-since'
    | 'path-taken'
    | 'conflict'
    | 'not-text';
}

export type UndoResult =
  | { readonly status: 'committed'; readonly seq: number; readonly files: number }
  /** Every change of the commit is already undone. */
  | { readonly status: 'unchanged' }
  /** Nothing was written: these files cannot be restored without losing later edits. */
  | { readonly status: 'refused'; readonly problems: readonly UndoProblem[] };

export type AcceptResult =
  | {
      readonly status: 'accepted';
      /** The commit that applied it; null when the head already had its content. */
      readonly seq: number | null;
      /** True when the proposal was merged with edits made after it. */
      readonly merged: boolean;
      /** The stored resolution. Its outcome is `rejected` if a rejection was stored first. */
      readonly resolution: Resolution;
    }
  /** It cannot apply without losing an edit made after it. It stays open. */
  | {
      readonly status: 'conflict';
      readonly reason: 'file-deleted' | 'path-taken' | 'conflict' | 'not-text';
    }
  /** It was resolved before. */
  | { readonly status: 'resolved'; readonly resolution: Resolution };

export interface ProposalDetail {
  readonly proposal: Proposal;
  readonly resolution: Resolution | null;
  /** The file's content at the proposal's base; null for a new file or binary content. */
  readonly baseText: string | null;
  readonly proposedText: string | null;
  /** The live file now, or null when it is gone. */
  readonly head: {
    readonly rev: number;
    readonly path: string;
    readonly text: string | null;
  } | null;
}

export interface VaultStatus {
  readonly vault: VaultRecord;
  readonly seq: number;
  readonly files: number;
  readonly bytes: number;
  readonly openProposals: number;
  readonly presence: readonly Presence[];
  /** The newest commits, newest first. */
  readonly recent: readonly Commit[];
}

/**
 * Operations for the vault's owner: status, undo, and the answer to
 * proposals. They write commits as the owner's actor, so unlike an agent
 * they may delete, move, and merge. See docs/subsystems/agent-sdk.md.
 */
export class VaultAdmin {
  readonly reader: VaultReader;
  readonly #storage: Storage;
  readonly #env: Environment;
  readonly #actor: Actor;
  readonly #maxAttempts: number;

  constructor(options: VaultAdminOptions) {
    if (!isActorId(options.actor.id))
      throw new ProtocolError(`Not an actor ID: ${JSON.stringify(options.actor.id)}`);
    this.#storage = options.storage;
    this.#env = options.env;
    this.#actor = { kind: options.actor.kind, id: options.actor.id };
    this.reader = new VaultReader(options.storage, options.env);
    this.#maxAttempts = options.maxAttempts ?? 20;
  }

  async status(recent = 10): Promise<VaultStatus> {
    const manifest = await this.reader.head();
    let files = 0;
    let bytes = 0;
    for (const [, entry] of manifest.liveFiles()) {
      files++;
      bytes += entry.size;
    }
    const commits: Commit[] = [];
    for (let seq = manifest.seq; seq >= 1 && commits.length < recent; seq--) {
      commits.push(await this.reader.commit(seq));
    }
    const { open } = await proposalIds(this.#storage, this.#env);
    return {
      vault: this.reader.vault as VaultRecord,
      seq: manifest.seq,
      files,
      bytes,
      openProposals: open.length,
      presence: await readPresence(this.#storage, this.#env),
      recent: commits,
    };
  }

  // ---------------------------------------------------------------- proposals

  /** Open proposals, oldest first. */
  async openProposals(): Promise<Proposal[]> {
    const { open } = await proposalIds(this.#storage, this.#env);
    const out: Proposal[] = [];
    for (const id of open) {
      const proposal = await readProposal(this.#storage, this.#env, id);
      if (proposal !== null) out.push(proposal);
    }
    return out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async proposal(id: string): Promise<ProposalDetail | null> {
    const proposal = await readProposal(this.#storage, this.#env, id);
    if (proposal === null) return null;
    const manifest = await this.reader.head();
    const live = proposal.fileId === null ? manifest.liveAt(proposal.path) : proposal.fileId;
    const entry = live === undefined ? undefined : manifest.file(live);
    return {
      proposal,
      resolution: await readResolution(this.#storage, this.#env, id),
      baseText: proposal.baseHash === null ? null : await this.reader.text(proposal.baseHash),
      proposedText: await this.reader.text(proposal.hash),
      head:
        entry === undefined || entry.deleted
          ? null
          : { rev: entry.rev, path: entry.path, text: await this.reader.text(entry.hash) },
    };
  }

  /**
   * Applies a proposal: as it is when the file has not changed since its
   * base, or merged three-way with the edits made since. A conflict leaves
   * it open and writes nothing.
   */
  async accept(id: string): Promise<AcceptResult> {
    const earlier = await readResolution(this.#storage, this.#env, id);
    if (earlier !== null) return { status: 'resolved', resolution: earlier };
    const proposal = await readProposal(this.#storage, this.#env, id);
    if (proposal === null) throw new ProtocolError(`No proposal ${id}`);
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const manifest = await this.reader.head();
      const plan = await this.#acceptPlan(manifest, proposal);
      if (plan.kind === 'conflict') return { status: 'conflict', reason: plan.reason };
      let seq: number | null = null;
      if (plan.kind === 'put') {
        const commit = await claimCommit(
          this.reader,
          this.#env,
          manifest,
          this.#actor,
          [plan.op],
          plan.blob === null ? [] : [plan.blob],
        );
        if (commit === null) continue;
        seq = commit.seq;
      }
      const resolution = await writeResolution(this.#storage, this.#env, {
        format: 1,
        id,
        resolvedAt: this.#env.now().toISOString(),
        actor: this.#actor,
        outcome: 'accepted',
        ...(seq === null ? {} : { seq }),
      });
      return { status: 'accepted', seq, merged: plan.kind === 'put' && plan.merged, resolution };
    }
    throw new ProtocolError(`accepting ${id} lost ${this.#maxAttempts} races`);
  }

  async #acceptPlan(
    manifest: Manifest,
    proposal: Proposal,
  ): Promise<
    | { kind: 'put'; op: Op; blob: NewBlob | null; merged: boolean }
    | { kind: 'unchanged' }
    | { kind: 'conflict'; reason: 'file-deleted' | 'path-taken' | 'conflict' | 'not-text' }
  > {
    if (proposal.fileId === null) {
      const taken = manifest.liveAt(proposal.path);
      if (taken !== undefined) {
        const entry = manifest.file(taken) as FileEntry;
        return entry.hash === proposal.hash
          ? { kind: 'unchanged' }
          : { kind: 'conflict', reason: 'path-taken' };
      }
      return {
        kind: 'put',
        op: {
          type: 'put',
          fileId: this.#env.newFileId(),
          path: proposal.path,
          baseRev: null,
          hash: proposal.hash,
          size: proposal.size,
        },
        blob: null,
        merged: false,
      };
    }
    const entry = manifest.file(proposal.fileId);
    if (entry === undefined || entry.deleted) return { kind: 'conflict', reason: 'file-deleted' };
    if (entry.hash === proposal.hash) return { kind: 'unchanged' };
    const put = (hash: ContentHash, size: number): PutOp => ({
      type: 'put',
      fileId: proposal.fileId as string,
      path: entry.path,
      baseRev: entry.rev,
      hash,
      size,
    });
    if (entry.hash === proposal.baseHash) {
      return { kind: 'put', op: put(proposal.hash, proposal.size), blob: null, merged: false };
    }
    if (!isMergeable(entry.path) || proposal.baseHash === null)
      return { kind: 'conflict', reason: 'conflict' };
    const [base, ours, theirs] = await Promise.all([
      this.reader.text(proposal.baseHash),
      this.reader.text(proposal.hash),
      this.reader.text(entry.hash),
    ]);
    if (base === null || ours === null || theirs === null)
      return { kind: 'conflict', reason: 'not-text' };
    const result = merge3({ base, ours, theirs });
    if (result.status !== 'clean') return { kind: 'conflict', reason: 'conflict' };
    if (result.text === theirs) return { kind: 'unchanged' };
    const blob = await newBlob(encodeUtf8(result.text));
    return {
      kind: 'put',
      op: {
        ...put(blob.hash, blob.bytes.length),
        merge: { base: proposal.baseRev as number, theirs: entry.rev },
      },
      blob,
      merged: true,
    };
  }

  /** Rejects a proposal. Returns the stored resolution, which may be an earlier acceptance. */
  async reject(id: string): Promise<Resolution> {
    const proposal = await readProposal(this.#storage, this.#env, id);
    if (proposal === null) throw new ProtocolError(`No proposal ${id}`);
    return writeResolution(this.#storage, this.#env, {
      format: 1,
      id,
      resolvedAt: this.#env.now().toISOString(),
      actor: this.#actor,
      outcome: 'rejected',
    });
  }

  // ---------------------------------------------------------------- undo

  /**
   * Writes a new commit that reverses commit `seq`. A file changed since
   * then is reverted three-way (Markdown and text only), so that later
   * edits stay. When any file cannot be restored safely, nothing is
   * written and the problems are returned.
   */
  async undo(seq: number): Promise<UndoResult> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt++) {
      const manifest = await this.reader.head();
      if (!Number.isSafeInteger(seq) || seq < 1 || seq > manifest.seq)
        throw new ProtocolError(`No commit ${seq}; the head is at ${manifest.seq}.`);
      const target = await this.reader.commit(seq);
      const ops: Op[] = [];
      const blobs: NewBlob[] = [];
      const problems: UndoProblem[] = [];
      for (const op of target.ops) {
        const step = await this.#undoOp(manifest, seq, op);
        if (step === null) continue;
        if ('reason' in step) problems.push(step);
        else {
          ops.push(step.op);
          if (step.blob !== null) blobs.push(step.blob);
        }
      }
      if (problems.length > 0) return { status: 'refused', problems };
      if (ops.length === 0) return { status: 'unchanged' };
      const commit = await claimCommit(this.reader, this.#env, manifest, this.#actor, ops, blobs);
      if (commit !== null) return { status: 'committed', seq: commit.seq, files: ops.length };
    }
    throw new ProtocolError(`undo of ${seq} lost ${this.#maxAttempts} races`);
  }

  /** The op that reverses `op` of commit `seq` on the head, null when none is needed. */
  async #undoOp(
    manifest: Manifest,
    seq: number,
    op: Op,
  ): Promise<{ op: Op; blob: NewBlob | null } | UndoProblem | null> {
    const head = manifest.file(op.fileId);
    if (head === undefined) throw new ProtocolError(`${op.fileId} is not in the head`);
    const problem = (reason: UndoProblem['reason']): UndoProblem => ({
      fileId: op.fileId,
      path: head.path,
      reason,
    });
    const before = op.baseRev === null ? null : await this.reader.entryAt(op.fileId, op.baseRev);
    const remove = (): { op: Op; blob: null } => ({
      op: { type: 'delete', fileId: op.fileId, path: head.path, baseRev: head.rev },
      blob: null,
    });

    if (op.type === 'put' && (before === null || before.deleted)) {
      // The commit created the file, or restored a deleted one.
      if (head.deleted) return null;
      return head.rev === seq ? remove() : problem('changed-since');
    }
    if (op.type === 'put' && before !== null) {
      if (head.deleted) return problem('deleted-since');
      if (head.hash === before.hash) return null;
      const restore = (hash: ContentHash, size: number): Op => ({
        type: 'put',
        fileId: op.fileId,
        path: head.path,
        baseRev: head.rev,
        hash,
        size,
      });
      if (head.hash === op.hash) return { op: restore(before.hash, before.size), blob: null };
      if (!isMergeable(head.path)) return problem('changed-since');
      const [after, wanted, now] = await Promise.all([
        this.reader.text(op.hash),
        this.reader.text(before.hash),
        this.reader.text(head.hash),
      ]);
      if (after === null || wanted === null || now === null) return problem('not-text');
      // Apply the change from `after` back to `wanted` onto the head.
      const result = merge3({ base: after, ours: wanted, theirs: now });
      if (result.status !== 'clean') return problem('conflict');
      if (result.text === now) return null;
      const blob = await newBlob(encodeUtf8(result.text));
      return { op: restore(blob.hash, blob.bytes.length), blob };
    }
    if (op.type === 'move') {
      if (head.deleted) return problem('deleted-since');
      if (head.path === op.from) return null;
      if (head.path !== op.to) return problem('moved-since');
      const occupant = manifest.liveAt(op.from);
      if (occupant !== undefined && occupant !== op.fileId) return problem('path-taken');
      return {
        op: { type: 'move', fileId: op.fileId, from: head.path, to: op.from, baseRev: head.rev },
        blob: null,
      };
    }
    // A delete.
    if (!head.deleted) return null;
    if (head.rev !== seq || before === null) return problem('changed-since');
    const occupant = manifest.liveAt(head.path);
    if (occupant !== undefined) return problem('path-taken');
    return {
      op: {
        type: 'put',
        fileId: op.fileId,
        path: head.path,
        baseRev: head.rev,
        hash: before.hash,
        size: before.size,
      },
      blob: null,
    };
  }
}
