/**
 * The storage contract that every layer above storage uses.
 *
 * The contract is specified in docs/subsystems/storage.md. Keys are relative
 * to the adapter's root (the vault prefix). Every key must pass
 * `checkStorageKey`.
 */

/** An object read from storage. */
export interface StoredObject {
  body: Uint8Array;
  /**
   * Opaque entity tag of this version, without surrounding quotes. Pass it to
   * `putIfMatch` unchanged. Identical bodies can have identical etags.
   */
  etag: string;
}

/** The result of a successful write. */
export interface PutResult {
  /** Opaque entity tag of the new version, without surrounding quotes. */
  etag: string;
}

/** One page of keys. */
export interface ListResult {
  /** Keys in ascending code point order (the same as UTF-8 byte order). */
  keys: string[];
  /**
   * True when more keys match after the last key in `keys`. Continue with
   * `startAfter` set to the last key. A page can hold fewer keys than the
   * limit and still be truncated.
   */
  truncated: boolean;
}

/** The largest `limit` that `list` accepts. */
export const MAX_LIST_LIMIT = 1000;

export interface Storage {
  /** Returns the current version, or `null` when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;

  /**
   * Creates the key only if it does not exist. Of concurrent creators of one
   * key, at most one succeeds.
   *
   * @throws PreconditionFailed when the key already exists.
   */
  putIfAbsent(key: string, body: Uint8Array, contentType: string): Promise<PutResult>;

  /**
   * Replaces the key only if its current etag equals `etag`.
   *
   * @throws PreconditionFailed when the key does not exist or its etag differs.
   */
  putIfMatch(key: string, body: Uint8Array, etag: string, contentType: string): Promise<PutResult>;

  /**
   * Lists keys that start with `prefix` and sort after `startAfter`, in
   * ascending code point order. Returns at most `limit` keys (default and
   * maximum `MAX_LIST_LIMIT`).
   */
  list(prefix: string, startAfter?: string, limit?: number): Promise<ListResult>;

  /** Deletes the key. Deleting a key that does not exist succeeds. */
  delete(key: string): Promise<void>;
}
