import type { ContentHash, FileEntry } from '@obsy/protocol';

/**
 * What the sync engine needs from its host. The Obsidian plugin implements
 * these on the vault and IndexedDB; the simulator implements them in
 * memory. See docs/subsystems/protocol.md#sync-engine.
 */

/** One file on the device. */
export interface LocalFile {
  readonly path: string;
  readonly hash: ContentHash;
  readonly size: number;
}

/**
 * The device's files. Every change is conditional on the file's current
 * content, so that the engine never overwrites an edit it has not seen.
 * A conditional call returns false, and changes nothing, when the
 * condition does not hold.
 *
 * Paths are vault paths. Two files never share a path key (NFC plus lower
 * case), as on macOS and iOS.
 */
export interface LocalFiles {
  /** Every file, with its content hash. */
  list(): Promise<LocalFile[]>;
  /** The file's bytes, or null when it does not exist. */
  read(path: string): Promise<Uint8Array | null>;
  /**
   * Writes the file only if its current content hash is `expected`, or, with
   * `expected` null, only if no file has the same path key.
   */
  write(path: string, bytes: Uint8Array, expected: ContentHash | null): Promise<boolean>;
  /** Removes the file only if its content hash is `expected`. The plugin moves it to the trash. */
  remove(path: string, expected: ContentHash): Promise<boolean>;
  /** Renames the file only if its content hash is `expected` and no other file has the target's path key. */
  move(from: string, to: string, expected: ContentHash): Promise<boolean>;
}

/** What the device last synced for one file: the base of its local edits. */
export interface SyncedFile {
  readonly path: string;
  readonly rev: number;
  readonly hash: ContentHash;
}

/** A commit that was sent but whose outcome is not known yet. */
export interface PendingClaim {
  readonly seq: number;
  /** The exact bytes sent, so that a retry is identical. */
  readonly body: string;
  readonly opId: string;
}

/**
 * A local write that changes a file's base, recorded before the write. If
 * the device stops between the write and the next save, the file's content
 * tells whether the write happened: `result` means yes, `expected` means
 * no. Anything else means the user edited the file since; the engine then
 * keeps that version as a conflict copy instead of guessing its base.
 */
export interface ContentIntent {
  /** Where the write goes. */
  readonly path: string;
  /** The content hash the write required (null: no file at the path). */
  readonly expected: ContentHash | null;
  /** The content hash after the write. */
  readonly result: ContentHash;
  /** The synced entry once the write has happened. */
  readonly next: SyncedFile;
}

/** The device's durable sync state. */
export interface DeviceState {
  readonly vaultId: string;
  readonly epoch: number;
  /** The checkpoint form of the head manifest at `head.seq` (the cursor). */
  readonly head: {
    readonly seq: number;
    readonly files: Readonly<Record<string, FileEntry>>;
  };
  /** Synced files by file ID. */
  readonly synced: Readonly<Record<string, SyncedFile>>;
  readonly pending: PendingClaim | null;
  /** Local writes in progress, by file ID. Missing in state saved before intents existed. */
  readonly intents?: Readonly<Record<string, ContentIntent>>;
}

/** Durable storage for `DeviceState`. `save` must be atomic. */
export interface StateStore {
  load(): Promise<DeviceState | null>;
  save(state: DeviceState): Promise<void>;
}

/** Time, randomness, and waiting, injectable for deterministic tests. */
export interface Environment {
  now(): Date;
  /** A number in [0, 1). */
  random(): number;
  sleep(ms: number): Promise<void>;
  newFileId(): string;
  newOpId(actorId: string): string;
}
