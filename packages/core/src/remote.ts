import {
  LOG_PREFIX,
  Manifest,
  ProtocolError,
  VAULT_KEY,
  blobKey,
  checkpointKey,
  decodeCheckpoint,
  decodeCommit,
  decodeVaultRecord,
  encodeRecord,
  encodeUtf8,
  hashContent,
  isPreconditionFailed,
  isStorageError,
  logKey,
  parseCheckpointKey,
  parseLogKey,
  CHECKPOINT_PREFIX,
  type Checkpoint,
  type Commit,
  type ContentHash,
  type Storage,
  type VaultRecord,
} from '@obsy/protocol';

import type { Environment } from './host';

/** Retries transient storage errors with capped exponential backoff and full jitter. */
export async function withRetry<T>(
  env: Environment,
  action: () => Promise<T>,
  options: { readonly attempts?: number; readonly baseMs?: number; readonly maxMs?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 8;
  const baseMs = options.baseMs ?? 100;
  const maxMs = options.maxMs ?? 10_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      if (!isStorageError(error, 'transient') || attempt >= attempts) throw error;
      const cap = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
      const wait = Math.max(error.retryAfterMs ?? 0, Math.floor(env.random() * cap));
      await env.sleep(wait);
    }
  }
}

/** The outcome of claiming a log entry. */
export type ClaimResult = { readonly won: true } | { readonly won: false; readonly winner: Commit };

/**
 * Bucket access for the sync engine: vault record, log, blobs, and
 * checkpoints, with validation and retries.
 */
export class RemoteVault {
  constructor(
    readonly storage: Storage,
    readonly env: Environment,
  ) {}

  async getVault(): Promise<VaultRecord | null> {
    const object = await withRetry(this.env, () => this.storage.get(VAULT_KEY));
    return object === null ? null : decodeVaultRecord(object.body);
  }

  /** Creates `vault.json`. Returns the record that exists afterwards (ours or another writer's). */
  async initVault(record: VaultRecord): Promise<VaultRecord> {
    try {
      await withRetry(this.env, () =>
        this.storage.putIfAbsent(VAULT_KEY, encodeRecord(record), 'application/json'),
      );
      return record;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const existing = await this.getVault();
      if (existing === null) throw new ProtocolError('vault.json vanished after a failed create');
      return existing;
    }
  }

  async readCommit(seq: number): Promise<Commit | null> {
    const object = await withRetry(this.env, () => this.storage.get(logKey(seq)));
    return object === null ? null : decodeCommit(object.body, seq);
  }

  /**
   * Applies every commit after `manifest.seq` to `manifest`, in order, and
   * returns them. Stops with `ProtocolError` at a gap or a commit that
   * breaks a rule.
   */
  async catchUp(manifest: Manifest): Promise<Commit[]> {
    const applied: Commit[] = [];
    for (;;) {
      const startAfter = manifest.seq === 0 ? undefined : logKey(manifest.seq);
      const page = await withRetry(this.env, () => this.storage.list(LOG_PREFIX, startAfter, 1000));
      const seqs = page.keys.map(parseLogKey).filter((seq): seq is number => seq !== null);
      if (seqs.length === 0) return applied;
      for (const seq of seqs) {
        if (seq !== manifest.seq + 1) {
          throw new ProtocolError(`log gap: expected ${manifest.seq + 1}, found ${seq}`);
        }
        const commit = await this.readCommit(seq);
        if (commit === null) throw new ProtocolError(`log entry ${seq} vanished`);
        manifest.apply(commit);
        applied.push(commit);
      }
      if (!page.truncated) return applied;
    }
  }

  /**
   * Creates `log/<seq>` with `body`. A request that may have applied is
   * retried with the identical body; a precondition failure is resolved by
   * reading the entry, so the result is always definite.
   */
  async claim(seq: number, body: string, opId: string): Promise<ClaimResult> {
    const bytes = encodeUtf8(body);
    try {
      await withRetry(
        this.env,
        () => this.storage.putIfAbsent(logKey(seq), bytes, 'application/json'),
        {
          attempts: 12,
        },
      );
      return { won: true };
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      const winner = await this.readCommit(seq);
      if (winner === null)
        throw new ProtocolError(`log entry ${seq} missing after a failed create`);
      return winner.opId === opId ? { won: true } : { won: false, winner };
    }
  }

  /** Uploads content once. An existing blob is success: blobs are never overwritten. */
  async putBlob(bytes: Uint8Array, hash: ContentHash): Promise<void> {
    try {
      await withRetry(this.env, () =>
        this.storage.putIfAbsent(blobKey(hash), bytes, 'application/octet-stream'),
      );
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
  }

  /** Reads content and checks it against its hash. */
  async getBlob(hash: ContentHash): Promise<Uint8Array> {
    const object = await withRetry(this.env, () => this.storage.get(blobKey(hash)));
    if (object === null) throw new ProtocolError(`blob ${hash} is missing`);
    const actual = await hashContent(object.body);
    if (actual !== hash) throw new ProtocolError(`blob ${hash} has content ${actual}`);
    return object.body;
  }

  /** The newest checkpoint, or null. */
  async latestCheckpoint(): Promise<Checkpoint | null> {
    let newest: number | null = null;
    let startAfter: string | undefined;
    for (;;) {
      const page = await withRetry(this.env, () =>
        this.storage.list(CHECKPOINT_PREFIX, startAfter, 1000),
      );
      for (const key of page.keys) {
        const seq = parseCheckpointKey(key);
        if (seq !== null) newest = seq;
      }
      if (!page.truncated || page.keys.length === 0) break;
      startAfter = page.keys.at(-1);
    }
    if (newest === null) return null;
    const key = checkpointKey(newest);
    const object = await withRetry(this.env, () => this.storage.get(key));
    return object === null ? null : decodeCheckpoint(object.body, newest);
  }

  /** Writes a checkpoint of `manifest`. Idempotent. */
  async writeCheckpoint(manifest: Manifest): Promise<void> {
    if (manifest.seq === 0) return;
    try {
      await withRetry(this.env, () =>
        this.storage.putIfAbsent(
          checkpointKey(manifest.seq),
          encodeRecord(manifest.toCheckpoint()),
          'application/json',
        ),
      );
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
    }
  }
}
