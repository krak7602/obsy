import {
  MAX_LIST_LIMIT,
  PreconditionFailed,
  checkStorageKey,
  checkStoragePrefix,
  compareKeys,
} from '@obsy/protocol';
import type { ListResult, PutResult, Storage, StoredObject } from '@obsy/protocol';

/** Called before the atomic step of every operation. Use it to interleave operations. */
export type MemoryScheduler = (operation: MemoryOperation, key: string) => Promise<void>;

export type MemoryOperation = 'get' | 'putIfAbsent' | 'putIfMatch' | 'list' | 'delete';

export interface MemoryStorageOptions {
  /**
   * Runs before each operation takes effect. The default yields once to the
   * microtask queue, so that concurrent calls interleave.
   */
  scheduler?: MemoryScheduler;
  /**
   * Largest number of keys that one `list` call returns, even when `limit` is
   * larger. Use a small value to test callers that must follow `truncated`.
   */
  pageSize?: number;
}

interface Entry {
  body: Uint8Array;
  etag: string;
  contentType: string;
}

/**
 * An in-memory `Storage` with the semantics that obsy needs from a provider:
 *
 * - each operation takes effect atomically at one point, after the scheduler;
 * - conditional writes check and write in that same step;
 * - reads and lists see every completed write (strong consistency);
 * - lists are in code point order (UTF-8 byte order), like S3 and R2;
 * - the etag is a hash of the body, so identical bodies have identical etags,
 *   like the MD5 etags of S3 and R2 single-part uploads;
 * - bodies are copied in and out, so callers cannot change stored data.
 */
export class MemoryStorage implements Storage {
  readonly #objects = new Map<string, Entry>();
  readonly #scheduler: MemoryScheduler;
  readonly #pageSize: number;

  constructor(options: MemoryStorageOptions = {}) {
    this.#scheduler = options.scheduler ?? (() => Promise.resolve());
    this.#pageSize = Math.min(options.pageSize ?? MAX_LIST_LIMIT, MAX_LIST_LIMIT);
  }

  async get(key: string): Promise<StoredObject | null> {
    checkStorageKey(key);
    await this.#scheduler('get', key);
    const entry = this.#objects.get(key);
    return entry === undefined ? null : { body: entry.body.slice(), etag: entry.etag };
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    checkStorageKey(key);
    const copy = body.slice();
    await this.#scheduler('putIfAbsent', key);
    if (this.#objects.has(key)) {
      throw new PreconditionFailed(`Key already exists: ${key}`, { status: 412 });
    }
    return this.#write(key, copy, contentType);
  }

  async putIfMatch(
    key: string,
    body: Uint8Array,
    etag: string,
    contentType: string,
  ): Promise<PutResult> {
    checkStorageKey(key);
    const copy = body.slice();
    await this.#scheduler('putIfMatch', key);
    const current = this.#objects.get(key);
    if (current === undefined) {
      throw new PreconditionFailed(`Key does not exist: ${key}`, { status: 412 });
    }
    if (current.etag !== etag) {
      throw new PreconditionFailed(`Etag does not match for key: ${key}`, { status: 412 });
    }
    return this.#write(key, copy, contentType);
  }

  async list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult> {
    checkStoragePrefix(prefix);
    const max = Math.min(normaliseLimit(limit), this.#pageSize);
    await this.#scheduler('list', prefix);
    const matching = [...this.#objects.keys()]
      .filter(
        (key) =>
          key.startsWith(prefix) && (startAfter === undefined || compareKeys(key, startAfter) > 0),
      )
      .sort(compareKeys);
    return { keys: matching.slice(0, max), truncated: matching.length > max };
  }

  async delete(key: string): Promise<void> {
    checkStorageKey(key);
    await this.#scheduler('delete', key);
    this.#objects.delete(key);
  }

  /** The number of stored objects. For tests. */
  get size(): number {
    return this.#objects.size;
  }

  /** The content type stored with `key`, or `undefined`. For tests. */
  contentTypeOf(key: string): string | undefined {
    return this.#objects.get(key)?.contentType;
  }

  #write(key: string, body: Uint8Array, contentType: string): PutResult {
    const etag = hashEtag(body);
    this.#objects.set(key, { body, etag, contentType });
    return { etag };
  }
}

function normaliseLimit(limit: number | undefined): number {
  if (limit === undefined) return MAX_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`List limit must be a positive integer, got ${limit}`);
  }
  return Math.min(limit, MAX_LIST_LIMIT);
}

/**
 * A 64-bit content hash in hex (two FNV-1a variants). It is not
 * cryptographic. It only needs to make different test bodies differ.
 */
export function hashEtag(body: Uint8Array): string {
  let first = 0x811c9dc5;
  let second = 0x01000193 ^ body.length;
  for (const byte of body) {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ byte ^ 0x5bd1e995, 0x01000193) >>> 0;
  }
  return first.toString(16).padStart(8, '0') + second.toString(16).padStart(8, '0');
}
