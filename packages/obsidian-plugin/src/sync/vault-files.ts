import type { LocalFile, LocalFiles } from '@obsy/core';
import { decodeUtf8Strict, hashContent, pathKey, type ContentHash } from '@obsy/protocol';

import type { VaultPort } from './vault-port';

/** A file's hash, valid while its size and mtime stay the same. */
export interface HashCacheEntry {
  readonly size: number;
  readonly mtime: number;
  readonly hash: ContentHash;
}

/** Downloads are written here first, then renamed into place. */
export const TEMP_SUFFIX = '.obsy-tmp';

/** How long a vault event for a path that obsy wrote counts as obsy's own. */
const OWN_CHANGE_MS = 5000;

export interface VaultLocalFilesOptions {
  /** Paths that obsy does not sync. */
  readonly exclude?: (path: string) => boolean;
  /** Milliseconds since the epoch. */
  readonly now?: () => number;
}

/** The smallest single replacement that turns `before` into `after`, or null when they are equal. */
export function minimalEdit(
  before: string,
  after: string,
): { from: number; to: number; text: string } | null {
  if (before === after) return null;
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before.charCodeAt(start) === after.charCodeAt(start)) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)
  ) {
    endBefore--;
    endAfter--;
  }
  // Never split a surrogate pair.
  if (start > 0 && isHighSurrogate(before.charCodeAt(start - 1))) start--;
  if (endBefore < before.length && isLowSurrogate(before.charCodeAt(endBefore))) {
    endBefore++;
    endAfter++;
  }
  return { from: start, to: endBefore, text: after.slice(start, endAfter) };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** UTF-8 text that Obsidian reads and writes unchanged: valid, no byte order mark. */
function plainText(bytes: Uint8Array): string | null {
  try {
    const text = decodeUtf8Strict(bytes);
    return text.startsWith('﻿') ? null : text;
  } catch {
    return null;
  }
}

/**
 * `LocalFiles` on an Obsidian vault. Every change first reads the file and
 * checks its content hash, then writes in the way that is safest for the
 * file's state:
 *
 * - a note open in an editor gets one minimal editor transaction, then the
 *   editor saves; a note with unsaved edits fails the condition;
 * - other text goes through `processText` (Obsidian's `vault.process`),
 *   which writes only if the text is still what was hashed;
 * - other files are written with `modifyBinary`;
 * - new files are written to a temporary path and renamed into place;
 * - removals follow the user's deletion preference (usually a trash).
 */
export class VaultLocalFiles implements LocalFiles {
  readonly #port: VaultPort;
  readonly #exclude: (path: string) => boolean;
  readonly #now: () => number;
  readonly #hashes = new Map<string, HashCacheEntry>();
  #cacheChanged = false;
  /**
   * Path keys of indexed files to their paths. Rebuilt by every `list`, so
   * that a stale entry costs at most one pass; kept up to date by obsy's own
   * changes, and dropped on any other vault event.
   */
  #index: Map<string, string> | null = null;
  readonly #ownChanges = new Map<string, number>();
  /** Paths left out of the last list because another file had the same path key. */
  twins: string[] = [];

  constructor(port: VaultPort, options: VaultLocalFilesOptions = {}) {
    this.#port = port;
    this.#exclude = options.exclude ?? (() => false);
    this.#now = options.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------ hash cache

  /** Loads saved hashes. Each is used only while the file's size and mtime match. */
  importHashes(entries: Readonly<Record<string, HashCacheEntry>>): void {
    for (const [path, entry] of Object.entries(entries)) this.#hashes.set(path, entry);
  }

  /** The hashes to save, or null when they did not change since the last call. */
  takeChangedHashes(): Record<string, HashCacheEntry> | null {
    if (!this.#cacheChanged) return null;
    this.#cacheChanged = false;
    return Object.fromEntries(this.#hashes);
  }

  // ------------------------------------------------------------ vault events

  /**
   * Called for every vault event. Returns true when the event is obsy's own
   * write. Any other event invalidates the path index.
   */
  noteVaultEvent(path: string): boolean {
    const key = pathKey(path);
    const until = this.#ownChanges.get(key);
    if (until !== undefined && until >= this.#now()) return true;
    this.#ownChanges.delete(key);
    this.#index = null;
    return false;
  }

  #markOwn(path: string): void {
    this.#ownChanges.set(pathKey(path), this.#now() + OWN_CHANGE_MS);
  }

  #isSynced(path: string): boolean {
    return !path.endsWith(TEMP_SUFFIX) && !this.#exclude(path);
  }

  #pathIndex(): Map<string, string> {
    if (this.#index === null) {
      this.#index = new Map();
      for (const file of this.#port.files()) this.#index.set(pathKey(file.path), file.path);
    }
    return this.#index;
  }

  /**
   * Runs a vault change that may fail because the user changed the vault
   * since the check: a file is gone, or a target path is taken. Such a
   * failure means that the condition no longer holds, so it returns false.
   */
  async #attempt(action: () => Promise<void>, raced: () => Promise<boolean>): Promise<boolean> {
    try {
      await action();
      return true;
    } catch (error) {
      if (await raced()) return false;
      throw error;
    }
  }

  #gone(path: string): () => Promise<boolean> {
    return () => Promise.resolve(this.#port.file(path) === null);
  }

  // ------------------------------------------------------------ LocalFiles

  async list(): Promise<LocalFile[]> {
    const files = this.#port
      .files()
      .filter((file) => this.#isSynced(file.path))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const seen = new Set<string>();
    const out: LocalFile[] = [];
    const twins: string[] = [];
    const present = new Set<string>();
    this.#index = null;
    this.#pathIndex();
    for (const file of files) {
      const key = pathKey(file.path);
      if (seen.has(key)) {
        twins.push(file.path);
        continue;
      }
      seen.add(key);
      present.add(file.path);
      let hash = this.#cachedHash(file.path, file.size, file.mtime);
      if (hash === undefined) {
        let bytes: Uint8Array;
        try {
          bytes = await this.#port.readBinary(file.path);
        } catch {
          continue; // removed since the index was read
        }
        hash = await hashContent(bytes);
        // The index may lag a write; cache only what matches the read.
        if (bytes.length === file.size) {
          this.#hashes.set(file.path, { size: file.size, mtime: file.mtime, hash });
          this.#cacheChanged = true;
        }
        out.push({ path: file.path, hash, size: bytes.length });
        continue;
      }
      out.push({ path: file.path, hash, size: file.size });
    }
    for (const path of this.#hashes.keys()) {
      if (!present.has(path)) {
        this.#hashes.delete(path);
        this.#cacheChanged = true;
      }
    }
    this.twins = twins;
    return out;
  }

  #cachedHash(path: string, size: number, mtime: number): ContentHash | undefined {
    const entry = this.#hashes.get(path);
    return entry !== undefined && entry.size === size && entry.mtime === mtime
      ? entry.hash
      : undefined;
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (this.#port.file(path) === null) return null;
    try {
      return await this.#port.readBinary(path);
    } catch {
      return null;
    }
  }

  /**
   * The file's bytes when its content hash is `expected`, else null. Also
   * null when the file's size or mtime changed while it was read and
   * hashed: the user saved meanwhile.
   */
  async #readIf(path: string, expected: ContentHash): Promise<Uint8Array | null> {
    const before = this.#port.file(path);
    const bytes = await this.read(path);
    if (before === null || bytes === null) return null;
    if ((await hashContent(bytes)) !== expected) return null;
    const after = this.#port.file(path);
    if (after === null || after.size !== before.size || after.mtime !== before.mtime) return null;
    return bytes;
  }

  async write(path: string, bytes: Uint8Array, expected: ContentHash | null): Promise<boolean> {
    if (expected === null) return this.#create(path, bytes);
    const current = await this.#readIf(path, expected);
    if (current === null) return false;
    const before = plainText(current);
    const after = plainText(bytes);
    if (before === null || after === null) {
      this.#markOwn(path);
      return this.#attempt(() => this.#port.modifyBinary(path, bytes), this.#gone(path));
    }
    const editor = this.#port.editor(path);
    // CodeMirror holds CRLF text with LF, so such notes are written on disk instead.
    if (editor !== null && !before.includes('\r') && !after.includes('\r')) {
      if (editor.getText() !== before) return false; // unsaved edits
      const edit = minimalEdit(before, after);
      this.#markOwn(path);
      if (edit !== null) editor.replace(edit.from, edit.to, edit.text);
      await editor.save();
      const saved = await this.read(path);
      if (saved !== null && (await hashContent(saved)) === expected) {
        // The editor did not write the file: write it on disk.
        return this.#process(path, before, after);
      }
      return true;
    }
    return this.#process(path, before, after);
  }

  async #process(path: string, before: string, after: string): Promise<boolean> {
    let applied = false;
    this.#markOwn(path);
    const done = await this.#attempt(
      () =>
        this.#port.processText(path, (text) => {
          if (text !== before) return text;
          applied = true;
          return after;
        }),
      this.#gone(path),
    );
    return done && applied;
  }

  async #create(path: string, bytes: Uint8Array): Promise<boolean> {
    const key = pathKey(path);
    if (this.#pathIndex().has(key) || (await this.#port.exists(path))) return false;
    const temp = `${path}${TEMP_SUFFIX}`;
    if (this.#port.file(temp) !== null || (await this.#port.exists(temp))) {
      this.#markOwn(temp);
      await this.#port.trash(temp);
    }
    this.#markOwn(temp);
    this.#markOwn(path);
    await this.#port.createBinary(temp, bytes);
    const renamed = await this.#attempt(
      () => this.#port.rename(temp, path),
      async () => this.#port.file(temp) === null || (await this.#port.exists(path)),
    );
    if (!renamed) {
      if (this.#port.file(temp) !== null) await this.#port.trash(temp);
      return false;
    }
    this.#pathIndex().set(key, path);
    return true;
  }

  async remove(path: string, expected: ContentHash): Promise<boolean> {
    const current = await this.#readIf(path, expected);
    if (current === null) return false;
    const editor = this.#port.editor(path);
    if (editor !== null) {
      const text = plainText(current);
      if (text === null || editor.getText() !== text) return false;
    }
    this.#markOwn(path);
    if (!(await this.#attempt(() => this.#port.trash(path), this.#gone(path)))) return false;
    this.#pathIndex().delete(pathKey(path));
    return true;
  }

  async move(from: string, to: string, expected: ContentHash): Promise<boolean> {
    const current = await this.#readIf(from, expected);
    if (current === null) return false;
    const fromKey = pathKey(from);
    const toKey = pathKey(to);
    if (toKey !== fromKey) {
      if (this.#pathIndex().has(toKey) || (await this.#port.exists(to))) return false;
    }
    this.#markOwn(from);
    this.#markOwn(to);
    const moved = await this.#attempt(
      () => this.#port.rename(from, to),
      async () =>
        this.#port.file(from) === null || (toKey !== fromKey && (await this.#port.exists(to))),
    );
    if (!moved) return false;
    const index = this.#pathIndex();
    index.delete(fromKey);
    index.set(toKey, to);
    return true;
  }

  /** Moves leftover temporary files from an interrupted download to the trash. */
  async removeLeftovers(): Promise<number> {
    let removed = 0;
    for (const file of this.#port.files()) {
      if (!file.path.endsWith(TEMP_SUFFIX)) continue;
      this.#markOwn(file.path);
      await this.#port.trash(file.path);
      removed++;
    }
    return removed;
  }
}
