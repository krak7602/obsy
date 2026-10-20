import { pathKey } from './paths';
import { ProtocolError, type Checkpoint, type Commit, type FileEntry } from './records';

/**
 * The state of every file after some prefix of the log, and the rules that
 * each commit must satisfy against that state. Readers apply commits in
 * order and stop at the first commit that breaks a rule: that is
 * corruption, not something to skip.
 *
 * The rules (docs/subsystems/protocol.md#commit-rules):
 *
 * - `seq` is the next number, and `epoch` is the vault's epoch.
 * - Every op's `baseRev` is the file's current revision. Writers rebase on
 *   the current state before they claim a number, so no op is stale.
 * - A `put` with `baseRev: null` creates a file with a new `fileId`.
 * - A `put` on an existing file keeps its path. A `put` on a deleted file
 *   restores it at its last path.
 * - A `move` starts at the file's current path. A `delete` names it.
 * - One op per file per commit. Every op is checked against the state
 *   before the commit.
 * - After the commit, two live files never share a path key (NFC plus
 *   lower case). Within a commit, renames may swap paths.
 * - A conflict copy names a file and revision that exist.
 */
export class Manifest {
  #seq: number;
  #epoch: number;
  readonly #files = new Map<string, FileEntry>();
  readonly #live = new Map<string, string>();

  constructor(epoch: number, seq = 0) {
    this.#epoch = epoch;
    this.#seq = seq;
  }

  /** The last applied sequence number; 0 for an empty log. */
  get seq(): number {
    return this.#seq;
  }

  get epoch(): number {
    return this.#epoch;
  }

  static fromCheckpoint(checkpoint: Checkpoint): Manifest {
    const manifest = new Manifest(checkpoint.epoch, checkpoint.seq);
    for (const [fileId, entry] of Object.entries(checkpoint.files)) {
      manifest.#files.set(fileId, entry);
      if (!entry.deleted) manifest.#live.set(pathKey(entry.path), fileId);
    }
    return manifest;
  }

  toCheckpoint(): Checkpoint {
    const files: Record<string, FileEntry> = {};
    for (const fileId of [...this.#files.keys()].sort()) {
      files[fileId] = this.#files.get(fileId) as FileEntry;
    }
    return { format: 1, seq: this.#seq, epoch: this.#epoch, files };
  }

  clone(): Manifest {
    const copy = new Manifest(this.#epoch, this.#seq);
    for (const [k, v] of this.#files) copy.#files.set(k, v);
    for (const [k, v] of this.#live) copy.#live.set(k, v);
    return copy;
  }

  /** The file, live or deleted, or `undefined` when the ID was never used. */
  file(fileId: string): FileEntry | undefined {
    return this.#files.get(fileId);
  }

  /** The live file whose path has the same key as `path`. */
  liveAt(path: string): string | undefined {
    return this.#live.get(pathKey(path));
  }

  /** Live files, in no particular order. */
  *liveFiles(): IterableIterator<[string, FileEntry]> {
    for (const fileId of this.#live.values()) yield [fileId, this.#files.get(fileId) as FileEntry];
  }

  /** Every file ever created, with tombstones. */
  *allFiles(): IterableIterator<[string, FileEntry]> {
    yield* this.#files;
  }

  /**
   * Applies one commit. Throws `ProtocolError` and leaves the manifest
   * unchanged when the commit breaks a rule.
   */
  apply(commit: Commit): void {
    const where = `commit ${commit.seq}`;
    const fail = (problem: string): never => {
      throw new ProtocolError(`${where}: ${problem}`);
    };
    if (commit.seq !== this.#seq + 1) fail(`expected seq ${this.#seq + 1}`);
    if (commit.epoch !== this.#epoch) fail(`epoch ${commit.epoch}, vault epoch ${this.#epoch}`);

    // Each op names a different file (validateCommit checks this), so every
    // op sees the state before the commit. Path keys are checked once, on
    // the state after the whole commit, so that renames can swap paths.
    const changed = new Map<string, FileEntry>();
    for (const op of commit.ops) {
      const before = this.#files.get(op.fileId);
      if (op.type === 'put' && op.baseRev === null) {
        if (before !== undefined) fail(`${op.fileId} already exists`);
      } else if (before === undefined) {
        fail(`${op.fileId} does not exist`);
      } else if (before.rev !== op.baseRev) {
        fail(`${op.fileId} is at rev ${before.rev}, op says ${String(op.baseRev)}`);
      }
      switch (op.type) {
        case 'put':
          if (before !== undefined && before.path !== op.path)
            fail(`put on ${op.fileId} changes its path`);
          if (op.conflictOf !== undefined && this.#files.get(op.conflictOf.fileId) === undefined) {
            fail('conflict copy of an unknown file');
          }
          if (op.conflictOf !== undefined && op.conflictOf.rev > this.#seq)
            fail('conflict copy of a future revision');
          changed.set(op.fileId, {
            path: op.path,
            rev: commit.seq,
            hash: op.hash,
            size: op.size,
            deleted: false,
          });
          break;
        case 'move':
          if (before === undefined || before.deleted) fail(`move of a deleted file ${op.fileId}`);
          else if (before.path !== op.from) fail(`move from ${op.from}, file is at ${before.path}`);
          else changed.set(op.fileId, { ...before, path: op.to, rev: commit.seq });
          break;
        case 'delete':
          if (before === undefined || before.deleted) fail(`delete of a deleted file ${op.fileId}`);
          else if (before.path !== op.path)
            fail(`delete names ${op.path}, file is at ${before.path}`);
          else changed.set(op.fileId, { ...before, rev: commit.seq, deleted: true });
          break;
      }
    }

    const live = new Map(this.#live);
    for (const fileId of changed.keys()) {
      const before = this.#files.get(fileId);
      if (before !== undefined && !before.deleted) live.delete(pathKey(before.path));
    }
    for (const [fileId, entry] of changed) {
      if (entry.deleted) continue;
      const key = pathKey(entry.path);
      if (live.has(key)) fail(`path key of ${entry.path} is in use`);
      live.set(key, fileId);
    }

    for (const [k, v] of changed) this.#files.set(k, v);
    this.#live.clear();
    for (const [k, v] of live) this.#live.set(k, v);
    this.#seq = commit.seq;
  }
}
