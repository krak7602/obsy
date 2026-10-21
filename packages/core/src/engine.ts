import { merge3 } from '@obsy/merge';
import {
  Manifest,
  ProtocolError,
  decodeUtf8Strict,
  encodeUtf8,
  freeConflictCopyPath,
  hashContent,
  pathKey,
  type Actor,
  type Commit,
  type ContentHash,
  type FileEntry,
  type Op,
  type Storage,
  type VaultRecord,
} from '@obsy/protocol';

import type {
  ContentIntent,
  DeviceState,
  Environment,
  LocalFile,
  LocalFiles,
  PendingClaim,
  StateStore,
  SyncedFile,
} from './host';
import { RemoteVault } from './remote';

export interface SyncEngineOptions {
  readonly storage: Storage;
  readonly local: LocalFiles;
  readonly state: StateStore;
  readonly env: Environment;
  /** The device's actor ID, for example `mac`. */
  readonly actorId: string;
  /** The device name used in conflict copy names. */
  readonly deviceName: string;
  /** Most commits and local passes in one `sync` call. Default 20. */
  readonly maxPasses?: number;
  /** Most ops in one commit. Default 500. */
  readonly maxOpsPerCommit?: number;
  /** Write a checkpoint after a commit whose seq is a multiple of this. Default 500. */
  readonly checkpointEvery?: number;
  /** Stop before mass deletes or when the local files look gone. Off when not set. */
  readonly rails?: SafetyRails;
  /**
   * The largest file, in bytes, that this device downloads when it does not
   * hold the file yet. Such a head file is left out, and a local file at its
   * path yields to a conflict copy name. Files the device already syncs, and
   * its own files, sync at any size. No limit when not set.
   */
  readonly maxFileSize?: number;
}

/**
 * Limits that stop a sync before it deletes many files. A sync trips a rail
 * when it would delete more than `maxFiles` files, or at least `minFiles`
 * files that are more than `maxFraction` of the files. With `emptyVault`, a
 * sync that would send changes also trips when the device has no files at
 * all but synced files that the head still has.
 */
export interface SafetyRails {
  /** Default 50. */
  readonly maxFiles?: number;
  /** Default 0.2. */
  readonly maxFraction?: number;
  /** The fraction rule applies from this many deletes. Default 10. */
  readonly minFiles?: number;
  /** Default true. */
  readonly emptyVault?: boolean;
}

/** Options for one `sync` call. */
export interface SyncRunOptions {
  /** Apply remote changes to the device, but send nothing. */
  readonly pullOnly?: boolean;
  /** The user confirmed the deletes that tripped a rail: do not check the rails. */
  readonly allowMassDelete?: boolean;
  /**
   * Checked before each pass, download, upload, and claim. When it returns
   * true, the sync saves its state and throws `SyncStopped`. For example,
   * iOS is about to suspend the app.
   */
  readonly shouldStop?: () => boolean;
}

/** A sync stopped at a safe point because `shouldStop` returned true. Its state is saved. */
export class SyncStopped extends Error {
  override readonly name = 'SyncStopped';

  constructor() {
    super('The sync stopped at a safe point');
  }
}

/**
 * A sync stopped at a safety rail before it changed anything for that
 * reason. `local` deletes are remote deletes that would remove files on the
 * device; `remote` deletes are files missing on the device that would be
 * deleted in the bucket.
 */
export class SafetyRailError extends Error {
  override readonly name = 'SafetyRailError';

  constructor(
    readonly rail: 'local-deletes' | 'remote-deletes' | 'empty-vault',
    readonly count: number,
    readonly total: number,
  ) {
    super(
      rail === 'empty-vault'
        ? `The device has no files, but ${count} files were synced before`
        : rail === 'local-deletes'
          ? `The sync would delete ${count} of ${total} files on this device`
          : `The sync would delete ${count} of ${total} files in the bucket`,
    );
  }
}

export interface SyncReport {
  /** Commits this device made. */
  readonly commits: number;
  /** Local writes, moves, and removals this device made. */
  readonly localChanges: number;
  /** Conflict copies this device created. */
  readonly conflictCopies: number;
  /** Ops that a pull-only sync did not send. */
  readonly unsent: number;
  /** Head files left out because of `maxFileSize`, in the last pass. */
  readonly skipped: number;
  /** True when local files and the head agree at the end. */
  readonly settled: boolean;
}

/** A local change failed its condition: the user changed the file meanwhile. Restart the pass. */
class LocalChanged extends Error {}

/** Files whose content obsy merges line by line. Others get a conflict copy on concurrent change. */
function isMergeable(path: string): boolean {
  return /\.(md|txt)$/i.test(path);
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return decodeUtf8Strict(bytes);
  } catch {
    return null;
  }
}

function emptyState(vault: VaultRecord): DeviceState {
  return {
    vaultId: vault.vaultId,
    epoch: vault.epoch,
    head: { seq: 0, files: {} },
    synced: {},
    pending: null,
  };
}

/**
 * Syncs one device's files with the bucket.
 *
 * One `sync` call: resolve a pending claim, then repeat until settled:
 * catch up with the log; bring every synced file up to the head, merging
 * remote changes into local edits on the device first; then commit the
 * remaining local changes as ops against the head. A lost claim starts the
 * next pass. See docs/subsystems/protocol.md#sync-engine.
 */
export class SyncEngine {
  readonly #remote: RemoteVault;
  readonly #options: SyncEngineOptions;
  readonly #actor: Actor;

  constructor(options: SyncEngineOptions) {
    this.#options = options;
    this.#remote = new RemoteVault(options.storage, options.env);
    this.#actor = { kind: 'device', id: options.actorId };
  }

  get remote(): RemoteVault {
    return this.#remote;
  }

  async sync(run: SyncRunOptions = {}): Promise<SyncReport> {
    const vault = await this.#remote.getVault();
    if (vault === null)
      throw new ProtocolError('The bucket has no vault.json. Initialise the vault first.');
    let state = await this.#options.state.load();
    let manifest: Manifest;
    if (state === null || state.vaultId !== vault.vaultId || state.epoch !== vault.epoch) {
      // A new device, another vault, or a repair: start from the newest
      // checkpoint and reconcile every file by content.
      const checkpoint = await this.#remote.latestCheckpoint();
      manifest =
        checkpoint !== null && checkpoint.epoch === vault.epoch
          ? Manifest.fromCheckpoint(checkpoint)
          : new Manifest(vault.epoch);
      state = emptyState(vault);
    } else {
      manifest = Manifest.fromCheckpoint({
        format: 1,
        seq: state.head.seq,
        epoch: state.epoch,
        files: state.head.files,
      });
    }

    const synced = new Map(Object.entries(state.synced));
    const intents = new Map(Object.entries(state.intents ?? {}));
    const counters = { commits: 0, localChanges: 0, conflictCopies: 0, unsent: 0, skipped: 0 };
    const stop = (): void => {
      if (run.shouldStop?.() === true) throw new SyncStopped();
    };
    let pendingClaim: PendingClaim | null = state.pending;
    const save = async (pending: PendingClaim | null = pendingClaim): Promise<void> => {
      pendingClaim = pending;
      const checkpoint = manifest.toCheckpoint();
      await this.#options.state.save({
        vaultId: vault.vaultId,
        epoch: vault.epoch,
        head: { seq: checkpoint.seq, files: checkpoint.files },
        synced: Object.fromEntries(synced),
        pending,
        intents: Object.fromEntries(intents),
      });
    };

    if (intents.size > 0) {
      counters.conflictCopies += await this.#resolveIntents(intents, synced);
      await save();
    }

    if (state.pending !== null) {
      await this.#resolvePending(state.pending, manifest, synced);
      await save(null);
    }

    const maxPasses = this.#options.maxPasses ?? 20;
    for (let pass = 0; pass < maxPasses; pass++) {
      stop();
      await this.#remote.catchUp(manifest);
      const reconciler = new Reconciler(
        this.#options,
        run,
        this.#remote,
        manifest,
        synced,
        intents,
        () => save(null),
      );
      let ops: Op[];
      try {
        ops = await reconciler.run();
      } catch (error) {
        counters.localChanges += reconciler.localChanges;
        counters.conflictCopies += reconciler.conflictCopies;
        await save(null);
        if (error instanceof LocalChanged) continue;
        throw error;
      }
      counters.localChanges += reconciler.localChanges;
      counters.conflictCopies += reconciler.conflictCopies;
      counters.skipped = reconciler.skipped;
      await save(null);
      if (ops.length === 0) {
        if (reconciler.localChanges === 0) return { ...counters, settled: true };
        continue;
      }
      if (run.pullOnly === true) {
        if (reconciler.localChanges === 0)
          return { ...counters, unsent: ops.length, settled: false };
        continue;
      }

      const commit = await this.#prepare(manifest, ops, stop);
      if (commit === null) continue;
      // Never send a commit that breaks the rules: check it on a copy first.
      manifest.clone().apply(commit);
      const body = JSON.stringify(commit);
      const pending: PendingClaim = { seq: commit.seq, body, opId: commit.opId };
      stop();
      await save(pending);
      const result = await this.#remote.claim(commit.seq, body, commit.opId);
      if (result.won) {
        manifest.apply(commit);
        applyOwnCommit(commit, synced);
        counters.commits++;
        await save(null);
        const every = this.#options.checkpointEvery ?? 500;
        if (commit.seq % every === 0) await this.#remote.writeCheckpoint(manifest);
      } else {
        await save(null);
      }
    }
    return { ...counters, settled: false };
  }

  /**
   * Settles local writes that were in progress when the device stopped.
   * Returns the number of conflict copies made.
   */
  async #resolveIntents(
    intents: Map<string, ContentIntent>,
    synced: Map<string, SyncedFile>,
  ): Promise<number> {
    const local = this.#options.local;
    let copies = 0;
    for (const [fileId, intent] of intents) {
      const bytes = await local.read(intent.path);
      const hash = bytes === null ? null : await hashContent(bytes);
      if (hash === intent.result) {
        synced.set(fileId, intent.next);
      } else if (hash !== intent.expected && hash !== null) {
        // Edited after a write that may or may not have happened: the base
        // is unknown. Keep this version as a conflict copy; the file's head
        // version is restored by the next pass.
        const taken = new Set((await local.list()).map((f) => pathKey(f.path)));
        const copy = freeConflictCopyPath(
          intent.path,
          this.#options.deviceName,
          this.#options.env.now(),
          (key) => taken.has(key),
        );
        if (await local.move(intent.path, copy, hash)) copies++;
      }
    }
    intents.clear();
    return copies;
  }

  /** Re-sends a claim whose outcome is unknown, with the identical body at the same seq. */
  async #resolvePending(
    pending: PendingClaim,
    manifest: Manifest,
    synced: Map<string, SyncedFile>,
  ): Promise<void> {
    if (pending.seq !== manifest.seq + 1) return;
    const result = await this.#remote.claim(pending.seq, pending.body, pending.opId);
    if (!result.won) return;
    const commit = await this.#remote.readCommit(pending.seq);
    if (commit === null)
      throw new ProtocolError(`log entry ${pending.seq} missing after a won claim`);
    manifest.apply(commit);
    applyOwnCommit(commit, synced);
  }

  /** Uploads content and builds the commit. Returns null when local files changed meanwhile. */
  async #prepare(manifest: Manifest, ops: Op[], stop: () => void): Promise<Commit | null> {
    for (const op of ops) {
      if (op.type !== 'put') continue;
      stop();
      const bytes = await this.#options.local.read(op.path);
      if (bytes === null || (await hashContent(bytes)) !== op.hash) return null;
      await this.#remote.putBlob(bytes, op.hash);
    }
    return {
      format: 1,
      seq: manifest.seq + 1,
      epoch: manifest.epoch,
      opId: this.#options.env.newOpId(this.#actor.id),
      actor: this.#actor,
      time: this.#options.env.now().toISOString(),
      ops,
    };
  }
}

/** Records the device's own committed ops as synced. */
function applyOwnCommit(commit: Commit, synced: Map<string, SyncedFile>): void {
  for (const op of commit.ops) {
    switch (op.type) {
      case 'put':
        synced.set(op.fileId, { path: op.path, rev: commit.seq, hash: op.hash });
        break;
      case 'move': {
        const before = synced.get(op.fileId);
        if (before !== undefined)
          synced.set(op.fileId, { ...before, path: op.to, rev: commit.seq });
        break;
      }
      case 'delete':
        synced.delete(op.fileId);
        break;
    }
  }
}

/** A local file that obsy does not track yet. A conflict copy records its origin. */
interface Untracked {
  path: string;
  conflictOf?: { readonly fileId: string; readonly rev: number };
}

/**
 * One reconcile pass. Afterwards every synced file matches the head (rev,
 * path, hash); remote changes are on the device, merged into local edits
 * where needed. The returned ops are the device's remaining changes,
 * against the head.
 */
class Reconciler {
  localChanges = 0;
  conflictCopies = 0;
  skipped = 0;
  /** Head files over the size limit that the device does not hold. */
  readonly #skippedHead = new Set<string>();
  /** Current local files by path key. Updated by every local change. */
  readonly #local = new Map<string, LocalFile>();
  /** Current local path of each synced file. */
  readonly #paths = new Map<string, string>();
  /** Untracked local files by path key. */
  readonly #untracked = new Map<string, Untracked>();
  readonly #blobs = new Map<ContentHash, Uint8Array>();

  /**
   * A synced entry's `rev` and `hash` are the content base of the local
   * file; its `path` is the path base. They advance separately, each right
   * after the local change that brings it to the head, so that an
   * interrupted pass leaves a correct base: a pending remote rename is not
   * mistaken for a local one, and merged content is never merged again
   * against an older base.
   */
  constructor(
    readonly options: SyncEngineOptions,
    readonly runOptions: SyncRunOptions,
    readonly remote: RemoteVault,
    readonly head: Manifest,
    readonly synced: Map<string, SyncedFile>,
    readonly intents: Map<string, ContentIntent>,
    readonly persist: () => Promise<void>,
  ) {}

  async run(): Promise<Op[]> {
    for (const file of await this.options.local.list()) this.#local.set(pathKey(file.path), file);
    if (this.options.maxFileSize !== undefined) this.#applySizeLimit(this.options.maxFileSize);
    this.#matchSynced();
    const rails = this.options.rails;
    if (rails !== undefined && this.runOptions.allowMassDelete !== true) this.#checkRails(rails);
    await this.#applyRemoteChanges();
    await this.#applyRemoteMoves();
    await this.#applyRemoteCreates();
    return this.#ops();
  }

  // ------------------------------------------------------------ matching

  #matchSynced(): void {
    const claimed = new Set<string>();
    const missing: string[] = [];
    // A stale synced entry can share its path with a newer one (the head
    // moved it away and another file took the path). Each local file is
    // claimed once: by the entry with the same content, else the newest.
    const order = [...this.synced].sort(([a, x], [b, y]) => {
      const local = this.#local.get(pathKey(x.path));
      const xMatch = local?.hash === x.hash ? 1 : 0;
      const yMatch = this.#local.get(pathKey(y.path))?.hash === y.hash ? 1 : 0;
      if (xMatch !== yMatch) return yMatch - xMatch;
      if (x.rev !== y.rev) return y.rev - x.rev;
      return a < b ? -1 : 1;
    });
    for (const [fileId, s] of order) {
      const key = pathKey(s.path);
      if (this.#local.has(key) && !claimed.has(key)) {
        this.#paths.set(fileId, (this.#local.get(key) as LocalFile).path);
        claimed.add(key);
      } else {
        missing.push(fileId);
      }
    }
    missing.sort();
    for (const [key, file] of this.#local)
      if (!claimed.has(key)) this.#untracked.set(key, { path: file.path });

    // A missing synced file whose exact content appears at an untracked
    // path was renamed on the device. Prefer the same file name.
    for (const fileId of missing) {
      const s = this.synced.get(fileId) as SyncedFile;
      const name = s.path.slice(s.path.lastIndexOf('/') + 1);
      const candidates = [...this.#untracked.values()]
        .filter((u) => (this.#local.get(pathKey(u.path)) as LocalFile).hash === s.hash)
        .sort((a, b) => (a.path < b.path ? -1 : 1));
      const chosen =
        candidates.find((u) => u.path.endsWith(`/${name}`) || u.path === name) ?? candidates[0];
      if (chosen !== undefined) {
        this.#untracked.delete(pathKey(chosen.path));
        this.#paths.set(fileId, chosen.path);
      }
    }
  }

  // ------------------------------------------------------------ size limit

  /** Marks head files over the limit that the device does not hold: they are not downloaded. */
  #applySizeLimit(max: number): void {
    for (const [fileId, h] of this.head.liveFiles()) {
      if (!this.synced.has(fileId) && h.size > max) this.#skippedHead.add(fileId);
    }
    this.skipped = this.#skippedHead.size;
  }

  // ------------------------------------------------------------ safety rails

  /** Throws `SafetyRailError` before a pass that would delete too much. Runs before any change. */
  #checkRails(rails: SafetyRails): void {
    const maxFiles = rails.maxFiles ?? 50;
    const maxFraction = rails.maxFraction ?? 0.2;
    const minFiles = rails.minFiles ?? 10;
    const trips = (count: number, total: number): boolean =>
      count > maxFiles || (count >= minFiles && count > maxFraction * total);

    const pullOnly = this.runOptions.pullOnly === true;
    if (rails.emptyVault !== false && !pullOnly && this.#local.size === 0) {
      const synced = [...this.synced.keys()].filter((id) => this.head.file(id)?.deleted === false);
      if (synced.length > 0) throw new SafetyRailError('empty-vault', synced.length, synced.length);
    }
    let localDeletes = 0;
    let remoteDeletes = 0;
    for (const [fileId, s] of this.synced) {
      const h = this.head.file(fileId);
      if (h === undefined) continue;
      const path = this.#paths.get(fileId);
      const local = path === undefined ? undefined : this.#file(path);
      if (local === undefined) {
        if (!h.deleted && h.rev === s.rev) remoteDeletes++;
      } else if (h.deleted && h.rev !== s.rev && local.hash === s.hash && local.path === s.path) {
        localDeletes++;
      }
    }
    if (trips(localDeletes, this.#local.size)) {
      throw new SafetyRailError('local-deletes', localDeletes, this.#local.size);
    }
    const live = [...this.head.liveFiles()].length;
    if (!pullOnly && trips(remoteDeletes, live)) {
      throw new SafetyRailError('remote-deletes', remoteDeletes, live);
    }
  }

  // ------------------------------------------------------------ local changes (all conditional)

  #file(path: string): LocalFile | undefined {
    return this.#local.get(pathKey(path));
  }

  async #write(path: string, bytes: Uint8Array, expected: ContentHash | null): Promise<void> {
    if (!(await this.options.local.write(path, bytes, expected))) throw new LocalChanged();
    const hash = await hashContent(bytes);
    const old = this.#file(path);
    if (old !== undefined && old.path !== path) this.#local.delete(pathKey(old.path));
    this.#local.set(pathKey(path), { path, hash, size: bytes.length });
    this.localChanges++;
  }

  /**
   * A local write that moves a synced file's content base to `next`. The
   * intent is saved first, so that a stop between the write and the next
   * save can be settled from the file's content (see `ContentIntent`).
   */
  async #writeBase(
    fileId: string,
    path: string,
    bytes: Uint8Array,
    expected: ContentHash | null,
    next: SyncedFile,
  ): Promise<void> {
    this.intents.set(fileId, { path, expected, result: await hashContent(bytes), next });
    await this.persist();
    try {
      await this.#write(path, bytes, expected);
    } catch (error) {
      this.intents.delete(fileId);
      await this.persist();
      throw error;
    }
    this.synced.set(fileId, next);
    this.intents.delete(fileId);
    await this.persist();
  }

  async #remove(path: string, expected: ContentHash): Promise<void> {
    if (!(await this.options.local.remove(path, expected))) throw new LocalChanged();
    this.#local.delete(pathKey(path));
    this.localChanges++;
  }

  async #move(from: string, to: string, expected: ContentHash): Promise<void> {
    if (!(await this.options.local.move(from, to, expected))) throw new LocalChanged();
    const file = this.#file(from) as LocalFile;
    this.#local.delete(pathKey(from));
    this.#local.set(pathKey(to), { ...file, path: to });
    this.localChanges++;
  }

  async #blob(hash: ContentHash): Promise<Uint8Array> {
    let bytes = this.#blobs.get(hash);
    if (bytes === undefined) {
      if (this.runOptions.shouldStop?.() === true) throw new SyncStopped();
      bytes = await this.remote.getBlob(hash);
      this.#blobs.set(hash, bytes);
    }
    return bytes;
  }

  #conflictPath(path: string): string {
    return freeConflictCopyPath(
      path,
      this.options.deviceName,
      this.options.env.now(),
      (key) => this.#local.has(key) || this.head.liveAt(key) !== undefined,
    );
  }

  /** Moves an untracked local file out of the way, to a conflict copy name. */
  async #yieldUntracked(key: string, conflictOf?: { fileId: string; rev: number }): Promise<void> {
    const untracked = this.#untracked.get(key) as Untracked;
    const file = this.#local.get(key) as LocalFile;
    const to = this.#conflictPath(file.path);
    await this.#move(file.path, to, file.hash);
    this.#untracked.delete(key);
    const origin = untracked.conflictOf ?? conflictOf;
    this.#untracked.set(
      pathKey(to),
      origin === undefined ? { path: to } : { path: to, conflictOf: origin },
    );
    this.conflictCopies++;
  }

  /**
   * Frees `path` on the device for a head file. An untracked file there
   * yields to a conflict copy name. A synced file there was renamed onto
   * this path by the device (the head has another file here); it yields
   * to a conflict copy name too and stays synced, so its rename is
   * committed to the new name.
   */
  async #makeRoom(path: string): Promise<void> {
    const key = pathKey(path);
    const occupant = this.#local.get(key);
    if (occupant === undefined) return;
    if (this.#untracked.has(key)) {
      await this.#yieldUntracked(key);
      return;
    }
    const owner = [...this.#paths].find(([, p]) => pathKey(p) === key)?.[0];
    const to = this.#conflictPath(occupant.path);
    await this.#move(occupant.path, to, occupant.hash);
    if (owner !== undefined) this.#paths.set(owner, to);
  }

  // ------------------------------------------------------------ remote changes to synced files

  /**
   * Brings each synced file's content up to the head, merging into local
   * edits. Path changes are done afterwards in `#applyRemoteMoves`.
   */
  async #applyRemoteChanges(): Promise<void> {
    for (const [fileId, s] of [...this.synced].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const h = this.head.file(fileId);
      if (h === undefined) {
        this.synced.delete(fileId);
        continue;
      }
      const path = this.#paths.get(fileId);
      const local = path === undefined ? undefined : this.#file(path);

      if (local === undefined) {
        // Deleted on the device.
        if (h.rev === s.rev) continue; // a delete op, built in #ops
        if (h.deleted) {
          this.synced.delete(fileId);
          continue;
        }
        // Edited or moved remotely: edit beats delete. Restore the head version.
        if (this.#local.has(pathKey(h.path))) await this.#makeRoom(h.path);
        await this.#writeBase(fileId, h.path, await this.#blob(h.hash), null, {
          path: h.path,
          rev: h.rev,
          hash: h.hash,
        });
        this.#paths.set(fileId, h.path);
        continue;
      }

      const localChanged = local.hash !== s.hash || local.path !== s.path;
      if (h.rev === s.rev) continue; // content base is the head; paths in #applyRemoteMoves
      if (h.deleted) {
        if (!localChanged) {
          await this.#remove(local.path, s.hash);
          this.#paths.delete(fileId);
        } else {
          // Changed on the device, deleted remotely: edit beats delete. The
          // local file becomes a new file.
          this.#paths.delete(fileId);
          this.#untracked.set(pathKey(local.path), { path: local.path });
        }
        this.synced.delete(fileId);
        continue;
      }

      // Both sides live. Content now (the content base becomes the head),
      // path in #applyRemoteMoves.
      await this.#mergeContent(fileId, s, h, local);
      if (this.synced.get(fileId)?.rev !== h.rev) {
        this.synced.set(fileId, { path: s.path, rev: h.rev, hash: h.hash });
      }
    }
  }

  async #mergeContent(
    fileId: string,
    s: SyncedFile,
    h: FileEntry,
    local: LocalFile,
  ): Promise<void> {
    const base = s.hash;
    const ours = local.hash;
    const theirs = h.hash;
    const next: SyncedFile = { path: s.path, rev: h.rev, hash: h.hash };
    if (theirs === base || ours === theirs) return;
    if (ours === base) {
      await this.#writeBase(fileId, local.path, await this.#blob(theirs), ours, next);
      return;
    }
    const oursBytes = await this.options.local.read(local.path);
    if (oursBytes === null || (await hashContent(oursBytes)) !== ours) throw new LocalChanged();
    if (isMergeable(local.path) && isMergeable(h.path)) {
      const texts = [
        decodeText(await this.#blob(base)),
        decodeText(oursBytes),
        decodeText(await this.#blob(theirs)),
      ];
      const [b, o, t] = texts;
      if (
        b !== null &&
        b !== undefined &&
        o !== null &&
        o !== undefined &&
        t !== null &&
        t !== undefined
      ) {
        const result = merge3({ base: b, ours: o, theirs: t });
        if (result.status === 'clean') {
          await this.#writeBase(fileId, local.path, encodeUtf8(result.text), ours, next);
          return;
        }
      }
    }
    // Not mergeable, or the merge conflicts: keep theirs at the path and ours as a conflict copy.
    const copy = this.#conflictPath(h.path);
    await this.#write(copy, oursBytes, null);
    this.#untracked.set(pathKey(copy), { path: copy, conflictOf: { fileId, rev: h.rev } });
    this.conflictCopies++;
    await this.#writeBase(fileId, local.path, await this.#blob(theirs), ours, next);
  }

  // ------------------------------------------------------------ remote moves

  /**
   * Moves synced files to their head path where the head renamed them.
   * When the device also renamed a file, the head's path wins. Moves wait
   * for each other; a cycle goes through a temporary name.
   */
  async #applyRemoteMoves(): Promise<void> {
    const wanted = new Map<string, string>();
    for (const [fileId, s] of this.synced) {
      const h = this.head.file(fileId);
      const path = this.#paths.get(fileId);
      if (h === undefined || h.deleted || path === undefined || h.path === s.path) continue;
      if (path === h.path) {
        // Moved already, by an earlier pass that stopped before recording it.
        this.synced.set(fileId, { ...s, path: h.path });
      } else {
        wanted.set(fileId, h.path);
      }
    }
    let progress = true;
    while (wanted.size > 0) {
      if (!progress) {
        // A cycle: move one file to a temporary name.
        const [fileId] = [...wanted.keys()].sort();
        const from = this.#paths.get(fileId as string) as string;
        const temp = this.#conflictPath(`${from}.obsy-move`);
        await this.#move(from, temp, (this.#file(from) as LocalFile).hash);
        this.#paths.set(fileId as string, temp);
      }
      progress = false;
      for (const [fileId, target] of [...wanted].sort(([a], [b]) => (a < b ? -1 : 1))) {
        const from = this.#paths.get(fileId) as string;
        const key = pathKey(target);
        const occupant = this.#local.get(key);
        if (occupant !== undefined && pathKey(occupant.path) !== pathKey(from)) {
          if (this.#untracked.has(key)) {
            await this.#yieldUntracked(key);
          } else {
            const owner = [...this.#paths].find(([, p]) => pathKey(p) === key)?.[0];
            if (owner !== undefined && wanted.has(owner)) continue; // wait for it to move away
            if (owner !== undefined) {
              // A synced file sits where the head wants this one and does not
              // move: the device renamed it there. It yields.
              const to = this.#conflictPath(occupant.path);
              await this.#move(occupant.path, to, occupant.hash);
              this.#paths.set(owner, to);
            }
          }
        }
        await this.#move(from, target, (this.#file(from) as LocalFile).hash);
        this.#paths.set(fileId, target);
        const s = this.synced.get(fileId) as SyncedFile;
        this.synced.set(fileId, { ...s, path: target });
        wanted.delete(fileId);
        progress = true;
      }
    }
  }

  // ------------------------------------------------------------ remote creates

  /** Writes head files that the device does not track yet, resolving untracked files at the same path. */
  async #applyRemoteCreates(): Promise<void> {
    const files = [...this.head.liveFiles()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [fileId, h] of files) {
      if (this.synced.has(fileId)) continue;
      const key = pathKey(h.path);
      const occupant = this.#local.get(key);
      if (this.#skippedHead.has(fileId)) {
        // Not downloaded. A local file at its path yields to a conflict copy
        // name, as it would to a downloaded file, so that it can be sent.
        if (occupant !== undefined && this.#untracked.has(key)) {
          await this.#yieldUntracked(key, { fileId, rev: h.rev });
        } else if (occupant !== undefined) {
          await this.#makeRoom(h.path);
        }
        continue;
      }
      if (occupant === undefined) {
        await this.#write(h.path, await this.#blob(h.hash), null);
        this.#paths.set(fileId, h.path);
        this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
        continue;
      }
      const untracked = this.#untracked.get(key);
      if (untracked === undefined) {
        // A synced file that the device renamed onto this path. It yields.
        await this.#makeRoom(h.path);
        await this.#write(h.path, await this.#blob(h.hash), null);
        this.#paths.set(fileId, h.path);
        this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
        continue;
      }
      if (occupant.hash === h.hash) {
        // Same content on both sides: adopt it.
        if (occupant.path !== h.path) await this.#move(occupant.path, h.path, occupant.hash);
        this.#untracked.delete(key);
        this.#paths.set(fileId, h.path);
        this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
        continue;
      }
      if (untracked.conflictOf === undefined && isMergeable(h.path) && isMergeable(occupant.path)) {
        // Created on both sides with no common base: merge only if one extends the other.
        const oursBytes = await this.options.local.read(occupant.path);
        if (oursBytes === null || (await hashContent(oursBytes)) !== occupant.hash)
          throw new LocalChanged();
        const o = decodeText(oursBytes);
        const t = decodeText(await this.#blob(h.hash));
        if (o !== null && t !== null) {
          const result = merge3({ base: null, ours: o, theirs: t });
          if (result.status === 'clean') {
            await this.#write(occupant.path, encodeUtf8(result.text), occupant.hash);
            if (occupant.path !== h.path) {
              await this.#move(
                occupant.path,
                h.path,
                (this.#file(occupant.path) as LocalFile).hash,
              );
            }
            this.#untracked.delete(key);
            this.#paths.set(fileId, h.path);
            this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
            continue;
          }
        }
      }
      await this.#yieldUntracked(key, { fileId, rev: h.rev });
      await this.#write(h.path, await this.#blob(h.hash), null);
      this.#paths.set(fileId, h.path);
      this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
    }
  }

  // ------------------------------------------------------------ ops

  /** The device's remaining changes against the head. */
  #ops(): Op[] {
    const max = this.options.maxOpsPerCommit ?? 500;
    const ops: Op[] = [];
    for (const [fileId, s] of [...this.synced].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ops.length >= max) break;
      const h = this.head.file(fileId);
      if (h === undefined || h.deleted || h.rev !== s.rev) continue;
      const path = this.#paths.get(fileId);
      const local = path === undefined ? undefined : this.#file(path);
      if (local === undefined) {
        ops.push({ type: 'delete', fileId, path: h.path, baseRev: h.rev });
      } else {
        // The device renamed the file only if the head kept the path base.
        // Otherwise a remote rename is still to be applied on the device.
        const renamed = local.path !== h.path && h.path === s.path;
        if (renamed) {
          // One op per file per commit: move now, put the content next commit.
          ops.push({ type: 'move', fileId, from: h.path, to: local.path, baseRev: h.rev });
        } else if (local.hash !== h.hash && local.path === h.path) {
          // (A file still waiting for a remote rename commits its content
          // after the rename: the upload reads the file at its head path.)
          ops.push({
            type: 'put',
            fileId,
            path: h.path,
            baseRev: h.rev,
            hash: local.hash,
            size: local.size,
          });
        }
      }
    }
    // Paths that this commit frees: a new file or a move may take them.
    const leaving = new Set(ops.filter((op) => op.type !== 'put').map((op) => op.fileId));
    for (let i = ops.length - 1; i >= 0; i--) {
      const op = ops[i] as Op;
      if (op.type !== 'move') continue;
      const owner = this.head.liveAt(op.to);
      if (owner !== undefined && owner !== op.fileId && !leaving.has(owner)) ops.splice(i, 1);
    }
    for (const [, untracked] of [...this.#untracked].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (ops.length >= max) break;
      const local = this.#file(untracked.path) as LocalFile;
      const owner = this.head.liveAt(local.path);
      if (owner !== undefined && !leaving.has(owner)) continue; // resolved in a later pass
      const op: Op =
        untracked.conflictOf !== undefined &&
        this.head.file(untracked.conflictOf.fileId) !== undefined
          ? {
              type: 'put',
              fileId: this.options.env.newFileId(),
              path: local.path,
              baseRev: null,
              hash: local.hash,
              size: local.size,
              conflictOf: untracked.conflictOf,
            }
          : {
              type: 'put',
              fileId: this.options.env.newFileId(),
              path: local.path,
              baseRev: null,
              hash: local.hash,
              size: local.size,
            };
      ops.push(op);
    }
    return ops;
  }
}
