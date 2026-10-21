import { RemoteVault, type Environment } from '@obsy/core';
import {
  Manifest,
  ProtocolError,
  decodeUtf8Strict,
  type Actor,
  type Commit,
  type ContentHash,
  type Op,
  type Storage,
  type VaultRecord,
} from '@obsy/protocol';

/** A file's state at one revision. */
export interface RevisionEntry {
  readonly path: string;
  readonly hash: ContentHash;
  readonly size: number;
  readonly deleted: boolean;
}

/** One revision of a file, newest first in `history`. */
export interface Revision {
  readonly rev: number;
  readonly type: Op['type'];
  readonly path: string;
  /** The content after the revision. */
  readonly hash: ContentHash;
  readonly size: number;
  readonly deleted: boolean;
  readonly actor: Actor;
  readonly time: string;
  readonly opId: string;
}

/** The bucket has no vault. */
export class NoVaultError extends Error {
  constructor() {
    super('The bucket prefix has no vault.json.');
    this.name = 'NoVaultError';
  }
}

const MAX_CACHED_COMMITS = 20_000;

/**
 * Read access to a vault for agents and maintenance: the head (from the
 * newest checkpoint, then the log), commits by `seq` with a cache, file
 * content, and a file's revisions found by following `baseRev`.
 */
export class VaultReader {
  readonly remote: RemoteVault;
  #manifest: Manifest | null = null;
  #vault: VaultRecord | null = null;
  readonly #commits = new Map<number, Commit>();

  constructor(
    readonly storage: Storage,
    readonly env: Environment,
  ) {
    this.remote = new RemoteVault(storage, env);
  }

  /** `vault.json` as read by the last `head`. */
  get vault(): VaultRecord | null {
    return this.#vault;
  }

  /** Catches up and returns the head manifest. Callers must not change it. */
  async head(): Promise<Manifest> {
    const vault = await this.remote.getVault();
    if (vault === null) throw new NoVaultError();
    if (
      this.#manifest === null ||
      this.#vault?.vaultId !== vault.vaultId ||
      this.#manifest.epoch !== vault.epoch
    ) {
      this.#commits.clear();
      const checkpoint = await this.remote.latestCheckpoint();
      this.#manifest =
        checkpoint !== null && checkpoint.epoch === vault.epoch
          ? Manifest.fromCheckpoint(checkpoint)
          : new Manifest(vault.epoch);
    }
    this.#vault = vault;
    for (const commit of await this.remote.catchUp(this.#manifest)) this.#remember(commit);
    return this.#manifest;
  }

  /** Records a commit that the caller claimed and applied to the head. */
  applied(commit: Commit): void {
    this.#manifest?.apply(commit);
    this.#remember(commit);
  }

  #remember(commit: Commit): void {
    if (this.#commits.size >= MAX_CACHED_COMMITS) {
      const oldest = this.#commits.keys().next().value;
      if (oldest !== undefined) this.#commits.delete(oldest);
    }
    this.#commits.set(commit.seq, commit);
  }

  /** The commit at `seq`. */
  async commit(seq: number): Promise<Commit> {
    const cached = this.#commits.get(seq);
    if (cached !== undefined) return cached;
    const commit = await this.remote.readCommit(seq);
    if (commit === null) throw new ProtocolError(`log entry ${seq} is missing`);
    this.#remember(commit);
    return commit;
  }

  async bytes(hash: ContentHash): Promise<Uint8Array> {
    return this.remote.getBlob(hash);
  }

  /** The content as UTF-8 text, or null when it is not. */
  async text(hash: ContentHash): Promise<string | null> {
    const bytes = await this.bytes(hash);
    try {
      return decodeUtf8Strict(bytes);
    } catch {
      return null;
    }
  }

  async #opAt(fileId: string, rev: number): Promise<{ commit: Commit; op: Op }> {
    const commit = await this.commit(rev);
    const op = commit.ops.find((o) => o.fileId === fileId);
    if (op === undefined) throw new ProtocolError(`commit ${rev} has no op for ${fileId}`);
    return { commit, op };
  }

  /** The file's path and content right after revision `rev`. */
  async entryAt(fileId: string, rev: number): Promise<RevisionEntry> {
    let { op } = await this.#opAt(fileId, rev);
    const path = op.type === 'move' ? op.to : op.path;
    const deleted = op.type === 'delete';
    // Moves and deletes keep the content: find the put before them.
    while (op.type !== 'put') {
      ({ op } = await this.#opAt(fileId, op.baseRev));
    }
    return { path, hash: op.hash, size: op.size, deleted };
  }

  /** The file's revisions, newest first, from `rev` back, at most `limit`. */
  async history(fileId: string, rev: number, limit = 50): Promise<Revision[]> {
    const out: Revision[] = [];
    let next: number | null = rev;
    while (next !== null && out.length < limit) {
      const { commit, op } = await this.#opAt(fileId, next);
      const entry = await this.entryAt(fileId, next);
      out.push({
        rev: next,
        type: op.type,
        ...entry,
        actor: commit.actor,
        time: commit.time,
        opId: commit.opId,
      });
      next = op.baseRev;
    }
    return out;
  }

  /**
   * Commits from the head back while their time is at or after `since`,
   * newest first, at most `limit`.
   */
  async recentCommits(since: Date, limit = 1000): Promise<Commit[]> {
    const head = this.#manifest;
    if (head === null) return [];
    const out: Commit[] = [];
    const cutoff = since.getTime();
    for (let seq = head.seq; seq >= 1 && out.length < limit; seq--) {
      const commit = await this.commit(seq);
      if (Date.parse(commit.time) < cutoff) break;
      out.push(commit);
    }
    return out;
  }
}
