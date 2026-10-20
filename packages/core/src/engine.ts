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
}

export interface SyncReport {
  /** Commits this device made. */
  readonly commits: number;
  /** Local writes, moves, and removals this device made. */
  readonly localChanges: number;
  /** Conflict copies this device created. */
  readonly conflictCopies: number;
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

  async sync(): Promise<SyncReport> {
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
    const counters = { commits: 0, localChanges: 0, conflictCopies: 0 };
    const save = async (pending: PendingClaim | null): Promise<void> => {
      const checkpoint = manifest.toCheckpoint();
      await this.#options.state.save({
        vaultId: vault.vaultId,
        epoch: vault.epoch,
        head: { seq: checkpoint.seq, files: checkpoint.files },
        synced: Object.fromEntries(synced),
        pending,
      });
    };

    if (state.pending !== null) {
      await this.#resolvePending(state.pending, manifest, synced);
      await save(null);
    }

    const maxPasses = this.#options.maxPasses ?? 20;
    for (let pass = 0; pass < maxPasses; pass++) {
      await this.#remote.catchUp(manifest);
      const reconciler = new Reconciler(this.#options, this.#remote, manifest, synced);
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
      await save(null);
      if (ops.length === 0) {
        if (reconciler.localChanges === 0) return { ...counters, settled: true };
        continue;
      }

      const commit = await this.#prepare(manifest, ops);
      if (commit === null) continue;
      const body = JSON.stringify(commit);
      const pending: PendingClaim = { seq: commit.seq, body, opId: commit.opId };
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
  async #prepare(manifest: Manifest, ops: Op[]): Promise<Commit | null> {
    for (const op of ops) {
      if (op.type !== 'put') continue;
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
  /** Current local files by path key. Updated by every local change. */
  readonly #local = new Map<string, LocalFile>();
  /** Current local path of each synced file. */
  readonly #paths = new Map<string, string>();
  /** Untracked local files by path key. */
  readonly #untracked = new Map<string, Untracked>();
  readonly #blobs = new Map<ContentHash, Uint8Array>();
  /**
   * Files whose content now matches the head, waiting for their path. They
   * become synced only when the path matches too, so that an interrupted
   * pass cannot mistake a pending remote rename for a local one.
   */
  readonly #ready = new Map<string, FileEntry>();

  constructor(
    readonly options: SyncEngineOptions,
    readonly remote: RemoteVault,
    readonly head: Manifest,
    readonly synced: Map<string, SyncedFile>,
  ) {}

  async run(): Promise<Op[]> {
    for (const file of await this.options.local.list()) this.#local.set(pathKey(file.path), file);
    this.#matchSynced();
    await this.#applyRemoteChanges();
    await this.#applyRemoteMoves();
    await this.#applyRemoteCreates();
    return this.#ops();
  }

  // ------------------------------------------------------------ matching

  #matchSynced(): void {
    const claimed = new Set<string>();
    const missing: string[] = [];
    for (const [fileId, s] of [...this.synced].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const key = pathKey(s.path);
      if (this.#local.has(key)) {
        this.#paths.set(fileId, (this.#local.get(key) as LocalFile).path);
        claimed.add(key);
      } else {
        missing.push(fileId);
      }
    }
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
        const occupant = this.#local.get(pathKey(h.path));
        if (occupant !== undefined) {
          if (!this.#untracked.has(pathKey(h.path))) continue; // resolved in a later pass
          await this.#yieldUntracked(pathKey(h.path));
        }
        await this.#write(h.path, await this.#blob(h.hash), null);
        this.#paths.set(fileId, h.path);
        this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
        continue;
      }

      const localChanged = local.hash !== s.hash || local.path !== s.path;
      if (h.rev === s.rev) continue; // no remote change; local changes become ops
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

      // Both sides live. Content now, path in #applyRemoteMoves.
      await this.#mergeContent(fileId, s, h, local);
      this.#ready.set(fileId, h);
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
    if (theirs === base || ours === theirs) return;
    if (ours === base) {
      await this.#write(local.path, await this.#blob(theirs), ours);
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
          await this.#write(local.path, encodeUtf8(result.text), ours);
          return;
        }
      }
    }
    // Not mergeable, or the merge conflicts: keep theirs at the path and ours as a conflict copy.
    const copy = this.#conflictPath(h.path);
    await this.#write(copy, oursBytes, null);
    this.#untracked.set(pathKey(copy), { path: copy, conflictOf: { fileId, rev: h.rev } });
    this.conflictCopies++;
    await this.#write(local.path, await this.#blob(theirs), ours);
  }

  // ------------------------------------------------------------ remote moves

  /**
   * Moves synced files to their head path where the head renamed them.
   * When the device also renamed a file, the head's path wins. Moves wait
   * for each other; a cycle goes through a temporary name.
   */
  async #applyRemoteMoves(): Promise<void> {
    const wanted = new Map<string, string>();
    for (const [fileId, h] of this.#ready) {
      const s = this.synced.get(fileId) as SyncedFile;
      const path = this.#paths.get(fileId) as string;
      if (h.path !== s.path && path !== h.path) wanted.set(fileId, h.path);
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
        wanted.delete(fileId);
        progress = true;
      }
    }
    for (const [fileId, h] of this.#ready)
      this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
    this.#ready.clear();
  }

  // ------------------------------------------------------------ remote creates

  /** Writes head files that the device does not track yet, resolving untracked files at the same path. */
  async #applyRemoteCreates(): Promise<void> {
    const files = [...this.head.liveFiles()].sort(([a], [b]) => (a < b ? -1 : 1));
    for (const [fileId, h] of files) {
      if (this.synced.has(fileId)) continue;
      const key = pathKey(h.path);
      const occupant = this.#local.get(key);
      if (occupant === undefined) {
        await this.#write(h.path, await this.#blob(h.hash), null);
        this.#paths.set(fileId, h.path);
        this.synced.set(fileId, { path: h.path, rev: h.rev, hash: h.hash });
        continue;
      }
      const untracked = this.#untracked.get(key);
      if (untracked === undefined) {
        // A synced file that the device renamed onto this path. It yields.
        const owner = [...this.#paths].find(([, p]) => pathKey(p) === key)?.[0];
        if (owner === undefined) continue;
        const to = this.#conflictPath(occupant.path);
        await this.#move(occupant.path, to, occupant.hash);
        this.#paths.set(owner, to);
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
      } else if (local.hash !== h.hash) {
        if (local.path !== h.path) {
          // One op per file per commit: move now, put the content next commit.
          ops.push({ type: 'move', fileId, from: h.path, to: local.path, baseRev: h.rev });
        } else {
          ops.push({
            type: 'put',
            fileId,
            path: h.path,
            baseRev: h.rev,
            hash: local.hash,
            size: local.size,
          });
        }
      } else if (local.path !== h.path) {
        ops.push({ type: 'move', fileId, from: h.path, to: local.path, baseRev: h.rev });
      }
    }
    // Paths that this commit frees: a new file may take them.
    const leaving = new Set(ops.filter((op) => op.type !== 'put').map((op) => op.fileId));
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
