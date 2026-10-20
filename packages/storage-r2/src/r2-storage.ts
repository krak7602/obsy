import {
  InvalidKey,
  MAX_LIST_LIMIT,
  PreconditionFailed,
  StorageError,
  TransientStorageError,
  checkStorageKey,
  checkStoragePrefix,
  type ListResult,
  type PutResult,
  type Storage,
  type StoredObject,
} from '@obsy/protocol';

/**
 * The parts of the Workers `R2Bucket` binding that this adapter uses.
 * Structural, so that the package needs no Workers type definitions.
 */
export interface R2BucketLike {
  get(key: string): Promise<{ readonly etag: string; arrayBuffer(): Promise<ArrayBuffer> } | null>;
  put(
    key: string,
    value: Uint8Array,
    options?: {
      onlyIf?: unknown;
      httpMetadata?: { contentType?: string };
    },
  ): Promise<{ readonly etag: string } | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    startAfter?: string;
    cursor?: string;
    limit?: number;
  }): Promise<{
    readonly objects: readonly { readonly key: string }[];
    readonly truncated: boolean;
    readonly cursor?: string;
  }>;
}

/**
 * The R2 error code from a binding error message, for example `10001` from
 * `put: We encountered an internal error. Please try again. (10001)`.
 */
function r2ErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /\((\d{5})\)\s*$/.exec(error.message)?.[1];
}

export interface R2StorageOptions {
  /** Root prefix for every key, for example `vaults/main/`. Empty or ending in `/`. */
  readonly prefix?: string;
}

/**
 * `Storage` over a Workers R2 binding. Conditional writes use the binding's
 * `onlyIf` (`etagDoesNotMatch: '*'` to create, `etagMatches` to replace): a
 * failed condition makes `put` return null, which becomes
 * `PreconditionFailed`. Other binding errors are transient; a write that
 * fails that way may have applied.
 */
export class R2Storage implements Storage {
  readonly #bucket: R2BucketLike;
  readonly #prefix: string;

  constructor(bucket: R2BucketLike, options: R2StorageOptions = {}) {
    const prefix = options.prefix ?? '';
    if (prefix !== '') {
      checkStoragePrefix(prefix);
      if (!prefix.endsWith('/')) throw new InvalidKey('Root prefix must end with "/"');
      checkStorageKey(prefix.slice(0, -1));
    }
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  get prefix(): string {
    return this.#prefix;
  }

  /** A new adapter on the same bucket, rooted at `<prefix><subPrefix>`. */
  withPrefix(subPrefix: string): R2Storage {
    return new R2Storage(this.#bucket, { prefix: this.#prefix + subPrefix });
  }

  #key(key: string): string {
    checkStorageKey(key);
    const full = this.#prefix + key;
    checkStorageKey(full);
    return full;
  }

  async #call<T>(
    operation: string,
    key: string,
    write: boolean,
    action: () => Promise<T>,
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof StorageError) throw error;
      const code = r2ErrorCode(error);
      throw new TransientStorageError(`${operation} ${key}: R2 binding error`, {
        mayHaveApplied: write,
        ...(code === undefined ? {} : { code }),
        cause: error,
      });
    }
  }

  async get(key: string): Promise<StoredObject | null> {
    const full = this.#key(key);
    return this.#call('get', key, false, async () => {
      const object = await this.#bucket.get(full);
      if (object === null) return null;
      return { body: new Uint8Array(await object.arrayBuffer()), etag: object.etag };
    });
  }

  async putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult> {
    const full = this.#key(key);
    const result = await this.#call('putIfAbsent', key, true, () =>
      this.#bucket.put(full, body.slice(), {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType },
      }),
    );
    if (result === null) throw new PreconditionFailed(`putIfAbsent ${key}: the key exists`);
    return { etag: result.etag };
  }

  async putIfMatch(
    key: string,
    body: Uint8Array,
    etag: string,
    contentType: string,
  ): Promise<PutResult> {
    const full = this.#key(key);
    const result = await this.#call('putIfMatch', key, true, () =>
      this.#bucket.put(full, body.slice(), {
        onlyIf: { etagMatches: etag },
        httpMetadata: { contentType },
      }),
    );
    if (result === null) {
      throw new PreconditionFailed(`putIfMatch ${key}: the key is missing or its etag differs`);
    }
    return { etag: result.etag };
  }

  async list(
    prefix: string,
    startAfter?: string,
    limit: number = MAX_LIST_LIMIT,
  ): Promise<ListResult> {
    checkStoragePrefix(prefix);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new RangeError(`limit must be an integer from 1 to ${MAX_LIST_LIMIT}`);
    }
    if (startAfter !== undefined) checkStorageKey(startAfter);
    const keys: string[] = [];
    let cursor: string | undefined;
    let truncated = false;
    do {
      const page = await this.#call('list', prefix, false, () =>
        this.#bucket.list({
          prefix: this.#prefix + prefix,
          limit: limit - keys.length,
          ...(cursor !== undefined
            ? { cursor }
            : startAfter !== undefined
              ? { startAfter: this.#prefix + startAfter }
              : {}),
        }),
      );
      for (const object of page.objects) keys.push(object.key.slice(this.#prefix.length));
      truncated = page.truncated;
      cursor = page.cursor;
    } while (truncated && keys.length < limit && cursor !== undefined);
    return { keys, truncated };
  }

  async delete(key: string): Promise<void> {
    const full = this.#key(key);
    await this.#call('delete', key, true, () => this.#bucket.delete(full));
  }
}
