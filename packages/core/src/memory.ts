import { hashContent, pathKey, type ContentHash } from '@obsy/protocol';

import type { DeviceState, Environment, LocalFile, LocalFiles, StateStore } from './host';

interface StoredFile {
  path: string;
  bytes: Uint8Array;
  hash: ContentHash;
}

/**
 * Local files in memory, with the conditional semantics of `LocalFiles`.
 * Paths that share a path key are the same file, as on macOS and iOS.
 * Tests and the simulator use it; so can a headless agent.
 */
export class MemoryLocalFiles implements LocalFiles {
  readonly #files = new Map<string, StoredFile>();

  /** Called before each engine call; tests use it to interleave edits. */
  constructor(readonly beforeEach: () => Promise<void> = () => Promise.resolve()) {}

  async list(): Promise<LocalFile[]> {
    await this.beforeEach();
    return [...this.#files.values()].map((f) => ({
      path: f.path,
      hash: f.hash,
      size: f.bytes.length,
    }));
  }

  async read(path: string): Promise<Uint8Array | null> {
    await this.beforeEach();
    const file = this.#files.get(pathKey(path));
    return file === undefined ? null : file.bytes.slice();
  }

  async write(path: string, bytes: Uint8Array, expected: ContentHash | null): Promise<boolean> {
    await this.beforeEach();
    const key = pathKey(path);
    const current = this.#files.get(key);
    if (expected === null ? current !== undefined : current?.hash !== expected) return false;
    this.#files.set(key, { path, bytes: bytes.slice(), hash: await hashContent(bytes) });
    return true;
  }

  async remove(path: string, expected: ContentHash): Promise<boolean> {
    await this.beforeEach();
    const key = pathKey(path);
    if (this.#files.get(key)?.hash !== expected) return false;
    this.#files.delete(key);
    return true;
  }

  async move(from: string, to: string, expected: ContentHash): Promise<boolean> {
    await this.beforeEach();
    const fromKey = pathKey(from);
    const toKey = pathKey(to);
    const file = this.#files.get(fromKey);
    if (file?.hash !== expected) return false;
    if (toKey !== fromKey && this.#files.has(toKey)) return false;
    this.#files.delete(fromKey);
    this.#files.set(toKey, { ...file, path: to });
    return true;
  }

  // Direct access for tests and simulated users. Not conditional.

  async userWrite(path: string, bytes: Uint8Array): Promise<void> {
    const key = pathKey(path);
    const existing = this.#files.get(key);
    this.#files.set(key, {
      path: existing?.path ?? path,
      bytes: bytes.slice(),
      hash: await hashContent(bytes),
    });
  }

  userRemove(path: string): boolean {
    return this.#files.delete(pathKey(path));
  }

  /** Renames like Obsidian does: refuses when the target exists. */
  userMove(from: string, to: string): boolean {
    const file = this.#files.get(pathKey(from));
    if (file === undefined) return false;
    if (pathKey(from) !== pathKey(to) && this.#files.has(pathKey(to))) return false;
    this.#files.delete(pathKey(from));
    this.#files.set(pathKey(to), { ...file, path: to });
    return true;
  }

  get(path: string): Uint8Array | undefined {
    return this.#files.get(pathKey(path))?.bytes.slice();
  }

  /** Path to content, sorted by path. */
  snapshot(): Map<string, Uint8Array> {
    return new Map(
      [...this.#files.values()]
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .map((f) => [f.path, f.bytes.slice()]),
    );
  }
}

/** A `StateStore` in memory. `crash` drops nothing: saves are atomic and durable. */
export class MemoryStateStore implements StateStore {
  #state: string | null = null;
  saves = 0;

  load(): Promise<DeviceState | null> {
    return Promise.resolve(this.#state === null ? null : (JSON.parse(this.#state) as DeviceState));
  }

  save(state: DeviceState): Promise<void> {
    this.#state = JSON.stringify(state);
    this.saves++;
    return Promise.resolve();
  }
}

/** An `Environment` driven by a seed: deterministic IDs, randomness, and a virtual clock. */
export class SeededEnvironment implements Environment {
  #seed: number;
  #clock: number;

  constructor(seed: number, start = Date.UTC(2026, 9, 20, 9, 0)) {
    this.#seed = seed >>> 0 || 1;
    this.#clock = start;
  }

  random(): number {
    // mulberry32
    this.#seed = (this.#seed + 0x6d2b79f5) >>> 0;
    let t = this.#seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  now(): Date {
    return new Date(this.#clock);
  }

  advance(ms: number): void {
    this.#clock += ms;
  }

  sleep(ms: number): Promise<void> {
    this.#clock += ms;
    return Promise.resolve();
  }

  #base32(length: number): string {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.random() * 32)];
    return out;
  }

  newFileId(): string {
    return `f_${this.#base32(24)}`;
  }

  newOpId(actorId: string): string {
    return `${actorId}:${this.#base32(20)}`;
  }
}
